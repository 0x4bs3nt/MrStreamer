import { describe, expect, it } from "vitest";
import {
  byIds,
  indexCatalogue,
  indexSteps,
  search,
  searchPage,
} from "../src/ondemand/catalogue.ts";
import { collections } from "../src/ondemand/collections.ts";
import {
  movieDetails,
  nextEpisode,
  seasonEpisodes,
  seriesDetails,
} from "../src/ondemand/details.ts";
import { suitability, versionLabels } from "../src/ondemand/languages.ts";
import { episodeName, titleName } from "../src/ondemand/names.ts";
import {
  channelSubtitle,
  renditionAudio,
  renditionSubtitles,
  type RenditionFacts,
} from "../src/ondemand/tracks.ts";
import type { OnDemandCatalogue } from "../src/provider.ts";
import { finish } from "../src/steps.ts";
import { continueWatching, isFinished, type TitleRow } from "../src/viewing/titles.ts";

/** The subscription every title of these tests is listed by. */
const SUBSCRIPTION = "subscription";

describe("title names", () => {
  it.each([
    ["Escape from New York (NL)", "Escape from New York", ["NL"], null],
    ["UNABOMBER (MULTI)", "Unabomber", ["MULTI"], null],
    ["Avatar: The Way of Water 4K (MULTI)", "Avatar: The Way of Water", ["MULTI", "4K"], null],
    ["SD Gundam Force (EN)", "SD Gundam Force", ["EN"], null],
    ["The HD Experience", "The HD Experience", [], null],
    ["Movie Full HD (NL)", "Movie", ["NL", "FHD"], null],
    ["Movie FULL-HD", "Movie", ["FHD"], null],
    ["Movie (Full HD)", "Movie", ["FHD"], null],
    ["Movie (VO)", "Movie", ["VO"], null],
    ["Movie (MULTISUB)", "Movie", ["MULTISUB"], null],
    ["Movie SD", "Movie", ["SD"], null],
    ["Some Film (NL AUDIO)", "Some Film", ["NL AUDIO"], null],
    ["Series (MULTi)", "Series", ["MULTI"], null],
    ["Movie (2019) (NL)", "Movie", ["NL"], 2019],
    ["Hamlet - 2024", "Hamlet", [], 2024],
    ["Hellboy [720p HD]", "Hellboy", ["720p", "HD"], null],
    // A bare year is often part of the title, and a title can be only a year.
    ["Wonder Woman 1984 (NL)", "Wonder Woman 1984", ["NL"], null],
    ["2012 (NL)", "2012", ["NL"], null],
  ])("reads %s", (raw, title, tags, year) => {
    expect(titleName(raw)).toEqual({ title, tags, year });
  });

  it("takes the year from the release date when the name has none", () => {
    expect(titleName("Blood Sacrifice (MULTI)", "2026-08-20").year).toBe(2026);
  });

  it("drops the series and numbers in front of an episode's own name", () => {
    expect(episodeName("Race Across the World (NL) - S02E03 - Aankomst in Tbilisi", 3)).toBe(
      "Aankomst in Tbilisi",
    );
    expect(episodeName("Blood Sacrifice (MULTI) - S01E04", 4)).toBe("Episode 4");
  });
});

describe("Continue watching", () => {
  const row = (partial: Partial<TitleRow> & Pick<TitleRow, "title" | "at">): TitleRow => ({
    position: 600,
    duration: 6000,
    finished: false,
    hidden: false,
    removedAt: null,
    since: partial.at,
    ...partial,
  });

  it("counts the credits as the end, and leaves short titles some of their end", () => {
    expect(isFinished(5700, 6000)).toBe(true);
    expect(isFinished(5600, 6000)).toBe(false);
    expect(isFinished(575, 600)).toBe(true);
    expect(isFinished(560, 600)).toBe(false);
  });

  it("shows each series once, as the episode watched last", () => {
    const episode = (id: string, season: number, number: number) =>
      ({ kind: "episode", id, seriesId: "s", season, episode: number }) as const;
    const shown = continueWatching([
      row({ title: episode("e1", 1, 1), at: 1, finished: true, position: 6000 }),
      row({ title: episode("e2", 1, 2), at: 3 }),
      row({ title: { kind: "movie", id: "m" }, at: 2 }),
    ]);
    expect(shown.map((entry) => entry.title.id)).toEqual(["e2", "m"]);
  });
});

