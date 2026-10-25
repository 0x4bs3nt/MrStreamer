// Movies and episodes downloaded to this computer: the queue, its one transfer at a time, and the
// copies that play without a subscription. Each download is a record in the database
// (../platform/downloads-store.ts) and a folder of its own in the app's downloads folder, with
// the file, a partial file while it transfers, and the artwork kept for it. Paths, addresses and
// logins stay here; the window sees the records as `Download`s.
//
// One download transfers at a time, of whichever subscription: the first in the queue whose
// subscription plays nothing. PlaybackCoordination lends its provider connection and takes
// it back for any stream of that subscription (see PlaybackCoordination.lend): the transfer
// stops, its request ends, and it waits with its partial file until nothing of its subscription
// plays. Another subscription's stream lets it go on. A transfer goes on from its partial file
// only when the provider proves it is the same file; otherwise it starts again and says so (see
// ../downloads/transfer.ts). It becomes a copy once every byte is on disk: the partial is flushed,
// renamed, and only then marked complete. Quitting keeps the queue and its partial files.
//
// The queue goes in the viewer's order: each unfinished download has its place (`order`, or when
// it was added for one an older build added), a new one goes last, and moving one swaps it with
// its neighbour among those waiting, the transfer under way staying put. A paused one keeps its
// place and its partial file and is passed over until resumed. Its pause is the viewer's alone:
// written down before its transfer is stopped, so nothing can take it meanwhile, and never
// written or cleared by playback taking the connection back. Paused is no stored state: an older
// build reads such a download as queued and transfers it, in the order downloads were added,
// keeping both keys for this build to find again.
//
// Only what the database says decides which folders are no download's: when it can't be read,
// nothing is listed, queued or cleaned up, and each call says so. A row this build can't read
// keeps its folder for the build that wrote it.
//
// A copy keeps what it needs to show and play without asking anyone: its details and artwork,
// read as it was queued, how far it was watched here, and the subtitles saved for the exact file
// it was made from (see `subtitlesOfCopy`). Removing a subscription cancels its unfinished
// downloads; its copies stay, and play, until the viewer deletes them.
//
// An episode also keeps what its series version listed then, from the details its queuing read
// anyway: its seasons in order and its TMDB id. The window hears each series version of an account
// by a key made up in this run, so nothing of the account reaches it, with the seasons its latest
// queued download listed; which copies go together and what plays next are worked out from those
// (see @mrstreamer/core/downloads/series). An episode queued before this, or by an earlier build,
// has no series and stands alone.
import { downloadFailure, type OperationObserver } from "../analytics/operations.ts";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  artworkUrl,
  type Download,
  type DownloadArtwork,
  type DownloadList,
  type DownloadFailure,
  type DownloadSeries,
} from "@mrstreamer/contracts/downloads";
import type { EpisodeDetails, RawTitleRef, TitleRef } from "@mrstreamer/contracts/ondemand";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { t } from "@mrstreamer/core/i18n";
import { fileDisk, transfer, type Disk, type TransferOutcome } from "../downloads/transfer.ts";
import {
  DownloadStore,
  type About,
  type PartIdentity,
  type SeriesKept,
  type StoredDownload,
} from "../platform/downloads-store.ts";
import { SavedSubtitles, subtitlesOfCopy } from "../platform/saved-subtitles.ts";
import { OnDemand } from "./ondemand.ts";
import { Playback, type LocalCopy } from "./playback.ts";
import { PlaybackCoordination, type Lent } from "./playback-coordination.ts";
import { Subscriptions } from "./subscription.ts";

/** How often the window hears how a transfer goes, at most. */
const CHANGES_MS = 250;
/** How often a transfer's progress is written down, so a restart goes on from about there. */
const SAVE_MS = 5000;
/** The most a picture kept for a download may be. */
const ARTWORK_BYTES = 8 * 1024 * 1024;
const ARTWORK_MS = 20_000;
const ID = /^[0-9a-f-]{36}$/;

export interface DownloadsDeps {
  readonly dataDir: string;
  readonly userAgent: string;
  readonly observeTransfer?: OperationObserver;
  /** The disk transfers write to; the file system except in tests. */
  readonly disk?: Disk;
  /** What artwork is fetched with; `fetch` except in tests. */
  readonly fetch?: typeof fetch;
}

