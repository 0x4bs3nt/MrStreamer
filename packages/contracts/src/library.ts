// The library model: how the app sees content, independent of the provider that supplied it.
import type { AppError } from "./errors.ts";
import type { OwnedId } from "./subscription.ts";
import type { BrowseMetadata } from "./live-browse.ts";

/**
 * A live TV channel: the provider's streams of one channel, one per quality or backup. Most have
 * one; streams join only when their names, regions, languages and categories agree (see
 * @mrstreamer/core/catalogue/variants). Streams of different subscriptions never join: the same
 * channel from two providers is two channels.
 */
export interface LiveChannel {
  /** Derived discovery facts, attached after exact channel joins have finished. */
  readonly browse?: BrowseMetadata;
  /** The subscription that lists it. With `id`, it names the channel (`OwnedId`). */
  readonly subscriptionId: string;
  /**
   * Stable within one subscription: the lowest of its streams' ids. Any of its streams' ids finds
   * the channel too, so favourites and history kept by stream still do.
   */
  readonly id: string;
  /** The provider's name of its first stream: "BE | VRT 1 FHD (VLAANDEREN)". */
  readonly name: string;
  /** The name to show: "VRT 1". */
  readonly title: string;
  /** Quality and format markers every stream's name carries: "FHD" for a channel with one. */
  readonly tags: readonly string[];
  /** The provider's channel number of its first stream, if it assigns one. */
  readonly number: number | null;
  readonly logoUrl: string | null;
  /** Every category one of its streams is in, by the ids of its own subscription's categories. */
  readonly categoryIds: readonly string[];
  /** Its streams, in the provider's order. */
  readonly variants: readonly ChannelVariant[];
  /**
   * Catch-up: how many days back the provider keeps its programmes to play after they aired, the
   * most any of its streams keeps. Null when none of them keeps any.
   */
  readonly catchupDays: number | null;
  /**
   * For adults: one of its streams is marked so, or sits in a category named for adults. Shown
   * only in Live TV, and only while Settings shows titles for adults.
   */
  readonly adult?: true;
  /**
   * Another subscription lists a channel that shows under the same name, so lists say which
   * subscription each is from. Worked out over every channel there is, whatever list it shows in.
   */
  readonly ambiguous?: true;
  /** Catalogue-validated identity for display-only search folding. Missing means keep apart. */
  readonly searchIdentity?: LiveSearchIdentity;
  /** Response-only full-catalogue group and source order. Never stored or used for playback. */
  readonly searchGroup?: LiveSearchStamp;
}

/** Full-catalogue display decision for one owned channel. */
export interface LiveSearchStamp {
  readonly key: string;
  readonly order: number;
}

/** Full-catalogue joins only; copies are owned keys in canonical source order. */
export type LiveSearchGroups = readonly {
  readonly key: string;
  readonly copies: readonly string[];
}[];

export interface LiveSearchIdentity {
  readonly title: string;
  readonly language: string | null;
  /** Explicit region only. A guide's country suffix is not an explicit region. */
  readonly region: string | null;
  readonly topics: readonly string[];
  /** Canonical identity of a guide id validated against this catalogue, else null. */
  readonly guideId: string | null;
}

/** How sharp a stream's picture is, best first: 4K, Full HD, HD and SD. */
export const QUALITIES = ["uhd", "fhd", "hd", "sd"] as const;
export type Quality = (typeof QUALITIES)[number];

/** One of a channel's streams. */
export interface ChannelVariant {
  /** The provider's stream id: what plays, and what a chosen quality remembers. */
  readonly id: string;
  /** The provider's name, for search: "BE | VRT 1 HD". */
  readonly name: string;
  /** Quality and format markers from its name: "HD", "HEVC". */
  readonly tags: readonly string[];
  /** The quality its name says, or null when it says none or contradicts itself. */
  readonly quality: Quality | null;
  /** How many days of catch-up the provider keeps of this stream; absent when it keeps none. */
  readonly catchupDays?: number;
}

/**
 * A list of channels as Live TV names it: one provider category, or those of several
 * subscriptions that show as one. They do when their country, the name they show under and
 * whether they are for adults all agree, and never by a name that only looks alike.
 */
export interface Category {
  /**
   * The first of its `members`: with `id`, it names the category (`OwnedId`). Any other member
   * names the same list.
   */
  readonly subscriptionId: string;
  readonly id: string;
  /** The provider's name: "BE | VLAANDEREN". */
  readonly name: string;
  /** The country or region it is grouped under: "Belgium". Null when it stands on its own. */
  readonly group: string | null;
  /** The name to show, within its group if it has one: "Vlaanderen". */
  readonly title: string;
  /** How many channels it lists, of every member. */
  readonly channelCount: number;
  /**
   * Each provider category it shows, in the order of the subscriptions. A channel's
   * `categoryIds` name these, within the channel's own subscription.
   */
  readonly members: readonly OwnedId[];
}

/** When a subscription's live catalogue was last fetched, and how big it is. */
export interface CatalogueStatus {
  /** The subscription whose catalogue this is. */
  readonly subscriptionId: string;
  readonly channelCount: number;
  /** Epoch milliseconds, or null before the first successful fetch. */
  readonly fetchedAt: number | null;
  /** Why the latest refresh failed, when it did. The catalogue from `fetchedAt` stays in use. */
  readonly failure: AppError | null;
  /**
   * Since when refreshes have failed, in epoch milliseconds: the first failure after the last
   * refresh that worked. Null while `failure` is.
   */
  readonly failedAt: number | null;
}
