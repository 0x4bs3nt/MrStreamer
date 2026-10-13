import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { WatchlistPage, WatchlistSort } from "@mrstreamer/contracts/watchlist";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mainLayer } from "../src/main/runtime.ts";
import { OnDemand } from "../src/main/services/ondemand.ts";
import { Settings } from "../src/main/services/preferences.ts";
import { Roster } from "../src/main/services/roster.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { Watchlist } from "../src/main/services/watchlist.ts";
import type { FakeProvider } from "./fake-provider.ts";
import { startFakeTmdb, tmdbName, type FakeTmdb } from "./fake-tmdb.ts";
import { collect, fakeProvider, promised, runtimeFor, tempDir, testConfig } from "./support.ts";

// The first fake provider's titles the tests save, by the ids it lists them under.
/** A film in two versions that share TMDB id 100000: `TWO_SOUNDS` and `TWO_SOUNDS_DUBBED`. */
const TWO_SOUNDS = "90000";
const TWO_SOUNDS_DUBBED = "90006";
/** Films in one version each, with TMDB ids 100001 and 100002. */
const INDEX_AT_END = "90001";
const OLD_AVI = "90002";
/** Films the provider lists without a TMDB id. */
const UNNAMED = "91000";
const UNNAMED_TOO = "91014";
/** A series in two versions that share TMDB id 90000: `FORMATS` and `FORMATS_ENGLISH`. */
const FORMATS = "80000";
const FORMATS_ENGLISH = "79998";
/** A series in one version, with TMDB id 90001. */
const FILES = "80001";
/** A series the provider marks for adults. */
const AFTER_DARK = "79999";

// What the second provider lists beside it, numbering its titles as the first does.
/** A film both list under TMDB id 101001: the first as `SHARED`, the second as `SHARED_THERE`. */
const SHARED = "91001";
const SHARED_THERE = "91000";
/** The second's own film, with a TMDB id of its own, under the id the first has `SHARED` at. */
const OTHER_STORY = "91001";
/** A film neither gives a TMDB id, which reads the same at both: `NAMESAKE` and `NAMESAKE_THERE`. */
const NAMESAKE = "91021";
const NAMESAKE_THERE = "91020";
/** A film for adults both list under TMDB id 101003: `ADULT_FILM` and `ADULT_FILM_THERE`. */
const ADULT_FILM = "91003";
const ADULT_FILM_THERE = "91002";
/** The second's own series, whose TMDB id 100001 is the one `INDEX_AT_END` has as a film. */
const OTHER_FILES = "80001";

let tmdb: FakeTmdb | null = null;
afterEach(async () => {
  await tmdb?.close();
  tmdb = null;
});

