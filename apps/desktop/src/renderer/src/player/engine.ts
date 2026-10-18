import type { AnalyticsPlaybackState } from "@mrstreamer/contracts/analytics";
import { observeMediaPlayback } from "./analytics.ts";
// Playback engines behind one interface, so the rest of the UI only ever talks to `Engine`. The
// main process delivers each stream in codecs these engines decode; see src/main/playback.
import Hls, { type ErrorData } from "hls.js";
import type { PlaybackFailureSelector } from "@mrstreamer/contracts/ipc";
import mpegts from "mpegts.js";
import type { StreamFormat } from "@mrstreamer/contracts/playback";
import { t } from "@mrstreamer/core/i18n";
import { hlsTracks, type EngineTracks, type SoundChoice } from "./hls-tracks.ts";

/** The picture may run this far behind the newest data before it jumps forward. */
const LIVE_MAX_LATENCY_S = 8;
/** How much buffer a jump forward keeps, against the next network hiccup. */
const LIVE_KEEP_BUFFER_S = 3;
/** No picture or sound within this long counts as a failed start. */
const START_TIMEOUT_MS = 20_000;
/** A clock that stands still this long after playback started counts as a broken stream. */
const STALL_TIMEOUT_MS = 15_000;
/** A clock that stands still this long while it should move is worth a word to the viewer. */
const WAITING_MS = 3000;
/** This much buffered media without the clock starting means the stream cannot be decoded. */
const UNPLAYABLE_BUFFER_S = 4;
/**
 * A clock that stands still this long while that much media waits beyond it means the stream's
 * timing is broken, as with frames that lack timestamps: data arrives but cannot be played.
 */
const BROKEN_TIMING_STALL_MS = 4000;

export type EngineName = "mpegts.js" | "hls.js" | "native";

export interface EngineError {
  /**
   * `network`: data stopped arriving. `media`: decoding failed. `unsupported`: a codec the engine
   * cannot play. `wrong-container`: not the format this engine reads at all, so another engine may.
   */
  readonly kind: "network" | "media" | "unsupported" | "wrong-container";
  readonly detail: string;
  /** HLS transport context, captured before teardown. Never contains an upstream address. */
  readonly failure?: PlaybackFailureSelector;
}

export function isEngineError(value: unknown): value is EngineError {
  return typeof value === "object" && value !== null && "kind" in value && "detail" in value;
}

/** What is known about the playing stream. Fields are null when the engine cannot tell. */
export interface StreamInfo {
  readonly width: number | null;
  readonly height: number | null;
  readonly fps: number | null;
  readonly videoCodec: string | null;
  readonly audioCodec: string | null;
  readonly audioChannels: number | null;
}

/** One stream playing in a video element. Create one per stream. */
export interface Engine {
  onPlayback?(listener: (state: AnalyticsPlaybackState) => void): void;
  readonly name: EngineName;
  /** Resolves when the first frame (or for radio, the first audio) plays. Rejects with an `EngineError`. */
  readonly started: Promise<void>;
  /** Called at most once, when playback breaks after it started. */
  onFailure(listener: (error: EngineError) => void): void;
  /**
   * Called at most once, when a stream that ends (see `createEngine`) played to its end, or for as
   * long as it lasts. A live stream never does: the end of its data is a break.
   */
  onEnded(listener: () => void): void;
  /**
   * How long the stream has played so far, in milliseconds: only time its clock moved, so none
   * spent paused or waiting for data.
   */
  played(): number;
  /**
   * Hears when the clock has stood still for a few seconds though the stream should play, and
   * when it moves again. That is well before a standstill counts as a failure.
   */
  onWaiting(listener: (waiting: boolean) => void): void;
  /**
   * Hears each private data packet of the stream, as teletext, DVB subtitles and copied captions
   * travel, with its time on the element's clock in seconds. Only MPEG-TS streams have them.
   */
  onPrivateData(listener: (pid: number, data: Uint8Array, at: number) => void): void;
  /**
   * The stream's sound and subtitle tracks, where the engine reads and switches them itself: an
   * HLS stream declares them in playlists only its player sees whole. Null otherwise: the main
   * process reads an MPEG-TS channel's tracks from its program table, and Chromium's own player
   * offers none to choose from, so a stream it plays shows no Sound or CC.
   */
  readonly tracks: EngineTracks | null;
  info(): StreamInfo;
  /** Stops playback, closes the connection and frees the video element. */
  destroy(): void;
}

