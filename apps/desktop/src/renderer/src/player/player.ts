import { appDiagnostic, streamDiagnostic } from "@mrstreamer/contracts/analytics";
import {
  PlaybackObservation,
  playbackFailure,
  streamFailure,
  engineDiagnostic,
} from "./analytics.ts";
// The player controller: owns the one video element, the open stream session and the playback state.
//
// Every `play` call starts a new selection. Anything that resolves for an older selection is
// dropped, so a slow channel can never replace the one the viewer picked after it.
//
// The main process picks which of a channel's streams plays: the quality chosen for it, else
// Automatic, which may pass a stream that doesn't start. Once one plays, the controller asks which.
//
// A channel's sound and subtitle tracks come from its program table once the stream starts, and
// again whenever the main process says they changed, as when captions begin in its pictures.
// Another sound track opens the stream again with it; subtitles are decoded here from the
// stream's private data, timed on the element's clock, and shown over the picture.
//
// An HLS stream's tracks come from its engine instead, which reads them from the stream's
// playlists and says so again whenever they change: its sound switches where it plays, and the
// lines of its subtitles and captions go on the element's subtitle track as they are read. The
// same choices and the same remembered languages apply to both.
//
// The video element outlives every view: Home's backdrop, the guide's preview and Watch each show
// it in turn (see Picture.tsx), so moving between them never reopens the stream. Only Watch plays
// sound unless the viewer unmutes elsewhere; `audible` is that choice, `muted` the viewer's own.
//
// With a receiver on the network connected (see output.ts), a channel the viewer chooses plays
// there: the main process opens it for the receiver, and the state here is what the receiver
// confirmed. Nothing previews meanwhile, as a preview would take the provider's connection from
// the receiver. A channel has no pause and no subtitles there; one the receiver itself holds
// paused or buffering, as after Pause on the TV's remote, says so here. What the receiver says is
// shown as it says it, and only its word that the channel plays makes it one that started: a
// receiver can hold a channel paused or buffering before it ever got its stream.
//
// A stream that breaks is tried again a few times, here and on a receiver alike, and those tries
// are the channel's until it has played for a while: one that comes back for a moment and breaks
// off again uses them up and fails, rather than reconnecting for ever. Choosing the channel
// again, or Retry, starts afresh. What a failure says is the kind of thing that went wrong and
// the provider's status, never the words an engine or the provider used for it.
//
// A programme the provider keeps in its catch-up archive plays the same way, as the channel's
// stream, from the programme's start (`playArchive`). It is a stream that ends: at the
// programme's end the channel stops, as after Stop. A reconnect, or another sound track, opens
// the recording again where it got to, or on the minute before where the provider counts in
// minutes; what plays is counted from where the provider's recording starts. Playing or switching to a channel plays it live; going back to Watch on the
// one that plays keeps the recording, as it keeps a live stream. Catch-up plays on this computer
// only.
import { createStore, useStore } from "zustand";
import type { AppError } from "@mrstreamer/contracts/errors";
import type { Programme } from "@mrstreamer/contracts/guide";
import type {
  OutputFailure,
  OutputStatus,
  RemoteMedia,
  RemoteState,
} from "@mrstreamer/contracts/output";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedId, sameOwned } from "@mrstreamer/contracts/subscription";
import {
  DEFAULT_SUBTITLE_LOOK,
  ORIGINAL_SOUND,
  type Preferences,
} from "@mrstreamer/contracts/preferences";
import type {
  ChannelTracks,
  LivePlaying,
  StreamFailure,
  StreamSession,
  SubtitleTrack,
} from "@mrstreamer/contracts/playback";
import { channelSubtitle } from "@mrstreamer/core/ondemand/tracks";
import { subtitleDecoder, type SubtitleDecoder } from "@mrstreamer/core/subtitles/decoder";
import { teletextPagePresent } from "@mrstreamer/core/subtitles/teletext";
import { dvbPagePresent } from "@mrstreamer/core/subtitles/dvb";
import type { Cue } from "@mrstreamer/core/subtitles/webvtt";
import { appError } from "../lib/errors.ts";
import { call, listen } from "../lib/ipc.ts";
import { decoders } from "./decoders.ts";
import {
  createEngine,
  isEngineError,
  nativeEngine,
  type Engine,
  type EngineError,
  type EngineName,
  type StreamInfo,
} from "./engine.ts";
import type { SoundChoice } from "./hls-tracks.ts";
import { outputs } from "./output.ts";
import {
  addTextCue,
  clearSubtitles,
  forgetShownSubtitles,
  setSubtitleDelay,
  setSubtitleLook,
  subtitlePresenter,
} from "./subtitles.ts";

/** Waits before each reconnect attempt after a stream breaks. Its length is the attempt limit. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000];
/**
 * How long a channel has to play before a break gets every reconnect again. A channel that breaks
 * off sooner keeps the reconnects it has left. Time paused or waiting for data isn't time played.
 */
export const STABLE_PLAYBACK_MS = 30_000;
/**
 * How long zapping waits for the next key press before it opens a stream. Flicking through
 * channels shows each one at once but only tunes the one the viewer stops on, which matters on
 * subscriptions that allow a single connection.
 */
const ZAP_SETTLE_MS = 350;
const VOLUME_SAVE_DELAY_MS = 400;

export type PlaybackProblem =
  /** The provider has no stream for the channel right now: it answered 404 or 410. */
  | { readonly kind: "unavailable"; readonly status: number }
  /**
   * The provider refused, with 401, 403, 429 or the like. The status is all that is known: it
   * doesn't say whether another device has the connection, the login stopped working or the
   * channel isn't offered here.
   */
  | { readonly kind: "refused"; readonly status: number }
  /** The stream arrived and couldn't be played or converted. Nothing reliable says why. */
  | { readonly kind: "unsupported" }
  /**
   * No data arrived, or it stopped arriving. `unanswered` when the main process saw that itself:
   * the provider didn't answer, sent nothing or broke off. Otherwise only the player noticed that
   * nothing plays, which data without a picture in it looks like too.
   */
  | { readonly kind: "network"; readonly unanswered: boolean }
  | { readonly kind: "provider-error"; readonly status: number }
  /** The session could not be opened at all. */
  | { readonly kind: "app"; readonly error: AppError }
  /**
   * A receiver on the network doesn't play it. `lost` when the receiver itself is gone, and has
   * to be connected to again.
   */
  | { readonly kind: "receiver"; readonly failure: OutputFailure; readonly lost: boolean };

