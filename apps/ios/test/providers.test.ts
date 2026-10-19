import type { Season, TitleRef } from "@mrstreamer/contracts/ondemand";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Several subscriptions, saved and shown together, and the upgrade from private beta 2's one. The
// app's own owners run, with its registry, Keychain index, viewing record, watchlist and state
// files; two of the desktop tests' fake Xtream panels answer over HTTP, the second numbering its
// channels, films and series as the first does. Documents and the Keychain are kept in memory
// across launches, which re-import the app's modules as a relaunch starts them again; the native
// player records what it is given.

const memory = vi.hoisted(() => ({
  files: new Map<string, string>(),
  keychain: new Map<string, string>(),
  /** Keychain items whose write fails. */
  refused: new Set<string>(),
  /** Documents whose write fails. */
  full: new Set<string>(),
  actions: [] as string[],
  /** What the player was given, in order. */
  played: [] as string[],
  /** Login checks held until a test lets them through. */
  held: [] as Array<() => void>,
  holdLogins: false,
  /** Channel lists held until a test lets them through. */
  heldChannels: [] as Array<() => void>,
  holdChannels: false,
  /** Movie lists held until a test lets them through. */
  heldMovies: [] as Array<() => void>,
  holdMovies: false,
  /** Passwords the Keychain has stored but whose write it hasn't answered yet. */
  heldSecrets: [] as Array<() => void>,
  holdSecrets: false,
  /** The Cache-Control header of each request to a panel. */
  caching: [] as Array<string | null>,
}));

vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => ({
    addListener: () => undefined,
    replaceAsync: async (source: { uri: string } | null) => {
      if (source) memory.played.push(source.uri);
    },
    play: () => undefined,
    pause: () => undefined,
  }),
}));
vi.mock("expo-file-system", () => {
  const pathOf = (parent: string | { readonly path: string }, name: string) =>
    `${typeof parent === "string" ? parent : parent.path}/${name}`;
  class Directory {
    readonly path: string;
    constructor(parent: string | Directory, name: string) {
      this.path = pathOf(parent, name);
    }
    get exists() {
      return true;
    }
    create() {}
    list() {
      const within = `${this.path}/`;
      return [...memory.files.keys()]
        .filter((path) => path.startsWith(within) && !path.slice(within.length).includes("/"))
        .map((path) => new File(this, path.slice(within.length)));
    }
  }
  class File {
    path: string;
    constructor(parent: string | Directory, name: string) {
      this.path = pathOf(parent, name);
    }
    get name() {
      return this.path.slice(this.path.lastIndexOf("/") + 1);
    }
    get exists() {
      return memory.files.has(this.path);
    }
    get size() {
      return memory.files.get(this.path)?.length ?? 0;
    }
    get modificationTime() {
      return 0;
    }
    create() {
      if (!this.exists) memory.files.set(this.path, "");
    }
    textSync() {
      const text = memory.files.get(this.path);
      if (text === undefined) throw new Error("No such file");
      return text;
    }
    async text() {
      return this.textSync();
    }
    writeSync(text: string) {
      if ([...memory.full].some((name) => this.path.endsWith(`/${name}.next`))) {
        throw new Error("The disk is full");
      }
      memory.files.set(this.path, text);
    }
    async write(text: string) {
      memory.files.set(this.path, text);
    }
    moveSync(to: File) {
      memory.files.set(to.path, this.textSync());
      memory.files.delete(this.path);
    }
    async move(to: File) {
      this.moveSync(to);
      this.path = to.path;
    }
    delete() {
      memory.files.delete(this.path);
    }
  }
  return { File, Directory, Paths: { document: "/documents", cache: "/cache" } };
});
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => memory.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    if (memory.refused.has(key)) throw new Error("errSecInteractionNotAllowed");
    memory.keychain.set(key, value);
    if (memory.holdSecrets && key.startsWith("s.")) {
      await new Promise<void>((go) => memory.heldSecrets.push(go));
    }
  },
  deleteItemAsync: async (key: string) => {
    memory.keychain.delete(key);
  },
}));
vi.mock("../src/telemetry/index.ts", () => ({
  noteAction: (action: string) => memory.actions.push(action),
}));

const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  memory.caching.push(new Headers(init?.headers).get("Cache-Control"));
  const login = url.pathname.endsWith("/player_api.php") && !url.searchParams.has("action");
  if (login && memory.holdLogins) await new Promise<void>((go) => memory.held.push(go));
  if (url.searchParams.get("action") === "get_live_streams" && memory.holdChannels) {
    await new Promise<void>((go) => memory.heldChannels.push(go));
  }
  if (url.searchParams.get("action") === "get_vod_streams" && memory.holdMovies) {
    await new Promise<void>((go) => memory.heldMovies.push(go));
  }
  return passThrough(input, init);
});

/** What these tests use of the desktop tests' fake panel. */
interface FakeTitles {
  readonly movies: readonly { readonly id: number; readonly container: string }[];
}
interface FakeProvider {
  readonly url: string;
  readonly titles: FakeTitles;
  failCatalogue(status: number | null): void;
  failTitles(status: number | null): void;
  serveTitles(select: <A extends FakeTitles>(all: A) => A): void;
  titleListRequests(): number;
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
    readonly second?: boolean;
  }): Promise<FakeProvider>;
};

