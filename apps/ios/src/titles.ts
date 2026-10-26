import { TMDB_REFRESH_MS } from "@mrstreamer/core/metadata/policy";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionTile,
  EpisodeDetails,
  Season,
  Title,
  TitleDetails,
  TitleKind,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { metadataStore, type MetadataStatus } from "@mrstreamer/core/metadata/store";
import {
  tmdb,
  TmdbError,
  type EpisodeAbout,
  type TitleAbout,
  type Tmdb,
  type TmdbKind,
} from "@mrstreamer/core/metadata/tmdb";
import {
  byIds,
  indexSteps,
  kindOf,
  searchPageSteps,
  type IndexedCatalogue,
} from "@mrstreamer/core/ondemand/catalogue";
import {
  collectionSteps,
  rowIds,
  type Collections,
  type CollectionSource,
} from "@mrstreamer/core/ondemand/collections";
import { movieDetails, seasonEpisodes, seriesDetails } from "@mrstreamer/core/ondemand/details";
import type { FilterFile, FilterFiles } from "@mrstreamer/core/ondemand/filters";
import type { OnDemandCatalogue, ProviderDetails, ProviderFile } from "@mrstreamer/core/provider";
import { finish, pacer, type Steps } from "@mrstreamer/core/steps";
import { File, Paths } from "expo-file-system";
import { useEffect, useSyncExternalStore } from "react";
import {
  accountChanges,
  members,
  onReadingSaved,
  onRoster,
  onSavable,
  readingSaved,
  savable,
  shownOf,
  type Member,
} from "./account.ts";
import {
  readAbout,
  readFiles,
  readSeason,
  readTitle,
  writeAbout,
  writeFiles,
  writeSeason,
  writeTitle,
  type Saved,
  type SavedFile,
} from "./details-cache.ts";
import { inTasks } from "./library.ts";
import type { ObservedFileTracks } from "./media-policy.ts";
import { effectiveTitleLanguage, onMediaPreferences } from "./media-preferences.ts";
import { currentSource, sourceOf, type Source } from "./sources.ts";
import { store, useStore } from "./store.ts";
import { titlePolicy } from "./content-policy.ts";
import { serveViewing } from "./viewing.ts";
import { alignWatchlist, serveWatchlist } from "./watchlist.ts";

// The movie and series catalogue of every saved subscription together, as the desktop builds it:
// each provider's lists, which account.ts loads, indexed by core as one (names, versions gathered
// by TMDB id across subscriptions and never by name, the version that suits the viewer's language
// first), the collections Movies and Series show, search, and details with seasons and episodes,
// each read from the subscription that lists the version. TMDB's metadata comes from core's
// store, with the key built into the app (EXPO_PUBLIC_TMDB_KEY); without one, collections that
// need it are empty and details show the provider's facts. account.ts gives a subscription's
// lists saved on the phone at launch as it gives its provider's (catalogue-cache.ts).
//
// Details opened are saved on the phone too (details-cache.ts) and show again after a restart:
// a provider's facts of a title without asking while they are fresher than a day and the lists
// they came with still show, else while it is asked, staying when it doesn't answer; TMDB's about
// of a title and of a season likewise for 150 days, a day when TMDB didn't know it. A TMDB failure
// is asked again at the next open, and a slow TMDB never holds the provider's facts back. Nothing
// of a login replaced or removed since shows (`underLogin`). Saved facts are for display only:
// where a title streams from is asked of its provider under its current login.
//
// Collections are made here, in short tasks, never while a screen draws. What screens read of the
// lists is one view (`shown`): the index with each kind's collections made of it, so no read and
// no listener sees one without the other. Lists that come again, as when a subscription's lists
// load again after a launch, are indexed and their collections made while the view before them
// shows, which they then replace in one change. TMDB's metadata changing what collections show has
// a kind's made again for the lists that show, those before showing meanwhile. A subscription
// that no longer lists any titles, as once it is removed, takes the view with it at once: what
// the others list shows again once it is indexed without it.
//
// It alone keeps what playback found in a file: the languages of its tracks (`titleFile`'s
// `observed`), saved per subscription beside the details (details-cache.ts). Browse's filters
// read them (`filterFilesOf`) only while the file is still the row the lists show: a movie's
// listed name and file type, an episode's in this run's answer for its series, asked under the
// lists that show now, and only while its login may keep them (`savable`): from the moment a new
// password starts deleting them, until a deletion that fails gives them back. Anything else is
// unknown, never absent.

export type TitleLists =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly index: IndexedCatalogue }
  | { readonly kind: "failed"; readonly error: AppError };
type Unlisted = Exclude<TitleLists, { readonly kind: "ready" }>;

/** One subscription's lists, as `indexSteps` takes them. */
interface Listed {
  readonly subscriptionId: string;
  readonly catalogue: OnDemandCatalogue;
}

/** A kind's collections, and the lists and metadata version they were made of. */
interface Made {
  readonly index: IndexedCatalogue;
  readonly version: number;
  readonly collections: Collections;
  readonly epoch: number;
}

/**
 * What screens read of the lists, changed as one: lists that show come with both kinds'
 * collections made of their index, and the subscriptions' lists the index was made of.
 */
type Shown =
  | { readonly lists: Unlisted; readonly made: null }
  | {
      readonly lists: Extract<TitleLists, { readonly kind: "ready" }>;
      readonly made: { readonly movie: Made; readonly series: Made };
      readonly listed: readonly Listed[];
    };

const shown = store<Shown>({ lists: { kind: "idle" }, made: null });
/** Rises whenever TMDB's metadata changes what lists show. */
const metadataVersion = store(0);
const metadataStatus = store<MetadataStatus | null>(null);
/**
 * How long the last read of the lists took: fetched and read, then indexed, from start to finish
 * of the tasks that did it. Milliseconds; lists saved on the phone count as none fetched.
 */
const timings = store<{ readonly fetched: number; readonly indexed: number } | null>(null);

/** The lists as they stand, for owners outside React. */
export const titleLists = (): TitleLists => shown.get().lists;
export const useTitleLists = () => useSyncExternalStore(shown.subscribe, titleLists);
/** Calls `listener` whenever the lists change, their collections already made of them. */
export function onTitleLists(listener: () => void): () => void {
  let last = titleLists();
  return shown.subscribe(() => {
    if (titleLists() === last) return;
    last = titleLists();
    listener();
  });
}

