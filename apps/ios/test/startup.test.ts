import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// When the app opens after a launch (startup.ts): as soon as the lists the phone saved show, the
// channels and the movie and series collections worked out of them, while the logins are checked
// and the providers asked; at once with nothing saved to show; never waiting on a provider, a
// removed subscription or a read the disk doesn't answer. Two of the desktop tests' fake Xtream
// panels answer over HTTP, over real files (`native-files.ts`), as saved-lists.test.ts runs them.
// A login check or list request can be held until a test lets it through.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** Each request to a panel: its `action`, or "login" for the login check. */
  requests: [] as string[],
  /** Requests held until a test lets them through. */
  held: [] as Array<() => void>,
  holdLogins: false,
  holdLists: false,
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
  setItemAsync: async (key: string, value: string) => {
    memory.keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    memory.keychain.delete(key);
  },
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

const LISTS = new Set([
  "get_live_categories",
  "get_live_streams",
  "get_vod_categories",
  "get_vod_streams",
  "get_series_categories",
  "get_series",
]);
const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const action = new URL(input).searchParams.get("action") ?? "login";
  memory.requests.push(action);
  const list = LISTS.has(action);
  if ((list && memory.holdLists) || (!list && action === "login" && memory.holdLogins)) {
    await new Promise<void>((go) => memory.held.push(go));
  }
  return passThrough(input, init);
});

const { native } = await import("./native-files.ts");

