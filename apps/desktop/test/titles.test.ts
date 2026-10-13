import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Codec } from "@mrstreamer/contracts/playback";
import * as Layer from "effect/Layer";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback, type PlaybackDeps } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { subtitleDecoder, type SubtitleCodec } from "@mrstreamer/core/subtitles/decoder";
import { readFeedLine, type SubtitlesUnavailable } from "@mrstreamer/core/subtitles/feed";
import type { SubtitleChange } from "@mrstreamer/core/subtitles/screen";
import { readMp4Start } from "../src/renderer/src/player/mp4.ts";
import { fixture, type FakeProviderOptions } from "./fake-provider.ts";
import {
  collect,
  fakeProvider,
  holdableFetch,
  promised,
  runtimeFor,
  tempDir,
  testSecrets,
  userAgent,
} from "./support.ts";

/** What Chromium on Linux decodes: no HEVC, no AC-3 or E-AC-3. */
const LINUX: readonly Codec[] = ["h264", "aac", "mp3", "opus", "flac"];

// CI points this at the bundled build, with ffprobe beside it; locally the ones on PATH do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

/**
 * Title playback on a connected fake provider that allows one connection and frees it as soon as
 * a request closes, unless `options` say otherwise. `fetchImpl` is what the subscription asks its
 * provider with.
 */
async function titles(
  deps: Partial<PlaybackDeps> = {},
  options: FakeProviderOptions = {},
  fetchImpl: typeof fetch = fetch,
) {
  const provider = await fakeProvider({ maxConnections: 1, slotReleaseMs: 0, ...options });
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: FFMPEG, ffprobe: FFPROBE, ...deps }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir: await tempDir(),
          secrets: testSecrets,
          providerOptions: { userAgent, fetch: fetchImpl },
        }),
      ),
    ),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  await subscriptions.add({ server: provider.url, username: "demo", password: "demo" });
  const [source] = await subscriptions.sources();
  const playback = await promised(runtime, Playback);
  /**
   * Opens a test movie by name, the way the app opens it from the catalogue. `asked` gives the
   * turn it is asked under, and has its address count as made under the login saved by then.
   */
  const open = async (
    name: string,
    decoders: readonly Codec[] = LINUX,
    asked?: { turn: number },
  ) => {
    const movie = provider.titles.movies.find((each) => each.name.startsWith(name));
    if (!movie || !source) throw new Error(`No movie ${name}`);
    const ref: TitleRef = { kind: "movie", subscriptionId: source.id, id: String(movie.id) };
    return playback.openTitle(
      ref,
      (await source.provider.titleFile("movie", ref.id, movie.container)).url,
      decoders,
      asked && { ...asked, revision: source.revision },
    );
  };
  /** Has the subscription's password entered again, as on its row in Settings. */
  const repair = () => subscriptions.update(source?.id ?? "", { secret: "demo" });
  return { provider, playback, open, repair, runtime, dispose: () => runtime.dispose() };
}

/**
 * Plays a run to its end and reads what the player would get. ffprobe reads its `streams` only
 * when a test asks for them.
 */
async function play(url: string) {
  const response = await fetch(url);
  const body = Buffer.from(await response.arrayBuffer());
  return {
    response,
    body,
    get streams() {
      return streamsOf(body);
    },
  };
}

/**
 * A converter process whose WebVTT reports the test controls over its real HTTP output.
 * The service still probes the fake provider and serves its public picture/subtitle addresses.
 * This makes late reports and a full live buffer deterministic without changing service state.
 */
async function controlledConverter() {
  const directory = await tempDir();
  const executable = join(directory, "converter.cjs");
  await writeFile(
    executable,
    `#!${process.execPath}
const { writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);
// Recovery uses the real converter; only the picture run's live report is controlled.
if (args.includes("pipe:0")) {
  const { spawnSync } = require("node:child_process");
  process.exit(spawnSync(${JSON.stringify(FFMPEG)}, args, { stdio: "inherit" }).status ?? 1);
}
const position = args.includes("-ss") ? Number(args[args.indexOf("-ss") + 1]) : 0;
writeFileSync(join(${JSON.stringify(directory)}, position + ".json"), JSON.stringify(args));
process.stdout.write("picture");
setInterval(() => {}, 1000);
`,
    { mode: 0o700 },
  );
  return {
    executable,
    async run(url: string, start: number) {
      const file = join(directory, `${start}.json`);
      await rm(file, { force: true });
      const leaving = new AbortController();
      const waiting = fetch(`${url}?start=${start}&subtitle=4`, { signal: leaving.signal });
      let args: string[] = [];
      await vi.waitFor(
        async () => {
          args = JSON.parse(await readFile(file, "utf8")) as string[];
          expect(args.length).toBeGreaterThan(0);
        },
        { timeout: 10_000 },
      );
      const subtitles = args.find((arg) => arg.endsWith("/subtitles"))!;
      const picture = args.find((arg) => arg.endsWith("/start"))!;
      await fetch(picture, {
        method: "PUT",
        body: `#tb 0: 1/1000\n0, ${start * 1000}, ${start * 1000}, 1, 1, 0\n`,
      });
      const response = await waiting;
      expect(response.status).toBe(200);
      // Read like the player. An abandoned response can be collected and close the run before
      // its subtitle report arrives. Replacement and explicit abort both end this read.
      const reading = response.body?.pipeTo(new WritableStream()).catch(() => {});
      return {
        subtitles,
        stop: async () => {
          leaving.abort();
          await reading;
        },
      };
    },
  };
}

/** A complete converter report with cues at the given file times. */
function webvtt(lines: readonly Line[]): string {
  const time = (seconds: number) =>
    `00:${Math.floor(seconds / 60)
      .toString()
      .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}.000`;
  return (
    "WEBVTT\n\n" +
    lines.map(([from, until, text]) => `${time(from)} --> ${time(until)}\n${text}\n\n`).join("")
  );
}

/** A line of text and when it shows, in title seconds. */
type Line = readonly [from: number, until: number, text: string];

/**
 * A track's subtitles as the player reads them: opens the feed for a track from `start`, with
 * the teletext page or caption channel when the track has several, and waits until it says what
 * it has for the position. The player asks for the picture meanwhile; these tests mostly ask for
 * it after. Packets go through the decoder for their codec, as in the player.
 */
async function subtitles(url: string, start: number, track: number, page: number | null = null) {
  const query = new URLSearchParams({ only: "subtitles", start: String(start) });
  query.set("subtitle", String(track));
  if (page !== null) query.set("page", String(page));
  const leaving = new AbortController();
  const response = await fetch(`${url}?${query}`, { signal: leaving.signal });
  const codec = response.headers.get("x-codec");
  const decoderFor = () => (codec ? subtitleDecoder(codec as SubtitleCodec, page) : null);
  let decoder = decoderFor();
  const changes: SubtitleChange[] = [];
  const lines: Line[] = [];
  /** The title seconds from which the track shows again after it had nothing for a position. */
  const again: number[] = [];
  const {
    promise: settled,
    resolve,
    reject,
  } = Promise.withResolvers<{
    changes: readonly SubtitleChange[];
    lines: readonly Line[];
    /** Why the feed has nothing for the position, when it hasn't. */
    unavailable: SubtitlesUnavailable | null;
  }>();
  const read = async () => {
    const text = new TextDecoder();
    let pending = "";
    for await (const chunk of response.body ?? []) {
      pending += text.decode(chunk, { stream: true });
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        const line = readFeedLine(part);
        if (!line) continue;
        if ("unavailable" in line) {
          decoder = decoderFor();
          resolve({ changes: [], lines: [], unavailable: line.unavailable });
        } else if ("ready" in line) {
          if (line.at === undefined) {
            resolve({ changes: [...changes], lines: [...lines], unavailable: null });
          } else again.push(line.at);
        } else if ("text" in line) lines.push([line.at, line.until, line.text]);
        else {
          const change = decoder?.push(Buffer.from(line.data, "base64"), line.at);
          if (change) changes.push(change);
        }
      }
    }
  };
  read().then(
    () => reject(new Error("The feed ended before it said what it has.")),
    (error: unknown) => reject(error),
  );
  return {
    codec,
    /** What the feed sent before it was ready: what the track holds before `start`. */
    before: await settled,
    /** Every change so far, those the run sent after the feed was ready included. */
    changes,
    lines,
    again,
    /** Plays the run the feed belongs to, to its end. */
    run: (more = "") => play(`${url}?start=${start}&subtitle=${track}${more}`),
    leave: () => leaving.abort(),
  };
}

/** Each change as its time and what it shows: text, or how many pictures. */
function shown(changes: readonly SubtitleChange[]): [number, string | number][] {
  return changes.map((change) => [
    Math.round(change.at * 100) / 100,
    change.screen.kind === "text" ? change.screen.lines.join(" ") : change.screen.pictures.length,
  ]);
}

/**
 * What the changes leave on screen `at` seconds into the title, as the player shows them: the
 * last one before then, unless it has ended. Text, or how many pictures; null for nothing.
 */
