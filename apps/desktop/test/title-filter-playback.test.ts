import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Layer from "effect/Layer";
import { mainLayer } from "../src/main/runtime.ts";
import { VerifiedFiles } from "../src/main/platform/verified-files.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { PlaybackCoordination } from "../src/main/services/playback-coordination.ts";
import { Playback } from "../src/main/services/playback.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fixture } from "./fake-provider.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig, userAgent } from "./support.ts";

const FFMPEG = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const FFPROBE = FFMPEG === "ffmpeg" ? "ffprobe" : FFMPEG.replace(/ffmpeg(\.exe)?$/, "ffprobe$1");
const hasTools =
  spawnSync(FFMPEG, ["-version"]).status === 0 && spawnSync(FFPROBE, ["-version"]).status === 0;
const decoders = ["h264", "aac", "mp3", "opus", "flac"] as const;

afterEach(() => vi.restoreAllMocks());

/** Hold a real file response before playback receives it, without delaying account checks. */
function fileResponses(origin: string) {
  const request = fetch;
  let next: { arrived: () => void; released: Promise<void> } | null = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const held = url.origin === origin && url.pathname.startsWith("/files/") ? next : null;
    if (held) next = null;
    const response = await request(input, init);
    held?.arrived();
    await held?.released;
    return response;
  });
  return {
    hold() {
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      next = { arrived: arrived.resolve, released: released.promise };
      return { arrived: arrived.promise, release: released.resolve };
    },
  };
}

async function start(dir: string) {
  const runtime = runtimeFor(mainLayer({ ...testConfig(dir), ffmpeg: FFMPEG, ffprobe: FFPROBE }));
  return {
    runtime,
    subscriptions: await promised(runtime, Subscriptions),
    titles: await promised(runtime, OnDemand),
    playback: await promised(runtime, Playback),
    files: await promised(runtime, VerifiedFiles),
  };
}

async function connected() {
  const provider = await fakeProvider({ titles: 1, maxConnections: 2, slotReleaseMs: 0 });
  const gates = fileResponses(provider.url);
  const dir = await tempDir();
  const app = await start(dir);
  const saved = await app.subscriptions.add({
    server: provider.url,
    username: "demo",
    password: "demo",
  });
  await app.titles.refresh(saved.id);
  const movie = provider.titles.movies.find((title) =>
    title.name.startsWith("TEST | Long subtitles"),
  );
  if (!movie) throw new Error("Expected fixture movie");
  const ref = { kind: "movie" as const, subscriptionId: saved.id, id: String(movie.id) };
  const open = async (playback = app.playback, turn?: number) => {
    const file = await app.titles.file(ref);
    return playback.openTitle(ref, file.url, decoders, {
      ...file,
      ...(turn === undefined ? {} : { turn }),
    });
  };
  const [source] = await app.subscriptions.saved();
  if (!source) throw new Error("Expected saved subscription");
  const facts = () => app.files.read(source.key, source.fileRevision);
  return { ...app, app, dir, provider, movie, gates, ref, open, source, facts };
}

/** Read an actual player run, so the service observes the provider's current file identity. */
async function play(url: string) {
  const response = await fetch(`${url}?start=0`);
  expect(response.status).toBe(200);
  expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
}

