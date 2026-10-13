import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import { seriesEpisodeOrder, seriesEpisodeSeasons } from "@mrstreamer/core/ondemand/details";
import { playlistGroupId } from "@mrstreamer/core/playlist/import";
import { mainLayer } from "../src/main/runtime.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Library } from "../src/main/services/library.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Roster } from "../src/main/services/roster.ts";
import { VerifiedFiles } from "../src/main/platform/verified-files.ts";
import { Watchlist } from "../src/main/services/watchlist.ts";
import { promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});
async function host() {
  let body = "";
  let status = 200;
  let requests = 0;
  let held: { arrived: () => void; release: Promise<void> } | null = null;
  const server = createServer(async (request, response) => {
    if (!request.url?.startsWith("/list")) return response.writeHead(404).end();
    requests++;
    const sent = body;
    const waiting = held;
    held = null;
    waiting?.arrived();
    await waiting?.release;
    response.writeHead(status).end(sent);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const list = (suffix = "one", extra = "") =>
    `#EXTM3U\n#EXTINF:-1 group-title="News",News\n${origin}/live.ts\n#EXTINF:-1 group-title="Films" tmdb-id="42",Film\n#EXTVLCOPT:http-user-agent=FilmAgent\n#EXTVLCOPT:http-referrer=${origin}/\n${origin}/${suffix}.mp4\n${extra}`;
  body = list();
  return {
    link: `${origin}/list?token=fake`,
    origin,
    requests: () => requests,
    list,
    set: (next: string) => {
      body = next;
      status = 200;
    },
    fail: () => {
      status = 503;
    },
    hold: () => {
      const arrived = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      held = { arrived: arrived.resolve, release: release.promise };
      return { arrived: arrived.promise, release: release.resolve };
    },
  };
}
/** The app's services on `dir`, as a start of the app has them, on a test clock if asked. */
async function started(dir: string, { testClock = false } = {}) {
  const services = mainLayer(testConfig(dir));
  const runtime = runtimeFor(
    testClock
      ? services.pipe(Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" })))
      : services,
  );
  return {
    runtime,
    subscriptions: await promised(runtime, Subscriptions),
    library: await promised(runtime, Library),
    titles: await promised(runtime, OnDemand),
    viewing: await promised(runtime, ViewingRecord),
    roster: await promised(runtime, Roster),
    watchlist: await promised(runtime, Watchlist),
  };
}
/** Moves the app's test clock on a second at a time until `pending` settles. */
async function passTime(
  runtime: Awaited<ReturnType<typeof started>>["runtime"],
  pending: Promise<unknown>,
): Promise<void> {
  let settled = false;
  const done = pending.finally(() => {
    settled = true;
  });
  while (!settled) {
    await runtime.runPromise(TestClock.adjust("1 second"));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await done;
}
const login = (link: string) => ({ server: link, username: "", password: "" });
const films = playlistGroupId("Films");

describe("saved M3U movie mapping", () => {
  // Each limit a source can pass, entries, bytes and groups, is the provider's: see
  // playlist-limits.test.ts. Here, one source over a limit stands for all of them.
  it("rejects the first mapping of an oversized source without saving a choice or losing Live after restart", async () => {
    const provider = await host();
    const row = `#EXTINF:-1 tvg-id="news" group-title="News",News\n${provider.origin}/live.ts\n`;
    const names = Array.from({ length: 10_000 }, (_, at) => `Group ${at}`).join(";");
    provider.set(
      `#EXTM3U\n${row}#EXTINF:-1 group-title="${names}",Other\n${provider.origin}/other.ts\n`,
    );
    const dir = await tempDir();
    const app = await started(dir);
    const saved = await app.subscriptions.add(login(provider.link));
    const before = (await app.subscriptions.sources())[0]!;
    const failure = {
      error: { kind: "unexpected", detail: expect.stringContaining("10,000 groups") },
    };
    // A first pick is checked even without opening the mapping report or loading Live first.
    await expect(
      app.subscriptions.mapPlaylist(saved.id, playlistGroupId("News"), "movie"),
    ).rejects.toMatchObject(failure);
    await app.roster.refreshPlaylist(saved.id);
    const channels = await app.library.channels({});
    expect(channels.some((channel) => channel.id === "news")).toBe(true);
    await expect(app.subscriptions.playlistGroups(saved.id, "", 0, 20)).rejects.toMatchObject(
      failure,
    );
    await expect(
      app.subscriptions.mapPlaylist(saved.id, playlistGroupId("News"), "movie"),
    ).rejects.toMatchObject(failure);
    expect((await app.subscriptions.list())[0]?.playlistMapped).toBe(false);
    expect(JSON.parse(await readFile(join(dir, "subscription.json"), "utf8"))).not.toHaveProperty(
      "mapping",
    );
    expect(await app.subscriptions.stands(before)).toBe(true);
    expect(
      await (await app.subscriptions.sourceOf(saved.id)).provider.liveStream("news"),
    ).toMatchObject({ url: `${provider.origin}/live.ts` });
    await app.runtime.dispose();
    const restarted = await started(dir);
    expect((await restarted.subscriptions.list())[0]?.playlistMapped).toBe(false);
    expect(await restarted.library.channels({})).toEqual(channels);
    expect(
      await (await restarted.subscriptions.sourceOf(saved.id)).provider.liveStream("news"),
    ).toMatchObject({ url: `${provider.origin}/live.ts` });
    await restarted.roster.refreshPlaylist(saved.id);
    expect(await restarted.library.channels({})).toEqual(channels);
  }, 15_000);

  it.each(["independent", "combined"] as const)(
    "keeps unmapped Live lists after an empty or unconfirmed short %s refresh",
    async (mode) => {
      const provider = await host();
      const rows = Array.from(
        { length: 20 },
        (_, at) => `#EXTINF:-1 group-title="News",Channel ${at}\n${provider.origin}/${at}.ts`,
      );
      const full = `#EXTM3U\n${rows.join("\n")}\n`;
      provider.set(full);
      // The seconds before a short list is fetched again to confirm it pass on a test clock.
      const app = await started(await tempDir(), { testClock: true });
      const saved = await app.subscriptions.add(login(provider.link));
      const refresh = () =>
        mode === "combined" ? app.roster.refreshPlaylist(saved.id) : app.library.refresh(saved.id);
      await refresh();
      expect(await app.library.channels({})).toHaveLength(20);
      provider.set("#EXTM3U\n");
      await expect(refresh()).rejects.toMatchObject({
        error: { kind: "incomplete-catalogue", received: 0, previous: 20 },
      });
      expect(await app.library.channels({})).toHaveLength(20);

      provider.set(`#EXTM3U\n${rows.slice(0, 2).join("\n")}\n`);
      const held = provider.hold();
      const rejected = expect(refresh()).rejects.toMatchObject({
        error: { kind: "incomplete-catalogue", received: 2, previous: 20 },
      });
      await held.arrived;
      provider.set(full);
      held.release();
      await passTime(app.runtime, rejected);
      expect(await app.library.channels({})).toHaveLength(20);
      expect((await app.library.status())[0]?.failure?.kind).toBe("incomplete-catalogue");
      expect((await app.subscriptions.list())[0]?.playlistMapped).toBe(false);
    },
    15_000,
  );

  it("saves mapped movies and series, aligns renamed versions, and keeps removable entries after remapping and restart", async () => {
    const provider = await host();
    const shows = `#EXTINF:-1 group-title="Shows",Show S01E01\n${provider.origin}/show.mp4\n`;
    provider.set(provider.list("one", shows));
    const dir = await tempDir();
    const app = await started(dir);
    const saved = await app.subscriptions.add(login(provider.link));
    const unmapped = await app.subscriptions.add(login(`${provider.link}&other=1`));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
    await app.roster.refreshPlaylist(saved.id);
    const query = { id: "all" as const, offset: 0, limit: 20 };
    const movie = (await app.titles.collection({ ...query, kind: "movie" })).titles[0]!;
    const series = (await app.titles.collection({ ...query, kind: "series" })).titles[0]!;
    const filmEntry = await app.watchlist.save("movie", movie);
    const seriesEntry = await app.watchlist.save("series", series);
    const page = { sort: "title" as const, offset: 0, limit: 20 };
    const before = await app.watchlist.list(page);
    expect(before.total).toBe(2);
    expect(before.entries).toMatchObject([
      { ...filmEntry, kind: "movie", name: "Film", title: { id: movie.id } },
      { ...seriesEntry, kind: "series", name: "Show", title: { id: series.id } },
    ]);
    expect(await app.watchlist.saved("movie", movie)).toEqual(filmEntry);
    await expect(
      app.watchlist.save("movie", { subscriptionId: unmapped.id, id: movie.id }),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });

    // Explicit TMDB identity follows a replacement version; the entry keeps its id and time.
    provider.set(provider.list("restored", shows).replace(",Film\n", ",Restored film\n"));
    await app.roster.refreshPlaylist(saved.id);
    const restored = (await app.titles.collection({ ...query, kind: "movie" })).titles[0]!;
    expect(restored.id).not.toBe(movie.id);
    expect(await app.watchlist.saved("movie", restored)).toEqual(filmEntry);
    expect((await app.watchlist.list(page)).entries[0]).toMatchObject({
      ...filmEntry,
      name: "Restored film",
      savedAt: before.entries[0]!.savedAt,
      title: { id: restored.id },
    });

    // Live and Skip choices still mean a mapped subscription, so saved entries remain available
    // to remove even when its catalogue has no titles left.
    await app.subscriptions.mapPlaylist(saved.id, films, "live");
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "skip");
    await app.roster.refreshPlaylist(saved.id);
    const without = await app.watchlist.list(page);
    expect(without.entries).toMatchObject([
      { ...filmEntry, name: "Restored film", title: null, listed: true },
      { ...seriesEntry, name: "Show", title: null, listed: true },
    ]);
    await app.runtime.dispose();
    const restarted = await started(dir);
    expect(await restarted.watchlist.list(page)).toEqual(without);
    await restarted.watchlist.remove(filmEntry);
    await restarted.watchlist.remove(seriesEntry);
    expect(await restarted.watchlist.list(page)).toEqual({ total: 0, entries: [] });
  }, 15_000);

  it("leaves HLS movies and episodes out with their reasons while keeping HLS Live", async () => {
    const provider = await host();
    provider.set(
      `#EXTM3U\n#EXTINF:-1 group-title="News",Live HLS\n${provider.origin}/live.m3u8\n` +
        `#EXTINF:-1 group-title="Films",HLS film\n${provider.origin}/film.m3u8\n` +
        `#EXTINF:-1 group-title="Shows",HLS show S01E01\n${provider.origin}/episode.m3u8\n` +
        `#EXTINF:-1 group-title="Films",File film\n${provider.origin}/film.mp4\n` +
        `#EXTINF:-1 group-title="Shows",File show S01E01\n${provider.origin}/episode.mp4\n`,
    );
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
    await app.roster.refreshPlaylist(saved.id);
    expect((await app.library.channels({})).map((channel) => channel.name)).toEqual(["Live HLS"]);
    expect((await app.titles.status()).lists[0]).toMatchObject({ movies: 1, series: 1 });
    const query = { id: "all" as const, offset: 0, limit: 20 };
    expect(
      (await app.titles.collection({ ...query, kind: "movie" })).titles.map((title) => title.title),
    ).toEqual(["File film"]);
    expect(
      (await app.titles.collection({ ...query, kind: "series" })).titles.map(
        (title) => title.title,
      ),
    ).toEqual(["File show"]);
    expect((await app.subscriptions.playlistGroups(saved.id, "", 0, 20)).status).toMatchObject({
      live: 1,
      movies: 1,
      series: 1,
      episodes: 1,
      omitted: 2,
    });
    expect((await app.subscriptions.playlistOmissions(saved.id, 0, 20)).entries).toEqual([
      { name: "HLS film", groups: ["Films"], reason: "unsupported-address" },
      { name: "HLS show S01E01", groups: ["Shows"], reason: "unsupported-address" },
    ]);
  });

  it("joins a titles query to the combined snapshot while other subscriptions occupy both title slots", async () => {
    const app = await started(await tempDir());
    const providers = await Promise.all([host(), host(), host()]);
    const saved = [];
    for (const provider of providers) {
      provider.set(provider.list().replace(' tmdb-id="42"', ""));
      const subscription = await app.subscriptions.add(login(provider.link));
      await app.subscriptions.mapPlaylist(subscription.id, films, "movie");
      saved.push(subscription);
    }
    const held = providers.slice(0, 2).map((provider) => provider.hold());
    const blockers = Promise.allSettled(saved.slice(0, 2).map(({ id }) => app.titles.refresh(id)));
    await Promise.all(held.map((request) => request.arrived));
    const target = providers[2]!;
    const targetId = saved[2]!.id;
    const before = target.requests();
    try {
      const combined = app.roster.refreshPlaylist(targetId);
      await vi.waitFor(async () =>
        expect(
          (await app.library.status()).find((status) => status.subscriptionId === targetId)
            ?.channelCount,
        ).toBe(1),
      );
      target.set(
        target.list(
          "changed",
          `#EXTINF:-1 group-title="Films",New film\n${target.origin}/new.mp4\n`,
        ),
      );
      const asked = app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      // The worker answers this status after the query's status read, while both slots are held.
      await app.titles.status();
      for (const request of held) request.release();
      await blockers;
      await combined;
      await asked;
      const page = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      const own = page.titles.filter((title) => title.subscriptionId === targetId);
      expect(own).toHaveLength(1);
      expect(
        await app.titles.file({ kind: "movie", subscriptionId: targetId, id: own[0]!.id }),
      ).toMatchObject({ url: `${target.origin}/one.mp4` });
      expect(target.requests() - before).toBe(1);
    } finally {
      for (const request of held) request.release();
      await blockers;
    }
  });

  it("rejects a stale combined waiter without displacing the new mapping's refresh behind busy title slots", async () => {
    const app = await started(await tempDir());
    const [a, b, queued, target] = await Promise.all([host(), host(), host(), host()]);
    const saved = [];
    for (const provider of [a, b, queued, target]) {
      provider.set(provider.list().replace(' tmdb-id="42"', ""));
      const subscription = await app.subscriptions.add(login(provider.link));
      await app.subscriptions.mapPlaylist(subscription.id, films, "movie");
      saved.push(subscription);
    }
    const aId = saved[0]!.id;
    const bId = saved[1]!.id;
    const queuedId = saved[2]!.id;
    const targetId = saved[3]!.id;
    for (const id of [aId, bId, queuedId]) await app.titles.refresh(id);
    // Keep the mapping pick on the cached import while the title slots are occupied.
    await app.subscriptions.playlistGroups(targetId, "", 0, 10);
    const heldA = a.hold();
    const heldB = b.hold();
    const heldQueued = queued.hold();
    const blockedA = Promise.allSettled([app.titles.refresh(aId)]);
    const blockedB = Promise.allSettled([app.titles.refresh(bId)]);
    await Promise.all([heldA.arrived, heldB.arrived]);
    const independent = Promise.allSettled([app.titles.refresh(targetId)]);
    await app.titles.status();
    const blockedQueued = Promise.allSettled([app.titles.refresh(queuedId)]);
    await app.titles.status();
    let staleFinished = false;
    const stale = Promise.allSettled([app.roster.refreshPlaylist(targetId)]).then((results) => {
      staleFinished = true;
      return results;
    });
    const liveStatus = async () =>
      (await app.library.status()).find((status) => status.subscriptionId === targetId);
    const work: Promise<unknown>[] = [blockedA, blockedB, independent, blockedQueued, stale];
    let heldIndependent: ReturnType<typeof target.hold> | undefined;
    try {
      await vi.waitFor(async () => expect((await liveStatus())?.channelCount).toBe(1));
      await app.subscriptions.mapPlaylist(targetId, playlistGroupId("News"), "skip");
      const before = target.requests();
      const newer = Promise.allSettled([app.roster.refreshPlaylist(targetId)]);
      work.push(newer);
      await vi.waitFor(async () => expect(await liveStatus()).toMatchObject({ channelCount: 0 }));
      heldIndependent = target.hold();
      heldA.release();
      await blockedA;
      await heldIndependent.arrived;
      heldIndependent.release();
      await heldQueued.arrived;
      expect(await independent).toMatchObject([
        {
          status: "rejected",
          reason: { error: { detail: "The subscription changed while loading titles." } },
        },
      ]);
      // The old combined call must reject while the newer owner is still waiting for a slot.
      await vi.waitFor(() => expect(staleFinished).toBe(true));
      expect(await stale).toMatchObject([
        {
          status: "rejected",
          reason: { error: { detail: "The subscription changed while loading titles." } },
        },
      ]);
      target.set(
        target.list(
          "changed",
          `#EXTINF:-1 group-title="Films",New film\n${target.origin}/new.mp4\n`,
        ),
      );
      const asked = app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      work.push(asked);
      // The worker has answered the query's status read before releasing either remaining slot.
      await app.titles.status();
      heldB.release();
      heldQueued.release();
      expect(await newer).toMatchObject([{ status: "fulfilled" }]);
      await asked;
      const page = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      const own = page.titles.filter((title) => title.subscriptionId === targetId);
      expect(own.map((title) => title.name)).toEqual(["Film"]);
      expect(
        await app.titles.file({ kind: "movie", subscriptionId: targetId, id: own[0]!.id }),
      ).toMatchObject({ url: `${target.origin}/one.mp4` });
      expect(target.requests() - before).toBe(2);
      expect(await liveStatus()).toMatchObject({ channelCount: 0, failure: null });
      expect(
        (await app.titles.status()).lists.find((status) => status.subscriptionId === targetId),
      ).toMatchObject({ movies: 1, failure: null });
    } finally {
      heldIndependent?.release();
      heldA.release();
      heldB.release();
      heldQueued.release();
      await Promise.allSettled(work);
    }
  }, 15_000);

  it.each([true, false])(
    "keeps the newer saved mapping when concurrent playlist reads finish newer first, already loaded=%s",
    async (loaded) => {
      const app = await started(await tempDir());
      const provider = await host();
      provider.set(provider.list().replace(' tmdb-id="42"', ""));
      const saved = await app.subscriptions.add(login(provider.link));
      await app.subscriptions.mapPlaylist(saved.id, films, "movie");
      if (loaded) await app.roster.refreshPlaylist(saved.id);
      else await app.subscriptions.playlistGroups(saved.id, "", 0, 10);
      const before = provider.requests();
      const first = provider.hold();
      const older = Promise.allSettled([app.titles.refresh(saved.id)]);
      await first.arrived;
      const work: Promise<unknown>[] = [older];
      let second: ReturnType<typeof provider.hold> | undefined;
      try {
        await app.subscriptions.mapPlaylist(saved.id, films, "skip");
        second = provider.hold();
        const newer = Promise.allSettled([app.roster.refreshPlaylist(saved.id)]);
        work.push(newer);
        await second.arrived;
        // Release both actual provider reads in one turn, with the newer revision first.
        second.release();
        first.release();
        expect(await newer).toMatchObject([{ status: "fulfilled" }]);
        expect(await older).toMatchObject([{ status: "rejected" }]);
        expect((await app.titles.status()).lists[0]).toMatchObject({ movies: 0, failure: null });
        expect(await app.titles.isStale(saved.id, "12 hours")).toBe(false);
        expect(await app.library.channels({})).toHaveLength(1);
        expect((await app.library.status())[0]).toMatchObject({ failure: null });
        expect(
          (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).titles,
        ).toEqual([]);
        expect(provider.requests() - before).toBe(2);
      } finally {
        second?.release();
        first.release();
        await Promise.allSettled(work);
      }
    },
    15_000,
  );

  it.each([false, true])(
    "keeps the later supplied title snapshot at the same source revision, already loaded=%s",
    async (loaded) => {
      const app = await started(await tempDir());
      const provider = await host();
      const saved = await app.subscriptions.add(login(provider.link));
      await app.subscriptions.mapPlaylist(saved.id, films, "movie");
      if (loaded) await app.titles.refresh(saved.id);
      const source = await app.subscriptions.sourceOf(saved.id);
      const first = await source.provider.playlistImport!(undefined, true);
      provider.set(
        provider.list(
          "new",
          `#EXTINF:-1 group-title="Films",New film\n${provider.origin}/new-film.mp4\n`,
        ),
      );
      const second = await source.provider.playlistImport!(undefined, true);
      await Promise.all([
        app.titles.refresh(saved.id, { source, read: Effect.succeed(first) }),
        app.titles.refresh(saved.id, { source, read: Effect.succeed(second) }),
      ]);
      const page = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      expect(page.titles.map((title) => title.name).sort()).toEqual(["Film", "New film"]);
      expect((await app.titles.status()).lists[0]?.movies).toBe(2);
    },
  );

  it("joins an unmapped Live read already running without downloading an unused combined snapshot", async () => {
    const provider = await host();
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    const before = provider.requests();
    const held = provider.hold();
    const independent = app.library.refresh(saved.id);
    await held.arrived;
    const combined = app.roster.refreshPlaylist(saved.id);
    held.release();
    await Promise.all([independent, combined]);
    expect(provider.requests() - before).toBe(1);
    expect(await app.library.channels({})).toHaveLength(2);
    expect((await app.titles.status()).lists).toEqual([]);
  });

  it("keeps one exact playlist snapshot while both list services wait behind other subscriptions", async () => {
    const app = await started(await tempDir());
    const providers = await Promise.all(Array.from({ length: 5 }, () => host()));
    const saved = [];
    for (const provider of providers) {
      // These are distinct synthetic films; an explicit shared TMDB id would join their rows.
      provider.set(provider.list().replace(' tmdb-id="42"', ""));
      const subscription = await app.subscriptions.add(login(provider.link));
      await app.subscriptions.mapPlaylist(subscription.id, films, "movie");
      saved.push(subscription);
    }
    const held = providers.slice(0, 4).map((provider) => provider.hold());
    const blockers = [
      app.library.refresh(saved[0]!.id),
      app.library.refresh(saved[1]!.id),
      app.titles.refresh(saved[2]!.id),
      app.titles.refresh(saved[3]!.id),
    ];
    const stopped = Promise.allSettled(blockers);
    await Promise.all(held.map((request) => request.arrived));
    const target = providers[4]!;
    const targetId = saved[4]!.id;
    const before = target.requests();
    const reading = target.hold();
    try {
      const refreshed = Promise.allSettled([app.roster.refreshPlaylist(targetId)]);
      // Live gets a slot first, downloads one snapshot and publishes it, while both title slots
      // still wait on their own providers. A later provider response must not change this refresh.
      held[0]!.release();
      await blockers[0];
      await reading.arrived;
      target.set(
        target.list(
          "rotated",
          '#EXTINF:-1 group-title="Films",New film\n' + target.origin + "/new.mp4\n",
        ),
      );
      reading.release();
      await vi.waitFor(async () =>
        expect(
          (await app.library.status()).find((status) => status.subscriptionId === targetId)
            ?.channelCount,
        ).toBe(1),
      );
      held[2]!.release();
      const [result] = await refreshed;
      expect(result?.status).toBe("fulfilled");
      expect(target.requests() - before).toBe(1);
      const page = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
      const own = page.titles.filter((title) => title.subscriptionId === targetId);
      expect(own).toHaveLength(1);
      expect(
        await app.titles.file({ kind: "movie", subscriptionId: targetId, id: own[0]!.id }),
      ).toMatchObject({ url: `${target.origin}/one.mp4` });
    } finally {
      reading.release();
      for (const request of held) request.release();
      await stopped;
    }
    expect((await stopped).every((result) => result.status === "fulfilled")).toBe(true);
  }, 15_000);

  it("refreshes live and mapped titles from one read and reports failure for both while keeping prior lists", async () => {
    const provider = await host();
    provider.set(
      provider.list(
        "one",
        `#EXTINF:-1 group-title="Shows",Show S01E01\n${provider.origin}/show.mp4\n`,
      ),
    );
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
    const before = provider.requests();
    await app.roster.refreshPlaylist(saved.id);
    expect(provider.requests() - before).toBe(1);
    expect(await app.library.channels({})).toHaveLength(1);
    expect((await app.titles.status()).lists[0]?.movies).toBe(1);
    const oldMovie = (
      await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })
    ).titles[0]!;
    await app.titles.details("movie", oldMovie);
    const oldSeries = (
      await app.titles.collection({ kind: "series", id: "all", offset: 0, limit: 20 })
    ).titles[0]!;
    const details = await app.titles.details("series", oldSeries);
    if (details.kind !== "series") throw new Error("No series");
    const episode = seriesEpisodeOrder(details)[0]!;
    const file = {
      kind: "episode" as const,
      subscriptionId: saved.id,
      id: episode.id,
      seriesId: oldSeries.id,
      season: episode.season,
      episode: episode.number,
    };
    await app.titles.file(file);
    provider.fail();
    await expect(app.roster.refreshPlaylist(saved.id)).rejects.toBeDefined();
    expect((await app.library.status())[0]?.failure?.kind).toBe("provider-error");
    expect((await app.titles.status()).lists[0]?.failure?.kind).toBe("provider-error");
    expect(await app.library.channels({})).toHaveLength(1);
    expect(
      (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(1);
    provider.set("#EXTM3U\n");
    const emptyBefore = provider.requests();
    await app.roster.refreshPlaylist(saved.id);
    expect(provider.requests() - emptyBefore).toBe(1);
    expect(await app.library.channels({})).toHaveLength(0);
    expect((await app.titles.status()).lists[0]).toMatchObject({ movies: 0, series: 0 });
    await expect(app.titles.details("movie", oldMovie)).rejects.toBeDefined();
    await expect(app.titles.details("series", oldSeries)).rejects.toBeDefined();
    await expect(app.titles.file({ ...oldMovie, kind: "movie" })).rejects.toBeDefined();
    await expect(app.titles.file(file)).rejects.toBeDefined();
    expect((await app.subscriptions.playlistGroups(saved.id, "", 0, 20)).status.omitted).toBe(0);
  });

  it("counts full omissions and provides bounded searchable group samples and pages", async () => {
    const provider = await host();
    const rows = Array.from(
      { length: 126 },
      (_, at) => `#EXTINF:-1 group-title="Shows",Unnumbered ${at}\n${provider.origin}/${at}.mp4`,
    );
    provider.set(`#EXTM3U\n${rows.join("\n")}\n`);
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
    const groups = await app.subscriptions.playlistGroups(saved.id, "sho", 0, 200);
    expect(groups.status).toMatchObject({ groups: 1, series: 0, episodes: 0, omitted: 126 });
    expect(groups.groups[0]).toMatchObject({ name: "Shows", entries: 126 });
    expect(groups.groups[0]?.samples).toHaveLength(5);
    expect((await app.subscriptions.playlistGroups(saved.id, "missing", 0, 20)).total).toBe(0);
    const first = await app.subscriptions.playlistOmissions(saved.id, 0, 200);
    const last = await app.subscriptions.playlistOmissions(saved.id, 100, 200);
    expect(first.total).toBe(126);
    expect(first.entries).toHaveLength(100);
    expect(last.entries).toHaveLength(26);
    expect(last.entries.at(-1)).toEqual({
      name: "Unnumbered 125",
      groups: ["Shows"],
      reason: "invalid-episode",
    });
  });

  it("saves one authoritative mapping, restores it after startup, and resolves exact files with stream headers", async () => {
    const provider = await host();
    const dir = await tempDir();
    const app = await started(dir);
    const saved = await app.subscriptions.add(login(provider.link));
    await app.library.refresh(saved.id);
    expect(await app.library.channels({})).toHaveLength(2);
    const before = (await app.subscriptions.sources())[0]!;
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    expect(await app.subscriptions.stands(before)).toBe(false);
    await app.library.refresh(saved.id);
    await app.titles.refresh(saved.id);
    const movies = await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 });
    expect(movies.total).toBe(1);
    const title = movies.titles[0]!;
    const file = await app.titles.file({ kind: "movie", subscriptionId: saved.id, id: title.id });
    expect(file).toMatchObject({
      url: `${provider.origin}/one.mp4`,
      container: "mp4",
      headers: { "User-Agent": "FilmAgent", Referer: `${provider.origin}/` },
    });
    const stored = await readFile(join(dir, "subscription.json"), "utf8");
    expect(stored).toContain('"mapping"');
    expect(stored).not.toContain(provider.link);
    expect(await app.library.channels({})).toHaveLength(1);
    await app.runtime.dispose();
    const restarted = await started(dir);
    expect((await restarted.subscriptions.list())[0]?.playlistMapped).toBe(true);
    expect(
      (await restarted.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 }))
        .titles[0]?.id,
    ).toBe(title.id);
    expect(
      await restarted.titles.file({ kind: "movie", subscriptionId: saved.id, id: title.id }),
    ).toMatchObject({ headers: file.headers, url: file.url });
  }, 20_000);

  it("keeps prior lists on failure, removes missing entries on one successful refresh, including remapping everything", async () => {
    const provider = await host();
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.library.refresh(saved.id);
    await app.titles.refresh(saved.id);
    provider.fail();
    await expect(app.library.refresh(saved.id)).rejects.toBeDefined();
    await expect(app.titles.refresh(saved.id)).rejects.toBeDefined();
    expect(
      (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(1);
    provider.set(provider.list());
    await app.subscriptions.mapPlaylist(saved.id, films, "skip");
    await app.titles.refresh(saved.id);
    expect(
      (await app.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(0);
    await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("News"), "skip");
    await app.library.refresh(saved.id);
    expect(await app.library.channels({})).toHaveLength(0);
  });

  it("refreshes caches after a saved mapping change interrupted before its list refresh", async () => {
    const provider = await host();
    const dir = await tempDir();
    const app = await started(dir);
    const saved = await app.subscriptions.add(login(provider.link));
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    await app.library.refresh(saved.id);
    await app.titles.refresh(saved.id);
    expect(await app.titles.isStale(saved.id, "12 hours")).toBe(false);
    await app.subscriptions.mapPlaylist(saved.id, films, "skip");
    await app.runtime.dispose();
    const restarted = await started(dir);
    expect(await restarted.library.isStale(saved.id, "12 hours")).toBe(true);
    expect(await restarted.titles.isStale(saved.id, "12 hours")).toBe(true);
    // Prior data remains reachable while the changed source refreshes.
    expect(
      (await restarted.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(1);
    await restarted.titles.refresh(saved.id);
    expect(
      (await restarted.titles.collection({ kind: "movie", id: "all", offset: 0, limit: 20 })).total,
    ).toBe(0);
  }, 15_000);

  it("drops stale work after a mapping change and preserves other subscriptions", async () => {
    const provider = await host();
    const app = await started(await tempDir());
    const saved = await app.subscriptions.add(login(provider.link));
    const other = await app.subscriptions.add(login(`${provider.link}&second=1`));
    await app.subscriptions.mapPlaylist(saved.id, films, "live");
    await app.subscriptions.playlistGroups(saved.id, "", 0, 10);
    const waiting = provider.hold();
    const refreshing = app.titles.refresh(saved.id);
    const rejected = expect(refreshing).rejects.toBeDefined();
    await waiting.arrived;
    await app.subscriptions.mapPlaylist(saved.id, films, "movie");
    waiting.release();
    await rejected;
    await app.titles.refresh(saved.id);
    expect(
      (await app.titles.status()).lists.find((each) => each.subscriptionId === saved.id)?.movies,
    ).toBe(1);
    expect(
      (await app.subscriptions.list()).find((each) => each.id === other.id)?.playlistMapped,
    ).toBe(false);
  });
});

it.each(["/index.m3u", "/50%/index.m3u", "/50%25/index.m3u"])(
  "follows credential-free HTTPS to HTTP redirects with ordinary or malformed path %s for unmapped Live",
  async (path) => {
    const { playlistProvider } = await import("../src/main/providers/m3u.ts");
    const requests: string[] = [];
    const provider = playlistProvider(
      { link: `https://example.test${path}` },
      {
        userAgent: "test",
        fetch: async (input) => {
          const address = new URL(String(input));
          requests.push(address.href);
          if (address.protocol === "https:") {
            address.protocol = "http:";
            return new Response(null, { status: 302, headers: { location: address.href } });
          }
          if (address.pathname === path)
            return new Response(
              '#EXTM3U x-tvg-url="https://example.test/guide.xml"\n#EXTINF:-1,Live\nhttps://example.test/50%/index.m3u8\n',
            );
          return new Response("stream or guide");
        },
      },
    );
    expect(await provider.authenticate()).toMatchObject({ state: "active" });
    const catalogue = await provider.liveCatalogue();
    expect(catalogue.channels).toHaveLength(1);
    const stream = await provider.liveStream(catalogue.channels[0]!.id);
    expect((await provider.request(stream.url)).ok).toBe(true);
    expect((await provider.request("https://example.test/50%/segment-0.ts")).ok).toBe(true);
    const guide = await provider.liveGuide();
    expect(guide.kind).toBe("document");
    if (guide.kind === "document") await guide.body.cancel();
    expect(requests).toContain(`http://example.test${path}`);
    expect(requests).toContain("http://example.test/50%/index.m3u8");
    expect(requests).toContain("http://example.test/guide.xml");
  },
);

it.each([
  "https://player:synthetic-password@example.test/film.mp4",
  "https://player%:synthetic-password@example.test/film.mp4",
])("protects a file's userinfo even when its percent encoding is malformed", async (url) => {
  const { playlistProvider } = await import("../src/main/providers/m3u.ts");
  const requests: string[] = [];
  const provider = playlistProvider(
    {
      link: "https://example.test/list",
      mapping: { version: 1, groups: [{ group: films, mode: "movie" }] },
    },
    {
      userAgent: "test",
      fetch: async (input) => {
        if (String(input) === "https://example.test/list")
          return new Response(`#EXTM3U\n#EXTINF:-1 group-title="Films",Film\n${url}\n`);
        requests.push(String(input));
        return new Response(null, {
          status: 302,
          headers: { location: url.replace("https:", "http:") },
        });
      },
    },
  );
  await provider.onDemandCatalogue();
  await expect(provider.request(url)).rejects.toThrow("unencrypted");
  expect(requests).toHaveLength(1);
});

it("bounds playlist headers while retaining the last successful exact file", async () => {
  const { playlistProvider } = await import("../src/main/providers/m3u.ts");
  let body = '#EXTM3U\n#EXTINF:-1 group-title="Films",Film\nhttps://example.test/film.mp4\n';
  const provider = playlistProvider(
    {
      link: "https://example.test/list",
      mapping: { version: 1, groups: [{ group: films, mode: "movie" }] },
    },
    { userAgent: "test", fetch: async () => new Response(body) },
  );
  const catalogue = await provider.onDemandCatalogue();
  const title = catalogue.movies[0]!;
  body = "#EXTM3U " + " ".repeat(65_536) + "\n";
  await expect(provider.authenticate()).rejects.toMatchObject({
    error: { kind: "unexpected", detail: expect.stringContaining("header exceeds") },
  });
  expect(await provider.titleFile("movie", title.id, "mp4")).toMatchObject({
    url: "https://example.test/film.mp4",
  });
});

it("resolves playlist files without probing and protects a file's own redirect credentials", async () => {
  const { playlistProvider } = await import("../src/main/providers/m3u.ts");
  const requests: string[] = [];
  const provider = playlistProvider(
    {
      link: "https://example.test/list",
      mapping: { version: 1, groups: [{ group: films, mode: "movie" }] },
    },
    {
      userAgent: "test",
      fetch: async (input) => {
        const address = String(input);
        requests.push(address);
        if (address === "https://example.test/list")
          return new Response(
            '#EXTM3U\n#EXTINF:-1 group-title="Films",Film\n#EXTVLCOPT:http-user-agent=FilmAgent\nhttps://example.test/film.mp4?token=synthetic-token\n',
          );
        return new Response(null, {
          status: 302,
          headers: { location: "http://example.test/film.mp4?token=synthetic-token" },
        });
      },
    },
  );
  const catalogue = await provider.onDemandCatalogue();
  const file = await provider.titleFile("movie", catalogue.movies[0]!.id, "mp4");
  expect(requests).toEqual(["https://example.test/list"]);
  expect(file.headers).toEqual({ "User-Agent": "FilmAgent" });
  await expect(provider.request(file.url)).rejects.toThrow("unencrypted");
  expect(requests).toHaveLength(2);
});

it("imports series files, resumes the selected exact version after reorder/startup, and leaves replacements unwatched", async () => {
  const provider = await host();
  const dir = await tempDir();
  const rows = [
    `#EXTINF:-1 group-title="Shows",Show S02E03\n${provider.origin}/a.mp4`,
    `#EXTINF:-1 group-title="Shows",Show S01E02\n${provider.origin}/b.mp4`,
    `#EXTINF:-1 group-title="Shows",Show S02E01\n${provider.origin}/c.mp4`,
    `#EXTINF:-1 group-title="Shows",Show S02E03 4K\n#EXTVLCOPT:http-user-agent=AlternateAgent\n${provider.origin}/a.mp4`,
    `#EXTINF:-1 group-title="Shows",Show 1920x1080\n${provider.origin}/uncertain.mp4`,
  ];
  provider.set(`#EXTM3U\n${rows.join("\n")}\n`);
  const app = await started(dir);
  const saved = await app.subscriptions.add(login(provider.link));
  await app.subscriptions.mapPlaylist(saved.id, playlistGroupId("Shows"), "series");
  await app.titles.refresh(saved.id);
  const all = await app.titles.collection({ kind: "series", id: "all", offset: 0, limit: 20 });
  expect(all.total).toBe(1);
  const series = { subscriptionId: saved.id, id: all.titles[0]!.id };
  const details = await app.titles.details("series", series);
  if (details.kind !== "series") throw new Error("No series");
  const order = seriesEpisodeOrder(details);
  expect(order.map((episode) => `${episode.season}:${episode.number}`)).toEqual([
    "2:3",
    "1:2",
    "2:1",
  ]);
  const first = order[0]!;
  const alternate = first.versions![1]!;
  expect(alternate).toMatchObject({ name: "Show S02E03 4K", container: "mp4", listedOrder: 3 });
  expect(alternate.observed).toBeUndefined();
  const exactFile = await app.titles.file({
    kind: "episode",
    subscriptionId: saved.id,
    id: alternate.id,
    seriesId: series.id,
    season: 2,
    episode: 3,
  });
  const [source] = await app.subscriptions.saved();
  if (!source) throw new Error("Expected source");
  const files = await promised(app.runtime, VerifiedFiles);
  await files.remember(source.key, source.fileRevision, {
    kind: "episode",
    id: alternate.id,
    seriesId: series.id,
    fileKey: "observed-alternate",
    listingKey: exactFile.listingKey,
    audio: ["en"],
    subtitles: ["nl"],
  });
  const reads = provider.requests();
  const observed = await app.titles.details("series", series);
  if (observed.kind !== "series") throw new Error("Expected series");
  const observedVersions = seriesEpisodeOrder(observed)[0]!.versions!;
  expect(observedVersions[0]?.observed).toBeUndefined();
  expect(observedVersions[1]?.observed).toEqual({ files: 1, audio: ["en"], subtitles: ["nl"] });
  const season = await app.titles.season(series, 2);
  expect(season[0]?.versions?.[1]?.observed).toEqual({
    files: 1,
    audio: ["en"],
    subtitles: ["nl"],
  });
  expect(provider.requests()).toBe(reads);

  expect((await app.titles.titles("series", [series]))[0]?.versions[0]?.episodeFiles).toContain(
    alternate.id,
  );
  const ref = {
    kind: "episode" as const,
    subscriptionId: saved.id,
    id: alternate.id,
    seriesId: series.id,
    season: 2,
    episode: 3,
  };
  expect(await app.titles.file(ref)).toMatchObject({
    url: `${provider.origin}/a.mp4`,
    headers: { "User-Agent": "AlternateAgent" },
  });
  await app.viewing.recordProgress(randomUUID(), ref, 500, 1000, Date.now());
  await app.viewing.markEpisode(
    randomUUID(),
    { ...ref, id: order[2]!.id, season: 2, episode: 1 },
    true,
  );
  const progress = await app.viewing.episodes(series);
  expect(continuation(details, progress.progress, [])?.episode.id).toBe(alternate.id);
  expect((await app.subscriptions.playlistOmissions(saved.id, 0, 20)).entries).toMatchObject([
    { name: "Show 1920x1080", reason: "invalid-episode" },
  ]);
  // Reorder the playlist without changing versions, then restart on the same persisted files.
  provider.set(`#EXTM3U\n${[rows[2], rows[1], rows[0], rows[3], rows[4]].join("\n")}\n`);
  await app.titles.refresh(saved.id);
  await app.runtime.dispose();
  const restarted = await started(dir);
  const again = await restarted.titles.details("series", series);
  if (again.kind !== "series") throw new Error("No series");
  const standing = await restarted.viewing.episodes(series);
  expect(
    (await restarted.titles.titles("series", [series]))[0]?.versions[0]?.episodeFiles,
  ).toContain(alternate.id);
  expect(continuation(again, standing.progress, [])?.episode.id).toBe(alternate.id);
  // A different exact file of the same episode must start on its own timeline.
  provider.set(
    `#EXTM3U\n${rows
      .slice(0, 3)
      .map((row) => row.replace("a.mp4", "replacement.mp4"))
      .join("\n")}\n`,
  );
  await restarted.titles.refresh(saved.id);
  const replacement = await restarted.titles.details("series", series);
  if (replacement.kind !== "series") throw new Error("No series");
  expect(continuation(replacement, standing.progress, standing.marks)?.resume).toBeUndefined();
  await restarted.viewing.relist(randomUUID(), series, seriesEpisodeSeasons(replacement));
  await restarted.runtime.dispose();
  const replacementStart = await started(dir);
  expect((await replacementStart.viewing.state()).marked[0]?.next).toMatchObject({
    season: 2,
    episode: 3,
    resume: null,
  });
  // Explicit marks are logical watched/unwatched decisions and follow source order.
  const marked = await replacementStart.viewing.markEpisode(
    randomUUID(),
    { ...ref, id: replacement.seasons[0]!.episodes[0]!.id },
    true,
  );
  expect(marked).toBeDefined();
  const viewed = await replacementStart.viewing.state();
  expect(viewed.marked[0]?.next).toMatchObject({ season: 1, episode: 2, resume: null });
}, 15_000);

it.each([false, true])(
  "keeps usable entries with long attributes and many groups, mapped=%s",
  async (mapped) => {
    const { playlistProvider } = await import("../src/main/providers/m3u.ts");
    const names = Array.from({ length: 33 }, (_, at) => `Group ${at}`);
    const address = `https://example.test/long.mp4?signature=${"x".repeat(5000)}`;
    const provider = playlistProvider(
      {
        link: "https://example.test/list",
        ...(mapped
          ? {
              mapping: {
                version: 1 as const,
                groups: names.map((name) => ({
                  group: playlistGroupId(name),
                  mode: "movie" as const,
                })),
              },
            }
          : {}),
      },
      {
        userAgent: "test",
        fetch: async () =>
          new Response(
            [
              "#EXTM3U",
              `#EXTINF:-1 group-title="${names.join(";")}" tvg-logo="data:image/png;base64,${"a".repeat(5000)}",Long film`,
              address,
              `#EXTINF:-1 group-title="${names[0]}",Ordinary film`,
              "https://example.test/ordinary.mp4",
              "",
            ].join("\n"),
          ),
      },
    );
    if (mapped) {
      const catalogue = await provider.onDemandCatalogue();
      expect(catalogue.movies).toHaveLength(2);
      expect((await provider.titleFile("movie", catalogue.movies[0]!.id, "mp4")).url).toBe(address);
    } else {
      const catalogue = await provider.liveCatalogue();
      expect(catalogue.channels).toHaveLength(2);
      expect((await provider.liveStream(catalogue.channels[0]!.id)).url).toBe(address);
    }
  },
);

it.each(["?token=synthetic-token", "?v=1"])(
  "keeps unmapped Live redirect policy for its own query %s",
  async (query) => {
    const { playlistProvider } = await import("../src/main/providers/m3u.ts");
    const url = `https://example.test/live.m3u8${query}`;
    const provider = playlistProvider(
      { link: "https://example.test/list" },
      {
        userAgent: "test",
        fetch: async (input) => {
          if (String(input) === "https://example.test/list")
            return new Response(`#EXTM3U\n#EXTINF:-1,Live\n${url}\n`);
          if (String(input).startsWith("https:"))
            return new Response(null, {
              status: 302,
              headers: { location: `http://example.test/1/live.m3u8${query}` },
            });
          return new Response("stream");
        },
      },
    );
    const catalogue = await provider.liveCatalogue();
    const stream = await provider.liveStream(catalogue.channels[0]!.id);
    expect((await provider.request(stream.url)).ok).toBe(true);
  },
);
