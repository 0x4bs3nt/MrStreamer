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
import { tmdb, type Tmdb, type TmdbKind } from "@mrstreamer/core/metadata/tmdb";
import {
  byIds,
  indexSteps,
  kindOf,
  searchPage,
  type IndexedCatalogue,
} from "@mrstreamer/core/ondemand/catalogue";
import {
  collectionSteps,
  rowIds,
  type Collections,
  type CollectionSource,
} from "@mrstreamer/core/ondemand/collections";
import { movieDetails, seasonEpisodes, seriesDetails } from "@mrstreamer/core/ondemand/details";
import type { OnDemandCatalogue, ProviderDetails, ProviderFile } from "@mrstreamer/core/provider";
import type { Steps } from "@mrstreamer/core/steps";
import { File, Paths } from "expo-file-system";
import { useEffect } from "react";
import { members, onRoster, shownOf, type Member } from "./account.ts";
import { inTasks } from "./library.ts";
import { currentSource, sourceOf } from "./sources.ts";
import { store, useStore, type Store } from "./store.ts";
import { serveViewing } from "./viewing.ts";
import { alignWatchlist } from "./watchlist.ts";

// The movie and series catalogue of every saved subscription together, as the desktop builds it:
// each provider's lists, which account.ts loads, indexed by core as one (names, versions gathered
// by TMDB id across subscriptions and never by name, the version that suits the viewer's language
// first), the collections Movies and Series show, search, and details with seasons and episodes,
// each read from the subscription that lists the version. TMDB's metadata comes from core's
// store, with the key built into the app (EXPO_PUBLIC_TMDB_KEY); without one, collections that
// need it are empty and details show the provider's facts. account.ts gives a subscription's
// lists saved on the phone at launch as it gives its provider's (catalogue-cache.ts).
//
// Collections are made here, never while a screen draws: each kind's in short tasks once the
// lists are indexed and again whenever TMDB's metadata changes what they show. Until the first
// are made for the lists that show, a kind has none (`useCollections` is null); later ones
// replace those before them only once made.

export type TitleLists =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly index: IndexedCatalogue }
  | { readonly kind: "failed"; readonly error: AppError };

const lists = store<TitleLists>({ kind: "idle" });
/** Rises whenever TMDB's metadata changes what lists show. */
const metadataVersion = store(0);
const metadataStatus = store<MetadataStatus | null>(null);
/**
 * How long the last read of the lists took: fetched and read, then indexed, from start to finish
 * of the tasks that did it. Milliseconds; lists saved on the phone count as none fetched.
 */
const timings = store<{ readonly fetched: number; readonly indexed: number } | null>(null);

export const useTitleLists = () => useStore(lists);
/** The lists as they stand, for owners outside React. */
export const titleLists = () => lists.get();
/** Calls `listener` whenever the lists change. */
export const onTitleLists = (listener: () => void) => lists.subscribe(listener);
export const useMetadataVersion = () => useStore(metadataVersion);
export const useMetadataStatus = () => useStore(metadataStatus);
export const useTitleTimings = () => useStore(timings);

const locale = new Intl.Locale(Intl.DateTimeFormat().resolvedOptions().locale);
/** The viewer's language, which version of a title shows first and which names TMDB gives. */
export const language = locale.language;
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

/** One subscription's lists, as `indexSteps` takes them. */
interface Listed {
  readonly subscriptionId: string;
  readonly catalogue: OnDemandCatalogue;
}

