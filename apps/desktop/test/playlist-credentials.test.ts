// What a playlist's stream sends where once its address is https, through the real playback proxy,
// its converter, a receiver's address on the local network, catch-up, title playback and downloads.
// The link's token never reaches http: not in an address the stream's playlists name, nor in a
// header its entry asks for. Plain http is a real loopback server that notes everything reaching
// it; https addresses are answered here, as a provider and its CDNs answer.
import { spawnSync } from "node:child_process";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";
import type { Codec } from "@mrstreamer/contracts/playback";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { transfer } from "../src/main/downloads/transfer.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture } from "./fake-provider.ts";
import { promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

// CI points this at the bundled build, with ffprobe beside it; locally the one on PATH does.
const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasProbe = spawnSync(FFPROBE, ["-version"]).status === 0;
const DECODERS: readonly Codec[] = ["h264", "aac"];
const SECRET = "synthetic-secret";
const LINK = `https://lists.test/list.m3u?token=${SECRET}`;
/** A token of three characters: the login all the same. */
const SHORT = "q7x";
const CLIP = fixture("h264-aac.mpegts");
/** An entry's Referer that holds the link's token, and one that holds nothing of it. */
const REFERER = `https://site.test/watch?token=${SECRET}`;
const ORDINARY = "https://site.test/watch";

/** What an address answers: text, bytes, or a redirect. */
type Answer = string | Buffer | { readonly location: string };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/**
 * The playlist at `link` listing `entries`, with playback and the subscription connected. `routes`
 * answers by address without its query, http ones on the loopback server at `plain`. `reached`
 * notes every http request and `asked` every https one, with their headers.
 */
async function connected(entries: (plain: string) => readonly string[], link = LINK) {
  const routes = new Map<string, Answer>();
  const reached: { path: string; headers: IncomingHttpHeaders }[] = [];
  const asked: { url: string; headers: Headers }[] = [];
  const server = createServer((request, response) => {
    reached.push({ path: request.url ?? "", headers: request.headers });
    const answer = routes.get(`${plain}${new URL(request.url ?? "/", plain).pathname}`);
    if (answer === undefined) return response.writeHead(404).end();
    if (typeof answer === "object" && "location" in answer)
      return response.writeHead(302, { location: answer.location }).end();
    const body = Buffer.from(answer);
    // Byte ranges, as files behind a provider's redirect answer them.
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    response.writeHead(range ? 206 : 200, {
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}),
    });
    response.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise((closed) => server.close(closed));
  });
  const plain = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  routes.set("https://lists.test/list.m3u", ["#EXTM3U", ...entries(plain), ""].join("\n"));
  const answer: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.protocol === "http:") return fetch(url, init);
    asked.push({ url: url.href, headers: new Headers(init?.headers) });
    const found = routes.get(`${url.origin}${url.pathname}`);
    if (found === undefined) return new Response(null, { status: 404 });
    const response =
      typeof found === "object" && "location" in found
        ? new Response(null, { status: 302, headers: { location: found.location } })
        : new Response(found);
    // As fetch tells the address it answered for, which a moved playlist's addresses start from.
    return Object.defineProperty(response, "url", { value: url.href });
  };
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: null, ffprobe: hasProbe ? FFPROBE : null }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir: await tempDir(),
          secrets: testSecrets,
          providerOptions: { userAgent, fetch: answer },
        }),
      ),
    ),
  );
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.add({
    server: link,
    username: "",
    password: "",
  });
  const playback = await promised(runtime, Playback);
  return {
    plain,
    routes,
    reached,
    asked,
    playback,
    subscriptions,
    subscriptionId,
    own: (id: string) => ({ subscriptionId, id }),
    /** `path` on the loopback server with the link's token in its query. */
    leaky: (path: string) => `${plain}${path}?token=${SECRET}`,
  };
}

/** Every address a playlist names, in its order: its tags' URIs and its other lines. */
async function named(url: string): Promise<string[]> {
  const text = await (await fetch(url)).text();
  return text.split("\n").flatMap((line) => {
    if (!line.startsWith("#")) return line.trim() ? [new URL(line.trim(), url).href] : [];
    return [...line.matchAll(/URI="([^"]+)"/g)].map((match) => new URL(match[1]!, url).href);
  });
}

