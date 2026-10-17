// Which of the provider's streams are one channel, and which of them to play. Panels list a channel
// once per quality ("VRT 1 FHD", "VRT 1 HD", "VRT 1 SD"), with backups ("FHD²") and sometimes in a
// category of their own ("BE | 4K"). Streams join only when they are surely the same channel:
//   - Their titles agree once quality markers are gone, case and accents aside but not spaces or
//     symbols: "Canal+" is not "Canal", nor "VRT1" "VRT 1".
//   - Their regions agree, and their languages: "BE - FR | RTBF La Une" stays apart from "BE |
//     RTBF La Une".
//   - Their categories hold the same, quality words aside: "BE | VLAANDEREN" and "BE | VLAANDEREN
//     HD" do, "CA | FRENCH" and "CA | ENGLISH" don't. A stream in a category named only for a
//     quality joins the title's streams when they form one group, and stays with its kind otherwise.
//   - Their trusted guide ids don't disagree, however each is spelt: "vtm.be" is "vtm BE". A shared
//     guide id joins nothing by itself: panels file unrelated channels under one (see
//     ./guide-ids.ts).
// Anything less certain stays apart, as the provider lists it.
import {
  QUALITIES,
  type ChannelVariant,
  type LiveChannel,
  type LiveSearchIdentity,
  type Quality,
} from "@mrstreamer/contracts/library";
import {
  DEFAULT_LIVE_QUALITY,
  type Preferences,
  type SubscriptionPreferences,
} from "@mrstreamer/contracts/preferences";
import { finish, pacer, type Steps } from "../steps.ts";
import { trustedGuideIds } from "./guide-ids.ts";
import type { NormalizedStream } from "./normalize.ts";
import { countryForCode, isBroadRegion } from "./regions.ts";

/** How many of a channel's streams Auto tries, one after another, before it gives up. */
const AUTO_TRIES = 3;

/** Markers that say how sharp the picture is. The rest, "HEVC" or "RAW", say nothing about it. */
// prettier-ignore
const RESOLUTIONS: Readonly<Record<string, Quality>> = {
  "8K": "uhd", "4K": "uhd", UHD: "uhd", FHD: "fhd", HD: "hd", "HD+": "hd", SD: "sd",
};

/** A channel as a catalogue lists it, before the library says which subscription's it is. */
export type ListedChannel = Omit<LiveChannel, "subscriptionId">;

export interface LiveChannels {
  /** In the provider's order, each where its first stream is. */
  readonly channels: readonly ListedChannel[];
  /**
   * The guide ids of each channel that has one to trust, by channel id: each spelling its streams
   * give, in their order. The guide lists programmes under one of them, not always the first.
   */
  readonly guideIds: ReadonlyMap<string, readonly string[]>;
}

/** The catalogue's channels, each with its streams. */
export function liveChannels(streams: readonly NormalizedStream[]): LiveChannels {
  return finish(liveChannelSteps(streams));
}

