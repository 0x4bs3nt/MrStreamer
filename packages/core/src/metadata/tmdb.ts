// The Movie Database (TMDB): what it knows about a film or series, by the TMDB id that Xtream
// Codes lists carry, a series' episodes season by season, and which titles each streaming service
// carries in a region. The app keeps only what its collections need. TMDB's terms ask for its
// logo and notice in the app, data cached no longer than six months, and JustWatch named beside
// streaming services.
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";

/** What the app keeps about one film or series. */
export interface TitleMetadata {
  /** TMDB genre ids; `GENRES` names them. */
  readonly genres: readonly number[];
  /** ISO 639-1: the language it was made in. */
  readonly language: string | null;
  /** TMDB's popularity: higher is more watched lately. */
  readonly popularity: number;
  /** Out of 10, with how many votes. */
  readonly rating: number;
  readonly votes: number;
  /** The franchise it belongs to, such as a film series. */
  readonly collection: { readonly id: number; readonly name: string } | null;
  /** A path to a landscape image on TMDB's image server. */
  readonly backdrop: string | null;
}

/** A film's or series' name in one language, and in the language it was made in. */
export interface TitleNames {
  /** The name in the language asked for; null when TMDB has no translation into it. */
  readonly name: string | null;
  readonly original: string | null;
}

/** What a title's details show from TMDB, asked for when the viewer opens it. */
export interface TitleAbout {
  /** The name in the language it was made in. */
  readonly original: string | null;
  /** ISO 639-1: the language it was made in. */
  readonly language: string | null;
  readonly overview: string | null;
  /** Paths on TMDB's image server; `tmdbImage` makes them addresses. */
  readonly poster: string | null;
  readonly backdrop: string | null;
  /** TMDB genre ids; `GENRES` names them. */
  readonly genres: readonly number[];
  /** Minutes: the film, or a usual episode. */
  readonly runtime: number | null;
  /** The first billed, with the part they play and a portrait. */
  readonly cast: readonly {
    readonly name: string;
    readonly character: string | null;
    readonly profile: string | null;
  }[];
  /** A film's directors, or a series' creators. */
  readonly directors: readonly string[];
}

/** What TMDB says about one episode, asked for when the viewer opens its season. */
export interface EpisodeAbout {
  readonly number: number;
  /** The name in the language asked for; null when TMDB has no translation into it. */
  readonly name: string | null;
  readonly overview: string | null;
  /** A path on TMDB's image server. */
  readonly still: string | null;
  /** "2016-07-15". */
  readonly airDate: string | null;
  /** Minutes. */
  readonly runtime: number | null;
  /** Out of 10; null until RATED_AFTER people voted. */
  readonly rating: number | null;
  /** The guest stars, with the part they play and a portrait. */
  readonly cast: TitleAbout["cast"];
  readonly directors: readonly string[];
}

/** How many of the cast a title's details show. */
const CAST_SHOWN = 12;

/** How many votes an episode's rating needs before it counts: fewer say little. */
const RATED_AFTER = 5;

/**
 * What TMDB names an episode it has no translation for, in the languages viewers pick: "Episode
 * 3", "Aflevering 3", "Folge 3".
 */
const UNNAMED_EPISODE =
  /^(?:episode|épisode|episodio|episódio|aflevering|folge|odcinek|bölüm)\s+(\d+)$/iu;

/** The address of an image on TMDB's server at a width it serves: 185, 342, 780, 1280. */
export function tmdbImage(path: string, width: 185 | 342 | 780 | 1280): string {
  return `https://image.tmdb.org/t/p/w${width}${path}`;
}

/** A streaming service as TMDB names it, from JustWatch's data. */
export interface StreamingService {
  readonly id: number;
  readonly name: string;
  /** TMDB's order for the region: lower is more prominent. */
  readonly priority: number;
}

export type TmdbKind = "movie" | "tv";

/** Why TMDB didn't answer, in the terms the app acts on. */
export type TmdbFailure =
  /** The key or token was refused: stop until it changes. */
  | { readonly kind: "refused" }
  /** Too many requests: wait `retryAfter` seconds. */
  | { readonly kind: "busy"; readonly retryAfter: number }
  /** TMDB doesn't have the id. */
  | { readonly kind: "missing" }
  | { readonly kind: "unavailable"; readonly detail: string };

export class TmdbError extends Error {
  readonly failure: TmdbFailure;
  constructor(failure: TmdbFailure) {
    super(failure.kind);
    this.failure = failure;
  }
}

/**
 * Genre names by TMDB id, films and series together. Series have their own ids for some, such as
 * Action & Adventure; those count as both.
 */
