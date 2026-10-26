import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "@mrstreamer/core/provider";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";

// Real account, preferences, playback and Watch. Only native UI/files/secrets/player and the
// provider adapter are ports. The sheet must read accepted picks and keep stale callbacks inert.
const port = nativePlayer();
let provider: Provider;
const keychain = new Map<string, string>();
const sheets: Array<{ options: readonly string[]; pick: (index: number) => void }> = [];
const alerts: string[][] = [];
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    keychain.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    keychain.delete(key);
  },
}));
vi.mock("@mrstreamer/core/xtream", async () => ({
  ...(await vi.importActual<typeof import("@mrstreamer/core/xtream")>("@mrstreamer/core/xtream")),
  xtreamProvider: () => provider,
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => port,
  VideoView: () => null,
  VideoAirPlayButton: () => null,
  isPictureInPictureSupported: () => false,
}));
vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      options: { options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      sheets.push({ ...options, pick });
    },
  },
  Alert: {
    alert: (title: string, message: string) => {
      alerts.push([title, message]);
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-screen-orientation", () => ({
  OrientationLock: { LANDSCAPE: 1 },
  lockAsync: async () => undefined,
  unlockAsync: async () => undefined,
}));
vi.mock("expo-router", () => ({ router: { push: () => undefined }, usePathname: () => "/live" }));
vi.mock("../src/header.tsx", () => ({
  useTabs: () => ({ tab: "live" }),
  openOnTabs: () => undefined,
}));
vi.mock("../src/download-status.tsx", () => ({ DownloadStatusButton: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({ testID, onPress }: { testID?: string; onPress: () => void }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }),
  };
});
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF", dim: "#8E8E93" } }));

const { native } = await import("./native-files.ts");
const account = await import("../src/account.ts");
const playback = await import("../src/playback.ts");
const preferences = await import("../src/media-preferences.ts");
const sources = await import("../src/sources.ts");
const { demoProvider } = await import("../src/demo.ts");
const { WatchLayer } = await import("../src/watch.tsx");
let channel: import("../src/library.ts").Channel;
let liveStream = vi.fn(async (id: string) => ({ url: `file:${id}.m3u8`, format: "hls" as const }));
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
let unmount = () => {};
let container = document.createElement("div");
async function until(ready: () => boolean) {
  for (let i = 0; i < 100 && !ready(); i++) await new Promise((done) => setTimeout(done, 10));
  expect(ready()).toBe(true);
}
beforeAll(async () => {
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  mkdirSync(join(native.root, "documents"));
  await account.restore();
});
beforeEach(async () => {
  liveStream = vi.fn(async (id: string) => ({ url: `file:${id}.m3u8`, format: "hls" as const }));
  provider = {
    ...demoProvider(),
    liveStream,
    liveCatalogue: async () => ({
      categories: [{ id: "news", name: "NL | News" }],
      channels: ["FHD", "HD", "SD", "4K"].map((quality, i) => ({
        id: String(10 + i),
        name: `NL | News ${quality}`,
        number: null,
        logoUrl: null,
        categoryIds: ["news"],
        guideId: "news.nl",
        catchupDays: null,
      })),
    }),
  };
  const id = await account.add({
    server: "http://quality.example",
    username: "fixture",
    password: "fixture-pass",
  });
  if (!id) throw new Error("No saved account");
  await until(() => {
    const now = account.currentCatalogue();
    return now.kind === "ready" && now.library.byKey.has(`${id}:10`);
  });
  const now = account.currentCatalogue();
  const found = now.kind === "ready" ? now.library.byKey.get(`${id}:10`) : undefined;
  if (!found) throw new Error("No channel");
  channel = found;
  preferences.updateMediaPreferences("liveQuality", "fhd");
  preferences.updateChannelPick(channel, null);
  port.tracks = null;
  port.currentTime = 0;
  sheets.length = 0;
  alerts.length = 0;
  container = document.createElement("div");
  const root = createRoot(container);
  unmount = () => React.act(() => root.unmount());
  React.act(() => root.render(React.createElement(WatchLayer)));
});
afterEach(async () => {
  native.sync = null;
  native.undeletable = null;
  unmount();
  await playback.stop();
  await tick();
  await account.remove(channel.subscriptionId, { keepHistory: true });
});
async function watch() {
  await React.act(async () => {
    account.playChannel(channel, "News", { watch: true });
    await tick();
  });
}
function menu() {
  React.act(() =>
    container
      .querySelector('[data-testid="watch-quality"]')!
      .dispatchEvent(new Event("click", { bubbles: true })),
  );
  const sheet = sheets.at(-1);
  if (!sheet) throw new Error("No Quality sheet");
  return sheet;
}
async function pick(sheet: ReturnType<typeof menu>, contains: string) {
  const index = sheet.options.findIndex((row) => row.includes(contains));
  expect(index).toBeGreaterThanOrEqual(0);
  await React.act(async () => {
    sheet.pick(index);
    await tick();
  });
}

