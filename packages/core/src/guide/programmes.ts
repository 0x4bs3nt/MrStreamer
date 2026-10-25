// What the UI asks of a subscription's guides, over its catalogue: now and next for a screen of
// channels, a schedule, a page of a grid, searches, and the lists for mapping channels by hand.
// The programmes are read from the guides' indexes on disk (index-file.ts), a few at a time.
//
// A subscription reads its guides in order (`Guides`): its own, its provider's or its playlist's,
// then each global source the viewer added, in the order of Settings > Guides. A catalogue channel
// shows the programmes of the first guide that has programmes for one of its own guide ids, of that
// guide's channel by that id exactly, and the whole channel from that guide: no programme of
// another fills a gap. A channel the viewer mapped by hand shows the guide channel it was mapped
// to, of the guide the mapping names, and that alone. Nothing is ever matched by name.
//
// A guide id means something only within its guide, so a guide channel is named by both, its
// `guideRef`, wherever it leaves the main process to be handed back: a grid's slot, a mapping.
import type {
  GuideChannel,
  GuideChannelPage,
  GuideChannelRef,
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

/** What a subscription's own guide is named by, where a global source is by its id. */
export const OWN_GUIDE = "own";

/** How catalogue channels name their guide channels. */
export interface GuideChannels {
  /**
   * The channel's guide ids: none, one, or each spelling its streams give of one, "vtm.be" and
   * "vtm BE". The channel shows the programmes of the first a guide has any for.
   */
  guideIdsOf(channelId: string): readonly string[];
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
  /** The guide it was mapped in: `OWN_GUIDE`, or a global source's id. */
  readonly source: string;
  /** The guide channel's id, exactly as that guide writes it. */
  readonly guideId: string;
  /** What the channel was called then, to name it once the provider no longer lists it. */
  readonly name: string;
}

/** A catalogue's channels with the viewer's mappings. */
export interface MappedChannels extends CatalogueChannels {
  /** The mapping of each channel the lists show, by the channel's id. */
  readonly mapped: ReadonlyMap<string, GuideMapping>;
  /** Mappings of channels the catalogue no longer lists, by the id each was mapped under. */
  readonly unlisted: ReadonlyMap<string, GuideMapping>;
}

/**
 * `channels` with `mappings`, by channel id. A mapping is kept under the channel's id as it was
 * then and finds the channel by any of its streams' ids, as the catalogue does, so it holds when
 * the provider lists the streams anew.
 */
export function mappedChannels(
  channels: CatalogueChannels,
  mappings: Readonly<Record<string, GuideMapping>>,
): MappedChannels {
  const mapped = new Map<string, GuideMapping>();
  const unlisted = new Map<string, GuideMapping>();
  for (const [key, mapping] of Object.entries(mappings)) {
    const channel = channels.channel(key);
    if (channel) mapped.set(channel.id, mapping);
    // One the lists only hide for now is neither shown nor gone.
    else if (!channels.listed(key)) unlisted.set(key, mapping);
  }
  return { ...channels, mapped, unlisted };
}

/** One of the guides a subscription's channels read. */
export interface GuidePart {
  /** `OWN_GUIDE`, or the global source's id. */
  readonly source: string;
  /** The global source's origin, or null for the subscription's own guide. */
  readonly origin: string | null;
  readonly index: GuideIndex;
  /** Where its index is, for the search worker. */
  readonly path: string;
}

/** A subscription's guides, in the order they supply its channels. */
export interface Guides {
  /** Its own guide when it has one, then each global source downloaded, in order. */
  readonly parts: readonly GuidePart[];
  /**
   * Every global source by its id, with its origin, downloaded or not: a mapping to one whose
   * download is still to come waits for it, rather than count as gone.
   */
  readonly sources: ReadonlyMap<string, string>;
  /** When each channel of every part ends, in time order: what decides which still have any. */
  readonly ends: Float64Array;
}

/** `parts`, read in their order, among `sources`. */
export function guidesOf(
  parts: readonly GuidePart[],
  sources: ReadonlyMap<string, string>,
): Guides {
  const ends = new Float64Array(parts.reduce((sum, part) => sum + part.index.ends.length, 0));
  let at = 0;
  for (const part of parts) {
    ends.set(part.index.ends, at);
    at += part.index.ends.length;
  }
  return { parts, sources, ends: ends.sort() };
}

/** What a guide channel of `source` is named by outside the main process. */
export function guideRef(source: string, guideId: string): string {
  return `${source}:${guideId}`;
}

/** What `guideRef` named, or null for what it can't have. */
export function parseGuideRef(ref: string): { source: string; guideId: string } | null {
  const at = ref.indexOf(":");
  return at > 0 && at < ref.length - 1
    ? { source: ref.slice(0, at), guideId: ref.slice(at + 1) }
    : null;
}

/** A channel as one of a subscription's guides lists it, with the guide. */
interface Shown {
  readonly part: GuidePart;
  readonly channel: IndexedChannel;
}

/** What each channel shows now and next at `at`. Channels without guide data are left out. */
export function listingsAt(
  guides: Guides,
  channels: MappedChannels,
  channelIds: readonly string[],
  at: number,
): Record<string, Listing> {
  const result: Record<string, Listing> = {};
  for (const channelId of channelIds) {
    const shown = shownChannel(guides, channels, channelId, at);
    const listing = shown && shown.part.index.listing(shown.channel, at);
    if (listing) result[channelId] = listing;
  }
  return result;
}

/** How many of a catalogue's channels its guides have programmes for, and from which. */
export interface Coverage {
  /** Channels with programmes that haven't ended. */
  readonly covered: number;
  /** Of those, how many each part supplies, by the part's source. */
  readonly bySource: ReadonlyMap<string, number>;
  /**
   * When the guide that supplies one of them can next change: the first end of the last
   * programme of a guide channel that supplies one, or null while none does.
   */
  readonly changes: number | null;
}

/**
 * How many of the catalogue's channels its guides have programmes for that haven't ended at
 * `at`, and from which guide each. A channel a guide only keeps the past of isn't covered.
 * Worked out in slices the first time, of `slice`'s budget, which a caller working through
 * several shares.
 */
export function coverage(
  guides: Guides,
  channels: MappedChannels,
  at: number,
  slice: Slice = slicer(),
): Promise<Coverage> {
  return remembered(covered, guides, channels, at, slice, async (slice) => {
    const bySource = new Map<string, number>();
    let count = 0;
    let changes: number | null = null;
    for (const channel of channels.all) {
      const shown = shownChannel(guides, channels, channel.id, at);
      if (shown) {
        count++;
        bySource.set(shown.part.source, (bySource.get(shown.part.source) ?? 0) + 1);
        const until = shown.channel.until;
        if (until !== null && (changes === null || until < changes)) changes = until;
      }
      const rest = slice();
      if (rest) await rest;
    }
    return { covered: count, bySource, changes };
  });
}

const covered = new WeakMap<Guides, WeakMap<MappedChannels, Remembered<Coverage>>>();

/**
 * The channel's programme on now and those after it that start before `until`, as
 * `GuideIndex.schedule` bounds them, all of the guide channel that supplies the channel at
 * `at`, the time now, as `rangeAt` reads it.
 */
export function scheduleAt(
  guides: Guides,
  channels: MappedChannels,
  channelId: string,
  at: number,
  from: number,
  until: number,
): readonly Programme[] {
  const shown = shownChannel(guides, channels, channelId, at);
  return shown ? shown.part.index.schedule(shown.channel, at, from, until) : [];
}

/**
 * Each channel's programmes that overlap [from, to), past ones the guide keeps among them, by
 * channel id, all of the guide channel that supplies the channel at `at`, the time now, as
 * listings pick it: whatever the stretch, so pages of a grid side by side never read two guides
 * for one channel. A guide that took over a channel shows only the past it kept itself. Each
 * slot names that guide channel by its `guideRef`. Channels without guide data are left out.
 * Channels that show the same guide channel share one read of it, and other work gets its turn
 * between reads.
 */
export async function rangeAt(
  guides: Guides,
  channels: MappedChannels,
  channelIds: readonly string[],
  at: number,
  from: number,
  to: number,
): Promise<Record<string, readonly GuideSlot[]>> {
  const slice = slicer();
  const read = new Map<IndexedChannel, readonly GuideSlot[]>();
  const result: Record<string, readonly GuideSlot[]> = {};
  for (const channelId of channelIds) {
    const shown = shownChannel(guides, channels, channelId, at);
    if (!shown) continue;
    let slots = read.get(shown.channel);
    if (!slots) {
      const guide = guideRef(shown.part.source, shown.channel.id);
      slots = shown.part.index.range(shown.channel, from, to).map((slot) => ({ ...slot, guide }));
      read.set(shown.channel, slots);
      const rest = slice();
      if (rest) await rest;
    }
    result[channelId] = slots;
  }
  return result;
}

/**
 * The programme of the guide channel `ref` names that starts at `start`, with its description:
 * a slot's of `rangeAt`, by the `guide` it names. Only while that guide channel supplies the
 * channel at `at`, the time now, as every other read picks it: null for a slot of a guide that
 * no longer does, or a guide channel the channel doesn't name, or none starting then.
 */
export function programmeAt(
  guides: Guides,
  channels: MappedChannels,
  channelId: string,
  ref: string,
  start: number,
  at: number,
): Programme | null {
  const shown = shownChannel(guides, channels, channelId, at);
  return shown && guideRef(shown.part.source, shown.channel.id) === ref
    ? shown.part.index.programme(shown.channel, start)
    : null;
}

/**
 * What the guide says of the channel's programme that starts at `start`, from the guide channel
 * that supplies the channel at `at`, the time now, as every other read picks it: `found`, or
 * `none` when no guide supplies the channel or the one that does lists nothing starting then. A
 * channel the lists don't show can't be told of, and is `unknown`.
 */
export function startingAt(
  guides: Guides,
  channels: MappedChannels,
  channelId: string,
  start: number,
  at: number,
): ProgrammeAt {
  if (!channels.channel(channelId)) return { kind: "unknown" };
  const shown = shownChannel(guides, channels, channelId, at);
  const programme = shown?.part.index.programme(shown.channel, start) ?? null;
  return programme ? { kind: "found", programme } : { kind: "none" };
}

/** What `startingAt` answers, here and as `Guide.startingAt`. */
export type ProgrammeAt =
  | { readonly kind: "unknown" }
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly programme: Programme };

