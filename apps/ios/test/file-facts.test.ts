import type { SeriesDetails, TitleDetails, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import type { FilterFiles } from "@mrstreamer/core/ondemand/filters";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { browseCollection } from "../src/title-browse.ts";

// The languages of the tracks playback finds in a provider file, as titles.ts keeps them and
// Browse's filters count them: through `titleFile`'s `observed`, over real files on disk
// (`native-files.ts`) and the desktop tests' fake Xtream panel. These cases call `observed` as
// playback will once it is wired to it; they say nothing of which files playback tells, or of
// what a native player reports.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** Each request to the panel: its `action`, or "login" for the login check. */
  requests: [] as string[],
  /** Passwords the panel takes for its own, as one whose password was changed. */
  aliases: [] as Array<readonly [alias: string, password: string]>,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async () => undefined,
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => memory.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void memory.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void memory.keychain.delete(key),
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

const DETAILS = new Set(["get_vod_info", "get_series_info"]);
const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const url = memory.aliases.reduce(
    (each, [alias, password]) =>
      each.replaceAll(encodeURIComponent(alias), encodeURIComponent(password)),
    input,
  );
  memory.requests.push(new URL(url).searchParams.get("action") ?? "login");
  return passThrough(url, init);
});

const { native } = await import("./native-files.ts");

interface FakeMovie {
  readonly id: number;
  readonly name: string;
  readonly container: string;
  readonly tmdb?: string;
}
interface FakeSeries {
  readonly id: number;
  readonly seasons: readonly (readonly unknown[])[];
}
interface FakeTitles {
  readonly movies: readonly FakeMovie[];
  readonly series: readonly FakeSeries[];
}
interface FakeProvider {
  readonly url: string;
  serveTitles(select: (all: FakeTitles) => FakeTitles): void;
  close(): Promise<void>;
}
/** The fake is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
  }): Promise<FakeProvider>;
};

const ONE = { username: "canaryuser", password: "canary+Pw@1" };
const LOGIN = [ONE.username, ONE.password];
let panel: FakeProvider;
beforeAll(async () => {
  panel = await startFakeProvider({ ...ONE, channels: 2, titles: 20 });
});
afterAll(async () => {
  await panel.close();
});

/** Two movies of the panel as two versions of one film: Dutch, and English in 4K. */
const twoVersions = (all: FakeTitles): FakeTitles => ({
  ...all,
  movies: all.movies.map((movie) =>
    movie.id === 91_000
      ? { ...movie, name: "Same Film 2024 (NL)", container: "mp4", tmdb: "77777" }
      : movie.id === 91_001
        ? { ...movie, name: "Same Film 2024 4K (EN)", container: "mp4", tmdb: "77777" }
        : movie,
  ),
});
const changing = (id: number, change: Partial<FakeMovie>) => (all: FakeTitles) => {
  const both = twoVersions(all);
  return {
    ...both,
    movies: both.movies.map((movie) => (movie.id === id ? { ...movie, ...change } : movie)),
  };
};

