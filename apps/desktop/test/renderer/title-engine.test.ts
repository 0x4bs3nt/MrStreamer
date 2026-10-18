// @vitest-environment happy-dom
import "./support.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nativeEngine, type Engine } from "../../src/renderer/src/player/engine.ts";
import {
  titleEngine,
  type TitleEngine,
  type TitleRun,
} from "../../src/renderer/src/player/title-engine.ts";
import * as mp4 from "../../src/renderer/src/player/mp4.ts";

const run: TitleRun = {
  url: "http://127.0.0.1/title/fixture",
  start: 0,
  audio: null,
  subtitle: null,
  page: null,
  convertSound: false,
  paused: false,
  duration: 600,
};
const tracks = { codecs: "avc1.64001f", firstFragment: 0 };
let engine: TitleEngine | Engine | null = null;
let append: "ok" | "sync" | "async" = "ok";

class Buffer extends EventTarget {
  updating = false;
  timestampOffset = 0;
  buffered = { length: 1, start: () => 0, end: () => 10 };
  appendBuffer() {
    if (append === "sync") throw new DOMException("Local refusal", "InvalidStateError");
    queueMicrotask(() => this.dispatchEvent(new Event(append === "async" ? "error" : "updateend")));
  }
}
class Source extends EventTarget {
  static isTypeSupported = () => true;
  readyState = "open";
  duration = 0;
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
  }
  addSourceBuffer() {
    return new Buffer();
  }
  endOfStream() {}
}

beforeEach(() => {
  vi.useFakeTimers();
  append = "ok";
  vi.stubGlobal("MediaSource", Source);
  vi.stubGlobal("MediaError", {
    MEDIA_ERR_NETWORK: 2,
    MEDIA_ERR_DECODE: 3,
    MEDIA_ERR_SRC_NOT_SUPPORTED: 4,
  });
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fixture");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(mp4, "readMp4Start").mockReturnValue(tracks);
  vi.stubGlobal("fetch", async () => new Response(new Uint8Array([1])));
});
afterEach(() => {
  engine?.destroy();
  engine = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["sync", "async"] as const)("reports a %s append refusal as local media", async (mode) => {
  append = mode;
  engine = titleEngine(document.createElement("video"), run);
  await expect(engine.started).rejects.toMatchObject({ kind: "media" });
});

it("reports a source buffer creation refusal as local media", async () => {
  vi.spyOn(Source.prototype, "addSourceBuffer").mockImplementation(() => {
    throw new DOMException("Unsupported codec", "NotSupportedError");
  });
  engine = titleEngine(document.createElement("video"), run);
  await expect(engine.started).rejects.toMatchObject({ kind: "media" });
});

it("reports an incompatible codec as unsupported", async () => {
  vi.spyOn(Source, "isTypeSupported").mockReturnValue(false);
  engine = titleEngine(document.createElement("video"), run);
  await expect(engine.started).rejects.toMatchObject({ kind: "unsupported" });
});

it("keeps a malformed MP4 parser exception on the local media path", async () => {
  vi.mocked(mp4.readMp4Start).mockRestore();
  // Complete boxes whose final hdlr lacks its required fields. The actual parser rejects it.
  const box = (name: string, ...children: Uint8Array[]) => {
    const bytes = new Uint8Array(8 + children.reduce((size, child) => size + child.length, 0));
    new DataView(bytes.buffer).setUint32(0, bytes.length);
    bytes.set(new TextEncoder().encode(name), 4);
    let offset = 8;
    for (const child of children) {
      bytes.set(child, offset);
      offset += child.length;
    }
    return bytes;
  };
  const malformed = box(
    "moov",
    box(
      "trak",
      box("tkhd"),
      box("mdia", box("mdhd"), box("minf", box("stbl", box("stsd"))), box("hdlr")),
    ),
  );
  vi.stubGlobal("fetch", async () => new Response(malformed));
  engine = titleEngine(document.createElement("video"), run);
  await expect(engine.started).rejects.toMatchObject({ kind: "media" });
});

it.each(["fetch", "head", "body"] as const)(
  "reports a %s transport failure as network",
  async (phase) => {
    vi.stubGlobal("fetch", async () => {
      if (phase === "fetch") throw new TypeError("Transport lost");
      let reads = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (phase === "body" && reads++ === 0) controller.enqueue(new Uint8Array([1]));
            else controller.error(new TypeError("Transport lost"));
          },
        }),
      );
    });
    if (phase === "head")
      vi.mocked(mp4.readMp4Start).mockReturnValue({ codecs: null, firstFragment: null });
    engine = titleEngine(document.createElement("video"), run);
    await expect(engine.started).rejects.toMatchObject({ kind: "network" });
  },
);

