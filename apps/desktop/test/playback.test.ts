import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { Codec } from "@mrstreamer/contracts/playback";
import * as Layer from "effect/Layer";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { captionDecoder } from "@mrstreamer/core/subtitles/captions";
import { pesReader } from "@mrstreamer/core/subtitles/transport";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import { fixture, type FakeProvider } from "./fake-provider.ts";
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

/** What Chromium on Linux decodes: no HEVC, no AC-3, no MP2. */
const LINUX: readonly Codec[] = ["h264", "aac", "mp3", "opus"];
/** What Chromium on an Apple silicon Mac decodes. */
const MAC: readonly Codec[] = ["h264", "hevc", "hevc-10bit", "aac", "mp3", "opus"];

// CI points this at the bundled build; locally the ffmpeg on PATH will do.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasFfmpeg = spawnSync(FFMPEG, ["-version"]).status === 0;

/**
 * Playback on a connected fake provider that allows one connection and frees it as soon as a
 * stream closes, unless `slotReleaseMs` says otherwise. `open` takes a channel of the connected
 * subscription by the provider's id; `service` is playback itself, and `tracksChanged` the
 * session ids it said that of so far. `dispose` ends it, as quitting the app does.
 */
async function connectedPlayback(options: { slotReleaseMs?: number; ffmpeg?: boolean } = {}) {
  const provider = await fakeProvider({
    maxConnections: 1,
    slotReleaseMs: options.slotReleaseMs ?? 0,
  });
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: options.ffmpeg ? FFMPEG : null }).pipe(
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
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  const service = await promised(runtime, Playback);
  const tracksChanged = await collect(runtime, service.tracksChanged);
  const playback = {
    ...service,
    open: (
      channelId: string,
      decoders: Parameters<typeof service.open>[1],
      options?: Parameters<typeof service.open>[2],
    ) => service.open({ subscriptionId, id: channelId }, decoders, options),
    dispose: () => runtime.dispose(),
  };
  return { provider, playback, service, subscriptionId, tracksChanged };
}

/** Ids of channels that stream without end. */
function liveChannels(provider: FakeProvider): string[] {
  return provider.catalogue.channels
    .filter((channel) => !channel.offline && !channel.fixture)
    .map((channel) => String(channel.streamId));
}

function channelNamed(provider: FakeProvider, name: string): string {
  const channel = provider.catalogue.channels.find((entry) => entry.name === name);
  if (!channel) throw new Error(`No channel ${name}`);
  return String(channel.streamId);
}

/**
 * Reads the first bytes of a stream, then leaves the response open like a player would. Hold a
 * stream open through here: Node cancels a response whose body was never read once it is garbage
 * collected, which would free the provider's connection mid-test.
 */
async function firstBytes(
  url: string,
): Promise<{ status: number; bytes: number; stop: () => void }> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  if (!response.ok || !response.body)
    return { status: response.status, bytes: 0, stop: () => controller.abort() };
  const { value } = await response.body.getReader().read();
  return { status: response.status, bytes: value?.length ?? 0, stop: () => controller.abort() };
}

/** The codecs ffprobe finds in what the player receives. */
async function playerReceives(
  url: string,
): Promise<{ video: string | null; audio: string | null }> {
  return playerReceivesBytes(Buffer.from(await (await fetch(url)).arrayBuffer()));
}

/** The streams ffprobe finds, in program table order, with their PIDs and languages. */
function streamIds(body: Buffer): { type: string; id: number; language?: string }[] {
  const probe = spawnSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,id:stream_tags=language",
      "-of",
      "json",
      "-i",
      "pipe:0",
    ],
    { input: body, encoding: "utf8" },
  );
  return (
    JSON.parse(probe.stdout) as {
      streams: { codec_type: string; id: string; tags?: { language?: string } }[];
    }
  ).streams.map((stream) => ({
    type: stream.codec_type,
    id: Number(stream.id),
    ...(stream.tags?.language ? { language: stream.tags.language } : {}),
  }));
}

