// Catch-up: which channels a provider keeps programmes of after they aired, and what reaches the
// provider when one plays from its archive, for an Xtream panel and for the conventions playlists
// describe it in.
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Codec } from "@mrstreamer/contracts/playback";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { archiveVariants } from "@mrstreamer/core/catchup";
import { playlistProvider } from "../src/main/providers/m3u.ts";
import { Library } from "../src/main/services/library.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import { fixture, type FakeProviderOptions } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

const LINUX: readonly Codec[] = ["h264", "aac", "mp3", "opus"];
const MINUTE = 60 * 1000;
/** 18:00 UTC on 13 October 2026: 20:00 in Amsterdam, on summer time. */
const EVENING = Date.UTC(2026, 9, 13, 18, 0);
/** 18:00 UTC on 1 December 2026: 19:00 in Amsterdam, on winter time. */
const WINTER = Date.UTC(2026, 11, 1, 18, 0);

afterEach(() => {
  vi.useRealTimers();
});

/** Playback and the library on a fake Xtream panel, with its subscription connected. */
async function connected(options: FakeProviderOptions = {}) {
  const provider = await fakeProvider(options);
  const dataDir = await tempDir();
  const runtime = runtimeFor(
    Layer.mergeAll(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(Layer.provide(PlaybackCoordination.layer)),
      Library.layer({ confirmDelay: 0 }),
    ).pipe(
      Layer.provideMerge(Settings.layer(dataDir)),
      Layer.provideMerge(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  return {
    provider,
    library: await promised(runtime, Library),
    playback: await promised(runtime, Playback),
    own: (id: string) => ({ subscriptionId, id }),
    dispose: () => runtime.dispose(),
  };
}

/** Everything the player receives from a session's address, once the stream ends. */
async function whole(url: string): Promise<Buffer> {
  return Buffer.from(await (await fetch(url)).arrayBuffer());
}

describe("an Xtream panel's catch-up", () => {
  it("lists how many days the panel keeps of each channel, and none where it keeps none", async () => {
    const { library, own, dispose } = await connected();
    // "TEST | H.264 + AAC", "TEST | H.264 + MP2" and "TEST | HEVC + AAC".
    const [aac, mp2, hevc] = await Promise.all(
      ["1000", "1001", "1006"].map((id) => library.channel(own(id))),
    );
    expect(aac).toMatchObject({ catchupDays: 3, variants: [{ id: "1000", catchupDays: 3 }] });
    expect(mp2?.catchupDays).toBeNull();
    expect(mp2?.variants[0]).not.toHaveProperty("catchupDays");
    expect(hevc?.catchupDays).toBe(2);
    await dispose();
  });

  it("plays a programme from its timeshift address on the panel's clock, to its end", async () => {
    // Two connections, so the second recording isn't refused while the first one's is let go of.
    const { provider, playback, own, dispose } = await connected({ maxConnections: 2 });

    const summer = await playback.open(own("1000"), LINUX, {
      variants: ["1000"],
      archive: { start: EVENING, end: EVENING + 30 * MINUTE },
    });
    expect(summer.url).not.toContain("demo");
    // The recording arrives whole, and the stream ends with it.
    expect((await whole(summer.url)).length).toBeGreaterThan(fixture("h264-aac.mpegts").length / 2);

    const winter = await playback.open(own("1000"), LINUX, {
      variants: ["1000"],
      archive: { start: WINTER, end: WINTER + 90 * MINUTE },
    });
    await whole(winter.url);

    expect(provider.archiveRequests()).toEqual([
      { streamId: "1000", minutes: 30, start: "2026-10-13:20-00" },
      { streamId: "1000", minutes: 90, start: "2026-12-01:19-00" },
    ]);
    // Nothing of the channel live was asked for.
    expect(provider.streamRequests()).toBe(0);
    await dispose();
  });

  it("passes a recording the panel sends at once on no faster than it plays, after a lead", async () => {
    // Forty seconds of recording, which the panel sends in one go.
    const recording = fixture("recording-long-subtitles.mpegts");
    const { playback, own, dispose } = await connected({
      channelOf: (channel) =>
        channel.streamId === 1000
          ? { ...channel, fixture: "recording-long-subtitles.mpegts" }
          : channel,
    });
    const session = await playback.open(own("1000"), LINUX, {
      variants: ["1000"],
      archive: { start: EVENING, end: EVENING + 30 * MINUTE },
    });
    const reader = (await fetch(session.url)).body!.getReader();
    let received = 0;
    let ended = false;
    const reading = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return void (ended = true);
        received += value.length;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    // The first thirty seconds or so, and the rest held back until they are due.
    expect(received).toBeGreaterThan(recording.length / 2);
    expect(received).toBeLessThan(recording.length * 0.9);
    expect(ended).toBe(false);
    await reader.cancel();
    await reading.catch(() => {});
    await dispose();
  });

  it("says where each recording starts, on the minute the panel counts from", async () => {
    const { provider, playback, own, dispose } = await connected({
      timeZone: null,
      // One for each, so none is refused while the one before is let go of.
      maxConnections: 3,
    });
    const end = EVENING + 30 * MINUTE;
    const open = async (start: number, until = end) => {
      const session = await playback.open(own("1000"), LINUX, {
        variants: ["1000"],
        archive: { start, end: until },
      });
      await whole(session.url);
      return session.archive;
    };
    // A programme on the minute starts there; resuming 45.5 s in starts on that minute again,
    // and says so, as does a programme half a minute past, whose end is in it too.
    expect(await open(EVENING)).toEqual({ start: EVENING, end });
    expect(await open(EVENING + 45_500)).toEqual({ start: EVENING, end });
    expect(await open(EVENING + 30_000, end + 30_000)).toEqual({
      start: EVENING,
      end: end + 30_000,
    });
    // Times in UTC, as the panel names no time zone.
    expect(provider.archiveRequests()).toEqual([
      { streamId: "1000", minutes: 30, start: "2026-10-13:18-00" },
      { streamId: "1000", minutes: 30, start: "2026-10-13:18-00" },
      { streamId: "1000", minutes: 31, start: "2026-10-13:18-00" },
    ]);
    await dispose();
  });

  it("ends a recording at the window's end though the provider sends on, and lets go of it", async () => {
    // Forty seconds of recording, then nothing, the connection held open: as an archive whose
    // address names no end plays on into what came after.
    const recording = fixture("recording-long-subtitles.mpegts");
    let open = 0;
    const server = createServer((request, response) => {
      if (request.url?.startsWith("/list.m3u")) {
        return response.end(
          [
            "#EXTM3U",
            '#EXTINF:-1 tvg-id="fs" catchup="flussonic" catchup-days="2",Flussonic',
            `http://127.0.0.1:${(server.address() as AddressInfo).port}/fs/mpegts`,
            "",
          ].join("\n"),
        );
      }
      open++;
      request.on("close", () => open--);
      response.writeHead(200, { "Content-Type": "video/mp2t" });
      response.write(recording);
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const dataDir = await tempDir();
    const runtime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(
        Layer.provide(PlaybackCoordination.layer),
        Layer.provideMerge(
          Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
        ),
      ),
    );
    const subscriptions = await promised(runtime, Subscriptions);
    const playback = await promised(runtime, Playback);
    const { id: subscriptionId } = await subscriptions.add({
      server: `http://127.0.0.1:${(server.address() as AddressInfo).port}/list.m3u`,
      username: "",
      password: "",
    });
    // Ten seconds of programme.
    const session = await playback.open({ subscriptionId, id: "fs" }, LINUX, {
      archive: { start: EVENING, end: EVENING + 10_000 },
    });
    expect(session.archive).toEqual({ start: EVENING, end: EVENING + 10_000 });
    const received = await whole(session.url);
    expect(received.length).toBeGreaterThan(recording.length * 0.15);
    expect(received.length).toBeLessThan(recording.length * 0.5);
    await vi.waitFor(() => expect(open).toBe(0));
    await runtime.dispose();
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });
});

describe("a playlist's catch-up", () => {
  /** The moment the recordings are asked for: an hour after the window starts. */
  const NOW = EVENING + 60 * MINUTE;
  const WINDOW = { start: EVENING, end: EVENING + 45 * MINUTE };
  const S = EVENING / 1000;
  const E = S + 45 * 60;
  const N = NOW / 1000;

  const LIST = [
    '#EXTM3U catchup="shift" catchup-days="1"',
    '#EXTINF:-1 tvg-id="inherited",Inherited',
    "https://iptv.test/inherited/index.m3u8?token=t",
    '#EXTINF:-1 tvg-id="append" catchup="append" catchup-days="3" catchup-source="&utc={utc}&lutc={lutc}",Append',
    "https://iptv.test/append/index.m3u8?token=t",
    '#EXTINF:-1 tvg-id="dollar" catch-up="default" tvg-rec="5" catchup-source="https://archive.test/dollar?start=${start}&end=${end}&duration=${duration}&now=${now}&timestamp=${timestamp}&offset=${offset}",Dollar',
    "https://iptv.test/dollar/index.m3u8",
    '#EXTINF:-1 tvg-id="braces" catchup-type="default" timeshift="7" catchup-source="https://archive.test/{Y}/{m}/{d}/{H}-{M}-{S}/{utc}-{utcend}-{lutc}/{duration}-{duration:60}-{offset}-{offset:60}.ts",Braces',
    "https://iptv.test/braces.ts",
    '#EXTINF:-1 tvg-id="fs-ts" catchup="flussonic" catchup-days="2",Flussonic MPEG-TS',
    "https://iptv.test/fs/mpegts?token=t",
    '#EXTINF:-1 tvg-id="fs-hls" catchup="fs" catchup-days="2",Flussonic HLS',
    "https://iptv.test/fs/video.m3u8?token=t",
    '#EXTINF:-1 tvg-id="xc" catchup="xc" catchup-days="4",Xtream',
    "https://iptv.test/live/user/pass/42.ts",
    "",
  ].join("\n");

  const NONE = [
    "#EXTM3U",
    '#EXTINF:-1 tvg-id="plain",Plain',
    "https://iptv.test/plain.ts",
    '#EXTINF:-1 tvg-id="no-days" catchup="shift",A mode without days',
    "https://iptv.test/no-days.ts",
    '#EXTINF:-1 tvg-id="no-mode" tvg-rec="3",Days without a mode',
    "https://iptv.test/no-mode.ts",
    '#EXTINF:-1 tvg-id="vod" catchup="vod" catchup-days="3",VOD',
    "https://iptv.test/vod.ts",
    '#EXTINF:-1 tvg-id="no-source" catchup="append" catchup-days="3",Append without a source',
    "https://iptv.test/no-source.ts",
    '#EXTINF:-1 tvg-id="not-xc" catchup="xc" catchup-days="3",Not an Xtream address',
    "https://iptv.test/channel/index.m3u8",
    '#EXTINF:-1 tvg-id="coarse" catchup="default" catchup-days="3" catchup-source="https://archive.test/{offset:60}.ts",Minutes before now only',
    "https://iptv.test/coarse.ts",
    '#EXTINF:-1 tvg-id="seconds" catchup="default" catchup-days="3" catchup-source="https://archive.test/{offset}.ts",Seconds before now only',
    "https://iptv.test/seconds.ts",
    '#EXTINF:-1 tvg-id="dollar-offset" catchup="append" catchup-days="3" catchup-source="?ago=${offset}",Seconds before now, appended',
    "https://iptv.test/dollar-offset.ts",
    '#EXTINF:-1 tvg-id="year" catchup="default" catchup-days="3" catchup-source="https://archive.test/{Y}/{offset:60}.ts",A year and minutes before now',
    "https://iptv.test/year.ts",
    '#EXTINF:-1 tvg-id="day" catchup="default" catchup-days="3" catchup-source="https://archive.test/{Y}{m}{d}.ts",A day alone',
    "https://iptv.test/day.ts",
    "",
  ].join("\n");

  /** A playlist provider for `body`, and every address it then requested beyond the playlist. */
  function provider(body: string) {
    const asked: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === "https://iptv.test/list.m3u") return new Response(body);
      asked.push(url);
      return new Response("");
    };
    return {
      asked,
      provider: playlistProvider(
        { link: "https://iptv.test/list.m3u" },
        { userAgent, fetch: fetchImpl },
      ),
    };
  }

  it("reads the days from each convention, inherited from the first line too", async () => {
    const { provider: list } = provider(LIST);
    const { channels } = await list.liveCatalogue();
    expect(Object.fromEntries(channels.map((each) => [each.id, each.catchupDays]))).toEqual({
      inherited: 1,
      append: 3,
      dollar: 5,
      braces: 7,
      "fs-ts": 2,
      "fs-hls": 2,
      xc: 4,
    });
  });

  it("asks for each recording at the address its convention makes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { provider: list, asked } = provider(LIST);
    await list.liveCatalogue();
    const formats: Record<string, string> = {};
    for (const id of ["inherited", "append", "dollar", "braces", "fs-ts", "fs-hls", "xc"]) {
      const stream = await list.archiveStream(id, WINDOW);
      formats[id] = stream.format;
      await list.request(stream.url);
    }
    expect(asked).toEqual([
      `https://iptv.test/inherited/index.m3u8?token=t&utc=${S}&lutc=${N}`,
      `https://iptv.test/append/index.m3u8?token=t&utc=${S}&lutc=${N}`,
      `https://archive.test/dollar?start=${S}&end=${E}&duration=2700&now=${N}&timestamp=${N}&offset=3600`,
      `https://archive.test/2026/10/13/18-00-00/${S}-${E}-${N}/2700-45-3600-60.ts`,
      `https://iptv.test/fs/timeshift_abs-${S}.ts?token=t`,
      `https://iptv.test/fs/video-${S}-2700.m3u8?token=t`,
      "https://iptv.test/timeshift/user/pass/45/2026-10-13:18-00/42.ts",
    ]);
    // As the recording's own address says, whatever the channel's live stream is.
    expect(formats).toMatchObject({ inherited: "hls", dollar: "mpegts", "fs-ts": "mpegts" });
  });

  it("counts an address that names the minute only from that minute, to the window's end", async () => {
    const { provider: list, asked } = provider(LIST);
    await list.liveCatalogue();
    // Half a minute past to half a minute past.
    const window = { start: EVENING + 30_000, end: EVENING + 30 * MINUTE + 30_000 };
    const xc = await list.archiveStream("xc", window);
    await list.request(xc.url);
    expect(asked).toEqual(["https://iptv.test/timeshift/user/pass/31/2026-10-13:18-00/42.ts"]);
    expect(xc.start).toBe(EVENING);
    // One that names the second starts on it.
    expect((await list.archiveStream("braces", window)).start).toBe(EVENING + 30_000);
  });

  it("plays a channel's recordings from its streams that name their start alone", async () => {
    const { provider: list } = provider(
      [
        "#EXTM3U",
        '#EXTINF:-1 catchup="default" catchup-days="2" catchup-source="https://archive.test/{utc}.ts",Example FHD',
        "https://iptv.test/fhd.ts",
        '#EXTINF:-1 catchup="default" catchup-days="2" catchup-source="https://archive.test/{offset}.ts",Example HD',
        "https://iptv.test/hd.ts",
        '#EXTINF:-1 catchup="xc" catchup-days="2",Example SD',
        "https://iptv.test/live/user/pass/7.ts",
        "",
      ].join("\n"),
    );
    const [channel, ...others] = liveChannels(
      normalizeCatalogue(await list.liveCatalogue()).streams,
    ).channels;
    expect(others).toEqual([]);
    expect(channel?.catchupDays).toBe(2);
    expect(archiveVariants(channel!, WINDOW, NOW).map(({ id }) => id)).toEqual([
      "Example FHD",
      "Example SD",
    ]);
  });

  /** One playlist channel with `attributes`, streaming from `url`. */
  const single = (attributes: string, url = "https://iptv.test/one.ts") =>
    provider(
      ["#EXTM3U", `#EXTINF:-1 tvg-id="one" ${attributes} catchup-days="2",One`, url, ""].join("\n"),
    );

  it.each([
    [
      "a literal that looks like a placeholder, beside a start in the fragment",
      'catchup="default" catchup-source="https://archive.test/{offset}.ts?ignored=catchupplaceholder1end#{utc}"',
    ],
    [
      "a start in the fragment",
      'catchup="default" catchup-source="https://archive.test/{offset}.ts#start={utc}"',
    ],
    [
      "a ${start} in the fragment",
      'catchup="default" catchup-source="https://archive.test/{offset}.ts#${start}"',
    ],
    [
      "a date in the fragment",
      'catchup="default" catchup-source="https://archive.test/{offset}.ts#{Y}/{m}/{d}/{H}/{M}"',
    ],
    [
      "a fragment after a complete start",
      'catchup="default" catchup-source="https://archive.test/{utc}.ts#top"',
    ],
    [
      "a .. segment",
      'catchup="default" catchup-source="https://archive.test/anchor/{utc}/../../{offset}.ts"',
    ],
    ["a . segment", 'catchup="default" catchup-source="https://archive.test/./{utc}.ts"'],
    [
      "an encoded .. segment",
      'catchup="default" catchup-source="https://archive.test/a/%2E%2e/{utc}.ts"',
    ],
    [
      "a login before the host",
      'catchup="default" catchup-source="https://user:pass@archive.test/{utc}.ts"',
    ],
    [
      "a placeholder in the host",
      'catchup="default" catchup-source="https://{utc}.archive.test/one.ts"',
    ],
    [
      "a placeholder in the port",
      'catchup="default" catchup-source="https://archive.test:{offset}/{utc}.ts"',
    ],
    ["a backslash", 'catchup="default" catchup-source="https://archive.test/a\\..\\{utc}.ts"'],
    ["no http(s) address", 'catchup="default" catchup-source="ftp://archive.test/{utc}.ts"'],
  ])("finds no catch-up for an address with %s", async (_, attributes) => {
    const { provider: list, asked } = single(attributes);
    const { channels } = await list.liveCatalogue();
    expect(channels.map((each) => each.catchupDays)).toEqual([null]);
    await expect(list.archiveStream("one", WINDOW)).rejects.toMatchObject({
      error: { kind: "catch-up", reason: "none" },
    });
    expect(asked).toEqual([]);
  });

  it.each([
    ["shift", 'catchup="shift"', "https://iptv.test/live.ts#player-options"],
    ["shift with a utc of its own", 'catchup="shift"', "https://iptv.test/live.ts?utc=1"],
    ["shift with an encoded utc", 'catchup="shift"', "https://iptv.test/live.ts?a=b&%75tc=1"],
    ["shift with an LUTC of its own", 'catchup="timeshift"', "https://iptv.test/live.ts?LUTC=1"],
    ["shift with a utc after a ;", 'catchup="shift"', "https://iptv.test/live.ts?token=t;utc=1"],
    [
      "shift with an encoded utc after a ;",
      'catchup="shift"',
      "https://iptv.test/live.ts?token=t;%75tc=1",
    ],
    [
      "append of a query to a stream with one",
      'catchup="append" catchup-source="?utc={utc}"',
      "https://iptv.test/live.ts?token=t",
    ],
    [
      "append with a utc of its own",
      'catchup="append" catchup-source="&utc={utc}&lutc={lutc}"',
      "https://iptv.test/live.ts?utc=1791914426&token=t",
    ],
    [
      "append with an encoded utc of its own",
      'catchup="append" catchup-source="&utc={utc}&lutc={lutc}"',
      "https://iptv.test/live.ts?%75tc=1791914426&token=t",
    ],
    [
      "a source with a key twice, encoded once",
      'catchup="default" catchup-source="https://archive.test/a.ts?utc=1791914426&%75tc={utc}"',
      "https://iptv.test/live.ts",
    ],
    [
      "a source with a key twice, in another case",
      'catchup="default" catchup-source="https://archive.test/a.ts?Start={utc}&START=1"',
      "https://iptv.test/live.ts",
    ],
    [
      "a source with a key twice, spelt with + and %20",
      'catchup="default" catchup-source="https://archive.test/a.ts?u+tc={utc}&u%20tc=1"',
      "https://iptv.test/live.ts",
    ],
    ["append", 'catchup="append" catchup-source="?utc={utc}"', "https://iptv.test/live.ts#top"],
    ["flussonic", 'catchup="flussonic"', "https://iptv.test/name/mpegts#top"],
    ["xc", 'catchup="xc"', "https://user:pass@iptv.test/live/user/pass/1.ts"],
  ])(
    "finds no catch-up for %s, which sends otherwise than it reads",
    async (_, attributes, url) => {
      const { provider: list } = single(attributes, url);
      const { channels } = await list.liveCatalogue();
      expect(channels.map((each) => each.catchupDays)).toEqual([null]);
    },
  );

  it("appends a source that starts with & to a stream without a query as part of its path", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { provider: list, asked } = single(
      'catchup="append" catchup-source="&utc={utc}"',
      "https://iptv.test/live.ts",
    );
    expect((await list.liveCatalogue()).channels.map((each) => each.catchupDays)).toEqual([2]);
    await list.request((await list.archiveStream("one", WINDOW)).url);
    expect(asked).toEqual([`https://iptv.test/live.ts&utc=${S}`]);
  });

  it.each([
    [
      "shift",
      'catchup="shift"',
      "https://iptv.test/live.ts?token=t&utcoffset=2",
      `https://iptv.test/live.ts?token=t&utcoffset=2&utc=${S}&lutc=${N}`,
    ],
    [
      "append",
      'catchup="append" catchup-source="&utc={utc}"',
      "https://iptv.test/live.m3u8?token=t",
      `https://iptv.test/live.m3u8?token=t&utc=${S}`,
    ],
    [
      "flussonic",
      'catchup="flussonic"',
      "https://iptv.test:8080/name/mpegts",
      `https://iptv.test:8080/name/timeshift_abs-${S}.ts`,
    ],
    [
      "xc",
      'catchup="xc"',
      "https://iptv.test/live/user/pass/42.ts",
      "https://iptv.test/timeshift/user/pass/45/2026-10-13:18-00/42.ts",
    ],
  ])("keeps %s catch-up on an ordinary stream address", async (_, attributes, url, recording) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { provider: list, asked } = single(attributes, url);
    expect((await list.liveCatalogue()).channels.map((each) => each.catchupDays)).toEqual([2]);
    await list.request((await list.archiveStream("one", WINDOW)).url);
    expect(asked).toEqual([recording]);
  });

  it("finds no catch-up where a playlist's attributes don't agree on one, and plays none", async () => {
    const { provider: list, asked } = provider(NONE);
    const { channels } = await list.liveCatalogue();
    expect(channels).toHaveLength(11);
    expect(channels.map((each) => each.catchupDays)).toEqual(channels.map(() => null));
    await expect(list.archiveStream("plain", WINDOW)).rejects.toMatchObject({
      error: { kind: "catch-up", reason: "none" },
    });
    expect(asked).toEqual([]);
  });

  it("plays a Flussonic recording from the playlist host as HLS", async () => {
    const host = await startFakePlaylist({ catchup: true });
    const dataDir = await tempDir();
    const runtime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: null }).pipe(
        Layer.provide(PlaybackCoordination.layer),
        Layer.provideMerge(
          Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
        ),
      ),
    );
    const subscriptions = await promised(runtime, Subscriptions);
    const playback = await promised(runtime, Playback);
    const { id: subscriptionId } = await subscriptions.add({
      server: host.link,
      username: "",
      password: "",
    });
    const session = await playback.open(
      { subscriptionId, id: PLAYLIST_CHANNELS.catchup.id },
      LINUX,
      { archive: WINDOW },
    );
    expect(session.format).toBe("hls");
    const list = await (await fetch(session.url)).text();
    // The recording's four parts, through the proxy, in a playlist that names no end yet.
    expect(list.match(/#EXTINF/g)).toHaveLength(4);
    expect(list).not.toContain("#EXT-X-ENDLIST");
    expect(host.requests()).toContain(`/catchup/index-${S}-2700.m3u8`);
    expect(host.requests()).not.toContain("/catchup/index.m3u8");
    await runtime.dispose();
    await host.close();
  });
});