it.each([2, 3, 4])("classifies native code %s by its code in both engines", async (code) => {
  for (const title of [false, true]) {
    const video = document.createElement("video");
    engine = title ? titleEngine(video, run) : nativeEngine(video, run.url);
    Object.defineProperty(video, "error", { value: { code, message: "Same diagnostic text" } });
    video.dispatchEvent(new Event("error"));
    await expect(engine.started).rejects.toEqual({
      kind: code === 2 ? "network" : code === 4 ? "unsupported" : "media",
      detail: "Same diagnostic text",
    });
    engine.destroy();
    engine = null;
  }
});

it.each(["paused", "seeking", "buffering", "seek-between-ticks"] as const)(
  "counts clock progress, excluding %s time and jumps",
  async (held) => {
    let paused = false,
      seeking = false;
    const video = document.createElement("video");
    Object.defineProperties(video, {
      paused: { get: () => paused },
      seeking: { get: () => seeking },
      buffered: { get: () => ({ length: 1, start: () => 0, end: () => 1000 }) },
    });
    const title = titleEngine(video, run);
    engine = title;
    await vi.advanceTimersByTimeAsync(0);
    video.currentTime = 0.2;
    video.dispatchEvent(new Event("timeupdate"));
    await title.started;
    await vi.advanceTimersByTimeAsync(1000);
    const before = title.played();

    if (held === "paused") paused = true;
    if (held === "seeking") seeking = true;
    if (held === "seek-between-ticks") {
      await vi.advanceTimersByTimeAsync(500);
      video.dispatchEvent(new Event("seeking"));
      video.currentTime += 100;
      video.dispatchEvent(new Event("seeked"));
    }
    if (held !== "buffering" && held !== "seek-between-ticks") video.currentTime += 100;
    await vi.advanceTimersByTimeAsync(40_000);
    expect(title.played()).toBe(before);

    paused = seeking = false;
    // Seek completion prevents its last jump from being credited on the first resumed tick.
    if (held === "seeking") video.dispatchEvent(new Event("seeked"));
    for (let second = 0; second < 30; second++) {
      video.currentTime += 1;
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(title.played() - before).toBeCloseTo(30_000);
  },
);

it("caps stability credit to elapsed time when the clock jumps or plays faster", async () => {
  const video = document.createElement("video");
  const title = titleEngine(video, run);
  engine = title;
  await vi.advanceTimersByTimeAsync(0);
  video.currentTime = 100;
  video.dispatchEvent(new Event("timeupdate"));
  await title.started;
  await vi.advanceTimersByTimeAsync(1000);
  expect(title.played()).toBe(1000);
});

it("cannot resume a destroyed title when its pending append completes", async () => {
  const buffer = new Buffer();
  vi.spyOn(buffer, "appendBuffer").mockImplementation(() => {});
  vi.spyOn(Source.prototype, "addSourceBuffer").mockReturnValue(buffer);
  const video = document.createElement("video");
  const play = vi.spyOn(video, "play");
  engine = titleEngine(video, { ...run, start: 42 });
  await vi.advanceTimersByTimeAsync(0);
  engine.destroy();
  video.currentTime = 80;
  buffer.dispatchEvent(new Event("updateend"));
  await vi.advanceTimersByTimeAsync(0);
  expect(video.currentTime).toBe(80);
  expect(play).not.toHaveBeenCalled();
});

it.each(["transport", "sync", "async"] as const)(
  "classifies %s failure after playback starts and reports it once",
  async (failure) => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const feed = new ReadableStream<Uint8Array>({
      start(controller) {
        source = controller;
      },
    });
    vi.stubGlobal("fetch", async () => new Response(feed));
    const video = document.createElement("video");
    engine = titleEngine(video, run);
    await vi.advanceTimersByTimeAsync(0);
    video.currentTime = 0.2;
    video.dispatchEvent(new Event("timeupdate"));
    await engine.started;
    const failed = vi.fn();
    engine.onFailure(failed);
    if (failure === "transport") source.error(new TypeError("Body reset"));
    else {
      append = failure;
      source.enqueue(new Uint8Array([2]));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ kind: failure === "transport" ? "network" : "media" }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(failed).toHaveBeenCalledTimes(1);
  },
);

it("cancels a pending body read on close without a playback failure", async () => {
  const cancelled = vi.fn();
  vi.stubGlobal("fetch", async () => new Response(new ReadableStream({ cancel: cancelled })));
  const video = document.createElement("video");
  engine = titleEngine(video, run);
  await vi.advanceTimersByTimeAsync(0);
  video.currentTime = 0.2;
  video.dispatchEvent(new Event("timeupdate"));
  await engine.started;
  const failed = vi.fn();
  engine.onFailure(failed);
  engine.destroy();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(cancelled).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
});
