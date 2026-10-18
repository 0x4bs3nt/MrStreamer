import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { DetailCache } from "../src/main/platform/detail-cache.ts";
import { startFakeTmdb, type FakeTmdb } from "./fake-tmdb.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const remotes: FakeTmdb[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const remote of remotes.splice(0)) await remote.close();
});

async function app({ metadata = false } = {}) {
  const dir = await tempDir();
  const provider = await fakeProvider({ titles: 5 });
  const remote = metadata ? await startFakeTmdb() : null;
  if (remote) remotes.push(remote);
  const start = async (key: string | null = metadata ? "test-key" : null) => {
    const runtime = runtimeFor(
      mainLayer({
        ...testConfig(dir),
        tmdbKey: key,
        ...(remote ? { tmdbApi: remote.url } : {}),
      }).pipe(Layer.provideMerge(TestClock.layer({ warningDelay: "1 day" }))),
    );
    await runtime.runPromise(TestClock.setTime(NOW));
    return {
      runtime,
      service: await promised(runtime, OnDemand),
      subscriptions: await promised(runtime, Subscriptions),
      settings: await promised(runtime, Settings),
      cache: await promised(runtime, DetailCache),
      time: (time: number) => runtime.runPromise(TestClock.setTime(time)),
    };
  };
  const first = await start();
  const login = { server: provider.url, username: "demo", password: "demo" };
  const { id: subscriptionId } = await first.subscriptions.add(login);
  const own = (id: string) => ({ subscriptionId, id });
  const series = own("80000");
  const episode = {
    ...own("81000"),
    kind: "episode",
    seriesId: "80000",
    season: 1,
    episode: 1,
  } as const;
  const movie = own("90000");
  return {
    ...first,
    first,
    start,
    dir,
    provider,
    remote,
    login,
    own,
    series,
    episode,
    movie,
    subscriptionId,
  };
}

/** Hold the real provider response at its fetch boundary, including deliberately late completion. */
function holdDetails() {
  return holdResponse((url) => {
    const action = url.searchParams.get("action");
    return action === "get_series_info" || action === "get_vod_info";
  });
}

function holdResponse(matches: (url: URL) => boolean) {
  const original = globalThis.fetch;
  let pending: { arrived: () => void; release: Promise<void>; aborted: () => void } | undefined;
  vi.stubGlobal("fetch", (async (input, init) => {
    const url = new URL(String(input));
    const gate = matches(url) ? pending : undefined;
    if (gate) pending = undefined;
    const response = await original(input, init);
    if (gate) {
      init?.signal?.addEventListener("abort", gate.aborted, { once: true });
      gate.arrived();
      await gate.release;
    }
    return response;
  }) satisfies typeof fetch);
  return () => {
    const arrived = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let aborted = false;
    pending = {
      arrived: arrived.resolve,
      release: release.promise,
      aborted: () => {
        aborted = true;
      },
    };
    return { arrived: arrived.promise, release: release.resolve, aborted: () => aborted };
  };
}

function episodeIds(
  details: Awaited<ReturnType<Awaited<ReturnType<typeof app>>["service"]["details"]>>,
) {
  if (details.kind !== "series") throw new Error("Expected a series");
  return details.seasons.flatMap((season) => season.episodes.map((episode) => episode.id));
}

