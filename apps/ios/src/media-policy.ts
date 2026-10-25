import type { AppError } from "@mrstreamer/contracts/errors";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import type { FilterFile } from "@mrstreamer/core/ondemand/filters";
import { TITLE_LANGUAGES, type TitleLanguage } from "@mrstreamer/core/ondemand/languages";
import { languageCode } from "@mrstreamer/core/ondemand/tracks";
import type {
  ObservedAudioTrack,
  ObservedFailure,
  ObservedSubtitleTrack,
  ObservedTrackSelection,
  ObservedTrackSnapshot,
} from "expo-video";
import type { getMediaPreferences } from "./media-preferences.ts";

// What the one player decides about the sound and subtitles of what plays, the facts it keeps of
// a file it read, and how a Live stream recovers: pure decisions over the native player's
// observed snapshots (patches/expo-video), with no state, timer, file or native call. The owner
// that applies them keeps everything stateful: which snapshot counts, one request at a time, the
// viewer's holds and the recovery timers. Languages compare as core's `languageCode` reads them,
// so "ger", "deu" and "de-DE" are one language; forced subtitles are only those the native
// player marks, never a name that says so.

/** The two global track policies, as accepted preferences hold them. */
export type MediaPolicy = Pick<ReturnType<typeof getMediaPreferences>, "audio" | "subtitles">;

/** What a choice is about, fixed when the viewer chooses it. */
export interface TrackContext {
  readonly media: "file" | "live";
  /** Canonical effective title language when the choice started; null when it names none. */
  readonly titleLanguage: string | null;
  /** Canonical language the title was made in, as its caller knows it; null when unknown. */
  readonly originalLanguage: string | null;
}

export type Decision =
  | { readonly kind: "select"; readonly selection: ObservedTrackSelection }
  /** The selection already satisfies the policy, or nothing can honestly be asked for. */
  | { readonly kind: "keep" }
  /** A needed fact isn't known yet: the group, the audio group or the selected sound. */
  | { readonly kind: "wait" };

const KEEP: Decision = { kind: "keep" };
const WAIT: Decision = { kind: "wait" };

type Track = ObservedAudioTrack | ObservedSubtitleTrack;
const languageOf = (track: Track | undefined) => languageCode(track?.language);

/** The language an audio policy asks for here. A channel follows only an explicit language. */
export function audioTarget(audio: MediaPolicy["audio"], context: TrackContext): string | null {
  if (audio.kind === "language") return audio.language;
  if (context.media === "live") return null;
  return audio.kind === "follow-title" ? context.titleLanguage : context.originalLanguage;
}

/**
 * A playable track in the target language, its default first; else the playable native default;
 * else nothing, never a first-track guess. Keeps a selection that already speaks the target.
 */
export function decideAudio(
  tracks: ObservedTrackSnapshot,
  policy: MediaPolicy,
  context: TrackContext,
): Decision {
  if (tracks.audio.state !== "ready") return WAIT;
  const playable = tracks.audio.options.filter((track) => track.isPlayable);
  const selected = tracks.audio.options.find((track) => track.id === tracks.selectedAudioId);
  const choose = (track: ObservedAudioTrack): Decision =>
    track.id === tracks.selectedAudioId
      ? KEEP
      : { kind: "select", selection: { kind: "audio", track } };
  const target = audioTarget(policy.audio, context);
  if (target !== null && selected?.isPlayable && languageOf(selected) === target) return KEEP;
  const spoken = playable.filter((track) => target !== null && languageOf(track) === target);
  const wanted = spoken.find((track) => track.isDefault) ?? spoken[0];
  if (wanted) return choose(wanted);
  const fallback = playable.find((track) => track.isDefault);
  return fallback ? choose(fallback) : KEEP;
}

/**
 * Off where the group allows it. A file's language picks a plain track in it, else forced
 * subtitles for the selected sound, as core's chooseTracks does. A channel's language follows
 * core's channelSubtitle: off while any playable sound speaks it, else plain, then forced in that
 * language, then off. Forced-only picks forced subtitles in the selected sound's language, else
 * off. `sound` is the confirmed selected sound: undefined while unconfirmed, null when the file
 * exposes no audio group.
 */
