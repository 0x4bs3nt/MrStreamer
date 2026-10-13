import type * as Duration from "effect/Duration";
import { describe, expect, it } from "vitest";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { mainLayer } from "../src/main/runtime.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { startFakePlaylist } from "./fake-playlist.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

/** The app's services on `dataDir`, as a start of the app reads them. */
async function started(dataDir: string) {
  const runtime = runtimeFor(mainLayer(testConfig(dataDir)));
  return {
    runtime,
    subscriptions: await promised(runtime, Subscriptions),
    roster: await promised(runtime, Roster),
    service: await promised(runtime, OnDemand),
    settings: await promised(runtime, Settings),
  };
}

const login = (provider: { readonly url: string }) => ({
  server: provider.url,
  username: "demo",
  password: "demo",
});

/**
 * The app's movie and series service on a fake provider, restartable on the same data folder.
 * `own` names a title of the connected subscription by the provider's id, and `onDemand`'s calls
 * about one subscription's lists are about that one's; `service` is the service as it is.
 * `reconnect` enters the login again, as the viewer does to repair it: the subscription stays the
 * same.
 */
async function onDemandApp(options: { titles?: number } = {}) {
  const dataDir = await tempDir();
  const provider = await fakeProvider(options);
  let subscriptionId = "";
  const start = async () => {
    const app = await started(dataDir);
    const { service } = app;
    const onDemand = {
      ...service,
      refresh: () => service.refresh(subscriptionId),
      isStale: (maxAge: Duration.Input) => service.isStale(subscriptionId, maxAge),
      /** The connected subscription's lists, with how far TMDB's metadata has come. */
      status: async () => {
        const { lists, metadata } = await service.status();
        const [first] = lists;
        if (!first) throw new Error("No subscription has movies and series");
        const { subscriptionId: of, ...own } = first;
        expect(of).toBe(subscriptionId);
        return { ...own, metadata };
      },
    };
    return { ...app, onDemand };
  };
  const app = await start();
  const reconnect = () => app.subscriptions.add(login(provider));
  subscriptionId = (await reconnect()).id;
  const own = (id: string) => ({ subscriptionId, id });
  return { provider, dataDir, start, own, reconnect, subscriptionId, ...app };
}

