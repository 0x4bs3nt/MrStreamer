import type { UsageObservers } from "../analytics/observers.ts";
// The live catalogue: each saved subscription's, fetched from its provider and cached on disk,
// and all of them together as the UI asks for them over IPC. Every channel and category says
// which subscription lists it, and a request names its channels and categories the same way. A
// cache keeps the provider's ids as they came, under the account's key, in its subscription's
// folder.
//
// The catalogues stay apart underneath. Lists show them together: every channel as each
// subscription's block in the order the subscriptions were added, a search across all of them
// before it is cut, and categories of several subscriptions as one where they show under the same
// country and name. One subscription that can't be reached keeps the channels it loaded before
// and says so in its own status; the others are not held up by it.
import { join } from "node:path";
import { type } from "arktype";
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  CatalogueStatus,
  Category,
  LiveChannel,
  LiveSearchGroups,
  LiveSearchStamp,
} from "@mrstreamer/contracts/library";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { adultIn, isAdultCategory } from "@mrstreamer/core/adult";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import {
  indexLiveSearch,
  matchingSearchGroups,
  type LiveSearchIndex,
} from "@mrstreamer/core/catalogue/search";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { diagnosed } from "@mrstreamer/core/diagnostics";
import { Failed, failedWith } from "@mrstreamer/core/failure";
import type { CatalogueChannels, GuideChannels } from "@mrstreamer/core/guide/programmes";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { normalize } from "@mrstreamer/core/text";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { t } from "@mrstreamer/core/i18n";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import { Settings } from "./preferences.ts";
import {
  sameSource,
  Subscriptions,
  type SavedSubscription,
  type Source,
  type PlaylistRefresh,
} from "./subscription.ts";

/** How many results a search returns. Enough to scroll, small enough to send per keystroke. */
const SEARCH_LIMIT = 200;
/**
 * A refresh that returns fewer than this share of the channels before counts as possibly
 * incomplete. It replaces the catalogue only when a second fetch confirms it.
 */
const SHRINK_CONFIRM_SHARE = 0.5;
const SHRINK_CONFIRM_DELAY: Duration.Input = "3 seconds";
/** How many subscriptions' catalogues are fetched at a time. */
const FETCHES_AT_ONCE = 2;

// The cache stores the catalogue as the provider sent it, and display names are worked out on
// load, so improved naming rules apply without fetching again. The newest stable release reads it
// too (see docs/contributing/architecture.md), so fields are added without a new version: a file
// written before guide ids or the adult flag still loads, and counts as outdated.
const CachedCatalogue = type({
  version: "4",
  /** Which subscription produced this catalogue. */
  key: "string",
  fetchedAt: "number",
  "importRevision?": "string",
  categories: type({ id: "string", name: "string" }).array(),
  channels: type({
    id: "string",
    name: "string",
    number: "number | null",
    logoUrl: "string | null",
    categoryIds: "string[]",
    "guideId?": "string | null",
    "adult?": "boolean",
  }).array(),
}).pipe((file) => ({
  ...file,
  channels: file.channels.map((channel) => ({ ...channel, guideId: channel.guideId ?? null })),
  outdated: file.channels.some(
    (channel) => channel.guideId === undefined || channel.adult === undefined,
  ),
}));

/** What the disk cache holds. */
interface CatalogueFile extends LiveCatalogue {
  readonly version: 4;
  readonly key: string;
  readonly fetchedAt: number;
  readonly importRevision?: string;
}

/** A provider category of one subscription, with whether its name says it is for adults. */
interface OwnCategory extends Omit<Category, "members"> {
  readonly adult: boolean;
}

/** One subscription's catalogue. */
interface IndexedCatalogue {
  /** The subscription whose channels and categories these are. */
  readonly subscriptionId: string;
  readonly fetchedAt: number;
  readonly importRevision?: string;
  /** Written by a version that didn't keep guide ids. */
  readonly outdated: boolean;
  readonly categories: readonly OwnCategory[];
  readonly channels: readonly LiveChannel[];
  /** Channels by their own id and each of their streams'. */
  readonly byId: ReadonlyMap<string, LiveChannel>;
  /** Channels per category id, in provider order. */
  readonly byCategory: ReadonlyMap<string, readonly LiveChannel[]>;
  /** Normalised names of every stream, index-aligned with `channels`. */
  readonly searchNames: readonly string[];
  /** The names the channels show under, folded, index-aligned with `channels`. */
  readonly titles: readonly string[];
  readonly guide: GuideChannels;
}

