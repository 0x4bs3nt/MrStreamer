import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The lists a launch shows from the phone: account.ts and the files it saves in Caches, over real
// files (`native-files.ts`, whose gate holds a read, write or move as a busy disk would, or for
// ever, as an app stopped there). Two of the desktop tests' fake Xtream panels answer over HTTP;
// an answer can be rewritten on its way, as a provider that sends other rows would. The Keychain
// is kept in memory across launches, which re-import the app's modules as a relaunch starts them.

const memory = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** Passwords the Keychain has stored but whose write it hasn't answered yet. */
  heldSecrets: [] as Array<() => void>,
  holdSecrets: false,
  /** Each request to a panel: its `action`, or "login" for the login check. */
  requests: [] as string[],
  /** List requests held until a test lets them through. */
  heldLists: [] as Array<() => void>,
  holdLists: false,
  /** Changes a channel list's rows on their way to the app. */
  channels: null as null | ((rows: Record<string, unknown>[]) => Record<string, unknown>[]),
  /** Passwords a panel takes for its own, as one whose password was changed. */
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
  setItemAsync: async (key: string, value: string) => {
    memory.keychain.set(key, value);
    if (memory.holdSecrets && key.startsWith("s.")) {
      await new Promise<void>((go) => memory.heldSecrets.push(go));
    }
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
  const url = memory.aliases.reduce(
    (each, [alias, password]) =>
      each.replaceAll(encodeURIComponent(alias), encodeURIComponent(password)),
    input,
  );
  const action = new URL(url).searchParams.get("action") ?? "login";
  memory.requests.push(action);
  if (LISTS.has(action) && memory.holdLists) {
    await new Promise<void>((go) => memory.heldLists.push(go));
  }
  const response = await passThrough(url, init);
  const rewrite = memory.channels;
  if (action !== "get_live_streams" || !rewrite || !response.ok) return response;
  const rows = (await response.json()) as Record<string, unknown>[];
  return Response.json(rewrite(rows));
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
    startFakeProvider({ ...ONE, channels: 30, titles: 20 }),
    startFakeProvider({ ...TWO, channels: 30, titles: 20, second: true }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});
/** Panels a test starts for a login of its own, closed after it. */
const started: FakeProvider[] = [];
async function panelFor(login: typeof ONE, size = { channels: 10, titles: 10 }) {
  const panel = await startFakeProvider({ ...login, ...size });
  started.push(panel);
  return panel;
}

/** What a test set going that ends with it. */
const cleanups: Array<() => void> = [];

/**
 * Makes each reading of the clock 10 ms later than the last, as on a phone busy enough that every
 * slice of work fills a task: `inTasks` then works one slice per task. No time is measured.
 */
function slowClock() {
  const real = Date.now.bind(Date);
  let ahead = 0;
  const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + (ahead += 10));
  cleanups.push(() => spy.mockRestore());
}

