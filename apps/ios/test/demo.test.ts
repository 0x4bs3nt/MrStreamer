import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import { indexCatalogue, kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { describe, expect, it } from "vitest";
import { DEMO_ID, demoEntry, demoProvider } from "../src/demo.ts";

// The built-in demo's provider, through the Provider contract the app's owners call: its sample
// titles and files, which come from the media committed with the app, and Live, which is off. Its
// certification playlist capability runs here only, against fetch answers made in the test. No
// network is used, and nothing here reads the media itself.

const COMMIT = "9791b09908e03742cee981c97e37d47829fc7a18";
const MEDIA = `https://raw.githubusercontent.com/Mr-Streamer-OSS/MrStreamer/${COMMIT}/apps/ios/demo-media/`;
const PLAYLIST =
  "https://raw.githubusercontent.com/Mr-Streamer-OSS/certification-playlist/main/reviewer.m3u";
const LIMIT = 64 * 1024;
const PLAYLIST_LIVE = { live: { kind: "playlist" } } as const;

/** What `work` was refused with; fails the test when it wasn't refused with an AppFailure. */
async function refusal(work: Promise<unknown>): Promise<AppError> {
  const cause = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  if (!(cause instanceof AppFailure)) throw new Error(`Expected an AppFailure: ${String(cause)}`);
  return cause.error;
}

/** A fetch that answers with `answer`, keeping each address it was asked and its headers. */
function fetching(answer: (url: string) => Response | Promise<Response>) {
  const asked: { readonly url: string; readonly headers: Headers }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    asked.push({ url, headers: new Headers(init?.headers) });
    return answer(url);
  };
  return { fetch: fetchImpl, asked };
}

/** A fetch that answers each request with the next of `answers`, in the order asked. */
function answering(...answers: Array<() => Response | Promise<Response>>) {
  return fetching(() => {
    const next = answers.shift();
    if (!next) throw new Error("Asked once more than the test expects.");
    return next();
  });
}

const refuseAll = () => answering();

/** A playlist as the certification one is written: a header line, then each channel. */
const playlist = (...lines: string[]) => `${["#EXTM3U", ...lines].join("\n")}\n`;
const channel = (id: string, url: string) => [
  `#EXTINF:-1 tvg-id="${id}" group-title="News",${id} Channel`,
  url,
];

/**
 * A response whose body is `body`, read as a stream as the adapter reads it. The app's React
 * Native types take no stream body, so it is set on a response made without one.
 */
function streamed(body: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
  return Object.defineProperty(new Response(null, init), "body", { value: body });
}

/** An answer held until the test gives it, so reads can be made to end in either order. */
function held() {
  let give!: (response: Response) => void;
  const answer = new Promise<Response>((resolve) => (give = resolve));
  return { answer: () => answer, give };
}

/** The asset commit's own catalogue.tsv, by id. */
function catalogueRows(): ReadonlyMap<string, Readonly<Record<string, string>>> {
  const text = readFileSync(join(import.meta.dirname, "../demo-media/catalogue.tsv"), "utf8");
  const [head = "", ...rows] = text.trim().split("\n");
  const names = head.split("\t");
  return new Map(
    rows.map((row): [string, Record<string, string>] => {
      const values = row.split("\t");
      const fields = Object.fromEntries(names.map((name, at) => [name, values[at] ?? ""]));
      return [fields["id"] ?? "", fields];
    }),
  );
}