/** The catalogue one subscription's lists make. */
const indexOf = (catalogue: OnDemandCatalogue, language: string) =>
  indexCatalogue([{ subscriptionId: SUBSCRIPTION, catalogue }], language);

describe("one title per film", () => {
  const movie = (id: string, name: string, tmdbId: string | null, addedAt: number) => ({
    id,
    name,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt,
    releaseDate: null,
    categoryIds: ["films"],
    adult: false,
    container: "mkv",
    tmdbId,
  });
  const catalogue = {
    movieCategories: [{ id: "films", name: "Films" }],
    movies: [
      movie("1", "Speak No Evil (NL)", "1114513", 3),
      movie("2", "Speak No Evil (MULTI)", "1114513", 2),
      movie("3", "Speak No Evil 2024 (DE)", "1114513", 4),
      movie("4", "Blow (NL)", null, 1),
    ],
    seriesCategories: [],
    series: [],
  };
  const listed = (language: string) =>
    indexOf(catalogue, language).movies.titles.map((title) => [
      title.id,
      title.versions.map((version) => version.id),
    ]);

  it("keeps each version's original label, file type and added date beside its own id", () => {
    const title = byIds(indexOf(catalogue, "en"), "movie", [
      { subscriptionId: SUBSCRIPTION, id: "1" },
    ])[0];
    expect(
      title?.versions.map(({ id, name, container, addedAt }) => ({ id, name, container, addedAt })),
    ).toEqual([
      { id: "2", name: "Speak No Evil (MULTI)", container: "mkv", addedAt: 2 },
      { id: "1", name: "Speak No Evil (NL)", container: "mkv", addedAt: 3 },
      { id: "3", name: "Speak No Evil 2024 (DE)", container: "mkv", addedAt: 4 },
    ]);
    expect(title?.versions.every((version) => version.observed === undefined)).toBe(true);
  });

  it("gathers the versions sharing a TMDB id, the one suiting the language first", () => {
    expect(listed("en")).toEqual([
      ["2", ["2", "1", "3"]],
      ["4", ["4"]],
    ]);
    expect(listed("nl")).toEqual([
      ["1", ["1", "2", "3"]],
      ["4", ["4"]],
    ]);
  });

  it("shows titles in the viewer's language, or subtitled, but not dubbed into another", () => {
    const films = {
      ...catalogue,
      movies: [
        movie("10", "Fright Night 2 (DE)", "100", 1),
        movie("11", "Fright Night (NL)", "101", 1),
        movie("12", "De Bondgenoten (NL)", "102", 1),
        movie("13", "Das Boot (MULTI)", "103", 1),
        movie("14", "Blow", "104", 1),
      ],
    };
    const madeIn: Record<string, string> = { "100": "en", "101": "en", "102": "nl", "103": "de" };
    const shown = (language: string) =>
      collections({
        kind: "movie",
        titles: indexOf(films, language).movies.titles,
        language,
        names: () => null,
        metadata: (tmdbId) => ({
          genres: [18],
          language: madeIn[tmdbId] ?? null,
          popularity: 1,
          rating: 7,
          votes: 10,
          collection: null,
          backdrop: null,
        }),
        services: [],
        now: 0,
      })
        .list("genre:Drama", "title")
        .map((title) => title.id);
    expect(shown("en")).toEqual(["14", "13", "11"]);
    expect(shown("nl")).toEqual(["14", "13", "12", "11"]);
  });

  it("keeps original and multiple-subtitle versions in unfiltered curated lists", () => {
    const films = {
      ...catalogue,
      movies: [
        movie("vo", "Amelie (VO)", "100", 1),
        movie("subs", "Parasite (MULTI SUB)", "101", 1),
        movie("plain", "Parasite", "101", 2),
        movie("english", "Heat (EN)", "102", 1),
      ],
    };
    const titles = indexOf(films, "en").movies.titles;
    const shown = collections({
      kind: "movie",
      titles,
      language: "en",
      names: () => null,
      metadata: () => ({
        genres: [18],
        language: "fr",
        popularity: 1,
        rating: 8,
        votes: 1000,
        collection: null,
        backdrop: null,
      }),
      services: [],
      now: 0,
    });
    expect(shown.list("popular", "title").map((title) => title.id)).toEqual([
      "vo",
      "english",
      "subs",
    ]);
    expect(titles.find((title) => title.tmdbId === "101")?.id).toBe("subs");
  });

  it("keeps a film when one of its versions is for adults", () => {
    const films = {
      ...catalogue,
      movies: [
        movie("20", "Wicked (NL)", "300", 1),
        { ...movie("21", "Wicked", "300", 2), adult: true },
      ],
    };
    const titles = indexOf(films, "en").movies.titles;
    expect(titles.map((title) => [title.id, title.adult])).toEqual([
      ["20", false],
      ["21", true],
    ]);
    // Only the collection for adults holds the adult row.
    const made = collections({
      kind: "movie",
      titles,
      language: "en",
      metadata: () => null,
      names: () => null,
      services: [],
      now: 0,
    });
    expect(made.list("all").map((title) => title.id)).toEqual(["20"]);
    expect(made.list("adult").map((title) => title.id)).toEqual(["21"]);
  });

  it.each([
    // "(NL)" keeps the film's own sound, so it beats an unmarked version, which may be a dub.
    ["en", ["41", "40", "42"]],
    ["nl", ["42", "41", "40"]],
  ])("prefers a version with its own sound for %s", (language, order) => {
    const films = {
      ...catalogue,
      movies: [
        movie("40", "Sessiz Bir Yer", "400", 9),
        movie("41", "A Quiet Place (NL)", "400", 1),
        movie("42", "A Quiet Place (NL AUDIO)", "400", 10),
      ],
    };
    const [title] = indexOf(films, language).movies.titles;
    expect(title?.versions.map((version) => version.id)).toEqual(order);
  });

  it("counts a film as new or in 4K only by versions the viewer would watch", () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 9, 1);
    const films = {
      ...catalogue,
      movies: [
        movie("30", "Heat (MULTI)", "600", now - 90 * day),
        movie("31", "Heat 4K (DE)", "600", now - day),
        movie("32", "Alien (MULTI)", "601", now - 10 * day),
        movie("33", "Alien 4K (MULTI)", "601", now - 90 * day),
      ],
    };
    const made = collections({
      kind: "movie",
      titles: indexOf(films, "en").movies.titles,
      language: "en",
      metadata: () => null,
      names: () => null,
      services: [],
      now,
    });
    expect(made.list("new-week")).toEqual([]);
    // Opening it opens the 4K version.
    expect(made.list("4k").map((title) => title.id)).toEqual(["33"]);
  });

  it("keeps warm lists stable only until the next rolling, year or metadata cutoff", () => {
    const day = 86_400_000;
    const now = Date.UTC(2026, 11, 31, 12);
    const titles = indexOf(
      { ...catalogue, movies: [movie("1", "Film (MULTI)", "1", now - 6 * day)] },
      "en",
    ).movies.titles;
    const make = (at: number, expiry = Infinity) =>
      collections({
        kind: "movie",
        titles,
        language: "en",
        metadata: () => null,
        names: () => null,
        services: [],
        now: at,
        expiresAt: () => expiry,
      });
    const made = make(now);
    expect(made.validAt(now)).toBe(true);
    expect(made.validAt(now - 1)).toBe(false);
    expect(made.list("new-week")).toBe(made.list("new-week"));
    expect(made.validAt(Date.UTC(2027, 0, 1) - 1)).toBe(true);
    expect(made.validAt(Date.UTC(2027, 0, 1))).toBe(false);
    const afterYear = make(Date.UTC(2027, 0, 1));
    expect(afterYear.validAt(now + day - 1)).toBe(true);
    expect(afterYear.validAt(now + day)).toBe(false);
    const expires = make(now, now + 1000);
    expect(expires.validAt(now + 999)).toBe(true);
    expect(expires.validAt(now + 1000)).toBe(false);
    // Expired or absent metadata does not force a rebuild on every offline read.
    expect(make(now, now - 1).validAt(now)).toBe(true);
  });

  it("finds the title by any of its versions, and by any version's name", () => {
    const index = indexOf(catalogue, "en");
    const third = { subscriptionId: SUBSCRIPTION, id: "3" };
    expect(byIds(index, "movie", [third]).map((title) => title.id)).toEqual(["2"]);
    // The same id in another subscription's lists is another film, or none.
    expect(byIds(index, "movie", [{ ...third, subscriptionId: "another" }])).toEqual([]);
    expect(search(index, "movie", "speak").map((title) => title.id)).toEqual(["2"]);
  });
});

