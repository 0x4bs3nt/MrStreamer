// What the UI asks of a guide, over a subscription's catalogue: now and next for a screen of
// channels, a schedule, a page of a grid, searches, and the lists for mapping channels by hand.
// The programmes are read from the guide's index on disk (index-file.ts), a few at a time.
//
// A catalogue channel shows the programmes of the guide channel its own guide id names, when the
// guide has that id exactly; or of the one the viewer mapped it to by hand, which then counts
// alone. Nothing is ever matched by name. `mappedChannels` lays the viewer's mappings over a
// catalogue's guide ids, both ways, so every lookup here reads one and the same answer.
import type {
  GuideChannelPage,
  GuideSlot,
  Listing,
  ListingMatch,
  MapChannel,
  MapFilter,
  Programme,
  ProgrammeMatch,
} from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { normalize, searchWords } from "../text.ts";
import {
  eachMatch,
  type GuideIndex,
  type GuideSearching,
  type IndexedChannel,
} from "./index-file.ts";

/** How many programmes a search returns. */
export const SEARCH_LIMIT = 50;

/** How catalogue channels map to the guide. */
export interface GuideChannels {
  /**
   * The channel's guide ids: none, one, or each spelling its streams give of one, "vtm.be" and
   * "vtm BE". The channel shows the programmes of the first the guide has any for.
   */
  guideIdsOf(channelId: string): readonly string[];
  /** The channels a guide id is one of, in catalogue order. */
  channelsOf(guideId: string): readonly LiveChannel[];
}

/** A subscription's channels as the lists show them, with their guide ids. */
export interface CatalogueChannels extends GuideChannels {
  /** Every channel the lists show, in their order. */
  readonly all: readonly LiveChannel[];
  /**
   * What a search compares each of `all` by, in the same order: its names, folded as
   * `normalize` folds text. Folded once with the catalogue, since folding thousands of names
   * takes longer than a search may hold the process.
   */
  readonly searchNames: readonly string[];
  /** The channel by its id or any of its streams', when the lists show it. */
  channel(channelId: string): LiveChannel | undefined;
  /** Whether the catalogue lists the channel at all, shown or not. */
  listed(channelId: string): boolean;
}

/** A channel the viewer mapped by hand, as it is kept. */
export interface GuideMapping {
  /** The guide channel's id, exactly as the guide writes it. */
  readonly guideId: string;
  /** What the channel was called then, to name it once the provider no longer lists it. */
  readonly name: string;
}

/** A catalogue's channels with the viewer's mappings laid over their guide ids. */
export interface MappedChannels extends CatalogueChannels {
  /** The guide channel the viewer mapped each channel to, by the channel's id. */
  readonly mapped: ReadonlyMap<string, string>;
  /** Mappings of channels the catalogue no longer lists, by the id each was mapped under. */
  readonly unlisted: ReadonlyMap<string, GuideMapping>;
}

/**
 * `channels` with `mappings`, by channel id, over its guide ids. A mapped channel has the guide
 * id it was mapped to and no other, also when the guide doesn't list that one: it then shows no
 * programmes, rather than another channel's. A guide id's channels are those that name it
 * themselves and aren't mapped elsewhere, with those mapped to it, in catalogue order.
 *
 * A mapping is kept under the channel's id as it was then and finds the channel by any of its
 * streams' ids, as the catalogue does, so it holds when the provider lists the streams anew.
 */
export function mappedChannels(
  channels: CatalogueChannels,
  mappings: Readonly<Record<string, GuideMapping>>,
): MappedChannels {
  const entries = Object.entries(mappings);
  if (entries.length === 0) return { ...channels, mapped: new Map(), unlisted: new Map() };
  const mapped = new Map<string, string>();
  /** The channels mapped to each guide id. */
  const reverse = new Map<string, LiveChannel[]>();
  const unlisted = new Map<string, GuideMapping>();
  for (const [key, mapping] of entries) {
    const channel = channels.channel(key);
    if (!channel) {
      // One the lists only hide for now is neither shown nor gone.
      if (!channels.listed(key)) unlisted.set(key, mapping);
      continue;
    }
    mapped.set(channel.id, mapping.guideId);
    const list = reverse.get(mapping.guideId);
    if (list) list.push(channel);
    else reverse.set(mapping.guideId, [channel]);
  }
  let positions: Map<string, number> | null = null;
  const position = (channel: LiveChannel) => {
    positions ??= new Map(channels.all.map((each, at) => [each.id, at]));
    return positions.get(channel.id) ?? Number.POSITIVE_INFINITY;
  };
  return {
    ...channels,
    mapped,
    unlisted,
    guideIdsOf: (channelId) => {
      const guideId = mapped.get(channels.channel(channelId)?.id ?? channelId);
      return guideId === undefined ? channels.guideIdsOf(channelId) : [guideId];
    },
    channelsOf: (guideId) => {
      const own = channels.channelsOf(guideId).filter((channel) => !mapped.has(channel.id));
      const others = reverse.get(guideId);
      if (!others) return own;
      return [...own, ...others].sort((a, b) => position(a) - position(b));
    },
  };
}

