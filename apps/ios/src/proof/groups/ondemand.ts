import type { Title } from "@mrstreamer/contracts/ondemand";
import { metadataStore } from "@mrstreamer/core/metadata/store";
import { tmdb } from "@mrstreamer/core/metadata/tmdb";
import { byIds, indexCatalogue, kindOf, searchPage } from "@mrstreamer/core/ondemand/catalogue";
import { collectionRows, collections } from "@mrstreamer/core/ondemand/collections";
import {
  movieDetails,
  nextEpisode,
  seasonEpisodes,
  seriesDetails,
} from "@mrstreamer/core/ondemand/details";
import { versionOptions } from "@mrstreamer/core/ondemand/version-options";
import type { OnDemandCatalogue, ProviderDetails } from "@mrstreamer/core/provider";
import { continueEntries } from "@mrstreamer/core/viewing/continue";
import { continuation, episodeStates } from "@mrstreamer/core/viewing/episodes";
import { memoryViewingStore, type ViewingSnapshot } from "@mrstreamer/core/viewing/memory-store";
import {
  LegacyViewing,
  ViewingAccount,
  ViewingChannels,
  ViewingRecord,
  ViewingSeries,
  ViewingStore,
} from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { plain, type ProofCase } from "../cases.ts";

// The on-demand rules Films, Series, details, Watch and Home run: indexing, collections and
// rows, details with seasons and episodes, the version menu, the viewing record over the
// in-memory store, Continue watching, and TMDB's answers read through its client and store.
// Times the record keeps differ per run, so the cases return what they decide, not when.

const SUB = "xtream-proof";
const NOW = Date.UTC(2026, 9, 10);
const day = 24 * 60 * 60;

const row = (
  id: string,
  name: string,
  extra: Partial<OnDemandCatalogue["movies"][number]> = {},
) => ({
  id,
  name,
  posterUrl: null,
  backdropUrl: null,
  rating: 6.5,
  addedAt: NOW - Number(id) * day * 1000,
  releaseDate: null,
  categoryIds: ["1"],
  adult: false,
  container: "mp4",
  tmdbId: null,
  ...extra,
});

/** Language versions sharing a TMDB id, a 4K one, one for adults and plain titles. */
const CATALOGUE: OnDemandCatalogue = {
  movieCategories: [
    { id: "1", name: "NL | FILMS" },
    { id: "9", name: "XXX | ADULT" },
  ],
  movies: [
    row("1", "NL | Copper Lake 2024 (NL)", { tmdbId: "501" }),
    row("2", "EN | Copper Lake 2024 (EN)", { tmdbId: "501" }),
    row("3", "Copper Lake 2024 [4K] (EN)", { tmdbId: "501", container: "mkv" }),
    row("4", "Glasswing (2025)", { tmdbId: "502" }),
    row("5", "Night Ferry", { tmdbId: "503", container: "avi" }),
    row("6", "Late Show", { categoryIds: ["9"] }),
    row("7", "Écume des jours (FR)", { tmdbId: "504" }),
  ],
  seriesCategories: [{ id: "1", name: "NL | SERIES" }],
  series: [
    row("20", "Kestrel House (NL)", { tmdbId: "601", container: null }),
    row("21", "Sable Coast", { container: null }),
  ],
};

const META: Record<
  string,
  { genres: number[]; popularity: number; rating: number; votes: number }
> = {
  "501": { genres: [53, 18], popularity: 90, rating: 7.4, votes: 900 },
  "502": { genres: [878], popularity: 50, rating: 7.1, votes: 400 },
  "503": { genres: [53, 80], popularity: 20, rating: 7.8, votes: 50 },
  "504": { genres: [18], popularity: 5, rating: 6, votes: 300 },
};

const shown = (title: Title) => [
  title.key,
  title.title,
  title.year,
  title.versions.map((v) => v.id),
];