describe("a search that returns the best titles of many matches", () => {
  // Starting with the query ranks first, a word starting with it second, inside a word last (Backstory);
  // dates repeat, so ties are common and must stay in the lists' order.
  const frames = [
    (n: number) => `Story ${n}`,
    (n: number) => `The story ${n}`,
    (n: number) => `Backstory ${n}`,
  ];
  const rows = Array.from({ length: 700 }, (_, at) => ({
    id: String(at),
    name: frames[at % 3]!(at),
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: (at * 7) % 5,
    releaseDate: null,
    categoryIds: [],
    adult: at % 50 === 0,
    container: "mkv",
  }));
  const index = indexOf(
    { movieCategories: [], movies: rows, seriesCategories: [], series: [] },
    "en",
  );
  const best = rows
    .filter((row) => !row.adult)
    .map((row, order) => ({ row, order, rank: (Number(row.id) % 3) as number }))
    .sort((a, b) => a.rank - b.rank || b.row.addedAt - a.row.addedAt || a.order - b.order)
    .map(({ row }) => row.id);

  it.each([1, 60, 300])("returns the best %i in order and counts every match", (limit) => {
    const page = searchPage(index, "movie", "story", undefined, limit);
    expect(page.titles.map((title) => title.id)).toEqual(best.slice(0, limit));
    expect(page.total).toBe(best.length);
    expect(search(index, "movie", "story", undefined, limit).map((title) => title.id)).toEqual(
      best.slice(0, limit),
    );
  });

  it("keeps every match when asked for more than there are", () => {
    const page = searchPage(index, "movie", "story", undefined, Infinity);
    expect(page.titles.map((title) => title.id)).toEqual(best);
    expect(page.total).toBe(best.length);
  });

  it("counts matches without returning any when nothing is asked for", () => {
    expect(searchPage(index, "movie", "story", undefined, 0)).toEqual({
      titles: [],
      total: best.length,
    });
    expect(searchPage(index, "movie", "nothing like it")).toEqual({ titles: [], total: 0 });
  });
});