/** What a receiver says of a channel it started. A channel has no end. */
type ReceiverState = Exclude<RemoteState, "ended">;

/** What the selected channel went through since the viewer chose it. */
interface Recovery {
  /** It played, for however short a time. */
  readonly played: boolean;
  /** The reconnects made since it was chosen, or since it last played for `STABLE_PLAYBACK_MS`. */
  readonly reconnects: number;
  /** How often one of those brought it back only for it to break off again. */
  readonly relapses: number;
}

type PlayerPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "tuning"; readonly since: number }
  | { readonly kind: "playing"; readonly engine: EngineName }
  /**
   * A receiver on the network has it. `state` is its last word on it: it plays, is paused there,
   * as from the TV's remote, or waits for the stream, which it may do before it ever played.
   */
  | { readonly kind: "playing"; readonly engine: "receiver"; readonly state: ReceiverState }
  /**
   * The stream broke and reconnect `attempt` of `of` is next: `until` is when it starts, in epoch
   * ms, and null once it is under way.
   */
  | {
      readonly kind: "reconnecting";
      readonly attempt: number;
      readonly of: number;
      readonly until: number | null;
    }
  /** `recovery` is what the channel went through before it failed, `at` when it did, in epoch ms. */
  | {
      readonly kind: "failed";
      readonly problem: PlaybackProblem;
      readonly recovery: Recovery;
      readonly at: number;
    };

export interface PlayerState {
  readonly channel: LiveChannel | null;
  /** The programme of `channel` that plays from the provider's catch-up archive; null for live. */
  readonly archive: Programme | null;
  readonly phase: PlayerPhase;
  /** The channel that played before the current one. Back returns to it, like a TV remote. */
  readonly previous: LiveChannel | null;
  readonly volume: number;
  readonly muted: boolean;
  /** Whether the view on screen plays sound: Watch does, previews only once unmuted. */
  readonly audible: boolean;
  /** The viewer pressed Stop, so previews don't start the stream again on their own. */
  readonly stopped: boolean;
  /** Sound and available subtitle choices. HLS keeps its declared languages after first proof. */
  readonly tracks: ChannelTracks | null;
  /** The sound track chosen, by id; null plays the channel's own choice. */
  readonly audioId: number | null;
  /** The subtitles on screen, or null for none. */
  readonly subtitle: SubtitleTrack | null;
  /**
   * The chosen subtitles of an HLS stream are still loading: its engine hasn't read them where
   * the stream plays. Whether they say anything there doesn't matter, and subtitles that can't be
   * had turn off without stopping the picture.
   */
  readonly subtitleLoading: boolean;
  /** First subtitle proof in this channel session, for the visible Watch view to announce. */
  readonly subtitleAvailability: { readonly played: number; readonly selected: boolean } | null;
  /**
   * Which of the channel's streams plays, once it started, and those that failed first. A channel
   * that failed here keeps what its last try got to: the streams the provider didn't deliver, and
   * the one that arrived and didn't play.
   */
  readonly stream: LivePlaying | null;
  /** The picture has stood still for a few seconds though the channel should play. */
  readonly waiting: boolean;
  /**
   * Automatic played another of the channel's streams because the first didn't start. Kept until
   * the channel changes or another quality is chosen.
   */
  readonly fellBack: { readonly from: string; readonly to: string } | null;
}

const store = createStore<PlayerState>(() => ({
  channel: null,
  archive: null,
  phase: { kind: "idle" },
  previous: null,
  volume: 1,
  muted: false,
  audible: false,
  stopped: false,
  tracks: null,
  audioId: null,
  subtitle: null,
  subtitleLoading: false,
  subtitleAvailability: null,
  stream: null,
  waiting: false,
  fellBack: null,
}));

/** Reads player state in a component. */
export function usePlayer<T>(selector: (state: PlayerState) => T): T {
  return useStore(store, selector);
}

/**
 * What the receiver last said of the channel it has, for the views to say. Null while the channel
 * plays here, and until the receiver says more of it than that it loads.
 */
export function receiverState(phase: PlayerState["phase"]): ReceiverState | null {
  return phase.kind === "playing" && phase.engine === "receiver" ? phase.state : null;
}

const observation = new PlaybackObservation("live");
let explicitlySelected: LiveChannel | null = null;
function selectForWatching(channel: LiveChannel): void {
  if (!observation.hasRun() || !sameOwned(explicitlySelected, channel)) {
    if (explicitlySelected && !sameOwned(explicitlySelected, channel))
      void call("analytics.action", "channel_changed").catch(() => {});
    explicitlySelected = channel;
    observation.begin();
  }
}
const video = document.createElement("video");
video.playsInline = true;
video.className = "size-full";
let selection = 0;
/**
 * The current selection is a preview: a failure leaves it stopped instead of reconnecting, so a
 * connection another device holds is not fought over.
 */
let quiet = false;
/**
 * A programme playing from the archive, and where in it the next stream opens, in whole epoch ms:
 * its start, then as far as the streams before played.
 */
interface Recording {
  readonly programme: Programme;
  at: number;
}
/** The recording that plays; null while the channel plays live. */
let archived: Recording | null = null;
/**
 * The open stream, and for a recording, which, from where the provider's recording starts, and
 * for how long it plays.
 */
let current: {
  readonly sessionId: string;
  readonly engine: Engine;
  readonly archived: {
    readonly of: Recording;
    readonly from: number;
    readonly length: number;
  } | null;
} | null = null;
let volumeSave: ReturnType<typeof setTimeout> | null = null;
let zapTimer: ReturnType<typeof setTimeout> | null = null;
/** The channel the last stream was opened for. It becomes `previous` when another channel tunes. */
let tuned: LiveChannel | null = null;
/** Decodes the chosen subtitles from the stream's private data and shows them. */
let shown: {
  readonly pid: number;
  readonly decoder: SubtitleDecoder;
  readonly presenter: ReturnType<typeof subtitlePresenter>;
} | null = null;
/** The subtitles chosen last on this channel, which C turns on again. */
let lastSubtitle: SubtitleTrack | null = null;
/** Declared tracks belong to this stream; proof belongs to the channel until it changes. */
let declaredTracks: ChannelTracks | null = null;
const provenSubtitles = new Set<string>();
/** Explicit Off suppresses later language autoselection on this channel. */
let subtitlesOff = false;
/** Time played across streams of this channel, including reconnects. */
let channelPlayed = 0;
/** Preference answers apply only to the latest track list of this selection. */
let tracksRevision = 0;
/** Counts the reads of the main process's tracks: only the answer to the last one applies. */
let tracksAsked = 0;
/** A bounded packet sample lets first-proof autoselection decode the data that proved it. */
let recentSubtitlePackets: { pid: number; data: Uint8Array; at: number }[] = [];
const subtitleKey = (track: Pick<SubtitleTrack, "id" | "page" | "format">) =>
  `${track.format}:${track.id}:${track.page}`;