/**
 * The index of the lists that show, for a request about subscription `id`'s titles that doesn't
 * draw, such as a title's file, a download's details or the viewing record's series: at once
 * while the lists that show hold `id`'s, or `id` has none to give them. While `id`'s lists are
 * still to join them, as while a launch reads its saved lists or they are indexed with the
 * others', or after another subscription's removal, once they do. Rejects at once with
 * `signal`'s reason once it aborts. While no lists show, it rejects too when `id` can't have its
 * titles listed: no longer saved, not signed in, or with no lists, its failure when they failed;
 * once some show, such a lookup answers with those, which don't hold `id`'s titles.
 */
export function listedIndex(id: string, signal: AbortSignal): Promise<IndexedCatalogue> {
  return new Promise((resolve, reject) => {
    const done = (answer: () => void) => {
      for (const stop of stops.splice(0)) stop();
      signal.removeEventListener("abort", settle);
      answer();
    };
    const settle = () => {
      if (signal.aborted) return done(() => reject(signal.reason));
      const now = shown.get();
      const member = members().find((each) => each.entry.id === id);
      const coming =
        member !== undefined &&
        currentSource(id) !== undefined &&
        (shownOf(member.titles) !== null || readingSaved("titles", id));
      if (now.made && (!coming || now.listed.some((each) => each.subscriptionId === id))) {
        const { index } = now.lists;
        return done(() => resolve(index));
      }
      if (!member) return done(() => reject(new AppFailure({ kind: "no-subscription" })));
      if (!currentSource(id)) {
        return done(() => reject(new AppFailure({ kind: "needs-secret", subscriptionId: id })));
      }
      if (coming) return;
      const error: AppError =
        member.titles.kind === "failed" ? member.titles.error : { kind: "no-subscription" };
      done(() => reject(new AppFailure(error)));
    };
    const stops = [shown.subscribe(settle), onRoster(settle), onReadingSaved(settle)];
    signal.addEventListener("abort", settle);
    settle();
  });
}

export const useMetadataVersion = () => useStore(metadataVersion);
export const useMetadataStatus = () => useStore(metadataStatus);
export const useTitleTimings = () => useStore(timings);

const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
/** The viewer's language, which version of a title shows first and which names TMDB gives. */
export let language: string = effectiveTitleLanguage();
/** A-B-A is three distinct runs, even when the language string agrees again. */
let languageEpoch = 0;
interface ReadingLanguage {
  readonly language: string;
  readonly epoch: number;
}
const readingLanguage = (): ReadingLanguage => ({ language, epoch: languageEpoch });
const currentLanguage = (reading: ReadingLanguage) => reading.epoch === languageEpoch;
/** Internal handback to detailsOf's latest-language loop, including underLogin retries. */
const retiredLanguage = Symbol("retired title language");
const region = locale.region ?? "US";

const TMDB_KEY = process.env.EXPO_PUBLIC_TMDB_KEY ?? "";
/** A test server that answers like TMDB, for the fixture panel. */
const TMDB_API = process.env.EXPO_PUBLIC_TMDB_API;
const client: Tmdb | null = TMDB_KEY
  ? tmdb({ key: TMDB_KEY, ...(TMDB_API ? { api: TMDB_API } : {}) })
  : null;
/** Whether TMDB answers this build at all: its key, and the attribution Settings shows. */
export const hasTmdb = client !== null;

const metadataFile = () => new File(Paths.cache, "tmdb.json");
const metadata = metadataStore({
  read: async () => {
    const file = metadataFile();
    return file.exists ? (JSON.parse(await file.text()) as unknown) : null;
  },
  write: async (contents) => {
    const file = metadataFile();
    if (!file.exists) file.create();
    await file.write(JSON.stringify(contents));
  },
  client,
  region,
  onChange: ({ content }) => {
    if (content) {
      metadataVersion.set((version) => version + 1);
      collect("movie");
      collect("series");
    }
    metadataStatus.set(metadata.status());
  },
});

/** The lists the index was made of, or is being made of. */
let indexed: readonly Listed[] = [];
let indexedEpoch = -1;
let indexing: AbortController | null = null;
/**
 * Whether saved titles a launch reads wait for each other to be indexed together (`relist`): until
 * the app opens (startup.ts), however long a read takes; from then on lists are indexed as they
 * show, one read later joining those indexed before it.
 */
let batching = true;

/** Ends the launch's batch: the lists that show are indexed now, without reads still under way. */
export function endLaunchBatch() {
  if (!batching) return;
  batching = false;
  relist();
}

const sameLists = (a: readonly Listed[], b: readonly Listed[]) =>
  a.length === b.length &&
  a.every(
    (each, at) =>
      each.subscriptionId === b[at]?.subscriptionId && each.catalogue === b[at]?.catalogue,
  );

/**
 * What the lists are while no subscription has any: loading while one may still bring some, else
 * why the first that can't failed, a password the Keychain lost included.
 */
function standing(all: readonly Member[]): Unlisted {
  if (all.length === 0) return { kind: "idle" };
  const waiting = all.some(
    (member) =>
      member.titles.kind === "loading" || (member.titles.kind === "idle" && !member.needsSecret),
  );
  const stuck = all.find((member) => member.titles.kind === "failed" || member.needsSecret);
  if (waiting || !stuck) return { kind: "loading" };
  return {
    kind: "failed",
    error:
      stuck.titles.kind === "failed"
        ? stuck.titles.error
        : { kind: "needs-secret", subscriptionId: stuck.entry.id },
  };
}

/** Each subscription's lists that show, in the roster's order. */
const listedOf = (all: readonly Member[]): Listed[] =>
  all.flatMap((member) => {
    const catalogue = shownOf(member.titles);
    return catalogue ? [{ subscriptionId: member.entry.id, catalogue }] : [];
  });

/**
 * Whether the lists that show, with their collections, were indexed of every subscription's lists
 * that show: none still to come.
 */
export function titlesWorkedOut(): boolean {
  const listed = listedOf(members());
  const now = shown.get();
  return (
    listed.length === 0 ||
    (now.made !== null && now.made.movie.epoch === languageEpoch && sameLists(now.listed, listed))
  );
}

/**
 * Indexes the lists of every subscription that has them, whenever one's change: those that
 * failed or load again keep what they had. Until one has lists, the state says whether any is
 * still loading or why they failed, after every change of the subscriptions. A subscription the
 * lists that show were made of and that lists none now takes them with it at once. While a launch
 * still establishes saved titles, including pending launch passwords (`readingSaved`), until
 * the app opens (`batching`), nothing is indexed, so they are indexed once.
 */
