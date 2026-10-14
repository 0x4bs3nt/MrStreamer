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

/** Where a subscription's programmes come from. */
export type GuideSource =
  /** Its own guide: its provider's, or the one its playlist's first line names. */
  | { readonly kind: "own" }
  /**
   * An XMLTV address the viewer gave for it. The address can hold a key, so it stays in the main
   * process, sealed on disk: this says only where it leads.
   */
  | {
      readonly kind: "external";
      /** The address's scheme, host and port: "https://guide.example.org". */
      readonly origin: string;
      /** Epoch milliseconds since it is the subscription's guide. */
      readonly since: number;
      /**
       * The keychain no longer opens the saved address. What was downloaded from it still shows,
       * and nothing refreshes until the viewer enters it again or goes back to the own guide.
       */
      readonly locked: boolean;
    };

/**
 * What a subscription's guide is doing, for a Settings row to show: each state holds all such a
 * row needs. The guide it had keeps answering throughout, until a new one is read whole.
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

/** A subscription's guide as Settings shows it: where from, what it covers, and since when. */
export interface GuideStatus {
  /** The subscription whose guide this is. */
  readonly subscriptionId: string;
  readonly source: GuideSource;
  /** Channels of its catalogue with programmes in the guide. */
  readonly channels: number;
  /** Channels of its catalogue as the lists show it, which `channels` is counted among. */
  readonly listed: number;
  /** Channels the guide itself lists. */
  readonly guideChannels: number;
  /** Epoch milliseconds of the last download that worked, or null before one, or without a guide. */
  readonly fetchedAt: number | null;
  /** Whether there is one. Where the own guide comes from stays in the main process. */
  readonly availability: GuideAvailability;
  /** Channels the viewer mapped to a guide channel by hand. */
  readonly mapped: number;
  /** Of those, the ones whose channel the provider, or whose guide channel the guide, no longer lists. */
  readonly unresolved: number;
  /** Why the latest download failed, when it did. The guide from `fetchedAt` stays in use. */
  readonly failure: AppError | null;
  /** Since when downloads have failed: the first failure after the last that worked. */
  readonly failedAt: number | null;
  /**
   * What is under way and how the latest download ended, as it goes: `guide.updated` tells each
   * step at once, and progress within one a few times a second at most.
   */
  readonly processing: GuideProcessing;
}

/** Why a guide can't be used, or why a change to one no longer applies. */
export type GuideFailure =
  /** Nothing to check: no http(s) address was typed, and none is saved. */
  | { readonly kind: "address" }
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
   * The guide, its source or its subscription changed since this was asked: a check that is no
   * longer the latest, or a mapping made from a list that no longer holds.
   */
  | { readonly kind: "changed" }
  /** The check was stopped: by Cancel, or by a later check. */
  | { readonly kind: "cancelled" };

/** What a check of an XMLTV address found. Nothing changed yet: `guide.use` switches to it. */
export interface GuideCandidate {
  /** Names this check. It counts only while it is the subscription's latest. */
  readonly id: string;
  /** The address's scheme, host and port. */
  readonly origin: string;
  /** Channels the guide lists. */
  readonly guideChannels: number;
  /** Channels of the subscription whose guide id the guide has programmes for. */
  readonly matched: number;
  /** Channels the subscription lists. */
  readonly listed: number;
  /** When the guide's last programme ends. */
  readonly until: number;
  /** The address is the one in use, so the viewer's mappings stay. Another address starts without. */
  readonly sameSource: boolean;
}

/** Which of a subscription's channels the mapping list shows. */
export const MAP_FILTERS = ["without", "mapped", "all"] as const;
export type MapFilter = (typeof MAP_FILTERS)[number];

/** One of a subscription's channels, with how it gets its programmes. */
export interface MapChannel {
  readonly id: string;
  readonly number: number | null;
  readonly title: string;
  /** The guide channel whose programmes it shows, or null without any. */
  readonly guideId: string | null;
  /**
   * The guide channel the viewer mapped it to, which the guide may no longer list. Null on
   * automatic: it then shows the guide channel its own guide id names, if the guide has it.
   */
  readonly mappedTo: string | null;
  /** False once the provider no longer lists it, and only its mapping is left. */
  readonly listed: boolean;
}

export interface MapChannelPage {
  readonly total: number;
  readonly channels: readonly MapChannel[];
  /** Names the guide these were read from, for `guide.map`: another guide refuses the change. */
  readonly revision: string;
}

/** A channel as the guide lists it. */
export interface GuideChannel {
  /** The id programmes name it by, exactly as the guide writes it. */
  readonly id: string;
  /** The name the guide gives it, or its id where the guide names none. */
  readonly name: string;
  /** Whether the guide has programmes for it that haven't ended. */
  readonly programmes: boolean;
}

export interface GuideChannelPage {
  readonly total: number;
  readonly channels: readonly GuideChannel[];
}
