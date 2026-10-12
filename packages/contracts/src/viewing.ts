// What the viewer keeps per account: favourite channels, the channels watched recently, how far
// movies and episodes got, and the episodes marked watched or unwatched by hand. The main process
// records them as events (see @mrstreamer/core/viewing); the UI reads this state, in which
// everything names its subscription. It holds every saved subscription's at once: the favourites
// in the order starred, whichever subscription each is from, and the rest by when it was watched.
import type { TitleRef } from "./ondemand.ts";
import type { OwnedId } from "./subscription.ts";

/** How many channels the recently watched list shows. */
export const RECENT_LIMIT = 12;

/** How many movies and series Continue watching shows. */
export const CONTINUE_LIMIT = 20;

/**
 * How many the record offers it: more than it shows, so the titles the UI leaves out, those for
 * adults and those the provider no longer lists, don't push the others off the row.
 */
export const CONTINUE_OFFERED = 100;

export interface Viewing {
  /** Channels in the order they were added, or the order the viewer gave them since. */
  readonly favourites: readonly OwnedId[];
  /** Channels, most recently watched first, at most `RECENT_LIMIT`. */
  readonly recent: readonly OwnedId[];
  /**
   * Movies started and not finished, and for each series the episode watched last, finished or
   * not, most recent first, at most `CONTINUE_OFFERED`. Removed ones stay out until played again.
   */
  readonly continueWatching: readonly TitleProgress[];
  /** At most 32 recent started local plays, including finished movies, for Home seeds. */
  readonly recentTitles?: readonly TitleProgress[];
  /**
   * The series an episode of which was marked, with where each goes on, most recent first, at
   * most `CONTINUE_OFFERED`. One taken out of Continue watching since stays out, as a played one
   * does, until it is marked or played again.
   */
  readonly marked: readonly MarkedSeries[];
  /** How far the record has come: a later change has a higher number. */
  readonly sequence: number;
}

/**
 * A new order for the favourites, from the list it was arranged in. The record takes it only
 * while that list still holds, so an order made from an older one never lands on favourites
 * changed since, nor on those of a subscription that went or took another's place: each favourite
 * names its subscription, so the lists then differ.
 */
export interface FavouriteOrder {
  /** The favourites as `Viewing.favourites` gave them: every one, of every subscription, in order. */
  readonly original: readonly OwnedId[];
  /**
   * Those of them the viewer arranged, in the order wanted. The rest, channels the lists don't
   * show or the provider no longer lists, keep their places.
   */
  readonly order: readonly OwnedId[];
}

/**
 * Which titles' progress to read or change: movies, and every episode of the series, by the ids
 * of their versions. Each language version of a film or series has its own.
 */
export interface TitleFilter {
  readonly movies?: readonly OwnedId[];
  readonly series?: readonly OwnedId[];
}

/** How far a movie or an episode got. */
export interface TitleProgress {
  readonly title: TitleRef;
  /** Seconds from the start. */
  readonly position: number;
  /** Seconds, as the player knew it. */
  readonly duration: number;
  /** Watched to the credits. */
  readonly finished: boolean;
  /** When it was last played: epoch milliseconds. */
  readonly at: number;
  /**
   * When the play that got it there began: epoch milliseconds. A mark of the episode made during
   * that play or after it stands against it, and one made before it gives way. A play that moves
   * to a receiver and back is one play, begun when the viewer started it.
   */
  readonly since: number;
}

/**
 * An episode the viewer marked watched or unwatched by hand, in one subscription. It is kept by
 * the series and the episode's numbers, so it holds for every version of the series that
 * subscription lists and for whichever file the provider serves the episode from.
 */
export interface EpisodeMark {
  readonly season: number;
  readonly episode: number;
  readonly watched: boolean;
  /**
   * When it was marked: epoch milliseconds. A play of the episode begun later replaces it, and
   * what a play begun before it saves afterwards is left out of the record.
   */
  readonly at: number;
  /** Names this mark for Undo. A later mark of the series has a higher one. */
  readonly revision: number;
}

/** How the episodes of a series stand in one subscription. */
export interface SeriesViewing {
  /** How far the files of every version that subscription lists got. */
  readonly progress: readonly TitleProgress[];
  /** The marks that hold for it, one per episode at most. */
  readonly marks: readonly EpisodeMark[];
  /**
   * The mark that can still be taken back, by its `revision`: the series' latest, until the
   * series is marked again, played or taken out of Continue watching. Null when none can.
   */
  readonly undoable: number | null;
}

/** A series an episode of which was marked, and where it goes on. */
export interface MarkedSeries {
  /** The series version its latest mark was made in. */
  readonly series: OwnedId;
  /**
   * What the record keeps the series' marks under (`SeriesIdentity.key` in
   * `@mrstreamer/core/viewing/marks`). The marks hold for the series the lists show now only
   * while that is still one of its keys.
   */
  readonly kept: string;
  /** When it was last marked: epoch milliseconds. A play of the series begun later takes over. */
  readonly at: number;
  /**
   * The episode to go on with as the record stands now, among the episodes the series listed
   * when it was last marked. Null once every numbered one of them is watched.
   */
  readonly next: MarkedNext | null;
}

/** The episode a marked series goes on with. */
export interface MarkedNext {
  readonly season: number;
  readonly episode: number;
  /**
   * Where it resumes, in seconds of its length, when it goes on from an episode played partway.
   * Null plays it from the beginning.
   */
  readonly resume: { readonly position: number; readonly duration: number } | null;
}