/**
 * Programmes on now or later whose title has every word of `query`, on the first channel in the
 * catalogue that shows them, from every guide. On now comes first, then by start time. `search`
 * reads each guide's file away from the main process, one after another; the caller keeps the
 * files until it answers.
 */
export async function searchAt(
  guides: Guides,
  channels: MappedChannels,
  query: string,
  at: number,
  search: GuideSearching,
  signal: AbortSignal,
): Promise<readonly ProgrammeMatch[]> {
  const words = searchWords(query);
  if (words.length === 0) return [];
  const shown = await searchable(guides, channels, at);
  const matches: ProgrammeMatch[] = [];
  for (const [place, part] of guides.parts.entries()) {
    const keys = shown[place];
    if (!keys || keys.size === 0) continue;
    // Each guide's own first fifty hold every one of the first fifty of them all.
    const found = await search.first(
      { path: part.path, words, at, channels: [...keys.keys()], limit: SEARCH_LIMIT },
      signal,
    );
    for (const { channel, programme } of found) {
      const shownOn = keys.get(channel);
      if (shownOn) matches.push({ channel: shownOn, programme });
    }
  }
  const onNow = (match: ProgrammeMatch) => (match.programme.start <= at ? 0 : 1);
  return matches
    .sort((a, b) => onNow(a) - onNow(b) || a.programme.start - b.programme.start)
    .slice(0, SEARCH_LIMIT);
}