const SERIES_DETAILS: ProviderDetails = {
  originalName: "Kestrel House (NL)",
  plot: "Three sisters inherit a guesthouse.",
  genres: ["Drama"],
  cast: ["Ana Costa"],
  directors: [],
  releaseDate: "2023-02-01",
  duration: 2880,
  posterUrl: null,
  backdropUrl: null,
  seasons: [{ number: 1, name: null, posterUrl: null }],
  episodes: [
    ...[1, 2, 3].map((number) => ({
      id: `e1${number}`,
      season: 1,
      number,
      name: `Kestrel House - S01E0${number} - Part ${number}`,
      plot: null,
      duration: 2880,
      stillUrl: null,
      airDate: null,
      addedAt: null,
      container: "mkv",
    })),
    ...[1, 2].map((number) => ({
      id: `e2${number}`,
      season: 2,
      number,
      name: `S02E0${number}`,
      plot: null,
      duration: 3000,
      stillUrl: null,
      airDate: null,
      addedAt: null,
      container: "mp4",
    })),
    {
      id: "e01",
      season: 0,
      number: 1,
      name: "Special",
      plot: null,
      duration: 600,
      stillUrl: null,
      airDate: null,
      addedAt: null,
      container: "mp4",
    },
  ],
  container: null,
};

/** TMDB's answers, as its API sends them, for a client with a stand-in fetch. */
function tmdbAnswer(url: string): unknown {
  const path = new URL(url).pathname;
  const about = /\/(movie|tv)\/(\d+)$/.exec(path);
  if (about) {
    const id = about[2] ?? "";
    const known = META[id];
    return {
      title: about[1] === "movie" ? `Named ${id}` : undefined,
      name: about[1] === "tv" ? `Named ${id}` : undefined,
      original_title: `Original ${id}`,
      original_language: id === "504" ? "fr" : "en",
      genres: (known?.genres ?? [18]).map((genre) => ({ id: genre })),
      popularity: known?.popularity ?? 1,
      vote_average: known?.rating ?? 5,
      vote_count: known?.votes ?? 1,
      backdrop_path: `/b${id}.jpg`,
      overview: `Story ${id}.`,
      poster_path: `/p${id}.jpg`,
      runtime: 112,
      credits: {
        cast: [{ name: "Eva Vos", character: "Mara", profile_path: null }],
        crew: [{ name: "Lotte Smit", job: "Director" }],
      },
    };
  }
  if (/\/season\/\d+$/.test(path)) {
    return {
      episodes: [1, 2, 3].map((number) => ({
        episode_number: number,
        name: number === 2 ? "Episode 2" : `TMDB ${number}`,
        overview: `Story of ${number}.`,
        still_path: `/s${number}.jpg`,
        air_date: "2023-02-0" + number,
        runtime: 48,
        vote_average: 8,
        vote_count: number === 3 ? 2 : 20,
        guest_stars: [],
        crew: [{ name: "Dora Director", job: "Director" }],
      })),
    };
  }
  if (path.endsWith("/watch/providers/movie")) {
    return {
      results: [
        { provider_id: 8, provider_name: "Netflix", display_priorities: { NL: 2 } },
        { provider_id: 9, provider_name: "Prime Video", display_priorities: { NL: 1 } },
      ],
    };
  }
  if (path.endsWith("/watch/providers/tv")) return { results: [] };
  if (path.includes("/discover/movie")) {
    const service = new URL(url).searchParams.get("with_watch_providers");
    return { page: 1, total_pages: 1, results: service === "8" ? [{ id: 501 }, { id: 503 }] : [] };
  }
  return { status_code: 34 };
}

const standIn: typeof fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const body = tmdbAnswer(url);
  return new Response(JSON.stringify(body), {
    status: "status_code" in (body as object) ? 404 : 200,
    headers: { "Content-Type": "application/json" },
  });
};

