// Downloads through the real main runtime: the fake provider at the HTTP boundary, ffprobe and
// the loopback proxy for copies, and a disk that can fail the way a full or missing one does.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { setLanguage } from "@mrstreamer/core/i18n";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { OperationObserver } from "../src/main/analytics/operations.ts";
import type { AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { OperationOutcome } from "../src/main/analytics/operations.ts";
import { fileDisk, type Disk } from "../src/main/downloads/transfer.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Downloads } from "../src/main/services/downloads.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { OnlineSubtitles } from "../src/main/services/online-subtitles.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture, type FakeProvider, type FakeProviderOptions } from "./fake-provider.ts";
import { startFakeTmdb, type FakeTmdb } from "./fake-tmdb.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const hasTools =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
const DECODERS = ["h264", "aac"] as const;
const LONG = 30_000;

/** A picture for every artwork address, so copies keep theirs without the network. */
const pictures: typeof fetch = async () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    headers: { "Content-Type": "image/png" },
  });

/** The app's services on `dataDir`, as one start of the app has them, with TMDB at `tmdb`. */
async function app(
  dataDir: string,
  disk?: Disk,
  tmdb?: FakeTmdb,
  observeTransfer?: OperationObserver,
) {
  const runtime = runtimeFor(
    mainLayer({
      ...testConfig(dataDir),
      ...(tmdb ? { tmdbKey: "test-key", tmdbApi: tmdb.url } : {}),
      ffmpeg: "ffmpeg",
      ffprobe: "ffprobe",
      downloads: {
        fetch: pictures,
        ...(disk ? { disk } : {}),
        ...(observeTransfer ? { observeTransfer } : {}),
      },
    }),
  );
  const downloads = await promised(runtime, Downloads);
  return {
    runtime,
    downloads,
    playback: await promised(runtime, Playback),
    subscriptions: await promised(runtime, Subscriptions),
    onDemand: await promised(runtime, OnDemand),
    roster: await promised(runtime, Roster),
    subtitles: await promised(runtime, OnlineSubtitles),
    /** The download of `id` as the list has it now. */
    find: async (id: string): Promise<Download | undefined> =>
      (await downloads.list()).items.find((each) => each.id === id),
    quit: () => runtime.dispose(),
  };
}

/** A connected subscription of a fake provider allowing one connection, its lists loaded. */
async function connected(
  options: FakeProviderOptions = {},
  disk?: Disk,
  observeTransfer?: OperationObserver,
) {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50, ...options });
  const dataDir = await tempDir();
  const started = await app(dataDir, disk, undefined, observeTransfer);
  const saved = await started.subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await started.onDemand.refresh(saved.id);
  return { provider, dataDir, subscriptionId: saved.id, ...started };
}

function movie(provider: FakeProvider, subscriptionId: string, name: string) {
  const found = provider.titles.movies.find((each) => each.name.startsWith(name));
  if (!found) throw new Error(`No movie ${name}`);
  return {
    id: found.id,
    bytes: found.fixture ? fixture(found.fixture) : Buffer.alloc(0),
    ref: { kind: "movie", subscriptionId, id: String(found.id) } satisfies TitleRef,
  };
}

function episode(provider: FakeProvider, subscriptionId: string) {
  const series = provider.titles.series.find((each) => each.name === "TEST | Formats (NL)")!;
  const file = series.seasons[0]![1]!;
  return {
    bytes: fixture(file.fixture!),
    ref: {
      kind: "episode",
      subscriptionId,
      id: String(file.id),
      seriesId: String(series.id),
      season: 1,
      episode: 2,
    } satisfies TitleRef,
  };
}

/** The one file a download keeps of the title, by its folder. */
async function copyOf(dataDir: string, id: string): Promise<Buffer> {
  const names = await readdir(join(dataDir, "downloads", id));
  const media = names.find((name) => name.startsWith("media.") && !name.endsWith(".part"));
  if (!media) throw new Error(`No copy in ${names.join(", ")}`);
  return readFile(join(dataDir, "downloads", id, media));
}

/** A file's bytes as one short string, so a mismatch fails without comparing them byte by byte. */
function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Reads a copy session's picture from `start` seconds, as the player asks for it. */
async function read(url: string, start: number): Promise<number> {
  const answer = await fetch(`${url}?start=${start}`);
  expect(answer.ok).toBe(true);
  return (await answer.arrayBuffer()).byteLength;
}

/**
 * Fakes `setTimeout` for the rest of the test, in main and the fake provider alike: time still
 * goes by as it does, and a test moves it on past a wait with `vi.advanceTimersByTimeAsync`
 * instead of sitting through it.
 */
function useMovedClock() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  onTestFinished(() => void vi.useRealTimers());
}

/** The film's address on the playlist host: a secret in its path, as a provider's login is. */
const FILM = "/s3cr3t-token/film.mp4";

/**
 * A playlist host with one mapped film, which wants its own User-Agent, as playlists name one.
 * `hold` keeps the next list or file request unanswered until released.
 */
