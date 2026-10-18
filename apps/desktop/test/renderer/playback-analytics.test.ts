// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import {
  observeMediaPlayback,
  PlaybackObservation,
  playbackFailure,
} from "../../src/renderer/src/player/analytics.ts";
import { appFailure } from "@mrstreamer/contracts/analytics";
import type { AnalyticsPlaybackState } from "@mrstreamer/contracts/analytics";

afterEach(() => vi.useRealTimers());

it("preserves the renderer's output-error projection while main and iOS keep theirs", () => {
  for (const kind of ["unreachable", "not-fetched", "no-network"] as const) {
    const error = { kind: "output", failure: { kind } } as const;
    expect(playbackFailure(error)).toBe("unavailable");
    expect(appFailure(error)).toBe("network");
  }
  const error = {
    kind: "output",
    failure: { kind: "media", detail: "PRIVATE missing codec" },
  } as const;
  expect(playbackFailure(error)).toBe("unavailable");
  expect(appFailure(error)).toBe("unsupported");
});
it("requires unpaused progress after waiting and seek, and stops renewing when the engine ends", async () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  let paused = true,
    seeking = false;
  Object.defineProperties(video, {
    paused: { get: () => paused },
    seeking: { get: () => seeking },
  });
  const states: AnalyticsPlaybackState[] = [];
  const observed = observeMediaPlayback(video);
  observed.listen((state) => states.push(state));
  video.currentTime = 100;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("paused");
  paused = false;
  video.dispatchEvent(new Event("play"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("waiting");
  video.currentTime += 2;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("playing");
  seeking = true;
  video.currentTime += 100;
  video.dispatchEvent(new Event("seeking"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("seeking");
  seeking = false;
  video.dispatchEvent(new Event("seeked"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("waiting");
  video.currentTime += 0.5;
  await vi.advanceTimersByTimeAsync(1000);
  expect(states.at(-1)).toBe("playing");
  video.dispatchEvent(new Event("waiting"));
  expect(states.at(-1)).toBe("waiting");
  observed.stop();
  const count = states.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(states).toHaveLength(count);
  expect(states.at(-1)).toBe("stopped");
});

it("sends only guarded fixed facts and a main-issued binding, discarding a delayed binding after a replacement", async () => {
  ipc.reset();
  const token = "11111111-1111-4111-8111-111111111111";
  const binding = "22222222-2222-4222-8222-222222222222";
  ipc.always("analytics.playbackBegin", token);
  const delayed = ipc.hold("analytics.playbackBind");
  ipc.always("analytics.playbackBind", binding);
  const observed = new PlaybackObservation("vod");
  observed.begin();
  expect(observed.measurement()).toEqual(ipc.argsOf("analytics.playbackBegin")[0]?.measurement);
  observed.bind("old-session");
  await Promise.resolve();
  observed.note("playing");
  observed.bind("current-session");
  observed.note("paused");
  delayed.resolve("33333333-3333-4333-8333-333333333333");
  await vi.waitFor(() => expect(ipc.argsOf("analytics.playbackState").length).toBeGreaterThan(0));
  expect(ipc.argsOf("analytics.playbackState").every((state) => state.binding === binding)).toBe(
    true,
  );
  expect(ipc.argsOf("analytics.playbackState").at(-1)?.state).toBe("paused");
  expect(
    ipc
      .argsOf("analytics.playbackState")
      .every((state) => Object.keys(state).sort().join() === "binding,sequence,state,token"),
  ).toBe(true);
  observed.end();
});

it("counts different explicit channel selections, excluding previews, first selection, duplicate selection and quality retry", async () => {
  ipc.reset();
  const { player } = await import("../../src/renderer/src/player/player.ts");
  player.stop();
  const channel = (id: string) => ({
    subscriptionId: SUBSCRIPTION,
    id,
    name: id,
    title: id,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    catchupDays: null,
    variants: [{ id, name: id, tags: [], quality: null }],
  });
  player.preview(channel("private-channel-a"));
  player.watch(channel("private-channel-a"));
  player.watch(channel("private-channel-a"));
  player.play(channel("private-channel-b"));
  player.reopen();
  player.zap(channel("private-channel-c"));
  player.zap(channel("private-channel-c"));
  expect(ipc.argsOf("analytics.action")).toEqual(["channel_changed", "channel_changed"]);
  player.stop();
});

it("ends the live measurement on reset and treats the next selection as the first, including after subscription reset", async () => {
  ipc.reset();
  const { player } = await import("../../src/renderer/src/player/player.ts");
  player.reset();
  ipc.reset();
  const token = "11111111-1111-4111-8111-111111111111";
  ipc.always("analytics.playbackBegin", token);
  const channel = (id: string) => ({
    subscriptionId: SUBSCRIPTION,
    id,
    name: id,
    title: id,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    catchupDays: null,
    variants: [{ id, name: id, tags: [], quality: null }],
  });
  player.watch(channel("first"));
  await vi.waitFor(() => expect(ipc.argsOf("analytics.playbackBegin")).toHaveLength(1));
  const control = ipc.argsOf("analytics.playbackBegin")[0]!.measurement.control;
  player.reset();
  await vi.waitFor(() => expect(ipc.argsOf("analytics.playbackEnd")).toEqual([{ token: control }]));
  ipc.emit("analytics.reset", null);
  expect(ipc.argsOf("analytics.playbackBegin")).toHaveLength(1);
  player.watch(channel("first"));
  player.reset();
  player.watch(channel("another"));
  expect(ipc.argsOf("analytics.playbackBegin")).toHaveLength(3);
  expect(ipc.argsOf("analytics.action")).toEqual([]);
  player.stop();
});

it("reports a live mid-play network failure on its closed binding while recovery replaces the session", async () => {
  vi.useFakeTimers();
  ipc.reset();
  const { player } = await import("../../src/renderer/src/player/player.ts");
  const { openWatch } = await import("../../src/renderer/src/app/ui-store.ts");
  player.reset();
  ipc.reset();
  const token = "11111111-1111-4111-8111-111111111111";
  const binding = "22222222-2222-4222-8222-222222222222";
  ipc.always("analytics.playbackBegin", token);
  ipc.always("analytics.playbackBind", binding);
  const channel = {
    subscriptionId: SUBSCRIPTION,
    id: "live",
    name: "Live",
    title: "Live",
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    catchupDays: null,
    variants: [{ id: "live", name: "Live", tags: [], quality: null }],
  };
  const open = ipc.hold("playback.open");
  player.setAudible(true);
  openWatch();
  await act(async () => player.play(channel));
  await act(async () =>
    open.resolve({
      sessionId: "session",
      channel: { subscriptionId: SUBSCRIPTION, id: "live" },
      url: "http://127.0.0.1/stream/session",
      format: "hls",
    }),
  );
  for (let second = 0; second < 40; second++) {
    player.element.currentTime += 1;
    await act(async () => vi.advanceTimersByTimeAsync(1000));
  }
  expect(player.state().phase.kind).toBe("playing");
  const failure = ipc.hold("playback.failure");
  const playing = ipc.hold("playback.playing");
  await act(async () => player.element.dispatchEvent(new Event("error")));
  await act(async () => {
    failure.resolve({ kind: "network", detail: "Private fixture detail" });
    playing.resolve(null);
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(ipc.argsOf("playback.close")).toContainEqual({ sessionId: "session" });
  const control = ipc.argsOf("analytics.playbackBegin")[0]!.measurement.control;
  expect(ipc.argsOf("analytics.playbackFailure")).toEqual([
    {
      token: control,
      binding,
      failure: "network",
      diagnostic: { diagnostic_stage: "deliver", diagnostic_reason: "network" },
    },
  ]);
  player.reset();
});