function relist() {
  const all = members();
  const listed = listedOf(all);
  // Retain recognised saved references as soon as raw lists arrive, even if indexing is replaced.
  alignWatchlist(null, listed);
  const now = shown.get();
  const gone =
    now.made !== null &&
    now.listed.some((each) => !listed.some((that) => that.subscriptionId === each.subscriptionId));
  if (listed.length === 0) {
    if (indexed.length > 0) {
      indexed = [];
      indexing?.abort();
      indexing = null;
      metadata.want([]);
    }
    const next = standing(all);
    const same =
      now.lists.kind === next.kind &&
      (now.lists.kind !== "failed" || (next.kind === "failed" && now.lists.error === next.error));
    if (!same) shown.set({ lists: next, made: null });
    return;
  }
  const restricted =
    now.made !== null &&
    listed.some((next) => {
      const before = now.listed.find((each) => each.subscriptionId === next.subscriptionId);
      if (!before || before.catalogue === next.catalogue) return false;
      return (["movie", "series"] as const).some((kind) =>
        [...titlePolicy(next.catalogue)[kind]].some(
          (id) =>
            titlePolicy(before.catalogue).known[kind].has(id) &&
            !titlePolicy(before.catalogue)[kind].has(id),
        ),
      );
    });
  if (gone || restricted) shown.set({ lists: { kind: "loading" }, made: null });
  else if (indexedEpoch === languageEpoch && sameLists(listed, indexed)) return;
  // Pending launch passwords reserve their possible title reads too. Those already read wait
  // for them until the app opens, including its deadline; late answers join normally after that.
  if (batching && readingSaved("titles")) {
    indexed = [];
    indexing?.abort();
    indexing = null;
    return;
  }
  indexed = listed;
  indexedEpoch = languageEpoch;
  indexing?.abort();
  const controller = new AbortController();
  indexing = controller;
  void index(listed, controller.signal, readingLanguage());
}

async function index(listed: readonly Listed[], signal: AbortSignal, reading: ReadingLanguage) {
  // Indexing 25,000 movies held the JS thread for a third of a second or more in a Release build
  // on the iOS simulator, so both kinds are worked out a few slices per task, starting after the
  // answer that brought the lists, and only a finished index shows, with its collections: what
  // showed before stays meanwhile, and screens never index a kind while they draw.
  const wanted = () => !signal.aborted && currentLanguage(reading);
  const started = Date.now();
  const permitted = listed.map((each) => ({
    ...each,
    catalogue: titlePolicy(each.catalogue).catalogue,
  }));
  const index = await inTasks(indexSteps(permitted, reading.language), wanted);
  if (!index) return;
  const took = Date.now() - started;
  const version = metadataVersion.get();
  const movie = await make("movie", index, version, wanted, reading);
  const series = movie && (await make("series", index, version, wanted, reading));
  if (!movie || !series || !wanted()) return;
  const fetched = Math.max(
    0,
    ...members().map((member) => (member.titles.kind === "ready" ? (member.titles.took ?? 0) : 0)),
  );
  timings.set({ fetched, indexed: took });
  shown.set({ lists: { kind: "ready", index }, made: { movie, series }, listed });
  // Again if TMDB's metadata changed what they show while they were made.
  collect("movie");
  collect("series");
  alignWatchlist(index, listed);
  // TMDB's metadata for what is listed, the newest first, once the lists show.
  setTimeout(() => {
    if (wanted()) metadata.want(wantedOf(index), reading.language);
  }, 0);
}

const tmdbKind = (kind: TitleKind): TmdbKind => (kind === "movie" ? "movie" : "tv");

function wantedOf(index: IndexedCatalogue) {
  return (["movie", "series"] as const).flatMap((kind) =>
    kindOf(index, kind).titles.flatMap((title) =>
      title.tmdbId && !title.adult
        ? [{ kind: tmdbKind(kind), tmdbId: title.tmdbId, addedAt: title.addedAt ?? 0 }]
        : [],
    ),
  );
}

/** Each kind whose collections are being made again for the lists that show, for which lists. */
const making = new Map<TitleKind, IndexedCatalogue>();

/**
 * The collections of `kind` for the lists that show, as TMDB's metadata stood when they were made:
 * null while no lists show. `reads` are what the screen reads them by besides (`useHolding`).
 */
export function useCollections(
  kind: TitleKind,
  reads: readonly unknown[] = [],
): Collections | null {
  const kept = useSyncExternalStore(shown.subscribe, () => shown.get().made?.[kind] ?? null);
  useHolding(kind, [kept, ...reads]);
  return kept?.collections ?? null;
}

/**
 * A tile may open only while its rendered collections, source login and provider lists still
 * stand. A refresh awaiting indexing cancels the old tap, even before React renders again.
 */
export function collectionSelection(kind: TitleKind, collections: Collections) {
  const snapshot = shown.get();
  const sources = new Map(
    snapshot.made
      ? snapshot.listed.map(({ subscriptionId }) => [subscriptionId, currentSource(subscriptionId)])
      : [],
  );
  return (title: Title): boolean => {
    const source = sources.get(title.subscriptionId);
    const now = shown.get();
    const listed = snapshot.made
      ? kindOf(snapshot.lists.index, kind).byId.get(ownedKey(title))
      : null;
    return (
      now.made?.[kind].collections === collections &&
      snapshot.made !== null &&
      sameLists(snapshot.listed, listedOf(members())) &&
      source !== undefined &&
      currentSource(title.subscriptionId) === source &&
      listed?.key === title.key
    );
  };
}

/** Whether the published collections have usable titles, without requesting new collections. */
export function useHasTitles(...kinds: readonly TitleKind[]): boolean {
  return useSyncExternalStore(shown.subscribe, () =>
    kinds.some((kind) => (shown.get().made?.[kind].collections.size("all") ?? 0) > 0),
  );
}

/**
 * Has `kind`'s collections made again if time has moved past what they hold (`collect`), as the
 * screen opens and whenever one of `reads` changes: what it reads them by, such as the title For
 * you is led by or the collection it shows. The last made show meanwhile. `reads` keeps its
 * length at each call.
 */
export function useHolding(kind: TitleKind, reads: readonly unknown[]): void {
  useEffect(() => collect(kind), [kind, ...reads]);
}

/** `useCollections` for owners outside React. */
export function collectionsOf(kind: TitleKind): Collections | null {
  collect(kind);
  return shown.get().made?.[kind].collections ?? null;
}

