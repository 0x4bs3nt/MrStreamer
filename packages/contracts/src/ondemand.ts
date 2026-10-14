// Movies and series as the UI sees them, independent of the provider that supplied them.
import { type } from "arktype";
import type { AppError } from "./errors.ts";
import type { OwnedId } from "./subscription.ts";
import { lazy, type Infer } from "./lazy.ts";

export const TITLE_KINDS = ["movie", "series"] as const;
export type TitleKind = (typeof TITLE_KINDS)[number];

/**
 * A movie or a series in a catalogue list. Series and movies share it, so lists show both alike.
 * Providers list each language version on its own; a title gathers them, those of every saved
 * subscription that lists the film or series, and shows and plays the one that suits the viewer's
 * language.
 */
export interface Title {
  readonly kind: TitleKind;
  /**
   * Names the film or series among the lists, whichever version shows first: its kind and TMDB id
   * where versions gather under one, else its only version. So a tile stays the same tile when
   * another subscription's lists arrive, are fetched again or go. Not an id to send back.
   */
  readonly key: string;
  /** The subscription that lists `id`. With `id`, it names that version (`OwnedId`). */
  readonly subscriptionId: string;
  /**
   * The version shown and played first. It can change with the language, when a provider adds a
   * better suited version or when another subscription is added, so what is kept refers to
   * versions by their own ids.
   */
  readonly id: string;
  /** The provider's name of that version, for search: "Blow 2001 (NL)". */
  readonly name: string;
  /**
   * The name to show: TMDB's name in the viewer's language once its metadata arrived, else the
   * provider's without its marks, "Blow".
   */
  readonly title: string;
  /** TMDB's name in the language the title was made in, when it differs from `title`. */
  readonly originalTitle: string | null;
  /** The language TMDB says it was made in, an ISO 639-1 code; null until TMDB said. */
  readonly originalLanguage: string | null;
  /** Markers from the name: language ("NL", "MULTI") and quality ("4K"). */
  readonly tags: readonly string[];
  readonly year: number | null;
  /** Portrait artwork. */
  readonly posterUrl: string | null;
  /** Landscape artwork, when the list has it. Movies get theirs with the details. */
  readonly backdropUrl: string | null;
  /** Out of 10, or null when the provider has none. */
  readonly rating: number | null;
  /** When the provider added the movie, or last changed the series: epoch milliseconds. */
  readonly addedAt: number | null;
  /** The provider marks it, or its category, as for adults. */
  readonly adult: boolean;
  /** The Movie Database's id, which the language versions of one film share. */
  readonly tmdbId: string | null;
  /** From TMDB, once its metadata arrived: "Comedy", "Drama". */
  readonly genres: readonly string[];
  /** Every version, the one shown first in front. They can be of several subscriptions. */
  readonly versions: readonly TitleVersion[];
  /**
   * A title of another subscription shows under the same name and year without being this one,
   * as when one of them has no TMDB id: tiles then say which subscription each is from. Only a
   * title whose versions are all of one subscription has it.
   */
  readonly ambiguous?: true;
}

/** Search results in Movies or Series: the best matches, and how many match in all. */
export interface TitleMatches {
  readonly titles: readonly Title[];
  readonly total: number;
  /** Before current-content filters, for the matched-of-all count. */
  readonly unfiltered?: number;
}

/** At most twelve related titles from saved subscriptions' already loaded lists. */
export interface RelatedTitles {
  readonly basis: string | null;
  readonly titles: readonly { readonly title: Title; readonly reason: string }[];
}

/** A bounded recommendation from an actual recent local play and loaded catalogue. */
export interface HomeRecommendation {
  readonly title: Title;
  readonly seed: string;
  readonly reason: string;
}

export interface HomeSeed {
  readonly kind: TitleKind;
  readonly version: OwnedId;
}

