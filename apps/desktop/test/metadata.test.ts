import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey } from "@mrstreamer/contracts/subscription";
import { tmdb as tmdbClient } from "@mrstreamer/core/metadata/tmdb";
import { metadataStore, type Wanted } from "../src/main/ondemand/metadata.ts";
import type { WorkerEvent, WorkerRequest } from "../src/main/ondemand/protocol.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { startFakeTmdb, tmdbName, type FakeTmdb } from "./fake-tmdb.ts";
import {
  collect,
  fakeProvider,
  promised,
  runtimeFor,
  tempDir,
  testConfig,
  type Promised,
} from "./support.ts";

let tmdb: FakeTmdb | null = null;
afterEach(async () => {
  await tmdb?.close();
  tmdb = null;
});

/** A movie of the lists that TMDB knows. */
async function knownMovie(onDemand: Promised<OnDemand["Service"]>): Promise<Title> {
  const { titles } = await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 50 });
  const movie = titles.find((title) => title.tmdbId);
  if (!movie) throw new Error("The lists have no movie with a TMDB id.");
  return movie;
}

/**
 * The app with a TMDB key, against the fake provider and a fake TMDB. Its first start saves the
 * provider's subscription. `own` names a title of that subscription by the provider's id. The
 * provider lists a few dozen titles, as TMDB is asked about each at 40 a second.
 */
async function metadataApp(key: string | null = "test-key") {
  const fake = await startFakeTmdb();
  tmdb = fake;
  const dataDir = await tempDir();
  const provider = await fakeProvider({ titles: 30 });
  let subscriptionId = "";
  const start = async () => {
    const runtime = runtimeFor(
      mainLayer({ ...testConfig(dataDir), tmdbKey: key, tmdbApi: fake.url }),
    );
    if (!subscriptionId) {
      const subscriptions = await promised(runtime, Subscriptions);
      ({ id: subscriptionId } = await subscriptions.add({
        server: provider.url,
        username: "demo",
        password: "demo",
      }));
    }
    const onDemand = await promised(runtime, OnDemand);
    // Any list loads the catalogue, and with it the metadata.
    await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 10 });
    return { runtime, onDemand };
  };
  const own = (id: string) => ({ subscriptionId, id });
  return { start, tmdb: fake, own };
}