describe("one title per film across subscriptions", () => {
  const row = (id: string, name: string, tmdbId: string | null, addedAt = 1, adult = false) => ({
    id,
    name,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt,
    releaseDate: null,
    categoryIds: ["films"],
    adult,
    container: "mkv",
    tmdbId,
  });
  const lists = (movies: readonly ReturnType<typeof row>[]): OnDemandCatalogue => ({
    movieCategories: [{ id: "films", name: "Films" }],
    movies,
    seriesCategories: [],
    series: movies,
  });
  // Two providers that number their films alike: every id is taken twice.
  const sources = [
    {
      subscriptionId: "a",
      catalogue: lists([
        row("1", "Blow (EN)", "100", 5),
        row("2", "Heat 1995", "200"),
        row("3", "Casino (EN)", null),
        row("4", "Wicked", "300", 1, true),
      ]),
    },
    {
      subscriptionId: "b",
      catalogue: lists([
        row("1", "Heat 1995 (NL)", null),
        row("2", "Blow 4K (EN)", "100", 9),
        row("3", "Casino (EN)", null),
        row("4", "Wicked", "300"),
      ]),
    },
  ];
  const shown = (language = "en", kind: "movies" | "series" = "movies") =>
    indexCatalogue(sources, language)[kind].titles.map((title) => [
      title.key,
      `${title.subscriptionId}:${title.id}`,
      title.versions.map((version) => `${version.subscriptionId}:${version.id}`),
      title.ambiguous ?? false,
    ]);

  it("gathers a film's versions by its TMDB id, whichever subscription lists them and under whatever id", () => {
    expect(shown()).toEqual([
      // Listed by both, under other ids: one title, the newer version of equals first.
      ["movie:tmdb:100", "b:2", ["b:2", "a:1"], false],
      // The same name and year, and no TMDB id to say it is the same film: two titles.
      ["movie:tmdb:200", "a:2", ["a:2"], true],
      ["movie:a:3", "a:3", ["a:3"], true],
      // For adults in one of them: it stays apart, and the other's stays what it was.
      ["movie:a:4", "a:4", ["a:4"], false],
      ["movie:b:1", "b:1", ["b:1"], true],
      ["movie:b:3", "b:3", ["b:3"], true],
      ["movie:tmdb:300", "b:4", ["b:4"], false],
    ]);
  });

  it("indexes in steps, both kinds at once, what it indexes as each kind is read", () => {
    for (const language of ["en", "nl"]) {
      for (const from of [sources, sources.toReversed()]) {
        const read = indexCatalogue(from, language);
        const stepped = finish(indexSteps(from, language));
        for (const kind of ["movies", "series"] as const) {
          expect(stepped[kind].titles).toEqual(read[kind].titles);
          expect([...stepped[kind].byId]).toEqual([...read[kind].byId]);
        }
        expect(search(stepped, "movie", "casino")).toEqual(search(read, "movie", "casino"));
      }
    }
  });

  it("never joins a movie and a series that share a TMDB id", () => {
    expect(shown("en", "series").map(([key]) => key)).toContain("series:tmdb:100");
    expect(shown().map(([key]) => key)).toContain("movie:tmdb:100");
  });

  it("names a title the same whichever version shows first, and whoever else lists it", () => {
    const keysOf = (from: typeof sources, language: string) =>
      indexCatalogue(from, language).movies.titles.map((title) => title.key);
    const alone = keysOf(sources.slice(0, 1), "en");

    // Another subscription's lists arriving changes no title's name, only which version shows.
    expect(keysOf(sources, "nl").filter((key) => alone.includes(key))).toEqual(alone);
    expect(keysOf(sources.toReversed(), "en").toSorted()).toEqual(keysOf(sources, "en").toSorted());
  });

  it("finds a title by a version of either subscription, and marks nothing with one alone", () => {
    const index = indexCatalogue(sources, "en");
    const found = (subscriptionId: string, id: string) =>
      byIds(index, "movie", [{ subscriptionId, id }]).map((title) => title.key);

    expect(found("a", "1")).toEqual(["movie:tmdb:100"]);
    expect(found("b", "2")).toEqual(["movie:tmdb:100"]);
    // The same id in the other one's lists is another film.
    expect(found("b", "1")).toEqual(["movie:b:1"]);
    // One subscription alone lists nothing a name could be mistaken for.
    const [alone] = sources;
    expect(
      indexCatalogue(alone ? [alone] : [], "en").movies.titles.some((title) => title.ambiguous),
    ).toBe(false);
    expect(search(index, "movie", "blow").map((title) => title.versions.length)).toEqual([2]);
  });
});