describe("persistent opened details through OnDemand", { timeout: 20_000 }, () => {
  it("restores movie, series and season details offline and keyless, without another detail request", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    const season = await a.service.season(a.series, 1);
    await expect
      .poll(async () => (await a.service.details("movie", a.movie)).plot)
      .toMatch(/^TMDB/);
    await expect
      .poll(async () => {
        const { metadata } = await a.service.status();
        return metadata && metadata.wanted > 0 && metadata.known === metadata.wanted;
      })
      .toBe(true);
    const movie = await a.service.details("movie", a.movie);
    await expect
      .poll(async () => (await a.service.details("series", a.series)).plot)
      .toMatch(/^TMDB/);
    const series = await a.service.details("series", a.series);
    const file = await a.service.file(a.episode);
    const counts = [
      a.provider.detailRequests(),
      a.remote!.aboutRequests(),
      a.remote!.seasonRequests().length,
    ];
    expect(counts[0]).toBe(2);
    await a.runtime.dispose();
    a.provider.failDetails(503);
    a.provider.failTitles(503);
    a.remote!.refuse(true);
    const restarted = await a.start(null);
    expect(await restarted.service.details("movie", a.movie)).toEqual(movie);
    expect(await restarted.service.details("series", a.series)).toEqual(series);
    expect(await restarted.service.season(a.series, 1)).toEqual(season);
    expect((await restarted.service.file(a.episode)).listingKey).toBe(file.listingKey);
    expect([
      a.provider.detailRequests(),
      a.remote!.aboutRequests(),
      a.remote!.seasonRequests().length,
    ]).toEqual(counts);
  });

  it("keeps stale display after refresh failure but denies current episode files and subtitle identity", async () => {
    const a = await app();
    const before = await a.service.details("series", a.series);
    const file = await a.service.file(a.episode);
    await a.service.refresh(a.subscriptionId);
    a.provider.failDetails(503);
    expect(episodeIds(await a.service.details("series", a.series))).toEqual(episodeIds(before));
    await expect(a.service.file(a.episode)).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });
    expect(await a.service.subtitleQuery(a.episode, file.listingKey)).toBeNull();
    a.provider.failDetails(null);
    const current = await a.service.file(a.episode);
    expect(current.listingKey).toBe(file.listingKey);
    const title = a.provider.titles.series.find((each) => each.id === 80000)!;
    a.provider.serveTitles((titles) => ({
      ...titles,
      series: titles.series.map((series) =>
        series.id === title.id
          ? {
              ...series,
              seasons: series.seasons.map((season, number) =>
                number === 0
                  ? season.map((episode, index) =>
                      index === 0 ? { ...episode, container: "mp4" } : episode,
                    )
                  : season,
              ),
            }
          : series,
      ),
    }));
    await a.service.refresh(a.subscriptionId);
    expect((await a.service.file(a.episode)).listingKey).not.toBe(file.listingKey);
    expect(await a.service.subtitleQuery(a.episode, file.listingKey)).toBeNull();
  });

  it.each([DAY, -1])(
    "renews provider evidence when its age is due or its clock is in the future (%s)",
    async (age) => {
      const a = await app();
      const before = await a.service.details("series", a.series);
      const file = await a.service.file(a.episode);
      await a.runtime.dispose();
      const next = await a.start();
      await next.time(NOW + age);
      a.provider.failDetails(503);
      expect(episodeIds(await next.service.details("series", a.series))).toEqual(
        episodeIds(before),
      );
      await expect(next.service.file(a.episode)).rejects.toBeDefined();
      expect(await next.service.subtitleQuery(a.episode, file.listingKey)).toBeNull();
      a.provider.failDetails(null);
      await next.service.file(a.episode);
      const requests = a.provider.detailRequests();
      await next.service.details("series", a.series);
      expect(a.provider.detailRequests()).toBe(requests);
    },
  );

  it("does not resurrect an unlisted title from its saved details", async () => {
    const a = await app();
    await a.service.details("series", a.series);
    a.provider.serveTitles((titles) => ({
      ...titles,
      series: titles.series.filter((title) => title.id !== 80000),
    }));
    await a.service.refresh(a.subscriptionId);
    await expect(a.service.details("series", a.series)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(a.service.file(a.episode)).rejects.toBeDefined();
  });

  it("requires current renewal for a legacy catalogue without an acceptance stamp", async () => {
    const a = await app();
    await a.service.details("series", a.series);
    await a.runtime.dispose();
    const path = join(a.dir, "ondemand.json.gz");
    const snapshot = JSON.parse(gunzipSync(await readFile(path)).toString()) as Record<
      string,
      unknown
    >;
    expect(snapshot["catalogueStamp"]).toEqual(expect.any(String));
    delete snapshot["catalogueStamp"];
    await writeFile(path, gzipSync(JSON.stringify(snapshot)));
    a.provider.failDetails(503);
    const next = await a.start();
    expect(episodeIds(await next.service.details("series", a.series))).toContain("81000");
    await expect(next.service.file(a.episode)).rejects.toBeDefined();
    a.provider.failDetails(null);
    await next.service.file(a.episode);
    const requests = a.provider.detailRequests();
    await next.service.file(a.episode);
    expect(a.provider.detailRequests()).toBe(requests);
  });

  it("persists newly opened legacy-profile display data without restoring episode file rights", async () => {
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    await a.runtime.dispose();
    const path = join(a.dir, "ondemand.json.gz");
    const snapshot = JSON.parse(gunzipSync(await readFile(path)).toString()) as Record<
      string,
      unknown
    >;
    delete snapshot["catalogueStamp"];
    await writeFile(path, gzipSync(JSON.stringify(snapshot)));
    const upgraded = await a.start();
    const displayed = await upgraded.service.details("series", a.series);
    await upgraded.runtime.dispose();
    a.provider.failDetails(503);
    const offline = await a.start();
    const requests = a.provider.detailRequests();
    expect(await offline.service.details("series", a.series)).toEqual(displayed);
    expect(await offline.service.season(a.series, 1)).not.toHaveLength(0);
    expect(a.provider.detailRequests()).toBe(requests);
    await expect(offline.service.file(a.episode)).rejects.toBeDefined();
    a.provider.failDetails(null);
    await offline.service.file(a.episode);
    const renewed = a.provider.detailRequests();
    await offline.service.file(a.episode);
    expect(a.provider.detailRequests()).toBe(renewed);
  });

  it("coalesces details and file callers while cancellation detaches one waiter", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const gate = hold();
    const service = await a.runtime.runPromise(OnDemand);
    const waiter = a.runtime.runFork(service.details("series", a.series));
    await gate.arrived;
    const other = a.service.file(a.episode);
    await a.runtime.runPromise(Fiber.interrupt(waiter));
    expect(gate.aborted()).toBe(false);
    gate.release();
    expect((await other).listingKey).toEqual(expect.any(String));
    expect(a.provider.detailRequests()).toBe(1);
  });

  it("aborts every waiter and rejects late work after forget while the source is still saved", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const gate = hold();
    const first = a.service.details("series", a.series).then(
      () => "success",
      () => "cancelled",
    );
    await gate.arrived;
    const second = a.service.file(a.episode).then(
      () => "success",
      () => "cancelled",
    );
    const [source] = await a.subscriptions.saved();
    await a.service.forget(source!);
    expect(await first).toBe("cancelled");
    expect(await second).toBe("cancelled");
    expect(gate.aborted()).toBe(true);
    await expect(a.service.details("series", a.series)).rejects.toBeDefined();
    gate.release();
    const db = new DatabaseSync(join(a.dir, "mrstreamer.db"));
    try {
      expect(
        db
          .prepare("select count(*) as n from title_detail_cache where owner = ?")
          .get(a.subscriptionId)?.["n"],
      ).toBe(0);
    } finally {
      db.close();
    }
  });

  it("aborts replaced-source work, lets its replacement finish, and retries failed flights", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const old = hold();
    const first = a.service.details("series", a.series).then(
      () => "success",
      () => "cancelled",
    );
    await old.arrived;
    await a.subscriptions.add(a.login);
    const replacement = hold();
    const second = a.service.details("series", a.series);
    await replacement.arrived;
    expect(old.aborted()).toBe(true);
    expect(await first).toBe("cancelled");
    old.release();
    const joined = a.service.file(a.episode);
    replacement.release();
    expect(episodeIds(await second)).toContain("81000");
    await joined;
    expect(a.provider.detailRequests()).toBe(2);
    await a.service.refresh(a.subscriptionId);
    a.provider.failDetails(503);
    await expect(a.service.file(a.episode)).rejects.toBeDefined();
    a.provider.failDetails(null);
    await a.service.file(a.episode);
  });

  it("rejects a captured old refresh source without cancelling current detail callers", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const source = await a.subscriptions.sourceOf(a.subscriptionId);
    await a.subscriptions.add(a.login);
    const gate = hold();
    const current = a.service.details("series", a.series).then(
      (details) => ({ details }),
      (error: unknown) => ({ error }),
    );
    await gate.arrived;
    const joined = a.service.file(a.episode).then(
      (file) => ({ file }),
      (error: unknown) => ({ error }),
    );
    // A captured refresh can arrive after its saved source has already been replaced.
    await expect(
      a.service.refresh(a.subscriptionId, { source, read: Effect.never }),
    ).rejects.toMatchObject({ error: { kind: "unexpected" } });
    expect(gate.aborted()).toBe(false);
    gate.release();
    expect(await current).toHaveProperty("details.kind", "series");
    expect(await joined).toHaveProperty("file.listingKey", expect.any(String));
    expect(a.provider.detailRequests()).toBe(1);
    expect((await a.service.file(a.episode)).revision).not.toBe(source.revision);
  });

  it("rejects a response begun before a catalogue acceptance and renews against the new list", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const gate = hold();
    const stale = a.service.file(a.episode).then(
      () => "success",
      () => "rejected",
    );
    await gate.arrived;
    const title = a.provider.titles.series.find((each) => each.id === 80000)!;
    a.provider.serveTitles((titles) => ({
      ...titles,
      series: titles.series.map((series) =>
        series.id === title.id
          ? {
              ...series,
              seasons: series.seasons.map((season, number) =>
                number === 0
                  ? season.map((episode, index) =>
                      index === 0 ? { ...episode, container: "mp4" } : episode,
                    )
                  : season,
              ),
            }
          : series,
      ),
    }));
    await a.service.refresh(a.subscriptionId);
    gate.release();
    expect(await stale).toBe("rejected");
    expect((await a.service.file(a.episode)).container).toBe("mp4");
    expect(a.provider.detailRequests()).toBe(2);
  });

  it("aborts external detail work and settles waiters at service shutdown", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const gate = hold();
    const pending = a.service.details("series", a.series).then(
      () => "success",
      () => "cancelled",
    );
    await gate.arrived;
    await a.runtime.dispose();
    expect(gate.aborted()).toBe(true);
    expect(await pending).toBe("cancelled");
    gate.release();
  });
  it("keeps valid TMDB records through key reconfiguration and expires positive metadata at 182 days", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    const first = await a.service.season(a.series, 1);
    await expect
      .poll(async () => (await a.service.details("series", a.series)).plot)
      .toMatch(/^TMDB/);
    const requests = [a.remote!.aboutRequests(), a.remote!.seasonRequests().length];
    await a.time(NOW + 149 * DAY);
    expect(await a.service.season(a.series, 1)).toEqual(first);
    expect([a.remote!.aboutRequests(), a.remote!.seasonRequests().length]).toEqual(requests);
    // A due renewal can fail without discarding a still-valid positive answer.
    const network = vi.spyOn(globalThis, "fetch");
    a.remote!.refuse(true);
    await a.time(NOW + 150 * DAY);
    expect(await a.service.season(a.series, 1)).toEqual(first);
    await expect.poll(() => a.remote!.aboutRequests()).toBeGreaterThan(requests[0]!);
    expect(network.mock.calls.some(([url]) => String(url).includes("/season/1"))).toBe(true);
    expect((await a.service.details("series", a.series)).plot).toMatch(/^TMDB/);
    await a.settings.update({ tmdbKey: "replacement-key" });
    await a.service.reconfigure();
    expect((await a.service.details("series", a.series)).plot).toMatch(/^TMDB/);
    await a.time(NOW + 182 * DAY);
    expect((await a.service.details("series", a.series)).plot).toMatch(/^All about/);
    expect((await a.service.season(a.series, 1))[0]?.plot).toBeNull();
  });

  it.each([false, true])(
    "settles a held season on key rotation with usable metadata or provider fallback (cached: %s)",
    async (cached) => {
      const holdAbout = holdResponse(
        (url) => url.searchParams.get("append_to_response") === "credits",
      );
      const holdSeason = holdResponse((url) => url.pathname.endsWith("/season/1"));
      const a = await app({ metadata: true });
      const network = vi.spyOn(globalThis, "fetch");
      await a.settings.update({ titleLanguage: "nl" });
      const before = cached ? await a.service.season(a.series, 1) : undefined;
      if (cached) {
        await expect
          .poll(async () => (await a.service.details("series", a.series)).plot)
          .toMatch(/^TMDB/);
        await a.time(NOW + 150 * DAY);
      }
      const about = holdAbout();
      const season = holdSeason();
      const pending = a.service.season(a.series, 1).then(
        (episodes) => ({ episodes }),
        (error: unknown) => ({ error }),
      );
      await Promise.all([about.arrived, season.arrived]);
      await a.settings.update({ tmdbKey: "replacement-key" });
      await a.service.reconfigure();
      const result = await pending;
      expect(result).toHaveProperty("episodes");
      if (!("episodes" in result)) throw new Error("Season failed during key rotation");
      if (before) expect(result.episodes).toEqual(before);
      else expect(result.episodes[0]?.plot).toBeNull();
      expect(about.aborted()).toBe(true);
      expect(season.aborted()).toBe(true);
      about.release();
      season.release();
      const record = await a.cache.read({ kind: "season", id: "90000", number: 1, language: "nl" });
      expect(record?.at ?? null).toBe(cached ? NOW : null);
      const title = await a.cache.read({
        kind: "about",
        titleKind: "series",
        id: "90000",
        language: "nl",
      });
      expect(title?.at ?? null).toBe(cached ? NOW : null);
      expect((await a.service.season(a.series, 1))[0]?.plot).toMatch(/^TMDB/);
      expect(
        network.mock.calls.some(([input]) => {
          const url = new URL(String(input));
          return (
            url.pathname.endsWith("/season/1") &&
            url.searchParams.get("api_key") === "replacement-key"
          );
        }),
      ).toBe(true);
    },
  );

  it("rejects a held season whose source was replaced before key rotation", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    a.remote!.failSeasons("hold");
    const pending = a.service.season(a.series, 1).then(
      () => null,
      (error: unknown) => error,
    );
    await expect.poll(() => a.remote!.seasonRequests().length).toBe(1);
    await a.subscriptions.add(a.login);
    await a.settings.update({ tmdbKey: "replacement-key" });
    await a.service.reconfigure();
    expect(await pending).toMatchObject({ error: { kind: "unexpected" } });
    a.remote!.failSeasons(null);
    expect(
      await a.cache.read({ kind: "season", id: "90000", number: 1, language: "nl" }),
    ).toBeNull();
    expect((await a.service.season(a.series, 1))[0]?.plot).toMatch(/^TMDB/);
  });

  it("retries persistent missing TMDB title and season answers after 24 hours", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    await a.cache.remember(
      { kind: "about", titleKind: "series", id: "90000", language: "nl" },
      { kind: "about", at: NOW, value: null },
    );
    await a.cache.remember(
      { kind: "season", id: "90000", number: 1, language: "nl" },
      { kind: "season", at: NOW, value: null },
    );
    expect((await a.service.season(a.series, 1))[0]?.plot).toBeNull();
    expect(a.remote!.aboutRequests()).toBe(0);
    expect(a.remote!.seasonRequests()).toEqual([]);
    await a.time(NOW + DAY - 1);
    await a.service.season(a.series, 1);
    expect(a.remote!.aboutRequests()).toBe(0);
    await a.time(NOW + DAY);
    expect((await a.service.season(a.series, 1))[0]?.plot).toMatch(/^TMDB/);
    await expect
      .poll(async () => (await a.service.details("series", a.series)).plot)
      .toMatch(/^TMDB/);
    expect(a.remote!.aboutRequests()).toBe(1);
    expect(a.remote!.seasonRequests()).toEqual(["90000/1/nl"]);
  });

  it("treats future TMDB timestamps as due rather than serving them indefinitely", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    await a.service.season(a.series, 1);
    await expect
      .poll(async () => (await a.service.details("series", a.series)).plot)
      .toMatch(/^TMDB/);
    const counts = [a.remote!.aboutRequests(), a.remote!.seasonRequests().length];
    const network = vi.spyOn(globalThis, "fetch");
    a.remote!.refuse(true);
    await a.time(NOW - 1);
    expect((await a.service.details("series", a.series)).plot).toMatch(/^All about/);
    expect((await a.service.season(a.series, 1))[0]?.plot).toBeNull();
    await expect.poll(() => a.remote!.aboutRequests()).toBeGreaterThan(counts[0]!);
    expect(network.mock.calls.some(([url]) => String(url).includes("/season/1"))).toBe(true);
  });

  it("keeps current details separate for colliding provider ids through restart and removal", async () => {
    const a = await app();
    const second = await fakeProvider({ titles: 5, second: true });
    const { id: other } = await a.subscriptions.add({
      server: second.url,
      username: "demo",
      password: "demo",
    });
    const theirs = { subscriptionId: other, id: a.series.id };
    expect(episodeIds(await a.service.details("series", a.series))).toHaveLength(5);
    expect(episodeIds(await a.service.details("series", theirs))).toHaveLength(2);
    await a.runtime.dispose();
    a.provider.failDetails(503);
    second.failDetails(503);
    const next = await a.start();
    // Loading the login anew changes its process revision, but preserves its stable identity.
    await next.subscriptions.add(a.login);
    expect(episodeIds(await next.service.details("series", a.series))).toHaveLength(5);
    expect(episodeIds(await next.service.details("series", theirs))).toHaveLength(2);
    expect(a.provider.detailRequests()).toBe(1);
    expect(second.detailRequests()).toBe(1);
    const source = (await next.subscriptions.saved()).find((source) => source.id === other)!;
    await next.service.forget(source);
    expect(episodeIds(await next.service.details("series", a.series))).toHaveLength(5);
    await expect(next.service.details("series", theirs)).rejects.toBeDefined();
  });

  it("fetches normally when the disposable storage table becomes unavailable", async () => {
    const a = await app();
    await a.service.refresh(a.subscriptionId);
    const db = new DatabaseSync(join(a.dir, "mrstreamer.db"));
    try {
      db.exec("drop table title_detail_cache");
    } finally {
      db.close();
    }
    expect(episodeIds(await a.service.details("series", a.series))).toContain("81000");
    expect((await a.service.file(a.episode)).listingKey).toEqual(expect.any(String));
    expect(a.provider.detailRequests()).toBe(1);
  });
  it("keeps a shared season request alive when one caller detaches", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    a.remote!.failSeasons("hold");
    const service = await a.runtime.runPromise(OnDemand);
    const first = a.runtime.runFork(service.season(a.series, 1));
    await expect.poll(() => a.remote!.seasonRequests().length).toBe(1);
    const second = a.service.season(a.series, 1);
    await a.runtime.runPromise(Fiber.interrupt(first));
    const interrupted = await a.runtime.runPromise(Fiber.await(first));
    expect(Exit.isFailure(interrupted) && Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
    a.remote!.failSeasons(null);
    expect((await second)[0]?.plot).toMatch(/^TMDB/);
    expect(a.remote!.seasonRequests()).toEqual(["90000/1/nl"]);
  });

  it("aborts TMDB title and season work on removal without persisting late answers", async () => {
    const a = await app({ metadata: true });
    await a.settings.update({ titleLanguage: "nl" });
    a.remote!.holdAbout(true);
    a.remote!.failSeasons("hold");
    const network = vi.spyOn(globalThis, "fetch");
    const pending = a.service.season(a.series, 1).then(
      () => "success",
      () => "cancelled",
    );
    await expect.poll(() => a.remote!.seasonRequests().length).toBe(1);
    expect(a.remote!.aboutRequests()).toBe(1);
    const [source] = await a.subscriptions.saved();
    await a.service.forget(source!);
    expect(await pending).toBe("cancelled");
    const signals = network.mock.calls
      .filter(([input]) => String(input).startsWith(a.remote!.url))
      .map(([, init]) => init?.signal);
    expect(signals.length).toBe(2);
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    a.remote!.holdAbout(false);
    a.remote!.failSeasons(null);
    expect(
      await a.cache.read({ kind: "about", titleKind: "series", id: "90000", language: "nl" }),
    ).toBeNull();
    expect(
      await a.cache.read({ kind: "season", id: "90000", number: 1, language: "nl" }),
    ).toBeNull();
    await a.subscriptions.add(a.login);
    expect((await a.service.season(a.series, 1))[0]?.plot).toMatch(/^TMDB/);
    expect(a.remote!.aboutRequests()).toBe(2);
    expect(a.remote!.seasonRequests()).toHaveLength(2);
  });
  it("does not replace a newer renewal when an older catalogue request falls back late", async () => {
    const hold = holdDetails();
    const a = await app();
    await a.service.details("series", a.series);
    await a.service.refresh(a.subscriptionId);
    const gate = hold();
    const older = a.service.details("series", a.series);
    await gate.arrived;
    a.provider.serveTitles((titles) => ({
      ...titles,
      series: titles.series.map((series) =>
        series.id === 80000
          ? {
              ...series,
              seasons: series.seasons.map((season) =>
                season.map((episode) => ({ ...episode, container: "mp4" })),
              ),
            }
          : series,
      ),
    }));
    await a.service.refresh(a.subscriptionId);
    const current = await a.service.file(a.episode);
    expect(current.container).toBe("mp4");
    gate.release();
    await older;
    a.provider.failDetails(503);
    expect((await a.service.file(a.episode)).listingKey).toBe(current.listingKey);
    expect(a.provider.detailRequests()).toBe(3);
  });
});
