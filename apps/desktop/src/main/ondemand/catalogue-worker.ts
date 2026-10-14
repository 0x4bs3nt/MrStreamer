// The movie and series catalogue, in a worker thread. Its lists run to tens of megabytes, and
// reading, indexing and sorting them would hold the main process for hundreds of milliseconds;
// here that costs nothing the viewer notices. The main process sends small calls and gets pages.
//
// Each subscription's lists are kept as its provider sent them, in memory and in its folder
// (ondemand.json.gz), and display names are worked out on load. What the lists show is made of
// all of them at once: one catalogue, in which a film two subscriptions list under one TMDB id is
// one title. It is sorted, searched and counted whole and cut into pages only then, so no
// subscription is cut short before another's titles are in, and a page never holds a film twice.
// One worker holds every subscription's lists; none gets a thread of its own.
//
// A refresh takes two calls. The lists it fetches wait aside until the main process, which knows
// the saved login, says whether they still count: only then do they show and reach the disk.
import { join } from "node:path";
import { workerData, parentPort } from "node:worker_threads";
import { type } from "arktype";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import {
  byIds,
  indexCatalogue,
  kindOf,
  search,
  searchPage,
  type IndexedCatalogue,
} from "@mrstreamer/core/ondemand/catalogue";
import type {
  CollectionId,
  HomeRecommendation,
  Title,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { listedFileKey } from "@mrstreamer/core/ondemand/files";
import {
  filterOptions,
  filterTitles,
  type FilterFiles,
  type FilterFile,
} from "@mrstreamer/core/ondemand/filters";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { adultIn } from "@mrstreamer/core/adult";
import { setLanguage, t } from "@mrstreamer/core/i18n";
import type { OnDemandCatalogue, ProviderTitle } from "@mrstreamer/core/provider";
import { tmdb, tmdbImage } from "@mrstreamer/core/metadata/tmdb";
import { collections, type Collections } from "@mrstreamer/core/ondemand/collections";
import {
  relatedProviderFacts,
  relatedTitles,
  type RelatedProviderFacts,
} from "@mrstreamer/core/ondemand/related";
import {
  entriesOf,
  factsOf,
  savedFirst,
  titleOf,
  type SavedMember,
} from "@mrstreamer/core/ondemand/watchlist";
import { readJsonFile, removeFile, writeJsonFile } from "../platform/json-file.ts";
import { providerFor } from "../providers/account.ts";
import { metadataStore, type Wanted } from "./metadata.ts";
import type {
  CatalogueOwner,
  KnownFile,
  WorkerCalls,
  WorkerEvent,
  WorkerRequest,
  WorkerSetup,
  WorkerStatus,
} from "./protocol.ts";
import { lazy } from "@mrstreamer/contracts/lazy";

const setup = workerData as WorkerSetup;

/** Counts arrivals of metadata that lists show, so collections built before them are built again. */
let metadataVersion = 0;
/** The viewer's language as the last call named it: TMDB's names are asked for in it. */
let viewerLanguage = "en";

/** TMDB's metadata, kept across subscriptions: it describes titles, not accounts. */
const metadata = metadataStore({
  path: setup.metadataPath,
  client: setup.tmdb
    ? tmdb({ key: setup.tmdb.key, ...(setup.tmdb.api ? { api: setup.tmdb.api } : {}) })
    : null,
  region: setup.tmdb?.region ?? "US",
  onChange: ({ content }) => {
    if (content) metadataVersion++;
    parentPort?.postMessage({
      event: "metadata",
      content,
      status: metadata.status(),
    } satisfies WorkerEvent);
  },
});

/**
 * Whether the viewer shows titles for adults, as the main process says with each status call:
 * TMDB is asked about them only then.
 */
let adults = false;

const Category = lazy(() => type({ id: "string", name: "string" }));
const ProviderTitle = lazy(() =>
  type({
    id: "string",
    name: "string",
    posterUrl: "string | null",
    backdropUrl: "string | null",
    rating: "number | null",
    addedAt: "number | null",
    releaseDate: "string | null",
    categoryIds: "string[]",
    adult: "boolean",
    container: "string | null",
    "tmdbId?": "string | null",
    "metadata?": "'lazy'",
    "episodeFiles?": "string[]",
  }),
);
/** Version 1 came before TMDB ids: still shown, but refreshed as soon as the app can. */
const CachedCatalogue = lazy(() =>
  type({
    version: "1 | 2",
    /** Which subscription produced it. */
    key: "string",
    fetchedAt: "number",
    "importRevision?": "string",
    movieCategories: Category().array(),
    movies: ProviderTitle().array(),
    seriesCategories: Category().array(),
    series: ProviderTitle().array(),
  }),
);

/** One subscription's lists. */
interface Loaded {
  /** The subscription whose titles these are. */
  readonly subscriptionId: string;
  readonly fetchedAt: number;
  readonly importRevision?: string;
  readonly catalogue: OnDemandCatalogue;
  readonly movies: number;
  readonly series: number;
}

/** Each subscription's lists, by its id, once read from disk or fetched. */
const loaded = new Map<string, Loaded>();
/** Related facts follow raw list identity, so replacement or removal retains no stale snapshot. */
const relatedFacts = new WeakMap<
  readonly ProviderTitle[],
  ReadonlyMap<string, RelatedProviderFacts>
>();

function relatedFactsOf(member: Loaded, kind: TitleKind, index: IndexedCatalogue) {
  const rows = kind === "movie" ? member.catalogue.movies : member.catalogue.series;
  let facts = relatedFacts.get(rows);
  if (!facts) {
    const names = new Map<string, string>();
    for (const row of rows) {
      const indexed = kindOf(index, kind).byId.get(
        ownedKey({ subscriptionId: member.subscriptionId, id: row.id }),
      );
      // The index's display name belongs to its primary version, before TMDB naming.
      if (indexed?.subscriptionId === member.subscriptionId && indexed.id === row.id) {
        names.set(row.id, indexed.title);
      }
    }
    facts = relatedProviderFacts(rows, names);
    relatedFacts.set(rows, facts);
  }
  return facts;
}

/** The refreshes in flight, by subscription, shared by calls with the same login. */
const refreshing = new Map<
  string,
  { readonly revision: number; readonly done: Promise<null>; readonly abort: AbortController }
>();
/**
 * The lists a refresh fetched, by subscription, set aside until the main process says whether the
 * login they were asked under still stands.
 */
const fetched = new Map<
  string,
  { readonly revision: number; readonly catalogue: OnDemandCatalogue }
>();

/** What the lists of some subscriptions make together, as a viewer of one language sees it. */
interface Shown {
  /** What it was made of: the same lists in the same order make the same catalogue. */
  readonly members: readonly Loaded[];
  readonly index: IndexedCatalogue;
  /** Current exact listed rows, built per kind only when local observations need validation. */
  readonly fileListings: Map<TitleKind, ReadonlyMap<string, ProviderTitle>>;
  /** By kind and metadata version; built when first asked for. */
  readonly collections: Map<string, Collections>;
}

/** The catalogue last made: the one every page of a visit asks for. */
let shown: Shown | null = null;

/**
 * Every TMDB id the loaded lists hold, once, with when it was added. Titles for adults count only
 * while the viewer shows them.
 */
function wanted(): Wanted[] {
  const found = new Map<string, Wanted>();
  for (const { catalogue } of loaded.values()) {
    for (const [kind, titles, categories] of [
      ["movie", catalogue.movies, catalogue.movieCategories],
      ["tv", catalogue.series, catalogue.seriesCategories],
    ] as const) {
      const isAdult = adultIn(categories);
      for (const title of titles) {
        if (title.metadata === "lazy" || !title.tmdbId || (!adults && isAdult(title))) continue;
        const key = `${kind}:${title.tmdbId}`;
        const addedAt = title.addedAt ?? 0;
        if ((found.get(key)?.addedAt ?? -1) < addedAt) {
          found.set(key, { kind, tmdbId: title.tmdbId, addedAt });
        }
      }
    }
  }
  return [...found.values()];
}

function remember(
  subscriptionId: string,
  fetchedAt: number,
  catalogue: OnDemandCatalogue,
  importRevision?: string,
): Loaded {
  const kept: Loaded = {
    subscriptionId,
    fetchedAt,
    ...(importRevision ? { importRevision } : {}),
    catalogue,
    movies: catalogue.movies.length,
    series: catalogue.series.length,
  };
  loaded.set(subscriptionId, kept);
  // After the call that loaded it has answered, unless other lists took its place.
  setTimeout(() => {
    if (loaded.get(subscriptionId) === kept) metadata.want(wanted(), viewerLanguage);
  }, 0);
  return kept;
}

/** How many titles a row shows before its All. */
const ROW_TITLES = 24;
/** Streaming services For you shows as rows, most stocked first. */
const SERVICE_ROWS = 3;

/** Notes whether the viewer shows titles for adults; turning it on asks TMDB about them. */
function showing(now: boolean): void {
  if (now === adults) return;
  adults = now;
  if (loaded.size > 0) metadata.want(wanted(), viewerLanguage);
}

/**
 * Notes the viewer's language from a call; a new one asks TMDB for names in it, in the
 * background.
 */
function speaking(language: string): void {
  if (language === viewerLanguage) return;
  viewerLanguage = language;
  if (loaded.size > 0) metadata.want(wanted(), language);
}

/**
 * A title with TMDB's name for a viewer of `language`, the language it was made in and its
 * backdrop, once known, as collections show it.
 */
function named(title: Title, language: string): Title {
  if (!title.tmdbId) return title;
  const kind = title.kind === "movie" ? "movie" : "tv";
  const found = metadata.name(kind, title.tmdbId, language);
  const known = metadata.get(kind, title.tmdbId);
  const backdrop = title.backdropUrl ? null : known?.backdrop;
  return {
    ...title,
    ...(found ? { title: found.name, originalTitle: found.original } : {}),
    originalLanguage: known?.language ?? null,
    ...(backdrop ? { backdropUrl: tmdbImage(backdrop, 1280) } : {}),
  };
}

const cachePath = (owner: CatalogueOwner) => join(owner.dir, "ondemand.json.gz");
/** The cache from before it was packed, read once and removed after the next write. */
const legacyCachePath = (owner: CatalogueOwner) => join(owner.dir, "ondemand.json");

/** The lists still to be written, by subscription: the newest of each. */
const unsaved = new Map<string, { readonly owner: CatalogueOwner; readonly kept: Loaded }>();
/** The wait before those are written; null while none wait. */
let waiting: NodeJS.Timeout | null = null;
/** The caches being written. Writes go one at a time, and forgetting lists waits for them. */
let writing: Promise<void> = Promise.resolve();
/**
 * How long lists wait to be written. Turning them into JSON holds this thread for a quarter of a
 * second, and the pages the UI asks for right after a refresh come first. The wait is one for
 * every subscription's lists, from the last that arrived, and stopping the worker skips it: a
 * wait each, one after another, would outlast the moment a quit gives.
 */
const WRITE_AFTER_MS = 1000;

/** Has a subscription's lists saved once the wait is over. */
function persist(owner: CatalogueOwner, kept: Loaded): void {
  unsaved.set(owner.subscriptionId, { owner, kept });
  if (waiting) clearTimeout(waiting);
  waiting = setTimeout(() => void save(), WRITE_AFTER_MS);
}

/**
 * Writes the lists that wait, now, one subscription after another, and is done once they and
 * any write before them are on disk. Lists that newer ones replaced, or whose subscription went
 * meanwhile, aren't written.
 */
function save(): Promise<void> {
  if (waiting) clearTimeout(waiting);
  waiting = null;
  for (const { owner, kept } of unsaved.values()) {
    writing = writing
      .then(async () => {
        if (loaded.get(owner.subscriptionId) !== kept) return;
        const { fetchedAt, catalogue } = kept;
        await writeJsonFile(cachePath(owner), {
          version: 2,
          key: owner.key,
          fetchedAt,
          ...(kept.importRevision ? { importRevision: kept.importRevision } : {}),
          ...catalogue,
        });
        await removeFile(legacyCachePath(owner));
      })
      .catch(() => {});
  }
  unsaved.clear();
  return writing;
}

/** Lists that came back empty once, by subscription: a second time in a row, they count. */
const emptyBefore = new Set<string>();

/** The cache files being read, by subscription, so the calls a start sends together read once. */
const reading = new Map<string, Promise<Loaded | null>>();
/** What names each of those reads, by subscription. */
const readings = new Map<string, object>();

/**
 * A subscription's lists from memory, or from disk when the lists in its folder are its
 * account's, or null when there are none yet.
 */
function current(owner: CatalogueOwner): Promise<Loaded | null> {
  const { subscriptionId, key } = owner;
  const kept = loaded.get(subscriptionId);
  if (kept) return Promise.resolve(kept);
  const under = reading.get(subscriptionId);
  if (under) return under;
  /** Names this read: forgetting the subscription, or reading again after that, takes it over. */
  const token = {};
  readings.set(subscriptionId, token);
  const done = (async () => {
    const file =
      (await readJsonFile(cachePath(owner), CachedCatalogue())) ??
      (await readJsonFile(legacyCachePath(owner), CachedCatalogue()));
    // Forgotten while reading, when the subscription went.
    if (file?.key !== key || readings.get(subscriptionId) !== token) return null;
    return (
      loaded.get(subscriptionId) ??
      remember(subscriptionId, file.version === 2 ? file.fetchedAt : 0, file, file.importRevision)
    );
  })();
  reading.set(subscriptionId, done);
  const settled = () => {
    if (reading.get(subscriptionId) !== done) return;
    reading.delete(subscriptionId);
    readings.delete(subscriptionId);
  };
  done.then(settled, settled);
  return done;
}

/**
 * The catalogue the lists of `owners` make together, for a viewer of `language`: the one made
 * last while it is of the same lists, else made anew. Subscriptions without lists yet add
 * nothing. With `required`, as for a page of a collection, it fails with what the UI explains
 * while subscriptions have lists to load and none has.
 */
async function catalogueOf(
  owners: readonly CatalogueOwner[],
  language: string,
  required = false,
): Promise<Shown> {
  const members = (await Promise.all(owners.map(current))).flatMap((each) => each ?? []);
  if (required && members.length === 0 && owners.length > 0) {
    throw new AppFailure({
      kind: "unexpected",
      detail: t("Movies and series haven't loaded yet."),
    });
  }
  return shownOf(members, language);
}

/** Builds an index from the lists supplied, without loading other libraries or metadata. */
function shownOf(members: readonly Loaded[], language: string): Shown {
  const same =
    shown?.index.language === language &&
    shown.members.length === members.length &&
    shown.members.every((each, at) => each === members[at]);
  if (!shown || !same) {
    shown = {
      members,
      index: indexCatalogue(members, language),
      fileListings: new Map(),
      collections: new Map(),
    };
  }
  return shown;
}

/** Last-read tracks count only while their exact file remains in these owners' current lists. */
function filterFiles(found: Shown, kind: TitleKind, known: readonly KnownFile[]): FilterFiles {
  const result = new Map<string, FilterFile[]>();
  if (known.length === 0) return result;
  let listings = found.fileListings.get(kind);
  if (!listings) {
    listings = new Map(
      found.members.flatMap((member) =>
        (kind === "movie" ? member.catalogue.movies : member.catalogue.series).map(
          (file) =>
            [ownedKey({ subscriptionId: member.subscriptionId, id: file.id }), file] as const,
        ),
      ),
    );
    found.fileListings.set(kind, listings);
  }
  const titles = kindOf(found.index, kind).byId;
  for (const file of known) {
    const key = ownedKey({
      subscriptionId: file.subscriptionId,
      id: file.kind === "movie" ? file.id : (file.seriesId ?? ""),
    });
    if (kind === "movie") {
      if (file.kind !== "movie") continue;
      const listed = listings.get(key);
      if (!listed || listedFileKey("movie", listed) !== file.listingKey) continue;
    } else {
      if (file.kind !== "episode" || !file.seriesId || !file.tags) continue;
      const listed = listings.get(key);
      if (!listed || (listed.episodeFiles && !listed.episodeFiles.includes(file.id))) continue;
    }
    const title = titles.get(key);
    const version = title?.versions.find((version) => ownedKey(version) === key);
    if (!version) continue;
    const files = result.get(key) ?? [];
    files.push({
      tags: file.tags ?? version.tags,
      ...(file.tracks ? { tracks: file.tracks } : {}),
    });
    result.set(key, files);
  }
  return result;
}

/** The collections of a kind as a viewer of `language` sees them, with the metadata so far. */
function collectionsOf(found: Shown, kind: TitleKind): Collections {
  const key = `${kind}|${metadataVersion}`;
  let made = found.collections.get(key);
  if (!made) {
    const { language } = found.index;
    const tmdbKind = kind === "movie" ? "movie" : "tv";
    made = collections({
      kind,
      titles: kindOf(found.index, kind).titles,
      language,
      metadata: (tmdbId) => metadata.get(tmdbKind, tmdbId),
      names: (tmdbId) => metadata.name(tmdbKind, tmdbId, language),
      services: metadata.services(tmdbKind),
      now: Date.now(),
    });
    // Older metadata only takes memory.
    for (const old of found.collections.keys()) {
      if (!old.endsWith(`|${metadataVersion}`)) found.collections.delete(old);
    }
    found.collections.set(key, made);
  }
  return made;
}

function statusOf(found: Loaded | null): WorkerStatus {
  return {
    movies: found?.movies ?? 0,
    series: found?.series ?? 0,
    fetchedAt: found?.fetchedAt ?? null,
    ...(found?.importRevision ? { importRevision: found.importRevision } : {}),
  };
}

async function refresh(args: WorkerCalls["refresh"]["args"]): Promise<null> {
  const { subscriptionId, revision } = args;
  const under = refreshing.get(subscriptionId);
  // Playlist reads can finish out of order. Older lists must leave newer work and results alone.
  if (
    (under && under.revision > revision) ||
    (fetched.get(subscriptionId)?.revision ?? -1) > revision
  ) {
    throw new AppFailure({ kind: "unexpected", detail: t("Stopped.") });
  }
  if (under?.revision === revision) return under.done;
  // This subscription's, under the login it had before. Another subscription's goes on.
  under?.abort.abort();
  const abort = new AbortController();
  const done = (async () => {
    const provider = providerFor(args.account, { userAgent: setup.userAgent });
    const catalogue = args.catalogue ?? (await provider.onDemandCatalogue(abort.signal));
    const before = await current(args);
    // An empty list doesn't replace one that had titles, unless it comes twice in a row, as for
    // channels: panels answer an overloaded request with an empty list, and one list can fail
    // while the other arrives.
    for (const list of args.account.kind === "m3u" ? [] : (["movies", "series"] as const)) {
      const mark = `${subscriptionId}:${list}`;
      const lost = catalogue[list].length === 0 && (before?.[list] ?? 0) > 0;
      if (!lost || emptyBefore.has(mark)) {
        emptyBefore.delete(mark);
        continue;
      }
      emptyBefore.add(mark);
      throw new AppFailure({
        kind: "incomplete-catalogue",
        received: 0,
        previous: before?.[list] ?? 0,
        list,
      });
    }
    if (abort.signal.aborted) throw new AppFailure({ kind: "unexpected", detail: t("Stopped.") });
    // A category list that comes back empty keeps the one before: panels answer an overloaded
    // request with an empty list too, and without its names, titles only a category marks for
    // adults would show everywhere.
    const kept: OnDemandCatalogue = {
      ...catalogue,
      movieCategories:
        args.account.kind === "m3u" || catalogue.movieCategories.length > 0 || !before
          ? catalogue.movieCategories
          : before.catalogue.movieCategories,
      seriesCategories:
        args.account.kind === "m3u" || catalogue.seriesCategories.length > 0 || !before
          ? catalogue.seriesCategories
          : before.catalogue.seriesCategories,
    };
    fetched.set(subscriptionId, { revision, catalogue: kept });
    return null;
  })();
  const running = { revision, done, abort };
  refreshing.set(subscriptionId, running);
  try {
    return await done;
  } finally {
    if (refreshing.get(subscriptionId) === running) refreshing.delete(subscriptionId);
  }
}

/**
 * Ends a refresh as the main process decided: the lists set aside for it become the
 * subscription's and are saved, or are dropped. Answers the status that leaves.
 */
async function finishRefresh({
  revision,
  keep,
  ...owner
}: WorkerCalls["finishRefresh"]["args"]): Promise<WorkerStatus> {
  const { subscriptionId } = owner;
  const aside = fetched.get(subscriptionId);
  // Gone already when a call that shared the refresh ended it, or the subscription went.
  if (aside?.revision !== revision) return statusOf(await current(owner));
  fetched.delete(subscriptionId);
  if (!keep) return statusOf(await current(owner));
  const kept = remember(subscriptionId, Date.now(), aside.catalogue, owner.importRevision);
  // Written after answering, so the lists show without waiting for the disk. Quitting writes
  // them first; a write it cuts short all the same leaves the previous lists for the next start,
  // which refreshes them when due.
  persist(owner, kept);
  return statusOf(kept);
}

/** TMDB's names for a title, so search finds it by its translations and its original name too. */
function aliases(title: Title): string {
  return title.tmdbId
    ? metadata.searchName(title.kind === "movie" ? "movie" : "tv", title.tmdbId)
    : "";
}

/** TMDB's picture of a saved title the lists hold no more, when TMDB told of one. */
function artworkOf(saved: SavedMember): string | null {
  if (!saved.tmdbId) return null;
  const backdrop = metadata.get(saved.kind === "movie" ? "movie" : "tv", saved.tmdbId)?.backdrop;
  return backdrop ? tmdbImage(backdrop, 780) : null;
}

/**
 * The title an entry is in the lists now, by what any of its subscriptions saved of it, or null
 * when the lists hold none that is surely it.
 */
function listedAs(index: IndexedCatalogue, entry: readonly SavedMember[]): Title | null {
  for (const member of entry) {
    const title = titleOf(index, member);
    if (title) return title;
  }
  return null;
}

/** Names in the order a list of them reads, whatever their case and accents. */
const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

const handlers: {
  [M in keyof WorkerCalls]: (args: WorkerCalls[M]["args"]) => Promise<WorkerCalls[M]["result"]>;
} = {
  status: async ({ adults: now, owners }) => {
    showing(now);
    return (await Promise.all(owners.map(current))).map(statusOf);
  },
  refresh,
  finishRefresh,
  byIds: async ({ language, kind, versions, owners, files }) => {
    speaking(language);
    const found = await catalogueOf(owners, language);
    const selected = byIds(found.index, kind, versions).map((title) => named(title, language));
    if (!files?.some((file) => file.tracks)) return selected;
    const wanted = new Set(selected.flatMap((title) => title.versions.map(ownedKey)));
    const read = files.filter(
      (file) =>
        file.tracks &&
        wanted.has(
          ownedKey({
            subscriptionId: file.subscriptionId,
            id: kind === "movie" ? file.id : (file.seriesId ?? ""),
          }),
        ),
    );
    if (read.length === 0) return selected;
    const observed = filterFiles(found, kind, read);
    return selected.map((shown) => {
      return {
        ...shown,
        versions: shown.versions.map((version) => {
          const read = observed
            .get(ownedKey(version))
            ?.flatMap((file) => (file.tracks ? [file.tracks] : []));
          return read?.length
            ? {
                ...version,
                observed: {
                  files: read.length,
                  audio: [...new Set(read.flatMap((file) => file.audio))],
                  subtitles: [...new Set(read.flatMap((file) => file.subtitles))],
                },
              }
            : version;
        }),
      };
    });
  },
  search: async ({ language, query, owners }) => {
    speaking(language);
    const { index } = await catalogueOf(owners, language);
    const matches = (kind: TitleKind) =>
      search(index, kind, query, aliases).map((title) => named(title, language));
    return { movies: matches("movie"), series: matches("series") };
  },
  searchKind: async ({ language, kind, query, limit, owners, filters, files = [] }) => {
    speaking(language);
    const found = await catalogueOf(owners, language);
    // Filters apply to every match before the cut; without them only the best `limit` are kept.
    if (!filters) {
      const page = searchPage(found.index, kind, query, aliases, limit);
      return { titles: page.titles.map((title) => named(title, language)), total: page.total };
    }
    const unfiltered = search(found.index, kind, query, aliases, Infinity);
    const matches = filterTitles(unfiltered, filters, filterFiles(found, kind, files));
    return {
      titles: matches.slice(0, limit).map((title) => named(title, language)),
      total: matches.length,
      unfiltered: unfiltered.length,
    };
  },
  filterOptions: async ({ owners, language, kind, files, adults }) => {
    const found = await catalogueOf(owners, language);
    // Choices need version hints and observed tracks, not metadata decoration or collection order.
    const indexed = kindOf(found.index, kind).titles;
    const titles = adults ? indexed : indexed.filter((title) => !title.adult);
    return filterOptions(titles, filterFiles(found, kind, files));
  },
  rows: async ({ language, kind, tab, like, owners }) => {
    speaking(language);
    const made = collectionsOf(await catalogueOf(owners, language, true), kind);
    const ids: CollectionId[] =
      tab === "new"
        ? ["new-week", "new-month", "recent"]
        : [
            ...(like ? [`like:${ownedKey(like)}` as const] : []),
            "popular",
            "new-week",
            "top-rated",
            ...made
              .services()
              .slice(0, SERVICE_ROWS)
              .map((service) => `service:${service.id}` as const),
          ];
    return ids.flatMap((id) => {
      const titles = made.list(id);
      const name = made.name(id);
      if (titles.length === 0 || !name) return [];
      return [{ id, name, total: titles.length, titles: titles.slice(0, ROW_TITLES) }];
    });
  },
  recommendations: async ({ owners, language, seeds }) => {
    const members = owners.flatMap((owner) => {
      const held = loaded.get(owner.subscriptionId);
      return held && held.importRevision === owner.importRevision ? [held] : [];
    });
    const found = shownOf(members, language);
    const catalogues = {
      movie: collectionsOf(found, "movie").list("all"),
      series: collectionsOf(found, "series").list("all"),
    };
    const recent = seeds.slice(0, 32).flatMap(({ kind, version }) => {
      const title = catalogues[kind].find(
        (title) =>
          !title.adult && title.versions.some((each) => ownedKey(each) === ownedKey(version)),
      );
      return title ? [{ title, version }] : [];
    });
    const excluded = new Set(recent.map(({ title }) => title.key));
    const used = new Set<string>();
    const results: HomeRecommendation[] = [];
    for (const { title: seed, version } of recent) {
      if (used.has(seed.key)) continue;
      used.add(seed.key);
      const own = members.find((member) => member.subscriptionId === version.subscriptionId);
      const facts = own ? relatedFactsOf(own, seed.kind, found.index) : undefined;
      const related = relatedTitles({
        opened: seed,
        version,
        titles: catalogues[seed.kind],
        provider: (each) =>
          each.subscriptionId === version.subscriptionId ? (facts?.get(each.id) ?? null) : null,
      });
      let contributed = 0;
      for (const { title, reason } of related.titles) {
        if (excluded.has(title.key)) continue;
        excluded.add(title.key);
        results.push({ title, reason, seed: seed.title });
        if (results.length === 12) return results;
        if (++contributed === 4) break;
      }
      if (used.size === 3) break;
    }
    return results;
  },
  related: async ({ language, kind, version, owners, metadata: about }) => {
    const members = owners.flatMap((owner) => {
      const held = loaded.get(owner.subscriptionId);
      return held && held.importRevision === owner.importRevision ? [held] : [];
    });
    const found = shownOf(members, language);
    const titles = collectionsOf(found, kind).list("all");
    const seed = titles.find((title) =>
      title.versions.some((each) => ownedKey(each) === ownedKey(version)),
    );
    if (!seed) return { basis: null, titles: [] };
    // Category ids belong to this provider. No category from another owner can match it.
    const own = members.find((member) => member.subscriptionId === version.subscriptionId);
    const providerTitles = own ? relatedFactsOf(own, kind, found.index) : undefined;
    return relatedTitles({
      opened: about ? { ...seed, genres: about.genres, originalLanguage: about.language } : seed,
      version,
      titles,
      provider: (each) => {
        if (each.subscriptionId !== version.subscriptionId) return null;
        return providerTitles?.get(each.id) ?? null;
      },
    });
  },
  tiles: async ({ language, kind, of, owners }) => {
    speaking(language);
    const made = collectionsOf(await catalogueOf(owners, language, true), kind);
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
  },
  collection: async ({ language, kind, id, sort, offset, limit, owners, filters, files = [] }) => {
    speaking(language);
    const found = await catalogueOf(owners, language, true);
    const made = collectionsOf(found, kind);
    const unfiltered = made.list(id, sort);
    const titles = filters
      ? filterTitles(
          unfiltered,
          filters,
          filterFiles(found, kind, files),
          (version) => id !== "4k" || version.tags.some((tag) => tag === "4K" || tag === "UHD"),
        )
      : unfiltered;
    return {
      name: made.name(id) ?? "",
      total: titles.length,
      titles: titles.slice(offset, offset + limit),
      ...(filters ? { unfiltered: unfiltered.length } : {}),
    };
  },
  saved: async ({ language, adults: shown, members, sort, offset, limit, owners }) => {
    speaking(language);
    const found = await catalogueOf(owners, language);
    /** The subscriptions whose lists were there to look in. */
    const held = new Set(found.members.map((each) => each.subscriptionId));
    const saved = entriesOf(members).flatMap((entry) => {
      const [first] = entry;
      if (!first) return [];
      const listed = listedAs(found.index, entry);
      const title = listed ? named(listed, language) : null;
      // For adults as the lists say now, or as they last said of a title they hold no more.
      if (!shown && (title?.adult ?? first.adult)) return [];
      return [{ first, entry, title, name: title?.title ?? first.name }];
    });
    const newest = (a: (typeof saved)[number], b: (typeof saved)[number]) =>
      savedFirst(b.first, a.first);
    saved.sort(
      sort === "title" ? (a, b) => byName.compare(a.name, b.name) || newest(a, b) : newest,
    );
    return {
      total: saved.length,
      entries: saved.slice(offset, offset + limit).map(({ first, entry, title }) => {
        const { subscriptionId, id, kind, name, year, savedAt } = first;
        const saving = new Set(entry.map((member) => member.subscriptionId));
        const sources = owners.flatMap((owner) =>
          saving.has(owner.subscriptionId) ? [owner.subscriptionId] : [],
        );
        return {
          subscriptionId,
          id,
          kind,
          name,
          year,
          savedAt,
          title,
          artworkUrl: title ? null : artworkOf(first),
          sources,
          listed: sources.every((source) => held.has(source)),
        };
      }),
    };
  },
  savedFacts: async ({ language, subscriptionId, entries, owners }) => {
    speaking(language);
    const { index, members } = await catalogueOf(owners, language);
    if (!members.some((each) => each.subscriptionId === subscriptionId)) return null;
    // Each title once, however many entries turn out to be it.
    const titles = new Set(
      entries.flatMap((entry) => titleOf(index, { ...entry, subscriptionId }) ?? []),
    );
    return [...titles].flatMap((title) => {
      const facts = factsOf(named(title, language), subscriptionId);
      // A title only another subscription lists now leaves what this one saved as it was.
      return facts.versionIds.length > 0 ? [facts] : [];
    });
  },
  container: async ({ id, ...owner }) => {
    const found = await current(owner);
    const movie = found?.catalogue.movies.find((movie) => movie.id === id);
    return movie?.container
      ? { container: movie.container, listingKey: listedFileKey("movie", movie) }
      : null;
  },
  forget: async (owner) => {
    const { subscriptionId } = owner;
    refreshing.get(subscriptionId)?.abort.abort();
    refreshing.delete(subscriptionId);
    fetched.delete(subscriptionId);
    reading.delete(subscriptionId);
    readings.delete(subscriptionId);
    loaded.delete(subscriptionId);
    unsaved.delete(subscriptionId);
    for (const list of ["movies", "series"]) emptyBefore.delete(`${subscriptionId}:${list}`);
    // Its titles aren't wanted any more, unless another subscription lists them too.
    metadata.want(wanted(), viewerLanguage);
    await writing;
    await Promise.all([removeFile(cachePath(owner)), removeFile(legacyCachePath(owner))]);
    return null;
  },
  flush: async () => {
    await Promise.all([save(), metadata.flush()]);
    return null;
  },
};

parentPort?.on("message", (request: WorkerRequest) => {
  setLanguage(request.interfaceLanguage);
  const handler = handlers[request.method] as (args: unknown) => Promise<unknown>;
  handler(request.args).then(
    (value) => parentPort?.postMessage({ id: request.id, ok: true, value }),
    (cause: unknown) =>
      parentPort?.postMessage({ id: request.id, ok: false, error: errorOf(cause) }),
  );
});

function errorOf(cause: unknown): AppError {
  if (cause instanceof AppFailure) return cause.error;
  return { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };
}