/** Other work the app's tasks leave room for: a timer that runs again each time it runs. */
function ticker() {
  const counted = { ticks: 0 };
  let on = true;
  const tick = () => {
    if (!on) return;
    counted.ticks++;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  cleanups.push(() => (on = false));
  return counted;
}

const folder = join(native.root, "cache", "catalogues");
const pathOf = (name: string) => join(folder, name);
/** The files in the folder of saved lists. */
const saved = () => (existsSync(folder) ? readdirSync(folder).toSorted() : []);
const savedOf = (id: string) => saved().filter((name) => name.startsWith(`${id}.`));
const contents = (name: string) => JSON.parse(readFileSync(pathOf(name), "utf8"));
const settle = (ms = 100) => new Promise((done) => setTimeout(done, ms));
/** List requests since `from`, an index into `memory.requests`. */
const listsAskedSince = (from: number) =>
  memory.requests.slice(from).filter((action) => LISTS.has(action));

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what = "the condition") {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same files and Keychain. */
async function launch() {
  vi.resetModules();
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  await account.restore();
  return { ...titles, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

const member = (app: App, id: string) => {
  const found = app.members().find((each) => each.entry.id === id);
  if (!found) throw new Error(`No subscription ${id}`);
  return found;
};

/** Adds `panel`'s account, then waits until both its lists are saved. */
async function added(app: App, panel: FakeProvider, login: typeof ONE) {
  const id = await app.add({ server: panel.url, ...login });
  if (!id) throw new Error("The add was cancelled");
  await until(() => savedOf(id).length === 2, "both lists saved");
  return id;
}

beforeEach(() => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  rmSync(join(native.root, "cache"), { recursive: true, force: true });
  native.gate = null;
  native.undeletable = null;
  native.sizeOf = null;
  memory.aliases = [];
  memory.keychain.clear();
  memory.holdSecrets = false;
  memory.heldSecrets.length = 0;
  memory.holdLists = false;
  memory.requests.length = 0;
  memory.channels = null;
  for (const panel of [one, two]) {
    panel.failCatalogue(null);
    panel.failTitles(null);
  }
});
beforeEach(async () => {
  const { Directory, Paths } = await import("./native-files.ts");
  for (const each of [Paths.document, Paths.cache])
    new Directory(each).create({ idempotent: true });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const go of memory.heldLists.splice(0)) go();
  vi.useRealTimers();
  await Promise.all(started.splice(0).map((panel) => panel.close()));
});

describe("a launch with lists saved", () => {
  it("shows lists saved less than 12 hours ago as loaded, asking for none, and checks the login", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const id = await added(await launch(), one, ONE);

    vi.setSystemTime(start + 12 * 60 * 60 * 1000 - 1);
    const from = memory.requests.length;
    const app = await launch();
    await until(() => member(app, id).account !== null, "the login check");
    await until(() => app.titleLists().kind === "ready", "the movie and series lists");
    expect(member(app, id).live).toMatchObject({ kind: "ready", from: "cache", fetchedAt: start });
    expect(member(app, id).titles).toMatchObject({ kind: "ready", from: "cache", took: null });
    await until(() => app.currentCatalogue().kind === "ready", "the saved channels");
    await settle();
    expect(memory.requests.slice(from)).toEqual(["login"]);

    // At 12 hours they show while they load again.
    vi.setSystemTime(start + 12 * 60 * 60 * 1000);
    const later = memory.requests.length;
    const again = await launch();
    await until(
      () => member(again, id).titles.kind === "ready" && member(again, id).live.kind === "ready",
      "the lists again",
    );
    expect(member(again, id).live).toMatchObject({ kind: "ready", from: "provider" });
    expect(member(again, id).titles).toMatchObject({ kind: "ready", from: "provider" });
    expect(listsAskedSince(later)).toContain("get_live_streams");
    expect(listsAskedSince(later)).toContain("get_vod_streams");
  });

  it("shows older lists while they load again, and keeps them when that fails, until Try again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    const id = await added(await launch(), one, ONE);
    vi.setSystemTime(start + 13 * 60 * 60 * 1000);

    memory.holdLists = true;
    const app = await launch();
    await until(() => memory.heldLists.length > 0, "a list request");
    await until(() => app.titleLists().kind === "ready", "the saved movie and series lists");
    expect(member(app, id).live).toMatchObject({
      kind: "loading",
      last: { channels: expect.any(Array) },
    });
    await until(() => app.currentCatalogue().kind === "ready", "the saved channels");

    one.failCatalogue(503);
    one.failTitles(503);
    memory.holdLists = false;
    for (const go of memory.heldLists.splice(0)) go();
    await until(() => member(app, id).titles.kind === "failed", "the failures");
    await until(() => member(app, id).live.kind === "failed", "the channels' failure");
    expect(app.shownOf(member(app, id).live)?.channels.length).toBeGreaterThan(0);
    expect(app.shownOf(member(app, id).titles)?.movies.length).toBeGreaterThan(0);
    expect(app.currentCatalogue()).toMatchObject({ kind: "ready", failing: [{ entry: { id } }] });
    expect(app.titleLists().kind).toBe("ready");

    one.failCatalogue(null);
    one.failTitles(null);
    app.retry(id);
    await until(() => member(app, id).titles.kind === "ready", "the retry");
    await until(() => member(app, id).live.kind === "ready", "the channels' retry");
    expect(member(app, id).live).toMatchObject({ from: "provider" });
  });

  it("asks the provider on Reload, Try again and an add, though the lists are fresh", async () => {
    const id = await added(await launch(), one, ONE);
    const app = await launch();
    await until(() => member(app, id).titles.kind === "ready", "the saved lists");
    const from = memory.requests.length;
    app.reloadChannels(id);
    await until(() => listsAskedSince(from).includes("get_live_streams"), "the channel list");
    app.retry(id);
    await until(() => listsAskedSince(from).includes("get_vod_streams"), "the movie list");
    const again = memory.requests.length;
    expect(await app.add({ server: one.url, ...ONE })).toBe(id);
    await until(
      () =>
        ["get_live_streams", "get_vod_streams"].every((each) =>
          listsAskedSince(again).includes(each),
        ),
      "both lists for the add",
    );
  });

  it("loads one kind from the provider when its file doesn't check out, keeping the other's", async () => {
    const id = await added(await launch(), one, ONE);
    const titles = `${id}.titles.json`;
    const whole = readFileSync(pathOf(titles), "utf8");
    const envelope = JSON.parse(whole);
    const now = Date.now();
    const broken: Record<string, () => void> = {
      unreadable: () => writeFileSync(pathOf(titles), "{not json"),
      partial: () => writeFileSync(pathOf(titles), whole.slice(0, whole.length / 2)),
      "another version": () =>
        writeFileSync(pathOf(titles), JSON.stringify({ ...envelope, version: 2 })),
      "another subscription": () =>
        writeFileSync(
          pathOf(titles),
          JSON.stringify({ ...envelope, subscriptionId: "xtream-other" }),
        ),
      "a row out of shape": () =>
        writeFileSync(
          pathOf(titles),
          JSON.stringify({
            ...envelope,
            catalogue: {
              ...envelope.catalogue,
              movies: [{ ...envelope.catalogue.movies[0], streamUrl: "http://x" }],
            },
          }),
        ),
      "from the future": () =>
        writeFileSync(
          pathOf(titles),
          JSON.stringify({ ...envelope, fetchedAt: now + 11 * 60 * 1000 }),
        ),
      "older than 30 days": () =>
        writeFileSync(
          pathOf(titles),
          JSON.stringify({ ...envelope, fetchedAt: now - 31 * 24 * 60 * 60 * 1000 }),
        ),
      "too many rows": () =>
        writeFileSync(
          pathOf(titles),
          JSON.stringify({
            ...envelope,
            catalogue: {
              ...envelope.catalogue,
              movieCategories: Array.from({ length: 250_001 }, (_, at) => ({
                id: `${at}`,
                name: "",
              })),
            },
          }),
        ),
      "too large": () => truncateSync(pathOf(titles), 64 * 1024 * 1024 + 1),
    };
    for (const [what, breakIt] of Object.entries(broken)) {
      breakIt();
      const from = memory.requests.length;
      const app = await launch();
      await until(() => member(app, id).titles.kind === "ready", `the movie lists, ${what}`);
      expect(member(app, id).titles, what).toMatchObject({ from: "provider" });
      expect(member(app, id).live, what).toMatchObject({ kind: "ready", from: "cache" });
      expect(listsAskedSince(from), what).not.toContain("get_live_streams");
      // Saved again from the provider's answer.
      await until(() => {
        const now = existsSync(pathOf(titles)) ? readFileSync(pathOf(titles), "utf8") : "";
        return now.startsWith("{") && JSON.parse(now).fetchedAt !== envelope.fetchedAt;
      }, `the lists saved again, ${what}`);
      writeFileSync(pathOf(titles), whole);
    }
  });

  it("loads one kind from the provider when a saved number overflows to infinity, keeping the other's", async () => {
    const id = await added(await launch(), one, ONE);
    const original = new Map(
      ["live", "titles"].map((kind) => [kind, readFileSync(pathOf(`${id}.${kind}.json`), "utf8")]),
    );
    /** `kind`'s file with `field` of its first `list` row set to `number`, as JSON text spells it. */
    const write = (kind: string, list: string, field: string, number: string) => {
      const envelope = JSON.parse(original.get(kind) ?? "");
      envelope.catalogue[list][0][field] = "__number__";
      writeFileSync(
        pathOf(`${id}.${kind}.json`),
        JSON.stringify(envelope).replace('"__number__"', number),
      );
    };
    const restore = () => {
      for (const [kind, text] of original) writeFileSync(pathOf(`${id}.${kind}.json`), text);
    };
    const overflows = [
      ["titles", "movies", "rating", "1e400"],
      ["titles", "movies", "addedAt", "-1e400"],
      ["live", "channels", "number", "1e400"],
      ["live", "channels", "catchupDays", "-1e400"],
    ] as const;
    for (const [kind, list, field, number] of overflows) {
      const what = `${list} ${field} ${number}`;
      restore();
      write(kind, list, field, number);
      const from = memory.requests.length;
      const app = await launch();
      await until(
        () => member(app, id).live.kind === "ready" && member(app, id).titles.kind === "ready",
        `both lists, ${what}`,
      );
      const other = kind === "live" ? "titles" : "live";
      expect(member(app, id)[kind], what).toMatchObject({ from: "provider" });
      expect(member(app, id)[other], what).toMatchObject({ from: "cache" });
      expect(listsAskedSince(from), what).toContain(
        kind === "live" ? "get_live_streams" : "get_vod_streams",
      );
      // Saved again from the provider's answer before the next case.
      const path = pathOf(`${id}.${kind}.json`);
      await until(
        () => existsSync(path) && !readFileSync(path, "utf8").includes("e400"),
        `the list saved again, ${what}`,
      );
    }
    // Finite numbers and none stay saved lists.
    for (const [kind, list, field, number] of [
      ["titles", "movies", "rating", "9.5"],
      ["titles", "movies", "addedAt", "null"],
      ["live", "channels", "number", "-3"],
      ["live", "channels", "catchupDays", "null"],
    ] as const) {
      restore();
      write(kind, list, field, number);
      const from = memory.requests.length;
      const app = await launch();
      await until(
        () => member(app, id).live.kind === "ready" && member(app, id).titles.kind === "ready",
        "both saved lists",
      );
      expect(member(app, id).live, `${field} ${number}`).toMatchObject({ from: "cache" });
      expect(member(app, id).titles, `${field} ${number}`).toMatchObject({ from: "cache" });
      expect(listsAskedSince(from)).toEqual([]);
    }
  });

  it("takes the new copy a write left halfway, and deletes every file not of a saved subscription", async () => {
    const id = await added(await launch(), one, ONE);
    // Stopped as iOS moves a write into place: the copy deleted, the new file still beside it.
    renameSync(pathOf(`${id}.live.json`), pathOf(`${id}.live.json.next`));
    writeFileSync(pathOf(`${id}.titles.json.next`), "{half");
    for (const name of ["xtream-gone.live.json", "xtream-gone.titles.json.next", "notes.txt"]) {
      writeFileSync(pathOf(name), "{}");
    }
    const from = memory.requests.length;
    const app = await launch();
    await until(() => member(app, id).titles.kind === "ready", "the saved lists");
    expect(member(app, id).live).toMatchObject({ kind: "ready", from: "cache" });
    expect(member(app, id).titles).toMatchObject({ kind: "ready", from: "cache" });
    expect(listsAskedSince(from)).toEqual([]);
    expect(saved()).toEqual([`${id}.live.json`, `${id}.titles.json`]);
  });

  it("deletes the least recently saved movie and series lists first past 256 MiB, then channels", async () => {
    const app = await launch();
    const a = await added(app, one, ONE);
    const b = await added(app, two, TWO);
    const sizes: [string, number, number][] = [
      [`${a}.live.json`, 60, 1],
      [`${a}.titles.json`, 60, 2],
      [`${b}.titles.json`, 60, 3],
      [`${b}.live.json`, 60, 4],
      [`${b}.live.json.next`, 30, 5],
    ];
    for (const [name, mib, age] of sizes) {
      writeFileSync(pathOf(name), "");
      truncateSync(pathOf(name), mib * 1024 * 1024);
      utimesSync(pathOf(name), age * 1000, age * 1000);
    }
    // Reads wait, so the files stay as the launch left them.
    native.gate = (operation) => (operation === "text" ? new Promise(() => undefined) : undefined);
    await launch();
    expect(saved()).toEqual(
      [`${a}.live.json`, `${b}.live.json`, `${b}.live.json.next`, `${b}.titles.json`].toSorted(),
    );
  });

  it("keeps writes a stopped app left halfway within 256 MiB, the oldest movie and series lists going first", async () => {
    const app = await launch();
    const three = { username: "six", password: "six-Pw6" };
    const a = await added(app, one, ONE);
    const b = await added(app, two, TWO);
    const c = await added(app, await panelFor(three), three);
    const ids = [a, b, c];
    // Stopped as each list moved into place: only the new files are left, 55 MiB each.
    ids.forEach((id, at) => {
      for (const [kind, age] of [
        ["titles", at + 1],
        ["live", at + 4],
      ] as const) {
        const name = `${id}.${kind}.json`;
        renameSync(pathOf(name), pathOf(`${name}.next`));
        utimesSync(pathOf(`${name}.next`), age * 1000, age * 1000);
      }
    });
    native.sizeOf = (path) => (path.includes("/catalogues/") ? 55 * 1024 * 1024 : undefined);
    memory.holdLists = true;
    const again = await launch();
    await until(
      () => ids.every((id) => member(again, id).live.kind === "ready"),
      "the saved channel lists",
    );
    await until(() => member(again, c).titles.kind === "ready", "the newest movie lists");
    expect(saved()).toEqual(
      [`${a}.live.json`, `${b}.live.json`, `${c}.live.json`, `${c}.titles.json`].toSorted(),
    );
    // The two it deleted are not there, and load from the provider as any missing list does.
    await until(
      () => [a, b].every((id) => member(again, id).titles.kind === "loading"),
      "the movie lists asked for",
    );
    for (const id of [a, b]) {
      expect(member(again, id).titles).toMatchObject({ kind: "loading", last: null });
    }
    expect(member(again, c).titles).toMatchObject({ kind: "ready", from: "cache" });
  });
});

