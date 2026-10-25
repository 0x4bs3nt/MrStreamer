import { nativePlayer } from "./native-player.ts";
import { guideFixture } from "./native-guide.ts";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Production account, catalogue, downloads, player and viewing owners. Only native I/O, fetch
// and telemetry transport are replaced. Media requests receive fixture bytes, never a network.
const memory = vi.hoisted(() => ({
  secrets: new Map<string, string>(),
  secretCalls: [] as string[],
  actions: [] as string[],
  players: [] as ReturnType<typeof nativePlayer>[],
  played: [] as string[],
  appState: "active",
  appListeners: [] as Array<(state: string) => void>,
  requests: 0,
}));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("../src/telemetry/index.ts", () => ({
  noteAction: (action: string) => memory.actions.push(action),
}));
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return memory.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      memory.appListeners.push(listener);
      return { remove: () => undefined };
    },
  },
}));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => {
    memory.secretCalls.push(`read:${key}`);
    return memory.secrets.get(key) ?? null;
  },
  setItemAsync: async (key: string, value: string) => {
    memory.secretCalls.push(`write:${key}`);
    memory.secrets.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    memory.secretCalls.push(`remove:${key}`);
    memory.secrets.delete(key);
  },
}));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => {
    const player = nativePlayer((source) => {
      memory.played.push(source.uri);
    });
    memory.players.push(player);
    return player;
  },
}));

const { native, File: DiskFile, Directory: Folder } = await import("./native-files.ts");
const { background } = await import("./native-downloads.ts");
const host = globalThis as { expo?: { modules?: Record<string, unknown> } };
let guide = guideFixture();
const releases: Array<() => void> = [];
function held() {
  let resolve = () => {};
  const promise = new Promise<void>((go) => (resolve = go));
  releases.push(resolve);
  return { promise, resolve };
}
const disk = (name: string) => new DiskFile(native.root, "documents", name);
const json = (name: string): unknown => JSON.parse(disk(name).textSync());
const registry = () =>
  (disk("subscriptions.json").exists
    ? json("subscriptions.json")
    : json("subscriptions.json.next")) as Record<string, unknown>;
const downloads = () =>
  json("downloads.json") as { items: Array<Record<string, unknown>>; forgetting: string[] };
const save = (name: string, value: unknown) => disk(name).writeSync(JSON.stringify(value));
const personal = (id = "personal") => ({
  id,
  kind: "xtream",
  server: "https://personal.example",
  username: "viewer",
  name: "Personal",
});
const envelope = (extra: Record<string, unknown> = {}) => ({
  version: 1,
  subscriptions: [],
  retired: [],
  pendingSecrets: [],
  erasing: [],
  ...extra,
});
const movie: TitleRef = { subscriptionId: "demo", kind: "movie", id: "movie" };
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(ready: () => boolean) {
  for (let n = 0; !ready(); n++) {
    if (n > 1_600) throw new Error("Public state did not settle");
    await wait(5);
  }
}

vi.stubGlobal("fetch", async (input: string | URL | Request) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  memory.requests++;
  if (url.hostname === "personal.example") {
    return Response.json(
      url.searchParams.has("action")
        ? []
        : {
            user_info: {
              auth: 1,
              status: "Active",
              exp_date: null,
              max_connections: "1",
              active_cons: "0",
            },
          },
    );
  }
  if (url.hostname === "raw.githubusercontent.com" && url.pathname.includes("/demo-media/")) {
    const bytes = new Uint8Array(4096).fill(42);
    return new Response(bytes, {
      headers: {
        "Content-Length": String(bytes.length),
        "Content-Type": url.pathname.endsWith(".mp4") ? "video/mp4" : "image/png",
      },
    });
  }
  throw new Error("Unexpected external request");
});

