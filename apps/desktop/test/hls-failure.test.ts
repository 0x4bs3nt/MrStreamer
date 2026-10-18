import { afterEach, expect, it } from "vitest";
import * as Layer from "effect/Layer";
import { Playback } from "../src/main/services/playback.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { PLAYLIST_CHANNELS, startFakePlaylist } from "./fake-playlist.ts";
import { promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

const dispose: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of dispose.splice(0).reverse()) await close();
});

/** Real loopback HLS proxy, with controlled upstream responses at the provider boundary. */
async function app(secure = false) {
  const host = await startFakePlaylist();
  dispose.push(() => host.close());
  const responses = new Map<string, () => Response | Promise<Response>>();
  const runtime = runtimeFor(
    Playback.layer({ userAgent, ffmpeg: null }).pipe(
      Layer.provide(PlaybackCoordination.layer),
      Layer.provideMerge(
        Subscriptions.layer({
          dataDir: await tempDir(),
          secrets: testSecrets,
          providerOptions: {
            userAgent,
            fetch: async (input, init) => {
              const url = new URL(String(input));
              const reply = responses.get(url.pathname.split("/").at(-1)!);
              if (reply) return reply();
              const answer = await fetch(
                secure ? `${host.origin}${url.pathname}${url.search}` : input,
                init,
              );
              return secure && url.pathname === "/playlist.m3u"
                ? new Response(
                    (await answer.text()).replaceAll(host.origin, "https://playlist.test"),
                  )
                : secure
                  ? new Response(answer.body, { status: answer.status, headers: answer.headers })
                  : answer;
            },
          },
        }),
      ),
    ),
  );
  dispose.push(() => runtime.dispose());
  const subscriptions = await promised(runtime, Subscriptions);
  const { id: subscriptionId } = await subscriptions.add({
    server: secure ? host.link.replace(host.origin, "https://playlist.test") : host.link,
    username: "",
    password: "",
  });
  const playback = await promised(runtime, Playback);
  const session = await playback.open({ subscriptionId, id: PLAYLIST_CHANNELS.tracks.id }, [
    "h264",
    "aac",
  ]);
  const master = await (await fetch(session.url)).text();
  const video = master.split("\n").find((line) => line.trim() && !line.startsWith("#"))!;
  const audio = /NAME="English".*URI="([^"]+)"/.exec(master)![1]!;
  const segments = (await (await fetch(video)).text())
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"));
  const failure = (url: string | null) =>
    playback.failure(session.sessionId, {
      kind: "hls",
      requestId: url ? new URL(url).pathname : null,
    });
  return { playback, session, responses, video, audio, segments, failure };
}

it.each([403, 404])(
  "keeps the current HLS %i cause through unrelated playlist and segment successes",
  async (status) => {
    const { responses, segments, video, audio, failure, session } = await app();
    responses.set("video-0.mpegts", () => new Response(null, { status }));
    expect((await fetch(segments[0]!)).status).toBe(status);
    await (await fetch(audio)).text();
    await (await fetch(video)).text();
    await (await fetch(segments[1]!)).arrayBuffer();
    expect(await failure(segments[0]!)).toEqual({
      kind: status === 403 ? "refused" : "unavailable",
      status,
    });
    expect(await failure(audio)).toBeNull();
    expect(await failure(null)).toBeNull();
    expect(await failure(session.url)).toBeNull();
  },
);

it.each([403, 404])(
  "ignores an older late %i after a successful retry of the same HLS request",
  async (status) => {
    const { responses, segments, failure } = await app();
    const old = Promise.withResolvers<Response>();
    const entered = Promise.withResolvers<void>();
    responses.set("video-0.mpegts", () => {
      entered.resolve();
      return old.promise;
    });
    const pending = fetch(segments[0]!);
    try {
      await entered.promise;
      responses.delete("video-0.mpegts");
      await (await fetch(segments[0]!)).arrayBuffer();
      old.resolve(new Response(null, { status }));
      expect((await pending).status).toBe(status);
      expect(await failure(segments[0]!)).toBeNull();
    } finally {
      old.resolve(new Response(null, { status }));
    }
  },
);

it("does not let an older successful HLS response erase a newer refusal", async () => {
  const { responses, segments, failure } = await app();
  const old = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  responses.set("video-0.mpegts", () => {
    entered.resolve();
    return old.promise;
  });
  const pending = fetch(segments[0]!);
  try {
    await entered.promise;
    responses.set("video-0.mpegts", () => new Response(null, { status: 403 }));
    expect((await fetch(segments[0]!)).status).toBe(403);
    old.resolve(new Response(new Uint8Array(128)));
    await (await pending).arrayBuffer();
    expect(await failure(segments[0]!)).toEqual({ kind: "refused", status: 403 });
  } finally {
    old.resolve(new Response(null, { status: 404 }));
  }
});