describe("subtitles a channel starts with", () => {
  const sound = (language: string) => ({ id: 1, language, label: language, default: true });
  const subtitles = (language: string, forced = false) => ({
    id: 2,
    page: 888,
    format: "teletext" as const,
    language,
    label: language,
    forced,
    default: false,
  });

  it.each([
    ["in the remembered language, where the channel speaks another", ["en"], "nl", "nl"],
    ["none on a channel that speaks it: those are for the hard of hearing", ["nl"], "nl", null],
    ["none on a channel with a sound track in it among others", ["en", "nl"], "dut", null],
    ["none when turned off", ["en"], "off", null],
    ["none when never chosen", ["en"], null, null],
  ])("%s", (_, audio, remembered, language) => {
    const tracks = { audio: audio.map(sound), subtitles: [subtitles("nl")], playing: 1 };

    expect(channelSubtitle(tracks, remembered)?.language ?? null).toBe(language);
  });

  it("prefers full subtitles to forced ones", () => {
    const tracks = {
      audio: [sound("en")],
      subtitles: [subtitles("nl", true), subtitles("nl")],
      playing: 1,
    };

    expect(channelSubtitle(tracks, "nl")?.forced).toBe(false);
  });
});

describe("an HLS stream's tracks", () => {
  const rendition = (id: number, facts: Partial<RenditionFacts> = {}): RenditionFacts => ({
    id,
    name: null,
    language: null,
    default: false,
    forced: false,
    accessible: false,
    ...facts,
  });

  it("names sound by the stream's own names, by language where a name is only a code, else by its place", () => {
    const tracks = renditionAudio([
      rendition(4, { name: "Director's commentary", language: "en" }),
      rendition(5, { name: "eng", language: "ENG", default: true }),
      rendition(6, { name: "DE" }),
      rendition(7, { name: "  ", language: "fra", accessible: true }),
      rendition(8),
      // A word of three letters that names no language stays the stream's name for it.
      rendition(9, { name: "HQ", language: "en" }),
    ]);

    expect(tracks).toEqual([
      { id: 4, language: "en", label: "Director's commentary", default: false },
      { id: 5, language: "en", label: "English", default: true },
      { id: 6, language: "de", label: "Deutsch", default: false },
      { id: 7, language: "fr", label: "Français · Audio description", default: false },
      { id: 8, language: null, label: "Track 5", default: false },
      { id: 9, language: "en", label: "HQ", default: false },
    ]);
  });

  it("tells subtitles from captions of the same name, and numbers those that still read the same", () => {
    const text = { page: null, format: "text" as const };
    const captions = (channel: number) => ({ page: channel, format: "captions" as const });
    const tracks = renditionSubtitles([
      { ...rendition(0, { name: "English", language: "en" }), ...text },
      { ...rendition(1, { name: "nld", forced: true }), ...text },
      { ...rendition(2, { language: "nl", accessible: true }), ...text },
      { ...rendition(3), ...text },
      { ...rendition(-1, { name: "English", language: "en" }), ...captions(1) },
      { ...rendition(-1), ...captions(2) },
      { ...rendition(-1), ...captions(3) },
    ]);

    expect(tracks.map((track) => [track.label, track.id, track.page, track.format])).toEqual([
      ["English · Text", 0, null, "text"],
      ["Nederlands · Forced", 1, null, "text"],
      ["Nederlands · SDH", 2, null, "text"],
      ["Track 4", 3, null, "text"],
      ["English · Captions", -1, 1, "captions"],
      ["Captions · 1", -1, 2, "captions"],
      ["Captions · 2", -1, 3, "captions"],
    ]);
    expect(tracks.map((track) => track.language)).toEqual([
      "en",
      "nl",
      "nl",
      null,
      "en",
      null,
      null,
    ]);
    expect(tracks[1]?.forced).toBe(true);
  });
});