describe("TMDB metadata", { timeout: 30_000 }, () => {
  it("asks TMDB about each listed title once, and keeps what it said across restarts", async () => {
    const app = await metadataApp();
    const first = await app.start();
    await vi.waitFor(
      async () => {
        const { metadata } = await first.onDemand.status();
        expect(metadata?.wanted).toBeGreaterThan(0);
        expect(metadata?.known).toBe(metadata?.wanted);
      },
      { timeout: 20_000 },
    );
    const asked = app.tmdb.detailRequests();
    expect(asked).toBe((await first.onDemand.status()).metadata?.wanted);
    await first.runtime.dispose();

    const again = await app.start();
    const { metadata } = await again.onDemand.status();
    expect(metadata?.known).toBe(metadata?.wanted);
    expect(app.tmdb.detailRequests()).toBe(asked);
  });

  it("asks TMDB about titles for adults only while Settings shows them", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const asked = async (wanted: number) =>
      vi.waitFor(
        async () => {
          const { metadata } = await onDemand.status();
          expect(metadata).toMatchObject({ wanted, known: wanted });
        },
        { timeout: 20_000 },
      );
    await vi.waitFor(async () =>
      expect((await onDemand.status()).metadata?.wanted).toBeGreaterThan(0),
    );
    const ordinary = (await onDemand.status()).metadata?.wanted ?? 0;
    await asked(ordinary);
    expect(app.tmdb.detailRequests()).toBe(ordinary);

    await (await promised(runtime, Settings)).update({ adultTitles: true });
    const forAdults = (
      await Promise.all(
        (["movie", "series"] as const).map((kind) =>
          onDemand.collection({ kind, id: "adult", offset: 0, limit: 1000 }),
        ),
      )
    ).flatMap((page) => page.titles.filter((title) => title.tmdbId));
    expect(forAdults.length).toBeGreaterThan(0);
    await asked(ordinary + forAdults.length);
    expect(app.tmdb.detailRequests()).toBe(ordinary + forAdults.length);
  });

  it("keeps the viewer's adult policy when details read the current catalogue stamp", async () => {
    const provider = await fakeProvider({ titles: 5 });
    const config = testConfig(await tempDir());
    const adults: boolean[] = [];
    const runtime = runtimeFor(
      mainLayer({
        ...config,
        catalogueWorker: (setup) => {
          const worker = config.catalogueWorker(setup);
          const postMessage = worker.postMessage.bind(worker);
          worker.postMessage = (request: WorkerRequest) => {
            if (request.method === "status") adults.push(request.args.adults);
            postMessage(request);
          };
          return worker;
        },
      }),
    );
    try {
      await (
        await promised(runtime, Subscriptions)
      ).add({
        server: provider.url,
        username: "demo",
        password: "demo",
      });
      const onDemand = await promised(runtime, OnDemand);
      const movie = await knownMovie(onDemand);
      const settings = await promised(runtime, Settings);
      for (const shown of [true, false]) {
        await settings.update({ adultTitles: shown });
        adults.length = 0;
        await onDemand.details("movie", movie);
        expect(adults.length).toBeGreaterThan(0);
        expect(adults.every((value) => value === shown)).toBe(true);
      }
    } finally {
      await runtime.dispose();
      await provider.close();
    }
  });

  it("stops asking when TMDB refuses the key, and says so", async () => {
    const app = await metadataApp();
    app.tmdb.refuse(true);
    const { onDemand } = await app.start();
    await vi.waitFor(async () =>
      expect((await onDemand.status()).metadata).toMatchObject({ known: 0, refused: true }),
    );
  });

  it("builds genres, streaming services and rows from it, in the viewer's language", async () => {
    const app = await metadataApp();
    // Netflix streams the first generated films; their TMDB ids are their ids plus 10,000.
    app.tmdb.stream(
      "movie",
      Array.from({ length: 30 }, (_, index) => String(101_000 + index)),
    );
    const { onDemand } = await app.start();
    await vi.waitFor(
      async () => expect(await onDemand.tiles("movie", "services")).not.toEqual([]),
      { timeout: 25_000 },
    );

    const genres = await onDemand.tiles("movie", "genres");
    expect(genres.map((genre) => genre.name).sort()).toEqual(["Comedy", "Drama"]);
    const comedy = await onDemand.collection({
      kind: "movie",
      id: "genre:Comedy",
      offset: 0,
      limit: 500,
    });
    expect(comedy.titles.length).toBeGreaterThan(0);
    expect(comedy.titles.every((title) => title.genres.includes("Comedy"))).toBe(true);

    // Films made in Dutch with only a Dutch version: out of the English rows, but in All.
    const all = await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 500 });
    const dutch = all.titles.filter(
      (title) => Number(title.tmdbId) % 3 === 0 && title.tags.includes("NL"),
    );
    expect(dutch.length).toBeGreaterThan(0);
    const shown = new Set(
      [
        ...comedy.titles,
        ...(await onDemand.collection({ kind: "movie", id: "genre:Drama", offset: 0, limit: 500 }))
          .titles,
      ].map((title) => title.id),
    );
    expect(dutch.some((title) => shown.has(title.id))).toBe(false);

    const services = await onDemand.tiles("movie", "services");
    expect(services).toEqual([expect.objectContaining({ name: "Netflix" })]);
    const rows = await onDemand.rows("movie", "for-you");
    expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining(["Popular", "Netflix"]));

    // For you leads with titles like one watched lately, named by one of its versions.
    const [watched] = comedy.titles;
    if (!watched) throw new Error("No comedy to be like.");
    const [alike] = await onDemand.rows("movie", "for-you", ownedId(watched));
    expect(alike).toMatchObject({
      id: `like:${ownedKey(watched)}`,
      name: `More like ${watched.title}`,
    });
    expect(alike?.titles.some((title) => title.id === watched.id)).toBe(false);
    const page = await onDemand.collection({
      kind: "movie",
      id: `like:${ownedKey(watched)}`,
      offset: 0,
      limit: 5,
    });
    expect(page.titles).toEqual(alike?.titles.slice(0, 5));
  });

  it("shows TMDB's names in the viewer's language, and finds titles by their original name", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const settings = await promised(runtime, Settings);
    const done = () =>
      vi.waitFor(
        async () => {
          const { metadata } = await onDemand.status();
          expect(metadata?.known).toBe(metadata?.wanted);
        },
        { timeout: 20_000 },
      );
    /** What a title shows, by TMDB's rules as the fake TMDB plays them. */
    const expected = (tmdbId: string, language: string) => {
      const id = Number(tmdbId);
      const shown = tmdbName(id, language);
      const madeIn = id % 3 === 0 ? "nl" : "en";
      // Without a translation, the English name stands in; for an English film, its own.
      const name =
        shown.name !== shown.original || madeIn === language
          ? shown.name
          : madeIn === "en"
            ? shown.original
            : tmdbName(id, "en").name;
      return {
        title: name,
        originalTitle: name === shown.original ? null : shown.original,
        // Which sound "Original language" plays.
        originalLanguage: madeIn,
      };
    };
    const all = async () =>
      (await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 500 })).titles;

    // Lists take up what arrived with the store's next notice.
    const named = (language: string) =>
      vi.waitFor(
        async () => {
          const titles = (await all()).filter((title) => title.tmdbId);
          expect(titles.length).toBeGreaterThan(0);
          for (const title of titles) {
            expect(title).toMatchObject(expected(title.tmdbId ?? "", language));
          }
          return titles;
        },
        { timeout: 20_000 },
      );
    await done();
    const english = await named("en");
    // A Dutch film shown by its English name is found by its Dutch one.
    const dutch = english.find((title) => title.originalTitle?.startsWith("Origineel"));
    expect(dutch).toBeDefined();
    expect(
      (await onDemand.search(dutch?.originalTitle ?? "")).movies.map((title) => title.tmdbId),
    ).toContain(dutch?.tmdbId);

    // Dutch names come in the background; English ones stay known.
    const asked = app.tmdb.detailRequests();
    await settings.update({ titleLanguage: "nl" });
    await all();
    await done();
    await named("nl");
    expect(app.tmdb.detailRequests("nl")).toBe(app.tmdb.detailRequests() - asked);
    const both = app.tmdb.detailRequests();
    await settings.update({ titleLanguage: "en" });
    await named("en");
    expect(app.tmdb.detailRequests()).toBe(both);
  });

  it("gives a title's details without waiting for TMDB, and says when TMDB's arrive", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const movie = await knownMovie(onDemand);
    expect(app.tmdb.aboutRequests()).toBe(0);
    const changed = await collect(runtime, onDemand.detailsChanged);
    app.tmdb.holdAbout(true);

    const early = await onDemand.details("movie", movie);

    expect(early.plot).toMatch(/^The story of /);
    await vi.waitFor(() => expect(app.tmdb.aboutRequests()).toBe(1));
    app.tmdb.holdAbout(false);
    await vi.waitFor(() => expect(changed).toEqual([{ kind: "movie", ...ownedId(movie) }]));
    const details = await onDemand.details("movie", movie);
    expect(details.plot).toMatch(/^TMDB's story of /);
    expect(details.title.posterUrl).toBe(
      `https://image.tmdb.org/t/p/w780/poster-${movie.tmdbId}.jpg`,
    );
    expect(details.cast).toEqual([
      {
        name: "Alan Actor",
        role: "The Lead",
        photoUrl: "https://image.tmdb.org/t/p/w185/alan.jpg",
      },
    ]);
    expect(details.directors).toEqual(["Grace Director"]);
    // TMDB's 101 minutes, not the provider's 100.
    expect(details.duration).toBe(6060);
    // Opening it again asks no one.
    await onDemand.details("movie", movie);
    expect(app.tmdb.aboutRequests()).toBe(1);
  });

  it("asks TMDB again for details it couldn't answer, or had no key for", async () => {
    const app = await metadataApp(null);
    const { runtime, onDemand } = await app.start();
    const { titles } = await onDemand.collection({
      kind: "movie",
      id: "all",
      offset: 0,
      limit: 50,
    });
    const [movie, other] = titles.filter((title) => title.tmdbId);
    if (!movie || !other) throw new Error("The lists have too few movies with a TMDB id.");
    const plot = async (title: Title) => (await onDemand.details("movie", title)).plot;

    expect(await plot(movie)).toMatch(/^The story of /);
    await (await promised(runtime, Settings)).update({ tmdbKey: "own-key" });
    await onDemand.reconfigure();
    await vi.waitFor(async () => expect(await plot(movie)).toMatch(/^TMDB's story of /));

    app.tmdb.refuse(true);
    expect(await plot(other)).toMatch(/^The story of /);
    app.tmdb.refuse(false);
    await vi.waitFor(async () => expect(await plot(other)).toMatch(/^TMDB's story of /));
  });

  it("puts details opened early together again with the names TMDB gives later", async () => {
    const app = await metadataApp();
    // TMDB refuses at first, so the lists and the details have only the provider's names.
    app.tmdb.refuse(true);
    const { runtime, onDemand } = await app.start();
    const movie = await knownMovie(onDemand);
    const early = await onDemand.details("movie", movie);
    expect(early.title).toMatchObject({ title: movie.title, originalLanguage: null });
    // Refused too.
    await vi.waitFor(() => expect(app.tmdb.aboutRequests()).toBe(1));

    // A key TMDB accepts: names arrive in the lists, in the background.
    app.tmdb.refuse(false);
    const settings = await promised(runtime, Settings);
    await settings.update({ tmdbKey: "another-key" });
    await onDemand.reconfigure();
    const listed = await vi.waitFor(
      async () => {
        const [title] = await onDemand.titles("movie", [movie]);
        expect(title?.originalLanguage).not.toBeNull();
        return title;
      },
      { timeout: 20_000 },
    );
    const downloads = app.tmdb.aboutRequests();

    // TMDB didn't answer then, so it is asked once more, now that it does.
    const again = await vi.waitFor(async () => {
      const details = await onDemand.details("movie", movie);
      expect(details.plot).toMatch(/^TMDB's story of /);
      return details;
    });

    expect(again.title).toMatchObject({
      title: listed?.title,
      originalLanguage: listed?.originalLanguage,
    });
    expect(app.tmdb.aboutRequests()).toBe(downloads + 1);
  });

  it("fetches nothing without a key", async () => {
    const app = await metadataApp(null);
    const { onDemand } = await app.start();
    expect((await onDemand.status()).metadata).toBeNull();
    expect(app.tmdb.detailRequests()).toBe(0);
    // A season's episodes are the provider's.
    const episodes = await onDemand.season(app.own(SERIES), 1);
    expect(episodes.map((episode) => episode.title)).toEqual(["Part 1", "Part 2", "Part 3"]);
    expect(app.tmdb.seasonRequests()).toEqual([]);
  });
});

/**
 * "TEST | Formats (NL)": three episodes in its first season and two in its second on the provider;
 * on TMDB, 90000, made in Dutch, four in its first and one in its second.
 */
const SERIES = "80000";

describe("episode details", { timeout: 30_000 }, () => {
  it("asks TMDB about a season only once it opens, for the episodes the provider has", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    await (await promised(runtime, Settings)).update({ titleLanguage: "nl" });
    const details = await onDemand.details("series", app.own(SERIES));
    if (details.kind !== "series") throw new Error("Not a series.");
    expect(app.tmdb.seasonRequests()).toEqual([]);

    const first = await onDemand.season(app.own(SERIES), 1);

    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/nl"]);
    // The provider's three, not TMDB's fourth.
    expect(first.map((episode) => episode.id)).toEqual(
      details.seasons[0]?.episodes.map((episode) => episode.id),
    );
    expect(first[0]).toEqual({
      ...details.seasons[0]?.episodes[0],
      title: "Origineel 1x1",
      plot: "TMDB's story of Origineel 1x1.",
      stillUrl: "https://image.tmdb.org/t/p/w780/still-90000-1-1.jpg",
      airDate: "2020-01-01",
      // TMDB's 50 minutes, not the provider's 45.
      duration: 3000,
      rating: 8.2,
      cast: [
        {
          name: "Gus Guest",
          role: "The Visitor",
          photoUrl: "https://image.tmdb.org/t/p/w185/gus.jpg",
        },
      ],
      directors: ["Dora Director"],
    });
    // Four people rated the third: too few to show.
    expect(first.map((episode) => episode.rating)).toEqual([8.2, 8.2, null]);

    // Opened again, it asks no one; the second season asks once it opens.
    await onDemand.season(app.own(SERIES), 1);
    const second = await onDemand.season(app.own(SERIES), 2);
    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/nl", "90000/2/nl"]);
    // TMDB lists one episode there; the provider's other keeps its own details.
    expect(second.map((episode) => [episode.title, episode.rating])).toEqual([
      ["Origineel 2x1", 8.2],
      ["Part 2", null],
    ]);
  });

  it("names episodes in the viewer's language, else in English, else in the series' own", async () => {
    const app = await metadataApp();
    const { runtime, onDemand } = await app.start();
    const settings = await promised(runtime, Settings);
    await settings.update({ titleLanguage: "de" });

    const episodes = await onDemand.season(app.own(SERIES), 1);

    // TMDB names none in German, the odd ones in English, and all in Dutch, the series' own.
    expect(episodes.map((episode) => [episode.title, episode.plot])).toEqual([
      ["English 1x1", "TMDB's story of English 1x1."],
      ["Origineel 1x2", "TMDB's story of Origineel 1x2."],
      ["English 1x3", "TMDB's story of English 1x3."],
    ]);
    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/de", "90000/1/en", "90000/1/nl"]);

    // In English, what TMDB said in English and Dutch serves again.
    await settings.update({ titleLanguage: "en" });
    const english = await onDemand.season(app.own(SERIES), 1);
    expect(english.map((episode) => episode.title)).toEqual([
      "English 1x1",
      "Origineel 1x2",
      "English 1x3",
    ]);
    expect(app.tmdb.seasonRequests()).toHaveLength(3);
  });

  it("gives each version of a series its own episodes, from the same answers", async () => {
    const app = await metadataApp();
    const { onDemand } = await app.start();

    const dutch = await onDemand.season(app.own(SERIES), 1);
    const english = await onDemand.season(app.own("79998"), 1);

    expect(dutch.map((episode) => [episode.id, episode.title])).toEqual([
      ["81000", "English 1x1"],
      ["81001", "Origineel 1x2"],
      ["81002", "English 1x3"],
    ]);
    expect(english.map((episode) => [episode.id, episode.title])).toEqual([
      ["799980", "English 1x1"],
      ["799981", "Origineel 1x2"],
    ]);
    expect(app.tmdb.seasonRequests()).toEqual(["90000/1/en", "90000/1/nl"]);
  });

  it("keeps the provider's episodes while TMDB fails or is slow, and asks again later", async () => {
    const app = await metadataApp();
    const { onDemand } = await app.start();
    const titles = async () =>
      (await onDemand.season(app.own(SERIES), 1)).map((episode) => episode.title);

    app.tmdb.failSeasons(500);
    expect(await titles()).toEqual(["Part 1", "Part 2", "Part 3"]);
    app.tmdb.failSeasons("hold");
    // The seconds TMDB gets pass on a fake clock: its deadlines are timers on it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const deadline = new AbortController();
      setTimeout(() => deadline.abort(new DOMException("Timed out", "TimeoutError")), ms);
      return deadline.signal;
    });
    try {
      const asked = app.tmdb.seasonRequests().length;
      const slow = titles();
      // Playing an episode doesn't wait for it: the clock stands still until it plays.
      await onDemand.file({
        kind: "episode",
        ...app.own("81000"),
        seriesId: SERIES,
        season: 1,
        episode: 1,
      });
      // The provider's episodes come once the seconds TMDB gets are up.
      await vi.waitFor(() => expect(app.tmdb.seasonRequests()).toHaveLength(asked + 1));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(await slow).toEqual(["Part 1", "Part 2", "Part 3"]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }

    app.tmdb.failSeasons(null);
    expect(await titles()).toEqual(["English 1x1", "Origineel 1x2", "English 1x3"]);
    expect(app.tmdb.seasonRequests()).toEqual([
      "90000/1/en",
      "90000/1/en",
      "90000/1/en",
      "90000/1/nl",
    ]);
  });
});

const DAY = 86_400_000;

/** The first `count` films by TMDB id, as the catalogue lists them to the store. */
const wantedTitles = (count: number): Wanted[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: "movie",
    tmdbId: String(index + 1),
    addedAt: index + 1,
  }));