/**
 * An engine for a stream in `format`. `sound` is the sound to start with where the engine picks
 * it: the main process picked it already for the streams it reads. `ends` is the milliseconds a
 * stream that ends lasts, as a catch-up recording does: it is over once it played that long, or
 * at the end of what arrived when its data stops first, which the engine says, where a live
 * stream's stopping data is a break. Null for a live stream.
 */
export function createEngine(
  format: StreamFormat,
  video: HTMLVideoElement,
  url: string,
  sound: SoundChoice,
  ends: number | null = null,
): Engine {
  if (format === "mpegts") return mpegtsEngine(video, url, ends);
  if (Hls.isSupported()) return hlsEngine(video, url, sound, ends);
  return nativeEngine(video, url, ends, { kind: "hls", requestId: null });
}

function mpegtsEngine(video: HTMLVideoElement, url: string, ends: number | null): Engine {
  if (!mpegts.getFeatureList().mseLivePlayback) {
    return failedEngine("mpegts.js", video, {
      kind: "unsupported",
      detail: t("This system cannot play MPEG-TS live streams."),
    });
  }
  const player = mpegts.createPlayer(
    { type: "mpegts", isLive: true, url },
    {
      enableWorker: true,
      lazyLoad: false,
      autoCleanupSourceBuffer: true,
      // Providers send a burst of buffered seconds when a stream opens, and a stall can leave the
      // picture behind live. Jump forward when that exceeds the maximum, keeping some buffer,
      // rather than play faster: a faster rate is audible and visible for half a minute. A
      // recording plays every second it has, however far ahead the data is.
      liveBufferLatencyChasing: ends === null,
      liveBufferLatencyMaxLatency: LIVE_MAX_LATENCY_S,
      liveBufferLatencyMinRemain: LIVE_KEEP_BUFFER_S,
    },
  );
  const life = lifecycle(
    video,
    () => {
      player.pause();
      player.unload();
      player.detachMediaElement();
      player.destroy();
    },
    ends,
  );
  player.on(mpegts.Events.ERROR, (type: unknown, detail: unknown, info: unknown) => {
    life.fail(mpegtsError(type, detail, info));
  });
  // A recording's end plays out what arrived, and the element says when it is over.
  player.on(mpegts.Events.LOADING_COMPLETE, () => {
    if (ends === null) life.fail({ kind: "network", detail: t("The provider ended the stream.") });
  });
  let privateData: ((pid: number, data: Uint8Array, at: number) => void) | null = null;
  // mpegts.js times private data in milliseconds on the timeline it gives the element.
  player.on(mpegts.Events.PES_PRIVATE_DATA_ARRIVED, (packet: unknown) => {
    if (!privateData || typeof packet !== "object" || packet === null) return;
    const { pid, data, pts, nearest_pts } = packet as Record<string, unknown>;
    const at = typeof pts === "number" ? pts : nearest_pts;
    if (typeof pid === "number" && data instanceof Uint8Array && typeof at === "number") {
      privateData(pid, data, at / 1000);
    }
  });
  player.attachMediaElement(video);
  player.load();
  void Promise.resolve(player.play()).catch(() => {});

  return {
    name: "mpegts.js",
    ...life.handle,
    onPrivateData(listener) {
      privateData = listener;
    },
    tracks: null,
    info() {
      // createPlayer returns the base Player type; for MSE playback mediaInfo carries codec details.
      const media: mpegts.MSEPlayerMediaInfo = player.mediaInfo;
      return {
        ...elementInfo(video),
        fps: numberOr(media.fps),
        videoCodec: stringOr(media.videoCodec),
        audioCodec: stringOr(media.audioCodec),
        audioChannels: numberOr(media["audioChannelCount"]),
      };
    },
  };
}