/**
 * The selected channel is the receiver's: the load that plays there, null until it was taken,
 * whether the receiver said it plays, for how long it has said so in all, in milliseconds, and
 * since when it says so now, null while it says anything else.
 */
let onReceiver: {
  load: number | null;
  started: boolean;
  played: number;
  since: number | null;
} | null = null;
const UNTRIED: Recovery = { played: false, reconnects: 0, relapses: 0 };
/** What the selected channel went through since the viewer chose it, here or on a receiver. */
let recovery = UNTRIED;
/** The viewer asked for this computer, so the channel goes on here when the receiver is let go of. */
let returning = false;

/**
 * Hears when the viewer starts a live channel, so a movie or episode playing in the same element
 * closes first. Previews don't count: they never replace what the viewer chose.
 */
let liveStarts: (() => void) | null = null;

export function onLiveStart(listener: () => void): void {
  liveStarts = listener;
}

function cancelZap(): void {
  if (zapTimer) clearTimeout(zapTimer);
  zapTimer = null;
}

/**
 * Stops the engine and closes the provider connection of the current stream. Its subtitles go
 * with it: their cues are on the clock of a stream that no longer plays.
 */
function release(): void {
  if (!current) return;
  if (sameOwned(tuned, store.getState().channel)) channelPlayed += current.engine.played();
  // The recording goes on from where this stream got to, counted from where it started.
  const recording = current.archived;
  if (recording) recording.of.at = recording.from + Math.round(current.engine.played());
  observation.unbind();
  current.engine.destroy();
  clearSubtitles(video);
  void call("playback.close", { sessionId: current.sessionId }).catch(() => {});
  current = null;
  declaredTracks = null;
  recentSubtitlePackets = [];
  // Nothing loads the chosen subtitles any more, and no picture is left to stand still.
  const { subtitleLoading, waiting } = store.getState();
  if (subtitleLoading || waiting) store.setState({ subtitleLoading: false, waiting: false });
}

/** The channel plays live from now on: a recording that played is forgotten. */
function live(): void {
  archived = null;
  if (store.getState().archive) store.setState({ archive: null });
}

/** The phase of a channel that failed with `problem`, after what it went through. */
function failed(problem: PlaybackProblem): PlayerPhase {
  return { kind: "failed", problem, recovery, at: Date.now() };
}

/**
 * Starts `channel` as chosen afresh, by the viewer or by a page for its preview: nothing it went
 * through before counts, and it has every reconnect.
 */
function begin(channel: LiveChannel, preview = false): Promise<void> {
  recovery = UNTRIED;
  return start(channel, false, preview);
}

/**
 * Notes that the channel broke off after `played` ms of picture. Long enough and the break gets
 * every reconnect, as a channel that worked. Any sooner and the reconnects it used stay used, so
 * coming back for a moment never earns more of them.
 */
function brokeOff(played: number): void {
  if (played >= STABLE_PLAYBACK_MS) recovery = { ...recovery, reconnects: 0, relapses: 0 };
  else if (recovery.reconnects > 0) recovery = { ...recovery, relapses: recovery.relapses + 1 };
}

/**
 * Takes the channel's next reconnect and says so: which attempt it is and when it starts. Returns
 * how long to wait for it, or null when none is left.
 */
function nextReconnect(): number | null {
  const delay = RECONNECT_DELAYS_MS[recovery.reconnects];
  if (delay === undefined) return null;
  recovery = { ...recovery, reconnects: recovery.reconnects + 1 };
  store.setState({ phase: reconnecting(Date.now() + delay) });
  return delay;
}

/** The phase of the reconnect the channel is at, which starts at `until` or is under way. */
function reconnecting(until: number | null): PlayerPhase {
  return {
    kind: "reconnecting",
    attempt: recovery.reconnects,
    of: RECONNECT_DELAYS_MS.length,
    until,
  };
}

/**
 * Opens and plays a stream: the channel's first, or the reconnect it is at. `repair` has the main
 * process re-encode the picture, which conceals a damaged broadcast the way standalone players do;
 * it costs CPU, so it is the second try.
 */