function screenAt(changes: readonly SubtitleChange[], at: number): string | number | null {
  const last = changes.findLast((change) => change.at <= at);
  if (!last || (last.until !== null && last.until <= at)) return null;
  return shown([last])[0]?.[1] || null;
}

/** The lines of text on screen `at` seconds into the title. */
function linesAt(lines: readonly Line[], at: number): string[] {
  return lines.filter(([from, until]) => from <= at && at < until).map(([, , text]) => text);
}

function streamsOf(body: Buffer): { codec_type: string; codec_name: string; channels?: number }[] {
  const probe = spawnSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,codec_name,channels",
      "-of",
      "json",
      "-i",
      "pipe:0",
    ],
    { input: body, encoding: "utf8" },
  );
  return probe.stdout ? ((JSON.parse(probe.stdout) as { streams?: [] }).streams ?? []) : [];
}

/** Where a clip's first packet of `stream` at or after `seconds` starts, in bytes. */
function packetPosition(name: string, stream: number, seconds: number): number {
  const probe = spawnSync(
    FFPROBE,
    [
      ...["-v", "error", "-select_streams", String(stream)],
      ...["-show_entries", "packet=pts_time,pos", "-of", "csv=p=0", "-i", "pipe:0"],
    ],
    { input: fixture(name), encoding: "utf8" },
  );
  const packets = probe.stdout.split("\n").map((line) => line.split(",").map(Number));
  return packets.find(([time = Number.NaN]) => time >= seconds)?.[1] ?? Number.NaN;
}

/**
 * The picture and sound of an MP4 clip `times` over as one file, its index first: as large as a
 * real file, where a clip fits in the proxy's memory whole.
 *
 * ffmpeg 6 keeps one packet between the thread that reads its only input and the thread that
 * writes, so the two take turns for every packet, some 60,000 of them for the large file. On a
 * busy virtual machine that took most of the test's twenty seconds. With room for a pass of the
 * clip it takes about one, and the file is the same to the byte.
 */
async function repeated(name: string, times: number): Promise<Buffer> {
  const made = join(await tempDir(), name);
  const done = spawnSync(
    FFMPEG,
    [
      ...["-v", "error", "-thread_queue_size", "1024", "-stream_loop", String(times - 1)],
      ...["-i", fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))],
      ...["-map", "0:v", "-map", "0:a", "-c", "copy", "-movflags", "+faststart", made],
    ],
    { encoding: "utf8" },
  );
  if (done.status !== 0) throw new Error(`ffmpeg could not repeat ${name}: ${done.stderr}`);
  return readFileSync(made);
}

/**
 * How many pictures of a run decode. An MP4's index says where each one lies, so every packet
 * comes even when the bytes there are another part of the file; only decoding tells.
 */
function picturesOf(body: Buffer): { readonly decoded: number; readonly errors: string } {
  const probe = spawnSync(
    FFPROBE,
    [
      ...["-v", "error", "-select_streams", "v:0", "-count_frames"],
      ...["-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", "-i", "pipe:0"],
    ],
    { input: body, encoding: "utf8" },
  );
  return { decoded: Number(probe.stdout), errors: probe.stderr };
}

/** How many pictures a run sent. */
function framesOf(body: Buffer): number {
  const probe = spawnSync(
    FFPROBE,
    [
      ...["-v", "error", "-select_streams", "v:0", "-count_packets"],
      ...["-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", "-i", "pipe:0"],
    ],
    { input: body, encoding: "utf8" },
  );
  return Number(probe.stdout);
}

