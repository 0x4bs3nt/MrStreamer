// Shared semantic selections for Live TV, Watch and Home. Topics lead discovery; the provider
// hierarchy stays available behind Provider lists. Library owns membership and facet policy.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BROWSE_TOPICS,
  EMPTY_LIVE_FILTERS,
  type BrowseTopic,
  type LiveBrowseQuery,
  type LiveBrowseResult,
  type LiveDiscovery,
} from "@mrstreamer/contracts/live-browse";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { call } from "../../lib/ipc.ts";
import type { Listing, ListingMatch } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { normalize, searchWords } from "@mrstreamer/core/text";
import { indexNames, nameQuery, scoreNames, type SearchNames } from "@mrstreamer/core/search/names";
import { searchResultGroups, type LiveSearchGroup } from "@mrstreamer/core/catalogue/search";
import { t } from "@mrstreamer/core/i18n";
import { useLocale } from "../../app/language.ts";
import { sameList, useUi, type ChannelList } from "../../app/ui-store.ts";
import { useNow } from "../../lib/clock.ts";
import { usePresentationVisible } from "../../lib/presentation.ts";
import { endOfDay } from "../../lib/format.ts";
import { queries, subscriptionName, useSubscriptions } from "../../lib/queries.ts";

export const PROVIDER_LISTS = "provider-lists";
const EMPTY_BROWSE: LiveBrowseResult = {
  channels: [],
  total: 0,
  counts: { browseTopics: 0, countries: 0, languages: 0, subscriptions: 0 },
  facets: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
};
const NO_IDS: readonly OwnedId[] = [];
/** Channels whose listings are asked for together. */
const LISTINGS_PAGE = 40;
/** A search waits this long for typing to pause, as the other searches do. */
const SEARCH_DELAY_MS = 120;
const NO_WORDS: readonly string[] = [];
const NO_MATCHES: Readonly<Record<string, ListingMatch>> = {};

/** The single renderer adapter from semantic discovery/personal choices to exact IPC scopes. */
export function browseQuery(
  list: ChannelList,
  viewing: Viewing | undefined,
  visibility: "viewer" | "ordinary",
  preferences: Preferences | undefined,
): LiveBrowseQuery {
  const filters = list.filters ?? EMPTY_LIVE_FILTERS;
  return {
    scope:
      list.kind === "category"
        ? { kind: "category", category: ownedId(list.category) }
        : list.kind === "favourites" || list.kind === "recent"
          ? {
              kind: "channels",
              channels: (
                viewing?.[list.kind === "favourites" ? "favourites" : "recent"] ?? NO_IDS
              ).map(ownedId),
            }
          : { kind: "all" },
    filters: {
      browseTopics: list.kind === "topic" ? [list.topic] : [],
      countries: [...filters.countries],
      languages: [...filters.languages],
      subscriptions: [...filters.subscriptions],
    },
    // Main gives a viewer hiding adults the ordinary list. Share Home's entry only once
    // preferences are known; without a snapshot, main still applies its saved policy.
    visibility:
      visibility === "viewer" && preferences && !preferences.adultTitles ? "ordinary" : visibility,
  };
}

/** Membership and facets always belong to the current descriptor, including personal order. */
export function useListChannels(list: ChannelList, visibility: "viewer" | "ordinary" = "viewer") {
  const viewing = useQuery(queries.viewing());
  const preferences = useQuery(queries.preferences());
  const personal = list.kind === "favourites" || list.kind === "recent";
  const request = browseQuery(list, viewing.data, visibility, preferences.data);
  const empty = request.scope.kind === "channels" && request.scope.channels.length === 0;
  const result = useQuery({
    ...queries.browse(request),
    enabled: !empty && (!personal || viewing.isSuccess),
  });
  const data = empty && viewing.isSuccess ? EMPTY_BROWSE : result.data;
  return {
    channels: personal && !viewing.isSuccess ? undefined : data?.channels,
    data,
    error: personal && !viewing.isSuccess ? viewing.error : result.error,
  };
}

