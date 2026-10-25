import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ObservedDetachResult, ObservedOpenResult } from "expo-video";
import type { LiveCatalogue } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-video", () => ({ createVideoPlayer: () => port }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async () => null,
  setItemAsync: async () => undefined,
  deleteItemAsync: async () => undefined,
}));
vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));

const { native } = await import("./native-files.ts");
let port = nativePlayer();
let account: typeof import("../src/account.ts");
let owner: typeof import("../src/playback.ts");
let sources: typeof import("../src/sources.ts");
let preferences: typeof import("../src/media-preferences.ts");
let demo: typeof import("../src/demo.ts");
let channel: import("../src/library.ts").Channel;
let revision = 0;
const tick = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const catalogue: LiveCatalogue = {
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
};
function signIn() {
  const liveStream = vi.fn(async (id: string, _signal?: AbortSignal) => ({
    url: `file:${id}.m3u8`,
    format: "hls" as const,
  }));
  const source = {
    revision: ++revision,
    login: [],
    provider: { ...demo.demoProvider(), liveStream },
  };
  sources.setSource("sub", source);
  return source;
}
async function watch() {
  account.playChannel(channel, "News", { watch: true });
  await tick();
  const { phase } = owner.playbackState.get();
  if (phase.kind === "idle") throw new Error("No selected channel");
  return phase.item;
}
const opened = (source: ReturnType<typeof signIn>) =>
  source.provider.liveStream.mock.calls.map(([id]) => id);
function detached(stamp: { attemptId: number; itemId: number }): ObservedDetachResult {
  return {
    kind: "detached",
    ...stamp,
    localItemExcluded: true,
    appWorkDrained: true,
    providerDisconnect: "unobservable",
  };
}
const waiting = () =>
  port.observation({
    kind: "state",
    timeControl: "waiting",
    mediaTimeSeconds: port.currentTime,
    bufferEmpty: true,
    likelyToKeepUp: false,
  });

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T08:00:00Z"));
  native.sync = null;
  native.undeletable = null;
  rmSync(join(native.root, "documents"), { recursive: true, force: true });
  mkdirSync(join(native.root, "documents"));
  port = nativePlayer();
  revision = 0;
  owner = await import("../src/playback.ts");
  sources = await import("../src/sources.ts");
  preferences = await import("../src/media-preferences.ts");
  demo = await import("../src/demo.ts");
  account = await import("../src/account.ts");
  const { buildLibrary } = await import("../src/library.ts");
  const first = buildLibrary([{ subscriptionId: "sub", label: "Home", catalogue }]).channels[0];
  if (!first) throw new Error("No grouped channel");
  channel = first;
});
afterEach(async () => {
  native.sync = null;
  native.undeletable = null;
  owner.onAdmission(null);
  owner.onPlaybackFailure(null);
  await owner.stop();
  await tick();
  vi.useRealTimers();
});

