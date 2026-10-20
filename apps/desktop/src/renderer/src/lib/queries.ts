// React Query bindings for the IPC contract. Components read data through these hooks only.
// Whatever a provider lists is asked for with the subscription it belongs to, and cached under
// both: a provider's ids mean nothing without their subscription.
import {
  queryOptions,
  replaceEqualDeep,
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFilters,
} from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type { GuideSlot, GuideStatus, MapFilter } from "@mrstreamer/contracts/guide";
import type { IpcInput } from "@mrstreamer/contracts/ipc";
import type { LiveBrowseQuery } from "@mrstreamer/contracts/live-browse";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import type {
  CollectionId,
  CollectionSort,
  RowTab,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import type { SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import {
  ownedId,
  ownedKey,
  sameOwned,
  type OwnedId,
  type SubscriptionSummary,
} from "@mrstreamer/contracts/subscription";
import type { TitleFilter, Viewing } from "@mrstreamer/contracts/viewing";
import type { WatchlistSort } from "@mrstreamer/contracts/watchlist";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { player } from "../player/player.ts";
import { hostOf } from "./format.ts";
import { call, listen, searchCall } from "./ipc.ts";
import { preferenceQuery } from "./preferences.ts";

/** Listings move on as programmes end; asking again each minute is enough for progress. */
const LISTINGS_REFRESH_MS = 60_000;

const NO_SUBSCRIPTIONS: readonly SubscriptionSummary[] = [];

// Acceptance context belongs to an in-flight reply, never to the saved viewing state. A read
// can reach React Query's commit after a command acknowledgement.
const viewingReads = new WeakMap<
  object,
  { client: QueryClient; before: Viewing | undefined; sequence: number; roster: string }
>();

/** Ordered saved ids identify the sources for a read or command within this session. */
export const savedAs = (subscriptions: readonly { readonly id: string }[] | undefined) =>
  (subscriptions ?? []).map(({ id }) => id).join("\n");

/** The saved sources known to this renderer, empty until the subscription query has data. */
export const rosterOf = (client: QueryClient) =>
  savedAs(client.getQueryData(queries.subscriptions().queryKey));

export const queries = {
  /** Every saved subscription, in the order added. Changed only by what Settings does to them. */
  subscriptions: () =>
    queryOptions({ queryKey: ["subscriptions"], queryFn: () => call("subscription.list") }),
  playlistGroups: (subscriptionId: string, query: string, offset: number, limit: number) =>
    queryOptions({
      queryKey: ["playlist", subscriptionId, "groups", query, offset, limit],
      queryFn: () => call("playlist.groups", { subscriptionId, query, offset, limit }),
    }),
  playlistOmissions: (subscriptionId: string, offset: number, limit: number) =>
    queryOptions({
      queryKey: ["playlist", subscriptionId, "omissions", offset, limit],
      queryFn: () => call("playlist.omissions", { subscriptionId, offset, limit }),
    }),
  /** The interface language, as `language.get` and Settings' changes say. */
  language: () =>
    queryOptions({
      queryKey: ["language"],
      queryFn: () => call("language.get"),
      staleTime: Infinity,
    }),
  preferences: preferenceQuery,
  /**
   * What the viewer left a subscription at: the last channel and category, and the versions and
   * streams picked in it.
   */
  subscriptionPreferences: (subscriptionId: string) =>
    queryOptions({
      queryKey: ["subscription-preferences", subscriptionId],
      queryFn: () => call("subscription.preferences", { subscriptionId }),
      staleTime: Infinity,
    }),
  /** Favourites and recently watched channels. Kept current by `syncViewing`. */
  viewing: () =>
    queryOptions({
      queryKey: ["viewing"],
      queryFn: async ({ client }) => {
        for (;;) {
          const before = client.getQueryData<Viewing>(["viewing"]);
          const roster = rosterOf(client);
          const viewing = await call("viewing.get");
          // Invalidation can join a first read. Keep its promise pending until it answers for
          // the same saved sources, including a legitimate lower combined sequence.
          if (rosterOf(client) !== roster) continue;
          viewingReads.set(viewing, { client, before, sequence: viewing.sequence, roster });
          return viewing;
        }
      },
      structuralSharing: (previous, next) => {
        if (typeof next === "object" && next !== null) {
          const read = viewingReads.get(next);
          if (read) {
            viewingReads.delete(next);
            const cached = read.client.getQueryData<Viewing>(["viewing"]);
            if (rosterOf(read.client) !== read.roster) {
              // The sources changed after queryFn returned. Keep existing data and re-read
              // after this commit, including inactive queries. With no cache, this reply is
              // temporary until that re-read: structural sharing cannot return undefined.
              queueMicrotask(() => {
                void read.client
                  .invalidateQueries(
                    { queryKey: ["viewing"], exact: true, refetchType: "all" },
                    { cancelRefetch: false },
                  )
                  .catch(() => {});
              });
              return cached ?? next;
            }
            // Removing an account can lower the combined sequence. Only a concurrent cache write
            // can supersede this read, not the record it started with. Equal sequences may carry
            // refreshed canonical channel IDs after a catalogue update.
            if (cached !== read.before && cached && cached.sequence > read.sequence) return cached;
          }
        }
        return replaceEqualDeep(previous, next);
      },
      staleTime: Infinity,
    }),
  /**
   * For each subscription, how many channels its guides cover and from which, what its own guide
   * is doing and how its latest download ended, or that it has none. Read again on
   * `guide.updated`.
   */
  guideStatus: () =>
    queryOptions({ queryKey: ["guide", "status"], queryFn: () => call("guide.status") }),
  /**
   * The XMLTV sources of Settings > Guides, in their order, each with what it is doing. Read
   * again on `guide.updated`.
   */
  guideSources: () =>
    queryOptions({ queryKey: ["guide", "sources"], queryFn: () => call("guide.sources") }),
  rememberedLiveBrowse: () =>
    queryOptions({
      queryKey: ["live-browse"],
      queryFn: () => call("liveBrowse.get"),
      staleTime: Infinity,
    }),
  browse: (request: LiveBrowseQuery) =>
    queryOptions({
      queryKey: ["library", "browse", request],
      queryFn: async ({ signal }) => {
        const result = await call("library.browse", request);
        signal.throwIfAborted();
        return result;
      },
      staleTime: Infinity,
    }),
  libraryStatus: () =>
    queryOptions({ queryKey: ["library", "status"], queryFn: () => call("library.status") }),
  categories: () =>
    queryOptions({
      queryKey: ["library", "categories"],
      queryFn: () => call("library.categories"),
      staleTime: Infinity,
    }),
  channel: (channel: OwnedId) =>
    queryOptions({
      queryKey: ["library", "channel", ownedKey(channel)],
      queryFn: () => call("library.channel", { channel: ownedId(channel) }),
      staleTime: Infinity,
    }),
  /** The given channels, in the order given. */
  channelsOf: (channels: readonly OwnedId[]) =>
    queryOptions({
      queryKey: ["library", "of", ...channels.map(ownedKey)],
      queryFn: () => call("library.channels", { channels: channels.map(ownedId) }),
      staleTime: Infinity,
      enabled: channels.length > 0,
    }),
  /** Kept current by `syncUpdates`, so it never needs refetching. */
  updates: () =>
    queryOptions({
      queryKey: ["updates"],
      queryFn: () => call("updates.status"),
      staleTime: Infinity,
    }),
  search: (query: string) =>
    queryOptions({
      queryKey: ["library", "search", query],
      queryFn: () => call("library.channels", { query }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
    }),
  /**
   * Now and next for the given channels, by each channel's `ownedKey`. Channels without guide
   * data are missing.
   */
  listings: (channels: readonly OwnedId[]) =>
    queryOptions({
      queryKey: ["guide", "listings", ...channels.map(ownedKey)],
      queryFn: () => call("guide.listings", { channels: channels.map(ownedId) }),
      enabled: channels.length > 0,
      staleTime: LISTINGS_REFRESH_MS / 2,
      refetchInterval: LISTINGS_REFRESH_MS,
      placeholderData: (previous) => previous,
    }),
  /** A channel's programmes over [from, until), and at least a few either side of now. */
  schedule: (channel: OwnedId, from: number, until: number) =>
    queryOptions({
      queryKey: ["guide", "schedule", ownedKey(channel), from, until],
      queryFn: () => call("guide.schedule", { channel: ownedId(channel), from, until }),
      staleTime: LISTINGS_REFRESH_MS,
    }),
  /**
   * The slots of a page of channels that overlap [from, to), past ones the guide keeps among
   * them, by each channel's `ownedKey`, without descriptions. Channels without guide data are missing. A guide
   * grid reads the page it shows this way; a new guide reads it again.
   */
  range: (channels: readonly OwnedId[], from: number, to: number) =>
    queryOptions({
      queryKey: ["guide", "range", from, to, ...channels.map(ownedKey)],
      queryFn: () => call("guide.range", { channels: channels.map(ownedId), from, to }),
      enabled: channels.length > 0,
      staleTime: Infinity,
    }),
  /** A grid slot's programme with its description, read with the slot's guide channel. */
  programme: (channel: OwnedId, slot: Pick<GuideSlot, "guide" | "start">) =>
    queryOptions({
      queryKey: ["guide", "programme", ownedKey(channel), slot.guide, slot.start],
      queryFn: () =>
        call("guide.programme", {
          channel: ownedId(channel),
          guide: slot.guide,
          start: slot.start,
        }),
      staleTime: Infinity,
    }),
  programmes: (query: string) =>
    queryOptions({
      queryKey: ["guide", "search", query],
      queryFn: ({ signal }) => searchCall("guide.search", { query }, signal, "palette"),
      staleTime: LISTINGS_REFRESH_MS,
      enabled: query.trim().length > 0,
    }),
  /** Full-catalogue display stamps, shared by every list and read only while searching. */
  searchGroups: () =>
    queryOptions({
      queryKey: ["library", "searchGroups"],
      queryFn: async () => {
        const groups = await call("library.searchGroups");
        return Object.fromEntries(
          groups.flatMap(({ key, copies }) =>
            copies.map((id, order) => [id, { key, order }] as const),
          ),
        );
      },
      staleTime: Infinity,
    }),
  /**
   * What a search finds in the programmes of one list's channels, on now and later until
   * `until`: a category's, the given ones, or every channel, by each channel's `ownedKey`. The
   * answer names its query; failures remain distinct from successful empty programme matches.
   */
  listSearch: (
    list: Omit<IpcInput<"guide.searchList">, "query" | "until" | "request">,
    query: string,
    until: number,
  ) =>
    queryOptions({
      queryKey: ["guide", "searchList", list, query, until],
      queryFn: async ({ signal }) => ({
        query,
        matches: await searchCall("guide.searchList", { ...list, query, until }, signal, "live"),
      }),
      enabled: query !== "",
      staleTime: LISTINGS_REFRESH_MS / 2,
      refetchInterval: LISTINGS_REFRESH_MS,
    }),
  /**
   * A page of a subscription's channels with how each gets its programmes, for mapping them by
   * hand. Every page read is read again on `guide.updated`, and by the sheet once a mapping is
   * answered: either changes which channels a filter shows, and so where each page begins.
   * Nothing of it is kept once its sheet closes: the next one reads the guide as it is then.
   */
  mapChannels: (
    subscriptionId: string,
    filter: MapFilter,
    query: string,
    offset: number,
    limit: number,
  ) =>
    queryOptions({
      queryKey: ["guide", "map", subscriptionId, "channels", filter, query, offset, limit],
      queryFn: () => call("guide.mapChannels", { subscriptionId, filter, query, offset, limit }),
      gcTime: 0,
    }),
  /** A page of the channels a subscription's guide lists, those `query` finds. */
  mapOptions: (subscriptionId: string, query: string, offset: number, limit: number) =>
    queryOptions({
      queryKey: ["guide", "map", subscriptionId, "options", query, offset, limit],
      queryFn: () => call("guide.mapOptions", { subscriptionId, query, offset, limit }),
      gcTime: 0,
    }),
  /** How many movies and series there are, and when they were fetched. */
  onDemandStatus: () =>
    queryOptions({
      queryKey: ["ondemand", "status"],
      queryFn: () => call("ondemand.status"),
      staleTime: Infinity,
    }),
  /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
  rows: (kind: TitleKind, tab: RowTab, like: OwnedId | null) =>
    queryOptions({
      queryKey: ["ondemand", "rows", kind, tab, like && ownedKey(like)],
      queryFn: () => call("ondemand.rows", { kind, tab, ...(like ? { like: ownedId(like) } : {}) }),
      staleTime: Infinity,
      placeholderData: (previous) => previous,
    }),
  /** Related titles, computed when details open from libraries already loaded. */
  related: (kind: TitleKind, version: OwnedId) =>
    queryOptions({
      queryKey: ["ondemand", "related", kind, ownedKey(version)],
      queryFn: () => call("ondemand.related", { kind, version: ownedId(version) }),
      retry: false,
    }),
  /** Genres or streaming services as tiles. */
  tiles: (kind: TitleKind, of: "genres" | "services") =>
    queryOptions({
      queryKey: ["ondemand", "tiles", kind, of],
      queryFn: () => call("ondemand.tiles", { kind, of }),
      staleTime: Infinity,
      placeholderData: (previous) => previous,
    }),
  /** One page of a collection, in `sort` or the collection's own order. */
  collection: (
    kind: TitleKind,
    id: CollectionId,
    sort: CollectionSort | undefined,
    offset: number,
    limit: number,
    filters?: TitleFilters,
  ) => {
    const chosen = filters && Object.keys(filters).length ? filters : undefined;
    return queryOptions({
      queryKey: [
        "ondemand",
        "collection",
        kind,
        id,
        sort ?? null,
        offset,
        limit,
        ...(chosen ? [chosen] : []),
      ],
      queryFn: () =>
        call("ondemand.collection", {
          kind,
          id,
          offset,
          limit,
          ...(sort ? { sort } : {}),
          ...(chosen ? { filters: chosen } : {}),
        }),
      staleTime: Infinity,
      // Keep a sort/page transition smooth, without presenting old matches under new filters.
      placeholderData: (previous, previousQuery) =>
        JSON.stringify(previousQuery?.queryKey[7] ?? null) === JSON.stringify(chosen ?? null)
          ? previous
          : undefined,
    });
  },
  /** Name hints and tracks already read on this device, for the current kind only. */
  titleFilterOptions: (kind: TitleKind) =>
    queryOptions({
      queryKey: ["ondemand", "filterOptions", kind],
      queryFn: () => call("ondemand.filterOptions", { kind }),
    }),
  titleSearch: (query: string) =>
    queryOptions({
      queryKey: ["ondemand", "search", query],
      queryFn: () => call("ondemand.search", { query }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
    }),
  /** Movies or series only, for the field in their tab bar. */
  titleSearchIn: (kind: TitleKind, query: string, filters?: TitleFilters) => {
    const chosen = filters && Object.keys(filters).length ? filters : undefined;
    return queryOptions({
      queryKey: ["ondemand", "searchKind", kind, query, ...(chosen ? [chosen] : [])],
      queryFn: () =>
        call("ondemand.searchKind", { kind, query, ...(chosen ? { filters: chosen } : {}) }),
      staleTime: Infinity,
      enabled: query.trim().length > 0,
      placeholderData: (previous, previousQuery) =>
        JSON.stringify(previousQuery?.queryKey[4] ?? null) === JSON.stringify(chosen ?? null)
          ? previous
          : undefined,
    });
  },
  /** Titles from the lists, by any of their versions; asks the provider nothing. */
  titles: (kind: TitleKind, versions: readonly OwnedId[]) =>
    queryOptions({
      queryKey: ["ondemand", "titles", kind, versions.map(ownedKey)],
      queryFn: () => call("ondemand.titles", { kind, versions: versions.map(ownedId) }),
      enabled: versions.length > 0,
    }),
  /** The details of one version of a movie or series. */
  details: (kind: TitleKind, version: OwnedId) =>
    queryOptions({
      queryKey: ["ondemand", "details", kind, ownedKey(version)],
      queryFn: () => call("ondemand.details", { kind, version: ownedId(version) }),
      staleTime: 30 * 60_000,
    }),
  /**
   * The episodes of a series version's season with TMDB's details, for when it shows. Read again
   * each time it shows: the main process keeps what TMDB said, and asks again what it didn't.
   */
  season: (series: OwnedId, season: number) =>
    queryOptions({
      queryKey: ["ondemand", "season", ownedKey(series), season],
      queryFn: () => call("ondemand.season", { series: ownedId(series), season }),
    }),
  /**
   * How far movies, or every episode of series, got: each a language version of one title. Kept
   * current by `syncViewing`.
   */
  progress: (titles: TitleFilter) =>
    queryOptions({
      queryKey: [
        "viewing",
        "progress",
        (titles.movies ?? []).map(ownedKey),
        (titles.series ?? []).map(ownedKey),
      ],
      queryFn: () =>
        call("viewing.progress", {
          ...(titles.movies ? { movies: titles.movies.map(ownedId) } : {}),
          ...(titles.series ? { series: titles.series.map(ownedId) } : {}),
        }),
      staleTime: Infinity,
    }),
  /**
   * How the episodes of a series stand in the subscription of the version named: how far they
   * got across its versions there, and the ones marked by hand. Kept current by `syncViewing`.
   */
  episodes: (series: OwnedId) =>
    queryOptions({
      queryKey: ["viewing", "episodes", ownedKey(series)],
      queryFn: () => call("viewing.episodes", { series: ownedId(series) }),
      staleTime: Infinity,
    }),
  /**
   * A page of the watchlist: saved titles with what the lists have of each now. Kept current by
   * `syncWatchlist`.
   */
  watchlist: (sort: WatchlistSort, offset: number, limit: number, home = false) =>
    queryOptions({
      queryKey: ["watchlist", "list", sort, offset, limit, home],
      queryFn: () => call("watchlist.list", { sort, offset, limit, ...(home ? { home } : {}) }),
      staleTime: Infinity,
      placeholderData: (previous) => previous,
    }),
  /**
   * The entry a movie or series is saved as, named by one of its versions, or null. Kept current
   * by `syncWatchlist`.
   */
  saved: (kind: TitleKind, version: OwnedId) =>
    queryOptions({
      queryKey: ["watchlist", "saved", kind, ownedKey(version)],
      queryFn: () => call("watchlist.saved", { kind, version: ownedId(version) }),
      staleTime: Infinity,
    }),
  licences: () =>
    queryOptions({
      queryKey: ["licences"],
      queryFn: () => call("licences.list"),
      staleTime: Infinity,
    }),
  licenceText: (id: string) =>
    queryOptions({
      queryKey: ["licences", id],
      queryFn: () => call("licences.text", { id }),
      staleTime: Infinity,
    }),
};

/** Stars or unstars a channel. The favourites list updates as soon as the main process has it. */
export function useToggleFavourite(): (channel: OwnedId) => void {
  const client = useQueryClient();
  return useCallback(
    (channel: OwnedId) => {
      const favourites = client.getQueryData(queries.viewing().queryKey)?.favourites ?? [];
      const roster = rosterOf(client);
      void call("viewing.setFavourite", {
        commandId: crypto.randomUUID(),
        channel: ownedId(channel),
        favourite: !favourites.some((each) => sameOwned(each, channel)),
      }).then(
        (viewing) => keepViewing(client, viewing, roster),
        () => {},
      );
    },
    [client],
  );
}

/**
 * Changes what the viewer left a subscription at, and keeps the answer for every view that reads
 * it.
 */
export async function updateSubscriptionPreferences(
  client: QueryClient,
  subscriptionId: string,
  patch: Partial<SubscriptionPreferences>,
): Promise<void> {
  const saved = await call("subscription.updatePreferences", { subscriptionId, patch });
  client.setQueryData(queries.subscriptionPreferences(subscriptionId).queryKey, saved);
}

/**
 * Remembers which of a channel's streams plays, or Automatic with null, among its subscription's
 * picks, and opens the channel again with it once saved.
 */
export function useChooseQuality(): (channel: LiveChannel, variantId: string | null) => void {
  const client = useQueryClient();
  return useCallback(
    (channel: LiveChannel, variantId: string | null) => {
      void (async () => {
        const { subscriptionId } = channel;
        const left = await client.fetchQuery(queries.subscriptionPreferences(subscriptionId));
        // A choice kept under another of the channel's streams' ids goes too.
        const others = Object.entries(left.channelVariants ?? {}).filter(
          ([id]) => !channel.variants.some((variant) => variant.id === id),
        );
        const channelVariants = Object.fromEntries(
          variantId === null ? others : [...others, [channel.id, variantId]],
        );
        await updateSubscriptionPreferences(client, subscriptionId, { channelVariants });
        if (sameOwned(player.current(), channel)) player.reopen();
      })().catch(() => {});
    },
    [client],
  );
}

/** Keeps what the main process answered for one subscription's guide among the others'. */
export function keepGuideStatus(client: QueryClient, status: GuideStatus): void {
  client.setQueryData(queries.guideStatus().queryKey, (all) =>
    all?.map((each) => (each.subscriptionId === status.subscriptionId ? status : each)),
  );
}

/** Keeps the latest viewing state: an answer can arrive after a later change's event. */
export function keepViewing(client: QueryClient, viewing: Viewing, roster: string): void {
  if (rosterOf(client) !== roster) return;
  const queryKey = queries.viewing().queryKey;
  const cached = client.getQueryData(queryKey);
  if (cached && cached.sequence > viewing.sequence) return;
  client.setQueryData(queryKey, viewing);
}

/** The saved subscriptions, in the order added; none until they are known. */
export function useSubscriptions(): readonly SubscriptionSummary[] {
  return useQuery(queries.subscriptions()).data ?? NO_SUBSCRIPTIONS;
}

/** What a subscription is listed as: the name the viewer gave it, else its server's host. */
export function subscriptionName(subscription: SubscriptionSummary): string {
  return subscription.name ?? hostOf(subscription.server);
}

/**
 * Names a subscription by its id, for telling apart two things that read the same but come from
 * different ones. Null for one that isn't saved.
 */
export function useSubscriptionNames(): (subscriptionId: string) => string | null {
  const subscriptions = useSubscriptions();
  return useMemo(() => {
    const names = new Map(subscriptions.map((each) => [each.id, subscriptionName(each)]));
    return (subscriptionId) => names.get(subscriptionId) ?? null;
  }, [subscriptions]);
}

/**
 * Names the subscription a channel or title is from where another one reads the same, and
 * nothing where none does: lists say whose something is only where that tells two apart.
 */
export function useSourceOf(): (of: {
  readonly subscriptionId: string;
  readonly ambiguous?: true;
}) => string | null {
  const nameOf = useSubscriptionNames();
  return useCallback((of) => (of.ambiguous ? nameOf(of.subscriptionId) : null), [nameOf]);
}

/**
 * Names the subscription of a Live TV search row that stands for one channel, while several are
 * saved, counting one whose login can't be read. With one saved, every row would name the same.
 */
export function useSearchSubscriptionNames(): (subscriptionId: string) => string | null {
  const several = useSubscriptions().length > 1;
  const nameOf = useSubscriptionNames();
  return useCallback(
    (subscriptionId) => (several ? nameOf(subscriptionId) : null),
    [several, nameOf],
  );
}

/**
 * What the viewer left each saved subscription at, by its id; undefined until every one is
 * known. `refetchOnMount` reads them afresh as a view opens: the main process notes the channel
 * watched last without going through this cache.
 */
export function useSubscriptionPreferences(
  refetchOnMount?: "always",
): ReadonlyMap<string, SubscriptionPreferences> | undefined {
  const subscriptions = useQuery(queries.subscriptions()).data;
  return useQueries({
    queries: (subscriptions ?? NO_SUBSCRIPTIONS).map(({ id }) => ({
      ...queries.subscriptionPreferences(id),
      ...(refetchOnMount ? { refetchOnMount } : {}),
    })),
    // The same function until the subscriptions change, so the same map until an answer does.
    combine: useCallback(
      (results: readonly { readonly data: SubscriptionPreferences | undefined }[]) => {
        if (!subscriptions) return undefined;
        const left = new Map<string, SubscriptionPreferences>();
        for (const [at, { data }] of results.entries()) {
          const id = subscriptions[at]?.id;
          if (!data || id === undefined) return undefined;
          left.set(id, data);
        }
        return left;
      },
      [subscriptions],
    ),
  });
}

/**
 * The channel watched last, whichever subscription it is of, or null before the first or once its
 * catalogue no longer has it. The viewing record says which; where it has none, as when it can't
 * be read, the channel a subscription was left at stands in.
 */
export function useLastChannel(): LiveChannel | null {
  const [watched] = useQuery(queries.viewing()).data?.recent ?? [];
  const left = useSubscriptionPreferences();
  const last = useMemo((): OwnedId | null => {
    if (watched) return watched;
    for (const [subscriptionId, { lastChannelId }] of left ?? []) {
      if (lastChannelId !== null) return { subscriptionId, id: lastChannelId };
    }
    return null;
  }, [watched, left]);
  const { data } = useQuery({
    ...queries.channel(last ?? { subscriptionId: "", id: "" }),
    enabled: last !== null,
  });
  return (last !== null && data) || null;
}

/** The favourite channels, by `ownedKey`, in their saved order. */
export function useFavouriteKeys(): ReadonlySet<string> {
  const { data } = useQuery(queries.viewing());
  return useMemo(() => new Set(data?.favourites.map(ownedKey)), [data]);
}

function useCategories() {
  return useQuery(queries.categories());
}

/**
 * Categories by the `ownedKey` of each provider category they show, for labelling channels and
 * finding a list by any of them.
 */
export function useCategoryMap(): ReadonlyMap<string, Category> {
  const { data } = useCategories();
  return useMemo(
    () =>
      new Map(
        data?.flatMap((category) =>
          category.members.map((member) => [ownedKey(member), category] as const),
        ),
      ),
    [data],
  );
}

/**
 * Refetches library data whenever the main process reports a new catalogue. A read already under
 * way may answer from the catalogue before, and settling clears the invalidation: once it settles,
 * its query is marked stale again. Whoever awaits that read still gets its answer.
 */
export function syncLibraryUpdates(client: QueryClient): () => void {
  // Favourites and history show by channel, and a new catalogue can join a channel's streams.
  const changed = [["library"], ["playlist"], queries.viewing().queryKey];
  return listen("library.updated", () => {
    // Invalidation alone reuses an in-flight first read with no cached data. Its old decision
    // must not become fresh after a catalogue update.
    void client.cancelQueries({ queryKey: queries.searchGroups().queryKey, exact: true });
    const underWay = changed.flatMap((queryKey) =>
      client
        .getQueryCache()
        .findAll({ queryKey, fetchStatus: "fetching" })
        .flatMap(({ queryKey, promise }) => (promise ? [{ queryKey, promise }] : [])),
    );
    for (const queryKey of changed) void client.invalidateQueries({ queryKey });
    // One that invalidation replaced with a new read is cancelled, and that read is current.
    for (const { queryKey, promise } of underWay)
      void promise.then(
        () => client.invalidateQueries({ queryKey, exact: true }),
        () => {},
      );
  });
}

/**
 * Reads movies and series again once the main process has fetched new lists, and a title's
 * details once TMDB's arrived after them. TMDB's progress alone only updates the status.
 */
export function syncOnDemand(client: QueryClient): () => void {
  const stopDetails = listen("ondemand.detailsChanged", ({ kind, ...version }) => {
    void client.invalidateQueries({ queryKey: queries.details(kind, version).queryKey });
    void client.invalidateQueries({ queryKey: queries.related(kind, version).queryKey });
  });
  const stopProgress = listen("ondemand.progress", (metadata) => {
    // Only the progress; the lists' status is whatever the latest full status said. Without a
    // status yet, the first one brings the progress with it.
    client.setQueryData(queries.onDemandStatus().queryKey, (old) => old && { ...old, metadata });
  });
  const stopLists = listen("ondemand.updated", () => {
    // Lists change with a refresh and as TMDB's metadata arrives. A season shown is read again
    // the next time it shows, not each time more metadata arrives.
    const lists = {
      queryKey: ["ondemand"],
      predicate: (query) => query.queryKey[1] !== "details" && query.queryKey[1] !== "season",
    } satisfies QueryFilters;
    // Invalidation alone reuses a first read with no cached data. Cancel its old answer before
    // reading the changed catalogue; queries with cached data keep their posters while it loads.
    void client.cancelQueries(lists);
    void client.invalidateQueries(lists);
    // So do the names and languages details show. Open details keep what they show; opened
    // again, they are put together anew from what the main process kept, with nothing downloaded.
    void client.invalidateQueries({ queryKey: ["ondemand", "details"], refetchType: "none" });
    // And which versions and marks are a series' own: the lists say what a series is.
    void client.invalidateQueries({ queryKey: ["viewing", "episodes"] });
  });
  return () => {
    stopDetails();
    stopProgress();
    stopLists();
  };
}

/**
 * Asks for programmes again once the main process has a new guide. A read still under way asked
 * the guide before, so it is dropped first: a first read would otherwise be waited for rather
 * than asked again, and its answer kept as fresh.
 */
export function syncGuideUpdates(client: QueryClient): () => void {
  return listen("guide.updated", () => {
    void client
      .cancelQueries({ queryKey: ["guide"] })
      .then(() => client.invalidateQueries({ queryKey: ["guide"] }));
  });
}

/**
 * Reads favourites, recently watched channels and progress again once the main process has a
 * later change.
 */
export function syncViewing(client: QueryClient): () => void {
  return listen("viewing.changed", ({ sequence }) => {
    const cached = client.getQueryData(queries.viewing().queryKey);
    if (cached && cached.sequence >= sequence) return;
    // The prefix covers progress too. A first read under way can still answer an older sequence.
    const pending = client
      .getQueryCache()
      .find({ queryKey: queries.viewing().queryKey, exact: true })?.promise;
    void client.invalidateQueries({ queryKey: queries.viewing().queryKey });
    void pending?.then(
      () => {
        if ((client.getQueryData(queries.viewing().queryKey)?.sequence ?? -1) < sequence)
          void client.invalidateQueries({ queryKey: queries.viewing().queryKey });
      },
      () => {},
    );
  });
}

/**
 * Reads the watchlist again once a title was saved or removed, and once the lists changed: they
 * say which title each entry is.
 */
export function syncWatchlist(client: QueryClient): () => void {
  const read = () => void client.invalidateQueries({ queryKey: ["watchlist"] });
  const stopChanges = listen("watchlist.changed", read);
  const stopLists = listen("ondemand.updated", read);
  return () => {
    stopChanges();
    stopLists();
  };
}

/** Keeps the update status current: download progress and outcomes arrive as events. */
export function syncUpdates(client: QueryClient): () => void {
  return listen("updates.changed", (status) => {
    client.setQueryData(queries.updates().queryKey, status);
  });
}