/**
 * Playback on a playlist that the test's own host serves: `lines` are its entries, given the host's
 * origin, and `answer` answers every other request. `asked` lists their paths, `open` how many are
 * still connected.
 */
async function hostedPlaylist(
  lines: (origin: string) => readonly string[],
  answer: (path: string, response: ServerResponse) => void,
) {
  const asked: string[] = [];
  let open = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://host").pathname;
    if (path === "/list.m3u")
      return void response.end(["#EXTM3U", ...lines(origin), ""].join("\n"));
    asked.push(path);
    open++;
    request.on("close", () => open--);
    answer(path, response);
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dataDir = await tempDir();
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: null }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.add({
    server: `${origin}/list.m3u`,
    username: "",
    password: "",
  });
  return {
    asked,
    open: () => open,
    playback: await promised(runtime, Playback),
    own: (id: string) => ({ subscriptionId, id }),
    async close() {
      await runtime.dispose();
      server.closeAllConnections();
      await new Promise((closed) => server.close(closed));
    },
  };
}

describe("a recording's stretch", () => {
  /** Forty seconds of recording, ten frames a second, with a PCR in its packets. */
  const RECORDING = fixture("recording-long-subtitles.mpegts");
  /** Sends `recording` in small pieces, so where playback stops it shows to within one. */
  const trickle = (recording: Buffer, response: ServerResponse) => {
    response.writeHead(200, { "Content-Type": "video/mp2t" });
    let offset = 0;
    const timer = setInterval(() => {
      response.write(recording.subarray(offset, offset + 32 * 188));
      offset += 32 * 188;
      if (offset >= recording.length) clearInterval(timer);
    }, 15);
    response.on("close", () => clearInterval(timer));
  };

  it("starts at one moment whichever of a channel's streams plays, and plays all of it", async () => {
    // HD names its start to the second and fails; SD names it to the minute and plays.
    const host = await hostedPlaylist(
      (origin) => [
        `#EXTINF:-1 catchup="default" catchup-days="2" catchup-source="${origin}/precise/{utc}.ts",Example HD`,
        `${origin}/precise.ts`,
        '#EXTINF:-1 catchup="xc" catchup-days="2",Example SD',
        `${origin}/live/demo/demo/1.ts`,
      ],
      (path, response) => {
        if (path.startsWith("/precise/")) return void response.writeHead(502).end();
        trickle(RECORDING, response);
      },
    );
    // Ten seconds of programme, from five seconds past.
    const window = { start: EVENING + 5_000, end: EVENING + 15_000 };
    const session = await host.playback.open(host.own("Example HD"), LINUX, {
      variants: ["Example HD", "Example SD"],
      archive: window,
    });
    // Both from the minute SD can name, which is where the recording starts, to its end.
    expect(session.archive).toEqual({ start: EVENING, end: window.end });
    const received = await whole(session.url);
    expect(await host.playback.playing(session.sessionId)).toMatchObject({
      variantId: "Example SD",
    });
    expect(host.asked).toEqual([
      `/precise/${EVENING / 1000}.ts`,
      "/timeshift/demo/demo/1/2026-10-13:18-00/1.ts",
    ]);
    // The fifteen seconds from the minute to the window's end, not the ten the window is long.
    expect(received.length).toBeGreaterThan(RECORDING.length * 0.33);
    expect(received.length).toBeLessThan(RECORDING.length * 0.45);
    await vi.waitFor(() => expect(host.open()).toBe(0));
    await host.close();
  });

  it.each(["on the PCR's own packet", "on a packet of its PID before it"] as const)(
    "counts a jump of the clock the stream marks as a discontinuity %s as no time played",
    async (where) => {
      // The recording's PCRs four seconds ahead from five seconds in, the first of them marked as
      // a discontinuity, or an adaptation-only packet of their PID just before it: its pictures
      // play on as before.
      const shifted = Buffer.from(RECORDING);
      let first: number | null = null;
      let jump: number | null = null;
      for (let at = 0; at + 188 <= shifted.length; at += 188) {
        const packet = shifted.subarray(at, at + 188);
        if (packet[0] !== 0x47 || !(packet[3]! & 0x20) || packet[4]! < 7 || !(packet[5]! & 0x10))
          continue;
        const pcr =
          packet[6]! * 2 ** 25 +
          (packet[7]! << 17) +
          (packet[8]! << 9) +
          (packet[9]! << 1) +
          (packet[10]! >> 7);
        first ??= pcr;
        if ((pcr - first) / 90_000 < 5) continue;
        jump ??= at;
        const ahead = pcr + 4 * 90_000;
        packet[6] = Math.floor(ahead / 2 ** 25) & 0xff;
        packet[7] = Math.floor(ahead / 2 ** 17) & 0xff;
        packet[8] = Math.floor(ahead / 2 ** 9) & 0xff;
        packet[9] = Math.floor(ahead / 2) & 0xff;
        packet[10] = (packet[10]! & 0x7f) | ((ahead & 1) << 7);
      }
      expect(jump).not.toBeNull();
      const at = jump!;
      let recording = shifted;
      if (where === "on the PCR's own packet") shifted[at + 5]! |= 0x80;
      else {
        const marker = Buffer.alloc(188, 0xff);
        marker[0] = 0x47;
        marker[1] = shifted[at + 1]! & 0x1f;
        marker[2] = shifted[at + 2]!;
        marker[3] = 0x20 | (shifted[at + 3]! & 0x0f);
        marker[4] = 183;
        marker[5] = 0x80;
        recording = Buffer.concat([shifted.subarray(0, at), marker, shifted.subarray(at)]);
      }
      const host = await hostedPlaylist(
        (origin) => [
          '#EXTINF:-1 tvg-id="fs" catchup="flussonic" catchup-days="2",Flussonic',
          `${origin}/fs/mpegts`,
        ],
        (_path, response) => trickle(recording, response),
      );
      const session = await host.playback.open(host.own("fs"), LINUX, {
        archive: { start: EVENING, end: EVENING + 10_000 },
      });
      const received = await whole(session.url);
      // Ten seconds of the forty, not the six the jump would leave.
      expect(received.length).toBeGreaterThan(RECORDING.length * 0.23);
      expect(received.length).toBeLessThan(RECORDING.length * 0.35);
      await vi.waitFor(() => expect(host.open()).toBe(0));
      await host.close();
    },
  );
});