describe("version labels", () => {
  it("say what each version of a film sounds like and subtitles, as its marks put it", () => {
    const names = [
      "Night Harbour 4K (EN)",
      "Night Harbour 1080p (NL AUDIO)",
      "Night Harbour (DE-DUBBED)",
      "Night Harbour 720p (MULTI)",
      "Night Harbour (NL)",
      "Night Harbour (AR)",
      "Night Harbour",
    ];

    expect(
      versionLabels(
        names.map((name) => titleName(name)),
        "en",
      ),
    ).toEqual([
      "English sound · 4K",
      "Nederlands sound · 1080p",
      "Deutsch sound",
      "Several languages · 720p",
      "English sound, Nederlands subtitles",
      "AR",
      "Standard",
    ]);
  });

  it.each([
    ["English", "en", "English sound, Nederlands subtitles"],
    ["Dutch, so (NL) is its own sound", "nl", "Nederlands sound"],
    ["a language TMDB hasn't said", null, "Original sound, Nederlands subtitles"],
  ])("read (NL) on a title made in %s", (_, madeIn, label) => {
    expect(versionLabels([{ tags: ["NL"] }], madeIn)).toEqual([label]);
  });

  it("read a mark for subtitles as the title's own sound, whatever the language", () => {
    const tags = titleName("Squid Game (ENG SUB)").tags;

    expect(versionLabels([{ tags }], "ko")).toEqual(["한국어 sound, English subtitles"]);
    // It suits English viewers, and isn't dubbed for German ones.
    expect(suitability(tags, "en")).toBe(4);
    expect(suitability(tags, "de")).toBe(suitability(["NL"], "de"));
  });

  it("numbers versions that read the same", () => {
    expect(versionLabels([{ tags: ["DE"] }, { tags: ["DE"] }, { tags: [] }], "en")).toEqual([
      "Deutsch sound",
      "Deutsch sound 2",
      "Standard",
    ]);
  });
});

