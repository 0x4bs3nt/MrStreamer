import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type {
  CollectionId,
  CollectionRow,
  CollectionTile,
  EpisodeDetails,
  Season,
  Title,
  TitleDetails,
  TitleKind,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { metadataStore, type MetadataStatus } from "@mrstreamer/core/metadata/store";
import { tmdb, type Tmdb, type TmdbKind } from "@mrstreamer/core/metadata/tmdb";
import {
  byIds,
  indexCatalogue,
  kindOf,
  searchPage,
  type IndexedCatalogue,
} from "@mrstreamer/core/ondemand/catalogue";
import {
  collectionRows,
  collections,
  type Collections,
} from "@mrstreamer/core/ondemand/collections";
import { movieDetails, seasonEpisodes, seriesDetails } from "@mrstreamer/core/ondemand/details";
import type { Provider, ProviderDetails, ProviderFile } from "@mrstreamer/core/provider";
import { File, Paths } from "expo-file-system";
import { appError } from "./errors.ts";
import { store, useStore } from "./store.ts";

// The movie and series catalogue of the connected subscription, as the desktop builds it: the
// provider's lists through core's Xtream adapter, indexed by core (names, versions gathered by
// TMDB id, the version that suits the viewer's language first), the collections Films and Series
// show, search, and details with seasons and episodes. TMDB's metadata comes from core's store,
// with the key built into the app (EXPO_PUBLIC_TMDB_KEY); without one, collections that need it
// are empty and details show the provider's facts. The lists are read once per sign-in and on
// Reload; nothing of them is kept on disk yet.

export type TitleLists =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly index: IndexedCatalogue }
  | { readonly kind: "failed"; readonly error: AppError };

const lists = store<TitleLists>({ kind: "idle" });
/** Rises whenever TMDB's metadata changes what lists show. */
const metadataVersion = store(0);
const metadataStatus = store<MetadataStatus | null>(null);
/** How long the last read of the lists took: fetched and parsed, then indexed. Milliseconds. */
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
    if (content) metadataVersion.set((version) => version + 1);
    metadataStatus.set(metadata.status());
  },
});

let provider: Provider | null = null;
let subscriptionId = "";
/** The signed-in subscription, which every version listed belongs to. */
export const subscriptionOf = () => subscriptionId;
let loading: AbortController | null = null;

/** Takes over the signed-in subscription's provider and reads its lists. */
export function connectTitles(signedIn: Provider, id: string) {
  provider = signedIn;
  subscriptionId = id;
  details.clear();
  seasons.clear();
  loadTitles();
}

/** Forgets the lists and stops what they asked of the provider and TMDB. */
export function disconnectTitles() {
  loading?.abort();
  loading = null;
  provider = null;
  subscriptionId = "";
  details.clear();
  seasons.clear();
  made.clear();
  lists.set({ kind: "idle" });
  metadata.want([]);
}

/** Reads the provider's movie and series lists again, dropping a read still under way. */
export function loadTitles() {
  loading?.abort();
  const controller = new AbortController();
  loading = controller;
  const reading = provider;
  if (!reading) return;
  lists.set({ kind: "loading" });
  const startedAt = Date.now();
  reading.onDemandCatalogue(controller.signal).then(
    async (catalogue) => {
      if (controller.signal.aborted) return;
      const fetched = Date.now();
      const index = indexCatalogue([{ subscriptionId, catalogue }], language);
      // Each kind in a task of its own, after the one that read the lists, so taps are handled
      // between them: the three back to back held the JS thread for 0.7 s with 25,000 titles.
      let indexed = 0;
      for (const kind of ["movie", "series"] as const) {
        await nextTask();
        if (controller.signal.aborted) return;
        const started = Date.now();
        kindOf(index, kind);
        indexed += Date.now() - started;
      }
      timings.set({ fetched: fetched - startedAt, indexed });
      made.clear();
      lists.set({ kind: "ready", index });
      // TMDB's metadata for what is listed, the newest first, once the lists show.
      setTimeout(() => {
        if (lists.get().kind === "ready" && !controller.signal.aborted) {
          metadata.want(wantedOf(index), language);
        }
      }, 0);
    },
    (cause: unknown) => {
      if (!controller.signal.aborted) lists.set({ kind: "failed", error: appError(cause) });
    },
  );
}

/** Resolves in a later task, after whatever input waits. */
const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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

/** Each kind's collections, made once per lists and metadata. */
const made = new Map<TitleKind, { index: IndexedCatalogue; version: number; made: Collections }>();