/** The catalogues of several subscriptions as lists show them, in the subscriptions' order. */
interface Combined {
  /** What it was made of: the same catalogues make the same lists. */
  readonly members: readonly IndexedCatalogue[];
  readonly categories: readonly Category[];
  /** A category's channels, of every subscription it joins, by each member's `ownedKey`. */
  readonly byCategory: ReadonlyMap<string, readonly LiveChannel[]>;
  readonly channels: readonly LiveChannel[];
  readonly searchNames: readonly string[];
  /** A channel as lists show it: marked when another subscription has one of its name. */
  readonly shown: (channel: LiveChannel) => LiveChannel;
}

/** Select a category, search names, or look up explicit ids. Ids with a query include search companions. */
export interface ChannelFilter {
  readonly category?: OwnedId;
  readonly query?: string;
  readonly channels?: readonly OwnedId[];
}

export interface LibraryOptions {
  readonly usage?: UsageObservers | undefined;
  /** Waits before a confirming fetch. Tests make it instant. */
  readonly confirmDelay?: Duration.Input;
}

export class Library extends Context.Service<
  Library,
  {
    /**
     * Fetches a subscription's catalogue from its provider. Concurrent calls for one subscription
     * share a fetch, and a few subscriptions fetch at a time. A supplied mapped playlist snapshot
     * waits for an earlier refresh to finish, so its catalogue is accepted separately.
     */
    refresh(
      subscriptionId: string,
      playlist?: PlaylistRefresh,
    ): Effect.Effect<CatalogueStatus, Failed>;
    /**
     * Whether a subscription's catalogue should be fetched again: missing, older than `maxAge`,
     * or outdated.
     */
    isStale(subscriptionId: string, maxAge: Duration.Input): Effect.Effect<boolean>;
    /**
     * A subscription's channels as the lists show them, with their guide ids, for the programme
     * guide: the same object while its catalogue and what the lists show of it stay the same.
     */
    guideChannels(subscriptionId: string): Effect.Effect<CatalogueChannels, Failed>;
    /** Each saved subscription's catalogue, in the subscriptions' order. */
    readonly status: Effect.Effect<readonly CatalogueStatus[]>;
    /** The categories of every subscription, those that show as one joined. */
    readonly categories: Effect.Effect<readonly Category[], Failed>;
    /**
     * All channels in a category, the best matches for a query across every catalogue, or the
     * given channels in that order; without any of those, every channel. Search responses carry
     * their full-catalogue display group and retain all its real copies. Ids with a
     * query return their search companions. A channel's id may be any of its streams'; a channel
     * shows once.
     */
    channels(filter: ChannelFilter): Effect.Effect<readonly LiveChannel[], Failed>;
    /** Lazy, full-catalogue joins shared by every searched list. An absent key stands alone. */
    readonly searchGroups: Effect.Effect<LiveSearchGroups, Failed>;
    /**
     * The channel by its id or any of its streams'. Fails with `no-subscription` when it names a
     * subscription that isn't saved.
     */
    channel(channel: OwnedId): Effect.Effect<LiveChannel, Failed>;
    /**
     * Finds a subscription's channels by their id or any of their streams', in its catalogue in
     * memory or on disk. Never fetches one: before the first, and for a subscription that isn't
     * saved, it finds none. It looks in the catalogue kept as each id is asked for, so a refresh
     * or a removal since shows at once.
     */
    lookup(subscriptionId: string): Effect.Effect<(channelId: string) => LiveChannel | undefined>;
    /** Forgets a subscription's catalogue, for when it goes. */
    forget(subscription: SavedSubscription): Effect.Effect<void>;
    /** A subscription's status after each of its refreshes, successful or not. */
    readonly changes: Stream.Stream<CatalogueStatus>;
  }