/** `liveChannels`, pausing between slices of its streams (../steps.ts). */
export function* liveChannelSteps(streams: readonly NormalizedStream[]): Steps<LiveChannels> {
  const due = pacer();
  const trusted = yield* trustedGuideIds(
    streams.flatMap((stream) =>
      stream.guideId ? [{ channel: stream, guideId: stream.guideId }] : [],
    ),
  );
  const alike = new Map<string, NormalizedStream[]>();
  const uncertain = new Set<NormalizedStream>();
  for (const stream of streams) {
    if (due()) yield;
    // Contradictory category/prefix metadata must not join or bridge otherwise distinct feeds.
    const country = /\.([a-z]{2})(?:@[^.@]*)?$/i.exec(trusted.get(stream.id) ?? "")?.[1];
    const guideRegion = country ? countryForCode(country) : null;
    if (
      stream.searchUncertain ||
      (guideRegion &&
        stream.region &&
        !isBroadRegion(stream.region) &&
        guideRegion !== stream.region)
    ) {
      uncertain.add(stream);
      continue;
    }
    const key = `${identity(stream.title)}\n${stream.language ?? ""}`;
    const list = alike.get(key);
    if (list) list.push(stream);
    else alike.set(key, [stream]);
  }
  // A stream's region is its name's or category's, else the country of its guide id: VRT1.be.
  const regionOf = (stream: NormalizedStream): string[] => {
    const country = /\.([a-z]{2})(?:@[^.@]*)?$/i.exec(trusted.get(stream.id) ?? "")?.[1];
    const region = stream.region ?? (country ? countryForCode(country) : null);
    return region ? [region] : [];
  };
  const together = new Map<NormalizedStream, readonly NormalizedStream[]>();
  for (const candidates of alike.values()) {
    // Most streams are a channel of their own.
    if (candidates.length === 1) continue;
    if (due()) yield;
    for (const regional of yield* partition(candidates, regionOf)) {
      for (const group of yield* partition(regional, (stream) => stream.topics)) {
        const guideIds = new Set<string>();
        for (const stream of group) {
          if (due()) yield;
          for (const id of guideChannel(trusted.get(stream.id))) guideIds.add(id);
        }
        for (const part of guideIds.size > 1 ? group.map((stream) => [stream]) : [group]) {
          for (const stream of part) {
            if (due()) yield;
            together.set(stream, part);
          }
        }
      }
    }
  }

  const channels: ListedChannel[] = [];
  const guideIds = new Map<string, readonly string[]>();
  for (const stream of streams) {
    if (due()) yield;
    const group = together.get(stream) ?? [stream];
    if (group[0] !== stream) continue;
    const searchIdentity = uncertain.has(stream)
      ? undefined
      : yield* searchIdentityOf(group, trusted);
    const channel = {
      ...(yield* joined(stream, group)),
      ...(searchIdentity ? { searchIdentity } : {}),
    };
    channels.push(channel);
    const spellings = new Set<string>();
    for (const each of group) {
      if (due()) yield;
      const spelling = trusted.get(each.id);
      if (spelling !== undefined) spellings.add(spelling);
    }
    if (spellings.size > 0) guideIds.set(channel.id, [...spellings]);
  }
  return { channels, guideIds };
}

/**
 * Search gets only metadata that every stream of the canonical channel agrees on. A channel can
 * have thousands of streams, so it looks at them a slice at a time.
 */
function* searchIdentityOf(
  streams: readonly NormalizedStream[],
  trusted: ReadonlyMap<string, string>,
): Steps<LiveSearchIdentity | undefined> {
  const first = streams[0];
  if (!first) return;
  const due = pacer();
  const title = identity(first.title);
  const regions = new Set<string>();
  const guides = new Set<string>();
  /** The topics every stream that has any agrees on, in the first such stream's order. */
  let topics: string[] | null = null;
  for (const stream of streams) {
    if (due()) yield;
    // Catch-up and regional/category labels can disappear from a cleaned display title.
    if (
      stream.searchUncertain ||
      /catch[ -]?up|timeshift|\+\s*\d+\s*h\b/i.test([stream.name, ...stream.topics].join(" ")) ||
      identity(stream.title) !== title ||
      stream.language !== first.language
    )
      return;
    if (stream.region !== null) regions.add(stream.region);
    for (const guide of guideChannel(trusted.get(stream.id))) guides.add(guide);
    if (stream.topics.length > 0) {
      topics =
        topics === null
          ? [...stream.topics]
          : topics.filter((topic) => stream.topics.includes(topic));
    }
  }
  if (regions.size > 1 || guides.size > 1) return;
  return {
    title,
    language: first.language,
    region: [...regions][0] ?? null,
    topics: topics ?? [],
    guideId: [...guides][0] ?? null,
  };
}

/**
 * What a stream's markers say about its picture: "FHD" and "1080p" are Full HD. A line count is
 * the more precise, so "HD (1080p)" is Full HD. Null when they say nothing, or disagree, as "HD
 * (576p)" does.
 */
