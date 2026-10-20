// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyticsPlaybackState } from "@mrstreamer/contracts/analytics";
import type { OutputStatus, RemoteMedia } from "@mrstreamer/contracts/output";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

// The media engine confirms/ends playback independently of the optional analytics bridge.
const mediaEngine = vi.hoisted(() => ({ starts: [] as number[], ended: () => {} }));
vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    if (run.paused) video.pause();
    else void video.play();
    mediaEngine.starts.push(run.start);
    return {
      started: Promise.resolve(),
      onPlayback(listener: (state: AnalyticsPlaybackState) => void) {
        listener(run.paused ? "paused" : "playing");
      },
      onFailure() {},
      onEnded(listener: () => void) {
        mediaEngine.ended = listener;
      },
      position: () => run.start,
      played: () => 0,
      seekWithin: () => false,
      onSubtitles() {},
      hideSubtitles() {},
      info: () => ({
        width: null,
        height: null,
        fps: null,
        videoCodec: null,
        audioCodec: null,
        audioChannels: null,
      }),
      destroy() {},
    };
  },
}));

const channel = {
  subscriptionId: SUBSCRIPTION,
  id: "fixture",
  name: "Fixture",
  title: "Fixture",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "fixture", name: "Fixture", tags: [], quality: null }],
};
const title = { kind: "movie" as const, subscriptionId: SUBSCRIPTION, id: "fixture" };
const now = {
  kind: "provider" as const,
  title,
  name: "Fixture",
  detail: null,
  artworkUrl: null,
  originalLanguage: "en",
};
const localTitle = {
  sessionId: "local-title",
  title,
  url: "http://127.0.0.1/title",
  duration: 120,
  audio: [],
  subtitles: [],
};
const receiver = { id: "fixture-tv", kind: "cast" as const, name: "Fixture TV" };
const local: OutputStatus = {
  offers: ["cast"],
  airplayRoutes: null,
  scanning: false,
  receivers: [receiver],
  output: { kind: "local" },
};
const remoteMedia = (state: RemoteMedia["state"] = "playing", generation = 1): RemoteMedia => ({
  generation,
  sessionId: "remote-title",
  item: { kind: "title", title },
  state,
  position: state === "ended" ? 120 : 20,
  at: Date.now(),
  duration: 120,
  subtitles: false,
});
const remote = (media: RemoteMedia | null = null): OutputStatus => ({
  ...local,
  output: {
    kind: "receiver",
    receiver,
    volume: { level: 0.5, muted: false },
    media,
    failure: null,
  },
});
const emit = (status: OutputStatus) => act(async () => ipc.emit("output.changed", status));
const settle = () => act(async () => vi.advanceTimersByTimeAsync(0));

function unavailable(
  mode: "pending" | "rejected",
  method: "analytics.playbackBegin" | "analytics.playbackResume" = "analytics.playbackBegin",
) {
  if (mode === "pending") return ipc.hold(method);
  ipc.refuse(method, { kind: "unexpected", detail: "Optional observer unavailable" });
  return null;
}