const folder = join(native.root, "cache", "details");
/** Every record saved, by its path under Caches/details. */
function records(at = folder, under = ""): string[] {
  if (!existsSync(at)) return [];
  return readdirSync(at, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? records(join(at, entry.name), `${under}${entry.name}/`)
      : [`${under}${entry.name}`],
  );
}
const savedPath = () => records().find((path) => path.endsWith("/files.json"));
const settle = (ms = 150) => new Promise((done) => setTimeout(done, ms));
const detailsAskedSince = (from: number) =>
  memory.requests.slice(from).filter((action) => DETAILS.has(action)).length;

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what = "the condition") {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same files. */
async function launch() {
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TMDB_KEY", "");
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const cache = await import("../src/details-cache.ts");
  await account.restore();
  if (account.members().length > 0) {
    await until(() => titles.titleLists().kind === "ready", "the movie and series lists");
  }
  return { ...account, ...titles, readFiles: cache.readFiles };
}
type App = Awaited<ReturnType<typeof launch>>;

async function added(app: App) {
  const id = await app.add({ server: panel.url, ...ONE });
  if (!id) throw new Error("The add was cancelled");
  await until(() => app.titleLists().kind === "ready", "the movie and series lists");
  return id;
}

const indexOf = (app: App) => {
  const lists = app.titleLists();
  return lists.kind === "ready" ? lists.index : null;
};
/** The lists published again after the panel's are read again. */
async function relisted(app: App, id: string) {
  const before = indexOf(app);
  app.reloadTitles(id);
  await until(() => indexOf(app) !== null && indexOf(app) !== before, "the lists read again");
}

const tracksOf = (files: FilterFiles, version: string) =>
  files.get(version)?.find((file) => file.tracks)?.tracks;
const movieRef = (subscriptionId: string, id: string) =>
  ({ kind: "movie", subscriptionId, id }) as const;
const lookUp = (app: App, ref: Parameters<App["titleFile"]>[0]) =>
  app.titleFile(ref, AbortSignal.timeout(5_000));
/** Looks `ref`'s file up and tells what playback found in it, as playback will. */
async function found(
  app: App,
  ref: Parameters<App["titleFile"]>[0],
  tracks: {
    readonly audio: readonly (string | null)[];
    readonly subtitles: readonly (string | null)[];
  },
) {
  const file = await lookUp(app, ref);
  if (!file.observed) throw new Error("No place to tell what was found");
  file.observed(tracks);
}
const savedIds = async (app: App, id: string) =>
  ((await app.readFiles(id, LOGIN, () => true)) ?? []).map((file) => file.id).toSorted();
const versionTags = (app: App, kind: TitleKind, version: string) => {
  const index = indexOf(app);
  return index
    ? kindOf(index, kind)
        .byId.get(version)
        ?.versions.find((each) => ownedKey(each) === version)?.tags
    : undefined;
};
const seriesOf = (details: TitleDetails): SeriesDetails => {
  if (details.kind !== "series") throw new Error("Not a series");
  return details;
};
const titleAt = (app: App, kind: TitleKind, version: string) => {
  const index = indexOf(app);
  const title = index ? kindOf(index, kind).byId.get(version) : undefined;
  if (!title) throw new Error(`No ${kind} ${version}`);
  return title;
};

/** Holds the saved facts' read until `release`. */
function holdSavedRead() {
  const held = { reading: false, release: () => {} };
  const gate = new Promise<void>((done) => {
    held.release = done;
  });
  native.gate = (operation, file) => {
    if (operation !== "text" || !file.endsWith("/files.json")) return undefined;
    held.reading = true;
    return gate;
  };
  return held;
}

let releases: Array<() => void> = [];
beforeEach(async () => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  rmSync(join(native.root, "cache"), { recursive: true, force: true });
  const { Directory, Paths } = await import("./native-files.ts");
  for (const each of [Paths.document, Paths.cache])
    new Directory(each).create({ idempotent: true });
  native.gate = null;
  native.sync = null;
  native.undeletable = null;
  memory.keychain.clear();
  memory.requests.length = 0;
  memory.aliases = [];
  panel.serveTitles((all) => all);
  releases = [];
});
afterEach(() => {
  native.gate = null;
  for (const release of releases.splice(0)) release();
  vi.unstubAllEnvs();
});