/** What each channel shows now and next at `at`. Channels without guide data are left out. */
export function listingsAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  at: number,
): Record<string, Listing> {
  const result: Record<string, Listing> = {};
  for (const channelId of channelIds) {
    const shown = shownChannel(index, channels, channelId, at);
    const listing = shown && index.listing(shown, at);
    if (listing) result[channelId] = listing;
  }
  return result;
}

/**
 * How many of the catalogue's channels the guide has programmes for that haven't ended at `at`.
 * A channel the guide only keeps the past of isn't covered. Worked out in slices the first time.
 */
export function channelsCovered(
  index: GuideIndex,
  channels: GuideChannels,
  at: number,
): Promise<number> {
  return remembered(covered, index, channels, at, async (slice) => {
    let count = 0;
    for (const { id, until } of index.channels.values()) {
      if (until !== null && until > at) {
        for (const channel of channels.channelsOf(id)) {
          if (shownGuideId(index, channels, channel.id, at) === id) count++;
        }
      }
      const rest = slice();
      if (rest) await rest;
    }
    return count;
  });
}

const covered = new WeakMap<GuideIndex, WeakMap<GuideChannels, Remembered<number>>>();

/**
 * The channel's programme on now and those after it that start before `until`, as
 * `GuideIndex.schedule` bounds them.
 */
export function scheduleAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
  at: number,
  from: number,
  until: number,
): readonly Programme[] {
  const shown = shownChannel(index, channels, channelId, at);
  return shown ? index.schedule(shown, at, from, until) : [];
}

/**
 * Each channel's programmes that overlap [from, to), past ones the guide keeps among them, by
 * channel id: of the guide channel that still has programmes at `from`, so a grid scrolled back
 * shows what the guide kept of then. Channels without guide data are left out. Channels that
 * show the same guide channel share one read of it, and other work gets its turn between reads.
 */
export async function rangeAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelIds: readonly string[],
  from: number,
  to: number,
): Promise<Record<string, readonly GuideSlot[]>> {
  const slice = slicer();
  const read = new Map<number, readonly GuideSlot[]>();
  const result: Record<string, readonly GuideSlot[]> = {};
  for (const channelId of channelIds) {
    const shown = shownChannel(index, channels, channelId, from);
    if (!shown) continue;
    let slots = read.get(shown.key);
    if (!slots) {
      slots = index.range(shown, from, to);
      read.set(shown.key, slots);
      const rest = slice();
      if (rest) await rest;
    }
    result[channelId] = slots;
  }
  return result;
}

/**
 * The programme of guide channel `guideId` that starts at `start`, with its description: a
 * slot's of `rangeAt`, by the guide it names. Null when the channel doesn't name that guide
 * channel, or it has none starting then.
 */
export function programmeAt(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
  guideId: string,
  start: number,
): Programme | null {
  if (!channels.guideIdsOf(channelId).includes(guideId)) return null;
  const channel = index.channels.get(guideId);
  return channel ? index.programme(channel, start) : null;
}

/**
 * Programmes on now or later whose title has every word of `query`, on the first channel in the
 * catalogue that shows them. On now comes first, then by start time. `search` reads the index's
 * file, at `path`, away from the main process; the caller keeps the file until it answers.
 */
export async function searchAt(
  index: GuideIndex,
  path: string,
  channels: GuideChannels,
  query: string,
  at: number,
  search: GuideSearching,
  signal: AbortSignal,
): Promise<readonly ProgrammeMatch[]> {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const shown = await searchable(index, channels, at);
  const found = await search.first(
    {
      path,
      words,
      at,
      channels: [...shown.keys()],
      limit: SEARCH_LIMIT,
    },
    signal,
  );
  return found.flatMap(({ channel, programme }) => {
    const shownOn = shown.get(channel);
    return shownOn ? [{ channel: shownOn, programme }] : [];
  });
}