describe("saving lists", () => {
  it("writes artwork that may carry the login as none, leaving this session's lists as they came", async () => {
    const [user, password] = [ONE.username, ONE.password];
    const unsafe = [
      `https://img.example/${user}/logo.png`,
      `https://img.example/logo.png?password=${encodeURIComponent(password)}`,
      `https://img.example/${encodeURIComponent(password)}/logo.png`,
      `https://${user}:x@img.example/logo.png`,
      `https://img.example/${"a".repeat(2048)}.png`,
    ];
    memory.channels = (rows) =>
      rows.map((row, at) => (at < unsafe.length ? { ...row, stream_icon: unsafe[at] } : row));
    const app = await launch();
    const id = await added(app, one, ONE);
    const listed = app.shownOf(member(app, id).live)?.channels ?? [];
    const kept = contents(`${id}.live.json`).catalogue.channels as { logoUrl: string | null }[];
    expect(kept).toHaveLength(listed.length);
    expect(kept.slice(0, unsafe.length).map((each) => each.logoUrl)).toEqual(
      unsafe.map(() => null),
    );
    expect(
      kept.slice(unsafe.length).some((each) => each.logoUrl?.startsWith("http://127.0.0.1")),
    ).toBe(true);
    expect(listed.slice(0, unsafe.length).map((each) => each.logoUrl)).toEqual(unsafe);
    expect(readFileSync(pathOf(`${id}.live.json`), "utf8")).not.toContain(password);
  });

  it("writes no channel list that has the password in its text, keeping the movie lists'", async () => {
    memory.channels = (rows) =>
      rows.map((row, at) => (at === 3 ? { ...row, name: `News ${ONE.password}` } : row));
    const app = await launch();
    const id = await app.add({ server: one.url, ...ONE });
    if (!id) throw new Error("The add was cancelled");
    await until(() => savedOf(id).includes(`${id}.titles.json`), "the movie lists saved");
    await settle(200);
    expect(savedOf(id)).toEqual([`${id}.titles.json`]);
    expect(member(app, id).live.kind).toBe("ready");
  });

  it("writes as none artwork whose decoded query holds the password, as form encoding spells it", async () => {
    const login = { username: "three", password: "canary space 3" };
    const { password } = login;
    const unsafe = [
      `https://img.example/logo.png?${new URLSearchParams({ token: `prefix${password}suffix` })}`,
      `https://proxy.example/image?${new URLSearchParams({ url: `http://panel.example/live/three/${password}/7.png` })}`,
      `https://img.example/logo.png?${new URLSearchParams({ [`k${password}`]: "1" })}`,
    ];
    // The username within a longer part is no login.
    const safe = "https://img.example/threefold/logo.png?ref=three-ish";
    const art = [...unsafe, safe];
    memory.channels = (rows) =>
      rows.map((row, at) => (at < art.length ? { ...row, stream_icon: art[at] } : row));
    const app = await launch();
    const id = await added(app, await panelFor(login), login);
    const listed = app.shownOf(member(app, id).live)?.channels ?? [];
    const kept = contents(`${id}.live.json`).catalogue.channels as { logoUrl: string | null }[];
    expect(kept).toHaveLength(listed.length);
    expect(kept.slice(0, art.length).map((each) => each.logoUrl)).toEqual([
      ...unsafe.map(() => null),
      safe,
    ]);
    expect(listed.slice(0, art.length).map((each) => each.logoUrl)).toEqual(art);
    const text = readFileSync(pathOf(`${id}.live.json`), "utf8");
    for (const spelling of [
      password,
      password.replaceAll(" ", "+"),
      encodeURIComponent(password),
    ]) {
      expect(text).not.toContain(spelling);
    }
  });

  it("writes as none artwork whose address within an address holds the password encoded again", async () => {
    const login = { username: "five", password: "canary space" };
    const { password } = login;
    /** An image proxy's address for `inner`, encoded as its query value. */
    const proxied = (inner: string) => {
      const outer = new URL("https://proxy.example/image");
      outer.searchParams.set("url", inner);
      return outer.href;
    };
    const asked = (base: string, name: string, value: string) => {
      const address = new URL(base);
      address.searchParams.set(name, value);
      return address.href;
    };
    const encodedPath = `https://panel.example/art/five/${encodeURIComponent(password)}/7.png`;
    const unsafe = [
      proxied(encodedPath),
      `https://img.example/${encodeURIComponent(encodeURIComponent(password))}/logo.png`,
      proxied(asked("https://panel.example/get.php", "password", password)),
      proxied(proxied(encodedPath)),
      // Encoding that doesn't decode can't be shown free of the login.
      "https://img.example/logo.png?x=%E0%A4%A",
    ];
    const safe = [
      proxied("https://img.example/art/7.png?size=w500"),
      proxied(asked("https://panel.example/logo.png", "ref", "fivefold")),
    ];
    const art = [...unsafe, ...safe];
    memory.channels = (rows) =>
      rows.map((row, at) => (at < art.length ? { ...row, stream_icon: art[at] } : row));
    const app = await launch();
    const id = await added(app, await panelFor(login), login);
    const listed = app.shownOf(member(app, id).live)?.channels ?? [];
    const kept = contents(`${id}.live.json`).catalogue.channels as { logoUrl: string | null }[];
    expect(kept).toHaveLength(listed.length);
    expect(kept.slice(0, art.length).map((each) => each.logoUrl)).toEqual([
      ...unsafe.map(() => null),
      ...safe,
    ]);
    expect(listed.slice(0, art.length).map((each) => each.logoUrl)).toEqual(art);
    const text = readFileSync(pathOf(`${id}.live.json`), "utf8");
    for (const spelling of [
      password,
      password.replaceAll(" ", "+"),
      encodeURIComponent(password),
      encodeURIComponent(encodeURIComponent(password)),
    ]) {
      expect(text).not.toContain(spelling);
    }
  });

  for (const [what, password] of [
    ["a number", "90817"],
    ["a field's name", "catchupDays"],
  ] as const) {
    it(`saves lists in which the password is only ${what}`, async () => {
      const login = { username: "four", password };
      memory.channels = (rows) => rows.map((row, at) => (at === 0 ? { ...row, num: 90817 } : row));
      const app = await launch();
      const id = await added(app, await panelFor(login), login);
      expect(readFileSync(pathOf(`${id}.live.json`), "utf8")).toContain(password);
      const again = await launch();
      await until(() => member(again, id).titles.kind === "ready", "the saved lists");
      expect(member(again, id).live).toMatchObject({ kind: "ready", from: "cache" });
    });
  }

  it("leaves a list loaded when it can't be saved", async () => {
    native.gate = (operation) =>
      operation === "write" ? Promise.reject(new Error("The disk is full")) : undefined;
    const app = await launch();
    const id = await app.add({ server: one.url, ...ONE });
    if (!id) throw new Error("The add was cancelled");
    await until(() => member(app, id).titles.kind === "ready", "the lists");
    await settle(200);
    expect(member(app, id).live.kind).toBe("ready");
    expect(saved()).toEqual([]);
  });
});