function mpegtsError(type: unknown, detail: unknown, info: unknown): EngineError {
  const message =
    info && typeof info === "object" && "msg" in info && typeof info.msg === "string"
      ? info.msg
      : String(detail);
  if (type === mpegts.ErrorTypes.NETWORK_ERROR) return { kind: "network", detail: message };
  if (detail === mpegts.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED)
    return { kind: "wrong-container", detail: message };
  if (detail === mpegts.ErrorDetails.MEDIA_CODEC_UNSUPPORTED)
    return { kind: "unsupported", detail: message };
  return { kind: "media", detail: message };
}

function hlsEngine(
  video: HTMLVideoElement,
  url: string,
  sound: SoundChoice,
  ends: number | null,
): Engine {
  // hls.js puts no subtitles on the element by itself: their lines go to the player as events,
  // only for the track the viewer chose (see ./hls-tracks.ts). A recording plays from its first
  // segment, also when its playlist names no end yet, as one still being recorded or a provider's
  // sliding archive does: hls.js would otherwise start such a playlist near its newest segment, as
  // live. It doesn't chase that edge afterwards either way.
  const hls = new Hls({
    enableWorker: true,
    renderTextTracksNatively: false,
    ...(ends === null ? {} : { startPosition: 0 }),
  });
  const tracks = hlsTracks(hls, video, sound);
  const life = lifecycle(
    video,
    () => {
      tracks.release();
      hls.destroy();
    },
    ends,
    { kind: "hls", requestId: null },
  );
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (tracks.subtitleError(data) || !data.fatal) return;
    life.fail(hlsError(data, url));
  });
  hls.loadSource(url);
  hls.attachMedia(video);
  void video.play().catch(() => {});

  return {
    name: "hls.js",
    ...life.handle,
    onPrivateData: () => {},
    tracks: tracks.handle,
    info() {
      const level = hls.levels[hls.currentLevel];
      return {
        ...elementInfo(video),
        fps: level?.frameRate || null,
        videoCodec: level?.videoCodec ?? null,
        audioCodec: level?.audioCodec ?? null,
        audioChannels: null,
      };
    },
  };
}

/** Maps an HLS failure before teardown discards its loader and fragment context. */
function hlsError(data: ErrorData, source: string): EngineError {
  // hls.js also groups malformed/empty playlist content under NETWORK_ERROR.
  const parsing = [
    Hls.ErrorDetails.MANIFEST_PARSING_ERROR,
    Hls.ErrorDetails.LEVEL_PARSING_ERROR,
    Hls.ErrorDetails.LEVEL_EMPTY_ERROR,
  ].includes(data.details);
  const network = data.type === Hls.ErrorTypes.NETWORK_ERROR && !parsing;
  const unsupported =
    data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
    data.details === Hls.ErrorDetails.BUFFER_INCOMPATIBLE_CODECS_ERROR;
  // Only loader failures select a request. Parsing errors can also carry a URL or fragment, even
  // when hls.js labels them network errors. A key failure must never select its media fragment.
  const transport = [
    Hls.ErrorDetails.MANIFEST_LOAD_ERROR,
    Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT,
    Hls.ErrorDetails.LEVEL_LOAD_ERROR,
    Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT,
    Hls.ErrorDetails.AUDIO_TRACK_LOAD_ERROR,
    Hls.ErrorDetails.AUDIO_TRACK_LOAD_TIMEOUT,
    Hls.ErrorDetails.FRAG_LOAD_ERROR,
    Hls.ErrorDetails.FRAG_LOAD_TIMEOUT,
    Hls.ErrorDetails.KEY_LOAD_ERROR,
    Hls.ErrorDetails.KEY_LOAD_TIMEOUT,
  ].includes(data.details);
  const address =
    data.response?.url ??
    data.context?.url ??
    data.url ??
    (data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
    data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT
      ? (data.part?.url ?? data.frag?.url)
      : undefined);
  const base = URL.parse(source);
  const request = address ? URL.parse(address) : null;
  const prefix = base?.pathname.replace(/\.m3u8$/, "/");
  const requestId =
    network &&
    transport &&
    base &&
    request &&
    request.origin === base.origin &&
    (request.pathname === base.pathname ||
      (prefix?.endsWith("/") &&
        request.pathname.startsWith(prefix) &&
        /^[0-9a-z]+$/.test(request.pathname.slice(prefix.length))))
      ? request.pathname
      : null;
  return {
    kind: network ? "network" : unsupported ? "unsupported" : "media",
    detail: data.details,
    failure: { kind: "hls", requestId },
  };
}