/**
 * The catalogue channel a search names for each guide channel with programmes that haven't
 * ended at `at`: the first that shows it, leaving out channels for adults, which show only in
 * Live TV's lists.
 */
function searchable(
  index: GuideIndex,
  channels: GuideChannels,
  at: number,
): Promise<ReadonlyMap<number, LiveChannel>> {
  return remembered(shownBy, index, channels, at, async (slice) => {
    const shown = new Map<number, LiveChannel>();
    for (const { key, id, until } of index.channels.values()) {
      if (until !== null && until > at) {
        const channel = channels
          .channelsOf(id)
          .find((each) => !each.adult && shownGuideId(index, channels, each.id, at) === id);
        if (channel) shown.set(key, channel);
      }
      const rest = slice();
      if (rest) await rest;
    }
    return shown;
  });
}

const shownBy = new WeakMap<
  GuideIndex,
  WeakMap<GuideChannels, Remembered<ReadonlyMap<number, LiveChannel>>>
>();

/**
 * What a search for `query` finds in the programmes of `channelIds`, by channel id: whether the
 * one on now has every word in its title, and the first later one starting before `until` that
 * does. Channels without a match are left out. Every channel given is searched, on the guide id
 * it shows, so channels that share one are each found and nothing is cut off; those for adults
 * count like any other, as a list holds them only while the catalogue shows them. `search` reads
 * the index's file, at `path`, away from the main process.
 */
export async function searchChannelsAt(
  index: GuideIndex,
  path: string,
  channels: GuideChannels,
  channelIds: readonly string[],
  query: string,
  at: number,
  until: number,
  search: GuideSearching,
  signal: AbortSignal,
): Promise<Record<string, ListingMatch>> {
  const words = searchWords(query);
  if (words.length === 0) return {};
  // A list may hold tens of thousands of channels: what is worked out of each, before and after
  // the worker searches, lets other work in between slices.
  const slice = slicer();
  const showing = new Map<number, string[]>();
  for (const channelId of channelIds) {
    const shown = shownChannel(index, channels, channelId, at);
    if (shown) {
      const ids = showing.get(shown.key);
      if (ids) ids.push(channelId);
      else showing.set(shown.key, [channelId]);
    }
    const rest = slice();
    if (rest) await rest;
  }
  if (showing.size === 0) return {};
  const found = await search.each(
    { path, words, at, until, channels: [...showing.keys()] },
    signal,
  );
  const result: Record<string, ListingMatch> = {};
  for (const { channel, now, later } of eachMatch(found)) {
    for (const channelId of showing.get(channel) ?? []) result[channelId] = { now, later };
    const rest = slice();
    if (rest) await rest;
  }
  return result;
}

/**
 * How many of the viewer's mappings lead nowhere: the provider no longer lists the channel, or
 * the guide no longer lists the guide channel it was mapped to.
 */
export function unresolvedMappings(index: GuideIndex | null, channels: MappedChannels): number {
  let count = channels.unlisted.size;
  if (!index) return count;
  for (const guideId of channels.mapped.values()) if (!index.channels.has(guideId)) count++;
  return count;
}

/** One of a catalogue's channels as the mapping list shows it at `at`. */
export function mapChannel(
  index: GuideIndex,
  channels: MappedChannels,
  channel: LiveChannel,
  at: number,
): MapChannel {
  return {
    id: channel.id,
    number: channel.number,
    title: channel.title,
    guideId: shownGuideId(index, channels, channel.id, at) ?? null,
    mappedTo: channels.mapped.get(channel.id) ?? null,
    listed: true,
  };
}

/**
 * A page of the catalogue's channels for the mapping list, in the lists' order: those without
 * programmes still to come at `at`, those mapped by hand, or all, and of those the ones whose
 * names have every word of `query`, or whose number is one of them. Mapped channels the provider
 * no longer lists come last among the mapped ones, under the name they had.
 */
export function mapChannelsAt(
  index: GuideIndex,
  channels: MappedChannels,
  { filter, query }: { readonly filter: MapFilter; readonly query: string },
  offset: number,
  limit: number,
  at: number,
): { readonly total: number; readonly channels: readonly MapChannel[] } {
  const words = searchWords(query);
  const found = (name: string, number: number | null) =>
    words.every((word) => name.includes(word) || String(number) === word);
  const rows: MapChannel[] = [];
  let total = 0;
  const take = (row: () => MapChannel) => {
    if (total >= offset && rows.length < limit) rows.push(row());
    total++;
  };
  for (const [position, channel] of channels.all.entries()) {
    if (!found(channels.searchNames[position] ?? "", channel.number)) continue;
    if (filter === "mapped" && !channels.mapped.has(channel.id)) continue;
    if (filter === "without" && shownGuideId(index, channels, channel.id, at) !== undefined) {
      continue;
    }
    take(() => mapChannel(index, channels, channel, at));
  }
  if (filter === "mapped") {
    for (const [id, mapping] of channels.unlisted) {
      if (!found(normalize(mapping.name), null)) continue;
      take(() => ({
        id,
        number: null,
        title: mapping.name,
        guideId: null,
        mappedTo: mapping.guideId,
        listed: false,
      }));
    }
  }
  return { total, channels: rows };
}