describe("Live attempt ownership", () => {
  it("advances a missing candidate without replacing the item or a waiting viewer request", async () => {
    const provider = signIn();
    const item = await watch();
    const request = owner.request();
    port.failure({ kind: "missing", evidence: null });
    expect(owner.playbackState.get().phase).toEqual({ kind: "loading", item });
    await tick();
    expect(opened(provider)).toEqual(["10", "11"]);
    port.state(true);
    expect(owner.playbackState.get().phase).toEqual({ kind: "playing", item });
    expect(request.stands()).toBe(true);
    expect(preferences.channelPicks("sub")).toEqual({});
  });

  it("plays an asked stream alone without persisting an override", async () => {
    const provider = signIn();
    account.playChannel(channel, "News", { watch: true, variantId: "13" });
    await tick();
    expect(opened(provider)).toEqual(["13"]);
    expect(owner.liveStream()?.explicit).toBe(true);
    port.failure({ kind: "missing", evidence: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["13"]);
    expect(preferences.channelPicks("sub")).toEqual({});
    expect(owner.playbackState.get().phase.kind).toBe("failed");
  });

  it("keeps a provider's typed format refusal terminal without fabricating a native HTTP cause", async () => {
    const provider = signIn();
    const { AppFailure } = await import("@mrstreamer/contracts/errors");
    provider.provider.liveStream.mockRejectedValueOnce(
      new AppFailure({ kind: "stream", failure: { kind: "refused", status: 429 } }),
    );
    await watch();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["10"]);
    expect(port.replaceObservedAsync).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("failed");
  });

  it.each(["auth", "rate-limit"] as const)("stops before fallback on native %s", async (kind) => {
    const provider = signIn();
    await watch();
    port.failure({ kind, evidence: null });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["10"]);
    expect(owner.playbackState.get().phase.kind).toBe("failed");
  });

  it.each(["missing", "decode", "unsupported", "auth", "rate-limit"] as const)(
    "does not reconnect a played stream after native %s",
    async (kind) => {
      const provider = signIn();
      await watch();
      port.state(true);
      port.failure({ kind, evidence: null });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(opened(provider)).toEqual(["10"]);
      expect(owner.playbackState.get().phase.kind).toBe("failed");
    },
  );

  it("caps the first unstable stretch at three candidates plus four reconnects at 1/2/4/8 seconds", async () => {
    const provider = signIn();
    const item = await watch();
    for (let i = 0; i < 2; i++) {
      port.failure({ kind: "missing", evidence: null });
      await tick();
    }
    port.state(true);
    for (const delay of [1000, 2000, 4000, 8000]) {
      const count = opened(provider).length;
      port.failure({ kind: "network", evidence: null });
      expect(owner.playbackState.get().phase).toEqual({ kind: "loading", item });
      expect(owner.liveStream()?.playing).toBeNull();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(opened(provider)).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      await tick();
      expect(opened(provider)).toHaveLength(count + 1);
      port.state(true);
    }
    port.failure({ kind: "network", evidence: null });
    expect(owner.playbackState.get().phase).toEqual({
      kind: "failed",
      item,
      error: "The connection to the provider failed.",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["10", "11", "12", "12", "12", "12", "12"]);
    expect(preferences.channelPicks("sub")).toEqual({});
  });

  it("earns four more reconnects after thirty seconds of real playing on one attempt", async () => {
    const provider = signIn();
    await watch();
    for (let i = 0; i < 2; i++) {
      port.failure({ kind: "missing", evidence: null });
      await tick();
    }
    port.state(true);
    for (const delay of [1000, 2000, 4000, 8000]) {
      port.failure();
      await vi.advanceTimersByTimeAsync(delay);
      await tick();
      port.state(true);
    }
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(10_000);
      port.currentTime += 10;
      port.state(true);
    }
    for (const delay of [1000, 2000, 4000, 8000]) {
      const count = opened(provider).length;
      port.failure();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(opened(provider)).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      await tick();
      port.state(true);
    }
    port.failure();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["10", "11", ...Array<string>(9).fill("12")]);
    expect(owner.playbackState.get().phase.kind).toBe("failed");
  });

  it("does not earn a stable reset from pause or native waiting time", async () => {
    const provider = signIn();
    await watch();
    port.state(true);
    for (const delay of [1000, 2000, 4000, 8000]) {
      port.failure();
      await vi.advanceTimersByTimeAsync(delay);
      await tick();
      port.state(true);
    }
    port.state(false);
    await vi.advanceTimersByTimeAsync(60_000);
    port.state(true);
    await vi.advanceTimersByTimeAsync(10_000);
    waiting();
    await vi.advanceTimersByTimeAsync(4000);
    port.failure();
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(opened(provider)).toHaveLength(5);
  });

  it("keeps PiP, mute, the item and pending actions across reconnect without reopening Watch", async () => {
    const provider = signIn();
    const item = await watch();
    port.state(true);
    owner.pictureInPicture(true);
    owner.setMuted(true);
    const request = owner.request();
    port.failure();
    const before = owner.playbackState.get();
    expect(before).toMatchObject({
      phase: { kind: "loading", item },
      watch: false,
      pip: true,
      muted: true,
      aside: false,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    port.state(true);
    expect(owner.playbackState.get()).toMatchObject({
      phase: { kind: "playing", item },
      watch: false,
      pip: true,
      muted: true,
      aside: false,
    });
    expect(request.stands()).toBe(true);
    expect(opened(provider)).toEqual(["10", "10"]);
  });

  it.each(["pause", "close", "aside", "pip", "airplay"] as const)(
    "ends backoff once on %s",
    async (action) => {
      const provider = signIn();
      await watch();
      port.state(true);
      if (action === "pip") owner.pictureInPicture(true);
      if (action === "airplay") {
        port.emit("isExternalPlaybackActiveChange", { isExternalPlaybackActive: true });
        await owner.closeWatch();
      }
      const failed = vi.fn();
      owner.onPlaybackFailure(failed);
      port.failure({ kind: "network", evidence: null });
      expect(failed).not.toHaveBeenCalled();
      if (action === "pause") owner.togglePause();
      if (action === "close") await owner.closeWatch();
      if (action === "aside") owner.setAside();
      if (action === "pip") owner.pictureInPicture(false);
      if (action === "airplay")
        port.emit("isExternalPlaybackActiveChange", { isExternalPlaybackActive: false });
      expect(owner.playbackState.get().phase).toMatchObject({
        kind: "failed",
        error: "The connection to the provider failed.",
      });
      expect(failed.mock.calls).toEqual([["network"]]);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(opened(provider)).toEqual(["10"]);
      expect(failed).toHaveBeenCalledOnce();
    },
  );

  it("cancels a queued candidate before its held native drain permits another provider lookup", async () => {
    const provider = signIn();
    await watch();
    const stamp = port.identity();
    const drain = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(drain.promise);
    port.failure({ kind: "missing", evidence: null });
    await tick();
    owner.togglePause();
    drain.resolve(detached(stamp));
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["10"]);
    expect(owner.playbackState.get().phase.kind).toBe("failed");
  });

  it("replaces backoff with Stop, a new quality or an explicit fresh retry", async () => {
    const provider = signIn();
    await watch();
    port.state(true);
    port.failure();
    await owner.stop();
    await vi.advanceTimersByTimeAsync(8000);
    expect(opened(provider)).toEqual(["10"]);
    await watch();
    port.state(true);
    port.failure();
    expect(account.chooseChannelQuality(channel, "News", "11")).toBe(true);
    await tick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened(provider)).toEqual(["10", "10", "11"]);
    port.state(true);
    port.failure();
    owner.retry();
    await tick();
    expect(opened(provider)).toEqual(["10", "10", "11", "11"]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(opened(provider)).toHaveLength(4);
  });

  it("binds the Source across backoff and lets only explicit Try again bind the replacement", async () => {
    const old = signIn();
    await watch();
    port.state(true);
    port.failure();
    const replacement = signIn();
    const cancelled = owner.playbackState.get().phase.kind;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(old)).toEqual(["10"]);
    expect(opened(replacement)).toEqual([]);
    expect(cancelled).toBe("failed");
    owner.retry();
    await tick();
    expect(opened(replacement)).toEqual(["10"]);
  });

  it("a bound login replaced during reclaim permits zero lookups under either source", async () => {
    const old = signIn();
    const reclaim = deferred<void>();
    owner.onAdmission({ acquire: () => reclaim.promise, release: () => undefined });
    account.playChannel(channel, "News", { watch: true });
    await tick();
    const replacement = signIn();
    reclaim.resolve();
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(old)).toEqual([]);
    expect(opened(replacement)).toEqual([]);
    expect(port.replaceObservedAsync).not.toHaveBeenCalled();
  });

  it("replacing the login during lookup prevents late attach and all further opens", async () => {
    const old = signIn();
    const lookup = deferred<Awaited<ReturnType<typeof old.provider.liveStream>>>();
    old.provider.liveStream.mockReturnValueOnce(lookup.promise);
    account.playChannel(channel, "News", { watch: true });
    await tick();
    const replacement = signIn();
    lookup.resolve({ url: "file:retired.m3u8", format: "hls" });
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(old)).toEqual(["10"]);
    expect(opened(replacement)).toEqual([]);
    expect(port.replaceObservedAsync).not.toHaveBeenCalled();
    expect(owner.playbackState.get().phase.kind).toBe("idle");
  });

  it("waits for exact detach and lease return before reclaiming and opening the next candidate", async () => {
    const provider = signIn();
    const order: string[] = [];
    owner.onAdmission({
      acquire: async () => {
        order.push("acquire");
      },
      release: () => {
        order.push("release");
      },
    });
    provider.provider.liveStream.mockImplementation(async (id) => {
      order.push(`lookup:${id}`);
      return { url: `file:${id}.m3u8`, format: "hls" };
    });
    await watch();
    const stamp = port.identity();
    const drain = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(drain.promise);
    port.failure({ kind: "missing", evidence: null });
    await tick();
    expect(order).toEqual(["acquire", "lookup:10"]);
    expect(owner.playbackState.get().closing).toEqual(["sub"]);
    drain.resolve(detached(stamp));
    await tick();
    expect(order).toEqual(["acquire", "lookup:10", "release", "acquire", "lookup:11"]);
    expect(opened(provider)).toEqual(["10", "11"]);
  });

  it("a three-second detach timeout ends recovery without accepting late closure as permission to open", async () => {
    const provider = signIn();
    await watch();
    const stamp = port.identity();
    const drain = deferred<ObservedDetachResult>();
    port.detachObservedAsync.mockReturnValueOnce(drain.promise);
    port.failure({ kind: "missing", evidence: null });
    await tick();
    await vi.advanceTimersByTimeAsync(2999);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The previous stream is still closing. Try again.",
    });
    drain.resolve(detached(stamp));
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(opened(provider)).toEqual(["10"]);
    expect(owner.playbackState.get().closing).toEqual([]);
  });
});