/**
 * A TMDB that answers at once and takes a second of the store's clock for each answer, so a run
 * of a few hundred titles lasts minutes by that clock and a moment by ours. `status` picks an
 * answer's HTTP status by title id; `popularity` is what each title's details say. `asked` hears
 * of each request as it is made, by how many there were.
 */
function slowTmdb(
  options: {
    readonly status?: (id: number) => number;
    readonly popularity?: (id: number) => number;
    readonly asked?: (requests: number) => void;
  } = {},
) {
  const clock = { time: 1000 * DAY, lastAnswer: 0, requests: 0 };
  const client = tmdbClient({
    key: "test-key",
    api: "http://tmdb.test/3",
    fetch: async (input) => {
      const url = new URL(String(input));
      // Streaming services: none.
      if (!/^\/3\/movie\/\d+$/.test(url.pathname)) return new Response("{}", { status: 404 });
      const id = Number(url.pathname.split("/").at(-1));
      const language = url.searchParams.get("language") ?? "en";
      clock.time += 1000;
      clock.lastAnswer = clock.time;
      clock.requests++;
      options.asked?.(clock.requests);
      const status = options.status?.(id) ?? 200;
      if (status !== 200) return new Response("{}", { status });
      return Response.json({
        title: language === "en" ? `Title ${id}` : `Titel ${id}`,
        original_title: `Title ${id}`,
        genres: [{ id: 35 }],
        original_language: "en",
        popularity: options.popularity?.(id) ?? id,
        vote_average: 7.5,
        vote_count: 400,
      });
    },
  });
  return { clock, client, now: () => clock.time };
}

