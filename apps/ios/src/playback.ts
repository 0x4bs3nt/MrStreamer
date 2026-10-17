import { appFailure, type AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import {
  createVideoPlayer,
  type AudioTrack,
  type SubtitleTrack,
  type VideoPlayer,
} from "expo-video";
import { appError, describeError, withoutLogin } from "./errors.ts";
import { store, useStore, type Store } from "./store.ts";
import { openFormat, type FormatSession } from "./title-formats.ts";

// The app's one player and what it plays: a live channel, or a movie or an episode. Every surface
// shows this player and no other: Home's preview, Watch, Picture in Picture and AirPlay, and the
// accessory above the tabs controls it. Nothing opens a second stream for a preview. Playing
// something else, stopping, removing its subscription and a failure each let go of the stream,
// so the provider's connection closes. A download of the same subscription gives the connection
// back before a stream opens (`onReclaim`); a downloaded copy plays from the phone and takes none.
//
// A movie or episode in a file AVPlayer can't open, such as Matroska, plays through a format
// session (`title-formats.ts`): the file is read natively, over one request to the provider at a
// time, and this player gets it as HLS from 127.0.0.1. Nothing of a new play reaches the
// provider until every earlier session's request has ended.
//
// A title starts where it is asked to, has a length to seek in, and tells whoever played it how
// far it got: every minute while it plays, when it pauses, and when it stops, fails or gives way
// to something else; and once more when it plays to its end.

/** What plays, as the screens name it. */
export interface Playing {
  /** A channel's, movie's or episode's `ownedKey`. */
  readonly id: string;
  /**
   * The subscription whose provider streams it; null for a downloaded copy, which plays from the
   * phone and holds no provider's connection.
   */
  readonly subscriptionId: string | null;
  readonly title: string;
  /** Where the catalogue lists a channel, "Netherlands · News"; a title's line, "S1 E2 · Name". */
  readonly place: string;
  /** A live channel plays on; a title has a length. */
  readonly live: boolean;
  /** An episode with one after it, which Watch offers. */
  readonly next: boolean;
  /** A title with other versions to try when this one fails. */
  readonly versions: boolean;
}

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" | "playing" | "paused"; readonly item: Playing }
  | { readonly kind: "failed"; readonly item: Playing; readonly error: string };

export interface Playback {
  readonly phase: Phase;
  /** Watch shows the player full screen. */
  readonly watch: boolean;
  /** Picture in Picture shows it, started from Watch. */
  readonly pip: boolean;
  /** It plays on an AirPlay receiver. */
  readonly external: boolean;
  /** Home's preview plays without sound until Watch opens or the viewer unmutes it. */
  readonly muted: boolean;
  /**
   * The subscriptions whose provider connection a format session that let go of its stream still
   * holds, until its request ended. The session streaming now isn't counted: the phase says so.
   */
  readonly closing: readonly string[];
}

/** Where a stream is, and its file type as whoever opened it knows it. */
export interface Source {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** "m3u8" for HLS; a title's listed container, or a copy's. */
  readonly container: string;
}

/**
 * The file types a format session plays: Matroska, which AVPlayer can't open. Everything else,
 * live streams always, goes to AVPlayer as it is, as it always did.
 */
const THROUGH_SESSION: ReadonlySet<string> = new Set(["mkv"]);

/** Opens what plays; aborted when the viewer moves on first. */
type Open = (signal: AbortSignal) => Promise<Source>;

export interface PlayOptions {
  /** In Watch, else in Home's preview. */
  readonly watch: boolean;
  /** What the stream's address carries that no failure the viewer sees may show. */
  readonly login: readonly string[];
  /** Seconds to start a title from. */
  readonly from?: number;
  /** Told how far a title got, in seconds of its length. */
  readonly progress?: (position: number, duration: number) => void;
  /** A title played to its end. */
  readonly ended?: () => void;
  /** Whether it got as far as playing, said once: true when it first plays, false if it fails. */
  readonly outcome?: (played: boolean) => void;
  /** Plays the episode after this one. */
  readonly next?: () => void;
  /** Shows the title's other versions, after this one failed. */
  readonly versions?: () => void;
}

const state = store<Playback>({
  phase: { kind: "idle" },
  watch: false,
  pip: false,
  external: false,
  muted: true,
  closing: [],
});
/** Seconds played of the current stream, apart from the rest so only the clock redraws. */
const clock = store(0);
/** A title's length in seconds, once known; 0 for live and before it loaded. */
const length = store(0);

export const usePlayback = () => useStore(state);
/** Read-only, for telemetry, which follows the player without a screen. */
export const playbackState: Pick<Store<Playback>, "get" | "subscribe"> = state;
export const playbackClock: Pick<Store<number>, "get" | "subscribe"> = clock;
export const usePlaybackClock = () => useStore(clock);
export const usePlaybackLength = () => useStore(length);

/**
 * The channel that plays or is about to, for channel lists to mark; none once it failed or
 * stopped, or while a title plays. A movie's key can read like a channel's of the same
 * subscription, so a title never counts.
 */
export function playingChannel(phase: Phase): string | null {
  return phase.kind === "idle" || phase.kind === "failed" || !phase.item.live
    ? null
    : phase.item.id;
}

/**
 * What streams or is about to, a channel or a title; none once it failed or stopped. A new play
 * is a new item, even of the same key, so a return from Picture in Picture can tell it apart.
 */
export function playingItem(phase: Phase): Playing | null {
  return phase.kind === "idle" || phase.kind === "failed" ? null : phase.item;
}

/**
 * A request of the viewer's that waits before it plays or opens anything, as a series' resume
 * waits for its details, or Next episode for how the episodes stand. It stands until the viewer
 * asks for something newer: any other request, any channel or title played, Stop, removing a
 * subscription or another screen. Whatever waited checks `stands()` before acting, so a late
 * answer never replaces what the viewer chose since, nor opens Watch over Connect.
 */
export interface Request {
  stands(): boolean;
}

/** Rises with every request, play, Stop and move to another screen: only the latest stands. */
let requests = 0;
/** The screen the viewer is on, as navigation reports it. */
let screen = "";

/** Starts a request that has to wait, replacing any waiting before it. */
export function request(): Request {
  const mine = ++requests;
  return { stands: () => mine === requests };
}

/**
 * Navigation reports the screen the viewer is on. Leaving it ends any waiting request for good,
 * coming back too; the same screen reported again changes nothing.
 */
export function onScreen(path: string) {
  if (path === screen) return;
  screen = path;
  requests++;
}

/** How often a playing title says how far it got. */
const CHECKPOINT_MS = 60_000;

let current: {
  readonly item: Playing;
  readonly open: Open;
  readonly options: PlayOptions;
  /** Seconds to seek to once the title is ready; null once done. */
  seek: number | null;
  /** Whether the stream got as far as playing, so a position means something. */
  loaded: boolean;
  /** Where a title was when it was let go of, for Try again. */
  stoppedAt: number | null;
} | null = null;
let attempt: AbortController | null = null;
/** The format session the player streams from now, how to stop it, and when it has. */
let format: {
  readonly session: FormatSession;
  readonly close: () => void;
  readonly closed: Promise<void>;
} | null = null;
/** Every format session whose provider request hasn't ended, with its subscription. */
const held = new Map<Promise<void>, string | null>();

/** Says which subscriptions sessions that let go of their stream still hold. */
function noteClosing() {
  const holding = [
    ...new Set(
      [...held]
        .filter(([closed, id]) => id !== null && closed !== format?.closed)
        .map(([, id]) => id!),
    ),
  ];
  const now = state.get().closing;
  if (holding.length !== now.length || holding.some((id, at) => id !== now[at])) {
    state.set((s) => ({ ...s, closing: holding }));
  }
}

/** Keeps `closed` among the sessions holding a connection until it resolves. */
function hold(closed: Promise<void>, subscriptionId: string | null) {
  held.set(closed, subscriptionId);
  noteClosing();
  void closed.finally(() => {
    held.delete(closed);
    noteClosing();
  });
}
let checkpoint: ReturnType<typeof setInterval> | null = null;
/** Told each failure's category, never its message; telemetry registers it. */
let failed: ((failure: AnalyticsFailure) => void) | null = null;
/** Ends Picture in Picture; Watch registers it while its view can. */
let endPictureInPicture: (() => void) | null = null;
/**
 * Takes a subscription's connection back from a download before a stream of it opens, so the
 * provider never sees both; downloads.ts registers it. Resolves once the download's request ended
 * and the provider had a moment to free it; rejects when it didn't end, and the stream fails.
 */
let reclaim: ((subscriptionId: string) => Promise<void>) | null = null;

/** Tells a title's owner how far it got, if it got anywhere. */
function report() {
  if (!current?.loaded || current.item.live) return;
  const made = player();
  const duration = made.duration;
  if (duration > 0 && Number.isFinite(duration)) {
    current.options.progress?.(Math.min(made.currentTime, duration), duration);
  }
}

let created: VideoPlayer | null = null;
/** The player, made on first use. */
export function player(): VideoPlayer {
  if (created) return created;
  const made = createVideoPlayer(null);
  made.timeUpdateEventInterval = 1;
  made.muted = state.get().muted;
  made.addListener("statusChange", ({ status, error }) => {
    if (!current) return;
    if (status === "error") {
      // A format session says why it stopped serving; AVPlayer's failures come without a type,
      // and on the fixtures they were formats it can't play.
      const stopped = format?.session.failure();
      if (!stopped) return fail(error?.message ?? "The player stopped.", "unsupported");
      const failure = { kind: "stream", failure: stopped } as const;
      return fail(describeError(failure), appFailure(failure));
    }
    if (status === "readyToPlay" && current.seek !== null) {
      const from = current.seek;
      current.seek = null;
      if (from > 0) made.currentTime = from;
    }
  });
  made.addListener("sourceLoad", ({ duration }) => {
    if (current && !current.item.live) length.set(Number.isFinite(duration) ? duration : 0);
  });
  made.addListener("playingChange", ({ isPlaying }) => {
    const { phase } = state.get();
    if (phase.kind === "idle" || phase.kind === "failed") return;
    if (isPlaying && current && !current.loaded) {
      current.loaded = true;
      current.options.outcome?.(true);
    }
    // Only playing moves a title on; a checkpoint while paused would make it look watched later.
    if (checkpoint) clearInterval(checkpoint);
    checkpoint = isPlaying ? setInterval(report, CHECKPOINT_MS) : null;
    if (!isPlaying && phase.kind === "playing") report();
    state.set((s) => ({
      ...s,
      phase: {
        kind: isPlaying ? "playing" : phase.kind === "loading" ? "loading" : "paused",
        item: phase.item,
      },
    }));
  });
  made.addListener("playToEnd", () => {
    if (!current || current.item.live) return;
    report();
    current.options.ended?.();
  });
  made.addListener("timeUpdate", ({ currentTime }) => clock.set(currentTime));
  made.addListener("isExternalPlaybackActiveChange", ({ isExternalPlaybackActive }) => {
    // An AirPlay receiver keeps playing while the app is in the background.
    made.staysActiveInBackground = isExternalPlaybackActive;
    // Back on the phone with Watch and Picture in Picture closed, Home's preview is silent again.
    const { watch, pip } = state.get();
    const silent = !isExternalPlaybackActive && !watch && !pip;
    if (silent) made.muted = true;
    state.set((s) => ({ ...s, external: isExternalPlaybackActive, muted: silent || s.muted }));
  });
  created = made;
  return made;
}

/** Lets go of the stream: the player keeps nothing that holds the provider's connection. */
function release() {
  report();
  if (current?.loaded && !current.item.live) current.stoppedAt = player().currentTime;
  if (checkpoint) clearInterval(checkpoint);
  checkpoint = null;
  attempt?.abort();
  attempt = null;
  const made = player();
  made.pause();
  void made.replaceAsync(null);
  // Its request ends on its own time; `held` keeps the next play from the provider until then.
  format?.close();
  format = null;
  noteClosing();
  clock.set(0);
  length.set(0);
}

/**
 * Shows why the stream failed: the player's message, which can quote its address, without it.
 * The first failure stands; the player may report another as the stream is let go of.
 */
function fail(message: string, failure: AnalyticsFailure) {
  if (!current || state.get().phase.kind === "failed") return;
  failed?.(failure);
  const { item, options } = current;
  release();
  if (!current.loaded) options.outcome?.(false);
  current.loaded = false;
  const error = withoutLogin(message, options.login);
  state.set((s) => ({ ...s, phase: { kind: "failed", item, error } }));
}

/**
 * Plays `item`, in Watch when `options.watch`, else in Home's preview. Whatever played before
 * stops first, saying how far it got; a slower earlier call that finishes later changes nothing.
 */
export async function play(item: Playing, open: Open, options: PlayOptions) {
  requests++;
  release();
  const controller = new AbortController();
  attempt = controller;
  current = { item, open, options, seek: options.from ?? null, loaded: false, stoppedAt: null };
  state.set((s) => {
    const muted = options.watch || s.watch ? false : s.muted;
    player().muted = muted;
    return {
      ...s,
      phase: { kind: "loading", item },
      watch: options.watch || s.watch,
      muted,
    };
  });
  try {
    await Promise.all(held.keys());
    if (controller.signal.aborted) return;
    if (item.subscriptionId !== null) await reclaim?.(item.subscriptionId);
    if (controller.signal.aborted) return;
    const source = await open(controller.signal);
    if (controller.signal.aborted) return;
    let playable = {
      uri: source.url,
      ...(source.headers ? { headers: { ...source.headers } } : {}),
      contentType: source.container === "m3u8" ? ("hls" as const) : ("auto" as const),
    };
    if (!item.live && THROUGH_SESSION.has(source.container.toLowerCase())) {
      const start = options.from ?? 0;
      const opening = openFormat(source.url, source.headers, start, controller.signal);
      hold(opening.closed, item.subscriptionId);
      const opened = await opening.opened;
      if (controller.signal.aborted) return opening.close();
      if (opened.kind === "session") {
        const { session } = opened;
        format = { session, close: opening.close, closed: opening.closed };
        noteClosing();
        // AVPlayer may only wait on the request the session refused, so its own word ends the
        // stream; a session already let go of says nothing to what plays now.
        void session.failed.then((failure) => {
          if (format?.session !== session) return;
          const error = { kind: "stream", failure } as const;
          fail(describeError(error), appFailure(error));
        });
        playable = { uri: opened.session.playlist, contentType: "hls" };
        // The stream starts there itself, so AVPlayer reads nothing before it.
        if (current) current.seek = null;
      } else {
        // AVPlayer opens it itself, once the session's request ended.
        await opening.closed;
        if (controller.signal.aborted) return;
      }
    }
    await player().replaceAsync(playable);
    if (controller.signal.aborted) return;
    player().play();
  } catch (cause) {
    if (controller.signal.aborted) return;
    const error = appError(cause);
    fail(describeError(error), appFailure(error));
  }
}

/** Plays what failed or stopped again, a title from where it got to. */
export function retry() {
  if (!current) return;
  const { item, open, options, stoppedAt } = current;
  const from = stoppedAt ?? options.from;
  void play(item, open, {
    ...options,
    watch: state.get().watch,
    ...(from === undefined ? {} : { from }),
  });
}

/**
 * Stops playing and closes Watch, Picture in Picture and the accessory. What plays next on Home
 * starts without sound again.
 */
export function stop() {
  requests++;
  release();
  current = null;
  endPictureInPicture?.();
  player().muted = true;
  state.set((s) => ({ ...s, phase: { kind: "idle" }, watch: false, pip: false, muted: true }));
}

export function togglePause() {
  const { phase } = state.get();
  if (phase.kind === "playing") player().pause();
  else if (phase.kind === "paused") player().play();
}

export function seekBy(seconds: number) {
  player().seekBy(seconds);
}

/** Moves a title to `seconds` from its start. */
export function seekTo(seconds: number) {
  player().currentTime = Math.max(0, seconds);
  clock.set(Math.max(0, seconds));
}

export function setMuted(muted: boolean) {
  player().muted = muted;
  state.set((s) => ({ ...s, muted }));
}

/** A sound or subtitle track the player found in what plays, to choose in Watch. */
export interface TrackChoice {
  readonly label: string;
  readonly selected: boolean;
  readonly choose: () => void;
}

/** What names a sound or subtitle track. */
type Track = Pick<AudioTrack | SubtitleTrack, "id" | "language" | "label" | "name">;

/**
 * A file can hold tracks of one language, such as English stereo and English surround. On iOS the
 * player's `id` (the track's place in what plays now, from the expo-video patch) tells them apart,
 * and the track's own name, where the file gives one, does too.
 */
function sameTrack(a: Track | null, b: Track) {
  return (
    a !== null &&
    a.id === b.id &&
    a.language === b.language &&
    a.label === b.label &&
    a.name === b.name
  );
}

/**
 * Each track with its label, or its language: tracks that share one add their own name, or else
 * their number among those that share it.
 */
function labelled<T extends Track>(tracks: readonly T[], fallback: string) {
  const labels = tracks.map((track) => track.label || track.language || fallback);
  return tracks.map((track, i) => {
    const label = labels[i] ?? fallback;
    if (labels.indexOf(label) === labels.lastIndexOf(label)) return { track, label };
    const number = labels.slice(0, i + 1).filter((other) => other === label).length;
    return { track, label: `${label} · ${track.name || number}` };
  });
}

/**
 * The sound tracks, or the subtitle tracks with Off first, AVPlayer exposes for what plays now.
 * Subtitles it doesn't draw itself, such as pictures, aren't among them. Choosing one hands the
 * player back the very track it listed.
 */
export function trackChoices(of: "audio" | "subtitles"): readonly TrackChoice[] {
  const made = player();
  if (of === "audio") {
    const current = made.audioTrack;
    return labelled(made.availableAudioTracks, "Sound").map(({ track, label }) => ({
      label,
      selected: sameTrack(current, track),
      choose: () => {
        made.audioTrack = track;
      },
    }));
  }
  const current = made.subtitleTrack;
  return [
    {
      label: "Off",
      selected: current === null,
      choose: () => {
        made.subtitleTrack = null;
      },
    },
    ...labelled(made.availableSubtitleTracks, "Subtitles").map(({ track, label }) => ({
      label,
      selected: sameTrack(current, track),
      choose: () => {
        made.subtitleTrack = track;
      },
    })),
  ];
}

/** Plays the episode after the one playing. */
export function playNext() {
  current?.options.next?.();
}

/** Shows the other versions of the title that failed. */
export function showVersions() {
  current?.options.versions?.();
}

/** Shows the player full screen, bringing it back from Picture in Picture. */
export function openWatch() {
  player().muted = false;
  if (state.get().pip) endPictureInPicture?.();
  state.set((s) => ({ ...s, watch: true, muted: false }));
}

/** Back to the tabs. With nothing else showing it, Home's preview plays on without sound. */
export function closeWatch() {
  const { pip, external } = state.get();
  const muted = !pip && !external;
  player().muted = muted;
  state.set((s) => ({ ...s, watch: false, muted }));
}

/**
 * Watch reports Picture in Picture starting and ending. It leaves Watch for the tabs, where the
 * accessory controls it; once it ends, Home's preview shows the player again.
 */
export function pictureInPicture(active: boolean) {
  if (active) {
    state.set((s) => ({ ...s, pip: true, watch: false }));
    return;
  }
  const { watch } = state.get();
  if (!watch) player().muted = true;
  state.set((s) => ({ ...s, pip: false, muted: s.watch ? s.muted : true }));
}

/**
 * The viewer brought Picture in Picture back to the app rather than closing it: Watch shows the
 * player again, with its sound, before Picture in Picture reports that it ended. Returns what
 * Watch shows, or null when nothing streams in Picture in Picture any more (it stopped or failed
 * first), so there is nothing to return to.
 */
export function restoreFromPictureInPicture(): Playing | null {
  const { phase, pip } = state.get();
  const item = playingItem(phase);
  if (!pip || item === null) return null;
  player().muted = false;
  state.set((s) => ({ ...s, watch: true, muted: false }));
  return item;
}

export function onPlaybackFailure(listener: ((failure: AnalyticsFailure) => void) | null) {
  failed = listener;
}

export function onEndPictureInPicture(end: (() => void) | null) {
  endPictureInPicture = end;
}

export function onReclaim(take: ((subscriptionId: string) => Promise<void>) | null) {
  reclaim = take;
}