describe("a login replaced or removed", () => {
  for (const how of ["added again", "given a new password"] as const) {
    it(`deletes the saved lists before the Keychain takes the password of one ${how}`, async () => {
      const app = await launch();
      const id = await added(app, one, ONE);
      memory.holdSecrets = true;
      const changing =
        how === "added again"
          ? app.add({ server: one.url, ...ONE })
          : app.update(id, { password: ONE.password });
      await until(() => memory.heldSecrets.length === 1, "the password's write");
      expect(savedOf(id)).toEqual([]);
      // The app stops before the Keychain answers: the next launch has nothing saved to show.
      memory.holdSecrets = false;
      memory.holdLists = true;
      const from = memory.requests.length;
      const again = await launch();
      await until(() => memory.heldLists.length > 0, "a list request");
      expect(member(again, id).live).toMatchObject({ kind: "loading", last: null });
      expect(listsAskedSince(from)).toContain("get_live_streams");
      void changing;
    });
  }

  for (const how of ["added again", "given a new password"] as const) {
    it(`keeps the old login of one ${how} while its saved lists can't be deleted`, async () => {
      const NEW = "oneNewPw7";
      memory.aliases = [[NEW, ONE.password]];
      const id = await added(await launch(), one, ONE);
      const change = (app: App) =>
        how === "added again"
          ? app.add({ server: one.url, username: ONE.username, password: NEW })
          : app.update(id, { password: NEW });
      native.undeletable = (path) => path.endsWith(`${id}.live.json`);
      const app = await launch();
      await until(() => member(app, id).titles.kind === "ready", "the saved lists");
      await expect(change(app)).rejects.toMatchObject({ error: { kind: "unexpected" } });
      expect(memory.keychain.get(`s.${id}`)).toBe(ONE.password);
      expect(member(app, id).live.kind).toBe("ready");

      // Restarted: the old login, whose list stayed, signs in again.
      const again = await launch();
      await until(() => member(again, id).account !== null, "the login check");
      expect(member(again, id).account).toMatchObject({ state: "active" });
      expect(member(again, id).live).toMatchObject({ kind: "ready", from: "cache" });

      // Once the phone deletes it, the change goes through, and nothing of the old login shows.
      native.undeletable = null;
      memory.holdLists = true;
      await change(again);
      expect(memory.keychain.get(`s.${id}`)).toBe(NEW);
      expect(savedOf(id)).toEqual([]);
      const waiting = memory.heldLists.length;
      const third = await launch();
      await until(() => memory.heldLists.length > waiting, "a list request");
      expect(member(third, id).live).toMatchObject({ kind: "loading", last: null });
    });
  }

  it("never gives an account added again the lists of its removal the phone couldn't delete", async () => {
    const app = await launch();
    const id = await added(app, one, ONE);
    native.undeletable = (path) => path.endsWith(`${id}.titles.json`);
    await app.remove(id, { keepHistory: true });
    await settle();
    expect(savedOf(id)).toEqual([`${id}.titles.json`]);
    await expect(app.add({ server: one.url, ...ONE })).rejects.toMatchObject({
      error: { kind: "unexpected" },
    });
    expect(app.members()).toEqual([]);
    expect(memory.keychain.has(`s.${id}`)).toBe(false);

    native.undeletable = null;
    memory.holdLists = true;
    expect(await app.add({ server: one.url, ...ONE })).toBe(id);
    expect(savedOf(id)).toEqual([]);
    const waiting = memory.heldLists.length;
    const again = await launch();
    await until(() => memory.heldLists.length > waiting, "a list request");
    expect(member(again, id).live).toMatchObject({ kind: "loading", last: null });
    expect(member(again, id).titles.kind).not.toBe("ready");
  });

  it("keeps the saved lists for a new name alone", async () => {
    const app = await launch();
    const id = await added(app, one, ONE);
    const before = saved().map((name) => readFileSync(pathOf(name), "utf8"));
    await app.update(id, { name: "Cabin" });
    await settle();
    expect(saved().map((name) => readFileSync(pathOf(name), "utf8"))).toEqual(before);
  });

  it("leaves no file of one removed while its list was being saved", async () => {
    const app = await launch();
    const id = await added(app, one, ONE);
    const held: { release?: () => void } = {};
    native.gate = (operation, path) =>
      operation === "move" && path.endsWith(`${id}.live.json.next`)
        ? new Promise((go) => (held.release = go))
        : undefined;
    app.reloadChannels(id);
    await until(() => held.release !== undefined, "the write's move");
    const removing = app.remove(id, { keepHistory: true });
    held.release?.();
    await removing;
    await until(() => savedOf(id).length === 0, "its files deleted");
    await settle(200);
    expect(saved()).toEqual([]);
  });

  it("never shows the lists of one removed to the same account added again", async () => {
    const app = await launch();
    const id = await added(app, one, ONE);
    const held: { release?: () => void } = {};
    native.gate = (operation, path) =>
      operation === "write" && path.endsWith(`${id}.live.json.next`)
        ? new Promise((go) => (held.release = go))
        : undefined;
    app.reloadChannels(id);
    await until(() => held.release !== undefined, "the write under way");
    await app.remove(id, { keepHistory: true });
    const adding = app.add({ server: one.url, ...ONE });
    await settle();
    native.gate = null;
    memory.holdLists = true;
    held.release?.();
    expect(await adding).toBe(id);
    // The app stops before the new lists land.
    await settle(200);
    expect(savedOf(id)).toEqual([]);
    const waiting = memory.heldLists.length;
    const again = await launch();
    await until(() => memory.heldLists.length > waiting, "a list request");
    expect(member(again, id).live).toMatchObject({ kind: "loading", last: null });
    expect(member(again, id).titles.kind).not.toBe("ready");
  });
});

