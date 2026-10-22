import type { Episode } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { kindOf } from "@mrstreamer/core/ondemand/catalogue";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Live favourites as the app's own owners keep them: account.ts with its registry and Keychain,
// the viewing record in viewing.json, and the favourites as Live, Home and Watch read them
// (favourites.ts). Two of the desktop tests' fake Xtream panels answer over HTTP, the second
// numbering its channels as the first does, and each lists one channel in three qualities
// (stream ids QUALITY_STREAM_IDS to + 2). A test changes what a panel lists and reloads, as a
// provider changing its list does. Documents and the Keychain are kept in memory across launches,
// which re-import the app's modules; the native player records what it is given.

const memory = vi.hoisted(() => ({
  files: new Map<string, string>(),
  keychain: new Map<string, string>(),
  /** Documents whose write fails. */
  full: new Set<string>(),
  /** What the player was given, in order. */
  played: [] as string[],
}));

vi.mock("react-native", () => ({ Alert: { alert: () => undefined } }));
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
  setItemAsync: async (key: string, value: string) => void memory.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void memory.keychain.delete(key),
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

/** What these tests use of the desktop tests' fake panel. */
interface FakeChannel {
  readonly streamId: number;
  readonly name: string;
  readonly categoryId: string;
  readonly guideId: string | null;
}
interface FakeProvider {
  readonly url: string;
  serveChannels(select: (all: readonly FakeChannel[]) => readonly FakeChannel[]): void;
  failCatalogue(status: number | null): void;
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider, QUALITY_STREAM_IDS } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
    readonly second?: boolean;
  }): Promise<FakeProvider>;
  QUALITY_STREAM_IDS: number;
};
/** The channel in Full HD, HD and SD, by its streams' ids. */
const [FHD, HD, SD] = [0, 1, 2].map((at) => String(QUALITY_STREAM_IDS + at)) as [
  string,
  string,
  string,
];

let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ username: "one", password: "one+Pw@1", channels: 40, titles: 4 }),
    startFakeProvider({
      username: "two",
      password: "two+Pw@2",
      channels: 40,
      titles: 4,
      second: true,
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});
// The app's modules compile once, here, rather than within the first test's own time.
beforeAll(async () => {
  await import("../src/account.ts");
});

const ONE = { username: "one", password: "one+Pw@1" };
const TWO = { username: "two", password: "two+Pw@2" };

/** Resolves once `ready` holds; fails the test when it doesn't within a few seconds. */
async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 8_000) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

/** The app as a launch starts it: fresh modules over the same Documents and Keychain. */
async function launch() {
  vi.resetModules();
  const account = await import("../src/account.ts");
  const viewing = await import("../src/viewing.ts");
  const favourites = await import("../src/favourites.ts");
  const titles = await import("../src/titles.ts");
  await account.restore();
  // The account's names last: its `retry` is a subscription's.
  return { ...titles, ...viewing, ...favourites, ...account };
}
type App = Awaited<ReturnType<typeof launch>>;

/** The favourites as Live, Home and Watch read them now. */
const listOf = (app: App) =>
  app.favouriteList(app.currentViewing(), app.currentCatalogue(), app.members());
/** The keys of the favourites that open, in order. */
const shown = (app: App) => listOf(app)?.shown.map(({ channel }) => channel.key) ?? [];
const hidden = (app: App) =>
  listOf(app)?.hidden.map(({ subscriptionId, why, count }) => ({ subscriptionId, why, count }));
/** The stream ids a subscription's record keeps as favourites, as viewing.json holds them. */
const stored = (id: string): readonly string[] =>
  JSON.parse(memory.files.get("/documents/viewing.json") ?? "{}").accounts?.[id]?.state
    ?.favourites ?? [];

/** One of `subscriptionId`'s channels as Live lists it, by any of its streams' ids. */
function channelOf(app: App, subscriptionId: string, id: string) {
  const now = app.currentCatalogue();
  const channel =
    now.kind === "ready" ? now.library.byKey.get(`${subscriptionId}:${id}`) : undefined;
  if (!channel) throw new Error(`No channel ${id} from ${subscriptionId}`);
  return channel;
}
const listsBoth = (app: App) => {
  const now = app.currentCatalogue();
  return now.kind === "ready" && now.library.labels.size === 2;
};

/** A launch with both panels saved and their channels shown. */
async function twoProviders() {
  const app = await launch();
  const a = await app.add({ server: one.url, ...ONE });
  const b = await app.add({ server: two.url, ...TWO, name: "Cabin" });
  if (!a || !b) throw new Error("An add was cancelled");
  await until(() => listsBoth(app), "both channel lists");
  return { app, a, b };
}

/** Stars or unstars a channel as a row or Watch does; resolves once the record is read again. */
async function star(app: App, channel: OwnedId, favourite = true) {
  await app.setFavourite(channel, favourite);
}

const libraryOf = (app: App) => {
  const now = app.currentCatalogue();
  return now.kind === "ready" ? now.library : null;
};

/** The channel list saved on the phone for `id`, which a relaunch shows. */
const cachedList = (id: string) => memory.files.get(`/cache/catalogues/${id}.live.json`);

/**
 * Reloads `id`'s channels as its panel lists them now, and waits for Live to show them and for
 * the list to be saved on the phone, so a relaunch after shows it too.
 */