/** Lets the clock move on, so what is saved next is saved later. */
function later(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** What a page shows of each entry: its name, and whether the lists have its title. */
function shown(page: WatchlistPage) {
  return page.entries.map((entry) => ({
    name: entry.title?.title ?? entry.name,
    available: entry.title !== null,
  }));
}

/** One of the two providers: the first, or the second beside it. */
type Of = 0 | 1;

/**
 * The watchlist as the app runs it, on two fake providers that number their titles alike: the
 * second lists some of the first's films and its test series under ids of its own, and others of
 * its own under the first's ids. `start` ends the app running before, if any, and starts it again
 * on the same data folder, `locked` with a keychain that opens no password. `withTmdb` gives it a
 * key and the fake TMDB.
 *
 * Its calls take a provider's ids alone and name them with the subscription saved for that
 * provider at that moment, the first unless `of` says the second; `watchlist` is the service
 * itself.
 */
async function watchlistApp({ withTmdb = false }: { withTmdb?: boolean } = {}) {
  const dataDir = await tempDir();
  const providers = [await fakeProvider(), await fakeProvider({ second: true })] as const;
  if (withTmdb) tmdb = await startFakeTmdb();
  let dispose: (() => Promise<void>) | null = null;

  const start = async ({ locked = false }: { locked?: boolean } = {}) => {
    await dispose?.();
    const config = testConfig(dataDir);
    /** A keychain that no longer opens what it sealed, as after it was reset. */
    const refusing = {
      ...config.secrets,
      open: (): string => {
        throw new Error("The keychain denied access.");
      },
    };
    const runtime = runtimeFor(
      mainLayer({
        ...config,
        ...(locked ? { secrets: refusing } : {}),
        ...(tmdb ? { tmdbKey: "test-key", tmdbApi: tmdb.url } : {}),
      }),
    );
    dispose = () => runtime.dispose();
    const watchlist = await promised(runtime, Watchlist);
    const onDemand = await promised(runtime, OnDemand);
    const viewing = await promised(runtime, ViewingRecord);
    const settings = await promised(runtime, Settings);
    const subscriptions = await promised(runtime, Subscriptions);
    const roster = await promised(runtime, Roster);
    /** The subscription saved for a provider now, by its id. */
    const idOf = async (of: Of = 0) =>
      (await subscriptions.list()).find((each) => each.server === providers[of].url)?.id ??
      "no-subscription";
    /** `id` as the subscription saved for a provider now lists it. */
    const own = async (id: string, of: Of = 0): Promise<OwnedId> => ({
      subscriptionId: await idOf(of),
      id,
    });
    const list = (sort: WatchlistSort = "saved") => watchlist.list({ sort, offset: 0, limit: 100 });
    return {
      watchlist,
      onDemand,
      viewing,
      settings,
      subscriptions,
      idOf,
      own,
      list,
      /** The names the watchlist shows, in `sort`, and whether the lists have each title. */
      shown: async (sort: WatchlistSort = "saved") => shown(await list(sort)),
      save: async (kind: TitleKind, id: string, of: Of = 0) =>
        watchlist.save(kind, await own(id, of)),
      saved: async (kind: TitleKind, id: string, of: Of = 0) =>
        watchlist.saved(kind, await own(id, of)),
      /** Saves a provider's login beside the others. Its lists load when they are asked for. */
      add: (of: Of) =>
        subscriptions.add({ server: providers[of].url, username: "demo", password: "demo" }),
      /** Removes a provider's subscription as Settings does, with what its account saved on `erase`. */
      remove: async (of: Of, erase = false) => roster.remove(await idOf(of), erase),
      /** Fetches a provider's lists again, as the app does twice a day and on Refresh. */
      refresh: async (of: Of = 0) => onDemand.refresh(await idOf(of)),
      /** What the UI is told from now on. */
      changes: () => collect(runtime, watchlist.changes),
      /** The account a provider's subscription keeps what it saved under. */
      account: async (of: Of = 0) => {
        const id = await idOf(of);
        return (await subscriptions.saved()).find((each) => each.id === id)?.key ?? "";
      },
    };
  };

  return {
    dataDir,
    providers,
    start,
    /** Runs `use` on the database through a connection of its own, as another build's would be. */
    database: <A>(use: (db: DatabaseSync) => A): A => {
      const db = new DatabaseSync(join(dataDir, "mrstreamer.db"));
      try {
        return use(db);
      } finally {
        db.close();
      }
    },
  };
}

/** The app started, with the first provider's subscription saved. */
async function connected(options: { withTmdb?: boolean } = {}) {
  const app = await watchlistApp(options);
  const saving = await app.start();
  await saving.add(0);
  return { app, provider: app.providers[0], saving };
}

/** The same with the second provider's beside it, and the lists of both loaded. */
async function two() {
  const { app, saving } = await connected();
  await saving.add(1);
  await saving.refresh(0);
  await saving.refresh(1);
  const [first, second] = app.providers;
  return { app, saving, first, second, a: await saving.idOf(0), b: await saving.idOf(1) };
}

// Each test starts the catalogue's worker thread, which takes a moment under a busy suite.
describe("watchlist", { timeout: 30_000 }, () => {
  it("saves movies and whole series, lists them newest first or by name a page at a time, and keeps them across a restart", async () => {
    const { app, saving } = await connected();

    const movie = await saving.save("movie", INDEX_AT_END);
    await later();
    await saving.save("series", FORMATS);
    await later();
    await saving.save("movie", OLD_AVI);

    const page = await saving.list();
    expect(page.total).toBe(3);
    expect(shown(page)).toEqual([
      { name: "TEST | Old AVI", available: true },
      { name: "TEST | Formats", available: true },
      { name: "TEST | Index at the end", available: true },
    ]);
    // Each entry is its subscription's, with the title as the lists have it.
    expect(page.entries[2]).toMatchObject({
      ...movie,
      kind: "movie",
      name: "TEST | Index at the end",
      savedAt: expect.any(Number),
      title: { kind: "movie", ...(await saving.own(INDEX_AT_END)), tmdbId: "100001" },
      artworkUrl: null,
      sources: [movie.subscriptionId],
      listed: true,
    });
    expect(page.entries[1]).toMatchObject({ kind: "series", title: { kind: "series" } });
    expect((await saving.shown("title")).map((entry) => entry.name)).toEqual([
      "TEST | Formats",
      "TEST | Index at the end",
      "TEST | Old AVI",
    ]);
    const second = await saving.watchlist.list({ sort: "saved", offset: 2, limit: 2 });
    expect(second.total).toBe(3);
    expect(shown(second)).toEqual([{ name: "TEST | Index at the end", available: true }]);

    const restarted = await app.start();
    expect(await restarted.list()).toEqual(page);
    expect(await restarted.saved("movie", INDEX_AT_END)).toEqual(movie);
  });

  it("saves a title once however often it is saved, and removes it once however often it is removed", async () => {
    const { saving } = await connected();
    const told = await saving.changes();

    const first = await saving.save("movie", INDEX_AT_END);
    const [{ savedAt } = { savedAt: 0 }] = (await saving.list()).entries;
    await later();
    const other = await saving.save("movie", OLD_AVI);
    await later();

    expect(await saving.save("movie", INDEX_AT_END)).toEqual(first);
    const page = await saving.list();
    // Saved again, it stays where it was: under the title saved after it.
    expect(page.entries.map((entry) => entry.id)).toEqual([other.id, first.id]);
    expect(page.entries[1]?.savedAt).toBe(savedAt);

    await saving.watchlist.remove(first);
    await saving.watchlist.remove(first);

    expect((await saving.list()).entries.map((entry) => entry.id)).toEqual([other.id]);
    expect(await saving.saved("movie", INDEX_AT_END)).toBeNull();
    expect(await saving.saved("movie", OLD_AVI)).toEqual(other);
    // Told after each change that was stored, also one that changed nothing.
    expect(told).toHaveLength(5);
  });

  it("saves a title once whichever of its versions is named, in whatever language it shows, and nothing the lists don't have", async () => {
    const { saving } = await connected();

    const film = await saving.save("movie", TWO_SOUNDS_DUBBED);
    const series = await saving.save("series", FORMATS_ENGLISH);

    expect(await saving.save("movie", TWO_SOUNDS)).toEqual(film);
    expect(await saving.saved("movie", TWO_SOUNDS)).toEqual(film);
    expect(await saving.saved("movie", TWO_SOUNDS_DUBBED)).toEqual(film);
    expect(await saving.saved("series", FORMATS)).toEqual(series);
    const shownFirst = async () =>
      (await saving.list()).entries.map((entry) => [entry.id, entry.title?.id]);
    const english = await shownFirst();
    expect(english).toHaveLength(2);

    // In Dutch each title shows another version first, and is the same entry.
    await saving.settings.update({ titleLanguage: "nl" });
    const dutch = await shownFirst();
    expect(dutch.map(([id]) => id)).toEqual(english.map(([id]) => id));
    expect(dutch.map(([, shownId]) => shownId)).not.toEqual(english.map(([, shownId]) => shownId));
    expect(await saving.save("movie", TWO_SOUNDS)).toEqual(film);
    expect(await saving.saved("series", FORMATS_ENGLISH)).toEqual(series);

    // 81000 is an episode of the Formats series: no series of the lists has that id.
    for (const [kind, id] of [
      ["movie", "404"],
      ["series", "81000"],
    ] as const) {
      await expect(saving.save(kind, id)).rejects.toMatchObject({
        error: { kind: "title-not-found" },
      });
      expect(await saving.saved(kind, id)).toBeNull();
    }
    expect((await saving.list()).total).toBe(2);
  });
});

describe("a saved title as the provider changes its lists", { timeout: 30_000 }, () => {
  it("follows a title the provider renames, or lists in other versions, by its TMDB id", async () => {
    const { provider, saving } = await connected();
    const film = await saving.save("movie", TWO_SOUNDS);
    const [before] = (await saving.list()).entries;

    // The version it was saved in goes, and the other gets another name.
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.flatMap((movie) =>
        String(movie.id) === TWO_SOUNDS
          ? []
          : String(movie.id) === TWO_SOUNDS_DUBBED
            ? [{ ...movie, name: "Two Sounds Restored (2024) (NL AUDIO)" }]
            : [movie],
      ),
    }));
    await saving.refresh();

    expect((await saving.list()).entries).toMatchObject([
      {
        ...film,
        savedAt: before?.savedAt,
        title: { id: TWO_SOUNDS_DUBBED, title: "Two Sounds Restored", year: 2024 },
      },
    ]);

    // Then the provider lists it under an id it never had, with the same TMDB id.
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.flatMap((movie) =>
        String(movie.id) === TWO_SOUNDS
          ? [{ ...movie, id: 95_555, tmdb: "100000" }]
          : String(movie.id) === TWO_SOUNDS_DUBBED
            ? []
            : [movie],
      ),
    }));
    await saving.refresh();

    expect((await saving.list()).entries).toMatchObject([
      { ...film, savedAt: before?.savedAt, title: { id: "95555" } },
    ]);
    expect(await saving.saved("movie", "95555")).toEqual(film);
  });

  it("keeps an entry the provider no longer lists, with the name it had last, until it lists it again", async () => {
    const { app, provider, saving } = await connected();
    const known = await saving.save("movie", INDEX_AT_END);
    await later();
    const unnamed = await saving.save("movie", UNNAMED);
    const before = await saving.list();
    const gone = new Set([INDEX_AT_END, UNNAMED]);

    // One fetch finds a title renamed, and the next finds both gone, with nothing read between.
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        String(movie.id) === UNNAMED ? { ...movie, name: "Harbour Lights (2021) (NL)" } : movie,
      ),
    }));
    await saving.refresh();
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.filter((movie) => !gone.has(String(movie.id))),
    }));
    await saving.refresh();

    // Both stay, without a title, and say the lists were looked in.
    const without = await saving.list();
    expect(without.total).toBe(2);
    expect(without.entries).toMatchObject([
      { ...unnamed, name: "Harbour Lights", year: 2021, title: null, listed: true },
      { ...known, name: "TEST | Index at the end", title: null, listed: true },
    ]);
    expect(without.entries.map((entry) => entry.savedAt)).toEqual(
      before.entries.map((entry) => entry.savedAt),
    );
    const restarted = await app.start();
    await restarted.refresh();
    expect(await restarted.list()).toEqual(without);

    provider.serveTitles((all) => all);
    await restarted.refresh();

    expect(await restarted.list()).toEqual(before);
    expect(await restarted.saved("movie", INDEX_AT_END)).toEqual(known);
    expect(await restarted.saved("movie", UNNAMED)).toEqual(unnamed);
  });

  it("never takes another title that got a saved title's provider id", async () => {
    const { provider, saving } = await connected();
    const saved = await saving.save("movie", INDEX_AT_END);
    await later();

    // The provider gives the id to another film, as its TMDB id says.
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        String(movie.id) === INDEX_AT_END
          ? { ...movie, name: "Another Film (EN)", tmdb: "777" }
          : movie,
      ),
    }));
    await saving.refresh();

    expect(await saving.shown()).toEqual([{ name: "TEST | Index at the end", available: false }]);
    expect(await saving.saved("movie", INDEX_AT_END)).toBeNull();

    // The other film can be saved on its own.
    const other = await saving.save("movie", INDEX_AT_END);
    expect(other.id).not.toBe(saved.id);
    expect(await saving.shown()).toEqual([
      { name: "Another Film", available: true },
      { name: "TEST | Index at the end", available: false },
    ]);

    // Once the provider lists the first film again, each entry is its own film, and removing
    // one leaves the other.
    provider.serveTitles((all) => all);
    await saving.refresh();
    expect(await saving.shown()).toEqual([
      { name: "Another Film", available: false },
      { name: "TEST | Index at the end", available: true },
    ]);
    expect(await saving.saved("movie", INDEX_AT_END)).toEqual(saved);
    await saving.watchlist.remove(other);
    expect(await saving.shown()).toEqual([{ name: "TEST | Index at the end", available: true }]);
  });

  it("keeps a title TMDB names as it was saved while a film TMDB doesn't name has its provider id", async () => {
    const { app, provider, saving } = await connected();
    const saved = await saving.save("movie", INDEX_AT_END);
    const before = await saving.list();
    await later();

    // The provider gives the id to a film without a TMDB id: nothing says it is the one saved.
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        String(movie.id) === INDEX_AT_END
          ? { ...movie, name: "An Unrelated New Film (EN)", tmdb: "0" }
          : movie,
      ),
    }));
    await saving.refresh();

    const kept = { ...before.entries[0], title: null };
    expect(await saving.list()).toEqual({ total: 1, entries: [kept] });
    expect(await saving.saved("movie", INDEX_AT_END)).toBeNull();

    // Saved, the newcomer is an entry of its own and takes nothing from the first, across
    // another fetch and a restart.
    const other = await saving.save("movie", INDEX_AT_END);
    expect(other.id).not.toBe(saved.id);
    const restarted = await app.start();
    await restarted.refresh();
    expect((await restarted.list()).entries).toMatchObject([
      { ...other, title: { title: "An Unrelated New Film", tmdbId: null } },
      kept,
    ]);
    expect(await restarted.saved("movie", INDEX_AT_END)).toEqual(other);

    // The provider lists the first film under its id again, and the entry is as it was. The
    // newcomer was known by that id alone, which names the first film now: it is saved once.
    provider.serveTitles((all) => all);
    await restarted.refresh();
    expect(await restarted.list()).toEqual(before);
    expect(await restarted.saved("movie", INDEX_AT_END)).toEqual(saved);
  });

  it("knows a title by its TMDB id once the provider lists one, and makes one entry of its versions", async () => {
    const { provider, saving } = await connected();
    const first = await saving.save("movie", UNNAMED);
    const [{ savedAt } = { savedAt: 0 }] = (await saving.list()).entries;
    await later();
    await saving.save("movie", UNNAMED_TOO);
    await later();
    const other = await saving.save("movie", OLD_AVI);
    expect((await saving.list()).total).toBe(3);

    // The provider now says both are one film, in two versions. The next fetch finds the
    // version saved first gone, with nothing read between.
    const versions = new Set([UNNAMED, UNNAMED_TOO]);
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        versions.has(String(movie.id)) ? { ...movie, tmdb: "424242" } : movie,
      ),
    }));
    await saving.refresh();
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.flatMap((movie) =>
        String(movie.id) === UNNAMED
          ? []
          : String(movie.id) === UNNAMED_TOO
            ? [{ ...movie, tmdb: "424242" }]
            : [movie],
      ),
    }));
    await saving.refresh();

    // One entry is left of the two: the one saved first, where it was, as the version left.
    const joined = await saving.list();
    expect(joined.entries.map((entry) => entry.id)).toEqual([other.id, first.id]);
    expect(joined.entries[1]).toMatchObject({
      savedAt,
      title: { id: UNNAMED_TOO, tmdbId: "424242" },
    });
    expect(await saving.saved("movie", UNNAMED_TOO)).toEqual(first);
  });

  it("never makes one title of two that share a name", async () => {
    const { provider, saving } = await connected();
    // Two films without a TMDB id, under one name and year.
    const named = "Night Harbour (2021) (NL)";
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        String(movie.id) === UNNAMED || String(movie.id) === UNNAMED_TOO
          ? { ...movie, name: named }
          : movie,
      ),
    }));
    const saved = await saving.save("movie", UNNAMED);

    expect(await saving.saved("movie", UNNAMED_TOO)).toBeNull();
    expect(await saving.shown()).toEqual([{ name: "Night Harbour", available: true }]);

    // The saved one goes, and comes back under an id it never had. Neither the film that
    // reads the same nor the one under the new id stands in for it: a name is no proof.
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        String(movie.id) === UNNAMED
          ? { ...movie, id: 95_002, tmdb: "0", name: named }
          : String(movie.id) === UNNAMED_TOO
            ? { ...movie, name: named }
            : movie,
      ),
    }));
    await saving.refresh();

    expect((await saving.list()).entries).toMatchObject([
      { ...saved, name: "Night Harbour", year: 2021, title: null },
    ]);
    expect(await saving.saved("movie", UNNAMED_TOO)).toBeNull();
    expect(await saving.saved("movie", "95002")).toBeNull();
  });

  it("shows what was saved when the lists can't be fetched, and the lists it has when a refresh fails", async () => {
    const { provider, saving } = await connected();
    await saving.save("movie", INDEX_AT_END);
    const before = await saving.list();

    // A refresh that fails keeps the lists, so the title stays as it was.
    provider.failTitles(503);
    await expect(saving.refresh()).rejects.toMatchObject({ error: { kind: "provider-error" } });
    expect(await saving.list()).toEqual(before);

    // Without any lists, as when the account is added again while its provider doesn't answer,
    // the entry shows as saved, and nothing says the provider dropped it.
    await saving.remove(0);
    await saving.add(0);
    const without = await saving.list();
    expect(without.total).toBe(1);
    expect(without.entries).toMatchObject([
      { name: "TEST | Index at the end", title: null, listed: false },
    ]);

    provider.failTitles(null);
    await saving.refresh();
    expect(await saving.shown()).toEqual([{ name: "TEST | Index at the end", available: true }]);
  });

  it("names a saved title as TMDB does, and shows TMDB's picture of one the provider dropped", async () => {
    const { provider, saving } = await connected({ withTmdb: true });
    await saving.save("movie", INDEX_AT_END);
    await later();
    await saving.save("movie", OLD_AVI);
    // TMDB's names arrive in the background.
    const names = [tmdbName(100_001, "en").name, tmdbName(100_002, "en").name];
    await expect
      .poll(async () => (await saving.shown("title")).map((entry) => entry.name), {
        timeout: 20_000,
      })
      .toEqual(names.toSorted());
    // The entries take the names over the next time the lists are fetched.
    await saving.refresh();

    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.filter((movie) => String(movie.id) !== INDEX_AT_END),
    }));
    await saving.refresh();

    // The entry keeps the name it showed, and its picture is TMDB's, never the provider's.
    const dropped = (await saving.list()).entries.find((entry) => entry.title === null);
    expect(dropped).toMatchObject({
      name: names[0],
      artworkUrl: "https://image.tmdb.org/t/p/w780/backdrop-100001.jpg",
    });
  });
});