describe("tracks found in a movie's file", () => {
  it("count for its listed row, across a relaunch, against that one version, asking nothing", async () => {
    panel.serveTitles(twoVersions);
    let app = await launch();
    const id = await added(app);
    const dutch = ownedKey({ subscriptionId: id, id: "91000" });
    await found(app, movieRef(id, "91000"), { audio: ["nl", "en"], subtitles: ["nl"] });
    await until(() => tracksOf(app.filterFilesOf("movie"), dutch) !== undefined, "the facts");
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toEqual({
      audio: ["nl", "en"],
      subtitles: ["nl"],
    });
    await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);

    const from = memory.requests.length;
    const made = app.collectionsOf("movie");
    if (!made) throw new Error("No collections");
    const english = { kind: "audio", language: "en" } as const;
    const files = app.filterFilesOf("movie");
    const heard = browseCollection(made, "all", { filters: { verified: english } }, files);
    expect(
      heard.titles.filter((title) => title.tmdbId === "77777").map((title) => title.id),
    ).toEqual(["91000"]);
    expect(heard.files).toBe(1);
    expect(heard.verified).toContainEqual({ value: english, count: 1 });
    // The 4K mark is the English version's; the English sound was found in the Dutch one.
    const both = browseCollection(
      made,
      "all",
      { filters: { verified: english, quality: "4k" } },
      files,
    );
    expect(both.titles.some((title) => title.tmdbId === "77777")).toBe(false);
    const fourK = browseCollection(made, "all", { filters: { quality: "4k" } }, files);
    expect(fourK.titles.find((title) => title.tmdbId === "77777")?.id).toBe("91001");
    browseCollection(
      made,
      "all",
      { filters: { verified: { kind: "subtitles", language: "nl" } } },
      files,
    );
    expect(memory.requests.length).toBe(from);

    app = await launch();
    const asked = memory.requests.length;
    await until(() => tracksOf(app.filterFilesOf("movie"), dutch) !== undefined, "the saved facts");
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toEqual({
      audio: ["nl", "en"],
      subtitles: ["nl"],
    });
    expect(detailsAskedSince(asked)).toBe(0);
  });

  it("stop counting once the lists show the row renamed or in another file type, and count again for it", async () => {
    panel.serveTitles(twoVersions);
    const app = await launch();
    const id = await added(app);
    const dutch = ownedKey({ subscriptionId: id, id: "91000" });
    await found(app, movieRef(id, "91000"), { audio: ["nl"], subtitles: [] });
    await until(() => tracksOf(app.filterFilesOf("movie"), dutch) !== undefined, "the facts");

    panel.serveTitles(changing(91_000, { name: "Same Film 2024 (NL) Remastered" }));
    await relisted(app, id);
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toBeUndefined();
    panel.serveTitles(changing(91_000, { container: "mkv" }));
    await relisted(app, id);
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toBeUndefined();
    panel.serveTitles(twoVersions);
    await relisted(app, id);
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toEqual({ audio: ["nl"], subtitles: [] });
  });

  it("writes nothing for unchanged tracks, and keeps them while a later play tells nothing", async () => {
    panel.serveTitles(twoVersions);
    let app = await launch();
    const id = await added(app);
    const dutch = ownedKey({ subscriptionId: id, id: "91000" });
    const tracks = { audio: ["nl", null], subtitles: [] };
    await found(app, movieRef(id, "91000"), tracks);
    await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);
    const path = savedPath();
    if (!path) throw new Error("Nothing saved");
    const text = readFileSync(join(folder, path), "utf8");
    let writes = 0;
    native.gate = (operation, file) => {
      if (operation !== "text" && file.includes("files.json")) writes++;
      return undefined;
    };
    await found(app, movieRef(id, "91000"), tracks);
    await settle();
    expect(writes).toBe(0);
    expect(readFileSync(join(folder, path), "utf8")).toBe(text);
    native.gate = null;
    // Played again with no tracks told, as when they never settle: what was found stays.
    await lookUp(app, movieRef(id, "91000"));
    app = await launch();
    await until(() => tracksOf(app.filterFilesOf("movie"), dutch) !== undefined, "the saved facts");
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toEqual(tracks);
  });

  it("takes a file found while the saved facts are read in beside them, and saves both", async () => {
    panel.serveTitles(twoVersions);
    let app = await launch();
    const id = await added(app);
    await found(app, movieRef(id, "91000"), { audio: ["nl"], subtitles: [] });
    await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);

    app = await launch();
    const held = holdSavedRead();
    releases.push(held.release);
    app.filterFilesOf("movie");
    await until(() => held.reading, "the saved facts' read");
    await found(app, movieRef(id, "91001"), { audio: ["en"], subtitles: ["en"] });
    native.gate = null;
    held.release();
    const keys = ["91000", "91001"].map((each) => ownedKey({ subscriptionId: id, id: each }));
    await until(
      () => keys.every((each) => tracksOf(app.filterFilesOf("movie"), each) !== undefined),
      "both files' facts",
    );
    await expect.poll(() => savedIds(app, id)).toEqual(["91000", "91001"]);
  });

  it.each(["replaced", "removed"] as const)(
    "saves and counts nothing more once the login is %s while the saved facts are read",
    async (how) => {
      const NEW = "canaryNew9";
      memory.aliases = [[NEW, ONE.password]];
      panel.serveTitles(twoVersions);
      let app = await launch();
      const id = await added(app);
      await found(app, movieRef(id, "91000"), { audio: ["nl"], subtitles: [] });
      await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);

      app = await launch();
      const late = await lookUp(app, movieRef(id, "91001"));
      const held = holdSavedRead();
      releases.push(held.release);
      app.filterFilesOf("movie");
      await until(() => held.reading, "the saved facts' read");
      const change =
        how === "replaced"
          ? app.update(id, { password: NEW })
          : app.remove(id, { keepHistory: true });
      await settle();
      late.observed?.({ audio: ["en"], subtitles: [] });
      native.gate = null;
      held.release();
      await change;
      await settle();
      expect(savedPath()).toBeUndefined();
      if (how === "replaced") {
        await until(() => app.members()[0]?.titles.kind === "ready", "the new login's lists");
        await until(() => indexOf(app) !== null, "the lists");
        for (const each of ["91000", "91001"]) {
          expect(
            tracksOf(app.filterFilesOf("movie"), ownedKey({ subscriptionId: id, id: each })),
          ).toBeUndefined();
        }
        await settle();
        expect(savedPath()).toBeUndefined();
      }
    },
  );

  it("reads saved facts it doesn't know as unknown, and drops what it mustn't keep", async () => {
    panel.serveTitles(twoVersions);
    let app = await launch();
    const id = await added(app);
    const dutch = ownedKey({ subscriptionId: id, id: "91000" });
    await found(app, movieRef(id, "91000"), { audio: ["nl"], subtitles: [] });
    await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);
    const path = savedPath();
    if (!path) throw new Error("Nothing saved");
    const file = join(folder, path);
    const saved = readFileSync(file, "utf8");

    writeFileSync(file, saved.replace('"version":1', '"version":2'));
    app = await launch();
    app.filterFilesOf("movie");
    await expect.poll(() => existsSync(file)).toBe(false);
    expect(tracksOf(app.filterFilesOf("movie"), dutch)).toBeUndefined();

    // One entry as written, one holding the password, one too long, one with too many tracks.
    const entry = {
      kind: "movie",
      id: "91000",
      name: "Same Film 2024 (NL)",
      container: "mp4",
      audio: ["nl"],
      subtitles: [],
      at: Date.now(),
    };
    const files = [
      entry,
      { ...entry, id: "91002", name: `Leak ${ONE.password}` },
      { ...entry, id: "91003", name: "x".repeat(513) },
      { ...entry, id: "91004", audio: Array.from({ length: 33 }, () => "en") },
    ];
    writeFileSync(file, JSON.stringify({ version: 1, subscriptionId: id, at: Date.now(), files }));
    app = await launch();
    await until(() => tracksOf(app.filterFilesOf("movie"), dutch) !== undefined, "the kept facts");
    await found(app, movieRef(id, "91001"), { audio: ["en"], subtitles: [] });
    await expect.poll(() => savedIds(app, id)).toEqual(["91000", "91001"]);
    expect(readFileSync(file, "utf8")).not.toContain(ONE.password);
  });
});