async function start(channel: LiveChannel, repair = false, preview = false): Promise<void> {
  if (outputs.remote()) {
    // Nothing previews while a receiver has playback: it would take the provider's connection.
    if (!preview) await startOnReceiver(channel);
    return;
  }
  const mine = ++selection;
  const measurement = preview ? null : observation.measurement();
  const first = recovery.reconnects === 0;
  // A stream nobody listens to, such as one a channel switch opens just after leaving Watch, is
  // a preview: it doesn't reconnect against another device.
  if (first) quiet = preview || !store.getState().audible;
  if (first) tune(channel);
  release();
  // A recording opens where the streams before got to, and one played to its end is over.
  const recording = archived;
  if (recording && recording.at >= recording.programme.stop) return player.stop();
  store.setState({
    channel,
    phase: first ? { kind: "tuning", since: Date.now() } : reconnecting(null),
    stream: null,
  });

  let session: StreamSession;
  let sound: SoundChoice;
  let subtitleLanguage: string | null = null;
  try {
    const preferences = await call("preferences.get").catch(() => null);
    const preferred = preferences?.audioLanguage;
    subtitleLanguage = preferences?.subtitleLanguage ?? null;
    sound = {
      audio: store.getState().audioId,
      // The sound in the viewer's language, when the channel has it; the original is its own.
      audioLanguage: preferred && preferred !== ORIGINAL_SOUND ? preferred : null,
    };
    if (!preview && mine !== selection) return;
    session = await call("playback.open", {
      ...(measurement ? { measurement } : {}),
      channel: ownedId(channel),
      ...(recording ? { archive: { start: recording.at, end: recording.programme.stop } } : {}),
      decoders: [...decoders],
      repair,
      ...(sound.audio !== null ? { audio: sound.audio } : {}),
      ...(sound.audioLanguage !== null ? { audioLanguage: sound.audioLanguage } : {}),
      // Said so the main process refuses it when a receiver took playback since this began.
      ...(preview ? { preview } : {}),
    });
  } catch (cause) {
    if (mine === selection) {
      const error = appError(cause);
      observation.failure(playbackFailure(error), appDiagnostic(error));
      store.setState({ phase: failed({ kind: "app", error: appError(cause) }) });
    }
    return;
  }
  if (mine !== selection) {
    void call("playback.close", { sessionId: session.sessionId }).catch(() => {});
    if (mine === selection) store.setState({ phase: { kind: "idle" } });
    return;
  }

  observation.bind(session.sessionId);
  // The provider's recording can start before the moment asked for, as Xtream's start on a whole
  // minute: what plays is counted from where it starts, and lasts to the window's end.
  const span = session.archive;
  const opened =
    recording && span ? { of: recording, from: span.start, length: span.end - span.start } : null;
  let engine = createEngine(session.format, video, session.url, sound, opened?.length ?? null);
  current = { sessionId: session.sessionId, engine, archived: opened };
  engine.onPlayback?.((state) => {
    if (mine === selection) observation.note(state);
  });
  engine.onPrivateData((pid, data, at) => {
    if (mine === selection) showSubtitles(pid, data, at);
  });
  engine.tracks?.onChange((tracks) => engineTracks(mine, tracks));
  engine.tracks?.onLine((line) => showLine(mine, line));
  engine.tracks?.onSubtitleLoaded(() => subtitlesLoaded(mine));
  engine.tracks?.onSubtitleUnavailable((track) => {
    const subtitle = store.getState().subtitle;
    if (mine !== selection || !subtitle || subtitleKey(subtitle) !== subtitleKey(track)) return;
    choose(null);
  });
  engine.tracks?.onSubtitleAvailable(
    (track) => {
      if (mine !== selection) return;
      provenSubtitles.add(subtitleKey(track));
      if (declaredTracks) void applyTracks(mine, declaredTracks);
    },
    subtitleLanguage,
    store.getState().tracks?.subtitles.filter((track) => provenSubtitles.has(subtitleKey(track))),
  );
  // An unavailable rendition turns off for this stream, while the channel's choice survives.
  // Explicit Off and a different channel clear that intent before another stream opens.
  if (!store.getState().subtitle && !subtitlesOff && lastSubtitle) choose(lastSubtitle);
  else restartSubtitles();
  let failure = await startFailure(engine);
  // Some "live" channels are raw audio (AAC radio) rather than MPEG-TS. Chromium plays those itself.
  if (failure?.kind === "wrong-container" && mine === selection) {
    engine.destroy();
    engine = nativeEngine(video, session.url, opened?.length ?? null);
    current = { sessionId: session.sessionId, engine, archived: opened };
    engine.onPlayback?.((state) => {
      if (mine === selection) observation.note(state);
    });
    failure = await startFailure(engine);
  }
  if (mine !== selection) return;
  if (failure) {
    await recover(mine, channel, session, failure, repair);
    return;
  }

  const playing = engine;
  recovery = { ...recovery, played: true };
  store.setState({ phase: { kind: "playing", engine: engine.name } });
  void loadStream(mine, session.sessionId);
  // An engine that reads the stream's tracks tells them itself; the main process reads the rest.
  // It says when they change (`playback.tracksChanged`), as captions begin whenever they do.
  if (!engine.tracks) void loadTracks(mine, session.sessionId);
  void call("viewing.recordWatch", {
    commandId: crypto.randomUUID(),
    channel: ownedId(channel),
  }).catch(() => {});
  playing.onWaiting((waiting) => {
    if (mine === selection) store.setState({ waiting });
  });
  // A stream that breaks is tried again with the reconnects the channel has left: all of them
  // once it played long enough.
  playing.onFailure((error) => {
    if (mine !== selection) return;
    brokeOff(playing.played());
    void recover(mine, channel, session, error, repair);
  });
  // A recording played to its end stops the channel.
  playing.onEnded(() => {
    if (mine === selection) player.stop();
  });
}

/**
 * Plays a channel on the connected receiver, in place of what it had: the channel's first try
 * there, or the reconnect it is at.
 */
async function startOnReceiver(channel: LiveChannel): Promise<void> {
  const mine = ++selection;
  const measurement = observation.measurement();
  const first = recovery.reconnects === 0;
  quiet = false;
  if (first) tune(channel);
  release();
  // A receiver plays the channel live: catch-up plays on this computer only.
  live();
  declaredTracks = null;
  recentSubtitlePackets = [];
  onReceiver = { load: null, started: false, played: 0, since: null };
  store.setState({
    channel,
    stopped: false,
    phase: first ? { kind: "tuning", since: Date.now() } : reconnecting(null),
    stream: null,
  });
  try {
    const { audioId } = store.getState();
    const preferred = (await call("preferences.get").catch(() => null))?.audioLanguage;
    if (mine !== selection) return;
    observation.remote();
    const media = await call("output.playChannel", {
      ...(measurement ? { measurement } : {}),
      channel: ownedId(channel),
      name: channel.title,
      ...(audioId !== null ? { audio: audioId } : {}),
      ...(preferred && preferred !== ORIGINAL_SOUND ? { audioLanguage: preferred } : {}),
    });
    if (mine !== selection || !onReceiver) {
      // Stopped meanwhile: the receiver is told so. One another channel replaced has gone already.
      void call("output.command", { generation: media.generation, command: "stop" }).catch(
        () => {},
      );
      return;
    }
    onReceiver.load = media.generation;
    // What the receiver said of it before this answer arrived.
    const said = outputs.media();
    if (said?.generation === media.generation) followReceiver(said);
  } catch (cause) {
    if (mine !== selection) return;
    const error = appError(cause);
    const failure = error.kind === "output" ? error.failure : null;
    if (failure?.kind === "stream") return void recoverOnReceiver(channel, failure.failure);
    store.setState({
      phase: failed(failure ? { kind: "receiver", failure, lost: false } : { kind: "app", error }),
    });
  }
}

/**
 * Takes the receiver's word on the channel it has. Its state shows from its first word past
 * loading, whatever that is. Only its word that the channel plays starts it: paused or buffering
 * before that says it is ready for the stream, not that the stream came.
 */
