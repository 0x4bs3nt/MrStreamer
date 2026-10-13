import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture } from "./fake-provider.ts";
import { promised, runtimeFor, tempDir, testConfig, userAgent } from "./support.ts";

const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** One URL serves different movie files according to each playlist entry's required headers. */
async function host(unsupportedHeaders = false) {
  let origin = "";
  let refused = 0;
  const requests: { agent: string; range: string | undefined }[] = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/list")) {
      return response.end(
        [
          "#EXTM3U",
          ...["Twelve", "Twenty"].flatMap((name) => [
            `#EXTINF:-1 group-title="Films",${name}`,
            `#EXTVLCOPT:http-user-agent=${unsupportedHeaders && name === "Twelve" ? "Player ’One’" : name}`,
            `#EXTVLCOPT:http-referrer=${origin}/${unsupportedHeaders && name === "Twelve" ? "’" : name}`,
            `${origin}/same.mp4`,
          ]),
          "",
        ].join("\n"),
      );
    }
    const agent =
      unsupportedHeaders && request.headers["user-agent"] === userAgent
        ? "Twelve"
        : request.headers["user-agent"];
    const referer = unsupportedHeaders && agent === "Twelve" ? undefined : `${origin}/${agent}`;
    if (
      request.url !== "/same.mp4" ||
      (agent !== "Twelve" && agent !== "Twenty") ||
      request.headers.referer !== referer
    ) {
      refused++;
      return response.writeHead(403).end();
    }
    requests.push({ agent, range: request.headers.range });
    const body = fixture(agent === "Twelve" ? "title-h264-aac.mp4" : "title-h264-eac3-subs.mkv");
    const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    if (start >= body.length) return response.writeHead(416).end();
    response.writeHead(range ? 206 : 200, {
      "Content-Type": agent === "Twelve" ? "video/mp4" : "video/x-matroska",
      "Content-Length": end - start + 1,
      "Accept-Ranges": "bytes",
      ETag: `"${agent}"`,
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${body.length}` } : {}),
    });
    response.end(body.subarray(start, end + 1));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { link: `${origin}/list?token=fake`, requests, refused: () => refused };
}

async function started(dir: string) {
  const runtime = runtimeFor(mainLayer({ ...testConfig(dir), ffmpeg: FFMPEG, ffprobe: FFPROBE }));
  return {
    runtime,
    subscriptions: await promised(runtime, Subscriptions),
    titles: await promised(runtime, OnDemand),
    playback: await promised(runtime, Playback),
  };
}

async function mapped(provider: Awaited<ReturnType<typeof host>>, dir: string) {
  const app = await started(dir);
  const saved = await app.subscriptions.add({ server: provider.link, username: "", password: "" });
  await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Films"), "movie");
  await app.titles.refresh(saved.id);
  const source = (await app.subscriptions.sources())[0]!;
  const catalogue = await source.provider.onDemandCatalogue();
  const refs = catalogue.movies.map((movie): TitleRef => ({
    kind: "movie",
    subscriptionId: saved.id,
    id: movie.id,
  }));
  expect(refs).toHaveLength(2);
  return { app, refs };
}

describe.skipIf(!hasTools)("mapped playlist file playback", () => {
  it("drops unsupported playlist header characters and opens the title with safe HTTP defaults", async () => {
    const provider = await host(true);
    const { app, refs } = await mapped(provider, await tempDir());
    const file = await app.titles.file(refs[0]!);
    const session = await app.playback.openTitle(refs[0]!, file.url, ["h264", "aac"], file);
    expect(session.duration).toBeCloseTo(12, 0);
    const answer = await fetch(session.url);
    expect(answer.ok).toBe(true);
    expect((await answer.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    await app.playback.close(session.sessionId);
    expect(provider.refused()).toBe(0);
    expect(provider.requests.some((request) => request.agent === "Twelve" && request.range)).toBe(
      true,
    );
  }, 30_000);

  it("rehydrates exact headers after restart and keeps same-URL versions' tracks separate", async () => {
    const provider = await host();
    const dir = await tempDir();
    const { app: first, refs } = await mapped(provider, dir);
    await first.runtime.dispose();
    const app = await started(dir);
    const sessions = [];
    for (const ref of refs) {
      const file = await app.titles.file(ref);
      // E-AC-3 too, so the second version's sound plays as it is.
      const session = await app.playback.openTitle(ref, file.url, ["h264", "aac", "eac3"], file);
      sessions.push(session);
      expect(session.url).not.toContain("same.mp4");
      const answer = await fetch(`${session.url}?start=1`);
      expect(answer.ok).toBe(true);
      expect((await answer.arrayBuffer()).byteLength).toBeGreaterThan(1000);
      await app.playback.close(session.sessionId);
    }
    expect(sessions[0]?.duration).toBeCloseTo(12, 0);
    expect(sessions[0]?.subtitles).toHaveLength(1);
    expect(sessions[1]?.duration).toBeCloseTo(20, 0);
    expect(sessions[1]?.subtitles).toHaveLength(2);
    expect(provider.refused()).toBe(0);
    for (const agent of ["Twelve", "Twenty"])
      expect(provider.requests.some((request) => request.agent === agent && request.range)).toBe(
        true,
      );
  }, 30_000);

  it("uses the receiver's exact version headers and probe after another version played locally", async () => {
    const provider = await host();
    const { app, refs } = await mapped(provider, await tempDir());
    const first = await app.titles.file(refs[0]!);
    const local = await app.playback.openTitle(refs[0]!, first.url, ["h264", "aac"], first);
    expect(local.duration).toBeCloseTo(12, 0);
    const second = await app.titles.file(refs[1]!);
    const receiver = await app.playback.openReceiverTitle(
      refs[1]!,
      second.url,
      { address: "127.0.0.1", decoders: ["h264", "aac"] },
      second,
    );
    expect(receiver.duration).toBeCloseTo(20, 0);
    expect(receiver.subtitles).toHaveLength(2);
    const loaded = await app.playback.loadReceiverTitle(receiver.sessionId, {
      audio: receiver.audio[0]?.id ?? null,
      subtitle: null,
    });
    expect(loaded).not.toBeNull();
    const master = await (await fetch(loaded!.url)).text();
    const media = master.split("\n").find((line) => line && !line.startsWith("#"))!;
    const playlistUrl = new URL(media, loaded!.url);
    const playlist = await (await fetch(playlistUrl)).text();
    const segment = playlist.split("\n").find((line) => line && !line.startsWith("#"))!;
    const answer = await fetch(new URL(segment, playlistUrl));
    expect(answer.ok).toBe(true);
    expect((await answer.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect(provider.refused()).toBe(0);
    expect(provider.requests.some((request) => request.agent === "Twenty" && request.range)).toBe(
      true,
    );
  }, 30_000);
});
