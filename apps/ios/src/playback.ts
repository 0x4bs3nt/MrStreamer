import { createVideoPlayer, type VideoPlayer } from "expo-video";
import { appError, describeError, withoutLogin } from "./errors.ts";
import { store, useStore } from "./store.ts";

// The app's one player and what it plays: a live channel, or a movie or an episode. Every surface
// shows this player and no other: Home's preview, Watch, Picture in Picture and AirPlay, and the
// accessory above the tabs controls it. Nothing opens a second stream for a preview. Playing
// something else, stopping, disconnecting and a failure each let go of the stream, so the
// provider's connection closes.
//
// A title starts where it is asked to, has a length to seek in, and tells whoever played it how
// far it got: every minute while it plays, when it pauses, and when it stops, fails or gives way
// to something else; and once more when it plays to its end.

/** What plays, as the screens name it. */
export interface Playing {
  /** A channel's id, or a movie's or episode's version as `ownedKey` writes it. */
  readonly id: string;
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
}

/** Where a stream is, and whether it is HLS. */
export interface Source {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly hls: boolean;
}

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
});
/** Seconds played of the current stream, apart from the rest so only the clock redraws. */
const clock = store(0);
/** A title's length in seconds, once known; 0 for live and before it loaded. */
const length = store(0);

export const usePlayback = () => useStore(state);
export const usePlaybackClock = () => useStore(clock);
export const usePlaybackLength = () => useStore(length);

/** What plays or is about to, for lists to mark; none once it failed or stopped. */
export function playingId(phase: Phase): string | null {
  return phase.kind === "idle" || phase.kind === "failed" ? null : phase.item.id;
}

/**
 * A request of the viewer's that waits before it plays or opens anything, as a series' resume
 * waits for its details, or Next episode for how the episodes stand. It stands until the viewer
 * asks for something newer: any other request, any channel or title played, Stop (which
 * Disconnect calls) or another screen. Whatever waited checks `stands()` before acting, so a late
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
let checkpoint: ReturnType<typeof setInterval> | null = null;
/** Ends Picture in Picture; Watch registers it while its view can. */
let endPictureInPicture: (() => void) | null = null;

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
    if (status === "error") return fail(error?.message ?? "The player stopped.");
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
  clock.set(0);
  length.set(0);
}

/** Shows why the stream failed: the player's message, which can quote its address, without it. */
function fail(message: string) {
  if (!current) return;
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
    const source = await open(controller.signal);
    if (controller.signal.aborted) return;
    await player().replaceAsync({
      uri: source.url,
      ...(source.headers ? { headers: { ...source.headers } } : {}),
      contentType: source.hls ? "hls" : "auto",
    });
    if (controller.signal.aborted) return;
    player().play();
  } catch (cause) {
    if (!controller.signal.aborted) fail(describeError(appError(cause)));
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

/**
 * The sound tracks, or the subtitle tracks with Off first, AVPlayer exposes for what plays now.
 * Subtitles it doesn't draw itself, such as pictures, aren't among them.
 */
export function trackChoices(of: "audio" | "subtitles"): readonly TrackChoice[] {
  const made = player();
  if (of === "audio") {
    const current = made.audioTrack;
    return made.availableAudioTracks.map((track) => ({
      label: track.label || track.language || "Sound",
      selected: current?.id === track.id && current?.language === track.language,
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
    ...made.availableSubtitleTracks.map((track) => ({
      label: track.label || track.language || "Subtitles",
      selected: current?.id === track.id && current?.language === track.language,
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

export function onEndPictureInPicture(end: (() => void) | null) {
  endPictureInPicture = end;
}