describe("tracks found in an episode's file", () => {
  it("count only while its series answer was asked under the lists that show, and nothing is asked for it", async () => {
    const app = await launch();
    const id = await added(app);
    const version = ownedKey({ subscriptionId: id, id: "80001" });
    const series = titleAt(app, "series", version);
    const from = memory.requests.length;
    const [episode] = seriesOf(await app.detailsOf(series)).seasons[0]?.episodes ?? [];
    if (!episode) throw new Error("No episode");
    await found(
      app,
      {
        kind: "episode",
        subscriptionId: episode.subscriptionId,
        id: episode.id,
        seriesId: episode.seriesId,
        season: episode.season,
        episode: episode.number,
      },
      { audio: ["nl"], subtitles: ["nl"] },
    );
    expect(detailsAskedSince(from)).toBe(1);
    await until(() => tracksOf(app.filterFilesOf("series"), version) !== undefined, "the facts");
    const files = app.filterFilesOf("series").get(version) ?? [];
    expect(files.filter((file) => file.tracks)).toEqual([
      { tags: versionTags(app, "series", version), tracks: { audio: ["nl"], subtitles: ["nl"] } },
    ]);
    expect(files.length).toBeGreaterThan(1);

    // Newer lists: the answer this run holds was asked under the lists before them.
    await relisted(app, id);
    expect(app.filterFilesOf("series").get(version)).toBeUndefined();
    await app.detailsOf(titleAt(app, "series", version));
    expect(app.filterFilesOf("series").get(version)).toBeUndefined();
    expect(detailsAskedSince(from)).toBe(1);
  });

  it("keep a held series with no episodes in the declared filters", async () => {
    panel.serveTitles((all) => ({
      ...all,
      series: all.series.map((each) => (each.id === 80_001 ? { ...each, seasons: [] } : each)),
    }));
    const app = await launch();
    const id = await added(app);
    const version = ownedKey({ subscriptionId: id, id: "80001" });
    await app.detailsOf(titleAt(app, "series", version));
    await until(() => app.filterFilesOf("series").has(version), "the held answer");
    expect(app.filterFilesOf("series").get(version)).toEqual([
      { tags: versionTags(app, "series", version) },
    ]);
    const made = app.collectionsOf("series");
    if (!made) throw new Error("No collections");
    const dutch = browseCollection(
      made,
      "all",
      { filters: { language: "nl" } },
      app.filterFilesOf("series"),
    );
    expect(dutch.titles.some((title) => title.id === "80001")).toBe(true);
  });
});
