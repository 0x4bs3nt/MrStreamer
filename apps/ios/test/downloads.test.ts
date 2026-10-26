import { nativePlayer } from "./native-player.ts";
import { guideFixture } from "./native-guide.ts";
import type { Download, DownloadStatus } from "@mrstreamer/contracts/downloads";
import type { Episode as SeriesEpisode, TitleRef } from "@mrstreamer/contracts/ondemand";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

// Downloads through the app's own owners: the account, its two fake Xtream panels over HTTP (the
// desktop tests' fake provider, one connection each, a closed one freed 300 ms later as its
// default has it), the title lists, the one player and the downloads owner. expo-file-system is
// `native-files.ts`, over real files; the app's native background scheduler is
// `native-downloads.ts`, a model of its contract over real requests that goes on to the next
// authorization by itself. The player asks for an online stream over HTTP, as AVPlayer does, and
// holds it until it is replaced. The Keychain is kept in memory, and a relaunch imports the app's
// modules again over the same Documents, Keychain and native queue, while the last process's
// media requests go on, as a background session's do. The shared download actions answer through
// a recorded system sheet. What only iOS can show (URLSession's own resume data and timing,
// earliestBeginDate, a suspended app's wakes and handler, the Keychain, Swift itself, playing the
// file) is not proved here.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** How long the Keychain takes to write a download's resume data. */
  keychainMs: 0,
  /** While true, the Keychain won't read a download's item, as before the first unlock. */
  locked: false,
  /** Holds the Keychain's removal of a download's resume data until `done`, saying when it starts. */
  removal: null as null | { started: () => void; done: Promise<void> },
  /** The last system sheet shown, and how to answer it. */
  sheet: null as null | { options: readonly string[]; pick: (at: number) => void },
  /**
   * What the player was given, how many download requests were still open then, and the HTTP
   * status the provider answered an online stream with, once it did.
   */
  played: [] as { readonly uri: string; readonly downloading: number; status: number | null }[],
  downloading: (): number => 0,
  player: null as ReturnType<typeof nativePlayer> | null,
  appState: "active" as string,
  appListeners: [] as Array<(state: string) => void>,
  /** While set, a series' details reach the app only once `released` settles. */
  details: null as null | { arrived: () => void; released: Promise<void> },
  restricted: null as null | {
    movies: readonly string[];
    series: readonly string[];
    channel: string;
  },
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
/** Set, the viewing record's saves of progress wait for it, as a busy record would. */
const viewingSaves: { hold: Promise<void> | null } = { hold: null };
/**
 * Has the next launch's viewing record hold its saves of progress while `viewingSaves.hold` is
 * set, for the test that asks, until it ends. Other tests run the record as it is: errors from a
 * wrapped record don't pass the app's `instanceof AppFailure` checks.
 */
function holdingViewingSaves() {
  vi.doMock("../src/viewing.ts", async (original) => {
    const viewing = await original<typeof import("../src/viewing.ts")>();
    return {
      ...viewing,
      recordProgress: async (...args: Parameters<typeof viewing.recordProgress>) => {
        await viewingSaves.hold;
        return viewing.recordProgress(...args);
      },
    };
  });
  onTestFinished(() => vi.doUnmock("../src/viewing.ts"));
}
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T>(styles: T) => styles },
  Alert: { alert: () => undefined },
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (at: number) => void,
    ) => {
      memory.sheet = { options, pick };
    },
  },
  AppState: {
    get currentState() {
      return memory.appState;
    },
    addEventListener: (_: "change", listener: (state: string) => void) => {
      memory.appListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => {
    if (memory.locked && key.includes("download")) throw new Error("Interaction not allowed");
    return memory.keychain.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    if (key.includes("download") && memory.keychainMs > 0) {
      await new Promise((done) => setTimeout(done, memory.keychainMs));
    }
    memory.keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    const held = key.includes("download") ? memory.removal : null;
    if (held) {
      held.started();
      await held.done;
    }
    memory.keychain.delete(key);
  },
}));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => {
    let stream: AbortController | null = null;
    let request = Promise.resolve();
    const player = nativePlayer((source) => {
      const played = {
        uri: source.uri,
        downloading: memory.downloading(),
        status: null as number | null,
      };
      memory.played.push(played);
      if (!source.uri.startsWith("http")) return;
      const controller = new AbortController();
      stream = controller;
      const identity = player.identity();
      request = fetch(source.uri, { signal: controller.signal }).then(
        async (response) => {
          played.status = response.status;
          if (response.ok) return;
          await response.body?.cancel();
          player.observation(
            { kind: "failure", terminal: true, failure: { kind: "unknown", evidence: null } },
            identity,
          );
        },
        () => undefined,
      );
    });
    const detach = player.detachObservedAsync.getMockImplementation()!;
    player.detachObservedAsync.mockImplementation(async (id) => {
      stream?.abort();
      await request;
      return detach(id);
    });
    memory.player = player;
    return player;
  },
}));

const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const response = await passThrough(input, init);
  const restricted = memory.restricted;
  const action = typeof input === "string" ? new URL(input).searchParams.get("action") : null;
  if (restricted && response.ok && action?.startsWith("get_")) {
    if (action === "get_vod_categories") {
      const categories = (await response.json()) as unknown[];
      return Response.json([
        ...categories,
        { category_id: "excluded", category_name: "XXX Adults" },
      ]);
    }
    if (["get_vod_streams", "get_series", "get_live_streams"].includes(action)) {
      const rows = (await response.json()) as Record<string, unknown>[];
      return Response.json(
        rows.map((row) => {
          const id = String(row["stream_id"] ?? row["series_id"]);
          if (action === "get_vod_streams" && id === restricted.movies[0]) {
            return { ...row, category_id: "excluded", category_ids: ["excluded"] };
          }
          const flagged =
            action === "get_vod_streams"
              ? restricted.movies.includes(id)
              : action === "get_series"
                ? restricted.series.includes(id)
                : id === restricted.channel;
          return flagged ? { ...row, is_adult: 1 } : row;
        }),
      );
    }
  }
  const held = memory.details;
  if (!held || typeof input !== "string" || !input.includes("action=get_series_info")) {
    return response;
  }
  const body = await response.text();
  held.arrived();
  await held.released;
  return new Response(body, { status: response.status, headers: response.headers });
});

const { native, File: DiskFile, Directory: Folder } = await import("./native-files.ts");
const { background } = await import("./native-downloads.ts");

interface FakeTitle {
  readonly id: number;
  readonly name: string;
  readonly fixture: string | null;
}
interface FakeSeries {
  readonly id: number;
  readonly seasons: readonly (readonly (FakeTitle & { readonly number?: number })[])[];
}
interface FakeProvider {
  readonly url: string;
  readonly titles: {
    readonly movies: readonly FakeTitle[];
    readonly series: readonly FakeSeries[];
  };
  activeStreams(): number;
  fileRequests(): number;
  streamRequests(): number;
  mostFilesAtOnce(): number;
  stallMovieFile(movieId: number, at: number, ms: number): void;
  replaceMovieFile(movieId: number, file: string | Buffer): void;
  close(): Promise<void>;
}
/** Typed by Node's own lib, which the app's tsconfig leaves out of the desktop's: by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider, fixture } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: Record<string, unknown>): Promise<FakeProvider>;
  fixture(name: string): Buffer;
};

const ONE = { username: "one", password: "one+Pw@1" };
const TWO = { username: "two", password: "two+Pw@2" };
let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ ...ONE, channels: 20, titles: 10 }),
    startFakeProvider({ ...TWO, channels: 20, titles: 10, second: true }),
  ]);
  memory.downloading = () => native.open;
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

/** MP4 films both panels list under the same ids, as the TEST movies are. */
const films = () =>
  one.titles.movies.filter(
    (each) => each.name.startsWith("TEST") && each.fixture?.endsWith(".mp4"),
  );
const movie = () => films()[0]!;
const otherMovie = () =>
  films()[1] ?? one.titles.movies.find((each) => each.fixture && each !== movie())!;
const episode = () => {
  const series = one.titles.series.find((each) => each.seasons[0]?.[0]?.fixture)!;
  const first = series.seasons[0]![0]!;
  return { series, first };
};

afterEach(async () => {
  memory.restricted = null;
  memory.details = null;
  one.stallMovieFile(movie().id, 0, 0);
  one.stallMovieFile(otherMovie().id, 0, 0);
  memory.appState = "active";
  memory.locked = false;
  native.held = null;
  native.sync = null;
  await background.forceQuit();
  // What an earlier launch left streaming ends before the next test asks the panels for files.
  await until(panelsIdle, "the panels to idle");
});

const panelsIdle = () => one.activeStreams() === 0 && two.activeStreams() === 0;

async function until(ready: () => boolean, what: string, ms = 8_000) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > ms) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/**
 * The app as a launch starts it: the last process ends, its media requests going on as a
 * background session's do, and fresh modules start over the same files, Keychain and native
 * ledger. With none going on, a launch takes longer than the panels take to free a closed
 * connection; the last process writes nothing more.
 */
async function launch() {
  background.die();
  const list = new DiskFile(native.root, "documents", "downloads.json");
  const left = { list: list.exists ? list.textSync() : null, keychain: new Map(memory.keychain) };
  if (background.task === null && background.strays.size === 0) {
    await until(panelsIdle, "the last process's requests to be freed");
  }
  if (left.list === null) {
    if (list.exists) list.delete();
  } else list.writeSync(left.list);
  memory.keychain = left.keychain;
  vi.resetModules();
  memory.appListeners.length = 0;
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const playback = await import("../src/playback.ts");
  const viewing = await import("../src/viewing.ts");
  const downloads = await import("../src/downloads.ts");
  const playTitle = await import("../src/play-title.ts");
  const series = await import("../src/series-download.ts");
  await account.restore();
  downloads.startDownloads();
  // `playback` too, whose `retry` another owner's shadows.
  return {
    ...titles,
    ...playback,
    ...viewing,
    ...downloads,
    ...account,
    ...playTitle,
    ...series,
    playback,
  };
}
type App = Awaited<ReturnType<typeof launch>>;

/** A fresh install: nothing in Documents, the Keychain or the native ledger. */
async function install() {
  await background.forceQuit();
  background.reset();
  const documents = new Folder(native.root, "documents");
  documents.delete();
  documents.create();
  native.free = 64 * 1024 * 1024 * 1024;
  native.requests.length = 0;
  native.pauseMs = 0;
  native.held = null;
  native.sync = null;
  memory.keychain.clear();
  memory.keychainMs = 0;
  memory.removal = null;
  memory.sheet = null;
  memory.played.length = 0;
}

/**
 * Adds the first provider, and the second when `both`, then waits until the combined index lists
 * the titles the tests ask each for: lists can be ready while the index still is an older one.
 */
async function withProviders(app: App, both = false) {
  const a = await app.add({ server: one.url, ...ONE });
  const b = both ? await app.add({ server: two.url, ...TWO }) : null;
  const listed = () => {
    const lists = app.titleLists();
    if (lists.kind !== "ready") return false;
    const has = (kind: "movie" | "series", subscriptionId: string, id: number) =>
      app.titleOf(lists.index, kind, { subscriptionId, id: String(id) }) !== undefined;
    const films = (subscriptionId: string) =>
      has("movie", subscriptionId, movie().id) && has("movie", subscriptionId, otherMovie().id);
    return films(a!) && has("series", a!, episode().series.id) && (b === null || films(b));
  };
  await until(listed, "the title lists");
  return { a: a!, b };
}

