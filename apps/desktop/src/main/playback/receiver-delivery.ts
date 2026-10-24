import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { Diagnostic } from "@mrstreamer/core/diagnostics";
import type { PlaybackDiagnostic } from "@mrstreamer/contracts/analytics";
import type { Codec, StreamFailure } from "@mrstreamer/contracts/playback";
import { languageCode, subtitleTracks } from "@mrstreamer/core/ondemand/tracks";
import { t } from "@mrstreamer/core/i18n";
import type { SubtitlesUnavailable } from "@mrstreamer/core/subtitles/feed";
import { createCleanStart } from "./clean-start.ts";
import { lastLine, liveDiagnostic, titleDiagnostic } from "./diagnostic.ts";
import type { StreamLayout } from "./inspect.ts";
import { CLEAN_START_CODECS, cleanStart, liveAudio, replay, type Opened } from "./live-start.ts";
import type { Layout, ReadFile } from "./matroska.ts";
import { mp4Keyframes } from "./mp4-index.ts";
import {
  convertPlan,
  copyPlan,
  listedSegments,
  livePlaylist,
  liveSegmentArguments,
  masterPlaylist,
  pictureSpan,
  runCuts,
  SEGMENT_S,
  segmentSpan,
  subtitleSegment,
  titlePlaylist,
  type LiveSegments,
  type SegmentPlan,
} from "./receiver.ts";
import {
  SEGMENT_LIMITS,
  segmentStore,
  type SegmentLimits,
  type SegmentStore,
} from "./segment-store.ts";
import { arrives, tell, until, unlessAborted } from "./signals.ts";
import type { SubtitleEntry, SubtitleHistory } from "./subtitle-history.ts";
import {
  endOf,
  interleave,
  subtitleSink,
  Unavailable,
  type Attempt,
  type Before,
  type FeedRequest,
  type Spent,
} from "./title-reading.ts";
import { receiverPlan, type TitleProbe } from "./title.ts";

/** Operations on one admitted session. Delivery cannot admit or close sessions. */
interface ReceiverSourceBase {
  readonly closed: AbortSignal;
  readonly decoders: ReadonlySet<Codec>;
  failure(): StreamFailure | null;
  /** Keep the standing failure, or set this one when there is none. */
  fail(failure: StreamFailure): StreamFailure;
  diagnostic(): PlaybackDiagnostic | null;
  noteDiagnostic(diagnostic: PlaybackDiagnostic): void;
}
/** Final source mode, captured after HLS preparation. Converted layout describes its output. */
export type LiveStream =
  | {
      readonly kind: "mpegts";
      open(signal: AbortSignal, failed: (failure: StreamFailure) => void): Promise<Opened>;
    }
  | {
      readonly kind: "converted-hls";
      readonly layout: StreamLayout;
      bytes(signal: AbortSignal): AsyncGenerator<Uint8Array>;
      failure(cause: unknown): StreamFailure;
    }
  | {
      readonly kind: "hls";
      passThrough(
        id: string | null,
        url: URL,
        request: IncomingMessage,
        response: ServerResponse,
        proxied: (id: string) => string,
      ): Promise<void>;
    };

export interface LiveReceiverSource extends ReceiverSourceBase {
  readonly kind: "live";
  readonly stream: LiveStream;
  readonly audio: number | null;
  readonly audioLanguage: string | null;
  readonly repair: boolean;
  made(run: string): { readonly segments: string; readonly list: string };
  begin(active: AbortController): void;
  started(layout: StreamLayout, playing: number | null): void;
  child(ended: Promise<void>): void;
}
/** Playback owns run bookkeeping and report routing; delivery receives built addresses. */
interface RunLease {
  /** Reject segments from a run replaced by a seek or track change. */
  readonly id: string;
  readonly source: string;
  readonly segments: string;
  readonly subtitles: string;
  report(reports: { readonly subtitles: (request: IncomingMessage) => void }): void;
  /** Settle only this run, even if a newer run already owns the slot. */
  settled(): void;
  ended(): void;
}

export interface TitleReceiverSource extends ReceiverSourceBase {
  readonly kind: "title";
  readonly probe: TitleProbe;
  size(): number | null;
  generation(): number;
  begin(abort: AbortController): RunLease;
  /** Use this reader for layout immediately, before awaiting any other file work. */
  reader(attempt: Attempt, most: { readonly bytes: number; readonly requests: number }): ReadFile;
  layout(read: ReadFile): Promise<Layout | null>;
  history(track: number): SubtitleHistory;
  subtitlesBefore(wanted: FeedRequest, attempt: Attempt): Promise<Before>;
  readonly recoveryMs: number;
  recovering(delta: 1 | -1): void;
  counts(): {
    readonly kept: number;
    readonly heldMs: number;
    readonly waitedMs: number;
    readonly revoked: number;
  };
  progress(buffered: number, paused: boolean): void;
}