/** The record service over the in-memory store, as the app runs it. */
function record(snapshot: ViewingSnapshot | null, save: (next: ViewingSnapshot) => void) {
  const layer = ViewingRecord.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ViewingStore, memoryViewingStore({ snapshot, save })),
        Layer.succeed(ViewingAccount, {
          owners: Effect.succeed([{ subscriptionId: SUB, key: SUB, original: false }]),
        }),
        Layer.succeed(ViewingChannels, { lookup: () => Effect.succeed(() => undefined) }),
        Layer.succeed(ViewingSeries, {
          identity: (series) =>
            Effect.succeed({
              key: "tmdb:601",
              keys: ["tmdb:601", `id:${series.id}`],
              versions: [series.id],
            }),
          seasons: () =>
            Effect.succeed([
              {
                number: 1,
                episodes: [1, 2, 3].map((number) => ({ id: `e1${number}`, season: 1, number })),
              },
              {
                number: 2,
                episodes: [1, 2].map((number) => ({ id: `e2${number}`, season: 2, number })),
              },
            ]),
        }),
        Layer.succeed(LegacyViewing, { take: Effect.succeed(null), drop: Effect.void }),
      ),
    ),
  );
  return <A>(use: (service: ViewingRecord["Service"]) => Effect.Effect<A, unknown>) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* ViewingRecord);
      }).pipe(Effect.provide(layer)),
    );
}