describe("the demo provider as the app makes it", () => {
  it("signs in without a login and asks nothing", async () => {
    const { fetch, asked } = refuseAll();
    const provider = demoProvider({ fetch });
    expect(DEMO_ID).toBe("demo");
    expect(demoEntry).toEqual({
      id: "demo",
      kind: "demo",
      name: "Demo",
      server: "https://raw.githubusercontent.com",
      username: "",
    });
    expect(await provider.authenticate()).toEqual({
      state: "active",
      expiresAt: null,
      maxConnections: null,
      activeConnections: null,
    });
    expect(asked).toEqual([]);
  });

  it("lists no channels, plays none and has no guide while Live is off", async () => {
    const { fetch, asked } = refuseAll();
    const provider = demoProvider({ fetch });
    expect(await provider.liveCatalogue()).toEqual({ categories: [], channels: [] });
    expect(await refusal(provider.liveStream("DW.de@English"))).toEqual({
      kind: "channel-not-found",
      channelId: "DW.de@English",
    });
    expect(await refusal(provider.archiveStream("DW.de@English", { start: 0, end: 1 }))).toEqual({
      kind: "catch-up",
      reason: "none",
    });
    expect(await provider.liveGuide()).toEqual({ kind: "none" });
    expect(await provider.liveGuideRequest?.()).toEqual({ kind: "none" });
    expect(asked).toEqual([]);
  });

  it("lists one sample movie and one sample series with no invented facts", async () => {
    const facts = { rating: null, addedAt: null, releaseDate: null, adult: false, tmdbId: null };
    expect(await demoProvider().onDemandCatalogue()).toEqual({
      movieCategories: [{ id: "sample-movies", name: "Sample movies" }],
      movies: [
        {
          id: "movie",
          name: "Generated sample movie",
          posterUrl: `${MEDIA}movie-cover.png`,
          backdropUrl: `${MEDIA}movie-backdrop.png`,
          ...facts,
          categoryIds: ["sample-movies"],
          container: "mp4",
        },
      ],
      seriesCategories: [{ id: "sample-series", name: "Sample series" }],
      series: [
        {
          id: "series",
          name: "Generated sample series",
          posterUrl: `${MEDIA}series-cover.png`,
          backdropUrl: `${MEDIA}series-backdrop.png`,
          ...facts,
          categoryIds: ["sample-series"],
          container: null,
        },
      ],
    });
  });

  it("describes the movie, and the series' one season of two episodes in order", async () => {
    const provider = demoProvider();
    const none = { originalName: null, genres: [], cast: [], directors: [], releaseDate: null };
    expect(await provider.movieDetails("movie")).toMatchObject({
      ...none,
      duration: 150,
      posterUrl: `${MEDIA}movie-cover.png`,
      backdropUrl: `${MEDIA}movie-backdrop.png`,
      seasons: [],
      episodes: [],
      container: "mp4",
    });
    const series = await provider.seriesDetails("series");
    expect(series).toMatchObject({
      ...none,
      duration: 90,
      posterUrl: `${MEDIA}series-cover.png`,
      backdropUrl: `${MEDIA}series-backdrop.png`,
      seasons: [{ number: 1, name: null, posterUrl: null }],
      container: null,
    });
    expect(series.episodeOrder).toBeUndefined();
    expect(series.episodes).toEqual(
      [1, 2].map((number) => ({
        id: `episode-${number}`,
        season: 1,
        number,
        name: `Episode ${number}`,
        plot: null,
        duration: 90,
        stillUrl: null,
        airDate: null,
        addedAt: null,
        container: "mp4",
      })),
    );
  });

  it("gives each sample's file at the pinned commit without fetching it", async () => {
    const { fetch, asked } = refuseAll();
    const provider = demoProvider({ fetch });
    expect(await provider.titleFile("movie", "movie", "mp4")).toEqual({
      url: `${MEDIA}movie.mp4`,
      container: "mp4",
    });
    for (const id of ["episode-1", "episode-2"]) {
      expect(await provider.titleFile("episode", id, "mp4")).toEqual({
        url: `${MEDIA}${id}.mp4`,
        container: "mp4",
      });
    }
    expect(asked).toEqual([]);
  });

  it("refuses titles and files it doesn't list", async () => {
    const provider = demoProvider();
    const missing = (titleId: string) => ({ kind: "title-not-found", titleId });
    // Each is asked only when checked, so no refusal is left without a handler meanwhile.
    const asked: Array<[() => Promise<unknown>, string]> = [
      [() => provider.movieDetails("series"), "series"],
      [() => provider.seriesDetails("movie"), "movie"],
      [() => provider.titleFile("movie", "episode-1", "mp4"), "episode-1"],
      [() => provider.titleFile("episode", "movie", "mp4"), "movie"],
      [() => provider.titleFile("episode", "episode-3", "mp4"), "episode-3"],
    ];
    for (const [ask, id] of asked) expect(await refusal(ask())).toEqual(missing(id));
  });

  it("names only files committed with the media, at their measured lengths", async () => {
    const provider = demoProvider();
    const rows = catalogueRows();
    /** The file a URL names under the pinned media folder, checked to be in this checkout. */
    const file = (url: string | null) => {
      expect(url?.startsWith(MEDIA)).toBe(true);
      const name = url?.slice(MEDIA.length) ?? "";
      expect(existsSync(join(import.meta.dirname, "../demo-media", name))).toBe(true);
      return name;
    };
    const { movies, series } = await provider.onDemandCatalogue();
    const artwork = [...movies, ...series].flatMap((each) => [each.posterUrl, each.backdropUrl]);
    const listed = ["movie-cover", "movie-backdrop", "series-cover", "series-backdrop"];
    expect(artwork.map(file)).toEqual(listed.map((id) => rows.get(id)?.["path"]));
    const movie = rows.get("movie");
    expect(file((await provider.titleFile("movie", "movie", "mp4")).url)).toBe(movie?.["path"]);
    expect((await provider.movieDetails("movie")).duration).toBe(
      Number(movie?.["duration_seconds"]),
    );
    for (const each of (await provider.seriesDetails("series")).episodes) {
      const row = rows.get(each.id);
      expect(row).toMatchObject({
        kind: "episode",
        series_id: "series",
        season: String(each.season),
        episode: String(each.number),
        language: "und",
      });
      expect(each.duration).toBe(Number(row?.["duration_seconds"]));
      expect(file((await provider.titleFile("episode", each.id, "mp4")).url)).toBe(row?.["path"]);
    }
  });

  it("shows in the app's catalogue with no year, language, quality mark or TMDB id", async () => {
    const catalogue = await demoProvider().onDemandCatalogue();
    const index = indexCatalogue([{ subscriptionId: DEMO_ID, catalogue }], "en");
    const shown = [...kindOf(index, "movie").titles, ...kindOf(index, "series").titles];
    expect(shown).toHaveLength(2);
    expect(shown.map((title) => title.title)).toEqual([
      "Generated sample movie",
      "Generated sample series",
    ]);
    for (const title of shown) {
      expect(title).toMatchObject({
        subscriptionId: DEMO_ID,
        originalTitle: null,
        originalLanguage: null,
        tags: [],
        year: null,
        tmdbId: null,
        genres: [],
      });
      expect(title.versions).toHaveLength(1);
    }
  });
});