beforeEach(async () => {
  vi.useFakeTimers();
  titlePlayer.close();
  player.reset();
  await emit(local);
  ipc.reset();
  mediaEngine.starts.length = 0;
  ipc.always("playback.open", {
    sessionId: "live",
    channel: { subscriptionId: SUBSCRIPTION, id: "fixture" },
    url: "http://127.0.0.1/live",
    format: "hls",
  });
  ipc.always("playback.openTitle", localTitle);
  ipc.always("playback.openCopy", { ...localTitle, copy: "fixture-copy", progress: null });
  ipc.always("output.openTitle", {
    sessionId: "remote-title",
    title,
    duration: 120,
    audio: [],
    subtitles: [],
    shows: ["text"],
  });
  ipc.always("output.playTitle", remoteMedia("loading"));
  ipc.always("output.playChannel", {
    ...remoteMedia(),
    item: { kind: "channel", channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
  });
  ipc.always("analytics.playbackBind", "22222222-2222-4222-8222-222222222222");
});
afterEach(async () => {
  titlePlayer.close();
  player.reset();
  await emit(local);
  await settle();
  vi.useRealTimers();
});

describe.each(["pending", "rejected"] as const)("optional measurement reply %s", (mode) => {
  it.each(["live", "provider", "copy"] as const)(
    "admits local %s and obtains a usable media result independently",
    async (kind) => {
      const reply = unavailable(mode);
      if (kind === "live") player.watch(channel);
      else
        void titlePlayer.open(
          kind === "provider" ? now : { ...now, kind: "copy", copy: "fixture-copy" },
          0,
        );
      await settle();
      const hint = ipc.argsOf("analytics.playbackBegin")[0]!.measurement;
      const args =
        kind === "live"
          ? ipc.argsOf("playback.open")
          : kind === "provider"
            ? ipc.argsOf("playback.openTitle")
            : ipc.argsOf("playback.openCopy");
      expect(args).toHaveLength(1);
      expect(args[0]?.measurement).toEqual(hint);
      if (kind === "live") {
        player.element.currentTime += 1;
        await act(async () => vi.advanceTimersByTimeAsync(1000));
        expect(player.state().phase.kind).toBe("playing");
      } else expect(titlePlayer.state().phase.kind).toBe("playing");
      expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(hint);
      reply?.resolve("99999999-9999-4999-8999-999999999999");
      await settle();
      expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(hint);
    },
  );

  it("admits a receiver live request independently", async () => {
    await emit(remote());
    unavailable(mode);
    player.watch(channel);
    await settle();
    expect(ipc.argsOf("output.playChannel")).toHaveLength(1);
    expect(ipc.argsOf("output.playChannel")[0]?.measurement).toEqual(
      ipc.argsOf("analytics.playbackBegin")[0]?.measurement,
    );
    await emit(
      remote({
        ...remoteMedia(),
        item: { kind: "channel", channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
      }),
    );
    expect(player.state().phase.kind).toBe("playing");
  });

  it("prepares and loads receiver VOD, then reloads the same intent independently", async () => {
    await emit(remote());
    unavailable(mode);
    void titlePlayer.open(now, 0);
    await settle();
    const hint = ipc.argsOf("analytics.playbackBegin")[0]!.measurement;
    expect(ipc.argsOf("output.openTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.openTitle")[0]?.measurement).toEqual(hint);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.playTitle")[0]?.measurement).toEqual(hint);
    await emit(remote(remoteMedia("playing")));
    // A track reload uses the still-open receiver session without another logical begin.
    titlePlayer.setSubtitle({
      id: 1,
      page: null,
      format: "text",
      language: "en",
      label: "English",
      forced: false,
      default: false,
    });
    await settle();
    expect(ipc.argsOf("output.playTitle")).toHaveLength(2);
    expect(ipc.argsOf("output.playTitle").at(-1)?.measurement).toEqual(hint);
    expect(ipc.argsOf("analytics.playbackBegin")).toHaveLength(1);
  });

  it("replays a receiver with a fresh immediate hint without reopening preparation", async () => {
    await emit(remote());
    void titlePlayer.open(now, 0);
    await settle();
    await emit(remote(remoteMedia("ended")));
    const original = ipc.argsOf("output.playTitle")[0]!.measurement!;
    unavailable(mode);
    titlePlayer.togglePause();
    await settle();
    const replay = ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement;
    expect(replay.control).not.toBe(original.control);
    expect(replay.order).toBeGreaterThan(original.order);
    expect(ipc.argsOf("output.openTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(2);
    expect(ipc.argsOf("output.playTitle").at(-1)).toMatchObject({
      measurement: replay,
      position: 0,
    });
  });

  it("replays a local title using its existing session despite a missing begin response", async () => {
    await titlePlayer.open(now, 0);
    await settle();
    await act(async () => mediaEngine.ended());
    expect(titlePlayer.state().phase.kind).toBe("ended");
    unavailable(mode);
    titlePlayer.togglePause();
    await settle();
    expect(mediaEngine.starts).toEqual([0, 0]);
    expect(titlePlayer.state().phase.kind).toBe("playing");
    const replay = ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement;
    expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(replay);
    expect(ipc.argsOf("playback.openTitle")).toHaveLength(1);
  });

  it("adopts live receiver playback and moves here independently of its resume response", async () => {
    const media = {
      ...remoteMedia(),
      item: { kind: "channel" as const, channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
    };
    await emit(remote(media));
    unavailable(mode, "analytics.playbackResume");
    player.adopt(channel, media);
    const hint = ipc.argsOf("analytics.playbackResume").at(-1)!.measurement;
    player.playHere();
    await emit(local);
    await settle();
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(ipc.argsOf("playback.open")[0]?.measurement).toEqual(hint);
    expect(hint.ongoing).toBe(true);
    expect(player.state().phase.kind).toBe("playing");
  });

  it("adopts paused receiver playback and returns here without a resume reply", async () => {
    const media = remoteMedia("paused");
    await emit(remote(media));
    unavailable(mode, "analytics.playbackResume");
    titlePlayer.adopt(
      now,
      {
        sessionId: media.sessionId,
        duration: 120,
        audio: [],
        subtitles: [],
        shows: ["text"],
        audioId: null,
        subtitleId: null,
        since: Date.now(),
      },
      media,
    );
    const hint = ipc.argsOf("analytics.playbackResume").at(-1)!.measurement;
    titlePlayer.setShown(true);
    titlePlayer.playHere();
    await emit(local);
    await settle();
    expect(ipc.argsOf("playback.openTitle")).toHaveLength(1);
    expect(ipc.argsOf("playback.openTitle")[0]?.measurement).toEqual(hint);
    expect(hint.ongoing).toBe(true);
    expect(titlePlayer.state().phase.kind).toBe("paused");
    expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(hint);
  });
});

it("ignores obsolete begin replies and preferences without admitting an older channel after a newer choice", async () => {
  const oldReply = ipc.hold("analytics.playbackBegin");
  const oldPreferences = ipc.hold("preferences.get");
  player.watch(channel);
  player.watch({ ...channel, id: "new", variants: [{ ...channel.variants[0]!, id: "new" }] });
  await settle();
  const current = ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement;
  oldReply.resolve("99999999-9999-4999-8999-999999999999");
  oldPreferences.resolve(ipc.snapshot(defaultPreferences));
  await settle();
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.open")[0]).toMatchObject({
    channel: { id: "new" },
    measurement: current,
  });
  expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(current);
});

describe("switching between live and title playback", () => {
  it("leaves a receiver title playing when catch-up is refused there", async () => {
    await emit(remote());
    await titlePlayer.open(now, 0);
    await settle();
    player.playArchive(channel, {
      start: Date.now() - 60_000,
      stop: Date.now() + 60_000,
      title: "Earlier programme",
      description: null,
    });
    await settle();
    expect(titlePlayer.state().now).toEqual(now);
    expect(titlePlayer.onReceiver()).toBe(true);
    expect(ipc.argsOf("output.playTitle")).toHaveLength(1);
    expect(ipc.argsOf("output.playChannel")).toHaveLength(0);
    expect(ipc.argsOf("output.command")).toHaveLength(0);
    expect(ipc.argsOf("playback.open")).toHaveLength(0);
  });

  it.each(["preview", "retry", "reopen"] as const)(
    "does not let a stale live %s interrupt an open title",
    async (action) => {
      player.watch(channel);
      await settle();
      await titlePlayer.open(now, 0);
      await settle();
      if (action === "preview") player.preview(channel);
      else player[action]();
      await settle();
      expect(ipc.argsOf("playback.open")).toHaveLength(1);
      expect(titlePlayer.state().phase.kind).toBe("playing");
      expect(player.state().phase.kind).toBe("idle");
    },
  );

  it.each([false, true])(
    "does not send an obsolete preview after its preferences answer, newer live selection %s",
    async (returnToLive) => {
      const pending = ipc.hold("preferences.get");
      player.preview(channel);
      await titlePlayer.open(now, 0);
      await settle();
      const newer = {
        ...channel,
        id: "newer",
        variants: [{ ...channel.variants[0]!, id: "newer" }],
      };
      if (returnToLive) {
        player.watch(newer);
        await settle();
      }
      pending.resolve(ipc.snapshot(defaultPreferences));
      await settle();
      expect(ipc.argsOf("playback.open").map((args) => args.channel.id)).toEqual(
        returnToLive ? ["newer"] : [],
      );
      if (returnToLive) expect(player.state().channel?.id).toBe("newer");
      else expect(titlePlayer.state().phase.kind).toBe("playing");
    },
  );

  it.each(["play", "archive", "zap"] as const)(
    "%s closes the title before opening a live session",
    async (action) => {
      await titlePlayer.open(now, 0);
      await settle();
      if (action === "archive")
        player.playArchive(channel, {
          start: Date.now() - 60_000,
          stop: Date.now() + 60_000,
          title: "Earlier programme",
          description: null,
        });
      else player[action](channel);
      // Zap relinquishes the title immediately, before its delayed channel open.
      expect(titlePlayer.state().now).toBeNull();
      expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "local-title" });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(ipc.argsOf("playback.open")).toHaveLength(1);
      const methods = ipc.methods();
      expect(methods.indexOf("playback.close")).toBeLessThan(methods.indexOf("playback.open"));
    },
  );

  it("closes the preview before opening a title and allows a preview after the title closes", async () => {
    player.preview(channel);
    await settle();
    await titlePlayer.open(now, 0);
    await settle();
    expect(player.state().phase.kind).toBe("idle");
    expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "live" });
    const methods = ipc.methods();
    expect(methods.indexOf("playback.close")).toBeLessThan(methods.indexOf("playback.openTitle"));
    titlePlayer.close();
    player.preview(channel);
    await settle();
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(ipc.argsOf("playback.open").at(-1)?.preview).toBe(true);
  });

  it("promotes the existing preview to Watch without closing or reopening it", async () => {
    player.preview(channel);
    await settle();
    player.watch(channel);
    await settle();
    expect(ipc.argsOf("playback.open")).toHaveLength(1);
    expect(ipc.argsOf("playback.close")).toHaveLength(0);
  });

  it.each(["live", "title"] as const)(
    "replaces receiver %s controls without sending a stop for that load",
    async (first) => {
      await emit(remote());
      if (first === "live") {
        player.watch(channel);
        await settle();
        await titlePlayer.open(now, 0);
        await settle();
        expect(player.onReceiver()).toBe(false);
        expect(player.state().phase.kind).toBe("idle");
        expect(titlePlayer.onReceiver()).toBe(true);
      } else {
        await titlePlayer.open(now, 0);
        await settle();
        player.watch(channel);
        await settle();
        expect(titlePlayer.state().now).toBeNull();
        expect(titlePlayer.onReceiver()).toBe(false);
        expect(player.onReceiver()).toBe(true);
      }
      expect(ipc.argsOf("output.command").filter((args) => args.command === "stop")).toEqual([]);
    },
  );

  it("relinquishes an adopted receiver channel when a title replaces it", async () => {
    // A prior title has fully closed before adoption, as after returning to an idle window.
    await titlePlayer.open(now, 0);
    titlePlayer.close();
    const media = {
      ...remoteMedia(),
      item: { kind: "channel" as const, channel: { subscriptionId: SUBSCRIPTION, id: "fixture" } },
    };
    await emit(remote(media));
    player.adopt(channel, media);
    await titlePlayer.open(now, 0);
    await settle();
    expect(player.onReceiver()).toBe(false);
    expect(player.state().phase.kind).toBe("idle");
    expect(titlePlayer.onReceiver()).toBe(true);
    expect(ipc.argsOf("output.command").filter((args) => args.command === "stop")).toEqual([]);
  });

  it("closes a live retry started after a title closes before opening the next title", async () => {
    player.watch(channel);
    await settle();
    await titlePlayer.open(now, 0);
    titlePlayer.close();
    player.retry();
    await settle();
    await titlePlayer.open(now, 0);
    await settle();
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(ipc.argsOf("playback.close").filter((args) => args.sessionId === "live")).toHaveLength(
      2,
    );
    const methods = ipc.methods();
    expect(methods.lastIndexOf("playback.close")).toBeLessThan(
      methods.lastIndexOf("playback.openTitle"),
    );
    expect(player.state().phase.kind).toBe("idle");
  });

  it("closes adopted receiver title controls when a live channel replaces them", async () => {
    await titlePlayer.open(now, 0);
    titlePlayer.close();
    const media = remoteMedia();
    await emit(remote(media));
    titlePlayer.adopt(
      now,
      {
        sessionId: media.sessionId,
        duration: 120,
        audio: [],
        subtitles: [],
        shows: ["text"],
        audioId: null,
        subtitleId: null,
        since: Date.now(),
      },
      media,
    );
    player.watch(channel);
    await settle();
    expect(titlePlayer.state().now).toBeNull();
    expect(titlePlayer.onReceiver()).toBe(false);
    expect(player.onReceiver()).toBe(true);
    expect(ipc.argsOf("output.command").filter((args) => args.command === "stop")).toEqual([]);
  });
});