const movieRef = (subscriptionId: string, id = movie().id): TitleRef => ({
  kind: "movie",
  subscriptionId,
  id: String(id),
});
const statusOf = (app: App, id: string): DownloadStatus | undefined =>
  app.downloadList().items.find((item) => item.id === id)?.status;
const isComplete = (app: App, id: string) => statusOf(app, id)?.kind === "complete";
const doc = () => JSON.parse(new DiskFile(native.root, "documents", "downloads.json").textSync());
/** An earlier build's resume data, in the app's own Keychain items. */
const downloadSecrets = () =>
  [...memory.keychain.keys()].filter((key) => key.startsWith("s.download"));
/** Downloads the native side keeps resume data for. */
const nativeSecrets = () => [...background.resume.keys()];
const receivedOf = (app: App, id: string) =>
  (statusOf(app, id) as { received?: number } | undefined)?.received;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const folder = (id: string) => new Folder(native.root, "documents", "downloads", id);
const mediaFile = (id: string) =>
  folder(id)
    .list()
    .filter((entry) => entry instanceof DiskFile)
    .find((entry) => entry.name.startsWith("media."));
/** Everything app storage holds, to look for logins. */
function everythingStored(): string {
  const read = (dir: InstanceType<typeof Folder>): string[] =>
    dir
      .list()
      .flatMap((entry) =>
        entry instanceof Folder
          ? read(entry)
          : entry.name.startsWith("media.") || ["poster", "wide"].includes(entry.name)
            ? []
            : [entry.textSync()],
      );
  return read(new Folder(native.root, "documents")).join("\n");
}

/** Plays a film of `subscriptionId` in Watch, online, as its details' Play does. */
function playFilm(app: App, subscriptionId: string, id: number) {
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No titles");
  const version = { subscriptionId, id: String(id) };
  app.playMovie(app.titleOf(lists.index, "movie", version)!, version, 0, () => undefined);
}

/** Sends the app to the background and back, as iOS reports it. */
function appGoes(state: "background" | "active") {
  memory.appState = state;
  for (const listener of memory.appListeners) listener(state);
}

