// Messages between the main process and the catalogue worker. A call about one subscription's
// lists names that subscription; a call for what the lists show names every subscription whose
// lists count, in their order, so an answer never holds what a subscription that went left
// behind. Every title and version in an answer says which subscription lists it.
import type { AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionId,
  CollectionPage,
  CollectionRow,
  CollectionSort,
  CollectionTile,
  RowTab,
  RelatedTitles,
  HomeRecommendation,
  HomeSeed,
  Title,
  TitleKind,
  TitleMatches,
} from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { FilterOptions, TitleFilters } from "@mrstreamer/contracts/title-filters";
import type { WatchlistPage, WatchlistSort } from "@mrstreamer/contracts/watchlist";
import type { SavedMember, SavedTitle, TitleFacts } from "@mrstreamer/core/ondemand/watchlist";
import type { ActiveLanguage } from "@mrstreamer/core/i18n";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import type { ProviderAccount } from "../providers/account.ts";
import type { MetadataStatus } from "./metadata.ts";

/** What the worker needs once: where TMDB's metadata lives and how to introduce itself. */
export interface WorkerSetup {
  readonly metadataPath: string;
  readonly userAgent: string;
  /** TMDB's key, the region for streaming services and, in tests, another API; null fetches none. */
  readonly tmdb: { readonly key: string; readonly region: string; readonly api?: string } | null;
}

/** Whose lists a call is about. */
export interface CatalogueOwner {
  /** The subscription's id: what its titles and versions carry. */
  readonly subscriptionId: string;
  /** The account its lists are kept on disk for. */
  readonly key: string;
  /** The subscription's folder, where its lists are kept. */
  readonly dir: string;
  readonly importRevision?: string;
}

/** The subscriptions whose lists make the catalogue a call asks about, in their order. */
interface Owners {
  readonly owners: readonly CatalogueOwner[];
}

/** Main validates current episode details; the worker validates movie rows against its lists. */
export interface KnownFile {
  readonly subscriptionId: string;
  readonly kind: "movie" | "episode";
  readonly id: string;
  readonly seriesId?: string;
  readonly listingKey: string;
  readonly tracks?: {
    readonly audio: readonly (string | null)[];
    readonly subtitles: readonly (string | null)[];
  };
  readonly tags?: readonly string[];
}

interface FilterQuery {
  readonly filters?: TitleFilters;
  readonly files?: readonly KnownFile[];
}

/** A subscription's loaded lists: their size and age; null counts when nothing is loaded for it. */
export interface WorkerStatus {
  readonly movies: number;
  readonly series: number;
  readonly fetchedAt: number | null;
  /** Private accepted-catalogue identity. Absent on legacy snapshots. */
  readonly catalogueStamp?: string;
  readonly importRevision?: string;
}

/** Which page of the watchlist, in which order. */
export interface SavedQuery {
  readonly home?: boolean;
  /** Everything the subscriptions saved: the lists say which to show, and in what order. */
  readonly members: readonly SavedMember[];
  readonly sort: WatchlistSort;
  readonly offset: number;
  readonly limit: number;
}

