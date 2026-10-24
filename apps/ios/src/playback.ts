import { appFailure, type AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import type { AppError } from "@mrstreamer/contracts/errors";
import {
  createVideoPlayer,
  type ObservedFailure,
  type ObservedItemIdentity,
  type ObservedTrackSelection,
  type ObservedTrackSnapshot,
  type PlaybackObservation,
  type VideoPlayer,
} from "expo-video";
import { appError, describeError, withoutLogin } from "./errors.ts";
import { currentSource, onSignedIn } from "./sources.ts";
import { store, useStore, type Store } from "./store.ts";
import { openFormat, type FormatSession } from "./title-formats.ts";

// The app's one player and what it plays: a live channel, or a movie or an episode. Every surface
// shows this player and no other: Home's preview, Watch, Picture in Picture and AirPlay, and the
// accessory above the tabs controls it. Nothing opens a second stream for a preview. Playing
// something else, stopping, removing its subscription and a failure each let go of the stream,
// so its local readers drain. Provider disconnect is unobservable. A download gives its
// subscription's connection back before a stream opens (`onReclaim`); a downloaded copy plays
// from the phone and takes none.
//
// A movie or episode in a file AVPlayer can't open, such as Matroska, plays through a format
// session (`title-formats.ts`): the file is read natively, over one request to the provider at a
// time, and this player gets it as HLS from 127.0.0.1. Nothing of a new play reaches the
// provider until every earlier session's request has ended.
//
// A title starts where it is asked to, has a length to seek in, and tells whoever played it how
// far it got: every minute while it plays, when it pauses, and when it stops, fails or gives way
// to something else; and once more when it plays to its end. Its owner saves each, one at a
// time in the order told, whichever play told it, so a slow save never lands after a later one.
// Whatever resumes a title waits for those saves before it reads where it got to
// (`progressSettled`). A refused save is told once, until one is kept again (`onProgressRefused`).
//
// Closing Watch pauses what plays, saving where it got to, unless Picture in Picture or AirPlay
// already shows it, where it plays on with its sound. Stop ends it and saves. Both resolve once
// their save ended, saying whether it was kept.

/** What plays, as the screens name it. */
export interface Playing {
  /** A channel's, movie's or episode's `ownedKey`. */
  readonly id: string;
  /**
   * The subscription whose provider streams it; null for a downloaded copy, which plays from the
   * phone and holds no provider's connection.
   */
  readonly subscriptionId: string | null;
  readonly title: string;
  /** Where the catalogue lists a channel, "Netherlands · News"; a title's line, "S1 E2 · Name". */
  readonly place: string;
  /** A live channel plays on; a title has a length. */
  readonly live: boolean;
  /** An episode with one after it, which Watch offers. */
  readonly next: boolean;
  /** A title with other versions to try when this one fails. */
  readonly versions: boolean;
}

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" | "playing" | "paused"; readonly item: Playing }
  | { readonly kind: "failed"; readonly item: Playing; readonly error: string };

export interface Playback {
  readonly phase: Phase;
  /** Watch shows the player full screen. */
  readonly watch: boolean;
  /** Picture in Picture shows it, started from Watch. */
  readonly pip: boolean;
  /** It plays on an AirPlay receiver. */
  readonly external: boolean;
  /**
   * Watch gave way to Downloads or Settings with no Picture in Picture to take the picture over:
   * it waits, paused, for the accessory to bring Watch back (`setAside`).
   */
  readonly aside: boolean;
  /** Home's preview plays without sound until Watch opens or the viewer unmutes it. */
  readonly muted: boolean;
  /**
   * Subscriptions with retired native or format readers still closing, including uncertain closes.
   * The active stream is represented by phase. This does not acknowledge a provider disconnect.
   */
  readonly closing: readonly string[];
}

/** Where a stream is, and its file type as whoever opened it knows it. */
export interface Source {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** "m3u8" for HLS; a title's listed container, or a copy's. */
  readonly container: string;
}

/**
 * The file types a format session plays: Matroska, which AVPlayer can't open. Everything else,
 * live streams always, goes to AVPlayer as it is, as it always did.
 */
const THROUGH_SESSION: ReadonlySet<string> = new Set(["mkv"]);

/** How the latest save of a title's progress ended: kept, or refused with what it was refused for. */
export type Saved = { readonly saved: true } | { readonly saved: false; readonly error: AppError };

/** Opens what plays; aborted when the viewer moves on first. */
type Open = (signal: AbortSignal) => Promise<Source>;

export interface PlayOptions {
  /** In Watch, else in Home's preview. */
  readonly watch: boolean;
  /** What the stream's address carries that no failure the viewer sees may show. */
  readonly login: readonly string[];
  /** Seconds to start a title from. */
  readonly from?: number;
  /**
   * Saves how far a title got, in seconds of its length; rejects when the save was refused, with
   * what was saved before kept. Asked once the save before it, of any play, ended.
   */
  readonly progress?: (position: number, duration: number) => Promise<void>;
  /** A title played to its end. */
  readonly ended?: () => void;
  /** Whether it got as far as playing, said once: true when it first plays, false if it fails. */
  readonly outcome?: (played: boolean) => void;
  /** Plays the episode after this one, once `saved`, this one's save before it, ended. */
  readonly next?: (saved: Promise<Saved>) => void;
  /** Shows the title's other versions, after this one failed. */
  readonly versions?: () => void;
}

const state = store<Playback>({
  phase: { kind: "idle" },
  watch: false,
  pip: false,
  external: false,
  aside: false,
  muted: true,
  closing: [],
});
/** Seconds played of the current stream, apart from the rest so only the clock redraws. */
const clock = store(0);
/** A title's length in seconds, once known; 0 for live and before it loaded. */
const length = store(0);

export const usePlayback = () => useStore(state);
/** Read-only, for telemetry, which follows the player without a screen. */
export const playbackState: Pick<Store<Playback>, "get" | "subscribe"> = state;
export const playbackClock: Pick<Store<number>, "get" | "subscribe"> = clock;
export const usePlaybackClock = () => useStore(clock);
export const usePlaybackLength = () => useStore(length);

/** A channel that plays or is about to, and how it stands, in the accessory's words. */
export interface ChannelStatus {
  readonly id: string;
  readonly word: "Connecting" | "Paused" | "Playing";
}

/**
 * The channel that plays or is about to, for channel lists and tiles to mark with how it stands;
 * none once it failed or stopped, or while a title plays. A movie's key can read like a channel's
 * of the same subscription, so a title never counts.
 */
export function channelStatus(phase: Phase): ChannelStatus | null {
  if (phase.kind === "idle" || phase.kind === "failed" || !phase.item.live) return null;
  const word =
    phase.kind === "loading" ? "Connecting" : phase.kind === "paused" ? "Paused" : "Playing";
  return { id: phase.item.id, word };
}

/**
 * What streams or is about to, a channel or a title; none once it failed or stopped. A new play
 * is a new item, even of the same key, so a return from Picture in Picture can tell it apart.
 */
export function playingItem(phase: Phase): Playing | null {
  return phase.kind === "idle" || phase.kind === "failed" ? null : phase.item;
}

/**
 * A request of the viewer's that waits before it plays or opens anything, as a series' resume
 * waits for its details, or Next episode for how the episodes stand. It stands until the viewer
 * asks for something newer: any other request, any channel or title played, Stop, removing a
 * subscription or another screen. Close, setting Watch aside and Picture in Picture changes
 * also retire deferred viewer actions. Whatever waited checks `stands()` before acting, so a
 * late answer never replaces what the viewer chose since, nor opens Watch over Connect.
 */
export interface Request {
  stands(): boolean;
}

/** Rises with viewer requests and Watch/navigation context changes: only the latest stands. */
let requests = 0;
/** The screen the viewer is on, as navigation reports it. */
let screen = "";

/** Starts a request that has to wait, replacing any waiting before it. */
export function request(): Request {
  const mine = ++requests;
  return { stands: () => mine === requests };
}

/**
 * Navigation reports the screen the viewer is on. Leaving it ends any waiting request for good,
 * coming back too; the same screen reported again changes nothing.
 */
export function onScreen(path: string) {
  if (path === screen) return;
  screen = path;
  requests++;
}

/** Whether setting Watch aside paused what played, so bringing Watch back plays it again. */
let resumeOnReturn = false;
/** Deferred loading Pause, or Watch's own pause while away. Returning clears only the latter. */
let pauseOnStart: false | "viewer" | "away" = false;
/**
 * Close silenced what it paused, which had sound: Play from paused brings that sound back. A new
 * play, Stop, Watch shown again and the viewer's own mute or unmute each end it.
 */
let soundOnPlay = false;

/** How often a playing title says how far it got. */
const CHECKPOINT_MS = 60_000;

let current: {
  readonly item: Playing;
  readonly open: Open;
  readonly options: PlayOptions;
  /** Seconds to seek to once the title is ready; null once done. */
  seek: number | null;
  /** Whether the stream got as far as playing, so a position means something. */
  loaded: boolean;
  /** Where a title was when it was let go of, for Try again. */
  stoppedAt: number | null;
  readonly resource: Resource;
  failure: PlaybackFailure | null;
} | null = null;
/** Failure facts stay local. Only the existing analytics callback receives a lossy category. */
type PlaybackFailure =
  | { readonly kind: "native"; readonly failure: ObservedFailure }
  | { readonly kind: "format"; readonly failure: StreamFailure }
  | { readonly kind: "lookup"; readonly error: AppError }
  | { readonly kind: "bridge" | "reset" | "cancelled" | "detach-timeout" };

type FormatReader = ReturnType<typeof openFormat>;
interface Resource {
  readonly id: number;
  readonly controller: AbortController;
  readonly sourceStands: () => boolean;
  readonly subscriptionId: string | null;
  readonly formats: FormatReader[];
  readonly closed: Promise<void>;
  readonly drained: () => void;
  readonly uncertain: (cause: Error) => void;
  readonly opening: Promise<void>;
  readonly opened: () => void;
  itemId: number | null;
  sequence: number;
  retired: boolean;
  detach: ReturnType<VideoPlayer["detachObservedAsync"]> | null;
  settlement: Promise<void> | null;
  session: FormatSession | null;
  tracks: ObservedTrackSnapshot | null;
  querying: Promise<ObservedTrackSnapshot | null> | null;
}
let attempts = 0;
const closing = new Set<Resource>();

/** Capture before Stop. The handle remains bound to these readers, even after another play. */
export function playbackReader(item: Playing): Readonly<{ closed: Promise<void> }> | null {
  return current?.item === item ? { closed: current.resource.closed } : null;
}

function stands(resource: Resource): boolean {
  return (
    current?.resource === resource &&
    !resource.retired &&
    !resource.controller.signal.aborted &&
    resource.sourceStands()
  );
}

onSignedIn(() => {
  if (current && !current.resource.retired && !current.resource.sourceStands()) void stop();
});

function noteClosing() {
  const holding = [
    ...new Set([...closing].flatMap((r) => (r.subscriptionId === null ? [] : [r.subscriptionId]))),
  ];
  const now = state.get().closing;
  if (holding.length !== now.length || holding.some((id, at) => id !== now[at])) {
    state.set((s) => ({ ...s, closing: holding }));
  }
}

/** Retain the real native promise and every format reader until positive closure. */
function retire(resource: Resource) {
  if (resource.settlement) return resource.settlement;
  resource.retired = true;
  closing.add(resource);
  resource.detach = Promise.resolve().then(() => player().detachObservedAsync(resource.id));
  resource.settlement = (async () => {
    const receipt = await resource.detach;
    if (
      receipt?.kind !== "detached" ||
      receipt.attemptId !== resource.id ||
      receipt.localItemExcluded !== true ||
      receipt.appWorkDrained !== true ||
      (resource.itemId !== null && receipt.itemId !== resource.itemId)
    ) {
      throw new Error("Player reader closure was not acknowledged.");
    }
    await resource.opening;
    await Promise.all(resource.formats.map((format) => format.closed));
    closing.delete(resource);
    resource.drained();
    noteClosing();
  })();
  resource.controller.abort();
  for (const format of resource.formats) format.close();
  noteClosing();
  void resource.settlement.catch(() =>
    resource.uncertain(new Error("Player reader closure was not acknowledged.")),
  );
  return resource.settlement;
}

/** The selection deadline never changes the real closing ledger or resumes a failed selection. */
async function waitForReaders(resource: Resource) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    const abort = () => reject(new Error("Selection ended."));
    resource.controller.signal.addEventListener("abort", abort, { once: true });
    resource.opening.then(() => resource.controller.signal.removeEventListener("abort", abort));
  });
  try {
    await Promise.race([
      Promise.all([...closing].map((r) => r.closed)),
      aborted,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("detach-timeout")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let checkpoint: ReturnType<typeof setInterval> | null = null;
const KEPT: Saved = { saved: true };
/** Every save of progress asked so far, one after another, ending with how the latest went. */
let saving: Promise<Saved> = Promise.resolve(KEPT);
/** Whether the latest save was refused, so a run of refusals is told once. */
let refusing = false;
/**
 * Told when a save is refused after one that was kept, unless its subscription went; Watch
 * registers it.
 */
let refused: (() => void) | null = null;
/** Told each failure's category, never its message; telemetry registers it. */
let failed: ((failure: AnalyticsFailure) => void) | null = null;
/** Ends Picture in Picture; Watch registers it while its view can. */
let endPictureInPicture: (() => void) | null = null;
/**
 * Takes a subscription's connection back from a download before a stream opens; downloads.ts
 * registers it. Resolves once the request ended and the provider had a moment to free it;
 * rejects when it didn't end, and the stream fails.
 */
let reclaim: ((subscriptionId: string) => Promise<void>) | null = null;

/** Abort this pre-reader wait only. Downloads still owns and settles the real reclaim. */
async function reclaimBeforeLookup(resource: Resource, subscriptionId: string) {
  if (!reclaim) return;
  const { signal } = resource.controller;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([reclaim(subscriptionId), cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * Tells a title's owner how far it got, if it got anywhere, after the saves asked before.
 * Resolves with how that save went once it ended; kept when there was nothing to save.
 */
function report(): Promise<Saved> {
  const save = current?.options.progress;
  const made = player();
  const duration = made.duration;
  if (
    !current?.loaded ||
    current.item.live ||
    !save ||
    !(duration > 0 && Number.isFinite(duration))
  ) {
    return saving.then(() => KEPT);
  }
  const position = Math.min(made.currentTime, duration);
  saving = saving.then(async (): Promise<Saved> => {
    try {
      await save(position, duration);
      refusing = false;
      return KEPT;
    } catch (cause) {
      const error = appError(cause);
      // A save whose subscription went, as removing its provider stops what plays, wasn't kept,
      // but the viewer chose that: it isn't told, and leaves a run of refusals as it was.
      if (error.kind !== "no-subscription") {
        if (!refusing) refused?.();
        refusing = true;
      }
      return { saved: false, error };
    }
  });
  return saving;
}

/** Resolves once every save of progress asked so far ended, kept or not. */
export function progressSettled(): Promise<void> {
  return saving.then(() => undefined);
}

let created: VideoPlayer | null = null;
/** The player, made on first use. */
export function player(): VideoPlayer {
  if (created) return created;
  const made = createVideoPlayer(null);
  made.timeUpdateEventInterval = 1;
  made.muted = state.get().muted;
  // Installed once, before any attempt. Legacy source/status/time events have no authority.
  made.addListener("playbackObservation", observe);
  made.addListener("isExternalPlaybackActiveChange", ({ isExternalPlaybackActive }) => {
    // An AirPlay receiver keeps playing while the app is in the background.
    made.staysActiveInBackground = isExternalPlaybackActive;
    // Back on the phone with Watch and Picture in Picture closed, Home's preview is silent again.
    const { watch, pip } = state.get();
    const silent = !isExternalPlaybackActive && !watch && !pip;
    if (silent) made.muted = true;
    state.set((s) => ({ ...s, external: isExternalPlaybackActive, muted: silent || s.muted }));
  });
  created = made;
  return made;
}

/** Releases readers independently of the ordered progress-save result. */
function release(): Promise<Saved> {
  const saved = report();
  if (current?.loaded && !current.item.live) current.stoppedAt = player().currentTime;
  if (checkpoint) clearInterval(checkpoint);
  checkpoint = null;
  if (current) void retire(current.resource);
  player().pause();
  clock.set(0);
  length.set(0);
  return saved;
}

function fail(failure: PlaybackFailure) {
  if (!current || current.resource.retired) return;
  current.failure = failure;
  const { item, options, loaded } = current;
  const formatFailure = failure.kind === "format" ? failure.failure : null;
  const native = failure.kind === "native" ? failure.failure : null;
  const analytics = formatFailure
    ? appFailure({ kind: "stream", failure: formatFailure })
    : failure.kind === "lookup"
      ? appFailure(failure.error)
      : native?.kind === "auth"
        ? "credentials"
        : native?.kind === "network"
          ? "network"
          : native?.kind === "unsupported" || native?.kind === "decode"
            ? "unsupported"
            : native?.kind === "missing" || native?.kind === "rate-limit" || native?.kind === "http"
              ? "unavailable"
              : "app";
  release();
  failed?.(analytics);
  if (!loaded) options.outcome?.(false);
  current.loaded = false;
  const message = formatFailure
    ? describeError({ kind: "stream", failure: formatFailure })
    : failure.kind === "lookup"
      ? describeError(failure.error)
      : native?.kind === "network"
        ? "The connection to the provider failed."
        : native?.kind === "unsupported" || native?.kind === "decode"
          ? "Mr. Streamer can't play this file."
          : failure.kind === "detach-timeout"
            ? "The previous stream is still closing. Try again."
            : "The player stopped. Try again.";
  state.set((s) => ({
    ...s,
    phase: { kind: "failed", item, error: withoutLogin(message, options.login) },
  }));
}

function acceptItem(resource: Resource, identity: ObservedItemIdentity) {
  if (
    !stands(resource) ||
    identity.attemptId !== resource.id ||
    !Number.isSafeInteger(identity.itemId) ||
    identity.itemId <= 0 ||
    (resource.itemId !== null && resource.itemId !== identity.itemId)
  )
    return false;
  resource.itemId = identity.itemId;
  return true;
}

function acceptTracks(resource: Resource, tracks: ObservedTrackSnapshot) {
  if (
    !stands(resource) ||
    tracks.attemptId !== resource.id ||
    tracks.itemId !== resource.itemId ||
    (resource.tracks && tracks.revision < resource.tracks.revision)
  )
    return;
  resource.tracks = tracks;
}

function refreshTracks(resource: Resource): Promise<ObservedTrackSnapshot | null> {
  if (!stands(resource) || resource.itemId === null) return Promise.resolve(null);
  if (resource.querying) return resource.querying;
  const expected = { attemptId: resource.id, itemId: resource.itemId };
  const before = resource.tracks;
  resource.querying = Promise.resolve()
    .then(() => player().getObservedTracksAsync(expected))
    .then(
      (tracks) => {
        if ("kind" in tracks || !stands(resource)) return null;
        if (resource.tracks === before) acceptTracks(resource, tracks);
        return resource.tracks;
      },
      () => null,
    )
    .finally(() => {
      resource.querying = null;
    });
  return resource.querying;
}

function observe(event: PlaybackObservation) {
  const resource = current?.resource;
  if (
    !resource ||
    !stands(resource) ||
    event.version !== 1 ||
    event.attemptId !== resource.id ||
    !Number.isSafeInteger(event.sequence) ||
    event.sequence <= resource.sequence
  )
    return;
  if (event.kind === "detached") return; // Only the retained promise proves drain.
  if (event.kind === "attached") {
    if (!acceptItem(resource, event)) return;
  } else if (event.kind === "failure" && resource.itemId === null && event.itemId !== null) {
    // A failed preparation may have constructed an item without ever attaching it.
    if (!acceptItem(resource, { attemptId: event.attemptId, itemId: event.itemId })) return;
  } else if (event.itemId !== resource.itemId) return;
  resource.sequence = event.sequence;
  if (!current) return;
  switch (event.kind) {
    case "attached":
      return;
    case "failure": {
      if (!event.terminal) return;
      const stopped = resource.session?.failure();
      return fail(
        stopped ? { kind: "format", failure: stopped } : { kind: "native", failure: event.failure },
      );
    }
    case "media-services-reset":
      return fail({ kind: "reset" });
    case "ready": {
      if (!current.item.live) length.set(event.durationSeconds ?? 0);
      if (current.seek !== null) {
        const from = current.seek;
        current.seek = null;
        if (from > 0) player().currentTime = from;
      }
      void refreshTracks(resource);
      return;
    }
    case "tracks":
      acceptTracks(resource, event.tracks);
      void refreshTracks(resource);
      return;
    case "ended":
      if (!pauseOnStart && !current.item.live) {
        report();
        current.options.ended?.();
      }
      return;
    case "state": {
      clock.set(event.mediaTimeSeconds);
      const { phase } = state.get();
      if (phase.kind === "idle" || phase.kind === "failed") return;
      const playing = event.timeControl === "playing";
      if (playing && pauseOnStart) {
        player().pause();
        return;
      }
      if (playing && !current.loaded) {
        current.loaded = true;
        current.options.outcome?.(true);
      }
      if (playing) checkpoint ??= setInterval(report, CHECKPOINT_MS);
      else if (checkpoint !== null) {
        clearInterval(checkpoint);
        checkpoint = null;
      }
      if (!playing && phase.kind === "playing") report();
      const kind = playing
        ? "playing"
        : phase.kind === "loading" && !pauseOnStart
          ? "loading"
          : "paused";
      if (kind !== phase.kind) {
        state.set((s) => ({ ...s, phase: { kind, item: phase.item } }));
      }
    }
  }
}

/** Read fixed bridge codes only. Native descriptions and wrapped causes never become UI text. */
function bridgeCode(cause: unknown): string | null {
  for (let depth = 0; depth < 4 && typeof cause === "object" && cause !== null; depth++) {
    if ("code" in cause && cause.code === "ERR_OBSERVED_NOT_DRAINED") return cause.code;
    cause = "cause" in cause ? cause.cause : null;
  }
  return null;
}
let admitted = false;

/** One same-player bootstrap retry yields through the async bridge, without a media reload. */
async function attach(
  resource: Resource,
  source: Parameters<VideoPlayer["replaceObservedAsync"]>[0],
) {
  try {
    const result = await player().replaceObservedAsync(source, resource.id);
    admitted = true;
    return result;
  } catch (cause) {
    if (admitted || !stands(resource) || bridgeCode(cause) !== "ERR_OBSERVED_NOT_DRAINED")
      throw cause;
    const result = await player().replaceObservedAsync(source, resource.id);
    admitted = true;
    return result;
  }
}

/** Plays only after earlier native and format readers positively close. No source probes. */
export async function play(item: Playing, open: Open, options: PlayOptions) {
  requests++;
  release();
  const controller = new AbortController();
  let signedIn = item.subscriptionId === null ? undefined : currentSource(item.subscriptionId);
  let sourceBound = signedIn !== undefined;
  let drained!: () => void;
  let uncertain!: (cause: Error) => void;
  let opened!: () => void;
  const closed = new Promise<void>((resolve, reject) => {
    drained = resolve;
    uncertain = reject;
  });
  void closed.catch(() => undefined); // Admission and reader handles still observe rejection.
  const resource: Resource = {
    id: ++attempts,
    controller,
    subscriptionId: item.subscriptionId,
    sourceStands: () =>
      item.subscriptionId === null ||
      !sourceBound ||
      currentSource(item.subscriptionId) === signedIn,
    formats: [],
    closed,
    drained,
    uncertain,
    opening: new Promise<void>((resolve) => {
      opened = resolve;
    }),
    opened,
    itemId: null,
    sequence: 0,
    retired: false,
    detach: null,
    settlement: null,
    session: null,
    tracks: null,
    querying: null,
  };
  current = {
    item,
    open,
    options,
    seek: options.from ?? null,
    loaded: false,
    stoppedAt: null,
    resource,
    failure: null,
  };
  resumeOnReturn = false;
  pauseOnStart = false;
  soundOnPlay = false;
  const owned = current;
  state.set((s) => {
    const muted = options.watch || s.watch ? false : s.muted;
    player().muted = muted;
    return {
      ...s,
      phase: { kind: "loading", item: owned.item },
      watch: options.watch || s.watch,
      aside: false,
      muted,
    };
  });
  let stage: "readers" | "lookup" | "native" = "native";
  try {
    if (player().mrStreamerPlaybackContract !== 1) throw new Error("Player contract unavailable.");
    stage = "readers";
    await waitForReaders(resource);
    if (!stands(resource)) return;
    stage = "lookup";
    if (item.subscriptionId !== null) await reclaimBeforeLookup(resource, item.subscriptionId);
    if (!stands(resource)) return;
    if (!sourceBound) {
      signedIn = item.subscriptionId === null ? undefined : currentSource(item.subscriptionId);
      sourceBound = true;
    }
    const source = await open(controller.signal);
    if (!stands(resource)) return;
    let playable = {
      uri: source.url,
      ...(source.headers ? { headers: { ...source.headers } } : {}),
      contentType: source.container === "m3u8" ? ("hls" as const) : ("auto" as const),
    };
    if (!item.live && THROUGH_SESSION.has(source.container.toLowerCase())) {
      const opening = openFormat(source.url, source.headers, options.from ?? 0, controller.signal);
      resource.formats.push(opening);
      // Observe failure now, even if opening itself is still pending.
      void opening.closed.catch(() => undefined);
      const opened = await opening.opened;
      if (!stands(resource)) return opening.close();
      if (opened.kind === "session") {
        const { session } = opened;
        resource.session = session;
        void session.failed.then((failure) => {
          if (stands(resource)) fail({ kind: "format", failure });
        });
        playable = { uri: session.playlist, contentType: "hls" };
        owned.seek = null;
      } else {
        await opening.closed;
        if (!stands(resource)) return;
      }
    }
    stage = "native";
    const result = await attach(resource, playable);
    if (!stands(resource)) return;
    if (result.attemptId !== resource.id) return fail({ kind: "bridge" });
    if (result.kind === "attached") {
      if (!acceptItem(resource, result)) return fail({ kind: "bridge" });
      player().play();
    } else if (result.kind === "failed") {
      if (
        result.itemId !== null &&
        !acceptItem(resource, { attemptId: result.attemptId, itemId: result.itemId })
      ) {
        return fail({ kind: "bridge" });
      }
      fail({ kind: "native", failure: result.failure });
    } else fail({ kind: "cancelled" });
  } catch (cause) {
    if (!stands(resource)) return;
    if (stage === "lookup") {
      const error = appError(cause);
      fail(
        error.kind === "stream"
          ? { kind: "format", failure: error.failure }
          : { kind: "lookup", error },
      );
    } else fail({ kind: stage === "readers" ? "detach-timeout" : "bridge" });
  } finally {
    resource.opened();
    if (!stands(resource) && !resource.retired) void retire(resource);
  }
}

/** Plays what failed or stopped again, a title from where it got to. */
export function retry() {
  if (!current) return;
  const { item, open, options, stoppedAt } = current;
  const from = stoppedAt ?? options.from;
  void play(item, open, {
    ...options,
    watch: state.get().watch,
    ...(from === undefined ? {} : { from }),
  });
}

/**
 * Stops playing and closes Watch, Picture in Picture and the accessory, saving how far a title
 * got. What plays next on Home starts without sound again. Waits for its real reader settlement
 * and reports only the save outcome. Uncertain closure stays blocked in the resource ledger.
 */
export async function stop(): Promise<Saved> {
  requests++;
  const saved = release();
  const readers = current?.resource.settlement;
  current = null;
  endPictureInPicture?.();
  player().muted = true;
  resumeOnReturn = false;
  pauseOnStart = false;
  soundOnPlay = false;
  state.set((s) => ({
    ...s,
    phase: { kind: "idle" },
    watch: false,
    pip: false,
    aside: false,
    muted: true,
  }));
  // Saved says only whether progress was kept. Reader failure remains in closing and on the
  // captured reader handle, even when Stop returns its save result.
  await readers?.catch(() => undefined);
  return saved;
}

/**
 * Play or Pause, the viewer's own: in Watch, or from the accessory while Watch is set aside, where
 * it replaces setting aside's own pause, so bringing Watch back keeps whatever they chose last.
 * It goes by what the player last reported, as the accessory shows it. Play after Close plays with
 * the sound Close silenced (`soundOnPlay`).
 */
export function togglePause() {
  resumeOnReturn = false;
  const { phase } = state.get();
  if (phase.kind === "playing" || phase.kind === "loading") {
    pauseOnStart = phase.kind === "loading" ? "viewer" : false;
    player().pause();
  } else if (phase.kind === "paused") {
    pauseOnStart = false;
    if (soundOnPlay) setMuted(false);
    player().play();
  }
}

export function seekBy(seconds: number) {
  player().seekBy(seconds);
}

/** Moves a title to `seconds` from its start. */
export function seekTo(seconds: number) {
  player().currentTime = Math.max(0, seconds);
  clock.set(Math.max(0, seconds));
}

export function setMuted(muted: boolean) {
  soundOnPlay = false;
  player().muted = muted;
  state.set((s) => ({ ...s, muted }));
}

/** Existing Watch rows. Selection acknowledges a request; subsequent readback checks the row. */
export interface TrackChoice {
  readonly kind: "track" | "off";
  readonly label: string;
  readonly selected: boolean;
  readonly choose: () => Promise<void>;
}

type Track =
  | ObservedTrackSnapshot["audio"]["options"][number]
  | ObservedTrackSnapshot["subtitles"]["options"][number];

function labelled<T extends Track>(tracks: readonly T[], fallback: string) {
  const labels = tracks.map((track) => track.label || track.language || fallback);
  return tracks.map((track, i) => {
    const label = labels[i] ?? fallback;
    if (labels.indexOf(label) === labels.lastIndexOf(label)) return { track, label };
    const number = labels.slice(0, i + 1).filter((other) => other === label).length;
    return { track, label: `${label} · ${track.name || number}` };
  });
}

/** Query actual groups when the menu opens. A retained row cannot select on a newer item/revision. */
export async function trackChoices(of: "audio" | "subtitles"): Promise<readonly TrackChoice[]> {
  const resource = current?.resource;
  if (!resource) return [];
  const tracks = await refreshTracks(resource);
  if (!tracks || !stands(resource)) return [];
  const choose = async (selection: ObservedTrackSelection) => {
    if (!stands(resource) || resource.tracks?.revision !== tracks.revision) return;
    if (selection.track && !selection.track.isPlayable) return;
    if (!selection.track && !tracks.subtitleOffAllowed) return;
    try {
      const result = await player().selectObservedTrackAsync(tracks, tracks.revision, selection);
      if (result.kind === "requested" && stands(resource)) await refreshTracks(resource);
    } catch {
      /* Selection is unconfirmed. No optimistic checkmark or raw bridge error. */
    }
  };
  if (of === "audio") {
    if (tracks.audio.state !== "ready") return [];
    return labelled(
      tracks.audio.options.filter((track) => track.isPlayable),
      "Sound",
    ).map(({ track, label }) => ({
      kind: "track" as const,
      label,
      selected: tracks.selectedAudioId === track.id,
      choose: () => choose({ kind: "audio", track }),
    }));
  }
  if (tracks.subtitles.state !== "ready") return [];
  return [
    ...(tracks.subtitleOffAllowed
      ? [
          {
            kind: "off" as const,
            label: "Off",
            selected: tracks.selectedSubtitleId === null,
            choose: () => choose({ kind: "subtitles", track: null }),
          },
        ]
      : []),
    ...labelled(
      tracks.subtitles.options.filter((track) => track.isPlayable),
      "Subtitles",
    ).map(({ track, label }) => ({
      kind: "track" as const,
      label,
      selected: tracks.selectedSubtitleId === track.id,
      choose: () => choose({ kind: "subtitles", track }),
    })),
  ];
}

/**
 * Plays the episode after the one playing, saving how far this one got first: its owner is given
 * that save, to read the record once it ended.
 */
export function playNext() {
  const saved = report();
  current?.options.next?.(saved);
}

/** Shows the other versions of the title that failed. */
export function showVersions() {
  current?.options.versions?.();
}

/**
 * Shows the player full screen, bringing it back from Picture in Picture or from being set aside.
 * What setting it aside paused plays again: a movie or an episode from where it paused, a channel
 * live again rather than from where it paused. What failed meanwhile shows its failure.
 */
export function openWatch() {
  soundOnPlay = false;
  player().muted = false;
  const { pip, aside, phase } = state.get();
  if (pip) endPictureInPicture?.();
  state.set((s) => ({ ...s, watch: true, aside: false, muted: false }));
  const resume = aside && resumeOnReturn;
  if (pauseOnStart === "away") pauseOnStart = false;
  resumeOnReturn = false;
  if (!resume || (phase.kind !== "playing" && phase.kind !== "paused")) return;
  if (phase.item.live) retry();
  else if (phase.kind === "paused") {
    pauseOnStart = false;
    player().play();
  }
}

/**
 * Back to the tabs at once, saving where a title got to. Picture in Picture or AirPlay already
 * showing it plays on there, muted or not as it was. Otherwise nothing plays unseen: what plays
 * pauses; what still loads pauses as it starts; what was paused or failed stays so. It goes
 * silent, as Home's preview is, so what plays next on Home starts without sound; Play from the
 * accessory brings back the sound it had (`soundOnPlay`). Resolves with how the save went once
 * it ended; a format session paused keeps its request open for Play.
 */
export function closeWatch(): Promise<Saved> {
  requests++;
  const { pip, external, phase, muted } = state.get();
  const away = !pip && !external;
  if (away) {
    resumeOnReturn = false;
    if ((phase.kind === "playing" || phase.kind === "loading") && !pauseOnStart) {
      pauseOnStart = "away";
    }
    soundOnPlay = !muted;
    if (phase.kind === "playing") player().pause();
  }
  const silent = away || muted;
  player().muted = silent;
  state.set((s) => ({ ...s, watch: false, aside: false, muted: silent }));
  return report();
}

/**
 * Watch gives way to Downloads or Settings where Picture in Picture can't take the picture over.
 * On AirPlay it plays on, as when Watch closes. Otherwise nothing plays unseen: what plays pauses,
 * what still loads pauses as it starts, and what was paused or failed stays so. The accessory over
 * the tabs shows it as it is and brings Watch back (`openWatch`).
 */
export function setAside() {
  requests++;
  const { phase, external } = state.get();
  if (phase.kind === "idle" || external) return void closeWatch();
  resumeOnReturn = phase.kind === "playing" || phase.kind === "loading";
  if ((phase.kind === "playing" || phase.kind === "loading") && !pauseOnStart) {
    pauseOnStart = "away";
  }
  if (phase.kind === "playing") player().pause();
  // Paused, it makes no sound; played again from the accessory, it plays as Watch would.
  player().muted = false;
  state.set((s) => ({ ...s, watch: false, aside: true, muted: false }));
}

/**
 * Watch shows again what was set aside, as it stands, when nothing else can bring it back: the
 * tabs and their accessory went, as when the last provider is removed while a downloaded copy
 * waits. A paused copy stays paused where it was; nothing opens again.
 */
export function unsetAside() {
  if (!state.get().aside) return;
  resumeOnReturn = false;
  player().muted = false;
  state.set((s) => ({ ...s, watch: true, aside: false, muted: false }));
}

/**
 * Watch reports Picture in Picture starting and ending. It leaves Watch for the tabs, where the
 * accessory controls it; once it ends, Home's preview shows the player again.
 */
export function pictureInPicture(active: boolean) {
  requests++;
  if (active) {
    state.set((s) => ({ ...s, pip: true, watch: false, aside: false }));
    return;
  }
  const { watch } = state.get();
  if (!watch) player().muted = true;
  state.set((s) => ({ ...s, pip: false, muted: s.watch ? s.muted : true }));
}

/**
 * The viewer brought Picture in Picture back to the app rather than closing it: Watch shows the
 * player again, with its sound, before Picture in Picture reports that it ended. Returns what
 * Watch shows, or null when nothing streams in Picture in Picture any more (it stopped or failed
 * first), so there is nothing to return to.
 */
export function restoreFromPictureInPicture(): Playing | null {
  const { phase, pip } = state.get();
  const item = playingItem(phase);
  if (!pip || item === null) return null;
  player().muted = false;
  state.set((s) => ({ ...s, watch: true, muted: false }));
  return item;
}

export function onPlaybackFailure(listener: ((failure: AnalyticsFailure) => void) | null) {
  failed = listener;
}

export function onEndPictureInPicture(end: (() => void) | null) {
  endPictureInPicture = end;
}

export function onReclaim(take: ((subscriptionId: string) => Promise<void>) | null) {
  reclaim = take;
}

export function onProgressRefused(tell: (() => void) | null) {
  refused = tell;
}