describe("downloads", { timeout: 30_000 }, () => {
  it("excludes recognised catalogues and saved actions after refresh and restore, keeping personal copies", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const watchlist = await import("../src/watchlist.ts");
    const lists = app.titleLists();
    const live = app.currentCatalogue();
    if (lists.kind !== "ready" || live.kind !== "ready") throw new Error("No lists");
    const { kindOf } = await import("@mrstreamer/core/ondemand/catalogue");
    const film = app.titleOf(lists.index, "movie", movieRef(a))!;
    const series = app.titleOf(lists.index, "series", {
      subscriptionId: a,
      id: String(episode().series.id),
    })!;
    const ordinary = kindOf(lists.index, "movie").titles.find((title) =>
      title.versions.every(
        (version) => ![String(movie().id), String(otherMovie().id)].includes(version.id),
      ),
    )!;
    const channel = live.library.channels[0]!;
    watchlist.saveTitle(film);
    watchlist.saveTitle(series);
    watchlist.saveTitle(ordinary);
    const copy = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, copy.id), "the personal copy");
    const originalCopy = mediaFile(copy.id)!;
    const ordinaryCopy = await app.addDownload({
      kind: "movie",
      subscriptionId: a,
      id: ordinary.id,
    });
    await until(() => isComplete(app, ordinaryCopy.id), "the permitted personal copy");
    memory.restricted = {
      movies: [String(movie().id), String(otherMovie().id)],
      series: series.versions.map((version) => version.id),
      channel: channel.variants[0]!.id,
    };
    app.reloadTitles(a);
    app.reloadChannels(a);
    await until(() => {
      const titles = app.titleLists();
      return (
        titles.kind === "ready" &&
        app.titlesWorkedOut() &&
        app.members()[0]?.titles.kind === "ready" &&
        app.members()[0]?.live.kind === "ready" &&
        app.currentCatalogue().kind === "ready" &&
        !app.titleOf(titles.index, "movie", movieRef(a))
      );
    }, "the filtered refresh");
    const requests = one.fileRequests();
    await expect(app.titleFile(movieRef(a), AbortSignal.timeout(1000))).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(app.detailsOf(film)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    await expect(
      app.titleFile(
        {
          kind: "episode",
          subscriptionId: a,
          id: String(episode().first.id),
          seriesId: series.id,
          season: 1,
          episode: 1,
        },
        AbortSignal.timeout(1000),
      ),
    ).rejects.toMatchObject({ error: { kind: "title-not-found" } });
    await expect(app.addDownload(movieRef(a))).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    app.playChannel(channel, "Live", { watch: true });
    expect(app.playbackState.get().phase.kind).toBe("idle");
    expect(one.fileRequests()).toBe(requests);
    const shownWatchlist = () => {
      const lists = app.titleLists();
      return watchlist.watchlistRows(
        watchlist.currentWatchlist(),
        {
          index: lists.kind === "ready" ? lists.index : null,
          complete: app.titlesWorkedOut(),
          members: app.members(),
          named: app.named,
        },
        "newest",
      );
    };
    expect(shownWatchlist().map((row) => row.name)).toEqual([ordinary.title]);
    app = await launch();
    await until(
      () => app.titlesWorkedOut() && app.titleLists().kind === "ready",
      "the restored lists",
    );
    const restoredWatchlist = await import("../src/watchlist.ts");
    const restored = app.titleLists();
    if (restored.kind !== "ready") throw new Error("No restored lists");
    expect(
      restoredWatchlist
        .watchlistRows(
          restoredWatchlist.currentWatchlist(),
          { index: restored.index, complete: true, members: app.members(), named: app.named },
          "newest",
        )
        .map((row) => row.name),
    ).toEqual([ordinary.title]);
    expect(kindOf(restored.index, "movie").titles.some((title) => title.id === film.id)).toBe(
      false,
    );
    expect(
      kindOf(restored.index, "movie").titles.some((title) => title.id === String(otherMovie().id)),
    ).toBe(false);
    expect(kindOf(restored.index, "series").titles.some((title) => title.id === series.id)).toBe(
      false,
    );
    expect(
      app.searchTitles(restored.index, "movie", ordinary.title, 10).titles.map((title) => title.id),
    ).toContain(ordinary.id);
    expect(
      app.searchTitles(restored.index, "movie", film.title, 10).titles.map((title) => title.id),
    ).not.toContain(film.id);
    const beforePlayback = memory.played.length;
    const beforeFiles = one.fileRequests();
    app.playDownload(copy.id);
    await app.progressSettled();
    expect(memory.played).toHaveLength(beforePlayback);
    expect(app.downloadList().items.some((item) => item.id === copy.id)).toBe(false);
    expect(originalCopy.exists).toBe(true);
    app.playDownload(ordinaryCopy.id);
    await until(() => memory.played.length > beforePlayback, "the permitted offline copy");
    expect(memory.played.at(-1)?.uri).toBe(mediaFile(ordinaryCopy.id)!.uri);
    expect(one.fileRequests()).toBe(beforeFiles);
    await expect(
      app.titleFile(
        { kind: "movie", subscriptionId: a, id: ordinary.id },
        AbortSignal.timeout(1000),
      ),
    ).resolves.toHaveProperty("url");
  });

  it("fences a newly recognised unfinished download and refuses Retry after restore, leaving ordinary downloads usable", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 1024, 10_000);
    const unfinished = await app.addDownload(movieRef(a));
    await until(() => (receivedOf(app, unfinished.id) ?? 0) > 0, "the unfinished request");
    memory.restricted = { movies: [String(movie().id)], series: [], channel: "" };
    app.reloadTitles(a);
    await until(
      () =>
        native.open === 0 && !app.downloadList().items.some((item) => item.id === unfinished.id),
      "the restricted transfer to stop",
    );
    await expect(app.retryDownload(unfinished.id)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    const requests = one.fileRequests();
    app = await launch();
    await until(
      () => app.titlesWorkedOut() && app.titleLists().kind === "ready",
      "the restored classification",
    );
    await expect(app.retryDownload(unfinished.id)).rejects.toMatchObject({
      error: { kind: "title-not-found" },
    });
    expect(one.fileRequests()).toBe(requests);
    expect(app.downloadList().items.some((item) => item.id === unfinished.id)).toBe(false);
    const ordinary = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, ordinary.id), "the permitted download");
  });

  it("refuses an episode lookup whose provider classifies its series while details are in flight", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    memory.details = { arrived: arrived.resolve, released: released.promise };
    const reading = app.titleFile(
      {
        kind: "episode",
        subscriptionId: a,
        id: String(first.id),
        seriesId: String(series.id),
        season: 1,
        episode: first.number ?? 1,
      },
      AbortSignal.timeout(20_000),
    );
    const rejected = expect(reading).rejects.toMatchObject({ error: { kind: "title-not-found" } });
    try {
      await arrived.promise;
      memory.restricted = { movies: [], series: [String(series.id)], channel: "" };
      app.reloadTitles(a);
      await until(
        () => app.titlesWorkedOut() && app.members()[0]?.titles.kind === "ready",
        "the new classification",
      );
    } finally {
      memory.details = null;
      released.resolve();
    }
    await rejected;
    await expect(app.titleFile(movieRef(a), AbortSignal.timeout(1000))).resolves.toHaveProperty(
      "url",
    );
  });

  it("enforces catalogue and native download exclusion while classification storage refuses writes", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const lists = app.titleLists();
    if (lists.kind !== "ready") throw new Error("No lists");
    const watchlist = await import("../src/watchlist.ts");
    const film = app.titleOf(lists.index, "movie", movieRef(a))!;
    watchlist.saveTitle(film);
    one.stallMovieFile(movie().id, 1024, 10_000);
    const copy = await app.addDownload(movieRef(a));
    await until(() => (receivedOf(app, copy.id) ?? 0) > 0, "the partial download");
    native.sync = (operation, path) => {
      if (
        operation === "write" &&
        (path.endsWith("downloads.json.next") || path.endsWith("watchlists.json.next"))
      )
        throw new Error("Storage refused");
    };
    memory.restricted = { movies: [String(movie().id)], series: [], channel: "" };
    try {
      app.reloadTitles(a);
      await until(
        () =>
          app.titlesWorkedOut() && app.members()[0]?.titles.kind === "ready" && native.open === 0,
        "catalogue invalidation and native fence",
      );
      const current = app.titleLists();
      if (current.kind !== "ready") throw new Error("No refreshed lists");
      expect(app.titleOf(current.index, "movie", movieRef(a))).toBeUndefined();
      expect(app.downloadList().items.some((item) => item.id === copy.id)).toBe(false);
      expect(
        watchlist.watchlistRows(
          watchlist.currentWatchlist(),
          { index: current.index, complete: true, members: app.members(), named: app.named },
          "newest",
        ),
      ).toEqual([]);
    } finally {
      native.sync = null;
    }
    app.reloadTitles(a);
    await until(() => background.receipts.length === 0, "the retained fence receipt");
    const ordinary = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, ordinary.id), "an ordinary transfer after storage recovers");
  });

  it.each(["missed native notification", "refused completion write"])(
    "retains a completed personal copy while restriction fences it after %s",
    async (race) => {
      await install();
      const app = await launch();
      const { a } = await withProviders(app);
      one.stallMovieFile(movie().id, 1024, 500);
      const copy = await app.addDownload(movieRef(a));
      await until(() => (receivedOf(app, copy.id) ?? 0) > 0, "the partial download");
      appGoes("background");
      if (race === "missed native notification") background.die();
      else
        native.sync = (operation, path) => {
          if (operation === "write" && path.endsWith("downloads.json.next"))
            throw new Error("Storage refused");
        };
      await until(() => native.open === 0 && mediaFile(copy.id) !== undefined, "native completion");
      const media = mediaFile(copy.id)!;
      const requests = one.fileRequests();
      memory.restricted = { movies: [String(movie().id)], series: [], channel: "" };
      app.reloadTitles(a);
      await until(
        () => app.titlesWorkedOut() && app.members()[0]?.titles.kind === "ready",
        "the classified catalogue",
      );
      expect(app.downloadList().items.some((item) => item.id === copy.id)).toBe(false);
      native.sync = null;
      appGoes("active");
      await until(() => background.receipts.length === 0, "the completion to be reconciled");
      memory.restricted = null;
      app.reloadTitles(a);
      await until(() => isComplete(app, copy.id), "the permitted retained copy");
      expect(media.exists).toBe(true);
      expect(one.fileRequests()).toBe(requests);
      app.playDownload(copy.id);
      await until(() => memory.played.at(-1)?.uri === media.uri, "the retained offline playback");
    },
  );

  it("applies a saved copy's original language through the real play action without establishing provider-file facts", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const copy = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, copy.id), "the saved copy");
    const disk = new DiskFile(native.root, "documents", "downloads.json");
    const stored: unknown = JSON.parse(disk.textSync(), (key, value: unknown) =>
      key === "about" && typeof value === "object" && value !== null
        ? { ...value, originalLanguage: "fr" }
        : value,
    );
    disk.writeSync(JSON.stringify(stored));
    app = await launch();
    const preferences = await import("../src/media-preferences.ts");
    preferences.updateMediaPreferences("audio", { kind: "original" });
    app.playDownload(copy.id);
    await until(() => memory.played.length === 1, "the copy to open");
    const player = memory.player;
    if (!player) throw new Error("No player");
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
    const files = one.fileRequests();
    player.tracks = tracks;
    player.observation({ kind: "tracks", tracks });
    await until(() => player.tracks?.selectedAudioId === "1", "French saved original sound");
    expect(one.fileRequests()).toBe(files);
    expect(
      app
        .filterFilesOf("movie")
        .get(`${a}:${copy.title.id}`)
        ?.some((file) => file.tracks !== undefined) ?? false,
    ).toBe(false);
    await app.stop();
  });

  it("adds the remaining provider's downloads asked for before or while a removed one's titles go", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const { series, first } = episode();
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    memory.details = { arrived: arrived.resolve, released: released.promise };
    // The episode's lookup is under way as the second provider goes.
    const asked = app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    await arrived.promise;
    await app.remove(b!, { keepHistory: true });
    expect(app.titleLists().kind).toBe("loading");
    // A film asked for while the lists are made again, then the episode's lookup lands.
    const film = app.addDownload(movieRef(a));
    memory.details = null;
    released.resolve();
    const [show, movieCopy] = await Promise.all([asked, film]);
    expect(show).toMatchObject({ subscription: { id: a } });
    expect(show.episodeName).not.toBeNull();
    expect(movieCopy).toMatchObject({ subscription: { id: a } });
    await until(() => isComplete(app, show.id) && isComplete(app, movieCopy.id), "both copies");
  });

  it("transfers one at a time, a movie then an episode, and keeps no login with them", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { series, first } = episode();
    const film = await app.addDownload(movieRef(a));
    const show = await app.addDownload({
      kind: "episode",
      subscriptionId: a,
      id: String(first.id),
      seriesId: String(series.id),
      season: 1,
      episode: first.number ?? 1,
    });
    expect(film.subscription?.id).toBe(a);
    await until(() => isComplete(app, film.id) && isComplete(app, show.id), "both copies");
    expect(one.mostFilesAtOnce()).toBe(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    const listed = app.downloadList();
    expect(listed.items.map((item) => item.id)).toEqual([show.id, film.id]);
    expect(listed.bytes).toBe(fixture(movie().fixture!).length + fixture(first.fixture!).length);
    expect(listed.items.find((item) => item.id === show.id)?.episodeName).not.toBeNull();
    // Nothing kept on disk names the address, the username or the password; nor the Keychain.
    const stored = everythingStored();
    for (const secret of [ONE.password, encodeURIComponent(ONE.password), `/${ONE.username}/`]) {
      expect(stored).not.toContain(secret);
    }
    expect(stored).not.toContain("/movie/");
    expect(downloadSecrets()).toEqual([]);
    expect(doc().forgetting).toEqual([]);
  });

  it("keeps a copy's pictures in its folder, fetched on the session that keeps no URL cache", async () => {
    await install();
    // The panel's pictures are on image.example: served here, its backdrops refused.
    const online = globalThis.fetch;
    const pictures = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== "image.example") return online(input, init);
      return Promise.resolve(
        url.pathname.startsWith("/b/")
          ? new Response("gone", { status: 404 })
          : new Response(`picture ${url.pathname}`),
      );
    });
    // What this test starts, it ends, passing or not, before its spy goes.
    let app: App | null = null;
    let film: { readonly id: string } | null = null;
    try {
      const started = await launch();
      app = started;
      const { a } = await withProviders(started);
      const poster = `https://image.example/p/${movie().id}.jpg`;
      const wide = `https://image.example/b/m${movie().id}.jpg`;
      const copy = await started.addDownload(movieRef(a));
      film = copy;
      const item = () => started.downloadList().items.find((each) => each.id === copy.id);
      await until(
        () => isComplete(started, copy.id) && item()?.posterUrl != null,
        "the copy's poster",
      );
      await until(() => native.tasks.some((each) => each.url === wide), "its backdrop asked for");
      await sleep(50);
      const kept = new DiskFile(native.root, "documents", "downloads", copy.id, "poster");
      expect(item()?.posterUrl).toBe(kept.uri);
      expect(kept.textSync()).toBe(`picture /p/${movie().id}.jpg`);
      expect(item()?.wideUrl).toBeNull();
      expect(new DiskFile(native.root, "documents", "downloads", copy.id, "wide").exists).toBe(
        false,
      );
      // Every picture request, this test's and an earlier one's of the same film alike.
      const asked = native.tasks.filter((each) => each.url === poster || each.url === wide);
      expect(new Set(asked.map((each) => each.url))).toEqual(new Set([poster, wide]));
      expect(asked.every((each) => each.sessionType === "foreground")).toBe(true);
    } finally {
      if (film) await app?.removeDownload(film.id).catch(() => undefined);
      app?.stop();
      pictures.mockRestore();
    }
  });

  it("answers a title asked for twice with one download, and keeps two providers' same id apart", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 30_000);
    const [first, second] = await Promise.all([
      app.addDownload(movieRef(a)),
      app.addDownload(movieRef(a)),
    ]);
    expect(second.id).toBe(first.id);
    const theirs = await app.addDownload(movieRef(b!));
    expect(theirs.id).not.toBe(first.id);
    expect(doc().items).toHaveLength(2);
    expect(app.downloadOf(movieRef(b!))?.id).toBe(theirs.id);
    expect(app.downloadOf(movieRef(a))?.id).toBe(first.id);
    await app.removeDownload(first.id);
    await until(() => isComplete(app, theirs.id), "the second provider's copy");
    expect(app.downloadOf(movieRef(a))).toBeUndefined();
  });

  it("cancels a transfer under way: its request ends and nothing of it stays", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 30_000);
    const film = await app.addDownload(movieRef(a));
    await until(
      () => (statusOf(app, film.id) as { received?: number } | undefined)?.received === 20_000,
      "the transfer to stall",
    );
    expect(one.activeStreams()).toBe(1);
    await app.removeDownload(film.id);
    await until(() => one.activeStreams() === 0, "the request to end");
    expect(app.downloadList().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    expect(doc().items).toEqual([]);
    expect(downloadSecrets()).toEqual([]);
  });

  it("fails while the provider refuses the file, and completes once retried", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    // Every connection the subscription allows is in use elsewhere.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const held = new AbortController();
    const login = `${ONE.username}/${encodeURIComponent(ONE.password)}`;
    await fetch(`${one.url}/movie/${login}/${otherMovie().id}.mp4`, { signal: held.signal });
    expect(one.activeStreams()).toBe(1);
    const film = await app.addDownload(movieRef(a));
    await until(() => statusOf(app, film.id)?.kind === "failed", "the refusal");
    expect(statusOf(app, film.id)).toEqual({
      kind: "failed",
      failure: { kind: "stream", failure: { kind: "refused", status: 403 } },
    });
    held.abort();
    await until(() => one.activeStreams() === 0, "the other connection to close");
    await app.retryDownload(film.id);
    await until(() => isComplete(app, film.id), "the retried copy");
    // Added again once failed, a download is queued again rather than duplicated.
    expect(doc().items).toHaveLength(1);
  });

  it("goes on in the background to the next authorized download, one request at a time, with no JavaScript", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 1_500);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    await until(() => background.open(next.id).length === 1, "the next one authorized");
    // iOS ends the app's process: no JavaScript hears or chooses anything after this.
    appGoes("background");
    background.die();
    await until(
      () => background.events.includes(`receipt:${next.id}:complete`),
      "both to complete natively",
    );
    expect(background.events.filter((each) => each.startsWith("start:"))).toEqual([
      `start:${film.id}`,
      `start:${next.id}`,
    ]);
    expect(one.mostFilesAtOnce()).toBe(1);
    // The next request waits its source's second of grace after the first one's local end.
    const [first, second] = native.requests;
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(1_000);
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, film.id) && isComplete(app, next.id), "both copies taken in");
    expect(mediaFile(next.id)?.size).toBe(fixture(otherMovie().fixture!).length);
    expect(nativeSecrets()).toEqual([]);
    await until(() => background.receipts.length === 0, "the receipts acknowledged");
  });

  it("finds a transfer that went on after the app's process ended, and one that finished meanwhile", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 1_500);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    // iOS ends the process and launches it again in the background: the request is still the
    // download's transfer, and goes on to complete with no other asked for.
    memory.appState = "background";
    app = await launch();
    await until(() => statusOf(app, film.id)?.kind === "transferring", "the request to be found");
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests).toHaveLength(1);
    expect(background.receipts).toEqual([]);

    // One that finishes while no process hears it is taken in by the next launch.
    appGoes("active");
    one.stallMovieFile(otherMovie().id, 20_000, 1_000);
    const other = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, other.id) === 20_000, "the second transfer to stall");
    background.die();
    await until(
      () => background.task === null && background.receipts.length === 1,
      "the request to finish unheard",
    );
    app = await launch();
    await until(() => isComplete(app, other.id), "the copy taken in");
    expect(native.requests).toHaveLength(2);
    expect(background.receipts).toEqual([]);
  });

  it("takes in only the receipt of a download's last attempt", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    expect(native.requests).toEqual([]);
    // An authorization this download never wrote down says it completed.
    background.receipts.push({
      version: 2,
      receipt: "r-stale",
      authorization: "z-stale",
      attempt: "a-stale",
      id: film.id,
      sequence: 999,
      received: 1,
      expected: 1,
      restarted: false,
      outcome: { kind: "complete", size: 1, expected: 1 },
    });
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    expect(background.receipts).toEqual([]);
  });

  it("ends a request no download accounts for, and gives the provider its time, before asking it anything", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    expect(native.requests).toEqual([]);
    // A request the session has that no attempt names, holding the provider's one connection
    // until the next launch's reconcile ends it.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const login = `${ONE.username}/${encodeURIComponent(ONE.password)}`;
    background.stray(`${one.url}/movie/${login}/${otherMovie().id}.mp4`);
    await until(() => one.activeStreams() === 1, "the stray request");
    // Launched in the foreground, its last process gone without hearing a change.
    memory.appState = "active";
    app = await launch();
    await until(
      () => isComplete(app, film.id) || statusOf(app, film.id)?.kind === "failed",
      "the download to end",
    );
    // The provider, still freeing the stray's connection, took the download's request.
    expect(statusOf(app, film.id)).toEqual({ kind: "complete" });
    expect(background.strays.size).toBe(0);
    expect(native.requests).toHaveLength(1);
    expect(native.requests[0]!.at - background.strayEndedAt).toBeGreaterThanOrEqual(1_000);
  });

  it("plays a stream while the native queue can't be read or is damaged: storage alone holds nothing back", async () => {
    for (const fault of ["unavailable", "corrupt"] as const) {
      await install();
      let app = await launch();
      await withProviders(app);
      background[fault] = true;
      // Launched in the background: no first foreground repairs the damaged queue meanwhile.
      memory.appState = "background";
      app = await launch();
      const { a } = await withProviders(app);
      memory.played.length = 0;
      playFilm(app, a, otherMovie().id);
      await until(() => memory.played[0]?.status != null, "the film");
      expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
      await app.stop();
      background[fault] = false;
    }
  });

  it("keeps a broken request's resume data: open, it fails and Retry goes on; in the background, it goes on once open", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await background.breakConnection();
    await until(() => statusOf(app, film.id)?.kind === "failed", "the failure");
    expect(statusOf(app, film.id)).toMatchObject({
      kind: "failed",
      failure: { kind: "stream", failure: { kind: "network" } },
    });
    expect(nativeSecrets()).toEqual([film.id]);
    one.stallMovieFile(movie().id, 40_000, 60_000);
    await app.retryDownload(film.id);
    await until(() => receivedOf(app, film.id) === 40_000, "the resumed transfer to stall");
    appGoes("background");
    await background.breakConnection();
    await until(() => statusOf(app, film.id)?.kind === "queued", "the download to wait");
    one.stallMovieFile(movie().id, 0, 0);
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests.map((each) => each.range)).toEqual([
      null,
      "bytes=20000-",
      "bytes=40000-",
    ]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    expect(nativeSecrets()).toEqual([]);
  });

  it("starts again, and says so, when the provider's file changed while it was paused", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const id = otherMovie().id;
    one.stallMovieFile(id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a, id));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    // Its provider's stream takes the connection: the transfer pauses, keeping its resume data.
    playFilm(app, a, movie().id);
    await until(() => memory.played[0]?.status != null, "the film");
    expect(statusOf(app, film.id)?.kind).toBe("waiting");
    expect(nativeSecrets()).toEqual([film.id]);
    const replacement = fixture("title-caption-track.mov");
    one.replaceMovieFile(id, replacement);
    one.stallMovieFile(id, 0, 0);
    let restarted = false;
    const off = app.onDownloads(() => {
      const status = statusOf(app, film.id);
      if (status?.kind === "transferring" && status.restarted) restarted = true;
    });
    app.stop();
    await until(() => isComplete(app, film.id), "the copy of the new file");
    off();
    expect(restarted).toBe(true);
    expect(mediaFile(film.id)?.size).toBe(replacement.length);
  });

  it("deletes a file left beside an unfinished download, rather than calling it complete", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // Quit by the viewer: iOS ends the request, with no resume data.
    await background.forceQuit();
    // A whole file of the right size, but no completion was ever written down for it.
    const left = new DiskFile(folder(film.id), "media.mp4");
    left.writeSync("x".repeat(fixture(movie().fixture!).length));
    one.stallMovieFile(movie().id, 0, 0);
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(mediaFile(film.id)?.textSync()).not.toMatch(/^x+$/);
  });

  it("hands resume data an earlier build kept to the native side; one the Keychain won't read waits for it", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    // An earlier build paused it, keeping its resume data in its own Keychain item: its record
    // names a build-14 attempt, and no native authorization has it.
    background.die();
    // That build schedules nothing natively: nothing is admitted while its state is made.
    background.down = true;
    await background.pauseAll();
    const kept = background.resume.get(film.id)!;
    background.resume.clear();
    background.receipts.length = 0;
    background.grants.clear();
    background.requests.clear();
    const stored = doc();
    for (const row of stored.items) {
      delete row.transfer;
      row.attempt = "a-build14";
    }
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
    const { keychainSecrets } = await import("../src/secrets.ts");
    await keychainSecrets.write(
      `download:${film.id}`,
      JSON.stringify({ url: kept.url, resumeData: kept.data }),
    );
    one.stallMovieFile(movie().id, 0, 0);
    memory.locked = true;
    app = await launch();
    await sleep(1_500);
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    expect(native.requests).toHaveLength(1);
    expect(downloadSecrets()).toHaveLength(1);
    memory.locked = false;
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests.map((each) => each.range)).toEqual([null, "bytes=30000-"]);
    expect(downloadSecrets()).toEqual([]);
    expect(nativeSecrets()).toEqual([]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("gives its provider's connection to a stream first, and goes on once the stream stops", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => one.activeStreams() === 1, "the transfer");
    // Another provider's film: the transfer goes on.
    playFilm(app, b!, otherMovie().id);
    await until(() => memory.played[0]?.status === 200, "the other provider's film");
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    expect(one.activeStreams()).toBe(1);
    // Its own provider's film: the transfer's request ended before the stream asked, though
    // URLSession took a while to end it, and the panel, still freeing that connection, takes it.
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    native.pauseMs = 200;
    playFilm(app, a, otherMovie().id);
    await until(() => memory.played[1]?.status != null, "the film");
    expect(memory.played[1]).toMatchObject({ downloading: 0, status: 200 });
    expect(app.playbackState.get().phase.kind).not.toBe("failed");
    expect(statusOf(app, film.id)?.kind).toBe("waiting");
    // Stopped, the stream's connection is freed in turn before the transfer goes on.
    one.stallMovieFile(movie().id, 0, 0);
    native.requests.length = 0;
    app.stop();
    await until(() => isComplete(app, film.id), "the copy");
    expect(native.requests[0]?.range).toBe("bytes=20000-");
  });

  it("waits while its provider's closing format session holds the connection, whatever plays next", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const item = (subscriptionId: string | null) => ({
      id: "format",
      subscriptionId,
      title: "format",
      place: "",
      live: false,
      next: false,
      versions: false,
    });
    // Another provider's film, then a copy on the phone, plays after A's Matroska title.
    for (const next of [b!, null]) {
      let end!: () => void;
      const ended = new Promise<void>((done) => (end = done));
      const { modules } = (globalThis as { expo: { modules: Record<string, unknown> } }).expo;
      Object.assign(modules, {
        Guide: guideFixture().native,
        TitleFormats: {
          create: () => undefined,
          open: async () => ({ kind: "session", playlist: "file:session.m3u8" }),
          close: () => undefined,
          closed: () => ended,
          failure: () => null,
          trace: () => [],
          addListener: () => ({ remove: () => undefined }),
        },
      });
      const options = { watch: true, login: [] };
      await app.playback.play(
        item(a),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "file:a.mkv", container: "mkv" }),
        },
        options,
      );
      const film = await app.addDownload(movieRef(a));
      expect(statusOf(app, film.id)?.kind).toBe("waiting");
      native.requests.length = 0;
      const playing = app.playback.play(
        item(next),
        {
          kind: "file",
          originalLanguage: null,
          open: async () => ({ url: "file:next.mp4", container: "mp4" }),
        },
        options,
      );
      // Longer than the provider's moment to free a connection: A's session still holds it.
      await new Promise((done) => setTimeout(done, 1_500));
      expect(native.requests).toEqual([]);
      expect(statusOf(app, film.id)?.kind).toBe("waiting");
      expect(app.playbackState.get().closing).toEqual([a]);
      const closedAt = Date.now();
      end();
      await playing;
      await until(() => native.requests.length > 0, "A's download, once its session closed");
      // The provider's moment to free it runs from the session's actual end.
      expect(Date.now() - closedAt).toBeGreaterThanOrEqual(900);
      app.stop();
      await app.removeDownload(film.id);
    }
  });

  it("fails a stream whose download doesn't let go of the connection, asking the provider nothing, and plays once tried again", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    one.stallMovieFile(otherMovie().id, 1, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => one.activeStreams() === 1, "the transfer");
    // URLSession ends neither the request it is asked to pause nor, after, to cancel.
    native.held = [];
    const asked = one.fileRequests();
    playFilm(app, a, otherMovie().id);
    await until(
      () => app.playbackState.get().phase.kind === "failed",
      "the stream to fail",
      15_000,
    );
    expect(app.playbackState.get().phase).toMatchObject({
      error: expect.stringContaining("A download still holds the provider's connection."),
    });
    expect(memory.played).toEqual([]);
    expect(one.fileRequests()).toBe(asked);
    // The request ends at last; Try again takes the connection, though the queue had it again.
    const held = native.held;
    native.held = null;
    for (const ending of held) ending();
    await until(() => statusOf(app, film.id)?.kind !== "transferring", "the transfer to end");
    app.playback.retry();
    await until(() => memory.played[0]?.status != null, "the film");
    expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
    await app.removeDownload(film.id);
    app.stop();
  });

  it("removes a paused download with its resume data", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    playFilm(app, a, otherMovie().id);
    await until(() => memory.played[0]?.status != null, "the film");
    expect(nativeSecrets()).toEqual([film.id]);
    await expect(app.removeDownload(film.id)).resolves.toBeUndefined();
    expect(app.downloadList().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    expect(nativeSecrets()).toEqual([]);
    expect(downloadSecrets()).toEqual([]);
    expect(doc()).toMatchObject({ items: [], forgetting: [] });
    app.stop();
  });

  it("cancels a transfer found after a relaunch: its request ends before its files go", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    app = await launch();
    await until(() => statusOf(app, film.id)?.kind === "transferring", "the request to be found");
    await app.removeDownload(film.id);
    expect(background.task).toBeNull();
    expect(native.open).toBe(0);
    expect(folder(film.id).exists).toBe(false);
    expect(app.downloadList().items).toEqual([]);
    expect(nativeSecrets()).toEqual([]);
    await until(() => background.receipts.length === 0, "the receipt to be acknowledged");
  });

  it("shows a finished copy before the Keychain lets go of its resume data, so an open Cancel keeps it", async () => {
    await install();
    const app = await launch();
    const { actionsOf } = await import("../src/download-controls.tsx");
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 500);
    let release = () => {};
    const removing = new Promise<void>((started) => {
      memory.removal = { started, done: new Promise((done) => (release = done)) };
    });
    const film = await app.addDownload(movieRef(a));
    await until(() => statusOf(app, film.id)?.kind === "transferring", "the transfer");
    const shown = app.downloadList().items.find((item) => item.id === film.id)!;
    actionsOf(shown)
      .find((action) => action.label === "Cancel download")!
      .run();
    expect(memory.sheet?.options).toEqual(["Cancel download", "Keep downloading"]);
    await removing;
    expect.soft(statusOf(app, film.id)?.kind).toBe("complete");
    memory.sheet!.pick(0);
    release();
    await until(() => doc().forgetting.length === 0, "the resume data to go");
    expect(statusOf(app, film.id)?.kind).toBe("complete");
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([film.id]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("ends a removed provider's unfinished downloads; its copy stays, plays offline and keeps its progress", async () => {
    await install();
    let app = await launch();
    const { a, b } = await withProviders(app, true);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    // Small enough for the file an earlier test put behind this film.
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const unfinished = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => one.activeStreams() === 1, "the second transfer");
    // Watched a while from the copy, its subscription still saved: the viewing record has it too.
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    expect(memory.played[0]?.uri).toBe(`file://${mediaFile(kept.id)!.path}`);
    memory.player!.state(true);
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    await expect(app.stop()).resolves.toEqual({ saved: true });
    const copyOf = () => app.downloadList().items.find((item) => item.id === kept.id);
    expect(copyOf()?.progress?.position).toBe(40);
    const recorded = await app.progressOf({ movies: [{ subscriptionId: a, id: kept.title.id }] });
    expect(recorded[0]?.position).toBe(40);

    await app.remove(a, { keepHistory: true });
    await until(() => one.activeStreams() === 0, "the transfer to end");
    await until(() => app.downloadList().items.length === 1, "the unfinished download to go");
    const list = app.downloadList();
    expect(list.ended).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: kept.id,
      subscription: null,
      status: { kind: "complete" },
    });
    expect(folder(unfinished.id).exists).toBe(false);
    expect(downloadSecrets()).toEqual([]);

    // After a relaunch, with no provider for it, it plays from where it was left, and plays on
    // when the last provider goes, while a request waiting to play lapses.
    app = await launch();
    const requests = one.fileRequests();
    app.playDownload(kept.id);
    await until(() => memory.played.length === 2, "the copy to open again");
    expect(memory.played[1]?.uri).toBe(memory.played[0]?.uri);
    memory.player!.state(true);
    const waiting = app.request();
    await app.remove(b!, { keepHistory: true });
    expect(waiting.stands()).toBe(false);
    expect(app.members()).toEqual([]);
    expect(app.playbackState.get()).toMatchObject({
      phase: { kind: "playing", item: { subscriptionId: null } },
      watch: true,
    });
    Object.assign(memory.player!, { currentTime: 70, duration: 100 });
    await expect(app.stop()).resolves.toEqual({ saved: true });
    expect(app.downloadList().items.find((item) => item.id === kept.id)?.progress?.position).toBe(
      70,
    );
    expect(one.fileRequests()).toBe(requests);
    const copy: Download | undefined = app.downloadList().items[0];
    expect(copy?.subscription).toBeNull();
  });

  for (const keepHistory of [true, false]) {
    it(`tells no refused save when the provider of a loaded film is removed, keepHistory ${keepHistory}`, async () => {
      await install();
      const app = await launch();
      const { a } = await withProviders(app);
      const told = vi.fn();
      app.onProgressRefused(told);
      playFilm(app, a, movie().id);
      await until(() => memory.played.length === 1, "the film");
      const player = memory.player!;
      player.state(true);
      Object.assign(player, { currentTime: 1200, duration: 6000 });
      await expect(app.closeWatch()).resolves.toEqual({ saved: true });
      player.state(false);
      await app.progressSettled();
      // Removing it stops the film, whose last save then finds its subscription gone.
      player.currentTime = 1300;
      await app.remove(a, { keepHistory });
      await app.progressSettled();
      expect(app.playbackState.get().phase.kind).toBe("idle");
      expect(told).not.toHaveBeenCalled();
    });
  }

  it("still tells a save the viewing record refuses, once, until one is kept again", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const told = vi.fn();
    app.onProgressRefused(told);
    playFilm(app, a, movie().id);
    await until(() => memory.played.length === 1, "the film");
    const player = memory.player!;
    player.state(true);
    Object.assign(player, { currentTime: 1200, duration: 6000 });
    // viewing.json can't be written.
    const blocked = new Folder(native.root, "documents", "viewing.json.next");
    blocked.create();
    await expect(app.closeWatch()).resolves.toMatchObject({ saved: false });
    player.state(false);
    await app.progressSettled();
    expect(told).toHaveBeenCalledOnce();
    blocked.delete();
    app.togglePause();
    player.state(true);
    player.state(false);
    await app.progressSettled();
    const film = { subscriptionId: a, id: String(movie().id) };
    expect((await app.progressOf({ movies: [film] }))[0]?.position).toBe(1200);
    blocked.create();
    await expect(app.stop()).resolves.toMatchObject({ saved: false });
    blocked.delete();
    expect(told).toHaveBeenCalledTimes(2);
  });

  it("plays a copy again from where Close just left it", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    void app.closeWatch();
    app.playDownload(kept.id);
    await until(() => memory.played.length === 2, "the copy to open again");
    memory.player!.ready();
    expect(memory.player!.currentTime).toBe(35);
    await app.stop();
  });

  it("goes on to the next save only once both of a copy's saves ended, and says it wasn't kept", async () => {
    await install();
    holdingViewingSaves();
    const app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    // The copy's record refuses the write at once; the viewing record's save is still going.
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    let release = () => {};
    viewingSaves.hold = new Promise((done) => (release = done));
    let stopped: unknown = null;
    void app.stop().then((saved) => (stopped = saved));
    await sleep(50);
    expect(stopped).toBeNull();
    release();
    viewingSaves.hold = null;
    await until(() => stopped !== null, "Stop to settle");
    expect(stopped).toMatchObject({ saved: false });
    blocked.delete();
    expect(app.downloadList().items.find((item) => item.id === kept.id)?.progress).toBeNull();
    const recorded = await app.progressOf({ movies: [{ subscriptionId: a, id: kept.title.id }] });
    expect(recorded[0]?.position).toBe(40);
  });

  it("queues a season's remaining episodes of one provider, once each", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    const [first] = season.episodes;
    await app.addDownload(episodeOf(first!));
    const scope = { kind: "season", season: season.number } as const;
    const plan = app.planDownload(details, version, scope);
    expect(plan.held).toBe(1);
    expect(plan.add.map((ref) => ref.id)).toEqual(season.episodes.slice(1).map((each) => each.id));

    const asked = two.fileRequests();
    const id = app.startDownload(plan, { replace: false, stands: () => true });
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()).toMatchObject({ id, total: season.episodes.length - 1 });
    expect(app.seriesRun()?.result).toMatchObject({
      added: season.episodes.length - 1,
      failed: [],
    });
    const records = app.downloadList().items.filter((item) => item.title.kind === "episode");
    expect(records.map((item) => item.title.id).toSorted()).toEqual(
      season.episodes.map((each) => each.id).toSorted(),
    );
    // The other provider lists the same ids: none of its episodes is queued or asked for.
    expect(records.every((item) => item.subscription?.id === a)).toBe(true);
    expect(b).not.toBeNull();
    expect(two.fileRequests()).toBe(asked);
    expect(app.planDownload(details, version, scope).add).toEqual([]);
  });

  it("replaces a missing copy only once the copy playing stops", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    // Its second episode, an MP4 the player opens itself, alone in its season.
    const only = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 2) }] };
    const kept = await app.addDownload(episodeOf(season.episodes[1]!));
    await until(() => isComplete(app, kept.id), "the copy", 20_000);
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    mediaFile(kept.id)!.delete();
    appGoes("background");
    appGoes("active");
    expect(statusOf(app, kept.id)?.kind).toBe("missing");

    const plan = app.planDownload(only, version, { kind: "season", season: season.number });
    expect(plan.missing).toHaveLength(1);
    const playing = app.startDownload(plan, { replace: true, stands: () => true })!;
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()?.result.failed).toEqual([
      { ref: plan.missing[0], error: "Stop playing this copy first." },
    ]);
    expect(statusOf(app, kept.id)?.kind).toBe("missing");

    await app.playback.stop();
    const retry = app.planRetry(playing)!;
    expect(retry.missing).toEqual(plan.missing);
    app.startDownload(retry, { replace: true, stands: () => true });
    await until(() => app.seriesRun()?.phase === "done", "the retry");
    expect(app.seriesRun()?.result).toMatchObject({ replaced: 1, failed: [] });
    expect(statusOf(app, kept.id)).toBeUndefined();
    expect(app.downloadOf(plan.missing[0]!)?.status.kind).not.toBe("missing");
  });

  // While the old record's removal still waits on the native side, the run stops: its new
  // addition isn't the run's to make any more. Nothing stopping it, it is made.
  for (const [change, count] of [
    ["nothing", 1],
    ["Cancel remaining", 1],
    ["a new login", 1],
    ["leaving", 1],
    ["Cancel remaining", 2],
  ] as const) {
    it(`replaces a missing copy, once its removal ends, only while the run stands: ${change}, ${count} missing`, async () => {
      await install();
      const app = await launch();
      const { a } = await withProviders(app);
      const { version, details } = await seriesDetails(app, a);
      const season = details.seasons[0]!;
      const episodes = season.episodes.slice(1, count + 1);
      const only = { ...details, seasons: [{ ...season, episodes }] };
      const copies: Download[] = [];
      for (const episode of episodes) copies.push(await app.addDownload(episodeOf(episode)));
      for (const copy of copies) {
        await until(() => isComplete(app, copy.id), "the copy", 20_000);
        mediaFile(copy.id)!.delete();
      }
      appGoes("background");
      appGoes("active");
      const plan = app.planDownload(only, version, { kind: "season", season: season.number });
      const { transfers } = await import("../src/download-task.ts");
      const forget = transfers.forgetResume.bind(transfers);
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      const hold = vi.spyOn(transfers, "forgetResume").mockImplementationOnce(async (id) => {
        arrived.resolve();
        await released.promise;
        await forget(id);
      });
      onTestFinished(() => {
        released.resolve();
        hold.mockRestore();
      });
      let mounted = true;
      const id = app.startDownload(plan, { replace: true, stands: () => mounted })!;
      await arrived.promise;
      expect(doc().items).toEqual(
        copies.slice(1).map((copy) => expect.objectContaining({ id: copy.id })),
      );
      if (change === "Cancel remaining") app.cancelRemaining(id);
      else if (change === "a new login") await app.update(a, { password: ONE.password });
      else if (change === "leaving") mounted = false;
      released.resolve();
      await until(() => app.seriesRun()?.phase === "done", "the run");
      const { result } = app.seriesRun()!;
      if (change === "nothing") {
        expect(result).toMatchObject({ replaced: 1, removed: 0, stopped: null });
        expect(app.downloadOf(plan.missing[0]!)?.status.kind).not.toBe("missing");
        return;
      }
      expect(result).toMatchObject({
        replaced: 0,
        removed: 1,
        cancelled: count - 1,
        stopped: { "Cancel remaining": "cancelled", "a new login": "login", leaving: "left" }[
          change
        ],
      });
      expect(app.seriesRun()).toMatchObject({ done: 1, total: count });
      expect(result.removed + result.cancelled).toBe(count);
      // Only the first copy was asked for: its removal stays, while unasked copies stay missing.
      expect(app.downloadList().items.map((item) => item.id)).toEqual(
        copies.slice(1).map((copy) => copy.id),
      );
      expect(doc().items).toEqual(
        copies.slice(1).map((copy) => expect.objectContaining({ id: copy.id })),
      );
      for (const copy of copies.slice(1)) expect(statusOf(app, copy.id)?.kind).toBe("missing");
    });
  }

  // A failed episode's retry waits for its file type; meanwhile the viewer removes it, removes and
  // downloads it anew, or the run no longer stands. Only that record's retry counts, and only a
  // run that stands writes it.
  for (const change of [
    "removal",
    "a new download of it",
    "Cancel remaining",
    "a new login",
  ] as const) {
    it(`retries a failed episode only as its record still stands: ${change}`, async () => {
      await install();
      let app = await launch();
      const { a } = await withProviders(app);
      const { version, details } = await seriesDetails(app, a);
      const season = details.seasons[0]!;
      const only = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 2) }] };
      const ref = episodeOf(season.episodes[1]!);
      native.free = 1;
      const failed = await app.addDownload(ref);
      await until(() => statusOf(app, failed.id)?.kind === "failed", "the disk to refuse it");
      native.free = 64 * 1024 * 1024 * 1024;
      // Launched anew, its file type is asked of the provider again.
      app = await launch();
      await until(() => app.titleLists().kind === "ready", "the title lists");
      const plan = app.planDownload(only, version, { kind: "season", season: season.number });
      expect(plan.retry).toHaveLength(1);
      const arrived = Promise.withResolvers<void>();
      const released = Promise.withResolvers<void>();
      memory.details = { arrived: arrived.resolve, released: released.promise };
      const id = app.startDownload(plan, { replace: false, stands: () => true })!;
      await arrived.promise;
      let anew: Promise<Download> | null = null;
      if (change === "removal") await app.removeDownload(failed.id);
      else if (change === "a new download of it") {
        await app.removeDownload(failed.id);
        anew = app.addDownload(ref);
      } else if (change === "Cancel remaining") app.cancelRemaining(id);
      else await app.update(a, { password: ONE.password });
      memory.details = null;
      released.resolve();
      await until(() => app.seriesRun()?.phase === "done", "the run");
      const { result } = app.seriesRun()!;
      expect(result.retried).toBe(0);
      if (change === "removal" || change === "a new download of it") {
        expect(result).toMatchObject({ skipped: 1, stopped: null });
        const again = anew && (await anew);
        // Nothing removed comes back; the new download is the viewer's own, once.
        expect(app.downloadList().items.map((item) => item.id)).toEqual(again ? [again.id] : []);
        expect(again?.id).not.toBe(failed.id);
        return;
      }
      expect(result).toMatchObject({
        cancelled: 1,
        stopped: change === "Cancel remaining" ? "cancelled" : "login",
      });
      expect(statusOf(app, failed.id)?.kind).toBe("failed");
      expect(doc().items.map((item: { state: string }) => item.state)).toEqual(["failed"]);
    });
  }

  it("lets an addition already asked settle after Cancel remaining, asking for no other", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const { version, details } = await seriesDetails(app, a);
    const season = details.seasons[0]!;
    const two = { ...details, seasons: [{ ...season, episodes: season.episodes.slice(1, 3) }] };
    // Launched anew, the first addition asks the provider for the series again.
    app = await launch();
    await until(() => app.titleLists().kind === "ready", "the title lists");
    const plan = app.planDownload(two, version, { kind: "season", season: season.number });
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    memory.details = { arrived: arrived.resolve, released: released.promise };
    const id = app.startDownload(plan, { replace: false, stands: () => true })!;
    await arrived.promise;
    app.cancelRemaining(id);
    memory.details = null;
    released.resolve();
    await until(() => app.seriesRun()?.phase === "done", "the run");
    expect(app.seriesRun()?.result).toMatchObject({ added: 1, cancelled: 1, stopped: "cancelled" });
    expect(app.downloadList().items.map((item) => item.title.id)).toEqual([plan.add[0]!.id]);
  });
});

