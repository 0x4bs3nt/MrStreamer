import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Codec, StreamFailure } from "@mrstreamer/contracts/playback";
import * as Layer from "effect/Layer";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback, type PlaybackDeps, type ReceiverTarget } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture, type FakeProviderOptions } from "./fake-provider.ts";
import { withIndexEntries, withIndexEntryAt } from "./matroska-index.ts";
import {
  fakeProvider,
  holdableFetch,
  promised,
  runtimeFor,
  tempDir,
  testSecrets,
  userAgent,
} from "./support.ts";

// CI points this at the bundled build, with ffprobe beside it; locally the ones on PATH do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;

/** The first profile receivers get: what every one of them decodes. */
const RECEIVER: readonly Codec[] = ["h264", "aac"];
/** Where a title's first picture sits on the clock of a receiver's segments, in seconds. */
const CLOCK_START = 10;

/**
 * Playback for a receiver on a connected fake provider that allows one connection and frees it as
 * soon as a request closes, unless `options` say otherwise. The receiver is this test, asking over
 * loopback as a TV asks over the local network. `own` names a channel or title of the connected
 * subscription by the provider's id, and `fetchImpl` is what the subscription asks its provider
 * with.
 */
async function receiver(
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
  const own = (id: string) => ({ subscriptionId: source?.id ?? "no-subscription", id });
  const playback = await promised(runtime, Playback);
  const closed: string[] = [];
  /** What whoever opened a session was told went wrong with its stream. */
  const failed: StreamFailure[] = [];
  const target: ReceiverTarget = {
    address: "127.0.0.1",
    decoders: RECEIVER,
    closed: () => closed.push("closed"),
    failed: (failure) => failed.push(failure),
  };
  // Resolve the async provider addresses before any competing playback calls take their turns.
  const files = new Map(
    await Promise.all(
      provider.titles.movies.map(
        async (movie) =>
          [
            movie.id,
            source
              ? (await source.provider.titleFile("movie", String(movie.id), movie.container)).url
              : null,
          ] as const,
      ),
    ),
  );
  /**
   * Opens a test movie by name for the receiver, the way the app opens it from the catalogue.
   * `file` puts another clip behind its address first: a fixture by name, or its bytes. `asked`
   * gives the turn it is asked under.
   */
  const open = (
    name: string,
    file?: string | Buffer,
    decoders: readonly Codec[] = RECEIVER,
    asked?: { turn: number },
  ) => {
    const movie = provider.titles.movies.find((each) => each.name.startsWith(name));
    if (!movie || !source) throw new Error(`No movie ${name}`);
    if (file !== undefined) provider.replaceMovieFile(movie.id, file);
    const ref: TitleRef = { kind: "movie", ...own(String(movie.id)) };
    return playback.openReceiverTitle(ref, files.get(movie.id)!, { ...target, decoders }, asked);
  };
  /** Opens a movie and loads it with these tracks: the video playlist a receiver ends up with. */
  const load = async (
    name: string,
    file?: string | Buffer,
    tracks: { audio?: number | null; subtitle?: number | null } = {},
  ) => {
    const opened = await open(name, file);
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: tracks.audio ?? null,
      subtitle: tracks.subtitle ?? null,
    });
    if (!loaded) throw new Error("Not a receiver's title");
    const main = await playlist(loaded.url);
    return { opened, loaded, main, video: await playlist(main.stream ?? "") };
  };
  /** A test movie by the start of its name. */
  const movie = (name: string) => {
    const found = provider.titles.movies.find((each) => each.name.startsWith(name));
    if (!found) throw new Error(`No movie ${name}`);
    return found;
  };
  return { provider, playback, open, load, movie, target, closed, failed, source, own };
}

interface Listed {
  readonly url: string;
  /** Seconds, as the playlist says. */
  readonly length: number;
  /** Where it starts in the playlist, in seconds. */
  readonly at: number;
}

