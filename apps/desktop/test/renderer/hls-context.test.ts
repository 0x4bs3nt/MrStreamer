// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Hls, { type ErrorData } from "hls.js";
import { player } from "../../src/renderer/src/player/player.ts";
import { createEngine, type Engine } from "../../src/renderer/src/player/engine.ts";
import type { LiveChannel } from "@mrstreamer/contracts/library";

const events = vi.hoisted(() => ({ error: (_data: unknown) => {} }));
vi.mock("hls.js", async (original) => {
  const real = await original<typeof import("hls.js")>();
  const { standIn } = await import("./hls-stand-in.ts");
  return {
    default: class extends standIn(real.default) {
      errors: ((event: string, data: unknown) => void)[] = [];
      constructor() {
        super();
        events.error = (data) => {
          for (const listener of this.errors) listener(real.default.Events.ERROR, data);
        };
      }
      override on(event: string, listener: (event: string, data: unknown) => void) {
        if (event === real.default.Events.ERROR) this.errors.push(listener);
        else super.on(event, listener);
      }
    },
  };
});

const SOURCE = "http://127.0.0.1:1234/stream/session-token.m3u8";
const VIDEO = "http://127.0.0.1:1234/stream/session-token/7";
const AUDIO = "http://127.0.0.1:1234/stream/session-token/2";
const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "hls",
  name: "HLS",
  title: "HLS",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "hls", name: "HLS", tags: [], quality: null }],
};
let engine: Engine | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  player.reset();
  player.element.currentTime = 0;
  ipc.reset();
});
afterEach(() => {
  player.reset();
  engine?.destroy();
  engine = null;
  vi.useRealTimers();
});

function error(details: ErrorData["details"], fields: Partial<ErrorData> = {}): ErrorData {
  return {
    type: Hls.ErrorTypes.NETWORK_ERROR,
    details,
    fatal: true,
    error: new Error("fixture"),
    ...fields,
  };
}
const response = (url: string) => ({ url, code: 403, text: "Forbidden" });

it.each([
  Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
  Hls.ErrorDetails.LEVEL_PARSING_ERROR,
  Hls.ErrorDetails.LEVEL_EMPTY_ERROR,
])("keeps invalid playlist content on media recovery: %s", async (details) => {
  const video = document.createElement("video");
  engine = createEngine("hls", video, SOURCE, { audio: null, audioLanguage: null });
  // hls.js reports these successful-response parser failures under NETWORK_ERROR.
  events.error(error(details, { url: SOURCE, response: { url: SOURCE, code: 200 } }));
  await expect(engine.started).rejects.toMatchObject({
    kind: "media",
    failure: { kind: "hls", requestId: null },
  });
});

it.each([
  [
    "segment HTTP refusal",
    () =>
      error(Hls.ErrorDetails.FRAG_LOAD_ERROR, {
        response: response(`${VIDEO}?secret=upstream-must-not-cross`),
      }),
    "/stream/session-token/7",
    "refused",
  ],
  [
    "root manifest refusal",
    () => error(Hls.ErrorDetails.MANIFEST_LOAD_ERROR, { url: SOURCE, response: response(SOURCE) }),
    "/stream/session-token.m3u8",
    "refused",
  ],
  [
    "audio playlist timeout beside a video 404",
    () => error(Hls.ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT, { url: AUDIO }),
    "/stream/session-token/2",
    "network",
  ],
  [
    "parser failure after a video 404",
    () =>
      error(Hls.ErrorDetails.FRAG_PARSING_ERROR, {
        type: Hls.ErrorTypes.MEDIA_ERROR,
        response: response(VIDEO),
      }),
    null,
    "unsupported",
  ],
  [
    "key HTTP refusal",
    () => error(Hls.ErrorDetails.KEY_LOAD_ERROR, { response: response(VIDEO) }),
    "/stream/session-token/7",
    "refused",
  ],
  [
    "foreign request",
    () =>
      error(Hls.ErrorDetails.FRAG_LOAD_ERROR, {
        response: response("https://upstream.example/login/password/7"),
      }),
    null,
    "network",
  ],
] as const)(
  "passes %s from the real engine to the controller's typed failure lookup",
  async (_name, makeError, requestId, problem) => {
    ipc
      .hold("playback.open")
      .resolve({ sessionId: "session", channel, url: SOURCE, format: "hls" });
    // A real main-service lookup returns a cause only for the exact selected request. The earlier
    // video 404 must not be returned for a parser failure or a different audio timeout.
    ipc.answer("playback.failure", ({ selector }) =>
      selector?.requestId === new URL(VIDEO).pathname ||
      selector?.requestId === new URL(SOURCE).pathname
        ? { kind: "refused", status: 403 }
        : null,
    );
    ipc.always("playback.playing", null);
    player.preview(channel);
    await vi.advanceTimersByTimeAsync(0);
    events.error(makeError());
    await vi.advanceTimersByTimeAsync(0);
    expect(ipc.argsOf("playback.failure")).toEqual([
      { sessionId: "session", selector: { kind: "hls", requestId } },
    ]);
    expect(player.state().phase).toMatchObject({ kind: "failed", problem: { kind: problem } });
  },
);

it.each(["parser", "native", "watchdog"] as const)(
  "keeps the HLS %s failure independent of any HTTP cause",
  async (source) => {
    const video = document.createElement("video");
    engine = createEngine("hls", video, SOURCE, { audio: null, audioLanguage: null });
    if (source === "parser")
      events.error(
        error(Hls.ErrorDetails.FRAG_PARSING_ERROR, {
          type: Hls.ErrorTypes.MEDIA_ERROR,
          response: response(VIDEO),
        }),
      );
    else if (source === "native") video.dispatchEvent(new Event("error"));
    else await vi.advanceTimersByTimeAsync(21_000);
    await expect(engine.started).rejects.toMatchObject({
      kind: source === "watchdog" ? "network" : "media",
      failure: { kind: "hls", requestId: null },
    });
  },
);