/** The collections of `kind` as the lists and TMDB's metadata stand. */
export function collectionsOf(index: IndexedCatalogue, kind: TitleKind): Collections {
  const version = metadataVersion.get();
  const kept = made.get(kind);
  if (kept && kept.index === index && kept.version === version) return kept.made;
  const tk = tmdbKind(kind);
  const result = collections({
    kind,
    titles: kindOf(index, kind).titles,
    language,
    metadata: (id) => metadata.get(tk, id),
    names: (id) => metadata.name(tk, id, language),
    services: metadata.services(tk),
    now: Date.now(),
  });
  made.set(kind, { index, version, made: result });
  return result;
}

/** For you or New: rows of collections, For you led by titles like `like`. */
export function rowsOf(
  index: IndexedCatalogue,
  kind: TitleKind,
  tab: "for-you" | "new",
  like: OwnedId | null,
): readonly CollectionRow[] {
  return collectionRows(collectionsOf(index, kind), tab, like);
}

/** Genres or streaming services as tiles, most stocked first. */
export function tilesOf(
  index: IndexedCatalogue,
  kind: TitleKind,
  of: "genres" | "services",
): readonly CollectionTile[] {
  const made = collectionsOf(index, kind);
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

/** A collection's titles and name. */
export function collectionOf(index: IndexedCatalogue, kind: TitleKind, id: CollectionId) {
  const made = collectionsOf(index, kind);
  return { name: made.name(id) ?? "", titles: made.list(id) };
}

/** Titles of `kind` whose names hold every word of `query`, by any name TMDB gave them too. */
export function searchTitles(index: IndexedCatalogue, kind: TitleKind, query: string) {
  const tk = tmdbKind(kind);
  const page = searchPage(index, kind, query, (title) =>
    title.tmdbId ? metadata.searchName(tk, title.tmdbId) : "",
  );
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

/** Details already read, or being read, by kind and version, with what the provider sent. */
const details = new Map<string, Promise<Read>>();

interface Read {
  readonly shown: TitleDetails;
  readonly raw: ProviderDetails;
}

/**
 * A title's details: the provider's facts of the version `title` names, with TMDB's overview,
 * cast and artwork when the build has a key and TMDB knows the title. Read once per sign-in; a
 * failed read is asked again next time.
 */
export function detailsOf(title: Title): Promise<TitleDetails> {
  return readOnce(title).then(({ shown }) => shown);
}

function readOnce(title: Title): Promise<Read> {
  const key = `${title.kind}|${ownedKey(title)}`;
  let found = details.get(key);
  if (!found) {
    found = readDetails(title);
    details.set(key, found);
    found.catch(() => details.delete(key));
  }
  return found;
}

async function readDetails(title: Title): Promise<Read> {
  const reading = provider;
  if (!reading) throw new AppFailure({ kind: "no-subscription" });
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

/** A season's episodes with TMDB's names, stills and stories, by series version and season. */
const seasons = new Map<string, Promise<readonly EpisodeDetails[]>>();

/** A season's episodes as its details list them, with TMDB's worked in where it answers. */
export function episodesOf(title: Title, season: Season): Promise<readonly EpisodeDetails[]> {
  const key = `${ownedKey(title)}|${season.number}`;
  let found = seasons.get(key);
  if (!found) {
    found = readSeason(title, season);
    seasons.set(key, found);
  }
  return found;
}

async function readSeason(title: Title, season: Season): Promise<readonly EpisodeDetails[]> {
  if (!client || !title.tmdbId || title.adult) return seasonEpisodes(season, []);
  const ask = (asked: string) =>
    client.season(title.tmdbId ?? "", season.number, asked).catch(() => []);
  const answers = await Promise.all(
    language === "en" ? [ask(language)] : [ask(language), ask("en")],
  );
  return seasonEpisodes(season, answers);
}

/**
 * Where a movie or an episode streams from, by the file type its provider lists: a movie's in the
 * lists or its details, an episode's in its series' details. Carries the login in its address.
 */
export async function titleFile(ref: TitleRef, signal: AbortSignal): Promise<ProviderFile> {
  const reading = provider;
  const ready = lists.get();
  if (!reading || ready.kind !== "ready") throw new AppFailure({ kind: "no-subscription" });
  const missing = new AppFailure({ kind: "title-not-found", titleId: ref.id });
  if (ref.kind === "movie") {
    const title = titleOf(ready.index, "movie", ref);
    if (!title) throw missing;
    const listed = title.versions.find((version) => version.id === ref.id)?.container;
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
