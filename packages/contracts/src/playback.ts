// Stream sessions: the main process opens the upstream connection and hands the UI a local URL.
import type { TitleRef } from "./ondemand.ts";
import type { OwnedId } from "./subscription.ts";
import type { PlaybackDiagnostic } from "./analytics.ts";

/** Container formats the UI's playback engines know how to load. */
export type StreamFormat = "mpegts" | "hls";

/**
 * Codecs the app tells apart in a stream. The UI reports which of them its player decodes, and
 * the main process converts the rest before they reach it.
 */
export const CODECS = [
  "h264",
  "hevc",
  "hevc-10bit",
  "mpeg2",
  "aac",
  /** AAC whose channel layout is only described in the stream, which browsers do not read. */
  "aac-pce",
  "aac-latm",
  "mp3",
  "mp2",
  "ac3",
  "eac3",
  "dts",
  "opus",
  "flac",
] as const;
export type Codec = (typeof CODECS)[number];

export interface StreamSession {
  readonly sessionId: string;
  /** The channel it plays, and from which subscription. */
  readonly channel: OwnedId;
  /** Loopback URL that proxies the provider stream. Carries no credentials. */
  readonly url: string;
  readonly format: StreamFormat;
  /**
   * For a recording from the catch-up archive, the stretch it plays: from where the provider's
   * recording begins, which can be up to a minute before the start asked for when the provider
   * counts in whole minutes, to the end asked for, where the stream stops.
   */
  readonly archive?: ArchiveWindow;
}

/**
 * A movie or episode ready to play. The player asks `url` for the picture and sound from a
 * position, with a chosen sound track and optionally a subtitle track:
 * `${url}?start=<seconds>&audio=<id>&subtitle=<id>`. Each request starts again from its position
 * and replaces the one before, so seeking and changing tracks never hold two provider
 * connections. The answer is fragmented MP4; its `x-start` header says at which second of the
 * title its first frame sits. With `only=subtitles` the same address answers the subtitle
 * track's feed instead, which the player reads before it asks for the picture: see
 * `@mrstreamer/core/subtitles/feed`.
 */
export interface TitleSession {
  readonly sessionId: string;
  readonly title: TitleRef;
  /** Loopback URL. Carries no credentials. */
  readonly url: string;
  /** Seconds, or null when the file does not say. */
  readonly duration: number | null;
  /** Sound tracks in the file's order. */
  readonly audio: readonly AudioTrack[];
  /** Subtitle tracks in the file's order, whatever their format. */
  readonly subtitles: readonly SubtitleTrack[];
}

/**
 * A stretch of a channel's past, in epoch milliseconds, to play from the provider's catch-up
 * archive: a programme from its start, or from where playback reached in it. `end` may lie ahead
 * for a programme still on; the provider sends what it has.
 */
export interface ArchiveWindow {
  readonly start: number;
  readonly end: number;
}

/**
 * Which of a channel's streams a live session plays. Auto tries the next stream when the provider
 * doesn't deliver one; a chosen stream is the only one tried.
 */
export interface LivePlaying {
  /** The stream that plays, by id, or null while none has started or when none could. */
  readonly variantId: string | null;
  /** The streams tried before it, in order, with why the provider didn't deliver them. */
  readonly failed: readonly { readonly variantId: string; readonly failure: StreamFailure }[];
}

/**
 * The sound and subtitle tracks of a playing channel: from its program table, or for an HLS
 * stream from what its playlists declare and the captions its picture carries.
 */
export interface ChannelTracks {
  readonly audio: readonly AudioTrack[];
  readonly subtitles: readonly SubtitleTrack[];
  /**
   * The sound track the stream plays, by id: the one asked for, else the one in the viewer's
   * language, else the channel's first or the stream's default. Null when the channel has none,
   * or declares none.
   */
  readonly playing: number | null;
}

export interface AudioTrack {
  /**
   * The track's number in a file, its PID in a channel, or for an HLS stream's rendition a number
   * worked out from what the playlist declares about it, the same whenever the channel lists it;
   * pass it back to choose it.
   */
  readonly id: number;
  /** ISO 639 language code as the file names it, or null. */
  readonly language: string | null;
  /** "English · 5.1" */
  readonly label: string;
  /** The file marks it as the one to play by default. */
  readonly default: boolean;
}

/**
 * How subtitles are carried. `text`: lines the player lays out, such as SubRip. `picture`:
 * images drawn over the picture, such as PGS, DVD and DVB subtitles. `teletext`: a teletext
 * subtitle page. `captions`: closed captions (CEA-608), inside the picture or as a track.
 */
export type SubtitleFormat = "text" | "picture" | "teletext" | "captions";

export interface SubtitleTrack {
  /**
   * The track's number in a file, or its PID in a channel. Captions inside the picture use the
   * picture's. An HLS stream's rendition has a number worked out from what the playlist declares
   * about it, the same whenever the channel lists it, and its caption channels share one no
   * rendition has.
   */
  readonly id: number;
  /**
   * Which of several in one track: a teletext page (888), a DVB subtitle page, or a caption
   * channel (1 for CC1). Null when the track holds one.
   */
  readonly page: number | null;
  readonly format: SubtitleFormat;
  readonly language: string | null;
  /** "Nederlands", "English · SDH", "Deutsch · Forced" */
  readonly label: string;
  /** Only for scenes in another language, such as signs and foreign dialogue. */
  readonly forced: boolean;
  readonly default: boolean;
}

/** Why the provider did not deliver a stream. */
export type StreamFailure =
  /** 401/403 and similar: wrong login, or every allowed connection is in use. */
  (
    | { readonly kind: "refused"; readonly status: number }
    /** 404/410: the channel has no stream right now. */
    | { readonly kind: "unavailable"; readonly status: number }
    | { readonly kind: "provider-error"; readonly status: number }
    /** No response before the timeout, or the connection dropped. */
    | { readonly kind: "network"; readonly detail: string }
    /** The stream arrived, but its format cannot be played or converted here. */
    | { readonly kind: "unsupported"; readonly detail: string }
  ) & { readonly diagnostic?: PlaybackDiagnostic };