/**
 * For each part, in order, the catalogue channel a search names for each of its guide channels
 * that some channel shows at `at`, by the channel's key in the part's file: the first in the
 * catalogue that shows it, leaving out channels for adults, which show only in Live TV's lists.
 */
function searchable(
  guides: Guides,
  channels: MappedChannels,
  at: number,
): Promise<readonly ReadonlyMap<number, LiveChannel>[]> {
  return remembered(shownBy, guides, channels, at, slicer(), async (slice) => {
    const shown = guides.parts.map(() => new Map<number, LiveChannel>());
    for (const channel of channels.all) {
      const found = channel.adult ? undefined : shownChannel(guides, channels, channel.id, at);
      const keys = found && shown[guides.parts.indexOf(found.part)];
      if (found && keys && !keys.has(found.channel.key)) keys.set(found.channel.key, channel);
      const rest = slice();
      if (rest) await rest;
    }
    return shown;
  });
}

const shownBy = new WeakMap<
  Guides,
  WeakMap<MappedChannels, Remembered<readonly ReadonlyMap<number, LiveChannel>[]>>
>();

/**
 * What a search for `query` finds in the programmes of `channelIds`, by channel id: whether the
 * one on now has every word in its title, and the first later one starting before `until` that
 * does. Channels without a match are left out. Every channel given is searched, on the guide
 * channel it shows, so channels that share one are each found and nothing is cut off; those for
 * adults count like any other, as a list holds them only while the catalogue shows them.
 * `search` reads each guide's file away from the main process.
 */
