// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EngineError } from "../../src/renderer/src/player/engine.ts";
import type { TitleRun } from "../../src/renderer/src/player/title-engine.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const runs = vi.hoisted(
  () =>
    [] as {
      readonly run: TitleRun;
      position: number;
      played: number;
      destroyed: boolean;
      start(): void;
      fail(error: EngineError): void;
    }[],
);

// The controller sees only the engine's public start, progress and failure contract.
vi.mock("../../src/renderer/src/player/title-engine.ts", () => ({
  titleEngine(video: HTMLVideoElement, run: TitleRun) {
    const { promise: started, resolve, reject } = Promise.withResolvers<void>();
    let failure: ((error: EngineError) => void) | null = null;
    let playing = false;
    const entry = {
      run,
      position: run.start,
      played: 0,
      destroyed: false,
      start() {
        playing = true;
        if (run.paused) video.pause();
        else void video.play();
        resolve();
      },
      fail(error: EngineError) {
        if (playing) failure?.(error);
        else reject(error);
      },
    };
    runs.push(entry);
    return {
      started,
      onFailure(listener: (error: EngineError) => void) {
        failure = listener;
      },
      onEnded() {},
      onSubtitles() {},
      hideSubtitles() {},
      position: () => entry.position,
      played: () => entry.played,
      seekWithin: () => false,
      info: () => ({}),
      destroy() {
        entry.destroyed = true;
      },
    };
  },
}));

const now = {
  kind: "provider" as const,
  title: { kind: "movie" as const, subscriptionId: SUBSCRIPTION, id: "1" },
  name: "Night Harbour",
  detail: null,
  artworkUrl: null,
  originalLanguage: null,
};
const dropped = { kind: "network", detail: "Connection lost" } as const;
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  runs.length = 0;
  ipc.always("playback.failure", null);
  ipc.always("playback.openTitle", {
    sessionId: "title-session",
    title: now.title,
    url: "http://127.0.0.1/title/fixture",
    duration: 600,
    audio: [
      { id: 1, language: "en", label: "English", default: true },
      { id: 2, language: "es", label: "Spanish", default: false },
    ],
    subtitles: [
      {
        id: 3,
        language: "en",
        label: "English",
        format: "text",
        page: null,
        forced: false,
        default: false,
      },
    ],
  });
  ipc.always("analytics.playbackBind", "22222222-2222-4222-8222-222222222222");
});
afterEach(() => {
  titlePlayer.close();
  vi.useRealTimers();
});

async function open() {
  void titlePlayer.open(now, 12);
  await settle();
  expect(runs).toHaveLength(1);
}

it("tries converted sound once for local media and then fails without a network retry", async () => {
  await open();
  runs[0]!.fail({ kind: "media", detail: "Local decoder diagnostic" });
  await settle();
  expect(runs).toHaveLength(2);
  expect(runs[1]!.run).toMatchObject({ start: 12, convertSound: true });
  runs[1]!.fail({ kind: "media", detail: "Local decoder diagnostic" });
  await settle();
  expect(titlePlayer.state().phase).toMatchObject({
    kind: "failed",
    problem: { kind: "unsupported" },
  });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(runs).toHaveLength(2);
  expect(ipc.argsOf("analytics.playbackFailure")).toEqual([
    expect.objectContaining({ failure: "unsupported" }),
  ]);
  expect(JSON.stringify(ipc.argsOf("analytics.playbackFailure"))).not.toContain("diagnostic");
});

