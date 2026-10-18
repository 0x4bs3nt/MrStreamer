import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import type { Secrets } from "../src/main/platform/secrets.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import { fixture } from "./fake-provider.ts";
import { promised, runtimeFor, tempDir, testConfig, testSecrets } from "./support.ts";

const CLIP = fixture("h264-aac.mpegts");
const PLAYER = "Player/1.0 (X11, Linux)";
const servers: Server[] = [];
const hosts: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  }
  for (const host of hosts.splice(0)) await host.close();
});

/**
 * A host for made-up playlists, as a public collection publishes them: `/list.m3u` with an HLS
 * channel that asks for its own User-Agent and Referer, an MPEG-TS channel, and entries no player
 * here plays; `/other.m3u`, whose first line names no guide; a packed guide `/list.m3u` names;
 * and `/panel`, a web page. HLS playlists arrive a few bytes at a time and one segment compressed,
 * as some servers send them. `asked` lists every request with the headers it came with. `serve`
 * puts something else at a path: a body, an HTTP status that fails it, or "hold", which takes
 * the request and never answers.
 */
async function playlistHost() {
  const asked: { path: string; userAgent?: string; referer?: string }[] = [];
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://host");
    asked.push({
      path: pathname,
      ...(request.headers["user-agent"] ? { userAgent: request.headers["user-agent"] } : {}),
      ...(request.headers.referer ? { referer: request.headers.referer } : {}),
    });
    const body = routes.get(pathname);
    if (body === undefined) return response.writeHead(404).end();
    if (body === "hold") return;
    if (typeof body === "number") return response.writeHead(body).end();
    if (pathname.endsWith("segment-1.ts")) {
      const packed = gzipSync(body);
      return response
        .writeHead(200, { "Content-Encoding": "gzip", "Content-Length": packed.length })
        .end(packed);
    }
    if (!pathname.endsWith(".m3u8")) return response.writeHead(200).end(body);
    response.writeHead(200);
    const text = Buffer.from(body);
    let at = 0;
    const next = () => {
      if (at >= text.length) return response.end();
      response.write(text.subarray(at, (at += 5)));
      setTimeout(next, 1);
    };
    next();
  });
  servers.push(server);
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const routes = new Map<string, string | Buffer | number>([
    [
      "/list.m3u",
      [
        `#EXTM3U x-tvg-url="${origin}/guide.xml.gz"`,
        `#EXTINF:-1 tvg-id="Alpha.test@HD" group-title="News;General" http-user-agent="${PLAYER}",Alpha News (720p)`,
        `#EXTVLCOPT:http-referrer=${origin}/`,
        `${origin}/alpha/index.m3u8`,
        '#EXTINF:-1 tvg-id="Beta.test" group-title="Movies",Beta Movies [Not 24/7]',
        `${origin}/beta.ts`,
        '#EXTINF:-1 tvg-id="Gamma.test" group-title="News",Gamma',
        `${origin}/gamma.mpd`,
        '#EXTINF:-1 tvg-id="Delta.test" group-title="News",Delta',
        "rtmp://127.0.0.1/delta",
      ].join("\n"),
    ],
    ["/other.m3u", `#EXTM3U\n#EXTINF:-1 tvg-id="Echo.test",Echo\n${origin}/beta.ts\n`],
    ["/alpha/index.m3u8", "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=200000\nlow/stream.m3u8\n"],
    [
      "/alpha/low/stream.m3u8",
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:3",
        "#EXT-X-MEDIA-SEQUENCE:0",
        "#EXTINF:3,",
        "segment-0.ts",
        "#EXTINF:3,",
        `${origin}/alpha/low/segment-1.ts`,
      ].join("\n"),
    ],
    ["/alpha/low/segment-0.ts", CLIP],
    ["/alpha/low/segment-1.ts", CLIP],
    ["/beta.ts", CLIP],
    ["/guide.xml.gz", gzipSync(guideAround(Date.now()))],
    ["/panel", "<!doctype html><title>Panel</title>"],
  ]);
  return {
    origin,
    asked,
    serve: (path: string, body: string | Buffer | number) => void routes.set(path, body),
    /** How often `path` was asked for. */
    requests: (path: string) => asked.filter((request) => request.path === path).length,
  };
}