async function reloaded(app: App, id: string) {
  const before = libraryOf(app);
  const saved = cachedList(id);
  app.reloadChannels(id);
  await until(() => libraryOf(app) !== before && app.channelsWorkedOut(), "the new list");
  await until(() => cachedList(id) !== saved, "the new list saved");
}

/** Has `panel` list only the streams `listed` keeps, then reloads `id`'s channels. */
async function relist(app: App, id: string, panel: FakeProvider, listed: (id: string) => boolean) {
  panel.serveChannels((all) => all.filter((each) => listed(String(each.streamId))));
  await reloaded(app, id);
}
const without =
  (...ids: string[]) =>
  (id: string) =>
    !ids.includes(id);

/** Has `panel` list the channels `select` makes of all it has, then reloads `id`'s channels. */
async function relistAs(
  app: App,
  id: string,
  panel: FakeProvider,
  select: (all: readonly FakeChannel[]) => readonly FakeChannel[],
) {
  panel.serveChannels(select);
  await reloaded(app, id);
}
/** A relaunch, once Live shows both providers' channels as saved on the phone, and the record. */
async function relaunch(count = 2) {
  const app = await launch();
  await until(() => {
    const now = app.currentCatalogue();
    return (
      now.kind === "ready" && now.library.labels.size === count && app.currentViewing() !== null
    );
  }, "the saved lists");
  // The record is read again once the channels show.
  await new Promise((done) => setTimeout(done, 50));
  return app;
}
/** The panel's channels with stream 1001 another quality of the channel in three. */
const withUhd = (all: readonly FakeChannel[]) => {
  const fhd = all.find((each) => String(each.streamId) === FHD);
  if (!fhd) throw new Error("No Full HD stream");
  return all.map((each) =>
    each.streamId === 1001
      ? { ...each, name: "BE | KWALITEIT 1 UHD", categoryId: fhd.categoryId, guideId: fhd.guideId }
      : each,
  );
};
/** viewing.json as written. */
const file = () => JSON.parse(memory.files.get("/documents/viewing.json") ?? "{}");
const ids = (app: App) =>
  app.currentViewing()?.favourites.map((each) => `${each.subscriptionId}:${each.id}`);

beforeEach(() => {
  memory.files.clear();
  memory.keychain.clear();
  memory.full.clear();
  memory.played.length = 0;
  for (const panel of [one, two]) {
    panel.serveChannels((all) => all);
    panel.failCatalogue(null);
  }
});

describe("starring channels", () => {
  it("keeps one favourite per channel and provider, in the order starred, after a relaunch", async () => {
    const { app, a, b } = await twoProviders();
    const quality = channelOf(app, a, HD);
    // Starred through its HD stream: the one channel, with every quality it lists.
    await star(app, { subscriptionId: a, id: HD });
    // The other provider's channel under the very same stream ids is a favourite of its own.
    await star(app, channelOf(app, b, FHD));
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 3, "three favourites");
    expect(shown(app)).toEqual([quality.key, `${b}:${FHD}`, `${a}:1000`]);
    expect(quality.key).toBe(`${a}:${FHD}`);
    expect(stored(a)).toEqual([FHD, HD, SD, "1000"]);
    expect(stored(b)).toEqual([FHD, HD, SD]);
    expect(memory.played).toEqual([]);

    const again = await launch();
    await until(() => listsBoth(again) && shown(again).length === 3, "the favourites again");
    expect(shown(again)).toEqual([`${a}:${FHD}`, `${b}:${FHD}`, `${a}:1000`]);

    await star(again, channelOf(again, b, SD), false);
    await until(() => shown(again).length === 2, "one fewer");
    expect(shown(again)).toEqual([`${a}:${FHD}`, `${a}:1000`]);
    expect(stored(b)).toEqual([]);
    expect(stored(a)).toEqual([FHD, HD, SD, "1000"]);
  });

  it("leaves the record as it was when viewing.json won't take a change", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 1, "the favourite");
    const before = memory.files.get("/documents/viewing.json");
    memory.full.add("viewing.json");
    await expect(star(app, channelOf(app, a, "1001"))).rejects.toThrow();
    await expect(star(app, channelOf(app, a, "1000"), false)).rejects.toThrow();
    expect(memory.files.get("/documents/viewing.json")).toBe(before);
    expect(shown(app)).toEqual([`${a}:1000`]);

    memory.full.clear();
    const again = await launch();
    await until(() => shown(again).length === 1, "the favourite after a relaunch");
    expect(shown(again)).toEqual([`${a}:1000`]);
  });
});