function followReceiver(media: RemoteMedia): void {
  const { channel, phase } = store.getState();
  // A channel has no end: the main process says its stream stopped instead.
  if (!channel || !onReceiver || media.state === "ended") return;
  // Only the time it says it plays is time played: none it holds the channel paused or buffering.
  onReceiver.played = playedOnReceiver();
  onReceiver.since = media.state === "playing" ? Date.now() : null;
  if (phase.kind !== "playing" && media.state === "loading") return;
  if (receiverState(phase) !== media.state) {
    store.setState({ phase: { kind: "playing", engine: "receiver", state: media.state } });
  }
  if (onReceiver.started || media.state !== "playing") return;
  onReceiver.started = true;
  recovery = { ...recovery, played: true };
  const mine = selection;
  void loadStream(mine, media.sessionId);
  void loadTracks(mine, media.sessionId);
  void call("viewing.recordWatch", {
    commandId: crypto.randomUUID(),
    channel: ownedId(channel),
  }).catch(() => {});
}

/** How long the receiver has said the channel plays, in milliseconds, up to now. */
function playedOnReceiver(): number {
  if (!onReceiver) return 0;
  return onReceiver.played + (onReceiver.since === null ? 0 : Date.now() - onReceiver.since);
}

/**
 * What to do about a channel whose stream the provider didn't deliver for the receiver: try
 * again after a delay when the network failed, with the reconnects the channel has left as for
 * this computer, or give up and say why.
 */
async function recoverOnReceiver(channel: LiveChannel, failure: StreamFailure): Promise<void> {
  const mine = selection;
  const problem = classify(failure, { kind: "network", detail: "" });
  if (onReceiver?.started) {
    brokeOff(playedOnReceiver());
    onReceiver.started = false;
  }
  const delay = retries(problem) ? nextReconnect() : null;
  if (delay === null) {
    store.setState({ phase: failed(problem) });
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
  // Not once the viewer asked for this computer: the receiver is being let go of.
  if (mine === selection && outputs.remote() && !returning) await startOnReceiver(channel);
}

/** Follows where playback goes: to a receiver that connected, back from one, and its word meanwhile. */
function outputChanged(status: OutputStatus, before: OutputStatus): void {
  const { output } = status;
  const { channel, phase } = store.getState();
  if (output.kind === "receiver" && before.output.kind !== "receiver") {
    // The channel being watched moves to the receiver. A preview only makes way.
    if (channel && !quiet && phase.kind !== "idle") void begin(channel);
    else if (!onReceiver) player.suspend();
    return;
  }
  if (!onReceiver || !channel) return;
  if (output.kind === "local") {
    // Let go of: the channel goes on here when the viewer asked for that, and stays stopped when
    // the receiver let go by itself.
    const resume = returning;
    returning = false;
    onReceiver = null;
    selection++;
    if (resume) player.play(channel);
    else store.setState({ phase: { kind: "idle" }, stopped: true });
    return;
  }
  if (output.kind === "lost") {
    // Still the same loss while the receivers listed or the scan change: its failure stays the
    // one the viewer may have closed the message about. Only a receiver reached again loses anew.
    if (before.output.kind === "lost") return;
    selection++;
    onReceiver.load = null;
    store.setState({
      phase: failed({ kind: "receiver", failure: output.failure, lost: true }),
    });
    return;
  }
  if (output.kind !== "receiver" || onReceiver.load === null) return;
  if (output.media?.generation === onReceiver.load) return followReceiver(output.media);
  if (output.media) return;
  // The receiver holds the channel no more: its stream stopped, or it was stopped there.
  onReceiver.load = null;
  const { failure } = output;
  if (failure?.kind === "stream") void recoverOnReceiver(channel, failure.failure);
  else if (failure) {
    store.setState({ phase: failed({ kind: "receiver", failure, lost: false }) });
  } else {
    // Stopped there: the main process ended its run, and playing it again begins another.
    observation.end();
    selection++;
    store.setState({ phase: { kind: "idle" }, stopped: true });
  }
}

outputs.subscribe(outputChanged);

/** Waits for an engine to start. Returns why it failed, or null once it plays. */
async function startFailure(engine: Engine): Promise<EngineError | null> {
  try {
    await engine.started;
    return null;
  } catch (error) {
    return isEngineError(error) ? error : { kind: "media", detail: String(error) };
  }
}

/**
 * Decides what to do about a failed or broken stream: reconnect after a delay when the network
 * failed, while the channel has reconnects left, try once more with the picture repaired when the
 * player could not decode it, or give up. A channel that gives up keeps what its session says of
 * the streams tried, which is asked for before the session closes.
 */
async function recover(
  mine: number,
  channel: LiveChannel,
  session: StreamSession,
  error: EngineError,
  repaired: boolean,
): Promise<void> {
  const [upstream, stream, context] = await Promise.all([
    call("playback.failure", {
      sessionId: session.sessionId,
      ...(error.failure ? { selector: error.failure } : {}),
    }).catch(() => null),
    call("playback.playing", { sessionId: session.sessionId }).catch(() => null),
    call("playback.diagnostic", { sessionId: session.sessionId }).catch(() => null),
  ]);
  if (mine !== selection) return;
  const problem = classify(upstream, error);
  if (quiet) {
    release();
    store.setState({ phase: failed(problem), stream });
    return;
  }
  if (problem.kind === "unsupported" && upstream === null && !repaired) {
    release();
    await start(channel, true);
    return;
  }
  observation.failure(
    upstream ? streamFailure(upstream) : error.kind === "network" ? "network" : "unsupported",
    upstream
      ? streamDiagnostic(upstream)
      : engineDiagnostic(error, session.format, repaired ? "repair" : "none", context),
  );
  const delay = retries(problem) ? nextReconnect() : null;
  release();
  if (delay === null) {
    store.setState({ phase: failed(problem), stream });
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, delay));
  if (mine !== selection) return;
  // Nobody listens any more, as after leaving Watch: what is left is a preview, which stays
  // failed instead of opening the stream again.
  if (quiet) store.setState({ phase: failed(problem), stream });
  else await start(channel, repaired);
}

/** Whether trying again by itself can help: the network failed, or the provider did. */
function retries(problem: PlaybackProblem): boolean {
  return problem.kind === "network" || problem.kind === "provider-error";
}

/**
 * The kind of thing that went wrong, from what the provider answered or else from how the engine
 * failed. What either said of it in words stays behind: those can name an address.
 */
function classify(upstream: StreamFailure | null, error: EngineError): PlaybackProblem {
  switch (upstream?.kind) {
    case "unavailable":
    case "refused":
    case "provider-error":
      return { kind: upstream.kind, status: upstream.status };
    case "network":
      return { kind: "network", unanswered: true };
    case "unsupported":
      return { kind: "unsupported" };
    case undefined:
      return error.kind === "network"
        ? { kind: "network", unanswered: false }
        : { kind: "unsupported" };
  }
}