/**
 * Makes `kind`'s collections again for the lists that show, unless those that show are of the
 * metadata as it stands and still hold now: no title has passed New's 7 or 30 days, no metadata
 * they were made with has expired, the year hasn't turned and the clock hasn't gone back
 * (`validAt`). While some are being made for these lists nothing else starts, so however often
 * TMDB's metadata changes they are made; once they are, this runs again and makes the latest, or
 * again if time passed what they hold while they were made. They show only while their lists do.
 */
function collect(kind: TitleKind) {
  const now = shown.get();
  if (!now.made || now.made[kind].epoch !== languageEpoch) return;
  const { index } = now.lists;
  const kept = now.made[kind];
  const current = kept.version === metadataVersion.get() && kept.collections.validAt(Date.now());
  if (current || making.get(kind) === index) return;
  making.set(kind, index);
  void remake(kind, index);
}

/** Makes `kind`'s collections of `index` again, to show in place of those before while it shows. */
async function remake(kind: TitleKind, index: IndexedCatalogue) {
  const reading = readingLanguage();
  const shows = () => {
    const now = shown.get();
    return currentLanguage(reading) && now.made !== null && now.lists.index === index;
  };
  const made = await make(kind, index, metadataVersion.get(), shows, reading).finally(() => {
    if (making.get(kind) === index) making.delete(kind);
  });
  const now = shown.get();
  if (!made || !now.made || !shows()) return;
  const both = kind === "movie" ? { ...now.made, movie: made } : { ...now.made, series: made };
  shown.set({ ...now, made: both });
  collect(kind);
}

/**
 * `kind`'s collections of `index`, with TMDB's metadata as it stands, `version`: null once
 * `wanted` fails, which stops them at the next task.
 */
async function make(
  kind: TitleKind,
  index: IndexedCatalogue,
  version: number,
  wanted: () => boolean,
  reading: ReadingLanguage,
): Promise<Made | null> {
  // Ranking 25,000 movies and their series with TMDB's metadata, then sorting their lists, held
  // the JS thread for 60 to 95 ms at once in a Release build on the iOS simulator, each time the
  // metadata changed while Movies drew. So collections are made a few slices per task.
  const tk = tmdbKind(kind);
  const collections = await inTasks(
    madeSteps({
      kind,
      titles: kindOf(index, kind).titles,
      language: reading.language,
      metadata: (id) => metadata.get(tk, id),
      names: (id) => metadata.name(tk, id, reading.language),
      services: metadata.services(tk),
      expiresAt: (id) => metadata.expiresAt(tk, id),
      now: Date.now(),
    }),
    wanted,
  );
  return collections && { index, version, collections, epoch: reading.epoch };
}

/**
 * Collections with the lists Movies, Series and Home open on already sorted, a step each: All, 4K
 * and the rows of For you and New. Those of a genre, a service or titles like one are sorted when
 * first asked.
 */
function* madeSteps(source: CollectionSource): Steps<Collections> {
  const collections = yield* collectionSteps(source);
  yield;
  const opened = [
    "all" as const,
    "4k" as const,
    ...rowIds(collections, "for-you", null),
    ...rowIds(collections, "new", null),
  ];
  for (const id of opened) {
    yield;
    collections.list(id);
  }
  yield;
  collections.genres();
  return collections;
}

/** Genres or streaming services as tiles, most stocked first. */
export function tilesOf(made: Collections, of: "genres" | "services"): readonly CollectionTile[] {
  return of === "genres"
    ? made.genres().map((genre) => ({
        id: `genre:${genre.name}` as const,
        name: genre.name,
        count: genre.count,
        artworkUrl: genre.artwork,
      }))
    : made.services().map((service) => ({
        id: `service:${service.id}` as const,
        name: service.name,
        count: service.count,
        artworkUrl: service.artwork,
      }));
}

/** How many titles of `kind` the lists hold: what search looks through. */
export const titleCount = (index: IndexedCatalogue, kind: TitleKind) =>
  kindOf(index, kind).titles.length;

/**
 * Titles of `kind` whose names hold every word of `query`, by any name TMDB gave them too: the
 * best `limit` of them, best first, and how many match in all. A larger `limit` over the same
 * index and metadata gives the same titles first, then the next best.
 */
export function searchTitles(
  index: IndexedCatalogue,
  kind: TitleKind,
  query: string,
  limit: number,
) {
  return finish(searchTitlesSteps(index, kind, query, limit));
}

/** The same names and ranking as `searchTitles`, in slices that Search can cancel. */
export function* searchTitlesSteps(
  index: IndexedCatalogue,
  kind: TitleKind,
  query: string,
  limit: number,
): Steps<{ readonly titles: Title[]; readonly total: number }> {
  const viewerLanguage = language;
  const tk = tmdbKind(kind);
  const page = yield* searchPageSteps(
    index,
    kind,
    query,
    (title) => {
      if (!title.tmdbId) return "";
      const shown = metadata.name(tk, title.tmdbId, viewerLanguage);
      return {
        ...(shown ? { title: shown.name, original: shown.original } : {}),
        names: metadata.searchAliases(tk, title.tmdbId),
      };
    },
    limit,
  );
  const titles: Title[] = [];
  const due = pacer();
  for (const title of page.titles) {
    if (due()) yield;
    titles.push(namedIn(title, viewerLanguage));
  }
  return { ...page, titles };
}

/** A title with TMDB's name for the viewer, once known, as collections show it. */
export function named(title: Title): Title {
  return namedIn(title, language);
}

function namedIn(title: Title, viewerLanguage: string): Title {
  if (!title.tmdbId) return title;
  const found = metadata.name(tmdbKind(title.kind), title.tmdbId, viewerLanguage);
  return found ? { ...title, title: found.name, originalTitle: found.original } : title;
}

/** The title a version belongs to, as the lists have it now, with TMDB's name once known. */
export function titleOf(
  index: IndexedCatalogue,
  kind: TitleKind,
  version: OwnedId,
): Title | undefined {
  const [found] = byIds(index, kind, [version]);
  return found && named(found);
}

/** How many answers of each sort below are kept in memory; the least recently used go first. */
const KEPT = 64;
const DAY = 24 * 60 * 60 * 1000;
/** A provider's saved facts younger than this show without asking again, while its lists stand. */
const PROVIDER_FRESH = DAY;
/** Retry a missing TMDB answer after a day; positive answers use the shared refresh policy. */
const MISSING_FRESH = DAY;