/** One version of a title as the provider lists it, often one per language. */
export interface TitleVersion {
  /** The subscription that lists it. With `id`, it names the version (`OwnedId`). */
  readonly subscriptionId: string;
  readonly id: string;
  /** Markers from its name: "NL", "MULTI", "4K". */
  readonly tags: readonly string[];
  /** Original provider label, when the current catalogue supplies it. */
  readonly name?: string;
  /** Listed file type for a movie; null for a series. No file is opened to learn it. */
  readonly container?: string | null;
  /** When this version was added or changed, in epoch milliseconds, when listed. */
  readonly addedAt?: number | null;
  /** Its position in this subscription's original list. */
  readonly listedOrder?: number;
  /** Current files opened on this device. Series facts describe only those read files, including episode alternatives. */
  readonly observed?: {
    readonly files: number;
    readonly audio: readonly (string | null)[];
    readonly subtitles: readonly (string | null)[];
  };
  /** Exact episode files of a mapped series, for showing progress without opening its details. */
  readonly episodeFiles?: readonly string[];
}

interface DetailsBase {
  readonly title: Title;
  readonly originalTitle: string | null;
  readonly plot: string | null;
  readonly genres: readonly string[];
  /** The first billed, with the part they play and a portrait when TMDB has them. */
  readonly cast: readonly Person[];
  /** A film's directors, or a series' creators. */
  readonly directors: readonly string[];
  /** "1981-05-23", as the provider wrote it. */
  readonly releaseDate: string | null;
  /** Seconds. For a series, the usual length of an episode. */
  readonly duration: number | null;
  readonly backdropUrl: string | null;
}

export interface Person {
  readonly name: string;
  /** The part they play. */
  readonly role: string | null;
  readonly photoUrl: string | null;
}

export interface MovieDetails extends DetailsBase {
  readonly kind: "movie";
}

export interface SeriesDetails extends DetailsBase {
  readonly kind: "series";
  /** In order, each with its episodes in order. Seasons without episodes are left out. */
  readonly seasons: readonly Season[];
  /** M3U logical episodes in original playlist order, including interleaved seasons. */
  readonly episodeOrder?: readonly string[];
  /** A removed or replaced source file never supplies progress to its replacement. */
  readonly exactVersions?: true;
}

export type TitleDetails = MovieDetails | SeriesDetails;

export interface Season {
  readonly number: number;
  /** "Season 2", or the provider's own name for it. */
  readonly name: string;
  readonly posterUrl: string | null;
  readonly episodes: readonly Episode[];
}

export interface Episode {
  /** The subscription that lists it, and its series. */
  readonly subscriptionId: string;
  readonly id: string;
  /** The series version it is an episode of, in the same subscription. */
  readonly seriesId: string;
  readonly season: number;
  readonly number: number;
  /** The episode's own name, without the series and numbers the provider puts in front. */
  readonly title: string;
  readonly plot: string | null;
  /** Seconds. */
  readonly duration: number | null;
  readonly stillUrl: string | null;
  readonly airDate: string | null;
  /** Every exact file of this logical episode, in source order. */
  readonly versions?: readonly EpisodeVersion[];
  readonly exactVersion?: true;
}

export interface EpisodeVersion extends Pick<
  TitleVersion,
  "container" | "addedAt" | "listedOrder" | "observed"
> {
  readonly id: string;
  readonly name: string;
  readonly tags: readonly string[];
  readonly duration: number | null;
}

/**
 * An episode once the viewer opened its season: TMDB's name in the viewer's language, story,
 * still, air date, runtime, rating, guest stars and directors where it has them, the provider's
 * otherwise.
 */
export interface EpisodeDetails extends Episode {
  /** Out of 10 on TMDB; null before enough people voted, or without TMDB. */
  readonly rating: number | null;
  /** The guest stars, with the part they play and a portrait. */
  readonly cast: readonly Person[];
  readonly directors: readonly string[];
}

/** When a subscription's movie and series lists were last fetched, and how big they are. */
export interface TitleListsStatus {
  /** The subscription whose lists these are. */
  readonly subscriptionId: string;
  /** How many it lists, each version on its own. */
  readonly movies: number;
  readonly series: number;
  /** Epoch milliseconds, or null before the first successful fetch. */
  readonly fetchedAt: number | null;
  /** Why the latest refresh failed, when it did. The lists from `fetchedAt` stay in use. */
  readonly failure: AppError | null;
}

