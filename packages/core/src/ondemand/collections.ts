// The collections Movies and Series show in their tabs, built from what every Xtream Codes
// provider sends (dates, ratings, names) and from TMDB's metadata (genres, languages,
// popularity, streaming services). Nothing here reads a provider's own category names.
import type {
  CollectionId,
  CollectionRow,
  CollectionSort,
  RowTab,
  Title,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { type PlainKey, t } from "../i18n.ts";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { GENRES, tmdbImage, type TitleMetadata } from "../metadata/tmdb.ts";
import { suitability, suits } from "./languages.ts";

/** The order a collection uses before the viewer chooses another sort. */
export function collectionSort(id: CollectionId): CollectionSort {
  if (id === "top-rated") return "rating";
  if (
    id === "recent" ||
    id === "popular" ||
    id.startsWith("genre:") ||
    id.startsWith("service:") ||
    id.startsWith("like:")
  )
    return "popular";
  return "added";
}

/** A streaming service and the TMDB ids of what it streams in the viewer's region. */
export interface ServiceTitles {
  readonly id: number;
  readonly name: string;
  readonly ids: ReadonlySet<string>;
}

/** What collections need: the titles, and TMDB's metadata as far as it has arrived. */
export interface CollectionSource {
  readonly kind: TitleKind;
  readonly titles: readonly Title[];
  readonly language: string;
  readonly metadata: (tmdbId: string) => TitleMetadata | null;
  /** TMDB's name for a title in the viewer's language, and its original, once known. */
  readonly names: (
    tmdbId: string,
  ) => { readonly name: string; readonly original: string | null } | null;
  readonly services: readonly ServiceTitles[];
  /** Epoch milliseconds, for "this week". */
  readonly now: number;
  /** Raw metadata expiry for an id, or the service snapshot without one; Infinity when absent. */
  readonly expiresAt?: (tmdbId?: string) => number;
}

/** A title with what collections sort and filter it by. */
interface Ranked {
  readonly title: Title;
  readonly genres: readonly string[];
  readonly popularity: number;
  /** TMDB's rating once enough people voted, 0 before; the provider's when TMDB has none. */
  readonly rating: number;
  /** Rated by enough people on TMDB to count as top rated. */
  readonly rated: boolean;
  /** Its version shown suits the viewer's language: `suits`. */
  readonly suits: boolean;
  /** The title opening a 4K version that suits the viewer, when it has one. */
  readonly fourK: Title | null;
}

/** Votes TMDB needs before its rating counts. */
const ENOUGH_VOTES = 100;
/** Top rated: at least this, out of 10. */
const TOP_RATING = 7.5;
const DAY_MS = 24 * 60 * 60_000;

export interface Collections {
  /** Whether this snapshot still describes `now`, including rolling dates and clock reversal. */
  validAt(now: number): boolean;
  /** A collection's titles, in `sort` or the collection's own order. */
  list(id: CollectionId, sort?: CollectionSort): readonly Title[];
  /** A collection's name to show: "Comedy", "Netflix", "New this week". */
  name(id: CollectionId): string | null;
  /** Genres with how many titles each, most first. */
  genres(): readonly {
    readonly name: string;
    readonly count: number;
    readonly artwork: string | null;
  }[];
  /** Streaming services with what of theirs the catalogue has, most first. */
  services(): readonly {
    readonly id: number;
    readonly name: string;
    readonly count: number;
    readonly artwork: string | null;
  }[];
}

export function collections(source: CollectionSource): Collections {
  let until = Date.UTC(new Date(source.now).getUTCFullYear() + 1, 0, 1);
  const expires = (id?: string) => {
    const at = source.expiresAt?.(id) ?? Infinity;
    if (at > source.now) until = Math.min(until, at);
  };
  expires();
  const ranked = source.titles
    .filter((title) => !title.adult)
    .map((title): Ranked => {
      if (title.tmdbId) expires(title.tmdbId);
      const meta = title.tmdbId ? source.metadata(title.tmdbId) : null;
      const names = title.tmdbId ? source.names(title.tmdbId) : null;
      const shown: Title = meta
        ? {
            ...title,
            ...(names ? { title: names.name, originalTitle: names.original } : {}),
            originalLanguage: meta.language ?? null,
            backdropUrl:
              title.backdropUrl ?? (meta.backdrop ? tmdbImage(meta.backdrop, 1280) : null),
            genres: genresOf(meta),
          }
        : title;
      const fitting = (tags: readonly string[]) =>
        suits(suitability(tags, source.language), meta?.language, source.language);
      const fourK = title.versions.find(
        (version) =>
          version.tags.some((tag) => tag === "4K" || tag === "UHD") && fitting(version.tags),
      );
      return {
        title: shown,
        genres: shown.genres,
        popularity: meta?.popularity ?? 0,
        // Providers rate new titles 10 of 10; TMDB's few early votes are no better.
        rating: meta ? (meta.votes >= ENOUGH_VOTES ? meta.rating : 0) : (title.rating ?? 0),
        rated: Boolean(meta && meta.votes >= ENOUGH_VOTES),
        suits: fitting(title.tags),
        fourK: !fourK
          ? null
          : fourK.id === title.id
            ? shown
            : { ...shown, subscriptionId: fourK.subscriptionId, id: fourK.id, tags: fourK.tags },
      };
    });
  const suiting = ranked.filter((entry) => entry.suits);
  // Membership changes at each title's rolling cutoff, not at calendar week/month boundaries.
  // Compute once with the snapshot; reads inside this interval need no catalogue scan.
  for (const entry of suiting) {
    for (const days of [7, 30]) {
      const cutoff = added(entry) + days * DAY_MS;
      if (cutoff > source.now) until = Math.min(until, cutoff);
    }
  }
  /** Titles for adults: in their own collection only, as the provider lists them. */
  const adult = source.titles.flatMap((title): Ranked[] =>
    title.adult
      ? [
          {
            title,
            genres: [],
            popularity: 0,
            rating: title.rating ?? 0,
            rated: false,
            suits: false,
            fourK: null,
          },
        ]
      : [],
  );
  const lists = new Map<string, readonly Title[]>();

  const orders: Record<CollectionSort, (a: Ranked, b: Ranked) => number> = {
    added: (a, b) => (b.title.addedAt ?? 0) - (a.title.addedAt ?? 0),
    popular: (a, b) =>
      b.popularity - a.popularity || (b.title.addedAt ?? 0) - (a.title.addedAt ?? 0),
    rating: (a, b) => b.rating - a.rating || b.popularity - a.popularity,
    title: (a, b) => collator.compare(a.title.title, b.title.title),
  };

  /** The titles included in a collection before sorting. */
  function members(id: CollectionId): { entries: readonly Ranked[] } {
    if (id === "all") return { entries: ranked };
    if (id === "adult") return { entries: adult };
    if (id === "new-week") {
      return {
        entries: suiting.filter((entry) => added(entry) > source.now - 7 * DAY_MS),
      };
    }
    if (id === "new-month") {
      return {
        entries: suiting.filter((entry) => added(entry) > source.now - 30 * DAY_MS),
      };
    }
    if (id === "recent") {
      const year = new Date(source.now).getUTCFullYear();
      return {
        entries: suiting.filter((entry) => (entry.title.year ?? 0) >= year - 1),
      };
    }
    if (id === "popular") return { entries: suiting.filter((entry) => entry.popularity > 0) };
    if (id === "top-rated")
      return {
        entries: suiting.filter((entry) => entry.rated && entry.rating >= TOP_RATING),
      };
    if (id === "4k") {
      return {
        entries: suiting.flatMap((entry) =>
          entry.fourK ? [{ ...entry, title: entry.fourK }] : [],
        ),
      };
    }
    if (id.startsWith("genre:")) {
      const genre = id.slice("genre:".length);
      return { entries: suiting.filter((entry) => entry.genres.includes(genre)) };
    }
    if (id.startsWith("service:")) {
      const service = source.services.find((each) => `service:${each.id}` === id);
      if (!service) return { entries: [] };
      return {
        entries: suiting.filter(
          (entry) => entry.title.tmdbId && service.ids.has(entry.title.tmdbId),
        ),
      };
    }
    if (id.startsWith("like:")) return { entries: alike(id.slice("like:".length)) };
    return { entries: [] };
  }

  /** The title one of whose versions `key` names, as `ownedKey` writes it. */
  const seedOf = (key: string) =>
    ranked.find((entry) => entry.title.versions.some((version) => ownedKey(version) === key));

  /** Titles sharing the most genres with one, more popular first; the title itself left out. */
  function alike(key: string): Ranked[] {
    const seed = seedOf(key);
    if (!seed || seed.genres.length === 0) return [];
    const scored = suiting.flatMap((entry) => {
      if (entry === seed) return [];
      const shared = entry.genres.filter((genre) => seed.genres.includes(genre)).length;
      return shared > 0 ? [{ entry, shared }] : [];
    });
    scored.sort((a, b) => b.shared - a.shared || b.entry.popularity - a.entry.popularity);
    return scored.map(({ entry }) => entry);
  }

  return {
    validAt: (now) => now >= source.now && now < until,

    list(id, sort) {
      const key = `${id}|${sort ?? ""}`;
      let list = lists.get(key);
      if (!list) {
        const { entries } = members(id);
        list = entries.toSorted(orders[sort ?? collectionSort(id)]).map((entry) => entry.title);
        lists.set(key, list);
      }
      return list;
    },

    name(id) {
      if (id.startsWith("genre:")) return id.slice("genre:".length);
      if (id.startsWith("service:")) {
        return source.services.find((service) => `service:${service.id}` === id)?.name ?? null;
      }
      if (id.startsWith("like:")) {
        const seed = seedOf(id.slice("like:".length));
        return seed ? t("More like {title}", { title: seed.title.title }) : null;
      }
      const name = NAMES.get(id);
      return name === undefined ? null : t(name);
    },

    genres: once(() => {
      const byGenre = new Map<string, Ranked[]>();
      for (const entry of suiting) {
        for (const genre of entry.genres) {
          const list = byGenre.get(genre);
          if (list) list.push(entry);
          else byGenre.set(genre, [entry]);
        }
      }
      return [...byGenre]
        .map(([name, entries]) => ({ name, count: entries.length, artwork: artworkOf(entries) }))
        .sort((a, b) => b.count - a.count);
    }),

    services: once(() =>
      source.services
        .map((service) => {
          const entries = suiting.filter(
            (entry) => entry.title.tmdbId && service.ids.has(entry.title.tmdbId),
          );
          return {
            id: service.id,
            name: service.name,
            count: entries.length,
            artwork: artworkOf(entries),
          };
        })
        .filter((service) => service.count > 0)
        .sort((a, b) => b.count - a.count),
    ),
  };
}

/** How many titles a row shows before its All. */
const ROW_TITLES = 24;
/** Streaming services For you shows as rows, most stocked first. */
const SERVICE_ROWS = 3;

/**
 * The rows of For you or New, each with its first titles and how many it has: New gathers what
 * was added; For you leads with titles like `like`, the one watched last, then what is popular,
 * new and top rated, and the best stocked services. Rows with nothing in them are left out.
 */
export function collectionRows(
  made: Collections,
  tab: RowTab,
  like: OwnedId | null,
): CollectionRow[] {
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
}

function once<A>(make: () => A): () => A {
  let value: { readonly made: A } | null = null;
  return () => (value ??= { made: make() }).made;
}

/** The fixed collections' names, in the interface language when they're asked for. */
const NAMES = new Map<string, PlainKey>([
  ["all", "All"],
  ["new-week", "New this week"],
  ["new-month", "New this month"],
  ["recent", "Recent releases"],
  ["popular", "Popular"],
  ["top-rated", "Top rated"],
  ["4k", "4K"],
  ["adult", "For adults"],
]);

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function added(entry: Ranked): number {
  return entry.title.addedAt ?? 0;
}

/** Genre names, once each, in TMDB's order. */
function genresOf(meta: TitleMetadata): string[] {
  return [...new Set(meta.genres.flatMap((id) => GENRES[id] ?? []))];
}

/** A landscape picture for a tile: the most popular member's that has one. */
function artworkOf(entries: readonly Ranked[]): string | null {
  let best: Ranked | null = null;
  for (const entry of entries) {
    if (entry.title.backdropUrl && (!best || entry.popularity > best.popularity)) best = entry;
  }
  return best?.title.backdropUrl ?? null;
}