export function decideSubtitles(
  tracks: ObservedTrackSnapshot,
  policy: MediaPolicy,
  context: TrackContext,
  sound: string | null | undefined,
): Decision {
  if (tracks.subtitles.state !== "ready") return WAIT;
  const playable = tracks.subtitles.options.filter((track) => track.isPlayable);
  const selected = tracks.subtitles.options.find((track) => track.id === tracks.selectedSubtitleId);
  const off = (): Decision =>
    !tracks.subtitleOffAllowed || tracks.selectedSubtitleId === null
      ? KEEP
      : { kind: "select", selection: { kind: "subtitles", track: null } };
  const choose = (track: ObservedSubtitleTrack): Decision =>
    track.id === tracks.selectedSubtitleId
      ? KEEP
      : { kind: "select", selection: { kind: "subtitles", track } };
  const wanted = policy.subtitles;
  if (wanted.kind === "off") return off();
  if (wanted.kind === "language" && context.media === "live") {
    if (tracks.audio.state !== "ready" && tracks.audio.state !== "absent") return WAIT;
    const spoken = tracks.audio.options.some(
      (track) => track.isPlayable && languageOf(track) === wanted.language,
    );
    if (spoken) return off();
    const inLanguage = playable.filter((track) => languageOf(track) === wanted.language);
    const track = inLanguage.find((each) => !each.forcedOnly) ?? inLanguage[0];
    return track ? choose(track) : off();
  }
  if (wanted.kind === "language") {
    const plain = (track: ObservedSubtitleTrack | undefined) =>
      track !== undefined &&
      track.isPlayable &&
      !track.forcedOnly &&
      languageOf(track) === wanted.language;
    if (plain(selected)) return KEEP;
    const track = playable.find(plain);
    if (track) return choose(track);
  }
  if (sound === undefined) return WAIT;
  const forced = (track: ObservedSubtitleTrack | undefined) =>
    track !== undefined &&
    track.isPlayable &&
    track.forcedOnly &&
    sound !== null &&
    languageOf(track) === sound;
  if (forced(selected)) return KEEP;
  const track = playable.find(forced);
  return track ? choose(track) : off();
}

/** What describes a track the viewer picked, kept in place of its native id. */
interface Described {
  readonly language: string | null;
  readonly label: string;
  readonly name: string | null;
}

/** A confirmed manual pick, kept by what describes it: never a native id or revision. */
export type TrackHold =
  | ({ readonly group: "audio" } & Described)
  | ({ readonly group: "subtitles"; readonly off: false; readonly forcedOnly: boolean } & Described)
  | { readonly group: "subtitles"; readonly off: true };

const described = (track: Track): Described => ({
  language: languageOf(track),
  label: track.label,
  name: track.name ?? null,
});

export function holdOf(selection: ObservedTrackSelection): TrackHold {
  if (selection.kind === "audio") return { group: "audio", ...described(selection.track) };
  const { track } = selection;
  if (!track) return { group: "subtitles", off: true };
  return { group: "subtitles", off: false, forcedOnly: track.forcedOnly, ...described(track) };
}

const alike = (track: Track, kept: Described) =>
  track.isPlayable &&
  languageOf(track) === kept.language &&
  track.label === kept.label &&
  (track.name ?? null) === kept.name;

/** The one playable track alike in everything the hold keeps, else null: the hold waits. */
export function rematch(
  hold: TrackHold,
  tracks: ObservedTrackSnapshot,
): ObservedTrackSelection | null {
  if (hold.group === "audio") {
    const found =
      tracks.audio.state === "ready"
        ? tracks.audio.options.filter((track) => alike(track, hold))
        : [];
    return found.length === 1 && found[0] ? { kind: "audio", track: found[0] } : null;
  }
  if (hold.off) return tracks.subtitleOffAllowed ? { kind: "subtitles", track: null } : null;
  const found =
    tracks.subtitles.state === "ready"
      ? tracks.subtitles.options.filter(
          (track) => alike(track, hold) && track.forcedOnly === hold.forcedOnly,
        )
      : [];
  return found.length === 1 && found[0] ? { kind: "subtitles", track: found[0] } : null;
}

