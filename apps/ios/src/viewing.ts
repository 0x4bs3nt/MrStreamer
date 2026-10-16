import { AppFailure } from "@mrstreamer/contracts/errors";
import type { Title, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type {
  EpisodeMark,
  SeriesViewing,
  TitleFilter,
  TitleProgress,
  Viewing,
} from "@mrstreamer/contracts/viewing";
import { failedWith, Failed } from "@mrstreamer/core/failure";
import { seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import { seriesIdentity } from "@mrstreamer/core/viewing/marks";
import { memoryViewingStore, type ViewingSnapshot } from "@mrstreamer/core/viewing/memory-store";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
  ViewingSeries,
  ViewingStore,
  type EpisodeRef,
} from "@mrstreamer/core/viewing/service";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { readJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";
import { detailsOf, titleOf, type TitleLists } from "./titles.ts";

// How far movies and episodes got, the episodes marked by hand and Continue watching: core's
// viewing record service, the desktop's own rules, over core's in-memory store, whose snapshot is
// kept in viewing.json in Documents and written whole after every change. One subscription's
// record for now, kept under its id; Disconnect erases it. Live channels watched lately stay in
// storage.ts, as before.

const FILE = "viewing.json";

let subscriptionId: string | null = null;
/** The lists, for what a series is and which episodes it lists; set by whoever reads them. */
let listed: () => TitleLists = () => ({ kind: "idle" });

const viewing = store<Viewing | null>(null);
/** The record as it stands; null before it was first read or without a subscription. */
export const useViewing = () => useStore(viewing);

function snapshot(): ViewingSnapshot | null {
  const read = readJson(FILE);
  return read && typeof read === "object" && "version" in read && read.version === 1
    ? (read as ViewingSnapshot)
    : null;
}

const layer = ViewingRecord.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.sync(ViewingStore, () =>
        memoryViewingStore({ snapshot: snapshot(), save: (next) => writeJson(FILE, next) }),
      ),
      Layer.succeed(ViewingAccount, {
        owners: Effect.sync(() =>
          subscriptionId ? [{ subscriptionId, key: subscriptionId, original: false }] : [],
        ),
      }),
      // Channels watched lately are kept apart, in storage.ts.
      Layer.succeed(ViewingChannels, { lookup: () => Effect.succeed(() => undefined) }),
      Layer.succeed(ViewingSeries, {
        identity: (series) => Effect.sync(() => seriesIdentity(series, seriesTitle(series))),
        seasons: (series) =>
          Effect.tryPromise({
            try: async () => {
              const title = seriesTitle(series);
              if (!title) throw new AppFailure({ kind: "title-not-found", titleId: series.id });
              const found = await detailsOf({ ...title, ...series });
              return found.kind === "series" ? seriesEpisodeSeasons(found) : [];
            },
            catch: failedWith,
          }),
      }),
      Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
    ),
  ),
);
const runtime = ManagedRuntime.make(layer);

/** A series version's title in the lists now, if they are read. */
function seriesTitle(series: OwnedId): Title | undefined {
  const lists = listed();
  return lists.kind === "ready" ? titleOf(lists.index, "series", series) : undefined;
}

/** Runs a call of the record; rejects with an `AppFailure` for the error it failed with. */
async function run<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>) {
  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      return yield* call(yield* ViewingRecord);
    }),
  );
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = Cause.squash(exit.cause);
  throw cause instanceof Failed ? new AppFailure(cause.error) : cause;
}

/** Reads the record again for the screens. */
async function refresh() {
  if (!subscriptionId) return;
  const id = subscriptionId;
  const read = await run((record) => record.state);
  if (subscriptionId === id) viewing.set(read);
}

/** Every change goes through here: the screens read the record once it is stored. */
async function change<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>) {
  const result = await run(call);
  await refresh();
  return result;
}

const commandId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Starts the record of the signed-in subscription; `lists` says what the catalogue holds. */
export function connectViewing(id: string, lists: () => TitleLists) {
  subscriptionId = id;
  listed = lists;
  void refresh().catch(() => undefined);
}

/** Erases what the subscription recorded, as the desktop does when a subscription is removed. */
export async function disconnectViewing() {
  const id = subscriptionId;
  subscriptionId = null;
  viewing.set(null);
  if (id) await run((record) => record.erase(id)).catch(() => undefined);
}

/** Saves how far a movie or episode played, in a play begun at `since`. */
export function recordProgress(title: TitleRef, position: number, duration: number, since: number) {
  return change((record) =>
    record.recordProgress(commandId(), title, position, duration, since),
  ).then(() => undefined);
}

/** Takes a movie or series out of Continue watching, every version of it. */
export function removeFromContinue(title: Title) {
  const versions = title.versions.map(({ subscriptionId: owner, id }) => ({
    subscriptionId: owner,
    id,
  }));
  const filter: TitleFilter = title.kind === "movie" ? { movies: versions } : { series: versions };
  return change((record) => record.removeFromContinue(commandId(), filter)).then(() => undefined);
}

/** A play watched a series to its end with nothing left to go on with. */
export function finishSeries(series: readonly OwnedId[], since: number) {
  return change((record) => record.finishSeries(commandId(), series, since)).then(() => undefined);
}

/** How far the given titles got. */
export function progressOf(filter: TitleFilter): Promise<readonly TitleProgress[]> {
  return run((record) => record.progress(filter));
}

/** How the episodes of a series version stand: progress, marks and the mark Undo takes back. */
export function seriesViewing(series: OwnedId): Promise<SeriesViewing> {
  return run((record) => record.episodes(series));
}

/** Marks an episode watched or unwatched by hand. */
export function markEpisode(episode: EpisodeRef, watched: boolean): Promise<EpisodeMark | null> {
  return change((record) => record.markEpisode(commandId(), episode, watched));
}

/** Takes back a series' latest mark, while it still can be. */
export function undoMark(series: OwnedId, revision: number) {
  return change((record) => record.undoMark(commandId(), series, revision));
}

/** Keeps the record's view of a series in line with its details as just read. */
export function relist(series: OwnedId, title: Title) {
  return detailsOf({ ...title, ...series }).then((found) =>
    found.kind === "series"
      ? run((record) => record.relist(commandId(), series, seriesEpisodeSeasons(found)))
      : undefined,
  );
}