describe("details", () => {
  const title = {
    kind: "movie" as const,
    key: `movie:${SUBSCRIPTION}:1`,
    subscriptionId: SUBSCRIPTION,
    id: "1",
    name: "Blow 1080p (NL AUDIO)",
    title: "Blow",
    originalTitle: null,
    originalLanguage: null,
    tags: ["NL AUDIO", "1080p"],
    year: 2001,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "1", tags: ["NL AUDIO", "1080p"] }],
  };
  const provider = {
    originalName: null,
    plot: null,
    genres: [],
    cast: [],
    directors: [],
    releaseDate: null,
    duration: null,
    posterUrl: null,
    backdropUrl: null,
    seasons: [],
    episodes: [],
    container: null,
  };
  const about = {
    original: null,
    language: null,
    overview: null,
    poster: null,
    backdrop: null,
    genres: [],
    runtime: null,
    cast: [],
    directors: [],
  };
  /** A season of one episode, which the provider says lasts `duration` seconds. */
  const season = (duration: number | null) => ({
    number: 1,
    name: "Season 1",
    posterUrl: null,
    episodes: [
      {
        subscriptionId: SUBSCRIPTION,
        id: "10",
        seriesId: "s1",
        season: 1,
        number: 1,
        title: "Pilot",
        plot: null,
        duration,
        stillUrl: null,
        airDate: null,
      },
    ],
  });
  /** What TMDB says of that episode in one language, lasting `runtime` minutes. */
  const episodeAbout = (runtime: number | null) => ({
    number: 1,
    name: null,
    overview: null,
    still: null,
    airDate: null,
    runtime,
    rating: null,
    cast: [],
    directors: [],
  });

  it.each([
    [
      "not the provider's, when it is the version's name with marks",
      "Blow 1080p (NL AUDIO)",
      undefined,
      null,
    ],
    ["not the provider's, when it is the shown name in capitals", "BLOW", undefined, null],
    [
      "the provider's, when it is another name",
      "Blow: Het Verhaal",
      undefined,
      "Blow: Het Verhaal",
    ],
    ["TMDB's, when TMDB answered", "Blow: Het Verhaal", "Blow Up", "Blow Up"],
    ["none, when TMDB answered with the shown name", "Blow: Het Verhaal", "Blow", null],
  ])("show as the original title %s", (_, originalName, tmdbOriginal, shown) => {
    const details = movieDetails(
      title,
      { ...provider, originalName },
      tmdbOriginal === undefined ? null : { ...about, original: tmdbOriginal },
    );

    expect(details.originalTitle).toBe(shown);
  });

  it.each([
    // A panel that says three minutes of a two-hour film.
    ["TMDB's runtime, whatever the provider says", 180, 120, 7200],
    ["TMDB's runtime, when the provider says none", null, 120, 7200],
    ["the provider's, when TMDB has none", 180, null, 180],
    ["the provider's, when TMDB says zero", 180, 0, 180],
    ["the provider's, when TMDB says less than nothing", 180, -120, 180],
    ["the provider's, when TMDB's is no number", 180, Number.NaN, 180],
    ["the provider's, when TMDB's has no end", 180, Number.POSITIVE_INFINITY, 180],
    ["none, when neither says", null, null, null],
  ])("show as a film's and an episode's length %s", (_, duration, runtime, shown) => {
    const film = movieDetails(title, { ...provider, duration }, { ...about, runtime });
    const [episode] = seasonEpisodes(season(duration), [[episodeAbout(runtime)]]);

    expect(film.duration).toBe(shown);
    expect(episode?.duration).toBe(shown);
  });

  it("show the provider's length while TMDB hasn't answered", () => {
    expect(movieDetails(title, { ...provider, duration: 180 }).duration).toBe(180);
    expect(seasonEpisodes(season(180), [])[0]?.duration).toBe(180);
  });

  it("take an episode's runtime from the first language TMDB answered with one", () => {
    const [episode] = seasonEpisodes(season(180), [
      [episodeAbout(null)],
      [episodeAbout(0)],
      [episodeAbout(50)],
    ]);

    expect(episode?.duration).toBe(3000);
  });
});