const correctness: readonly ProofCase[] = [
  {
    name: "core: on-demand index, search, collections and rows",
    compare: "same",
    run: () => {
      const index = indexCatalogue([{ subscriptionId: SUB, catalogue: CATALOGUE }], "nl");
      const movies = kindOf(index, "movie").titles;
      const made = collections({
        kind: "movie",
        titles: movies,
        language: "nl",
        metadata: (id) => {
          const known = META[id];
          return known
            ? {
                ...known,
                language: id === "504" ? "fr" : "en",
                collection: null,
                backdrop: `/b${id}.jpg`,
              }
            : null;
        },
        names: () => null,
        services: [{ id: 8, name: "Netflix", ids: new Set(["501", "503"]) }],
        now: NOW,
      });
      const like = { subscriptionId: SUB, id: "4" };
      return plain({
        movies: movies.map(shown),
        series: kindOf(index, "series").titles.map(shown),
        search: searchPage(index, "movie", "copper").titles.map((title) => title.id),
        searchTotal: searchPage(index, "movie", "lake").total,
        forYou: collectionRows(made, "for-you", like).map((each) => [
          each.id,
          each.name,
          each.total,
          each.titles.map((title) => title.id),
        ]),
        fresh: collectionRows(made, "new", null).map((each) => [each.id, each.total]),
        genres: made.genres().map((genre) => [genre.name, genre.count, genre.artwork]),
        services: made.services().map((service) => [service.name, service.count]),
        fourK: made.list("4k").map((title) => [title.id, title.tags]),
        byTitle: made.list("all", "title").map((title) => title.title),
        adult: made.list("adult").map((title) => title.id),
      });
    },
  },
  {
    name: "core: details, seasons, episodes and the version menu",
    compare: "same",
    run: () => {
      const index = indexCatalogue([{ subscriptionId: SUB, catalogue: CATALOGUE }], "en");
      const [copper] = kindOf(index, "movie").titles;
      const [kestrel] = kindOf(index, "series").titles;
      if (!copper || !kestrel) return null;
      const movie = movieDetails(
        copper,
        { ...SERIES_DETAILS, seasons: [], episodes: [], container: "mp4" },
        {
          original: "Copper Lake",
          language: "en",
          overview: "TMDB's story.",
          poster: "/p.jpg",
          backdrop: "/b.jpg",
          genres: [53],
          runtime: 112,
          cast: [{ name: "Eva Vos", character: "Mara", profile: null }],
          directors: ["Lotte Smit"],
        },
      );
      const series = seriesDetails(kestrel, SERIES_DETAILS, null, "en");
      const first = series.seasons[0];
      return plain({
        movie: [movie.plot, movie.genres, movie.duration, movie.directors, movie.backdropUrl],
        seasons: series.seasons.map((season) => [
          season.number,
          season.name,
          season.episodes.map((episode) => [episode.id, episode.number, episode.title]),
        ]),
        next: nextEpisode(series, { season: 1, episode: 3 })?.id ?? null,
        last: nextEpisode(series, { season: 2, episode: 2 }) ?? null,
        tmdbSeason: first
          ? seasonEpisodes(first, [
              [1, 2].map((number) => ({
                number,
                name: number === 2 ? null : `TMDB ${number}`,
                overview: `Story of ${number}.`,
                still: `/s${number}.jpg`,
                airDate: null,
                runtime: 48,
                rating: 8,
                cast: [],
                directors: [],
              })),
            ]).map((episode) => [episode.title, episode.stillUrl, episode.duration])
          : null,
        versions: versionOptions(copper.versions, "en", [SUB]).map((group) => [
          group.quality,
          group.label,
          group.versions.map((version) => version.id),
        ]),
      });
    },
  },
  {
    name: "core: viewing record, marks, Undo and Continue watching over the in-memory store",
    compare: "same",
    run: async () => {
      let saved: ViewingSnapshot | null = null;
      const save = (next: ViewingSnapshot) => {
        saved = JSON.parse(JSON.stringify(next)) as ViewingSnapshot;
      };
      const run = record(null, save);
      const series = { subscriptionId: SUB, id: "20" };
      const episode = (season: number, number: number) => ({
        kind: "episode" as const,
        subscriptionId: SUB,
        id: `e${season}${number}`,
        seriesId: "20",
        season,
        episode: number,
      });
      await run((r) =>
        r.recordProgress("p1", { kind: "movie", subscriptionId: SUB, id: "4" }, 600, 6000, 1),
      );
      await run((r) => r.recordProgress("p2", episode(1, 1), 2850, 2880, 2));
      await run((r) => r.recordProgress("p3", episode(1, 2), 400, 2880, 3));
      const mark = await run((r) => r.markEpisode("m1", episode(1, 3), true));
      // A launch over what was saved.
      const relaunched = record(saved, save);
      const standing = await relaunched((r) => r.episodes(series));
      const viewing = await relaunched((r) => r.state);
      const index = indexCatalogue([{ subscriptionId: SUB, catalogue: CATALOGUE }], "en");
      const details = seriesDetails(
        kindOf(index, "series").titles[0] as Title,
        SERIES_DETAILS,
        null,
        "en",
      );
      const stateOf = episodeStates(standing.progress, standing.marks);
      const goesOn = continuation(details, standing.progress, standing.marks);
      await relaunched((r) => r.undoMark("u1", series, mark?.revision ?? 0));
      const undone = await relaunched((r) => r.episodes(series));
      const entries = continueEntries(
        viewing,
        (kind, version) => byIds(index, kind, [version])[0],
        20,
      );
      return plain({
        mark: mark ? [mark.season, mark.episode, mark.watched] : null,
        undoable: standing.undoable === mark?.revision,
        states: details.seasons.flatMap((season) =>
          season.episodes.map((each) => [each.id, stateOf(each).kind]),
        ),
        goesOn: goesOn ? [goesOn.episode.id, goesOn.resume?.position ?? null, goesOn.replay] : null,
        continuing: viewing.continueWatching.map(({ title, position }) => [title.id, position]),
        entries: entries.map((entry) => [entry.title.id, entry.line, entry.done]),
        undone: undone.marks.length,
      });
    },
  },
  {
    name: "core: TMDB answers through its client and the metadata store",
    compare: "same",
    run: async () => {
      const client = tmdb({ key: "proof-key", api: "https://tmdb.proof/3", fetch: standIn });
      const details = await client.details("movie", "501", "nl");
      const about = await client.about("movie", "501", "nl");
      const season = await client.season("601", 1, "nl");
      const services = await client.services("movie", "NL");
      let file: unknown = null;
      const store = metadataStore({
        read: async () => file,
        write: async (next) => {
          file = next;
        },
        client,
        region: "NL",
        onChange: () => undefined,
      });
      store.want(
        ["501", "502", "504"].map((tmdbId, at) => ({ kind: "movie", tmdbId, addedAt: at })),
        "nl",
      );
      for (
        let tries = 0;
        tries < 200 && (store.status().known < 3 || store.status().fetching);
        tries++
      ) {
        await new Promise((done) => setTimeout(done, 25));
      }
      return plain({
        details: [details.name, details.original, details.genres, details.popularity],
        about: [about.overview, about.runtime, about.directors, about.cast.map((c) => c.name)],
        season: season.map((episode) => [episode.number, episode.name, episode.still]),
        services: services.map((service) => [service.id, service.name]),
        stored: {
          status: store.status(),
          genres: store.get("movie", "501")?.genres ?? null,
          name: store.name("movie", "504", "nl"),
          search: store.searchName("movie", "501"),
          netflix: store.services("movie").map((service) => [service.name, [...service.ids]]),
        },
      });
    },
  },
];