>()("mrstreamer/Library") {
  static readonly layer = (options: LibraryOptions = {}) => Layer.effect(Library, make(options));
}

function make(options: LibraryOptions) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const settings = yield* Settings;
    const scope = yield* Effect.scope;
    const updates = yield* PubSub.unbounded<CatalogueStatus>();
    const fetchOne = (yield* Semaphore.make(FETCHES_AT_ONCE)).withPermits(1);
    /** Each subscription's catalogue, by its id, once read from disk or fetched. */
    const catalogues = new Map<string, IndexedCatalogue>();
    const refreshing = new Map<
      string,
      {
        readonly source: Source;
        readonly token: object;
        readonly fiber: Fiber.Fiber<CatalogueStatus, Failed>;
      }
    >();
    /** Why a subscription's refreshes fail, and since when, until one succeeds. */
    const failures = new Map<string, { readonly error: AppError; readonly at: number }>();
    /** The lists last made, with and without the channels for adults. */
    const made: { all: Combined | null; ordinary: Combined | null } = {
      all: null,
      ordinary: null,
    };
    /** Each subscription's channels as the guide reads them, kept while the lists are the same. */
    const guideViews = new WeakMap<Combined, Map<string, CatalogueChannels>>();
    const noSubscription = new Failed({ error: { kind: "no-subscription" } });

    const cachePath = (subscription: SavedSubscription) => join(subscription.dir, "catalogue.json");

    /** The catalogue of a saved subscription from memory or disk. Never hits the network. */
    const cached = (subscription: SavedSubscription) =>
      Effect.gen(function* () {
        const kept = catalogues.get(subscription.id);
        if (kept) return kept;
        const file = yield* Effect.promise(() =>
          readJsonFile(cachePath(subscription), CachedCatalogue),
        );
        if (file?.key !== subscription.key) return null;
        // Read by another call meanwhile, or fetched: that one stands.
        const now = catalogues.get(subscription.id) ?? index(file, subscription.id, file.outdated);
        catalogues.set(subscription.id, now);
        return now;
      });

    const statusOf = (subscriptionId: string, shown: IndexedCatalogue | null): CatalogueStatus => {
      const failure = failures.get(subscriptionId);
      return {
        subscriptionId,
        channelCount: shown?.channels.length ?? 0,
        fetchedAt: shown?.fetchedAt ?? null,
        failure: failure?.error ?? null,
        failedAt: failure?.at ?? null,
      };
    };

    /** Whether Live TV's lists show channels for adults. */
    const adults = Effect.map(settings.get, (preferences) => preferences.adultTitles ?? false);

    /** A subscription's status with its catalogue as the lists show it. */
    const statusNow = (subscription: SavedSubscription) =>
      Effect.gen(function* () {
        const found = yield* cached(subscription);
        return statusOf(subscription.id, found && ((yield* adults) ? found : withoutAdults(found)));
      });

    const fetchAndStore = (source: Source, playlist?: PlaylistRefresh) =>
      Effect.gen(function* () {
        const refreshed = options.usage?.action("playlist_refreshed");
        const fetched = yield* complete(source, yield* cached(source), playlist);
        // Dropped when the subscription went, or its login changed, while it downloaded.
        if (!(yield* subscriptions.stands(source))) return yield* switched;
        const file: CatalogueFile = {
          version: 4,
          key: source.key,
          fetchedAt: yield* Clock.currentTimeMillis,
          ...(source.importRevision ? { importRevision: source.importRevision } : {}),
          categories: fetched.categories,
          channels: fetched.channels,
        };
        // Written before it is used: the next start must not find an older catalogue on disk.
        yield* Effect.promise(() => writeJsonFile(cachePath(source), file));
        // Nor is it shown for a subscription that went while it was written.
        if (!(yield* subscriptions.stands(source))) return yield* switched;
        catalogues.set(source.id, index(file, source.id, false));
        failures.delete(source.id);
        const status = yield* statusNow(source);
        yield* PubSub.publish(updates, status);
        refreshed?.();
        return status;
      }).pipe(
        fetchOne,
        diagnosed("catalogue"),
        Effect.tapError((failed) =>
          Effect.gen(function* () {
            // How a fetch ended under a login that changed since says nothing of the one saved.
            if (!(yield* subscriptions.stands(source))) return;
            failures.set(source.id, {
              error: failed.error,
              at: failures.get(source.id)?.at ?? (yield* Clock.currentTimeMillis),
            });
            yield* PubSub.publish(updates, yield* statusNow(source));
          }),
        ),
      );

    /** Fetches `source`'s catalogue, or joins the fetch under way for it with the same login. */
    const refreshOf = (
      source: Source,
      playlist?: PlaylistRefresh,
    ): Effect.Effect<CatalogueStatus, Failed> =>
      Effect.gen(function* () {
        const under = refreshing.get(source.id);
        // A mapped combined refresh needs its own snapshot after an earlier independent fetch.
        // Unmapped Live has no titles to align and can keep joining the fetch already running.
        if (playlist && source.playlistMapped && under && sameSource(source, under.source)) {
          yield* Fiber.await(under.fiber);
          if (!(yield* subscriptions.stands(source))) return yield* switched;
          return yield* refreshOf(source, playlist);
        }
        let running = under && sameSource(source, under.source) ? under : null;
        if (!running) {
          const token = {};
          const fiber = yield* Effect.forkIn(
            fetchAndStore(source, playlist).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  if (refreshing.get(source.id)?.token === token) refreshing.delete(source.id);
                }),
              ),
            ),
            scope,
          );
          running = { source, token, fiber };
          refreshing.set(source.id, running);
        }
        return yield* Fiber.join(running.fiber);
      });

    /**
     * Fetches the catalogue and checks it against the one in use. Explicit mapping can remove
     * every channel. Otherwise an empty list never replaces channels, and a much shorter one
     * only when a second fetch returns the same.
     */
    const complete = (
      source: Source,
      previous: IndexedCatalogue | null,
      playlist?: PlaylistRefresh,
    ) =>
      Effect.gen(function* () {
        const fetch = Effect.tryPromise({
          try: (signal) => source.provider.liveCatalogue(signal),
          catch: failedWith,
        });
        const fetched = playlist ? (yield* playlist.read).live : yield* fetch;
        const before = previous?.channels.length ?? 0;
        const received = fetched.channels.length;
        if (source.playlistMapped || before === 0 || received >= before * SHRINK_CONFIRM_SHARE)
          return fetched;
        if (received > 0) {
          yield* Effect.sleep(options.confirmDelay ?? SHRINK_CONFIRM_DELAY);
          const again = yield* fetch;
          const difference = Math.abs(again.channels.length - received);
          if (again.channels.length > 0 && difference <= Math.max(10, received * 0.05)) {
            return again;
          }
        }
        return yield* new Failed({
          error: { kind: "incomplete-catalogue", received, previous: before },
        });
      });

    /**
     * The catalogues there are, in the subscriptions' order. A subscription that has none yet
     * fetches its own beside what shows, and says when it is in; with nothing to show at all,
     * the call waits for the first fetches and fails as they did when none came.
     */
    const current = Effect.gen(function* () {
      const saved = yield* subscriptions.saved;
      const [first] = saved;
      if (!first) return yield* noSubscription;
      const found = yield* Effect.forEach(saved, cached);
      const loaded = found.flatMap((each) => each ?? []);
      const missing = (yield* subscriptions.sources).filter((each) => !catalogues.has(each.id));
      if (loaded.length > 0) {
        for (const source of missing) {
          // One that failed waits for its own Retry, or the next start.
          if (!failures.has(source.id))
            yield* Effect.forkIn(Effect.ignore(refreshOf(source)), scope);
        }
        return loaded;
      }
      const failed = yield* Effect.forEach(
        missing,
        (source) =>
          Effect.match(refreshOf(source), { onFailure: (cause) => cause, onSuccess: () => null }),
        { concurrency: "unbounded" },
      );
      const fetched = (yield* subscriptions.saved).flatMap((each) => catalogues.get(each.id) ?? []);
      if (fetched.length > 0) return fetched;
      return yield* failed.find((each) => each !== null) ??
        new Failed({ error: { kind: "needs-secret", subscriptionId: first.id } });
    });

    /** The lists of `loaded`, kept while the same catalogues make them. */
    const listsOf = (slot: "all" | "ordinary", loaded: readonly IndexedCatalogue[]) => {
      const members = slot === "all" ? loaded : loaded.map(withoutAdults);
      const kept = made[slot];
      if (kept && sameMembers(kept.members, members)) return kept;
      return (made[slot] = combine(members));
    };

    /**
     * The catalogues as Live TV shows them: channels for adults only while Settings shows titles
     * for adults, and never in search.
     */
    const visible = Effect.gen(function* () {
      const loaded = yield* current;
      return {
        lists: listsOf((yield* adults) ? "all" : "ordinary", loaded),
        search: listsOf("ordinary", loaded),
      };
    });

    /** The catalogue of `subscriptionId` among those the lists show, or `no-subscription`. */
    const memberOf = (subscriptionId: string) =>
      Effect.flatMap(visible, ({ lists }) => {
        const member = lists.members.find((each) => each.subscriptionId === subscriptionId);
        return member ? Effect.succeed({ member, lists }) : Effect.fail(noSubscription);
      });

    return {
      refresh: (subscriptionId: string, playlist?: PlaylistRefresh) =>
        playlist
          ? refreshOf(playlist.source, playlist)
          : Effect.flatMap(subscriptions.sourceOf(subscriptionId), (source) => refreshOf(source)),

      isStale: (subscriptionId: string, maxAge: Duration.Input) =>
        Effect.gen(function* () {
          const subscription = (yield* subscriptions.saved).find(
            (each) => each.id === subscriptionId,
          );
          const existing = subscription ? yield* cached(subscription) : null;
          const now = yield* Clock.currentTimeMillis;
          return (
            !existing ||
            existing.outdated ||
            existing.importRevision !== subscription?.importRevision ||
            now - existing.fetchedAt > Duration.toMillis(maxAge)
          );
        }),

      guideChannels: (subscriptionId: string) =>
        Effect.map(memberOf(subscriptionId), ({ member, lists }) => {
          const views = guideViews.get(lists) ?? new Map<string, CatalogueChannels>();
          guideViews.set(lists, views);
          const kept = views.get(subscriptionId);
          if (kept) return kept;
          const view: CatalogueChannels = {
            all: member.channels.map((channel) => lists.shown(channel)),
            searchNames: member.searchNames,
            channel: (channelId) => {
              const found = member.byId.get(channelId);
              return found && lists.shown(found);
            },
            // Of the whole catalogue: a channel the lists only hide is still the provider's.
            listed: (channelId) => catalogues.get(subscriptionId)?.byId.has(channelId) ?? false,
            guideIdsOf: member.guide.guideIdsOf,
            channelsOf: (guideId) => member.guide.channelsOf(guideId).map(lists.shown),
          };
          views.set(subscriptionId, view);
          return view;
        }),

      status: Effect.flatMap(subscriptions.saved, (saved) => Effect.forEach(saved, statusNow)),

      categories: Effect.map(visible, ({ lists }) => lists.categories),

      searchGroups: Effect.map(visible, ({ search }) => searchGroupCache(search.channels).groups),

      channels: (filter: ChannelFilter) =>
        Effect.map(visible, ({ lists, search: searched }) => {
          const query = normalize(filter.query ?? "");
          if (filter.channels) {
            // Those of a subscription that isn't saved are in no catalogue, whatever their ids.
            const byId = new Map(lists.members.map((each) => [each.subscriptionId, each.byId]));
            const found = filter.channels.flatMap(
              ({ subscriptionId, id }) => byId.get(subscriptionId)?.get(id) ?? [],
            );
            if (query)
              return stampSearchGroups(
                matchingSearchGroups(searchIndex(searched.channels), found)
                  .slice(0, SEARCH_LIMIT)
                  .flatMap((group) => group.copies),
                searched.channels,
              );
            return plainChannels([...new Set(found)].map(lists.shown));
          }
          if (query) return search(searched.channels, searched.searchNames, query);
          if (!filter.category) return plainChannels(lists.channels);
          return plainChannels(lists.byCategory.get(ownedKey(filter.category)) ?? []);
        }),

      channel: (channel: OwnedId) =>
        Effect.flatMap(memberOf(channel.subscriptionId), ({ member, lists }) => {
          const found = member.byId.get(channel.id);
          return found
            ? Effect.succeed(lists.shown(found))
            : Effect.fail(
                new Failed({ error: { kind: "channel-not-found", channelId: channel.id } }),
              );
        }),

      lookup: (subscriptionId: string) =>
        Effect.gen(function* () {
          const subscription = (yield* subscriptions.saved).find(
            (each) => each.id === subscriptionId,
          );
          if (subscription) yield* cached(subscription);
          return (channelId: string) =>
            subscription ? catalogues.get(subscriptionId)?.byId.get(channelId) : undefined;
        }),

      forget: (subscription: SavedSubscription) =>
        Effect.gen(function* () {
          catalogues.delete(subscription.id);
          failures.delete(subscription.id);
          // An added subscription's cache went with its folder.
          if (subscription.original) {
            yield* Effect.promise(() => removeFile(cachePath(subscription)));
          }
        }),

      changes: Stream.fromPubSub(updates),
    };
  });
}