async function launch(withDownloads = true) {
  background.die();
  vi.resetModules();
  memory.appListeners.length = 0;
  const account = await import("../src/account.ts");
  const titles = await import("../src/titles.ts");
  const playback = await import("../src/playback.ts");
  const viewing = await import("../src/viewing.ts");
  const copies = await import("../src/downloads.ts");
  const playTitle = await import("../src/play-title.ts");
  const sources = await import("../src/sources.ts");
  const watchlist = await import("../src/watchlist.ts");
  await account.restore();
  if (withDownloads) copies.startDownloads();
  const app = {
    ...account,
    ...titles,
    ...viewing,
    ...copies,
    ...playTitle,
    ...sources,
    ...watchlist,
    playback,
  };
  current = app;
  return app;
}
type App = Awaited<ReturnType<typeof launch>>;
let current: App | null = null;
const demoListed = (app: App) => app.members().some((member) => member.entry.kind === "demo");
const marker = () => registry()["demo"];
async function withDemo() {
  const app = await launch();
  expect(await app.startDemo()).toEqual({ kind: "started" });
  await until(() => app.titleLists().kind === "ready");
  return app;
}
async function copy(app: App, ref = movie) {
  const item = await app.addDownload(ref);
  await until(() =>
    app.downloadList().items.some((each) => each.id === item.id && each.status.kind === "complete"),
  );
  return item;
}
const folder = (id: string) => new Folder(native.root, "documents", "downloads", id);
const player = () => memory.players.at(-1)!;
function holdReader() {
  const close = held();
  const actual = player().detachObservedAsync.getMockImplementation()!;
  player().detachObservedAsync.mockImplementation(async (id) => {
    await close.promise;
    return actual(id);
  });
  return close;
}

beforeEach(async () => {
  await background.forceQuit();
  background.reset();
  for (const name of readdirSync(native.root))
    rmSync(join(native.root, name), { recursive: true, force: true });
  mkdirSync(join(native.root, "documents"));
  mkdirSync(join(native.root, "cache"));
  memory.secrets.clear();
  memory.secretCalls.length = 0;
  memory.actions.length = 0;
  memory.players.length = 0;
  memory.played.length = 0;
  memory.requests = 0;
  memory.appState = "active";
  native.sync = null;
  native.gate = null;
  native.undeletable = null;
  guide = guideFixture();
  host.expo!.modules!["Guide"] = guide.native;
  // Known empty personal registry avoids first-install Keychain cleanup obscuring demo calls.
  save("subscriptions.json", envelope());
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  vi.useRealTimers();
  native.sync = null;
  native.gate = null;
  native.undeletable = null;
  await current?.playback.stop();
  await current?.viewingChangesSettled();
  await background.forceQuit();
  await wait(30);
  vi.restoreAllMocks();
  current = null;
});