interface FakeProvider {
  readonly url: string;
  failCatalogue(status: number | null): void;
  failTitles(status: number | null): void;
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

const ONE = { username: "one", password: "one+Pw@1" };
const TWO = { username: "two", password: "two+Pw@2" };
let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ ...ONE, channels: 300, titles: 400 }),
    startFakeProvider({ ...TWO, channels: 300, titles: 400, second: true }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

const folder = join(native.root, "cache", "catalogues");
const pathOf = (name: string) => join(folder, name);
const settle = (ms = 100) => new Promise((done) => setTimeout(done, ms));
const listsAskedSince = (from: number) =>
  memory.requests.slice(from).filter((action) => LISTS.has(action));
const release = () => {
  for (const go of memory.held.splice(0)) go();
};

async function until(ready: () => boolean, what = "the condition") {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** What screens read when the app opened, taken as it opened. */
interface Opened {
  readonly channelsFrom: ReadonlySet<string>;
  readonly titlesFrom: ReadonlySet<string>;
  readonly movies: boolean;
  readonly series: boolean;
  readonly listsShown: number;
}

/** The app as a launch starts it: fresh modules over the same files and Keychain. */
async function launch() {
  vi.resetModules();
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const startup = await import("../src/startup.ts");
  const { kindOf } = await import("@mrstreamer/core/ondemand/catalogue");
  const seen = { opened: null as Opened | null, listsShown: 0 };
  titles.onTitleLists(() => {
    if (titles.titleLists().kind === "ready") seen.listsShown++;
  });
  /** The subscriptions whose movies and series the published lists hold. */
  const titlesFrom = () => {
    const lists = titles.titleLists();
    return new Set(
      lists.kind === "ready"
        ? (["movie", "series"] as const).flatMap((kind) =>
            kindOf(lists.index, kind).titles.flatMap((title) =>
              title.versions.map((version) => version.subscriptionId),
            ),
          )
        : [],
    );
  };
  startup.onStartup(() => {
    const catalogue = account.currentCatalogue();
    seen.opened = {
      channelsFrom: new Set(
        catalogue.kind === "ready"
          ? catalogue.library.channels.map((channel) => channel.subscriptionId)
          : [],
      ),
      titlesFrom: titlesFrom(),
      movies: titles.collectionsOf("movie") !== null,
      series: titles.collectionsOf("series") !== null,
      listsShown: seen.listsShown,
    };
  });
  void startup.startUp();
  return { ...account, ...titles, ...startup, seen, titlesFrom };
}
type App = Awaited<ReturnType<typeof launch>>;

const member = (app: App, id: string) => {
  const found = app.members().find((each) => each.entry.id === id);
  if (!found) throw new Error(`No subscription ${id}`);
  return found;
};

/** Both accounts added on a launch before, with all four lists saved. */
async function savedBoth() {
  const app = await launch();
  await until(() => app.currentStartup().kind === "open", "the first launch");
  const a = await app.add({ server: one.url, ...ONE });
  const b = await app.add({ server: two.url, ...TWO });
  if (!a || !b) throw new Error("An add was cancelled");
  const files = [a, b].flatMap((id) => [`${id}.live.json`, `${id}.titles.json`]);
  await until(() => files.every((name) => existsSync(pathOf(name))), "four lists saved");
  return { a, b };
}

beforeEach(async () => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  rmSync(join(native.root, "cache"), { recursive: true, force: true });
  native.gate = null;
  native.undeletable = null;
  native.sizeOf = null;
  memory.keychain.clear();
  memory.requests.length = 0;
  memory.holdLogins = false;
  memory.holdLists = false;
  for (const panel of [one, two]) {
    panel.failCatalogue(null);
    panel.failTitles(null);
  }
  const { Directory, Paths } = await import("./native-files.ts");
  for (const each of [Paths.document, Paths.cache])
    new Directory(each).create({ idempotent: true });
});
afterEach(() => {
  memory.holdLogins = false;
  memory.holdLists = false;
  release();
  native.gate = null;
  vi.useRealTimers();
});

describe("opening after a launch", () => {
  it("opens once both providers' saved channels and collections show, before their logins answer, asking for no list", async () => {
    const { a, b } = await savedBoth();
    memory.holdLogins = true;
    const from = memory.requests.length;
    // The app's own clock, so it opens with time to spare before the 8 seconds after which it
    // would open anyway, while both login checks are still held.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const app = await launch();
    expect(app.currentStartup().kind).toBe("opening");
    let waited = 0;
    for (; waited < 7_000 && app.currentStartup().kind !== "open"; waited += 10) {
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(app.currentStartup().kind).toBe("open");
    expect(waited).toBeLessThan(7_000);
    expect(memory.requests.slice(from).filter((action) => action === "login")).toHaveLength(2);
    expect(memory.held).toHaveLength(2);
    vi.useRealTimers();

    expect(app.seen.opened).toEqual({
      channelsFrom: new Set([a, b]),
      titlesFrom: new Set([a, b]),
      movies: true,
      series: true,
      // Indexed once, with both providers' lists: not again as the second's arrived.
      listsShown: 1,
    });
    for (const id of [a, b]) {
      expect(member(app, id).account).toBeNull();
      expect(member(app, id).live).toMatchObject({ kind: "ready", from: "cache" });
      expect(member(app, id).titles).toMatchObject({ kind: "ready", from: "cache" });
    }
    // Fresh copies stand for the lists: once the logins answer, none is asked for.
    memory.holdLogins = false;
    release();
    await until(() => [a, b].every((id) => member(app, id).account !== null), "the logins");
    await settle();
    expect(listsAskedSince(from)).toEqual([]);
    expect(app.currentStartup().kind).toBe("open");
  });

  it("indexes both providers' saved titles once though one's copy reads slower, not one's first", async () => {
    const { a, b } = await savedBoth();
    const holds: Array<() => void> = [];
    native.gate = (operation, path) =>
      operation === "text" && path.endsWith(`/${b}.titles.json`)
        ? new Promise<void>((go) => holds.push(go))
        : undefined;
    memory.holdLogins = true;
    const app = await launch();
    await until(() => holds.length > 0 && member(app, a).titles.kind === "ready", "one's titles");
    // Time enough to index one's titles alone, as each arrived used to be.
    await settle(500);
    expect(app.titleLists().kind).not.toBe("ready");
    native.gate = null;
    for (const go of holds.splice(0)) go();
    await until(() => app.currentStartup().kind === "open", "the app to open");
    expect(app.seen.opened).toMatchObject({ titlesFrom: new Set([a, b]), listsShown: 1 });
  });

  it("opens with older lists while they load again quietly, and keeps them when that fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const { a, b } = await savedBoth();
    vi.setSystemTime(start + 13 * 60 * 60 * 1000);
    memory.holdLists = true;
    const app = await launch();
    await until(() => app.currentStartup().kind === "open", "the app to open");
    expect(app.seen.opened).toMatchObject({ channelsFrom: new Set([a, b]), movies: true });
    for (const id of [a, b]) {
      // Shown while they load again: what loading.tsx's status line says nothing of.
      expect(member(app, id).live).toMatchObject({ kind: "loading", last: expect.anything() });
    }
    await until(() => memory.held.length >= 4, "the list requests");

    one.failCatalogue(503);
    one.failTitles(503);
    memory.holdLists = false;
    release();
    await until(
      () => member(app, a).live.kind === "failed" && member(app, a).titles.kind === "failed",
      "one's failures",
    );
    expect(app.shownOf(member(app, a).live)?.channels.length).toBeGreaterThan(0);
    expect(app.shownOf(member(app, a).titles)?.movies.length).toBeGreaterThan(0);
    expect(app.currentCatalogue()).toMatchObject({
      kind: "ready",
      failing: [{ entry: { id: a } }],
    });
    expect(app.titleLists().kind).toBe("ready");
    await until(() => member(app, b).titles.kind === "ready", "two's lists");
    expect(member(app, b).titles).toMatchObject({ from: "provider" });
  });

  it("opens at once without lists to show when a copy is missing or doesn't check out, while the logins are held", async () => {
    const { a, b } = await savedBoth();
    rmSync(pathOf(`${a}.live.json`));
    rmSync(pathOf(`${a}.titles.json`));
    writeFileSync(pathOf(`${b}.titles.json`), "{not json");
    memory.holdLogins = true;
    memory.holdLists = true;
    const app = await launch();
    await until(() => app.currentStartup().kind === "open", "the app to open");
    // What was saved shows; what wasn't loads for the first time, as screens say.
    expect(app.seen.opened).toMatchObject({ channelsFrom: new Set([b]), titlesFrom: new Set() });
    expect(member(app, b).live).toMatchObject({ kind: "ready", from: "cache" });
    expect(app.shownOf(member(app, a).live)).toBeNull();
    expect(app.shownOf(member(app, a).titles)).toBeNull();
    expect(app.shownOf(member(app, b).titles)).toBeNull();
    expect(app.titleLists().kind).toBe("loading");

    memory.holdLogins = false;
    memory.holdLists = false;
    release();
    await until(() => app.titleLists().kind === "ready", "the lists from the providers");
    expect(member(app, a).titles).toMatchObject({ kind: "ready", from: "provider" });
  });

  it("answers a title lookup asked while a launch reads that subscription's saved titles once they show", async () => {
    const { b } = await savedBoth();
    const holds: Array<() => void> = [];
    native.gate = (operation, path) =>
      operation === "text" && path.endsWith(`/${b}.titles.json`)
        ? new Promise<void>((go) => holds.push(go))
        : undefined;
    memory.holdLogins = true;
    const app = await launch();
    await until(() => holds.length > 0, "two's titles read");
    const answer = { settled: false, failed: null as unknown };
    const looked = app.listedIndex(b, AbortSignal.timeout(5_000)).then(
      (index) => {
        answer.settled = true;
        return index;
      },
      (cause: unknown) => {
        answer.settled = true;
        answer.failed = cause;
        return null;
      },
    );
    await settle(200);
    expect(answer).toEqual({ settled: false, failed: null });
    native.gate = null;
    for (const go of holds.splice(0)) go();
    const index = await looked;
    expect(answer.failed).toBeNull();
    expect(app.titleLists()).toEqual({ kind: "ready", index });
    await until(() => app.currentStartup().kind === "open", "the app to open");
    expect(app.seen.opened?.titlesFrom.has(b)).toBe(true);
  });

  it("opens at once with no subscription saved", async () => {
    const app = await launch();
    await until(() => app.currentStartup().kind === "open", "the app to open");
    expect(app.members()).toEqual([]);
  });

  it("opens with the saved lists of those it can sign in when the Keychain lost a password", async () => {
    const { a, b } = await savedBoth();
    memory.keychain.delete(`s.${b}`);
    memory.holdLogins = true;
    const app = await launch();
    await until(() => app.currentStartup().kind === "open", "the app to open");
    expect(member(app, b).needsSecret).toBe(true);
    expect(app.seen.opened).toMatchObject({
      channelsFrom: new Set([a]),
      titlesFrom: new Set([a]),
    });
  });

  it("opens once a subscription whose saved list the disk doesn't answer is removed, and shows nothing of it after", async () => {
    const { a, b } = await savedBoth();
    const holds: Array<() => void> = [];
    native.gate = (operation, path) =>
      operation === "text" && path.includes(`/${b}.`)
        ? new Promise<void>((go) => holds.push(go))
        : undefined;
    memory.holdLogins = true;
    const app = await launch();
    await until(() => holds.length > 0, "two's read");
    await until(() => member(app, a).titles.kind === "ready", "one's saved lists");
    await settle(300);
    expect(app.currentStartup().kind).toBe("opening");

    await app.remove(b, { keepHistory: true });
    await until(() => app.currentStartup().kind === "open", "the app to open");
    expect(app.seen.opened).toMatchObject({
      channelsFrom: new Set([a]),
      titlesFrom: new Set([a]),
      movies: true,
    });
    // The read answers late: nothing of the removed subscription shows.
    native.gate = null;
    for (const go of holds.splice(0)) go();
    await settle(300);
    expect(app.members().map((each) => each.entry.id)).toEqual([a]);
    const catalogue = app.currentCatalogue();
    expect(
      catalogue.kind === "ready" &&
        catalogue.library.channels.every((channel) => channel.subscriptionId === a),
    ).toBe(true);
  });

  it("opens without the rest once a saved list's read hasn't answered within 8 seconds, showing what was read until it joins", async () => {
    const { a, b } = await savedBoth();
    const holds: Array<() => void> = [];
    native.gate = (operation, path) =>
      operation === "text" && path.includes(`/${b}.titles`)
        ? new Promise<void>((go) => holds.push(go))
        : undefined;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const app = await launch();
    await vi.advanceTimersByTimeAsync(7_000);
    expect(holds.length).toBeGreaterThan(0);
    expect(member(app, a).titles).toMatchObject({ kind: "ready", from: "cache" });
    expect(app.currentStartup().kind).toBe("opening");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(app.currentStartup().kind).toBe("open");

    // Two's read still hangs: one's movies and series are indexed and their collections made.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(holds.length).toBeGreaterThan(0);
    expect(app.titleLists().kind).toBe("ready");
    expect(app.titlesFrom()).toEqual(new Set([a]));
    expect(app.collectionsOf("movie")).not.toBeNull();
    expect(app.collectionsOf("series")).not.toBeNull();
    expect(member(app, b).live).toMatchObject({ kind: "ready", from: "cache" });
    const lookups = { b: "waiting" };
    const forOne = await app.listedIndex(a, AbortSignal.timeout(5_000));
    expect(forOne).toBe((app.titleLists() as { index: unknown }).index);
    const forTwo = app.listedIndex(b, AbortSignal.timeout(5_000)).then(
      (index) => ((lookups.b = "answered"), index),
      () => ((lookups.b = "failed"), null),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(lookups.b).toBe("waiting");

    // Two's read answers late: its titles join one's in the lists that show.
    vi.useRealTimers();
    native.gate = null;
    for (const go of holds.splice(0)) go();
    await until(() => app.titlesFrom().size === 2, "two's titles joining");
    expect(app.titlesFrom()).toEqual(new Set([a, b]));
    expect(app.collectionsOf("movie")).not.toBeNull();
    expect(app.collectionsOf("series")).not.toBeNull();
    // Answered with the lists that hold two's.
    expect(await forTwo).toBe((app.titleLists() as { index: unknown }).index);
    expect(lookups.b).toBe("answered");
    expect(app.currentStartup().kind).toBe("open");
  });
});