/** `/other.m3u` with a first line that names the host's guide, and a channel the guide covers. */
const namingGuide = (origin: string) =>
  `#EXTM3U x-tvg-url="${origin}/guide.xml.gz"\n#EXTINF:-1 tvg-id="Alpha.test@HD",Alpha\n${origin}/beta.ts\n`;
/** The same channel under a first line that names none. */
const namingNone = (origin: string) =>
  `#EXTM3U\n#EXTINF:-1 tvg-id="Alpha.test@HD",Alpha\n${origin}/beta.ts\n`;

/** Alpha's programme on now and the one after, in XMLTV. */
function guideAround(now: number): string {
  const time = (at: number) =>
    `${new Date(at).toISOString().replace(/[-:T]/g, "").slice(0, 14)} +0000`;
  const programme = (from: number, to: number, title: string) =>
    `<programme start="${time(from)}" stop="${time(to)}" channel="Alpha.test@HD"><title>${title}</title></programme>`;
  const hour = 60 * 60 * 1000;
  return `<?xml version="1.0"?><tv>${programme(now - hour / 2, now + hour / 2, "Morning News")}${programme(now + hour / 2, now + hour, "Weather")}</tv>`;
}

/**
 * The app's services on `dataDir`; another call is the app started again, with `secrets` as the
 * keychain it finds then. `own` names a channel with the subscription saved first at that moment,
 * and the calls about one subscription's lists and guide are about that one; opening a channel
 * and asking for listings take and answer the playlist's own ids.
 */
async function app(dataDir: string, secrets: Secrets = testSecrets) {
  const runtime = runtimeFor(mainLayer({ ...testConfig(dataDir), secrets }));
  const subscriptions = await promised(runtime, Subscriptions);
  const playback = await promised(runtime, Playback);
  const guide = await promised(runtime, Guide);
  const library = await promised(runtime, Library);
  const roster = await promised(runtime, Roster);
  /** The subscription saved first. Without one, an id that names none that is. */
  const saved = async () => (await subscriptions.list())[0]?.id ?? "no-subscription";
  const own = async (id: string) => ({ subscriptionId: await saved(), id });
  return {
    own,
    subscriptions,
    library: { ...library, refresh: async () => library.refresh(await saved()) },
    onDemand: await promised(runtime, OnDemand),
    playback: {
      ...playback,
      open: async (channelId: string, decoders: Parameters<typeof playback.open>[1]) =>
        playback.open(await own(channelId), decoders),
    },
    guide: {
      ...guide,
      refresh: async () => guide.refresh(await saved()),
      refreshIfStale: async () => guide.refreshIfStale(await saved()),
      /** The first subscription's guide, as Settings shows it. */
      status: async () => {
        const [first] = await guide.status();
        if (!first) throw new Error("No subscription is saved");
        const { subscriptionId: _of, ...status } = first;
        return status;
      },
      /** Removes the subscription, with what was loaded from it. */
      clear: async () => roster.remove(await saved(), false),
      listings: async (channelIds: readonly string[]) => {
        const channels = await Promise.all(channelIds.map(own));
        const listings = await guide.listings(channels);
        return Object.fromEntries(
          channels.flatMap((channel) => {
            const listing = listings[ownedKey(channel)];
            return listing ? [[channel.id, listing] as const] : [];
          }),
        );
      },
    },
    viewing: await promised(runtime, ViewingRecord),
  };
}

/** Why `promise` failed, as the window is told. */
const failureOf = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (cause: unknown) => (cause instanceof Failed ? cause.error : cause),
  );

const linkOnly = (server: string) => ({ server, username: "", password: "" });

/** The proxy addresses a playlist the player receives names. */
function addresses(playlist: string): string[] {
  return playlist.split("\n").filter((line) => line.startsWith("http"));
}