describe("a large provider's lists", () => {
  const BIG = { username: "big", password: "big-Pw7" };
  const SIZE = { channels: 600, titles: 3000 };
  /** The ticks when the titles first show as `from`, kept as the roster changes. */
  const shownWhen = (app: App, from: "provider" | "cache", counted: { ticks: number }) => {
    const seen = { at: -1 };
    const off = app.onRoster(() => {
      const titles = app.members()[0]?.titles;
      if (seen.at < 0 && titles?.kind === "ready" && titles.from === from) seen.at = counted.ticks;
    });
    cleanups.push(off);
    return seen;
  };
  /** By file name, the ticks when each pending file is first written. */
  const writtenWhen = (counted: { ticks: number }) => {
    const seen = new Map<string, number>();
    native.gate = (operation, path) => {
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (operation === "write" && !seen.has(name)) seen.set(name, counted.ticks);
      return undefined;
    };
    return seen;
  };
  /** The ticks when `id`'s titles file is first read, or -1. */
  const readWhen = (id: string, counted: { ticks: number }) => {
    const seen = { at: -1 };
    native.gate = (operation, path) => {
      if (operation === "text" && path.endsWith(`/${id}.titles.json`) && seen.at < 0) {
        seen.at = counted.ticks;
      }
      return undefined;
    };
    return seen;
  };

  it("leaves room for other work while it copies the lists to the phone", async () => {
    const panel = await panelFor(BIG, SIZE);
    slowClock();
    const app = await launch();
    const counted = ticker();
    const shown = shownWhen(app, "provider", counted);
    const written = writtenWhen(counted);
    const id = await added(app, panel, BIG);
    expect(savedOf(id)).toEqual([`${id}.live.json`, `${id}.titles.json`]);
    // Tens of tasks ran between the lists showing and their copy being written.
    expect((written.get(`${id}.titles.json.next`) ?? -1) - shown.at).toBeGreaterThanOrEqual(20);
  });

  it("leaves room for other work while it checks the saved lists, then shows them whole", async () => {
    const panel = await panelFor(BIG, SIZE);
    const first = await launch();
    const id = await added(first, panel, BIG);
    const listed = first.shownOf(member(first, id).titles);
    slowClock();
    const counted = ticker();
    const read = readWhen(id, counted);
    const app = await launch();
    const shown = shownWhen(app, "cache", counted);
    await until(() => member(app, id).titles.kind === "ready", "the saved lists");
    expect(member(app, id).titles).toMatchObject({ from: "cache" });
    expect(shown.at - read.at).toBeGreaterThanOrEqual(20);
    expect(app.shownOf(member(app, id).titles)).toEqual(listed);
  });

  it("shows nothing of a saved list whose row near its end doesn't check out", async () => {
    const panel = await panelFor(BIG, SIZE);
    const id = await added(await launch(), panel, BIG);
    const name = `${id}.titles.json`;
    const envelope = contents(name);
    const movies = envelope.catalogue.movies as Record<string, unknown>[];
    movies[movies.length - 3] = { ...movies[movies.length - 3], streamUrl: "http://x" };
    writeFileSync(pathOf(name), JSON.stringify(envelope));
    slowClock();
    const counted = ticker();
    const from = memory.requests.length;
    const app = await launch();
    const fromCache = shownWhen(app, "cache", counted);
    await until(() => member(app, id).titles.kind === "ready", "the movie lists");
    expect(member(app, id).titles).toMatchObject({ from: "provider" });
    expect(fromCache.at).toBe(-1);
    expect(listsAskedSince(from)).toContain("get_vod_streams");
    expect(member(app, id).live).toMatchObject({ from: "cache" });
  });

  it("shows and keeps nothing of lists checked while their subscription is removed", async () => {
    const panel = await panelFor(BIG, SIZE);
    const id = await added(await launch(), panel, BIG);
    slowClock();
    const counted = ticker();
    const read = readWhen(id, counted);
    const app = await launch();
    const fromCache = shownWhen(app, "cache", counted);
    await until(() => read.at >= 0 && counted.ticks >= read.at + 5, "the rows being checked");
    expect(member(app, id).titles.kind).toBe("idle");
    await app.remove(id, { keepHistory: true });
    await until(() => savedOf(id).length === 0, "its files deleted");
    await settle(300);
    expect(fromCache.at).toBe(-1);
    expect(app.members()).toEqual([]);
    expect(savedOf(id)).toEqual([]);
  });

  it("writes nothing of lists being copied while their subscription is removed", async () => {
    const panel = await panelFor(BIG, SIZE);
    slowClock();
    const app = await launch();
    const counted = ticker();
    const shown = shownWhen(app, "provider", counted);
    const written = writtenWhen(counted);
    const id = await app.add({ server: panel.url, ...BIG });
    if (!id) throw new Error("The add was cancelled");
    await until(() => shown.at >= 0 && counted.ticks >= shown.at + 5, "the copy under way");
    expect(written.has(`${id}.titles.json.next`)).toBe(false);
    await app.remove(id, { keepHistory: true });
    await settle(300);
    expect(written.has(`${id}.titles.json.next`)).toBe(false);
    expect(savedOf(id).filter((name) => name.includes(".titles."))).toEqual([]);
    await until(() => savedOf(id).length === 0, "its files deleted");
  });
});