function playerReceivesBytes(body: Buffer): { video: string | null; audio: string | null } {
  const probe = spawnSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "stream=codec_type,codec_name", "-of", "json", "-i", "pipe:0"],
    { input: body, encoding: "utf8" },
  );
  const streams = (
    JSON.parse(probe.stdout) as { streams: { codec_type: string; codec_name: string }[] }
  ).streams;
  return {
    video: streams.find((stream) => stream.codec_type === "video")?.codec_name ?? null,
    audio: streams.find((stream) => stream.codec_type === "audio")?.codec_name ?? null,
  };
}

describe("playback", () => {
  it("streams a channel through a local URL without the login in it", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(liveChannels(provider)[0] ?? "", LINUX);
    const stream = await firstBytes(session.url);

    expect(session.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/stream\//);
    expect(session.url).not.toContain("demo");
    expect(stream).toMatchObject({ status: 200 });
    expect(stream.bytes).toBeGreaterThan(0);
    stream.stop();
    await playback.dispose();
  });

  it("opens a channel for the subscription it names, and closes nothing for another's", async () => {
    const { provider, playback, service, subscriptionId } = await connectedPlayback();
    const [one = "", two = ""] = liveChannels(provider);
    const playing = await playback.open(one, LINUX);
    const stream = await firstBytes(playing.url);
    const requests = provider.streamRequests();

    // The same provider id, as a subscription that went, or another's lists, could name it.
    await expect(
      service.open({ subscriptionId: "another-subscription", id: two }, LINUX),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });

    // What plays is the subscription's own, and plays on: nothing reached the provider.
    expect(playing.channel).toEqual({ subscriptionId, id: one });
    expect(provider.activeStreams()).toBe(1);
    expect(provider.streamRequests()).toBe(requests);
    expect(await playback.failure(playing.sessionId)).toBeNull();
    stream.stop();
    await playback.dispose();
  });

  it("releases the previous stream when switching on a one-connection subscription", async () => {
    const { provider, playback } = await connectedPlayback({ slotReleaseMs: 300 });
    const [one = "", two = ""] = liveChannels(provider);

    const first = await playback.open(one, LINUX);
    const firstStream = await firstBytes(first.url);
    expect(provider.activeStreams()).toBe(1);

    const second = await playback.open(two, LINUX);
    const secondStream = await firstBytes(second.url);

    expect(secondStream.status).toBe(200);
    expect(provider.activeStreams()).toBe(1);
    expect((await fetch(first.url)).status).toBe(410);
    firstStream.stop();
    secondStream.stop();
    await playback.dispose();
  });

  it("releases the provider connection when the app quits", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(liveChannels(provider)[0] ?? "", LINUX);
    const stream = await firstBytes(session.url);
    expect(provider.activeStreams()).toBe(1);

    await playback.dispose();

    await vi.waitFor(() => expect(provider.activeStreams()).toBe(0));
    stream.stop();
  });

  it("explains a channel that is off air", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(channelNamed(provider, "TEST | Offline"), LINUX);
    const stream = await firstBytes(session.url);

    expect(stream.status).toBe(404);
    expect(await playback.failure(session.sessionId)).toEqual({ kind: "unavailable", status: 404 });
    await playback.dispose();
  });

  describe("a channel with several streams", () => {
    it("plays the next stream when the provider has none for the first", async () => {
      const { provider, playback } = await connectedPlayback();
      const offline = channelNamed(provider, "TEST | Offline");
      const [working = ""] = liveChannels(provider);

      const session = await playback.open(offline, LINUX, { variants: [offline, working] });
      const stream = await firstBytes(session.url);

      expect(stream.status).toBe(200);
      expect(await playback.playing(session.sessionId)).toEqual({
        variantId: working,
        failed: [{ variantId: offline, failure: { kind: "unavailable", status: 404 } }],
      });
      // One request each, the second after the first was answered: the subscription allows one.
      expect(provider.streamRequests()).toBe(2);
      stream.stop();
      await playback.dispose();
    });

    it("tries a chosen stream alone, and says why it failed", async () => {
      const { provider, playback } = await connectedPlayback();
      const offline = channelNamed(provider, "TEST | Offline");

      const session = await playback.open(offline, LINUX, { variants: [offline] });
      const stream = await firstBytes(session.url);

      expect(stream.status).toBe(404);
      expect(await playback.failure(session.sessionId)).toEqual({
        kind: "unavailable",
        status: 404,
      });
      expect(await playback.playing(session.sessionId)).toMatchObject({ variantId: null });
      expect(provider.streamRequests()).toBe(1);
      await playback.dispose();
    });

    it("reports a refusal when the connection limit stays in use, and tries no other stream, which would refuse it too", async () => {
      const { provider, playback } = await connectedPlayback();
      const [one = "", two = "", three = ""] = liveChannels(provider);
      // Someone else is watching on the only connection.
      const elsewhere = await firstBytes(`${provider.url}/live/demo/demo/${three}.ts`);
      expect(elsewhere.status).toBe(200);
      const before = provider.streamRequests();

      const session = await playback.open(one, LINUX, { variants: [one, two] });
      const stream = await firstBytes(session.url);

      expect(stream.status).toBe(403);
      expect(await playback.failure(session.sessionId)).toEqual({ kind: "refused", status: 403 });
      expect(await playback.playing(session.sessionId)).toEqual({
        variantId: null,
        failed: [{ variantId: one, failure: { kind: "refused", status: 403 } }],
      });
      // The first try and its two retries, all for the first stream.
      expect(provider.streamRequests() - before).toBe(3);
      elsewhere.stop();
      await playback.dispose();
    });

    it("tries a stream that just failed last, so reconnecting doesn't wait for it", async () => {
      const { provider, playback } = await connectedPlayback();
      const offline = channelNamed(provider, "TEST | Offline");
      const [working = ""] = liveChannels(provider);
      const first = await playback.open(offline, LINUX, { variants: [offline, working] });
      (await firstBytes(first.url)).stop();

      const again = await playback.open(offline, LINUX, { variants: [offline, working] });
      const stream = await firstBytes(again.url);

      expect(await playback.playing(again.sessionId)).toEqual({ variantId: working, failed: [] });
      stream.stop();
      await playback.dispose();
    });
  });

  it("passes a stream the player decodes through unchanged", async () => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(channelNamed(provider, "TEST | H.264 + AAC"), LINUX);
    const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());

    expect(received.equals(fixture("h264-aac.mpegts"))).toBe(true);
    await playback.dispose();
  });

  it("lists a channel's sound tracks and subtitle pages once its stream starts", async () => {
    const { provider, playback } = await connectedPlayback();
    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
    );
    expect(await playback.tracks(session.sessionId)).toBeNull();

    await fetch(session.url).then((response) => response.arrayBuffer());

    expect(await playback.tracks(session.sessionId)).toEqual({
      audio: [
        { id: 0x101, language: "en", label: "English", default: true },
        { id: 0x102, language: "nl", label: "Nederlands", default: false },
      ],
      subtitles: [
        expect.objectContaining({
          id: 0x103,
          page: 1,
          format: "picture",
          label: "Nederlands · Picture",
        }),
        expect.objectContaining({
          id: 0x300,
          page: 888,
          format: "teletext",
          label: "Nederlands · Teletext",
        }),
        // Found in the pictures as they passed.
        expect.objectContaining({ id: 0x1ff0, page: 1, format: "captions", label: "Captions" }),
      ],
      playing: 0x101,
    });
    await playback.dispose();
  });

  it("says a channel's tracks changed once captions turn up in its pictures", async () => {
    const { provider, playback, tracksChanged } = await connectedPlayback();
    // A channel without captions says nothing.
    const plain = await playback.open(channelNamed(provider, "TEST | H.264 + AAC"), LINUX);
    await fetch(plain.url).then((response) => response.arrayBuffer());
    expect(tracksChanged).toEqual([]);

    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
    );
    await fetch(session.url).then((response) => response.arrayBuffer());

    await vi.waitFor(() => expect(tracksChanged).toEqual([session.sessionId]));
    expect((await playback.tracks(session.sessionId))?.subtitles.at(-1)).toMatchObject({
      format: "captions",
      page: 1,
    });
    await playback.dispose();
  });

  it("copies captions out of the pictures into a stream the player reads, in display order", async () => {
    const { provider, playback } = await connectedPlayback();
    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
    );

    const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());

    const reader = pesReader();
    const decoder = captionDecoder(1);
    const changes = [...reader.push(received), ...reader.end()].flatMap((packet) =>
      packet.pid === 0x1ff0 && packet.pts !== null
        ? (decoder.push(packet.payload, packet.pts / 90_000) ?? [])
        : [],
    );
    expect(
      changes.map((change) => [
        Math.round(change.at * 100) / 100,
        change.screen.kind === "text" ? change.screen.lines : null,
      ]),
    ).toEqual([
      [2.32, ["HELLO CAPTIONS"]],
      [4.4, []],
    ]);
    await playback.dispose();
  });

  it.each([
    ["chosen sound track", { audio: 0x102 }],
    ["sound track in the remembered language", { audioLanguage: "nl" }],
  ])("plays the %s, keeping the rest of the stream", async (_, choice) => {
    const { provider, playback } = await connectedPlayback();

    const session = await playback.open(
      channelNamed(provider, "TEST | Subtitles and two sound tracks"),
      LINUX,
      choice,
    );
    const received = streamIds(Buffer.from(await (await fetch(session.url)).arrayBuffer()));

    // The player plays the first sound track the program table lists, which the tracks name.
    expect(received.filter((stream) => stream.type === "audio").map((stream) => stream.id)).toEqual(
      [0x102, 0x101],
    );
    expect(await playback.tracks(session.sessionId)).toMatchObject({ playing: 0x102 });
    expect(received.map((stream) => stream.id)).toContain(0x300);
    await playback.dispose();
  });

  it("names the formats of a stream it cannot convert", async () => {
    const { provider, playback } = await connectedPlayback({ ffmpeg: false });

    const session = await playback.open(channelNamed(provider, "TEST | H.264 + MP2"), LINUX);
    const response = await fetch(session.url);

    expect(response.status).toBe(415);
    expect(await playback.failure(session.sessionId)).toEqual({
      kind: "unsupported",
      detail: "This stream carries h264 video and mp2 sound.",
      diagnostic: {
        diagnostic_stage: "convert",
        diagnostic_reason: "tool_missing",
        diagnostic_container: "mpegts",
        diagnostic_delivery: "converted",
        diagnostic_video_codec: "h264",
        diagnostic_audio_codec: "mpeg_audio",
        diagnostic_fallback: "none",
      },
    });
    await playback.dispose();
  });

  // Converting video in software takes seconds, more so while other tests run.
  describe.skipIf(!hasFfmpeg)("with ffmpeg", { timeout: 30_000 }, () => {
    it("re-encodes a damaged picture when asked to repair a stream", async () => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });
      const decodeErrors = (stream: Buffer) =>
        spawnSync(
          FFPROBE,
          [
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-count_frames",
            "-show_entries",
            "stream=nb_read_frames",
            "-of",
            "json",
            "pipe:0",
          ],
          {
            input: stream,
            encoding: "utf8",
          },
        ).stderr.trim();
      const channel = channelNamed(provider, "TEST | H.264 damaged");

      const direct = await playback.open(channel, LINUX);
      expect(decodeErrors(Buffer.from(await (await fetch(direct.url)).arrayBuffer()))).not.toBe("");
      const repaired = await playback.open(channel, LINUX, { repair: true });
      const received = Buffer.from(await (await fetch(repaired.url)).arrayBuffer());

      expect(decodeErrors(received)).toBe("");
      expect(playerReceivesBytes(received)).toEqual({ video: "h264", audio: "aac" });
      await playback.dispose();
    });

    it("starts a stream joined mid-sequence on its first decodable picture", async () => {
      const { provider, playback } = await connectedPlayback();

      const session = await playback.open(
        channelNamed(provider, "TEST | H.264 joined mid-stream"),
        LINUX,
      );
      const received = Buffer.from(await (await fetch(session.url)).arrayBuffer());
      const probe = spawnSync(
        FFPROBE,
        [
          "-select_streams",
          "v",
          "-show_entries",
          "frame=key_frame",
          "-of",
          "csv=p=0",
          "-i",
          "pipe:0",
        ],
        { input: received, encoding: "utf8" },
      );

      expect(probe.stdout.trim().split("\n")[0]).toBe("1");
      expect(probe.stderr).not.toMatch(/non-existing|decode_slice_header error|reference/i);
      await playback.dispose();
    });

    it("converts the chosen sound track and keeps the subtitles where the player finds them", async () => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });

      // A player without AAC: the sound converts.
      const session = await playback.open(
        channelNamed(provider, "TEST | Subtitles and two sound tracks"),
        ["h264", "mp3"],
        { audio: 0x102 },
      );
      const received = streamIds(Buffer.from(await (await fetch(session.url)).arrayBuffer()));

      expect(received.filter((stream) => stream.type === "audio")).toEqual([
        { type: "audio", id: expect.any(Number), language: "dut" },
      ]);
      expect(
        received.filter((stream) => stream.type === "subtitle").map((stream) => stream.id),
      ).toEqual([0x103, 0x300]);
      await playback.dispose();
    });

    it.each([
      ["TEST | H.264 + MP2", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + AC-3", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + AC-3 DVB", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + E-AC-3", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | H.264 + MP3", LINUX, { video: "h264", audio: "mp3" }],
      ["TEST | MPEG-2 + MP2", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | HEVC + AAC", LINUX, { video: "h264", audio: "aac" }],
      ["TEST | HEVC + AAC", MAC, { video: "hevc", audio: "aac" }],
      ["TEST | HEVC 10-bit + AAC", MAC, { video: "hevc", audio: "aac" }],
      ["TEST | HEVC 10-bit + AAC", ["h264", "hevc", "aac"], { video: "h264", audio: "aac" }],
    ] as const)("delivers %s to a player with %j as %j", async (name, decoders, expected) => {
      const { provider, playback } = await connectedPlayback({ ffmpeg: true });

      const session = await playback.open(channelNamed(provider, name), decoders);

      expect(await playerReceives(session.url)).toEqual(expected);
      await playback.dispose();
    });
  });
});