describe("whose a saved title is", { timeout: 30_000 }, () => {
  it("takes what a subscription saved out of the list with it, brings it back with its account, and refuses a change for one that went", async () => {
    const { saving, b } = await two();
    const first = await saving.save("movie", UNNAMED);
    const before = await saving.list();
    const gone = await saving.own(FILES);
    await later();
    const theirs = await saving.save("movie", OTHER_STORY, 1);
    const told = await saving.changes();

    // Removed without its box ticked: what the other saved stays, and nothing else shows.
    await saving.remove(0);
    expect((await saving.list()).entries).toMatchObject([{ ...theirs, sources: [b] }]);

    // What was under way for the first arrives after it went.
    for (const change of [
      saving.watchlist.save("series", gone),
      saving.watchlist.saved("series", gone),
      saving.watchlist.remove(first),
    ]) {
      await expect(change).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    }
    expect((await saving.list()).total).toBe(1);
    expect(told).toEqual([]);

    // Its account comes back under a new id, with the entry it had.
    const back = await saving.add(0);
    expect(back.id).not.toBe(first.subscriptionId);
    expect((await saving.list()).entries).toMatchObject([
      theirs,
      ...before.entries.map(({ id, savedAt, name }) => ({
        subscriptionId: back.id,
        id,
        savedAt,
        name,
        sources: [back.id],
      })),
    ]);

    // With every subscription removed nothing shows, and what each saved waits for it.
    await saving.remove(0);
    await saving.remove(1);
    expect(await saving.list()).toEqual({ total: 0, entries: [] });
    await saving.add(0);
    expect((await saving.list()).entries.map((entry) => entry.id)).toEqual([first.id]);
  });

  it("shows, saves and removes while a subscription's password can't be read, from the lists it loaded before", async () => {
    const { app, saving } = await connected();
    const entry = await saving.save("movie", INDEX_AT_END);
    const before = await saving.list();

    // The keychain no longer opens the password, so nothing can be asked of the provider.
    const locked = await app.start({ locked: true });
    expect(await locked.subscriptions.list()).toMatchObject([{ needsSecret: true }]);
    expect(await locked.list()).toEqual(before);
    await later();
    const other = await locked.save("movie", OLD_AVI);
    await locked.watchlist.remove(entry);
    expect((await locked.list()).entries).toMatchObject([
      { ...other, title: { id: OLD_AVI }, listed: true },
    ]);
  });

  it("stores nothing of a save whose subscription went while the lists were fetched", async () => {
    const { app, saving } = await connected();
    const target = await saving.own(INDEX_AT_END);
    // Nothing is loaded yet, so the save waits for the provider's lists.
    const held = app.providers[0].hold("titles");
    const late = saving.watchlist.save("movie", target);
    late.catch(() => {});
    await held.arrived;

    await saving.remove(0);
    held.release();

    await expect(late).rejects.toMatchObject({ error: { kind: expect.any(String) } });
    await saving.add(0);
    expect((await saving.list()).total).toBe(0);
  });

  it("deletes an account's watchlist for good with its record, and only its own", async () => {
    const { app, saving, b } = await two();
    const kept = await saving.save("movie", OTHER_STORY, 1);
    await later();
    await saving.save("movie", UNNAMED);
    await saving.save("series", FILES);
    await later();
    // A film both list is saved for both, and each keeps a record of its own.
    await saving.save("movie", INDEX_AT_END);
    const key = await saving.account();
    const left = [{ name: "TEST | Index at the end", sources: [b] }, kept];

    // Remove, with its box ticked.
    await saving.remove(0, true);

    expect((await saving.list()).entries).toMatchObject(left);
    const file = Buffer.concat(
      await Promise.all(
        ["mrstreamer.db", "mrstreamer.db-wal"].map((name) =>
          readFile(join(app.dataDir, name)).catch(() => Buffer.alloc(0)),
        ),
      ),
    );
    expect(file.includes(key)).toBe(false);
    // Added again, the account finds nothing of what it saved, and is given nothing.
    const restarted = await app.start();
    await restarted.add(0);
    await restarted.refresh();
    expect((await restarted.list()).entries).toMatchObject(left);
  });
});