// Made when it fails, so it says so in the interface language of the moment.
const switched = Effect.failSync(
  () =>
    new Failed({
      error: { kind: "unexpected", detail: t("The subscription changed while loading channels.") },
    }),
);

function sameMembers(a: readonly IndexedCatalogue[], b: readonly IndexedCatalogue[]): boolean {
  return a.length === b.length && a.every((each, at) => each === b[at]);
}

/** The catalogue in `file` as the app shows it, its channels and categories `subscriptionId`'s. */
function index(file: CatalogueFile, subscriptionId: string, outdated: boolean): IndexedCatalogue {
  const { categories, streams } = normalizeCatalogue(file);
  const logical = liveChannels(streams);
  const { guideIds } = logical;
  // A channel is for adults when one of its streams is.
  const isAdult = adultIn(file.categories);
  const adultStreams = new Set(file.channels.filter(isAdult).map((channel) => channel.id));
  const channels = logical.channels.map((channel): LiveChannel =>
    channel.variants.some((variant) => adultStreams.has(variant.id))
      ? { subscriptionId, ...channel, adult: true }
      : { subscriptionId, ...channel },
  );
  const byId = new Map<string, LiveChannel>();
  const byGuideId = new Map<string, LiveChannel[]>();
  for (const channel of channels) {
    byId.set(channel.id, channel);
    for (const variant of channel.variants) byId.set(variant.id, channel);
    for (const guideId of guideIds.get(channel.id) ?? []) {
      const list = byGuideId.get(guideId);
      if (list) list.push(channel);
      else byGuideId.set(guideId, [channel]);
    }
  }
  // A channel shows in each of its streams' categories, once, where its first stream there is.
  const byCategory = new Map<string, LiveChannel[]>();
  const placed = new Set<string>();
  for (const stream of streams) {
    const channel = byId.get(stream.id);
    if (!channel) continue;
    for (const categoryId of stream.categoryIds) {
      const key = `${categoryId}\n${channel.id}`;
      if (placed.has(key)) continue;
      placed.add(key);
      const list = byCategory.get(categoryId);
      if (list) list.push(channel);
      else byCategory.set(categoryId, [channel]);
    }
  }
  return {
    subscriptionId,
    fetchedAt: file.fetchedAt,
    ...(file.importRevision ? { importRevision: file.importRevision } : {}),
    outdated,
    categories: categories
      .map((category) => ({
        subscriptionId,
        ...category,
        channelCount: byCategory.get(category.id)?.length ?? 0,
        adult: isAdultCategory(category.name),
      }))
      .filter((category) => category.channelCount > 0),
    channels,
    byId,
    byCategory,
    searchNames: channels.map((channel) =>
      normalize(channel.variants.map((variant) => variant.name).join(" ")),
    ),
    titles: channels.map((channel) => normalize(channel.title)),
    guide: {
      guideIdsOf: (channelId) => guideIds.get(byId.get(channelId)?.id ?? channelId) ?? [],
      channelsOf: (guideId) => byGuideId.get(guideId) ?? [],
    },
  };
}