/** The movie and series lists of every subscription that has any, and TMDB's metadata for them. */
export interface OnDemandStatus {
  /** One per subscription with movies and series, in the subscriptions' order, including explicitly mapped playlists. */
  readonly lists: readonly TitleListsStatus[];
  /** How far TMDB's metadata has come; null without a key. */
  readonly metadata: MetadataProgress | null;
}

/** TMDB's metadata for the catalogue: genres, languages, services. */
export interface MetadataProgress {
  /** Titles TMDB answered for, of those listed with a TMDB id. */
  readonly known: number;
  readonly wanted: number;
  /** TMDB refused the key; nothing more arrives until it changes. */
  readonly refused: boolean;
  /** Titles are being asked about now; false once a run ends, finished or not, as offline. */
  readonly fetching: boolean;
}

/** One page of a list, and how long the whole list is. */
export interface TitlePage {
  readonly total: number;
  readonly titles: readonly Title[];
  readonly unfiltered?: number;
}

/**
 * A collection Movies and Series show: everything, what's new, popular or top rated, a genre, a
 * streaming service, titles like one the viewer watched, or titles for adults, which no other
 * collection holds and which shows only once the viewer asks for it in Settings. `like:` names
 * the title by one of its versions, as `ownedKey` writes it.
 */
export type CollectionId =
  | "all"
  | "new-week"
  | "new-month"
  | "recent"
  | "popular"
  | "top-rated"
  | "4k"
  | "adult"
  | `genre:${string}`
  | `service:${number}`
  | `like:${string}`;

/** Whether text names a collection: what the UI sends is checked before it is used. */
export function isCollectionId(text: string): text is CollectionId {
  return /^(all|new-week|new-month|recent|popular|top-rated|4k|adult|genre:.+|service:\d+|like:.+)$/.test(
    text,
  );
}

/** How a collection's page is ordered. */
export const COLLECTION_SORTS = ["added", "popular", "rating", "title"] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

/** The tabs of rows: For you, and New. */
export const ROW_TABS = ["for-you", "new"] as const;
export type RowTab = (typeof ROW_TABS)[number];

/** One row of a tab: a collection's first titles, and how many it has. */
export interface CollectionRow {
  readonly id: CollectionId;
  readonly name: string;
  readonly total: number;
  readonly titles: readonly Title[];
}

/** A genre or streaming service as a tile, with a picture from its most popular title. */
export interface CollectionTile {
  readonly id: CollectionId;
  readonly name: string;
  readonly count: number;
  readonly artworkUrl: string | null;
}

/** One page of a collection, with its name. */
export interface CollectionPage extends TitlePage {
  readonly name: string;
}

/**
 * A movie, or one episode of a series, by the provider's own ids: what the viewing record keeps
 * per account, and what a provider is asked for. Alone it names nothing: `TitleRef` says whose.
 */
export const RawTitleRef = lazy(() =>
  type({ kind: "'movie'", id: "string > 0" }, "|", {
    kind: "'episode'",
    id: "string > 0",
    seriesId: "string > 0",
    season: "number.integer >= 0",
    episode: "number.integer >= 0",
  }),
);
export type RawTitleRef = Infer<typeof RawTitleRef>;

/**
 * Something that plays on demand: a movie, or one episode of a series, of one subscription. An
 * episode's `seriesId` is in that subscription too.
 */
export const TitleRef = lazy(() => RawTitleRef().and({ subscriptionId: "string > 0" }));
export type TitleRef = Infer<typeof TitleRef>;

/** The series version an episode belongs to, in the episode's own subscription. */
export function seriesOf(episode: {
  readonly subscriptionId: string;
  readonly seriesId: string;
}): OwnedId {
  return { subscriptionId: episode.subscriptionId, id: episode.seriesId };
}

/** "movie:123" or "episode:456": one key per thing that plays, within a subscription. */
export function titleKey(ref: RawTitleRef): string {
  return `${ref.kind}:${ref.id}`;
}