describe("the watchlist of several subscriptions", { timeout: 30_000 }, () => {
  /** The ids a page shows, in its order. */
  const ids = (page: WatchlistPage) => page.entries.map((entry) => entry.id);
  /** Which subscription's version each of a title's is. */
  const versionsOf = (entry: WatchlistPage["entries"][number] | undefined) =>
    (entry?.title?.versions ?? []).map(({ subscriptionId, id }) => ({ subscriptionId, id }));
  /** Has a provider list a film no more, from its next lists on. */
  const drop = (provider: FakeProvider, id: string) =>
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.filter((movie) => String(movie.id) !== id),
    }));
  /** Has a provider give a film a TMDB id, from its next lists on. */
  const name = (provider: FakeProvider, id: string, tmdbId: string) =>
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        String(movie.id) === id ? { ...movie, tmdb: tmdbId } : movie,
      ),
    }));

  it("shows a film two subscriptions list as one entry, saved for both at once and found by either's version", async () => {
    const { app, saving, first, second, a, b } = await two();
    const told = await saving.changes();
    const details = () => [first, second].map((provider) => provider.detailRequests());
    const asked = details();

    const entry = await saving.save("movie", SHARED);

    // Neither provider was asked about the title.
    expect(details()).toEqual(asked);
    // One entry, of the one title the lists make of both versions, and one change told.
    const page = await saving.list();
    expect(page.total).toBe(1);
    expect(page.entries).toMatchObject([
      { ...entry, title: { key: "movie:tmdb:101001" }, sources: [a, b], listed: true },
    ]);
    expect(versionsOf(page.entries[0])).toEqual(
      expect.arrayContaining([
        { subscriptionId: a, id: SHARED },
        { subscriptionId: b, id: SHARED_THERE },
      ]),
    );
    expect(told).toHaveLength(1);

    // Whichever version names it, it is that entry, and saving it again changes nothing of it.
    expect(await saving.saved("movie", SHARED_THERE, 1)).toEqual(entry);
    await later();
    expect(await saving.save("movie", SHARED_THERE, 1)).toEqual(entry);
    expect(await saving.list()).toEqual(page);
    const restarted = await app.start();
    expect(await restarted.list()).toEqual(page);

    // Each keeps a record of its own: with the first gone, the second's is the entry, where it
    // was.
    await restarted.remove(0);
    expect((await restarted.list()).entries).toMatchObject([
      { savedAt: page.entries[0]?.savedAt, sources: [b], title: { key: "movie:tmdb:101001" } },
    ]);
  });

  it("keeps titles apart that share only a provider's id, a name, or a TMDB id of another kind", async () => {
    const { saving, a, b } = await two();
    // Under the id the first has the film both list at, the second lists a film of its own.
    const shared = await saving.save("movie", SHARED);
    expect(await saving.saved("movie", OTHER_STORY, 1)).toBeNull();
    await later();
    const other = await saving.save("movie", OTHER_STORY, 1);
    await later();
    // A film neither gives a TMDB id reads the same at both: a name is no proof.
    const namesake = await saving.save("movie", NAMESAKE);
    expect(await saving.saved("movie", NAMESAKE_THERE, 1)).toBeNull();
    await later();
    const there = await saving.save("movie", NAMESAKE_THERE, 1);
    await later();
    // The second's series has the TMDB id a film both list has: TMDB numbers the two apart.
    const film = await saving.save("movie", INDEX_AT_END);
    expect(await saving.saved("series", OTHER_FILES, 1)).toBeNull();
    await later();
    const series = await saving.save("series", OTHER_FILES, 1);

    const page = await saving.list();
    expect(page.entries).toMatchObject([
      { ...series, sources: [b], title: { key: "series:tmdb:100001" } },
      { ...film, sources: [a, b], title: { key: "movie:tmdb:100001" } },
      { ...there, sources: [b], title: { subscriptionId: b, ambiguous: true } },
      { ...namesake, sources: [a], title: { subscriptionId: a, ambiguous: true } },
      { ...other, sources: [b], title: { key: "movie:tmdb:111001" } },
      { ...shared, sources: [a, b], title: { key: "movie:tmdb:101001" } },
    ]);
    expect(page.entries[2]?.title?.title).toBe(page.entries[3]?.title?.title);

    // Removing one takes nothing of another.
    for (const entry of [namesake, shared, film]) await saving.watchlist.remove(entry);
    expect(ids(await saving.list())).toEqual([series.id, there.id, other.id]);
  });

  it("gives a subscription added later no record of a title saved before it, though it plays it", async () => {
    const { saving } = await connected();
    const a = await saving.idOf();
    const entry = await saving.save("movie", SHARED);
    const [{ savedAt } = { savedAt: 0 }] = (await saving.list()).entries;

    await saving.add(1);
    await saving.refresh(1);
    const b = await saving.idOf(1);

    // The same entry, whose title now has the newcomer's version to play as well.
    const [joined] = (await saving.list()).entries;
    expect(joined).toMatchObject({ ...entry, savedAt, sources: [a] });
    expect(versionsOf(joined)).toEqual(
      expect.arrayContaining([
        { subscriptionId: a, id: SHARED },
        { subscriptionId: b, id: SHARED_THERE },
      ]),
    );
    expect(await saving.saved("movie", SHARED_THERE, 1)).toEqual(entry);

    // The newcomer was given nothing: with the first gone it has no such entry, and the
    // first's waits for its account.
    await saving.remove(0);
    expect((await saving.list()).total).toBe(0);
    expect(await saving.saved("movie", SHARED_THERE, 1)).toBeNull();
    await saving.add(0);
    expect((await saving.list()).entries).toMatchObject([{ id: entry.id, savedAt }]);
  });

  it.each([
    { saver: 0, newcomer: 1 },
    { saver: 1, newcomer: 0 },
  ] as const)(
    "keeps an entry's id and time when saving it again gives a subscription that lists it since a record of it (saved by $saver)",
    async ({ saver, newcomer }) => {
      const { app, saving } = await two();
      const ids = [SHARED, SHARED_THERE] as const;
      const owners = [await saving.idOf(0), await saving.idOf(1)] as const;
      // The other subscription lists nothing of the film yet.
      drop(app.providers[newcomer], ids[newcomer]);
      await saving.refresh(newcomer);
      const made = await saving.save("movie", ids[saver], saver);
      // An entry saved before, under an id as saving makes them up: one that sorts behind every
      // other, so no id made up later takes its place by chance.
      const entry = { ...made, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
      app.database((db) => {
        db.prepare("update watchlist set id = ? where id = ?").run(entry.id, made.id);
        db.prepare("update watchlist_versions set entry_id = ? where entry_id = ?").run(
          entry.id,
          made.id,
        );
      });
      const [{ savedAt } = { savedAt: 0 }] = (await saving.list()).entries;
      await later();

      // Listed there too now, it is saved for the one that saved it alone until it is saved again.
      app.providers[newcomer].serveTitles((all) => all);
      await saving.refresh(newcomer);
      expect((await saving.list()).entries).toMatchObject([
        { ...entry, savedAt, sources: [owners[saver]] },
      ]);
      expect(await saving.save("movie", ids[newcomer], newcomer)).toEqual(entry);
      expect((await saving.list()).entries).toMatchObject([{ ...entry, savedAt, sources: owners }]);
      expect(await saving.save("movie", ids[saver], saver)).toEqual(entry);
      expect(await saving.saved("movie", ids[newcomer], newcomer)).toEqual(entry);

      // The record the other got has the entry's time: with the first gone, the entry is where
      // it was.
      await saving.remove(saver);
      expect((await saving.list()).entries).toMatchObject([
        { savedAt, sources: [owners[newcomer]], title: { key: "movie:tmdb:101001" } },
      ]);
    },
  );

  it("takes an entry out with what every subscription saved of it, also where its provider lists it no more, and nothing else", async () => {
    const { saving, second, a, b } = await two();
    const entry = await saving.save("movie", SHARED);
    await later();
    const other = await saving.save("movie", OTHER_STORY, 1);
    await later();
    const namesake = await saving.save("movie", NAMESAKE_THERE, 1);
    // The second drops the film both listed: what it saved of it has no title of its own left.
    drop(second, SHARED_THERE);
    await saving.refresh(1);
    const [, , left] = (await saving.list()).entries;
    expect(left).toMatchObject({ ...entry, sources: [a, b] });
    expect(versionsOf(left)).toEqual([{ subscriptionId: a, id: SHARED }]);

    await saving.watchlist.remove(entry);

    expect(ids(await saving.list())).toEqual([namesake.id, other.id]);
    // Nothing of it is left with the second: listed there again, with the first gone, the
    // film isn't saved.
    second.serveTitles((all) => all);
    await saving.refresh(1);
    await saving.remove(0);
    expect(ids(await saving.list())).toEqual([namesake.id, other.id]);
    expect(await saving.saved("movie", SHARED_THERE, 1)).toBeNull();
  });

  it("makes one entry of what two subscriptions saved once their lists prove it one film, where it was saved first", async () => {
    const { saving, first, second, a, b } = await two();
    const one = await saving.save("movie", NAMESAKE);
    const [{ savedAt } = { savedAt: 0 }] = (await saving.list()).entries;
    await later();
    await saving.save("movie", NAMESAKE_THERE, 1);
    await later();
    const newest = await saving.save("movie", OLD_AVI);
    expect((await saving.list()).total).toBe(3);

    // Both providers now give the film the same TMDB id.
    name(first, NAMESAKE, "424242");
    name(second, NAMESAKE_THERE, "424242");
    await saving.refresh(0);
    await saving.refresh(1);

    const joined = await saving.list();
    expect(ids(joined)).toEqual([newest.id, one.id]);
    expect(joined.entries[1]).toMatchObject({
      ...one,
      savedAt,
      sources: [a, b],
      title: { key: "movie:tmdb:424242" },
    });
    expect(await saving.saved("movie", NAMESAKE_THERE, 1)).toEqual(one);
    // And it goes as one.
    await saving.watchlist.remove(one);
    expect(ids(await saving.list())).toEqual([newest.id]);
    expect(await saving.saved("movie", NAMESAKE_THERE, 1)).toBeNull();
  });

  it("says no provider lists a title only once the lists of every subscription that saved it were looked in", async () => {
    const { saving, first, second, a } = await two();
    await saving.save("movie", SHARED);
    // The second's account is added again while its provider doesn't answer: what it saved is
    // back, without lists to look in.
    await saving.remove(1);
    second.failTitles(503);
    await saving.add(1);
    const b = await saving.idOf(1);
    const entries = async () => (await saving.list()).entries;

    // The first drops the film. Nothing says the second did.
    drop(first, SHARED);
    await saving.refresh(0);
    expect(await entries()).toMatchObject([{ title: null, sources: [a, b], listed: false }]);

    // The second's lists arrive and still have it: the entry is the title again, in its version.
    second.failTitles(null);
    await saving.refresh(1);
    const [there] = await entries();
    expect(there).toMatchObject({ title: { key: "movie:tmdb:101001" }, listed: true });
    expect(versionsOf(there)).toEqual([{ subscriptionId: b, id: SHARED_THERE }]);

    // Once it drops the film too, every list was looked in and none has it.
    drop(second, SHARED_THERE);
    await saving.refresh(1);
    expect(await entries()).toMatchObject([{ title: null, sources: [a, b], listed: true }]);

    // Listed again by either, it is itself.
    first.serveTitles((all) => all);
    await saving.refresh(0);
    expect(versionsOf((await entries())[0])).toEqual([{ subscriptionId: a, id: SHARED }]);
  });

  it("saves a film for adults for the subscription whose row it is alone, and hides it with the setting", async () => {
    const { saving, a, b } = await two();
    await saving.settings.update({ adultTitles: true });

    // Both list the film for adults under one TMDB id, and rows for adults never join: the
    // second's is another title, which isn't saved.
    const adult = await saving.save("movie", ADULT_FILM);
    const [saved] = (await saving.list()).entries;
    expect(saved).toMatchObject({ ...adult, sources: [a], title: { adult: true } });
    expect(versionsOf(saved)).toEqual([{ subscriptionId: a, id: ADULT_FILM }]);
    expect(await saving.saved("movie", ADULT_FILM_THERE, 1)).toBeNull();
    await later();
    const there = await saving.save("movie", ADULT_FILM_THERE, 1);
    expect(ids(await saving.list())).toEqual([there.id, adult.id]);

    // Removing one leaves the other.
    await saving.watchlist.remove(adult);
    expect((await saving.list()).entries).toMatchObject([{ ...there, sources: [b] }]);

    // Hidden, it neither shows nor counts, and stays saved.
    await saving.settings.update({ adultTitles: false });
    expect(await saving.list()).toEqual({ total: 0, entries: [] });
    await saving.settings.update({ adultTitles: true });
    expect(ids(await saving.list())).toEqual([there.id]);
  });

  it("stores a save for every subscription or for none, and takes an entry out of all or of none", async () => {
    const { app, saving, a, b } = await two();
    const told = await saving.changes();
    const theirs = await saving.account(1);
    // The disk gives out at the second's record, after the first's is written.
    app.database((db) =>
      db.exec(`create trigger full before insert on watchlist when new.account = '${theirs}'
               begin select raise(abort, 'disk full'); end`),
    );

    await expect(saving.save("movie", SHARED)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect(await saving.list()).toEqual({ total: 0, entries: [] });
    expect(await saving.saved("movie", SHARED)).toBeNull();
    expect(told).toEqual([]);

    app.database((db) => db.exec("drop trigger full"));
    const entry = await saving.save("movie", SHARED);
    const both = await saving.list();
    expect(both.entries).toMatchObject([{ ...entry, sources: [a, b] }]);

    // A removal that fails at the second's record leaves the first's too.
    app.database((db) =>
      db.exec(`create trigger held before delete on watchlist when old.account = '${theirs}'
               begin select raise(abort, 'database is locked'); end`),
    );
    await expect(saving.watchlist.remove(entry)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect(await saving.list()).toEqual(both);

    app.database((db) => db.exec("drop trigger held"));
    await saving.watchlist.remove(entry);
    expect(await saving.list()).toEqual({ total: 0, entries: [] });
    // Neither kept anything: with the first gone, the second has no such entry.
    await saving.remove(0);
    expect(await saving.saved("movie", SHARED_THERE, 1)).toBeNull();
  });

  /**
   * Both subscriptions saved with nothing loaded, and a save under way that waits for their
   * lists: the second's are in, the first's are held until `release`.
   */
  async function saveWaiting() {
    const app = await watchlistApp();
    const saving = await app.start();
    await saving.add(0);
    await saving.add(1);
    const [a, b] = [await saving.idOf(0), await saving.idOf(1)];
    const held = app.providers[0].hold("titles");
    const late = saving.save("movie", SHARED);
    late.catch(() => {});
    await held.arrived;
    // Observe the other list becoming available before testing the held-save race. Worker
    // startup takes up to two seconds in the measured concurrent setup, before this test's body.
    await vi.waitFor(
      async () => {
        const status = await saving.onDemand.status();
        expect(
          status.lists.find((each) => each.subscriptionId === b)?.fetchedAt ?? null,
          JSON.stringify(status),
        ).not.toBeNull();
      },
      { timeout: 5_000, interval: 50 },
    );
    return { saving, a, b, late, release: () => held.release() };
  }

  it("stores nothing of a save when a subscription that lists the title has its login entered again meanwhile", async () => {
    const { saving, a, b, late, release } = await saveWaiting();

    // The viewer enters the second's password again: what was read under the login before
    // counts no more, for either subscription.
    await saving.subscriptions.update(b, { secret: "demo" });
    release();

    await expect(late).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(await saving.list()).toEqual({ total: 0, entries: [] });
    // Asked again, it is saved for both.
    const entry = await saving.save("movie", SHARED);
    expect((await saving.list()).entries).toMatchObject([{ ...entry, sources: [a, b] }]);
  });

  it("gives a subscription that goes while a save waits no record of it", async () => {
    const { saving, a, late, release } = await saveWaiting();

    await saving.remove(1);
    release();

    // Saved for the one that stays, as the title its lists alone make.
    const entry = await late;
    const [saved] = (await saving.list()).entries;
    expect(saved).toMatchObject({ ...entry, sources: [a] });
    expect(versionsOf(saved)).toEqual([{ subscriptionId: a, id: SHARED }]);
    // The other's account, added again, kept nothing of it.
    await saving.add(1);
    await saving.refresh(1);
    await saving.remove(0);
    expect((await saving.list()).total).toBe(0);
  });

  it("plays a saved film from the subscription picked, with that one's own progress, and stays saved", async () => {
    const { saving, first, second, a, b } = await two();
    const entry = await saving.save("movie", SHARED);
    const before = await saving.list();
    const here = { kind: "movie" as const, subscriptionId: a, id: SHARED };
    const there = { kind: "movie" as const, subscriptionId: b, id: SHARED_THERE };

    // Each version is its own subscription's file.
    expect((await saving.onDemand.file(here)).url.startsWith(first.url)).toBe(true);
    expect((await saving.onDemand.file(there)).url.startsWith(second.url)).toBe(true);

    // Played in the second's version, that one alone got anywhere, and the entry is as it was.
    await saving.viewing.recordProgress(randomUUID(), there, 600, 6000, Date.now());
    const progress = await saving.viewing.progress({ movies: [here, there] });
    expect(progress.map((each) => each.title)).toEqual([there]);
    expect(await saving.list()).toEqual(before);

    // Taking it off the watchlist leaves how far it got.
    await saving.watchlist.remove(entry);
    expect(await saving.viewing.progress({ movies: [here, there] })).toEqual(progress);
  });
});

describe("titles for adults on the watchlist", { timeout: 30_000 }, () => {
  it("keeps them saved, and shows and counts them only while the viewer shows titles for adults", async () => {
    const { provider, saving } = await connected();
    await saving.save("movie", INDEX_AT_END);
    await later();
    const turned = await saving.save("series", FILES);
    await later();
    const adult = await saving.save("series", AFTER_DARK);
    const ordinary = [{ name: "TEST | Index at the end", available: true }];
    const [{ name: files } = { name: "" }] = (await saving.list()).entries;

    expect(await saving.list()).toMatchObject({ total: 2 });
    await saving.settings.update({ adultTitles: true });
    expect(await saving.list()).toMatchObject({ total: 3 });
    expect(
      await saving.watchlist.list({ sort: "saved", offset: 0, limit: 100, home: true }),
    ).toMatchObject({ total: 2 });
    expect((await saving.shown())[0]).toEqual({ name: "After Dark", available: true });

    // The provider drops the one, and marks another for adults.
    provider.serveTitles((all) => ({
      ...all,
      series: all.series.flatMap((series) =>
        String(series.id) === AFTER_DARK
          ? []
          : String(series.id) === FILES
            ? [{ ...series, adult: true }]
            : [series],
      ),
    }));
    await saving.refresh();
    expect(await saving.shown()).toEqual([
      { name: "After Dark", available: false },
      { name: files, available: true },
      ...ordinary,
    ]);

    // Hidden, nothing of either shows, in either order: no name, and no count.
    await saving.settings.update({ adultTitles: false });
    expect(await saving.list()).toMatchObject({ total: 1 });
    expect(await saving.shown()).toEqual(ordinary);
    expect(await saving.shown("title")).toEqual(ordinary);

    await saving.settings.update({ adultTitles: true });
    expect((await saving.list()).entries).toMatchObject([
      { ...adult, title: null },
      { ...turned, title: { adult: true } },
      { title: { adult: false } },
    ]);
    const home = await saving.watchlist.list({ sort: "saved", offset: 0, limit: 100, home: true });
    expect(home.total).toBe(1);
    expect(home.entries.map((entry) => entry.name)).toEqual(ordinary.map((entry) => entry.name));
  });

  it("keeps a saved title for adults its own while another title has its provider id", async () => {
    const { provider, saving } = await connected();
    await saving.settings.update({ adultTitles: true });
    const adult = await saving.save("series", AFTER_DARK);
    await later();

    // The provider gives the id to a series that isn't for adults, as its TMDB id says, and the
    // viewer saves that one too.
    provider.serveTitles((all) => ({
      ...all,
      series: all.series.map((series) =>
        String(series.id) === AFTER_DARK
          ? { ...series, adult: false, name: "Morning Light (EN)", tmdb: "777" }
          : series,
      ),
    }));
    await saving.refresh();
    const other = await saving.save("series", AFTER_DARK);

    expect(other.id).not.toBe(adult.id);
    const both = [
      { name: "Morning Light", available: true },
      { name: "After Dark", available: false },
    ];
    expect(await saving.shown()).toEqual(both);
    // Only the one saved as a title for adults hides with them.
    await saving.settings.update({ adultTitles: false });
    expect(await saving.shown()).toEqual(both.slice(0, 1));
    await saving.settings.update({ adultTitles: true });

    // Listed again, the first is itself, though the newcomer's entry holds the id as well.
    provider.serveTitles((all) => all);
    await saving.refresh();
    expect(await saving.shown()).toEqual([
      { name: "Morning Light", available: false },
      { name: "After Dark", available: true },
    ]);
    expect(await saving.saved("series", AFTER_DARK)).toEqual(adult);
  });
});

describe("the watchlist beside the viewing record", { timeout: 30_000 }, () => {
  it("leaves progress and Continue watching as they were, and stays as it was while titles are played, finished and removed there", async () => {
    const { saving } = await connected();
    const movie = { kind: "movie" as const, ...(await saving.own(INDEX_AT_END)) };
    const series = await saving.own(FORMATS);
    const episode = {
      kind: "episode" as const,
      subscriptionId: series.subscriptionId,
      id: "81000",
      seriesId: FORMATS,
      season: 1,
      episode: 1,
    };
    await saving.viewing.recordProgress(randomUUID(), movie, 600, 6000, Date.now());
    const record = await saving.viewing.state();
    const progress = await saving.viewing.progress({ movies: [movie] });

    const entry = await saving.save("movie", INDEX_AT_END);
    await saving.watchlist.remove(entry);
    await saving.save("movie", INDEX_AT_END);
    await later();
    await saving.save("series", FORMATS);

    expect(await saving.viewing.state()).toEqual(record);
    expect(await saving.viewing.progress({ movies: [movie] })).toEqual(progress);
    const before = await saving.list();

    await saving.viewing.recordProgress(randomUUID(), movie, 5990, 6000, Date.now());
    await saving.viewing.recordProgress(randomUUID(), episode, 2690, 2700, Date.now());
    await saving.viewing.removeFromContinue(randomUUID(), { movies: [movie] });
    await saving.viewing.finishSeries(randomUUID(), [series], Date.now());

    expect(await saving.list()).toEqual(before);
  });

  it("survives the record being rebuilt and builds from before it writing to the file, and starts empty on a file from before it", async () => {
    const { app, saving } = await connected();
    const movie = { kind: "movie" as const, ...(await saving.own(INDEX_AT_END)) };
    await saving.save("movie", INDEX_AT_END);
    await later();
    await saving.save("series", FORMATS);
    await saving.viewing.recordProgress(randomUUID(), movie, 600, 6000, Date.now());
    const before = await saving.list();
    const record = await saving.viewing.state();
    const account = await saving.account();

    // What an older build does with the file: it rebuilds the state its rules add up to, and
    // adds events of its own, without a payload. Then what a change to this build's rules does.
    app.database((db) => {
      db.exec("delete from state; delete from titles;");
      db.prepare(
        "insert into events (account, type, version, channel_id, at, command_id) values (?, 'watched', 1, 'c1', 1, 'older-build')",
      ).run(account);
      db.exec("delete from meta where key = 'state-version';");
    });

    const rebuilt = await app.start();
    expect(await rebuilt.list()).toEqual(before);
    expect((await rebuilt.viewing.state()).continueWatching).toEqual(record.continueWatching);

    // The database as builds before the watchlist left it.
    app.database((db) => db.exec("drop table watchlist; drop table watchlist_versions;"));

    const restarted = await app.start();
    expect(await restarted.list()).toMatchObject({ total: 0 });
    expect(
      (await restarted.viewing.state()).continueWatching.map((entry) => entry.title.id),
    ).toEqual([INDEX_AT_END]);
    await restarted.save("movie", INDEX_AT_END);
    expect(await restarted.shown()).toEqual([{ name: "TEST | Index at the end", available: true }]);
  });
});

describe("a watchlist change the database refuses", { timeout: 30_000 }, () => {
  it("still reads what was saved when new lists can't be taken over, and takes them over later", async () => {
    const { app, provider, saving } = await connected();
    const first = await saving.save("movie", UNNAMED);
    await later();
    await saving.save("movie", UNNAMED_TOO);
    const versions = new Set([UNNAMED, UNNAMED_TOO]);
    provider.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) =>
        versions.has(String(movie.id)) ? { ...movie, tmdb: "424242" } : movie,
      ),
    }));
    app.database((db) =>
      db.exec(`create trigger held before delete on watchlist
               begin select raise(abort, 'database is locked'); end`),
    );
    await saving.refresh();

    // Both entries are the one film now, and stay two until the record can be written.
    const held = await saving.list();
    expect(held.total).toBe(2);
    expect(held.entries.every((entry) => entry.title?.tmdbId === "424242")).toBe(true);

    app.database((db) => db.exec("drop trigger held"));
    expect((await saving.list()).entries.map((entry) => entry.id)).toEqual([first.id]);
  });

  it("fails its calls when the database can't open", async () => {
    const app = await watchlistApp();
    await mkdir(join(app.dataDir, "mrstreamer.db"), { recursive: true });
    const saving = await app.start();
    await saving.add(0);

    await expect(saving.save("movie", INDEX_AT_END)).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    await expect(saving.list()).rejects.toMatchObject({ error: { kind: "unexpected" } });
  });
});