describe("Live quality through the real owners", () => {
  it("uses the saved global quality, keeps the logical channel and caps Automatic to core candidates", async () => {
    preferences.updateMediaPreferences("liveQuality", "sd");
    await watch();
    expect(liveStream.mock.calls.map(([id]) => id)).toEqual(["12"]);
    preferences.updateMediaPreferences("liveQuality", "uhd"); // The current Plan keeps its original core order.
    await React.act(async () => {
      port.failure({ kind: "missing", evidence: null });
      await tick();
    });
    expect(liveStream.mock.calls.map(([id]) => id)).toEqual(["12", "11"]);
    expect(playback.liveStream()).toMatchObject({
      channel: channel.key,
      explicit: false,
      playing: null,
    });
    expect(preferences.channelPicks(channel.subscriptionId)).toEqual({});
  });

  it.each(["loading", "playing", "paused", "failed"] as const)(
    "offers accepted quality and Automatic reset in %s",
    async (phase) => {
      preferences.updateChannelPick(channel, "11");
      await watch();
      await React.act(async () => {
        if (phase === "playing" || phase === "paused") port.state(true);
        if (phase === "paused") {
          playback.togglePause();
          port.state(false);
        }
        if (phase === "failed") port.failure({ kind: "auth", evidence: null });
        await tick();
      });
      const sheet = menu();
      expect(sheet.options.filter((row) => row.startsWith("✓ "))).toEqual([
        expect.stringContaining("HD · NL | News HD"),
      ]);
      expect(sheet.options.filter((row) => row.endsWith(" · Playing"))).toHaveLength(
        phase === "playing" || phase === "paused" ? 1 : 0,
      );
      await pick(sheet, "Automatic");
      expect(preferences.channelPicks(channel.subscriptionId)).toEqual({});
      expect(liveStream.mock.calls.map(([id]) => id)).toEqual(["11", "10"]);
      expect(playback.liveStream()).toMatchObject({ explicit: false, playing: null });
    },
  );

  it("starts a new Choice only after its pick is durable and resets a failing override during backoff", async () => {
    await watch();
    await pick(menu(), "HD · NL | News HD");
    expect(preferences.channelPicks(channel.subscriptionId)).toEqual({ "10": "11" });
    await React.act(async () => {
      port.state(true);
      port.failure();
      await tick();
    });
    expect(playback.playbackState.get().phase.kind).toBe("loading");
    await pick(menu(), "Automatic");
    expect(liveStream.mock.calls.map(([id]) => id)).toEqual(["10", "11", "10"]);
    expect(playback.liveStream()?.explicit).toBe(false);
  });

  it.each([false, true])(
    "a refused delete-then-move pick changes neither playback nor accepted value, cleanup refused=%s",
    async (cleanup) => {
      preferences.updateChannelPick(channel, "11");
      await watch();
      const item = playback.playingItem(playback.playbackState.get().phase);
      native.sync = (operation, path) => {
        if (operation === "move-after-delete" && path.endsWith("media-preferences.json.next"))
          throw new Error("Disk refused");
      };
      native.undeletable = (path) => cleanup && path.endsWith("media-preferences.json.next");
      await pick(menu(), "SD · NL | News SD");
      expect(preferences.channelPicks(channel.subscriptionId)).toEqual({ "10": "11" });
      expect(playback.playingItem(playback.playbackState.get().phase)).toBe(item);
      expect(liveStream.mock.calls.map(([id]) => id)).toEqual(["11"]);
      expect(alerts).toEqual([
        ["Couldn't save media preference", "Your previous choice is still saved. Try again."],
      ]);
    },
  );

  it.each(["close", "new-item", "retry", "new-menu", "request", "source", "catalogue"] as const)(
    "ignores a sheet after %s",
    async (changed) => {
      await watch();
      const sheet = menu();
      await React.act(async () => {
        if (changed === "close") await playback.closeWatch();
        if (changed === "new-item") account.playChannel(channel, "News", { watch: true });
        if (changed === "retry") playback.retry();
        if (changed === "new-menu") menu();
        if (changed === "request") playback.request();
        if (changed === "source") {
          const current = sources.sourceOf(channel.subscriptionId);
          sources.setSource(channel.subscriptionId, { ...current, revision: current.revision + 1 });
        }
        if (changed === "catalogue") {
          account.reloadChannels(channel.subscriptionId);
          await until(() => {
            const now = account.currentCatalogue();
            return now.kind === "ready" && now.library.byKey.get(channel.key) !== channel;
          });
        }
        await tick();
      });
      const before = liveStream.mock.calls.length;
      await pick(sheet, "SD · NL | News SD");
      expect(preferences.channelPicks(channel.subscriptionId)).toEqual({});
      expect(liveStream).toHaveBeenCalledTimes(before);
      expect(alerts).toEqual([]);
    },
  );
});
