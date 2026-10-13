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
  oldPreferences.resolve(defaultPreferences);
  await settle();
  expect(ipc.argsOf("playback.open")).toHaveLength(1);
  expect(ipc.argsOf("playback.open")[0]).toMatchObject({
    channel: { id: "new" },
    measurement: current,
  });
  expect(ipc.argsOf("analytics.playbackBind").at(-1)?.measurement).toEqual(current);
});