/** Keeps `value` as `key`'s, the most recently used, dropping the least recently used past KEPT. */
function keep<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key);
  map.set(key, value);
  for (const oldest of map.keys()) {
    if (map.size <= KEPT) return;
    map.delete(oldest);
  }
}

/** `key`'s value, now the most recently used. */
function used<V>(map: Map<string, V>, key: string): V | undefined {
  const found = map.get(key);
  if (found !== undefined) keep(map, key, found);
  return found;
}

interface Asked {
  readonly subscriptionId: string;
  readonly source: Source;
  readonly kind: TitleKind;
  /** The version asked about. */
  readonly id: string;
  readonly read: Promise<ProviderDetails>;
  /**
   * The subscription's lists that showed when it was asked: an answer counts for file facts only
   * while those are the lists that show. Never changed when the answer is used again.
   */
  readonly listing: OnDemandCatalogue | null;
  /** The answer, once it came. */
  value?: ProviderDetails;
}

/**
 * The provider's facts this run asked for, or is asking for, by login, kind and version. Only
 * these say where a title streams from: never a saved record. Those of a login replaced or removed
 * since go as the roster changes.
 */
const asked = new Map<string, Asked>();

/** When `id`'s movie and series lists came, while they show as loaded; null otherwise. */
function listedAt(id: string): number | null {
  const titles = members().find((member) => member.entry.id === id)?.titles;
  return titles?.kind === "ready" ? titles.fetchedAt : null;
}

const askedKey = (title: Title, source: Source) =>
  `${source.revision}|${title.kind}|${ownedKey(title)}`;

/**
 * The provider's facts of the version `title` names under `source`, asked once per sign-in: a
 * failed read is asked again next time. Saves the answer while its login may (`savable`).
 */
function askUnder(title: Title, source: Source): Promise<ProviderDetails> {
  const id = title.subscriptionId;
  const key = askedKey(title, source);
  const found = used(asked, key);
  if (found) return found.read;
  const listed = listedAt(id);
  const signal = AbortSignal.timeout(20_000);
  const read =
    title.kind === "movie"
      ? source.provider.movieDetails(title.id, signal)
      : source.provider.seriesDetails(title.id, signal);
  const listing = listedOf(members()).find((each) => each.subscriptionId === id)?.catalogue;
  const asking: Asked = {
    subscriptionId: id,
    source,
    kind: title.kind,
    id: title.id,
    read,
    listing: listing ?? null,
  };
  keep(asked, key, asking);
  factsChanged();
  read.then(
    (value) => {
      asking.value = value;
      if (asked.get(key) === asking) factsChanged();
      const saved = { at: Date.now(), listedAt: listed, value };
      void writeTitle(id, title.kind, title.id, saved, source.login, () => savable(id, source));
    },
    () => {
      if (asked.get(key) !== asking) return;
      asked.delete(key);
      factsChanged();
    },
  );
  return read;
}

/**
 * What `read` answers under `id`'s login, settled only while that login stands (`savable`).
 * Once it no longer does, `read` runs again under the login after it: the new password's, or the
 * same one when a change that would have replaced it failed; changes under way are waited for
 * first. Rejects once the subscription is removed, or when its login still doesn't stand after
 * every change, so nothing is read again under a login that can't answer.
 */
async function underLogin<A>(id: string, read: (source: Source) => Promise<A>): Promise<A> {
  let source = sourceOf(id);
  for (;;) {
    if (savable(id, source)) {
      try {
        const answer = await read(source);
        if (savable(id, source)) return answer;
      } catch (cause) {
        if (savable(id, source)) throw cause;
      }
    }
    if (currentSource(id) === source) await accountChanges();
    const next = sourceOf(id);
    if (next === source && !savable(id, source)) throw new AppFailure({ kind: "no-subscription" });
    source = next;
  }
}

/**
 * A title's details under `source`: the provider's facts of the version `title` names, with
 * TMDB's overview, cast and artwork when the build has a key and TMDB knows the title. Saved facts
 * show at once through `show`, while `source` stands: this run's answer, or the saved one while it
 * is fresher than a day and its lists haven't come again since; else the provider is asked, the
 * saved facts showing meanwhile and staying when it fails. TMDB's answer is waited for only by
 * the result, with what it said before showing until then.
 */
async function detailsUnder(
  title: Title,
  source: Source,
  show: ((details: TitleDetails) => void) | undefined,
  reading: ReadingLanguage,
): Promise<TitleDetails> {
  if (!currentLanguage(reading)) throw retiredLanguage;
  const id = title.subscriptionId;
  const stands = () => savable(id, source);
  const saved = await readTitle(id, title.kind, title.id, stands);
  // Provider records belong to the source, not the presentation language. A retired
  // attempt must return before it can launch work or rejoin the current metadata map.
  if (!currentLanguage(reading) || !stands()) throw retiredLanguage;
  const about = aboutOf(title, reading);
  const shown = (raw: ProviderDetails, known: TitleAbout | null) =>
    title.kind === "movie"
      ? movieDetails(title, raw, known)
      : seriesDetails(title, raw, known, reading.language);
  const early = async (raw: ProviderDetails) => {
    const known = about ? await about.now : null;
    if (show && stands() && currentLanguage(reading)) show(shown(raw, known));
  };
  const fresh = saved && Date.now() - saved.at < PROVIDER_FRESH && saved.listedAt === listedAt(id);
  const refresh =
    used(asked, askedKey(title, source))?.read ?? (fresh ? null : askUnder(title, source));
  if (saved) await early(saved.value);
  let raw = saved?.value;
  if (refresh) {
    try {
      raw = await refresh;
      await early(raw);
    } catch (cause) {
      if (!raw) throw cause;
    }
  }
  if (!raw) throw new AppFailure({ kind: "title-not-found", titleId: title.id });
  return shown(raw, about ? await about.final : null);
}

/**
 * A title's details, as `detailsUnder` reads them under its subscription's current login, read
 * again under a new password (`underLogin`). `show`, when given, has the facts already known
 * before the result: saved ones while the provider and TMDB are asked. Nothing of a login replaced
 * or removed since is shown or answered.
 */