async function playlistHost() {
  const film = fixture("title-h264-aac.mp4");
  let origin = "";
  const asked: string[] = [];
  const holds = new Map<string, { arrived: () => void; released: Promise<void> }>();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://host").pathname;
    asked.push(path);
    const held = holds.get(path);
    holds.delete(path);
    held?.arrived();
    void (held?.released ?? Promise.resolve()).then(() => {
      if (response.destroyed) return;
      if (path === "/list") {
        return response.end(
          [
            "#EXTM3U",
            '#EXTINF:-1 group-title="Films",Twelve',
            "#EXTVLCOPT:http-user-agent=Twelve",
            `${origin}${FILM}`,
            "",
          ].join("\n"),
        );
      }
      if (path !== FILM || request.headers["user-agent"] !== "Twelve") {
        return response.writeHead(403).end();
      }
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
      const start = range ? Number(range[1]) : 0;
      response.writeHead(range ? 206 : 200, {
        "Content-Type": "video/mp4",
        "Content-Length": film.length - start,
        ETag: '"twelve"',
        ...(range ? { "Content-Range": `bytes ${start}-${film.length - 1}/${film.length}` } : {}),
      });
      response.end(film.subarray(start));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    film,
    link: `${origin}/list?token=fake`,
    asked: (path: string) => asked.filter((each) => each === path).length,
    hold(path: "/list" | typeof FILM) {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      holds.set(path, { arrived: arrived.resolve, released: released.promise });
      return { arrived: arrived.promise, release: () => released.resolve() };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A playlist host with one mapped film whose address redirects to `/media.<extension>?cut=` and
 * the current `cut`: two files of one size behind one path, told apart only by their query, under
 * the same ETag. While `held`, a file answer stops after 40 kB. With `lengthless`, cut b answers
 * with the whole file and no size, as a chunked answer does.
 */
async function cutsHost({ film = "title-h264-aac.mp4", lengthless = false } = {}) {
  const extension = film.endsWith(".mpegts") ? "ts" : "mp4";
  const type = extension === "ts" ? "video/mp2t" : "video/mp4";
  const first = fixture(film);
  // One byte of its pictures differs, within the first 40 kB, so both play.
  const second = Buffer.from(first);
  second[30_000]! ^= 0xff;
  let origin = "";
  const state = { cut: "a", held: false };
  const asked: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", origin);
    asked.push(url.pathname + url.search);
    if (url.pathname === "/list") {
      return response.end(
        `#EXTM3U\n#EXTINF:-1 group-title="Films",Film\n${origin}/film.${extension}\n`,
      );
    }
    if (url.pathname === `/film.${extension}`) {
      return response.writeHead(302, { Location: `/media.${extension}?cut=${state.cut}` }).end();
    }
    const bytes = url.searchParams.get("cut") === "a" ? first : second;
    if (lengthless && bytes === second) {
      return response.writeHead(200, { "Content-Type": type, ETag: '"one"' }).end(bytes);
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    response.writeHead(range ? 206 : 200, {
      "Content-Type": type,
      "Content-Length": bytes.length - start,
      ETag: '"one"',
      ...(range ? { "Content-Range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    });
    if (state.held) response.write(bytes.subarray(start, 40_000));
    else response.end(bytes.subarray(start));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    first,
    second,
    state,
    link: `${origin}/list`,
    asked: (path: string) => asked.filter((each) => each === path).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Saves `link` as a playlist whose Films are movies, and its one film. */
async function mappedFilm(started: Awaited<ReturnType<typeof app>>, link: string) {
  const saved = await started.subscriptions.add({ server: link, username: "", password: "" });
  await started.subscriptions.mapPlaylist(saved.id, playlistGroupId("Films"), "movie");
  await started.onDemand.refresh(saved.id);
  const source = (await started.subscriptions.sources())[0]!;
  const [listed] = (await source.provider.onDemandCatalogue()).movies;
  return { kind: "movie", subscriptionId: saved.id, id: listed!.id } satisfies TitleRef;
}

/**
 * Answers SubDL at main's `fetch` with one English result for whatever is asked, of the release
 * `answer.release` names, and counts. `answer.fileMark` changes the ETag of the provider's file
 * answers: a string replaces it, null removes it.
 */
function serveSubdl() {
  const request = fetch;
  let requests = 0;
  const answer: { release: string; fileMark?: string | null } = { release: "Cinema cut" };
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "api.subdl.com") {
      requests++;
      return Response.json({
        status: true,
        results: [{ tmdb_id: Number(url.searchParams.get("tmdb_id")), type: "movie" }],
        subtitles: [
          {
            language: "English",
            release_name: answer.release,
            url: `https://dl.subdl.com/${encodeURIComponent(answer.release)}.srt`,
          },
        ],
      });
    }
    if (url.hostname === "dl.subdl.com") {
      requests++;
      return new Response(`1\n00:00:01,000 --> 00:00:03,000\n${answer.release}.\n`);
    }
    const response = await request(input, init);
    if (answer.fileMark === undefined || !url.pathname.startsWith("/files/")) return response;
    const headers = new Headers(response.headers);
    if (answer.fileMark === null) headers.delete("etag");
    else headers.set("etag", answer.fileMark);
    const marked = new Response(response.body, { status: response.status, headers });
    Object.defineProperty(marked, "url", { value: response.url });
    return marked;
  });
  onTestFinished(() => spy.mockRestore());
  return { answer, requests: () => requests };
}

describe.skipIf(!hasTools)("downloads", () => {
  it("downloads a movie and an episode, then plays the copies with no provider request", async () => {
    const { provider, dataDir, subscriptionId, downloads, playback, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const show = episode(provider, subscriptionId);
    const first = await downloads.add(film.ref);
    const second = await downloads.add(show.ref);
    expect(first).toMatchObject({
      title: { kind: "movie", id: film.ref.id },
      subscription: { id: subscriptionId },
    });
    expect(second).toMatchObject({
      episodeName: expect.any(String),
      title: { season: 1, episode: 2 },
    });
    // Asking again answers the same download.
    expect((await downloads.add(film.ref)).id).toBe(first.id);
    await vi.waitFor(
      async () => {
        expect((await find(first.id))?.status.kind).toBe("complete");
        expect((await find(second.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, first.id))).toBe(digest(film.bytes));
    expect(digest(await copyOf(dataDir, second.id))).toBe(digest(show.bytes));
    const listed = await find(first.id);
    expect(listed).toMatchObject({
      size: film.bytes.length,
      posterUrl: expect.stringMatching(/^mrstreamer:\/\/download\//),
    });
    expect(provider.mostFilesAtOnce()).toBe(1);

    const asked = provider.fileRequests();
    const copy = await playback.openCopy(
      {
        id: first.id,
        path: join(dataDir, "downloads", first.id, "media.mkv"),
        container: "mkv",
        title: first.title,
        progress: null,
      },
      DECODERS,
    );
    expect(copy.audio.length).toBe(2);
    expect(copy.subtitles.length).toBeGreaterThan(0);
    expect(await read(copy.url, 0)).toBeGreaterThan(0);
    expect(await read(copy.url, 2)).toBeGreaterThan(0);
    await downloads.recordProgress(first.id, 3, 10);
    // Opened again at once, it says where it was left before any list has told of it.
    const again = await playback.openCopy(await downloads.copy(first.id), DECODERS);
    expect(again.progress).toEqual({ position: 3, duration: 10 });
    expect((await find(first.id))?.progress).toEqual({ position: 3, duration: 10 });
    expect(provider.fileRequests()).toBe(asked);
    await playback.close(again.sessionId);
  }, 60_000);

  it("goes on from the partial file after a restart when the provider proves it is the same file", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => {
        const status = (await find(queued.id))?.status;
        expect(status).toMatchObject({ kind: "transferring", received: 200_000 });
      },
      { timeout: LONG },
    );
    await quit();
    const sentBefore = provider.fileBytes();
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));

    const again = await app(dataDir);
    await vi.waitFor(
      async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
    // Only the rest was sent again.
    expect(provider.fileBytes() - sentBefore).toBe(film.bytes.length - 200_000);
  }, 60_000);

  it("starts again, and says so, when the file was replaced or the provider ignores ranges", async () => {
    for (const options of [{}, { wholeFiles: true }]) {
      const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected(options);
      const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
      provider.stallMovieFile(film.id, 200_000, 60_000);
      const queued = await downloads.add(film.ref);
      await vi.waitFor(
        async () => {
          expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 });
        },
        { timeout: LONG },
      );
      await quit();
      const replacement = fixture("title-long-subs.mkv");
      if (!options.wholeFiles) provider.replaceMovieFile(film.id, replacement);
      provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
      const sentBefore = provider.fileBytes();
      const again = await app(dataDir);
      await vi.waitFor(
        async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
        { timeout: LONG },
      );
      // The whole file again from its first byte, never the old bytes with new ones after them.
      const copy = options.wholeFiles ? film.bytes : replacement;
      expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(copy));
      expect(provider.fileBytes() - sentBefore).toBe(copy.length);
    }
  }, 120_000);

  it("keeps a partial file the old file's until a replacement is written over it, through a full disk or a crash", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    await quit();
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    // As long as the first, of other bytes: only its mark tells it apart.
    const replacement = Buffer.from(film.bytes);
    replacement.fill(0xab, 0, 200_000);
    provider.replaceMovieFile(film.id, replacement);
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);

    // The app stops as the replacement is about to be written, before the partial was emptied,
    // as a crash would: a start from what was on disk then takes the replacement whole.
    const writing = Promise.withResolvers<void>();
    const crashing = await app(dataDir, {
      ...fileDisk,
      write: () => {
        writing.resolve();
        return new Writable({ write: () => {} });
      },
    });
    await writing.promise;
    const crashed = await tempDir();
    await cp(dataDir, crashed, { recursive: true });
    await crashing.quit();
    const recovered = await app(crashed);
    await vi.waitFor(
      async () => expect((await recovered.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(crashed, queued.id))).toBe(digest(replacement));
    await recovered.quit();

    // No room for the replacement: the partial stays the old file's, and Retry takes the new one.
    let free = 0;
    const full = await app(dataDir, { ...fileDisk, free: async () => free });
    await vi.waitFor(
      async () =>
        expect((await full.find(queued.id))?.status).toMatchObject({
          kind: "failed",
          failure: { kind: "disk-full" },
        }),
      { timeout: LONG },
    );
    free = Number.MAX_SAFE_INTEGER;
    await full.downloads.retry(queued.id);
    await vi.waitFor(
      async () => expect((await full.find(queued.id))?.status.kind).toBe("complete"),
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(replacement));
  }, 90_000);

  it("gives the connection to playback of its subscription, waits, then finishes", async () => {
    const { provider, dataDir, subscriptionId, downloads, playback, onDemand, find } =
      await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => {
        expect((await find(queued.id))?.status).toMatchObject({
          kind: "transferring",
          received: 200_000,
        });
      },
      { timeout: LONG },
    );
    // One connection allowed: the stream opens only because the download gave its own back.
    const file = await onDemand.file(other.ref);
    const playing = await playback.openTitle(other.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect((await find(queued.id))?.status.kind).toBe("waiting");
    expect(provider.mostFilesAtOnce()).toBe(1);
    // Going on from wherever its partial file ended, it is sent the rest without a pause.
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await playback.close(playing.sessionId);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("fails an open whose download hasn't closed its partial file in time, and opens once it has", async () => {
    // The first partial file closes only when the test lets it; it keeps none of its bytes.
    const closing = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    let held = true;
    const disk: Disk = {
      ...fileDisk,
      write: (path, start) => {
        if (!held) return fileDisk.write(path, start);
        held = false;
        return new Writable({
          write: (_chunk, _encoding, done) => done(),
          destroy: (error, done) => {
            closing.resolve();
            void closed.promise.then(() => done(error));
          },
        });
      },
    };
    const { provider, dataDir, subscriptionId, downloads, playback, onDemand, find } =
      await connected({}, disk);
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    const asked = provider.fileRequests();
    const file = await onDemand.file(other.ref);
    // The open waits 10 s for the partial file to close: the clock is moved on past that.
    useMovedClock();
    const refused = expect(
      playback.openTitle(other.ref, file.url, DECODERS, file),
    ).rejects.toMatchObject({ error: { kind: "stream", failure: { kind: "network" } } });
    await closing.promise;
    try {
      await vi.advanceTimersByTimeAsync(10_000);
      // The provider hears nothing of the stream while the download's file is still open.
      await refused;
      expect(provider.fileRequests()).toBe(asked);
    } finally {
      closed.resolve();
    }
    // Asked again once it closed, it plays.
    const playing = await playback.openTitle(other.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect(provider.mostFilesAtOnce()).toBe(1);
    provider.stallMovieFile(film.id, Number.MAX_SAFE_INTEGER, 0);
    await playback.close(playing.sessionId);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
  }, 60_000);

  it("cancels mid-request and while queued, leaving nothing, and retries a failed one", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const next = movie(provider, subscriptionId, "TEST | Index at the end");
    const broken = movie(provider, subscriptionId, "TEST | Missing file");
    provider.stallMovieFile(film.id, 200_000, 60_000);
    const running = await downloads.add(film.ref);
    const waiting = await downloads.add(next.ref);
    await vi.waitFor(
      async () => {
        expect((await find(running.id))?.status.kind).toBe("transferring");
        expect((await find(waiting.id))?.status.kind).toBe("queued");
      },
      { timeout: LONG },
    );
    await downloads.remove(waiting.id);
    await downloads.remove(running.id);
    // The request ended with the cancel.
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    expect((await downloads.list()).items).toEqual([]);
    expect(await readdir(join(dataDir, "downloads"))).toEqual([]);

    const failing = await downloads.add(broken.ref);
    await vi.waitFor(
      async () => {
        expect((await find(failing.id))?.status).toMatchObject({
          kind: "failed",
          failure: { kind: "stream", failure: { kind: "unavailable" } },
        });
      },
      { timeout: LONG },
    );
    const asked = provider.fileRequests();
    await downloads.retry(failing.id);
    await vi.waitFor(
      async () => {
        expect(provider.fileRequests()).toBeGreaterThan(asked);
        expect((await find(failing.id))?.status.kind).toBe("failed");
      },
      { timeout: LONG },
    );
  }, 60_000);

  it("tells of a failed download added again while its subscription plays", async () => {
    const { provider, subscriptionId, runtime, downloads, playback, onDemand, find } =
      await connected();
    const broken = movie(provider, subscriptionId, "TEST | Missing file");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    const failing = await downloads.add(broken.ref);
    await vi.waitFor(async () => expect((await find(failing.id))?.status.kind).toBe("failed"), {
      timeout: LONG,
    });
    const file = await onDemand.file(other.ref);
    const playing = await playback.openTitle(other.ref, file.url, DECODERS, file);
    const told = await collect(runtime, downloads.changes);
    // Playback holds the subscription, so no start of the download tells of it instead.
    const again = await downloads.add(broken.ref);
    expect(again).toMatchObject({ id: failing.id, status: { kind: "waiting" } });
    await vi.waitFor(() =>
      expect(told.at(-1)?.items).toMatchObject([{ id: failing.id, status: { kind: "waiting" } }]),
    );
    await playback.close(playing.sessionId);
  }, 60_000);

  it("fails on a full disk or a missing folder, and never makes a copy of the partial", async () => {
    // The error the disk fails each write with, and the room it says it has: the file system's
    // where null. One start serves each case, the download retried after the disk changes.
    let fails: { code: string; message: string } | null = {
      code: "ENOSPC",
      message: "no space left on device",
    };
    let free: number | null = null;
    const disk: Disk = {
      ...fileDisk,
      free: async (dir) => free ?? fileDisk.free(dir),
      write: (path, start) => {
        const failure = fails;
        if (!failure) return fileDisk.write(path, start);
        return new Writable({
          write: (_chunk, _encoding, done) =>
            done(Object.assign(new Error(failure.message), { code: failure.code })),
        });
      },
    };
    const { provider, subscriptionId, downloads, find } = await connected({}, disk);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const queued = await downloads.add(film.ref);
    const failsWith = (failure: object) =>
      vi.waitFor(
        async () => expect((await find(queued.id))?.status).toEqual({ kind: "failed", failure }),
        { timeout: LONG },
      );
    await failsWith({ kind: "disk-full", needed: null });

    // Too little room for the file, known before a byte of it is written.
    fails = null;
    free = 1000;
    await downloads.retry(queued.id);
    await failsWith({ kind: "disk-full", needed: film.bytes.length - 1000 });

    free = null;
    fails = { code: "ENOENT", message: "no such file or directory" };
    await downloads.retry(queued.id);
    await failsWith({ kind: "folder", detail: expect.any(String) });
    const items = (await downloads.list()).items;
    expect(items.every((item) => item.status.kind !== "complete")).toBe(true);
  }, 60_000);

  it("ends unfinished downloads with their subscription and keeps its copies playable after a restart", async () => {
    const { provider, dataDir, subscriptionId, downloads, roster, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const held = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await downloads.recordProgress(done.id, 4, 8);
    provider.stallMovieFile(held.id, 200_000, 60_000);
    const unfinished = await downloads.add(held.ref);
    await vi.waitFor(
      async () => expect((await find(unfinished.id))?.status.kind).toBe("transferring"),
      { timeout: LONG },
    );
    await roster.remove(subscriptionId, true);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    const after = await downloads.list();
    expect(after.ended).toBe(1);
    expect(after.items.map((item) => item.id)).toEqual([done.id]);
    expect(after.items[0]).toMatchObject({
      subscription: null,
      status: { kind: "complete" },
      progress: { position: 4, duration: 8 },
    });
    await quit();
    await provider.close();

    const again = await app(dataDir);
    expect(await again.subscriptions.list()).toEqual([]);
    const [kept] = (await again.downloads.list()).items;
    expect(kept).toMatchObject({
      id: done.id,
      name: expect.any(String),
      posterUrl: expect.any(String),
      progress: { position: 4 },
    });
    const copy = await again.playback.openCopy(
      {
        id: done.id,
        path: join(dataDir, "downloads", done.id, "media.mp4"),
        container: "mp4",
        title: kept!.title,
        progress: null,
      },
      DECODERS,
    );
    expect(await read(copy.url, 1)).toBeGreaterThan(0);
    await again.downloads.remove(done.id);
    expect((await again.downloads.list()).items).toEqual([]);
    expect(await readdir(join(dataDir, "downloads"))).toEqual([]);
  }, 60_000);

  it("converts a rejected offline video copy without contacting its provider", async () => {
    const { provider, subscriptionId, downloads, playback, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    provider.replaceMovieFile(film.id, Buffer.from(fixture("title-h264-10bit.mkv")));
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    const requests = provider.fileRequests();
    await provider.close();
    const copy = await playback.openCopy(await downloads.copy(done.id), DECODERS);
    for (const [query, expected] of [
      ["start=3&audio=2", "copy"],
      ["start=6&audio=2&picture=convert", "convert"],
      ["start=9&audio=1", "convert"],
    ]) {
      const response = await fetch(`${copy.url}?${query}`);
      expect(response.headers.get("x-title-video")).toBe(expected);
      expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    }
    expect(provider.fileRequests()).toBe(requests);
    await playback.close(copy.sessionId);
  });

  it("answers adds of one title made at once with one download", async () => {
    const { provider, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const [first, second] = await Promise.all([downloads.add(film.ref), downloads.add(film.ref)]);
    expect(second.id).toBe(first.id);
    expect((await downloads.list()).items.map((item) => item.id)).toEqual([first.id]);
    await vi.waitFor(async () => expect((await find(first.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await quit();
  }, 60_000);

  it("queues nothing of a subscription removed while the episode's details were asked for", async () => {
    const tmdb = await startFakeTmdb();
    onTestFinished(() => tmdb.close());
    const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
    const dataDir = await tempDir();
    const { subscriptions, onDemand, downloads, roster, quit } = await app(
      dataDir,
      undefined,
      tmdb,
    );
    const saved = await subscriptions.add({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    await onDemand.refresh(saved.id);
    tmdb.failSeasons("hold");
    const asked = tmdb.seasonRequests().length;
    const adding = downloads.add(episode(provider, saved.id).ref);
    // Removal aborts the held request immediately; observe its rejection before the assertion below.
    void adding.catch(() => {});
    await vi.waitFor(() => expect(tmdb.seasonRequests().length).toBeGreaterThan(asked));
    await roster.remove(saved.id, true);
    // TMDB answers only now, once the subscription has gone.
    tmdb.failSeasons(null);
    await expect(adding).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect((await downloads.list()).items).toEqual([]);
    await quit();
  }, 60_000);

  it("asks again when the provider is still freeing the connection of the download before", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected({
      slotReleaseMs: 800,
    });
    const first = movie(provider, subscriptionId, "TEST | Index at the end");
    const second = movie(provider, subscriptionId, "TEST | Old AVI");
    const a = await downloads.add(first.ref);
    const b = await downloads.add(second.ref);
    await vi.waitFor(
      async () => {
        expect((await find(a.id))?.status.kind).toBe("complete");
        expect((await find(b.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    expect(digest(await copyOf(dataDir, b.id))).toBe(digest(second.bytes));
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 60_000);

  it("says a copy whose file is gone is missing, plays nothing of it, and still deletes it", async () => {
    const { provider, dataDir, subscriptionId, runtime, downloads, find } = await connected();
    const told = await collect(runtime, downloads.changes);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(() => expect(told.at(-1)?.items[0]?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // Nothing more to tell of, so no later list of the finished copy can be what finds it gone.
    await new Promise((resolve) => setTimeout(resolve, 600));
    await rm(join(dataDir, "downloads", done.id, "media.mp4"));
    // Opening it is what finds the file gone, so the window that last heard complete hears of it.
    await expect(downloads.copy(done.id)).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unavailable" } },
    });
    await vi.waitFor(() =>
      expect(told.at(-1)?.items).toMatchObject([{ id: done.id, status: { kind: "missing" } }]),
    );
    expect((await find(done.id))?.status.kind).toBe("missing");
    await downloads.remove(done.id);
    expect((await downloads.list()).items).toEqual([]);
  }, 60_000);

  it("tells of a deleted copy last, though a list made before it waited on the disk", async () => {
    let hold: PromiseWithResolvers<void> | null = null;
    const held = Promise.withResolvers<void>();
    const slow: Disk = {
      ...fileDisk,
      free: async (dir) => {
        const holding = hold;
        // Only the downloads folder's, which the list asks for; a transfer asks for its own.
        if (holding && basename(dir) === "downloads") {
          hold = null;
          held.resolve();
          await holding.promise;
        }
        return fileDisk.free(dir);
      },
    };
    const { provider, subscriptionId, runtime, downloads, find } = await connected({}, slow);
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    const told = await collect(runtime, downloads.changes);
    const release = Promise.withResolvers<void>();
    hold = release;
    await downloads.recordProgress(done.id, 3, 20);
    // The list telling of that progress has the copy, and waits for the disk's free space.
    await held.promise;
    await downloads.remove(done.id);
    // Time for a later list to be told first, were one made meanwhile.
    await new Promise((resolve) => setTimeout(resolve, 600));
    release.resolve();
    await vi.waitFor(() => expect(told.at(-1)?.items).toEqual([]));
    expect((await downloads.list()).items).toEqual([]);
    const gone = told.findIndex((list) => list.items.length === 0);
    expect(told.slice(gone).flatMap((list) => list.items)).toEqual([]);
  }, 60_000);

  it("deletes no copy it can't read the record of, and says it can't read them", async () => {
    const { provider, dataDir, subscriptionId, downloads, find, quit } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const done = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(done.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    await quit();
    // A download of a later build, with a record this one doesn't know.
    const later = randomUUID();
    const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
    db.prepare("insert into downloads (id, added_at, record) values (?, ?, ?)").run(
      later,
      Date.now(),
      JSON.stringify({ id: later, kept: "differently" }),
    );
    db.close();
    await mkdir(join(dataDir, "downloads", later));
    await writeFile(join(dataDir, "downloads", later, "media.mkv"), "a later build's copy");

    const again = await app(dataDir);
    expect((await again.downloads.list()).items.map((item) => item.id)).toEqual([done.id]);
    await again.quit();
    expect((await readdir(join(dataDir, "downloads"))).toSorted()).toEqual(
      [done.id, later].toSorted(),
    );

    // A database that can't be opened lists, queues and deletes nothing.
    await writeFile(join(dataDir, "mrstreamer.db"), "not a database");
    const unreadable = await app(dataDir);
    await expect(unreadable.downloads.list()).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    await expect(unreadable.downloads.add(film.ref)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect((await readdir(join(dataDir, "downloads"))).toSorted()).toEqual(
      [done.id, later].toSorted(),
    );
    expect(digest(await copyOf(dataDir, done.id))).toBe(digest(film.bytes));
    await unreadable.quit();
  }, 60_000);

  it("lets another subscription play while a download goes on", async () => {
    const { provider, subscriptionId, downloads, subscriptions, onDemand, playback, find } =
      await connected();
    const other = await fakeProvider({ maxConnections: 1, slotReleaseMs: 50 });
    const second = await subscriptions.add({
      server: other.url,
      username: "demo",
      password: "demo",
    });
    await onDemand.refresh(second.id);
    const film = movie(provider, subscriptionId, "TEST | Two sound tracks and subtitles (MULTI)");
    // The download pauses while the other plays, then goes on once the clock is moved past it.
    useMovedClock();
    provider.stallMovieFile(film.id, 200_000, 10_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 200_000 }),
      { timeout: LONG },
    );
    const elsewhere = movie(other, second.id, "TEST | Index at the end");
    const file = await onDemand.file(elsewhere.ref);
    const playing = await playback.openTitle(elsewhere.ref, file.url, DECODERS, file);
    expect(await read(playing.url, 0)).toBeGreaterThan(0);
    expect((await find(queued.id))?.status.kind).toBe("transferring");
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    // The download's provider was asked once for the file, never stopped for the other's stream.
    expect(provider.fileRequests()).toBe(2);
    await playback.close(playing.sessionId);
  }, 60_000);

  it("waits out a provider that stops sending for longer than it took to answer", async () => {
    const { provider, dataDir, subscriptionId, downloads, find } = await connected();
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    // A pause past the 15 s an answer gets to start, well within the minute a body may say
    // nothing: the clock is moved on through it rather than waited out.
    useMovedClock();
    provider.stallMovieFile(film.id, 30_000, 17_000);
    const queued = await downloads.add(film.ref);
    await vi.waitFor(
      async () => expect((await find(queued.id))?.status).toMatchObject({ received: 30_000 }),
      { timeout: LONG },
    );
    await vi.advanceTimersByTimeAsync(17_000);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(film.bytes));
  }, 60_000);

  it("downloads a mapped playlist's film with its headers, and stops while the file is still looked up", async () => {
    const host = await playlistHost();
    try {
      const dataDir = await tempDir();
      const first = await app(dataDir);
      const saved = await first.subscriptions.add({
        server: host.link,
        username: "",
        password: "",
      });
      await first.subscriptions.mapPlaylist(saved.id, playlistGroupId("Films"), "movie");
      await first.onDemand.refresh(saved.id);
      const source = (await first.subscriptions.sources())[0]!;
      const [listed] = (await source.provider.onDemandCatalogue()).movies;
      const ref: TitleRef = { kind: "movie", subscriptionId: saved.id, id: listed!.id };
      // Quit with the file's answer held: the queue keeps it.
      const answer = host.hold(FILM);
      const queued = await first.downloads.add(ref);
      await answer.arrived;
      await first.quit();
      answer.release();

      // The next start reads the playlist again before it knows the file: removed meanwhile, the
      // file is never asked for.
      const files = host.asked(FILM);
      const list = host.hold("/list");
      const second = await app(dataDir);
      await list.arrived;
      expect((await second.find(queued.id))?.status.kind).toBe("transferring");
      await second.downloads.remove(queued.id);
      list.release();
      expect((await second.downloads.list()).items).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(host.asked(FILM)).toBe(files);
      expect(await readdir(join(dataDir, "downloads"))).toEqual([]);

      // Queued again and quit while it is looked up: the next start finishes it.
      const again = await second.downloads.add(ref);
      await vi.waitFor(
        async () => expect((await second.find(again.id))?.status.kind).toBe("complete"),
        { timeout: LONG },
      );
      expect(digest(await copyOf(dataDir, again.id))).toBe(digest(host.film));
      // What is kept on disk names no address: the secret in the file's path stays in memory.
      const db = new DatabaseSync(join(dataDir, "mrstreamer.db"), { readOnly: true });
      try {
        const kept = JSON.stringify(db.prepare("select * from downloads").all());
        expect(kept).toContain(again.id);
        expect(kept).not.toContain("s3cr3t");
        expect(kept).not.toContain("127.0.0.1");
      } finally {
        db.close();
      }
      const another = await second.downloads.add({ ...ref });
      expect(another.id).toBe(again.id);
      await second.quit();
    } finally {
      await host.close();
    }
  }, 60_000);

  it("starts again when a file's address redirects to another query, whatever its mark", async () => {
    const host = await cutsHost();
    host.state.held = true;
    try {
      const dataDir = await tempDir();
      const started = await app(dataDir);
      const queued = await started.downloads.add(await mappedFilm(started, host.link));
      await vi.waitFor(
        async () =>
          expect((await started.find(queued.id))?.status).toMatchObject({ received: 40_000 }),
        { timeout: LONG },
      );
      await started.quit();
      host.state.cut = "b";
      host.state.held = false;
      const again = await app(dataDir);
      await vi.waitFor(
        async () => expect((await again.find(queued.id))?.status.kind).toBe("complete"),
        { timeout: LONG },
      );
      expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(host.second));
      await again.quit();
    } finally {
      await host.close();
    }
  }, 60_000);

  it.each([
    { after: "the address redirected to another query", host: {}, from: 2 },
    {
      after: "an answer of another query didn't say its size",
      host: { film: "h264-aac.mpegts", lengthless: true },
      from: 0,
    },
  ])(
    "brings no subtitle along that was chosen or timed after $after",
    async (cases) => {
      const service = serveSubdl();
      const host = await cutsHost(cases.host);
      try {
        const dataDir = await tempDir();
        const started = await app(dataDir);
        const { playback, onDemand, subtitles } = started;
        await subtitles.configure(
          { enabled: true, service: "subdl", languages: ["en"] },
          { subdl: { apiKey: "fixture-key" } },
        );
        const ref = await mappedFilm(started, host.link);
        const file = await onDemand.file(ref);
        const session = await playback.openTitle(ref, file.url, DECODERS, file);
        const choose = async (release: string) => {
          service.answer.release = release;
          const found = await subtitles.search(session.sessionId);
          return (await subtitles.choose(session.sessionId, found.results[0]!.id)).saved.selection!;
        };
        expect(await read(session.url, 0)).toBeGreaterThan(0);
        const first = await choose("Cut A");
        // The same address now leads to the other file, read again, under the same size and ETag.
        host.state.cut = "b";
        expect(await read(session.url, cases.from)).toBeGreaterThan(0);
        expect(host.asked(`/media.${file.container}?cut=b`)).toBeGreaterThan(0);
        const second = await choose("Cut B");
        await subtitles.timing(session.sessionId, { offset: 3, speed: 1 });
        await playback.close(session.sessionId);

        host.state.cut = "a";
        const queued = await started.downloads.add(ref);
        await vi.waitFor(
          async () => expect((await started.find(queued.id))?.status.kind).toBe("complete"),
          { timeout: LONG },
        );
        expect(digest(await copyOf(dataDir, queued.id))).toBe(digest(host.first));
        const copy = await playback.openCopy(
          {
            id: queued.id,
            path: join(dataDir, "downloads", queued.id, `media.${file.container}`),
            container: file.container,
            title: queued.title,
            progress: null,
          },
          DECODERS,
        );
        expect(await read(copy.url, 0)).toBeGreaterThan(0);
        expect(await subtitles.saved(copy.sessionId)).toBeNull();
        await expect(subtitles.show(copy.sessionId, second)).rejects.toBeDefined();
        // What was chosen while only the first file had been read came along, for its bytes.
        await subtitles.show(copy.sessionId, first);
        expect(await subtitles.saved(copy.sessionId)).toMatchObject({
          subtitle: { release: "Cut A" },
          timing: { offset: 0 },
        });
        await playback.close(copy.sessionId);
        await started.quit();
      } finally {
        await host.close();
      }
    },
    60_000,
  );

  it("brings saved subtitles along only for the very bytes they were saved for", async () => {
    const service = serveSubdl();
    const { provider, subscriptionId, downloads, playback, onDemand, subtitles, find, dataDir } =
      await connected({ maxConnections: 2, slotReleaseMs: 0 });
    await subtitles.configure(
      { enabled: true, service: "subdl", languages: ["en"] },
      { subdl: { apiKey: "fixture-key" } },
    );
    const same = movie(provider, subscriptionId, "TEST | Long subtitles");
    const other = movie(provider, subscriptionId, "TEST | Index at the end");
    for (const film of [same, other]) {
      const file = await onDemand.file(film.ref);
      const session = await playback.openTitle(film.ref, file.url, DECODERS, file);
      expect(await read(session.url, 0)).toBeGreaterThan(0);
      const found = await subtitles.search(session.sessionId);
      await subtitles.choose(session.sessionId, found.results[0]!.id);
      await subtitles.timing(session.sessionId, { offset: -2, speed: 1 });
      await playback.close(session.sessionId);
    }
    // The second film's file changes before it is downloaded: its subtitles were for other bytes.
    provider.replaceMovieFile(other.id, fixture("title-mpeg4-mp3.avi"));
    const kept = await downloads.add(same.ref);
    const changed = await downloads.add(other.ref);
    await vi.waitFor(
      async () => {
        expect((await find(kept.id))?.status.kind).toBe("complete");
        expect((await find(changed.id))?.status.kind).toBe("complete");
      },
      { timeout: LONG },
    );
    const asked = service.requests();
    const copies = [
      { id: kept.id, container: "mkv" },
      { id: changed.id, container: "mp4" },
    ];
    const saved = [];
    for (const { id, container } of copies) {
      const download = (await find(id))!;
      const copy = await playback.openCopy(
        {
          id,
          path: join(dataDir, "downloads", id, `media.${container}`),
          container,
          title: download.title,
          progress: null,
        },
        DECODERS,
      );
      saved.push(await subtitles.saved(copy.sessionId));
      // A copy is searched for nowhere.
      await expect(subtitles.search(copy.sessionId)).rejects.toBeDefined();
      await playback.close(copy.sessionId);
    }
    expect(saved[0]).toMatchObject({ subtitle: { release: "Cinema cut" }, timing: { offset: -2 } });
    expect(saved[1]).toBeNull();
    expect(service.requests()).toBe(asked);
  }, 60_000);

  it("brings no subtitle chosen while nothing proved the bytes, though the file was proven before", async () => {
    const service = serveSubdl();
    const { provider, subscriptionId, downloads, playback, onDemand, subtitles, find, dataDir } =
      await connected({ maxConnections: 2, slotReleaseMs: 0 });
    await subtitles.configure(
      { enabled: true, service: "subdl", languages: ["en"] },
      { subdl: { apiKey: "fixture-key" } },
    );
    const film = movie(provider, subscriptionId, "TEST | Index at the end");
    const choose = async (release: string) => {
      service.answer.release = release;
      const file = await onDemand.file(film.ref);
      const session = await playback.openTitle(film.ref, file.url, DECODERS, file);
      expect(await read(session.url, 0)).toBeGreaterThan(0);
      const found = await subtitles.search(session.sessionId);
      await subtitles.choose(session.sessionId, found.results[0]!.id);
      await playback.close(session.sessionId);
    };
    service.answer.fileMark = '"first"';
    await choose("Cinema cut");
    // Other bytes of the same size behind the address, with nothing to tell them by.
    const other = Buffer.from(film.bytes);
    other[50_000]! ^= 0xff;
    provider.replaceMovieFile(film.id, other);
    service.answer.fileMark = null;
    await choose("Another cut");
    // The first file is back, as its mark says, and is downloaded.
    provider.replaceMovieFile(film.id, film.bytes);
    service.answer.fileMark = '"first"';
    const queued = await downloads.add(film.ref);
    await vi.waitFor(async () => expect((await find(queued.id))?.status.kind).toBe("complete"), {
      timeout: LONG,
    });
    const copy = await playback.openCopy(
      {
        id: queued.id,
        path: join(dataDir, "downloads", queued.id, "media.mp4"),
        container: "mp4",
        title: queued.title,
        progress: null,
      },
      DECODERS,
    );
    expect(await subtitles.saved(copy.sessionId)).toBeNull();
    await playback.close(copy.sessionId);
  }, 60_000);
});

// Main makes its services before it applies the saved interface language, and the viewer can pick
// another while it runs: a failure made later is in the language of that moment.
it("says a download asked for after it went is gone in the interface language picked since", async () => {
  const { downloads, quit } = await app(await tempDir());
  setLanguage({ locale: "fr-FR", formats: "fr-FR" });
  onTestFinished(() => setLanguage({ locale: "en-US", formats: "en-US" }));
  const gone = { error: { kind: "unexpected", detail: "Ce téléchargement n'est plus là." } };
  await expect(downloads.retry("gone")).rejects.toMatchObject(gone);
  await expect(downloads.recordProgress("gone", 3, 10)).rejects.toMatchObject(gone);
  await quit();
});

// A Downloads table this build can't prepare fails every call from the start, before main applies
// the saved interface language: each one says so in the language picked since, and keeps every folder.
it("says Downloads can't be opened in the interface language picked since the start", async () => {
  const dataDir = await tempDir();
  const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
  db.exec("create table downloads (id text primary key)");
  db.close();
  const kept = randomUUID();
  await mkdir(join(dataDir, "downloads", kept), { recursive: true });
  const { downloads, quit } = await app(dataDir);
  setLanguage({ locale: "fr-FR", formats: "fr-FR" });
  onTestFinished(() => setLanguage({ locale: "en-US", formats: "en-US" }));
  const closed = {
    error: { kind: "unexpected", detail: "Impossible d'ouvrir les téléchargements." },
  };
  await expect(downloads.list()).rejects.toMatchObject(closed);
  await expect(
    downloads.add({ kind: "movie", subscriptionId: "any", id: "1" }),
  ).rejects.toMatchObject(closed);
  await quit();
  expect(await readdir(join(dataDir, "downloads"))).toEqual([kept]);
});

it("observes actual download runs, successful completion, disk failure and cancelled transfers with bounded codes", async () => {
  const outcomes: { outcome: OperationOutcome; failure?: AnalyticsFailure }[] = [];
  let starts = 0;
  const observeTransfer: OperationObserver = () => {
    starts++;
    return (outcome, failure) => outcomes.push({ outcome, ...(failure ? { failure } : {}) });
  };
  // The file system's room until the last download, which finds none.
  let full = false;
  const disk: Disk = { ...fileDisk, free: async (dir) => (full ? 0 : fileDisk.free(dir)) };
  const started = await connected({}, disk, observeTransfer);
  const film = movie(started.provider, started.subscriptionId, "TEST | Index at the end");
  const done = await started.downloads.add(film.ref);
  await vi.waitFor(
    async () => expect((await started.find(done.id))?.status.kind).toBe("complete"),
    { timeout: LONG },
  );
  expect(outcomes).toEqual([{ outcome: "success" }]);
  await started.downloads.add(film.ref);
  expect(starts).toBe(1);
  const stoppedFilm = movie(
    started.provider,
    started.subscriptionId,
    "TEST | Two sound tracks and subtitles (MULTI)",
  );
  started.provider.stallMovieFile(stoppedFilm.id, 200_000, 60_000);
  const stopped = await started.downloads.add(stoppedFilm.ref);
  await vi.waitFor(
    async () =>
      expect((await started.find(stopped.id))?.status).toMatchObject({
        kind: "transferring",
        received: 200_000,
      }),
    { timeout: LONG },
  );
  await started.downloads.remove(stopped.id);
  expect(outcomes).toEqual([{ outcome: "success" }, { outcome: "interrupted" }]);
  const preempted = await started.downloads.add(stoppedFilm.ref);
  await vi.waitFor(
    async () =>
      expect((await started.find(preempted.id))?.status).toMatchObject({
        kind: "transferring",
        received: 200_000,
      }),
    { timeout: LONG },
  );
  const opened = await started.playback.openTitle(
    film.ref,
    (await started.onDemand.file(film.ref)).url,
    DECODERS,
  );
  await vi.waitFor(() =>
    expect(outcomes).toEqual([
      { outcome: "success" },
      { outcome: "interrupted" },
      { outcome: "interrupted" },
    ]),
  );
  expect((await started.find(preempted.id))?.status.kind).toBe("waiting");
  await started.downloads.remove(preempted.id);
  await started.playback.close(opened.sessionId);
  full = true;
  const failed = await started.downloads.add(
    movie(started.provider, started.subscriptionId, "TEST | Old AVI").ref,
  );
  await vi.waitFor(
    async () => expect((await started.find(failed.id))?.status.kind).toBe("failed"),
    { timeout: LONG },
  );
  expect(outcomes).toEqual([
    { outcome: "success" },
    { outcome: "interrupted" },
    { outcome: "interrupted" },
    { outcome: "failed", failure: "disk" },
  ]);
  expect(starts).toBe(4);
}, 60_000);