let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ username: "one", password: "one+Pw@1", channels: 40, titles: 20 }),
    startFakeProvider({
      username: "two",
      password: "two+Pw@2",
      channels: 40,
      titles: 20,
      second: true,
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

const LEGACY = "xtream-mbeta2";
const doc = (name: string) => `/documents/${name}`;
const settle = () => new Promise((done) => setTimeout(done, 0));

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what = "the condition") {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  vi.resetModules();
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const playback = await import("../src/playback.ts");
  const viewing = await import("../src/viewing.ts");
  const storage = await import("../src/storage.ts");
  await account.restore();
  // The account's names last: its `retry` is a subscription's, not the player's.
  return { ...titles, ...playback, ...viewing, ...storage, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

const ids = (app: App) => app.members().map((member) => member.entry.id);
const member = (app: App, id: string) => app.members().find((each) => each.entry.id === id);
/** Every channel Live lists, once. */
const channels = (app: App) => {
  const now = app.currentCatalogue();
  return now.kind === "ready" ? [...new Set(now.library.byKey.values())] : [];
};
const channelsReady = (app: App, subscriptions: number) =>
  new Set(channels(app).map((channel) => channel.subscriptionId)).size === subscriptions;
const titlesOf = (app: App) => {
  const lists = app.titleLists();
  return lists.kind === "ready" ? kindOf(lists.index, "movie").titles : [];
};
const registry = () => JSON.parse(memory.files.get(doc("subscriptions.json")) ?? "null");
/** What Documents holds; Caches, where lists are saved, aside. */
const documents = () =>
  new Map([...memory.files].filter(([path]) => path.startsWith("/documents/")));
const savedLists = () =>
  [...memory.files.keys()].filter((path) => path.startsWith("/cache/catalogues/"));

/** Deletes the lists saved on the phone once those of `ids` are, so a launch asks the providers. */
async function forgetSavedLists(...ids: string[]) {
  const names = ids.flatMap((id) => [`${id}.live.json`, `${id}.titles.json`]);
  await until(
    () => names.every((name) => memory.files.has(`/cache/catalogues/${name}`)),
    "the saved lists",
  );
  for (const path of savedLists()) memory.files.delete(path);
}
const keychainIds = () => JSON.parse(memory.keychain.get("index") ?? "[]");
const playingNow = (app: App) => {
  const { phase } = app.playbackState.get();
  return phase.kind === "idle" ? null : phase.item;
};

/** Plays one of `subscriptionId`'s channels in Watch, by its provider's id. */
function watchChannel(app: App, subscriptionId: string, id: string) {
  const channel = channels(app).find(
    (each) => each.subscriptionId === subscriptionId && each.id === id,
  );
  if (!channel) throw new Error(`No channel ${id} from ${subscriptionId}`);
  app.playChannel(channel, "", { watch: true });
  return channel;
}

/** Private beta 2's files and Keychain, as it left them with one subscription on `panel`. */
async function beta2(panel: FakeProvider, movie: TitleRef) {
  memory.files.set(
    doc("state.json"),
    JSON.stringify({
      subscription: { id: LEGACY, server: panel.url, username: "one" },
      recent: ["3", "1"],
      region: "TEST",
    }),
  );
  memory.keychain.set("index", JSON.stringify([LEGACY]));
  memory.keychain.set(`s.${LEGACY}`, "one+Pw@1");
  memory.files.set(
    doc("watchlist.json"),
    JSON.stringify({
      version: 1,
      subscriptionId: LEGACY,
      entries: [
        {
          kind: "movie",
          tmdbId: null,
          versionIds: [movie.id],
          name: "Saved in beta 2",
          year: null,
          adult: false,
          id: "beta2-1",
          savedAt: 1_700_000_000_000,
          sequence: 1,
        },
      ],
    }),
  );
  // Beta 2's viewing.json is core's viewing snapshot of its one account, keyed by its id: the
  // record writes it as beta 2 did, before the app starts.
  vi.resetModules();
  const viewing = await import("../src/viewing.ts");
  viewing.setViewingOwners([LEGACY]);
  await viewing.recordProgress(movie, 120, 600, Date.now());
}

const firstMovie = (panel: FakeProvider, subscriptionId: string): TitleRef => {
  const [movie] = panel.titles.movies;
  if (!movie) throw new Error("The panel lists no movies");
  return { kind: "movie", subscriptionId, id: String(movie.id) };
};

beforeEach(() => {
  memory.files.clear();
  memory.keychain.clear();
  memory.refused.clear();
  memory.full.clear();
  memory.actions.length = 0;
  memory.played.length = 0;
  memory.holdLogins = false;
  memory.held.length = 0;
  memory.holdChannels = false;
  memory.heldChannels.length = 0;
  memory.holdMovies = false;
  memory.heldMovies.length = 0;
  memory.holdSecrets = false;
  memory.caching.length = 0;
  for (const panel of [one, two]) {
    panel.failCatalogue(null);
    panel.failTitles(null);
    panel.serveTitles((all) => all);
  }
});
afterEach(() => {
  for (const go of memory.held.splice(0)) go();
  for (const go of memory.heldChannels.splice(0)) go();
  for (const go of memory.heldMovies.splice(0)) go();
  // A write still held belongs to an app that stopped: it never answers.
  memory.heldSecrets.length = 0;
  vi.useRealTimers();
});

describe("the first launch since private beta 2", () => {
  it("keeps its subscription's id, password, progress, watchlist, recent channels and region", async () => {
    const movie = firstMovie(one, LEGACY);
    await beta2(one, movie);
    const before = new Map(memory.files);
    const app = await launch();

    expect(ids(app)).toEqual([LEGACY]);
    expect(registry()).toEqual({
      version: 1,
      subscriptions: [{ id: LEGACY, kind: "xtream", server: one.url, username: "one", name: null }],
      retired: [],
      pendingSecrets: [],
      erasing: [],
    });
    expect(keychainIds()).toEqual([LEGACY]);
    expect(memory.keychain.get(`s.${LEGACY}`)).toBe("one+Pw@1");
    // Beta 2's files stay as they were, for an older build; state.json gains the owned channels.
    for (const name of ["watchlist.json", "viewing.json"]) {
      expect(memory.files.get(doc(name))).toBe(before.get(doc(name)));
    }
    const state = JSON.parse(memory.files.get(doc("state.json")) ?? "{}");
    expect(state).toEqual({
      subscription: { id: LEGACY, server: one.url, username: "one" },
      recent: ["3", "1"],
      recentChannels: [`${LEGACY}:3`, `${LEGACY}:1`],
      region: "TEST",
    });

    await until(() => titlesOf(app).length > 0, "the movie lists");
    const progress = await app.progressOf({ movies: [movie] });
    expect(progress.map((each) => [each.title.id, each.position])).toEqual([[movie.id, 120]]);
    const saved = (await import("../src/watchlist.ts")).currentWatchlist();
    expect(
      saved.map((entry) => entry.map(({ subscriptionId, id }) => [subscriptionId, id])),
    ).toEqual([[[LEGACY, "beta2-1"]]]);
  });

  it("migrates once: a relaunch finds the registry and changes nothing", async () => {
    await beta2(one, firstMovie(one, LEGACY));
    await launch();
    const after = documents();
    const keychain = new Map(memory.keychain);
    const again = await launch();
    expect(ids(again)).toEqual([LEGACY]);
    expect(documents()).toEqual(after);
    expect(new Map(memory.keychain)).toEqual(keychain);
  });

  it("asks for a password the Keychain lost, and keeps the subscription", async () => {
    await beta2(one, firstMovie(one, LEGACY));
    memory.keychain.delete(`s.${LEGACY}`);
    const app = await launch();
    expect(ids(app)).toEqual([LEGACY]);
    expect(member(app, LEGACY)?.needsSecret).toBe(true);
    // Movies and Series say so too, rather than loading for ever.
    expect(app.titleLists()).toMatchObject({ kind: "failed", error: { kind: "needs-secret" } });
  });
});

const ONE = { username: "one", password: "one+Pw@1" };
const TWO = { username: "two", password: "two+Pw@2" };

/** A launch with the first panel saved, then the second added; both lists loaded. */
async function twoProviders() {
  const app = await launch();
  const a = await app.add({ server: one.url, ...ONE });
  const b = await app.add({ server: two.url, ...TWO, name: "Holiday house" });
  if (!a || !b) throw new Error("An add was cancelled");
  await until(() => channelsReady(app, 2), "both channel lists");
  await until(
    () => new Set(titlesOf(app).flatMap((t) => t.versions.map((v) => v.subscriptionId))).size === 2,
    "both title lists",
  );
  return { app, a, b };
}

describe("adding a subscription", () => {
  it("checks the login before saving anything, and saves nothing when the provider refuses", async () => {
    const app = await launch();
    await expect(
      app.add({ server: two.url, username: "two", password: "wrong" }),
    ).rejects.toThrow();
    expect(memory.files.has(doc("subscriptions.json"))).toBe(true);
    expect(registry().subscriptions).toEqual([]);
    expect(registry().pendingSecrets).toEqual([]);
    expect(keychainIds()).toEqual([]);
    expect(ids(app)).toEqual([]);
    expect(memory.actions).not.toContain("playlist_added");
  });

  it("keeps the first's lists and adds the second's beside them", async () => {
    const { app, a, b } = await twoProviders();
    expect(ids(app)).toEqual([a, b]);
    expect(keychainIds()).toEqual([a, b]);
    expect(registry().subscriptions.map((each: { name: string | null }) => each.name)).toEqual([
      null,
      "Holiday house",
    ]);
    // An older build still shows the first.
    expect(JSON.parse(memory.files.get(doc("state.json")) ?? "{}").subscription.id).toBe(a);
    expect(memory.actions.filter((each) => each === "playlist_added")).toHaveLength(2);
    expect(memory.actions).toContain("playlist_refreshed");
  });

  it("updates the account saved when the same one is added again", async () => {
    const { app, a, b } = await twoProviders();
    const added = memory.actions.length;
    const again = await app.add({ server: two.url, ...TWO, name: "Cabin" });
    expect(again).toBe(b);
    expect(ids(app)).toEqual([a, b]);
    expect(member(app, b)?.label).toBe("Cabin");
    expect(memory.actions.slice(added)).not.toContain("playlist_added");
  });

  it("writes nothing for an add cancelled while its login is checked", async () => {
    const app = await launch();
    memory.holdLogins = true;
    const cancel = new AbortController();
    const adding = app.add({ server: one.url, ...ONE }, cancel.signal);
    await until(() => memory.held.length === 1, "the login check");
    cancel.abort();
    for (const go of memory.held.splice(0)) go();
    await adding.catch(() => null);
    expect(registry().subscriptions).toEqual([]);
    expect(keychainIds()).toEqual([]);
  });

  it("leaves no password behind when the Keychain refuses it", async () => {
    const app = await launch();
    memory.refused.add("s.xtream-" + Date.now().toString(36).slice(0, 3));
    memory.refused.add("index");
    await expect(app.add({ server: one.url, ...ONE })).rejects.toMatchObject({
      error: { kind: "keychain-refused" },
    });
    memory.refused.clear();
    expect(registry().subscriptions).toEqual([]);
    const again = await launch();
    expect(ids(again)).toEqual([]);
    expect(registry().pendingSecrets).toEqual([]);
  });

  it("removes at the next launch a password an add wrote before the app stopped", async () => {
    const app = await launch();
    memory.keychain.set("s.download-key", "not a provider's");
    memory.holdSecrets = true;
    void app.add({ server: one.url, ...ONE });
    // The password is in the Keychain and the registry doesn't list it yet: the app stops here.
    await until(() => memory.heldSecrets.length === 1, "the password's write");
    expect([...memory.keychain.keys()].filter((key) => key.startsWith("s.xtream"))).toHaveLength(1);
    memory.holdSecrets = false;
    const again = await launch();
    expect(ids(again)).toEqual([]);
    expect([...memory.keychain.keys()].filter((key) => key.startsWith("s.xtream"))).toEqual([]);
    expect(keychainIds()).toEqual([]);
    expect(memory.keychain.get("s.download-key")).toBe("not a provider's");
  });

  it("saves nothing for an add left while its password is written, keeping the others", async () => {
    const { app, a, b } = await twoProviders();
    const movie = titlesOf(app)
      .flatMap((title) => title.versions)
      .find((v) => v.subscriptionId === b);
    if (!movie) throw new Error("No film of the second");
    await app.recordProgress({ kind: "movie", ...movie }, 200, 600, Date.now());
    await app.remove(b, { keepHistory: true });
    memory.holdSecrets = true;
    const leaving = new AbortController();
    const adding = app.add({ server: two.url, ...TWO }, leaving.signal);
    await until(() => memory.heldSecrets.length === 1, "the password's write");
    leaving.abort();
    for (const go of memory.heldSecrets.splice(0)) go();
    expect(await adding).toBeNull();
    expect(ids(app)).toEqual([a]);
    expect(keychainIds()).toEqual([a]);
    expect(memory.keychain.has(`s.${b}`)).toBe(false);
    expect(registry().subscriptions.map((each: { id: string }) => each.id)).toEqual([a]);
    expect(registry().retired.map((each: { id: string }) => each.id)).toEqual([b]);
    expect(registry().pendingSecrets).toEqual([]);
    expect(member(app, a)?.live.kind).toBe("ready");
    // Added later, it still takes its id and history back.
    memory.holdSecrets = false;
    expect(await app.add({ server: two.url, ...TWO })).toBe(b);
    const progress = await app.progressOf({ movies: [{ subscriptionId: b, id: movie.id }] });
    expect(progress.map((each) => each.position)).toEqual([200]);
  });

  it("shows a first subscription saved, though older builds' copy of it couldn't be written", async () => {
    const app = await launch();
    memory.full.add("state.json");
    const a = await app.add({ server: one.url, ...ONE });
    expect(a).not.toBeNull();
    expect(ids(app)).toEqual([a]);
    await until(() => channelsReady(app, 1), "its channels");
    memory.full.clear();
    expect(await app.add({ server: one.url, ...ONE })).toBe(a);
    expect(ids(app)).toEqual([a]);
  });
});

describe("editing a subscription", () => {
  it("changes nothing when the viewer leaves while the new password is checked", async () => {
    const { app, b } = await twoProviders();
    memory.holdLogins = true;
    const leaving = new AbortController();
    const editing = app.update(b, { name: "Cabin", password: TWO.password }, leaving.signal);
    await until(() => memory.held.length === 1, "the login check");
    leaving.abort();
    for (const go of memory.held.splice(0)) go();
    await editing.catch(() => undefined);
    expect(member(app, b)?.label).toBe("Holiday house");
  });

  it("finishes the change once the new password is being written", async () => {
    const { app, b } = await twoProviders();
    memory.holdSecrets = true;
    const leaving = new AbortController();
    const editing = app.update(b, { name: "Cabin", password: TWO.password }, leaving.signal);
    await until(() => memory.heldSecrets.length === 1, "the password's write");
    leaving.abort();
    for (const go of memory.heldSecrets.splice(0)) go();
    await editing;
    expect(member(app, b)?.label).toBe("Cabin");
    expect(registry().subscriptions.map((each: { name: string | null }) => each.name)).toEqual([
      null,
      "Cabin",
    ]);
    await until(() => member(app, b)?.live.kind === "ready", "its channels again");
  });
});

describe("everything together", () => {
  it("keeps every request out of the URL cache, whose entries would hold the login", async () => {
    await twoProviders();
    expect(memory.caching.length).toBeGreaterThan(0);
    expect(memory.caching.every((each) => each === "no-store")).toBe(true);
  });

  it("lists both providers' channels, each playing from its own provider though their ids match", async () => {
    const { app, a, b } = await twoProviders();
    const fromOne = channels(app).filter((each) => each.subscriptionId === a);
    const fromTwo = channels(app).filter((each) => each.subscriptionId === b);
    expect(fromOne.length).toBeGreaterThan(0);
    expect(fromTwo.map((each) => each.id)).toEqual(fromOne.map((each) => each.id));
    // The same channel from two providers is two rows, each named for its subscription.
    expect(fromTwo.every((each) => each.ambiguous)).toBe(true);
    const [first] = fromOne;
    if (!first) throw new Error("No channel");
    const now = app.currentCatalogue();
    if (now.kind !== "ready") throw new Error("No library");
    expect(now.library.placeOf.get(`${b}:${first.id}`)).toMatch(/· Holiday house$/);

    watchChannel(app, b, first.id);
    await until(() => memory.played.length === 1, "the stream");
    expect(memory.played[0]).toContain(two.url);
    expect(memory.played[0]).toContain(`/live/two/`);
    expect(playingNow(app)).toMatchObject({ id: `${b}:${first.id}`, subscriptionId: b });
  });

  it("joins a film both list by TMDB id, its progress kept for each provider's file", async () => {
    const { app, a, b } = await twoProviders();
    const merged = titlesOf(app).find(
      (title) => new Set(title.versions.map((v) => v.subscriptionId)).size === 2,
    );
    if (!merged) throw new Error("No film both providers list");
    const ofOne = merged.versions.find((v) => v.subscriptionId === a);
    const ofTwo = merged.versions.find((v) => v.subscriptionId === b);
    if (!ofOne || !ofTwo) throw new Error("A version is missing");
    await app.recordProgress({ kind: "movie", ...ofTwo }, 300, 600, Date.now());
    await app.recordProgress({ kind: "movie", ...ofOne }, 60, 600, Date.now());
    const progress = await app.progressOf({
      movies: [
        { subscriptionId: a, id: ofOne.id },
        { subscriptionId: b, id: ofTwo.id },
      ],
    });
    expect(progress.map((each) => [each.title.subscriptionId, each.position]).toSorted()).toEqual(
      [
        [a, 60],
        [b, 300],
      ].toSorted(),
    );
  });

  it("keeps one provider's lists and stream when the other's fail, and retries only that one", async () => {
    const { app, a, b } = await twoProviders();
    const [first] = channels(app).filter((each) => each.subscriptionId === a);
    if (!first) throw new Error("No channel");
    watchChannel(app, a, first.id);
    const asked = one.titleListRequests();
    two.failCatalogue(503);
    app.reloadChannels(b);
    await until(() => member(app, b)?.live.kind === "failed", "the failure");
    expect(channelsReady(app, 2)).toBe(true);
    const now = app.currentCatalogue();
    expect(now.kind === "ready" && now.failing.map((each) => each.entry.id)).toEqual([b]);
    expect(member(app, a)?.live.kind).toBe("ready");
    expect(playingNow(app)?.subscriptionId).toBe(a);

    two.failCatalogue(null);
    app.retry(b);
    await until(() => member(app, b)?.live.kind === "ready", "the retry");
    expect(one.titleListRequests()).toBe(asked);
    expect(playingNow(app)?.subscriptionId).toBe(a);
  });

  it("plays a film from the file its own provider lists, when both list it under one id", async () => {
    one.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) => ({ ...movie, container: "mkv" })),
    }));
    two.serveTitles((all) => ({
      ...all,
      movies: all.movies.map((movie) => ({ ...movie, container: "mp4" })),
    }));
    const { app, a, b } = await twoProviders();
    const shared = titlesOf(app).find((title) =>
      title.versions.some(
        (v) =>
          v.subscriptionId === a &&
          title.versions.some((w) => w.subscriptionId === b && w.id === v.id),
      ),
    );
    if (!shared) throw new Error("No film both list under one id");
    const id = shared.versions[0]!.id;
    const fileOf = (subscriptionId: string) =>
      app.titleFile({ kind: "movie", subscriptionId, id }, new AbortController().signal);
    expect((await fileOf(a)).url).toMatch(new RegExp(`/movie/one/.+/${id}\\.mkv$`));
    expect((await fileOf(b)).url).toMatch(new RegExp(`/movie/two/.+/${id}\\.mp4$`));
  });

  it("tells Movies and Series why no list loaded, and loads them on Try again", async () => {
    one.failTitles(503);
    const app = await launch();
    const a = await app.add({ server: one.url, ...ONE });
    if (!a) throw new Error("The add was cancelled");
    await until(() => member(app, a)?.titles.kind === "failed", "the failure");
    expect(app.titleLists().kind).toBe("failed");
    one.failTitles(null);
    app.retryTitles();
    await until(() => app.titleLists().kind === "ready", "the lists");
  });

  it("reads a season as a provider added again lists it, not as it was before", async () => {
    const { app, b } = await twoProviders();
    const lists = app.titleLists();
    if (lists.kind !== "ready") throw new Error("No lists");
    const series = kindOf(lists.index, "series").titles.find((title) =>
      title.versions.some((v) => v.subscriptionId === b),
    );
    const version = series?.versions.find((v) => v.subscriptionId === b);
    if (!series || !version) throw new Error("No series of the second");
    const title = { ...series, ...version };
    const seasonOf = (id: string): Season => ({
      number: 1,
      name: "Season 1",
      posterUrl: null,
      episodes: [
        {
          subscriptionId: b,
          seriesId: version.id,
          id,
          season: 1,
          number: 1,
          title: "Pilot",
          plot: null,
          duration: null,
          stillUrl: null,
          airDate: null,
        },
      ],
    });
    expect((await app.episodesOf(title, seasonOf("old-file"))).map((each) => each.id)).toEqual([
      "old-file",
    ]);
    await app.remove(b, { keepHistory: true });
    expect(await app.add({ server: two.url, ...TWO })).toBe(b);
    expect((await app.episodesOf(title, seasonOf("new-file"))).map((each) => each.id)).toEqual([
      "new-file",
    ]);
  });

  it("names a renamed subscription where its channels show, at once", async () => {
    const { app, a, b } = await twoProviders();
    const [first] = channels(app).filter((each) => each.subscriptionId === a);
    if (!first) throw new Error("No channel");
    await app.update(b, { name: "Cabin" });
    const now = app.currentCatalogue();
    if (now.kind !== "ready") throw new Error("No library");
    expect(now.library.placeOf.get(`${b}:${first.id}`)).toMatch(/· Cabin$/);
  });

  it("shows a subscription's channels while a new password signs it in, then the new list", async () => {
    const { app, b } = await twoProviders();
    const before = app.currentCatalogue();
    const editing = app.update(b, { password: TWO.password });
    await until(() => {
      expect(channelsReady(app, 2)).toBe(true);
      const now = app.currentCatalogue();
      return now.kind === "ready" && before.kind === "ready" && now.library !== before.library;
    }, "the new list");
    await editing;
    expect(member(app, b)?.live.kind).toBe("ready");
    expect(channelsReady(app, 2)).toBe(true);
  });

  it("counts a change of channel, not the first one or the same one again", async () => {
    const { app, a, b } = await twoProviders();
    const [first, second] = channels(app).filter((each) => each.subscriptionId === a);
    if (!first || !second) throw new Error("Too few channels");
    memory.actions.length = 0;
    watchChannel(app, a, first.id);
    watchChannel(app, a, first.id);
    watchChannel(app, b, first.id);
    watchChannel(app, b, second.id);
    expect(memory.actions).toEqual(["channel_changed", "channel_changed"]);
  });
});