export async function detailsOf(
  title: Title,
  show?: (details: TitleDetails) => void,
): Promise<TitleDetails> {
  if (title.adult) throw new AppFailure({ kind: "title-not-found", titleId: title.id });
  const check = () => admitTitle({ kind: title.kind, ...ownedId(title) });
  check();
  // A replaced language never answers through the old callback. A caller still waiting is
  // read again in the latest language, while login replacement keeps its existing authority.
  for (;;) {
    const reading = readingLanguage();
    try {
      const value = await underLogin(title.subscriptionId, (source) =>
        detailsUnder(
          title,
          source,
          show &&
            ((details) => {
              check();
              show(details);
            }),
          reading,
        ),
      );
      check();
      if (currentLanguage(reading)) return value;
    } catch (cause) {
      if (currentLanguage(reading)) throw cause;
    }
  }
}

/**
 * A TMDB answer: what is known without waiting for TMDB, `now`, and the answer to show in the
 * end, `final`. `now` is the saved one, of any age, until `final` settles; then `final`'s.
 */
interface Answer<A> {
  now: Promise<A | null>;
  readonly final: Promise<A | null>;
}

/**
 * `final` for a saved TMDB answer `kept`: itself while it is fresh, else TMDB's, which is saved,
 * as "missing" too. When TMDB doesn't answer, `kept`'s, or none: not `final`, so it is asked
 * again next time.
 */
async function fromTmdb<A>(
  kept: Saved<A | null> | null,
  answer: (signal: AbortSignal) => Promise<A>,
  write: (saved: Saved<A | null>) => Promise<void>,
): Promise<{ readonly value: A | null; readonly final: boolean }> {
  if (kept && Date.now() - kept.at < (kept.value === null ? MISSING_FRESH : TMDB_REFRESH_MS)) {
    return { value: kept.value, final: true };
  }
  try {
    const value = await answer(AbortSignal.timeout(20_000));
    void write({ at: Date.now(), value });
    return { value, final: true };
  } catch (cause) {
    if (!(cause instanceof TmdbError && cause.failure.kind === "missing")) {
      return { value: kept?.value ?? null, final: false };
    }
    void write({ at: Date.now(), value: null });
    return { value: null, final: true };
  }
}

/** `key`'s TMDB answer, asked once until it is final (`fromTmdb`). */
function tmdbAnswer<A>(
  map: Map<string, Answer<A>>,
  key: string,
  saved: () => Promise<Saved<A | null> | null>,
  answer: (signal: AbortSignal) => Promise<A>,
  write: (saved: Saved<A | null>) => Promise<void>,
): Answer<A> {
  const found = used(map, key);
  if (found) return found;
  const kept = saved();
  const entry: Answer<A> = {
    now: kept.then((record) => record?.value ?? null),
    final: kept
      .then((record) => fromTmdb(record, answer, write))
      .then(({ value, final }) => {
        if (final) entry.now = Promise.resolve(value);
        else if (map.get(key) === entry) map.delete(key);
        return value;
      }),
  };
  keep(map, key, entry);
  return entry;
}

/** What TMDB says of a title for the viewer, by kind, TMDB id and language. */
const abouts = new Map<string, Answer<TitleAbout>>();

function aboutOf(title: Title, reading: ReadingLanguage): Answer<TitleAbout> | null {
  const { language } = reading;
  const { kind, tmdbId } = title;
  if (!client || !tmdbId || title.adult) return null;
  return tmdbAnswer(
    abouts,
    `${kind}|${tmdbId}|${language}`,
    () => readAbout(kind, tmdbId, language),
    (signal) => {
      if (!currentLanguage(reading)) throw retiredLanguage;
      return client.about(tmdbKind(kind), tmdbId, language, signal);
    },
    (saved) =>
      currentLanguage(reading) ? writeAbout(kind, tmdbId, language, saved) : Promise.resolve(),
  );
}

/**
 * What TMDB says of a season's episodes, by TMDB id, season and language. It is the same whichever
 * provider lists the series; the provider's episodes are those of the details read.
 */
const seasons = new Map<string, Answer<readonly EpisodeAbout[]>>();

/**
 * A season's episodes as its details list them, with TMDB's worked in where it answers. `show`,
 * when given, has them with what TMDB said before, while TMDB is asked. Rejects, showing nothing,
 * once the login the details were read under no longer stands: details of the login after it
 * bring their own season.
 */
export async function episodesOf(
  title: Title,
  season: Season,
  show?: (episodes: readonly EpisodeDetails[]) => void,
): Promise<readonly EpisodeDetails[]> {
  if (title.adult) throw new AppFailure({ kind: "title-not-found", titleId: title.id });
  const check = () => admitTitle({ kind: "series", ...ownedId(title) });
  check();
  const reading = readingLanguage();
  const { language } = reading;
  const { tmdbId } = title;
  if (!client || !tmdbId) return seasonEpisodes(season, []);
  const id = title.subscriptionId;
  const source = currentSource(id);
  const stands = () => source !== undefined && savable(id, source);
  const { number } = season;
  const answers = (language === "en" ? [language] : [language, "en"]).map((asked) =>
    tmdbAnswer(
      seasons,
      `${tmdbId}|${number}|${asked}`,
      () => readSeason(tmdbId, number, asked),
      (signal) => {
        if (!currentLanguage(reading)) throw retiredLanguage;
        return client.season(tmdbId, number, asked, signal);
      },
      (saved) =>
        currentLanguage(reading) ? writeSeason(tmdbId, number, asked, saved) : Promise.resolve(),
    ),
  );
  const worked = (told: readonly (readonly EpisodeAbout[] | null)[]) =>
    seasonEpisodes(
      season,
      told.map((each) => each ?? []),
    );
  if (show) {
    const now = await Promise.all(answers.map((answer) => answer.now));
    check();
    if (stands() && currentLanguage(reading)) show(worked(now));
  }
  const told = await Promise.all(answers.map((answer) => answer.final));
  check();
  if (!stands()) throw new AppFailure({ kind: "no-subscription" });
  if (!currentLanguage(reading)) return episodesOf(title, season, show);
  return worked(told);
}

/** The listed row a file was looked up by: what its facts are checked against. No address. */
type FileRow = Pick<SavedFile, "kind" | "id" | "seriesId" | "name" | "container">;

/**
 * A movie's or an episode's file: where it streams from and, when the row it was looked up by
 * can be checked again later, where playback tells the languages of the tracks it could play in
 * it (`observed`). That is for a provider file AVPlayer opens as it is, never a format session,
 * a downloaded copy or a channel; telling unknown tracks is telling nothing.
 */
export type TitleFile = ProviderFile & {
  readonly admit?: () => void;
  readonly observed?: (tracks: ObservedFileTracks) => void;
};