// Each test starts the catalogue's worker thread, which takes a moment under a busy suite.
describe("movies and series", { timeout: 20_000 }, () => {
  it("fetches both lists on first use and lists them newest first, without adult titles", async () => {
    const { onDemand } = await onDemandApp();

    const newest = await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 5 });

    expect(newest.titles.map((title) => title.title)).toEqual([
      "TEST | Two sound tracks and subtitles",
      "TEST | Index at the end",
      "TEST | Old AVI",
      "TEST | Missing file",
      expect.any(String),
    ]);
    expect(newest.titles[0]).toMatchObject({ kind: "movie", tags: ["MULTI"], adult: false });
    const all = await onDemand.collection({
      kind: "movie",
      id: "all",
      sort: "title",
      offset: 0,
      limit: 1000,
    });
    expect(all.titles.some((title) => title.adult)).toBe(false);
    expect(all.total).toBe(all.titles.length);
    expect((await onDemand.status()).movies).toBeGreaterThan(all.total);
    expect((await onDemand.search("adult film")).movies).toEqual([]);
  });

  it("lists titles for adults on their own once the viewer asks, and series marked so whatever their category", async () => {
    const { onDemand, settings } = await onDemandApp();
    const adult = () => onDemand.collection({ kind: "movie", id: "adult", offset: 0, limit: 100 });
    const series = (id: "all" | "adult") =>
      onDemand.collection({ kind: "series", id, sort: "title", offset: 0, limit: 1000 });
    expect((await adult()).total).toBe(0);
    expect((await series("all")).titles.map((title) => title.title)).not.toContain("After Dark");
    expect((await onDemand.search("after dark")).series).toEqual([]);

    await settings.update({ adultTitles: true });
    const listed = await adult();
    expect(listed.total).toBeGreaterThan(0);
    expect(listed.titles.every((title) => title.adult)).toBe(true);
    expect((await series("adult")).titles.map((title) => title.title)).toEqual(["After Dark"]);
    // Still nowhere else.
    expect((await onDemand.search("adult film")).movies).toEqual([]);
    expect((await onDemand.search("after dark")).series).toEqual([]);
  });

  it("keeps titles only their category marks for adults out when the categories come back empty", async () => {
    const { onDemand, provider } = await onDemandApp();
    const adultInAll = async () =>
      (
        await onDemand.collection({
          kind: "movie",
          id: "all",
          sort: "title",
          offset: 0,
          limit: 1000,
        })
      ).titles.some((title) => title.name.startsWith("Adult Film"));
    expect(await adultInAll()).toBe(false);

    provider.emptyTitleCategories(true);
    await onDemand.refresh();

    expect(await adultInAll()).toBe(false);
    expect((await onDemand.search("adult film")).movies).toEqual([]);
  });

  it("shows the episodes the provider added once the lists are refreshed", async () => {
    const { onDemand, provider, own } = await onDemandApp();
    const episodes = async () => {
      const details = await onDemand.details("series", own("80000"));
      return details.kind === "series" ? details.seasons.flatMap((season) => season.episodes) : [];
    };
    const before = await episodes();

    const series = provider.titles.series.find((each) => each.id === 80_000);
    const season = series?.seasons.at(-1);
    if (!series || !season?.[0]) throw new Error("The fake provider has no test series.");
    // The fake provider lists what its titles hold when asked.
    (season as unknown as unknown[]).push({ ...season[0], id: 81_012 });
    expect(await episodes()).toHaveLength(before.length);
    await onDemand.refresh();

    expect((await episodes()).map((episode) => episode.id)).toEqual([
      ...before.map((episode) => episode.id),
      "81012",
    ]);
  });

  it("searches movies and series by any words of their names, and one kind for its page: the best matches, and how many match in all", async () => {
    const { onDemand } = await onDemandApp({ titles: 1000 });

    const found = await onDemand.search("sound test");
    expect(found.movies.map((title) => title.title)).toEqual([
      "TEST | Two sound tracks and subtitles",
    ]);
    expect((await onDemand.search("formats")).series.map((title) => title.title)).toEqual([
      "TEST | Formats",
    ]);

    const stories = await onDemand.searchKind("movie", "story");
    expect(stories.titles).toHaveLength(300);
    expect(stories.total).toBeGreaterThan(300);
    expect(stories.titles.every((title) => title.kind === "movie" && !title.adult)).toBe(true);
    expect((await onDemand.searchKind("series", "sound test")).total).toBe(0);
    expect((await onDemand.searchKind("movie", "sound test")).titles.map((t) => t.title)).toEqual([
      "TEST | Two sound tracks and subtitles",
    ]);
  });

  it("finds titles by any version from the lists, without asking for details", async () => {
    const { onDemand, provider, own } = await onDemandApp();
    const versions = provider.titles.movies.slice(0, 3).map((movie) => own(String(movie.id)));

    const found = await onDemand.titles("movie", [...versions, own("404")]);

    // Each title, and each of its versions, says whose it is.
    expect(found.every((title) => title.subscriptionId === own("").subscriptionId)).toBe(true);
    expect(found.flatMap((title) => title.versions)).toEqual(
      expect.arrayContaining(versions.map((version) => expect.objectContaining(version))),
    );
    expect(provider.detailRequests()).toBe(0);
    // Without TMDB, a title's details are the provider's.
    const [first] = versions;
    if (!first) throw new Error("The fake provider has no movies.");
    const details = await onDemand.details("movie", first);
    expect(details.cast).toEqual([
      { name: "Ada Lovelace", role: null, photoUrl: null },
      { name: "Alan Turing", role: null, photoUrl: null },
    ]);
    expect(provider.detailRequests()).toBe(1);
  });

  it("builds a series' seasons from its episodes, one row for an episode the provider lists twice, and still plays the other file", async () => {
    const { onDemand, own } = await onDemandApp();

    const details = await onDemand.details("series", own("80000"));

    if (details.kind !== "series") throw new Error("Not a series.");
    // The provider lists fewer seasons than its episodes have.
    expect(details.seasons.map((season) => [season.name, season.episodes.length])).toEqual([
      ["Seizoen 1", 3],
      ["Season 2", 2],
    ]);
    expect(details.seasons[0]?.episodes[0]).toMatchObject({
      ...own("81000"),
      seriesId: "80000",
      season: 1,
      number: 1,
      title: "Part 1",
      duration: 2700,
    });
    expect(details.seasons[0]?.episodes.map((episode) => [episode.id, episode.number])).toEqual([
      ["81000", 1],
      ["81001", 2],
      ["81002", 3],
    ]);
    const file = await onDemand.file({
      kind: "episode",
      ...own("81003"),
      seriesId: "80000",
      season: 1,
      episode: 2,
    });
    expect(file.container).toBe("mp4");
  });

  it("keeps the lists after a restart without asking the provider again", async () => {
    const app = await onDemandApp();
    const before = await app.onDemand.collection({
      kind: "series",
      id: "all",
      offset: 0,
      limit: 10,
    });
    await app.runtime.dispose();
    app.provider.failTitles(500);

    const restarted = await app.start();

    expect(
      await restarted.onDemand.collection({ kind: "series", id: "all", offset: 0, limit: 10 }),
    ).toEqual(before);
    expect(await restarted.onDemand.isStale("12 hours")).toBe(false);
  });

  it("keeps the lists when a refresh fails, and says why", async () => {
    const { onDemand, provider } = await onDemandApp();
    const before = await onDemand.status();
    await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });
    provider.failTitles(503);

    await expect(onDemand.refresh()).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });

    const after = await onDemand.status();
    expect(after.movies).toBeGreaterThan(before.movies);
    expect(after.failure).toEqual({ kind: "provider-error", status: 503 });
  });

  it("keeps the lists when the provider refuses the login for them", async () => {
    const { onDemand, provider } = await onDemandApp();
    await onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });
    const before = await onDemand.status();
    provider.failTitles("login");

    // Twice: a second empty answer in a row would count as the provider's real lists.
    for (const _ of [1, 2]) {
      await expect(onDemand.refresh()).rejects.toMatchObject({ error: { kind: "invalid-login" } });
    }

    expect(await onDemand.status()).toMatchObject({
      movies: before.movies,
      series: before.series,
      failure: { kind: "invalid-login" },
    });
  });

  it("doesn't ask the provider again for every list after the first fetch failed", async () => {
    const { onDemand, provider } = await onDemandApp();
    const list = () => onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });
    const failed = { error: { kind: "provider-error", status: 503 } };
    provider.failTitles(503);
    await expect(list()).rejects.toMatchObject(failed);

    // Lists answer with the failure for a while; refreshing asks again.
    provider.failTitles(null);
    await expect(list()).rejects.toMatchObject(failed);
    await onDemand.refresh();
    expect((await list()).total).toBeGreaterThan(0);
  });

  it("drops lists that arrive after the login was entered again, and keeps the ones it had", async () => {
    const app = await onDemandApp();
    const { onDemand, provider } = app;
    await onDemand.refresh();
    const before = await onDemand.status();
    const told = await collect(app.runtime, onDemand.changes);
    const held = provider.hold("titles");
    const late = onDemand.refresh();
    late.catch(() => {});
    await held.arrived;

    const again = await app.reconnect();
    held.release();

    await expect(late).rejects.toMatchObject({ error: { kind: "unexpected" } });
    expect(app.own("").subscriptionId).toBe(again.id);
    expect(await onDemand.status()).toEqual(before);
    expect(told).toEqual([]);
    // Nor are they what the next start reads.
    await app.runtime.dispose();
    expect(await (await app.start()).onDemand.status()).toEqual(before);
  });

  it("doesn't report a refusal that arrives after the login was entered again", async () => {
    const app = await onDemandApp();
    const { onDemand, provider } = app;
    await onDemand.refresh();
    const before = await onDemand.status();
    const told = await collect(app.runtime, onDemand.changes);
    provider.failTitles("login");
    const held = provider.hold("titles");
    const late = onDemand.refresh();
    late.catch(() => {});
    await held.arrived;

    await app.reconnect();
    held.release();

    await expect(late).rejects.toMatchObject({ error: { kind: "invalid-login" } });
    expect(await onDemand.status()).toEqual(before);
    expect(told).toEqual([]);
  });

  it("forgets the last account's titles when the subscription goes", async () => {
    const app = await onDemandApp();
    await app.onDemand.collection({ kind: "movie", id: "all", offset: 0, limit: 1 });

    await app.roster.remove(app.subscriptionId, false);

    expect(await app.service.status()).toEqual({ lists: [], metadata: null });
    await expect(app.onDemand.search("story")).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
    await expect(app.onDemand.season(app.own("80000"), 1)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("finds nothing by a version that names another subscription", async () => {
    const { onDemand, provider, own } = await onDemandApp();
    const id = String(provider.titles.movies[0]?.id);
    // The same provider id, as another subscription's lists could hold it.
    const theirs = { subscriptionId: "another-subscription", id };

    expect(await onDemand.titles("movie", [theirs])).toEqual([]);
    expect(await onDemand.titles("movie", [theirs, own(id)])).toHaveLength(1);
    for (const asked of [
      onDemand.details("movie", theirs),
      onDemand.season({ ...theirs, id: "80000" }, 1),
      onDemand.file({ kind: "movie", ...theirs }),
    ]) {
      await expect(asked).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    }
    expect(provider.detailRequests()).toBe(0);
    // Nor does a title like one of another subscription's lead a row.
    const rows = (like: typeof theirs) => onDemand.rows("movie", "for-you", like);
    expect((await rows(theirs)).some((row) => row.id.startsWith("like:"))).toBe(false);
  });
});

describe("the movies and series of several subscriptions", { timeout: 30_000 }, () => {
  /**
   * Two providers that number their titles alike, so every id is taken twice: the second lists
   * some of the first's films and its test series under ids of its own, and others of its own
   * under the first's ids. `a` and `b` are their subscriptions, in the order added.
   */
  async function two() {
    const dataDir = await tempDir();
    const [first, second] = [await fakeProvider(), await fakeProvider({ second: true })];
    const app = await started(dataDir);
    const a = (await app.subscriptions.add(login(first))).id;
    const b = (await app.subscriptions.add(login(second))).id;
    await app.service.refresh(a);
    await app.service.refresh(b);
    return { ...app, dataDir, first, second, a, b };
  }
  const of = (subscriptionId: string, id: number | string) => ({ subscriptionId, id: String(id) });
  type App = Awaited<ReturnType<typeof two>>;

  /** Every title of a kind's All, read a page at a time as the grid reads it. */
  async function all(service: App["service"], kind: "movie" | "series") {
    const first = await service.collection({ kind, id: "all", offset: 0, limit: 50 });
    const titles = [...first.titles];
    while (titles.length < first.total) {
      const next = await service.collection({ kind, id: "all", offset: titles.length, limit: 50 });
      titles.push(...next.titles);
    }
    return { total: first.total, titles };
  }

  /** What the two lists hold between them: each film once, by its TMDB id where it has one. */
  function films({ first, second, a, b }: App) {
    const known = (tmdb: string | undefined, id: number) =>
      tmdb === "0" || (tmdb === undefined && id % 7 === 0) ? null : (tmdb ?? String(id + 10_000));
    const keys = new Set<string>();
    for (const [subscriptionId, provider] of [
      [a, first],
      [b, second],
    ] as const) {
      for (const movie of provider.titles.movies) {
        if (movie.adult) continue;
        const tmdb = known(movie.tmdb, movie.id);
        keys.add(tmdb ? `movie:tmdb:${tmdb}` : `movie:${subscriptionId}:${movie.id}`);
      }
    }
    return keys;
  }

  it("shows a film both list once, with the versions of each, joined by their film alone, and counts what is left once", async () => {
    const app = await two();
    const { service, first, second, a, b } = app;

    const listed = await all(service, "movie");

    // No film twice, none missing, and the count is of films, not of versions.
    const keys = listed.titles.map((title) => title.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(films(app));
    expect(listed.total).toBe(keys.length);
    const each = (provider: typeof first) =>
      provider.titles.movies.filter((movie) => !movie.adult).length;
    expect(listed.total).toBeLessThan(each(first) + each(second));
    expect(await service.status()).toMatchObject({
      lists: [
        { subscriptionId: a, movies: first.titles.movies.length, failure: null },
        { subscriptionId: b, movies: second.titles.movies.length, failure: null },
      ],
    });

    // Versions join by their film alone: not by an id two providers share, nor by a name.
    const titled = async (version: ReturnType<typeof of>) => {
      const [title] = await service.titles("movie", [version]);
      return title;
    };

    // The first's film 91001 is the second's 91000: one title, found by either version.
    const shared = await titled(of(a, 91_001));
    expect(shared).toMatchObject({ key: "movie:tmdb:101001" });
    expect(shared?.versions.map(({ subscriptionId, id }) => [subscriptionId, id])).toEqual(
      expect.arrayContaining([
        [a, "91001"],
        [b, "91000"],
      ]),
    );
    expect(shared?.versions).toHaveLength(2);
    expect(await titled(of(b, 91_000))).toEqual(shared);
    expect(shared).not.toHaveProperty("ambiguous");
    // Under the id of the first's film, the second lists a film of its own.
    expect(await titled(of(b, 91_001))).toMatchObject({
      key: "movie:tmdb:111001",
      name: "Other Story 1 (NL)",
      versions: [of(b, 91_001)],
    });
    // The same film by its name, with no TMDB id to say so: two titles, each told apart.
    const [mine, theirs] = await service.titles("movie", [of(a, 91_007), of(b, 91_006)]);
    expect(mine).toMatchObject({
      key: `movie:${a}:91007`,
      versions: [of(a, 91_007)],
      ambiguous: true,
    });
    expect(theirs).toMatchObject({
      key: `movie:${b}:91006`,
      versions: [of(b, 91_006)],
      ambiguous: true,
    });
    expect(mine?.title).toBe(theirs?.title);
  });

  it("searches every list before it cuts, and finds a film of either once", async () => {
    const app = await two();
    const { service, b } = app;

    const found = await service.searchKind("movie", "story");

    const keys = found.titles.map((title) => title.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(found.total).toBe(keys.length);
    // The second's own films are found though the first alone lists more than enough.
    const own = found.titles.filter((title) => title.name.startsWith("Other Story"));
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((title) => title.subscriptionId === b)).toBe(true);
    const everything = await service.search("other story");
    expect(everything.movies.length).toBeGreaterThan(0);
    expect(everything.movies.every((title) => title.subscriptionId === b)).toBe(true);
  });

  it("lists the seasons and episodes of the version asked, and makes up none from another's", async () => {
    const { service, first, second, a, b } = await two();
    const episodes = async (series: ReturnType<typeof of>) => {
      const details = await service.details("series", series);
      if (details.kind !== "series") throw new Error("Not a series");
      return details.seasons.map((season) =>
        season.episodes.map((episode) => [episode.subscriptionId, episode.id]),
      );
    };

    const [series] = await service.titles("series", [of(b, 80_000)]);
    // One series, in the first's two versions and the second's one.
    expect(series).toMatchObject({ key: "series:tmdb:90000" });
    expect(
      series?.versions.map(({ subscriptionId, id }) => [subscriptionId, id]).toSorted(),
    ).toEqual(
      [
        [a, "79998"],
        [a, "80000"],
        [b, "80000"],
      ].toSorted(),
    );
    // The same series id and episode ids, and each provider's own files behind them.
    expect(await episodes(of(a, 80_000))).toEqual([
      [
        [a, "81000"],
        [a, "81001"],
        [a, "81002"],
      ],
      [
        [a, "81010"],
        [a, "81011"],
      ],
    ]);
    expect(await episodes(of(b, 80_000))).toEqual([
      [
        [b, "81000"],
        [b, "81001"],
      ],
    ]);
    // The second has no second season: the first's isn't offered in its place.
    await expect(service.season(of(b, 80_000), 2)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    const file = (subscriptionId: string) =>
      service.file({
        kind: "episode",
        subscriptionId,
        id: "81000",
        seriesId: "80000",
        season: 1,
        episode: 1,
      });
    expect((await file(a)).url.startsWith(first.url)).toBe(true);
    expect((await file(b)).url.startsWith(second.url)).toBe(true);
  });

  it("keeps the others' titles when one's lists can't be fetched, and after it goes", async () => {
    const app = await two();
    const { service, roster, second, a, b } = app;
    const before = await all(service, "movie");

    second.failTitles(503);
    await expect(service.refresh(b)).rejects.toMatchObject({
      error: { kind: "provider-error", status: 503 },
    });

    expect(await all(service, "movie")).toEqual(before);
    expect((await service.status()).lists).toMatchObject([
      { subscriptionId: a, failure: null },
      { subscriptionId: b, failure: { kind: "provider-error", status: 503 } },
    ]);

    await roster.remove(b, false);

    // What both listed stays the same title, with the first's version alone.
    const [shared] = await service.titles("movie", [of(a, 91_001)]);
    expect(shared).toMatchObject({ key: "movie:tmdb:101001", versions: [of(a, 91_001)] });
    expect(await service.titles("movie", [of(b, 91_001)])).toEqual([]);
    const left = await all(service, "movie");
    expect(left.titles.every((title) => title.subscriptionId === a)).toBe(true);
    expect(left.titles.some((title) => title.ambiguous)).toBe(false);
    expect((await service.status()).lists.map((each) => each.subscriptionId)).toEqual([a]);
  });

  it("reads each subscription's lists from its own folder after a restart, without the providers", async () => {
    const app = await two();
    // A third, loaded last: the app quits with the lists of several still to be written.
    const third = await fakeProvider({ titles: 40 });
    const c = (await app.subscriptions.add(login(third))).id;
    await app.service.refresh(c);
    const before = await all(app.service, "movie");
    const { lists } = await app.service.status();
    await app.runtime.dispose();
    for (const provider of [app.first, app.second, third]) provider.failTitles(500);

    const restarted = await started(app.dataDir);

    // Each has what it loaded, as old as it was: none is asked for again, and none could answer.
    expect((await restarted.service.status()).lists).toEqual(lists);
    expect(await all(restarted.service, "movie")).toEqual(before);
    for (const id of [app.a, app.b, c]) {
      expect(await restarted.service.isStale(id, "12 hours")).toBe(false);
    }
  });

  it("shows what is there while an added subscription's lists load, and then with them", async () => {
    const dataDir = await tempDir();
    const [first, second] = [await fakeProvider(), await fakeProvider({ second: true })];
    const app = await started(dataDir);
    const a = (await app.subscriptions.add(login(first))).id;
    await app.service.refresh(a);
    const alone = await all(app.service, "movie");
    const told = await collect(app.runtime, app.service.changes);
    const held = second.hold("titles");

    const b = (await app.roster.add(login(second))).id;
    await held.arrived;
    // Asked for while the new lists are on their way: no wait, and nothing missing.
    expect(await all(app.service, "movie")).toEqual(alone);
    held.release();
    await expect
      .poll(() =>
        told.some((status) =>
          status.lists.some((each) => each.subscriptionId === b && each.fetchedAt),
        ),
      )
      .toBe(true);

    const both = await all(app.service, "movie");
    expect(both.total).toBeGreaterThan(alone.total);
    expect(both.titles.some((title) => title.subscriptionId === b)).toBe(true);
  });

  it("has no movies or series for a playlist beside a subscription that has them", async () => {
    const { service, subscriptions, subscriptionId: a } = await onDemandApp();
    const playlist = await startFakePlaylist();
    try {
      await subscriptions.add({ server: playlist.link, username: "", password: "" });

      expect((await subscriptions.list()).map((each) => each.kind)).toEqual(["xtream", "m3u"]);
      // A playlist has live TV only: it adds no lists, and none are asked of it.
      expect((await service.status()).lists).toHaveLength(1);
      const listed = await all(service, "movie");
      expect(listed.titles.some((title) => title.subscriptionId === a)).toBe(true);
    } finally {
      await playlist.close();
    }
  });
});