describe("a provider listing its channels otherwise", () => {
  it("keeps a channel one favourite as its qualities come and go", async () => {
    const { app, a } = await twoProviders();
    // Starred while the provider listed only HD and SD.
    await relist(app, a, one, without(FHD));
    await star(app, channelOf(app, a, SD));
    await until(() => shown(app).length === 1, "the favourite");
    expect(shown(app)).toEqual([`${a}:${HD}`]);
    expect(stored(a)).toEqual([HD, SD]);

    // Full HD listed again: the same favourite, now by the channel's lowest stream.
    await relist(app, a, one, () => true);
    await until(() => shown(app)[0] === `${a}:${FHD}`, "the channel with Full HD");
    expect(shown(app)).toEqual([`${a}:${FHD}`]);
    expect(hidden(app)).toEqual([]);

    // HD gone: the stream saved stays saved, still the same one favourite, nothing hidden.
    await relist(app, a, one, without(HD));
    expect(shown(app)).toEqual([`${a}:${FHD}`]);
    expect(hidden(app)).toEqual([]);
    expect(stored(a)).toEqual([HD, SD]);
  });

  it("keeps favourites no list shows in their places while the rest are rearranged", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, b, "1000"));
    await until(() => shown(app).length === 3, "three favourites");

    await relist(app, a, one, without(FHD, HD, SD));
    await until(() => shown(app).length === 2, "the channel gone");
    expect(hidden(app)).toEqual([{ subscriptionId: a, why: "not-listed", count: null }]);
    // A failed reload keeps the list that showed, and the favourites with it.
    one.failCatalogue(503);
    app.reloadChannels(a);
    await until(() => app.members()[0]?.live.kind === "failed", "the failure");
    expect(shown(app)).toEqual([`${a}:1000`, `${b}:1000`]);

    const list = listOf(app);
    if (!list) throw new Error("No favourites");
    await app.reorderFavourites({
      original: list.original,
      order: list.shown.map((each) => each.saved).toReversed(),
    });
    await until(() => shown(app)[0] === `${b}:1000`, "the new order");
    expect(stored(a)).toEqual([FHD, HD, SD, "1000"]);

    one.failCatalogue(null);
    await relist(app, a, one, () => true);
    await until(() => shown(app).length === 3, "the channel back");
    expect(shown(app)).toEqual([`${a}:${FHD}`, `${b}:1000`, `${a}:1000`]);
    expect(memory.played).toEqual([]);
  });

  it("refuses an order made from favourites that changed since, moving nothing", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, b, "1000"));
    await until(() => shown(app).length === 2, "two favourites");
    const list = listOf(app);
    if (!list) throw new Error("No favourites");
    await star(app, channelOf(app, a, "1001"));
    await expect(
      app.reorderFavourites({
        original: list.original,
        order: list.shown.map((each) => each.saved).toReversed(),
      }),
    ).rejects.toMatchObject({ error: { kind: "favourites-changed" } });
    expect(shown(app)).toEqual([`${a}:1000`, `${b}:1000`, `${a}:1001`]);

    // And one viewing.json won't take leaves the order as it was.
    memory.full.add("viewing.json");
    const now = listOf(app);
    if (!now) throw new Error("No favourites");
    await expect(
      app.reorderFavourites({
        original: now.original,
        order: now.shown.map((each) => each.saved).toReversed(),
      }),
    ).rejects.toThrow();
    expect(shown(app)).toEqual([`${a}:1000`, `${b}:1000`, `${a}:1001`]);
  });
});

describe("a provider's favourites as it comes and goes", () => {
  it("opens none of a provider that needs its password, keeping them and their places", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, b, "1000"));
    await until(() => shown(app).length === 2, "two favourites");
    memory.keychain.delete(`s.${a}`);

    const again = await launch();
    await until(
      () => again.members()[0]?.needsSecret === true && shown(again).length === 1,
      "the password asked for",
    );
    expect(shown(again)).toEqual([`${b}:1000`]);
    expect(hidden(again)).toEqual([{ subscriptionId: a, why: "needs-secret", count: null }]);
    expect(stored(a)).toEqual(["1000"]);
    expect(memory.played).toEqual([]);
  });

  it("brings a provider's favourites back with it when removed with its history kept", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, b, "1000"));
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 2, "two favourites");

    await app.remove(b, { keepHistory: true });
    await until(() => shown(app).length === 1, "the other's favourites");
    expect(shown(app)).toEqual([`${a}:1000`]);
    expect(stored(b)).toEqual(["1000"]);

    const back = await app.add({ server: two.url, ...TWO });
    expect(back).toBe(b);
    await until(() => listsBoth(app) && shown(app).length === 2, "its favourites back");
    expect(shown(app)).toEqual([`${b}:1000`, `${a}:1000`]);
  });

  it("erases only that provider's favourites when its history goes with it", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, b, "1000"));
    await star(app, channelOf(app, a, "1000"));
    await until(() => shown(app).length === 2, "two favourites");

    await app.remove(b, { keepHistory: false });
    await until(() => shown(app).length === 1, "the other's favourites");
    expect(stored(b)).toEqual([]);
    expect(stored(a)).toEqual(["1000"]);

    const back = await app.add({ server: two.url, ...TWO });
    if (!back) throw new Error("The add was cancelled");
    await until(() => listsBoth(app), "both lists");
    expect(shown(app)).toEqual([`${a}:1000`]);
  });
});

