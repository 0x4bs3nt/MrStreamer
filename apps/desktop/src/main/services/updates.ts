import type { UsageObservers } from "../analytics/observers.ts";
// In-app updates and the release channel.
//
// The app checks on its own after starting and every four hours, quietly: an automatic check that
// fails keeps what the last one found and tries again later, backing off, and waits for GitHub
// when GitHub asks. The user can check at any time. Nothing downloads or installs on its own: the
// user downloads, then confirms the restart, and a download never restarts the app.
//
// Each channel offers only its own releases, and Nightly only one newer than the installed build.
// The first run stores the build's own channel; after that only the user changes it, so a Nightly
// user who installs a stable build stays on Nightly and waits for the next nightly. Switching a
// nightly build to Stable offers the newest stable release even when it is older, and installs it
// over the nightly like any update: this device's data stays.
//
// A copy installed as an MSIX package, as the Microsoft Store installs it, leaves all of this to
// the Store, which only carries stable releases: the service offers nothing and opens the Store.
import { checkFailure, type OperationObserver } from "../analytics/operations.ts";
import { join } from "node:path";
import { type } from "arktype";
import type {
  CheckFailure,
  UpdateOffer,
  UpdatePhase,
  UpdateStatus,
} from "@mrstreamer/contracts/updates";
import {
  channelOf,
  compareVersions,
  formatVersion,
  parseVersion,
  type Channel,
  type Version,
} from "@mrstreamer/contracts/version";
import { diagnosed, Diagnostics } from "@mrstreamer/core/diagnostics";
import { failedWith, type Failed } from "@mrstreamer/core/failure";
import { DiscoveryFailed, newestOn, type Offer } from "@mrstreamer/core/updates/feed";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import { lazy } from "@mrstreamer/contracts/lazy";