/** The first fixture series' details from `subscriptionId`, as its details screen reads them. */
async function seriesDetails(app: App, subscriptionId: string) {
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No titles");
  const version = { subscriptionId, id: String(episode().series.id) };
  const title = app.titleOf(lists.index, "series", version)!;
  const details = await app.detailsOf({ ...title, ...version });
  if (details.kind !== "series") throw new Error("Not a series");
  return { version, details };
}

/** An episode's ref as its row's download button queues it. */
const episodeOf = (each: SeriesEpisode): TitleRef => ({
  kind: "episode",
  subscriptionId: each.subscriptionId,
  id: each.id,
  seriesId: each.seriesId,
  season: each.season,
  episode: each.number,
});

describe("offline Next", { timeout: 30_000 }, () => {
  /** MP4 neighbours in the provider's first season, downloaded by the real queue. */
  async function pair() {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { details } = await seriesDetails(app, a);
    const [first, second] = details.seasons[0]!.episodes.slice(1, 3);
    const from = await app.addDownload(episodeOf(first!));
    const to = await app.addDownload(episodeOf(second!));
    await until(() => isComplete(app, from.id) && isComplete(app, to.id), "the episode copies");
    return { app, a, from, to };
  }
  const item = (app: App) => app.playingItem(app.playbackState.get().phase);

  it("keeps the saved immediate order across a removed provider and cold launch, with no network or autoplay", async () => {
    let { app, a, from, to } = await pair();
    // The target's own resume position must survive too, without an online viewing read.
    app.playDownload(to.id);
    await until(() => memory.played.length === 1, "the target copy");
    memory.player!.ready();
    memory.player!.currentTime = 70;
    memory.player!.state(true);
    await app.stop();
    await app.remove(a, { keepHistory: false });
    app = await launch();
    const network = vi.spyOn(globalThis, "fetch");
    onTestFinished(() => network.mockRestore());
    app.playDownload(from.id);
    await until(() => memory.played.length === 2, "the original copy");
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: true });
    memory.player!.ready();
    memory.player!.currentTime = 40;
    memory.player!.state(true);
    memory.player!.observation({ kind: "ended" });
    await sleep(30);
    expect(memory.played).toHaveLength(2);
    app.playNext();
    await until(() => memory.played.length === 3, "the next saved copy");
    memory.player!.ready();
    expect(memory.played[2]?.uri).toBe(`file://${mediaFile(to.id)!.path}`);
    expect(memory.player!.currentTime).toBe(65);
    expect(app.downloadList().items.find((each) => each.id === from.id)?.progress?.position).toBe(
      40,
    );
    expect(network).not.toHaveBeenCalled();
    await app.stop();
  });

  it("stops at a missing episode instead of skipping to a later saved one", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const { details } = await seriesDetails(app, a);
    const last = details.seasons[0]!.episodes.at(-1)!;
    const later = details.seasons[1]!.episodes[1]!;
    const from = await app.addDownload(episodeOf(last));
    const pastGap = await app.addDownload(episodeOf(later));
    await until(
      () => isComplete(app, from.id) && isComplete(app, pastGap.id),
      "the nonadjacent copies",
    );
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    app.playNext();
    await app.progressSettled();
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    await app.stop();
  });

  it("never borrows the same episode id from another provider", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const theirs = await seriesDetails(app, b!);
    const ours = await seriesDetails(app, a);
    const from = await app.addDownload(episodeOf(theirs.details.seasons[0]!.episodes[0]!));
    const other = await app.addDownload(episodeOf(ours.details.seasons[0]!.episodes[1]!));
    await until(
      () => isComplete(app, from.id) && isComplete(app, other.id),
      "both providers' copies",
    );
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the second provider's copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    app.playNext();
    await app.progressSettled();
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    await app.stop();
  });

  it("does not offer or stream a successor whose complete record has lost its file", async () => {
    const { app, from, to } = await pair();
    mediaFile(to.id)!.delete();
    app.playDownload(from.id);
    await until(() => memory.played.length === 1, "the original copy");
    memory.player!.ready();
    expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
    const requests = one.fileRequests();
    app.playNext();
    await app.progressSettled();
    await sleep(30);
    expect(memory.played).toHaveLength(1);
    expect(one.fileRequests()).toBe(requests);
    await app.stop();
  });

  for (const change of ["nothing", "Stop", "navigation", "target removed"] as const) {
    it(
      change === "nothing"
        ? "advances after a held save with its provider still saved"
        : `retires a Next waiting for its save when ${change}`,
      async () => {
        holdingViewingSaves();
        const { app, a, from, to } = await pair();
        app.playDownload(from.id);
        await until(() => memory.played.length === 1, "the copy");
        memory.player!.ready();
        memory.player!.currentTime = 40;
        memory.player!.state(true);
        const held = Promise.withResolvers<void>();
        viewingSaves.hold = held.promise;
        onTestFinished(() => {
          viewingSaves.hold = null;
          held.resolve();
        });
        app.playNext();
        await sleep(20);
        expect(memory.played).toHaveLength(1);
        if (change === "Stop") void app.stop();
        else if (change === "navigation") app.request();
        else if (change === "target removed") await app.removeDownload(to.id);
        viewingSaves.hold = null;
        held.resolve();
        await app.progressSettled();
        if (change === "nothing") {
          await until(() => memory.played.length === 2, "the next local copy after its save");
          expect(memory.played[1]?.uri).toBe(`file://${mediaFile(to.id)!.path}`);
          if (from.title.kind !== "episode") throw new Error("Not an episode copy");
          const viewed = await app.progressOf({
            series: [{ subscriptionId: a, id: from.title.seriesId }],
          });
          expect(viewed.find((each) => each.title.id === from.title.id)?.position).toBe(40);
        } else {
          await sleep(30);
          expect(memory.played).toHaveLength(1);
        }
        await app.stop();
      },
    );
  }

  for (const continuation of [
    undefined,
    { version: 2, title: "future" },
    { version: 1, title: { kind: "bad" } },
  ]) {
    it(`keeps a copy playable without guessing an unreadable saved order: ${JSON.stringify(continuation)}`, async () => {
      let { app, a, from } = await pair();
      await app.remove(a, { keepHistory: false });
      const stored = doc();
      const row = stored.items.find((each: { id: string }) => each.id === from.id);
      if (continuation === undefined) delete row.continuation;
      else row.continuation = continuation;
      new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
      app = await launch();
      app.playDownload(from.id);
      await until(() => memory.played.length === 1, "the legacy copy");
      memory.player!.ready();
      expect(item(app)).toMatchObject({ id: `copy:${from.id}`, next: false });
      expect(memory.played[0]?.uri).toBe(`file://${mediaFile(from.id)!.path}`);
      memory.player!.currentTime = 30;
      memory.player!.state(true);
      app.playNext();
      await app.progressSettled();
      await sleep(20);
      expect(memory.played).toHaveLength(1);
      await app.stop();
      expect(doc().items.find((each: { id: string }) => each.id === from.id).continuation).toEqual(
        continuation,
      );
      expect(app.downloadList().items.find((each) => each.id === from.id)?.progress?.position).toBe(
        30,
      );
    });
  }
});

