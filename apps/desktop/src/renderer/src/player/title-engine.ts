import type { AnalyticsPlaybackState } from "@mrstreamer/contracts/analytics";
import { observeMediaPlayback } from "./analytics.ts";
// Movies and episodes through Media Source Extensions. One run plays the title from a position
// with the chosen tracks, as the proxy sends it (see src/main/playback/title.ts): fragmented MP4
// whose `x-start` header says where its picture begins. Placing the fragments there makes the
// element's clock the title's clock, so the position is `currentTime`, a seek into what is
// already buffered is instant, and subtitle cues line up without arithmetic in the view.
//
// With subtitles on, a run reads their feed beside the picture, which never waits for it (see
// @mrstreamer/core/subtitles/feed): what the track holds before the run's start, then the
// subtitles as the run reads them. Independent text shows as it arrives while recovery continues.
// Packet changes wait for the recovered state; then what is on screen where the picture has got to
// shows at once, such as a picture, page or caption that began long before the start. When the
// first part can't be had the run says so, and the picture plays on. The run also says whether a
// cue it has is due at the position, so text that shows is never called loading or unavailable.
//
// Reading holds back once enough is buffered ahead. While paused nothing more is read, and the
// provider's connection sits idle until playback moves on; the controller ends the run after a
// long pause.
import { subtitleDecoder, type SubtitleCodec } from "@mrstreamer/core/subtitles/decoder";
import { readFeedLine } from "@mrstreamer/core/subtitles/feed";
import type { SubtitleChange } from "@mrstreamer/core/subtitles/screen";
import { t } from "@mrstreamer/core/i18n";
import type { EngineError, StreamInfo } from "./engine.ts";
import { readMp4Start } from "./mp4.ts";
import {
  addTextCue,
  clearSubtitles,
  onSubtitlesChange,
  subtitlePresenter,
  subtitlesDue,
} from "./subtitles.ts";

/** Stop reading once this much is buffered ahead, and read again below the second value. */
const AHEAD_S = { stop: 60, resume: 40 } as const;
/** No picture within this long counts as a failed start. */
const START_TIMEOUT_MS = 30_000;
/** How long a run may send nothing at all. */
const NOTHING_TIMEOUT_MS = 45_000;
/** The proxy gets 30 s for subtitle recovery; allow its final answer another 5 s to arrive. */
const SUBTITLE_WAIT_MS = 35_000;
/** How often a run tells the proxy what it has buffered while its subtitles load. */
const PROGRESS_MS = 500;
/** A clock that stands still this long while playing, with nothing buffered, counts as broken. */
const STALL_TIMEOUT_MS = 20_000;
/** The start of a run is read into memory until its codecs are known; more is not a movie. */
const HEAD_LIMIT = 16 * 1024 * 1024;

export interface TitleRun {
  /** The session's address; the run adds its position and tracks. */
  readonly url: string;
  readonly start: number;
  readonly audio: number | null;
  readonly subtitle: number | null;
  /** The teletext page or caption channel to show, for a track that holds several. */
  readonly page: number | null;
  /** Converts the sound even when the player decodes it: the second try after a failed start. */
  readonly convertSound: boolean;
  /**
   * Shows the first picture and waits, as when the viewer changes tracks or skips while paused;
   * otherwise it plays.
   */
  readonly paused: boolean;
  /** Seconds, so the element's timeline covers the whole title. */
  readonly duration: number | null;
}

/**
 * The search for what a run's track holds before its start: still under way, given up, or done.
 * Independent text can already show while it is under way or given up.
 */
type SubtitleRecovery = "loading" | "unavailable" | "recovered";

/** How a run's chosen subtitles stand where the picture is. */
export interface SubtitleState {
  readonly recovery: SubtitleRecovery;
  /**
   * A cue the run has is due where the picture is, as timed now (see `subtitlesDue`): there is
   * text or a picture to show, whatever recovery still looks for before the start.
   */
  readonly covered: boolean;
}