/** The catalogue without channels for adults, kept per catalogue once worked out. */
const adultless = new WeakMap<IndexedCatalogue, IndexedCatalogue>();

/** The catalogue without channels for adults, nor the categories left empty without them. */
function withoutAdults(found: IndexedCatalogue): IndexedCatalogue {
  if (!found.channels.some((channel) => channel.adult)) return found;
  const known = adultless.get(found);
  if (known) return known;
  const kept = (channel: LiveChannel | undefined) => channel !== undefined && !channel.adult;
  const keep = [...found.channels.keys()].filter((at) => kept(found.channels[at]));
  const byCategory = new Map(
    [...found.byCategory].map(([id, channels]) => [id, channels.filter(kept)] as const),
  );
  const made: IndexedCatalogue = {
    ...found,
    categories: found.categories
      .map((category) => ({ ...category, channelCount: byCategory.get(category.id)?.length ?? 0 }))
      .filter((category) => category.channelCount > 0),
    channels: found.channels.filter(kept),
    byId: new Map([...found.byId].filter(([, channel]) => kept(channel))),
    byCategory,
    searchNames: keep.map((at) => found.searchNames[at] ?? ""),
    titles: keep.map((at) => found.titles[at] ?? ""),
    guide: {
      guideIdsOf: (channelId) =>
        kept(found.byId.get(channelId)) ? found.guide.guideIdsOf(channelId) : [],
      channelsOf: (guideId) => found.guide.channelsOf(guideId).filter(kept),
    },
  };
  adultless.set(found, made);
  return made;
}