describe("one stream across several subscriptions", () => {
  /**
   * Playback on two subscriptions with one connection each, whose providers list other channels
   * under the same ids. `a` and `b` name a channel of each by that id.
   */
  async function two() {
    const [first, second] = [
      await fakeProvider({ maxConnections: 1, slotReleaseMs: 0 }),
      await fakeProvider({ maxConnections: 1, slotReleaseMs: 0, channels: 200 }),
    ];
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
    const subscriptions = await promised(runtime, Subscriptions);
    const login = (provider: FakeProvider) => ({
      server: provider.url,
      username: "demo",
      password: "demo",
    });
    const [id = ""] = liveChannels(second);
    const a = { subscriptionId: (await subscriptions.add(login(first))).id, id };
    const b = { subscriptionId: (await subscriptions.add(login(second))).id, id };
    return { first, second, subscriptions, playback: await promised(runtime, Playback), a, b };
  }

  it("closes what plays from one before the other's opens, so no provider sees a second connection", async () => {
    const { first, second, playback, a, b } = await two();

    const one = await playback.open(a, LINUX);
    const playing = await firstBytes(one.url);
    expect([first.activeStreams(), second.activeStreams()]).toEqual([1, 0]);

    // The same id is another channel there, at another provider.
    const other = await playback.open(b, LINUX);
    await vi.waitFor(() => expect(first.activeStreams()).toBe(0));
    const next = await firstBytes(other.url);

    expect(other.channel).toEqual(b);
    expect([first.activeStreams(), second.activeStreams()]).toEqual([0, 1]);
    expect((await fetch(one.url)).status).toBe(410);
    expect([first.streamRequests(), second.streamRequests()]).toEqual([1, 1]);
    playing.stop();
    next.stop();
  });

  it("opens nothing for what the viewer has moved on from, and leaves what plays", async () => {
    const { first, second, playback, a, b } = await two();
    const session = await playback.open(a, LINUX, { turn: await playback.begin() });
    const playing = await firstBytes(session.url);
    const asked = await playback.begin();
    // Something else was asked for before this one got its turn.
    const later = await playback.begin();

    await expect(playback.open(b, LINUX, { turn: asked })).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    });

    expect(await playback.passed(asked)).toBe(true);
    expect([first.activeStreams(), second.streamRequests()]).toEqual([1, 0]);
    const next = await playback.open(b, LINUX, { turn: later });
    expect(next.channel).toEqual(b);
    playing.stop();
  });

  it("opens no channel once the viewer asked for something else while its streams were looked up", async () => {
    const host = await startFakePlaylist();
    const holdable = holdableFetch();
    const dataDir = await tempDir();
    const start = async () => {
      const runtime = runtimeFor(
        Playback.layer({ userAgent, ffmpeg: null }).pipe(
          Layer.provide(PlaybackCoordination.layer),
          Layer.provideMerge(
            Subscriptions.layer({
              dataDir,
              secrets: testSecrets,
              providerOptions: { userAgent, fetch: holdable.fetch },
            }),
          ),
        ),
      );
      return {
        subscriptions: await promised(runtime, Subscriptions),
        playback: await promised(runtime, Playback),
      };
    };
    const { id: subscriptionId } = await (
      await start()
    ).subscriptions.add({ server: host.link, username: "", password: "" });
    // Started again, a playlist is read anew for the address of the channel asked for.
    const { playback } = await start();
    const channel = { subscriptionId, id: PLAYLIST_CHANNELS.plain.id };
    const turn = await playback.begin();

    const held = holdable.holdNext();
    const opening = playback.open(channel, LINUX, { turn });
    await held.arrived;
    const later = await playback.begin();
    held.release();

    await expect(opening).rejects.toMatchObject({
      error: { kind: "unexpected", detail: "Something else played in the meantime." },
    });
    expect((await playback.open(channel, LINUX, { turn: later })).channel).toEqual(channel);
    await host.close();
  });

  it("closes the stream of a subscription that goes, and no other's", async () => {
    const { first, playback, a, b } = await two();
    const session = await playback.open(a, LINUX);
    const playing = await firstBytes(session.url);

    await playback.closeOf(b.subscriptionId);
    expect(first.activeStreams()).toBe(1);
    expect(await playback.playing(session.sessionId)).not.toBeNull();

    await playback.closeOf(a.subscriptionId);
    await vi.waitFor(() => expect(first.activeStreams()).toBe(0));
    expect((await fetch(session.url)).status).toBe(410);
    playing.stop();
  });

  it("opens no file from an address made under a login that changed since, and closes nothing for it", async () => {
    const { first, second, subscriptions, playback, a, b } = await two();
    const [source] = await subscriptions.sources();
    const movie = first.titles.movies[0];
    if (!source || !movie) throw new Error("The first subscription has a source and a movie");
    const title = {
      kind: "movie",
      subscriptionId: a.subscriptionId,
      id: String(movie.id),
    } as const;
    const address = (await source.provider.titleFile("movie", title.id, movie.container)).url;
    const session = await playback.open(b, LINUX);
    const playing = await firstBytes(session.url);

    // The password entered again while the title's address was being worked out.
    await subscriptions.update(a.subscriptionId, { secret: "demo" });

    await expect(
      playback.openTitle(title, address, LINUX, { revision: source.revision }),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(first.fileRequests()).toBe(0);
    expect(second.activeStreams()).toBe(1);
    playing.stop();
  });

  it("plays nothing of a subscription whose secret the keychain lost, and says which", async () => {
    const dataDir = await tempDir();
    const provider = await fakeProvider();
    const start = async (open: (sealed: string) => string) => {
      const runtime = runtimeFor(
        Playback.layer({ userAgent, ffmpeg: null }).pipe(
          Layer.provide(PlaybackCoordination.layer),
          Layer.provideMerge(
            Subscriptions.layer({
              dataDir,
              secrets: { seal: testSecrets.seal, open },
              providerOptions: { userAgent },
            }),
          ),
        ),
      );
      return {
        subscriptions: await promised(runtime, Subscriptions),
        playback: await promised(runtime, Playback),
      };
    };
    const { id: subscriptionId } = await (
      await start(testSecrets.open)
    ).subscriptions.add({ server: provider.url, username: "demo", password: "demo" });

    const locked = await start(() => {
      throw new Error("The keychain opens nothing.");
    });

    await expect(
      locked.playback.open({ subscriptionId, id: liveChannels(provider)[0] ?? "" }, LINUX),
    ).rejects.toMatchObject({ error: { kind: "needs-secret", subscriptionId } });
    expect(provider.streamRequests()).toBe(0);
  });
});