export const GENRES: Readonly<Record<number, readonly string[]>> = {
  28: ["Action"],
  12: ["Adventure"],
  16: ["Animation"],
  35: ["Comedy"],
  80: ["Crime"],
  99: ["Documentary"],
  18: ["Drama"],
  10751: ["Family"],
  14: ["Fantasy"],
  36: ["History"],
  27: ["Horror"],
  10402: ["Music"],
  9648: ["Mystery"],
  10749: ["Romance"],
  878: ["Science fiction"],
  53: ["Thriller"],
  10752: ["War"],
  37: ["Western"],
  10759: ["Action", "Adventure"],
  10762: ["Kids"],
  10764: ["Reality"],
  10765: ["Science fiction", "Fantasy"],
  10768: ["War"],
};

const API = "https://api.themoviedb.org/3";
const REQUEST_MS = 15_000;

const Details = lazy(() =>
  type({
    "title?": "string | null",
    "name?": "string | null",
    "original_title?": "string | null",
    "original_name?": "string | null",
    "genres?": type({ id: "number" }).array(),
    "original_language?": "string | null",
    "popularity?": "number",
    "vote_average?": "number",
    "vote_count?": "number",
    "belongs_to_collection?": type({ id: "number", name: "string" }).or("null"),
    "backdrop_path?": "string | null",
  }),
);

const About = lazy(() =>
  type({
    "original_title?": "string | null",
    "original_name?": "string | null",
    "original_language?": "string | null",
    "overview?": "string | null",
    "poster_path?": "string | null",
    "backdrop_path?": "string | null",
    "genres?": type({ id: "number" }).array(),
    "runtime?": "number | null",
    "episode_run_time?": "number[]",
    "created_by?": type({ name: "string" }).array(),
    "credits?": type({
      "cast?": type({
        name: "string",
        "character?": "string | null",
        "profile_path?": "string | null",
      }).array(),
      "crew?": type({ name: "string", "job?": "string | null" }).array(),
    }),
  }),
);

/** A season's episodes. */
const seasonEpisodes = lazy(() =>
  type({
    episodes: type({
      episode_number: "number",
      "name?": "string | null",
      "overview?": "string | null",
      "still_path?": "string | null",
      "air_date?": "string | null",
      "runtime?": "number | null",
      "vote_average?": "number",
      "vote_count?": "number",
      "guest_stars?": type({
        name: "string",
        "character?": "string | null",
        "profile_path?": "string | null",
      }).array(),
      "crew?": type({ name: "string", "job?": "string | null" }).array(),
    }).array(),
  }),
);

const Page = lazy(() =>
  type({
    page: "number",
    total_pages: "number",
    results: type({ id: "number" }).array(),
  }),
);

const Services = lazy(() =>
  type({
    results: type({
      provider_id: "number",
      provider_name: "string",
      "display_priorities?": "Record<string, number>",
      "display_priority?": "number",
    }).array(),
  }),
);

export interface TmdbOptions {
  /** A read access token (starts with "eyJ"), sent as a bearer token, or an API key. */
  readonly key: string;
  /** TMDB's API, or a test server that answers like it. */
  readonly api?: string;
  readonly fetch?: typeof fetch;
}