/**
 * The lists the catalogues make together, in their order. A channel is marked `ambiguous` when
 * another subscription lists one that shows under the same name: nothing else would tell the two
 * apart. Categories of several subscriptions show as one when their country, the name they show
 * under and whether they are named for adults all agree, and keep whose each one is underneath.
 */
function combine(members: readonly IndexedCatalogue[]): Combined {
  /** Which subscription lists a name, or null once a second one does. */
  const listedBy = new Map<string, string | null>();
  for (const { subscriptionId, titles } of members) {
    for (const title of titles) {
      const owner = listedBy.get(title);
      if (owner === undefined) listedBy.set(title, subscriptionId);
      else if (owner !== subscriptionId) listedBy.set(title, null);
    }
  }
  const marked = new Map<LiveChannel, LiveChannel>();
  for (const { channels, titles } of members) {
    for (const [at, channel] of channels.entries()) {
      if (listedBy.get(titles[at] ?? "") === null)
        marked.set(channel, { ...channel, ambiguous: true });
    }
  }
  const shown = (channel: LiveChannel) => marked.get(channel) ?? channel;
  /** A subscription's channels as lists show them: its own array while none of them is marked. */
  const shownAll = (channels: readonly LiveChannel[]) =>
    marked.size === 0 ? channels : channels.map(shown);

  const joined = new Map<string, { category: Category; channels: Set<LiveChannel> }>();
  for (const member of members) {
    for (const { adult, ...category } of member.categories) {
      const listed = shownAll(member.byCategory.get(category.id) ?? []);
      const key = `${category.group ?? ""}\n${category.title}\n${adult}`;
      const known = joined.get(key);
      if (!known) {
        joined.set(key, {
          category: { ...category, members: [ownedId(category)] },
          channels: new Set(listed),
        });
        continue;
      }
      // A channel may belong to several raw categories that show under the same name.
      for (const channel of listed) known.channels.add(channel);
      known.category = {
        ...known.category,
        channelCount: known.channels.size,
        members: [...known.category.members, ownedId(category)],
      };
    }
  }
  const byCategory = new Map<string, readonly LiveChannel[]>();
  for (const { category, channels } of joined.values()) {
    const listed = [...channels];
    for (const member of category.members) byCategory.set(ownedKey(member), listed);
  }
  const [only] = members;
  return {
    members,
    categories: [...joined.values()].map(({ category }) => category),
    byCategory,
    channels:
      only && members.length === 1
        ? shownAll(only.channels)
        : members.flatMap((each) => shownAll(each.channels)),
    searchNames:
      only && members.length === 1 ? only.searchNames : members.flatMap((each) => each.searchNames),
    shown,
  };
}