/** Resolve native aliases and missing categories identically for discovery consumers. */
export function resolveDiscovery(list: ChannelList, categories: readonly Category[]): ChannelList {
  if (list.kind !== "category") return list;
  const category = categories.find((each) =>
    each.members.some((member) => sameOwned(member, list.category)),
  );
  return category ? { ...list, category: ownedId(category) } : { kind: "all" };
}

/** Home's existing category row follows discovery, without duplicating personal rows. */
export function useHomeDiscovery(): ChannelList {
  const list = useUi((state) => state.list);
  const remembered = useQuery(queries.rememberedLiveBrowse());
  const categories = useQuery(queries.categories());
  const discovery =
    list.kind === "favourites" || list.kind === "recent"
      ? (remembered.data ?? { kind: "all" as const })
      : list;
  return categories.data ? resolveDiscovery(discovery, categories.data) : discovery;
}

/**
 * Searches a list for `text`, and gives the channels found in the list's order with what marks
 * them: all of them, and no words, without a search. A channel is found when every word shows
 * among its names, the one shown, the provider's and each stream's, or in the title of one of
 * its programmes on now or later today. The names are at hand; the main process finds the
 * programmes in the guide it has loaded, so typing asks the provider nothing, and a list without
 * a guide still finds names.
 * Names appear as soon as typing settles; programme matches join in list order. Old rows are
 * inert during typing. A pending, stale or failed grouping decision keeps current copies apart.
 */