/** The lists the index was made of, or is being made of. */
let indexed: readonly Listed[] = [];
let indexing: AbortController | null = null;

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
function standing(all: readonly Member[]): TitleLists {
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

/**
 * Indexes the lists of every subscription that has them, whenever one's change: those that
 * failed or load again keep what they had. Until one has lists, the state says whether any is
 * still loading or why they failed, after every change of the subscriptions.
 */
function relist() {
  const all = members();
  const listed = all.flatMap((member) => {
    const catalogue = shownOf(member.titles);
    return catalogue ? [{ subscriptionId: member.entry.id, catalogue }] : [];
  });
  if (listed.length === 0) {
    if (indexed.length > 0) {
      indexed = [];
      indexing?.abort();
      indexing = null;
      forget();
      metadata.want([]);
    }
    const next = standing(all);
    const now = lists.get();
    const same =
      now.kind === next.kind &&
      (now.kind !== "failed" || (next.kind === "failed" && now.error === next.error));
    if (!same) lists.set(next);
    return;
  }
  if (sameLists(listed, indexed)) return;
  indexed = listed;
  indexing?.abort();
  const controller = new AbortController();
  indexing = controller;
  void index(listed, controller.signal);
}

async function index(listed: readonly Listed[], signal: AbortSignal) {
  // Indexing 25,000 movies held the JS thread for a third of a second or more in a Release build
  // on the iOS simulator, so both kinds are worked out a few slices per task, starting after the
  // answer that brought the lists, and only a finished index shows: what showed before stays
  // meanwhile, and screens never index a kind while they draw.
  const started = Date.now();
  const index = await inTasks(indexSteps(listed, language), () => !signal.aborted);
  if (!index) return;
  const took = Date.now() - started;
  const fetched = Math.max(
    0,
    ...members().map((member) => (member.titles.kind === "ready" ? (member.titles.took ?? 0) : 0)),
  );
  timings.set({ fetched, indexed: took });
  forget();
  lists.set({ kind: "ready", index });
  collect("movie");
  collect("series");
  alignWatchlist(index);
  // TMDB's metadata for what is listed, the newest first, once the lists show.
  setTimeout(() => {
    if (!signal.aborted) metadata.want(wantedOf(index), language);
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

/** A kind's collections, and the lists and metadata version they were made of. */
interface Made {
  readonly index: IndexedCatalogue;
  readonly version: number;
  readonly collections: Collections;
}

/** Each kind's collections as last made for the lists that show; null until the first are. */
const made: Record<TitleKind, Store<Made | null>> = {
  movie: store<Made | null>(null),
  series: store<Made | null>(null),
};
/** Each kind's collections being made, for which lists. */
const making = new Map<TitleKind, IndexedCatalogue>();

/**
 * The collections of `kind` for the lists that show, as TMDB's metadata stood when they were made:
 * null until the first are made, and again from when other lists show until theirs are. `reads`
 * are what the screen reads them by besides (`useHolding`).
 */
export function useCollections(
  kind: TitleKind,
  reads: readonly unknown[] = [],
): Collections | null {
  const kept = useStore(made[kind]);
  useHolding(kind, [kept, ...reads]);
  return kept?.collections ?? null;
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
  return made[kind].get()?.collections ?? null;
}

/** Drops both kinds' collections: other lists, or none, show from now on. */
function forget() {
  made.movie.set(null);
  made.series.set(null);
}

/**
 * Makes `kind`'s collections for the lists that show, unless those made are of these lists and
 * the metadata as it stands, and still hold now: no title has passed New's 7 or 30 days, no
 * metadata they were made with has expired, the year hasn't turned and the clock hasn't gone
 * back (`validAt`). While some are being made for these lists nothing else starts, so however
 * often TMDB's metadata changes the first are made; once they are, this runs again and makes
 * the latest, or again if time passed what they hold while they were made.
 */
function collect(kind: TitleKind) {
  const now = lists.get();
  if (now.kind !== "ready") return;
  const { index } = now;
  const version = metadataVersion.get();
  const kept = made[kind].get();
  const current =
    kept?.index === index && kept.version === version && kept.collections.validAt(Date.now());
  if (current || making.get(kind) === index) return;
  making.set(kind, index);
  void make(kind, index, version);
}

async function make(kind: TitleKind, index: IndexedCatalogue, version: number) {
  // Ranking 25,000 movies and their series with TMDB's metadata, then sorting their lists, held
  // the JS thread for 60 to 95 ms at once in a Release build on the iOS simulator, each time the
  // metadata changed while Movies drew. So collections are made a few slices per task, and work
  // for lists that no longer show stops at the next task and shows nothing.
  const current = () => {
    const now = lists.get();
    return now.kind === "ready" && now.index === index;
  };
  const tk = tmdbKind(kind);
  let result: Collections | null;
  try {
    result = await inTasks(
      madeSteps({
        kind,
        titles: kindOf(index, kind).titles,
        language,
        metadata: (id) => metadata.get(tk, id),
        names: (id) => metadata.name(tk, id, language),
        services: metadata.services(tk),
        expiresAt: (id) => metadata.expiresAt(tk, id),
        now: Date.now(),
      }),
      current,
    );
  } finally {
    if (making.get(kind) === index) making.delete(kind);
  }
  if (!result || !current()) return;
  made[kind].set({ index, version, collections: result });
  collect(kind);
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

/** Titles of `kind` whose names hold every word of `query`, by any name TMDB gave them too. */
export function searchTitles(index: IndexedCatalogue, kind: TitleKind, query: string) {
  const tk = tmdbKind(kind);
  const page = searchPage(index, kind, query, (title) => {
    if (!title.tmdbId) return "";
    const shown = metadata.name(tk, title.tmdbId, language);
    return {
      ...(shown ? { title: shown.name, original: shown.original } : {}),
      names: metadata.searchAliases(tk, title.tmdbId),
    };
  });
  return { ...page, titles: page.titles.map(named) };
}

/** A title with TMDB's name for the viewer, once known, as collections show it. */
export function named(title: Title): Title {
  if (!title.tmdbId) return title;
  const found = metadata.name(tmdbKind(title.kind), title.tmdbId, language);
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

/** Details already read, or being read, by login, kind and version, with what the provider sent. */
const details = new Map<string, Promise<Read>>();

interface Read {
  readonly shown: TitleDetails;
  readonly raw: ProviderDetails;
}

/**
 * A title's details: the provider's facts of the version `title` names, from its subscription,
 * with TMDB's overview, cast and artwork when the build has a key and TMDB knows the title. Read
 * once per sign-in; a failed read is asked again next time.
 */
export function detailsOf(title: Title): Promise<TitleDetails> {
  return readOnce(title).then(({ shown }) => shown);
}

function readOnce(title: Title): Promise<Read> {
  const key = `${currentSource(title.subscriptionId)?.revision ?? 0}|${title.kind}|${ownedKey(title)}`;
  let found = details.get(key);
  if (!found) {
    found = readDetails(title);
    details.set(key, found);
    found.catch(() => details.delete(key));
  }
  return found;
}

async function readDetails(title: Title): Promise<Read> {
  const reading = sourceOf(title.subscriptionId).provider;
  const signal = AbortSignal.timeout(20_000);
  const about =
    client && title.tmdbId && !title.adult
      ? client.about(tmdbKind(title.kind), title.tmdbId, language, signal).catch(() => null)
      : Promise.resolve(null);
  if (title.kind === "movie") {
    const [raw, known] = await Promise.all([reading.movieDetails(title.id, signal), about]);
    return { raw, shown: movieDetails(title, raw, known) };
  }
  const [raw, known] = await Promise.all([reading.seriesDetails(title.id, signal), about]);
  return { raw, shown: seriesDetails(title, raw, known, language) };
}

type SeasonAnswers = Parameters<typeof seasonEpisodes>[1];

/**
 * What TMDB says of a season's episodes, by TMDB id and season. It is the same whichever provider
 * lists the series, so it is asked once; the provider's episodes are those of the details read.
 */
const seasons = new Map<string, Promise<SeasonAnswers>>();

/** A season's episodes as its details list them, with TMDB's worked in where it answers. */
export async function episodesOf(title: Title, season: Season): Promise<readonly EpisodeDetails[]> {
  const { tmdbId } = title;
  if (!client || !tmdbId || title.adult) return seasonEpisodes(season, []);
  const key = `${tmdbId}|${season.number}`;
  let answers = seasons.get(key);
  if (!answers) {
    const ask = (asked: string) => client.season(tmdbId, season.number, asked).catch(() => []);
    answers = Promise.all(language === "en" ? [ask(language)] : [ask(language), ask("en")]);
    seasons.set(key, answers);
  }
  return seasonEpisodes(season, await answers);
}

/**
 * Where a movie or an episode streams from, by the file type its provider lists: a movie's in the
 * lists or its details, an episode's in its series' details. Asks the subscription that lists it,
 * and carries its login in the address.
 */
export async function titleFile(ref: TitleRef, signal: AbortSignal): Promise<ProviderFile> {
  const reading = sourceOf(ref.subscriptionId).provider;
  const ready = lists.get();
  if (ready.kind !== "ready") throw new AppFailure({ kind: "no-subscription" });
  const missing = new AppFailure({ kind: "title-not-found", titleId: ref.id });
  if (ref.kind === "movie") {
    const title = titleOf(ready.index, "movie", ref);
    if (!title) throw missing;
    const listed = title.versions.find((version) => sameOwned(version, ref))?.container;
    const container = listed ?? (await readOnce({ ...title, ...ownedId(ref) })).raw.container;
    return reading.titleFile("movie", ref.id, container ?? "mp4", signal);
  }
  const series = { subscriptionId: ref.subscriptionId, id: ref.seriesId };
  const title = titleOf(ready.index, "series", series);
  if (!title) throw missing;
  const { raw } = await readOnce({ ...title, ...series });
  const episode = raw.episodes.find((each) => each.id === ref.id);
  if (!episode) throw missing;
  return reading.titleFile("episode", ref.id, episode.container, signal);
}

onRoster(relist);
relist();

serveViewing({
  series: (version) => {
    const now = lists.get();
    return now.kind === "ready" ? titleOf(now.index, "series", version) : undefined;
  },
  details: detailsOf,
});