it.each([
  { kind: "refused", status: 403 },
  { kind: "unavailable", status: 404 },
  { kind: "provider-error", status: 503 },
  { kind: "unsupported", detail: "Proxy codec diagnostic" },
] as const)(
  "preserves main's typed $kind failure over a renderer network failure",
  async (failure) => {
    await open();
    ipc.always("playback.failure", failure);
    runs[0]!.fail(dropped);
    await settle();
    expect(titlePlayer.state().phase).toMatchObject({
      kind: "failed",
      problem: { kind: failure.kind },
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toHaveLength(1);
  },
);

it("keeps a main transport failure on reconnect instead of converting sound", async () => {
  await open();
  ipc.always("playback.failure", dropped);
  runs[0]!.fail({ kind: "media", detail: "Decoder diagnostic" });
  await settle();
  expect(titlePlayer.state().phase).toMatchObject({ kind: "reconnecting", attempt: 1 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(runs).toHaveLength(2);
  expect(runs[1]!.run.convertSound).toBe(false);
});

/** Returns a picture briefly, then loses it at its latest position. */
async function relapse(played = 1000) {
  const current = runs.at(-1)!;
  current.start();
  await settle();
  current.played = played;
  current.position += played / 1000;
  current.fail(dropped);
  await settle();
  expect(current.destroyed).toBe(true);
}

it("exhausts four 1/2/4/8-second retries across one-second returns", async () => {
  await open();
  for (const [index, delay] of [1000, 2000, 4000, 8000].entries()) {
    await relapse();
    expect(titlePlayer.state().phase).toMatchObject({
      kind: "reconnecting",
      attempt: index + 1,
      of: 4,
    });
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(runs).toHaveLength(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(runs).toHaveLength(index + 2);
    expect(runs.at(-1)!.run.start).toBe(13 + index);
  }
  await relapse();
  expect(titlePlayer.state().phase).toMatchObject({ kind: "failed", problem: { kind: "network" } });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(runs).toHaveLength(5);
  // Recovery stays within the original logical play and proxy session.
  expect(ipc.argsOf("analytics.playbackBegin")).toHaveLength(1);
  expect(ipc.argsOf("playback.openTitle")).toHaveLength(1);
  titlePlayer.retry();
  await settle();
  expect(runs).toHaveLength(6);
  await relapse();
  expect(titlePlayer.state().phase).toMatchObject({ kind: "reconnecting", attempt: 1 });
});

it.each([29_999, 30_000])(
  "restores the budget only after 30 seconds of progress, played=%s",
  async (played) => {
    await open();
    await relapse();
    await vi.advanceTimersByTimeAsync(1000);
    await relapse(played);
    expect(titlePlayer.state().phase).toMatchObject({
      kind: "reconnecting",
      attempt: played >= 30_000 ? 1 : 2,
    });
  },
);

it("keeps earned stability when a healthy run is replaced by a seek", async () => {
  await open();
  await relapse();
  await vi.advanceTimersByTimeAsync(1000);
  runs.at(-1)!.start();
  await settle();
  runs.at(-1)!.played = 30_000;
  titlePlayer.seek(80);
  await relapse();
  expect(titlePlayer.state().phase).toMatchObject({ kind: "reconnecting", attempt: 1 });
});

it("preserves position, pause and chosen tracks without resetting the budget for a new run", async () => {
  await open();
  await relapse();
  await vi.advanceTimersByTimeAsync(1000);
  runs.at(-1)!.start();
  await settle();
  titlePlayer.togglePause();
  titlePlayer.setAudio(2);
  runs.at(-1)!.start();
  await settle();
  titlePlayer.setSubtitle(titlePlayer.state().subtitles[0]!);
  runs.at(-1)!.start();
  await settle();
  titlePlayer.seek(42);
  expect(runs.at(-1)!.run).toMatchObject({ start: 42, paused: true, audio: 2, subtitle: 3 });
  await relapse(0);
  expect(titlePlayer.state().phase).toMatchObject({ kind: "reconnecting", attempt: 2 });
  await vi.advanceTimersByTimeAsync(2000);
  expect(runs.at(-1)!.run).toMatchObject({ start: 42, paused: true, audio: 2, subtitle: 3 });
});

it.each(["lookup", "delay"] as const)(
  "close or another title during %s cannot revive the old run",
  async (stage) => {
    for (const supersede of [false, true]) {
      titlePlayer.close();
      runs.length = 0;
      await open();
      runs[0]!.start();
      await settle();
      const lookup = stage === "lookup" ? ipc.hold("playback.failure") : null;
      runs[0]!.fail(dropped);
      await settle();
      titlePlayer.close();
      if (supersede) {
        void titlePlayer.open({ ...now, title: { ...now.title, id: "2" } }, 80);
        await settle();
      }
      lookup?.resolve(dropped);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toHaveLength(supersede ? 2 : 1);
      expect(titlePlayer.state().phase.kind).toBe(supersede ? "starting" : "idle");
      if (supersede) expect(runs.at(-1)!.run.start).toBe(80);
    }
  },
);