describe("the demo's certification playlist capability, in tests only", () => {
  it("reads the playlist from main uncached and keeps only HTTPS HLS channels", async () => {
    const body = [
      '#EXTM3U x-tvg-url="https://guide.example/a.xml.gz"',
      '#EXTINF:-1 tvg-id="A.test@HD" group-title="News" tvg-logo="https://a.example/a.png" catchup="default" catchup-days="3",Alpha',
      "https://a.example/live/index.m3u8",
      '#EXTINF:-1 tvg-id="B.test@HD" group-title="News",Beta',
      "http://b.example/live/index.m3u8",
      '#EXTINF:-1 tvg-id="C.test@HD" group-title="News",Gamma',
      "https://c.example/live/manifest.mpd",
      '#EXTINF:-1 tvg-id="D.test@HD" group-title="Sport",Delta',
      "https://d.example/live/stream.ts",
      '#EXTINF:-1 tvg-id="E.test@HD" group-title="News" tvg-logo="http://e.example/e.png",Echo',
      "#EXTVLCOPT:http-user-agent=Player/1.0",
      "https://e.example/live/index.m3u8",
      "",
    ].join("\n");
    const { fetch, asked } = fetching(() => new Response(body));
    const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
    const listed = await provider.liveCatalogue();
    expect(asked.map((each) => each.url)).toEqual([PLAYLIST]);
    expect(asked[0]?.headers.get("cache-control")).toBe("no-store");
    expect(listed.categories).toEqual([{ id: "News", name: "News" }]);
    expect(
      listed.channels.map(({ id, logoUrl, catchupDays }) => ({ id, logoUrl, catchupDays })),
    ).toEqual([
      { id: "A.test@HD", logoUrl: "https://a.example/a.png", catchupDays: null },
      { id: "E.test@HD", logoUrl: null, catchupDays: null },
    ]);
    expect(await provider.liveStream("A.test@HD")).toEqual({
      url: "https://a.example/live/index.m3u8",
      format: "hls",
    });
    expect(await provider.liveStream("E.test@HD")).toEqual({
      url: "https://e.example/live/index.m3u8",
      format: "hls",
      headers: { "User-Agent": "Player/1.0" },
    });
    expect(asked).toHaveLength(1);
    expect(await provider.liveGuideRequest?.()).toEqual({ kind: "none" });
    expect(await refusal(provider.archiveStream("A.test@HD", { start: 0, end: 1 }))).toEqual({
      kind: "catch-up",
      reason: "none",
    });
    // A channel it left out isn't played: the playlist is read again, and still doesn't list it.
    expect(await refusal(provider.liveStream("B.test@HD"))).toEqual({
      kind: "channel-not-found",
      channelId: "B.test@HD",
    });
    expect(asked).toHaveLength(2);
  });

  it("keeps the first 32 channels of a longer playlist", async () => {
    const ids = Array.from({ length: 40 }, (_, at) => `C${at}.test`);
    const lines = ids.flatMap((id) => channel(id, `https://x.example/${id}.m3u8`));
    const { fetch } = fetching(() => new Response(playlist(...lines)));
    const listed = await demoProvider({ fetch, ...PLAYLIST_LIVE }).liveCatalogue();
    expect(listed.channels.map((each) => each.id)).toEqual(ids.slice(0, 32));
  });

  it("refuses a declared size past 64 KiB before reading its body", async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      { pull: () => void pulled++, cancel: () => void (cancelled = true) },
      { highWaterMark: 0 },
    );
    const { fetch } = fetching(() =>
      streamed(body, { headers: { "content-length": String(LIMIT + 1) } }),
    );
    const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
    expect(await refusal(provider.liveCatalogue())).toMatchObject({ kind: "invalid-input" });
    expect(pulled).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("stops reading a body that grows past 64 KiB", async () => {
    // 16 KiB a piece: the fifth piece passes the limit.
    const piece = new TextEncoder().encode(`#EXTM3U\n${"#".repeat(16 * 1024 - 9)}\n`);
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull: (controller) => {
          pulled++;
          controller.enqueue(piece);
        },
        cancel: () => void (cancelled = true),
      },
      { highWaterMark: 0 },
    );
    const { fetch } = fetching(() => streamed(body));
    const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
    expect(await refusal(provider.liveCatalogue())).toMatchObject({ kind: "invalid-input" });
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it("refuses a fetch without a body stream instead of reading it whole", async () => {
    // A small declared size whose real body is far larger, as a wrong header or a packed body
    // that unpacks larger would give. Without a stream it can't be read in bounded pieces.
    const whole: string[] = [];
    const { fetch } = fetching(() => {
      const response = new Response(null, { headers: { "content-length": "64" } });
      for (const method of ["text", "arrayBuffer", "blob", "json", "bytes"] as const) {
        Object.defineProperty(response, method, {
          value: async () => {
            whole.push(method);
            return playlist(...channel("X.test@HD", "https://x.example/x.m3u8")).repeat(LIMIT);
          },
        });
      }
      return response;
    });
    const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
    expect(await refusal(provider.liveCatalogue())).toMatchObject({ kind: "unexpected" });
    expect(await refusal(provider.liveStream("X.test@HD"))).toMatchObject({ kind: "unexpected" });
    expect(whole).toEqual([]);
  });

  it("answers a page that isn't a playlist, a server failure and a lost connection", async () => {
    const { fetch } = answering(
      () => new Response("<!doctype html><title>Not here</title>"),
      () => new Response("Unavailable", { status: 503 }),
      () => {
        throw new TypeError("fetch failed");
      },
    );
    const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
    expect(await refusal(provider.liveCatalogue())).toMatchObject({ kind: "invalid-input" });
    expect(await refusal(provider.liveCatalogue())).toEqual({
      kind: "provider-error",
      status: 503,
    });
    expect(await refusal(provider.liveCatalogue())).toMatchObject({
      kind: "unreachable",
      server: "https://raw.githubusercontent.com",
    });
  });

  it("follows an https redirect, and refuses one to cleartext or to another scheme", async () => {
    const mirror = "mirror.example/reviewer.m3u";
    const moved = (location: string) => (url: string) =>
      url === PLAYLIST
        ? new Response(null, { status: 302, headers: { location } })
        : new Response(playlist(...channel("A.test@HD", "https://a.example/live/index.m3u8")));

    const followed = fetching(moved(`https://${mirror}`));
    const listed = await demoProvider({ fetch: followed.fetch, ...PLAYLIST_LIVE }).liveCatalogue();
    expect(listed.channels.map((each) => each.id)).toEqual(["A.test@HD"]);
    expect(followed.asked.map((each) => each.url)).toEqual([PLAYLIST, `https://${mirror}`]);

    for (const location of [`http://${mirror}`, `ftp://${mirror}`]) {
      const refused = fetching(moved(location));
      const provider = demoProvider({ fetch: refused.fetch, ...PLAYLIST_LIVE });
      expect(await refusal(provider.liveCatalogue())).toMatchObject({ kind: "unreachable" });
      expect(refused.asked.map((each) => each.url)).toEqual([PLAYLIST]);
    }
  });

  it("plays the newest read's streams whichever answer arrives last", async () => {
    for (const order of [
      ["newer", "older"],
      ["older", "newer"],
    ] as const) {
      const answers = { older: held(), newer: held() };
      const { fetch, asked } = answering(answers.older.answer, answers.newer.answer);
      const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
      const reads = { older: provider.liveCatalogue(), newer: provider.liveCatalogue() };
      for (const which of order) {
        const lines = channel("X.test@HD", `https://${which}.example/x.m3u8`);
        answers[which].give(new Response(playlist(...lines)));
        await reads[which];
      }
      expect(await provider.liveStream("X.test@HD")).toEqual({
        url: "https://newer.example/x.m3u8",
        format: "hls",
      });
      expect(asked).toHaveLength(2);
    }
  });

  it("keeps the streams it had when a newer read is stopped", async () => {
    const late = held();
    const { fetch, asked } = answering(
      () => new Response(playlist(...channel("X.test@HD", "https://first.example/x.m3u8"))),
      late.answer,
    );
    const provider = demoProvider({ fetch, ...PLAYLIST_LIVE });
    await provider.liveCatalogue();
    const stop = new AbortController();
    const stopped = provider.liveCatalogue(stop.signal);
    stop.abort();
    late.give(new Response(playlist(...channel("X.test@HD", "https://stopped.example/x.m3u8"))));
    await expect(stopped).rejects.toMatchObject({ name: "AbortError" });
    expect(await provider.liveStream("X.test@HD")).toEqual({
      url: "https://first.example/x.m3u8",
      format: "hls",
    });
    expect(asked).toHaveLength(2);
  });
});