/**
 * Every query word must appear in the channel name. Names that start with the query rank first,
 * then names with a word starting with it, then the rest. Ties keep the subscriptions' order,
 * and within one its provider's.
 */
function search(
  channels: readonly LiveChannel[],
  names: readonly string[],
  query: string,
): readonly LiveChannel[] {
  const words = query.split(" ");
  const ranked: { channel: LiveChannel; rank: number; order: number }[] = [];
  for (const [order, channel] of channels.entries()) {
    const name = names[order] ?? "";
    if (!words.every((word) => name.includes(word))) continue;
    const rank = name.startsWith(query) ? 0 : ` ${name}`.includes(` ${query}`) ? 1 : 2;
    ranked.push({ channel, rank, order });
  }
  ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
  // Limit display groups, retaining all their real copies and stream variants.
  const groups = matchingSearchGroups(
    searchIndex(channels),
    ranked.map((entry) => entry.channel),
  ).slice(0, SEARCH_LIMIT);
  const copies = groups.flatMap((group) => group.copies);
  const selected = new Set(copies.map(ownedKey));
  const matched = ranked
    .map((entry) => entry.channel)
    .filter((channel) => selected.has(ownedKey(channel)));
  const matchedKeys = new Set(matched.map(ownedKey));
  return stampSearchGroups(
    [...matched, ...copies.filter((channel) => !matchedKeys.has(ownedKey(channel)))],
    channels,
  );
}