export class Downloads extends Context.Service<
  Downloads,
  {
    readonly list: Effect.Effect<DownloadList, Failed>;
    /**
     * Queues a movie or an episode, by the exact version given, with its details and artwork kept
     * for the copy. One of the same account already queued or downloaded, or added while this
     * was looked up, answers as it is; a failed one is queued again. Fails while its subscription
     * can't be asked, or doesn't list it, and once it was removed or logged in anew meanwhile.
     */
    add(title: TitleRef): Effect.Effect<Download, Failed>;
    /**
     * Cancels an unfinished download, or deletes a copy, with everything kept for it. What plays
     * the copy closes first; a transfer stops, and its request ends, before its files go.
     */
    remove(id: string): Effect.Effect<void, Failed>;
    /** Queues a failed download again, in its place. */
    retry(id: string): Effect.Effect<void, Failed>;
    /**
     * Pauses an unfinished download that hasn't failed. The pause is written down first, so the
     * queue can't take the download meanwhile; a transfer then stops, and this answers once its
     * request ended, its partial file closed and where it stopped is written down. Fails, changing
     * nothing, when the pause can't be written down: a transfer goes on. A transfer stopped before
     * where it got to can't be written down fails too, its pause and partial file kept on disk:
     * until the next start, this run lists it as failed, with Retry.
     */
    pause(id: string): Effect.Effect<void, Failed>;
    /** Lets a paused download take its turn again, going on from its partial file where proven. */
    resume(id: string): Effect.Effect<void, Failed>;
    /** Pauses every unfinished download that hasn't failed, as `pause` does, in one write. */
    readonly pauseAll: Effect.Effect<void, Failed>;
    /** Resumes every paused download, in one write. */
    readonly resumeAll: Effect.Effect<void, Failed>;
    /**
     * Moves a download waiting its turn, paused or not, one place earlier (-1) or later (1) among
     * those waiting. The transfer under way neither moves nor stops. Fails, changing nothing, when
     * the new order can't be written down.
     */
    move(id: string, by: -1 | 1): Effect.Effect<void, Failed>;
    recordProgress(id: string, position: number, duration: number): Effect.Effect<void, Failed>;
    /** A complete copy, for playback to open; fails when it isn't, or its file is gone. */
    copy(id: string): Effect.Effect<LocalCopy, Failed>;
    /** A copy's kept picture, for the app's artwork scheme; null without one. */
    artwork(
      id: string,
      artwork: DownloadArtwork,
    ): Effect.Effect<{ readonly path: string; readonly type: string } | null>;
    /**
     * A subscription is going: its unfinished downloads end, their transfer and files with them.
     * Its copies stay.
     */
    subscriptionGone(subscriptionId: string): Effect.Effect<void>;
    /** The list after every change, each later than the last, a few times a second at most. */
    readonly changes: Stream.Stream<DownloadList>;
  }
>()("mrstreamer/Downloads") {
  static readonly layer = (deps: DownloadsDeps) => Layer.effect(Downloads, make(deps));
}

/** The transfer under way. */
interface Active {
  readonly id: string;
  /** Stops it for the viewer or the app; playback's lease stops it for a stream. */
  readonly controller: AbortController;
  received: number;
  size: number | null;
  identity: PartIdentity | null;
  restarted: boolean;
  rate: number | null;
  /** Settles once its request is over, the partial closed and its lease given back. */
  over: Promise<void>;
  /**
   * Settles once what it ended with is written down: a copy, a failure, or where it stopped. Says
   * why, when that couldn't be written down.
   */
  settled: Promise<Failed | null>;
}

