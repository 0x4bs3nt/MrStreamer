// @vitest-environment happy-dom
import "./support.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
  createEngine,
  type Engine,
  type EngineError,
} from "../../src/renderer/src/player/engine.ts";
import { streams } from "./hls-stand-in.ts";

vi.mock("hls.js", async (original) => {
  const real = await original<typeof import("hls.js")>();
  const { standIn } = await import("./hls-stand-in.ts");
  return { default: standIn(real.default) };
});
let engine: Engine | null = null;
afterEach(() => {
  engine?.destroy();
  engine = null;
  vi.useRealTimers();
});
it.each(["subtitle-playlist", "subtitle-segment"] as const)(
  "%s errors preserve playback but a subsequent video error still fails the engine",
  async (target) => {
    vi.useFakeTimers();
    const video = document.createElement("video");
    engine = createEngine("hls", video, "http://127.0.0.1/fixture", {
      audio: null,
      audioLanguage: null,
    });
    const failures: EngineError[] = [];
    engine.onFailure((error) => failures.push(error));
    engine.tracks!.onSubtitleAvailable(() => {});
    const stream = streams.latest();
    stream.variant({ subtitles: [{ name: "English", lang: "en" }] });
    stream.error(target);
    expect(stream.loading).toBe(true);
    video.currentTime = 1;
    await vi.advanceTimersByTimeAsync(1000);
    await expect(engine.started).resolves.toBeUndefined();
    expect(failures).toEqual([]);
    stream.error("video");
    expect(failures).toEqual([
      { kind: "network", detail: "fragLoadError", failure: { kind: "hls", requestId: null } },
    ]);
  },
);
it("still rejects genuine audio failures before the first picture", async () => {
  const video = document.createElement("video");
  engine = createEngine("hls", video, "http://127.0.0.1/fixture", {
    audio: null,
    audioLanguage: null,
  });
  streams.latest().error("audio");
  await expect(engine.started).rejects.toEqual({
    kind: "network",
    detail: "fragLoadError",
    failure: { kind: "hls", requestId: null },
  });
});