export interface ReceiverLan {
  readonly origin: string;
  requests: number;
  failed(failure: StreamFailure): void;
}
export interface ReceiverTools {
  readonly ffmpeg: string | null;
  record(entry: Diagnostic): void;
  readonly limits: {
    readonly idleMs?: number;
    readonly segmentMs?: number;
    readonly cuesMs?: number;
    readonly segments?: Partial<SegmentLimits>;
  };
}

interface ReceiverDeliveryBase {
  /** Answers a request to the session's address on the local network, its target read as `url`. */
  serve(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void>;
  receive(
    run: string,
    index: number | null,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void>;
}

export interface LiveReceiverDelivery extends ReceiverDeliveryBase {
  readonly kind: "live";
  readonly url: string;
  run(): Promise<void>;
  epoch(startS: number): void;
}

export interface TitleReceiverDelivery extends ReceiverDeliveryBase {
  readonly kind: "title";
  readonly first: number;
  load(tracks: { readonly audio: number | null; readonly subtitle: number | null }): {
    readonly url: string;
    readonly subtitles: boolean;
  };
  readonly loaded: boolean;
  /** Drop and abort the current load before notifying its receiver. */
  fileReplaced(failure: StreamFailure): void;
}

/**
 * What a receiver may ask the address on the local network for: a session's playlists, and the
 * segments, subtitles and HLS addresses those name. Nothing else has a path there.
 */
const RECEIVER_ROUTE =
  /^\/r\/([\w-]+)\/(?:(master|video|subs|live)\.m3u8|v(\d{1,6})\.ts|s(\d{1,6})\.vtt|l(\d{1,9})\.ts|h((?:subs-)?[0-9a-z]{1,12}))$/;
/** What reading where a movie's keyframes are may take of the provider, before any of it plays. */
const INDEX_LIMITS = { bytes: 24 * 1024 * 1024, requests: 96, ms: 20_000 } as const;
/** A run for a receiver that hasn't asked for anything this long ends, as a long pause does here. */
const RECEIVER_IDLE_MS = 5 * 60_000;
/** How long a receiver's request for a segment's subtitles waits for the run to have read them. */
const CUES_WAIT_MS = 15_000;
/**
 * How long a receiver's request for a segment waits for it to be made. A provider or an ffmpeg
 * that takes longer has stopped: the request ends, and so does the run.
 */
const SEGMENT_WAIT_MS = 30_000;
/** The lines of a channel's playlist for a receiver, and how many it needs before it is given out. */
const LIVE_LIST = { kept: 6, least: 2 } as const;
/** How long a receiver's request for a channel's playlist waits for its first segments. */
const LIVE_START_MS = 20_000;
/** The most one segment of a channel may hold; a few megabytes is usual. */
const LIVE_SEGMENT_BYTES = 48 * 1024 * 1024;

/** What a receiver plays of a channel, besides what the session holds for the UI's player. */
interface LiveReceiver {
  readonly token: string;
  /** MPEG-TS: the segments ffmpeg made lately, by number. */
  readonly made: Map<number, Buffer>;
  /** The playlist's lines; `fresh` where the provider's stream started again. */
  list: { readonly index: number; readonly length: number; readonly fresh: boolean }[];
  /** The ffmpeg whose segments count, by the id in their address, and its first segment. */
  run: string | null;
  first: number;
  /** The stream is over: the provider ended it, or it failed. */
  over: boolean;
  /** Heard when the playlist grew or the stream ended. */
  readonly changed: Set<() => void>;
  readonly epochs: number[];
  duration: number;
}

/** What a receiver plays of a movie or episode. */
interface TitleReceiver {
  /** Where its segments start; its picture copied, or converted once copying can't keep to them. */
  plan: SegmentPlan;
  /** Where the plan's starts come from, for the diagnostics. */
  readonly index: "cues" | "samples" | "none";
  /** What the receiver was last sent: the tracks chosen, under a token of their own. */
  load: TitleLoad | null;
}

/** One load of a title on a receiver: a playlist for the chosen tracks, and its segments. */
interface TitleLoad {
  readonly token: string;
  readonly audio: number | null;
  /** A text subtitle track, or null. */
  readonly subtitle: number | null;
  readonly store: SegmentStore;
  /** Aborts when another load takes its place, or the session closes. */
  readonly closed: AbortController;
  run: ReceiverRun | null;
  /** Ends the run when the receiver asks for nothing for a long time. */
  idle: ReturnType<typeof setTimeout> | undefined;
  /** Heard when a segment arrived, a run ended, or subtitles were read. */
  readonly changed: Set<() => void>;
}

/** One ffmpeg making a title's segments in order, from one of them on. */
interface ReceiverRun {
  readonly id: string;
  /** Its first segment, and how many it makes that end where the playlist says. */
  readonly from: number;
  readonly count: number;
  /** The segment being taken from it, or the next to come. */
  next: number;
  ended: boolean;
  readonly signal: AbortSignal;
  /** Ends it: the receiver went elsewhere, or paused for long. */
  stop(): void;
  /** The text subtitles it has read, on the file's clock. */
  readonly cues: SubtitleEntry[];
  /** What the track holds from before the run's start, or null when that can't be had. */
  readonly before: Promise<Before | null>;
  /** Told once its first segment is whole: the provider is no longer the run's alone. */
  settled?: () => void;
}

/** Token and method checks shared by the two delivery kinds, after Playback's LAN preamble. */
function receiverRoute(
  token: string | undefined,
  lan: ReceiverLan,
  request: IncomingMessage,
  url: URL,
  response: ServerResponse,
) {
  // A path with ".." in it was resolved before it is matched, so it names nothing here.
  const route = RECEIVER_ROUTE.exec(url.pathname);
  if (!route || route[1] !== token || (request.method !== "GET" && request.method !== "HEAD")) {
    response.writeHead(410).end();
    return null;
  }
  lan.requests++;
  return route;
}

/** A channel's LAN token, segment ring and converter, subordinate to its admitted session. */
export function liveReceiverDelivery(
  source: LiveReceiverSource,
  lan: ReceiverLan,
  tools: ReceiverTools,
): LiveReceiverDelivery {
  const receiver: LiveReceiver = {
    token: randomBytes(18).toString("base64url"),
    made: new Map(),
    list: [],
    run: null,
    first: 0,
    over: false,
    changed: new Set(),
    epochs: [],
    duration: 0,
  };
  const proxied = (id: string) => `${lan.origin}/r/${receiver.token}/h${id}`;
  return {
    kind: "live",
    url: `${lan.origin}/r/${receiver.token}/live.m3u8`,
    run: runLive,
    epoch: (startS) => void receiver.epochs.push(startS),
    async serve(request, response, url) {
      const route = receiverRoute(receiver.token, lan, request, url, response);
      if (!route) return;
      const [, , playlist, , , made, address] = route;
      if (source.stream.kind === "hls" && (playlist === "live" || address !== undefined)) {
        await source.stream.passThrough(address ?? null, url, request, response, proxied);
      } else if (source.stream.kind !== "hls" && playlist === "live") {
        await sendLivePlaylist(response);
      } else {
        const segment = made === undefined ? undefined : receiver.made.get(Number(made));
        if (!segment) response.writeHead(404).end();
        else {
          response.writeHead(200, {
            "Content-Type": "video/mp2t",
            "Content-Length": segment.length,
          });
          response.end(segment);
        }
      }
    },
    async receive(run, index, request, response) {
      if (request.headers.expect) response.writeContinue();
      receiveLive(run, index, request, response);
    },
  };
  /**
   * A channel's playlist for a receiver: the segments made lately. The first one waits until
   * there are enough to start playing from, or the stream turns out not to come.
   */
  async function sendLivePlaylist(response: ServerResponse): Promise<void> {
    const left = new AbortController();
    response.on("close", () => left.abort());
    await until(
      receiver.changed,
      () => receiver.list.length >= LIVE_LIST.least || receiver.over,
      AbortSignal.any([source.closed, left.signal, AbortSignal.timeout(LIVE_START_MS)]),
    );
    if (response.destroyed) return;
    if (receiver.list.length === 0) {
      const failure = source.failure();
      response.writeHead(failure && "status" in failure ? failure.status : 502).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
    // A stream that is over says so, and the receiver stops asking.
    response.end(livePlaylist(receiver.list) + (receiver.over ? "#EXT-X-ENDLIST\n" : ""));
  }

  /**
   * Reads a channel's MPEG-TS from the provider for a receiver and has ffmpeg cut it into
   * segments, which come back here one by one (see `receiveLive`). The picture and the chosen
   * sound are copied when the receiver decodes them. One request to the provider, as for the
   * UI's player; it starts when the session opens, so the receiver finds segments when it asks.
   */
  async function runLive(): Promise<void> {
    const stream = source.stream;
    if (stream.kind === "hls") return;
    const started = performance.now();
    const report = (
      delivery: "direct" | "converted" | "none",
      outcome: "ok" | StreamFailure["kind"],
    ) =>
      tools.record({
        op: "stream",
        ms: Math.round(performance.now() - started),
        delivery,
        outcome,
      });
    const active = new AbortController();
    source.begin(active);
    const signal = AbortSignal.any([source.closed, active.signal]);
    const over = (failure: StreamFailure) => {
      if (signal.aborted) return;
      source.fail(failure);
      receiver.over = true;
      tell(receiver.changed);
    };

    const hls = stream.kind === "converted-hls";
    const opened =
      stream.kind === "converted-hls"
        ? {
            ok: true as const,
            reader: null,
            start: { layout: stream.layout, diagnostic: {}, head: [], pending: null },
            input: stream.bytes(signal),
          }
        : await stream
            .open(signal, (failure) => report("none", failure.kind))
            .then((opened) =>
              opened.ok ? { ...opened, input: replay(opened.start, opened.reader) } : opened,
            );
    if (signal.aborted) {
      if (opened.ok) void opened.reader?.cancel().catch(() => {});
      return;
    }
    if (!opened.ok) return over(opened.failure);
    const { reader, start } = opened;
    const { layout } = start;
    const ffmpeg = tools.ffmpeg;
    if (!layout || !ffmpeg) {
      void reader?.cancel().catch(() => {});
      report("none", "unsupported");
      return over({
        kind: "unsupported",
        diagnostic: {
          ...liveDiagnostic(layout, null, source.repair, source.audio),
          diagnostic_delivery: "unknown",
          diagnostic_stage: "inspect",
          diagnostic_reason: !ffmpeg ? "tool_missing" : "inspection_undetermined",
        },
        detail: ffmpeg
          ? t("A receiver plays channels sent as MPEG-TS or HLS, and this one is neither.")
          : t("This build has no ffmpeg to make a receiver's stream."),
      });
    }
    const video = layout.video;
    const input = opened.input;
    const cleaned =
      video && video.codec !== "unknown" && CLEAN_START_CODECS.has(video.codec)
        ? cleanStart(input, createCleanStart(video.pid, video.codec))
        : input;
    // The track asked for, else the sound in the viewer's language, else the channel's first.
    const chosen = liveAudio(layout, source.audio, source.audioLanguage);
    if (!hls) source.started(layout, chosen?.pid ?? null);
    const decodes = (codec: Codec | "unknown") => codec !== "unknown" && source.decoders.has(codec);
    const segments: LiveSegments = {
      ...(hls ? { subtitles: [...new Set(layout.subtitles.map((track) => track.pid))] } : {}),
      video: !video ? "none" : decodes(video.codec) ? "copy" : "h264",
      audio: !chosen ? "none" : decodes(chosen.codec) ? "copy" : "aac",
      pids: { video: video?.pid ?? null, audio: chosen?.pid ?? null },
    };
    const delivery = segments.video === "h264" || segments.audio === "aac" ? "converted" : "direct";

    source.noteDiagnostic({
      ...liveDiagnostic(layout, null, source.repair, chosen?.pid ?? null),
      ...start.diagnostic,
      diagnostic_delivery: delivery,
    });
    const id = randomBytes(9).toString("base64url");
    receiver.run = id;
    receiver.first = (receiver.list.at(-1)?.index ?? -1) + 1;
    const made = source.made(id);
    const child = spawn(
      ffmpeg,
      liveSegmentArguments(segments, receiver.first, made.segments, made.list),
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    if (hls) {
      const ended = new Promise<void>((resolve) => child.once("close", () => resolve()));
      source.child(ended);
    }
    let errors = "";
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000);
    });
    const stop = () => child.kill("SIGKILL");
    signal.addEventListener("abort", stop, { once: true });
    const body = Readable.from(cleaned);
    body.on("error", (cause) => {
      if (!signal.aborted)
        source.fail(
          stream.kind === "converted-hls"
            ? stream.failure(cause)
            : { kind: "network", detail: String(cause) },
        );
      child.stdin.end();
    });
    // ffmpeg stops reading when it fails or is killed; that write error is not the stream's.
    child.stdin.on("error", () => {});
    body.pipe(child.stdin);
    child.on("error", (cause) =>
      over({
        kind: "unsupported",
        detail: String(cause),
        diagnostic: {
          ...source.diagnostic(),
          diagnostic_stage: "convert",
          diagnostic_reason: "tool_failed",
        },
      }),
    );
    child.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      body.destroy();
      if (signal.aborted) return;
      const failure: StreamFailure =
        source.failure() ??
        (code === 0
          ? { kind: "network", detail: t("The provider's stream ended.") }
          : {
              kind: "unsupported",
              detail: `${t("The stream could not be made into one a receiver plays.")} ${lastLine(errors, code, child.signalCode)}`,
              diagnostic: {
                ...source.diagnostic(),
                diagnostic_stage: "convert",
                diagnostic_reason: "conversion_failed",
              },
            });
      report(delivery, failure.kind);
      over(failure);
    });
    report(delivery, "ok");
  }

  /**
   * What the ffmpeg of a channel's receiver stream sends back: a segment (`index`), kept until
   * the playlist has moved past it, or its list of the segments that are whole, which puts
   * them in the playlist.
   */
  function receiveLive(
    run: string,
    index: number | null,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    if (receiver.run !== run) {
      request.resume();
      response.writeHead(410).end();
      return;
    }
    request.on("error", () => {});
    if (index !== null) {
      const parts: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > LIVE_SEGMENT_BYTES) request.destroy();
        else parts.push(chunk);
      });
      request.on("end", () => {
        if (receiver.run === run) receiver.made.set(index, Buffer.concat(parts));
        response.writeHead(204).end();
      });
      return;
    }
    // The list comes anew with each segment: what it names that the playlist hasn't yet goes in.
    let text = "";
    request.setEncoding("utf8");
    request.on("data", (part: string) => {
      if (text.length < 64 * 1024) text += part;
    });
    request.on("end", () => {
      response.writeHead(204).end();
      if (receiver.run !== run) return;
      for (const listed of listedSegments(text)) {
        const newest = receiver.list.at(-1)?.index ?? -1;
        if (listed.index <= newest || !receiver.made.has(listed.index)) continue;
        // The first of an ffmpeg that isn't the session's first: the provider's stream started
        // again, and its clock did too.
        let fresh = receiver.list.length > 0 && listed.index === receiver.first;
        while (receiver.epochs[0] !== undefined && receiver.epochs[0] <= receiver.duration + 0.25) {
          receiver.epochs.shift();
          fresh = true;
        }
        receiver.duration += listed.length;
        receiver.list = [...receiver.list, { ...listed, fresh }].slice(-LIVE_LIST.kept);
        // One behind the playlist stays, for a receiver that asks for it a moment late.
        const oldest = receiver.list[0]!.index - 1;
        for (const kept of receiver.made.keys()) if (kept < oldest) receiver.made.delete(kept);
      }
      tell(receiver.changed);
    });
  }
}