// Each run starts ffmpeg, which takes a moment under a busy suite.
describe.skipIf(!hasTools)("movies and episodes", { timeout: 20_000 }, () => {
  it("names HEVC for Media Source Extensions", () => {
    const remux = spawnSync(
      FFMPEG,
      [
        ...[
          "-v",
          "error",
          "-f",
          "mpegts",
          "-i",
          "pipe:0",
          "-c",
          "copy",
          "-tag:v",
          "hvc1",
          "-f",
          "mp4",
        ],
        ...["-movflags", "frag_keyframe+empty_moov+delay_moov+default_base_moof", "pipe:1"],
      ],
      { input: fixture("hevc-aac.mpegts"), maxBuffer: 16 * 1024 * 1024 },
    );

    expect(readMp4Start(remux.stdout).codecs).toMatch(/^hvc1\.1\.6\.L\d+\.[0-9A-F.]+,mp4a\.40\.2$/);
  });

  it("names the tracks a file holds, in their own languages", async () => {
    const { open, dispose } = await titles();

    const session = await open("TEST | Two sound tracks");

    expect(session.duration).toBeCloseTo(20, 0);
    expect(session.audio).toEqual([
      { id: 1, language: "en", label: "English · 5.1", default: true },
      { id: 2, language: "es", label: "Español · Stereo · Commentary", default: false },
    ]);
    expect(session.subtitles.map(({ label, forced, format }) => [label, forced, format])).toEqual([
      ["English", false, "text"],
      ["Español · Forced", true, "text"],
    ]);
    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/title\//);
    expect(session.url).not.toContain("demo");
    await dispose();
  });

  it.each([
    [
      "TEST | Picture subtitles",
      [
        { id: 2, page: null, format: "picture", label: "English", forced: false },
        { id: 3, page: null, format: "picture", label: "Nederlands · Forced", forced: true },
        { id: 4, page: null, format: "text", label: "Français", forced: false },
      ],
    ],
    [
      "TEST | Broadcast recording",
      [
        { id: 3, page: null, format: "picture", label: "Nederlands · Picture", forced: false },
        { id: 4, page: 888, format: "teletext", label: "Nederlands · Teletext", forced: false },
        { id: 0, page: 1, format: "captions", label: "Captions", forced: false },
      ],
    ],
  ] as const)("lists every subtitle track of %s, in whatever format", async (name, expected) => {
    const { open, dispose } = await titles();

    const session = await open(name);

    expect(session.subtitles).toEqual(expected.map((track) => expect.objectContaining(track)));
    await dispose();
  });

  it("sends picture subtitles beside the picture: PGS as stored, DVD pictures as DVB", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Picture subtitles");

    const pgs = await subtitles(session.url, 0, 2);
    expect(pgs.codec).toBe("pgs");
    // From the start of the file the run brings every subtitle itself.
    expect(pgs.before.changes).toEqual([]);
    await pgs.run();
    // Shown from 2 to 4 s, 5 to 7 s and 8 to 10 s; the subtitles' times are 0.021 s on.
    await vi.waitFor(() =>
      expect(shown(pgs.changes)).toEqual([
        [2.02, 1],
        [4.02, 0],
        [5.02, 1],
        [7.02, 0],
        [8.02, 1],
        [10.02, 0],
      ]),
    );
    const dvd = await subtitles(session.url, 0, 3);
    expect(dvd.codec).toBe("dvb");
    await dvd.run();
    await vi.waitFor(() =>
      expect(shown(dvd.changes)).toEqual([
        [5.02, 1],
        [7.01, 0],
        [8.02, 1],
        [10.01, 0],
      ]),
    );
    await dispose();
  });

  it("sends a recording's teletext page and captions beside the picture", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Broadcast recording");

    const teletext = await subtitles(session.url, 0, 4, 888);
    expect(teletext.codec).toBe("teletext");
    await teletext.run();
    await vi.waitFor(() =>
      expect(shown(teletext.changes)).toEqual([
        [1.02, "TELETEKST 888"],
        [3.02, ""],
      ]),
    );
    const captions = await subtitles(session.url, 0, 0, 1);
    expect(captions.codec).toBe("captions");
    await captions.run();
    await vi.waitFor(() =>
      expect(shown(captions.changes)).toEqual([
        [0.94, "HELLO CAPTIONS"],
        [3.02, ""],
      ]),
    );
    const dvb = await subtitles(session.url, 0, 3);
    await dvb.run();
    await vi.waitFor(() => expect(shown(dvb.changes)[0]).toEqual([0.52, 1]));
    await dispose();
  });

  it("plays from a position: the picture from the keyframe before it", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks");

    const run = await play(`${session.url}?start=12&audio=1`);

    // Keyframes every 5 seconds: a start at 12 shows the picture from 10, counted from its first
    // frame's decoding time, a few frames earlier.
    expect(Number(run.response.headers.get("x-start"))).toBeGreaterThan(9.8);
    expect(Number(run.response.headers.get("x-start"))).toBeLessThanOrEqual(10);
    expect(run.body.subarray(4, 8).toString()).toBe("ftyp");
    // E-AC-3 becomes AAC here, because the player decodes no E-AC-3; H.264 stays as it is.
    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "aac"]);
    // What the player reads from these: the codecs Media Source Extensions needs.
    const start = readMp4Start(run.body);
    expect(start.codecs).toMatch(/^avc1\.64[0-9a-f]{4},mp4a\.40\.2$/);
    expect(start.firstFragment).not.toBeNull();
    await dispose();
  });

  it("sends text subtitles as lines on the title's clock, with the run that reads them", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks");

    const text = await subtitles(session.url, 17.5, 3);
    expect(text.codec).toBe("");
    // To the tenth of a second: the file's sound starts 0.021 s before its picture, and
    // ffprobe's versions differ on which of the two starts the title.
    const tenths = ([from, until, line]: Line) => [from.toFixed(1), until.toFixed(1), line];
    expect(text.before.lines.map(tenths)).toEqual([["17.0", "19.0", "Seventeen"]]);
    const run = await text.run("&audio=1");

    // With subtitles on, the picture starts at the keyframe before the position all the same.
    expect(Number(run.response.headers.get("x-start"))).toBeGreaterThan(14.8);
    expect(Number(run.response.headers.get("x-start"))).toBeLessThanOrEqual(15);
    // The run sends nothing that began before its position again.
    expect(text.lines).toEqual(text.before.lines);
    await dispose();
  });

  // What a file holds of a subtitle sits where it begins, before the keyframe a run starts from.
  it.each([
    ["a PGS picture", "TEST | Picture subtitles", 2, null, 6.5, 1, 7.02],
    ["a DVD picture", "TEST | Picture subtitles", 3, null, 6.5, 1, 7.01],
  ] as const)(
    "shows %s already on screen at the position, until it goes",
    async (_, name, track, page, position, showing, gone) => {
      const { open, provider, dispose } = await titles();
      const session = await open(name);

      const feed = await subtitles(session.url, position, track, page);

      // On screen when the feed is ready, before the run is asked for.
      expect(screenAt(feed.before.changes, position)).toBe(showing);
      await feed.run();
      await vi.waitFor(() => expect(shown(feed.changes).at(-1)?.[0]).toBeGreaterThanOrEqual(gone));
      expect(screenAt(feed.changes, gone - 0.05)).toBe(showing);
      expect(screenAt(feed.changes, gone + 0.01)).toBeNull();
      expect(provider.mostFilesAtOnce()).toBe(1);
      await dispose();
    },
  );

  // A recording keeps its subtitles among its pictures, with no index to find them by.
  it.each([
    ["DVB subtitles", 3, null],
    ["teletext page", 4, 888],
    ["captions", 0, 1],
  ] as const)(
    "plays a recording from a position and says its %s can't be had there",
    async (_, track, page) => {
      const { open, playback, provider, dispose } = await titles();
      const session = await open("TEST | Broadcast recording");

      const feed = await subtitles(session.url, 2.5, track, page);
      const run = await feed.run();

      expect(feed.before.unavailable).toBe("unreadable");
      // Nothing of what the track held before the position shows, and the picture plays.
      expect(screenAt(feed.changes, 2.6)).toBeNull();
      expect(run.response.status).toBe(200);
      expect(framesOf(run.body)).toBeGreaterThan(0);
      expect(await playback.failure(session.sessionId)).toBeNull();
      expect(provider.mostFilesAtOnce()).toBe(1);
      await dispose();
    },
  );

  it("shows nothing at a position between two subtitles", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Picture subtitles");

    const feed = await subtitles(session.url, 7.5, 2);

    expect(screenAt(feed.before.changes, 7.5)).toBeNull();
    await feed.run();
    await vi.waitFor(() => expect(screenAt(feed.changes, 8.1)).toBe(1));
    await dispose();
  });

  // From here on, what shows at a position depends on what the file holds long before it.
  it("shows a PGS picture that has been on screen for a quarter of a minute", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Long subtitles");

    // On screen from 121 to 139 s.
    const feed = await subtitles(session.url, 137, 2);

    expect(screenAt(feed.before.changes, 137)).toBe(1);
    const run = await feed.run();
    await vi.waitFor(() => expect(shown(feed.changes).at(-1)).toEqual([139, 0]));
    // The picture itself starts at the keyframe before the position, as without subtitles.
    expect(Number(run.response.headers.get("x-start"))).toBeCloseTo(136, 1);
    await dispose();
  });

  it("draws a PGS picture again from the object and colours sent long before", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Long subtitles");

    // Sent at 11 s and cleared at 13; shown again at 23 s by a display set that sends nothing.
    const feed = await subtitles(session.url, 27, 2);

    expect(shown(feed.before.changes)).toEqual([
      [11, 1],
      [13, 0],
      [23, 1],
    ]);
    expect(screenAt(feed.before.changes, 27)).toBe(1);
    await feed.run();
    await vi.waitFor(() => expect(screenAt(feed.changes, 29)).toBeNull());
    await dispose();
  });

  it("keeps what later packets build on when a run starts before them", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Long subtitles");

    // The run reads the display set at 23 s itself; what it draws was sent at 11 s.
    const feed = await subtitles(session.url, 21, 2);

    expect(screenAt(feed.before.changes, 21)).toBeNull();
    await feed.run();
    // Each change once, in order: what the feed brought, then what the run read.
    await vi.waitFor(() =>
      expect(shown(feed.changes)).toEqual([
        [11, 1],
        [13, 0],
        [23, 1],
        [29, 0],
        [60, 1],
        [62, 0],
        [121, 1],
        [139, 0],
      ]),
    );
    await dispose();
  });

  it("shows nothing once a picture has ended, though the file's index leaves its end out", async () => {
    const { open, dispose } = await titles();
    // Its index lists the picture at 23 s and not the end of it at 29 s.
    const session = await open("TEST | Index with a gap");

    const feed = await subtitles(session.url, 29.5, 2);

    expect(shown(feed.before.changes).at(-1)).toEqual([29, 0]);
    expect(screenAt(feed.before.changes, 29.5)).toBeNull();
    await dispose();
  });

  it("shows nothing once a picture has ended, though the index lists as many packets as the file counts", async () => {
    const { open, provider, dispose } = await titles();
    // Its index lists the picture at 23 s twice, the second time where its end at 29 s was, and
    // the file's own count of the track's packets agrees with it.
    const session = await open("TEST | Index doubled");
    // The provider keeps the end waiting: a scan that stops at the picture never reads it.
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Index doub"));
    const end = packetPosition("title-long-subs-doubled.mkv", 2, 29);
    provider.stallMovieFile(movie?.id ?? 0, end, 600);

    const feed = await subtitles(session.url, 29.5, 2);

    expect(shown(feed.before.changes)).toEqual([
      [11, 1],
      [13, 0],
      [23, 1],
      [29, 0],
    ]);
    expect(screenAt(feed.before.changes, 29.5)).toBeNull();
    await dispose();
  });

  it("shows the lines of text on screen at a position, however long ago they began", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Long subtitles");

    // One line from 121 to 139 s, another over it from 130 to 133 s.
    const long = await subtitles(session.url, 137, 4);
    expect(linesAt(long.before.lines, 137)).toEqual(["Longue ligne"]);
    await long.run();
    await vi.waitFor(() => expect(linesAt(long.lines, 142)).toEqual(["Apres"]));
    expect(long.lines.map(([, , text]) => text)).toEqual(["Longue ligne", "Apres"]);

    const both = await subtitles(session.url, 131, 4);
    expect(linesAt(both.before.lines, 131)).toEqual(["Longue ligne", "En meme temps"]);
    const none = await subtitles(session.url, 100, 4);
    expect(none.before.lines).toEqual([]);
    await dispose();
  });

  it("sends each line once, though the file was read for it and the run reads it too", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    // The line that starts at 130 s is read for the position, a second and a half before it,
    // and by the run from there.
    const feed = await subtitles(session.url, 128.5, 4);
    await feed.run();
    await vi.waitFor(() => expect(linesAt(feed.lines, 142)).toEqual(["Apres"]));

    expect(feed.lines.map(([, , text]) => text)).toEqual([
      "Longue ligne",
      "En meme temps",
      "Apres",
    ]);
    await dispose();
  });

  it("ends a DVD picture at its own end, which comes with the picture", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Long subtitles");

    // On screen from 121 to 139 s; the page ffmpeg makes of it would stay until 151 s.
    const during = await subtitles(session.url, 137, 3);
    expect(shown(during.before.changes)).toEqual([
      [121, 1],
      [139, 0],
    ]);
    expect(screenAt(during.before.changes, 137)).toBe(1);
    const after = await subtitles(session.url, 140, 3);
    expect(screenAt(after.before.changes, 140)).toBeNull();
    await dispose();
  });

  it("shows a recording's subtitles again from where they start afresh after a skip", async () => {
    const { open, playback, dispose } = await titles();
    const session = await open("TEST | Long recording");

    // Regions, colours and objects come at 11 s; the page at 23 s only says to show them, which
    // a run from 27 s can't. The page at 33 s brings its own.
    const feed = await subtitles(session.url, 27, 1);
    await feed.run();

    expect(feed.before.unavailable).toBe("unreadable");
    await vi.waitFor(() => expect(shown(feed.changes).at(-1)).toEqual([34.99, 0]));
    expect(feed.again).toEqual([33]);
    expect(shown(feed.changes)).toEqual([
      [33, 1],
      [34.99, 0],
    ]);
    expect(await playback.failure(session.sessionId)).toBeNull();
    await dispose();
  });

  it("sends a caption track's own packets, for the player's decoder to read from the start", async () => {
    const { open, provider, dispose } = await titles();
    const session = await open("TEST | Caption track");
    expect(session.subtitles).toEqual([
      expect.objectContaining({ id: 1, page: null, format: "captions" }),
    ]);

    // FIRST goes into the hidden memory at 10 s and SECOND after it at 29 s; the command at 30 s
    // shows both, which ffmpeg's own caption decoder would lose at a skip.
    const feed = await subtitles(session.url, 0, 1);
    expect(feed.codec).toBe("captions");
    await feed.run();

    await vi.waitFor(() =>
      expect(shown(feed.changes)).toEqual([
        [30, "FIRST SECOND"],
        [31, ""],
        [35, "THIRD"],
        [37, ""],
      ]),
    );
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("reads the file for a position once: the same or an earlier one costs nothing more", async () => {
    const { open, provider, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    const first = await subtitles(session.url, 137, 4);
    await first.run();

    const sent = provider.fileBytes();
    const again = await subtitles(session.url, 137, 4);
    const earlier = await subtitles(session.url, 61, 4);

    expect(linesAt(again.before.lines, 137)).toEqual(["Longue ligne"]);
    expect(linesAt(earlier.before.lines, 61)).toEqual(["Soixante"]);
    expect(provider.fileBytes()).toBe(sent);
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("forgets what it read of a file once the provider puts another in its place", async () => {
    const { open, provider, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    const first = await subtitles(session.url, 6.5, 2);
    // The long movie shows nothing at 6.5 s.
    expect(screenAt(first.before.changes, 6.5)).toBeNull();
    await first.run();

    // Another file behind the same address, of another size: its PGS picture shows from 5 to 7 s.
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    provider.replaceMovieFile(movie?.id ?? 0, "title-h264-picture-subs.mkv");
    // The first read of it tells the proxy; what it knew was the other file's.
    await play(`${session.url}?start=0`);
    const second = await subtitles(session.url, 6.5, 2);

    expect(screenAt(second.before.changes, 6.5)).toBe(1);
    await dispose();
  });

  it("says a file was replaced when its first answer shows it, and reads the new one next", async () => {
    const { open, provider, playback, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    // The same file but for one line of text, as a provider's corrected copy: only its ETag
    // tells the two apart.
    const corrected = Buffer.from(fixture("title-long-subs.mkv"));
    corrected.write("Ligne longue", corrected.indexOf("Longue ligne"));
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    provider.replaceMovieFile(movie?.id ?? 0, corrected);

    // The first read of the file, for its index, tells the proxy: nothing it knew holds.
    const told = await subtitles(session.url, 137, 4);
    const feed = await subtitles(session.url, 137, 4);

    expect(told.before.unavailable).toBe("changed");
    expect(linesAt(feed.before.lines, 137)).toEqual(["Ligne longue"]);
    expect(await playback.failure(session.sessionId)).toBeNull();
    expect(provider.mostFilesAtOnce()).toBe(1);
    await feed.run();
    await vi.waitFor(() => expect(linesAt(feed.lines, 142)).toEqual(["Apres"]));
    await dispose();
  });

  it("drops a previous run's buffered text when the provider replaces its file", async () => {
    const { open, provider, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    await play(`${session.url}?start=137&subtitle=4`);
    const corrected = Buffer.from(fixture("title-long-subs.mkv"));
    corrected.write("Autre", corrected.indexOf("Apres"));
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    provider.replaceMovieFile(movie?.id ?? 0, corrected);
    const told = await subtitles(session.url, 137, 4);
    expect(told.before.unavailable).toBe("changed");
    const feed = await subtitles(session.url, 137, 4);
    expect(feed.lines.map(([, , text]) => text)).not.toContain("Apres");
    await feed.run();
    await vi.waitFor(() => expect(linesAt(feed.lines, 142)).toEqual(["Autre"]), {
      timeout: 10_000,
    });
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("never takes a replaced file's subtitles for the new one's when two servers take turns", async () => {
    // The provider frees its connection at once, so the two servers answer strictly in turn.
    const { open, provider, playback, dispose } = await titles({}, { fileHosts: 2 });
    const session = await open("TEST | Long subtitles");
    const first = await subtitles(session.url, 137, 4);
    expect(linesAt(first.before.lines, 137)).toEqual(["Longue ligne"]);
    first.leave();

    // Each server has its own ETag for the file, and both get the corrected copy.
    const corrected = Buffer.from(fixture("title-long-subs.mkv"));
    corrected.write("Ligne longue", corrected.indexOf("Longue ligne"));
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    provider.replaceMovieFile(movie?.id ?? 0, corrected);
    // One server's answer to the picture shows the new file.
    await play(`${session.url}?start=0`);
    const second = await subtitles(session.url, 137, 4);

    expect(linesAt(second.before.lines, 137)).toEqual(["Ligne longue"]);
    expect(await playback.failure(session.sessionId)).toBeNull();
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("takes every file a provider puts in place of one of the same size for another", async () => {
    const { open, provider, playback, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    const first = await subtitles(session.url, 137, 4);
    expect(linesAt(first.before.lines, 137)).toEqual(["Longue ligne"]);

    // Five corrected copies, one after the other: each the same file but for one line of text,
    // which only its ETag tells from the copy before.
    for (const line of [1, 2, 3, 4, 5].map((copy) => `Copie num. ${copy}`)) {
      const corrected = Buffer.from(fixture("title-long-subs.mkv"));
      corrected.write(line, corrected.indexOf("Longue ligne"));
      provider.replaceMovieFile(movie?.id ?? 0, corrected);
      // The first read of it tells the proxy; what it knew was the other file's.
      await play(`${session.url}?start=0`);

      const feed = await subtitles(session.url, 137, 4);
      expect(linesAt(feed.before.lines, 137)).toEqual([line]);
    }
    expect(await playback.failure(session.sessionId)).toBeNull();
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("plays on without subtitles from before a position when the file is another with every answer", async () => {
    const { open, provider, playback, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    provider.unsettleMovieFile(movie?.id ?? 0, true);
    const asked = provider.fileRequests();

    // Nothing read of one file holds for the next: the feed says so, and the picture plays.
    const feed = await subtitles(session.url, 137, 4);
    const run = await feed.run();

    expect(feed.before.unavailable).toBe("changed");
    expect(run.response.status).toBe(200);
    expect(framesOf(run.body)).toBeGreaterThan(0);
    expect(await playback.failure(session.sessionId)).toBeNull();
    // It asks once for the subtitles, not for as long as the provider goes on.
    expect(provider.fileRequests() - asked).toBeLessThan(20);
    expect(provider.mostFilesAtOnce()).toBe(1);
    // Once the file stays the same one, its subtitles come.
    provider.unsettleMovieFile(movie?.id ?? 0, false);
    await play(`${session.url}?start=0`);
    const settled = await subtitles(session.url, 137, 4);
    expect(linesAt(settled.before.lines, 137)).toEqual(["Longue ligne"]);
    await dispose();
  });

  it("opens and plays an MP4 with its index at the end though its ETag is another with every answer", async () => {
    const { open, provider, playback, dispose } = await titles();
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Index at"));
    provider.unsettleMovieFile(movie?.id ?? 0, true);

    const session = await open("TEST | Index at the end");
    const run = await play(`${session.url}?start=5`);

    expect(run.response.status).toBe(200);
    expect(Number(run.response.headers.get("x-start"))).toBeLessThanOrEqual(5);
    expect(framesOf(run.body)).toBeGreaterThan(0);
    expect(await playback.failure(session.sessionId)).toBeNull();
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("plays, and reads a track's past anew each time, when answers carry only the time they were sent", async () => {
    const { open, provider, playback, dispose } = await titles({}, { fileDates: true });
    const session = await open("TEST | Long subtitles");

    const feed = await subtitles(session.url, 137, 4);
    const run = await feed.run();

    expect(linesAt(feed.before.lines, 137)).toEqual(["Longue ligne"]);
    expect(framesOf(run.body)).toBeGreaterThan(0);
    expect(await playback.failure(session.sessionId)).toBeNull();
    // Nothing says the file is still the same one, so nothing read of it is used again.
    const asked = provider.fileRequests();
    const again = await subtitles(session.url, 137, 4);
    expect(linesAt(again.before.lines, 137)).toEqual(["Longue ligne"]);
    expect(provider.fileRequests()).toBeGreaterThan(asked);
    await dispose();
  });

  it("says the subtitles before a position can't be had when they are more than it keeps", async () => {
    // Room for one line of text, where the lines before 137 s take three.
    const { open, playback, dispose } = await titles({ recovery: { history: 16 } });
    const session = await open("TEST | Long subtitles");

    const feed = await subtitles(session.url, 137, 4);
    const run = await feed.run();

    expect(feed.before.unavailable).toBe("limit");
    // The picture plays, and the lines the run reads from there on still come.
    expect(framesOf(run.body)).toBeGreaterThan(0);
    await vi.waitFor(() => expect(linesAt(feed.lines, 142)).toEqual(["Apres"]));
    expect(feed.again).toEqual([141]);
    expect(await playback.failure(session.sessionId)).toBeNull();
    await dispose();
  });

  it("starts the picture while the subtitles before its position are slow to come", async () => {
    const { open, provider, playback, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    // What the reading asks of the file comes only once the run has played to its end.
    const release = provider.holdFileParts();

    // Asked together, as the player does: the run plays to its end before the feed is ready.
    let played = false;
    const waiting = subtitles(session.url, 137, 2).then((feed) => ({ feed, after: played }));
    const run = await play(`${session.url}?start=137&subtitle=2`);
    played = true;
    release();
    const { feed, after } = await waiting;

    expect(run.response.status).toBe(200);
    expect(framesOf(run.body)).toBeGreaterThan(0);
    expect(after).toBe(true);
    // Then what was on screen at the position, and its end, which the run read meanwhile.
    expect(screenAt(feed.before.changes, 137)).toBe(1);
    await vi.waitFor(() => expect(shown(feed.changes).at(-1)).toEqual([139, 0]));
    expect(await playback.failure(session.sessionId)).toBeNull();
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("sends a buffered text line once when a new run reads it again", async () => {
    const { open, provider, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    await play(`${session.url}?start=137&subtitle=4`);
    // What the reading asks of the file comes only once the new run has played.
    const release = provider.holdFileParts();
    const asked = provider.fileRequests();
    const waiting = subtitles(session.url, 137, 4);
    // Recovery has asked the provider, so this feed joined before the new picture request.
    await vi.waitFor(() => expect(provider.fileRequests()).toBeGreaterThan(asked), {
      timeout: 10_000,
    });
    await play(`${session.url}?start=137&subtitle=4`);
    release();
    const feed = await waiting;
    expect(feed.lines.filter(([, , text]) => text === "Apres")).toHaveLength(1);
    expect(linesAt(feed.lines, 137)).toEqual(["Longue ligne"]);
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("sends live text once across an intervening cancelled run", async () => {
    const { open, provider, dispose } = await titles();
    try {
      const session = await open("TEST | Long subtitles");
      const first = await subtitles(session.url, 125, 4);
      await first.run();
      const feed = await subtitles(session.url, 135, 4);
      expect(feed.lines.filter(([, , text]) => text === "Apres")).toHaveLength(1);
      const cancelled = new AbortController();
      const asked = provider.fileRequests();
      const middle = fetch(`${session.url}?start=130&subtitle=4`, {
        signal: cancelled.signal,
      })
        .then((response) => response.body?.cancel())
        .catch(() => {});
      await vi.waitFor(() => expect(provider.fileRequests()).toBeGreaterThan(asked), {
        timeout: 10_000,
      });
      cancelled.abort();
      await middle;
      await feed.run();
      await vi.waitFor(() => expect(linesAt(feed.lines, 135)).toEqual(["Longue ligne"]), {
        timeout: 10_000,
      });
      expect(feed.lines.filter(([, , text]) => text === "Apres")).toHaveLength(1);
    } finally {
      await dispose();
    }
  });

  it.skipIf(process.platform === "win32")(
    "leaves a replaced run's late line for the current run, including new text at a known time",
    async () => {
      const converter = await controlledConverter();
      const { open, dispose } = await titles({ ffmpeg: converter.executable });
      try {
        const session = await open("TEST | Long subtitles");
        const old = await converter.run(session.url, 125);
        const feed = await subtitles(session.url, 135, 4);
        const { promise: finished, resolve, reject } = Promise.withResolvers<void>();
        const report = request(old.subtitles, { method: "PUT" }, (response) => {
          response.resume();
          response.on("end", resolve);
        });
        report.on("error", reject);
        report.write(webvtt([[141, 143, "Already sent"]]));
        await vi.waitFor(
          () => expect(feed.lines.some(([, , text]) => text === "Already sent")).toBe(true),
          { timeout: 10_000 },
        );
        const current = await converter.run(session.url, 135);
        // The old converter's accepted report can still arrive after its process was replaced.
        report.end(webvtt([[142, 144, "Late line"]]));
        await finished;
        await fetch(current.subtitles, {
          method: "PUT",
          body: webvtt([[137, 138, "Current run"]]),
        });
        await vi.waitFor(
          () => expect(feed.lines.some(([, , text]) => text === "Current run")).toBe(true),
          { timeout: 10_000 },
        );
        expect(feed.lines.some(([, , text]) => text === "Late line")).toBe(false);
        await fetch(current.subtitles, {
          method: "PUT",
          body: webvtt([
            [142, 144, "Late line"],
            [141, 143, "New text"],
          ]),
        });
        await vi.waitFor(
          () => expect(feed.lines.filter(([, , text]) => text === "Late line")).toHaveLength(1),
          { timeout: 10_000 },
        );
        expect(feed.lines.filter(([at]) => at === 141).map(([, , text]) => text)).toEqual([
          "Already sent",
          "New text",
        ]);
        await current.stop();
      } finally {
        await dispose();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "sends text between an old run's trimmed buffer and the early feed's position",
    async () => {
      const converter = await controlledConverter();
      const { open, dispose } = await titles({ ffmpeg: converter.executable });
      try {
        const session = await open("TEST | Long subtitles");
        const old = await converter.run(session.url, 125);
        // Three independent lines exceed the run's 2 MB buffer, dropping the first at 127 s.
        const lines: Line[] = [127, 130, 141].map((at) => [
          at,
          at + 1,
          String(at) + "x".repeat(800_000),
        ]);
        await fetch(old.subtitles, { method: "PUT", body: webvtt(lines) });
        const feed = await subtitles(session.url, 125, 4);
        expect(feed.lines.some(([at]) => at === 127)).toBe(false);
        expect(feed.lines.some(([at]) => at === 130)).toBe(true);
        const current = await converter.run(session.url, 125);
        await fetch(current.subtitles, { method: "PUT", body: webvtt(lines) });
        await vi.waitFor(() => expect(feed.lines.some(([at]) => at === 127)).toBe(true), {
          timeout: 10_000,
        });
        await current.stop();
      } finally {
        await dispose();
      }
    },
  );

  it("sends upcoming text while recovery waits for the provider, then recovers earlier lines once", async () => {
    const { open, provider, dispose } = await titles();
    const session = await open("TEST | Long subtitles");
    // What recovery asks of the file waits until the run's own text has come.
    const release = provider.holdFileParts();
    const leaving = new AbortController();
    const response = await fetch(`${session.url}?only=subtitles&start=137&subtitle=4`, {
      signal: leaving.signal,
    });
    const lines: Line[] = [];
    let ready = false;
    const reading = (async () => {
      let pending = "";
      const text = new TextDecoder();
      for await (const chunk of response.body ?? []) {
        pending += text.decode(chunk, { stream: true });
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          const line = readFeedLine(part);
          if (line && "text" in line) lines.push([line.at, line.until, line.text]);
          if (line && "ready" in line) ready = true;
        }
      }
    })().catch(() => {});
    try {
      const run = await play(`${session.url}?start=137&subtitle=4`);
      expect(framesOf(run.body)).toBeGreaterThan(0);
      await vi.waitFor(() => expect(lines.map(([, , text]) => text)).toEqual(["Apres"]), {
        timeout: 10_000,
      });
      expect(ready).toBe(false);
      release();
      await vi.waitFor(() => expect(ready).toBe(true), { timeout: 10_000 });
      expect(linesAt(lines, 137)).toEqual(["Longue ligne"]);
      expect(lines.map(([, , text]) => text).sort()).toEqual(["Apres", "Longue ligne"]);
      expect(provider.mostFilesAtOnce()).toBe(1);
    } finally {
      leaving.abort();
      await reading;
      await dispose();
    }
  });

  it("plays a whole file from a provider that knows no byte ranges", async () => {
    const { open, provider, dispose } = await titles({}, { wholeFiles: true });
    const session = await open("TEST | Long subtitles");
    const size = fixture("title-long-subs.mkv").length;
    const before = { requests: provider.fileRequests(), bytes: provider.fileBytes() };

    const feed = await subtitles(session.url, 0, 2);
    const run = await feed.run();

    expect(run.response.status).toBe(200);
    // Every picture of its 150 seconds, at five a second.
    expect(framesOf(run.body)).toBe(750);
    await vi.waitFor(() => expect(shown(feed.changes).at(-1)).toEqual([139, 0]));
    // The provider's one answer at a time, as ffmpeg asks for it: once or twice, by its version,
    // each a redirect and the file. The subtitles ask for nothing more.
    expect(provider.fileRequests() - before.requests).toBeLessThanOrEqual(4);
    expect(provider.fileBytes() - before.bytes).toBeLessThanOrEqual(2 * size);
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it.each([
    { marks: "a strong ETag", fetchImpl: fetch },
    {
      marks: "no ETag but a Last-Modified long before they were sent",
      fetchImpl: (async (input, init) => {
        const answer = await fetch(input, init);
        const headers = new Headers(answer.headers);
        headers.delete("etag");
        headers.set("last-modified", "Mon, 01 Jan 2024 00:00:00 GMT");
        return new Response(answer.body, { status: answer.status, headers });
      }) satisfies typeof fetch,
    },
  ])(
    "shows the lines on screen at a position from what a run read, asking a provider that knows no byte ranges for nothing, when answers carry $marks",
    async ({ fetchImpl }) => {
      const { open, provider, playback, dispose } = await titles(
        {},
        { wholeFiles: true },
        fetchImpl,
      );
      const session = await open("TEST | Long subtitles");
      const counts = () => ({ requests: provider.fileRequests(), bytes: provider.fileBytes() });
      // A run from the start reads every line of the track, to its last.
      const first = await subtitles(session.url, 0, 4);
      await first.run();
      await vi.waitFor(() => expect(linesAt(first.lines, 142)).toEqual(["Apres"]));
      first.leave();
      const read = counts();

      const long = await subtitles(session.url, 137, 4);
      const both = await subtitles(session.url, 131, 4);

      expect(linesAt(long.before.lines, 137)).toEqual(["Longue ligne"]);
      expect(linesAt(both.before.lines, 131)).toEqual(["Longue ligne", "En meme temps"]);
      expect(counts()).toEqual(read);
      expect(await playback.failure(session.sessionId)).toBeNull();
      expect(provider.mostFilesAtOnce()).toBe(1);
      await dispose();
    },
  );

  it("says a provider that knows no byte ranges can't give the lines before a position no run read from the start, and asks it for nothing", async () => {
    const { open, provider, playback, dispose } = await titles({}, { wholeFiles: true });
    const session = await open("TEST | Long subtitles");
    const counts = () => ({ requests: provider.fileRequests(), bytes: provider.fileBytes() });
    const opened = counts();

    const cold = await subtitles(session.url, 137, 4);
    expect(cold.before.unavailable).toBe("unreadable");
    expect(counts()).toEqual(opened);
    // A run from the position reads the lines from there on, which leaves out any that began
    // before it.
    const run = await cold.run();
    expect(framesOf(run.body)).toBeGreaterThan(0);
    await vi.waitFor(() => expect(linesAt(cold.lines, 142)).toEqual(["Apres"]));
    cold.leave();
    const read = counts();
    const later = await subtitles(session.url, 142, 4);

    expect(later.before.unavailable).toBe("unreadable");
    expect(later.before.lines).toEqual([]);
    expect(counts()).toEqual(read);
    expect(await playback.failure(session.sessionId)).toBeNull();
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("forgets what a run read once a provider that knows no byte ranges puts another file in its place", async () => {
    const { open, provider, playback, runtime, dispose } = await titles({}, { wholeFiles: true });
    const session = await open("TEST | Long subtitles");
    const replaced = await collect(runtime, playback.fileReplaced);
    const counts = () => ({ requests: provider.fileRequests(), bytes: provider.fileBytes() });
    const first = await subtitles(session.url, 0, 4);
    await first.run();
    await vi.waitFor(() => expect(linesAt(first.lines, 142)).toEqual(["Apres"]));
    first.leave();

    // The same file but for one line of text: only its ETag tells the two apart.
    const corrected = Buffer.from(fixture("title-long-subs.mkv"));
    corrected.write("Ligne longue", corrected.indexOf("Longue ligne"));
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
    provider.replaceMovieFile(movie?.id ?? 0, corrected);
    // The picture's next answer shows the other file.
    await play(`${session.url}?start=0`);
    await vi.waitFor(() => expect(replaced).toContain(session.sessionId));
    const told = counts();
    const stale = await subtitles(session.url, 137, 4);

    expect(stale.before.unavailable).toBe("unreadable");
    expect(stale.before.lines).toEqual([]);
    expect(counts()).toEqual(told);
    stale.leave();
    // A run of the new file from its start has its lines shown.
    const again = await subtitles(session.url, 0, 4);
    await again.run();
    await vi.waitFor(() => expect(linesAt(again.lines, 142)).toEqual(["Apres"]));
    again.leave();
    const fresh = await subtitles(session.url, 137, 4);
    expect(linesAt(fresh.before.lines, 137)).toEqual(["Ligne longue"]);
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("uses nothing a run read from answers that don't say how long the file is, once a provider that knows no byte ranges answers with another file", async () => {
    let unsized = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      if (!unsized || answer.status !== 200) return answer;
      const headers = new Headers(answer.headers);
      headers.delete("content-length");
      return new Response(answer.body, { status: answer.status, headers });
    };
    const { open, provider, playback, dispose } = await titles({}, { wholeFiles: true }, fetchImpl);
    try {
      // Opened again, the title has what ffprobe read: no answer has said what its file is yet.
      await open("TEST | Long subtitles");
      const session = await open("TEST | Long subtitles");
      const counts = () => ({ requests: provider.fileRequests(), bytes: provider.fileBytes() });
      unsized = true;
      const first = await subtitles(session.url, 0, 4);
      await first.run();
      await vi.waitFor(() => expect(linesAt(first.lines, 142)).toEqual(["Apres"]));
      first.leave();
      unsized = false;

      // The same file but for one line of text, which the next answer, of known length, is of.
      const corrected = Buffer.from(fixture("title-long-subs.mkv"));
      corrected.write("Ligne longue", corrected.indexOf("Longue ligne"));
      const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
      provider.replaceMovieFile(movie?.id ?? 0, corrected);
      const source = session.url.replace("/title/", "/source/").replace(/\.mp4$/, "");
      const answer = await fetch(source, { headers: { Range: "bytes=0-" } });
      expect(Buffer.from(await answer.arrayBuffer())).toEqual(corrected);
      const told = counts();
      const stale = await subtitles(session.url, 137, 4);

      expect(stale.before.unavailable).toBe("unreadable");
      expect(stale.before.lines).toEqual([]);
      expect(counts()).toEqual(told);
      stale.leave();
      // A run of the file from its start, with answers that say what it is, has its lines shown.
      const again = await subtitles(session.url, 0, 4);
      await again.run();
      await vi.waitFor(() => expect(linesAt(again.lines, 142)).toEqual(["Apres"]));
      again.leave();
      const read = counts();
      const fresh = await subtitles(session.url, 137, 4);
      expect(linesAt(fresh.before.lines, 137)).toEqual(["Ligne longue"]);
      expect(counts()).toEqual(read);
      expect(await playback.failure(session.sessionId)).toBeNull();
      expect(provider.mostFilesAtOnce()).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("uses nothing a run read from a server that still sends the file a provider that knows no byte ranges replaced", async () => {
    // Every file is asked of the server `host`. Once `lagging`, the second still sends the file
    // as it was, with the ETag it first gave for it.
    let host = 0;
    let lagging = false;
    const tags = new Map<string, string>();
    const fetchImpl: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      const location = answer.headers.get("location");
      const file = new URL(answer.url).pathname.startsWith("/files/");
      if (!location?.includes("/files/") && !(file && answer.ok)) return answer;
      const headers = new Headers(answer.headers);
      const old = lagging && tags.has(answer.url) && answer.url.includes("/files/1/");
      if (location) headers.set("location", location.replace(/\/files\/\d+\//, `/files/${host}/`));
      else if (!tags.has(answer.url)) tags.set(answer.url, headers.get("etag") ?? "");
      if (old) {
        await answer.arrayBuffer();
        headers.set("etag", tags.get(answer.url) ?? "");
      }
      const body = old ? fixture("title-long-subs.mkv") : answer.body;
      const changed = new Response(body, { status: answer.status, headers });
      Object.defineProperty(changed, "url", { value: answer.url });
      return changed;
    };
    const { open, provider, playback, dispose } = await titles(
      {},
      { wholeFiles: true, fileHosts: 2 },
      fetchImpl,
    );
    try {
      const session = await open("TEST | Long subtitles");
      const counts = () => ({ requests: provider.fileRequests(), bytes: provider.fileBytes() });
      const source = session.url.replace("/title/", "/source/").replace(/\.mp4$/, "");
      const read = async () =>
        Buffer.from(await (await fetch(source, { headers: { Range: "bytes=0-" } })).arrayBuffer());
      host = 1;
      expect(await read()).toEqual(fixture("title-long-subs.mkv"));

      // The same file but for one line of text, which the first server's next answer is of.
      const corrected = Buffer.from(fixture("title-long-subs.mkv"));
      corrected.write("Ligne longue", corrected.indexOf("Longue ligne"));
      const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Long sub"));
      provider.replaceMovieFile(movie?.id ?? 0, corrected);
      host = 0;
      expect(await read()).toEqual(corrected);
      // A run the second server answers with the old file plays it, its lines with it.
      host = 1;
      lagging = true;
      const old = await subtitles(session.url, 0, 4);
      await old.run();
      await vi.waitFor(() => expect(linesAt(old.lines, 137)).toEqual(["Longue ligne"]));
      old.leave();
      const told = counts();
      const stale = await subtitles(session.url, 137, 4);

      expect(stale.before.unavailable).toBe("unreadable");
      expect(stale.before.lines).toEqual([]);
      expect(counts()).toEqual(told);
      stale.leave();
      // A run of the new file from its start has its lines shown.
      host = 0;
      const again = await subtitles(session.url, 0, 4);
      await again.run();
      await vi.waitFor(() => expect(linesAt(again.lines, 142)).toEqual(["Apres"]));
      again.leave();
      const ran = counts();
      const fresh = await subtitles(session.url, 137, 4);
      expect(linesAt(fresh.before.lines, 137)).toEqual(["Ligne longue"]);
      expect(counts()).toEqual(ran);
      expect(await playback.failure(session.sessionId)).toBeNull();
      expect(provider.mostFilesAtOnce()).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("uses nothing a run read from a provider that knows no byte ranges when answers carry only the time they were sent", async () => {
    const { open, provider, dispose } = await titles({}, { wholeFiles: true, fileDates: true });
    const session = await open("TEST | Long subtitles");
    const counts = () => ({ requests: provider.fileRequests(), bytes: provider.fileBytes() });
    const first = await subtitles(session.url, 0, 4);
    await first.run();
    await vi.waitFor(() => expect(linesAt(first.lines, 142)).toEqual(["Apres"]));
    first.leave();
    const read = counts();

    const feed = await subtitles(session.url, 137, 4);

    expect(feed.before.unavailable).toBe("unreadable");
    expect(feed.before.lines).toEqual([]);
    expect(counts()).toEqual(read);
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("plays a large file whole from a provider that knows no byte ranges", async () => {
    // 10 MB of film, which ffprobe leaves in the middle of: the provider answers the run's
    // request with all of it again.
    const { open, provider, dispose } = await titles({}, { wholeFiles: true });
    const film = await repeated("title-h264-aac.mp4", 70);
    const movie = provider.titles.movies.find((each) => each.name.startsWith("TEST | Index at"));
    provider.replaceMovieFile(movie?.id ?? 0, film);
    // Half of it comes at once and the rest as slowly as over a network. Sent from this computer
    // alone, nearly all of it has left the provider by the time ffprobe is done.
    const half = Math.floor(film.length / 2);
    provider.stallMovieFile(movie?.id ?? 0, half, 60_000);
    const session = await open("TEST | Index at the end");
    // ffprobe left in the middle of the file, and the provider has stopped sending it.
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    provider.stallMovieFile(movie?.id ?? 0, half, 0);
    const before = { requests: provider.fileRequests(), bytes: provider.fileBytes() };
    expect(before.bytes).toBeLessThan(film.length);

    const run = await play(`${session.url}?start=0`);

    expect(run.response.status).toBe(200);
    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "aac"]);
    // Every picture of its 300, seventy times, and each the file's own.
    expect(picturesOf(run.body)).toEqual({ decoded: 21_000, errors: "" });
    // Asked for once, redirect and file, and sent once: no request after the provider's answer.
    expect(provider.fileRequests() - before.requests).toBe(2);
    expect(provider.fileBytes() - before.bytes).toBe(film.length);
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("resumes and skips outside the buffer as on a ranged provider with whole-file answers", async () => {
    const reference: { start: number; decoded: number }[] = [];
    for (const wholeFiles of [false, true]) {
      const { open, provider, dispose } = await titles({}, { wholeFiles });
      const movie = provider.titles.movies.find((each) =>
        each.name.startsWith("TEST | Long subtitles"),
      );
      provider.replaceMovieFile(movie?.id ?? 0, "title-receiver.mkv");
      const session = await open("TEST | Long subtitles");
      const size = fixture("title-receiver.mkv").length;

      // A resumed run, followed by a new run beyond its buffer, as the player asks for them.
      for (const [index, position] of [30, 52.5].entries()) {
        const before = { requests: provider.fileRequests(), bytes: provider.fileBytes() };
        const run = await play(`${session.url}?start=${position}`);
        expect(run.response.status).toBe(200);
        const start = Number(run.response.headers.get("x-start"));
        const picture = picturesOf(run.body);
        expect(start).toBeLessThanOrEqual(position);
        expect(picture.errors).toBe("");
        expect(picture.decoded).toBeGreaterThan(0);
        expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "aac"]);
        if (wholeFiles) expect({ start, decoded: picture.decoded }).toEqual(reference[index]);
        else reference.push({ start, decoded: picture.decoded });
        // Metadata and seek reads, each taking a redirect and one file answer.
        expect(provider.fileRequests() - before.requests).toBeLessThanOrEqual(8);
        expect(provider.fileBytes() - before.bytes).toBeLessThanOrEqual(4 * size);
      }
      expect(provider.mostFilesAtOnce()).toBe(1);
      await dispose();
    }
  });

  it("answers the asked source range and refuses positions at or past the whole file end at once", async () => {
    const { open, provider, dispose } = await titles({}, { wholeFiles: true });
    const session = await open("TEST | Long subtitles");
    const size = fixture("title-long-subs.mkv").length;
    const source = session.url.replace("/title/", "/source/").replace(/\.mp4$/, "");

    for (const position of [Math.floor(size / 2), size - 1, size, size + 1]) {
      const before = { requests: provider.fileRequests(), bytes: provider.fileBytes() };
      const response = await fetch(source, {
        headers: { Range: `bytes=${position}-` },
        signal: AbortSignal.timeout(2000),
      });
      const body = await response.arrayBuffer();
      if (position < size) {
        expect(response.status).toBe(206);
        expect(response.headers.get("content-range")).toBe(`bytes ${position}-${size - 1}/${size}`);
        expect(response.headers.get("content-length")).toBe(String(size - position));
        expect(Buffer.from(body)).toEqual(fixture("title-long-subs.mkv").subarray(position));
      } else {
        expect(response.status).toBe(416);
        expect(response.headers.get("content-range")).toBe(`bytes */${size}`);
        expect(body.byteLength).toBe(0);
      }
      // One redirect and one file answer for each request ffmpeg could make.
      expect(provider.fileRequests() - before.requests).toBe(2);
      expect(provider.fileBytes() - before.bytes).toBeLessThanOrEqual(size);
    }
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("passes through a correct 206 range whose total size is unknown", async () => {
    let changeHeaders = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      if (!changeHeaders || answer.status !== 206) return answer;
      const headers = new Headers(answer.headers);
      headers.set("content-range", (headers.get("content-range") ?? "").replace(/\/\d+$/, "/*"));
      return new Response(answer.body, { status: answer.status, headers });
    };
    const { open, dispose } = await titles({}, {}, fetchImpl);
    try {
      const session = await open("TEST | Long subtitles");
      changeHeaders = true;
      const bytes = fixture("title-long-subs.mkv");
      const position = Math.floor(bytes.length / 2);
      const source = session.url.replace("/title/", "/source/").replace(/\.mp4$/, "");
      const answer = await fetch(source, { headers: { Range: `bytes=${position}-` } });
      expect(answer.status).toBe(206);
      expect(answer.headers.get("content-range")).toBe(`bytes ${position}-${bytes.length - 1}/*`);
      expect(Buffer.from(await answer.arrayBuffer())).toEqual(bytes.subarray(position));
    } finally {
      await dispose();
    }
  });

  it.each([true, false])(
    "notifies only when dropped bytes advance, wholeFiles=%s",
    async (wholeFiles) => {
      let holding = false;
      const arrived = Promise.withResolvers<{
        controller: ReadableStreamDefaultController<Uint8Array>;
        bytes: Uint8Array;
      }>();
      const fetchImpl: typeof fetch = async (input, init) => {
        const answer = await fetch(input, init);
        if (!holding || (answer.status !== 200 && answer.status !== 206)) return answer;
        const bytes = new Uint8Array(await answer.arrayBuffer());
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              arrived.resolve({ controller, bytes });
            },
          }),
          { status: answer.status, headers: answer.headers },
        );
      };
      const { open, playback, runtime, dispose } = await titles({}, { wholeFiles }, fetchImpl);
      try {
        const notices = await collect(runtime, playback.readingAhead);
        const session = await open("TEST | Long subtitles");
        expect(notices).toEqual([]);
        holding = true;
        const position = 32 * 1024;
        const source = session.url.replace("/title/", "/source/").replace(/\.mp4$/, "");
        const reading = fetch(source, { headers: { Range: `bytes=${position}-` } }).then(
          async (answer) => ({
            status: answer.status,
            bytes: Buffer.from(await answer.arrayBuffer()),
          }),
        );
        const { controller, bytes } = await arrived.promise;
        // The proxy spaces its notices by performance.now(), whose clock the test moves on.
        vi.useFakeTimers({ toFake: ["performance"] });
        controller.enqueue(bytes.subarray(0, 8192));
        if (wholeFiles) await vi.waitFor(() => expect(notices).toEqual([session.sessionId]));
        // Time alone sends no notices while the prefix is held, even after the throttle period.
        vi.advanceTimersByTime(3100);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(notices).toEqual(wholeFiles ? [session.sessionId] : []);
        controller.enqueue(bytes.subarray(8192, 16384));
        if (wholeFiles) await vi.waitFor(() => expect(notices).toHaveLength(2));
        controller.enqueue(bytes.subarray(16384, 32768));
        await new Promise((resolve) => setTimeout(resolve, 50));
        const dropped = [...notices];
        // All subsequent bytes belong to the answer, so another throttle period yields no notice.
        vi.advanceTimersByTime(3100);
        controller.enqueue(bytes.subarray(32768));
        controller.close();
        const answer = await reading;
        expect(answer.status).toBe(206);
        expect(answer.bytes).toEqual(fixture("title-long-subs.mkv").subarray(position));
        expect(notices).toEqual(dropped);
      } finally {
        vi.useRealTimers();
        await dispose();
      }
    },
  );

  it("waits past the start deadline while a whole-file answer advances to the asked position", async () => {
    let slow = false;
    const fetchImpl: typeof fetch = async (input, init) => {
      const answer = await fetch(input, init);
      const position = Number(
        /^bytes=(\d+)-$/.exec(new Headers(init?.headers).get("range") ?? "")?.[1],
      );
      if (!slow || !answer.body || !position) return answer;
      let read = 0;
      const body = answer.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, out) {
            for (let at = 0; at < chunk.length; at += 4096) {
              // Slow the prefix, then let the first picture arrive within its own deadline.
              if (read < position) await new Promise((resolve) => setTimeout(resolve, 25));
              const part = chunk.subarray(at, at + 4096);
              read += part.length;
              out.enqueue(part);
            }
          },
        }),
      );
      return new Response(body, { status: answer.status, headers: answer.headers });
    };
    const timeout = 500;
    const { open, provider, dispose } = await titles(
      { runStartMs: timeout },
      { wholeFiles: true },
      fetchImpl,
    );
    try {
      const movie = provider.titles.movies.find((each) =>
        each.name.startsWith("TEST | Long subtitles"),
      );
      provider.replaceMovieFile(movie?.id ?? 0, "title-receiver.mkv");
      const session = await open("TEST | Long subtitles");
      slow = true;
      const began = performance.now();
      const run = await play(`${session.url}?start=30`);
      expect(run.response.status).toBe(200);
      expect(performance.now() - began).toBeGreaterThan(timeout);
      expect(Number(run.response.headers.get("x-start"))).toBeCloseTo(21.746, 2);
      expect(picturesOf(run.body).decoded).toBeGreaterThan(0);
      expect(provider.mostFilesAtOnce()).toBe(1);
    } finally {
      await dispose();
    }
  });

  it("fails a whole-file read-forward that stops advancing for the start deadline", async () => {
    const timeout = 500;
    const { open, provider, dispose } = await titles({ runStartMs: timeout }, { wholeFiles: true });
    try {
      const movie = provider.titles.movies.find((each) =>
        each.name.startsWith("TEST | Long subtitles"),
      );
      provider.replaceMovieFile(movie?.id ?? 0, "title-receiver.mkv");
      const session = await open("TEST | Long subtitles");
      provider.stallMovieFile(movie?.id ?? 0, 16 * 1024, 5000);
      const began = performance.now();
      const response = await fetch(`${session.url}?start=30`);
      expect(response.status).toBe(415);
      expect(performance.now() - began).toBeGreaterThanOrEqual(timeout);
      expect(performance.now() - began).toBeLessThan(2500);
    } finally {
      await dispose();
    }
  });

  it("starts a converted picture exactly where asked, with the subtitle on screen there", async () => {
    const { open, dispose } = await titles();
    // No H.264 here, so the picture converts.
    const session = await open("TEST | Long subtitles", ["aac"]);

    const feed = await subtitles(session.url, 137, 2);
    expect(screenAt(feed.before.changes, 137)).toBe(1);
    const run = await feed.run();

    expect(Number(run.response.headers.get("x-start"))).toBeCloseTo(137, 2);
    // The file ends at 150 s: thirteen seconds of picture at 5 frames a second, without the
    // sixteen the subtitle had been on screen before them.
    const frames = framesOf(run.body);
    expect(frames).toBeGreaterThan(60);
    expect(frames).toBeLessThan(70);
    await vi.waitFor(() => expect(shown(feed.changes).at(-1)).toEqual([139, 0]));
    await dispose();
  });

  it("copies sound the player decodes, such as E-AC-3 where the system has it", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks", [...LINUX, "eac3"]);

    const run = await play(`${session.url}?start=6&audio=1`);

    expect(run.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "eac3",
      channels: 6,
    });
    await dispose();
  });

  it("plays the chosen sound track", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Two sound tracks");

    const run = await play(`${session.url}?start=0&audio=2`);

    expect(run.response.status).toBe(200);
    expect(run.streams.find((stream) => stream.codec_type === "audio")).toMatchObject({
      codec_name: "aac",
      channels: 2,
    });
    await dispose();
  });

  it("keeps earlier MP4 text samples when a new run starts before the previous one", async () => {
    const { open, provider, dispose } = await titles();
    const movie = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Index at the end"),
    );
    provider.replaceMovieFile(movie?.id ?? 0, fixture("title-receiver.mp4"));
    const session = await open("TEST | Index at the end");
    await play(`${session.url}?start=50&subtitle=3`);
    const feed = await subtitles(session.url, 0, 3);
    await feed.run();
    await vi.waitFor(() => expect(linesAt(feed.lines, 4)).toEqual(["Three to six"]), {
      timeout: 10_000,
    });
    expect(provider.mostFilesAtOnce()).toBe(1);
    await dispose();
  });

  it("leaves an MP4's text subtitles to the run, which starts them at their own line", async () => {
    const { open, dispose } = await titles();
    // Its index sits at the end, which is read by asking for byte ranges.
    const session = await open("TEST | Index at the end");
    expect(session.subtitles.map((track) => track.label)).toEqual(["English"]);

    const feed = await subtitles(session.url, 5, 2);
    // An MP4 lists each track's own samples: nothing to read before the run.
    expect(feed.before.lines).toEqual([]);
    const run = await feed.run();

    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "aac"]);
    expect(Number(run.response.headers.get("x-start"))).toBeGreaterThan(3.8);
    expect(Number(run.response.headers.get("x-start"))).toBeLessThanOrEqual(4);
    await vi.waitFor(() => expect(feed.lines).toContainEqual([2, 4, "First line"]));
    await dispose();
  });

  it("converts a picture the player can't decode, starting exactly where asked", async () => {
    const { open, dispose } = await titles();
    const session = await open("TEST | Old AVI");

    const run = await play(`${session.url}?start=2.5`);

    expect(Number(run.response.headers.get("x-start"))).toBeCloseTo(2.5, 2);
    // The picture converts; MP3 sound plays as it is.
    expect(run.streams.map((stream) => stream.codec_name)).toEqual(["h264", "mp3"]);
    await dispose();
  });

  it("explains a title whose file the provider doesn't have", async () => {
    const { open, dispose } = await titles();

    await expect(open("TEST | Missing file")).rejects.toMatchObject({
      error: { kind: "stream", failure: { kind: "unavailable", status: 404 } },
    });
    await dispose();
  });

  it("holds one provider connection while skipping, and none once closed", async () => {
    // A provider that frees its connection a moment after a request closes, as real panels do:
    // a skip's next request can be refused, and is asked again.
    const { provider, open, playback, dispose } = await titles({}, { slotReleaseMs: 50 });
    const session = await open("TEST | Long subtitles");

    const leaving = new AbortController();
    const first = await fetch(`${session.url}?start=0&subtitle=2`, { signal: leaving.signal });
    expect(first.status).toBe(200);
    // A skip: the player asks for the subtitles before another position, which are read from
    // the file, and for the run from there.
    const feed = await subtitles(session.url, 137, 2);
    const second = await feed.run();
    expect(second.response.status).toBe(200);
    // And a skip while the file is still being read for the one before.
    const dropped = subtitles(session.url, 61, 3).catch(() => null);
    const last = await subtitles(session.url, 27, 2);
    expect(screenAt(last.before.changes, 27)).toBe(1);
    await dropped;
    expect(provider.mostFilesAtOnce()).toBe(1);
    leaving.abort();

    await playback.close(session.sessionId);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    expect((await fetch(`${session.url}?start=0`)).status).toBe(410);
    await dispose();
  });

  it.each([
    {
      change: "the viewer asked for something else",
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    },
    { change: "its password was entered again", error: { kind: "no-subscription" } },
  ])("opens nothing when $change while its file was read", async ({ change, error }) => {
    const holdable = holdableFetch();
    const { provider, playback, open, repair, dispose } = await titles({}, {}, holdable.fetch);
    const turn = await playback.begin();

    const held = holdable.holdNext();
    const opening = open("TEST | Long subtitles", LINUX, { turn });
    await held.arrived;
    if (change === "the viewer asked for something else") await playback.begin();
    else await repair();
    held.release();

    await expect(opening).rejects.toMatchObject({ error });
    // Nothing of it is left open: the provider's one connection is free for what is asked next.
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    const next = await open("TEST | Long subtitles");
    expect((await fetch(`${next.url}?start=0`)).status).toBe(200);
    await dispose();
  });
});