function make(deps: DownloadsDeps) {
  return Effect.gen(function* () {
    const store = yield* DownloadStore;
    const playback = yield* Playback;
    const coordination = yield* PlaybackCoordination;
    const onDemand = yield* OnDemand;
    const subscriptions = yield* Subscriptions;
    const savedSubtitles = yield* SavedSubtitles;
    const scope = yield* Effect.scope;
    const disk = deps.disk ?? fileDisk;
    const fetchArtwork = deps.fetch ?? fetch;
    const root = join(deps.dataDir, "downloads");
    const changes = yield* PubSub.sliding<DownloadList>(4);

    const folderOf = (id: string) => join(root, id);
    const mediaOf = (record: StoredDownload) =>
      join(folderOf(record.id), `media.${extensionOf(record.container)}`);
    const partOf = (record: StoredDownload) => `${mediaOf(record)}.part`;

    const records = new Map<string, StoredDownload>();
    const loaded = yield* Effect.result(store.list);
    // Without its table nothing can be queued or listed either: each call says so, as the store
    // says it then, in the interface language of that moment. A read that works later still fails:
    // nothing on disk was checked against the table at the start.
    const unloaded =
      loaded._tag === "Failure"
        ? store.list.pipe(Effect.andThen(Effect.fail(loaded.failure)))
        : null;
    if (loaded._tag === "Failure") {
      yield* Effect.logWarning("[downloads] can't be read", loaded.failure.error);
    }
    const inventory = loaded._tag === "Success" ? loaded.success : null;
    for (const record of inventory?.records ?? []) records.set(record.id, record);
    /** Copies whose file is gone, as last looked: looked at again as the window asks for the list. */
    const missing = new Set<string>();
    let active: Active | null = null;
    let ended = 0;
    let closing = false;

    /**
     * Writes a record and keeps it. Every write is synchronous, as the database is: none can come
     * between a removal's and its record going, so nothing writes a removed download back.
     */
    const write = (record: StoredDownload) => {
      Effect.runSync(store.put(record));
      records.set(record.id, record);
    };
    /** Changes a download's record as it is now; one removed meanwhile stays removed. */
    const update = (id: string, change: (latest: StoredDownload) => StoredDownload) => {
      const latest = records.get(id);
      if (latest) write(change(latest));
    };
    /** Writes several records in one transaction and keeps them: all of them, or none. */
    const writeAll = (changed: readonly StoredDownload[]) => {
      if (changed.length === 0) return;
      Effect.runSync(store.putMany(changed));
      for (const record of changed) records.set(record.id, record);
    };

    /** A download's place in the queue: its own, or when it was added, as an older build kept it. */
    const placeOf = (record: StoredDownload) => record.order ?? record.addedAt;
    /** The unfinished downloads in queue order; one placed alike keeps the order it was read in. */
    const unfinished = () =>
      [...records.values()]
        .filter((record) => record.state !== "complete")
        .toSorted((a, b) => placeOf(a) - placeOf(b));
    /** The place after every unfinished download's: where a new one goes. */
    const lastPlace = () => {
      let last = 0;
      for (const record of records.values()) {
        if (record.state !== "complete") last = Math.max(last, placeOf(record));
      }
      return last + 1;
    };

    // A copy renamed into place as the app stopped, before it was written down as complete.
    for (const record of records.values()) {
      if (
        record.state === "queued" &&
        record.size !== null &&
        (yield* Effect.promise(() => disk.size(mediaOf(record)))) === record.size
      ) {
        const { pausedAt: _pausedAt, order: _order, ...rest } = record;
        const complete: StoredDownload = {
          ...rest,
          state: "complete",
          received: record.size,
          completedAt: Date.now(),
        };
        yield* store.put(complete).pipe(Effect.ignore);
        records.set(record.id, complete);
      }
    }
    // Folders no row names: left by a deletion that couldn't finish, or a download that went.
    // Only a database read whole tells them; a row this build can't read still names its own.
    if (inventory) {
      const { unreadable } = inventory;
      yield* Effect.promise(async () => {
        const names = await readdir(root).catch(() => []);
        await Promise.all(
          names
            .filter((name) => ID.test(name) && !records.has(name) && !unreadable.has(name))
            .map((name) => rm(folderOf(name), { recursive: true, force: true }).catch(() => {})),
        );
      });
    }

    const lookForMissing = () => {
      missing.clear();
      for (const record of records.values()) {
        if (record.state === "complete" && !existsSync(mediaOf(record))) missing.add(record.id);
      }
    };
    lookForMissing();

    /**
     * Each series version of an account as the window knows it: a key made up for it in this run.
     * An Xtream account's key holds its username, so the window never sees what it is made of. Its
     * TMDB id splits it: a provider that gives a series' id to another series gives another key.
     */
    const seriesKeys = new Map<string, string>();
    const seriesKeyOf = (record: StoredDownload): string | null => {
      if (!record.series || record.title.kind !== "episode") return null;
      const version = JSON.stringify([record.account, record.title.seriesId, record.series.tmdb]);
      const known = seriesKeys.get(version);
      if (known) return known;
      const made = randomUUID();
      seriesKeys.set(version, made);
      return made;
    };

    /** The saved subscription of each account now, by its key, with the name it shows. */
    const accounts = Effect.gen(function* () {
      const [saved, listed] = yield* Effect.all([subscriptions.saved, subscriptions.list]);
      const names = new Map(listed.map((each) => [each.id, each.name ?? hostOf(each.server)]));
      return new Map(
        saved.map((each) => [each.key, { id: each.id, name: names.get(each.id) ?? "" }]),
      );
    });

    const downloadOf = (
      record: StoredDownload,
      owners: ReadonlyMap<string, { readonly id: string; readonly name: string }>,
      busy: ReadonlySet<string>,
    ): Download => ({
      id: record.id,
      title: record.title,
      subscription: owners.get(record.account) ?? null,
      name: record.about.name,
      episodeName: record.about.episodeName,
      year: record.about.year,
      duration: record.about.duration,
      originalLanguage: record.about.originalLanguage,
      posterUrl: record.about.poster ? artworkUrl(record.id, "poster") : null,
      wideUrl: record.about.wide ? artworkUrl(record.id, "wide") : null,
      size:
        record.state === "complete"
          ? record.received
          : active?.id === record.id
            ? active.size
            : record.size,
      status:
        record.state === "complete"
          ? { kind: missing.has(record.id) ? "missing" : "complete" }
          : record.state === "failed"
            ? {
                kind: "failed",
                failure: record.failure ?? {
                  kind: "app",
                  error: { kind: "unexpected", detail: t("This download stopped.") },
                },
              }
            : active?.id === record.id
              ? {
                  kind: "transferring",
                  received: active.received,
                  size: active.size,
                  rate: active.rate,
                  restarted: active.restarted,
                }
              : record.pausedAt !== undefined
                ? { kind: "paused", received: record.received, size: record.size }
                : busy.has(record.subscriptionId)
                  ? { kind: "waiting" }
                  : { kind: "queued" },
      progress: record.progress && {
        position: record.progress.position,
        duration: record.progress.duration,
      },
      series: seriesKeyOf(record),
    });

    /** What each series of the downloads listed, by its key: as its latest queued one read it. */
    const seriesOf = (all: readonly StoredDownload[]) => {
      const latest = new Map<string, { readonly addedAt: number; readonly series: SeriesKept }>();
      for (const record of all) {
        const key = seriesKeyOf(record);
        const before = key ? latest.get(key) : undefined;
        if (key && record.series && (!before || record.addedAt >= before.addedAt)) {
          latest.set(key, { addedAt: record.addedAt, series: record.series });
        }
      }
      return Object.fromEntries(
        [...latest].map(([key, { series }]): [string, DownloadSeries] => [
          key,
          { seasons: series.seasons, sourceOrder: series.sourceOrder },
        ]),
      );
    };

    const view = Effect.gen(function* () {
      const owners = yield* accounts;
      const busy = yield* coordination.busy;
      const all = [...records.values()];
      // The transfer leads, then those waiting their turn in their order, then the failed ones.
      const queue = unfinished();
      const leads = (record: StoredDownload) =>
        record.state === "queued" && record.id === active?.id;
      const copies = all
        .filter((record) => record.state === "complete")
        .toSorted((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      const free = yield* Effect.promise(async () => {
        await mkdir(root, { recursive: true }).catch(() => {});
        return disk.free(root);
      });
      return {
        items: [
          ...queue.filter(leads),
          ...queue.filter((record) => record.state === "queued" && !leads(record)),
          ...queue.filter((record) => record.state === "failed"),
          ...copies,
        ].map((record) => downloadOf(record, owners, busy)),
        series: seriesOf(all),
        bytes: all.reduce(
          (sum, record) => sum + (active?.id === record.id ? active.received : record.received),
          0,
        ),
        free,
        ended,
      } satisfies DownloadList;
    });

    let telling: NodeJS.Timeout | undefined;
    /** Whether a list is being made to tell, and whether anything changed since it began. */
    let viewing = false;
    let stale = false;
    /**
     * Tells the window, once the changes of the next moment are in. One list is made at a time,
     * so one that waits on the disk can't arrive after a later one; what changes while it is made
     * is told once it is out.
     */
    const tell = () => {
      if (closing) return;
      if (viewing) stale = true;
      if (telling || viewing) return;
      telling = setTimeout(() => {
        telling = undefined;
        viewing = true;
        void Effect.runPromise(view)
          .then(
            (list) => PubSub.publishUnsafe(changes, list),
            () => {},
          )
          .finally(() => {
            viewing = false;
            if (stale) {
              stale = false;
              tell();
            }
          });
      }, CHANGES_MS);
    };

    /**
     * The first download the queue may start now, in its order: queued, not paused, and of a
     * subscription that plays nothing and didn't refuse its connection in this choice.
     */
    const firstAllowed = (busy: ReadonlySet<string>, refused: ReadonlySet<string>) =>
      unfinished().find(
        (record) =>
          record.state === "queued" &&
          record.pausedAt === undefined &&
          !busy.has(record.subscriptionId) &&
          !refused.has(record.subscriptionId),
      );

    /**
     * Starts the first download allowed to go, if none goes on. Its subscription's connection is
     * lent under playback's admission, which can wait on an open or a removal: the queue may have
     * been reordered, paused or emptied meanwhile. Whatever is first then starts, when the lease is
     * its subscription's; otherwise the lease goes back and the choice is made again from the queue
     * as it is.
     */
    let picking = false;
    let again = false;
    const next = async (): Promise<void> => {
      if (picking) {
        again = true;
        return;
      }
      picking = true;
      try {
        // Subscriptions that lent nothing in this choice: something of theirs plays. Woken
        // meanwhile, as when playback stopped, the queue forgets them: they may lend now.
        const refused = new Set<string>();
        for (;;) {
          if (active || closing) return;
          if (again) refused.clear();
          again = false;
          const chosen = firstAllowed(await Effect.runPromise(coordination.busy), refused);
          if (!chosen) {
            if (!again) return;
            continue;
          }
          const lent = await Effect.runPromise(coordination.lend(chosen.subscriptionId));
          if (!lent) {
            refused.add(chosen.subscriptionId);
            continue;
          }
          const busy = await Effect.runPromise(coordination.busy);
          if (again) refused.clear();
          // Read only now: the app may have begun to close while the lease was asked for.
          const first = closing ? undefined : firstAllowed(busy, refused);
          if (first?.subscriptionId === chosen.subscriptionId) {
            start(first, lent);
            return;
          }
          lent.release();
        }
      } finally {
        picking = false;
      }
    };
    const wake = () => void next();

    /** Transfers `record` on the connection playback lent it. */
    const start = (record: StoredDownload, lent: Lent) => {
      const finished = deps.observeTransfer?.();
      const controller = new AbortController();
      let outcome: TransferOutcome = { kind: "stopped" };
      const transferring: Active = {
        id: record.id,
        controller,
        received: record.received,
        size: record.size,
        identity: record.identity,
        restarted: record.restarted,
        rate: null,
        over: Promise.resolve(),
        settled: Promise.resolve(null),
      };
      active = transferring;
      tell();
      transferring.over = transferOf(
        record,
        transferring,
        AbortSignal.any([controller.signal, lent.signal]),
      )
        .then(
          (ended) => void (outcome = ended),
          (cause) =>
            void (outcome = {
              kind: "failed",
              failure: { kind: "app", error: failedWith(cause).error },
            }),
        )
        // Only once its request is over does the subscription's stream go on.
        .finally(() => lent.release());
      transferring.settled = transferring.over
        .then(async () => {
          const failure = await settle(record.id, transferring, outcome);
          if (failure === "stopped") finished?.("interrupted");
          else if (failure) finished?.("failed", downloadFailure(failure));
          else finished?.(outcome.kind === "stopped" ? "interrupted" : "success");
          return null;
        })
        .catch((cause) => {
          finished?.("failed", "app");
          console.warn("[downloads] couldn't keep how a transfer ended", cause);
          const failure = cause instanceof Failed ? cause : failedWith(cause);
          // Failed as far as this run knows, so the queue doesn't take it again and again.
          const latest = records.get(record.id);
          if (latest?.state === "queued") {
            records.set(record.id, {
              ...latest,
              state: "failed",
              failure: { kind: "app", error: failure.error },
            });
          }
          return failure;
        })
        .finally(() => {
          active = null;
          tell();
          wake();
        });
    };

    /** Asks the provider for `record`'s file and writes it into its partial file. */
    const transferOf = async (
      record: StoredDownload,
      transferring: Active,
      signal: AbortSignal,
    ): Promise<TransferOutcome> => {
      const title: TitleRef = { ...record.title, subscriptionId: record.subscriptionId };
      // Stopped while the file is looked up, nothing is asked of the provider's file.
      const resolved = await Effect.runPromise(
        Effect.all([subscriptions.sourceOf(record.subscriptionId), onDemand.file(title)]).pipe(
          Effect.result,
        ),
        { signal },
      ).catch(() => null);
      if (!resolved || signal.aborted) return { kind: "stopped" };
      if (resolved._tag === "Failure") {
        return { kind: "failed", failure: { kind: "app", error: resolved.failure.error } };
      }
      const [source, file] = resolved.success;
      // The file the bytes are of: its listing and login, which its saved subtitles are kept by.
      update(record.id, (latest) => ({
        ...latest,
        listingKey: file.listingKey,
        sourceStamp: source.fileRevision,
      }));
      try {
        await mkdir(folderOf(record.id), { recursive: true });
      } catch (cause) {
        return { kind: "failed", failure: { kind: "folder", detail: messageOf(cause) } };
      }
      if (signal.aborted) return { kind: "stopped" };
      let savedAt = performance.now();
      let measured = { at: performance.now(), received: record.received };
      return transfer({
        url: file.url,
        headers: file.headers ?? {},
        request: source.provider.request,
        userAgent: deps.userAgent,
        part: partOf(record),
        known: record.identity,
        signal,
        disk,
        progress: ({ received, size, restarted }) => {
          if (active !== transferring) return;
          const now = performance.now();
          if (now - measured.at >= 1000) {
            const rate = ((received - measured.received) * 1000) / (now - measured.at);
            transferring.rate = rate >= 0 ? rate : null;
            measured = { at: now, received };
          }
          const again = restarted !== transferring.restarted;
          transferring.received = received;
          transferring.size = size;
          transferring.restarted = restarted;
          tell();
          // How far it got goes down now and then; what the partial is of, as `identify` says.
          if (again || now - savedAt >= SAVE_MS) {
            savedAt = now;
            try {
              update(record.id, (latest) => ({ ...latest, received, size, restarted }));
            } catch {
              // Written down at the end, or the transfer goes on from less.
            }
          }
        },
        // Throws when it can't be written down, before the transfer touches the partial.
        identify: (identity) => {
          transferring.identity = identity;
          if (sameIdentity(records.get(record.id)?.identity ?? null, identity)) return;
          const { received, size, restarted } = transferring;
          update(record.id, (latest) => ({ ...latest, received, size, identity, restarted }));
        },
      });
    };

    /** Writes down how a transfer ended: a copy, a failure, or where it stopped. */
    const settle = async (
      id: string,
      transferring: Active,
      outcome: TransferOutcome,
    ): Promise<DownloadFailure | "stopped" | undefined> => {
      const record = records.get(id);
      // Removed meanwhile: its files are the removal's.
      if (!record) return "stopped";
      const { received, size, identity, restarted } = transferring;
      const where = { ...record, received, size, identity, restarted };
      if (outcome.kind === "stopped") {
        update(id, () => where);
        return;
      }
      if (outcome.kind === "failed") {
        update(id, () => ({ ...where, state: "failed", failure: outcome.failure }));
        return outcome.failure;
      }
      try {
        await rename(partOf(record), mediaOf(record));
      } catch (cause) {
        const failure: DownloadFailure = { kind: "folder", detail: messageOf(cause) };
        update(id, () => ({ ...where, state: "failed", failure }));
        return failure;
      }
      // What was saved for the exact bytes it was made from comes with the copy. Saved for other
      // bytes, or without proof of which, it stays the provider file's.
      const source = await Effect.runPromise(
        subscriptions.sourceOf(record.subscriptionId).pipe(Effect.option),
      );
      if (source._tag === "Some" && outcome.identity && records.has(id)) {
        await Effect.runPromise(
          savedSubtitles
            .duplicate(
              {
                account: source.value.key,
                sourceStamp: record.sourceStamp,
                listingKey: record.listingKey,
                kind: record.title.kind,
                id: record.title.id,
              },
              subtitlesOfCopy(record.id, record.title),
              outcome.identity,
            )
            .pipe(Effect.ignore),
        );
      }
      if (!records.has(id)) return "stopped";
      missing.delete(id);
      // A copy has no place in the queue, and a pause asked for as it finished pauses nothing.
      update(id, (latest) => {
        const { failure: _failure, pausedAt: _pausedAt, order: _order, ...rest } = latest;
        return {
          ...rest,
          state: "complete",
          received: outcome.size,
          size: outcome.size,
          identity: outcome.identity,
          restarted,
          completedAt: Date.now(),
        };
      });
    };

    /**
     * Stops the transfer under way, its pause already written down: done once its request ended,
     * its partial file closed and where it stopped is kept. Fails, the transfer stopped all the
     * same, when where it stopped can't be kept.
     */
    const stopPaused = async (transferring: Active) => {
      transferring.controller.abort();
      const failure = await transferring.settled;
      if (failure) throw failure;
    };

    /**
     * Takes a download out: its record at once, so nothing writes it back; then its transfer stops,
     * its request ends, its playback closes and its files go.
     */
    const removeOne = async (id: string) => {
      const record = records.get(id);
      if (!record) return;
      Effect.runSync(store.remove(id));
      records.delete(id);
      missing.delete(id);
      const transferring = active?.id === id ? active : null;
      if (transferring) {
        transferring.controller.abort();
        await transferring.settled;
      }
      await Effect.runPromise(playback.closeCopy(id));
      await Effect.runPromise(
        savedSubtitles.forget(subtitlesOfCopy(id, record.title)).pipe(Effect.ignore),
      );
      // What can't go now, as a file Windows still holds, goes as the app starts next.
      await rm(folderOf(id), { recursive: true, force: true }).catch(() => {});
    };

    // Whatever plays decides which subscriptions' downloads wait.
    yield* Effect.forkIn(
      Stream.runForEach(coordination.busyChanged, () =>
        Effect.sync(() => {
          tell();
          wake();
        }),
      ),
      scope,
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        closing = true;
        clearTimeout(telling);
        const stopping = active;
        if (!stopping) return;
        stopping.controller.abort();
        await stopping.settled;
      }),
    );
    wake();

    const attempt = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) => (cause instanceof Failed ? cause : failedWith(cause)),
      });

    // Made when it fails, so it says so in the interface language of the moment.
    const notFound = () =>
      new Failed({
        error: { kind: "unexpected", detail: t("That download is no longer here.") },
      });

    return {
      list: Effect.suspend(() => {
        if (unloaded) return unloaded;
        lookForMissing();
        return view;
      }),

      add: (title: TitleRef) =>
        Effect.gen(function* () {
          if (unloaded) return yield* unloaded;
          const source = yield* subscriptions.sourceOf(title.subscriptionId);
          const { subscriptionId, ...raw } = title;
          const knownOf = () =>
            [...records.values()].find(
              (record) =>
                record.account === source.key &&
                record.title.kind === raw.kind &&
                record.title.id === raw.id,
            );
          const answer = (known: StoredDownload) =>
            Effect.gen(function* () {
              if (known.state === "failed") {
                yield* attempt(async () =>
                  update(known.id, ({ failure: _failure, pausedAt: _pausedAt, ...rest }) => ({
                    ...rest,
                    state: "queued",
                  })),
                );
                tell();
                wake();
              }
              const owners = yield* accounts;
              return downloadOf(records.get(known.id) ?? known, owners, yield* coordination.busy);
            });
          const known = knownOf();
          if (known) return yield* answer(known);
          // Asked first: a title its provider doesn't list now isn't queued.
          const file = yield* onDemand.file(title);
          const kept = yield* aboutOf(raw, subscriptionId);
          // Both took a while. A subscription removed or logged in anew meanwhile had its unfinished
          // downloads ended without this one (a removal ends them again once it is gone, after
          // this look), and the same title may have been added meanwhile: that one is the answer.
          // Nothing waits between the second look and the write.
          if (!(yield* subscriptions.stands(source))) {
            return yield* new Failed({ error: { kind: "no-subscription" } });
          }
          const added = knownOf();
          if (added) return yield* answer(added);
          const record: StoredDownload = {
            id: randomUUID(),
            account: source.key,
            subscriptionId,
            title: raw,
            listingKey: file.listingKey,
            sourceStamp: source.fileRevision,
            container: file.container,
            about: { ...kept.about, poster: null, wide: null },
            ...("series" in kept ? { series: kept.series } : {}),
            state: "queued",
            size: null,
            received: 0,
            identity: null,
            restarted: false,
            addedAt: Date.now(),
            // Last in the queue, so a season added episode by episode keeps their order.
            order: lastPlace(),
            completedAt: null,
            progress: null,
          };
          yield* attempt(async () => write(record));
          yield* Effect.forkIn(
            Effect.promise(() => keepArtwork(record.id, kept.artwork)),
            scope,
          );
          tell();
          wake();
          return downloadOf(record, yield* accounts, yield* coordination.busy);
        }),

      remove: (id: string) =>
        attempt(async () => {
          await removeOne(id);
          tell();
          wake();
        }),

      retry: (id: string) =>
        attempt(async () => {
          const record = records.get(id);
          if (!record) throw notFound();
          if (record.state !== "failed") return;
          // Retry asks for the transfer, so a pause an older build kept through the failure goes.
          const { failure: _failure, pausedAt: _pausedAt, ...rest } = record;
          write({ ...rest, state: "queued" });
          tell();
          wake();
        }),

      pause: (id: string) =>
        attempt(async () => {
          const record = records.get(id);
          if (!record) throw notFound();
          if (record.state !== "queued") return;
          if (record.pausedAt === undefined) {
            write({ ...record, pausedAt: Date.now() });
            tell();
          }
          if (active?.id === id) await stopPaused(active);
        }),

      resume: (id: string) =>
        attempt(async () => {
          const record = records.get(id);
          if (!record) throw notFound();
          if (record.state !== "queued" || record.pausedAt === undefined) return;
          const { pausedAt: _pausedAt, ...rest } = record;
          write(rest);
          tell();
          wake();
        }),

      pauseAll: attempt(async () => {
        const at = Date.now();
        writeAll(
          [...records.values()]
            .filter((record) => record.state === "queued" && record.pausedAt === undefined)
            .map((record) => ({ ...record, pausedAt: at })),
        );
        tell();
        if (active && records.get(active.id)?.pausedAt !== undefined) await stopPaused(active);
      }),

      resumeAll: attempt(async () => {
        writeAll(
          [...records.values()]
            .filter((record) => record.state === "queued" && record.pausedAt !== undefined)
            .map(({ pausedAt: _pausedAt, ...rest }) => rest),
        );
        tell();
        wake();
      }),

      move: (id: string, by: -1 | 1) =>
        attempt(async () => {
          const record = records.get(id);
          if (!record) throw notFound();
          const queue = unfinished();
          const waiting = queue.filter((each) => each.state === "queued" && each.id !== active?.id);
          const from = waiting.indexOf(record);
          const other = waiting[from + by];
          if (from < 0 || !other) return;
          // Swapped in the whole queue, then every unfinished download given its place from 1, so
          // two an older build added at the same moment swap too, and the rest keep their order.
          const order = queue.with(queue.indexOf(record), other).with(queue.indexOf(other), record);
          writeAll(
            order.flatMap((each, index) =>
              each.order === index + 1 ? [] : [{ ...each, order: index + 1 }],
            ),
          );
          tell();
        }),

      recordProgress: (id: string, position: number, duration: number) =>
        attempt(async () => {
          const record = records.get(id);
          if (record?.state !== "complete") throw notFound();
          write({
            ...record,
            progress: { position: Math.min(position, duration), duration, at: Date.now() },
          });
          tell();
        }),

      copy: (id: string) =>
        Effect.suspend(() => {
          const record = records.get(id);
          if (record?.state !== "complete" || !existsSync(mediaOf(record))) {
            if (record?.state === "complete" && !missing.has(id)) {
              missing.add(id);
              tell();
            }
            return Effect.fail(
              new Failed({
                error: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
              }),
            );
          }
          return Effect.succeed({
            id: record.id,
            path: mediaOf(record),
            container: record.container,
            title: record.title,
            progress: record.progress && {
              position: record.progress.position,
              duration: record.progress.duration,
            },
          } satisfies LocalCopy);
        }),

      artwork: (id: string, artwork: DownloadArtwork) =>
        Effect.sync(() => {
          const record = records.get(id);
          const type = record?.about[artwork];
          return record && type ? { path: join(folderOf(record.id), artwork), type } : null;
        }),

      subscriptionGone: (subscriptionId: string) =>
        Effect.promise(async () => {
          const gone = [...records.values()].filter(
            (record) => record.subscriptionId === subscriptionId && record.state !== "complete",
          );
          if (gone.length === 0) return;
          for (const record of gone) await removeOne(record.id).catch(() => {});
          ended += gone.length;
          tell();
          wake();
        }),

      changes: Stream.fromPubSub(changes),
    };

    /**
     * What a download keeps of its title's details, and where its pictures are online, from the
     * details the viewer just opened: a movie's, or an episode's with its series', and what that
     * series lists, so its copies are placed and go on offline. Nothing more is asked for that.
     */
    function aboutOf(title: RawTitleRef, subscriptionId: string) {
      return Effect.gen(function* () {
        if (title.kind === "movie") {
          const details = yield* onDemand.details("movie", { subscriptionId, id: title.id });
          return {
            about: {
              name: details.title.title,
              episodeName: null,
              year: details.title.year,
              duration: details.duration,
              originalLanguage: details.title.originalLanguage,
            },
            artwork: {
              poster: details.title.posterUrl,
              wide: details.backdropUrl ?? details.title.backdropUrl,
            },
          };
        }
        const series = yield* onDemand.details("series", { subscriptionId, id: title.seriesId });
        const season = yield* onDemand
          .season({ subscriptionId, id: title.seriesId }, title.season)
          .pipe(Effect.orElseSucceed((): readonly EpisodeDetails[] => []));
        const episode =
          season.find((each) => each.id === title.id) ??
          (series.kind === "series"
            ? series.seasons.flatMap((each) => each.episodes).find((each) => each.id === title.id)
            : undefined);
        return {
          about: {
            name: series.title.title,
            episodeName: episode?.title ?? null,
            year: series.title.year,
            duration: episode?.duration ?? series.duration,
            originalLanguage: series.title.originalLanguage,
          },
          artwork: {
            poster: series.title.posterUrl,
            wide: episode?.stillUrl ?? series.backdropUrl ?? series.title.backdropUrl,
          },
          ...(series.kind === "series"
            ? {
                series: {
                  tmdb: series.title.tmdbId,
                  seasons: seriesEpisodeSeasons(series).map(({ number, episodes }) => ({
                    number,
                    episodes: episodes.map((each) => each.number),
                  })),
                  sourceOrder: series.episodeOrder !== undefined,
                },
              }
            : {}),
        };
      });
    }

    /**
     * Fetches a download's pictures into its folder, so the copy shows them with no network. One
     * that doesn't come leaves the copy without it.
     */
    async function keepArtwork(
      id: string,
      urls: { readonly poster: string | null; readonly wide: string | null },
    ): Promise<void> {
      const kept: Partial<Record<DownloadArtwork, string>> = {};
      for (const artwork of ["poster", "wide"] as const) {
        const url = urls[artwork];
        if (!url || !/^https?:\/\//.test(url)) continue;
        const picture = await fetchPicture(url).catch(() => null);
        if (!picture || !records.has(id)) continue;
        try {
          await mkdir(folderOf(id), { recursive: true });
          await writeFile(join(folderOf(id), artwork), picture.bytes);
          kept[artwork] = picture.type;
        } catch {
          // Without it, the copy shows its name.
        }
      }
      if (Object.keys(kept).length === 0) return;
      try {
        update(id, (latest) => ({
          ...latest,
          about: { ...latest.about, ...kept } satisfies About,
        }));
      } catch {
        // Fetched again by nothing: the copy shows its name.
      }
      tell();
    }

    async function fetchPicture(
      url: string,
    ): Promise<{ readonly bytes: Uint8Array; readonly type: string } | null> {
      const response = await fetchArtwork(url, {
        headers: { "User-Agent": deps.userAgent },
        signal: AbortSignal.timeout(ARTWORK_MS),
      });
      const type = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!response.ok || !type.startsWith("image/") || !response.body) {
        void response.body?.cancel().catch(() => {});
        return null;
      }
      const parts: Uint8Array[] = [];
      let length = 0;
      for await (const part of response.body) {
        length += part.length;
        if (length > ARTWORK_BYTES) return null;
        parts.push(part);
      }
      return { bytes: Buffer.concat(parts), type };
    }
  });
}

function sameIdentity(a: PartIdentity | null, b: PartIdentity | null): boolean {
  return a?.resource === b?.resource && a?.mark === b?.mark && a?.size === b?.size;
}

/** A file type safe to name a file with; anything else is kept as "bin". */
function extensionOf(container: string): string {
  return /^[a-z0-9]{1,8}$/i.test(container) ? container.toLowerCase() : "bin";
}

function hostOf(server: string): string {
  return URL.parse(server)?.host || server;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