/** Each call and what it answers. */
export interface WorkerCalls {
  /**
   * Each owner's lists, in the order asked. Also says whether the viewer shows titles for adults,
   * which TMDB is asked about only then.
   */
  status: { args: Owners & { adults: boolean }; result: readonly WorkerStatus[] };
  /**
   * Fetches a subscription's two lists from its provider and, when they look complete, sets them
   * aside for `finishRefresh`: nothing shows or is saved yet. `revision` is the login's:
   * a newer fetch replaces an older one; a fetch older than active or pending work is rejected.
   */
  refresh: {
    args: CatalogueOwner & {
      revision: number;
      account: ProviderAccount;
      catalogue?: OnDemandCatalogue;
    };
    result: null;
  };
  /**
   * Ends the refresh under that login. With `keep`, the lists it set aside become the
   * subscription's and are saved; without, they are dropped and the lists from before stay. Only
   * the main process knows whether the login still stands, so it says.
   */
  finishRefresh: {
    args: CatalogueOwner & { revision: number; keep: boolean };
    result: WorkerStatus;
  };
  /** Titles by any of their versions, each named with the subscription that lists it. */
  byIds: {
    args: Owners & {
      language: string;
      kind: TitleKind;
      versions: readonly OwnedId[];
      files?: readonly KnownFile[];
    };
    result: readonly Title[];
  };
  search: {
    args: Owners & { language: string; query: string };
    result: { readonly movies: readonly Title[]; readonly series: readonly Title[] };
  };
  /** Movies or series matching `query`, the best `limit` of them, and how many match. */
  searchKind: {
    args: Owners &
      FilterQuery & { language: string; kind: TitleKind; query: string; limit: number };
    result: TitleMatches;
  };
  filterOptions: {
    args: Owners & {
      language: string;
      kind: TitleKind;
      files: readonly KnownFile[];
      adults: boolean;
    };
    result: FilterOptions;
  };
  /** A tab's rows; For you starts with titles like `like`, a version of one watched lately. */
  rows: {
    args: Owners & { language: string; kind: TitleKind; tab: RowTab; like?: OwnedId };
    result: readonly CollectionRow[];
  };
  /** Related uses only loaded lists and metadata already known for the opened version. */
  related: {
    args: Owners & {
      language: string;
      kind: TitleKind;
      version: OwnedId;
      metadata?: { readonly genres: readonly string[]; readonly language: string | null };
    };
    result: RelatedTitles;
  };
  recommendations: {
    args: Owners & { language: string; seeds: readonly HomeSeed[] };
    result: readonly HomeRecommendation[];
  };
  /** Genres or streaming services as tiles. */
  tiles: {
    args: Owners & { language: string; kind: TitleKind; of: "genres" | "services" };
    result: readonly CollectionTile[];
  };
  /** One page of a collection. */
  collection: {
    args: Owners &
      FilterQuery & {
        language: string;
        kind: TitleKind;
        id: CollectionId;
        sort?: CollectionSort;
        offset: number;
        limit: number;
      };
    result: CollectionPage;
  };
  /**
   * A page of the watchlist: what the subscriptions saved as the entries it makes, each with the
   * title it is in the lists now, found by the indexes the catalogue keeps. Titles for adults
   * show only with `adults`, and count only then.
   */
  saved: {
    args: Owners & SavedQuery & { language: string; adults: boolean };
    result: WatchlistPage;
  };
  /**
   * What the lists say now about the titles `entries`, saved by `subscriptionId`, are: each once,
   * as that subscription lists it, for its record to take over. Titles it lists no more are left
   * out. Null when none of its lists are loaded.
   */
  savedFacts: {
    args: Owners & { language: string; subscriptionId: string; entries: readonly SavedTitle[] };
    result: readonly TitleFacts[] | null;
  };
  /** The file type a movie streams as, or null when its subscription's lists don't have it. */
  container: {
    args: CatalogueOwner & { id: string };
    result: { container: string; listingKey: string } | null;
  };
  /** Forgets a subscription's lists and removes their cache, for when the subscription goes. */
  forget: { args: CatalogueOwner; result: null };
  /** Writes pending lists and answers once all cache writes finish, for a clean shutdown. */
  flush: { args: Record<string, never>; result: null };
}

export type WorkerMethod = keyof WorkerCalls;

export type WorkerRequest = {
  [M in WorkerMethod]: {
    readonly id: number;
    readonly method: M;
    readonly args: WorkerCalls[M]["args"];
    /** The interface language at the call, which names such as "New this week" are written in. */
    readonly interfaceLanguage: ActiveLanguage;
  };
}[WorkerMethod];

export type WorkerReply =
  | { readonly id: number; readonly ok: true; readonly value: unknown }
  | { readonly id: number; readonly ok: false; readonly error: AppError };

/**
 * What the worker says unasked: more metadata arrived, or TMDB refused the key. `content` says
 * that what lists show changed; without it only the status did.
 */
export interface WorkerEvent {
  readonly event: "metadata";
  readonly content: boolean;
  readonly status: MetadataStatus;
}
