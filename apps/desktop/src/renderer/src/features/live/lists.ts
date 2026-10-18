// The channel lists the guide and Watch's channel list show: favourites, recently watched, every
// channel, or one category. Categories group under their country, as the provider names them.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Listing, ListingMatch } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { normalize, searchWords } from "@mrstreamer/core/text";
import { indexNames, nameQuery, scoreNames, type SearchNames } from "@mrstreamer/core/search/names";
import { searchResultGroups, type LiveSearchGroup } from "@mrstreamer/core/catalogue/search";
import { t } from "@mrstreamer/core/i18n";
import { useLocale } from "../../app/language.ts";
import { useUi, type ChannelList } from "../../app/ui-store.ts";
import { useNow } from "../../lib/clock.ts";
import { usePresentationVisible } from "../../lib/presentation.ts";
import { endOfDay } from "../../lib/format.ts";
import {
  queries,
  rememberCategory,
  subscriptionName,
  useSubscriptions,
} from "../../lib/queries.ts";

const NO_IDS: readonly OwnedId[] = [];
/** Channels whose listings are asked for together. */
const LISTINGS_PAGE = 40;
const NO_CHANNELS: readonly LiveChannel[] = [];
/** A search waits this long for typing to pause, as the other searches do. */
const SEARCH_DELAY_MS = 120;
const NO_WORDS: readonly string[] = [];
const NO_MATCHES: Readonly<Record<string, ListingMatch>> = {};

/** The channels of a list, in its order; undefined while they load. */
export function useListChannels(list: ChannelList): {
  readonly channels: readonly LiveChannel[] | undefined;
  readonly error: unknown;
} {
  const viewing = useQuery(queries.viewing());
  const ids =
    list.kind === "favourites"
      ? (viewing.data?.favourites ?? NO_IDS)
      : list.kind === "recent"
        ? (viewing.data?.recent ?? NO_IDS)
        : NO_IDS;
  const byIds = useQuery(queries.channelsOf(ids));
  const listed = list.kind === "favourites" || list.kind === "recent";
  const byCategory = useQuery({
    ...queries.channels(list.kind === "category" ? list.category : null),
    enabled: !listed,
  });
  if (!listed) return { channels: byCategory.data, error: byCategory.error };
  if (!viewing.data) return { channels: undefined, error: viewing.error };
  return { channels: ids.length === 0 ? NO_CHANNELS : byIds.data, error: byIds.error };
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
  list: ChannelList,
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
  const scope = useMemo(
    () =>
      list.kind === "category"
        ? { category: ownedId(list.category) }
        : list.kind === "all"
          ? {}
          : { channels: channels.map(ownedId) },
    [list, channels],
  );
  const searching = text.trim() !== "";
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
    case "category":
      return categories.get(ownedKey(list.category))?.title ?? t("Channels");
  }
}

/**
 * Shows a list in the guide. A category, or all channels, is where Live TV opens next time: a
 * category is kept for its own subscription, and all channels by none of them keeping one.
 */
export function useShowList(): (list: ChannelList) => void {
  const client = useQueryClient();
  const subscriptions = useSubscriptions();
  return useCallback(
    (list) => {
      useUi.setState({ list });
      if (list.kind !== "category" && list.kind !== "all") return;
      const category = list.kind === "category" ? list.category : null;
      void rememberCategory(client, subscriptions, category).catch(() => {});
    },
    [client, subscriptions],
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

/** One country at a time, or Find across the whole catalogue. Only the chosen list is saved. */
export function useListPicker(selected: ChannelList) {
  const categories = useQuery(queries.categories()).data;
  const viewing = useQuery(queries.viewing()).data;
  const status = useQuery(queries.libraryStatus()).data;
  const subscriptions = useSubscriptions();
  const locale = useLocale();
  const selectedKey = selected.kind === "category" ? ownedKey(selected.category) : selected.kind;
  const selectedGroup =
    selected.kind === "category"
      ? (categories?.find((category) =>
          category.members.some((member) => sameOwned(member, selected.category)),
        )?.group ?? null)
      : null;
  const [group, setGroup] = useState<string | null>(selectedGroup);
  const [query, search] = useState("");
  const [entry, setEntry] = useState(0);
  // Remembered lists arrive asynchronously; refresh can also move a category to another country.
  useEffect(() => {
    setGroup(selectedGroup);
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
        count: viewing?.favourites.length ?? 0,
      },
      {
        kind: "list",
        list: { kind: "recent" },
        title: t("Recently watched"),
        count: viewing?.recent.length ?? 0,
      },
      {
        kind: "list",
        list: { kind: "all" },
        title: t("All channels"),
        count: (status ?? []).reduce((sum, each) => sum + each.channelCount, 0),
      },
    ];
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
  }, [categories, viewing, status, subscriptions, locale, group, query]);
  const openGroup = (group: string) => {
    setGroup(group);
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
    if (group === null) return false;
    // Restore the country's position in the provider-ordered root, including ungrouped rows.
    const root: string[] = ["favourites", "recent", "all"];
    for (const category of categories ?? []) {
      if (category.group === null) root.push(ownedKey(category));
      else if (!root.includes(category.group)) root.push(category.group);
    }
    setEntry(Math.max(0, root.indexOf(group)));
    setGroup(null);
    return true;
  };
  const count = (categories ?? []).reduce(
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
    group,
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