/** Holds the player's next native detach until `release`, or refuses it with `refuse`. */
function holdingDetach() {
  const player = memory.player!;
  const detach = player.detachObservedAsync.getMockImplementation()!;
  const held = Promise.withResolvers<void>();
  player.detachObservedAsync.mockImplementationOnce(async (id) => {
    await held.promise;
    return detach(id);
  });
  return { release: () => held.resolve(), refuse: () => held.reject(new Error("Not detached")) };
}

describe("the native queue's contract", { timeout: 40_000 }, () => {
  it("binds a login's download authority without changing its Source, and plays while binding is refused", async () => {
    await install();
    // The native queue can't write an enable: no binding, so no download asks anything.
    background.faults.ledger = true;
    const app = await launch();
    const { a } = await withProviders(app);
    const sources = await import("../src/sources.ts");
    const source = sources.currentSource(a)!;
    const retired = sources.retiredLogins();
    const film = await app.addDownload(movieRef(a));
    await sleep(1_500);
    expect(app.downloadGeneration(source)).toBeNull();
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    expect(native.requests).toEqual([]);
    // Titles and streams go on all the same.
    playFilm(app, a, otherMovie().id);
    await until(() => memory.played[0]?.status != null, "the film");
    expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
    await app.stop();
    background.faults.ledger = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once its login is bound");
    expect(sources.currentSource(a)).toBe(source);
    expect(sources.retiredLogins()).toBe(retired);
    expect(app.downloadGeneration(source)).not.toBeNull();
  });

  it("fences a login's downloads before its password changes, and asks again under the new login", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const sources = await import("../src/sources.ts");
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // Neither the ledger nor the Keychain can fence it: the change is refused, nothing changes.
    const before = sources.currentSource(a);
    background.faults = { ...background.faults, ledger: true, keychainDelete: true };
    await expect(app.update(a, { password: ONE.password })).rejects.toThrow();
    expect(sources.currentSource(a)).toBe(before);
    expect(statusOf(app, film.id)?.kind).toBe("transferring");
    background.faults = { ...background.faults, ledger: false, keychainDelete: false };
    await app.update(a, { password: ONE.password });
    expect(sources.currentSource(a)).not.toBe(before);
    one.stallMovieFile(movie().id, 0, 0);
    await until(() => isComplete(app, film.id), "the copy under the new login");
    // The old login's request went with its generation, resume data included.
    expect(native.requests.map((each) => each.range)).toEqual([null, null]);
    expect(one.mostFilesAtOnce()).toBe(1);
  });

  it("removes a transfer under a Keychain fence when the native ledger refuses, and never asks for it again", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    background.faults.ledger = true;
    await app.removeDownload(film.id);
    expect(doc().items).toEqual([]);
    expect(folder(film.id).exists).toBe(false);
    await until(() => one.activeStreams() === 0, "its request to end");
    background.faults.ledger = false;
    const asked = native.requests.length;
    app = await launch();
    await sleep(1_500);
    expect(native.requests).toHaveLength(asked);
    expect(app.downloadList().items).toEqual([]);
  });

  it("finishes a removal whose record couldn't be dropped at the next launch, never asking for it again", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // The intent is written and the fence made; then Documents refuses every write.
    let writes = 0;
    native.sync = (operation, path) => {
      if (operation === "write" && path.endsWith("downloads.json.next") && ++writes > 1) {
        throw new Error("No space left on the device.");
      }
    };
    await expect(app.removeDownload(film.id)).rejects.toThrow();
    expect(doc().items).toEqual([
      expect.objectContaining({ id: film.id, removal: { version: 1, reason: "user" } }),
    ]);
    await until(() => one.activeStreams() === 0, "its request to end");
    // Its cancelled receipt waits: nothing wrote the removal down yet.
    expect(background.receipts.map((each) => each.outcome.kind)).toEqual(["cancelled"]);
    native.sync = null;
    const asked = native.requests.length;
    app = await launch();
    await until(() => doc().items.length === 0, "the removal to finish");
    await until(() => background.receipts.length === 0, "its receipt acknowledged after");
    await sleep(1_500);
    expect(native.requests).toHaveLength(asked);
    expect(folder(film.id).exists).toBe(false);
  });

  it("acknowledges a receipt only once its record wrote it down, then takes it in once", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    await until(
      () => background.events.includes(`receipt:${film.id}:complete`),
      "the transfer to complete natively",
    );
    await sleep(100);
    expect(background.receipts).toHaveLength(1);
    expect(doc().items[0]).toMatchObject({ id: film.id, state: "queued" });
    blocked.delete();
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy");
    await until(() => background.receipts.length === 0, "the receipt acknowledged");
    expect(native.requests).toHaveLength(1);
  });

  it("lets a stream stopped while its lease is still being acquired hold nothing back", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    native.pauseMs = 800;
    playFilm(app, a, otherMovie().id);
    await sleep(100);
    // Released before its acquisition answered: that late answer can't hold the provider.
    await app.stop();
    one.stallMovieFile(movie().id, 0, 0);
    await until(() => isComplete(app, film.id), "the copy, going on from its pause");
    expect(memory.played).toEqual([]);
    expect(native.requests.map((each) => each.range)).toEqual([null, "bytes=20000-"]);
  });

  it("deletes a copy only once its player's readers closed, and opens it for no tap meanwhile", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    const detach = holdingDetach();
    let removed = false;
    const removing = app.removeDownload(kept.id).then(() => (removed = true));
    await until(() => doc().items.length === 0, "the record to go");
    expect(app.playbackState.get().phase.kind).toBe("idle");
    app.playDownload(kept.id);
    await sleep(300);
    // Saving progress or Stop answering isn't its reader closing: the file stays.
    expect(folder(kept.id).exists).toBe(true);
    expect(removed).toBe(false);
    expect(memory.played).toHaveLength(1);
    detach.release();
    await removing;
    expect(folder(kept.id).exists).toBe(false);
  });

  it("keeps a deleted copy's folder while its reader's closure is refused, until a later launch", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    const detach = holdingDetach();
    const removing = app.removeDownload(kept.id);
    await until(() => doc().items.length === 0, "the record to go");
    detach.refuse();
    await removing;
    expect(folder(kept.id).exists).toBe(true);
    app = await launch();
    await until(() => !folder(kept.id).exists, "the next launch to sweep the folder");
  });

  it("waits for a copy's reader still retiring after another copy played", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const first = await app.addDownload(movieRef(a));
    const other = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => isComplete(app, first.id) && isComplete(app, other.id), "both copies");
    app.playDownload(first.id);
    await until(() => memory.played.length === 1, "the first copy");
    const detach = holdingDetach();
    // A newer play retires the first copy's reader; its detach hasn't answered.
    app.playDownload(other.id);
    await sleep(100);
    const removing = app.removeDownload(first.id);
    await until(() => doc().items.length === 1, "the first record to go");
    await sleep(300);
    expect(folder(first.id).exists).toBe(true);
    detach.release();
    await removing;
    expect(folder(first.id).exists).toBe(false);
    expect(folder(other.id).exists).toBe(true);
    await app.stop();
  });

  it("erases a subscription's downloads for its reset, copies too, with saves and readers apart", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    const copy = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, copy.id), "the copy");
    const theirs = await app.addDownload(movieRef(b!));
    await until(() => isComplete(app, theirs.id), "the other provider's copy");
    // Small enough for the file an earlier test put behind this film.
    one.stallMovieFile(otherMovie().id, 5_000, 60_000);
    const unfinished = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, unfinished.id) === 5_000, "the transfer to stall");
    app.playDownload(copy.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.state(true);
    const detach = holdingDetach();
    const erased = await app.eraseDownloads(a, "demo-reset");
    expect(erased).toMatchObject({ trusted: true, removed: 2, kept: 0 });
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([theirs.id]);
    await erased.saved;
    let cleaned: string | null = null;
    void erased.cleanup.then((settled) => (cleaned = settled));
    await sleep(300);
    expect(cleaned).toBeNull();
    expect(folder(copy.id).exists).toBe(true);
    detach.release();
    await expect(erased.cleanup).resolves.toBe("closed");
    expect(folder(copy.id).exists).toBe(false);
    expect(folder(unfinished.id).exists).toBe(false);
    expect(isComplete(app, theirs.id)).toBe(true);
    await until(() => one.activeStreams() === 0, "the transfer's request to end");
  });

  it("erases nothing, trusted, for a subscription with no downloads on a fresh install", async () => {
    await install();
    const app = await launch();
    const erased = await app.eraseDownloads("demo", "demo-reset");
    expect(erased).toMatchObject({ trusted: true, removed: 0, kept: 0 });
    await expect(erased.cleanup).resolves.toBe("closed");
  });

  it("stops Watch showing a removed copy that failed, so Try again can't open it again", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1, "the copy to open");
    memory.player!.failure();
    await until(() => app.playbackState.get().phase.kind === "failed", "the copy to fail");
    await app.removeDownload(kept.id);
    expect(app.playbackState.get().phase.kind).toBe("idle");
    app.playback.retry();
    await sleep(100);
    expect(memory.played).toHaveLength(1);
    expect(folder(kept.id).exists).toBe(false);
  });

  it("starts a damaged native queue over once at the first foreground, keeping copies", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const kept = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, kept.id), "the copy");
    appGoes("background");
    const queued = await app.addDownload(movieRef(a, otherMovie().id));
    background.corrupt = true;
    memory.appState = "active";
    app = await launch();
    await until(() => isComplete(app, queued.id), "the queued copy under a fresh queue", 15_000);
    const resets = () => background.events.filter((each) => each === "reset").length;
    expect(resets()).toBe(1);
    expect(isComplete(app, kept.id)).toBe(true);
    expect(mediaFile(kept.id)?.size).toBe(fixture(movie().fixture!).length);
    // Damaged again in the same process: no second automatic reset.
    background.corrupt = true;
    appGoes("background");
    appGoes("active");
    await sleep(300);
    expect(resets()).toBe(1);
    background.corrupt = false;
  });

  it("tries a refused reset of a damaged queue once per process, and stays blocked honestly", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    background.corrupt = true;
    background.faults.keychainDelete = true;
    memory.appState = "active";
    app = await launch();
    const attempts = () => background.events.filter((each) => each === "reset-attempt").length;
    await until(() => attempts() === 1, "the one automatic reset attempt");
    // The next foreground in the same process reads again but doesn't start the queue over again.
    background.faults.keychainDelete = false;
    appGoes("background");
    appGoes("active");
    await sleep(500);
    expect(attempts()).toBe(1);
    expect(background.corrupt).toBe(true);
    expect(statusOf(app, film.id)?.kind).toBe("queued");
    expect(native.requests).toEqual([]);
    background.corrupt = false;
  });

  it("never starts a locked queue over, and goes on once it can be read", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    background.unavailable = true;
    memory.appState = "active";
    app = await launch();
    await sleep(1_000);
    expect(background.events).not.toContain("reset");
    expect(native.requests).toEqual([]);
    background.unavailable = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once the queue reads");
    expect(background.events).not.toContain("reset");
  });
});

