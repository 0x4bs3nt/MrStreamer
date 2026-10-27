// One connected Cast receiver: the channel to it, the media app started on it, and the load that
// app plays. It asks the receiver for what the output service wants, each request with an id and
// a deadline, and turns what the receiver says into the adapter's events.
//
// A receiver numbers each media it loads (`mediaSessionId`). The session holds one load, the last
// one asked for, and learns its number from the answer to its LOAD; what the receiver says under
// any other number belongs to an earlier load, or to another sender, and is dropped.
import { setTimeout as sleep } from "node:timers/promises";
import {
  ReceiverFailed,
  type AdapterEvent,
  type Connection,
  type ReceiverMedia,
  type TransportState,
} from "../adapter.ts";
import { openChannel, type CastMessage, type Channel } from "./channel.ts";
import type { CastEndpoint } from "./discovery.ts";
import {
  NAMESPACE,
  PLATFORM,
  readMediaMessage,
  readPlatformMessage,
  readReceiverMessage,
  type MediaStatus,
  type ReceiverStatus,
} from "./messages.ts";

/**
 * Google's Default Media Receiver: the app every Cast receiver can start, which plays the address
 * it is given and needs no registration.
 */
const MEDIA_RECEIVER = "CC1AD845";

/** How long the adapter waits at each step, in milliseconds. */
export interface CastTimings {
  /** Between pings, and how long a receiver may say nothing before the connection is reopened. */
  readonly ping: number;
  readonly silence: number;
  /** For the connection to open, and for the answer to a request. */
  readonly request: number;
  /** For the receiver to start the media app, and to take a load: a TV is slower at both. */
  readonly launch: number;
  readonly load: number;
  /** Between questions about the position while media plays. */
  readonly status: number;
  /** The wait before each try at reopening a broken connection, and how long each step of a try may take. */
  readonly reconnect: readonly number[];
  readonly attempt: number;
  /** For the receiver to confirm it stopped the app when letting go. */
  readonly close: number;
}

export const CAST_TIMINGS: CastTimings = {
  ping: 5000,
  silence: 10_000,
  request: 5000,
  launch: 20_000,
  load: 30_000,
  status: 5000,
  // Three tries over about ten seconds.
  reconnect: [500, 1500, 3000],
  attempt: 2000,
  close: 1500,
};

/** What an answer says beyond the status it may carry. */
interface Answer {
  readonly type: string;
  readonly requestId?: number;
  readonly reason?: string | null;
  readonly detailedErrorCode?: number | null;
}

/** The load the receiver was last asked to play. */
interface Load {
  readonly generation: number;
  readonly url: string;
  readonly live: boolean;
  /** The LOAD request: its answer names the receiver's media of this load. */
  readonly requestId: number;
  /** Settles once the receiver answered the LOAD, or didn't in time. */
  readonly answered: Promise<void>;
  /** Null until the receiver named it. */
  mediaSessionId: number | null;
  /** Given up from here before the receiver took it: it is stopped should the receiver play it. */
  dropped: boolean;
  state: TransportState;
  position: number;
  duration: number | null;
  /** Whether it showed a picture: buffering before that is still loading. */
  shown: boolean;
  /** Whether its text subtitles should show, and what the receiver was last asked. */
  subtitles: boolean;
  asked: boolean | null;
  textTrack: number | null;
  activeTracks: readonly number[];
}

export interface Session {
  readonly connection: Connection;
  /** As `Connection.disconnect`. */
  disconnect(): Promise<void>;
}

const unreachable = () => new ReceiverFailed({ kind: "unreachable" });

/** `promise`, or a rejection as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(unreachable());
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * A refusal in words for a failure's detail: its type, with its reason and error code. Only
 * what reads like one of the protocol's own names is kept, so nothing else a receiver wrote
 * reaches the UI or a log.
 */
function describe(answer: Answer): string {
  const name = (text: string | null | undefined) =>
    text && /^[A-Z_]{1,40}$/.test(text) ? text : "";
  const code = Number.isInteger(answer.detailedErrorCode) ? String(answer.detailedErrorCode) : "";
  return [name(answer.type) || "UNKNOWN", name(answer.reason), code].filter(Boolean).join(" ");
}

/** The state a receiver's media status describes; null when it describes none the app reports. */
function stateOf(status: MediaStatus, shown: boolean): TransportState | "failed" | null {
  switch (status.playerState) {
    case "PLAYING":
      return "playing";
    case "PAUSED":
      return "paused";
    case "BUFFERING":
      return shown ? "buffering" : "loading";
    case "LOADING":
      return "loading";
    case "IDLE":
      if (status.idleReason === "FINISHED") return "ended";
      if (status.idleReason === "CANCELLED" || status.idleReason === "INTERRUPTED") {
        return "stopped";
      }
      return status.idleReason === "ERROR" ? "failed" : null;
    default:
      return null;
  }
}

