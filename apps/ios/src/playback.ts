import type { LiveStream } from "@mrstreamer/core/provider";
import { createVideoPlayer, type VideoPlayer } from "expo-video";
import { appError, describeError, withoutLogin } from "./errors.ts";
import { rememberChannel } from "./storage.ts";
import { store, useStore } from "./store.ts";

// The app's one player and what it plays. Every surface shows this player and no other: Home's
// preview, Watch, Picture in Picture and AirPlay, and the accessory above the tabs controls it.
// Nothing opens a second stream for a preview. Playing another channel, stopping, disconnecting
// and a failure each let go of the stream, so the provider's connection closes.

/** What plays, as the screens name it. */
export interface Channel {
  readonly id: string;
  readonly title: string;
  /** Where the catalogue lists it: "Netherlands · News". */
  readonly place: string;
}

export type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" | "playing" | "paused"; readonly channel: Channel }
  | { readonly kind: "failed"; readonly channel: Channel; readonly error: string };

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

const state = store<Playback>({
  phase: { kind: "idle" },
  watch: false,
  pip: false,
  external: false,
  muted: true,
});
/** Seconds played of the current stream, apart from the rest so only the clock redraws. */
const clock = store(0);

export const usePlayback = () => useStore(state);

/** The channel that plays or is about to, for lists to mark; none once it failed or stopped. */
export function playingChannelId(phase: Phase): string | null {
  return phase.kind === "idle" || phase.kind === "failed" ? null : phase.channel.id;
}
export const usePlaybackClock = () => useStore(clock);

/** Opens a channel's stream; aborted when the viewer moves on first. */
type Open = (signal: AbortSignal) => Promise<LiveStream>;

let current: {
  readonly channel: Channel;
  readonly open: Open;
  /** What the stream's address carries that no failure the viewer sees may show. */
  readonly login: readonly string[];
} | null = null;
let attempt: AbortController | null = null;
/** Ends Picture in Picture; Watch registers it while its view can. */
let endPictureInPicture: (() => void) | null = null;

let created: VideoPlayer | null = null;
/** The player, made on first use. */
export function player(): VideoPlayer {
  if (created) return created;
  const made = createVideoPlayer(null);
  made.timeUpdateEventInterval = 1;
  made.muted = state.get().muted;
  made.addListener("statusChange", ({ status, error }) => {
    if (status !== "error" || !current) return;
    fail(error?.message ?? "The player stopped.");
  });
  made.addListener("playingChange", ({ isPlaying }) => {
    const { phase } = state.get();
    if (phase.kind === "idle" || phase.kind === "failed") return;
    state.set((s) => ({
      ...s,
      phase: {
        kind: isPlaying ? "playing" : phase.kind === "loading" ? "loading" : "paused",
        channel: phase.channel,
      },
    }));
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
  attempt?.abort();
  attempt = null;
  const made = player();
  made.pause();
  void made.replaceAsync(null);
  clock.set(0);
}

/** Shows why the stream failed: the player's message, which can quote its address, without it. */
function fail(message: string) {
  if (!current) return;
  const { channel, login } = current;
  release();
  const error = withoutLogin(message, login);
  state.set((s) => ({ ...s, phase: { kind: "failed", channel, error } }));
}

/**
 * Plays `channel`, in Watch when `watch`, else in Home's preview. `login` is what the stream's
 * address carries, kept out of the failures shown. Whatever played before stops first; a slower
 * earlier call that finishes later changes nothing.
 */
export async function play(
  channel: Channel,
  open: Open,
  { watch, login }: { readonly watch: boolean; readonly login: readonly string[] },
) {
  release();
  const controller = new AbortController();
  attempt = controller;
  current = { channel, open, login };
  state.set((s) => {
    const muted = watch || s.watch ? false : s.muted;
    player().muted = muted;
    return { ...s, phase: { kind: "loading", channel }, watch: watch || s.watch, muted };
  });
  rememberChannel(channel.id);
  try {
    const stream = await open(controller.signal);
    if (controller.signal.aborted) return;
    await player().replaceAsync({
      uri: stream.url,
      ...(stream.headers ? { headers: { ...stream.headers } } : {}),
      contentType: stream.format === "hls" ? "hls" : "auto",
    });
    if (controller.signal.aborted) return;
    player().play();
  } catch (cause) {
    if (!controller.signal.aborted) fail(describeError(appError(cause)));
  }
}

/** Plays the failed or stopped channel again. */
export function retry() {
  if (current) {
    const { channel, open, login } = current;
    void play(channel, open, { watch: state.get().watch, login });
  }
}

/**
 * Stops playing and closes Watch, Picture in Picture and the accessory. What plays next on Home
 * starts without sound again.
 */
export function stop() {
  current = null;
  release();
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

export function setMuted(muted: boolean) {
  player().muted = muted;
  state.set((s) => ({ ...s, muted }));
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