/** Waits until `store` ends its run. */
const settled = (store: ReturnType<typeof metadataStore>) =>
  vi.waitFor(() => expect(store.status().fetching).toBe(false), { timeout: 20_000 });

describe("TMDB metadata store", { timeout: 30_000 }, () => {
  it("fetches a list given while an earlier one is being fetched", async () => {
    let store: ReturnType<typeof metadataStore> | null = null;
    // As after a refresh that lists 20 more, while the fifth title is being asked about.
    const tmdb = slowTmdb({
      asked: (requests) => {
        if (requests === 5) store?.want(wantedTitles(60));
      },
    });
    store = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: tmdb.client,
      region: "NL",
      onChange: () => {},
      now: tmdb.now,
    });
    store.want(wantedTitles(40));
    await settled(store);
    expect(store.status()).toMatchObject({ known: 60, wanted: 60, fetching: false });
  });

  it("says it stopped when TMDB can't be reached, with titles still unanswered", async () => {
    const path = join(await tempDir(), "metadata.json.gz");
    // No request gets through, and the waits before each is tried again pass on a fake clock.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const changes: boolean[] = [];
      const store = metadataStore({
        path,
        client: tmdbClient({
          key: "test-key",
          api: "http://tmdb.test/3",
          fetch: () => Promise.reject(new TypeError("fetch failed")),
        }),
        region: "NL",
        onChange: () => changes.push(store.status().fetching),
      });
      store.want(wantedTitles(3));
      expect(store.status().fetching).toBe(true);
      while (store.status().fetching) {
        await vi.advanceTimersByTimeAsync(1000);
        // Lets the store read and write its file.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(store.status()).toMatchObject({ known: 0, fetching: false });
      // The UI hears that it stopped.
      expect(changes.at(-1)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves out what TMDB said more than six months ago", async () => {
    const path = join(await tempDir(), "metadata.json.gz");
    const entry = (at: number) => ({ at, genres: [35], language: "en", popularity: 1 });
    await writeFile(
      path,
      gzipSync(
        JSON.stringify({
          version: 1,
          entries: { "movie:1": entry(0), "movie:2": entry(100 * DAY) },
        }),
      ),
    );
    const store = metadataStore({
      path,
      client: null,
      region: "NL",
      onChange: () => {},
      now: () => 200 * DAY,
    });
    store.want(wantedTitles(2));
    await vi.waitFor(() => expect(store.get("movie", "2")).not.toBeNull());
    expect(store.get("movie", "1")).toBeNull();
  });
});