/** Downloads and installs releases: electron-updater in the app, a fake in tests. */
export interface Installer {
  /** Downloads and verifies the release in `feedUrl`. Rejects when `signal` aborts. */
  download(
    target: {
      readonly feedUrl: string;
      readonly version: string;
      readonly allowDowngrade: boolean;
    },
    onProgress: (percent: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  /**
   * Quits, installs the downloaded release and starts it. Rejects when the system refuses the
   * release, as macOS does when its signature doesn't match; otherwise the app quits first.
   */
  install(): Promise<void>;
}

/** When automatic checks run. */
export interface CheckSchedule {
  /** After the app starts. */
  readonly first: Duration.Input;
  /** Between checks that worked. */
  readonly every: Duration.Input;
}

/** After starting, then every four hours. */
export const DEFAULT_SCHEDULE: CheckSchedule = { first: "20 seconds", every: "4 hours" };

/** Waits after automatic checks that failed in a row, the last one repeating. */
const RETRY_AFTER = ["15 minutes", "30 minutes", "1 hour", "2 hours", "4 hours"] as const;

/** A copy installed from the app's own download: the app finds, downloads and installs updates. */
export interface DirectUpdates {
  /** Finds releases this platform can install. Rejects with `DiscoveryFailed`. */
  readonly discover: (signal: AbortSignal) => Promise<readonly Offer[]>;
  readonly onChannelChanged?: (channel: Channel) => void;
  readonly observeCheck?: (channel: Channel) => ReturnType<OperationObserver>;
  readonly installer: Installer;
  /** When automatic checks run; null for none, as in most tests. */
  readonly schedule?: CheckSchedule | null;
}

/**
 * A copy installed as an MSIX package, as the Microsoft Store installs it. The Store updates it,
 * so the app never checks, downloads or installs, and needs no installer.
 */
export interface StoreUpdates {
  /** Opens the app's page in the Store, which offers its update there. */
  readonly openStore: () => Promise<void>;
}

/** Pacman owns an Arch installation. No direct updater capability enters this branch. */
export interface PacmanUpdates {
  readonly managed: "pacman";
}

/** What the app passes in: its version, and who updates this copy. */
export type UpdatesConfig = {
  /** The running build's version. */
  readonly installed: string;
} & (DirectUpdates | StoreUpdates | PacmanUpdates);

export type UpdatesDeps = UpdatesConfig & {
  readonly dataDir: string;
  readonly usage?: UsageObservers | undefined;
};

export class Updates extends Context.Service<
  Updates,
  {
    readonly status: Effect.Effect<UpdateStatus>;
    /**
     * Looks for the release the chosen channel offers this build, now, and says why when that
     * fails. A check already running is shared. Only the latest check counts: one that finishes
     * after a newer check or a channel change leaves the state alone.
     */
    readonly check: Effect.Effect<UpdateStatus>;
    /**
     * Changes the channel and checks what it offers. An update the new channel doesn't receive,
     * such as a nightly after switching to Stable or a stable release after switching to
     * Nightly, is dropped: its download stops, and a downloaded one won't install.
     */
    setChannel(next: Channel): Effect.Effect<UpdateStatus>;
    /**
     * Downloads the release the last check found, or again after a failed download or install.
     * Playback carries on meanwhile.
     */
    readonly download: Effect.Effect<UpdateStatus>;
    /** Stops a download in progress; the update goes back to available. */
    readonly cancel: Effect.Effect<void>;
    /** Installs the downloaded update. The user has confirmed the restart. */
    readonly restart: Effect.Effect<void>;
    /** Closes the notice for `version`. Settings keeps offering it; a newer version notifies. */
    dismiss(version: string): Effect.Effect<UpdateStatus>;
    /** Opens the app's page in the Microsoft Store, for a Store copy. Does nothing for other copies. */
    readonly openStore: Effect.Effect<void, Failed>;
    /** The status after every change, such as a download's progress. */
    readonly changes: Stream.Stream<UpdateStatus>;
  }
>()("mrstreamer/Updates") {
  static readonly layer = (deps: UpdatesDeps) =>
    Layer.effect(Updates, "managed" in deps || "openStore" in deps ? managed(deps) : make(deps));
}

const SETTINGS_FILE = "updates.json";
/** updates.json: the channel, and the version whose notice was closed. */
const SettingsFile = lazy(() =>
  type({ channel: "'stable' | 'nightly'", "dismissed?": "string | null" }),
);

/** Whether a channel receives `version`: each receives only its own releases. */
function receives(channel: Channel, version: string): boolean {
  const parsed = parseVersion(version);
  return parsed !== null && channelOf(parsed) === channel;
}

function make(deps: UpdatesDeps & DirectUpdates) {
  return Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const diagnostics = yield* Diagnostics;
    const updates = yield* PubSub.unbounded<UpdateStatus>();
    const settingsPath = join(deps.dataDir, SETTINGS_FILE);
    /** Writes updates.json one at a time, with what memory holds then, so the last change wins. */
    const writeOne = (yield* Semaphore.make(1)).withPermits(1);
    // A development build without a release version counts as the oldest stable.
    const installed: Version = parseVersion(deps.installed) ?? {
      major: 0,
      minor: 0,
      patch: 0,
      nightly: null,
    };

    const stored = yield* Effect.promise(() => readJsonFile(settingsPath, SettingsFile()));
    let channel: Channel = stored?.channel ?? channelOf(installed);
    let dismissed: string | null = stored?.dismissed ?? null;
    let savedChannel = channel;
    let savedDismissed = dismissed;
    let update: UpdatePhase = { kind: "idle" };
    /** The release the last check found for the channel, whether or not it is newer. */
    let target: Offer | null = null;
    let checked: UpdateStatus["checked"] = null;
    let nextCheckAt: number | null = null;
    /** The check whose result still counts; a newer check or a channel change voids it. */
    let checking: { readonly channel: Channel; readonly fiber: Fiber.Fiber<CheckResult> } | null =
      null;
    /** The download in flight; there is one installer. */
    let downloading: Fiber.Fiber<void, unknown> | null = null;
    /** The download whose outcome still counts; a channel change can void it. */
    let attempt: object | null = null;

    // Keeps what a newer release added to the file, for when it runs again.
    const save = writeOne(
      Effect.promise(async () => {
        const next = { ...stored, channel, dismissed };
        const currentTarget = target ? formatVersion(target.version) : null;
        const dismissedUpdate =
          next.dismissed !== savedDismissed && next.dismissed === currentTarget
            ? deps.usage?.action("update_dismissed")
            : undefined;
        await writeJsonFile(settingsPath, next);
        if (savedChannel !== next.channel) deps.onChannelChanged?.(next.channel);
        savedChannel = next.channel;
        savedDismissed = next.dismissed;
        if (target && formatVersion(target.version) === next.dismissed) dismissedUpdate?.();
      }),
    );
    if (!stored) yield* save;

    /** Whether the chosen channel still receives `version`, checked before downloading or installing it. */
    const wanted = (version: string) => receives(channel, version);

    const snapshot = (): UpdateStatus => ({
      version: deps.installed,
      distribution: "direct",
      channel,
      update,
      offer: offerOf(target, update),
      checked,
      nextCheckAt,
      dismissed,
    });
    const status = Effect.sync(snapshot);
    const changed = Effect.suspend(() => PubSub.publish(updates, snapshot()));

    /** Forgets an update the chosen channel no longer receives. */
    const drop = Effect.gen(function* () {
      target = null;
      update = { kind: "idle" };
      yield* changed;
      return snapshot();
    });

    /** Asks the sources for releases; what it found, or why not. */
    const discover = (checkedChannel: Channel) =>
      Effect.suspend(() => {
        const finished = deps.observeCheck?.(checkedChannel);
        return Effect.tryPromise({
          try: (signal) => deps.discover(signal),
          catch: (cause) => cause,
        }).pipe(
          diagnosed("check"),
          Effect.tapError((cause) =>
            Effect.sync(() => {
              if (cause instanceof DiscoveryFailed) {
                for (const answer of cause.answers)
                  diagnostics.record({ op: "update-source", ...answer });
              }
            }),
          ),
          Effect.result,
          Effect.map((found): CheckResult =>
            found._tag === "Success"
              ? { ok: true, offers: found.success }
              : {
                  ok: false,
                  failure:
                    found.failure instanceof DiscoveryFailed
                      ? found.failure.failure
                      : { kind: "offline" },
                },
          ),
          Effect.tap((result) =>
            Effect.sync(() =>
              finished?.(
                result.ok ? "success" : "failed",
                result.ok ? undefined : checkFailure(result.failure),
              ),
            ),
          ),
          Effect.onInterrupt(() => Effect.sync(() => finished?.("interrupted"))),
        );
      });

    /** A download in progress or ready: a check can't take it away, even one that fails. */
    const staged = () => update.kind === "downloading" || update.kind === "ready";

    /**
     * One check, shared by callers while it runs, and what it found; null when it didn't run or
     * a newer check or channel change voided it. `manual` shows it running and a failure;
     * automatic checks change nothing the user sees until they find something.
     */
    const runCheck = (manual: boolean): Effect.Effect<CheckResult | null> =>
      Effect.gen(function* () {
        if (staged()) return null;
        let running = checking?.channel === channel ? checking : null;
        if (!running) {
          running = { channel, fiber: yield* Effect.forkIn(discover(channel), scope) };
          checking = running;
        }
        if (manual) {
          update = { kind: "checking" };
          yield* changed;
        }
        const result = yield* Fiber.join(running.fiber);
        if (checking !== running) return null;
        checking = null;
        checked = {
          at: yield* Clock.currentTimeMillis,
          failure: result.ok ? null : result.failure,
        };
        // Including one that started while the check ran.
        if (staged()) {
          yield* changed;
          return result;
        }
        if (!result.ok) {
          // An update an earlier check found stays on offer; `checked` says this one failed.
          if (manual || update.kind === "checking") {
            update = target
              ? { kind: "available", version: formatVersion(target.version) }
              : { kind: "failed", step: "check", failure: result.failure };
          }
          yield* changed;
          return result;
        }
        const newest = newestOn(channel, result.offers);
        // A nightly build on Stable goes to the newest stable release, older or not. Nightly
        // never goes back, so a stable build on Nightly waits for a newer nightly.
        const offered =
          newest &&
          (compareVersions(newest.version, installed) > 0 ||
            (channel === "stable" && installed.nightly !== null));
        target = offered ? newest : null;
        update = target
          ? { kind: "available", version: formatVersion(target.version) }
          : { kind: "current" };
        yield* changed;
        return result;
      });

    /** Checks after starting, then every four hours; after failures sooner, and never before GitHub allows. */
    const automatic = (schedule: CheckSchedule) =>
      Effect.gen(function* () {
        let wait = Duration.toMillis(schedule.first);
        let failures = 0;
        for (;;) {
          nextCheckAt = (yield* Clock.currentTimeMillis) + wait;
          yield* changed;
          yield* Effect.sleep(Duration.millis(wait));
          nextCheckAt = null;
          const result = yield* runCheck(false);
          const now = yield* Clock.currentTimeMillis;
          const failure = result && !result.ok ? result.failure : null;
          if (!failure) {
            failures = 0;
            // Up to a tenth later, so many installs don't all ask at once.
            wait = Duration.toMillis(schedule.every) * (1 + Math.random() / 10);
            continue;
          }
          const retry = RETRY_AFTER[Math.min(failures, RETRY_AFTER.length - 1)] ?? "4 hours";
          failures++;
          const allowed = failure.kind === "busy" && failure.until ? failure.until - now : 0;
          wait = Math.max(Duration.toMillis(retry), allowed + 60_000);
        }
      });
    if (deps.schedule) yield* Effect.forkIn(automatic(deps.schedule), scope);

    return {
      status,
      check: Effect.as(runCheck(true), undefined).pipe(Effect.andThen(status)),

      setChannel: (next: Channel) =>
        Effect.gen(function* () {
          channel = next;
          checking = null;
          const staged = update.kind === "downloading" || update.kind === "ready" ? update : null;
          if (!staged || !receives(next, staged.version)) {
            attempt = null;
            target = null;
            update = { kind: "idle" };
            if (downloading) yield* Fiber.interrupt(downloading);
          }
          yield* save;
          yield* changed;
          yield* runCheck(true);
          return snapshot();
        }),

      download: Effect.gen(function* () {
        const retry = update.kind === "failed" && update.step !== "check";
        if ((update.kind !== "available" && !retry) || !target || downloading) return snapshot();
        const release = target;
        const version = formatVersion(release.version);
        if (!wanted(version)) return yield* drop;
        const mine = {};
        attempt = mine;
        // Set before anything waits, so a second download finds this one.
        update = { kind: "downloading", version, percent: 0 };
        // In the service's scope, so quitting stops it too. Known before the UI hears of it, so
        // a cancel always finds it.
        const fiber = yield* Effect.forkIn(
          Effect.tryPromise({
            try: (signal) =>
              deps.installer.download(
                {
                  feedUrl: release.feedUrl,
                  version,
                  allowDowngrade: compareVersions(release.version, installed) < 0,
                },
                (percent) => {
                  if (attempt !== mine || signal.aborted) return;
                  update = { kind: "downloading", version, percent };
                  PubSub.publishUnsafe(updates, snapshot());
                },
                signal,
              ),
            catch: (cause) => cause,
          }).pipe(diagnosed("download")),
          scope,
        );
        downloading = fiber;
        yield* changed;
        const exit = yield* Fiber.await(fiber);
        if (downloading === fiber) downloading = null;
        if (attempt !== mine) return snapshot();
        attempt = null;
        // A download that finishes after it was cancelled doesn't count either.
        if (Exit.isSuccess(exit)) update = { kind: "ready", version };
        else if (Cause.hasInterrupts(exit.cause)) update = { kind: "available", version };
        else {
          update = {
            kind: "failed",
            step: "download",
            version,
            detail: reason(Cause.squash(exit.cause)),
          };
        }
        yield* changed;
        return snapshot();
      }),

      cancel: Effect.suspend(() => (downloading ? Fiber.interrupt(downloading) : Effect.void)),

      restart: Effect.gen(function* () {
        if (update.kind !== "ready") return;
        const version = update.version;
        if (!wanted(version)) {
          yield* drop;
          return;
        }
        const installing = yield* Effect.tryPromise({
          try: () => deps.installer.install(),
          catch: (cause) => cause,
        }).pipe(diagnosed("install"), Effect.result);
        if (installing._tag === "Failure") {
          update = { kind: "failed", step: "install", version, detail: reason(installing.failure) };
          yield* changed;
        }
      }),

      dismiss: (version: string) =>
        Effect.gen(function* () {
          dismissed = version;
          yield* save;
          yield* changed;
          return snapshot();
        }),

      openStore: Effect.void,

      changes: Stream.fromPubSub(updates),
    };
  });
}