/**
 * Connects to the receiver at `endpoint` and starts the media app on it. `emit` hears the
 * receiver's news from then on, none of it before this resolves. Rejects with `ReceiverFailed`,
 * also when `signal` aborts first, and leaves nothing connected. A connect given up while the
 * receiver starts the app still has that app to stop: `leaves` is handed the wait for it.
 */
export async function openSession(
  endpoint: CastEndpoint,
  timings: CastTimings,
  emit: (event: AdapterEvent) => void,
  signal: AbortSignal,
  leaves: (stopped: Promise<void>) => void = () => {},
): Promise<Session> {
  /** Aborts when the session ends, whichever way: it stops a reconnect that is under way. */
  const ended = new AbortController();
  const pending = new Map<
    number,
    { readonly timer: NodeJS.Timeout; resolve(answer: Answer): void; reject(error: Error): void }
  >();
  let nextRequest = 1;
  let channel: Channel | null = null;
  /** The media app as started for this session, and the apps the receiver last said it runs. */
  let app: { readonly sessionId: string; readonly transportId: string } | null = null;
  let applications: NonNullable<ReceiverStatus["applications"]> = [];
  let volume: { readonly level: number; readonly muted: boolean } | null = null;
  let load: Load | null = null;
  /** The last question about what plays: its answer lists everything the media app holds. */
  let polled = -1;
  let watching: NodeJS.Timeout | undefined;
  /** Connected with the app running: from then on news is reported and a broken channel reopened. */
  let established = false;
  let recovering = false;
  /** Let go of, released or lost: nothing more is reported, and commands fail. */
  let closed = false;

  const report = (event: AdapterEvent) => {
    if (!closed) emit(event);
  };

  const failPending = () => {
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(unreachable());
    }
    pending.clear();
  };

  /**
   * Sends a request and waits for the answer that names it, `deadline` ms at most. Rejects with
   * `unreachable` when none comes, the channel breaks first or there is none.
   */
  const request = (
    destinationId: string,
    namespace: string,
    body: object,
    deadline = timings.request,
    requestId = nextRequest++,
  ) =>
    new Promise<Answer>((resolve, reject) => {
      // While a broken channel is being reopened, the app isn't joined yet and hears nothing.
      if (!channel || (recovering && destinationId !== PLATFORM)) return reject(unreachable());
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(unreachable());
      }, deadline);
      pending.set(requestId, { timer, resolve, reject });
      try {
        channel.send(destinationId, namespace, { ...body, requestId });
      } catch {
        pending.delete(requestId);
        clearTimeout(timer);
        reject(new ReceiverFailed({ kind: "unavailable", detail: "request too large" }));
      }
    });

  /** Hands an answer to the request it names, if one still waits. */
  const settle = (answer: Answer) => {
    const waiting = pending.get(answer.requestId ?? 0);
    if (!waiting) return;
    pending.delete(answer.requestId ?? 0);
    clearTimeout(waiting.timer);
    waiting.resolve(answer);
  };

  /** A request to the receiver itself. Rejects unless it answers with its status. */
  const ask = async (body: object, deadline?: number): Promise<void> => {
    const answer = await request(PLATFORM, NAMESPACE.receiver, body, deadline);
    if (answer.type !== "RECEIVER_STATUS") {
      throw new ReceiverFailed({ kind: "unavailable", detail: describe(answer) });
    }
  };

  /**
   * Asks the media app what it plays. Nobody waits for the answer: it arrives as a status like
   * any other, and a connection that carries none is the heartbeat's to notice.
   */
  const poll = () => {
    if (!channel || !app) return;
    polled = nextRequest++;
    channel.send(app.transportId, NAMESPACE.media, { type: "GET_STATUS", requestId: polled });
  };

  const reportState = (current: Load, state: TransportState) => {
    current.state = state;
    report({
      type: "status",
      status: {
        generation: current.generation,
        state,
        position: current.position,
        at: Date.now(),
        duration: current.duration,
      },
    });
  };

  /** A request about the media of `current`, which the receiver named. */
  const mediaRequest = async (current: Load, body: object): Promise<void> => {
    if (!app || current.mediaSessionId === null) return;
    const answer = await request(app.transportId, NAMESPACE.media, {
      ...body,
      mediaSessionId: current.mediaSessionId,
    });
    // The receiver let go of the media meanwhile: there is nothing left to command.
    if (answer.type === "MEDIA_STATUS" || answer.reason === "INVALID_MEDIA_SESSION_ID") return;
    throw new ReceiverFailed({ kind: "media", detail: describe(answer) });
  };

  /**
   * Has the receiver show or hide the load's text track, once it listed the tracks and unless it
   * already does. The tracks that aren't text stay as the receiver has them.
   */
  const syncSubtitles = async (current: Load): Promise<void> => {
    const track = current.textTrack;
    if (track === null) return;
    const showing = current.asked ?? current.activeTracks.includes(track);
    if (showing === current.subtitles) return;
    current.asked = current.subtitles;
    const others = current.activeTracks.filter((id) => id !== track);
    await mediaRequest(current, {
      type: "EDIT_TRACKS_INFO",
      activeTrackIds: current.subtitles ? [...others, track] : others,
    });
  };

  const mediaStatus = (current: Load, status: MediaStatus) => {
    const text = status.media?.tracks?.find((track) => track.type === "TEXT");
    if (text) current.textTrack = text.trackId;
    if (status.activeTrackIds) current.activeTracks = status.activeTrackIds;
    const duration = status.media?.duration;
    if (!current.live && typeof duration === "number" && duration > 0) current.duration = duration;

    const state = stateOf(status, current.shown);
    // An idle receiver says 0 or nothing for the position: where the media got to stands.
    if (typeof status.currentTime === "number" && status.playerState !== "IDLE") {
      current.position = Math.max(0, status.currentTime);
    }
    if (state === "playing" || state === "paused") current.shown = true;
    if (state === "failed") {
      current.state = "stopped";
      report({
        type: "media-failed",
        generation: current.generation,
        failure: { kind: "media", detail: "IDLE ERROR" },
      });
    } else if (state) {
      reportState(current, state);
    }
    void syncSubtitles(current).catch(() => {});
  };

  /** A media status message: every media the app holds, in answer to `requestId` or as news. */
  const mediaStatuses = (statuses: readonly MediaStatus[], requestId: number | undefined) => {
    const current = load;
    if (closed || !current || !channel || !app) return;
    for (const status of statuses) {
      // The load's media is the one the answer to its LOAD names, or one playing its address,
      // as found when asking again after the connection broke before the answer.
      if (
        current.mediaSessionId === null &&
        (requestId === current.requestId || status.media?.contentId === current.url)
      ) {
        current.mediaSessionId = status.mediaSessionId;
        if (current.dropped) {
          try {
            channel.send(app.transportId, NAMESPACE.media, {
              type: "STOP",
              mediaSessionId: status.mediaSessionId,
              requestId: nextRequest++,
            });
          } catch {
            // Reconnecting cannot shrink this app's transport id. Stop the owned app instead,
            // then invalidate the session even if that STOP also cannot be sent or answered.
            void disconnect().then(() => emit({ type: "lost", failure: { kind: "unreachable" } }));
          }
        }
      }
      if (status.mediaSessionId === current.mediaSessionId && !current.dropped) {
        mediaStatus(current, status);
      }
    }
    // Asked what it plays, the receiver no longer names this load: it went unannounced.
    if (
      requestId === polled &&
      current.mediaSessionId !== null &&
      !current.dropped &&
      current.state !== "ended" &&
      current.state !== "stopped" &&
      !statuses.some((status) => status.mediaSessionId === current.mediaSessionId)
    ) {
      reportState(current, "stopped");
    }
  };

  const receiverStatus = (status: ReceiverStatus) => {
    applications = status.applications ?? [];
    if (!established) return;
    if (typeof status.volume?.level === "number") {
      const level = Math.min(1, Math.max(0, status.volume.level));
      const muted = status.volume.muted ?? false;
      if (level !== volume?.level || muted !== volume.muted) {
        volume = { level, muted };
        report({ type: "volume", level, muted });
      }
    }
    // A status that doesn't list the app, or lists none, says it is gone.
    const session = app?.sessionId;
    if (!applications.some((application) => application.sessionId === session)) {
      finish({ type: "released" });
    }
  };

  const receive = (message: CastMessage) => {
    if (message.namespace === NAMESPACE.connection) {
      if (readPlatformMessage(message.payload)?.type !== "CLOSE") return;
      // The app closing its end is the app going; the receiver closing its own is the channel
      // going, though the socket may stay.
      if (message.sourceId === app?.transportId) finish({ type: "released" });
      else if (message.sourceId === PLATFORM) broken();
      return;
    }
    // What it says is taken in first, so whoever waits for the answer finds it done.
    if (message.namespace === NAMESPACE.receiver && message.sourceId === PLATFORM) {
      const answer = readReceiverMessage(message.payload);
      if (!answer) return;
      if (answer.type === "RECEIVER_STATUS" && answer.status) receiverStatus(answer.status);
      settle(answer);
    } else if (message.namespace === NAMESPACE.media && message.sourceId === app?.transportId) {
      const answer = readMediaMessage(message.payload);
      if (!answer) return;
      if (answer.type === "MEDIA_STATUS") mediaStatuses(answer.status ?? [], answer.requestId);
      settle(answer);
    }
  };

  /** Opens the channel and the link to the receiver on it. */
  const open = async (deadline: number, until: AbortSignal) => {
    const opened = await openChannel({
      host: endpoint.host,
      port: endpoint.port,
      deadline,
      ping: timings.ping,
      silence: timings.silence,
      signal: until,
      message: receive,
      broken,
    });
    if (closed) {
      opened.close();
      throw unreachable();
    }
    channel = opened;
    opened.send(PLATFORM, NAMESPACE.connection, { type: "CONNECT", origin: {} });
    return opened;
  };

  /** Drops the channel and fails what waits on it. */
  const drop = () => {
    channel?.close();
    channel = null;
    failPending();
  };

  /** The session is over: lets go of everything, then says why, once. */
  function finish(event: AdapterEvent) {
    if (closed) return;
    closed = true;
    end();
    emit(event);
  }
  const end = () => {
    ended.abort();
    clearInterval(watching);
    drop();
  };

  /**
   * Reopens a broken channel, a few times, and takes up the app again when the receiver still
   * runs it. The receiver is lost when no try gets through.
   */
  const recover = async () => {
    recovering = true;
    for (const wait of timings.reconnect) {
      await sleep(wait, undefined, { signal: ended.signal }).catch(() => {});
      if (closed || !app) return;
      try {
        const opened = await open(timings.attempt, ended.signal);
        // Its status says whether the app still runs: the session is released when not.
        await ask({ type: "GET_STATUS" }, timings.attempt);
        if (closed) return;
        opened.send(app.transportId, NAMESPACE.connection, { type: "CONNECT", origin: {} });
        poll();
        recovering = false;
        return;
      } catch {
        if (closed) return;
        drop();
      }
    }
    finish({ type: "lost", failure: { kind: "unreachable" } });
  };

  function broken() {
    if (closed) return;
    drop();
    if (established && !recovering) void recover();
  }

  /** Runs a command on the load of `generation`, unless the receiver no longer has it. */
  const command = async (generation: number, body: object): Promise<void> => {
    if (closed) throw unreachable();
    const current = load;
    if (current?.generation !== generation || current.dropped) return;
    // A command during a load waits for the receiver to name its media.
    await current.answered;
    if (closed) throw unreachable();
    if (load === current && !current.dropped) await mediaRequest(current, body);
  };

  let leaving: Promise<void> | null = null;
  const disconnect = () =>
    (leaving ??= (async () => {
      if (closed) return;
      closed = true;
      if (channel && app) {
        // Stopping the app ends its media too; the media's own stop is for a receiver that is
        // slow about the app. Nothing waits longer than `close` for the receiver to confirm.
        if (load && load.mediaSessionId !== null) {
          try {
            channel.send(app.transportId, NAMESPACE.media, {
              type: "STOP",
              mediaSessionId: load.mediaSessionId,
              requestId: nextRequest++,
            });
          } catch {
            // The app's STOP can still fit when its media's STOP cannot.
          }
        }
        await ask({ type: "STOP", sessionId: app.sessionId }, timings.close).catch(() => {});
        channel?.send(app.transportId, NAMESPACE.connection, { type: "CLOSE" });
        channel?.send(PLATFORM, NAMESPACE.connection, { type: "CLOSE" });
      }
    })()
      // A receiver's identifiers can make even STOP too large. Closing must still settle.
      .catch(() => {})
      .finally(end));

  /** The LAUNCH, once sent: a connect given up meanwhile still has an app to stop. */
  let launching: Promise<unknown> = Promise.resolve();
  const started = () =>
    applications.find((application) => application.appId === MEDIA_RECEIVER) ?? null;
  let localAddress: string | null;
  try {
    const opened = await open(timings.request, signal);
    localAddress = opened.localAddress;
    const launch = request(
      PLATFORM,
      NAMESPACE.receiver,
      { type: "LAUNCH", appId: MEDIA_RECEIVER },
      timings.launch,
    );
    launching = launch;
    const answer = await unlessAborted(launch, signal);
    const application = started();
    if (answer.type !== "RECEIVER_STATUS" || !application?.sessionId || !application.transportId) {
      throw new ReceiverFailed({ kind: "unavailable", detail: describe(answer) });
    }
    app = { sessionId: application.sessionId, transportId: application.transportId };
    opened.send(app.transportId, NAMESPACE.connection, { type: "CONNECT", origin: {} });
  } catch (error) {
    closed = true;
    // The receiver may be starting the app still. It is stopped once the receiver names it, and
    // the channel stays just long enough to hear that.
    leaves(
      launching
        .catch(() => {})
        .then(() => {
          const sessionId = started()?.sessionId;
          if (sessionId) {
            channel?.send(PLATFORM, NAMESPACE.receiver, {
              type: "STOP",
              sessionId,
              requestId: nextRequest++,
            });
          }
        })
        .catch(() => {})
        .finally(end),
    );
    throw error;
  }

  established = true;
  watching = setInterval(() => {
    // A paused or finished media's position stands still.
    if (load && load.state !== "paused" && load.state !== "ended" && load.state !== "stopped") {
      if (load.mediaSessionId !== null && !load.dropped) poll();
    }
  }, timings.status);
  // Its status from here on is news, the volume first.
  void ask({ type: "GET_STATUS" }).catch(() => {});

  const connection: Connection = {
    receiver: endpoint.receiver,
    localAddress,
    // The first profile: H.264 with AAC, the pair Cast receivers are taken to decode. No
    // receiver has played it from this app yet, and what a given TV adds (HEVC, AC-3, E-AC-3)
    // is unread, so those convert until hardware proves otherwise.
    decoders: ["h264", "aac"],
    volume: true,

    async load(media: ReceiverMedia, loading: AbortSignal) {
      // A load that can't be sent leaves the one before it as the receiver's.
      if (closed || !app || !channel || recovering || loading.aborted) throw unreachable();
      const requestId = nextRequest++;
      const answer = unlessAborted(
        request(
          app.transportId,
          NAMESPACE.media,
          {
            type: "LOAD",
            sessionId: app.sessionId,
            media: {
              contentId: media.url,
              contentType: "application/x-mpegURL",
              streamType: media.live ? "LIVE" : "BUFFERED",
              hlsSegmentFormat: "ts",
              hlsVideoSegmentFormat: "mpeg2_ts",
              metadata: {
                // Generic: a title, a line under it and a picture.
                metadataType: 0,
                title: media.metadata.title,
                ...(media.metadata.subtitle === null ? {} : { subtitle: media.metadata.subtitle }),
                ...(media.metadata.artworkUrl === null
                  ? {}
                  : { images: [{ url: media.metadata.artworkUrl }] }),
              },
            },
            autoplay: !media.paused,
            // A channel carries no position: a receiver given none starts at the live edge, and
            // given 0 it may start at the oldest segment the playlist lists.
            ...(media.live ? {} : { currentTime: media.position }),
          },
          timings.load,
          requestId,
        ),
        loading,
      );
      const current: Load = {
        generation: media.generation,
        url: media.url,
        live: media.live,
        requestId,
        answered: answer.then(
          () => {},
          () => {},
        ),
        mediaSessionId: null,
        dropped: false,
        state: "loading",
        position: media.position,
        duration: null,
        shown: false,
        subtitles: media.subtitles,
        asked: null,
        textTrack: null,
        activeTracks: [],
      };
      load = current;
      const taken = await answer.catch((error: unknown) => {
        // The receiver may take it yet, after the service heard it didn't.
        current.dropped = true;
        throw error;
      });
      if (taken.type !== "MEDIA_STATUS") {
        throw new ReceiverFailed({ kind: "media", detail: describe(taken) });
      }
    },
    play: (generation) => command(generation, { type: "PLAY" }),
    pause: (generation) => command(generation, { type: "PAUSE" }),
    // Without a resume state the receiver keeps playing or stays paused, as it was.
    seek: (generation, position) => command(generation, { type: "SEEK", currentTime: position }),
    stop: (generation) => command(generation, { type: "STOP" }),
    async showSubtitles(generation, on) {
      if (closed) throw unreachable();
      if (load?.generation !== generation || load.dropped) return;
      // Before the receiver listed the tracks, this is what it is asked once it does.
      load.subtitles = on;
      await syncSubtitles(load);
    },
    async setVolume({ level, muted }) {
      if (closed) throw unreachable();
      // A level or a mute a request, as Cast's own senders send them.
      if (level !== undefined) {
        await ask({ type: "SET_VOLUME", volume: { level: Math.min(1, Math.max(0, level)) } });
      }
      if (muted !== undefined) await ask({ type: "SET_VOLUME", volume: { muted } });
    },
    disconnect,
  };
  return { connection, disconnect };
}