describe("Demo through the production lifecycle", () => {
  it("starts once on a clean install without waiting for native readiness or touching secrets", async () => {
    const ready = held();
    const port = host.expo!.modules!["BackgroundDownloads"] as {
      reconcile: (...args: unknown[]) => Promise<unknown>;
    };
    const actual = port.reconcile;
    vi.spyOn(port, "reconcile").mockImplementation(async (...args) => {
      await ready.promise;
      return actual(...args);
    });
    const app = await launch();
    const starts = await Promise.all([app.startDemo(), app.startDemo()]);
    expect(starts).toEqual([{ kind: "started" }, { kind: "started" }]);
    expect(app.members().map((member) => [member.entry.kind, member.label])).toEqual([
      ["demo", "Demo"],
    ]);
    const source = app.currentSource("demo");
    expect(source?.login).toEqual([]);
    expect(await app.startDemo()).toEqual({ kind: "started" });
    expect(app.currentSource("demo")).toBe(source);
    expect(memory.secretCalls).toEqual([]);
    expect(memory.requests).toBe(0);
    expect(memory.actions).toEqual([]);
    ready.resolve();
  });

  it("refuses to trust empty downloads while the owner has not loaded", async () => {
    const app = await launch(false);
    expect(await app.startDemo()).toEqual({ kind: "incomplete", pending: ["downloads"] });
    expect(demoListed(app)).toBe(false);
    expect(marker()).toEqual({ version: 1, state: "erasing" });
    app.startDownloads();
    expect(await app.startDemo()).toEqual({ kind: "started" });
  });

  it.each(["downloads.json", "downloads.json.next"])(
    "keeps unreadable %s inert and removal incomplete",
    async (name) => {
      disk(name).writeSync("{broken");
      const app = await launch();
      expect(await app.startDemo()).toEqual({ kind: "incomplete", pending: ["downloads"] });
      expect(marker()).toEqual({ version: 1, state: "erasing" });
      expect(disk(name).textSync()).toBe("{broken");
      expect(demoListed(app)).toBe(false);
    },
  );

  it("recovers a valid .next with an unreadable main and preserves unknown records", async () => {
    disk("downloads.json").writeSync("{broken");
    save("downloads.json.next", {
      version: 1,
      items: [{ id: "d-unknown", subscriptionId: "demo", future: true }],
      forgetting: [],
    });
    const app = await launch();
    expect(await app.startDemo()).toEqual({ kind: "incomplete", pending: ["downloads"] });
    expect(demoListed(app)).toBe(false);
    expect(disk("downloads.json.next").textSync()).toContain("d-unknown");
  });

  it("starts from a valid empty .next without requiring an absent main", async () => {
    disk("downloads.json").writeSync("{broken");
    save("downloads.json.next", { version: 1, items: [], forgetting: [] });
    const app = await launch();
    expect(await app.startDemo()).toEqual({ kind: "started" });
  });

  it("does not infer missing documents when storage existence itself fails", async () => {
    const app = await launch(false);
    const { File: CurrentFile } = await import("expo-file-system");
    const get = Object.getOwnPropertyDescriptor(CurrentFile.prototype, "exists")!.get!;
    vi.spyOn(CurrentFile.prototype, "exists", "get").mockImplementation(function (
      this: InstanceType<typeof CurrentFile>,
    ) {
      if (this.name.startsWith("downloads.json")) throw new Error("Storage unavailable");
      return get.call(this) as boolean;
    });
    app.startDownloads();
    expect(await app.startDemo()).toEqual({ kind: "incomplete", pending: ["downloads"] });
  });

  it.each(["bad", { version: 2, state: "active" }, null])(
    "restores personal providers around an unreadable marker %j",
    async (demo) => {
      const entries = [personal("one"), personal("two")];
      save(
        "subscriptions.json",
        envelope({ subscriptions: entries, demo, future: { owned: [1, 2] } }),
      );
      memory.secrets.set("s.one", "fixture-one");
      memory.secrets.set("s.two", "fixture-two");
      const app = await launch();
      expect(app.members().map((member) => member.entry.id)).toEqual(["one", "two"]);
      expect(app.currentSource("one")).toBeDefined();
      expect(app.currentSource("two")).toBeDefined();
      expect(await app.startDemo()).toEqual({ kind: "refused", reason: "unreadable-demo" });
      expect(await app.endDemo()).toEqual({ kind: "refused", reason: "unreadable-demo" });
      await app.update("one", { name: "Renamed" });
      expect(registry()["demo"]).toEqual(demo);
      expect(registry()["future"]).toEqual({ owned: [1, 2] });
    },
  );

  it.each(["subscriptions", "retired", "erasing", "pendingSecrets"])(
    "protects a personal reserved id in %s from every demo action",
    async (where) => {
      const entry = personal("demo");
      save(
        "subscriptions.json",
        envelope({
          subscriptions: [personal()],
          [where]: where === "subscriptions" || where === "retired" ? [entry] : ["demo"],
          demo: { version: 1, state: "active" },
        }),
      );
      memory.secrets.set("s.demo", "fixture-personal");
      const app = await launch();
      expect(demoListed(app)).toBe(false);
      if (where === "subscriptions") {
        expect(memory.secretCalls).toContain("read:s.demo");
        expect(app.currentSource("demo")?.login).toEqual(["viewer", "fixture-personal"]);
      }
      for (const action of [app.startDemo, app.endDemo, app.resetDemo])
        expect(await action()).toEqual({ kind: "refused", reason: "reserved-id" });
      expect(marker()).toEqual({ version: 1, state: "active" });
    },
  );

  it("preserves opaque and personal registry fields during demo-only writes", async () => {
    const before = envelope({
      subscriptions: [personal()],
      retired: [personal("retired")],
      future: { nested: ["keep"] },
    });
    save("subscriptions.json", before);
    const app = await launch();
    expect(await app.startDemo()).toEqual({ kind: "started" });
    expect(registry()).toEqual({ ...before, demo: { version: 1, state: "active" } });
    expect(await app.endDemo()).toMatchObject({ kind: "erased" });
    expect(registry()).toEqual(before);
  });

  it("preserves carried favourite memory on clean Try and removes it only after demo viewing exists", async () => {
    const carried = { version: 9, personal: ["opaque"] };
    save("viewing.json", {
      version: 1,
      sequence: 0,
      receipts: [],
      imported: true,
      accounts: {},
      favouriteMembership: carried,
    });
    const app = await withDemo();
    expect((json("viewing.json") as Record<string, unknown>)["favouriteMembership"]).toEqual(
      carried,
    );
    await app.recordProgress(movie, 30, 150, Date.now());
    expect(await app.resetDemo()).toEqual({ kind: "started" });
    expect((json("viewing.json") as Record<string, unknown>)["accounts"]).not.toHaveProperty(
      "demo",
    );
    expect(json("viewing.json")).not.toHaveProperty("favouriteMembership");
  });

  it.each(["guide", "lists", "details"])(
    "keeps a refused %s erase retryable at launch",
    async (cache) => {
      const app = await withDemo();
      if (cache === "guide") guide.control.refused.add("demo");
      else {
        const root = cache === "lists" ? "catalogues" : "details/providers/demo";
        const dir = new Folder(native.root, "cache", root);
        dir.create({ idempotent: true, intermediates: true });
        const file = new DiskFile(dir, "demo.titles.json");
        file.writeSync("{}");
        native.undeletable = (path) => path === file.path;
      }
      expect(await app.endDemo()).toEqual({ kind: "incomplete", pending: ["saved-data"] });
      expect(demoListed(app)).toBe(false);
      expect(marker()).toEqual({ version: 1, state: "erasing" });
      native.undeletable = null;
      guide.control.refused.clear();
      const relaunched = await launch();
      await until(() => marker() === undefined);
      expect(demoListed(relaunched)).toBe(false);
    },
  );

  it("does not let an older cache erase or queued launch retry clear a newer Try", async () => {
    save("subscriptions.json", envelope({ demo: { version: 1, state: "erasing" } }));
    const gate = held();
    let entered = false;
    guide.control.forget = async (id) => {
      if (id === "demo") {
        entered = true;
        await gate.promise;
      }
      return true;
    };
    const app = await launch();
    await until(() => entered);
    const trying = app.startDemo();
    expect(demoListed(app)).toBe(false);
    // Step B releases account.serially for unrelated personal changes.
    const id = await app.add({
      server: "https://personal.example",
      username: "viewer",
      password: "fixture",
    });
    expect(id).toBeTypeOf("string");
    gate.resolve();
    expect(await trying).toEqual({ kind: "started" });
    await app.recordProgress(movie, 40, 150, Date.now());
    await wait(30);
    expect(marker()).toEqual({ version: 1, state: "active" });
    expect(app.viewingHolds("demo")).toBe(true);
  });

  it("retries launch once more on actual downloads ready and rechecks the current marker", async () => {
    save("subscriptions.json", envelope({ demo: { version: 1, state: "erasing" } }));
    const app = await launch(false);
    await app.accountChanges();
    await wait(20);
    expect(marker()).toEqual({ version: 1, state: "erasing" });
    let erases = 0;
    const ready = held();
    app.connectDemoDownloads({
      erase: async () => {
        erases++;
        return {
          trusted: true,
          kept: 0,
          removed: 0,
          saved: Promise.resolve(),
          cleanup: Promise.resolve("closed"),
        };
      },
      ready: ready.promise,
    });
    expect(await app.startDemo()).toEqual({ kind: "started" });
    expect(erases).toBe(1);
    ready.resolve();
    await wait(30);
    expect(erases).toBe(1);
    expect(marker()).toEqual({ version: 1, state: "active" });
  });

  it("bounds a hung viewing mark, then makes a later Try cross its own fresh barrier", async () => {
    const app = await withDemo();
    const titleLists = app.titleLists();
    if (titleLists.kind !== "ready") throw new Error("No titles");
    const title = app.titleOf(titleLists.index, "series", {
      subscriptionId: "demo",
      id: "series",
    })!;
    const details = await app.detailsOf(title);
    if (details.kind !== "series") throw new Error("No series");
    const gate = held();
    let entered = false;
    app.serveViewing({
      series: async () => {
        entered = true;
        await gate.promise;
        return title;
      },
      details: async () => details,
    });
    const marking = app
      .markEpisode(
        {
          kind: "episode",
          subscriptionId: "demo",
          id: "episode-1",
          seriesId: "series",
          season: 1,
          episode: 1,
        },
        true,
      )
      .catch(() => null);
    await until(() => entered);
    vi.useFakeTimers();
    const exiting = app.endDemo();
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await exiting).toEqual({ kind: "incomplete", pending: ["history"] });
    const trying = app.startDemo();
    await vi.advanceTimersByTimeAsync(1);
    expect(demoListed(app)).toBe(false);
    gate.resolve();
    await marking;
    await vi.advanceTimersByTimeAsync(1);
    expect(await trying).toEqual({ kind: "started" });
    expect(await app.seriesViewing({ subscriptionId: "demo", id: "series" })).toMatchObject({
      marks: [],
    });
  });

  it("reports erasure while a failed copy reader stays open and a new Try cannot reuse it", async () => {
    const first = await withDemo();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const kept = await first.addDownload(movie);
    clock.mockRestore();
    await until(() =>
      first
        .downloadList()
        .items.some((each) => each.id === kept.id && each.status.kind === "complete"),
    );
    await wait(30);
    const app = await launch();
    await until(() => app.titleLists().kind === "ready");
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1);
    player().ready();
    player().state(true);
    player().currentTime = 35;
    const close = holdReader();
    player().failure();
    await until(() => app.playback.playbackState.get().phase.kind === "failed");
    const exiting = app.endDemo();
    const trying = app.startDemo();
    expect(await exiting).toEqual({ kind: "erased", files: "deferred" });
    expect(await trying).toEqual({ kind: "started" });
    expect(app.playback.playbackState.get().phase.kind).toBe("idle");
    app.playDownload(kept.id);
    app.playback.retry();
    await wait(30);
    expect(memory.played).toHaveLength(1);
    expect(folder(kept.id).exists).toBe(true);
    const played = new DiskFile(folder(kept.id), "media.mp4").textSync();
    vi.spyOn(Date, "now").mockReturnValue(now);
    const next = await app.addDownload(movie);
    expect(next.id).not.toBe(kept.id);
    expect(new DiskFile(folder(kept.id), "media.mp4").textSync()).toBe(played);
    close.resolve();
    await until(() => !folder(kept.id).exists);
    expect(marker()).toEqual({ version: 1, state: "active" });
  });

  it("keeps personal playback and records while removing an older demo reader", async () => {
    const app = await withDemo();
    const kept = await copy(app);
    const id = await app.add({
      server: "https://personal.example",
      username: "viewer",
      password: "fixture",
    });
    if (!id) throw new Error("No personal provider");
    const own: TitleRef = { kind: "movie", subscriptionId: id, id: "own" };
    await app.recordProgress(own, 55, 150, Date.now());
    const before = (json("viewing.json") as { accounts: Record<string, unknown> }).accounts[id];
    app.playDownload(kept.id);
    await until(() => memory.played.length === 1);
    const close = holdReader();
    // Personal play retires the demo resource; its close is still held in playback's ledger.
    const playing = app.playback.play(
      {
        id: "personal-stream",
        subscriptionId: id,
        title: "Personal",
        place: "",
        live: false,
        next: false,
        versions: false,
      },
      async () => ({ url: "https://personal.example/movie.mp4", container: "mp4" }),
      { watch: true, login: [] },
    );
    await wait(20);
    const phase = app.playback.playbackState.get().phase;
    expect(await app.endDemo()).toEqual({ kind: "erased", files: "deferred" });
    expect(app.playback.playbackState.get().phase).toBe(phase);
    expect(folder(kept.id).exists).toBe(true);
    expect((json("viewing.json") as { accounts: Record<string, unknown> }).accounts[id]).toEqual(
      before,
    );
    close.resolve();
    await playing;
    await until(() => !folder(kept.id).exists);
  });

  it("writes demo-reset intent before a refused record fence and keeps it through automatic source removal", async () => {
    const app = await withDemo();
    const item = await app.addDownload(movie);
    await until(() =>
      [...background.grants.values()].some(
        (grant) => grant.id === item.id && grant.state !== "reserved",
      ),
    );
    // A background wake may not deliver receipt hints to JS before the account command.
    background.listeners.get("receipt")?.clear();
    const port = host.expo!.modules!["BackgroundDownloads"] as {
      cancelAuthorization: (...args: unknown[]) => Promise<unknown>;
    };
    let fences = 0;
    const fence = vi.spyOn(port, "cancelAuthorization").mockImplementation(async () => {
      fences++;
      expect(marker()).toEqual({ version: 1, state: "erasing" });
      expect(downloads().items.find((each) => each["id"] === item.id)?.["removal"]).toEqual({
        version: 1,
        reason: "demo-reset",
      });
      throw new Error("Native fence refused");
    });
    expect(await app.endDemo()).toEqual({ kind: "incomplete", pending: ["downloads"] });
    await until(() => fences >= 2);
    expect(downloads().items[0]?.["removal"]).toEqual({ version: 1, reason: "demo-reset" });
    expect(marker()).toEqual({ version: 1, state: "erasing" });
    fence.mockRestore();
    // The next launch finishes the durable intent without reauthorizing the old record.
    const requested = memory.requests;
    await launch();
    await until(() => marker() === undefined);
    expect(downloads().items).toEqual([]);
    expect(memory.requests).toBe(requested);
  });

  it("skips an old demo episode finish after reset while preserving the new Continue entry", async () => {
    const app = await withDemo();
    const lists = app.titleLists();
    if (lists.kind !== "ready") throw new Error("No titles");
    const title = app.titleOf(lists.index, "series", { subscriptionId: "demo", id: "series" })!;
    const details = await app.detailsOf(title);
    if (details.kind !== "series") throw new Error("No series");
    const episodes = details.seasons.flatMap((season) => season.episodes);
    const first = episodes[0]!;
    const last = episodes.at(-1)!;
    const ref = (episode: typeof first): TitleRef => ({
      kind: "episode",
      subscriptionId: "demo",
      id: episode.id,
      seriesId: episode.seriesId,
      season: episode.season,
      episode: episode.number,
    });
    await app.recordProgress(ref(first), 90, 90, Date.now());
    const gate = held();
    let entered = false;
    app.serveViewing({
      series: async () => {
        entered = true;
        await gate.promise;
        return title;
      },
      details: async () => details,
    });
    app.playEpisode(details, last, 0, () => undefined);
    await until(() => memory.played.length === 1);
    player().duration = 90;
    player().ready();
    player().state(true);
    player().currentTime = 90;
    player().observation({ kind: "ended" });
    await until(() => entered);
    expect(await app.resetDemo()).toEqual({ kind: "started" });
    await app.recordProgress(ref(first), 90, 90, Date.now());
    await app.recordProgress(ref(last), 30, 90, Date.now());
    const before = app.currentViewing()?.continueWatching;
    expect(before).toHaveLength(1);
    gate.resolve();
    await wait(50);
    await app.viewingChangesSettled();
    expect(app.currentViewing()?.continueWatching).toEqual(before);
  });

  it("preserves global media and analytics bytes through Reset and Exit", async () => {
    const app = await withDemo();
    const names = ["media-preferences.json", "analytics.json"];
    for (const name of names) disk(name).writeSync('{"keep":"exact bytes"}\n');
    expect(await app.resetDemo()).toEqual({ kind: "started" });
    expect(await app.endDemo()).toMatchObject({ kind: "erased" });
    for (const name of names) expect(disk(name).textSync()).toBe('{"keep":"exact bytes"}\n');
  });

  it("orders a whole Exit before the next Try at the downloads port", async () => {
    const app = await launch(false);
    const progress = held();
    let erases = 0;
    let hold = false;
    app.connectDemoDownloads({
      ready: Promise.resolve(),
      erase: async () => {
        erases++;
        return {
          trusted: true,
          removed: 0,
          kept: 0,
          saved: hold ? progress.promise : Promise.resolve(),
          cleanup: Promise.resolve("closed"),
        };
      },
    });
    expect(await app.startDemo()).toEqual({ kind: "started" });
    hold = true;
    const exit = app.endDemo();
    await until(() => erases === 2);
    const trying = app.startDemo();
    await wait(30);
    expect(erases).toBe(2);
    expect(demoListed(app)).toBe(false);
    progress.resolve();
    expect(await exit).toMatchObject({ kind: "erased" });
    expect(await trying).toEqual({ kind: "started" });
    expect(erases).toBe(3);
    expect(marker()).toEqual({ version: 1, state: "active" });
  });

  it("waits for an already begun relist details read before Reset can activate", async () => {
    const app = await withDemo();
    const lists = app.titleLists();
    if (lists.kind !== "ready") throw new Error("No titles");
    const title = app.titleOf(lists.index, "series", { subscriptionId: "demo", id: "series" })!;
    const details = await app.detailsOf(title);
    const gate = held();
    let reading = false;
    app.serveViewing({
      series: async () => title,
      details: async () => {
        reading = true;
        await gate.promise;
        return details;
      },
    });
    const relisting = app.relist({ subscriptionId: "demo", id: "series" }, title);
    await until(() => reading);
    let result: unknown;
    const reset = app.resetDemo().then((value) => {
      result = value;
      return value;
    });
    await wait(30);
    expect(result).toBeUndefined();
    expect(marker()).toEqual({ version: 1, state: "erasing" });
    gate.resolve();
    await relisting;
    expect(await reset).toEqual({ kind: "started" });
  });

  it("leaves only safe relaunch states when a registry move refuses after writing .next", async () => {
    const app = await withDemo();
    native.sync = (operation, path) => {
      if (operation === "move-after-delete" && path.endsWith("subscriptions.json.next"))
        throw new Error("Move refused");
    };
    expect(await app.endDemo()).toEqual({ kind: "refused", reason: "registry-refused" });
    expect(json("subscriptions.json.next")).toHaveProperty("demo", {
      version: 1,
      state: "erasing",
    });
    native.sync = null;
    const restored = await launch();
    await until(() => marker() === undefined);
    expect(demoListed(restored)).toBe(false);
  });
});