/** A Dutch version of a series whose provider lists these files, as `seriesDetails` shows it. */
function seriesOf(
  files: readonly (readonly [
    id: string,
    season: number,
    number: number,
    name: string,
    addedAt?: number,
  ])[],
  language = "en",
  sourceOrder = false,
) {
  return seriesDetails(
    {
      kind: "series",
      key: `series:${SUBSCRIPTION}:s1`,
      subscriptionId: SUBSCRIPTION,
      id: "s1",
      name: "Harbour Lights (NL)",
      title: "Harbour Lights",
      originalTitle: null,
      originalLanguage: null,
      tags: ["NL"],
      year: 2024,
      posterUrl: null,
      backdropUrl: null,
      rating: null,
      addedAt: null,
      adult: false,
      tmdbId: null,
      genres: [],
      versions: [{ subscriptionId: SUBSCRIPTION, id: "s1", tags: ["NL"] }],
    },
    {
      originalName: null,
      plot: null,
      genres: [],
      cast: [],
      directors: [],
      releaseDate: null,
      duration: null,
      posterUrl: null,
      backdropUrl: null,
      seasons: [],
      episodes: files.map(([id, season, number, name, addedAt]) => ({
        id,
        season,
        number,
        name,
        plot: null,
        duration: null,
        stillUrl: null,
        airDate: null,
        addedAt: addedAt ?? null,
        container: "mkv",
      })),
      container: null,
      ...(sourceOrder ? { episodeOrder: "source" as const } : {}),
    },
    null,
    language,
  );
}

describe("a series' episodes", () => {
  it("keeps exact alternate file dates in the provider contract's milliseconds", () => {
    const addedAt = Date.UTC(2024, 2, 5);
    const series = seriesOf(
      [
        ["first", 1, 1, "Harbour S01E01 HD", addedAt],
        ["second", 1, 1, "Harbour S01E01 4K", addedAt + 1000],
      ],
      "en",
      true,
    );
    expect(series.seasons[0]?.episodes[0]?.versions?.map((file) => file.addedAt)).toEqual([
      addedAt,
      addedAt + 1000,
    ]);
  });

  it.each([
    [
      "the newest of two files",
      [
        ["10", 1, 1, "Harbour Lights - S01E01 - Pilot", 100],
        ["11", 1, 1, "Harbour Lights - S01E01 - Pilot", 200],
      ],
      "11",
    ],
    [
      "the newest of two files, listed first",
      [
        ["11", 1, 1, "Harbour Lights - S01E01 - Pilot", 200],
        ["10", 1, 1, "Harbour Lights - S01E01 - Pilot", 100],
      ],
      "11",
    ],
    [
      "the file in the viewer's language over a newer dub",
      [
        ["10", 1, 1, "Harbour Lights - S01E01 - Pilot (EN)", 100],
        ["11", 1, 1, "Harbour Lights - S01E01 - Pilot (DE)", 200],
      ],
      "10",
    ],
  ] as const)("show one row per episode: %s", (_, files, shown) => {
    const series = seriesOf([...files, ["20", 1, 2, "Harbour Lights - S01E02 - Ashore"]]);

    expect(
      series.seasons.flatMap((season) =>
        season.episodes.map((episode) => [episode.id, episode.number]),
      ),
    ).toEqual([
      [shown, 1],
      ["20", 2],
    ]);
    expect(
      series.seasons.flatMap((season) => season.episodes).every((episode) => !episode.versions),
    ).toBe(true);
  });
});

describe("the next episode", () => {
  // The provider's rows in another order, with ids and names that sort differently from its
  // season and episode numbers, specials, and a second file of S1 E2.
  const series = seriesOf([
    ["900", 2, 1, "A Second Season"],
    ["100", 1, 3, "Zebra"],
    ["300", 0, 1, "Behind the Scenes"],
    ["700", 1, 1, "Pilot"],
    ["200", 1, 2, "Middle"],
    ["201", 1, 2, "Middle"],
    ["800", 2, 2, "Finale"],
    ["301", 0, 2, "Bloopers"],
  ]);

  it.each([
    ["the next number in the season", "700", 1, 1, "200"],
    ["the one after, from a file of the same episode the series doesn't show", "201", 1, 2, "100"],
    ["into the next season", "100", 1, 3, "900"],
    ["found by season and number when the id is gone", "gone", 1, 3, "900"],
    ["nothing after the last season, specials aside", "800", 2, 2, null],
    ["only specials after a special", "300", 0, 1, "301"],
    ["nothing after the last special", "301", 0, 2, null],
    ["unknown for an episode the series doesn't list", "gone", 3, 1, undefined],
  ])("is %s", (_, id, season, episode, next) => {
    const found = nextEpisode(series, { id, season, episode });
    expect(found ? found.id : found).toBe(next);
  });
});