/** A title's plan, current receiver load and runs. Playback still owns the file and reports. */
export async function titleReceiverDelivery(
  source: TitleReceiverSource,
  lan: ReceiverLan,
  tools: ReceiverTools,
): Promise<TitleReceiverDelivery | null> {
  const planned = await planSegments(source, source.probe);
  if (!planned) return null;
  const receiver: TitleReceiver = { ...planned, load: null };
  return {
    kind: "title",
    first: receiver.plan.starts[0]!,
    get loaded() {
      return receiver.load !== null;
    },
    fileReplaced(failure) {
      const load = receiver.load;
      receiver.load = null;
      load?.closed.abort();
      lan.failed(failure);
    },
    load(tracks) {
      const before = receiver.load;
      before?.closed.abort();
      // Only text reaches a receiver: the others are drawn by the UI's player.
      const subtitle =
        source.probe.subtitles.find(
          (track) => track.id === tracks.subtitle && track.format === "text",
        )?.id ?? null;
      const closed = new AbortController();
      const load: TitleLoad = {
        token: randomBytes(18).toString("base64url"),
        audio: tracks.audio,
        subtitle,
        store: segmentStore({ ...SEGMENT_LIMITS, ...tools.limits.segments }),
        closed,
        run: null,
        idle: undefined,
        changed: new Set(),
      };
      const end = () => closed.abort();
      source.closed.addEventListener("abort", end, { once: true });
      closed.signal.addEventListener(
        "abort",
        () => {
          source.closed.removeEventListener("abort", end);
          clearTimeout(load.idle);
          load.store.fail();
          tell(load.changed);
        },
        { once: true },
      );
      receiver.load = load;
      return {
        url: `${lan.origin}/r/${load.token}/master.m3u8`,
        subtitles: subtitle !== null,
      };
    },
    async serve(request, response, url) {
      const route = receiverRoute(receiver.load?.token, lan, request, url, response);
      if (!route) return;
      if (receiver.load) await serveReceiverTitle(receiver.load, route, response);
      else response.writeHead(410).end();
    },
    async receive(run, index, request, response) {
      if (index !== null) return receiveSegment(run, index, request, response);
      if (request.headers.expect) response.writeContinue();
      response.writeHead(410).end();
    },
  };
  /** A receiver's request for something of a title: a playlist, a segment or a segment's subtitles. */
  async function serveReceiverTitle(
    load: TitleLoad,
    route: RegExpExecArray,
    response: ServerResponse,
  ): Promise<void> {
    const [, , playlist, video, cues] = route;
    const probe = source.probe;
    // A receiver that asks is still there: the run may go on, and does while a request waits.
    const idle = () => {
      clearTimeout(load.idle);
      load.idle = setTimeout(
        () => (load.store.awaited().length > 0 ? idle() : load.run?.stop()),
        tools.limits.idleMs ?? RECEIVER_IDLE_MS,
      );
    };
    idle();
    const { plan } = receiver;
    const text = (body: string) => {
      response.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
      response.end(body);
    };
    if (playlist === "master") {
      const size = source.size();
      const track = subtitleTracks(probe.subtitles).find((each) => each.id === load.subtitle);
      text(
        masterPlaylist(
          size !== null ? (size * 8) / (plan.end - plan.starts[0]!) : 8_000_000,
          track ? { name: track.label, language: languageCode(track.language) } : null,
        ),
      );
    } else if (playlist === "video") text(titlePlaylist(plan, (index) => `v${index}.ts`));
    else if (playlist === "subs" && load.subtitle !== null) {
      text(titlePlaylist(plan, (index) => `s${index}.vtt`));
    } else if (video !== undefined && Number(video) < plan.starts.length) {
      await sendSegment(load, Number(video), response);
    } else if (cues !== undefined && load.subtitle !== null && Number(cues) < plan.starts.length) {
      await sendCues(load, Number(cues), response);
    } else response.writeHead(404).end();
  }

  /**
   * A segment of a title for a receiver, once it is made. Where the receiver asks is where it
   * is: a run that isn't about to make the segment gives way to one that starts with it, so a
   * skip anywhere in the title costs one new request to the provider, as for the UI's player.
   */
  async function sendSegment(
    load: TitleLoad,
    index: number,
    response: ServerResponse,
  ): Promise<void> {
    const left = new AbortController();
    response.on("close", () => left.abort());
    const run = load.run;
    // The one being taken from ffmpeg now, or the next: anything further is sooner had afresh.
    const coming =
      run !== null &&
      !run.ended &&
      !run.signal.aborted &&
      index >= run.next &&
      index <= run.next + 1 &&
      index < run.from + run.count;
    if (!load.store.has(index) && !coming) startRun(load, index);
    const late = AbortSignal.timeout(tools.limits.segmentMs ?? SEGMENT_WAIT_MS);
    const segment = await load.store.take(
      index,
      AbortSignal.any([load.closed.signal, left.signal, late]),
    );
    noteAhead(load);
    if (!segment && late.aborted && !left.signal.aborted && !load.closed.signal.aborted) {
      // The provider, or the ffmpeg reading it, has stopped. The run ends, which frees the
      // provider, and whoever opened the session hears; asking again starts a new one.
      const failure = source.fail({
        kind: "network",
        detail: t("The provider did not send the file in time."),
      });
      load.run?.stop();
      load.store.fail();
      lan.failed(failure);
      if (!response.destroyed) response.writeHead(504).end();
      return;
    }
    if (response.destroyed) return;
    if (!segment) {
      const failure = source.failure();
      response.writeHead(failure && "status" in failure ? failure.status : 503).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "video/mp2t", "Content-Length": segment.length });
    response.end(segment);
  }

  /**
   * Tells the session how much of the title waits for the receiver, which says when a reading
   * of a subtitle track's past may have the provider: while ffmpeg is held, playback spares it.
   */
  function noteAhead(load: TitleLoad): void {
    const run = load.run;
    source.progress(
      load.store.ahead * SEGMENT_S,
      run !== null && !run.ended && !load.store.room(run.next),
    );
  }

  /**
   * Starts the ffmpeg that makes a title's segments from segment `from` on, in place of the one
   * before. `mismatch` when it takes the place of a copied run whose segment didn't start where
   * the file's index said.
   */
  function startRun(load: TitleLoad, from: number, mismatch = false): void {
    const probe = source.probe;
    const ffmpeg = tools.ffmpeg;
    if (!ffmpeg) return;
    const started = performance.now();
    load.run?.stop();
    // Requests that wait for a segment this run doesn't bring first get none.
    for (const index of load.store.awaited()) {
      if (index < from || index > from + 1) load.store.fail(index);
    }
    const { plan } = receiver;
    const abort = new AbortController();
    const signal = AbortSignal.any([load.closed.signal, abort.signal]);
    const lease = source.begin(abort);
    const cuts = runCuts(
      plan,
      from,
      probe.origin,
      // ffmpeg's reader for MP4 seeks by presentation time; see `runCuts`.
      probe.video?.reordered === true && probe.container !== "mp4",
    );
    const planned = receiverPlan(
      probe,
      {
        audio: load.audio,
        subtitle: load.subtitle,
        convert: plan.video === "convert",
        cuts,
        from,
        first: plan.starts[0]!,
      },
      source.decoders,
      {
        source: lease.source,
        // ffmpeg starts sending the next segment without waiting for an answer to the last,
        // and would read the whole file ahead of the receiver. With a name in the address it
        // asks first, "Expect: 100-continue", as it does to learn how a server wants a login,
        // and waits for the answer; the proxy wants none and answers when there is room.
        segments: lease.segments,
        subtitles: lease.subtitles,
      },
    );
    let reported = false;
    const report = (outcome: "ok" | StreamFailure["kind"]) => {
      if (reported) return;
      reported = true;
      tools.record({
        op: "receiver",
        ms: Math.round(performance.now() - started),
        video: planned.video,
        audio: planned.audio,
        index: mismatch ? "mismatch" : planned.video === "copy" ? receiver.index : "none",
        outcome,
      });
    };

    const child = spawn(ffmpeg, planned.args, { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    let spawnFailed = false;
    child.stderr.on("data", (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-2000);
    });
    const stop = () => {
      child.kill("SIGKILL");
      lease.settled();
    };
    signal.addEventListener("abort", stop, { once: true });
    const exited = new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.on("error", (cause) => {
        errors = String(cause);
        spawnFailed = true;
        resolve(null);
      });
    });

    source.noteDiagnostic({
      ...titleDiagnostic(probe, planned, load.audio),
      diagnostic_fallback: mismatch ? "video" : "none",
    });
    const expected = plan.starts[from]!;
    const cues: SubtitleEntry[] = [];
    // What the run reads of its subtitle track is kept with the session's file, as a run of the
    // UI's player keeps it, so a later position finds it read.
    const generation = source.generation();
    const reading =
      planned.subtitle && load.subtitle !== null ? source.history(load.subtitle).reading() : null;
    const subtitles =
      planned.subtitle && reading
        ? subtitleSink(planned.subtitle, (entry) => {
            // What it reads now is of another file than it started in.
            if (source.generation() !== generation) return;
            reading.add(entry);
            reading.reach(entry.from - interleave(probe));
            cues.push(entry);
            tell(load.changed);
          })
        : null;
    reading?.begin(from === 0 ? Number.NEGATIVE_INFINITY : expected + interleave(probe));
    if (subtitles) lease.report({ subtitles: subtitles.receive });

    const run: ReceiverRun = {
      id: lease.id,
      from,
      count: cuts.count,
      next: from,
      ended: false,
      signal,
      stop: () => abort.abort(),
      cues,
      // From the start of the file a run reads every line itself.
      before:
        load.subtitle === null || from === 0
          ? Promise.resolve(null)
          : cuesBefore(load, load.subtitle, expected - probe.origin, signal),
    };
    load.run = run;

    void exited.then(async (code) => {
      signal.removeEventListener("abort", stop);
      // Process exit can precede delivery of its final loopback report.
      if (code === 0 && subtitles) await arrives(subtitles.arrived);
      const whole = (await subtitles?.whole()) === true;
      // ffmpeg exits cleanly after its input broke off too; the source knows better.
      reading?.end(whole && code === 0 && !signal.aborted && !source.failure());
      run.ended = true;
      lease.ended();
      if (signal.aborted) return;
      if (code !== 0 || source.failure()) {
        const failure = source.fail({
          kind: "unsupported",
          detail: `${t("The file could not be played.")} ${lastLine(errors, code, child.signalCode)}`,
          diagnostic: {
            ...source.diagnostic(),
            diagnostic_stage: "convert",
            diagnostic_reason: spawnFailed ? "tool_failed" : "conversion_failed",
          },
        });
        report(failure.kind);
        // Nothing more comes of this run, and the next would fail the same way.
        load.store.fail();
      } else {
        // It read the file to its end: a segment still waited for isn't in it.
        for (const index of load.store.awaited()) if (index >= run.next) load.store.fail(index);
      }
      tell(load.changed);
    });
    run.settled = () => {
      report("ok");
      lease.settled();
    };
  }

  /**
   * A segment a title's ffmpeg sends back. ffmpeg asks before it sends one (see `startRun`),
   * and is told to go on only when the receiver is near that segment, which holds ffmpeg, and
   * through it the provider's connection, while the receiver has enough. What follows a run's
   * last cut isn't a segment of the playlist: the run ends there.
   *
   * The receiver has the playlist already, so every segment has to hold what that says: its
   * pictures' times are read from the segment itself, the first where the segment starts and
   * none at or after where the next does. A copied one that doesn't means the file's index
   * named a keyframe that isn't there, or left the segment too long to keep: the title's
   * picture is converted from then on, with keyframes made at the same starts. A converted one
   * that doesn't can't be put right, and fails the stream.
   */
  async function receiveSegment(
    id: string,
    index: number,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const load = receiver.load;
    const run = load?.run;
    const refuse = () => {
      request.resume();
      if (!response.headersSent) response.writeHead(410).end();
    };
    if (!load || !run || run.id !== id) return refuse();
    if (index >= run.from + run.count) {
      run.stop();
      return refuse();
    }
    /** The segment isn't what the playlist says: converted from here on, if it was copied. */
    const wrong = () => {
      run.stop();
      if (receiver.plan.video === "copy") {
        receiver.plan = { ...receiver.plan, video: "convert" };
        startRun(load, index, true);
      } else {
        source.fail({
          kind: "unsupported",
          detail: t("The file's picture can't be cut where a receiver's playlist needs it."),
          diagnostic: {
            ...titleDiagnostic(source.probe, null, load.audio),
            diagnostic_stage: "convert",
            diagnostic_reason: "conversion_failed",
            diagnostic_fallback: "video",
          },
        });
        load.store.fail();
      }
      refuse();
    };
    request.on("error", () => {});
    run.next = index;
    // ffmpeg asked before sending: it waits here, having read no more of the provider's file
    // than this segment took.
    await load.store.whenRoom(index, run.signal);
    if (run.signal.aborted) return refuse();
    if (request.headers.expect) response.writeContinue();
    const parts: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of request as AsyncIterable<Buffer>) {
        if (run.signal.aborted) return refuse();
        size += chunk.length;
        if (size > load.store.limits.segment) return wrong();
        parts.push(chunk);
      }
    } catch {
      return refuse();
    }
    if (run.signal.aborted) return refuse();
    const segment = Buffer.concat(parts);
    const listed = segmentSpan(receiver.plan, index);
    const shows = pictureSpan(segment);
    if (
      shows === null ||
      Math.abs(shows.first - listed.start) > listed.within ||
      (listed.end !== null && shows.last >= listed.end + listed.within)
    ) {
      return wrong();
    }
    load.store.put(index, segment);
    run.next = index + 1;
    run.settled?.();
    noteAhead(load);
    tell(load.changed);
    response.writeHead(204).end();
  }

  /**
   * What a text subtitle track holds from before `start` seconds into the title that a run
   * from there doesn't bring: the line on screen at the position, above all. It is read as for
   * the UI's player (see `subtitlesBefore`), when playback spares the provider. Null when it
   * can't be had, which the diagnostics note: the track then shows from its next line.
   */
  async function cuesBefore(
    load: TitleLoad,
    track: number,
    start: number,
    signal: AbortSignal,
  ): Promise<Before | null> {
    const started = performance.now();
    const spent: Spent = { bytes: 0, requests: 0 };
    const attempt: Attempt = {
      signal: AbortSignal.any([signal, AbortSignal.timeout(source.recoveryMs)]),
      spent,
      narrow: false,
    };
    const record = (outcome: "ok" | SubtitlesUnavailable) =>
      tools.record({
        op: "subtitles",
        ms: Math.round(performance.now() - started),
        bytes: spent.bytes,
        requests: spent.requests,
        ...source.counts(),
        outcome,
      });
    // What the receiver has waiting counts for two seconds, as what a player says does.
    const noting = setInterval(() => noteAhead(load), 500);
    source.recovering(1);
    try {
      const before = await source.subtitlesBefore(
        { track, page: null, codec: "", start: Math.max(0, start) },
        attempt,
      );
      if (!signal.aborted) record("ok");
      return before;
    } catch (cause) {
      if (!signal.aborted) {
        record(
          cause instanceof Unavailable
            ? cause.kind
            : attempt.signal.aborted
              ? "limit"
              : "unreadable",
        );
      }
      return null;
    } finally {
      clearInterval(noting);
      source.recovering(-1);
      tell(load.changed);
    }
  }

  /**
   * A segment's text subtitles for a receiver: every line on screen at some time in it, the one
   * that began before it included. They are known once a run that began at or before the
   * segment has read past its end. A receiver that asks sooner waits, a while at most, and gets
   * a segment without lines rather than none: the picture never waits for subtitles.
   */
  async function sendCues(load: TitleLoad, index: number, response: ServerResponse): Promise<void> {
    const left = new AbortController();
    response.on("close", () => left.abort());
    const signal = AbortSignal.any([
      load.closed.signal,
      left.signal,
      AbortSignal.timeout(tools.limits.cuesMs ?? CUES_WAIT_MS),
    ]);
    const reader = () => {
      const run = load.run;
      return run && run.from <= index && (run.next > index + 1 || run.ended) ? run : null;
    };
    await until(load.changed, () => reader() !== null, signal);
    const run = reader();
    // What came before the run's start is still being read, or the wait is already over: the
    // segment goes without it then.
    const before = run ? await unlessAborted(run.before, signal) : null;
    if (response.destroyed) return;
    const { plan } = receiver;
    const entries = run
      ? [...(before?.entries ?? []), ...run.cues.filter((cue) => !before || cue.from > before.upTo)]
      : [];
    response.writeHead(200, { "Content-Type": "text/vtt; charset=utf-8" });
    response.end(
      subtitleSegment(
        entries,
        plan.starts[index]!,
        plan.starts[index + 1] ?? plan.end,
        plan.starts[0]!,
      ),
    );
  }
}

