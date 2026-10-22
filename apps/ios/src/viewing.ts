import { AppFailure } from "@mrstreamer/contracts/errors";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Title, TitleDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import type {
  EpisodeMark,
  FavouriteOrder,
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
import {
  favouriteOf,
  membershipFile,
  readMembership,
  reconcile,
  sameMembership,
  type Membership,
} from "./viewing-membership.ts";

// Favourite channels, how far movies and episodes got, the episodes marked by hand and Continue
// watching: core's viewing record service, the desktop's own rules, over core's in-memory store,
// whose snapshot is kept in viewing.json in Documents and written whole after every change. Each
// saved subscription has a record of its own, under its id (private beta 2's one already did):
// account.ts says which are saved and which channels Live shows, and erases one's record when it
// is removed with its history. Live channels watched lately stay in storage.ts.
//
// A favourite keeps the provider's stream ids of its channel. Beside the record, the same file
// keeps which of a provider's stream ids were seen together in one channel
// (`favouriteMembership`, viewing-membership.ts), so a favourite stays one favourite while its
// provider lists some of its qualities and not others, after a relaunch too: starred, unstarred
// and moved whole, by the channel that lists them now, or under its lowest stream while none
// does. Every write of the record writes that memory with it, as the catalogue stood then, and
// only once the file took both does the app go by it. A catalogue that groups those ids otherwise
// is written too, as it shows; one the file refuses is kept until the next write. A field another
// build wrote, or one this build can't trust, is written back as it is, and favourites then go by
// the channels listed now alone, until a provider's history is deleted: as this build can't tell
// which part was that provider's, that write drops all of it. Starring, unstarring and reordering
// are decided and written before their promise is answered, so the screens' checks of a moment
// before still hold.

const FILE = "viewing.json";

/** The saved subscriptions' ids, in their order; set by account.ts. */
let owners: readonly string[] = [];

/**
 * The channels Live shows, by the `ownedKey` of each channel and of each of its streams; set by
 * account.ts. A subscription whose channels don't show has none here.
 */
let channels: ReadonlyMap<string, LiveChannel> = new Map();

/** What the lists hold of a series, for which episodes it has; set by titles.ts. */
export interface ViewingCatalogue {
  /**
   * The series a version belongs to in the lists, once they show for its subscription; none when
   * its subscription's titles aren't listed. Rejects when the lists don't come in time.
   */
  readonly series: (version: OwnedId) => Promise<Title | undefined>;
  readonly details: (title: Title) => Promise<TitleDetails>;
}
let catalogue: ViewingCatalogue = {
  series: async () => undefined,
  details: () => Promise.reject(new AppFailure({ kind: "no-subscription" })),
};

const viewing = store<Viewing | null>(null);
/** The record as it stands; null before it was first read or without a subscription. */
export const useViewing = () => useStore(viewing);
/** The record as the screens have it, for handlers outside React. */
export const currentViewing = () => viewing.get();

/** viewing.json as this launch read it. */
const read = readJson(FILE);

function snapshot(): ViewingSnapshot | null {
  return read && typeof read === "object" && "version" in read && read.version === 1
    ? (read as ViewingSnapshot)
    : null;
}

/** The favourites' memory as read: another build's, or one not to trust, is only carried. */
const kept = readMembership(
  read && typeof read === "object" && "favouriteMembership" in read
    ? read.favouriteMembership
    : undefined,
);
/** Whether favourites may go by the memory: none read, or one this build reads. */
const remembers = kept.kind !== "kept";
/**
 * The memory this build can't read, written back as it is, until a provider's history is erased:
 * that write leaves it out, as it can't tell what of it was that provider's.
 */
let carried: unknown = kept.kind === "kept" ? kept.value : undefined;
/** Set while a provider's history is erased, for that write alone. */
let erasing = false;

/** The record as the file holds it: what was read, then each snapshot written. */
let base: ViewingSnapshot | null = snapshot();
/**
 * Which stream ids were seen together: what the file holds, and any grouping the catalogue
 * showed since that the file refused, until a write takes it. Never what a refused change of the
 * record would have made it.
 */
let membership: Membership = kept.kind === "read" ? kept.membership : {};

/** Each account's favourites as `snapshot` holds them: its own stream ids. */
const favouritesIn = (snapshot: ViewingSnapshot) =>
  new Map(Object.entries(snapshot.accounts).map(([key, each]) => [key, each.state.favourites]));

/** The whole file for `snapshot` with the memory `next`, or the field read where it is carried. */
const fileOf = (snapshot: ViewingSnapshot, next: Membership) => ({
  ...snapshot,
  favouriteMembership: remembers ? membershipFile(next) : erasing ? undefined : carried,
});

/**
 * Writes the record's snapshot with the memory as it follows from it and the channels shown now,
 * as one file. Only once the file took it do both stand; else it throws, and the store undoes
 * the change.
 */
function save(next: ViewingSnapshot) {
  const after = remembers ? reconcile(membership, favouritesIn(next), channels) : membership;
  writeJson(FILE, fileOf(next, after));
  base = next;
  membership = after;
  if (erasing) carried = undefined;
}

/**
 * Takes in how the channels shown now group the favourites' streams, and writes it beside the
 * record as last written. A write the file refuses keeps it in memory for the next one.
 */
function observe() {
  if (!remembers || !base) return;
  const after = reconcile(membership, favouritesIn(base), channels);
  if (sameMembership(after, membership)) return;
  membership = after;
  try {
    writeJson(FILE, fileOf(base, after));
  } catch {
    // Kept until the next write of the record, which writes it too.
  }
}

/** Which favourite a subscription's stream ids are, by the memory and the channels shown now. */
const favourite = (subscriptionId: string) =>
  Effect.sync(() => favouriteOf(subscriptionId, membership[subscriptionId] ?? [], channels));

const layer = ViewingRecord.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.sync(ViewingStore, () => memoryViewingStore({ snapshot: base, save })),
      Layer.succeed(ViewingAccount, {
        // The record key is the subscription's id, which comes back when an account is added
        // again, so nothing is ever rekeyed.
        owners: Effect.sync(() =>
          owners.map((subscriptionId) => ({
            subscriptionId,
            key: subscriptionId,
            original: false,
          })),
        ),
      }),
      // Read when the record is: the channels shown then, so favourites show by them.
      Layer.succeed(ViewingChannels, {
        lookup: (subscriptionId) =>
          Effect.sync(() => {
            const shown = channels;
            return (id: string) => shown.get(ownedKey({ subscriptionId, id }));
          }),
        ...(remembers ? { favourite } : {}),
      }),
      Layer.succeed(ViewingSeries, {
        identity: (series) =>
          Effect.tryPromise({
            try: async () => seriesIdentity(series, await catalogue.series(series)),
            catch: failedWith,
          }),
        seasons: (series) =>
          Effect.tryPromise({
            try: async () => {
              const title = await catalogue.series(series);
              if (!title) throw new AppFailure({ kind: "title-not-found", titleId: series.id });
              const found = await catalogue.details({ ...title, ...series });
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
// Built now, in one go, so a favourite's change, which runs in one go, never finds it half built.
runtime.runSyncExit(Effect.void);

type Call<A> = (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>;
const withRecord = <A>(call: Call<A>) =>
  Effect.gen(function* () {
    return yield* call(yield* ViewingRecord);
  });

/** What a call of the record ended with, or the `AppFailure` for the error it failed with. */
function outcome<A>(exit: Exit.Exit<A, Failed>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const cause = Cause.squash(exit.cause);
  throw cause instanceof Failed ? new AppFailure(cause.error) : cause;
}

/** Runs a call of the record; rejects with an `AppFailure` for the error it failed with. */
async function run<A>(call: Call<A>) {
  return outcome(await runtime.runPromiseExit(withRecord(call)));
}

/**
 * Rises whenever the saved subscriptions or the channels shown change: a read made before then is
 * dropped, as the read that change starts follows it.
 */
let generation = 0;

/** Reads the record again for the screens. */
async function refresh() {
  const asked = generation;
  if (owners.length === 0) return viewing.set(null);
  const read = await run((record) => record.state);
  if (asked === generation) viewing.set(read);
}

/** Every change goes through here: the screens read the record once it is stored. */
async function change<A>(call: (record: ViewingRecord["Service"]) => Effect.Effect<A, Failed>) {
  const result = await run(call);
  await refresh();
  return result;
}

const commandId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** The saved subscriptions, whose records the screens read together. */
export function setViewingOwners(ids: readonly string[]) {
  if (ids.length === owners.length && ids.every((id, at) => id === owners[at])) return;
  owners = ids;
  generation++;
  void refresh().catch(() => undefined);
}

/**
 * The channels Live shows, by the `ownedKey` of each channel and stream (`Library.byKey`), or
 * none while none show. The favourites are read again by them: a refresh that lists a channel's
 * streams otherwise, or no longer lists it, shows in them at once.
 */
export function setViewingChannels(byKey: ReadonlyMap<string, LiveChannel>) {
  if (byKey === channels) return;
  channels = byKey;
  // Before the record is read again, so the read goes by the grouping just seen.
  observe();
  generation++;
  void refresh().catch(() => undefined);
}

/** titles.ts says what the lists hold, once, as it loads. */
export function serveViewing(lists: ViewingCatalogue) {
  catalogue = lists;
}

/**
 * Erases what a removed subscription recorded, when its history goes with it, in one write,
 * which also drops a memory of the favourites this build can't read. Rejects, with nothing
 * changed, when the file won't take it.
 */
export async function eraseViewing(subscriptionId: string): Promise<void> {
  erasing = true;
  try {
    outcome(runtime.runSyncExit(withRecord((record) => record.erase(subscriptionId))));
  } finally {
    erasing = false;
  }
  await refresh();
}

/**
 * A favourite's change, decided and written at the call, in the same turn as what the caller
 * checked before it: the file holds it before the promise is awaited. Rejects, with nothing
 * changed, when the record refuses it or the file won't take it; resolves once the screens read it.
 */
async function changeNow(call: Call<unknown>): Promise<void> {
  outcome(runtime.runSyncExit(withRecord(call)));
  await refresh();
}

/**
 * Stars a channel, with every stream of it the favourites know, or unstars it, whichever
 * subscription it is from. Nothing plays. Rejects with nothing changed when viewing.json won't
 * take it.
 */
export function setFavourite(channel: OwnedId, favourite: boolean): Promise<void> {
  const { subscriptionId, id } = channel;
  return changeNow((record) => record.setFavourite(commandId(), { subscriptionId, id }, favourite));
}

/**
 * Puts the favourites in `order`. The ones it leaves out, those no list shows now or of a provider
 * that needs its password, keep their places. Rejects with `favourites-changed`, and nothing
 * changed, when the favourites no longer show as `order.original`, and with nothing changed when
 * viewing.json won't take it.
 */
export function reorderFavourites(order: FavouriteOrder): Promise<void> {
  return changeNow((record) => record.reorderFavourites(commandId(), order));
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
  return catalogue
    .details({ ...title, ...series })
    .then((found) =>
      found.kind === "series"
        ? run((record) => record.relist(commandId(), series, seriesEpisodeSeasons(found)))
        : undefined,
    );
}
