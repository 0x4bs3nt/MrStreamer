import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Preferences, SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ipcInputs } from "@mrstreamer/contracts/ipc";
import { Settings } from "../src/main/services/preferences.ts";
import { Subscriptions } from "../src/main/services/subscription.ts";
import { fakeProvider, promised, runtimeFor, tempDir, testSecrets, userAgent } from "./support.ts";

/** What writes of preferences.json wait for before they reach the disk, as on a slow one. */
const disk = vi.hoisted<{ ready: Promise<void>; arrived?: () => void }>(() => ({
  ready: Promise.resolve(),
}));
vi.mock("../src/main/platform/json-file.ts", async (original) => {
  const actual = await original<typeof import("../src/main/platform/json-file.ts")>();
  const writeJsonFile: typeof actual.writeJsonFile = async (path, value) => {
    if (path.endsWith("preferences.json")) {
      disk.arrived?.();
      await disk.ready;
    }
    return actual.writeJsonFile(path, value);
  };
  return { ...actual, writeJsonFile };
});
afterEach(() => {
  disk.ready = Promise.resolve();
  delete disk.arrived;
});

/** Settings and subscriptions on `dataDir`, as a new start of the app reads them. */
async function start(dataDir: string) {
  const runtime = runtimeFor(
    Settings.layer(dataDir).pipe(
      Layer.provideMerge(
        Subscriptions.layer({ dataDir, secrets: testSecrets, providerOptions: { userAgent } }),
      ),
    ),
  );
  return {
    runtime,
    settings: await promised(runtime, Settings),
    subscriptions: await promised(runtime, Subscriptions),
  };
}

const settingsIn = async (dataDir: string) => (await start(dataDir)).settings;

/** A data folder with a subscription connected, and that subscription's id. */
async function connected() {
  const provider = await fakeProvider();
  const dataDir = await tempDir();
  const { settings, subscriptions } = await start(dataDir);
  const login = { server: provider.url, username: "demo", password: "demo" };
  const { id } = await subscriptions.add(login);
  return { dataDir, settings, subscriptions, id, login };
}

/** The saved subscription `id` names, as the services know it. */
async function savedAs(
  subscriptions: Awaited<ReturnType<typeof start>>["subscriptions"],
  id: string,
) {
  const found = (await subscriptions.saved()).find((each) => each.id === id);
  if (!found) throw new Error(`${id} isn't saved`);
  return found;
}

const stored = async (dataDir: string): Promise<unknown> =>
  JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8"));