/** A catalogue the size large panels send: tens of thousands of rows, many sharing TMDB ids. */
function largeCatalogue(movies: number, series: number): OnDemandCatalogue {
  const words = [
    "Copper",
    "Lake",
    "Night",
    "Ferry",
    "Glass",
    "Wing",
    "Salt",
    "Meridian",
    "Kestrel",
  ];
  const rows = (count: number, offset: number) =>
    Array.from({ length: count }, (_, at) => {
      const id = offset + at;
      const language = ["NL", "EN", "DE", "FR", "MULTI"][id % 5];
      return row(
        String(id),
        `${language} | ${words[id % 9]} ${words[(id * 7) % 9]} ${id} (${2000 + (id % 25)}) [${id % 11 === 0 ? "4K" : "HD"}]`,
        {
          tmdbId: id % 13 === 0 ? null : String(100_000 + Math.floor(id / 3)),
          addedAt: NOW - (id % 900) * day * 1000,
          container: id % 3 === 0 ? "mkv" : "mp4",
        },
      );
    });
  return { ...CATALOGUE, movies: rows(movies, 1_000_000), series: rows(series, 5_000_000) };
}

/** Milliseconds `run` takes. */
function timed<A>(run: () => A): { readonly value: A; readonly ms: number } {
  const started = Date.now();
  const value = run();
  return { value, ms: Date.now() - started };
}

const measuredCases: readonly ProofCase[] = [
  {
    name: "measure: indexing 40,000 films and 10,000 series on this runtime",
    compare: "record",
    run: () => {
      const catalogue = largeCatalogue(40_000, 10_000);
      const index = timed(() => indexCatalogue([{ subscriptionId: SUB, catalogue }], "en"));
      const films = timed(() => kindOf(index.value, "movie").titles.length);
      const series = timed(() => kindOf(index.value, "series").titles.length);
      const made = timed(() =>
        collections({
          kind: "movie",
          titles: kindOf(index.value, "movie").titles,
          language: "en",
          metadata: () => null,
          names: () => null,
          services: [],
          now: NOW,
        }),
      );
      const rows = timed(() => collectionRows(made.value, "new", null).length);
      const all = timed(() => made.value.list("all").length);
      const search = timed(() => searchPage(index.value, "movie", "copper lake").total);
      const again = timed(() => searchPage(index.value, "movie", "night fer").total);
      return {
        films: films.value,
        series: series.value,
        ms: {
          index: index.ms,
          films: films.ms,
          series: series.ms,
          collections: made.ms,
          rows: rows.ms,
          all: all.ms,
          firstSearch: search.ms,
          search: again.ms,
        },
      };
    },
  },
];

export const cases: readonly ProofCase[] = [...correctness, ...measuredCases];