/** Calls to TMDB with one key. Every call throws `TmdbError` when TMDB doesn't answer. */
export function tmdb(options: TmdbOptions) {
  const fetchImpl = options.fetch ?? fetch;
  const api = options.api ?? API;
  const bearer = options.key.startsWith("eyJ");

  async function get(path: string, params: Record<string, string>, signal?: AbortSignal) {
    const query = new URLSearchParams(bearer ? params : { ...params, api_key: options.key });
    let response: Response;
    try {
      response = await fetchImpl(`${api}${path}?${query}`, {
        headers: bearer
          ? { Authorization: `Bearer ${options.key}`, Accept: "application/json" }
          : { Accept: "application/json" },
        // A request TMDB doesn't answer within this long counts as failed.
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)])
          : AbortSignal.timeout(REQUEST_MS),
      });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new TmdbError({ kind: "unavailable", detail: String(cause) });
    }
    if (response.status === 401) throw new TmdbError({ kind: "refused" });
    if (response.status === 404) throw new TmdbError({ kind: "missing" });
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("retry-after")) || 10;
      throw new TmdbError({ kind: "busy", retryAfter });
    }
    if (!response.ok) {
      throw new TmdbError({ kind: "unavailable", detail: `HTTP ${response.status}` });
    }
    const body: unknown = await response.json();
    return body;
  }

  return {
    /**
     * What TMDB knows about a film or series, with its name in `language`, an ISO 639-1 code.
     * TMDB answers with the original name when it has no translation; that counts as none, unless
     * the title was made in that language.
     */
    async details(
      kind: TmdbKind,
      id: string,
      language: string,
      signal?: AbortSignal,
    ): Promise<TitleMetadata & TitleNames> {
      const body = Details()(await get(`/${kind}/${id}`, { language }, signal));
      if (body instanceof type.errors) {
        throw new TmdbError({ kind: "unavailable", detail: body.summary });
      }
      const name = (body.title ?? body.name)?.trim() || null;
      const original = (body.original_title ?? body.original_name)?.trim() || null;
      const madeIn = body.original_language || null;
      return {
        genres: (body.genres ?? []).map((genre) => genre.id),
        language: madeIn,
        popularity: body.popularity ?? 0,
        rating: body.vote_average ?? 0,
        votes: body.vote_count ?? 0,
        collection: body.belongs_to_collection ?? null,
        backdrop: body.backdrop_path ?? null,
        name: name !== original || madeIn === language ? name : null,
        original,
      };
    },

    /**
     * What a title's details show, in `language`: its overview, artwork, runtime, cast and
     * directors or creators. One request, for when the viewer opens the title.
     */
    async about(
      kind: TmdbKind,
      id: string,
      language: string,
      signal?: AbortSignal,
    ): Promise<TitleAbout> {
      const body = About()(
        await get(`/${kind}/${id}`, { language, append_to_response: "credits" }, signal),
      );
      if (body instanceof type.errors) {
        throw new TmdbError({ kind: "unavailable", detail: body.summary });
      }
      const directors =
        kind === "tv"
          ? (body.created_by ?? []).map((person) => person.name)
          : (body.credits?.crew ?? [])
              .filter((person) => person.job === "Director")
              .map((person) => person.name);
      return {
        original: (body.original_title ?? body.original_name)?.trim() || null,
        language: body.original_language || null,
        overview: body.overview?.trim() || null,
        poster: body.poster_path ?? null,
        backdrop: body.backdrop_path ?? null,
        genres: (body.genres ?? []).map((genre) => genre.id),
        runtime: body.runtime || body.episode_run_time?.[0] || null,
        cast: (body.credits?.cast ?? []).slice(0, CAST_SHOWN).map((person) => ({
          name: person.name,
          character: person.character?.trim() || null,
          profile: person.profile_path ?? null,
        })),
        directors: [...new Set(directors)],
      };
    },

    /**
     * A series' season as TMDB lists it, in `language`: each episode's name, overview, still, air
     * date, runtime, rating, guest stars and directors. One request, for when the viewer opens the
     * season. TMDB names an episode it has no translation for "Episode 3"; that counts as no
     * name.
     */
    async season(
      id: string,
      season: number,
      language: string,
      signal?: AbortSignal,
    ): Promise<readonly EpisodeAbout[]> {
      const body = seasonEpisodes()(await get(`/tv/${id}/season/${season}`, { language }, signal));
      if (body instanceof type.errors) {
        throw new TmdbError({ kind: "unavailable", detail: body.summary });
      }
      return body.episodes.map((episode): EpisodeAbout => {
        const name = episode.name?.trim() || null;
        const unnamed = name && UNNAMED_EPISODE.exec(name);
        return {
          number: episode.episode_number,
          name: unnamed && Number(unnamed[1]) === episode.episode_number ? null : name,
          overview: episode.overview?.trim() || null,
          still: episode.still_path ?? null,
          airDate: episode.air_date?.trim() || null,
          runtime: episode.runtime || null,
          rating: (episode.vote_count ?? 0) >= RATED_AFTER ? (episode.vote_average ?? null) : null,
          cast: (episode.guest_stars ?? []).slice(0, CAST_SHOWN).map((person) => ({
            name: person.name,
            character: person.character?.trim() || null,
            profile: person.profile_path ?? null,
          })),
          directors: [
            ...new Set(
              (episode.crew ?? [])
                .filter((person) => person.job === "Director")
                .map((person) => person.name),
            ),
          ],
        };
      });
    },

    /** The streaming services TMDB knows in a region, most prominent first. */
    async services(kind: TmdbKind, region: string, signal?: AbortSignal) {
      const body = Services()(
        await get(`/watch/providers/${kind}`, { watch_region: region }, signal),
      );
      if (body instanceof type.errors) {
        throw new TmdbError({ kind: "unavailable", detail: body.summary });
      }
      return body.results
        .map((service): StreamingService => ({
          id: service.provider_id,
          name: service.provider_name,
          priority:
            service.display_priorities?.[region] ?? service.display_priority ?? Number.MAX_VALUE,
        }))
        .sort((a, b) => a.priority - b.priority);
    },

    /** One page of the titles a service streams in a region, most popular first. */
    async onService(
      kind: TmdbKind,
      service: number,
      region: string,
      page: number,
      signal?: AbortSignal,
    ): Promise<{ readonly ids: readonly string[]; readonly pages: number }> {
      const body = Page()(
        await get(
          `/discover/${kind}`,
          {
            watch_region: region,
            with_watch_providers: String(service),
            with_watch_monetization_types: "flatrate",
            sort_by: "popularity.desc",
            page: String(page),
          },
          signal,
        ),
      );
      if (body instanceof type.errors) {
        throw new TmdbError({ kind: "unavailable", detail: body.summary });
      }
      return { ids: body.results.map((result) => String(result.id)), pages: body.total_pages };
    },
  };
}

export type Tmdb = ReturnType<typeof tmdb>;