const plainResponses = new WeakMap<readonly LiveChannel[], readonly LiveChannel[]>();

/** Ordinary lists need neither display groups nor canonical grouping identities. */
function plainChannels(channels: readonly LiveChannel[]): readonly LiveChannel[] {
  let response = plainResponses.get(channels);
  if (!response) {
    response = channels.map(({ searchIdentity: _identity, ...channel }) => channel);
    plainResponses.set(channels, response);
  }
  return response;
}

const searchIndexes = new WeakMap<readonly LiveChannel[], LiveSearchIndex>();
const stampedSearchResponses = new WeakMap<
  LiveSearchIndex,
  {
    readonly groups: LiveSearchGroups;
    readonly stamps: Readonly<Record<string, LiveSearchStamp>>;
  }
>();

/** One lazy authority per catalogue, shared by stamp-only and channel search responses. */
function searchGroupCache(all: readonly LiveChannel[]) {
  const index = searchIndex(all);
  let cache = stampedSearchResponses.get(index);
  if (!cache) {
    const groups = index.groups
      .filter((group) => group.copies.length > 1)
      .map((group) => ({ key: group.key, copies: group.copies.map(ownedKey) }));
    cache = {
      groups,
      stamps: Object.fromEntries(
        groups.flatMap(({ key, copies }) =>
          copies.map((id, order) => [id, { key, order }] as const),
        ),
      ),
    };
    stampedSearchResponses.set(index, cache);
  }
  return cache;
}

/** List subsets carry full-catalogue grouping. Identity stays on canonical playback channels. */
function stampSearchGroups(
  channels: readonly LiveChannel[],
  all: readonly LiveChannel[],
): readonly LiveChannel[] {
  const cache = searchGroupCache(all);
  return channels.map(({ searchIdentity: _identity, ...channel }) => ({
    ...channel,
    searchGroup: cache.stamps[ownedKey(channel)] ?? { key: ownedKey(channel), order: 0 },
  }));
}

function searchIndex(channels: readonly LiveChannel[]): LiveSearchIndex {
  let index = searchIndexes.get(channels);
  if (!index) {
    index = indexLiveSearch(channels);
    searchIndexes.set(channels, index);
  }
  return index;
}