/**
 * Whether an accepted snapshot shows the exact track a requested selection named. Off only in a
 * ready subtitle group that still allows it, with nothing selected: an absent, unknown or
 * Off-refusing group never confirms Off. A track by its id within the requested revision; at a
 * newer revision, ids are other options' positions, so it must rematch uniquely to the selection.
 */
export function confirms(
  selection: ObservedTrackSelection,
  requestedAt: number,
  after: ObservedTrackSnapshot,
): boolean {
  const { track } = selection;
  if (!track) {
    return (
      after.subtitles.state === "ready" &&
      after.subtitleOffAllowed &&
      after.selectedSubtitleId === null
    );
  }
  const selectedId = selection.kind === "audio" ? after.selectedAudioId : after.selectedSubtitleId;
  if (after.revision === requestedAt) return selectedId === track.id;
  const again = rematch(holdOf(selection), after);
  return again !== null && again.track !== null && again.track.id === selectedId;
}

export type Remembered =
  | { readonly field: "audio"; readonly value: MediaPolicy["audio"] }
  | { readonly field: "subtitles"; readonly value: MediaPolicy["subtitles"] };

/** The language as a global choice can hold it, if it is one of those offered. */
const offered = (code: string | null): TitleLanguage | undefined =>
  TITLE_LANGUAGES.find((language) => language.code === code)?.code;

/**
 * The global policy a confirmed manual pick that changed the selection should become, or null
 * when the accepted policy already expresses it or no global choice can: then the pick holds for
 * this choice only. `accepted` is the current accepted globals, not those the choice started
 * with, so a second pick on one choice replaces the first; `context` stays the choice's. Forced
 * subtitles become forced-only only for the confirmed sound's language.
 */
export function remembered(
  picked: ObservedTrackSelection,
  sound: string | null | undefined,
  accepted: MediaPolicy,
  context: TrackContext,
): Remembered | null {
  if (picked.kind === "audio") {
    const language = offered(languageOf(picked.track));
    if (!language || audioTarget(accepted.audio, context) === language) return null;
    return { field: "audio", value: { kind: "language", language } };
  }
  const now = accepted.subtitles;
  const { track } = picked;
  if (!track) return now.kind === "off" ? null : { field: "subtitles", value: { kind: "off" } };
  const language = languageOf(track);
  if (!track.forcedOnly) {
    const listed = offered(language);
    if (!listed || (now.kind === "language" && now.language === listed)) return null;
    return { field: "subtitles", value: { kind: "language", language: listed } };
  }
  if (language === null || language !== sound || now.kind === "forced-only") return null;
  return { field: "subtitles", value: { kind: "forced-only" } };
}

/** Core's per-file track facts: the languages of the tracks this iPhone can play. */
export type ObservedFileTracks = NonNullable<FilterFile["tracks"]>;

/** More playable tracks than this leave a file unread rather than its facts cut short. */
const FACT_TRACKS = 32;

/**
 * The languages of a snapshot's playable tracks, null where a track names none, once audio is
 * ready and subtitles are ready or absent (absent gives none). Null while either is unknown:
 * null never means a file has no such tracks.
 */
export function observedFileTracks(tracks: ObservedTrackSnapshot): ObservedFileTracks | null {
  const subtitlesKnown = tracks.subtitles.state === "ready" || tracks.subtitles.state === "absent";
  if (tracks.audio.state !== "ready" || !subtitlesKnown) return null;
  const audio = tracks.audio.options.filter((track) => track.isPlayable);
  const subtitles = tracks.subtitles.options.filter((track) => track.isPlayable);
  if (audio.length > FACT_TRACKS || subtitles.length > FACT_TRACKS) return null;
  return { audio: audio.map(languageOf), subtitles: subtitles.map(languageOf) };
}

// Recovery of a Live stream that failed. The values are the desktop's
// (renderer/player/recovery-policy.ts and engine.ts), which Hermes can't import.

