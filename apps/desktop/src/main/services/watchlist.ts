// The watchlist: movies and whole series the viewer saved to watch later. It is apart from the
// viewing record: playing, finishing or leaving Continue watching changes no entry, and saving or
// removing one changes nothing of how far a title got.
//
// What an account saved is its own, kept by the provider's own ids as the viewing record is. The
// watchlist the viewer sees is every saved subscription's together. A film two of them list
// under one TMDB id is one title in the lists and one entry here, whichever of them saved it;
// nothing else joins what two subscriptions saved, so a record without that proof stays an entry
// of its own (see @mrstreamer/core/ondemand/watchlist).
//
// Saving a title saves it for every subscription that lists a version of it now, in one
// transaction: all of them or none. Nobody is asked which. A subscription added later that lists
// the title too plays it from the same entry, and is given no record of it by itself. Removing an
// entry takes out what every subscription saved of it, also where its provider lists it no more.
//
// What is saved is worked out here, from the title as the lists have it: its name, year and
// kind, whether it is for adults, its TMDB id and the ids of each subscription's versions. The UI
// names a title by one of its versions and sends nothing else, and no provider is asked anything.
// A change is told to the UI after it is stored.
//
// Which title an entry is now, the lists say each time the watchlist is read, so an entry no
// provider lists any more stays, without a title, and has one again when it is listed again.
import type { TitleKind, TitleListsStatus } from "@mrstreamer/contracts/ondemand";
import { hasTitles, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistPage, WatchlistSort } from "@mrstreamer/contracts/watchlist";
import { Failed } from "@mrstreamer/core/failure";
import { factsOf } from "@mrstreamer/core/ondemand/watchlist";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { WatchlistStore, type Membership } from "../platform/watchlist-store.ts";
import { OnDemand } from "./ondemand.ts";
import { sameSource, Subscriptions, type SavedSubscription } from "./subscription.ts";

/** Which page of the watchlist. */
export interface WatchlistQuery {
  readonly home?: boolean;
  readonly sort: WatchlistSort;
  readonly offset: number;
  readonly limit: number;
}

export class Watchlist extends Context.Service<
  Watchlist,
  {
    /**
     * A page of what the saved subscriptions saved, as the entries it makes, each with the title
     * it is in the lists now. Titles for adults show, and count, only while the viewer shows
     * them. Empty without a subscription that has movies and series.
     */
    list(query: WatchlistQuery): Effect.Effect<WatchlistPage, Failed>;
    /**
     * The entry a movie or series is saved as, named by any of its versions, or null. Fails with
     * `no-subscription`, as saving and removing do, when the subscription named isn't saved.
     */
    saved(kind: TitleKind, version: OwnedId): Effect.Effect<OwnedId | null, Failed>;
    /**
     * Saves a movie or a whole series, named by one of its versions, for every subscription that
     * lists it now, and answers its entry once it is stored. A title saved already keeps its
     * entry and the time it was saved, and a subscription that lists it now without a record of
     * it gets one. Fails with `title-not-found` when the lists don't have the version, and with
     * `no-subscription` when a subscription that lists the title went, or had its login stored
     * anew, while the lists were read: nothing is stored then.
     */
    save(kind: TitleKind, version: OwnedId): Effect.Effect<OwnedId, Failed>;
    /**
     * Takes an entry out, with what every saved subscription saved of it, also one whose title
     * the lists no longer have. What a subscription that isn't saved kept stays its own.
     */
    remove(entry: OwnedId): Effect.Effect<void, Failed>;
    /** Says so after each title saved or removed. */
    readonly changes: Stream.Stream<void>;
  }
>()("mrstreamer/Watchlist") {
  static readonly layer = Layer.effect(Watchlist, make());
}