describe("a favourite's streams, remembered", () => {
  it("unstars a favourite whole while a quality is gone, before or after a relaunch, for good", async () => {
    for (const relaunchFirst of [true, false]) {
      memory.files.clear();
      memory.keychain.clear();
      one.serveChannels((all) => all);
      const { app, a, b } = await twoProviders();
      await star(app, channelOf(app, a, FHD));
      await star(app, channelOf(app, b, FHD));
      await relist(app, a, one, without(FHD));
      await until(() => shown(app).length === 2, "both favourites");
      expect(shown(app)).toEqual([`${a}:${HD}`, `${b}:${FHD}`]);

      const then = relaunchFirst ? await relaunch() : app;
      expect(shown(then)).toEqual([`${a}:${HD}`, `${b}:${FHD}`]);
      await star(then, channelOf(then, a, HD), false);
      expect(stored(a)).toEqual([]);
      expect(stored(b)).toEqual([FHD, HD, SD]);

      // Full HD back, after a relaunch: the favourite stays gone.
      one.serveChannels((all) => all);
      const later = await relaunch();
      await relist(later, a, one, () => true);
      expect(shown(later)).toEqual([`${b}:${FHD}`]);
      expect(stored(a)).toEqual([]);
      expect(memory.played).toEqual([]);
    }
  });

  it("keeps an order made while a quality was gone, with every stream moving together", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, b, FHD));
    await relist(app, a, one, without(FHD));
    const absent = await relaunch();
    const list = absent.currentFavourites();
    if (!list) throw new Error("No favourites");
    expect(list.shown.map(({ channel }) => channel.key)).toEqual([`${a}:${HD}`, `${b}:${FHD}`]);
    await absent.reorderFavourites({
      original: list.original,
      order: list.shown.map(({ saved }) => saved).toReversed(),
    });
    const still = await relaunch();
    expect(shown(still)).toEqual([`${b}:${FHD}`, `${a}:${HD}`]);
    await relist(still, a, one, () => true);
    const restored = await relaunch();
    // Exactly one of it, after the other, whichever quality names it now.
    expect(ids(restored)).toEqual([`${b}:${FHD}`, `${a}:${FHD}`]);
    expect(hidden(restored)).toEqual([]);
  });

  it("leaves every other favourite, hidden or not, unknown or the other provider's, in its place", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, "1000"));
    await star(app, channelOf(app, a, FHD));
    // A stream no list ever named, as an older build could have kept.
    await star(app, { subscriptionId: a, id: "999999" });
    await star(app, channelOf(app, b, "1000"));
    await star(app, channelOf(app, b, FHD));
    await relist(app, a, one, without(FHD, "1000"));
    await relist(app, b, two, without("1000"));
    const absent = await relaunch();
    const list = absent.currentFavourites();
    if (!list) throw new Error("No favourites");
    expect(list.shown.map(({ channel }) => channel.key)).toEqual([`${a}:${HD}`, `${b}:${FHD}`]);
    await absent.reorderFavourites({
      original: list.original,
      order: list.shown.map(({ saved }) => saved).toReversed(),
    });
    await star(absent, channelOf(absent, a, HD), false);

    one.serveChannels((all) => all);
    two.serveChannels((all) => all);
    const back = await relaunch();
    await relist(back, a, one, () => true);
    await relist(back, b, two, () => true);
    expect(ids(back)).toEqual([`${a}:1000`, `${b}:${FHD}`, `${a}:999999`, `${b}:1000`]);
    // The other provider's channel moved ahead of its own hidden one, every stream of it.
    expect(stored(b)).toEqual([FHD, HD, SD, "1000"]);
  });

  it("keeps a quality seen later as the favourite, once its first ones are gone", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    // The provider lists another quality of it, stream 1001, which names the channel now.
    await relistAs(app, a, one, withUhd);
    expect(channelOf(app, a, FHD).id).toBe("1001");
    const seen = await relaunch();
    // Only the new quality is left.
    await relistAs(seen, a, one, (all) =>
      withUhd(all).filter((each) => ![FHD, HD, SD].includes(String(each.streamId))),
    );
    const left = await relaunch();
    expect(shown(left)).toEqual([`${a}:1001`]);
    await star(left, channelOf(left, a, "1001"), false);
    expect(stored(a)).toEqual([]);
    await relist(left, a, one, () => true);
    expect(shown(left)).toEqual([]);
  });

  it("follows the channels listed now when they split, and joins only what one channel lists", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    // HD becomes a channel of its own and SD goes.
    const split = (all: readonly FakeChannel[]) =>
      all.flatMap((each) =>
        String(each.streamId) === SD
          ? []
          : String(each.streamId) === HD
            ? [{ ...each, name: "BE | ANDERS 2 HD" }]
            : [each],
      );
    await relistAs(app, a, one, split);
    expect(shown(app)).toEqual([`${a}:${FHD}`, `${a}:${HD}`]);
    expect(hidden(app)).toEqual([{ subscriptionId: a, why: "not-listed", count: null }]);
    // Taking out the HD channel takes out its stream alone.
    await star(app, channelOf(app, a, HD), false);
    expect(stored(a)).toEqual([FHD, SD]);
    // With only that other channel listed, after a relaunch, SD doesn't go with it.
    await relistAs(app, a, one, (all) =>
      split(all).filter((each) => String(each.streamId) !== FHD),
    );
    const apart = await relaunch();
    expect(shown(apart)).toEqual([]);
    expect(ids(apart)).toEqual([`${a}:${FHD}`, `${a}:${SD}`]);
    // One channel listing them together again makes them one.
    await relist(apart, a, one, () => true);
    expect(ids(apart)).toEqual([`${a}:${FHD}`]);
    expect(shown(apart)).toEqual([`${a}:${FHD}`]);
  });
});