describe("when the store tells the UI of metadata", { timeout: 30_000 }, () => {
  /** What the store told the UI, and when by the fake clock. */
  function notices(clock: { time: number }) {
    const told: { content: boolean; at: number }[] = [];
    return {
      told,
      onChange: ({ content }: { content: boolean }) => told.push({ content, at: clock.time }),
    };
  }

  /** The file a store leaves after asking about `count` titles of `tmdb`, which answers `status`. */
  async function kept(tmdb: ReturnType<typeof slowTmdb>, count: number) {
    const path = join(await tempDir(), "metadata.json.gz");
    const first = metadataStore({
      path,
      client: tmdb.client,
      region: "NL",
      onChange: () => {},
      now: tmdb.now,
    });
    first.want(wantedTitles(count));
    await settled(first);
    await first.flush();
    return path;
  }

  it("tells lists nothing when TMDB's answers are the same as before, and still keeps them", async () => {
    const path = join(await tempDir(), "metadata.json.gz");
    const tmdb = slowTmdb();
    const open = (onChange: (change: { content: boolean }) => void, client = tmdb.client) =>
      metadataStore({ path, client, region: "NL", onChange, now: tmdb.now });
    const first = open(() => {});
    first.want(wantedTitles(20));
    await settled(first);
    await first.flush();

    // Past the time titles are fetched again, with the same answers.
    tmdb.clock.time += 151 * DAY;
    const same = notices(tmdb.clock);
    const reopened = tmdb.clock.time;
    const again = open(same.onChange);
    again.want(wantedTitles(20));
    await settled(again);
    await again.flush();
    expect(same.told.length).toBeGreaterThan(0);
    // Only the kept answers, told as they load; fetching them again says nothing more.
    expect(same.told.filter(({ content }) => content)).toEqual([{ content: true, at: reopened }]);

    // Their new time was saved: well past the first answers' six months, they are still used.
    tmdb.clock.time += 100 * DAY;
    const kept = open(() => {}, null as never);
    kept.want(wantedTitles(20));
    await vi.waitFor(() => expect(kept.get("movie", "1")).not.toBeNull());

    // Answers that differ are told, so the contrast holds.
    tmdb.clock.time += 151 * DAY;
    const popular = slowTmdb({ popularity: (id) => id + 1 });
    popular.clock.time = tmdb.clock.time;
    const changed = notices(popular.clock);
    const changing = metadataStore({
      path,
      client: popular.client,
      region: "NL",
      onChange: changed.onChange,
      now: popular.now,
    });
    changing.want(wantedTitles(20));
    await settled(changing);
    expect(changed.told.some(({ content }) => content)).toBe(true);
  });

  it("tells lists less often as a run goes on, status as before, and ends with them current", async () => {
    const tmdb = slowTmdb();
    const seen = notices(tmdb.clock);
    const store = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: tmdb.client,
      region: "NL",
      onChange: seen.onChange,
      now: tmdb.now,
    });
    store.want(wantedTitles(200));
    await settled(store);

    const content = seen.told.filter(({ content }) => content).map(({ at }) => at);
    // Apart from the one that ends the run, which comes when it does.
    const gaps = content.slice(1, -1).map((at, index) => at - (content[index] ?? 0));
    expect(gaps.length).toBeGreaterThan(3);
    for (const [index, gap] of gaps.entries()) {
      expect(gap).toBeGreaterThanOrEqual(gaps[index - 1] ?? 0);
    }
    expect(gaps.at(-1)).toBeGreaterThanOrEqual(2 * (gaps[0] ?? 0));
    // Doubling from 3 s and 30 s apart at most, each plus the answer that came due.
    expect(gaps[0]).toBeLessThan(10_000);
    expect(gaps.filter((gap) => gap >= 30_000).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...gaps)).toBeLessThan(32_000);

    // The status keeps coming every few seconds in between.
    const all = seen.told.map(({ at }) => at);
    expect(Math.max(...all.slice(1).map((at, index) => at - (all[index] ?? 0)))).toBeLessThan(
      10_000,
    );

    // What arrived last was told at the end.
    expect(content.at(-1)).toBeGreaterThanOrEqual(tmdb.clock.lastAnswer);
    expect(store.status()).toMatchObject({ known: 200, wanted: 200, fetching: false });
  });

  it("tells the status alone of an id TMDB doesn't know, and of a refused key", async () => {
    const unknown = slowTmdb({ status: () => 404 });
    const missing = notices(unknown.clock);
    const store = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: unknown.client,
      region: "NL",
      onChange: missing.onChange,
      now: unknown.now,
    });
    store.want(wantedTitles(3));
    await settled(store);
    expect(store.status()).toMatchObject({ known: 3, fetching: false });
    expect(missing.told.length).toBeGreaterThan(0);
    expect(missing.told.filter(({ content }) => content)).toEqual([]);

    const refusing = slowTmdb({ status: () => 401 });
    const refused = notices(refusing.clock);
    const blocked = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: refusing.client,
      region: "NL",
      onChange: refused.onChange,
      now: refusing.now,
    });
    blocked.want(wantedTitles(3));
    await settled(blocked);
    expect(blocked.status()).toMatchObject({ refused: true, fetching: false });
    expect(refused.told.filter(({ content }) => content)).toEqual([]);
  });

  it.each([
    [
      "a language change",
      (store: ReturnType<typeof metadataStore>) => store.want(wantedTitles(200), "nl"),
    ],
    ["a new list", (store: ReturnType<typeof metadataStore>) => store.want(wantedTitles(201))],
  ])("tells lists quickly again after %s", async (_name, change) => {
    const tmdb = slowTmdb();
    const seen = notices(tmdb.clock);
    let switchedAt: number | null = null;
    const store = metadataStore({
      path: join(await tempDir(), "metadata.json.gz"),
      client: tmdb.client,
      region: "NL",
      onChange: (notice) => {
        seen.onChange(notice);
        // With the gap grown to 30 s, as a long run does.
        if (switchedAt === null && seen.told.filter(({ content }) => content).length === 6) {
          switchedAt = tmdb.clock.time;
          change(store);
        }
      },
      now: tmdb.now,
    });
    store.want(wantedTitles(200));
    await settled(store);

    expect(switchedAt).not.toBeNull();
    const after = seen.told.filter(({ content, at }) => content && at > (switchedAt ?? 0));
    // The one that ends the run being left, and then the next, not 30 s later.
    expect((after[1]?.at ?? Infinity) - (switchedAt ?? 0)).toBeLessThan(25_000);
  });

  it("tells lists of the metadata kept on disk once it has loaded, with nothing to fetch", async () => {
    const tmdb = slowTmdb();
    const path = await kept(tmdb, 3);
    const requests = tmdb.clock.requests;

    // Lists built before the file loaded show the provider's names: they need to be told.
    tmdb.clock.time += 10 * DAY;
    const seen = notices(tmdb.clock);
    const heard: (string | null)[] = [];
    const store: ReturnType<typeof metadataStore> = metadataStore({
      path,
      client: tmdb.client,
      region: "NL",
      onChange: (notice) => {
        seen.onChange(notice);
        heard.push(store.name("movie", "1", "en")?.name ?? null);
      },
      now: tmdb.now,
    });
    store.want(wantedTitles(3));
    await settled(store);
    expect(tmdb.clock.requests).toBe(requests);
    expect(seen.told.filter(({ content }) => content)).toHaveLength(1);
    // By then the kept answers were there to be read.
    expect(heard[0]).toBe("Title 1");

    // Without a key it is the same: the store answers from disk.
    const keyless = notices(tmdb.clock);
    metadataStore({ path, client: null, region: "NL", onChange: keyless.onChange, now: tmdb.now });
    await vi.waitFor(() => expect(keyless.told).toEqual([{ content: true, at: tmdb.clock.time }]));
  });

  it("keeps independent raw search aliases, including punctuation, within their validity", async () => {
    const path = join(await tempDir(), "metadata.json.gz");
    let now = Date.now();
    await writeFile(
      path,
      gzipSync(
        JSON.stringify({
          version: 1,
          entries: {
            "movie:1": {
              at: now,
              names: { en: "Spider-Man", nl: "Other Translation" },
              original: "O’Brien",
            },
          },
        }),
      ),
    );
    const store = metadataStore({
      path,
      client: null,
      region: "NL",
      onChange: () => {},
      now: () => now,
    });
    await vi.waitFor(() =>
      expect(store.searchAliases("movie", "1")).toEqual([
        "Spider-Man",
        "Other Translation",
        "O’Brien",
      ]),
    );
    now += 183 * DAY;
    expect(store.searchAliases("movie", "1")).toEqual([]);
    expect(store.searchAliases("movie", "missing")).toEqual([]);
  });

  it("finds a title by TMDB's names once the kept metadata has loaded, though it was searched before", async () => {
    const tmdb = slowTmdb();
    const path = await kept(tmdb, 3);
    const seen = notices(tmdb.clock);
    const store = metadataStore({
      path,
      client: null,
      region: "NL",
      onChange: seen.onChange,
      now: tmdb.now,
    });

    // Searched while the file is still being read: no names yet.
    expect(store.searchName("movie", "1")).toBe("");
    await vi.waitFor(() => expect(seen.told).toHaveLength(1));
    expect(store.searchName("movie", "1")).toContain("title 1");
  });

  it("tells nothing of a file that can't be read, isn't there, or holds nothing lists show", async () => {
    const quiet = async (path: string, client: ReturnType<typeof slowTmdb>["client"] | null) => {
      const tmdb = slowTmdb();
      const seen = notices(tmdb.clock);
      const store = metadataStore({
        path,
        client,
        region: "NL",
        onChange: seen.onChange,
        now: tmdb.now,
      });
      // Long enough for the file to have loaded.
      await new Promise((done) => setTimeout(done, 100));
      expect(store.get("movie", "1")).toBeNull();
      expect(seen.told).toEqual([]);
    };
    const dir = await tempDir();
    await quiet(join(dir, "none.json.gz"), null);
    await writeFile(join(dir, "broken.json.gz"), "not a metadata file");
    await quiet(join(dir, "broken.json.gz"), slowTmdb().client);
    // Titles TMDB doesn't know show nothing.
    await quiet(await kept(slowTmdb({ status: () => 404 }), 3), null);
  });

  it("tells lists of a changed title within the spacing, not at the end of a run of unchanged answers", async () => {
    const tmdb = slowTmdb();
    const path = await kept(tmdb, 200);

    // Past the time titles are fetched again. Of the newest titles, fetched first, two differ:
    // one that is told at once, and another that arrives with it, while a notice is not due.
    // All the others are the same.
    tmdb.clock.time += 151 * DAY;
    const changing = slowTmdb({ popularity: (id) => (id === 200 || id === 195 ? 999 : id) });
    changing.clock.time = tmdb.clock.time;
    const start = changing.clock.time;
    const told: { at: number; shown: number | undefined }[] = [];
    const store: ReturnType<typeof metadataStore> = metadataStore({
      path,
      client: changing.client,
      region: "NL",
      onChange: ({ content }) => {
        if (content) {
          told.push({
            at: changing.clock.time - start,
            shown: store.get("movie", "195")?.popularity,
          });
        }
      },
      now: changing.now,
    });
    store.want(wantedTitles(200));
    await settled(store);

    // The run lasts 200 s by the clock; lists had the second title long before its end.
    const first = told.find(({ shown }) => shown === 999);
    expect(first?.at ?? Infinity).toBeLessThan(30_000);
  });

  it.each([
    ["TMDB no longer knows", { status: () => 404 }, null],
    ["TMDB answers the same", {}, 1],
  ])("tells lists when a title that had expired and %s", async (_name, options, popularity) => {
    const tmdb = slowTmdb();
    const path = await kept(tmdb, 1);

    // Lists show it at first, and then six months pass.
    tmdb.clock.time += 100 * DAY;
    const again = slowTmdb(options);
    again.clock.time = tmdb.clock.time;
    const seen = notices(again.clock);
    const store = metadataStore({
      path,
      client: again.client,
      region: "NL",
      onChange: seen.onChange,
      now: again.now,
    });
    await vi.waitFor(() => expect(store.get("movie", "1")?.popularity).toBe(1));
    again.clock.time += 83 * DAY;
    expect(store.get("movie", "1")).toBeNull();
    const before = seen.told.length;

    store.want(wantedTitles(1));
    await settled(store);
    expect(store.get("movie", "1")?.popularity ?? null).toBe(popularity);
    expect(seen.told.slice(before).some(({ content }) => content)).toBe(true);
  });
});