export interface TitleEngine {
  onPlayback?(listener: (state: AnalyticsPlaybackState) => void): void;
  /** Resolves once the picture moves. Rejects with an `EngineError`. */
  readonly started: Promise<void>;
  /** Called at most once, when playback breaks after it started. */
  onFailure(listener: (error: EngineError) => void): void;
  /** Called when the title plays to its end. */
  onEnded(listener: () => void): void;
  /**
   * Called with how the subtitles stand at once, null for a run without them, and again each time
   * that changes. A run with subtitles starts loading, with no cue due at the position.
   */
  onSubtitles(listener: (state: SubtitleState | null) => void): void;
  /** Seconds into the title. */
  position(): number;
  /** Moves within what is already here; false when the caller must start a run from there. */
  seekWithin(position: number): boolean;
  /**
   * Takes the subtitles off for the rest of the run: what shows goes, the run's feed stops being
   * read, and the run says no more of them. Showing subtitles again takes a new run.
   */
  hideSubtitles(): void;
  /** Main says the source advanced toward this run's asked position. Keeps only startup alive. */
  readingAhead(): void;
  info(): StreamInfo;
  /** Stops reading, ends the run's connection and frees the element. */
  destroy(): void;
}

export function titleEngine(video: HTMLVideoElement, run: TitleRun): TitleEngine {
  const observation = observeMediaPlayback(video);
  const abort = new AbortController();
  /** Ends the subtitles with the run, or before it, when the viewer turns them off. */
  const subtitlesOff = new AbortController();
  const subtitlesSignal = AbortSignal.any([abort.signal, subtitlesOff.signal]);
  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  clearSubtitles(video);
  const presenter = run.subtitle === null ? null : subtitlePresenter(video);
  let buffer: SourceBuffer | null = null;
  let codecs: string | null = null;
  let settled = false;
  let finished = false;
  let failureListener: ((error: EngineError) => void) | null = null;
  let pendingFailure: EngineError | null = null;
  let endedListener: (() => void) | null = null;
  let state: SubtitleState | null =
    run.subtitle === null ? null : { recovery: "loading", covered: false };
  let stateListener: ((state: SubtitleState | null) => void) | null = null;
  let subtitleWait: ReturnType<typeof setTimeout> | null = null;
  /** Says how the subtitles stand when that changed: recovery as given, coverage as it is now. */
  const report = (recovery: SubtitleRecovery | undefined = state?.recovery) => {
    if (!state || !recovery) return;
    const covered = subtitlesDue(video);
    if (state.recovery === recovery && state.covered === covered) return;
    state = { recovery, covered };
    stateListener?.(state);
  };
  const say = (recovery: SubtitleRecovery) => {
    if (recovery !== "loading" && subtitleWait !== null) {
      clearTimeout(subtitleWait);
      subtitleWait = null;
    }
    report(recovery);
  };
  /** The title second from which a track shows again after it had nothing for the start. */
  let showsFrom: number | null = null;
  /** Until the response identifies independent text, assume the feed needs packet history. */
  let decoding = true;
  const { promise: started, resolve, reject } = Promise.withResolvers<void>();
  started.catch(() => {});

  const fail = (error: EngineError) => {
    observation.stop();
    if (finished) return;
    finished = true;
    stopWatching();
    if (!settled) {
      settled = true;
      reject(error);
    } else if (failureListener) failureListener(error);
    else pendingFailure = error;
  };

  // Started once the clock moves on from where the run placed it.
  let from: number | null = null;
  let lastTime = 0;
  let lastProgressAt = Date.now();
  /** When the run was asked for. */
  const waitingSince = Date.now();
  let lastReadAheadAt = waitingSince;
  const watchdog = setInterval(() => {
    const now = Date.now();
    const waitingFrom = Math.max(waitingSince, lastReadAheadAt);
    // Nothing to show yet, paused or not: the provider answered and then stalled. Later than
    // the proxy's own wait for a run's start, whose answer says more.
    if (from === null && now - waitingFrom > NOTHING_TIMEOUT_MS) {
      fail({
        kind: "network",
        detail: t("No picture within {seconds} s.", { seconds: NOTHING_TIMEOUT_MS / 1000 }),
      });
      return;
    }
    if (video.paused || video.seeking || video.currentTime > lastTime + 0.05) {
      lastTime = video.currentTime;
      lastProgressAt = now;
      return;
    }
    if (!settled && now - waitingFrom > START_TIMEOUT_MS) {
      fail({
        kind: "network",
        detail: t("No picture within {seconds} s.", { seconds: START_TIMEOUT_MS / 1000 }),
      });
    } else if (settled && now - lastProgressAt > STALL_TIMEOUT_MS && ahead() < 1) {
      fail({ kind: "network", detail: t("The title stopped arriving.") });
    }
  }, 1000);
  const onError = () => {
    const error = video.error;
    fail({
      kind: error?.code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED ? "unsupported" : "media",
      detail: error?.message || t("The title could not be decoded."),
    });
  };
  const onEnded = () => endedListener?.();
  /** Resolves once the subtitle picture due where the run starts is drawn. */
  let drawnAtStart = Promise.resolve();
  // The clock moving on from where the run placed it is the start, as soon as it happens.
  const onTime = () => {
    if (from !== null && !settled && video.currentTime >= from + 0.1) {
      settled = true;
      void drawnAtStart.then(resolve);
    }
    if (showsFrom !== null && video.currentTime >= showsFrom) {
      showsFrom = null;
      say("recovered");
    } else report();
  };
  // Lines that come, go, or move with the timing, and seeks, change what is due without the clock.
  const stopFollowing = onSubtitlesChange(() => report());
  // While the subtitles load, the proxy reads the file for them only as far as the picture can
  // spare the provider, which what is buffered here tells it.
  const telling = setInterval(() => {
    if (state?.recovery !== "loading" || from === null) return;
    const query = `only=progress&buffered=${ahead().toFixed(1)}&paused=${video.paused ? 1 : 0}`;
    void fetch(`${run.url}?${query}`, { signal: abort.signal }).catch(() => {});
  }, PROGRESS_MS);
  video.addEventListener("error", onError);
  video.addEventListener("ended", onEnded);
  video.addEventListener("timeupdate", onTime);
  function stopWatching() {
    if (subtitleWait !== null) clearTimeout(subtitleWait);
    subtitleWait = null;
    clearInterval(watchdog);
    clearInterval(telling);
    video.removeEventListener("error", onError);
    video.removeEventListener("ended", onEnded);
    video.removeEventListener("timeupdate", onTime);
    stopFollowing();
  }

  /** Seconds buffered beyond the position. */
  function ahead(): number {
    const ranges = video.buffered;
    for (let index = 0; index < ranges.length; index++) {
      if (
        ranges.start(index) <= video.currentTime + 0.5 &&
        ranges.end(index) >= video.currentTime
      ) {
        return ranges.end(index) - video.currentTime;
      }
    }
    return 0;
  }

  /** Resolves once the element has room to buffer more. */
  const room = () =>
    new Promise<void>((done) => {
      if (ahead() < AHEAD_S.stop) return done();
      const check = () => {
        if (abort.signal.aborted || ahead() < AHEAD_S.resume) {
          video.removeEventListener("timeupdate", check);
          video.removeEventListener("seeking", check);
          abort.signal.removeEventListener("abort", check);
          done();
        }
      };
      video.addEventListener("timeupdate", check);
      video.addEventListener("seeking", check);
      abort.signal.addEventListener("abort", check, { once: true });
    });

  /**
   * Resolves once the buffer took what it was given, and rejects when it refused. Whichever comes
   * takes both listeners away, so a long title leaves none behind for each piece it appended.
   */
  const updated = (target: SourceBuffer) =>
    new Promise<void>((done, failed) => {
      const settled = new AbortController();
      const settle = (finish: () => void) => () => {
        settled.abort();
        finish();
      };
      target.addEventListener("updateend", settle(done), { signal: settled.signal });
      target.addEventListener(
        "error",
        settle(() => failed(new Error("The player refused the title."))),
        { signal: settled.signal },
      );
    });

  /** Appends a piece, making room behind the position when the element is full. */
  async function append(target: SourceBuffer, data: Uint8Array): Promise<void> {
    for (let tries = 0; ; tries++) {
      try {
        target.appendBuffer(data as Uint8Array<ArrayBuffer>);
        await updated(target);
        return;
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError") || tries > 3) {
          throw error;
        }
        const behind = video.currentTime - 20;
        if (behind > 0) {
          target.remove(0, behind);
          await updated(target);
        } else {
          await room();
        }
      }
    }
  }

  async function play(): Promise<void> {
    await new Promise((opened) =>
      mediaSource.addEventListener("sourceopen", opened, { once: true }),
    );
    const query = new URLSearchParams({ start: run.start.toFixed(3) });
    if (run.audio !== null) query.set("audio", String(run.audio));
    if (run.subtitle !== null) query.set("subtitle", String(run.subtitle));
    if (run.convertSound) query.set("sound", "convert");
    const response = await fetch(`${run.url}?${query}`, { signal: abort.signal });
    if (!response.ok || !response.body) {
      throw {
        kind: response.status === 415 ? "unsupported" : "network",
        detail: t("The title answered HTTP {status}.", { status: String(response.status) }),
      } satisfies EngineError;
    }
    const pictureStart = Number(response.headers.get("x-start")) || 0;

    const reader = response.body.getReader();
    abort.signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), {
      once: true,
    });
    // The start is held until the tracks and the first fragment are known.
    let head = new Uint8Array(0);
    let start = readMp4Start(head);
    while (start.codecs === null || start.firstFragment === null) {
      const { value, done } = await reader.read();
      if (done || head.length > HEAD_LIMIT) {
        throw {
          kind: "unsupported",
          detail: t("The title didn't start like a video."),
        } satisfies EngineError;
      }
      const joined = new Uint8Array(head.length + value.length);
      joined.set(head);
      joined.set(value, head.length);
      head = joined;
      start = readMp4Start(head);
    }
    codecs = start.codecs;
    const type = `video/mp4; codecs="${start.codecs}"`;
    if (!MediaSource.isTypeSupported(type)) {
      throw {
        kind: "unsupported",
        detail: t("This system can't play {codecs}.", { codecs: start.codecs }),
      } satisfies EngineError;
    }
    if (run.duration) mediaSource.duration = run.duration;
    buffer = mediaSource.addSourceBuffer(type);
    buffer.timestampOffset = pictureStart - start.firstFragment;
    await append(buffer, head);
    // The picture decodes from the keyframe before the start and shows from the start itself,
    // unless the file only allowed a later one.
    from = Math.max(run.start, buffer.buffered.length > 0 ? buffer.buffered.start(0) : run.start);
    video.currentTime = from;
    lastTime = from;
    // Chromium says which cues are due a moment after the position moves; the picture due here
    // is drawn without waiting for that.
    // A picture that can't be drawn doesn't hold the start back.
    drawnAtStart = (presenter?.drawNow() ?? drawnAtStart).catch(() => {});
    if (run.paused) {
      // Paused, the clock doesn't move: the run has started once the picture is there, with the
      // subtitles due on it.
      void new Promise((ready) => {
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && !video.seeking) ready(null);
        else video.addEventListener("seeked", ready, { once: true });
      })
        .then(() => drawnAtStart)
        .then(() => {
          if (!settled && !finished) {
            settled = true;
            resolve();
          }
        });
    } else {
      void video.play().catch(() => {});
    }
    for (;;) {
      await room();
      if (abort.signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      await append(buffer, value);
    }
    if (mediaSource.readyState === "open" && !buffer.updating) mediaSource.endOfStream();
  }

  /**
   * Reads the run's subtitle feed, a JSON line each, for as long as the run lasts. Lines of text
   * go on the element's subtitle track; packets go through the decoder for their codec, and what
   * they draw is shown. Packets before `ready` are from before the run's start: the decoder
   * takes all of it, so it knows what later packets build on, and nothing of it shows until then.
   * At `ready` what is on screen where the picture has got to shows, and each change after it.
   * After `unavailable` the track shows only what stands on its own: lines of text as they come,
   * and packets from where the feed says the track starts afresh. Rejects when the feed breaks.
   */
  async function readSubtitles(track: number): Promise<void> {
    const query = new URLSearchParams({
      only: "subtitles",
      start: run.start.toFixed(3),
      subtitle: String(track),
    });
    if (run.page !== null) query.set("page", String(run.page));
    const response = await fetch(`${run.url}?${query}`, { signal: subtitlesSignal });
    if (!response.ok || !response.body) {
      throw new Error(`The subtitles answered HTTP ${response.status}.`);
    }
    const codec = response.headers.get("x-codec");
    const decoderFor = () => (isCodec(codec) ? subtitleDecoder(codec, run.page) : null);
    let decoder = decoderFor();
    decoding = decoder !== null;
    /** Packet changes need the recovered decoder state; text lines can show as they arrive. */
    let held: SubtitleChange[] | null = [];
    const text = new TextDecoder();
    let pending = "";
    for await (const chunk of response.body) {
      pending += text.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const each of lines) {
        const line = readFeedLine(each);
        // The tracks are shared with the next run, which may have started already.
        if (!line || subtitlesSignal.aborted) continue;
        if ("unavailable" in line) {
          // Packet decoders can't build on an incomplete past. Independent text already read
          // stays unless the provider replaced the file it belongs to.
          held = null;
          decoder = decoderFor();
          if (decoding || line.unavailable === "changed") clearSubtitles(video);
          showsFrom = null;
          say("unavailable");
        } else if ("ready" in line) {
          if (line.at !== undefined) {
            // The track starts afresh further on: it counts as recovered once the picture gets
            // there.
            showsFrom = line.at;
            continue;
          }
          // What the last change before the position left on screen, and each one after it.
          const now = Math.max(run.start, video.currentTime);
          const last = held?.findLastIndex((change) => change.at <= now) ?? -1;
          for (const change of held?.slice(Math.max(0, last)) ?? []) {
            presenter?.show(change);
          }
          held = null;
          // Chromium says which cues are due only a moment after the position moves.
          void presenter?.drawNow().catch(() => {});
          say("recovered");
        } else if ("text" in line) {
          addTextCue(video, line.at, line.until, line.text);
        } else {
          const data = Uint8Array.from(atob(line.data), (char) => char.charCodeAt(0));
          const change = decoder?.push(data, line.at);
          if (change && held) held.push(change);
          else if (change) {
            presenter?.show(change);
            report();
          }
        }
      }
    }
    throw new Error("The subtitles ended early.");
  }

  if (run.subtitle !== null) {
    subtitleWait = setTimeout(() => {
      if (subtitlesSignal.aborted || state?.recovery !== "loading") return;
      // End the wait for history. Independent text can keep showing and arriving; packet
      // decoders still need that history, so stop their read and clear their output.
      if (decoding) {
        subtitlesOff.abort();
        clearSubtitles(video);
      }
      showsFrom = null;
      say("unavailable");
    }, SUBTITLE_WAIT_MS);
    readSubtitles(run.subtitle).catch(() => {
      // Turned off or stopped with the run: nothing to say.
      if (subtitlesSignal.aborted) return;
      // The feed broke, and the picture plays on. What a decoder drew waits for an end that
      // won't come, so it goes; lines of text end by themselves.
      if (decoding) clearSubtitles(video);
      showsFrom = null;
      say("unavailable");
    });
  }

  video.src = objectUrl;
  play().catch((error: unknown) => {
    if (abort.signal.aborted) return;
    fail(
      typeof error === "object" && error !== null && "kind" in error && "detail" in error
        ? (error as EngineError)
        : { kind: "network", detail: error instanceof Error ? error.message : String(error) },
    );
  });

  return {
    onPlayback: observation.listen,
    started,
    onFailure(listener) {
      failureListener = listener;
      if (pendingFailure) {
        listener(pendingFailure);
        pendingFailure = null;
      }
    },
    onEnded(listener) {
      endedListener = listener;
    },
    onSubtitles(listener) {
      stateListener = listener;
      listener(state);
    },
    position: () => video.currentTime,
    seekWithin(position) {
      const ranges = buffer?.buffered;
      if (!ranges) return false;
      for (let index = 0; index < ranges.length; index++) {
        if (position >= ranges.start(index) && position < ranges.end(index) - 0.5) {
          video.currentTime = position;
          return true;
        }
      }
      return false;
    },
    hideSubtitles() {
      stateListener = null;
      subtitlesOff.abort();
      clearSubtitles(video);
      showsFrom = null;
      say("recovered");
    },
    readingAhead() {
      if (!settled && !finished) lastReadAheadAt = Date.now();
    },
    info: () => ({
      width: video.videoWidth || null,
      height: video.videoHeight || null,
      fps: null,
      videoCodec: codecs?.split(",")[0] ?? null,
      audioCodec: codecs?.split(",")[1] ?? null,
      audioChannels: null,
    }),
    destroy() {
      if (abort.signal.aborted) return;
      finished = true;
      observation.stop();
      stopWatching();
      abort.abort();
      if (!settled) reject({ kind: "network", detail: "Stopped." } satisfies EngineError);
      clearSubtitles(video);
      video.pause();
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(objectUrl);
    },
  };
}

const CODECS: readonly SubtitleCodec[] = ["pgs", "dvb", "teletext", "captions"];

function isCodec(value: string | null): value is SubtitleCodec {
  return CODECS.some((codec) => codec === value);
}