describe("two favourites one channel lists together", () => {
  it("are one only once a channel joins them, never by a name alone", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, a, "1001"));
    // Its name alone: still a channel, and a favourite, of its own.
    await relistAs(app, a, one, (all) =>
      all.map((each) =>
        each.streamId === 1001 ? { ...each, name: "BE | KWALITEIT 1 UHD" } : each,
      ),
    );
    expect(shown(app)).toEqual([`${a}:${FHD}`, `${a}:1001`]);
    // Listed as one channel: one favourite, whose star takes out every stream of both.
    await relistAs(app, a, one, withUhd);
    expect(shown(app)).toEqual([`${a}:1001`]);
    const joined = await relaunch();
    expect(shown(joined)).toEqual([`${a}:1001`]);
    await star(joined, channelOf(joined, a, "1001"), false);
    expect(stored(a)).toEqual([]);
  });
});

describe("a favourite's change, written", () => {
  it("is in the file when it answers, from the first change after a launch", async () => {
    const { a } = await twoProviders();
    const app = await relaunch();
    const starring = app.setFavourite(channelOf(app, a, FHD), true);
    expect(stored(a)).toEqual([FHD, HD, SD]);
    await starring;
    await star(app, channelOf(app, a, "1000"));
    const list = app.currentFavourites();
    if (!list) throw new Error("No favourites");
    const moving = app.reorderFavourites({
      original: list.original,
      order: list.shown.map(({ saved }) => saved).toReversed(),
    });
    expect(stored(a)).toEqual(["1000", FHD, HD, SD]);
    await moving;
  });

  it("rejects, changing nothing, when the file won't take it, and goes through when tried again", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, b, FHD));
    await relist(app, a, one, without(FHD));
    const before = memory.files.get("/documents/viewing.json");
    memory.full.add("viewing.json");
    const list = app.currentFavourites();
    if (!list) throw new Error("No favourites");
    let adding: Promise<void> | null = null;
    expect(() => (adding = app.setFavourite(channelOf(app, a, "1000"), true))).not.toThrow();
    await expect(adding).rejects.toThrow();
    await expect(app.setFavourite(channelOf(app, a, HD), false)).rejects.toThrow();
    await expect(
      app.reorderFavourites({
        original: list.original,
        order: list.shown.map(({ saved }) => saved).toReversed(),
      }),
    ).rejects.toThrow();
    await expect(app.eraseViewing(b)).rejects.toThrow();
    expect(memory.files.get("/documents/viewing.json")).toBe(before);

    memory.full.clear();
    const again = await relaunch();
    expect(memory.files.get("/documents/viewing.json")).toBe(before);
    expect(shown(again)).toEqual([`${a}:${HD}`, `${b}:${FHD}`]);
    await star(again, channelOf(again, a, HD), false);
    expect(stored(a)).toEqual([]);
    await star(again, channelOf(again, a, "1000"));
    expect(shown(again)).toEqual([`${b}:${FHD}`, `${a}:1000`]);
  });

  it("keeps what a refused change would have remembered out of later writes", async () => {
    const { app, a } = await twoProviders();
    memory.full.add("viewing.json");
    await expect(app.setFavourite(channelOf(app, a, FHD), true)).rejects.toThrow();
    memory.full.clear();
    await app.recordProgress({ kind: "movie", subscriptionId: a, id: "1" }, 60, 600, Date.now());
    expect(stored(a)).toEqual([]);
    expect(file().favouriteMembership).toBeUndefined();
  });

  it("writes a grouping the catalogue shows with the next write when the file refused it", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    memory.full.add("viewing.json");
    await relistAs(app, a, one, withUhd);
    const cohort = () => file().favouriteMembership?.accounts?.[a]?.[0] ?? [];
    // Not in the file yet: a relaunch now wouldn't know it.
    expect(cohort()).not.toContain("1001");
    memory.full.clear();
    await app.recordProgress({ kind: "movie", subscriptionId: a, id: "1" }, 60, 600, Date.now());
    expect(cohort()).toContain("1001");
  });
});

/** A series of `a`'s with an episode, as its details list it, for a mark. */
async function episodeOf(app: App, a: string) {
  await until(() => app.titleLists().kind === "ready", "the title lists");
  const lists = app.titleLists();
  if (lists.kind !== "ready") throw new Error("No lists");
  for (const show of kindOf(lists.index, "series").titles) {
    const version = show.versions.find((each) => each.subscriptionId === a);
    if (!version) continue;
    const title = { ...show, subscriptionId: a, id: version.id };
    const details = await app.detailsOf(title);
    if (details.kind !== "series") continue;
    const episode: Episode | undefined = details.seasons.flatMap((season) => season.episodes)[0];
    if (episode) return { title, episode };
  }
  throw new Error("No series with an episode");
}