describe("TMDB's progress to the UI", { timeout: 30_000 }, () => {
  /** A catalogue worker the test speaks for; it can hold back what it says of the lists. */
  class FakeWorker extends EventEmitter {
    holding = false;
    held: WorkerRequest | null = null;
    postMessage(request: WorkerRequest) {
      if (request.method === "status" && this.holding) {
        this.held = request;
        return;
      }
      const value =
        request.method === "status"
          ? request.args.owners.map(() => ({ movies: 10, series: 0, fetchedAt: 1 }))
          : null;
      queueMicrotask(() => this.emit("message", { id: request.id, ok: true, value }));
    }
    async terminate() {
      return 0;
    }
  }

  it("carries only the progress, without waiting for the worker to say how the lists stand", async () => {
    const worker = new FakeWorker();
    const provider = await fakeProvider();
    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(await tempDir()),
        tmdbKey: "test-key",
        catalogueWorker: () => worker as unknown as Worker,
      }),
    );
    try {
      await (
        await promised(runtime, Subscriptions)
      ).add({ server: provider.url, username: "demo", password: "demo" });
      const onDemand = await promised(runtime, OnDemand);
      // The first call starts the worker, which is listened to from then on.
      await onDemand.status();
      const progress = await collect(runtime, onDemand.progressChanges);
      const updates = await collect(runtime, onDemand.changes);
      const metadata = { known: 1, wanted: 10, refused: false, fetching: true };

      worker.holding = true;
      worker.emit("message", {
        event: "metadata",
        content: false,
        status: metadata,
      } satisfies WorkerEvent);
      await vi.waitFor(() => expect(progress).toEqual([metadata]));
      // No word from the worker on the lists was waited for, and nothing told them changed.
      expect(worker.held).toBeNull();
      expect(updates).toEqual([]);
    } finally {
      await runtime.dispose();
      await provider.close();
    }
  });
});