describe.skipIf(!hasTools)("playback produces verified filter facts", { timeout: 20000 }, () => {
  it("writes only successful observed tracks, adopts cached probes under a new session id and keeps facts across restart", async () => {
    const app = await connected();
    expect((await app.titles.filterOptions("movie")).verified).toEqual([]);
    const unread = await app.titles.titles("movie", [app.ref]);
    expect(
      unread[0]?.versions.find((version) => version.id === app.ref.id)?.observed,
    ).toBeUndefined();
    const first = await app.open();
    const fileRequests = app.provider.fileRequests();
    const listed = await app.titles.titles("movie", [app.ref]);
    expect(listed[0]?.versions.find((version) => version.id === app.ref.id)).toMatchObject({
      name: app.movie.name,
      observed: { files: 1, audio: [null], subtitles: ["en", "nl", "fr"] },
    });
    expect(app.provider.fileRequests()).toBe(fileRequests);
    expect(await app.facts()).toEqual([
      expect.objectContaining({
        id: app.ref.id,
        fileKey: first.sessionId,
        audio: [null],
        subtitles: ["en", "nl", "fr"],
      }),
    ]);
    const requests = app.provider.fileRequests();
    const cached = await app.open();
    expect(cached.sessionId).not.toBe(first.sessionId);
    expect(app.provider.fileRequests()).toBe(requests);
    expect(await app.facts()).toEqual([expect.objectContaining({ fileKey: cached.sessionId })]);
    expect(await app.titles.filterOptions("movie")).toMatchObject({
      files: 1,
      verified: [
        { kind: "audio", language: "unknown" },
        { kind: "subtitles", language: "en" },
        { kind: "subtitles", language: "fr" },
        { kind: "subtitles", language: "nl" },
      ],
    });
    const before = [
      app.provider.titleListRequests(),
      app.provider.detailRequests(),
      app.provider.fileRequests(),
    ];
    expect(
      (
        await app.titles.searchKind("movie", "Long subtitles", {
          verified: { kind: "audio", language: "unknown" },
        })
      ).titles.map((title) => title.id),
    ).toEqual([app.ref.id]);
    expect([
      app.provider.titleListRequests(),
      app.provider.detailRequests(),
      app.provider.fileRequests(),
    ]).toEqual(before);
    await app.runtime.dispose();
    const restored = await start(app.dir);
    expect(await restored.titles.filterOptions("movie")).toMatchObject({ files: 1 });
    expect(await restored.files.read(app.source.key, app.source.fileRevision)).toEqual([
      expect.objectContaining({ fileKey: cached.sessionId }),
    ]);
    expect([
      app.provider.titleListRequests(),
      app.provider.detailRequests(),
      app.provider.fileRequests(),
    ]).toEqual(before);
    const file = await restored.titles.file(app.ref);
    const fresh = await restored.playback.openTitle(app.ref, file.url, decoders, file);
    expect(app.provider.fileRequests()).toBeGreaterThan(requests);
    expect(await restored.files.read(app.source.key, app.source.fileRevision)).toEqual([
      expect.objectContaining({ fileKey: fresh.sessionId }),
    ]);
  });

  it.each(["new turn", "changed source"] as const)(
    "rejects a late real probe after %s without writing facts",
    async (change) => {
      const app = await connected();
      const turn = await app.playback.begin();
      const held = app.gates.hold();
      const opening = app.open(app.playback, turn);
      // Attach rejection handling before changing the source.
      const settled = opening.then(
        () => null,
        (error: unknown) => error,
      );
      await held.arrived;
      if (change === "new turn") await app.playback.begin();
      else await app.subscriptions.update(app.source.id, { secret: "demo" });
      held.release();
      expect(await settled).toMatchObject({
        error: change === "new turn" ? { kind: "unexpected" } : { kind: "no-subscription" },
      });
      expect(await app.facts()).toEqual([]);
      expect(await app.titles.filterOptions("movie")).toMatchObject({ files: 0, verified: [] });
    },
  );

  it("forgets an observed replacement after a cached open, then probes the replacement on reopening", async () => {
    const app = await connected();
    await app.open();
    const cached = await app.open();
    await play(cached.url);
    app.provider.replaceMovieFile(app.movie.id, "title-mpeg4-mp3.avi");
    await play(cached.url);
    expect(await app.facts()).toEqual([]);
    expect(await app.titles.filterOptions("movie")).toMatchObject({ files: 0, verified: [] });
    const next = await app.open();
    expect(next.subtitles).toEqual([]);
    expect(await app.facts()).toEqual([
      expect.objectContaining({ fileKey: next.sessionId, subtitles: [] }),
    ]);
    expect((await app.titles.filterOptions("movie")).verified).not.toContainEqual({
      kind: "subtitles",
      language: "unknown",
    });
  });

  it("an older session's delayed replacement response cannot erase a newer session's facts", async () => {
    const app = await connected();
    const old = await app.open();
    const corrected = Buffer.from(fixture("title-long-subs.mkv"));
    corrected.write("Ligne longue", corrected.indexOf("Longue ligne"));
    app.provider.replaceMovieFile(app.movie.id, corrected);
    const held = app.gates.hold();
    const reading = play(old.url);
    await held.arrived;
    // A separate public Playback service models another still-running consumer of the same store.
    const newerRuntime = runtimeFor(
      Playback.layer({ userAgent, ffmpeg: FFMPEG, ffprobe: FFPROBE }).pipe(
        Layer.provide(PlaybackCoordination.layer),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Subscriptions, await app.runtime.runPromise(Subscriptions)),
            Layer.succeed(VerifiedFiles, await app.runtime.runPromise(VerifiedFiles)),
          ),
        ),
      ),
    );
    const newer = await app.open(await promised(newerRuntime, Playback));
    const written = await app.facts();
    held.release();
    await reading;
    expect(await app.facts()).toEqual(written);
    expect(written).toEqual([expect.objectContaining({ fileKey: newer.sessionId })]);
    expect(await app.titles.filterOptions("movie")).toMatchObject({ files: 1 });
  });
});