describe("other writes of the record", () => {
  it("keep the favourites' memory, and their own results", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await relist(app, a, one, without(FHD));
    const memoryBefore = file().favouriteMembership;
    const { title, episode } = await episodeOf(app, a);
    const lists = app.titleLists();
    if (lists.kind !== "ready") throw new Error("No lists");
    const [first, second] = kindOf(lists.index, "movie").titles.filter((each) =>
      each.versions.some((version) => version.subscriptionId === a),
    );
    if (!first || !second) throw new Error("Too few movies");
    const versionOf = (movie: typeof first) => {
      const version = movie.versions.find((each) => each.subscriptionId === a);
      if (!version) throw new Error("No version of the first provider's");
      return { kind: "movie" as const, subscriptionId: a, id: version.id };
    };
    const mark = await app.markEpisode(
      {
        kind: "episode",
        subscriptionId: a,
        id: episode.id,
        seriesId: episode.seriesId,
        season: episode.season,
        episode: episode.number,
      },
      true,
    );
    await app.relist({ subscriptionId: a, id: title.id }, title);
    await app.recordProgress(versionOf(first), 300, 600, Date.now());
    await app.removeFromContinue(first);
    await app.recordProgress(versionOf(second), 300, 600, Date.now());
    expect(file().favouriteMembership).toEqual(memoryBefore);
    const again = await relaunch();
    const progress = await again.progressOf({ movies: [versionOf(second)] });
    expect(progress.map((each) => each.position)).toEqual([300]);
    expect(again.currentViewing()?.continueWatching.map((each) => each.title.id)).toEqual([
      versionOf(second).id,
    ]);
    expect((await again.seriesViewing({ subscriptionId: a, id: title.id })).marks).toEqual([mark]);
    await star(again, channelOf(again, a, HD), false);
    expect(stored(a)).toEqual([]);
  });
});

describe("a provider removed and added again", () => {
  it("brings its favourite back whole with it, and erasing takes only its memory", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, b, FHD));
    await relist(app, a, one, without(FHD));
    await app.remove(a, { keepHistory: true });
    expect(file().favouriteMembership.accounts[a]).toBeDefined();
    const later = await relaunch(1);
    const back = await later.add({ server: one.url, ...ONE });
    expect(back).toBe(a);
    await until(() => listsBoth(later) && shown(later).length === 2, "its favourite back");
    expect(shown(later)).toEqual([`${a}:${HD}`, `${b}:${FHD}`]);

    // Erasing the other provider's history, refused once and done at the next launch.
    memory.full.add("viewing.json");
    await expect(later.remove(b, { keepHistory: false })).rejects.toThrow();
    expect(stored(b)).toEqual([FHD, HD, SD]);
    memory.full.clear();
    const erased = await relaunch(1);
    expect(stored(b)).toEqual([]);
    expect(file().favouriteMembership.accounts[b]).toBeUndefined();
    expect(file().favouriteMembership.accounts[a]).toBeDefined();
    await star(erased, channelOf(erased, a, HD), false);
    expect(stored(a)).toEqual([]);
  });
});

describe("viewing.json from another build", () => {
  it("captures only what the channels show of a file without the memory, keeping the rest", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, { subscriptionId: a, id: "999999" });
    const written = file();
    delete written.favouriteMembership;
    memory.files.set("/documents/viewing.json", JSON.stringify(written));
    const older = await relaunch();
    expect(file().favouriteMembership.accounts[a]).toEqual([[FHD, HD, SD]]);
    expect(ids(older)).toEqual([`${a}:${FHD}`, `${a}:999999`]);
    expect(file().accounts[a].state).toEqual(written.accounts[a].state);
  });

  it("carries a memory it can't read as it is, going by the channels alone", async () => {
    for (const unread of [
      { version: 2, accounts: { anything: true } },
      { version: 1, accounts: { someone: [["only-one"]] } },
    ]) {
      memory.files.clear();
      memory.keychain.clear();
      one.serveChannels((all) => all);
      const { app, a } = await twoProviders();
      await star(app, channelOf(app, a, FHD));
      memory.files.set(
        "/documents/viewing.json",
        JSON.stringify({ ...file(), favouriteMembership: unread }),
      );
      const other = await relaunch();
      await relist(other, a, one, without(FHD));
      // As before this memory: the stream gone shows apart.
      expect(hidden(other)).toEqual([{ subscriptionId: a, why: "not-listed", count: null }]);
      await other.recordProgress({ kind: "movie", subscriptionId: a, id: "1" }, 60, 600, 1);
      expect(file().favouriteMembership).toEqual(unread);
      expect(stored(a)).toEqual([FHD, HD, SD]);
    }
  });
});

describe("a stream a panel lists in two of its channels", () => {
  it("stays one favourite's, so a quality gone and back across relaunches brings nothing back", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    // HD's and SD's rows again in another category: two channels list those streams.
    await relistAs(app, a, one, (all) => [
      ...all,
      ...all
        .filter((each) => [HD, SD].includes(String(each.streamId)))
        .map((each) => ({ ...each, categoryId: "16" })),
    ]);
    expect(channelOf(app, a, HD).id).not.toBe(channelOf(app, a, FHD).id);
    /** The memory as written, each cohort's ids in order: every id in one of them only. */
    const remembered = () =>
      (file().favouriteMembership?.accounts?.[a] ?? []).map((cohort: string[]) =>
        cohort.toSorted(),
      );
    expect(remembered()).toEqual([[FHD, HD, SD]]);
    // An ordinary write after keeps it as it is.
    await app.recordProgress({ kind: "movie", subscriptionId: a, id: "1" }, 300, 600, Date.now());
    expect(remembered()).toEqual([[FHD, HD, SD]]);

    // The panel's usual list again, without Full HD, after a relaunch with that file.
    one.serveChannels((all) => all);
    const again = await relaunch();
    await relist(again, a, one, without(FHD));
    expect(shown(again)).toEqual([`${a}:${HD}`]);
    await star(again, channelOf(again, a, HD), false);
    expect(stored(a)).toEqual([]);
    await relist(again, a, one, () => true);
    const last = await relaunch();
    expect(shown(last)).toEqual([]);
    expect(stored(a)).toEqual([]);
    expect(memory.played).toEqual([]);
  });
});