/**
 * Externally managed copies never check, download, install or read/write updates.json.
 * Only the Store variant has an action, which opens its Store page.
 */
function managed(deps: UpdatesDeps & (StoreUpdates | PacmanUpdates)) {
  const status: UpdateStatus = {
    version: deps.installed,
    distribution: "managed" in deps ? deps.managed : "store",
    channel: "stable",
    update: { kind: "idle" },
    offer: null,
    checked: null,
    nextCheckAt: null,
    dismissed: null,
  };
  const unchanged = Effect.succeed(status);
  return Effect.succeed({
    status: unchanged,
    check: unchanged,
    setChannel: () => unchanged,
    download: unchanged,
    cancel: Effect.void,
    restart: Effect.void,
    dismiss: () => unchanged,
    openStore:
      "managed" in deps
        ? Effect.void
        : Effect.tryPromise({ try: () => deps.openStore(), catch: failedWith }),
    changes: Stream.empty,
  });
}

type CheckResult =
  | { readonly ok: true; readonly offers: readonly Offer[] }
  | { readonly ok: false; readonly failure: CheckFailure };

/** The offered release's notes and page, while there is an update to show them for. */
function offerOf(target: Offer | null, update: UpdatePhase): UpdateOffer | null {
  if (!target || update.kind === "current" || update.kind === "idle") return null;
  return { version: formatVersion(target.version), notes: target.notes, page: target.page };
}

function reason(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