export function useListSearch(
  channels: readonly LiveChannel[],
  text: string,
): {
  readonly channels: readonly LiveChannel[];
  /** The search the channels are for, as typed; empty without one. */
  readonly query: string;
  /** Its words as search compares them, for marking what matched. */
  readonly words: readonly string[];
  /** What it found in each channel's programmes today, by the channel's `ownedKey`. */
  readonly matches: Readonly<Record<string, ListingMatch>>;
  readonly groups: readonly LiveSearchGroup[] | null;
  readonly actionable: boolean;
  readonly pending: boolean;
  readonly failed: boolean;
} {
  const visible = usePresentationVisible();
  // What was typed, once typing pauses. An emptied field counts at once: the whole list shows
  // without a wait, and what the field held before never searches the list shown next.
  const [settled, settle] = useState(text);
  useEffect(() => {
    if (text.trim() === "") {
      settle("");
      return;
    }
    const timer = setTimeout(() => settle(text), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  const query = text.trim() === "" ? "" : settled.trim();
  const until = endOfDay(useNow());
  const searching = text.trim() !== "";
  // Disabled queries still hash their keys on render. Empty search needs no channel scope.
  const scope = useMemo(
    () => ({ channels: searching ? channels.map(ownedId) : [] }),
    [channels, searching],
  );
  const grouped = useQuery({
    ...queries.searchGroups(),
    // Start the one catalogue decision during the typing delay, before programme search waits.
    enabled: searching && visible,
  });
  const actionable = text.trim() === "" || text === settled;
  const programmeSearch = queries.listSearch(scope, actionable ? query : "", until);
  const found = useQuery({
    ...programmeSearch,
    enabled: visible && actionable && query !== "",
    queryKey: actionable
      ? programmeSearch.queryKey
      : ["guide", "searchList", "paused", scope, query, until],
    placeholderData: (previous) => (actionable ? undefined : previous),
  });
  const pending =
    searching && (!actionable || found.isPending || found.isFetching || grouped.isPending);
  const failed = searching && found.isError;
  useEffect(() => {
    if (!searching) return;
    // Fold names during the typing delay, alongside the catalogue decision.
    const timer = setTimeout(() => searchNames(channels), 0);
    return () => clearTimeout(timer);
  }, [channels, searching]);
  const matches = found.data?.matches ?? NO_MATCHES;
  const result = useMemo(() => {
    const words = searchWords(query);
    if (!searching || words.length === 0) {
      return { channels, query: "", words: NO_WORDS, matches: NO_MATCHES, groups: null };
    }
    const names = searchNames(channels);
    const asked = nameQuery(query);
    const found = channels.filter(
      (channel, index) =>
        matches[ownedKey(channel)] !== undefined ||
        (names[index] !== undefined && scoreNames(asked, names[index]) !== undefined),
    );
    // Only fresh decisions join copies. Keep every current copy of a matching group, without
    // constructing display groups for the rest of a large list.
    const stamps = !grouped.isStale && !grouped.isError ? grouped.data : undefined;
    const keys = new Set(
      found.map((channel) => stamps?.[ownedKey(channel)]?.key ?? ownedKey(channel)),
    );
    const stamped = channels.flatMap((channel) => {
      const id = ownedKey(channel);
      const stamp = stamps?.[id];
      return keys.has(stamp?.key ?? id)
        ? [{ ...channel, searchGroup: stamp ?? { key: id, order: 0 } }]
        : [];
    });
    const groups = new Map(searchResultGroups(stamped).map((group) => [group.key, group]));
    return {
      channels: found,
      groups: [...keys].flatMap((key) => groups.get(key) ?? []),
      query,
      words,
      matches,
    };
  }, [channels, query, matches, searching, grouped.data, grouped.isStale, grouped.isError]);
  return { ...result, actionable, pending, failed };
}

/** Each list's names as search compares them, worked out at its first search. */
const foldedNames = new WeakMap<readonly LiveChannel[], readonly SearchNames[]>();

/**
 * The names of each of a list's channels, folded and in the list's order: the one shown, then
 * each stream's as the provider wrote it.
 */
function searchNames(channels: readonly LiveChannel[]): readonly SearchNames[] {
  let names = foldedNames.get(channels);
  if (!names) {
    names = channels.map((channel) =>
      indexNames(
        channel.title,
        channel.variants.map((variant) => variant.name),
      ),
    );
    foldedNames.set(channels, names);
  }
  return names;
}

/** The list's name: "Favourites", or the category's own. */
export function listTitle(list: ChannelList, categories: ReadonlyMap<string, Category>): string {
  switch (list.kind) {
    case "favourites":
      return t("Favourites");
    case "recent":
      return t("Recently watched");
    case "all":
      return t("All channels");
    case "topic":
      return topicTitle(list.topic);
    case "category":
      return categories.get(ownedKey(list.category))?.title ?? t("Channels");
  }
}

const TOPIC_LABELS = {
  news: "News",
  sport: "Sports",
  kids: "Kids",
  movies: "Movies",
  entertainment: "Entertainment",
  music: "Music",
  documentary: "Documentary",
  regional: "Regional",
  other: "Other",
} as const;
function topicTitle(topic: BrowseTopic): string {
  return t(TOPIC_LABELS[topic]);
}

// Serialize discovery writes so rapid topic/native/All changes settle in the viewer's order.
let remembering = Promise.resolve();
let rememberTurn = 0;
export function useShowList(): (list: ChannelList) => void {
  const client = useQueryClient();
  return useCallback(
    (list) => {
      const current = useUi.getState().list;
      const filters = list.filters ?? (sameList(current, list) ? current.filters : undefined);
      const next = filters ? { ...list, filters } : list;
      useUi.setState({ list: next });
      if (list.kind === "favourites" || list.kind === "recent") return;
      const selection: LiveDiscovery =
        list.kind === "topic"
          ? { kind: "topic", topic: list.topic }
          : list.kind === "category"
            ? { kind: "category", category: ownedId(list.category) }
            : { kind: "all" };
      const turn = ++rememberTurn;
      const account = useUi.getState().account;
      void client.cancelQueries({ queryKey: queries.rememberedLiveBrowse().queryKey });
      client.setQueryData(queries.rememberedLiveBrowse().queryKey, selection);
      remembering = remembering
        .catch(() => {})
        .then(async () => {
          if (useUi.getState().account !== account) return;
          try {
            const saved = await call("liveBrowse.remember", selection);
            if (turn === rememberTurn && useUi.getState().account === account)
              client.setQueryData(queries.rememberedLiveBrowse().queryKey, saved);
            await client.invalidateQueries({ queryKey: ["subscription-preferences"] });
          } catch {
            if (turn === rememberTurn && useUi.getState().account === account)
              await client.invalidateQueries({ queryKey: queries.rememberedLiveBrowse().queryKey });
          }
        });
    },
    [client],
  );
}

export type ListEntry =
  | {
      readonly kind: "list";
      readonly list: ChannelList;
      readonly title: string;
      readonly count: number;
      /** Country and source context in Find results. */
      readonly context?: string;
    }
  | {
      readonly kind: "group";
      readonly group: string;
      readonly count: number;
    };

/** Fixed topics first; Provider lists keeps native countries/categories and catalogue-wide Find. */
export function useListPicker(selected: ChannelList) {
  const categories = useQuery(queries.categories()).data;
  const catalogue = useListChannels({ kind: "all" });
  const favourites = useListChannels({ kind: "favourites" });
  const recent = useListChannels({ kind: "recent" });
  const subscriptions = useSubscriptions();
  const locale = useLocale();
  const selectedKey =
    selected.kind === "category"
      ? ownedKey(selected.category)
      : selected.kind === "topic"
        ? selected.topic
        : selected.kind;
  const selectedGroup =
    selected.kind === "category"
      ? (categories?.find((category) =>
          category.members.some((member) => sameOwned(member, selected.category)),
        )?.group ?? null)
      : null;
  const [group, setGroup] = useState<string | null>(selectedGroup);
  const [providers, setProviders] = useState(selected.kind === "category");
  const [query, search] = useState("");
  const [entry, setEntry] = useState(0);
  // Remembered lists arrive asynchronously; refresh can also move a category to another country.
  useEffect(() => {
    setGroup(selectedGroup);
    setProviders(selected.kind === "category");
    search("");
    setEntry(0);
  }, [selectedKey, selectedGroup]);
  const entries = useMemo(() => {
    const all = categories ?? [];
    const names = new Map(subscriptions.map((each) => [each.id, subscriptionName(each)]));
    const duplicates = new Map<string, number>();
    for (const category of all)
      duplicates.set(
        JSON.stringify([category.group, category.title]),
        (duplicates.get(JSON.stringify([category.group, category.title])) ?? 0) + 1,
      );
    const categoryEntry = (category: Category, finding: boolean): ListEntry => {
      const sources =
        (duplicates.get(JSON.stringify([category.group, category.title])) ?? 0) > 1
          ? [
              ...new Set(
                category.members.map((member) => names.get(member.subscriptionId)).filter(Boolean),
              ),
            ].join(", ")
          : "";
      return {
        kind: "list",
        list: { kind: "category", category: ownedId(category) },
        title: category.title,
        count: category.channelCount,
        context: [finding ? category.group : null, sources].filter(Boolean).join(" · "),
      };
    };
    const words = searchWords(query);
    if (words.length > 0)
      return all
        .filter((category) => {
          const text = normalize(
            [category.name, category.title, category.group].filter(Boolean).join(" "),
          );
          return words.every((word) => text.includes(word));
        })
        .map((category) => categoryEntry(category, true));
    if (group !== null)
      return all
        .filter((category) => category.group === group)
        .map((category) => categoryEntry(category, false));
    const result: ListEntry[] = [
      {
        kind: "list",
        list: { kind: "favourites" },
        title: t("Favourites"),
        count: favourites.channels?.length ?? 0,
      },
      {
        kind: "list",
        list: { kind: "recent" },
        title: t("Recently watched"),
        count: recent.channels?.length ?? 0,
      },
      {
        kind: "list",
        list: { kind: "all" },
        title: t("All channels"),
        count: catalogue.data?.total ?? 0,
      },
    ];
    if (!providers) {
      const counts = new Map(
        catalogue.data?.facets.browseTopics.map((each) => [each.value, each.count]),
      );
      result.push(
        ...BROWSE_TOPICS.map((topic): ListEntry => ({
          kind: "list",
          list: { kind: "topic", topic },
          title: topicTitle(topic),
          count: counts.get(topic) ?? 0,
        })),
        { kind: "group", group: PROVIDER_LISTS, count: catalogue.data?.total ?? 0 },
      );
      return result;
    }
    result.length = 0;
    const groups = new Map<string, number>();
    for (const category of all)
      if (category.group !== null)
        groups.set(category.group, (groups.get(category.group) ?? 0) + category.channelCount);
    const placed = new Set<string>();
    for (const category of all) {
      if (category.group === null) result.push(categoryEntry(category, false));
      else if (!placed.has(category.group)) {
        placed.add(category.group);
        result.push({
          kind: "group",
          group: category.group,
          count: groups.get(category.group) ?? 0,
        });
      }
    }
    return result;
  }, [
    categories,
    catalogue.data,
    favourites.channels,
    recent.channels,
    subscriptions,
    locale,
    group,
    query,
    providers,
  ]);
  const openGroup = (group: string) => {
    if (group === PROVIDER_LISTS) setProviders(true);
    else setGroup(group);
    search("");
    setEntry(0);
  };
  const setQuery = (query: string) => {
    search(query);
    setEntry(0);
  };
  const back = () => {
    if (query.trim() !== "") {
      setQuery("");
      return true;
    }
    if (group === null) {
      if (!providers) return false;
      setProviders(false);
      setEntry(12);
      return true;
    }
    // Restore the country's position in the provider-ordered root, including ungrouped rows.
    const root: string[] = [];
    for (const category of categories ?? []) {
      if (category.group === null) root.push(ownedKey(category));
      else if (!root.includes(category.group)) root.push(category.group);
    }
    setEntry(Math.max(0, root.indexOf(group)));
    setGroup(null);
    return true;
  };
  const count =
    providers && group === null
      ? (catalogue.data?.total ?? 0)
      : (categories ?? []).reduce(
          (sum, category) => sum + (category.group === group ? category.channelCount : 0),
          0,
        );
  // A country removed by refresh never leaves an empty, unreachable branch.
  useEffect(() => {
    if (categories && group !== null && !categories.some((category) => category.group === group))
      setGroup(null);
  }, [categories, group]);
  return {
    entries,
    group: group ?? (providers ? PROVIDER_LISTS : null),
    count,
    query,
    setQuery,
    openGroup,
    back,
    entry: Math.min(entry, Math.max(entries.length - 1, 0)),
    setEntry,
  };
}

export type ListPickerState = ReturnType<typeof useListPicker>;

/**
 * Now and next for the channels at `visible` positions in a long list, by each channel's
 * `ownedKey`. Asks in pages of 40, so scrolling a list of thousands asks only for what comes into
 * view.
 */
export function useVisibleListings(
  channels: readonly LiveChannel[],
  visible: readonly number[],
): ReadonlyMap<string, Listing> {
  const visiblePage = usePresentationVisible();
  const pages = [...new Set(visible.map((index) => Math.floor(index / LISTINGS_PAGE)))];
  return useQueries({
    queries: pages.map((page) => ({
      ...queries.listings(channels.slice(page * LISTINGS_PAGE, (page + 1) * LISTINGS_PAGE)),
      enabled: visiblePage,
    })),
    combine: (results) => {
      const merged = new Map<string, Listing>();
      for (const result of results) {
        for (const [key, listing] of Object.entries(result.data ?? {})) merged.set(key, listing);
      }
      return merged;
    },
  });
}

/** The channel `delta` steps from `current` in `list`, wrapping around like channel up and down. */
export function adjacentChannel(
  list: readonly LiveChannel[],
  current: OwnedId | null | undefined,
  delta: number,
): LiveChannel | undefined {
  if (list.length === 0) return undefined;
  const index = list.findIndex((channel) => sameOwned(channel, current));
  if (index === -1) return delta > 0 ? list[0] : list[list.length - 1];
  return list[(index + delta + list.length) % list.length];
}
