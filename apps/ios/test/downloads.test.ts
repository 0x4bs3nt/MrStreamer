import type { Download, DownloadStatus } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Downloads through the app's own owners: the account, its two fake Xtream panels over HTTP (the
// desktop tests' fake provider, one connection each, a closed one freed 300 ms later as its
// default has it), the title lists, the one player and the downloads owner. expo-file-system is
// `native-files.ts`, over real files; the app's native background transfer owner is
// `native-downloads.ts`, a model of its contract over real requests. The player asks for an
// online stream over HTTP, as AVPlayer does, and holds it until it is replaced. The Keychain is
// kept in memory, and a relaunch imports the app's modules again over the same Documents,
// Keychain and native ledger, while the last process's media requests go on, as a background
// session's do. The shared download actions answer through a recorded system sheet. What only
// iOS can show (URLSession's own resume data and timing, a suspended app's wakes, playing the
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
  player: null as null | {
    currentTime: number;
    duration: number;
    emit(event: string, payload: unknown): void;
  },
  appState: "active" as string,
  appListeners: [] as Array<(state: string) => void>,
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo", () => import("./native-downloads.ts"));
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
    const listeners = new Map<string, Array<(payload: unknown) => void>>();
    let stream: AbortController | null = null;
    const player = {
      currentTime: 0,
      duration: 0,
      muted: true,
      addListener: (event: string, listener: (payload: unknown) => void) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      },
      emit: (event: string, payload: unknown) => {
        for (const listener of listeners.get(event) ?? []) listener(payload);
      },
      replaceAsync: async (source: { uri: string } | null) => {
        stream?.abort();
        stream = null;
        if (!source) return;
        const played = {
          uri: source.uri,
          downloading: memory.downloading(),
          status: null as number | null,
        };
        memory.played.push(played);
        if (!source.uri.startsWith("http")) return;
        const controller = new AbortController();
        stream = controller;
        void fetch(source.uri, { signal: controller.signal }).then(
          (response) => {
            played.status = response.status;
            if (response.ok) return;
            void response.body?.cancel();
            player.emit("statusChange", { status: "error", error: { message: "HTTP error" } });
          },
          () => undefined,
        );
      },
      play: () => undefined,
      pause: () => undefined,
    };
    memory.player = player;
    return player;
  },
}));

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
  one.stallMovieFile(movie().id, 0, 0);
  one.stallMovieFile(otherMovie().id, 0, 0);
  memory.appState = "active";
  memory.locked = false;
  native.held = null;
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
  if (background.attempts.size === 0 && background.strays.size === 0) {
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
  await account.restore();
  downloads.startDownloads();
  // `playback` too, whose `retry` another owner's shadows.
  return { ...titles, ...playback, ...viewing, ...downloads, ...account, ...playTitle, playback };
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
const nativeSecrets = () => [...background.secrets.keys()];
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

  it("goes on in the background, and starts the next only once the app is open again", async () => {
    await install();
    const app = await launch();
    const { a } = await withProviders(app);
    one.stallMovieFile(movie().id, 30_000, 1_500);
    const film = await app.addDownload(movieRef(a));
    const next = await app.addDownload(movieRef(a, otherMovie().id));
    await until(() => receivedOf(app, film.id) === 30_000, "the transfer to stall");
    appGoes("background");
    // Neither paused nor asked again: the one request goes on and completes in the background.
    await until(() => isComplete(app, film.id), "the copy, in the background");
    expect(native.requests.map((each) => each.range)).toEqual([null]);
    expect(mediaFile(film.id)?.size).toBe(fixture(movie().fixture!).length);
    await sleep(1_500);
    expect(statusOf(app, next.id)?.kind).toBe("queued");
    expect(native.requests).toHaveLength(1);
    appGoes("active");
    await until(() => isComplete(app, next.id), "the next copy, once open");
    expect(nativeSecrets()).toEqual([]);
    expect(background.receipts).toEqual([]);
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
      () => background.attempts.size === 0 && background.receipts.length === 1,
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
    // An attempt this download never authorized says it completed.
    background.receipts.push({
      receipt: "r-stale",
      attempt: "a-stale",
      id: film.id,
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

  it("fails a stream, asking the provider nothing, while the native side's requests can't be read, and plays once they can", async () => {
    await install();
    let app = await launch();
    await withProviders(app);
    background.unavailable = true;
    app = await launch();
    const { a } = await withProviders(app);
    const asked = one.fileRequests();
    playFilm(app, a, otherMovie().id);
    await until(() => app.playbackState.get().phase.kind === "failed", "the stream to fail");
    expect(memory.played).toEqual([]);
    expect(one.fileRequests()).toBe(asked);
    background.unavailable = false;
    appGoes("background");
    appGoes("active");
    app.playback.retry();
    await until(() => memory.played[0]?.status != null, "the film");
    expect(memory.played[0]).toMatchObject({ downloading: 0, status: 200 });
    app.stop();
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
    // An earlier build paused it, keeping its resume data in its own Keychain item.
    background.die();
    await background.pauseAll();
    const kept = background.secrets.get(film.id)!;
    background.secrets.clear();
    background.receipts.length = 0;
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
      Object.assign(globalThis, {
        expo: {
          modules: {
            TitleFormats: {
              create: () => undefined,
              open: async () => ({ kind: "session", playlist: "file:session.m3u8" }),
              close: () => undefined,
              closed: () => ended,
              failure: () => null,
              trace: () => [],
              addListener: () => ({ remove: () => undefined }),
            },
          },
        },
      });
      const options = { watch: true, login: [] };
      await app.playback.play(
        item(a),
        async () => ({ url: "file:a.mkv", container: "mkv" }),
        options,
      );
      const film = await app.addDownload(movieRef(a));
      expect(statusOf(app, film.id)?.kind).toBe("waiting");
      native.requests.length = 0;
      const playing = app.playback.play(
        item(next),
        async () => ({ url: "file:next.mp4", container: "mp4" }),
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
    expect(background.attempts.size).toBe(0);
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
    memory.player!.emit("playingChange", { isPlaying: true });
    Object.assign(memory.player!, { currentTime: 40, duration: 100 });
    app.stop();
    const copyOf = () => app.downloadList().items.find((item) => item.id === kept.id);
    await until(() => copyOf()?.progress?.position === 40, "the copy's progress");
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
    memory.player!.emit("playingChange", { isPlaying: true });
    const waiting = app.request();
    await app.remove(b!, { keepHistory: true });
    expect(waiting.stands()).toBe(false);
    expect(app.members()).toEqual([]);
    expect(app.playbackState.get()).toMatchObject({
      phase: { kind: "playing", item: { subscriptionId: null } },
      watch: true,
    });
    Object.assign(memory.player!, { currentTime: 70, duration: 100 });
    app.stop();
    await until(
      () => app.downloadList().items.find((item) => item.id === kept.id)?.progress?.position === 70,
      "the copy's progress",
    );
    expect(one.fileRequests()).toBe(requests);
    const copy: Download | undefined = app.downloadList().items[0];
    expect(copy?.subscription).toBeNull();
  });
});