export function qualityOf(tags: readonly string[]): Quality | null {
  if (tags.length === 0) return null;
  const lines = new Set(
    tags.flatMap((tag): Quality[] => {
      const count = Number(/^(\d{3,4})p$/.exec(tag)?.[1]);
      if (!count) return [];
      return [count >= 2160 ? "uhd" : count >= 1080 ? "fhd" : count >= 720 ? "hd" : "sd"];
    }),
  );
  const named = new Set(tags.flatMap((tag) => RESOLUTIONS[tag] ?? []));
  const [measured, ...more] = lines;
  if (more.length > 0) return null;
  if (!measured) return named.size === 1 ? ([...named][0] ?? null) : null;
  // "HD" also stands for high definition in general, which Full HD is.
  const fits = [...named].every(
    (quality) => quality === measured || (quality === "hd" && measured === "fhd"),
  );
  return fits ? measured : null;
}

/**
 * The streams to try for a channel, in order. A stream asked for by id, or else the one the viewer
 * chose for the channel before (`channelVariants`), is tried alone; a stream asked for that the
 * channel doesn't have gives none. Otherwise Auto's: the preferred quality, then lower ones from the
 * best down, then higher ones from the nearest up, then those whose quality is unknown, at most
 * `AUTO_TRIES`. Equals keep the provider's order, so a backup follows its main stream.
 */
export function streamsToPlay(
  channel: Pick<LiveChannel, "variants">,
  preferences: Pick<Preferences, "liveQuality"> & Pick<SubscriptionPreferences, "channelVariants">,
  asked?: string,
): readonly ChannelVariant[] {
  if (asked !== undefined) {
    const variant = channel.variants.find(({ id }) => id === asked);
    return variant ? [variant] : [];
  }
  const chosen = chosenVariant(channel, preferences.channelVariants);
  if (chosen) return [chosen];
  const preferred = QUALITIES.indexOf(preferences.liveQuality ?? DEFAULT_LIVE_QUALITY);
  const rank = ({ quality }: ChannelVariant) => {
    if (quality === null) return 2 * QUALITIES.length;
    const lower = QUALITIES.indexOf(quality) - preferred;
    return lower >= 0 ? lower : QUALITIES.length - lower;
  };
  return channel.variants.toSorted((a, b) => rank(a) - rank(b)).slice(0, AUTO_TRIES);
}

/**
 * The stream the viewer chose for a channel, or null for Automatic. A choice is kept under the
 * channel's id then, which may since be another of its streams'; one the channel no longer lists
 * counts as none.
 */
export function chosenVariant(
  channel: Pick<LiveChannel, "variants">,
  choices: SubscriptionPreferences["channelVariants"],
): ChannelVariant | null {
  for (const { id } of channel.variants) {
    const chosen = channel.variants.find((variant) => variant.id === choices?.[id]);
    if (chosen) return chosen;
  }
  return null;
}

/**
 * A title as streams compare it: lowercase, without accents, and with punctuation as spaces, except
 * the symbols that tell channels apart: "Canal+", "E!".
 */
function identity(title: string): string {
  return title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+!&]+/gu, " ")
    .trim();
}

/**
 * Splits streams into groups by what `keysOf` says about them: their regions, or their
 * categories' topics. Streams sharing a key join, also through a third. Those without one join the
 * one group there is, or form their own beside several: a stream that doesn't say is never the
 * reason two that differ join.
 */