export async function searchChannelsAt(
  guides: Guides,
  channels: MappedChannels,
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
  const showing = guides.parts.map(() => new Map<number, string[]>());
  for (const channelId of channelIds) {
    const shown = shownChannel(guides, channels, channelId, at);
    const keys = shown && showing[guides.parts.indexOf(shown.part)];
    if (shown && keys) {
      const ids = keys.get(shown.channel.key);
      if (ids) ids.push(channelId);
      else keys.set(shown.channel.key, [channelId]);
    }
    const rest = slice();
    if (rest) await rest;
  }
  const result: Record<string, ListingMatch> = {};
  for (const [place, part] of guides.parts.entries()) {
    const keys = showing[place];
    if (!keys || keys.size === 0) continue;
    const found = await search.each(
      { path: part.path, words, at, until, channels: [...keys.keys()] },
      signal,
    );
    for (const { channel, now, later } of eachMatch(found)) {
      for (const channelId of keys.get(channel) ?? []) result[channelId] = { now, later };
      const rest = slice();
      if (rest) await rest;
    }
  }
  return result;
}

/**
 * How many of the viewer's mappings lead nowhere: the provider no longer lists the channel, the
 * source it names went, or its guide no longer lists the guide channel it was mapped to.
 */
export function unresolvedMappings(guides: Guides, channels: MappedChannels): number {
  let count = channels.unlisted.size;
  for (const mapping of channels.mapped.values()) {
    if (mapping.source !== OWN_GUIDE && !guides.sources.has(mapping.source)) {
      count++;
      continue;
    }
    const part = guides.parts.find((each) => each.source === mapping.source);
    if (part && !part.index.channels.has(mapping.guideId)) count++;
  }
  return count;
}

/** One of a catalogue's channels as the mapping list shows it at `at`. */
export function mapChannel(
  guides: Guides,
  channels: MappedChannels,
  channel: LiveChannel,
  at: number,
): MapChannel {
  const shown = shownChannel(guides, channels, channel.id, at);
  const mapping = channels.mapped.get(channel.id);
  return {
    id: channel.id,
    number: channel.number,
    title: channel.title,
    shown: shown ? refOf(shown.part.source, shown.part.origin, shown.channel.id) : null,
    mapped: mapping ? mappedRef(guides, mapping) : null,
    listed: true,
  };
}

/** What a mapping names, its source's origin among `guides`. */
function mappedRef(guides: Guides, mapping: GuideMapping): GuideChannelRef {
  return refOf(mapping.source, guides.sources.get(mapping.source) ?? null, mapping.guideId);
}

function refOf(source: string, origin: string | null, id: string): GuideChannelRef {
  return source === OWN_GUIDE
    ? { ref: guideRef(source, id), id, source: null, origin: null }
    : { ref: guideRef(source, id), id, source, origin };
}

/**
 * A page of the catalogue's channels for the mapping list, in the lists' order: those without
 * programmes still to come at `at`, those mapped by hand, or all, and of those the ones whose
 * names have every word of `query`, or whose number is one of them. Mapped channels the provider
 * no longer lists come last among the mapped ones, under the name they had.
 */
export function mapChannelsAt(
  guides: Guides,
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
    if (filter === "without" && shownChannel(guides, channels, channel.id, at)) continue;
    take(() => mapChannel(guides, channels, channel, at));
  }
  if (filter === "mapped") {
    for (const [id, mapping] of channels.unlisted) {
      if (!found(normalize(mapping.name), null)) continue;
      take(() => ({
        id,
        number: null,
        title: mapping.name,
        shown: null,
        mapped: mappedRef(guides, mapping),
        listed: false,
      }));
    }
  }
  return { total, channels: rows };
}