/** Chromium's own player. Plays progressive files and raw audio streams such as AAC radio. */
export function nativeEngine(
  video: HTMLVideoElement,
  url: string,
  ends: number | null = null,
  failure?: PlaybackFailureSelector,
): Engine {
  const life = lifecycle(video, () => {}, ends, failure);
  video.src = url;
  void video.play().catch(() => {});
  return {
    name: "native",
    ...life.handle,
    onPrivateData: () => {},
    tracks: null,
    info: () => elementInfo(video),
  };
}

function failedEngine(name: EngineName, video: HTMLVideoElement, error: EngineError): Engine {
  const life = lifecycle(video, () => {}, null);
  life.fail(error);
  return {
    name,
    ...life.handle,
    onPrivateData: () => {},
    tracks: null,
    info: () => elementInfo(video),
  };
}

/**
 * The start, stall and failure bookkeeping every engine shares. `teardown` releases the engine's
 * own resources; the video element is reset afterwards.
 *
 * A stream counts as started once its clock moves. A first frame alone is not enough: a decoder
 * that cannot handle the audio shows one frame and then freezes. A watchdog tells the cases apart:
 * data piling up without playback means the format is unplayable, no data means the network.
 *
 * A stream that `ends` is over once it played that many milliseconds, or when the element reaches
 * the end of what arrived, which no watchdog counts as a stall: the engine says it ended instead.
 */