function* partition(
  streams: readonly NormalizedStream[],
  keysOf: (stream: NormalizedStream) => readonly string[],
): Steps<(readonly NormalizedStream[])[]> {
  if (streams.length === 1) return [streams];
  const due = pacer();
  type Group = { keys: Set<string>; streams: Set<NormalizedStream> };
  /** In the order they were made, one that takes others in counting as new. */
  const groups = new Set<Group>();
  const groupByKey = new Map<string, Group>();
  const unsaid: NormalizedStream[] = [];
  for (const stream of streams) {
    if (due()) yield;
    const keys = keysOf(stream);
    if (keys.length === 0) {
      unsaid.push(stream);
      continue;
    }
    const joining = new Set(keys.flatMap((key) => groupByKey.get(key) ?? []));
    // The largest of them takes the stream and the others in, so a group a thousand streams of
    // one channel join one by one isn't copied each time.
    const group = [...joining].reduce<Group>(
      (largest, each) => (each.streams.size > largest.streams.size ? each : largest),
      { keys: new Set(), streams: new Set() },
    );
    for (const key of keys) {
      group.keys.add(key);
      groupByKey.set(key, group);
    }
    group.streams.add(stream);
    for (const other of joining) {
      groups.delete(other);
      if (other === group) continue;
      for (const key of other.keys) {
        group.keys.add(key);
        groupByKey.set(key, group);
      }
      for (const each of other.streams) {
        if (due()) yield;
        group.streams.add(each);
      }
    }
    groups.add(group);
  }
  const [only, ...more] = groups;
  if (only && more.length === 0) for (const stream of unsaid) only.streams.add(stream);
  else if (unsaid.length > 0) groups.add({ keys: new Set(), streams: new Set(unsaid) });
  // In the provider's order, which the first stream of each group keeps.
  const groupOf = new Map<NormalizedStream, NormalizedStream[]>();
  const listed = [...groups].map((group) => {
    const members: NormalizedStream[] = [];
    for (const stream of group.streams) groupOf.set(stream, members);
    return members;
  });
  for (const stream of streams) {
    if (due()) yield;
    groupOf.get(stream)?.push(stream);
  }
  return listed;
}

/**
 * The guide channel an id names, its feed's quality and its spelling aside. Playlists name feeds
 * after "@", and one channel's SD and HD feeds are one channel: "BBCOne.uk@ScotlandHD" is
 * "BBCOne.uk@Scotland", "Arirang.kr@HD" is "Arirang.kr". "@East" and "@West" stay apart. Panels
 * spell one id several ways, so case, spaces and punctuation don't count: "vtm.be" is "vtm BE",
 * and "NPO1.nl" "NPO 1 NL". Every letter and digit does, the country's too, and the symbols that
 * tell channels apart, as in titles: "RTL.de" is not "RTL.lu", nor "Canal.fr" "Canal+.fr".
 */
function guideChannel(guideId: string | undefined): string[] {
  if (!guideId) return [];
  return [
    guideId
      .replace(/@(.*?)(?:SD|HD|FHD|UHD|4K)?$/i, (_, feed: string) => feed && `@${feed}`)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}@+!&]+/gu, ""),
  ];
}

/** One channel of the streams in `group`, the first of them `first`, a slice at a time. */
function* joined(
  first: NormalizedStream,
  group: readonly NormalizedStream[],
): Steps<ListedChannel> {
  const due = pacer();
  let id = first.id;
  let tags = first.tags;
  let logoUrl: string | null = null;
  const categoryIds = new Set<string>();
  const variants: ChannelVariant[] = [];
  let catchupDays = 0;
  for (const stream of group) {
    if (due()) yield;
    id = lower(id, stream.id);
    tags = tags.filter((tag) => stream.tags.includes(tag));
    logoUrl ??= stream.logoUrl || null;
    for (const categoryId of stream.categoryIds) categoryIds.add(categoryId);
    variants.push({
      id: stream.id,
      name: stream.name,
      tags: stream.tags,
      quality: qualityOf(stream.tags),
      ...(stream.catchupDays ? { catchupDays: stream.catchupDays } : {}),
    });
    catchupDays = Math.max(catchupDays, stream.catchupDays ?? 0);
  }
  return {
    id,
    name: first.name,
    title: first.title,
    tags,
    number: first.number,
    logoUrl,
    categoryIds: [...categoryIds],
    variants,
    catchupDays: catchupDays || null,
  };
}

/** The lower of two stream ids: by number when both are numbers, as Xtream's are. */
function lower(a: string, b: string): string {
  const numbers = /^\d+$/.test(a) && /^\d+$/.test(b);
  return (numbers ? Number(b) < Number(a) : b < a) ? b : a;
}