/**
 * A page of the channels the guides list, each guide's by name in the guides' order: all of
 * them, or those whose name or id has every word of `query`, with the ones that begin with it
 * first. Each says whether its guide has programmes for it that haven't ended at `at`; none of
 * the programmes come along.
 */
export function guideChannelsAt(
  guides: Guides,
  query: string,
  offset: number,
  limit: number,
  at: number,
): GuideChannelPage {
  const words = searchWords(query);
  const whole = words.join(" ");
  const all = guides.parts.flatMap((part) =>
    [...part.index.channels.values()].map((channel) => ({ part, channel })),
  );
  const matches =
    words.length === 0
      ? all
      : all
          .filter(({ channel }) => words.every((word) => channel.folded.includes(word)))
          // The sort keeps the guides' and the names' order within each half.
          .sort(
            (a, b) =>
              Number(!a.channel.folded.startsWith(whole)) -
              Number(!b.channel.folded.startsWith(whole)),
          );
  return {
    total: matches.length,
    listed: all.length,
    channels: matches.slice(offset, offset + limit).map(({ part, channel }): GuideChannel => ({
      ...refOf(part.source, part.origin, channel.id),
      name: channel.name,
      programmes: channel.until !== null && channel.until > at,
    })),
  };
}

/** The mapping a channel shows by, unless the source it names went: then it is automatic. */
function mappingOf(
  guides: Guides,
  channels: MappedChannels,
  channelId: string,
): GuideMapping | undefined {
  const mapping = channels.mapped.get(channels.channel(channelId)?.id ?? channelId);
  return mapping && (mapping.source === OWN_GUIDE || guides.sources.has(mapping.source))
    ? mapping
    : undefined;
}

/**
 * The guide channel whose programmes a channel shows from `after` on. Mapped, the one it was
 * mapped to, when that guide has programmes for it then, else none. Otherwise, of the first
 * guide in order that has programmes for one of its guide ids that haven't ended by then, the
 * first such. So a spelling a guide doesn't know, or only keeps the past of, never hides one it
 * has programmes for, wherever the provider lists it, a later guide never patches an earlier
 * one's channel, and a channel shows, counts and is found once.
 */
function shownChannel(
  guides: Guides,
  channels: MappedChannels,
  channelId: string,
  after: number,
): Shown | undefined {
  const mapping = mappingOf(guides, channels, channelId);
  if (mapping) {
    const part = guides.parts.find((each) => each.source === mapping.source);
    const channel = part?.index.channels.get(mapping.guideId);
    return part && channel && channel.until !== null && channel.until > after
      ? { part, channel }
      : undefined;
  }
  const guideIds = channels.guideIdsOf(channelId);
  if (guideIds.length === 0) return undefined;
  for (const part of guides.parts) {
    for (const guideId of guideIds) {
      const channel = part.index.channels.get(guideId);
      if (channel && channel.until !== null && channel.until > after) return { part, channel };
    }
  }
  return undefined;
}

/** What `remembered` keeps: an answer, or the work under way on it, and how long it holds. */
interface Remembered<A> {
  readonly value: Promise<A>;
  /** How many of the guides' channels had no programmes left then: it holds while as many have. */
  readonly ended: number;
}

/** How many of the guides' channels have no programmes left at `at`, their last ones among them. */
function endedBy(guides: Guides, at: number): number {
  const { ends } = guides;
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
 * What `work` makes of a subscription's guides and its channels at `at`, kept while both are the
 * same and the same channels still have programmes to come. Work under way is kept too, so
 * whoever asks meanwhile waits for the same answer; `work` lets other work in with the `slice` it
 * is given. Work that fails is forgotten.
 */
function remembered<A>(
  cache: WeakMap<Guides, WeakMap<MappedChannels, Remembered<A>>>,
  guides: Guides,
  channels: MappedChannels,
  at: number,
  slice: Slice,
  work: (slice: Slice) => Promise<A>,
): Promise<A> {
  let byChannels = cache.get(guides);
  if (!byChannels) cache.set(guides, (byChannels = new WeakMap()));
  const ended = endedBy(guides, at);
  const kept = byChannels.get(channels);
  if (kept?.ended === ended) return kept.value;
  const value = work(slice);
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
/** Answers a pause to take before going on, once the work since the last has had its time. */
export type Slice = () => Promise<void> | undefined;

export function slicer(): Slice {
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
