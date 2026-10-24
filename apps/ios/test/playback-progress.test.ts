import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { nativePlayer } from "./native-player.ts";

// Real playback and progress callbacks, with native observations delivered once a second.
const port = nativePlayer();
vi.mock("expo-video", () => ({ createVideoPlayer: () => port }));
const { play, playbackClock, playbackState, progressSettled, stop, togglePause } =
  await import("../src/playback.ts");
const saves: Array<{ id: string; at: number; position: number; duration: number }> = [];

async function watching(id: string) {
  await play(
    { id, subscriptionId: null, title: id, place: "", live: false, next: false, versions: false },
    async () => ({ url: `file:${id}.mp4`, container: "mp4" }),
    {
      watch: true,
      login: [],
      progress: async (position, duration) => {
        saves.push({ id, at: Date.now(), position, duration });
      },
    },
  );
  port.currentTime = 0;
  port.state(true);
}

/** Media time and a valid playing observation advance once per second. */
async function playingFor(seconds: number) {
  for (let second = 1; second <= seconds; second++) {
    port.currentTime = second;
    await vi.advanceTimersByTimeAsync(1000);
    port.state(true);
  }
  await progressSettled();
}

beforeEach(async () => {
  await stop();
  saves.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  await stop();
  vi.useRealTimers();
});

describe("periodic progress under managed playback observations", () => {
  it("repeated playing samples update the clock without republishing the playback phase", async () => {
    await watching("movie");
    const transitions = vi.fn();
    const clock = vi.fn();
    onTestFinished(playbackState.subscribe(transitions));
    onTestFinished(playbackClock.subscribe(clock));
    await playingFor(5);
    expect(playbackState.get().phase.kind).toBe("playing");
    expect(playbackClock.get()).toBe(5);
    expect(clock).toHaveBeenCalledTimes(5);
    expect(transitions).not.toHaveBeenCalled();
  });

  it("saves every minute through second-by-second playing samples, then stops while paused", async () => {
    await watching("movie");
    const transitions = vi.fn();
    const clock = vi.fn();
    onTestFinished(playbackState.subscribe(transitions));
    onTestFinished(playbackClock.subscribe(clock));
    await playingFor(125);
    expect(saves).toEqual([
      { id: "movie", at: 60_000, position: 60, duration: 600 },
      { id: "movie", at: 120_000, position: 120, duration: 600 },
    ]);
    expect(transitions).not.toHaveBeenCalled();
    expect(clock).toHaveBeenCalledTimes(125);

    togglePause();
    port.state(false);
    await progressSettled();
    expect(saves.at(-1)).toEqual({ id: "movie", at: 125_000, position: 125, duration: 600 });
    const paused = [...saves];
    await vi.advanceTimersByTimeAsync(120_000);
    port.state(false);
    await progressSettled();
    expect(saves).toEqual(paused);
    expect(transitions).toHaveBeenCalledOnce();
  });

  it("saves the replaced item once and keeps the new item's minute cadence and positions separate", async () => {
    await watching("old");
    await playingFor(45);
    const old = port.identity();
    await watching("new");
    port.observation(
      {
        kind: "state",
        timeControl: "playing",
        mediaTimeSeconds: 999,
        bufferEmpty: false,
        likelyToKeepUp: true,
      },
      old,
    );
    await playingFor(70);
    expect(saves).toEqual([
      { id: "old", at: 45_000, position: 45, duration: 600 },
      { id: "new", at: 105_000, position: 60, duration: 600 },
    ]);

    await expect(stop()).resolves.toEqual({ saved: true });
    expect(saves.at(-1)).toEqual({ id: "new", at: 115_000, position: 70, duration: 600 });
    const stopped = [...saves];
    await vi.advanceTimersByTimeAsync(120_000);
    expect(saves).toEqual(stopped);
  });
});