/**
 * Makes `channel` the one tuned, when it is another: the one before becomes where Back goes, even
 * while switching, and the tracks and subtitle timing start afresh, with the viewer's languages,
 * for the new channel.
 */
function tune(channel: LiveChannel): void {
  if (sameOwned(tuned, channel)) return;
  if (tuned) store.setState({ previous: tuned });
  tuned = channel;
  store.setState({
    tracks: null,
    audioId: null,
    subtitle: null,
    subtitleLoading: false,
    subtitleAvailability: null,
    fellBack: null,
  });
  lastSubtitle = null;
  declaredTracks = null;
  provenSubtitles.clear();
  subtitlesOff = false;
  channelPlayed = 0;
  tracksRevision++;
  recentSubtitlePackets = [];
  shown = null;
  clearSubtitles(video);
  setSubtitleDelay(video, 0);
}

/** Reads which of the channel's streams plays, and notes when Automatic passed one by. */
async function loadStream(mine: number, sessionId: string): Promise<void> {
  const stream = await call("playback.playing", { sessionId }).catch(() => null);
  if (mine !== selection || !stream) return;
  const [failed] = stream.failed;
  const fellBack =
    failed && stream.variantId ? { from: failed.variantId, to: stream.variantId } : null;
  store.setState(fellBack ? { stream, fellBack } : { stream });
}

/**
 * Reads the stream's tracks from the main process. An answer that arrives after a later read's
 * is dropped: it is the older list.
 */
async function loadTracks(mine: number, sessionId: string): Promise<void> {
  const asked = ++tracksAsked;
  const tracks = await call("playback.tracks", { sessionId }).catch(() => null);
  if (mine === selection && asked === tracksAsked && tracks) await applyTracks(mine, tracks);
}

/**
 * The main process found another caption channel in a stream's pictures. Only the stream that
 * plays here counts: one closed since is nobody's, an HLS engine tells its own tracks, and what
 * was found before a stream plays is in the tracks read when it does.
 */
listen("playback.tracksChanged", ({ sessionId }) => {
  if (current?.sessionId !== sessionId || current.engine.tracks) return;
  if (store.getState().phase.kind !== "playing") return;
  void loadTracks(selection, sessionId);
});

/**
 * Takes the stream's tracks as its engine tells them, now and whenever they change. What the
 * viewer chose holds only while the stream still has it: subtitles it no longer lists go, and a
 * sound track gives way to the one that plays, as after the stream moved to renditions without it.
 */
function engineTracks(mine: number, tracks: ChannelTracks): void {
  if (mine !== selection) return;
  const { audioId, subtitle } = store.getState();
  const listed = (track: SubtitleTrack) =>
    tracks.subtitles.some((each) => each.id === track.id && each.page === track.page);
  if (lastSubtitle && !listed(lastSubtitle)) lastSubtitle = null;
  if (subtitle && !listed(subtitle)) choose(null);
  if (audioId !== null && tracks.playing !== null && tracks.playing !== audioId) {
    store.setState({ audioId: null });
  }
  void applyTracks(mine, tracks);
}

/**
 * Shows the stream's tracks. Until the viewer chose subtitles on this channel, those in the
 * viewer's language may come on by themselves (see channelSubtitle): the language remembered, or
 * none when the viewer turned subtitles off, whatever the stream marks as its default.
 */
async function applyTracks(mine: number, tracks: ChannelTracks): Promise<void> {
  declaredTracks = tracks;
  // The main process declares captions only after seeing them in the current video data.
  if (!current?.engine.tracks) {
    for (const track of tracks.subtitles) {
      if (track.format === "captions") provenSubtitles.add(subtitleKey(track));
    }
    for (const packet of recentSubtitlePackets) observeSubtitles(packet.pid, packet.data);
  }
  const proven = tracks.subtitles.filter((track) => provenSubtitles.has(subtitleKey(track)));
  const available = {
    ...tracks,
    subtitles: onReceiver
      ? tracks.subtitles
      : tracks.subtitles.filter(
          (track) =>
            proven.includes(track) || (track.format === "text" && provenSubtitles.size > 0),
        ),
  };
  const revision = ++tracksRevision;
  store.setState({ tracks: available });
  const chosen = () => subtitlesOff || store.getState().subtitle !== null || lastSubtitle !== null;
  const wanted = (await call("preferences.get").catch(() => null))?.subtitleLanguage ?? null;
  if (mine !== selection || revision !== tracksRevision) return;
  if (!chosen()) {
    const match = channelSubtitle(
      onReceiver ? available : { ...tracks, subtitles: proven },
      wanted,
    );
    if (match) choose(match);
  }
  if (!onReceiver && !store.getState().subtitleAvailability && proven.length > 0) {
    store.setState({
      subtitleAvailability: {
        played: channelPlayed + (current?.engine.played() ?? 0),
        selected: store.getState().subtitle !== null,
      },
    });
  }
}

/** Puts a line of an HLS stream's subtitles on the element's track, at the viewer's timing. */
function showLine(mine: number, line: Cue): void {
  if (mine !== selection || !store.getState().subtitle) return;
  forgetShownSubtitles(video);
  addTextCue(video, line.start, line.end, line.text);
}

/** The engine of an HLS stream has read the chosen subtitles where the stream plays. */
function subtitlesLoaded(mine: number): void {
  if (mine !== selection || !store.getState().subtitleLoading) return;
  store.setState({ subtitleLoading: false });
}

/**
 * Starts the chosen subtitles from scratch: read by the engine of a stream that carries them in
 * its playlists, else decoded here from the stream's private data. The engine's are loading until
 * it says otherwise, which it may do at once.
 */
function restartSubtitles(): void {
  const { subtitle } = store.getState();
  const own = current?.engine.tracks ?? null;
  store.setState({ subtitleLoading: own !== null && subtitle !== null });
  if (own) {
    shown = null;
    own.setSubtitle(subtitle);
    return;
  }
  shown = subtitle
    ? {
        pid: subtitle.id,
        decoder: subtitleDecoder(
          subtitle.format === "teletext"
            ? "teletext"
            : subtitle.format === "captions"
              ? "captions"
              : "dvb",
          subtitle.page,
        ),
        presenter: subtitlePresenter(video),
      }
    : null;
  if (shown) {
    for (const packet of recentSubtitlePackets) {
      if (packet.pid !== shown.pid) continue;
      const change = shown.decoder.push(packet.data, packet.at);
      if (change) shown.presenter.show(change);
    }
  }
}