describe("preferences", () => {
  it("keeps Home row order, hidden and future rows across restart and subscription removal", async () => {
    const { dataDir, settings, subscriptions, id } = await connected();
    const homeRows = [
      { id: "watchlist", visible: false },
      { id: "future-row", visible: false },
      { id: "continue", visible: true },
    ];
    await settings.update({ homeRows });
    await settings.update({ volume: 0.4 });
    expect((await (await settingsIn(dataDir)).get()).homeRows).toEqual(homeRows);
    await Effect.runPromise(await settings.prepareForget(await savedAs(subscriptions, id)));
    expect((await (await settingsIn(dataDir)).get()).homeRows).toEqual(homeRows);
  });

  it("changes only what the UI sends, and survives a restart", async () => {
    const dataDir = await tempDir();
    await (await settingsIn(dataDir)).update({ audioLanguage: "nl", autoplayNext: false });

    const patch = ipcInputs["preferences.update"]()({ volume: 0.3, muted: true });
    if (patch instanceof type.errors) throw new Error(patch.summary);
    await (await settingsIn(dataDir)).update(patch);

    expect(await (await settingsIn(dataDir)).get()).toEqual({
      volume: 0.3,
      muted: true,
      audioLanguage: "nl",
      autoplayNext: false,
      nextEpisodeDelaySeconds: 10,
    });
  });

  it("keeps what the viewer left a subscription at apart, for that subscription alone", async () => {
    const { dataDir, settings, id } = await connected();
    await settings.update({ volume: 0.4 });

    await settings.updateSubscription(id, { lastChannelId: "818", lastCategoryId: "7" });
    await settings.updateSubscription(id, { titleVersions: { "movie:603": "4012" } });

    const left = {
      lastChannelId: "818",
      lastCategoryId: "7",
      titleVersions: { "movie:603": "4012" },
    };
    expect(await settings.ofSubscription(id)).toEqual(left);
    expect(await (await settingsIn(dataDir)).ofSubscription(id)).toEqual(left);
    expect(await settings.get()).toEqual({
      volume: 0.4,
      muted: false,
      nextEpisodeDelaySeconds: 10,
    });
    // A subscription that isn't saved has none to read, and takes none.
    await expect(settings.ofSubscription("another-subscription")).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
    await expect(
      settings.updateSubscription("another-subscription", { lastChannelId: "5" }),
    ).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(await settings.ofSubscription(id)).toEqual(left);
  });

  it("keeps the file as the stable release reads and writes it", async () => {
    const { dataDir, settings, id } = await connected();

    await settings.update({ volume: 0.4, liveQuality: "hd" });
    await settings.updateSubscription(id, {
      lastChannelId: "818",
      channelVariants: { "818": "819" },
    });

    // One flat file, every key where that release looks for it.
    expect(await stored(dataDir)).toEqual({
      volume: 0.4,
      muted: false,
      liveQuality: "hd",
      lastChannelId: "818",
      lastCategoryId: null,
      channelVariants: { "818": "819" },
    });

    // What that release then changes in it is what this one reads.
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({ volume: 0.9, muted: true, lastChannelId: "5", lastCategoryId: "2" }),
    );
    const returned = await settingsIn(dataDir);

    expect(await returned.get()).toEqual({ volume: 0.9, muted: true, nextEpisodeDelaySeconds: 10 });
    expect(await returned.ofSubscription(id)).toEqual({ lastChannelId: "5", lastCategoryId: "2" });
  });

  it("forgets what the viewer left the subscription at, but not the volume, when it goes", async () => {
    const { dataDir, settings, subscriptions, id, login } = await connected();
    await settings.update({ volume: 0.4 });
    await settings.updateSubscription(id, {
      lastChannelId: "818",
      lastCategoryId: "7",
      titleVersions: { "movie:603": "4012" },
      channelVariants: { "818": "819" },
    });

    const gone = await savedAs(subscriptions, id);
    await subscriptions.remove(id);
    await Effect.runPromise(await settings.prepareForget(gone));

    expect(await stored(dataDir)).toEqual({
      volume: 0.4,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
    });
    // The subscription connected next starts where none was left.
    const next = await subscriptions.add(login);
    expect(await settings.ofSubscription(next.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
    await expect(settings.ofSubscription(id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
  });

  it("keeps what was left at an added subscription in its own folder, apart from every other's", async () => {
    const { dataDir, settings, subscriptions, id } = await connected();
    const other = await fakeProvider();
    const added = await subscriptions.add({
      server: other.url,
      username: "demo",
      password: "demo",
    });
    await settings.updateSubscription(id, { lastChannelId: "818" });

    // The same ids as the first one's, which mean another channel and another film here.
    await settings.updateSubscription(added.id, {
      lastChannelId: "818",
      lastCategoryId: "2",
      titleVersions: { "movie:603": "9" },
    });
    await settings.updateSubscription(id, { lastCategoryId: "7" });

    const left = { lastChannelId: "818", lastCategoryId: "2", titleVersions: { "movie:603": "9" } };
    expect(await settings.ofSubscription(added.id)).toEqual(left);
    expect(await settings.ofSubscription(id)).toEqual({
      lastChannelId: "818",
      lastCategoryId: "7",
    });
    // The file every release reads holds the first one's alone.
    expect(await stored(dataDir)).toEqual({
      volume: 1,
      muted: false,
      lastChannelId: "818",
      lastCategoryId: "7",
    });
    expect(
      JSON.parse(
        await readFile(join(dataDir, "subscriptions", added.id, "preferences.json"), "utf8"),
      ),
    ).toEqual(left);
    expect(await (await settingsIn(dataDir)).ofSubscription(added.id)).toEqual(left);

    // It goes with its subscription, and the first one's stays.
    const gone = await savedAs(subscriptions, added.id);
    await subscriptions.remove(added.id);
    await Effect.runPromise(await settings.prepareForget(gone));

    await expect(settings.ofSubscription(added.id)).rejects.toMatchObject({
      error: { kind: "no-subscription" },
    });
    expect(await settings.ofSubscription(id)).toEqual({
      lastChannelId: "818",
      lastCategoryId: "7",
    });
  });

  it("doesn't write what was left at a subscription that went while the change waited its turn", async () => {
    const { settings, subscriptions, id, login } = await connected();
    const ready = Promise.withResolvers<void>();
    disk.ready = ready.promise;
    const writing = settings.update({ volume: 0.4 });
    const late = settings.updateSubscription(id, { lastChannelId: "818" });
    late.catch(() => {});

    await subscriptions.remove(id);
    const next = await subscriptions.add(login);
    ready.resolve();
    await writing;

    await expect(late).rejects.toMatchObject({ error: { kind: "no-subscription" } });
    expect(await settings.ofSubscription(next.id)).toEqual({
      lastChannelId: null,
      lastCategoryId: null,
    });
  });

  it("keeps what a newer version wrote when it saves", async () => {
    const dataDir = await tempDir();
    const newer = {
      volume: 1,
      muted: false,
      lastChannelId: null,
      lastCategoryId: null,
      subtitles: "nl",
    };
    await writeFile(join(dataDir, "preferences.json"), JSON.stringify(newer));

    await (await settingsIn(dataDir)).update({ volume: 0.5 });

    expect(await stored(dataDir)).toEqual({ ...newer, volume: 0.5 });
  });

  it("reads files that still carry favourites and recent channels, without them", async () => {
    const dataDir = await tempDir();
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({
        volume: 0.3,
        muted: true,
        lastChannelId: "5",
        lastCategoryId: null,
        recentChannelIds: ["5"],
        favouriteChannelIds: ["5"],
      }),
    );

    expect(await (await settingsIn(dataDir)).get()).toEqual({
      volume: 0.3,
      muted: true,
      nextEpisodeDelaySeconds: 10,
    });
  });
});

describe("the interface language", () => {
  it("survives a restart beside the other preferences, which it leaves alone", async () => {
    const dataDir = await tempDir();
    const settings = await settingsIn(dataDir);
    await settings.update({
      titleLanguage: "nl",
      audioLanguage: "original",
      subtitleLanguage: "en",
    });
    await settings.setInterfaceLanguage("de-DE");

    const returned = await settingsIn(dataDir);
    expect(await returned.interfaceLanguage()).toBe("de-DE");
    // The preferences the UI reads and changes don't carry it.
    expect(await returned.get()).toEqual({
      volume: 1,
      muted: false,
      titleLanguage: "nl",
      audioLanguage: "original",
      subtitleLanguage: "en",
      nextEpisodeDelaySeconds: 10,
    });
    await returned.setInterfaceLanguage("system");
    expect(await (await settingsIn(dataDir)).interfaceLanguage()).toBe("system");
  });

  it("is only ever set to a language this release speaks, or System default", () => {
    const set = ipcInputs["language.set"]();
    expect(set({ choice: "fr-FR" })).toEqual({ choice: "fr-FR" });
    expect(set({ choice: "system" })).toEqual({ choice: "system" });
    expect(set({ choice: "it-IT" })).toBeInstanceOf(type.errors);
    // Not through the preferences, which take their own keys alone.
    expect(ipcInputs["preferences.update"]()({ interfaceLanguage: "de-DE", muted: true })).toEqual({
      muted: true,
    });
  });

  it("keeps a language a later release saved, and the rest of the file with it", async () => {
    const dataDir = await tempDir();
    const later = { volume: 0.6, muted: false, lastChannelId: null, lastCategoryId: null };
    await writeFile(
      join(dataDir, "preferences.json"),
      JSON.stringify({ ...later, interfaceLanguage: "it-IT" }),
    );

    const settings = await settingsIn(dataDir);
    expect(await settings.interfaceLanguage()).toBe("it-IT");
    expect(await settings.get()).toEqual({
      volume: 0.6,
      muted: false,
      nextEpisodeDelaySeconds: 10,
    });
    await settings.update({ muted: true });
    expect(await stored(dataDir)).toEqual({ ...later, muted: true, interfaceLanguage: "it-IT" });
  });

  it("stays when the original subscription goes", async () => {
    const { dataDir, settings, subscriptions, id } = await connected();
    await settings.setInterfaceLanguage("es-ES");
    const gone = await savedAs(subscriptions, id);
    await subscriptions.remove(id);
    await Effect.runPromise(await settings.prepareForget(gone));

    expect(await (await settingsIn(dataDir)).interfaceLanguage()).toBe("es-ES");
  });
});

describe("the next-episode delay", () => {
  it.each([0, 1, 10, 37, 60])(
    "accepts and keeps exactly %i seconds across restart",
    async (nextEpisodeDelaySeconds) => {
      const dataDir = await tempDir();
      const patch = ipcInputs["preferences.update"]()({ nextEpisodeDelaySeconds });
      if (patch instanceof type.errors) throw new Error(patch.summary);
      expect((await (await settingsIn(dataDir)).update(patch)).nextEpisodeDelaySeconds).toBe(
        nextEpisodeDelaySeconds,
      );
      expect((await (await settingsIn(dataDir)).get()).nextEpisodeDelaySeconds).toBe(
        nextEpisodeDelaySeconds,
      );
    },
  );

  it.each([-1, 0.5, 37.5, 61, NaN, Infinity, -Infinity, "37", null])(
    "rejects %s at IPC ingress",
    (nextEpisodeDelaySeconds) => {
      expect(ipcInputs["preferences.update"]()({ nextEpisodeDelaySeconds })).toBeInstanceOf(
        type.errors,
      );
    },
  );

  it("defaults an absent delay without adding it to unrelated writes", async () => {
    const dataDir = await tempDir();
    const settings = await settingsIn(dataDir);
    expect((await settings.get()).nextEpisodeDelaySeconds).toBe(10);
    expect((await settings.update({ muted: true })).nextEpisodeDelaySeconds).toBe(10);
    expect(await stored(dataDir)).not.toHaveProperty("nextEpisodeDelaySeconds");
  });

  it.each([75, "future", { mode: "future" }, null, -1, 37.5])(
    "preserves unsupported raw %j through writes, older readers and original-source forgetting",
    async (nextEpisodeDelaySeconds) => {
      const { dataDir, subscriptions, id } = await connected();
      const raw = {
        volume: 0.4,
        muted: true,
        autoplayNext: false,
        nextEpisodeDelaySeconds,
        lastChannelId: "818",
        lastCategoryId: "7",
        titleVersions: { "movie:603": "4012" },
        channelVariants: { "818": "819" },
        favouriteChannelIds: ["818"],
        recentChannelIds: ["819"],
        interfaceLanguage: "de-DE",
        futurePreference: { mode: "kept" },
      };
      await writeFile(join(dataDir, "preferences.json"), JSON.stringify(raw));
      const settings = await settingsIn(dataDir);
      expect(await settings.get()).toMatchObject({
        volume: 0.4,
        muted: true,
        autoplayNext: false,
        nextEpisodeDelaySeconds: 10,
      });
      await settings.update({ volume: 0.6 });
      await settings.setInterfaceLanguage("fr-FR");
      await settings.updateSubscription(id, { lastChannelId: "9" });
      await settings.dropLegacyLists();
      await Effect.runPromise(await settings.prepareForget(await savedAs(subscriptions, id)));
      const expected = {
        volume: 0.6,
        muted: true,
        autoplayNext: false,
        nextEpisodeDelaySeconds,
        lastChannelId: null,
        lastCategoryId: null,
        interfaceLanguage: "fr-FR",
        futurePreference: { mode: "kept" },
      };
      expect(await stored(dataDir)).toEqual(expected);
      // Stable's schema has no delay key, and retains it when reconstructing the flat file.
      const stable = Preferences().omit("nextEpisodeDelaySeconds").merge(SubscriptionPreferences())(
        await stored(dataDir),
      );
      if (stable instanceof type.errors) throw new Error(stable.summary);
      await writeFile(
        join(dataDir, "preferences.json"),
        JSON.stringify({ ...stable, muted: false }),
      );
      const restarted = await settingsIn(dataDir);
      expect(await restarted.get()).toMatchObject({
        volume: 0.6,
        muted: false,
        nextEpisodeDelaySeconds: 10,
      });
      await restarted.update({ audioLanguage: "nl" });
      expect(await stored(dataDir)).toEqual({ ...expected, muted: false, audioLanguage: "nl" });
      await restarted.update({ nextEpisodeDelaySeconds: 37 });
      expect((await (await settingsIn(dataDir)).get()).nextEpisodeDelaySeconds).toBe(37);
      expect(await stored(dataDir)).toEqual({
        ...expected,
        muted: false,
        audioLanguage: "nl",
        nextEpisodeDelaySeconds: 37,
      });
    },
  );

  it("retains the acknowledged policy when a write fails", async () => {
    const dataDir = await tempDir();
    const settings = await settingsIn(dataDir);
    await settings.update({ nextEpisodeDelaySeconds: 37, autoplayNext: true });
    const blocked = Promise.withResolvers<void>();
    disk.ready = blocked.promise;
    const writing = settings.update({ nextEpisodeDelaySeconds: 0, autoplayNext: false });
    const failed = expect(writing).rejects.toBeDefined();
    blocked.reject(new Error("disk unavailable"));
    await failed;
    expect(await settings.get()).toMatchObject({ nextEpisodeDelaySeconds: 37, autoplayNext: true });
    expect(await (await settingsIn(dataDir)).get()).toMatchObject({
      nextEpisodeDelaySeconds: 37,
      autoplayNext: true,
    });
  });
});

describe("remembered Live TV discovery", () => {
  it("restores topics globally, honors changed old-build legacy choice, and keeps All after restart", async () => {
    const { dataDir, settings, id } = await connected();
    await settings.updateSubscription(id, { lastCategoryId: "news" });
    await settings.rememberLiveBrowse({ kind: "topic", topic: "sport" });
    expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual({
      kind: "topic",
      topic: "sport",
    });
    expect(await settings.get()).not.toHaveProperty("rememberedLiveBrowse");
    // A prior stable build knows only lastCategoryId and retains the optional raw leaf.
    const old = await settingsIn(dataDir);
    await old.updateSubscription(id, { lastCategoryId: "kids" });
    expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual({
      kind: "category",
      category: { subscriptionId: id, id: "kids" },
    });
    const upgraded = await settingsIn(dataDir);
    await upgraded.rememberLiveBrowse({
      kind: "category",
      category: { subscriptionId: id, id: "films" },
    });
    expect((await (await settingsIn(dataDir)).ofSubscription(id)).lastCategoryId).toBe("films");
    await upgraded.rememberLiveBrowse({ kind: "all" });
    const afterAll = await settingsIn(dataDir);
    expect(await afterAll.liveBrowse()).toEqual({ kind: "all" });
    expect((await afterAll.ofSubscription(id)).lastCategoryId).toBeNull();
    expect(await stored(dataDir)).not.toHaveProperty("rememberedLiveBrowse");
  });

  it.each([true, false])(
    "preserves global topics and clears removed native choices for original=%s",
    async (original) => {
      const { dataDir, settings, subscriptions, id, login } = await connected();
      const provider = await fakeProvider();
      const second = await subscriptions.add({ ...login, server: provider.url });
      const removed = await savedAs(subscriptions, original ? id : second.id);
      await settings.rememberLiveBrowse({
        kind: "category",
        category: { subscriptionId: removed.id, id: "7" },
      });
      await settings.rememberLiveBrowse({ kind: "topic", topic: "music" });
      const forgetSettings = await settings.prepareForget(removed);
      await subscriptions.remove(removed.id);
      await Effect.runPromise(forgetSettings);
      expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual({
        kind: "topic",
        topic: "music",
      });
      const kept = original ? second.id : id;
      await settings.rememberLiveBrowse({
        kind: "category",
        category: { subscriptionId: kept, id: "8" },
      });
      const last = await savedAs(subscriptions, kept);
      const forgetLast = await settings.prepareForget(last);
      await subscriptions.remove(kept);
      await Effect.runPromise(forgetLast);
      expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual({ kind: "all" });
    },
  );

  it.each([true, false])(
    "preserves an unknown raw leaf through saves and removal for original=%s",
    async (original) => {
      const { dataDir, subscriptions, id, login } = await connected();
      const provider = await fakeProvider();
      const second = await subscriptions.add({ ...login, server: provider.url });
      const future = {
        version: 98,
        selection: { kind: "future", opaque: [1, 2] },
        legacy: "future",
      };
      const path = join(dataDir, "preferences.json");
      await writeFile(
        path,
        JSON.stringify({
          volume: 0.6,
          muted: false,
          lastChannelId: null,
          lastCategoryId: null,
          rememberedLiveBrowse: future,
        }),
      );
      const settings = await settingsIn(dataDir);
      expect(await settings.liveBrowse()).toEqual({ kind: "all" });
      await settings.update({ muted: true });
      await settings.setInterfaceLanguage("nl-NL");
      expect(await settings.get()).not.toHaveProperty("rememberedLiveBrowse");
      const removed = await savedAs(subscriptions, original ? id : second.id);
      const forgetSettings = await settings.prepareForget(removed);
      await subscriptions.remove(removed.id);
      await Effect.runPromise(forgetSettings);
      expect(await stored(dataDir)).toMatchObject({
        rememberedLiveBrowse: future,
        muted: true,
        interfaceLanguage: "nl-NL",
      });
    },
  );
});

it("keeps a prior-stable native edit authoritative when source removal rebases the remembered record", async () => {
  const { dataDir, settings, subscriptions, id, login } = await connected();
  const other = await fakeProvider();
  const second = await subscriptions.add({ ...login, server: other.url });
  await settings.updateSubscription(id, { lastCategoryId: "before" });
  await settings.rememberLiveBrowse({ kind: "topic", topic: "news" });
  const oldBuild = await settingsIn(dataDir);
  await oldBuild.updateSubscription(id, { lastCategoryId: "changed" });
  const upgraded = await settingsIn(dataDir);
  const beforeRemoval = await upgraded.liveBrowse();
  expect(beforeRemoval).toEqual({
    kind: "category",
    category: { subscriptionId: id, id: "changed" },
  });
  const removed = await savedAs(subscriptions, second.id);
  const forgetSettings = await upgraded.prepareForget(removed);
  await subscriptions.remove(second.id);
  await Effect.runPromise(forgetSettings);
  expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual(beforeRemoval);
});

it.each([true, false])(
  "clears the removed native selection while another source remains, original=%s",
  async (original) => {
    const { dataDir, settings, subscriptions, id, login } = await connected();
    const other = await fakeProvider();
    const second = await subscriptions.add({ ...login, server: other.url });
    const removed = await savedAs(subscriptions, original ? id : second.id);
    await settings.rememberLiveBrowse({
      kind: "category",
      category: { subscriptionId: removed.id, id: "native" },
    });
    const forgetSettings = await settings.prepareForget(removed);
    await subscriptions.remove(removed.id);
    await Effect.runPromise(forgetSettings);
    expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual({ kind: "all" });
  },
);

it("keeps a newer discovery choice made while source removal is in flight", async () => {
  const { dataDir, settings, subscriptions, id, login } = await connected();
  const other = await fakeProvider();
  await subscriptions.add({ ...login, server: other.url });
  await settings.rememberLiveBrowse({ kind: "topic", topic: "news" });
  const removed = await savedAs(subscriptions, id);
  const forgetSettings = await settings.prepareForget(removed);
  await settings.rememberLiveBrowse({ kind: "topic", topic: "sport" });
  await subscriptions.remove(id);
  await Effect.runPromise(forgetSettings);
  expect(await (await settingsIn(dataDir)).liveBrowse()).toEqual({ kind: "topic", topic: "sport" });
});

// Cancelling an admitted native write cannot leave this process behind its saved file.
it.each(["general", "added"] as const)(
  "publishes a completed %s preference write even when its caller cancels",
  async (kind) => {
    const dataDir = await tempDir();
    const { runtime, settings, subscriptions } = await start(dataDir);
    let subscriptionId: string | null = null;
    if (kind === "added") {
      const original = await fakeProvider();
      await subscriptions.add({ server: original.url, username: "demo", password: "demo" });
      const added = await fakeProvider({ second: true });
      subscriptionId = (
        await subscriptions.add({ server: added.url, username: "demo", password: "demo" })
      ).id;
      await settings.ofSubscription(subscriptionId);
    } else await settings.get();
    const raw = await runtime.runPromise(Settings);
    const arrived = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    disk.arrived = arrived.resolve;
    disk.ready = released.promise;
    const expected = subscriptionId ? { lastCategoryId: "kept" } : { muted: true };
    const fiber = runtime.runFork(
      subscriptionId
        ? Effect.asVoid(raw.updateSubscription(subscriptionId, { lastCategoryId: "kept" }))
        : Effect.asVoid(raw.update({ muted: true })),
    );
    let stopping: Promise<unknown> | undefined;
    try {
      await arrived.promise;
      stopping = runtime.runPromise(Fiber.interrupt(fiber));
      // Deliver cancellation while the real filesystem boundary is still held.
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      released.resolve();
      delete disk.arrived;
    }
    await stopping;
    const file = subscriptionId
      ? join(dataDir, "subscriptions", subscriptionId, "preferences.json")
      : join(dataDir, "preferences.json");
    const persisted: unknown = JSON.parse(await readFile(file, "utf8"));
    expect(persisted).toMatchObject(expected);
    expect(
      subscriptionId ? await settings.ofSubscription(subscriptionId) : await settings.get(),
    ).toMatchObject(expected);
    const restarted = (await start(dataDir)).settings;
    expect(
      subscriptionId ? await restarted.ofSubscription(subscriptionId) : await restarted.get(),
    ).toMatchObject(expected);
  },
);