describe("attended Live deadlines", () => {
  it("starts the twenty-second deadline at native attach, excluding reclaim and lookup", async () => {
    const provider = signIn();
    preferences.updateChannelPick(channel, "10");
    const reclaim = deferred<void>();
    const lookup = deferred<Awaited<ReturnType<typeof provider.provider.liveStream>>>();
    owner.onAdmission({ acquire: () => reclaim.promise, release: () => undefined });
    provider.provider.liveStream.mockReturnValueOnce(lookup.promise);
    account.playChannel(channel, "News", { watch: true });
    await tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opened(provider)).toEqual([]);
    reclaim.resolve();
    await tick();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.replaceObservedAsync).not.toHaveBeenCalled();
    lookup.resolve({ url: "file:10.m3u8", format: "hls" });
    await tick();
    port.state(false); // AVPlayer's initial paused sample is not a viewer Pause.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "No picture or sound within 20 s.",
    });
    expect(opened(provider)).toEqual(["10"]);
  });

  it("retains startup time across Close and return rather than restarting its budget", async () => {
    signIn();
    preferences.updateChannelPick(channel, "10");
    await watch();
    await vi.advanceTimersByTimeAsync(7000);
    await owner.closeWatch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    owner.openWatch();
    await vi.advanceTimersByTimeAsync(12_999);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "No picture or sound within 20 s.",
    });
    expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
  });

  it("keeps an initial paused Live item paused after Close during attach and return", async () => {
    const provider = signIn();
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    const attaching = deferred<void>();
    const replace = port.replaceObservedAsync.getMockImplementation();
    if (!replace) throw new Error("No native attach port");
    port.replaceObservedAsync.mockImplementationOnce(async (...args) => {
      await attaching.promise;
      const attached = await replace(...args);
      port.state(false); // The attached item's initial fact, before its admission reply.
      return attached;
    });
    try {
      const item = await watch();
      expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(7000);
      await owner.closeWatch();
      attaching.resolve();
      await tick();
      const attached = port.identity();
      expect(owner.playbackState.get().phase).toEqual({ kind: "paused", item });
      expect(port.play).not.toHaveBeenCalled();

      owner.openWatch();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "paused" } });
      expect(owner.playingItem(owner.playbackState.get().phase)).toBe(item);
      expect(opened(provider)).toEqual(["10"]);
      expect(port.identity()).toEqual(attached);
      expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
      expect(port.play).not.toHaveBeenCalled();
      expect(failed).not.toHaveBeenCalled();

      owner.togglePause();
      expect(port.play).toHaveBeenCalledOnce();
      waiting();
      await vi.advanceTimersByTimeAsync(12_999);
      expect(opened(provider)).toEqual(["10"]);
      expect(failed).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await tick();
      expect(opened(provider)).toEqual(["10", "11"]);
      expect(owner.playbackState.get().phase.kind).toBe("loading");
      expect(owner.playingItem(owner.playbackState.get().phase)).toBe(item);
    } finally {
      attaching.resolve();
      await tick();
    }
  });

  it("keeps a late-playing Live item paused after Close until Play resumes the startup remainder", async () => {
    const provider = signIn();
    const outcome = vi.fn();
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    const item = {
      id: channel.key,
      subscriptionId: channel.subscriptionId,
      title: channel.title,
      place: "News",
      live: true,
      next: false,
      versions: false,
    };
    await owner.play(
      item,
      {
        kind: "live",
        explicit: true,
        candidates: [
          {
            variantId: "10",
            open: async (signal) => {
              const stream = await provider.provider.liveStream("10", signal);
              return { url: stream.url, container: "m3u8" };
            },
          },
        ],
      },
      { watch: true, login: [], outcome },
    );
    const attached = port.identity();
    expect(port.play).toHaveBeenCalledOnce();
    port.state(false);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(7000);
    await owner.closeWatch();
    port.pause.mockClear();
    port.state(true);
    expect(port.pause).toHaveBeenCalledOnce();
    expect(outcome).not.toHaveBeenCalled();
    port.state(false);
    expect(owner.playbackState.get().phase).toEqual({ kind: "paused", item });

    owner.openWatch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(owner.playbackState.get()).toMatchObject({ watch: true, phase: { kind: "paused" } });
    expect(owner.playingItem(owner.playbackState.get().phase)).toBe(item);
    expect(opened(provider)).toEqual(["10"]);
    expect(port.identity()).toEqual(attached);
    expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
    expect(port.play).toHaveBeenCalledOnce();
    expect(failed).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();

    owner.togglePause();
    expect(port.play).toHaveBeenCalledTimes(2);
    waiting();
    await vi.advanceTimersByTimeAsync(12_999);
    expect(owner.playbackState.get().phase.kind).toBe("paused");
    expect(failed).not.toHaveBeenCalled();
    expect(outcome).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.playbackState.get().phase).toEqual({
      kind: "failed",
      item,
      error: "No picture or sound within 20 s.",
    });
    expect(opened(provider)).toEqual(["10"]);
    expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
    expect(failed.mock.calls).toEqual([["network"]]);
    expect(outcome.mock.calls).toEqual([[false]]);
  });

  it("counts stall time while waiting, resets on progress and publishes the deadline as network only at terminal", async () => {
    const provider = signIn();
    await watch();
    port.state(true);
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    await vi.advanceTimersByTimeAsync(14_000);
    port.currentTime = 1;
    waiting();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(opened(provider)).toEqual(["10"]);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    owner.togglePause();
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The stream stopped delivering data.",
    });
    expect(failed.mock.calls).toEqual([["network"]]);
  });

  it("excludes native-paused time from a stall and preserves its spent time on native Play", async () => {
    const provider = signIn();
    await watch();
    port.state(true);
    await vi.advanceTimersByTimeAsync(4000);
    port.state(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(opened(provider)).toEqual(["10"]);
    port.state(true);
    await vi.advanceTimersByTimeAsync(10_999);
    expect(owner.playbackState.get().phase.kind).toBe("playing");
    await vi.advanceTimersByTimeAsync(1);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(opened(provider)).toEqual(["10", "10"]);
  });

  it("a native Play after acknowledged viewer Pause permits recovery again", async () => {
    const provider = signIn();
    await watch();
    port.state(true);
    owner.togglePause();
    port.state(false);
    await vi.advanceTimersByTimeAsync(60_000);
    port.state(true);
    port.failure();
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(1000);
    await tick();
    expect(opened(provider)).toEqual(["10", "10"]);
  });

  it("does not overlap a never-finished native admission after its startup deadline", async () => {
    const provider = signIn();
    const admission = deferred<ObservedOpenResult>();
    port.replaceObservedAsync.mockReturnValueOnce(admission.promise);
    account.playChannel(channel, "News", { watch: true });
    await tick();
    const attemptId = port.replaceObservedAsync.mock.calls[0]![1];
    await vi.advanceTimersByTimeAsync(20_000);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    await vi.advanceTimersByTimeAsync(3000);
    expect(owner.playbackState.get().phase).toMatchObject({
      kind: "failed",
      error: "The previous stream is still closing. Try again.",
    });
    expect(opened(provider)).toEqual(["10"]);
    admission.resolve({ kind: "attached", attemptId, itemId: 1 });
    await tick();
    expect(port.replaceObservedAsync).toHaveBeenCalledOnce();
    expect(port.play).not.toHaveBeenCalled();
  });

  it("leaves Home preview without candidate fallback, startup or stall watchdogs", async () => {
    const provider = signIn();
    account.playChannel(channel, "News", { watch: false });
    await tick();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(owner.playbackState.get().phase.kind).toBe("loading");
    port.state(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(owner.playbackState.get().phase.kind).toBe("playing");
    port.failure();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(owner.playbackState.get().phase.kind).toBe("failed");
    expect(opened(provider)).toEqual(["10"]);
  });

  it.each(["provider", "copy"] as const)(
    "adds no deadline or recovery to a %s file",
    async (kind) => {
      const open = vi.fn(async () => ({ url: "file:movie.mp4", container: "mp4" }));
      await owner.play(
        {
          id: kind,
          subscriptionId: kind === "copy" ? null : "sub",
          title: "Movie",
          place: "",
          live: false,
          next: false,
          versions: false,
        },
        { kind: "file", originalLanguage: null, open },
        { watch: true, login: [] },
      );
      await vi.advanceTimersByTimeAsync(120_000);
      expect(owner.playbackState.get().phase.kind).toBe("loading");
      port.state(true);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(owner.playbackState.get().phase.kind).toBe("playing");
      port.failure();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(open).toHaveBeenCalledOnce();
      expect(owner.playbackState.get().phase.kind).toBe("failed");
    },
  );

  it("sends one successful outcome and one terminal failure per Epoch across automatic attempts", async () => {
    const outcome = vi.fn();
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    const open = vi.fn(async () => ({ url: "file:live.m3u8", container: "m3u8" }));
    await owner.play(
      {
        id: "live",
        subscriptionId: null,
        title: "Live",
        place: "",
        live: true,
        next: false,
        versions: false,
      },
      {
        kind: "live",
        explicit: false,
        candidates: [
          { variantId: "a", open },
          { variantId: "b", open },
        ],
      },
      { watch: true, login: [], outcome },
    );
    port.failure({ kind: "missing", evidence: null });
    await tick();
    expect(outcome).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    port.state(true);
    for (const delay of [1000, 2000, 4000, 8000]) {
      port.failure();
      await vi.advanceTimersByTimeAsync(delay);
      await tick();
      port.state(true);
    }
    port.failure();
    port.failure();
    expect(outcome.mock.calls).toEqual([[true]]);
    expect(failed.mock.calls).toEqual([["app"]]); // Unknown remains unknown, not a fabricated network cause.
    expect(open).toHaveBeenCalledTimes(6);
  });

  it("sends false only once when all candidates fail before the first playing", async () => {
    const outcome = vi.fn();
    const failed = vi.fn();
    owner.onPlaybackFailure(failed);
    const open = async () => ({ url: "file:live.m3u8", container: "m3u8" });
    await owner.play(
      {
        id: "live",
        subscriptionId: null,
        title: "Live",
        place: "",
        live: true,
        next: false,
        versions: false,
      },
      {
        kind: "live",
        explicit: false,
        candidates: [
          { variantId: "a", open },
          { variantId: "b", open },
        ],
      },
      { watch: true, login: [], outcome },
    );
    port.failure();
    await tick();
    expect(outcome).not.toHaveBeenCalled();
    port.failure();
    port.failure();
    expect(outcome.mock.calls).toEqual([[false]]);
    expect(failed.mock.calls).toEqual([["app"]]);
  });
});
