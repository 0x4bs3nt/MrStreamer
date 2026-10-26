import { createRoot, window } from "./dom.ts";
import * as React from "react";
import type {
  Episode,
  SeriesDetails,
  TitleDetails,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import type { FilterFiles } from "@mrstreamer/core/ondemand/filters";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { browseCollection } from "../src/title-browse.ts";
import { nativePlayer } from "./native-player.ts";

// The languages of the tracks playback finds in a provider file, as titles.ts keeps them and
// Browse's filters count them: through `titleFile`'s `observed`, over real files on disk
// (`native-files.ts`) and the desktop tests' fake Xtream panel. Cache cases call the public
// `observed` sink directly; caller cases deliver native-port snapshots through the real player
// and play-title owners. Neither establishes AVFoundation behavior. A screen that reads them
// as `useFileFacts` says runs with React DOM on a happy-dom window.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** Each request to the panel: its `action`, or "login" for the login check. */
  requests: [] as string[],
  /** Passwords the panel takes for its own, as one whose password was changed. */
  aliases: [] as Array<readonly [alias: string, password: string]>,
  /** Passwords the Keychain has stored but whose write it hasn't answered yet. */
  heldSecrets: [] as Array<() => void>,
  holdSecrets: false,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
const player = nativePlayer();
vi.mock("expo-video", () => ({ createVideoPlayer: () => player }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => memory.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    memory.keychain.set(key, value);
    if (memory.holdSecrets && key.startsWith("s.")) {
      await new Promise<void>((go) => memory.heldSecrets.push(go));
    }
  },
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
interface FakeEpisode {
  readonly id: number | string;
  readonly container: string;
}
/** The panel's ids are numbers; a provider's may be any text, which the panel sends as it is. */
interface FakeSeries {
  readonly id: number | string;
  readonly name: string;
  readonly tmdb?: string;
  readonly seasons: readonly (readonly FakeEpisode[])[];
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
let runningPlayback: typeof import("../src/playback.ts") | undefined;
async function launch() {
  await runningPlayback?.stop();
  vi.resetModules();
  vi.stubEnv("EXPO_PUBLIC_TMDB_KEY", "");
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const cache = await import("../src/details-cache.ts");
  const { currentSource } = await import("../src/sources.ts");
  const playback = await import("../src/playback.ts");
  runningPlayback = playback;
  const playTitle = await import("../src/play-title.ts");
  const preferences = await import("../src/media-preferences.ts");
  await account.restore();
  if (account.members().length > 0) {
    await until(() => titles.titleLists().kind === "ready", "the movie and series lists");
  }
  return {
    ...account,
    ...titles,
    readFiles: cache.readFiles,
    currentSource,
    playback,
    playTitle,
    preferences,
  };
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
const episodeRef = (episode: Episode) =>
  ({
    kind: "episode",
    subscriptionId: episode.subscriptionId,
    id: episode.id,
    seriesId: episode.seriesId,
    season: episode.season,
    episode: episode.number,
  }) as const;
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

/** The first episode of a listed series, as its details answer, asked under the lists now. */
async function firstEpisode(app: App, version: string) {
  const details = seriesOf(await app.detailsOf(titleAt(app, "series", version)));
  const episode = details.seasons[0]?.episodes[0];
  if (!episode) throw new Error("No episode");
  return episode;
}

/** Holds the saved facts' next read (`text`) or write until `release`. */
function holdSaved(operation: "text" | "write") {
  const held = { started: false, release: () => {} };
  const gate = new Promise<void>((done) => {
    held.release = done;
  });
  native.gate = (each, file) => {
    if (each !== operation || !file.includes("/files.json")) return undefined;
    held.started = true;
    return gate;
  };
  releases.push(held.release);
  return held;
}

/**
 * A screen showing what Browse's filters count, rendered again whenever `useFileFacts` says to:
 * how many listed movie files, then episode files, have tracks found. Answers what it shows.
 */
function watched(app: App) {
  const container = window.document.createElement("div");
  const root = createRoot(container);
  function Counts() {
    app.useFileFacts();
    const counts = (["movie", "series"] as const).map((kind) => {
      const made = app.collectionsOf(kind);
      return made
        ? browseCollection(made, "all", { filters: {} }, app.filterFilesOf(kind)).files
        : 0;
    });
    return React.createElement("span", null, counts.join(" "));
  }
  root.render(React.createElement(Counts));
  unmounts.push(() => root.unmount());
  return () => container.textContent;
}

let releases: Array<() => void> = [];
let unmounts: Array<() => void> = [];
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
  memory.holdSecrets = false;
  panel.serveTitles((all) => all);
  player.tracks = null;
  player.play.mockClear();
  player.selectObservedTrackAsync.mockReset().mockResolvedValue({ kind: "requested" });
  releases = [];
});
afterEach(async () => {
  native.gate = null;
  for (const release of [...releases.splice(0), ...memory.heldSecrets.splice(0)]) release();
  for (const unmount of unmounts.splice(0)) unmount();
  vi.unstubAllEnvs();
  await runningPlayback?.stop();
});

describe("tracks found in a movie's file", () => {
  it("forwards a real movie play's settled snapshots into Browse, using its actual original language", async () => {
    panel.serveTitles(twoVersions);
    const app = await launch();
    const id = await added(app);
    const version = { subscriptionId: id, id: "91000" };
    const key = ownedKey(version);
    app.preferences.updateMediaPreferences("audio", { kind: "original" });
    app.playTitle.playMovie(
      { ...titleAt(app, "movie", key), originalLanguage: "fr" },
      version,
      0,
      () => undefined,
    );
    await until(
      () =>
        player.identity().attemptId > 0 &&
        app.playback.playbackState.get().phase.kind === "loading",
      "movie attachment",
    );
    await until(() => player.play.mock.calls.length > 0, "movie admission");
    const identity = player.identity();
    const tracks = {
      ...identity,
      revision: 1,
      audio: {
        state: "ready" as const,
        options: ["en", "fr"].map((language, index) => ({
          ...identity,
          revision: 1,
          id: String(index),
          group: "audio" as const,
          language,
          label: language,
          isDefault: index === 0,
          isPlayable: true,
        })),
      },
      subtitles: { state: "absent" as const, options: [] },
      selectedAudioId: "0",
      selectedSubtitleId: null,
      subtitleOffAllowed: false,
    };
    player.selectObservedTrackAsync.mockImplementation(async (_item, _revision, choice) => {
      const current = player.tracks;
      if (!current) throw new Error("No native snapshot");
      player.tracks = {
        ...current,
        ...(choice.kind === "audio"
          ? { selectedAudioId: choice.track.id }
          : { selectedSubtitleId: choice.track?.id ?? null }),
      };
      return { kind: "requested" };
    });
    player.tracks = tracks;
    player.observation({ kind: "tracks", tracks });
    await until(() => player.tracks?.selectedAudioId === "1", "French original sound");
    await until(
      () => tracksOf(app.filterFilesOf("movie"), key) !== undefined,
      "facts forwarded by playback",
    );
    expect(tracksOf(app.filterFilesOf("movie"), key)).toEqual({
      audio: ["en", "fr"],
      subtitles: [],
    });
    const changed = {
      ...tracks,
      revision: 2,
      audio: {
        ...tracks.audio,
        options: tracks.audio.options.map((track) => ({ ...track, revision: 2 })),
      },
      subtitles: {
        state: "ready" as const,
        options: [
          {
            ...identity,
            revision: 2,
            id: "0",
            group: "subtitles" as const,
            language: "nl",
            label: "Dutch",
            isDefault: false,
            isPlayable: true,
            forcedOnly: false,
          },
        ],
      },
    };
    player.tracks = changed;
    player.observation({ kind: "tracks", tracks: changed });
    await until(
      () => tracksOf(app.filterFilesOf("movie"), key)?.subtitles.length === 1,
      "later settled subtitles",
    );
    const unknown = {
      ...changed,
      revision: 3,
      audio: {
        ...changed.audio,
        options: changed.audio.options.map((track) => ({ ...track, revision: 3 })),
      },
      subtitles: { state: "unavailable" as const, options: [] },
    };
    player.tracks = unknown;
    player.observation({ kind: "tracks", tracks: unknown });
    await settle(0);
    expect(tracksOf(app.filterFilesOf("movie"), key)?.subtitles).toEqual(["nl"]);
    const asked = memory.requests.length;
    const made = app.collectionsOf("movie");
    if (!made) throw new Error("No movie collections");
    expect(
      browseCollection(
        made,
        "all",
        { filters: { verified: { kind: "audio", language: "fr" } } },
        app.filterFilesOf("movie"),
      ).titles.some((title) => title.id === "91000"),
    ).toBe(true);
    expect(memory.requests).toHaveLength(asked);
    await app.playback.stop();
  });

  it("binds a real episode play's facts to its listing and uses details.title.originalLanguage", async () => {
    const app = await launch();
    const id = await added(app);
    const key = ownedKey({ subscriptionId: id, id: "80001" });
    const details = seriesOf(await app.detailsOf(titleAt(app, "series", key)));
    const episode = details.seasons[0]?.episodes[0];
    if (!episode) throw new Error("No episode");
    app.preferences.updateMediaPreferences("audio", { kind: "original" });
    player.play.mockClear();
    app.playTitle.playEpisode(
      { ...details, title: { ...details.title, originalLanguage: "de" } },
      episode,
      0,
      () => undefined,
    );
    await until(() => player.play.mock.calls.length > 0, "episode admission");
    const identity = player.identity();
    const tracks = {
      ...identity,
      revision: 1,
      audio: {
        state: "ready" as const,
        options: ["en", "de"].map((language, index) => ({
          ...identity,
          revision: 1,
          id: String(index),
          group: "audio" as const,
          language,
          label: language,
          isDefault: index === 0,
          isPlayable: true,
        })),
      },
      subtitles: { state: "absent" as const, options: [] },
      selectedAudioId: "0",
      selectedSubtitleId: null,
      subtitleOffAllowed: false,
    };
    player.selectObservedTrackAsync.mockImplementation(async (_item, _revision, choice) => {
      const current = player.tracks;
      if (!current) throw new Error("No native snapshot");
      player.tracks = {
        ...current,
        ...(choice.kind === "audio"
          ? { selectedAudioId: choice.track.id }
          : { selectedSubtitleId: choice.track?.id ?? null }),
      };
      return { kind: "requested" };
    });
    player.tracks = tracks;
    player.observation({ kind: "tracks", tracks });
    await until(() => player.tracks?.selectedAudioId === "1", "German original sound");
    await until(
      () => tracksOf(app.filterFilesOf("series"), key) !== undefined,
      "episode file facts",
    );
    expect(tracksOf(app.filterFilesOf("series"), key)).toEqual({
      audio: ["en", "de"],
      subtitles: [],
    });
    const before = memory.requests.length;
    app.filterFilesOf("series");
    expect(memory.requests).toHaveLength(before);
    await app.playback.stop();
  });

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
    const held = holdSaved("text");
    app.filterFilesOf("movie");
    await until(() => held.started, "the saved facts' read");
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
      const { observed } = await lookUp(app, movieRef(id, "91001"));
      if (!observed) throw new Error("No place to tell what was found");
      const source = app.currentSource(id);
      if (!source) throw new Error("Not signed in");
      const held = holdSaved("text");
      app.filterFilesOf("movie");
      await until(() => held.started, "the saved facts' read");
      const change =
        how === "replaced"
          ? app.update(id, { password: NEW })
          : app.remove(id, { keepHistory: true });
      await until(() => !app.savable(id, source), "the old login to stop standing");
      observed({ audio: ["en"], subtitles: [] });
      native.gate = null;
      held.release();
      await change;
      // In the subscription's turn on the disk: after anything the late file asked to write.
      expect(await app.readFiles(id, LOGIN, () => true)).toBeNull();
      expect(savedPath()).toBeUndefined();
      if (how === "replaced") {
        await until(() => app.members()[0]?.titles.kind === "ready", "the new login's lists");
        await until(() => indexOf(app) !== null, "the lists");
        for (const each of ["91000", "91001"]) {
          expect(
            tracksOf(app.filterFilesOf("movie"), ownedKey({ subscriptionId: id, id: each })),
          ).toBeUndefined();
        }
        expect(await app.readFiles(id, LOGIN, () => true)).toBeNull();
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

  it("reads at most the 2048 latest saved facts it may keep, as many as it writes", async () => {
    panel.serveTitles(twoVersions);
    const app = await launch();
    const id = await added(app);
    await found(app, movieRef(id, "91000"), { audio: ["nl"], subtitles: [] });
    await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);
    const path = savedPath();
    if (!path) throw new Error("Nothing saved");

    // 2050 it may keep, the oldest first, and the latest of all holding the password.
    const now = Date.now();
    const entry = (place: number) => ({
      kind: "movie",
      id: String(place),
      name: `Film ${place}`,
      container: "mp4",
      audio: ["nl"],
      subtitles: [],
      at: now - 3_000 + place,
    });
    const files = [
      ...Array.from({ length: 2050 }, (_, place) => entry(place)),
      { ...entry(2050), name: `Leak ${ONE.password}` },
    ];
    writeFileSync(
      join(folder, path),
      JSON.stringify({ version: 1, subscriptionId: id, at: now, files }),
    );
    const read = (await app.readFiles(id, LOGIN, () => true)) ?? [];
    expect(read.map((file) => file.id).toSorted()).toEqual(
      Array.from({ length: 2048 }, (_, place) => String(place + 2)).toSorted(),
    );
  });
});

describe("tracks found in an episode's file", () => {
  it("count only while its series answer was asked under the lists that show, and nothing is asked for it", async () => {
    const app = await launch();
    const id = await added(app);
    const version = ownedKey({ subscriptionId: id, id: "80001" });
    const from = memory.requests.length;
    const episode = await firstEpisode(app, version);
    await found(app, episodeRef(episode), { audio: ["nl"], subtitles: ["nl"] });
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

  it("count for their own series' episode only, whatever text the provider's ids hold", async () => {
    // Joined with a separator, these two series' episode ids would read the same: series "7|8"'s
    // episode "9", and series "7"'s episode "8|9". Both are the panel's one episode, under one
    // series name: one name and file type.
    const OPAQUE = [
      { id: "7|8", episode: "9", tmdb: "88801" },
      { id: "7", episode: "8|9", tmdb: "88802" },
    ] as const;
    panel.serveTitles((all) => {
      const [series] = all.series;
      const [episode] = series?.seasons[0] ?? [];
      if (!series || !episode) throw new Error("No series");
      const opaque = OPAQUE.map((each) => ({
        ...series,
        id: each.id,
        name: "Same Show",
        tmdb: each.tmdb,
        seasons: [[{ ...episode, id: each.episode }]],
      }));
      return { ...all, series: [...opaque, ...all.series] };
    });
    const app = await launch();
    const id = await added(app);
    const [first, second] = OPAQUE.map((each) => ownedKey({ subscriptionId: id, id: each.id }));
    if (!first || !second) throw new Error("No versions");
    const episodes = [await firstEpisode(app, first), await firstEpisode(app, second)] as const;
    expect(episodes.map(({ seriesId, id, title }) => [seriesId, id, title])).toEqual([
      ["7|8", "9", episodes[0].title],
      ["7", "8|9", episodes[0].title],
    ]);

    await found(app, episodeRef(episodes[0]), { audio: ["nl"], subtitles: [] });
    await until(() => tracksOf(app.filterFilesOf("series"), first) !== undefined, "the facts");
    expect(tracksOf(app.filterFilesOf("series"), second)).toBeUndefined();
    const made = app.collectionsOf("series");
    if (!made) throw new Error("No collections");
    const dutch = browseCollection(
      made,
      "all",
      { filters: { verified: { kind: "audio", language: "nl" } } },
      app.filterFilesOf("series"),
    );
    expect(dutch.titles.map((title) => title.id)).toEqual(["7|8"]);
    expect(dutch.files).toBe(1);

    await found(app, episodeRef(episodes[1]), { audio: ["en"], subtitles: [] });
    await until(() => tracksOf(app.filterFilesOf("series"), second) !== undefined, "the facts");
    expect(tracksOf(app.filterFilesOf("series"), first)).toEqual({ audio: ["nl"], subtitles: [] });
    expect(tracksOf(app.filterFilesOf("series"), second)).toEqual({ audio: ["en"], subtitles: [] });
    await expect.poll(() => savedIds(app, id)).toEqual(["8|9", "9"]);
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

describe("tracks found under a login whose saved lists are being deleted", () => {
  const NEW = "canaryNew9";
  const DUTCH = { audio: ["nl"], subtitles: [] };

  it("count no more from the moment a new password starts deleting them, though it still signs in", async () => {
    memory.aliases = [[NEW, ONE.password]];
    panel.serveTitles(twoVersions);
    const app = await launch();
    const id = await added(app);
    const movie = ownedKey({ subscriptionId: id, id: "91000" });
    const series = ownedKey({ subscriptionId: id, id: "80001" });
    await found(app, movieRef(id, "91000"), DUTCH);
    await found(app, episodeRef(await firstEpisode(app, series)), DUTCH);
    const shows = watched(app);
    await expect.poll(shows).toBe("1 1");
    expect(tracksOf(app.filterFilesOf("movie"), movie)).toEqual(DUTCH);
    expect(tracksOf(app.filterFilesOf("series"), series)).toEqual(DUTCH);
    const { observed } = await lookUp(app, movieRef(id, "91001"));
    if (!observed) throw new Error("No place to tell what was found");
    const source = app.currentSource(id);

    // Its saved lists deleted, the new password not yet in the Keychain: the old login still
    // signs in, and the lists it gave still show.
    memory.holdSecrets = true;
    const change = app.update(id, { password: NEW });
    await until(() => memory.heldSecrets.length > 0, "the new password's write");
    const asked = memory.requests.length;
    expect(tracksOf(app.filterFilesOf("movie"), movie)).toBeUndefined();
    expect(tracksOf(app.filterFilesOf("series"), series)).toBeUndefined();
    const made = app.collectionsOf("movie");
    if (!made) throw new Error("No collections");
    const heard = browseCollection(
      made,
      "all",
      { filters: { verified: { kind: "audio", language: "nl" } } },
      app.filterFilesOf("movie"),
    );
    expect([heard.titles, heard.verified, heard.files]).toEqual([[], [], 0]);
    await expect.poll(shows).toBe("0 0");
    observed({ audio: ["en"], subtitles: [] });
    expect(app.currentSource(id)).toBe(source);
    expect(memory.requests.length).toBe(asked);

    for (const go of memory.heldSecrets.splice(0)) go();
    await change;
    expect(app.currentSource(id)).not.toBe(source);
    await until(() => app.members()[0]?.titles.kind === "ready", "the new login's lists");
    expect(tracksOf(app.filterFilesOf("movie"), movie)).toBeUndefined();
    expect(shows()).toBe("0 0");
    expect(await app.readFiles(id, LOGIN, () => true)).toBeNull();
  });

  it.each(["held", "still being read"] as const)(
    "count again as before once the change can't delete them, with them %s",
    async (how) => {
      memory.aliases = [[NEW, ONE.password]];
      panel.serveTitles(twoVersions);
      let app = await launch();
      const id = await added(app);
      const movie = ownedKey({ subscriptionId: id, id: "91000" });
      const later = ownedKey({ subscriptionId: id, id: "91001" });
      await found(app, movieRef(id, "91000"), DUTCH);
      await expect.poll(() => savedIds(app, id)).toEqual(["91000"]);
      native.undeletable = (path) => path.endsWith("/files.json");
      let shows: () => string | null = () => null;
      let held: ReturnType<typeof holdSaved>;
      if (how === "held") {
        // A later file's facts held, their write still on its way.
        held = holdSaved("write");
        await found(app, movieRef(id, "91001"), { audio: ["en"], subtitles: [] });
        await until(() => held.started, "the facts' write");
        shows = watched(app);
        await expect.poll(shows).toBe("2 0");
      } else {
        app = await launch();
        held = holdSaved("text");
        app.filterFilesOf("movie");
        await until(() => held.started, "the saved facts' read");
      }
      const source = app.currentSource(id);
      if (!source) throw new Error("Not signed in");

      const change = app.update(id, { password: NEW });
      await until(() => !app.savable(id, source), "the deletion to start");
      const asked = memory.requests.length;
      expect(tracksOf(app.filterFilesOf("movie"), movie)).toBeUndefined();
      if (how === "held") await expect.poll(shows).toBe("0 0");
      native.gate = null;
      held.release();
      await expect(change).rejects.toMatchObject({ error: { kind: "unexpected" } });

      expect(app.savable(id, source)).toBe(true);
      expect(app.currentSource(id)).toBe(source);
      await expect.poll(() => tracksOf(app.filterFilesOf("movie"), movie)).toEqual(DUTCH);
      if (how === "held") {
        expect(tracksOf(app.filterFilesOf("movie"), later)).toEqual({
          audio: ["en"],
          subtitles: [],
        });
        await expect.poll(shows).toBe("2 0");
      }
      expect(memory.requests.length).toBe(asked);
      // The write that waited on the disk while they couldn't be kept stayed out.
      expect(await savedIds(app, id)).toEqual(["91000"]);
    },
  );
});