/** Recognised entries in the latest raw lists, even before their index is ready. */
export function excludedTitle(
  ref: TitleRef | ({ readonly kind: "series" } & OwnedId),
): boolean | null {
  const kind = ref.kind === "episode" ? "series" : ref.kind;
  const id = ref.kind === "episode" ? ref.seriesId : ref.id;
  const member = members().find((each) => each.entry.id === ref.subscriptionId);
  const catalogue = member && shownOf(member.titles);
  if (!catalogue) return null;
  const policy = titlePolicy(catalogue);
  return policy.known[kind].has(id) ? policy[kind].has(id) : null;
}

/** Action admission never trusts a restored reference or an older rendered index. */
export function admitTitle(ref: TitleRef | ({ readonly kind: "series" } & OwnedId)): void {
  if (excludedTitle(ref)) {
    throw new AppFailure({ kind: "title-not-found", titleId: ref.id });
  }
}

/**
 * Where a movie or an episode streams from, by the file type its provider lists: a movie's in the
 * lists or this run's answer for its details, an episode's in this run's answer for its series'.
 * Asks the subscription that lists it, under its current login, which the address carries; never
 * a saved record. While the lists are made again with its subscription's in them, it waits for
 * them (`listedIndex`). A movie listed with its name and file type, and an episode, come with
 * `observed`, kept under the login that looked them up.
 */
export async function titleFile(ref: TitleRef, signal: AbortSignal): Promise<TitleFile> {
  admitTitle(ref);
  const index = await listedIndex(ref.subscriptionId, signal);
  admitTitle(ref);
  // The login that stands now, whichever was signed in while the lists were made again.
  const reading = sourceOf(ref.subscriptionId);
  const missing = new AppFailure({ kind: "title-not-found", titleId: ref.id });
  const answered = (title: Title) =>
    underLogin(ref.subscriptionId, async (source) => ({
      raw: await askUnder(title, source),
      source,
    }));
  if (ref.kind === "movie") {
    const title = titleOf(index, "movie", ref);
    if (!title) throw missing;
    const version = title.versions.find((each) => sameOwned(each, ref));
    if (version?.container) {
      const container = version.container;
      const name = version.name;
      const file = await reading.provider.titleFile("movie", ref.id, container, signal);
      admitTitle(ref);
      if (name === undefined) return { ...file, admit: () => admitTitle(ref) };
      const row: FileRow = { kind: "movie", id: ref.id, name, container };
      return {
        ...file,
        admit: () => admitTitle(ref),
        observed: observing(ref.subscriptionId, reading, row),
      };
    }
    const { raw, source } = await answered({ ...title, ...ownedId(ref) });
    admitTitle(ref);
    const file = await source.provider.titleFile("movie", ref.id, raw.container ?? "mp4", signal);
    admitTitle(ref);
    return { ...file, admit: () => admitTitle(ref) };
  }
  const series = { subscriptionId: ref.subscriptionId, id: ref.seriesId };
  const title = titleOf(index, "series", series);
  if (!title) throw missing;
  const { raw, source } = await answered({ ...title, ...series });
  admitTitle(ref);
  const episode = raw.episodes.find((each) => each.id === ref.id);
  if (!episode) throw missing;
  const file = await source.provider.titleFile("episode", ref.id, episode.container, signal);
  admitTitle(ref);
  const row: FileRow = {
    kind: "episode",
    id: episode.id,
    seriesId: ref.seriesId,
    name: episode.name,
    container: episode.container,
  };
  return {
    ...file,
    admit: () => admitTitle(ref),
    observed: observing(ref.subscriptionId, source, row),
  };
}

/** One subscription's file facts under one login: those saved, with what playback found since. */
interface Facts {
  readonly source: Source;
  /** By kind, series and file id (`fileKey`). */
  readonly files: Map<string, SavedFile>;
  /** Settles once the saved facts were read and taken in, or found missing. */
  readonly ready: Promise<void>;
}

/** File facts by subscription, each under the login it was read for. */
const facts = new Map<string, Facts>();
/**
 * Rises whenever file facts, this run's answers they are checked against, or whether their login
 * may keep them, change.
 */
const factsRevision = store(0);
const factsChanged = () => factsRevision.set((revision) => revision + 1);
/** The most files whose facts one subscription keeps in memory, as on disk. */
const FACT_FILES = 2048;

/** One key per file, whatever a provider's opaque ids hold: they may hold any separator. */
const fileKey = (file: Pick<SavedFile, "kind" | "id" | "seriesId">) =>
  JSON.stringify([file.kind, file.seriesId ?? null, file.id]);

/**
 * `id`'s file facts under `source`, its saved facts read once, in the subscription's turn on the
 * disk. A read that finishes once `source` no longer stands, or after these were replaced, takes
 * nothing in; should `source` stand again, as when a deletion fails, they are read again.
 */
function factsOf(id: string, source: Source): Facts {
  const known = facts.get(id);
  if (known?.source === source) return known;
  const files = new Map<string, SavedFile>();
  const stands = () => savable(id, source) && facts.get(id) === held;
  const held: Facts = {
    source,
    files,
    ready: readFiles(id, source.login, stands).then((saved) => {
      if (!stands()) {
        // Nothing is in them yet: `remember` waits for this.
        if (facts.get(id) === held) facts.delete(id);
        return;
      }
      if (!saved || saved.length === 0) return;
      // Oldest first, as `remember` keeps them, so the oldest go first past FACT_FILES.
      for (const file of saved.toSorted((a, b) => a.at - b.at)) files.set(fileKey(file), file);
      factsChanged();
    }),
  };
  facts.set(id, held);
  return held;
}

/** The login `id` is signed in with, while it may keep file facts (`savable`). */
function standingSource(id: string): Source | undefined {
  const source = currentSource(id);
  return source && savable(id, source) ? source : undefined;
}

/** `id`'s file facts under the login that stands now, if it may keep any. */
function standingFacts(id: string): Facts | undefined {
  const source = standingSource(id);
  return source && factsOf(id, source);
}

const sameTracks = (a: readonly (string | null)[], b: readonly (string | null)[]) =>
  a.length === b.length && a.every((language, at) => language === b[at]);

/**
 * Keeps what playback found in `row`'s file under `source`: once the saved facts were taken in,
 * so they never replace it, and only when it changes them. Nothing once `source` no longer stands.
 */