describe("playlist subscriptions", () => {
  it("connect with a link alone, which stays sealed, and list live channels only", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const { subscriptions, library, onDemand } = await app(dataDir);

    const connected = await subscriptions.add(linkOnly(`${host.origin}/list.m3u?token=t0k3n`));

    expect(connected).toMatchObject({ kind: "m3u", server: host.origin, username: "" });
    const stored = await readFile(join(dataDir, "subscription.json"), "utf8");
    expect(stored).not.toContain("t0k3n");
    expect(stored).not.toContain("list.m3u");
    expect((await library.categories()).map((category) => category.name)).toEqual([
      "News",
      "General",
      "Movies",
    ]);
    expect((await library.channels({})).map((channel) => [channel.id, channel.name])).toEqual([
      ["Alpha.test@HD", "Alpha News (720p)"],
      ["Beta.test", "Beta Movies [Not 24/7]"],
    ]);
    // No movies or series, and none asked for.
    expect(await onDemand.refresh(connected.id)).toEqual({ lists: [], metadata: null });
    // Another playlist from the same host is another account.
    const other = await subscriptions.add(linkOnly(`${host.origin}/other.m3u`));
    expect(other.id).not.toBe(connected.id);
  });

  it("refuse a page that isn't a playlist, and a server address without a login", async () => {
    const host = await playlistHost();
    const { subscriptions } = await app(await tempDir());
    const failure = (server: string) => failureOf(subscriptions.add(linkOnly(server)));

    expect(await failure(`${host.origin}/panel`)).toMatchObject({ kind: "incomplete-login" });
    const asked = host.asked.length;
    // Asks for the login without asking the server.
    expect(await failure(host.origin)).toMatchObject({ kind: "incomplete-login" });
    expect(host.asked).toHaveLength(asked);
    expect(await subscriptions.list()).toEqual([]);
  });

  it("play HLS through the proxy, with the headers the playlist asks for", async () => {
    const host = await playlistHost();
    const { subscriptions, playback } = await app(await tempDir());
    await subscriptions.add(linkOnly(`${host.origin}/list.m3u`));

    const session = await playback.open("Alpha.test@HD", ["h264", "aac"]);
    const master = await (await fetch(session.url)).text();
    const [variant] = addresses(master);
    const segments = addresses(await (await fetch(variant ?? "")).text());

    expect(session.format).toBe("hls");
    expect(master).not.toContain(host.origin);
    expect(segments).toHaveLength(2);
    for (const segment of segments) {
      expect(Buffer.from(await (await fetch(segment)).arrayBuffer())).toEqual(CLIP);
    }
    const upstream = host.asked.filter((request) => request.path.startsWith("/alpha/"));
    expect(upstream).toHaveLength(4);
    for (const request of upstream) {
      expect(request).toMatchObject({ userAgent: PLAYER, referer: `${host.origin}/` });
    }
    // A closed session's addresses lead nowhere.
    await playback.close(session.sessionId);
    expect((await fetch(segments[0] ?? "")).status).toBe(410);
  });

  it("play an HLS stream's sound and subtitle renditions through the proxy too", async () => {
    const host = await startFakePlaylist();
    hosts.push(host);
    const { subscriptions, playback } = await app(await tempDir());
    await subscriptions.add(linkOnly(host.link));

    const session = await playback.open(PLAYLIST_CHANNELS.tracks.id, ["h264", "aac"]);
    const master = await (await fetch(session.url)).text();
    /** Where the player finds the rendition named `name`: an address of the proxy. */
    const rendition = (name: string) =>
      new RegExp(`NAME="${name}".*URI="([^"]+)"`).exec(master)?.[1] ?? "";
    const [segment] = addresses(await (await fetch(rendition("spa"))).text());
    const [lines] = addresses(await (await fetch(rendition("Deutsch"))).text());

    // The player is told what the stream declares, and of no address of the host's.
    expect(master).toContain('TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="English",LANGUAGE="en"');
    expect(master).not.toContain(host.origin);
    expect(Buffer.from(await (await fetch(segment ?? "")).arrayBuffer())).toEqual(
      fixture("hls/sound-es-0.mpegts"),
    );
    expect(await (await fetch(lines ?? "")).text()).toContain("Deutsche Zeile 1");
    // Only what the player asked for was fetched: no rendition it didn't choose.
    expect(host.requests().filter((path) => path.startsWith("/tracks/"))).toEqual([
      "/tracks/master.m3u8",
      "/tracks/sound-es.m3u8",
      "/tracks/subtitles-de.m3u8",
      "/tracks/sound-es-0.mpegts",
      "/tracks/subtitles-de.vtt",
    ]);
  });

  it("keeps subtitle HTTP failures separate from a later video failure", async () => {
    const host = await playlistHost();
    host.serve(
      "/alpha/index.m3u8",
      [
        "#EXTM3U",
        '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",URI="lines.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=200000,SUBTITLES="subs"',
        "low/stream.m3u8",
      ].join("\n"),
    );
    const { subscriptions, playback } = await app(await tempDir());
    await subscriptions.add(linkOnly(`${host.origin}/list.m3u`));
    const session = await playback.open("Alpha.test@HD", ["h264", "aac"]);
    const master = await (await fetch(session.url)).text();
    const subtitles = /URI="([^"]+)"/.exec(master)![1]!;
    const [video] = addresses(master);
    expect((await fetch(subtitles)).status).toBe(404);
    expect(
      await playback.failure(session.sessionId, {
        kind: "hls",
        requestId: new URL(video!).pathname,
      }),
    ).toBeNull();
    host.serve("/alpha/lines.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nline.vtt\n");
    const [line] = addresses(await (await fetch(subtitles)).text());
    expect((await fetch(line!)).status).toBe(404);
    expect(
      await playback.failure(session.sessionId, {
        kind: "hls",
        requestId: new URL(video!).pathname,
      }),
    ).toBeNull();
    host.serve("/alpha/low/stream.m3u8", 503);
    expect((await fetch(video!)).status).toBe(503);
    expect(
      await playback.failure(session.sessionId, {
        kind: "hls",
        requestId: new URL(video!).pathname,
      }),
    ).toEqual({
      kind: "provider-error",
      status: 503,
    });
    // A successful subtitle playlist must not clear the picture's genuine failure either.
    expect((await fetch(subtitles)).status).toBe(200);
    expect(
      await playback.failure(session.sessionId, {
        kind: "hls",
        requestId: new URL(video!).pathname,
      }),
    ).toEqual({
      kind: "provider-error",
      status: 503,
    });
  });

  it("attributes HLS failures only to the selected request and clears only its successful retry", async () => {
    const host = await playlistHost();
    const { subscriptions, playback } = await app(await tempDir());
    await subscriptions.add(linkOnly(`${host.origin}/list.m3u`));
    const session = await playback.open("Alpha.test@HD", ["h264", "aac"]);
    const [variant] = addresses(await (await fetch(session.url)).text());
    const segments = addresses(await (await fetch(variant!)).text());
    const selected = (url: string | null) => ({
      kind: "hls" as const,
      requestId: url ? new URL(url).pathname : null,
    });
    host.serve("/alpha/low/segment-0.ts", 404);
    expect((await fetch(segments[0]!)).status).toBe(404);
    expect(await playback.failure(session.sessionId, selected(segments[0]!))).toEqual({
      kind: "unavailable",
      status: 404,
    });
    expect(await playback.failure(session.sessionId, selected(segments[1]!))).toBeNull();
    expect(await playback.failure(session.sessionId, selected(null))).toBeNull();
    expect(await playback.failure(session.sessionId)).toBeNull();
    // Neither a playlist reload nor another segment resolves the failed segment.
    await (await fetch(session.url)).text();
    await (await fetch(variant!)).text();
    await (await fetch(segments[1]!)).arrayBuffer();
    expect(await playback.failure(session.sessionId, selected(segments[0]!))).toEqual({
      kind: "unavailable",
      status: 404,
    });
    host.serve("/alpha/low/segment-0.ts", CLIP);
    await (await fetch(segments[0]!)).arrayBuffer();
    expect(await playback.failure(session.sessionId, selected(segments[0]!))).toBeNull();
    // Proxy identity belongs to this session, not just a segment number.
    const before = session.sessionId;
    const next = await playback.open("Alpha.test@HD", ["h264", "aac"]);
    const [nextVariant] = addresses(await (await fetch(next.url)).text());
    const [nextSegment] = addresses(await (await fetch(nextVariant!)).text());
    host.serve("/alpha/low/segment-0.ts", 403);
    expect((await fetch(nextSegment!)).status).toBe(403);
    expect(await playback.failure(next.sessionId, selected(nextSegment!))).toEqual({
      kind: "refused",
      status: 403,
    });
    expect(await playback.failure(next.sessionId, selected(segments[0]!))).toBeNull();
    expect(await playback.failure(before, selected(segments[0]!))).toBeNull();
  });

  it("play a channel after a restart, reading the playlist again for its address", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const before = await app(dataDir);
    await before.subscriptions.add(linkOnly(`${host.origin}/list.m3u`));
    await before.library.channels({});

    const after = await app(dataDir);
    const reads = () => host.asked.filter((request) => request.path === "/list.m3u").length;
    const readBefore = reads();
    // From the cache, without asking the host.
    expect(await after.library.channels({})).toHaveLength(2);
    expect(reads()).toBe(readBefore);
    const session = await after.playback.open("Beta.test", ["h264", "aac"]);
    const response = await fetch(session.url);

    expect(session.format).toBe("mpegts");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CLIP);
    expect(reads()).toBe(readBefore + 1);
  });

  it("take the programme guide the playlist names, packed", async () => {
    const host = await playlistHost();
    const { subscriptions, library, guide } = await app(await tempDir());
    await subscriptions.add(linkOnly(`${host.origin}/list.m3u`));
    await library.channels({});

    await guide.refresh();

    const listings = await guide.listings(["Alpha.test@HD", "Beta.test"]);
    expect(listings["Alpha.test@HD"]).toMatchObject({
      now: { title: "Morning News" },
      next: { title: "Weather" },
    });
    expect(listings["Beta.test"]).toBeUndefined();
    expect(await guide.status()).toMatchObject({ channels: 1, availability: "available" });
  });

  it("say a playlist names no guide, without failing, and ask again only when told to", async () => {
    const host = await playlistHost();
    const { subscriptions, library, guide } = await app(await tempDir());
    await subscriptions.add(linkOnly(`${host.origin}/other.m3u`));
    await library.channels({});
    // Not read for a guide yet: nothing says it has none.
    expect(await guide.status()).toMatchObject({
      channels: 0,
      fetchedAt: null,
      availability: "unknown",
    });

    await guide.refreshIfStale();

    // An answer, not a failure: nothing is reported as one.
    const none = {
      channels: 0,
      fetchedAt: null,
      availability: "none",
      processing: { state: "empty" },
    };
    expect(await guide.status()).toMatchObject(none);
    const read = host.requests("/other.m3u");
    // The checks the app makes on its own leave the playlist alone from then on.
    await guide.refreshIfStale();
    await guide.refreshIfStale();
    expect(host.requests("/other.m3u")).toBe(read);
    // Refresh in Settings reads its first line again, and still succeeds.
    await guide.refresh();
    expect(host.requests("/other.m3u")).toBe(read + 1);
    expect(await guide.status()).toMatchObject(none);
    expect(host.requests("/guide.xml.gz")).toBe(0);
  });

  it("find a guide the playlist names later, and drop it when the playlist names none any more", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const { subscriptions, library, guide } = await app(dataDir);
    await subscriptions.add(linkOnly(`${host.origin}/other.m3u`));
    host.serve("/other.m3u", namingNone(host.origin));
    await library.refresh();
    await guide.refresh();
    expect(await guide.listings(["Alpha.test@HD"])).toEqual({});

    host.serve("/other.m3u", namingGuide(host.origin));
    await guide.refresh();

    expect((await guide.listings(["Alpha.test@HD"]))["Alpha.test@HD"]).toMatchObject({
      now: { title: "Morning News" },
    });
    expect(await guide.status()).toMatchObject({ channels: 1, availability: "available" });

    host.serve("/other.m3u", namingNone(host.origin));
    await guide.refresh();

    expect(await guide.listings(["Alpha.test@HD"])).toEqual({});
    expect(await guide.status()).toMatchObject({
      channels: 0,
      fetchedAt: null,
      availability: "none",
    });
    // Nothing of the dropped guide is left for the next start to read.
    const restarted = await app(dataDir);
    await restarted.library.channels({});
    expect(await restarted.guide.listings(["Alpha.test@HD"])).toEqual({});
    expect(await restarted.guide.status()).toMatchObject({ availability: "unknown" });
  });

  it("keep the last guide when the playlist or the guide it names can't be had", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const { subscriptions, library, guide } = await app(dataDir);
    await subscriptions.add(linkOnly(`${host.origin}/list.m3u`));
    await library.channels({});
    await guide.refresh();
    const playlist = await (await fetch(`${host.origin}/list.m3u`)).text();
    const nowOn = async (services: { guide: typeof guide }) =>
      (await services.guide.listings(["Alpha.test@HD"]))["Alpha.test@HD"]?.now?.title;

    host.serve("/guide.xml.gz", 502);
    expect(await failureOf(guide.refresh())).toEqual({ kind: "provider-error", status: 502 });
    host.serve("/guide.xml.gz", "<tv></tv>");
    expect(await failureOf(guide.refresh())).toEqual({ kind: "guide", failure: { kind: "empty" } });
    host.serve("/list.m3u", 503);
    expect(await failureOf(guide.refresh())).toEqual({ kind: "provider-error", status: 503 });
    // A page in the playlist's place says nothing about its guide either.
    host.serve("/list.m3u", "<!doctype html><title>Moved</title>");
    expect(await failureOf(guide.refresh())).toMatchObject({
      kind: "unreachable",
      server: host.origin,
    });

    expect(await nowOn({ guide })).toBe("Morning News");
    expect(await guide.status()).toMatchObject({ channels: 1, availability: "available" });
    // The guide on disk is still the last complete one.
    host.serve("/list.m3u", playlist);
    const guideRequests = host.requests("/guide.xml.gz");
    const restarted = await app(dataDir);
    await restarted.library.channels({});
    await restarted.guide.refreshIfStale();
    expect(await nowOn(restarted)).toBe("Morning News");
    expect(host.requests("/guide.xml.gz")).toBe(guideRequests);
  });

  it("keep what was known when the subscription goes while the playlist is being read", async () => {
    const host = await playlistHost();
    const { subscriptions, library, guide } = await app(await tempDir());
    await subscriptions.add(linkOnly(`${host.origin}/other.m3u`));
    await library.channels({});
    host.serve("/other.m3u", "hold");
    const read = host.requests("/other.m3u");
    const refresh = guide.refresh().then(
      () => "finished",
      () => "stopped",
    );
    await vi.waitFor(() => expect(host.requests("/other.m3u")).toBe(read + 1));

    await guide.clear();

    expect(await refresh).toBe("stopped");
    expect(await guide.listings(["Alpha.test@HD"])).toEqual({});
  });

  it("ask for the link again when the keychain no longer opens it, and keep the account", async () => {
    const host = await playlistHost();
    const dataDir = await tempDir();
    const link = `${host.origin}/list.m3u?token=t0k3n`;
    const before = await app(dataDir);
    const connected = await before.subscriptions.add(linkOnly(link));
    await before.library.channels({});
    const starred = await before.own("Beta.test");
    await before.viewing.setFavourite("first", starred, true);

    // What a new app signature or a reset keychain looks like to the app.
    const locked = await app(dataDir, {
      seal: testSecrets.seal,
      open: () => {
        throw new AppFailure({ kind: "keychain-refused" });
      },
    });
    const [asking] = await locked.subscriptions.list();

    // Only the host is left to say which link: none of the link itself reaches the window.
    expect(asking).toEqual({ ...connected, needsSecret: true });
    expect(asking).toMatchObject({ kind: "m3u", server: host.origin, username: "" });
    expect(JSON.stringify(asking)).not.toMatch(/t0k3n|list\.m3u/);
    expect(await locked.subscriptions.sources()).toEqual([]);
    // What it loaded and what the viewer kept still show; nothing of it plays.
    expect((await locked.viewing.state()).favourites).toEqual([starred]);
    expect(await locked.library.channels({})).toHaveLength(2);
    expect(await failureOf(locked.playback.open("Beta.test", ["h264", "aac"]))).toEqual({
      kind: "needs-secret",
      subscriptionId: connected.id,
    });

    // The same link is the same account: its favourites and channels are as they were.
    const read = host.requests("/list.m3u");
    expect(await locked.subscriptions.add(linkOnly(link))).toEqual(connected);
    expect((await locked.viewing.state()).favourites).toEqual([starred]);
    expect(await locked.library.channels({})).toHaveLength(2);
    // Checking the link read its first line; the channels came from the copy on disk.
    expect(host.requests("/list.m3u")).toBe(read + 1);
    // A new link entered for it, as after its token changed, is the same subscription still.
    const relinked = await locked.subscriptions.update(connected.id, {
      secret: `${host.origin}/list.m3u?token=n3w`,
    });
    expect(relinked).toEqual(connected);
    expect((await locked.viewing.state()).favourites).toEqual([starred]);
    expect(await readFile(join(dataDir, "subscription.json"), "utf8")).not.toMatch(/n3w|list\.m3u/);
    // A link that carries a login is a panel's, which is another kind of subscription.
    expect(
      await failureOf(
        locked.subscriptions.update(connected.id, {
          secret: `${host.origin}/get.php?username=u&password=p`,
        }),
      ),
    ).toMatchObject({ kind: "incomplete-login" });
    // Another link added is another account, beside this one.
    const other = await locked.subscriptions.add(linkOnly(`${host.origin}/other.m3u`));
    expect(other.id).not.toBe(connected.id);
    expect(await locked.subscriptions.list()).toHaveLength(2);
  });
});