/** Checks addresses and segment structure only; unselected tracks are never decoded. */
function observeSubtitles(pid: number, data: Uint8Array): boolean {
  let changed = false;
  for (const track of declaredTracks?.subtitles ?? []) {
    if (track.id !== pid || provenSubtitles.has(subtitleKey(track))) continue;
    const present =
      track.format === "teletext"
        ? teletextPagePresent(data, track.page)
        : track.format === "picture" && dvbPagePresent(data, track.page);
    if (present) {
      provenSubtitles.add(subtitleKey(track));
      changed = true;
    }
  }
  return changed;
}

function showSubtitles(pid: number, data: Uint8Array, at: number): void {
  if (!declaredTracks || declaredTracks.subtitles.some((track) => track.id === pid)) {
    if (data.byteLength <= 65_536) {
      recentSubtitlePackets.push({ pid, data: data.slice(), at });
      let bytes = recentSubtitlePackets.reduce(
        (total, packet) => total + packet.data.byteLength,
        0,
      );
      while (bytes > 65_536 || recentSubtitlePackets.length > 64) {
        bytes -= recentSubtitlePackets.shift()!.data.byteLength;
      }
    }
  }
  if (declaredTracks && observeSubtitles(pid, data)) {
    void applyTracks(selection, declaredTracks);
  }
  if (!shown || pid !== shown.pid) return;
  const change = shown.decoder.push(data, at);
  if (change) shown.presenter.show(change);
}

/** Shows `track`, or nothing. */
function choose(track: SubtitleTrack | null): void {
  store.setState({ subtitle: track });
  if (track) lastSubtitle = track;
  clearSubtitles(video);
  restartSubtitles();
}

/**
 * Remembers the subtitles picked, in a channel or a title, for the next ones: their language, or
 * none. Captions have no language, so picking them keeps the one remembered before.
 */
export function rememberSubtitles(track: SubtitleTrack | null): void {
  const language = track ? track.language : "off";
  if (language === null) return;
  void call("preferences.update", { subtitleLanguage: language }).catch(() => {});
}

/** The receiver's volume, when one has playback and it can be set from here. */
function receiverVolume(): { readonly level: number; readonly muted: boolean } | null {
  const { output } = outputs.status();
  return output.kind === "receiver" ? output.volume : null;
}

function applyVolume(): void {
  const { volume, muted, audible } = store.getState();
  video.volume = volume;
  video.muted = muted || !audible;
}

function saveVolume(): void {
  if (volumeSave) clearTimeout(volumeSave);
  volumeSave = setTimeout(() => {
    const { volume, muted } = store.getState();
    void call("preferences.update", { volume, muted }).catch(() => {});
  }, VOLUME_SAVE_DELAY_MS);
}