/** A playlist as a receiver reads it: what it names, relative to its own address. */
async function playlist(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  const lines = text.split("\n").map((line) => line.trim());
  const segments: Listed[] = [];
  let at = 0;
  lines.forEach((line, index) => {
    const length = /^#EXTINF:([\d.]+)/.exec(line)?.[1];
    if (length === undefined) return;
    segments.push({ url: new URL(lines[index + 1] ?? "", url).href, length: Number(length), at });
    at += Number(length);
  });
  const named = (pattern: RegExp) => {
    const found = lines.map((line) => pattern.exec(line)?.[1]).find((each) => each !== undefined);
    return found === undefined ? null : new URL(found, url).href;
  };
  return {
    status: response.status,
    type: response.headers.get("content-type"),
    text,
    segments,
    length: at,
    ended: lines.includes("#EXT-X-ENDLIST"),
    /** A multivariant playlist's one stream, and its subtitles. */
    stream: named(/^([^#\s].*)$/),
    subtitles: named(/^#EXT-X-MEDIA:.*URI="([^"]+)"/),
  };
}

/** What ffprobe reads of a segment: its tracks, and when each picture shows on the segments' clock. */
async function segment(url: string, signal?: AbortSignal) {
  return segmentOf(await fetch(url, signal ? { signal } : {}));
}

/**
 * The same of an answer that came already. ffprobe holds this process up while it reads, and the
 * proxy with it, so a test that sends requests together reads their answers only afterwards.
 */
async function segmentOf(response: Response) {
  const body = Buffer.from(await response.arrayBuffer());
  const probed = spawnSync(
    FFPROBE,
    [
      ...["-v", "error", "-print_format", "json", "-show_streams"],
      ...["-show_entries", "packet=stream_index,pts_time,flags", "-i", "pipe:0"],
    ],
    { input: body, maxBuffer: 64 * 1024 * 1024 },
  );
  const json = JSON.parse(probed.stdout.toString() || "{}") as {
    streams?: { index: number; codec_type: string; codec_name: string }[];
    packets?: { stream_index: number; pts_time?: string; flags: string }[];
  };
  const video = json.streams?.find((stream) => stream.codec_type === "video");
  const pictures = (json.packets ?? [])
    .filter((packet) => packet.stream_index === video?.index && packet.pts_time !== undefined)
    .map((packet) => ({ at: Number(packet.pts_time), key: packet.flags.includes("K") }));
  const times = pictures.map((picture) => picture.at);
  return {
    status: response.status,
    bytes: body.length,
    codecs: (json.streams ?? []).map((stream) => stream.codec_name),
    /** The first and last picture, by when they show, in seconds into the title. */
    from: Math.min(...times) - CLOCK_START,
    to: Math.max(...times) - CLOCK_START,
    /** Whether the segment's first packet is a keyframe, so it plays by itself. */
    startsOnKeyframe: pictures[0]?.key === true,
    keyframes: pictures.filter((picture) => picture.key).length,
  };
}

/**
 * Asks for a segment as a receiver does and reads it to its end, without ffprobe: for a segment a
 * test only needs made, with no subtitles read after it.
 */
async function fetched(url: string): Promise<number> {
  const response = await fetch(url);
  await response.arrayBuffer();
  return response.status;
}

/** A segment's subtitles as a receiver reads them: each line with its times in title seconds. */
async function cues(url: string) {
  const response = await fetch(url);
  const text = await response.text();
  const seconds = (stamp: string) =>
    stamp.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  const lines = [...text.matchAll(/^([\d:.]+) --> ([\d:.]+)\n([^\n]+)/gm)].map(
    (found) => [seconds(found[1]!), seconds(found[2]!), found[3]!] as const,
  );
  return { status: response.status, type: response.headers.get("content-type"), text, lines };
}

/** Where the receiver clips' picture has keyframes, in seconds into the title. */
const KEYFRAMES = [0, 0.7, 5.1, 5.6, 13.3, 13.5, 21.9, 30, 30.4, 44.8, 52.2, 61];
/** The Matroska receiver clip's clock starts here; its index names times on that clock. */
const CLOCK = 7.5;
/** A movie in a Matroska file and one in an MP4, which other clips take the place of. */
const MATROSKA = "TEST | Long subtitles";
const MP4 = "TEST | Two sound tracks and subtitles 1080p";

// Each test starts ffmpeg and ffprobe several times and waits for the provider's one connection
// between them, which takes a while under a busy suite. What the proxy must do in time, a test
// measures itself.
describe.skipIf(!hasTools)("a movie for a receiver", { timeout: 20_000 }, () => {
  it("gets a playlist of the whole title, its picture copied in segments that start where it says", async () => {
    const { provider, load } = await receiver();
    const { opened, loaded, main, video } = await load(MATROSKA);

    expect(opened.duration).toBeCloseTo(150, 0);
    expect(loaded.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/master\.m3u8$/);
    expect(main.type).toBe("application/vnd.apple.mpegurl");
    expect(main.subtitles).toBeNull();
    expect(video.ended).toBe(true);
    expect(video.text).toContain("#EXT-X-PLAYLIST-TYPE:VOD");
    // The title's own length, before any of it was made.
    expect(video.length).toBeCloseTo(opened.duration, 1);

    const first = await segment(video.segments[0]!.url);
    expect(first.codecs).toEqual(["h264", "aac"]);
    expect(first.startsOnKeyframe).toBe(true);
    expect(first.from).toBeCloseTo(0, 2);
    const second = await segment(video.segments[1]!.url);
    expect(second.from).toBeCloseTo(video.segments[1]!.at, 2);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it.each([
    ["a Matroska file whose clock starts late", MATROSKA, "title-receiver.mkv"],
    ["an MP4 with its index at the end", MP4, "title-receiver.mp4"],
  ])(
    "cuts %s at its own uneven keyframes, each segment on the title's clock",
    async (_what, movie, file) => {
      const { provider, load } = await receiver();
      const { opened, video } = await load(movie, file);

      // Sixty-four seconds of picture, and sound a moment longer.
      expect(opened.duration).toBeGreaterThan(64);
      expect(opened.duration).toBeLessThan(64.2);
      expect(video.length).toBeCloseTo(opened.duration, 1);
      // A segment starts on the first keyframe four seconds or more after the one before: the
      // close pairs stay together, and none is cut on a grid the picture doesn't have.
      const starts = [0, 5.1, 13.3, 21.9, 30, 44.8, 52.2, 61];
      expect(video.segments.map((each) => Number(each.at.toFixed(1)))).toEqual(starts);
      for (const [index, listed] of video.segments.entries()) {
        const made = await segment(listed.url);
        expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
        // Pictures are stored out of the order they show in: the keyframe still shows first.
        expect(made.from, `segment ${index}`).toBeCloseTo(listed.at, 2);
        expect(made.to, `segment ${index}`).toBeLessThan(listed.at + listed.length);
        expect(made.to, `segment ${index}`).toBeGreaterThan(listed.at + listed.length - 0.35);
        expect(made.keyframes, `segment ${index}`).toBe(
          KEYFRAMES.filter(
            (time) => time >= listed.at - 0.01 && time < listed.at + listed.length - 0.01,
          ).length,
        );
      }
      // One reader of the provider's file, however many segments were asked for.
      expect(provider.mostFilesAtOnce()).toBe(1);
    },
  );

  it("copies an end-index MP4's picture when the same title is opened again", async () => {
    const { provider, playback, load } = await receiver();
    for (const file of ["title-receiver.mp4", undefined]) {
      const { video } = await load(MP4, file);
      expect(video.segments.map((each) => Number(each.at.toFixed(1)))).toEqual([
        0, 5.1, 13.3, 21.9, 30, 44.8, 52.2, 61,
      ]);
      const first = await segment(video.segments[0]!.url);
      expect(first.status).toBe(200);
      expect(first.startsOnKeyframe).toBe(true);
      // Copy keeps both original keyframes; conversion makes one at the segment's start.
      expect(first.keyframes).toBe(2);
      await playback.closeAll();
    }
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("starts anywhere the receiver skips to, near the end and backwards, one request at a time", async () => {
    // A provider that frees its connection a moment after a request closes, as real panels do:
    // a skip's next request can be refused, and is asked again.
    const { provider, load } = await receiver({}, { slotReleaseMs: 50 });
    const { video } = await load(MATROSKA, "title-receiver.mkv");
    const at = (index: number) => video.segments[index]!;

    // Far beyond anything made, then the last segment, then back to before both.
    for (const index of [5, video.segments.length - 1, 2, 6]) {
      const made = await segment(at(index).url);
      expect(made.status, `segment ${index}`).toBe(200);
      expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
      expect(made.from, `segment ${index}`).toBeCloseTo(at(index).at, 2);
    }
    const last = await segment(at(video.segments.length - 1).url);
    // The title's last picture: a tenth of a second before its end.
    expect(last.to).toBeCloseTo(video.length - 0.12, 1);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("serves a segment away from the start from a provider that knows no byte ranges", async () => {
    const { provider, load } = await receiver({}, { wholeFiles: true });
    const { video } = await load(MATROSKA, "title-receiver.mkv");
    const asked = video.segments.find((each) => each.at >= 30)!;
    const before = { requests: provider.fileRequests(), bytes: provider.fileBytes() };
    const made = await segment(asked.url);

    expect(made.status).toBe(200);
    expect(made.from).toBeCloseTo(asked.at, 2);
    expect(made.to).toBeLessThan(asked.at + asked.length);
    expect(made.startsOnKeyframe).toBe(true);
    expect(made.codecs).toEqual(["h264", "aac"]);
    expect(provider.fileRequests() - before.requests).toBeLessThanOrEqual(8);
    expect(provider.fileBytes() - before.bytes).toBeLessThanOrEqual(
      4 * fixture("title-receiver.mkv").length,
    );
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("answers requests for segments far apart at once without a second reader", async () => {
    const { provider, playback, load } = await receiver();
    const { opened, video } = await load(MATROSKA, "title-receiver.mkv");
    const asked = () => playback.receiverRequests(opened.sessionId);

    // A receiver that skips twice before the first answer came, and asks for the next one too.
    // The proxy takes where the receiver is from the request that reached it last, and requests
    // sent together, each on a connection of its own, reach it in any order. So each is sent as
    // soon as the proxy has counted the one before, and no answer is read until all four are in.
    const answers = [];
    for (const index of [1, 6, 4, 5]) {
      const before = (await asked()) ?? 0;
      answers.push(fetch(video.segments[index]!.url).then((answer) => [index, answer] as const));
      await vi.waitFor(async () => expect(await asked()).toBe(before + 1), { interval: 1 });
    }
    for (const [index, answer] of await Promise.all(answers)) {
      const made = await segmentOf(answer);
      // Where it went last, and the segment after, play. One it left may get nothing.
      if (index === 4 || index === 5) expect(made.status, `segment ${index}`).toBe(200);
      else expect([200, 503], `segment ${index}`).toContain(made.status);
      if (made.status === 200) expect(made.from).toBeCloseTo(video.segments[index]!.at, 2);
    }
    expect(provider.mostFilesAtOnce()).toBe(1);
    // Asked again, the one it left plays.
    expect((await segment(video.segments[1]!.url)).from).toBeCloseTo(video.segments[1]!.at, 2);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("copies by an index that lists only some keyframes, the others inside the segments", async () => {
    const { load } = await receiver();
    const kept = [0, 13.3, 30, 44.8, 61].map((time) => CLOCK + time);
    const { video } = await load(MATROSKA, withIndexEntries(fixture("title-receiver.mkv"), kept));

    expect(video.segments.map((each) => Number(each.at.toFixed(1)))).toEqual([
      0, 13.3, 30, 44.8, 61,
    ]);
    const second = await segment(video.segments[1]!.url);
    expect(second.from).toBeCloseTo(13.3, 2);
    // 13.3, 13.5 and 21.9: the keyframes the index doesn't name are in it, uncut.
    expect(second.keyframes).toBe(3);
    expect((await segment(video.segments[3]!.url)).from).toBeCloseTo(44.8, 2);
  });

  it("converts the picture when the index is too sparse to copy by, on the title's own clock", async () => {
    const { provider, load } = await receiver();
    const sparse = withIndexEntries(
      fixture("title-receiver.mkv"),
      [0, 21.9, 44.8].map((time) => CLOCK + time),
    );
    const { opened, video } = await load(MATROSKA, sparse);

    expect(video.length).toBeCloseTo(opened.duration, 1);
    // No index to cut by: every four seconds, with a keyframe made at each start.
    expect(video.segments.slice(0, 4).map((each) => each.at)).toEqual([0, 4, 8, 12]);
    for (const index of [9, 0, video.segments.length - 1]) {
      const listed = video.segments[index]!;
      const made = await segment(listed.url);
      expect(made.codecs, `segment ${index}`).toEqual(["h264", "aac"]);
      expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
      expect(made.keyframes, `segment ${index}`).toBe(1);
      // The first frame at or after the start: within a frame of it.
      expect(made.from, `segment ${index}`).toBeGreaterThanOrEqual(listed.at - 0.001);
      expect(made.from, `segment ${index}`).toBeLessThan(listed.at + 0.11);
    }
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("converts from the segment on where the index names a keyframe that isn't there", async () => {
    const { load } = await receiver();
    // The entry of the keyframe at 30 s says 28.5 s.
    const wrong = withIndexEntryAt(fixture("title-receiver.mkv"), CLOCK + 30, CLOCK + 28.5);
    const { opened, video } = await load(MATROSKA, wrong);

    const named = video.segments.findIndex((each) => Math.abs(each.at - 28.5) < 0.01);
    expect(named).toBeGreaterThan(0);
    // Played through from the start, and skipped to: both get a segment that starts where the
    // playlist the receiver already has says, not where the keyframe turned out to be.
    for (const index of [named - 1, named, named + 1]) {
      const listed = video.segments[index]!;
      const made = await segment(listed.url);
      expect(made.status, `segment ${index}`).toBe(200);
      expect(made.startsOnKeyframe, `segment ${index}`).toBe(true);
      expect(Math.abs(made.from - listed.at), `segment ${index}`).toBeLessThan(0.11);
      expect(made.to, `segment ${index}`).toBeLessThan(listed.at + listed.length);
    }
    expect(video.length).toBeCloseTo(opened.duration, 1);
  });

  it.each([
    // MPEG-4 Part 2 with MP3: both convert.
    ["a picture the receiver doesn't decode", "TEST | Old AVI", 6, true],
    // H.264 in a transport stream, which lists no keyframes, and no sound.
    ["a recording without an index", "TEST | Long recording", 40, false],
  ])("converts %s and keeps the title's length", async (_what, movie, length, sound) => {
    const { load } = await receiver();
    const { opened, video } = await load(movie);

    expect(opened.duration).toBeCloseTo(length, 0);
    expect(video.length).toBeCloseTo(opened.duration, 1);
    const last = video.segments.length - 1;
    const made = await segment(video.segments[last]!.url);
    expect(made.codecs[0]).toBe("h264");
    expect(made.codecs.slice(1)).toEqual(sound ? ["aac"] : []);
    expect(made.startsOnKeyframe).toBe(true);
    expect(Math.abs(made.from - video.segments[last]!.at)).toBeLessThan(0.21);
  });

  // Like the local-title controlled converter, this executable uses a Unix shebang.
  it.skipIf(process.platform === "win32").each([true, false])(
    "settles a completed converter with a late subtitle report: %s",
    async (sent) => {
      const directory = await tempDir();
      const executable = join(directory, "converter.cjs");
      const report = join(directory, "report.json");
      await writeFile(
        executable,
        `#!${process.execPath}\nconst { writeFileSync } = require("node:fs");\nwriteFileSync(${JSON.stringify(report)}, JSON.stringify({ pid: process.pid, url: process.argv.find(arg => arg.endsWith("/subtitles")) }));\n`,
        { mode: 0o700 },
      );
      const { playback, open } = await receiver({ ffmpeg: executable });
      const opened = await open(MATROSKA, "title-receiver.mkv");
      const loaded = await playback.loadReceiverTitle(opened.sessionId, {
        audio: null,
        subtitle: opened.subtitles.find((track) => track.language === "en")!.id,
      });
      const main = await playlist(loaded!.url);
      const video = await playlist(main.stream!);
      const subtitles = await playlist(main.subtitles!);
      const waiting = fetched(video.segments[0]!.url);
      let converter: { pid: number; url: string };
      await vi.waitFor(async () => {
        converter = JSON.parse(await readFile(report, "utf8"));
        expect(converter.url).toMatch(/\/report\/[^/]+\/[^/]+\/subtitles$/);
        expect(() => process.kill(converter.pid, 0)).toThrow();
      });
      if (sent) {
        const response = await fetch(converter!.url, {
          method: "PUT",
          body: "WEBVTT\n\n00:00:10.500 --> 00:00:11.500\nLate report\n\n",
        });
        expect(response.status).toBe(204);
      }
      // The stand-in sends no video. Completion must still release the waiting receiver.
      expect(await waiting).toBe(503);
      expect((await cues(subtitles.segments[0]!.url)).lines).toEqual(
        sent ? [[3, 4, "Late report"]] : [],
      );
    },
  );

  it("sends text subtitles as a rendition, a line across a cut in both segments", async () => {
    const { playback, open } = await receiver();
    const opened = await open(MATROSKA, "title-receiver.mkv");
    const english = opened.subtitles.find((track) => track.language === "en");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    expect(loaded?.subtitles).toBe(true);
    const main = await playlist(loaded!.url);
    expect(main.text).toMatch(/#EXT-X-MEDIA:TYPE=SUBTITLES.*NAME="English".*LANGUAGE="en"/);
    const video = await playlist(main.stream!);
    const subtitles = await playlist(main.subtitles!);
    expect(subtitles.segments.map((each) => each.length)).toEqual(
      video.segments.map((each) => each.length),
    );

    // Played from the start. The segments are cut at 5.1 and 13.3 s: "Three to six" runs across
    // the first cut and "Twelve to sixteen" across the second.
    for (const index of [0, 1, 2, 3]) await segment(video.segments[index]!.url);
    const first = await cues(subtitles.segments[0]!.url);
    expect(first.type).toBe("text/vtt; charset=utf-8");
    expect(first.text).toContain("X-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000");
    expect(first.lines).toEqual([[3, 6, "Three to six"]]);
    expect((await cues(subtitles.segments[1]!.url)).lines).toEqual([
      [3, 6, "Three to six"],
      [12, 16, "Twelve to sixteen"],
    ]);
    expect((await cues(subtitles.segments[2]!.url)).lines).toEqual([[12, 16, "Twelve to sixteen"]]);
  });

  it.each([
    ["a Matroska file, read from before the position", MATROSKA, "title-receiver.mkv"],
    ["an MP4, whose track starts at its own line", MP4, "title-receiver.mp4"],
  ])("keeps the line on screen where the receiver skips to in %s", async (_what, movie, file) => {
    const { provider, playback, open } = await receiver();
    const opened = await open(movie, file);
    const english = opened.subtitles.find((track) => track.language === "en");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    const main = await playlist(loaded!.url);
    const video = await playlist(main.stream!);
    const subtitles = await playlist(main.subtitles!);

    // Straight to the segment that starts at 30 s: "Across thirty" began at 29 s.
    const at = video.segments.findIndex((each) => Math.abs(each.at - 30) < 0.01);
    const [made, lines] = await Promise.all([
      segment(video.segments[at]!.url),
      // The next one too, as a receiver fills its buffer.
      segment(video.segments[at + 1]!.url).then(() => cues(subtitles.segments[at]!.url)),
    ]);
    expect(made.from).toBeCloseTo(30, 2);
    expect(lines.lines).toEqual([[29, 33, "Across thirty"]]);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("keeps the line on screen where the receiver skips to from what a run read, on a provider that knows no byte ranges", async () => {
    const { provider, playback, open, failed } = await receiver({}, { wholeFiles: true });
    const opened = await open(MATROSKA, "title-receiver.mkv");
    const english = opened.subtitles.find((track) => track.language === "en");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    const main = await playlist(loaded!.url);
    const video = await playlist(main.stream!);
    const subtitles = await playlist(main.subtitles!);
    // Without byte ranges there is no index to cut the picture at its keyframes: the segments
    // are even, and one starts at 32 s.
    const at = video.segments.findIndex((each) => Math.abs(each.at - 32) < 0.01);
    /** Skips to the segment at 32 s, and the next as a receiver fills its buffer. */
    const skip = () =>
      Promise.all([
        segment(video.segments[at]!.url),
        segment(video.segments[at + 1]!.url).then(() => cues(subtitles.segments[at]!.url)),
      ]);

    // Nothing has read the file from its start: "Across thirty", from 29 s, can't be had.
    const [cold, without] = await skip();
    expect(cold.from).toBeCloseTo(32, 2);
    expect(without.lines).toEqual([]);
    // Played from the start to the end, which reads every line.
    for (const each of video.segments) expect((await segment(each.url)).status).toBe(200);
    const [made, lines] = await skip();

    expect(made.from).toBeCloseTo(32, 2);
    expect(made.startsOnKeyframe).toBe(true);
    expect(lines.lines).toEqual([[29, 33, "Across thirty"]]);
    expect(failed).toEqual([]);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 30_000);

  it("answers for a segment's subtitles in time while the line from before a skip is still being read", async () => {
    const { provider, playback, open } = await receiver({ receiver: { cuesMs: 150 } });
    const opened = await open(MATROSKA, "title-receiver.mkv");
    const english = opened.subtitles.find((track) => track.language === "en");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    const main = await playlist(loaded!.url);
    const video = await playlist(main.stream!);
    const subtitles = await playlist(main.subtitles!);
    const at = video.segments.findIndex((each) => Math.abs(each.at - 30) < 0.01);
    // Reading what the track held before the position takes the provider a while.
    provider.slowFileParts(400);

    await segment(video.segments[at]!.url);
    await segment(video.segments[at + 1]!.url);
    const asked = performance.now();
    const soon = await cues(subtitles.segments[at]!.url);
    // The picture's own reading has no line that began before it: the segment goes without.
    expect(soon.status).toBe(200);
    expect(soon.lines).toEqual([]);
    expect(performance.now() - asked).toBeLessThan(1000);
    // A receiver that leaves while it waits is let go of, and the next one still gets an answer.
    const leaving = new AbortController();
    const left = fetch(subtitles.segments[at]!.url, { signal: leaving.signal }).catch(() => null);
    setTimeout(() => leaving.abort(), 50);
    expect(await left).toBeNull();
    // Once the reading is done, the line that was on screen at the position is there.
    await vi.waitFor(
      async () =>
        expect((await cues(subtitles.segments[at]!.url)).lines).toEqual([
          [29, 33, "Across thirty"],
        ]),
      { timeout: 10_000, interval: 300 },
    );
  }, 15_000);

  it("ends what a receiver was sent when the provider puts another file behind the title", async () => {
    const { provider, load, open, movie, failed } = await receiver();
    const { video, loaded } = await load(MATROSKA, "title-receiver.mkv");
    expect(await fetched(video.segments[0]!.url)).toBe(200);

    provider.replaceMovieFile(movie(MATROSKA).id, "title-h264-eac3-subs.mkv");
    // The playlist the receiver holds is of the file that is gone: nothing more is made of it.
    const next = await fetch(video.segments[5]!.url);
    expect(next.status).toBeGreaterThanOrEqual(400);
    expect(failed).toEqual([expect.objectContaining({ kind: "network" })]);
    expect((await fetch(loaded.url)).status).toBe(410);
    expect((await fetch(video.segments[0]!.url)).status).toBe(410);
    // Opened again, the title is the new file: its own length and playlist.
    const again = await open(MATROSKA);
    expect(again.duration).toBeCloseTo(20, 0);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("ends it too when the other file is as long to the byte, and reads that one when opened again", async () => {
    const { provider, playback, load, open, movie, failed } = await receiver();
    const { video, loaded } = await load(MATROSKA, "title-receiver.mkv");
    expect(await fetched(video.segments[0]!.url)).toBe(200);

    // The same file but for one line of its subtitles, which its server marks as another.
    const other = fixture("title-receiver.mkv");
    other.write("Three to SIX", other.indexOf("Three to six"));
    provider.replaceMovieFile(movie(MATROSKA).id, other);
    expect((await fetch(video.segments[5]!.url)).status).toBeGreaterThanOrEqual(400);
    expect((await fetch(loaded.url)).status).toBe(410);
    expect((await fetch(video.segments[0]!.url)).status).toBe(410);
    // Whoever opened it heard once, however often the receiver asked after that.
    expect(failed).toEqual([expect.objectContaining({ kind: "network" })]);

    const again = await open(MATROSKA);
    const english = again.subtitles.find((track) => track.language === "en");
    const reloaded = await playback.loadReceiverTitle(again.sessionId, {
      audio: null,
      subtitle: english!.id,
    });
    const main = await playlist(reloaded!.url);
    const fresh = await playlist(main.stream!);
    for (const index of [0, 1]) await segment(fresh.segments[index]!.url);
    const lines = await cues((await playlist(main.subtitles!)).segments[0]!.url);
    expect(lines.lines).toEqual([[3, 6, "Three to SIX"]]);
    expect(failed).toHaveLength(1);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("gives up a segment the provider doesn't send in time, and makes it when asked again", async () => {
    const { provider, playback, load, movie, failed } = await receiver({
      receiver: { segmentMs: 1500 },
    });
    const { opened, video } = await load(MATROSKA, "title-receiver.mkv");
    // The provider stops in the middle of the file, as a stalled connection does: inside the
    // segment that starts at 30 s, which a reading from there never gets to the end of.
    const at = video.segments.findIndex((each) => Math.abs(each.at - 30) < 0.01);
    provider.stallMovieFile(movie(MATROSKA).id, 200_000, 60_000);

    const asked = performance.now();
    const stalled = await fetch(video.segments[at]!.url);
    expect(stalled.status).toBe(504);
    expect(performance.now() - asked).toBeLessThan(4000);
    expect(failed).toEqual([expect.objectContaining({ kind: "network" })]);
    expect(await playback.failure(opened.sessionId)).toMatchObject({ kind: "network" });
    // The reading ended with the request: the provider's connection is free again.
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));

    provider.stallMovieFile(movie(MATROSKA).id, 200_000, 0);
    const made = await segment(video.segments[at]!.url);
    expect(made.status).toBe(200);
    expect(made.from).toBeCloseTo(video.segments[at]!.at, 2);
    expect(provider.mostFilesAtOnce()).toBe(1);
  }, 15_000);

  it("leaves subtitles that are pictures out, and the picture as it is", async () => {
    const { playback, open } = await receiver();
    const opened = await open("TEST | Picture subtitles");
    const picture = opened.subtitles.find((track) => track.format === "picture");
    const loaded = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: picture!.id,
    });

    expect(loaded?.subtitles).toBe(false);
    const main = await playlist(loaded!.url);
    expect(main.subtitles).toBeNull();
    const video = await playlist(main.stream!);
    // Still cut at the file's keyframes, every two seconds: copied, not converted to draw them in.
    expect(video.segments[1]!.at).toBeCloseTo(4, 2);
    expect((await segment(video.segments[1]!.url)).keyframes).toBe(2);
  });

  it("holds the provider while the receiver has enough", async () => {
    const { provider, load } = await receiver({ receiver: { segments: { ahead: 1 } } });
    const { video } = await load(MATROSKA, "title-receiver.mkv");
    const exact = async (index: number) =>
      expect((await segment(video.segments[index]!.url)).from).toBeCloseTo(
        video.segments[index]!.at,
        2,
      );

    await exact(1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // One segment ahead is made and ffmpeg waits: it hasn't read on to the end of the file, so
    // what the receiver asks for next comes of the same reading, with nothing new asked of the
    // provider.
    const asked = provider.fileRequests();
    for (const index of [2, 3, 4]) await exact(index);
    expect(provider.fileRequests()).toBe(asked);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("lets go of the provider when the receiver stays away, and goes on when it asks again", async () => {
    const { provider, load } = await receiver({
      receiver: { idleMs: 150, segments: { ahead: 1 } },
    });
    const { video } = await load(MATROSKA, "title-receiver.mkv");

    expect((await segment(video.segments[1]!.url)).status).toBe(200);
    // Nothing asked for a while, as when paused: the reading ends.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const asked = provider.fileRequests();
    const next = await segment(video.segments[3]!.url);
    expect(next.from).toBeCloseTo(video.segments[3]!.at, 2);
    expect(provider.fileRequests()).toBeGreaterThan(asked);
    expect(provider.mostFilesAtOnce()).toBe(1);
  });

  it("serves a receiver only its own load, and nothing of the proxy's own", async () => {
    const { playback, open, closed } = await receiver();
    const opened = await open(MATROSKA, "title-receiver.mkv");
    const first = await playback.loadReceiverTitle(opened.sessionId, {
      audio: null,
      subtitle: null,
    });
    const preflight = await fetch(first!.url, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toBe("Range");
    const lan = new URL(first!.url);
    const token = lan.pathname.split("/")[2]!;
    const status = async (path: string, method = "GET") =>
      (await fetch(`${lan.origin}${path}`, { method })).status;

    expect(await status(`/r/${token}/master.m3u8`)).toBe(200);
    // What ffmpeg and ffprobe read and report stays on loopback's own port.
    for (const path of [
      `/source/${token}`,
      `/title/${token}.mp4`,
      `/stream/${token}.ts`,
      `/report/${token}/x/start`,
      `/hls/${token}/x/0.ts`,
      `/r/${token}/../../source/${token}`,
      `/r/${token}/%2e%2e/%2e%2e/source/${token}`,
      `/r/${token}/v0.ts/../../../title/${token}.mp4`,
      `/r/${token}/secret.txt`,
      `/r/wrong-token/master.m3u8`,
      `/`,
    ]) {
      expect(await status(path), path).toBe(410);
    }
    expect(await status(`/r/${token}/master.m3u8`, "POST")).toBe(410);

    // Other tracks are another load, under another token: the one before is gone.
    const second = await playback.loadReceiverTitle(opened.sessionId, {
      audio: opened.audio[1]!.id,
      subtitle: null,
    });
    expect(second!.url).not.toBe(first!.url);
    expect(await status(`/r/${token}/master.m3u8`)).toBe(410);
    expect((await fetch(second!.url)).status).toBe(200);

    // Closed, the address answers nobody, and whoever opened it for a receiver hears.
    await playback.close(opened.sessionId);
    expect(closed).toEqual(["closed"]);
    await expect(fetch(second!.url)).rejects.toThrow();
  });

  it("is the one session: opening it closes what played here, and the other way round", async () => {
    const { provider, playback, load, source, own } = await receiver();
    const channel = String(
      provider.catalogue.channels.find((each) => !each.offline && !each.fixture)!.streamId,
    );
    const local = await playback.open(own(channel), RECEIVER);
    const reading = new AbortController();
    void fetch(local.url, { signal: reading.signal }).catch(() => {});
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(1));

    const { opened, video } = await load(MATROSKA, "title-receiver.mkv");
    expect(await fetched(video.segments[0]!.url)).toBe(200);
    expect((await fetch(local.url)).status).toBe(410);

    // A title opened for this computer takes the receiver's place.
    const movie = provider.titles.movies.find((each) => each.name.startsWith(MP4))!;
    await playback.openTitle(
      { kind: "movie", ...own(String(movie.id)) },
      (await source!.provider.titleFile("movie", String(movie.id), movie.container)).url,
      RECEIVER,
    );
    await expect(fetch(video.segments[1]!.url)).rejects.toThrow();
    expect(await playback.receiverRequests(opened.sessionId)).toBeNull();
    reading.abort();
  });

  it("refuses a page's preview while a receiver has the session, one asked for before it opened too", async () => {
    const { provider, playback, load, closed, own } = await receiver();
    const channel = String(
      provider.catalogue.channels.find((each) => !each.offline && !each.fixture)!.streamId,
    );
    const refused = { error: { kind: "unexpected", detail: "A receiver has playback." } };

    // Asked for while the receiver's title is still being read: its turn comes after.
    const opening = load(MATROSKA, "title-receiver.mkv");
    await expect(playback.open(own(channel), RECEIVER, { preview: true })).rejects.toMatchObject(
      refused,
    );
    const { video } = await opening;
    await expect(playback.open(own(channel), RECEIVER, { preview: true })).rejects.toMatchObject(
      refused,
    );

    // The receiver's session never closed: it still gets what it asks for.
    expect(closed).toEqual([]);
    expect(await fetched(video.segments[0]!.url)).toBe(200);
  });

  it("opens nothing once the viewer asked for something else while its index was read", async () => {
    const holdable = holdableFetch();
    const { provider, playback, open, closed } = await receiver({}, {}, holdable.fetch);
    // What the file holds is known from when it was open before: its index is what is read now.
    const before = await open(MATROSKA, "title-receiver.mkv");
    await playback.close(before.sessionId);
    const turn = await playback.begin();

    const held = holdable.holdNext();
    const opening = open(MATROSKA, undefined, RECEIVER, { turn });
    await held.arrived;
    await playback.begin();
    held.release();

    await expect(opening).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    });
    // Its session closed, as whoever opened it for the receiver hears, and nothing is left open.
    expect(closed).toEqual(["closed", "closed"]);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
  });
});

describe.skipIf(!hasTools)("a channel for a receiver", () => {
  /** A provider whose channels send a forty-second recording at once and stay open, as a live one does. */
  const recording = (): FakeProviderOptions => ({
    streams: (_channel, out) => void out.write(fixture("recording-long-subtitles.mpegts")),
  });

  it("is cut into segments from the one stream, the newest in its playlist", async () => {
    const { provider, playback, target, own } = await receiver({}, recording());
    const channel = String(provider.catalogue.channels[0]!.streamId);
    const opened = await playback.openReceiver(own(channel), target);

    expect(opened.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/r\/[\w-]+\/live\.m3u8$/);
    const live = await playlist(opened.url);
    expect(live.status).toBe(200);
    expect(live.ended).toBe(false);
    expect(live.segments.length).toBeGreaterThanOrEqual(2);
    for (const listed of live.segments) expect(listed.length).toBeGreaterThanOrEqual(1.9);
    const made = await segment(live.segments.at(-1)!.url);
    expect(made.status).toBe(200);
    // The recording has a picture and no sound.
    expect(made.codecs).toEqual(["h264"]);
    expect(made.startsOnKeyframe).toBe(true);
    // The stream goes on: a later playlist has moved, and holds no more than a few segments.
    const later = await vi.waitFor(async () => {
      const next = await playlist(opened.url);
      expect(next.segments.at(-1)!.url).not.toBe(live.segments[0]!.url);
      return next;
    });
    expect(later.segments.length).toBeLessThanOrEqual(6);
    expect(provider.streamRequests()).toBe(1);
    expect(provider.activeStreams()).toBe(1);

    await playback.close(opened.sessionId);
    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
  });

  it("has only the sound the receiver can't decode converted", async () => {
    const { provider, playback, target, own } = await receiver();
    const channel = provider.catalogue.channels.find((each) => each.name === "TEST | H.264 + MP2")!;
    const opened = await playback.openReceiver(own(String(channel.streamId)), target);

    const live = await playlist(opened.url);
    expect(live.segments.length).toBeGreaterThanOrEqual(1);
    const made = await segment(live.segments[0]!.url);
    expect(made.codecs).toEqual(["h264", "aac"]);
    // The fixture's three seconds are over: the playlist says so, and why.
    await vi.waitFor(async () => expect((await playlist(opened.url)).ended).toBe(true));
    expect(await playback.failure(opened.sessionId)).toMatchObject({ kind: "network" });
  });

  it("says why when the provider has no stream", async () => {
    const { provider, playback, target, own } = await receiver();
    const channel = provider.catalogue.channels.find((each) => each.offline)!;
    const opened = await playback.openReceiver(own(String(channel.streamId)), target);

    expect((await playlist(opened.url)).status).toBe(404);
    expect(await playback.failure(opened.sessionId)).toMatchObject({ kind: "unavailable" });
  });
});

describe("an HLS channel for a receiver", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    }
  });

  it("has its playlists pointed at this computer, and the broadcaster's addresses kept from it", async () => {
    const clip = fixture("h264-aac.mpegts");
    const asked: { path: string; userAgent?: string }[] = [];
    const server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://host");
      asked.push({
        path: pathname,
        ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      });
      const body = routes.get(pathname);
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200).end(body);
    });
    servers.push(server);
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = new Map<string, string | Buffer>([
      [
        "/list.m3u",
        `#EXTM3U\n#EXTINF:-1 tvg-id="Alpha.test" http-user-agent="Player/1.0",Alpha\n${origin}/alpha/index.m3u8?token=s3cret\n`,
      ],
      [
        "/alpha/index.m3u8",
        '#EXTM3U\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="cc",NAME="English",URI="subs/en.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,SUBTITLES="cc"\nlow/stream.m3u8\n',
      ],
      ["/alpha/subs/en.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nen.vtt\n"],
      ["/alpha/subs/en.vtt", "WEBVTT\n\n00:00.000 --> 00:06.000\nHello\n"],
      ["/alpha/low/stream.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nsegment-0.ts\n"],
      ["/alpha/low/segment-0.ts", clip],
    ]);
    const runtime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(
        Layer.provide(PlaybackCoordination.layer),
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir: await tempDir(),
            secrets: testSecrets,
            providerOptions: { userAgent },
          }),
        ),
      ),
    );
    const { id: subscriptionId } = await (
      await promised(runtime, Subscriptions)
    ).add({ server: `${origin}/list.m3u`, username: "", password: "" });
    const playback = await promised(runtime, Playback);

    const opened = await playback.openReceiver(
      { subscriptionId, id: "Alpha.test" },
      {
        address: "127.0.0.1",
        decoders: RECEIVER,
      },
    );
    const lan = new URL(opened.url).origin;
    const main = await playlist(opened.url);
    expect(main.text).not.toContain(origin);
    expect(main.text).not.toContain("s3cret");
    expect(main.stream).toMatch(new RegExp(`^${lan}/r/[\\w-]+/h[0-9a-z]+$`));
    const stream = await playlist(main.stream!);
    expect(stream.segments[0]!.url.startsWith(`${lan}/r/`)).toBe(true);
    expect(Buffer.from(await (await fetch(stream.segments[0]!.url)).arrayBuffer())).toEqual(clip);
    expect(main.subtitles).toMatch(new RegExp(`^${lan}/r/[\\w-]+/hsubs-[0-9a-z]{1,12}$`));
    const subtitles = await playlist(main.subtitles!);
    expect(subtitles.status).toBe(200);
    expect(subtitles.text).not.toContain(origin);
    const line = await fetch(subtitles.segments[0]!.url);
    expect(line.status).toBe(200);
    expect(await line.text()).toContain("Hello");
    expect(await playback.failure(opened.sessionId)).toBeNull();
    // Subtitle failure must preserve an existing video failure, and never create one.
    routes.delete("/alpha/subs/en.vtt");
    expect((await fetch(subtitles.segments[0]!.url)).status).toBe(404);
    expect(await playback.failure(opened.sessionId)).toBeNull();
    routes.delete("/alpha/low/segment-0.ts");
    expect((await fetch(stream.segments[0]!.url)).status).toBe(404);
    const videoFailure = await playback.failure(opened.sessionId);
    expect(videoFailure).toMatchObject({ kind: "unavailable", status: 404 });
    expect((await fetch(subtitles.segments[0]!.url)).status).toBe(404);
    expect(await playback.failure(opened.sessionId)).toEqual(videoFailure);
    routes.set("/alpha/subs/en.vtt", "WEBVTT\n");
    expect((await fetch(subtitles.segments[0]!.url)).status).toBe(200);
    expect(await playback.failure(opened.sessionId)).toEqual(videoFailure);
    const route = new URL(main.subtitles!);
    for (const path of [
      route.pathname.replace("/hsubs-", "/hsubs--"),
      route.pathname + "1234567890123",
      route.pathname.replace(/\/r\/[^/]+\//, "/r/wrong-token/"),
    ]) {
      expect((await fetch(new URL(path, lan))).status).toBe(410);
    }
    // Every request the receiver made went out with the header the channel asks for.
    for (const request of asked.filter((each) => each.path.startsWith("/alpha/"))) {
      expect(request.userAgent).toBe("Player/1.0");
    }
    await playback.close(opened.sessionId);
    await expect(fetch(opened.url)).rejects.toThrow();
  });

  it("answers a request whose target is no address with 400, here and on the local network, and goes on", async () => {
    const server = createServer((request, response) => {
      const body = routes.get(new URL(request.url ?? "/", "http://host").pathname);
      if (body === undefined) response.writeHead(404).end();
      else response.writeHead(200).end(body);
    });
    servers.push(server);
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const routes = new Map<string, string | Buffer>([
      ["/list.m3u", `#EXTM3U\n#EXTINF:-1 tvg-id="Alpha.test",Alpha\n${origin}/alpha/index.m3u8\n`],
      ["/alpha/index.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nsegment-0.ts\n"],
      ["/alpha/segment-0.ts", fixture("h264-aac.mpegts")],
    ]);
    const runtime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(
        Layer.provide(PlaybackCoordination.layer),
        Layer.provideMerge(
          Subscriptions.layer({
            dataDir: await tempDir(),
            secrets: testSecrets,
            providerOptions: { userAgent },
          }),
        ),
      ),
    );
    const { id: subscriptionId } = await (
      await promised(runtime, Subscriptions)
    ).add({ server: `${origin}/list.m3u`, username: "", password: "" });
    const playback = await promised(runtime, Playback);
    const rejections: unknown[] = [];
    const note = (reason: unknown) => void rejections.push(reason);
    process.on("unhandledRejection", note);
    try {
      // Node's parser takes these targets; none of them is an address.
      const malformed = ["http://[", "//[", "http://%"];
      const local = await playback.open({ subscriptionId, id: "Alpha.test" }, RECEIVER);
      const here = await Promise.all(malformed.map((target) => raw(new URL(local.url), target)));
      const playing = (await playlist(local.url)).status;

      const opened = await playback.openReceiver(
        { subscriptionId, id: "Alpha.test" },
        { address: "127.0.0.1", decoders: RECEIVER },
      );
      const lan = await Promise.all(malformed.map((target) => raw(new URL(opened.url), target)));
      const stream = await playlist(opened.url);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect({ here, lan, rejections }).toEqual({
        here: malformed.map(() => "HTTP/1.1 400 Bad Request"),
        lan: malformed.map(() => "HTTP/1.1 400 Bad Request"),
        rejections: [],
      });
      expect(playing).toBe(200);
      expect(stream.status).toBe(200);
      expect((await fetch(stream.segments[0]!.url)).status).toBe(200);

      await playback.close(opened.sessionId);
      await expect(fetch(opened.url)).rejects.toThrow();
    } finally {
      process.off("unhandledRejection", note);
    }
  });
});

/** The status line answering a GET of `target` exactly as written, sent to `url`'s server. */
async function raw(url: URL, target: string): Promise<string> {
  const socket = connect(Number(url.port), url.hostname);
  socket.write(`GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`);
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (part: string) => (text += part));
  // A request nobody answers holds the connection: give up on it.
  socket.setTimeout(2_000, () => socket.destroy());
  await new Promise((closed) => socket.once("close", closed));
  return text.split("\r\n")[0] ?? "";
}