describe("a quality gone while another's row is listed twice", () => {
  /** The panel's channels with the rows of `ids` listed again in category `categoryId`. */
  const repeating =
    (categoryId: string, ...ids: string[]) =>
    (all: readonly FakeChannel[]) => [
      ...all,
      ...all
        .filter((each) => ids.includes(String(each.streamId)))
        .map((each) => ({ ...each, categoryId })),
    ];
  const remembered = (a: string) =>
    (file().favouriteMembership?.accounts?.[a] ?? []).map((cohort: string[]) => cohort.toSorted());

  it("keeps the quality gone with the favourite, so unstarring it then takes it out for good", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, b, FHD));
    await relist(app, a, one, without(SD));
    // SD still gone; HD's row listed again in another category.
    await relistAs(app, a, one, (all) =>
      repeating("16", HD)(all.filter((each) => String(each.streamId) !== SD)),
    );
    expect(channelOf(app, a, HD).id).not.toBe(channelOf(app, a, FHD).id);
    expect(remembered(a)).toEqual([[FHD, HD, SD]]);

    // The panel's usual list again, SD still gone, after a relaunch; unstarred there.
    one.serveChannels((all) => all.filter((each) => String(each.streamId) !== SD));
    const again = await relaunch();
    await relist(again, a, one, without(SD));
    expect(shown(again)).toEqual([`${a}:${FHD}`, `${b}:${FHD}`]);
    await star(again, channelOf(again, a, FHD), false);
    expect(stored(a)).toEqual([]);
    // SD back, after a relaunch: nothing of it comes back, and the other provider's stays.
    one.serveChannels((all) => all);
    const back = await relaunch();
    await relist(back, a, one, () => true);
    const last = await relaunch();
    expect(shown(last)).toEqual([`${b}:${FHD}`]);
    expect(stored(a)).toEqual([]);
    expect(stored(b)).toEqual([FHD, HD, SD]);
    expect(memory.played).toEqual([]);
  });

  it("keeps it too when rows sharing its streams are listed in two more categories", async () => {
    const { app, a } = await twoProviders();
    await star(app, channelOf(app, a, FHD));
    await relist(app, a, one, without(SD));
    // FHD's and HD's rows in one category, HD's again in another: channels sharing HD.
    await relistAs(app, a, one, (all) =>
      repeating(
        "17",
        HD,
      )(repeating("16", FHD, HD)(all.filter((each) => String(each.streamId) !== SD))),
    );
    expect(channelOf(app, a, HD).id).not.toBe(channelOf(app, a, FHD).id);
    expect(remembered(a)).toEqual([[FHD, HD, SD]]);
    one.serveChannels((all) => all);
    const back = await relaunch();
    await relist(back, a, one, () => true);
    expect(shown(back)).toEqual([`${a}:${FHD}`]);
    await star(back, channelOf(back, a, SD), false);
    expect(stored(a)).toEqual([]);
  });
});

describe("two channels of one id, one linking the others", () => {
  const UHD = "1001";
  /** The panel's channels in four qualities, without SD. */
  const usual = (all: readonly FakeChannel[]) =>
    withUhd(all).filter((each) => String(each.streamId) !== SD);
  /**
   * UHD's and FHD's rows in Kwaliteit, UHD's again and HD's in category 16, HD's again in 17,
   * SD gone: two channels named 1001, one sharing UHD with the first and HD with the third.
   */
  const repeated = (all: readonly FakeChannel[]) => {
    const rows = usual(all);
    const row = (id: string) => rows.find((each) => String(each.streamId) === id);
    const uhd = row(UHD);
    const hd = row(HD);
    if (!uhd || !hd) throw new Error("No UHD or HD row");
    return [
      ...rows.map((each) => (String(each.streamId) === HD ? { ...each, categoryId: "16" } : each)),
      { ...uhd, categoryId: "16" },
      { ...hd, categoryId: "17" },
    ];
  };
  // Sorted as strings: "1001" after "100002".
  const remembered = (a: string) =>
    (file().favouriteMembership?.accounts?.[a] ?? []).map((cohort: string[]) => cohort.toSorted());
  const streamsOf = (app: App, a: string, id: string) => {
    const channel = channelOf(app, a, id);
    return { id: channel.id, streams: channel.variants.map((each) => each.id).toSorted() };
  };

  it("keeps a quality gone with the favourite, so unstarring it then takes it out for good", async () => {
    const { app, a, b } = await twoProviders();
    await relistAs(app, a, one, withUhd);
    await star(app, channelOf(app, a, FHD));
    await star(app, channelOf(app, b, FHD));
    expect(stored(a).toSorted()).toEqual([FHD, HD, SD, UHD]);
    await relistAs(app, a, one, usual);
    expect(remembered(a)).toEqual([[FHD, HD, SD, UHD]]);

    // Seen twice, each a new list: SD stays with the favourite.
    for (let pass = 0; pass < 2; pass++) {
      await relistAs(app, a, one, repeated);
      expect(streamsOf(app, a, FHD)).toEqual({ id: UHD, streams: [FHD, UHD] });
      expect(streamsOf(app, a, UHD)).toEqual({ id: UHD, streams: [HD, UHD] });
      expect(streamsOf(app, a, HD)).toEqual({ id: HD, streams: [HD] });
      expect(remembered(a)).toEqual([[FHD, HD, SD, UHD]]);
    }

    // The usual list again, SD still gone, after a relaunch; unstarred there.
    one.serveChannels(usual);
    const again = await relaunch();
    await relistAs(again, a, one, usual);
    expect(remembered(a)).toEqual([[FHD, HD, SD, UHD]]);
    expect(shown(again)).toEqual([`${a}:${UHD}`, `${b}:${FHD}`]);
    await star(again, channelOf(again, a, FHD), false);
    expect(stored(a)).toEqual([]);

    // SD back, after a relaunch: nothing of it comes back, and the other provider's stays.
    one.serveChannels(withUhd);
    const back = await relaunch();
    await relistAs(back, a, one, withUhd);
    const last = await relaunch();
    expect(shown(last)).toEqual([`${b}:${FHD}`]);
    expect(stored(a)).toEqual([]);
    expect(stored(b)).toEqual([FHD, HD, SD]);
    expect(memory.played).toEqual([]);
  });
});