function lifecycle(
  video: HTMLVideoElement,
  teardown: () => void,
  ends: number | null,
  failure?: PlaybackFailureSelector,
) {
  const observation = observeMediaPlayback(video);
  let settled = false;
  let finished = false;
  let destroyed = false;
  let failureListener: ((error: EngineError) => void) | null = null;
  let pendingFailure: EngineError | null = null;
  let endedListener: (() => void) | null = null;
  let pendingEnd = false;
  let waitingListener: ((waiting: boolean) => void) | null = null;
  let waiting = false;
  let played = 0;

  const { promise: started, resolve, reject } = Promise.withResolvers<void>();
  started.catch(() => {});

  const openedAt = Date.now();
  let lastTime = video.currentTime;
  let lastProgressAt = openedAt;
  let lastCheckAt = openedAt;

  const watchdog = setInterval(() => {
    const now = Date.now();
    const sinceCheck = now - lastCheckAt;
    lastCheckAt = now;
    if (video.currentTime > lastTime + 0.05) {
      if (!settled && video.currentTime - lastTime > 0.25) begin();
      // A jump forward to catch up with live moves the clock further than the stream played.
      played += Math.min((video.currentTime - lastTime) * 1000, sinceCheck);
      lastTime = video.currentTime;
      lastProgressAt = now;
      wait(false);
      if (ends !== null && played >= ends) onEnded();
      return;
    }
    if (!settled) {
      if (bufferedAhead(video) >= UNPLAYABLE_BUFFER_S) {
        fail({
          kind: "unsupported",
          detail: t("The stream arrives but its audio or video cannot be decoded."),
        });
      } else if (now - openedAt > START_TIMEOUT_MS) {
        fail({
          kind: "network",
          detail: t("No picture or sound within {seconds} s.", {
            seconds: START_TIMEOUT_MS / 1000,
          }),
        });
      }
    } else if (video.paused) {
      // Time paused isn't time stalled.
      lastProgressAt = now;
      wait(false);
    } else {
      const stalled = now - lastProgressAt;
      if (stalled >= WAITING_MS) wait(true);
      if (stalled > BROKEN_TIMING_STALL_MS && bufferedAhead(video) >= UNPLAYABLE_BUFFER_S) {
        fail({ kind: "media", detail: t("The stream arrives, but its timing is broken.") });
      } else if (stalled > STALL_TIMEOUT_MS) {
        fail({ kind: "network", detail: t("The stream stopped delivering data.") });
      }
    }
  }, 1000);

  function begin(): void {
    if (settled || finished) return;
    settled = true;
    resolve();
  }

  function wait(still: boolean): void {
    if (waiting === still) return;
    waiting = still;
    waitingListener?.(still);
  }

  function fail(error: EngineError): void {
    if (finished) return;
    finished = true;
    if (failure && !error.failure) error = { ...error, failure };
    detach();
    if (!settled) {
      settled = true;
      reject(error);
    } else if (failureListener) {
      failureListener(error);
    } else {
      pendingFailure = error;
    }
  }

  const onError = () => {
    const error = video.error;
    const unsupported = error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
    fail({
      kind:
        error?.code === MediaError.MEDIA_ERR_NETWORK
          ? "network"
          : unsupported
            ? "unsupported"
            : "media",
      detail: error?.message || t("The stream could not be decoded."),
    });
  };
  video.addEventListener("error", onError);

  // Played to its end. One that never got going sent nothing to play.
  const onEnded = () => {
    if (finished) return;
    if (!settled && video.currentTime === 0) {
      fail({ kind: "network", detail: t("The stream stopped delivering data.") });
      return;
    }
    begin();
    finished = true;
    detach();
    if (endedListener) endedListener();
    else pendingEnd = true;
  };
  if (ends !== null) video.addEventListener("ended", onEnded);

  function detach(): void {
    observation.stop();
    clearInterval(watchdog);
    video.removeEventListener("error", onError);
    video.removeEventListener("ended", onEnded);
  }

  return {
    fail,
    handle: {
      onPlayback: observation.listen,
      started,
      onFailure(listener: (error: EngineError) => void): void {
        failureListener = listener;
        if (pendingFailure) {
          listener(pendingFailure);
          pendingFailure = null;
        }
      },
      onEnded(listener: () => void): void {
        endedListener = listener;
        if (pendingEnd) {
          pendingEnd = false;
          listener();
        }
      },
      played: (): number => played,
      onWaiting(listener: (waiting: boolean) => void): void {
        waitingListener = listener;
      },
      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        finished = true;
        detach();
        if (!settled) reject({ kind: "network", detail: "Stopped." } satisfies EngineError);
        teardown();
        video.pause();
        video.removeAttribute("src");
        video.load();
      },
    },
  };
}

/** Seconds of media buffered beyond the current position. */
function bufferedAhead(video: HTMLVideoElement): number {
  const { buffered, currentTime } = video;
  return buffered.length > 0 ? buffered.end(buffered.length - 1) - currentTime : 0;
}

/** What the video element itself knows: only the picture size. */
function elementInfo(video: HTMLVideoElement): StreamInfo {
  return {
    width: video.videoWidth || null,
    height: video.videoHeight || null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    audioChannels: null,
  };
}

function numberOr(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function stringOr(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}