/** Pauses `film`'s transfer for a stream of its provider, keeping resume data, then stops it. */
async function pausedWithResume(app: App, a: string, film: Download) {
  playFilm(app, a, otherMovie().id);
  await until(() => memory.played.at(-1)?.status != null, "the film");
  await until(() => nativeSecrets().includes(film.id), "the transfer's resume data");
  return background.resume.get(film.id)!;
}

describe("the native queue's corrections", { timeout: 40_000 }, () => {
  it("keeps a finished file while the Keychain doesn't answer, and publishes it once it does", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    background.faults.keychainUnavailable = true;
    await until(() => background.deferred !== null, "the finished file to wait for the Keychain");
    await sleep(300);
    // Unreadable isn't missing: no failure, no refresh, no second request.
    expect(background.receipts).toEqual([]);
    expect(doc().items[0]).toMatchObject({ id: film.id, state: "queued" });
    expect(native.requests).toHaveLength(1);
    background.faults.keychainUnavailable = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once the Keychain answers");
    expect(native.requests).toHaveLength(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("starts a refused resume again only on the viewer's Retry when its resume data can't be deleted", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const kept = await pausedWithResume(app, a, film);
    // The file the resume data names is gone: the server-side resume is refused.
    const { part } = JSON.parse(Buffer.from(kept.data, "base64").toString()) as { part: string };
    new DiskFile(part).delete();
    background.faults.keychainDelete = true;
    one.stallMovieFile(movie().id, 0, 0);
    await app.stop();
    await until(() => statusOf(app, film.id)?.kind === "failed", "the refused resume to fail");
    expect(statusOf(app, film.id)).toMatchObject({
      kind: "failed",
      failure: { kind: "stream", failure: { kind: "network" } },
    });
    const asked = native.requests.length;
    appGoes("background");
    appGoes("active");
    await sleep(1_500);
    // Not asked again on its own, though the queue refilled.
    expect(native.requests).toHaveLength(asked);
    background.faults.keychainDelete = false;
    await app.retryDownload(film.id);
    await until(() => isComplete(app, film.id), "the copy after Retry");
    // Retry's resumed request is refused too; the bytes go, and it starts once from nothing.
    expect(native.requests.slice(asked).map((each) => each.range)).toEqual(["bytes=20000-", null]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("defers a resumed start whose resume data can't be made its own, then goes on from it", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await pausedWithResume(app, a, film);
    background.faults.keychainWrite = true;
    one.stallMovieFile(movie().id, 0, 0);
    await app.stop();
    await sleep(1_500);
    // Neither a fresh request in its place nor a resumed one it doesn't own.
    expect(native.requests).toHaveLength(1);
    background.faults.keychainWrite = false;
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy once its resume data is its own");
    expect(native.requests.map((each) => each.range)).toEqual([null, "bytes=20000-"]);
  });

  it("removes a revoked login's resume data with it, a failed download's included", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    await background.breakConnection();
    await until(() => statusOf(app, film.id)?.kind === "failed", "the failure");
    expect(nativeSecrets()).toEqual([film.id]);
    const old = background.sources.get(a)!.generation;
    await app.update(a, { password: ONE.password });
    const ofOld = (each: { sourceGeneration: string }) => each.sourceGeneration === old;
    expect([...background.requests.values()].filter(ofOld)).toEqual([]);
    expect([...background.resume.values()].filter(ofOld)).toEqual([]);
    expect(background.anchors.get(a)?.generation).not.toBe(old);
    // Its Retry asks anew under the new login, from the start.
    one.stallMovieFile(movie().id, 0, 0);
    await app.retryDownload(film.id);
    await until(() => isComplete(app, film.id), "the copy under the new login");
    expect(native.requests.map((each) => each.range)).toEqual([null, null]);
  });

  it("keeps a build-14 copy's file while its record can't be written, and completes it without asking again", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    const film = await app.addDownload(movieRef(a));
    await until(() => isComplete(app, film.id), "the copy");
    const size = mediaFile(film.id)!.size;
    // As build 14 left it: queued under its own attempt, with that attempt's complete receipt
    // not yet taken in.
    background.die();
    background.down = true;
    const stored = doc();
    const row = stored.items[0];
    delete row.transfer;
    Object.assign(row, { state: "queued", attempt: "a-build14", completedAt: null });
    new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
    background.legacyReceipts.push({
      receipt: "r-build14",
      attempt: "a-build14",
      id: film.id,
      outcome: { kind: "complete", size, expected: size },
    });
    const asked = native.requests.length;
    // downloads.json can't be written.
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    app = await launch();
    await sleep(1_500);
    expect(mediaFile(film.id)?.size).toBe(size);
    expect(native.requests).toHaveLength(asked);
    expect(background.legacyReceipts).toHaveLength(1);
    blocked.delete();
    app = await launch();
    await until(() => isComplete(app, film.id), "the copy taken in");
    expect(mediaFile(film.id)?.size).toBe(size);
    expect(native.requests).toHaveLength(asked);
    await until(() => background.legacyReceipts.length === 0, "build 14's receipt acknowledged");
  });

  it("keeps a native completion its damaged queue still reads through the queue's reset", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    await until(
      () => background.events.includes(`receipt:${film.id}:complete`),
      "the transfer to complete natively",
    );
    background.corrupt = true;
    blocked.delete();
    app = await launch();
    await until(() => background.events.includes("reset"), "the reset");
    await until(() => isComplete(app, film.id), "the copy from its kept receipt");
    expect(native.requests).toHaveLength(1);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
  });

  it("refuses a reset whose final write doesn't answer in time, then lets its late write settle once", async () => {
    await install();
    let app = await launch();
    const { a } = await withProviders(app);
    appGoes("background");
    const film = await app.addDownload(movieRef(a));
    background.corrupt = true;
    const hold = Promise.withResolvers<void>();
    background.resetHold = hold.promise;
    background.resetDeadlineMs = 300;
    onTestFinished(() => {
      hold.resolve();
      background.resetHold = null;
      background.resetDeadlineMs = 15_000;
    });
    memory.appState = "active";
    app = await launch();
    const attempts = () => background.events.filter((each) => each === "reset-attempt").length;
    await until(() => attempts() === 1, "the one automatic reset attempt");
    await sleep(600);
    expect(background.corrupt).toBe(true);
    expect(background.resetting).toBe(true);
    // Another foreground while its write is outstanding starts no second reset.
    appGoes("background");
    appGoes("active");
    await sleep(300);
    expect(attempts()).toBe(1);
    expect(native.requests).toEqual([]);
    hold.resolve();
    await until(() => background.events.includes("reset-late"), "the late write to apply");
    expect(background.events).not.toContain("reset");
    appGoes("background");
    appGoes("active");
    await until(() => isComplete(app, film.id), "the copy under the fresh queue");
    expect(attempts()).toBe(1);
  });
});