describe("addresses an https stream's playlists name", () => {
  it("asks http for none that holds the link's token, and for one that holds none", async () => {
    const app = await connected(() => [
      '#EXTINF:-1 tvg-id="secure",Secure',
      "https://cdn.test/live/master.m3u8",
    ]);
    const { plain, routes, leaky } = app;
    routes.set(
      "https://cdn.test/live/master.m3u8",
      [
        "#EXTM3U",
        `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="${leaky("/audio.m3u8")}"`,
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="${leaky("/subs.m3u8")}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,AUDIO="a",SUBTITLES="s"',
        "video.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=2000",
        leaky("/variant.m3u8"),
      ].join("\n"),
    );
    routes.set(
      "https://cdn.test/live/video.m3u8",
      [
        "#EXTM3U",
        "#EXT-X-TARGETDURATION:4",
        `#EXT-X-KEY:METHOD=AES-128,URI="${leaky("/key")}"`,
        `#EXT-X-MAP:URI="${leaky("/init.mp4")}"`,
        "#EXTINF:4,",
        leaky("/segment-0.ts"),
        "#EXTINF:4,",
        `${plain}/segment-1.ts?relay=7f3a`,
      ].join("\n"),
    );
    for (const path of ["/audio.m3u8", "/subs.m3u8", "/variant.m3u8", "/key", "/init.mp4"])
      routes.set(`${plain}${path}`, "#EXTM3U\n");
    routes.set(`${plain}/segment-0.ts`, CLIP);
    routes.set(`${plain}/segment-1.ts`, CLIP);

    const session = await app.playback.open(app.own("secure"), DECODERS);
    const [audio, subtitles, video, variant] = await named(session.url);
    const [key, map, leaked, relayed] = await named(video!);
    for (const child of [audio, subtitles, variant, key, map, leaked]) {
      expect((await fetch(child!)).status, child).toBe(502);
    }
    expect(
      await app.playback.failure(session.sessionId, {
        kind: "hls",
        requestId: new URL(leaked!).pathname,
      }),
    ).toMatchObject({ kind: "network", detail: expect.stringContaining("unencrypted") });
    expect(Buffer.from(await (await fetch(relayed!)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => each.path)).toEqual(["/segment-1.ts?relay=7f3a"]);
  });

  it("asks for every address an http stream's playlist names, as an address typed with http", async () => {
    const app = await connected((plain) => [
      '#EXTINF:-1 tvg-id="plain",Plain',
      `${plain}/plain/index.m3u8`,
    ]);
    app.routes.set(
      `${app.plain}/plain/index.m3u8`,
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment.ts?token=${SECRET}\n`,
    );
    app.routes.set(`${app.plain}/plain/segment.ts`, CLIP);
    const session = await app.playback.open(app.own("plain"), DECODERS);
    const [segment] = await named(session.url);
    expect(Buffer.from(await (await fetch(segment!)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => each.path)).toContain(`/plain/segment.ts?token=${SECRET}`);
  });

  it("converts nothing it would have to ask http for with the token", async () => {
    const app = await connected(() => [
      '#EXTINF:-1 tvg-id="repair",Repair',
      "https://cdn.test/repair/index.m3u8",
    ]);
    app.routes.set(
      "https://cdn.test/repair/index.m3u8",
      `#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\n${app.leaky("/part-0.ts")}\n`,
    );
    app.routes.set(`${app.plain}/part-0.ts`, CLIP);
    await expect(
      app.playback.open(app.own("repair"), DECODERS, { repair: true }),
    ).rejects.toMatchObject({
      error: {
        kind: "stream",
        failure: { kind: "network", detail: expect.stringContaining("unencrypted") },
      },
    });
    expect(app.reached).toEqual([]);
  });

  it("gives a receiver on the local network nothing it would have to ask http for with the token", async () => {
    const app = await connected(() => [
      '#EXTINF:-1 tvg-id="tv",TV',
      "https://cdn.test/tv/index.m3u8",
    ]);
    app.routes.set(
      "https://cdn.test/tv/index.m3u8",
      [
        "#EXTM3U",
        `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",NAME="English",URI="${app.leaky("/tv-subs.m3u8")}"`,
        '#EXT-X-STREAM-INF:BANDWIDTH=1000,SUBTITLES="s"',
        "low/stream.m3u8",
      ].join("\n"),
    );
    app.routes.set(
      "https://cdn.test/tv/low/stream.m3u8",
      "#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nsegment-0.ts\n",
    );
    app.routes.set("https://cdn.test/tv/low/segment-0.ts", CLIP);
    app.routes.set(`${app.plain}/tv-subs.m3u8`, "#EXTM3U\n");
    const opened = await app.playback.openReceiver(app.own("tv"), {
      address: "127.0.0.1",
      decoders: DECODERS,
    });
    const [subtitles, stream] = await named(opened.url);
    expect(new URL(subtitles!).origin).toBe(new URL(opened.url).origin);
    expect((await fetch(subtitles!)).status).toBe(502);
    const [segment] = await named(stream!);
    expect(Buffer.from(await (await fetch(segment!)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached).toEqual([]);
    await app.playback.close(opened.sessionId);
  });

  it("names a moved playlist's addresses from where it moved, held to the stream's own address", async () => {
    const app = await connected(() => [
      '#EXTINF:-1 tvg-id="moved",Moved',
      `#EXTVLCOPT:http-referrer=${REFERER}`,
      "https://cdn.test/moved/master.m3u8",
    ]);
    const { routes, leaky } = app;
    routes.set("https://cdn.test/moved/master.m3u8", {
      location: "https://edge.test/now/master.m3u8",
    });
    routes.set(
      "https://edge.test/now/master.m3u8",
      "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow/media.m3u8\n",
    );
    routes.set(
      "https://edge.test/now/low/media.m3u8",
      `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nsegment.ts\n#EXTINF:3,\n${leaky("/part.ts")}\n`,
    );
    // The segment leads back to the stream's own origin.
    routes.set("https://edge.test/now/low/segment.ts", {
      location: "https://cdn.test/back/segment.ts",
    });
    routes.set("https://cdn.test/back/segment.ts", CLIP);
    routes.set(`${app.plain}/part.ts`, CLIP);

    const session = await app.playback.open(app.own("moved"), DECODERS);
    const [media] = await named(session.url);
    expect(new URL(media!).origin).toBe(new URL(session.url).origin);
    const [segment, part] = await named(media!);
    const ranged = await fetch(segment!, { headers: { Range: "bytes=0-187" } });
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(CLIP);
    expect((await fetch(part!)).status).toBe(502);
    expect(app.reached).toEqual([]);

    /** What each request to `url` carried as `name`. */
    const sent = (url: string, name: string) =>
      new Set(app.asked.filter((each) => each.url === url).map((each) => each.headers.get(name)));
    // Elsewhere, its first request included, the Referer goes cut to its origin; back at the
    // stream's origin, whole.
    for (const url of [
      "https://edge.test/now/master.m3u8",
      "https://edge.test/now/low/media.m3u8",
      "https://edge.test/now/low/segment.ts",
    ])
      expect(sent(url, "referer"), url).toEqual(new Set(["https://site.test/"]));
    expect(sent("https://cdn.test/back/segment.ts", "referer")).toEqual(new Set([REFERER]));
    expect(sent("https://cdn.test/back/segment.ts", "range")).toEqual(new Set(["bytes=0-187"]));
  });

  it("holds a playlist an https stream redirected to http to the stream's own address", async () => {
    const app = await connected(() => [
      '#EXTINF:-1 tvg-id="relay",Relay',
      "https://cdn.test/relay.m3u8",
    ]);
    const { routes, plain } = app;
    routes.set("https://cdn.test/relay.m3u8", { location: `${plain}/relay/index.m3u8` });
    routes.set(
      `${plain}/relay/index.m3u8`,
      `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nsegment.ts?token=${SECRET}\n#EXTINF:3,\nsegment.ts\n`,
    );
    routes.set(`${plain}/relay/segment.ts`, CLIP);

    const session = await app.playback.open(app.own("relay"), DECODERS);
    const [leaked, relayed] = await named(session.url);
    expect((await fetch(leaked!)).status).toBe(502);
    expect(Buffer.from(await (await fetch(relayed!)).arrayBuffer())).toEqual(CLIP);
    expect(new Set(app.reached.map((each) => each.path))).toEqual(
      new Set(["/relay/index.m3u8", "/relay/segment.ts"]),
    );
  });

  it("plays a recording from the catch-up archive with none of its parts asked of http with the token", async () => {
    const app = await connected(() => [
      '#EXTINF:-1 tvg-id="archive" catchup="flussonic" catchup-days="2",Archive',
      "https://cdn.test/archive/index.m3u8",
    ]);
    const start = Math.floor(Date.now() / 60_000) * 60_000 - 2 * 60 * 60_000;
    const end = start + 30 * 60_000;
    app.routes.set(
      `https://cdn.test/archive/index-${start / 1000}-1800.m3u8`,
      `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${app.leaky("/archive/part-0.ts")}\n`,
    );
    app.routes.set(`${app.plain}/archive/part-0.ts`, CLIP);
    const session = await app.playback.open(app.own("archive"), DECODERS, {
      archive: { start, end },
    });
    expect(session.archive).toEqual({ start, end });
    const [part] = await named(session.url);
    expect((await fetch(part!)).status).toBe(502);
    expect(app.reached).toEqual([]);
  });
});

describe("what of a playlist's link counts as its login", () => {
  /** Opens the stream `id` and checks it stopped before asking http for anything. */
  async function refused(app: Awaited<ReturnType<typeof connected>>, id: string) {
    const session = await app.playback.open(app.own(id), DECODERS);
    expect((await fetch(session.url)).status).toBe(502);
    expect(await app.playback.failure(session.sessionId)).toMatchObject({
      kind: "network",
      detail: expect.stringContaining("unencrypted"),
    });
    await app.playback.close(session.sessionId);
    expect(app.reached).toEqual([]);
  }

  it("plays a stream redirected to http with a setting of the link's in a name, not with its token", async () => {
    const app = await connected(
      () => [
        '#EXTINF:-1 tvg-id="setting",Setting',
        "https://cdn.test/setting.ts",
        '#EXTINF:-1 tvg-id="token",Token',
        "https://cdn.test/token.ts",
      ],
      `https://lists.test/list.m3u?format=hlsarchive&token=${SECRET}`,
    );
    const { routes, plain } = app;
    routes.set("https://cdn.test/setting.ts", { location: `${plain}/hlsarchive_index.ts` });
    routes.set("https://cdn.test/token.ts", {
      location: `${plain}/hlsarchive_index.ts?token=${SECRET}`,
    });
    routes.set(`${plain}/hlsarchive_index.ts`, CLIP);

    await refused(app, "token");
    const setting = await app.playback.open(app.own("setting"), DECODERS);
    expect(Buffer.from(await (await fetch(setting.url)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => each.path)).toEqual(["/hlsarchive_index.ts"]);
  });

  it("refuses a stream redirected to http with the link's token joined to other text, however short", async () => {
    const app = await connected(
      () => [
        '#EXTINF:-1 tvg-id="relay",Relay',
        "https://cdn.test/relay.ts",
        '#EXTINF:-1 tvg-id="joined",Joined',
        "https://cdn.test/joined.ts",
      ],
      `https://lists.test/list.m3u?token=${SHORT}`,
    );
    const { routes, plain } = app;
    routes.set("https://cdn.test/relay.ts", { location: `${plain}/relay/live.ts?token=7f3a` });
    routes.set("https://cdn.test/joined.ts", {
      location: `${plain}/relay/live.ts?auth=x${SHORT}y`,
    });
    routes.set(`${plain}/relay/live.ts`, CLIP);

    await refused(app, "joined");
    const relay = await app.playback.open(app.own("relay"), DECODERS);
    expect(Buffer.from(await (await fetch(relay.url)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => each.path)).toEqual(["/relay/live.ts?token=7f3a"]);
  });

  it("refuses the link's token in an http address with a plus as written and the rest escaped, as a path reads it", async () => {
    const app = await connected(
      () => [
        '#EXTINF:-1 tvg-id="joined",Joined',
        "https://cdn.test/joined.ts",
        '#EXTINF:-1 tvg-id="child",Child',
        "https://cdn.test/child/index.m3u8",
        '#EXTINF:-1 tvg-id="referer",Referer',
        "#EXTVLCOPT:http-referrer=https://site.test/%71+%78/watch",
        "https://cdn.test/referer.ts",
      ],
      `https://lists.test/list.m3u?token=${encodeURIComponent("q+x")}`,
    );
    const { routes, plain } = app;
    routes.set("https://cdn.test/joined.ts", { location: `${plain}/joined/%71+%78/live.ts` });
    routes.set(
      "https://cdn.test/child/index.m3u8",
      `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${plain}/leak/%71+%78/seg-0.ts\n#EXTINF:3,\n${plain}/relay/seg-1.ts\n`,
    );
    routes.set("https://cdn.test/referer.ts", { location: `${plain}/referer/live.ts` });
    for (const path of ["/joined/%71+%78/live.ts", "/leak/%71+%78/seg-0.ts", "/relay/seg-1.ts"])
      routes.set(`${plain}${path}`, CLIP);
    routes.set(`${plain}/referer/live.ts`, CLIP);

    await refused(app, "joined");
    const child = await app.playback.open(app.own("child"), DECODERS);
    const [leaked, relayed] = await named(child.url);
    expect((await fetch(leaked!)).status).toBe(502);
    expect(Buffer.from(await (await fetch(relayed!)).arrayBuffer())).toEqual(CLIP);
    const referer = await app.playback.open(app.own("referer"), DECODERS);
    expect(Buffer.from(await (await fetch(referer.url)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => [each.path, each.headers.referer])).toEqual([
      ["/relay/seg-1.ts", undefined],
      ["/referer/live.ts", "https://site.test/"],
    ]);
  });

  it("plays a stream redirected to http with a plus in its path for a login with a space", async () => {
    const app = await connected(
      () => [
        '#EXTINF:-1 tvg-id="plus",Plus',
        "#EXTVLCOPT:http-referrer=https://site.test/open+sesame/watch",
        "https://cdn.test/plus.ts",
      ],
      `https://lists.test/list.m3u?token=${encodeURIComponent("open sesame")}`,
    );
    app.routes.set("https://cdn.test/plus.ts", { location: `${app.plain}/open+sesame/live.ts` });
    app.routes.set(`${app.plain}/open+sesame/live.ts`, CLIP);
    const session = await app.playback.open(app.own("plus"), DECODERS);
    expect(Buffer.from(await (await fetch(session.url)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => [each.path, each.headers.referer])).toEqual([
      ["/open+sesame/live.ts", "https://site.test/open+sesame/watch"],
    ]);
  });

  it("refuses the link's token beside an escape that is no UTF-8, and plays such an escape without it", async () => {
    const app = await connected(
      () => [
        '#EXTINF:-1 tvg-id="broken",Broken',
        "https://cdn.test/broken.ts",
        '#EXTINF:-1 tvg-id="child",Child',
        "https://cdn.test/child/index.m3u8",
        '#EXTINF:-1 tvg-id="latin",Latin',
        "#EXTVLCOPT:http-referrer=https://site.test/watch/%71%37%78%FF",
        "https://cdn.test/latin.ts",
      ],
      `https://lists.test/list.m3u?token=${SHORT}`,
    );
    const { routes, plain } = app;
    routes.set("https://cdn.test/broken.ts", {
      location: `${plain}/relay/live.ts?auth=x%FF%71%37%78y`,
    });
    routes.set(
      "https://cdn.test/child/index.m3u8",
      `#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\n${plain}/leak/x%FF%71%37%78y/seg-0.ts\n`,
    );
    routes.set("https://cdn.test/latin.ts", { location: `${plain}/caf%E9/live.ts` });
    for (const path of ["/relay/live.ts", "/leak/x%FF%71%37%78y/seg-0.ts", "/caf%E9/live.ts"])
      routes.set(`${plain}${path}`, CLIP);

    await refused(app, "broken");
    const child = await app.playback.open(app.own("child"), DECODERS);
    const [leaked] = await named(child.url);
    expect((await fetch(leaked!)).status).toBe(502);
    expect(app.reached).toEqual([]);
    const latin = await app.playback.open(app.own("latin"), DECODERS);
    expect(Buffer.from(await (await fetch(latin.url)).arrayBuffer())).toEqual(CLIP);
    expect(app.reached.map((each) => [each.path, each.headers.referer])).toEqual([
      ["/caf%E9/live.ts", "https://site.test/"],
    ]);
  });
});

describe("the headers a playlist entry asks for", () => {
  /** An entry streaming from `url`, with a player's User-Agent and `referer`. */
  const entry = (id: string, url: string, referer = REFERER) => [
    `#EXTINF:-1 tvg-id="${id}",${id}`,
    "#EXTVLCOPT:http-user-agent=SyntheticPlayer/1.0",
    `#EXTVLCOPT:http-referrer=${referer}`,
    url,
  ];

  it("go whole to the stream's own origin, and with the token cut from them anywhere else", async () => {
    const app = await connected(() => [
      ...entry("same", "https://cdn.test/same.ts"),
      ...entry("cross", "https://cdn.test/cross.ts"),
      ...entry("down", "https://cdn.test/down.ts"),
      ...entry("ordinary", "https://cdn.test/ordinary.ts", ORDINARY),
    ]);
    const { routes, plain } = app;
    routes.set("https://cdn.test/same.ts", { location: "https://cdn.test/same-moved.ts" });
    routes.set("https://cdn.test/cross.ts", { location: "https://edge.test/cross.ts" });
    routes.set("https://cdn.test/down.ts", { location: `${plain}/down.ts` });
    routes.set("https://cdn.test/ordinary.ts", { location: `${plain}/ordinary.ts` });
    for (const url of ["https://cdn.test/same-moved.ts", "https://edge.test/cross.ts"])
      routes.set(url, CLIP);
    for (const path of ["/down.ts", "/ordinary.ts"]) routes.set(`${plain}${path}`, CLIP);

    for (const id of ["same", "cross", "down", "ordinary"]) {
      const session = await app.playback.open(app.own(id), DECODERS);
      expect((await (await fetch(session.url)).arrayBuffer()).byteLength).toBeGreaterThan(0);
      await app.playback.close(session.sessionId);
    }
    const sent = (url: string) => app.asked.find((each) => each.url === url)?.headers;
    expect(sent("https://cdn.test/same-moved.ts")?.get("referer")).toBe(REFERER);
    expect(sent("https://edge.test/cross.ts")?.get("referer")).toBe("https://site.test/");
    expect(sent("https://edge.test/cross.ts")?.get("user-agent")).toBe("SyntheticPlayer/1.0");
    const reached = Object.fromEntries(app.reached.map((each) => [each.path, each.headers]));
    expect(reached["/down.ts"]).toMatchObject({
      referer: "https://site.test/",
      "user-agent": "SyntheticPlayer/1.0",
    });
    expect(reached["/ordinary.ts"]?.referer).toBe(ORDINARY);
    expect(JSON.stringify(app.reached)).not.toContain(SECRET);
  });

  describe.skipIf(!hasProbe)("for a playlist's film", () => {
    it("never reach http with the token, played or downloaded", async () => {
      const app = await connected(() => [
        '#EXTINF:-1 group-title="Films",Film',
        "#EXTVLCOPT:http-user-agent=FilmAgent",
        `#EXTVLCOPT:http-referrer=${REFERER}`,
        "https://cdn.test/films/film.mp4",
      ]);
      app.routes.set("https://cdn.test/films/film.mp4", {
        location: `${app.plain}/films/film.mp4`,
      });
      const film = fixture("title-h264-aac.mp4");
      app.routes.set(`${app.plain}/films/film.mp4`, film);
      await app.subscriptions.mapPlaylist(app.subscriptionId, playlistGroupId("Films"), "movie");
      const source = (await app.subscriptions.sources())[0]!;
      const [movie] = (await source.provider.onDemandCatalogue()).movies;
      const file = await source.provider.titleFile("movie", movie!.id, "mp4");
      expect(file.headers).toEqual({ "User-Agent": "FilmAgent", Referer: REFERER });

      const ref = { kind: "movie" as const, subscriptionId: app.subscriptionId, id: movie!.id };
      const session = await app.playback.openTitle(ref, file.url, DECODERS, file);
      expect(session.duration).toBeGreaterThan(0);
      await app.playback.close(session.sessionId);

      const part = join(await tempDir(), "film.part");
      const outcome = await transfer({
        url: file.url,
        headers: file.headers ?? {},
        request: source.provider.request,
        userAgent,
        part,
        known: null,
        signal: new AbortController().signal,
        progress: () => {},
        identify: () => {},
      });
      expect(outcome).toMatchObject({ kind: "complete", size: film.length });

      expect(app.reached.length).toBeGreaterThan(1);
      for (const request of app.reached) {
        expect(request.headers).toMatchObject({
          referer: "https://site.test/",
          "user-agent": "FilmAgent",
        });
      }
      expect(JSON.stringify(app.reached)).not.toContain(SECRET);
    });
  });
});