describe("a memory this build can't read, when a provider's history is deleted", () => {
  const registered = () => JSON.parse(memory.files.get("/documents/subscriptions.json") ?? "{}");
  const unreadable = (a: string, b: string) => [
    { version: 2, accounts: { [a]: [[FHD, HD, SD]], [b]: [[FHD, HD]] } },
    { version: 1, accounts: { [a]: [[FHD]], [b]: [[FHD, HD, SD]] } },
  ];
  /** viewing.json with `unread` as its memory, then a relaunch with both providers. */
  async function withUnread(unread: unknown) {
    memory.files.set(
      "/documents/viewing.json",
      JSON.stringify({ ...file(), favouriteMembership: unread }),
    );
    return relaunch();
  }

  it("goes with it once the deletion is written, kept through other writes until then", async () => {
    for (const at of [0, 1]) {
      memory.files.clear();
      memory.keychain.clear();
      const { app, a, b } = await twoProviders();
      await star(app, channelOf(app, a, FHD));
      await star(app, channelOf(app, b, FHD));
      await app.recordProgress({ kind: "movie", subscriptionId: b, id: "1" }, 300, 600, 1);
      const unread = unreadable(a, b)[at];
      const again = await withUnread(unread);
      const bBefore = file().accounts[b];

      // Other writes, and a removal keeping history, carry it as it is.
      await again.recordProgress({ kind: "movie", subscriptionId: a, id: "1" }, 300, 600, 1);
      expect(file().favouriteMembership).toEqual(unread);
      await again.remove(b, { keepHistory: true });
      expect(file().favouriteMembership).toEqual(unread);
      expect(await again.add({ server: two.url, ...TWO, name: "Cabin" })).toBe(b);
      await until(() => listsBoth(again), "both lists again");

      // The deletion refused: nothing goes, and it is left to the next launch.
      memory.full.add("viewing.json");
      await expect(again.remove(a, { keepHistory: false })).rejects.toThrow();
      expect(file().favouriteMembership).toEqual(unread);
      expect(stored(a)).toEqual([FHD, HD, SD]);
      expect(registered().erasing).toEqual([a]);

      // The next launch deletes it: a's record and the whole memory, b's record as it was.
      memory.full.clear();
      const later = await relaunch(1);
      expect(registered().erasing).toEqual([]);
      expect(file().accounts[a]).toBeUndefined();
      expect(file().favouriteMembership).toBeUndefined();
      expect(file().accounts[b].state).toEqual(bBefore.state);
      expect(file().accounts[b].rows).toEqual(bBefore.rows);

      // Nothing brings it back: a later write, a favourite, or a relaunch.
      await later.recordProgress({ kind: "movie", subscriptionId: b, id: "2" }, 300, 600, 1);
      await star(later, channelOf(later, b, "1000"));
      expect(file().favouriteMembership).toBeUndefined();
      // Read with none, the next launch remembers again, from what its channels show.
      await relaunch(1);
      expect(JSON.stringify(file().favouriteMembership ?? null)).not.toContain(a);
      expect(stored(b)).toEqual([FHD, HD, SD, "1000"]);
      expect(memory.played).toEqual([]);
    }
  });

  it("goes with a provider's history though the record holds nothing of it", async () => {
    const { app, a, b } = await twoProviders();
    await star(app, channelOf(app, b, FHD));
    const unread = unreadable(a, b)[0];
    const again = await withUnread(unread);
    expect(file().accounts[a]).toBeUndefined();
    await again.remove(a, { keepHistory: false });
    expect(registered().erasing).toEqual([]);
    expect(file().favouriteMembership).toBeUndefined();
    expect(stored(b)).toEqual([FHD, HD, SD]);
  });
});