function make() {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const onDemand = yield* OnDemand;
    const store = yield* WatchlistStore;
    const changes = yield* PubSub.unbounded<void>();
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });
    /** The fetch of its lists each subscription's record was last brought in line with, by its id. */
    let alignedTo: ReadonlyMap<string, number> = new Map();

    /**
     * The saved subscriptions that have movies and series, in their order, also while a password
     * can't be read: what they saved shows either way. Unmapped playlists have none to save.
     */
    const saving = Effect.map(subscriptions.saved, (saved) => saved.filter(hasTitles));

    /** Those, when the one `named` belongs to is among them. */
    const savingWith = (named: OwnedId) =>
      Effect.flatMap(saving, (found) =>
        found.some((each) => each.id === named.subscriptionId)
          ? Effect.succeed(found)
          : Effect.fail(noSubscription),
      );

    /**
     * Brings what `source` saved in line with its lists, once for each fetch of them: a title's
     * new name and versions are taken over, a title that got a TMDB id since is known by it from
     * then on, and records that turn out to be one title become one. Answers whether it is in
     * line now. When it isn't, the record stays as it is and the next call tries again.
     */
    const align = (found: readonly SavedSubscription[], source: SavedSubscription) =>
      Effect.gen(function* () {
        const entries = yield* store.entries([source.key]);
        if (entries.length === 0) return true;
        const titles = yield* onDemand.savedFacts(found, source, entries);
        // The lists went meanwhile, or the subscription did, or its login was stored anew: what
        // was worked out for it is no longer its own. Check again in the write transaction.
        if (!titles || !(yield* subscriptions.stands(source))) return false;
        yield* store.adopt(source.key, titles, () => subscriptions.standsNow(source));
        return true;
      }).pipe(
        Effect.catchTag("Failed", (failed) =>
          Effect.as(
            Effect.logWarning("[watchlist] the saved titles keep what they had", failed.error),
            false,
          ),
        ),
      );

    /** Brings what each of `found` saved in line with its lists as `lists` say they were fetched. */
    const alignTo = (found: readonly SavedSubscription[], lists: readonly TitleListsStatus[]) =>
      Effect.gen(function* () {
        const next = new Map<string, number>();
        for (const source of found) {
          const fetchedAt = lists.find((each) => each.subscriptionId === source.id)?.fetchedAt;
          // Without lists there is nothing to go by.
          if (fetchedAt === null || fetchedAt === undefined) continue;
          if (alignedTo.get(source.id) === fetchedAt || (yield* align(found, source))) {
            next.set(source.id, fetchedAt);
          }
        }
        alignedTo = next;
      });

    // After every fetch of the lists, so a title is followed from one fetch to the next: what
    // the provider renames today and drops tomorrow is known by what it was last.
    yield* Effect.forkScoped(
      Stream.runForEach(onDemand.changes, ({ lists }) =>
        Effect.flatMap(saving, (found) => alignTo(found, lists)),
      ),
    );

    /**
     * The same before a read or a change, for lists this run only read from disk, or whose fetch
     * hasn't been taken over yet.
     */
    const aligned = (found: readonly SavedSubscription[]) =>
      Effect.flatMap(onDemand.status, ({ lists }) => alignTo(found, lists));

    /** The title a version belongs to as the lists have it, with every subscription's versions. */
    const listed = (kind: TitleKind, version: OwnedId) =>
      Effect.map(onDemand.titles(kind, [version]), ([title]) => title ?? null);

    /** What `found` saved, each record named with its subscription. */
    const membersOf = (found: readonly SavedSubscription[]) =>
      Effect.map(store.entries(found.map((each) => each.key)), (entries) =>
        entries.flatMap(({ account, ...entry }) => {
          const owner = found.find((each) => each.key === account);
          return owner ? [{ ...entry, subscriptionId: owner.id }] : [];
        }),
      );

    /** A record as the UI names its entry: with the subscription whose account keeps it. */
    const entryOf = (found: readonly SavedSubscription[], { account, id }: Membership) => {
      const owner = found.find((each) => each.key === account);
      return owner ? Effect.succeed({ subscriptionId: owner.id, id }) : Effect.fail(noSubscription);
    };

    return {
      list: ({ sort, offset, limit, home }: WatchlistQuery) =>
        Effect.gen(function* () {
          const found = yield* saving;
          if (found.length === 0) return { total: 0, entries: [] };
          yield* aligned(found);
          const members = yield* membersOf(found);
          if (members.length === 0) return { total: 0, entries: [] };
          return yield* onDemand.saved(found, {
            members,
            sort,
            offset,
            limit,
            ...(home ? { home } : {}),
          });
        }),

      saved: (kind: TitleKind, version: OwnedId) =>
        Effect.gen(function* () {
          yield* aligned(yield* savingWith(version));
          const title = yield* listed(kind, version);
          if (!title) return null;
          // As saved now: the lists may have taken a while.
          const found = yield* saving;
          const first = yield* store.find(
            found.map((each) => ({ account: each.key, facts: factsOf(title, each.id) })),
          );
          return first && (yield* entryOf(found, first));
        }),

      save: (kind: TitleKind, version: OwnedId) =>
        Effect.gen(function* () {
          const before = yield* savingWith(version);
          yield* aligned(before);
          const missing = new Failed({ error: { kind: "title-not-found", titleId: version.id } });
          const title = yield* listed(kind, version);
          if (!title) return yield* missing;
          const at = yield* Clock.currentTimeMillis;
          // Every subscription the lists gave a version of must keep its source, including at
          // the transaction itself: a roster read may have answered a pre-removal snapshot.
          const found = yield* saving;
          const stands = title.versions.every(({ subscriptionId }) => {
            const was = before.find((each) => each.id === subscriptionId);
            const now = found.find((each) => each.id === subscriptionId);
            return was !== undefined && sameSource(was, now);
          });
          if (!stands) return yield* noSubscription;
          const first = yield* store.save({
            listed: found.map((each) => ({ account: each.key, facts: factsOf(title, each.id) })),
            at,
            stands: () =>
              title.versions.every(({ subscriptionId }) => {
                const source = before.find((each) => each.id === subscriptionId);
                return source !== undefined && subscriptions.standsNow(source);
              }),
          });
          if (!first) return yield* missing;
          yield* PubSub.publish(changes, undefined);
          return yield* entryOf(found, first);
        }),

      remove: (entry: OwnedId) =>
        Effect.gen(function* () {
          // What a subscription that went kept is no longer the viewer's to change. The
          // transaction checks the named owner and selects the other accounts still saved.
          const found = yield* saving;
          const owner = found.find((each) => each.id === entry.subscriptionId);
          if (!owner) return yield* noSubscription;
          yield* store.remove({
            accounts: () =>
              found.filter((each) => subscriptions.standsNow(each)).map((each) => each.key),
            account: owner.key,
            id: entry.id,
            stands: () => subscriptions.standsNow(owner),
          });
          yield* PubSub.publish(changes, undefined);
        }),

      changes: Stream.fromPubSub(changes),
    };
  });
}
