// The programme guide as the UI sees it. Times are epoch milliseconds.
import type { AppError } from "./errors.ts";
import type { LiveChannel } from "./library.ts";

export interface Programme {
  readonly start: number;
  readonly stop: number;
  readonly title: string;
  readonly description: string | null;
}

/**
 * A programme as a grid places it: without its description, which `guide.programme` reads with
 * the slot's `guide`.
 */
export interface GuideSlot extends Omit<Programme, "description"> {
  /**
   * The guide channel the slot is of, among those its channel's guide ids name: opaque, to hand
   * back to `guide.programme` as it is.
   */
  readonly guide: string;
}

/**
 * How much a grid reads at once with `guide.range`: a page of channels over a few hours. A grid
 * shows about 25 channels by six hours and reads the next page as it scrolls.
 */
export const GUIDE_RANGE = { channels: 30, hours: 12 } as const;

/**
 * What `guide.schedule` answers of a channel: the programmes over [from, until), never more than
 * `most`; where that holds fewer, at least `atLeast` on now or to come, from past `until`, and,
 * when `from` has passed, at least `atLeast` that have ended, from before `from`. The guide keeps
 * no programme shorter than a minute, so `most` holds the longest day with the one on at its
 * start: over a day it never cuts one short. That is a day of 26 hours, as where the clocks go
 * back two hours (Antarctica/Troll), `GUIDE_DAY_MS`.
 */
export const GUIDE_SCHEDULE = { atLeast: 6, most: 26 * 60 + 1 } as const;

/** The longest day a clock can have, which `guide.schedule` may be asked for: 26 hours. */
export const GUIDE_DAY_MS = 26 * 60 * 60 * 1000;

/** What a channel shows now and next. Either is null where the guide has a gap or ends. */
export interface Listing {
  readonly now: Programme | null;
  readonly next: Programme | null;
}

/** A programme that matched a search, on the channel that shows it. */
export interface ProgrammeMatch {
  readonly channel: LiveChannel;
  readonly programme: Programme;
}

/**
 * What a search within a list of channels found in one channel's programmes today. Without
 * descriptions: the channel's schedule has them.
 */
export interface ListingMatch {
  /** Whether the programme on now matches. */
  readonly now: boolean;
  /** The first later one that matches, or null. */
  readonly later: Pick<Programme, "start" | "title"> | null;
}

/**
 * Whether the subscription has a programme guide. `unknown`: it hasn't answered yet, as before
 * the first download or when asking failed. `available`: a guide of it is loaded. `none`: it
 * answered that it has none, as a playlist does whose first line names no guide.
 */
export type GuideAvailability = "unknown" | "available" | "none";

/**
 * An XMLTV guide the viewer added in Settings > Guides. Every subscription reads the sources
 * after its own guide, in their order. The address can hold a key, so it stays in the main
 * process, sealed on disk: this says only where it leads.
 */
export interface GuideSourceStatus {
  /**
   * Names the source for `guide.removeSource`, `guide.moveSource`, `guide.refreshSource` and
   * `guide.renameSource`. A random id given when it was added: nothing of its address.
   */
  readonly id: string;
  /** The address's scheme, host and port: "https://guide.example.org". */
  readonly origin: string;
  /**
   * The name the viewer gave it, `GUIDE_LABEL_MAX` characters at most, or null without one. Kept
   * as typed, not sealed.
   */
  readonly label: string | null;
  /**
   * The keychain no longer opens the saved address. What was downloaded from it still shows, and
   * nothing refreshes until the viewer adds it again.
   */
  readonly locked: boolean;
  /** Its work and its guide, `ready.channels` counting the channels it supplies in every subscription. */
  readonly processing: GuideProcessing;
}

/** How many of a subscription's channels one of its guides supplies. */
export interface GuideSupply {
  /** The global source, or null for the subscription's own guide. */
  readonly source: Pick<GuideSourceStatus, "id" | "origin" | "label"> | null;
  readonly channels: number;
}

/**
 * What a guide is doing, a subscription's own or a global source, for a Settings row to show:
 * each state holds all such a row needs. The guide it had keeps answering throughout, until a
 * new one is read whole.
 *   - `downloading`: `bytes` of the document have arrived, of `total` when the server says.
 *   - `reading`: the document is being indexed, `programmes` of it so far, since `since`.
 *   - `ready`: nothing is under way and a guide is in use: `channels` of the catalogue it covers,
 *     the `programmes` it keeps, until when they run, and when it was downloaded.
 *   - `failed`: nothing is under way, and downloads have failed `since` then, for `reason`. The
 *     last download that worked stays in use: `kept` says when it arrived, or null without one.
 *   - `empty`: nothing is under way, no guide is in use and none failed. Whether one is to come
 *     is `GuideStatus.availability`.
 */
export type GuideProcessing =
  | { readonly state: "downloading"; readonly bytes: number; readonly total: number | null }
  | { readonly state: "reading"; readonly programmes: number; readonly since: number }
  | {
      readonly state: "ready";
      readonly channels: number;
      readonly programmes: number;
      /** Epoch milliseconds its last programme ends, or null without one. */
      readonly until: number | null;
      readonly fetchedAt: number;
    }
  | {
      readonly state: "failed";
      readonly reason: AppError;
      readonly since: number;
      /** Epoch milliseconds the guide still in use was downloaded, or null without one. */
      readonly kept: number | null;
    }
  | { readonly state: "empty" };