async function remember(id: string, source: Source, row: FileRow, tracks: ObservedFileTracks) {
  if (!savable(id, source)) return;
  const held = factsOf(id, source);
  await held.ready;
  if (!savable(id, source) || facts.get(id) !== held) return;
  const key = fileKey(row);
  const known = held.files.get(key);
  if (
    known &&
    known.name === row.name &&
    known.container === row.container &&
    sameTracks(known.audio, tracks.audio) &&
    sameTracks(known.subtitles, tracks.subtitles)
  ) {
    return;
  }
  held.files.delete(key);
  held.files.set(key, {
    ...row,
    audio: [...tracks.audio],
    subtitles: [...tracks.subtitles],
    at: Date.now(),
  });
  // The files found longest ago go first, as they do on disk.
  for (const oldest of held.files.keys()) {
    if (held.files.size <= FACT_FILES) break;
    held.files.delete(oldest);
  }
  factsChanged();
  void writeFiles(id, [...held.files.values()], source.login, () => {
    return savable(id, source) && facts.get(id) === held;
  });
}

/** `remember`, for one file looked up under `source`. */
const observing = (id: string, source: Source, row: FileRow) => (tracks: ObservedFileTracks) =>
  void remember(id, source, row, tracks);

type Showing = Exclude<Shown, { readonly made: null }>;

/** Each listed movie whose file facts are of the row the lists show now. */
function movieFiles(now: Showing): FilterFiles {
  const files = new Map<string, readonly FilterFile[]>();
  const { byId } = kindOf(now.lists.index, "movie");
  for (const { subscriptionId } of now.listed) {
    const held = standingFacts(subscriptionId);
    for (const file of held?.files.values() ?? []) {
      if (file.kind !== "movie") continue;
      const key = ownedKey({ subscriptionId, id: file.id });
      const version = byId.get(key)?.versions.find((each) => ownedKey(each) === key);
      if (!version || version.name !== file.name || version.container !== file.container) continue;
      files.set(key, [
        { tags: version.tags, tracks: { audio: file.audio, subtitles: file.subtitles } },
      ]);
    }
  }
  return files;
}

/**
 * Each series version this run has an answer for, asked under the login that stands and the
 * lists that show now: every episode it lists, with the facts of those whose row they are of. A
 * series with no episodes keeps its declared row. Nothing is asked for this.
 */
function seriesFiles(now: Showing): FilterFiles {
  const files = new Map<string, readonly FilterFile[]>();
  const { byId } = kindOf(now.lists.index, "series");
  for (const asking of asked.values()) {
    const details = asking.value;
    const { subscriptionId } = asking;
    const lists = now.listed.find((each) => each.subscriptionId === subscriptionId);
    if (
      asking.kind !== "series" ||
      !details ||
      !lists ||
      asking.listing !== lists.catalogue ||
      currentSource(subscriptionId) !== asking.source ||
      !savable(subscriptionId, asking.source)
    ) {
      continue;
    }
    const key = ownedKey({ subscriptionId, id: asking.id });
    const version = byId.get(key)?.versions.find((each) => ownedKey(each) === key);
    if (!version) continue;
    const held = standingFacts(subscriptionId);
    const episodes = details.episodes.map((episode): FilterFile => {
      const found = held?.files.get(
        fileKey({ kind: "episode", seriesId: asking.id, id: episode.id }),
      );
      return found && found.name === episode.name && found.container === episode.container
        ? { tags: version.tags, tracks: { audio: found.audio, subtitles: found.subtitles } }
        : { tags: version.tags };
    });
    files.set(key, episodes.length > 0 ? episodes : [{ tags: version.tags }]);
  }
  return files;
}

const NO_FILES: FilterFiles = new Map();
/**
 * What `filterFilesOf` last answered for each kind, and for which lists, facts and logins: the
 * standing login of each listed subscription, in the lists' order.
 */
const filesMade = new Map<
  TitleKind,
  {
    readonly shown: Shown;
    readonly revision: number;
    readonly standing: readonly (Source | undefined)[];
    readonly files: FilterFiles;
  }
>();

/**
 * The file facts of `kind` Browse's filters count, by version, for the lists that show: core's
 * FilterFiles, which fall back to each version's declared tags where a version has none here.
 * Reads saved facts from the phone the first time; never asks a provider.
 */
export function filterFilesOf(kind: TitleKind): FilterFiles {
  const now = shown.get();
  if (!now.made) return NO_FILES;
  // Read now, told or not: never a login's facts once it stopped standing, nor none once it stands.
  const standing = now.listed.map(({ subscriptionId }) => standingSource(subscriptionId));
  const kept = filesMade.get(kind);
  if (
    kept?.shown === now &&
    kept.revision === factsRevision.get() &&
    kept.standing.every((source, at) => source === standing[at])
  ) {
    return kept.files;
  }
  const files = kind === "movie" ? movieFiles(now) : seriesFiles(now);
  filesMade.set(kind, { shown: now, revision: factsRevision.get(), standing, files });
  return files;
}

/** Rises whenever what `filterFilesOf` answers may have changed, for screens to read it again. */
export const useFileFacts = () => useStore(factsRevision);

/** Drops this run's answers, and file facts, of logins replaced or removed since. */
function forgetLogins() {
  let changed = false;
  for (const [key, each] of asked) {
    if (currentSource(each.subscriptionId) === each.source) continue;
    asked.delete(key);
    changed = true;
  }
  for (const [id, held] of facts) {
    if (currentSource(id) === held.source) continue;
    facts.delete(id);
    changed = true;
  }
  if (changed) factsChanged();
}

onMediaPreferences(() => {
  const next = effectiveTitleLanguage();
  if (next === language) return;
  language = next;
  languageEpoch++;
  // Abort old metadata demand immediately, before the replacement index is ready. Cached
  // answers remain owned by the shared metadata store and keyed by their actual language.
  metadata.want([], language);
  abouts.clear();
  seasons.clear();
  relist();
});

onRoster(forgetLogins);
// A login still signed in that may no longer keep its facts, or may again after a failed deletion:
// they stay held, and screens read them again.
onSavable(factsChanged);
serveWatchlist(members);
onRoster(relist);
onReadingSaved(relist);
relist();

serveViewing({
  // As a title's file is looked up: once the lists show, waiting while its subscription's are
  // made again, and none when its subscription's titles aren't listed.
  series: (version) =>
    listedIndex(version.subscriptionId, AbortSignal.timeout(20_000)).then(
      (index) => titleOf(index, "series", version),
      (cause: unknown) => {
        if (cause instanceof AppFailure) return undefined;
        throw cause;
      },
    ),
  details: detailsOf,
});