export const player = {
  /** The video element every view shows the picture in. */
  element: video,

  /** Restores the saved volume and subtitle look. Call once before the first `play`. */
  hydrate(preferences: Preferences): void {
    store.setState({ volume: preferences.volume, muted: preferences.muted });
    applyVolume();
    setSubtitleLook(preferences.subtitleLook ?? DEFAULT_SUBTITLE_LOOK);
  },

  /** Plays a channel live. */
  play(channel: LiveChannel): void {
    selectForWatching(channel);
    liveStarts?.();
    cancelZap();
    live();
    store.setState({ stopped: false });
    void begin(channel);
  },

  /**
   * Plays a programme of `channel` from the provider's catch-up archive, from its start, as `play`
   * plays the channel live. Nothing opens while a receiver has playback: it plays channels live.
   */
  playArchive(channel: LiveChannel, programme: Programme): void {
    if (outputs.remote()) return;
    selectForWatching(channel);
    liveStarts?.();
    cancelZap();
    archived = { programme, at: programme.start };
    store.setState({ stopped: false, archive: programme });
    void begin(channel);
  },

  /**
   * Plays a channel to watch it, keeping the stream when a preview already shows it, a recording's
   * too. From then on a failure reconnects as usual.
   */
  watch(channel: LiveChannel): void {
    const { channel: selected, phase } = store.getState();
    const open =
      phase.kind === "playing" || phase.kind === "tuning" || phase.kind === "reconnecting";
    if (sameOwned(selected, channel) && open && !zapTimer) {
      selectForWatching(channel);
      if (current) observation.bind(current.sessionId);
      liveStarts?.();
      quiet = false;
      store.setState({ stopped: false });
      return;
    }
    player.play(channel);
  },

  /**
   * Plays a channel live to watch it, as the viewer asked for its live picture: a preview of it
   * that shows it live goes on, and a recording of it gives way to the channel live, as `play`
   * does.
   */
  watchLive(channel: LiveChannel): void {
    if (store.getState().archive) player.play(channel);
    else player.watch(channel);
  },

  /** Starts a muted preview of a channel, unless it already plays or the viewer stopped playback. */
  preview(channel: LiveChannel): void {
    const { channel: current, phase, stopped } = store.getState();
    // Nothing previews while a receiver has playback, or had it until its connection broke.
    if (outputs.receiver()) return;
    if (stopped || (sameOwned(current, channel) && phase.kind !== "idle")) return;
    cancelZap();
    // Another channel previews live. The one that played a recording goes on with it.
    if (!sameOwned(current, channel)) live();
    void begin(channel, true);
  },

  /**
   * Stops a preview while nobody can see it. Unlike `stop`, the next preview starts it again. A
   * channel a receiver plays is left alone: no page stops that.
   */
  suspend(): void {
    if (onReceiver) return;
    cancelZap();
    selection++;
    release();
    shown = null;
    store.setState({ phase: { kind: "idle" } });
  },

  /**
   * Whether the view on screen plays sound. A stream nobody listens to is a preview again, so
   * leaving Watch stops it from reconnecting against another device.
   */
  setAudible(audible: boolean): void {
    quiet = !audible;
    observation.setEligible(audible);
    if (store.getState().audible === audible) return;
    store.setState({ audible });
    applyVolume();
  },

  /**
   * Switches channel the way a remote does: the new channel shows immediately and its stream
   * opens once the viewer stops switching for a moment.
   */
  zap(channel: LiveChannel): void {
    selectForWatching(channel);
    liveStarts?.();
    cancelZap();
    selection++;
    release();
    live();
    // What a receiver says of the channel before is no word on this one.
    if (onReceiver) onReceiver.load = null;
    tune(channel);
    store.setState({ channel, phase: { kind: "tuning", since: Date.now() }, stopped: false });
    zapTimer = setTimeout(() => {
      zapTimer = null;
      void begin(channel);
    }, ZAP_SETTLE_MS);
  },

  /** Returns to the channel that played before this one. */
  back(): void {
    const { previous } = store.getState();
    if (previous) player.play(previous);
  },

  /** Tries the current channel again from scratch, in the quality it had, with every reconnect. */
  retry(): void {
    const { channel } = store.getState();
    if (channel) void begin(channel);
  },

  /** Opens the current channel again after its quality was chosen, forgetting a fallback. */
  reopen(): void {
    store.setState({ fellBack: null });
    player.retry();
  },

  /** Stops the channel. On a receiver it ends the stream there and keeps the receiver. */
  stop(): void {
    observation.end();
    explicitlySelected = null;
    if (onReceiver) {
      const { load } = onReceiver;
      cancelZap();
      selection++;
      onReceiver = null;
      if (load !== null) {
        void call("output.command", { generation: load, command: "stop" }).catch(() => {});
      }
      store.setState({ phase: { kind: "idle" }, stopped: true });
      return;
    }
    player.suspend();
    store.setState({ stopped: true });
  },

  /**
   * Makes way for a movie or episode: what plays here ends, and a channel a receiver plays is
   * forgotten, as the title takes its place there.
   */
  makeWay(): void {
    observation.end();
    explicitlySelected = null;
    if (!onReceiver) return player.suspend();
    cancelZap();
    selection++;
    onReceiver = null;
    store.setState({ phase: { kind: "idle" } });
  },

  /**
   * Brings the channel a receiver plays back to this computer: the receiver is let go of first,
   * then it plays here.
   */
  playHere(): void {
    returning = true;
    void outputs.local();
  },

  /**
   * Plays on a channel the receiver holds paused, as after Pause on the TV's remote. The receiver
   * keeps the stream it has, so nothing opens again.
   */
  resume(): void {
    if (onReceiver?.load == null || receiverState(store.getState().phase) !== "paused") return;
    void call("output.command", { generation: onReceiver.load, command: "play" }).catch(() => {});
  },

  /** Whether the selected channel is the receiver's. */
  onReceiver: (): boolean => onReceiver !== null,

  /** Takes up a channel a receiver already plays, as when the window opens while it does. */
  adopt(channel: LiveChannel, media: RemoteMedia): void {
    if (onReceiver) return;
    explicitlySelected = channel;
    observation.adoptRemote();
    selection++;
    tune(channel);
    recovery = UNTRIED;
    live();
    onReceiver = { load: media.generation, started: false, played: 0, since: null };
    store.setState({ channel, stopped: false, phase: { kind: "tuning", since: media.at } });
    followReceiver(media);
  },

  /** Stops and forgets the selected channel, for when the subscription changes. */
  reset(): void {
    observation.end();
    explicitlySelected = null;
    onReceiver = null;
    player.suspend();
    live();
    tuned = null;
    provenSubtitles.clear();
    declaredTracks = null;
    store.setState({ channel: null, previous: null, stopped: false, subtitleAvailability: null });
  },

  /**
   * Sets the volume: this computer's, or the receiver's while one has playback. False when the
   * receiver's can't be set from here.
   */
  setVolume(volume: number): boolean {
    const level = Math.min(1, Math.max(0, volume));
    if (outputs.receiver()) {
      if (!receiverVolume()) return false;
      outputs.volume({ level, muted: false });
      return true;
    }
    store.setState({ volume: level, muted: false, audible: true });
    applyVolume();
    saveVolume();
    return true;
  },

  /** Up and Down: a step louder or quieter, on whatever plays. False as for `setVolume`. */
  nudgeVolume(step: number): boolean {
    const from = outputs.receiver() ? (receiverVolume()?.level ?? 0) : store.getState().volume;
    return player.setVolume(from + step);
  },

  /**
   * The speaker: mutes or unmutes. Unmuting a preview makes it audible without touching the
   * viewer's own mute setting.
   */
  toggleMute(): boolean {
    if (outputs.receiver()) {
      const receiver = receiverVolume();
      if (receiver) outputs.volume({ muted: !receiver.muted });
      return receiver !== null;
    }
    const { muted, audible } = store.getState();
    if (!audible) {
      store.setState({ audible: true, muted: false });
    } else {
      store.setState({ muted: !muted });
    }
    applyVolume();
    saveVolume();
    return true;
  },

  /**
   * Plays another sound track of the channel, and remembers its language. An HLS stream switches
   * where it plays. Any other opens again with the track, so its picture starts over.
   */
  setAudio(id: number): void {
    const { channel, tracks } = store.getState();
    const track = tracks?.audio.find((each) => each.id === id);
    if (!channel || !track) return;
    store.setState({ audioId: id });
    if (track.language) {
      void call("preferences.update", { audioLanguage: track.language }).catch(() => {});
    }
    const own = current?.engine.tracks;
    if (own) own.setAudio(id);
    else void begin(channel);
  },

  /** Shows a subtitle track, or none, and remembers the choice. A receiver shows none of a channel's. */
  setSubtitle(track: SubtitleTrack | null): void {
    if (onReceiver) return;
    if (
      track &&
      !store.getState().tracks?.subtitles.some((each) => subtitleKey(each) === subtitleKey(track))
    )
      return;
    subtitlesOff = track === null;
    choose(track);
    rememberSubtitles(track);
  },

  /** C: subtitles off, or back on: the ones chosen last on this channel, else the first. */
  toggleSubtitles(): void {
    const { subtitle, tracks } = store.getState();
    if (subtitle) return player.setSubtitle(null);
    const next =
      tracks?.subtitles.find(
        (track) => lastSubtitle && subtitleKey(track) === subtitleKey(lastSubtitle),
      ) ??
      tracks?.subtitles[0] ??
      null;
    if (next) player.setSubtitle(next);
  },

  /** The player's state now, for key handlers that read it once. */
  state(): PlayerState {
    return store.getState();
  },

  /** The selected channel, playing or not. */
  current(): LiveChannel | null {
    return store.getState().channel;
  },

  /** Details of the playing stream, or null when nothing plays. */
  info(): StreamInfo | null {
    return current && store.getState().phase.kind === "playing" ? current.engine.info() : null;
  },
};