describe("removing a subscription", () => {
  it("stops what plays from it, and only that", async () => {
    const { app, a, b } = await twoProviders();
    const [first] = channels(app).filter((each) => each.subscriptionId === a);
    if (!first) throw new Error("No channel");
    watchChannel(app, a, first.id);
    await app.remove(b, { keepHistory: true });
    expect(playingNow(app)?.subscriptionId).toBe(a);
    expect(channelsReady(app, 1)).toBe(true);
    expect(keychainIds()).toEqual([a]);
    expect(memory.actions).toContain("playlist_removed");

    watchChannel(app, a, first.id);
    await app.remove(a, { keepHistory: true });
    expect(playingNow(app)).toBeNull();
    // The last one gone: Connect.
    expect(ids(app)).toEqual([]);
    expect(JSON.parse(memory.files.get(doc("state.json")) ?? "{}").subscription).toBeNull();
  });

  it("never shows the channels of one removed while they are worked out", async () => {
    const app = await launch();
    const a = await app.add({ server: one.url, ...ONE });
    if (!a) throw new Error("The add was cancelled");
    await until(() => channelsReady(app, 1), "the first's channels");
    memory.holdChannels = true;
    const b = await app.add({ server: two.url, ...TWO });
    if (!b) throw new Error("The add was cancelled");
    let removing: Promise<void> | null = null;
    // Removed as its channels land, before a task has worked them out.
    const off = app.onRoster(() => {
      if (!removing && member(app, b)?.live.kind === "ready") {
        removing = app.remove(b, { keepHistory: true });
      }
    });
    await until(() => memory.heldChannels.length === 1, "the second's channel list");
    memory.heldChannels.shift()?.();
    await until(() => removing !== null, "the second's channels");
    off();
    await removing;
    await new Promise((done) => setTimeout(done, 100));
    expect(ids(app)).toEqual([a]);
    expect(app.currentCatalogue().kind).toBe("ready");
    expect(channels(app).every((each) => each.subscriptionId === a)).toBe(true);
    expect(channels(app).length).toBeGreaterThan(0);
  });

  it("never shows the movies of one removed while they are read or indexed, keeping the other's", async () => {
    for (const when of ["read", "indexed"] as const) {
      const app = await launch();
      const a = await app.add({ server: one.url, ...ONE });
      if (!a) throw new Error("The add was cancelled");
      await until(() => titlesOf(app).length > 0, "the first's lists");
      const before = app.titleLists();
      const shownFrom = new Set<string>();
      const offLists = app.onTitleLists(() => {
        for (const title of titlesOf(app)) {
          for (const version of title.versions) shownFrom.add(version.subscriptionId);
        }
      });
      memory.holdMovies = true;
      const b = await app.add({ server: two.url, ...TWO });
      if (!b) throw new Error("The add was cancelled");
      await until(() => memory.heldMovies.length === 1, "the second's movie list");
      let removing: Promise<void> | null = null;
      // Removed as its rows are read, or as its lists land, before a task has indexed them.
      const off = app.onRoster(() => {
        if (!removing && when === "indexed" && member(app, b)?.titles.kind === "ready") {
          removing = app.remove(b, { keepHistory: true });
        }
      });
      memory.heldMovies.shift()?.();
      if (when === "read") removing = app.remove(b, { keepHistory: true });
      await until(() => removing !== null, "the second's lists");
      off();
      await removing;
      await new Promise((done) => setTimeout(done, 100));
      offLists();
      expect(ids(app)).toEqual([a]);
      expect(shownFrom.has(b)).toBe(false);
      if (when === "read") expect(app.titleLists()).toBe(before);
      expect(titlesOf(app).length).toBeGreaterThan(0);
      expect(
        titlesOf(app).every((title) => title.versions.every((v) => v.subscriptionId === a)),
      ).toBe(true);
      await app.remove(a, { keepHistory: true });
      memory.holdMovies = false;
    }
  });

  it("brings its history back when the account is added again", async () => {
    const { app, b } = await twoProviders();
    const movie = titlesOf(app)
      .flatMap((title) => title.versions)
      .find((v) => v.subscriptionId === b);
    if (!movie) throw new Error("No film of the second");
    await app.recordProgress({ kind: "movie", ...movie }, 200, 600, Date.now());
    await app.remove(b, { keepHistory: true });
    expect(registry().retired.map((each: { id: string }) => each.id)).toEqual([b]);
    expect(await app.add({ server: two.url, ...TWO })).toBe(b);
    expect(registry().retired).toEqual([]);
    const progress = await app.progressOf({ movies: [{ subscriptionId: b, id: movie.id }] });
    expect(progress.map((each) => each.position)).toEqual([200]);
  });

  it("keeps the version picked with its history, plays it once added again, and erases it with it", async () => {
    const { app, a, b } = await twoProviders();
    const both = (title: { versions: readonly { subscriptionId: string }[] }) =>
      new Set(title.versions.map((v) => v.subscriptionId)).size === 2;
    const shared = titlesOf(app).find((title) => title.tmdbId && both(title));
    const own = titlesOf(app).find(
      (title) => title.tmdbId && title.versions.every((v) => v.subscriptionId === a),
    );
    const picked = shared?.versions.find((v) => v.subscriptionId === b);
    if (!shared || !own || !picked) throw new Error("The lists lack a shared or own film");
    const now = (title: typeof shared) => {
      const found = titlesOf(app).find((each) => each.tmdbId === title.tmdbId);
      if (!found) throw new Error("The film isn't listed");
      return found;
    };
    const stateOf = () => JSON.parse(memory.files.get(doc("state.json")) ?? "{}");
    app.pickVersion(shared, { subscriptionId: b, id: picked.id });
    app.pickVersion(own, own.versions[0]!);
    // Another write of state.json keeps the picks, and they keep it.
    const [channel] = channels(app).filter((each) => each.subscriptionId === a);
    if (!channel) throw new Error("No channel");
    watchChannel(app, a, channel.id);
    expect(stateOf().recentChannels).toContain(channel.key);
    expect(app.pickedVersion(now(shared), app.readState())).toEqual({
      subscriptionId: b,
      id: picked.id,
    });
    expect(stateOf().titleVersions[b]).toBeDefined();

    await app.remove(b, { keepHistory: true });
    await until(() => !both(now(shared)), "the film from the first alone");
    expect(app.pickedVersion(now(shared), app.readState())).toBeNull();
    expect(stateOf().titleVersions[b]).toBeDefined();
    expect(await app.add({ server: two.url, ...TWO })).toBe(b);
    await until(() => both(now(shared)), "the film from both again");
    expect(app.pickedVersion(now(shared), app.readState())).toEqual({
      subscriptionId: b,
      id: picked.id,
    });

    const again = await launch();
    await until(
      () => both(titlesOf(again).find((each) => each.tmdbId === shared.tmdbId) ?? { versions: [] }),
      "the film after a relaunch",
    );
    const relaunched = titlesOf(again).find((each) => each.tmdbId === shared.tmdbId)!;
    expect(again.pickedVersion(relaunched, again.readState())).toEqual({
      subscriptionId: b,
      id: picked.id,
    });

    for (const password of [ONE.password, TWO.password]) {
      expect(memory.files.get(doc("state.json"))).not.toContain(password);
    }
    await again.remove(b, { keepHistory: false });
    expect(stateOf().titleVersions[b]).toBeUndefined();
    expect(stateOf().titleVersions[a]).toEqual({ [`movie:${own.tmdbId}`]: own.versions[0]!.id });
    expect(stateOf().recentChannels).toContain(channel.key);
  });

  it("erases its history when asked, leaving a film the other saved too on the watchlist", async () => {
    const { app, a, b } = await twoProviders();
    const watchlist = await import("../src/watchlist.ts");
    const shared = titlesOf(app).find(
      (title) => new Set(title.versions.map((v) => v.subscriptionId)).size === 2,
    );
    const own = titlesOf(app).find((title) => title.versions.every((v) => v.subscriptionId === b));
    if (!shared || !own) throw new Error("The lists lack a shared or own film");
    watchlist.saveTitle(shared);
    watchlist.saveTitle(own);
    expect(watchlist.currentWatchlist()).toHaveLength(2);
    const version = own.versions[0]!;
    await app.recordProgress({ kind: "movie", ...version }, 200, 600, Date.now());

    await app.remove(b, { keepHistory: false });
    expect(registry().retired).toEqual([]);
    expect(await app.progressOf({ movies: [version] })).toEqual([]);
    expect(
      watchlist.currentWatchlist().map((entry) => entry.map((each) => each.subscriptionId)),
    ).toEqual([[a]]);
    // Added again, it starts afresh.
    expect(await app.add({ server: two.url, ...TWO })).not.toBe(b);
  });

  it("deletes a history it couldn't delete at the next launch", async () => {
    const { app, a, b } = await twoProviders();
    const watchlist = await import("../src/watchlist.ts");
    const own = titlesOf(app).find((title) => title.versions.every((v) => v.subscriptionId === b));
    if (!own) throw new Error("No film of the second's own");
    watchlist.saveTitle(own);
    const version = own.versions[0]!;
    await app.recordProgress({ kind: "movie", ...version }, 200, 600, Date.now());
    const [channel] = channels(app).filter((each) => each.subscriptionId === b);
    if (!channel) throw new Error("No channel");
    watchChannel(app, b, channel.id);
    const recentOf = () =>
      (JSON.parse(memory.files.get(doc("state.json")) ?? "{}").recentChannels ?? []) as string[];
    expect(recentOf()).toContain(channel.key);

    memory.full.add("state.json");
    memory.full.add("viewing.json");
    await expect(app.remove(b, { keepHistory: false })).rejects.toThrow();
    expect(ids(app)).toEqual([a]);
    memory.full.clear();

    const again = await launch();
    expect(ids(again)).toEqual([a]);
    expect(memory.files.get(doc("viewing.json"))).not.toContain(b);
    expect(memory.files.get(doc("watchlists.json"))).not.toContain(b);
    expect(recentOf().filter((key) => key.startsWith(`${b}:`))).toEqual([]);
    // Done: a later launch has nothing left to delete, and changes nothing.
    const after = documents();
    await launch();
    expect(documents()).toEqual(after);
  });

  it("never deletes, for a history still to go, an account added since under the same id", async () => {
    const { app, b } = await twoProviders();
    memory.full.add("viewing.json");
    await expect(app.remove(b, { keepHistory: false })).rejects.toThrow();
    memory.full.clear();
    // The clock as when the removed one was added, which its id was made from.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Number.parseInt(b.slice("xtream-".length), 36));
    const readded = await app.add({ server: two.url, ...TWO });
    vi.useRealTimers();
    if (!readded) throw new Error("The add was cancelled");
    expect(readded).not.toBe(b);
    await until(() =>
      titlesOf(app).some((t) => t.versions.some((v) => v.subscriptionId === readded)),
    );
    const version = titlesOf(app)
      .flatMap((title) => title.versions)
      .find((v) => v.subscriptionId === readded)!;
    await app.recordProgress({ kind: "movie", ...version }, 90, 600, Date.now());
    const again = await launch();
    const progress = await again.progressOf({ movies: [version] });
    expect(progress.map((each) => each.position)).toEqual([90]);
  });

  it("stands when it keeps the history, though older builds' copy couldn't be written", async () => {
    const { app, a, b } = await twoProviders();
    memory.full.add("state.json");
    await app.remove(b, { keepHistory: true });
    expect(ids(app)).toEqual([a]);
  });

  it("keeps the subscription saved when the registry refuses its removal", async () => {
    const { app, a, b } = await twoProviders();
    const before = memory.files.get(doc("subscriptions.json"));
    memory.full.add("subscriptions.json");
    await expect(app.remove(b, { keepHistory: false })).rejects.toThrow();
    expect(ids(app)).toEqual([a, b]);
    memory.full.clear();
    expect(memory.files.get(doc("subscriptions.json"))).toBe(before);
    expect(memory.keychain.has(`s.${b}`)).toBe(true);
    expect(ids(await launch())).toEqual([a, b]);
  });

  it("drops a remove's password at the next launch when the Keychain kept it", async () => {
    const { app, b } = await twoProviders();
    const removing = app.remove(b, { keepHistory: true });
    // The registry commit happens before the Keychain removal; stop the app in between.
    await removing;
    memory.keychain.set(`s.${b}`, "left behind");
    const pending = registry();
    memory.files.set(
      doc("subscriptions.json"),
      JSON.stringify({ ...pending, pendingSecrets: [b] }),
    );
    const again = await launch();
    expect(ids(again)).not.toContain(b);
    expect(memory.keychain.has(`s.${b}`)).toBe(false);
    expect(registry().pendingSecrets).toEqual([]);
  });

  it("plays no resume still waiting for a subscription removed meanwhile", async () => {
    const { app, a } = await twoProviders();
    const asked = app.request();
    await app.remove(a, { keepHistory: true });
    expect(asked.stands()).toBe(false);
  });

  it("serialises an add and a removal begun together", async () => {
    const { app, a, b } = await twoProviders();
    await app.remove(b, { keepHistory: true });
    const [readded] = await Promise.all([
      app.add({ server: two.url, ...TWO }),
      app.remove(a, { keepHistory: true }),
    ]);
    expect(readded).toBe(b);
    expect(ids(app)).toEqual([b]);
    expect(keychainIds()).toEqual([b]);
    expect(registry().retired.map((each: { id: string }) => each.id)).toEqual([a]);
  });
});

describe("a launch with saved subscriptions", () => {
  it("checks each login before its movie and series lists, and loads channels at once", async () => {
    const { a, b } = await twoProviders();
    await forgetSavedLists(a, b);
    memory.holdLogins = true;
    const before = [one.titleListRequests(), two.titleListRequests()];
    const app = await launch();
    await until(() => channelsReady(app, 2), "channels");
    await until(() => memory.held.length === 2, "both login checks");
    expect([one.titleListRequests(), two.titleListRequests()]).toEqual(before);
    memory.held.shift()?.();
    memory.held.shift()?.();
    await until(() => one.titleListRequests() > before[0]! && two.titleListRequests() > before[1]!);
  });

  it("starts no lists for a subscription removed while its login was checked", async () => {
    const { a, b } = await twoProviders();
    await forgetSavedLists(a, b);
    memory.holdLogins = true;
    const app = await launch();
    await until(() => memory.held.length === 2, "both login checks");
    const before = two.titleListRequests();
    await app.remove(b, { keepHistory: true });
    for (const go of memory.held.splice(0)) go();
    await settle();
    await new Promise((done) => setTimeout(done, 200));
    expect(two.titleListRequests()).toBe(before);
  });
});