/**
 * Leaves `film` as build 14 did: queued under its own attempt, its whole file in place and its
 * complete receipt not yet taken in, optionally already being removed with its subscription.
 */
function asBuild14Completion(film: Download, intent?: "source-removed") {
  background.die();
  background.down = true;
  const size = mediaFile(film.id)!.size;
  const stored = doc();
  const row = stored.items.find((each: { id: string }) => each.id === film.id);
  delete row.transfer;
  Object.assign(row, { state: "queued", attempt: "a-build14", completedAt: null });
  if (intent) row.removal = { version: 1, reason: intent };
  new DiskFile(native.root, "documents", "downloads.json").writeSync(JSON.stringify(stored));
  background.legacyReceipts.push({
    receipt: "r-build14",
    attempt: "a-build14",
    id: film.id,
    outcome: { kind: "complete", size, expected: size },
  });
  return size;
}

describe("the native queue's boundaries", { timeout: 40_000 }, () => {
  for (const intent of ["fresh", "resumed"] as const) {
    it(`keeps a build-14 completion its record couldn't write yet when its subscription goes: ${intent} automatic removal`, async () => {
      await install();
      let app = await launch();
      const { a, b } = await withProviders(app, true);
      const film = await app.addDownload(movieRef(a));
      await until(() => isComplete(app, film.id), "the copy");
      // Resumed: the subscription went and its removal was written down in an earlier run.
      if (intent === "resumed") await app.remove(a, { keepHistory: true });
      const size = asBuild14Completion(film, intent === "resumed" ? "source-removed" : undefined);
      const asked = native.requests.length;
      const blocked = new Folder(native.root, "documents", "downloads.json.next");
      blocked.create();
      app = await launch();
      // Its receipt is read and refused by downloads.json, which then takes writes again.
      await sleep(1_000);
      blocked.delete();
      if (intent === "fresh") await app.remove(a, { keepHistory: true });
      else await app.update(b!, { name: "Renamed" });
      await sleep(300);
      expect(mediaFile(film.id)?.size).toBe(size);
      expect(doc().items.map((item: { id: string }) => item.id)).toEqual([film.id]);
      // The next reconcile writes the completion down: it wins the automatic removal.
      appGoes("background");
      appGoes("active");
      await until(() => isComplete(app, film.id), "the copy kept");
      expect(app.downloadList().items.find((item) => item.id === film.id)).toMatchObject({
        subscription: null,
        status: { kind: "complete" },
      });
      expect(doc().items[0].removal).toBeUndefined();
      expect(mediaFile(film.id)?.size).toBe(size);
      expect(native.requests).toHaveLength(asked);
      await until(() => background.legacyReceipts.length === 0, "its receipt acknowledged");
    });
  }

  for (const how of ["user", "demo-reset"] as const) {
    it(`lets an explicit ${how} deletion remove a build-14 copy whose completion is still owed`, async () => {
      await install();
      let app = await launch();
      const { a } = await withProviders(app);
      const film = await app.addDownload(movieRef(a));
      await until(() => isComplete(app, film.id), "the copy");
      asBuild14Completion(film);
      const blocked = new Folder(native.root, "documents", "downloads.json.next");
      blocked.create();
      app = await launch();
      await sleep(1_000);
      blocked.delete();
      if (how === "user") await app.removeDownload(film.id);
      else {
        const erased = await app.eraseDownloads(a, "demo-reset");
        expect(erased).toMatchObject({ removed: 1, kept: 0 });
        await expect(erased.cleanup).resolves.toBe("closed");
      }
      expect(doc().items).toEqual([]);
      expect(folder(film.id).exists).toBe(false);
      // Its receipt later finds no record: acknowledged, nothing comes back.
      appGoes("background");
      appGoes("active");
      await until(() => background.legacyReceipts.length === 0, "its receipt acknowledged");
      expect(app.downloadList().items).toEqual([]);
      expect(folder(film.id).exists).toBe(false);
    });
  }

  it("ends a download whose pause and revoke its record couldn't write yet when its subscription goes", async () => {
    await install();
    const app = await launch();
    const { a, b } = await withProviders(app, true);
    one.stallMovieFile(movie().id, 20_000, 60_000);
    const film = await app.addDownload(movieRef(a));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    const blocked = new Folder(native.root, "documents", "downloads.json.next");
    blocked.create();
    // Paused for a stream of its provider, then ended by its subscription's removal: downloads.json
    // refuses both receipts, and the removal's intent.
    await pausedWithResume(app, a, film);
    await app.remove(a, { keepHistory: true });
    expect(background.receipts.map((each) => each.outcome.kind)).toEqual(["paused", "refresh"]);
    expect(doc().items).toMatchObject([{ id: film.id }]);
    expect(doc().items[0].removal).toBeUndefined();
    const asked = native.requests.length;
    blocked.delete();
    // The next roster change ends it: neither receipt can be its completion.
    await app.update(b!, { name: "Renamed" });
    await until(() => doc().items.length === 0, "the automatic removal");
    await until(() => !folder(film.id).exists, "its folder");
    appGoes("background");
    appGoes("active");
    await until(() => background.receipts.length === 0, "its receipts acknowledged");
    expect(app.downloadList().items).toEqual([]);
    expect(native.requests).toHaveLength(asked);
  });

  it("frees the slot for the next download when a file being published is removed under a Keychain fence", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 20_000, 1_000);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, film.id) === 20_000, "the transfer to stall");
    // Its publication waits on the Keychain while the viewer deletes it and the ledger refuses
    // the removal's write: the removal is fenced by deleting its items.
    background.faults.keychainUnavailable = true;
    await until(() => background.deferred !== null, "the finished file to wait");
    background.faults.ledger = true;
    await app.removeDownload(film.id);
    expect(doc().items.map((item: { id: string }) => item.id)).toEqual([next.id]);
    background.faults = { ...background.faults, ledger: false, keychainUnavailable: false };
    appGoes("background");
    appGoes("active");
    // Complete means every byte the server announced is in place; an earlier case may have
    // replaced this film's file on the shared panel, so its size isn't the fixture's.
    await until(() => isComplete(app, next.id), "the next download");
    expect(folder(film.id).exists).toBe(false);
    expect(one.mostFilesAtOnce()).toBe(1);
  });
});