/** Waits before each reconnect; their number is the reconnect limit. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
/** Playing this long, without pause or waiting, earns every reconnect back. */
export const STABLE_PLAYBACK_MS = 30_000;
/** A Live attempt with no picture or sound this long after native attach fails. */
export const START_TIMEOUT_MS = 20_000;
/** A Live stream whose time stands still this long after it played, not paused, fails. */
export const STALL_TIMEOUT_MS = 15_000;

/** Why an attempt failed, as playback keeps it. Only a category ever reaches analytics. */
export type PlaybackFailure =
  | { readonly kind: "native"; readonly failure: ObservedFailure }
  | { readonly kind: "format"; readonly failure: StreamFailure }
  | { readonly kind: "lookup"; readonly error: AppError }
  /** A deadline the app measured: a policy category, never an HTTP cause. */
  | { readonly kind: "deadline"; readonly stage: "startup" | "stall" }
  | { readonly kind: "bridge" | "reset" | "cancelled" | "detach-timeout" };

/** Where a viewer's choice stands in its budget. */
export interface Recovery {
  /** Streams to try: core's Automatic up to three, or the one chosen. */
  readonly candidates: number;
  readonly candidate: number;
  /** The candidate that reached playing since the choice, or Try again, began; null if none. */
  readonly playedOn: number | null;
  /** Reconnects used since playing last earned them back. */
  readonly reconnects: number;
  /** How long the failed attempt played, without pause, waiting or backoff. */
  readonly playedMs: number;
}

export type Step =
  | { readonly kind: "fail" }
  | { readonly kind: "candidate"; readonly candidate: number }
  | {
      readonly kind: "reconnect";
      readonly candidate: number;
      readonly delayMs: number;
      readonly reconnects: number;
    };

type FailureClass = "refusal" | "missing" | "transient" | "no-start" | "media" | "terminal";

/** Native failure kinds as recovery treats them. Unknown is a budget class, never a cause. */
const NATIVE: Readonly<Record<ObservedFailure["kind"], FailureClass>> = {
  auth: "refusal",
  "rate-limit": "refusal",
  missing: "missing",
  network: "transient",
  unknown: "transient",
  http: "transient",
  decode: "media",
  unsupported: "media",
};

function classOf(failure: PlaybackFailure): FailureClass {
  switch (failure.kind) {
    case "native":
      return NATIVE[failure.failure.kind];
    case "format":
      return failure.failure.kind === "refused" ? "refusal" : "terminal";
    case "deadline":
      return failure.stage === "stall" ? "transient" : "no-start";
    default:
      return "terminal";
  }
}

/**
 * What a failed attempt leads to. Only a Live stream someone watches, not paused by the viewer,
 * under the login it began with, tries again. Before the choice played, the next candidate; once
 * it played, the candidate that played after 1, 2, 4 and 8 seconds, earned back by playing
 * STABLE_PLAYBACK_MS. That is at most 3 + 4 opens until a stream plays that long, and 4 after.
 * Refusals and app failures stop at once.
 */
export function nextStep(
  failure: PlaybackFailure,
  recovery: Recovery,
  context: {
    readonly live: boolean;
    readonly attended: boolean;
    readonly held: boolean;
    readonly sourceStands: boolean;
  },
): Step {
  const failed: Step = { kind: "fail" };
  if (!context.live || !context.attended || context.held || !context.sourceStands) return failed;
  const kind = classOf(failure);
  if (kind === "refusal" || kind === "terminal") return failed;
  if (recovery.playedOn === null) {
    const next = recovery.candidate + 1;
    return next < recovery.candidates ? { kind: "candidate", candidate: next } : failed;
  }
  if (kind !== "transient" && kind !== "no-start") return failed;
  const used = recovery.playedMs >= STABLE_PLAYBACK_MS ? 0 : recovery.reconnects;
  const delayMs = RECONNECT_DELAYS_MS[used];
  return delayMs === undefined
    ? failed
    : { kind: "reconnect", candidate: recovery.playedOn, delayMs, reconnects: used + 1 };
}