it("keeps a root manifest refusal selectable while rejecting subtitle, foreign and unissued paths", async () => {
  const { responses, session, playback, failure } = await app();
  responses.set("master.m3u8", () => new Response(null, { status: 403 }));
  expect((await fetch(session.url)).status).toBe(403);
  expect(await failure(session.url)).toEqual({ kind: "refused", status: 403 });
  for (const requestId of [
    "/stream/other.m3u8",
    new URL(session.url).pathname.replace(".m3u8", "/zzzzzz"),
    new URL(session.url).pathname.replace(".m3u8", "/subs-0"),
  ]) {
    expect(await playback.failure(session.sessionId, { kind: "hls", requestId })).toBeNull();
  }
});

it.each(["root", "segment"] as const)(
  "preserves the typed credential refusal for the fatal HLS %s request",
  async (target) => {
    const { responses, session, segments, failure } = await app();
    const url = target === "root" ? session.url : segments[0]!;
    responses.set(
      target === "root" ? "master.m3u8" : "video-0.mpegts",
      () => new Response(null, { status: 401 }),
    );
    expect((await fetch(url)).status).toBe(401);
    expect(await failure(url)).toEqual({ kind: "refused", status: 401 });
    expect(await failure(null)).toBeNull();
  },
);

it.each(["root", "segment"] as const)(
  "preserves HTTPS credential protection on the fatal HLS %s request",
  async (target) => {
    const { responses, session, segments, failure } = await app(true);
    const url = target === "root" ? session.url : segments[0]!;
    responses.set(
      target === "root" ? "master.m3u8" : "video-0.mpegts",
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://relay.test/stream?token=t0k3n" },
        }),
    );
    expect((await fetch(url)).status).toBe(502);
    const cause = await failure(url);
    expect(cause).toMatchObject({
      kind: "network",
      detail: expect.stringContaining("unencrypted"),
    });
    expect(JSON.stringify(cause)).not.toContain("t0k3n");
    expect(await failure(null)).toBeNull();
  },
);

it("keeps current failures through unrelated discovery that expires old segment addresses", async () => {
  const { responses, segments, video, audio, failure } = await app();
  responses.set("video-0.mpegts", () => new Response(null, { status: 404 }));
  responses.set("sound-en.m3u8", () => new Response(null, { status: 403 }));
  expect((await fetch(segments[0]!)).status).toBe(404);
  expect((await fetch(audio)).status).toBe(403);
  responses.set(
    "video.m3u8",
    () =>
      new Response(
        [
          "#EXTM3U",
          "#EXT-X-TARGETDURATION:4",
          ...Array.from({ length: 10_002 }, (_, i) => `#EXTINF:4,\nnew-${i}.mpegts`),
        ].join("\n"),
      ),
  );
  const current = (await (await fetch(video)).text())
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("#"));
  expect(await failure(segments[0]!)).toEqual({ kind: "unavailable", status: 404 });
  expect((await fetch(segments[0]!)).status).toBe(410);
  expect(await failure(segments[0]!)).toBeNull();
  expect(await failure(audio)).toEqual({ kind: "refused", status: 403 });
  expect((await fetch(current.at(-1)!)).status).toBe(404);
  expect(await failure(current.at(-1)!)).toEqual({ kind: "unavailable", status: 404 });
});

it("does not lend a previous attempt's HTTP cause to a pending HLS retry", async () => {
  const { responses, segments, failure } = await app();
  const url = segments[0]!;
  responses.set("video-0.mpegts", () => new Response(null, { status: 404 }));
  expect((await fetch(url)).status).toBe(404);
  expect(await failure(url)).toEqual({ kind: "unavailable", status: 404 });
  const reply = Promise.withResolvers<Response>();
  const entered = Promise.withResolvers<void>();
  responses.set("video-0.mpegts", () => {
    entered.resolve();
    return reply.promise;
  });
  const pending = fetch(url);
  try {
    await entered.promise;
    // hls.js may time out or abort this attempt before the proxy receives any HTTP answer.
    expect(await failure(url)).toBeNull();
  } finally {
    reply.resolve(new Response(null, { status: 503 }));
    await pending;
  }
  expect(await failure(url)).toEqual({ kind: "provider-error", status: 503 });
});