/**
 * A page of the channels a guide lists, by name: all of them, or those whose name or id has
 * every word of `query`, with the ones that begin with it first. Each says whether the guide has
 * programmes for it that haven't ended at `at`; none of the programmes come along.
 */
export function guideChannelsAt(
  index: GuideIndex,
  query: string,
  offset: number,
  limit: number,
  at: number,
): GuideChannelPage {
  const words = searchWords(query);
  const whole = words.join(" ");
  const all = [...index.channels.values()];
  const matches =
    words.length === 0
      ? all
      : all
          .filter(({ folded }) => words.every((word) => folded.includes(word)))
          // The sort keeps the names' order within each half.
          .sort(
            (a, b) => Number(!a.folded.startsWith(whole)) - Number(!b.folded.startsWith(whole)),
          );
  return {
    total: matches.length,
    channels: matches
      .slice(offset, offset + limit)
      .map(({ id, name, until }) => ({ id, name, programmes: until !== null && until > at })),
  };
}

/**
 * The guide channel whose programmes a channel shows from `after` on: the first of its ids the
 * guide has programmes for that haven't ended by then. So a spelling the guide doesn't know, or
 * only keeps the past of, never hides one it has programmes for, wherever the provider lists it,
 * and a channel shows, counts and is found once when the guide knows several.
 */
function shownChannel(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
  after: number,
): IndexedChannel | undefined {
  for (const guideId of channels.guideIdsOf(channelId)) {
    const channel = index.channels.get(guideId);
    if (channel && channel.until !== null && channel.until > after) return channel;
  }
  return undefined;
}

function shownGuideId(
  index: GuideIndex,
  channels: GuideChannels,
  channelId: string,
  after: number,
): string | undefined {
  return shownChannel(index, channels, channelId, after)?.id;
}

/** What `remembered` keeps: an answer, or the work under way on it, and how long it holds. */
interface Remembered<A> {
  readonly value: Promise<A>;
  /** How many of the guide's channels had no programmes left then: it holds while as many have. */
  readonly ended: number;
}

/** How many of a guide's channels have no programmes left at `at`, the guide's last ones among them. */
function endedBy(index: GuideIndex, at: number): number {
  const { ends } = index;
  let low = 0;
  let high = ends.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((ends[middle] ?? 0) <= at) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * What `work` makes of a guide and a catalogue's channels at `at`, kept while both are the same
 * and the same channels still have programmes to come. Work under way is kept too, so whoever
 * asks meanwhile waits for the same answer; `work` lets other work in with the `slice` it is
 * given. Work that fails is forgotten.
 */
function remembered<A>(
  cache: WeakMap<GuideIndex, WeakMap<GuideChannels, Remembered<A>>>,
  index: GuideIndex,
  channels: GuideChannels,
  at: number,
  work: (slice: () => Promise<void> | undefined) => Promise<A>,
): Promise<A> {
  let byChannels = cache.get(index);
  if (!byChannels) cache.set(index, (byChannels = new WeakMap()));
  const ended = endedBy(index, at);
  const kept = byChannels.get(channels);
  if (kept?.ended === ended) return kept.value;
  const value = work(slicer());
  const remembering = byChannels;
  remembering.set(channels, { value, ended });
  value.catch(() => {
    if (remembering.get(channels)?.value === value) remembering.delete(channels);
  });
  return value;
}

/** A read on the main process lets other work in once it has run this long. */
const SLICE_MS = 8;

/**
 * Lets other work in when the slice under way has run `SLICE_MS`: awaited after each step of a
 * long loop on the main process, it looks at the clock every eighth step and costs nothing else.
 */
export function slicer(): () => Promise<void> | undefined {
  let began = performance.now();
  let count = 0;
  return () => {
    if ((++count & 7) !== 0 || performance.now() - began < SLICE_MS) return undefined;
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        began = performance.now();
        resolve();
      }),
    );
  };
}