/**
 * Where the segments of the session's title start for a receiver: on the keyframes the file's
 * index names when the receiver decodes the picture and the index can be read and used, and
 * every few seconds with the picture converted otherwise. Reading the index takes a few
 * requests of the provider and a bounded amount, before anything plays. Null when the file
 * has no picture or doesn't say how long it is: it gets no playlist then.
 */
async function planSegments(
  source: TitleReceiverSource,
  probe: TitleProbe,
): Promise<Pick<TitleReceiver, "plan" | "index"> | null> {
  const video = probe.video;
  const end = endOf(probe);
  if (!video || end === null) return null;
  const converted = () => {
    const plan = convertPlan(video.start, end);
    return plan && { plan, index: "none" as const };
  };
  if (video.codec === null || !source.decoders.has(video.codec)) return converted();
  const attempt: Attempt = {
    signal: AbortSignal.any([source.closed, AbortSignal.timeout(INDEX_LIMITS.ms)]),
    spent: { bytes: 0, requests: 0 },
    narrow: false,
  };
  const read = source.reader(attempt, INDEX_LIMITS);
  let keyframes: number[] | null = null;
  let index: TitleReceiver["index"] = "none";
  try {
    if (probe.container === "matroska") {
      const layout = await source.layout(read);
      // ffmpeg numbers its streams by the tracks it reads, in the file's order.
      const track = layout?.tracks[video.id]?.number;
      keyframes =
        layout && track !== undefined
          ? layout.cues.flatMap((cue) => (cue.track === track ? [cue.time] : []))
          : null;
      index = "cues";
    } else if (probe.container === "mp4") {
      // A cached probe hasn't read this session's source. Learn its size through the same
      // bounded reader; the index then reuses the header's kept window.
      if (source.size() === null) await read(0, 16);
      const size = source.size();
      if (size !== null) {
        const times = await mp4Keyframes(read, size, video.id);
        keyframes = times && times.map((time) => video.start + time);
        index = "samples";
      }
    }
  } catch {
    // The provider didn't give the index, or it is more than may be read.
    keyframes = null;
  }
  const plan = keyframes && keyframes.length > 0 ? copyPlan(keyframes, video.start, end) : null;
  return plan ? { plan, index } : converted();
}