/**
 * A subscription's guide as Settings shows it: what its own guide and the global sources cover,
 * and what its own guide is doing.
 */
export interface GuideStatus {
  /** The subscription whose guide this is. */
  readonly subscriptionId: string;
  /** Channels of its catalogue with programmes in any of its guides. */
  readonly channels: number;
  /**
   * Of those, how many each guide supplies, in order: its own, then each global source that
   * supplies any.
   */
  readonly supplied: readonly GuideSupply[];
  /** Channels of its catalogue as the lists show it, which `channels` is counted among. */
  readonly listed: number;
  /** Channels its own guide lists. */
  readonly guideChannels: number;
  /** Epoch milliseconds of its own guide's last download that worked, or null without one. */
  readonly fetchedAt: number | null;
  /** Whether it has a guide of its own. Where that comes from stays in the main process. */
  readonly availability: GuideAvailability;
  /** Channels the viewer mapped to a guide channel by hand. */
  readonly mapped: number;
  /**
   * Of those, the ones whose channel the provider, or whose guide channel its guide, no longer
   * lists, or whose source went.
   */
  readonly unresolved: number;
  /**
   * What is under way with its own guide and how the latest download ended, as it goes:
   * `guide.updated` tells each step at once, and progress within one a few times a second at
   * most.
   */
  readonly processing: GuideProcessing;
}

/** The most characters a source's name keeps: one typed longer is cut there. */
export const GUIDE_LABEL_MAX = 60;

/** Why a guide can't be used, or why a change to one no longer applies. */
export type GuideFailure =
  /** Nothing to add: what was typed isn't an http(s) address. */
  | { readonly kind: "address" }
  /**
   * The name given a source holds an address ("://"), as when one is pasted into the wrong field:
   * a name is kept unsealed. A guard against that slip, not a check that a name holds no key.
   */
  | { readonly kind: "label" }
  /** The keychain no longer opens the saved address. */
  | { readonly kind: "locked" }
  /** The address redirected from https to http, or more often than a guide may. */
  | { readonly kind: "redirect"; readonly reason: "unencrypted" | "too-many" }
  /** The address answered with something other than an XMLTV document. */
  | { readonly kind: "not-xmltv" }
  /** The document stops before its end, or its gzip is damaged. */
  | { readonly kind: "incomplete" }
  /** The document lists no programmes at all. */
  | { readonly kind: "empty" }
  /** Every programme it lists has ended. */
  | { readonly kind: "ended" }
  /** The document is larger than the app reads: nothing of it is used. */
  | { readonly kind: "too-large"; readonly limit: "bytes" | "element" | "channels" }
  /**
   * The guide, its source or its subscription changed since this was asked: a source that was
   * removed, or a mapping made from a list that no longer holds.
   */
  | { readonly kind: "changed" };

/** Which of a subscription's channels the mapping list shows. */
export const MAP_FILTERS = ["without", "mapped", "all"] as const;
export type MapFilter = (typeof MAP_FILTERS)[number];

/** A guide channel of one of a subscription's guides: which guide, and its id there. */
export interface GuideChannelRef {
  /** Opaque: names the guide and the channel, for `guide.map`. */
  readonly ref: string;
  /** The id programmes name it by, exactly as the guide writes it. */
  readonly id: string;
  /**
   * The global source's id, as `guide.sources` names it, or null for the subscription's own guide.
   * An address a release before set that couldn't move to the sources this run is none of theirs.
   */
  readonly source: string | null;
  /** The global source's origin, or null for the subscription's own guide. */
  readonly origin: string | null;
}

/** One of a subscription's channels, with how it gets its programmes. */
export interface MapChannel {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  /** The guide channel whose programmes it shows, or null without any. */
  readonly shown: GuideChannelRef | null;
  /**
   * The guide channel the viewer mapped it to, which its guide may no longer list. Null on
   * automatic: it then shows the first guide channel its own guide ids name, its own guide first
   * and then the sources in order.
   */
  readonly mapped: GuideChannelRef | null;
  /** False once the provider no longer lists it, and only its mapping is left. */
  readonly listed: boolean;
}

export interface MapChannelPage {
  readonly total: number;
  readonly channels: readonly MapChannel[];
  /** Names the guide these were read from, for `guide.map`: another guide refuses the change. */
  readonly revision: string;
}

/** A channel as one of a subscription's guides lists it. */
export interface GuideChannel extends GuideChannelRef {
  /** The name the guide gives it, or its id where the guide names none. */
  readonly name: string;
  /** Whether the guide has programmes for it that haven't ended. */
  readonly programmes: boolean;
}

export interface GuideChannelPage {
  /** The channels the query finds. */
  readonly total: number;
  /** The channels the guides list in all, found or not. */
  readonly listed: number;
  readonly channels: readonly GuideChannel[];
}
