import { type } from "arktype";
import type { AppError } from "./errors.ts";
import type { Codec, StreamFailure } from "./playback.ts";
import { lazy, type Infer } from "./lazy.ts";

/** Only these screen-entry literals may cross the renderer collection boundary. */
export const analyticsFeatures = [
  "home",
  "live_tv",
  "movies",
  "series",
  "watchlist",
  "downloads",
  "search",
  "settings",
  "player",
  "details",
] as const;
export type AnalyticsFeature = (typeof analyticsFeatures)[number];

/** Main-process consent and availability. Identity is never returned to a renderer. */
export interface AnalyticsSettings {
  readonly enabled: boolean;
  /** Reports the selected transport without exposing capture configuration or identifiers. */
  readonly transport: "unconfigured" | "local" | "production" | "unavailable";
}

/** Fixed interactions. No content identifiers, search terms or preference values cross IPC. */
export const analyticsActions = [
  "channel_changed",
  "playlist_added",
  "playlist_removed",
  "playlist_refreshed",
  "epg_opened",
  "search_used",
  "favourite_added",
  "update_seen",
  "update_dismissed",
] as const;
export type AnalyticsAction = (typeof analyticsActions)[number];
export const analyticsSettings = [
  "interface_language",
  "audio_language",
  "subtitle_language",
  "title_language",
  "live_quality",
  "autoplay_next",
  "subtitle_look",
  "home_rows",
  "update_channel",
] as const;
export type AnalyticsSetting = (typeof analyticsSettings)[number];
export type AnalyticsPlaybackKind = "live" | "vod";
export type AnalyticsPlaybackState = "playing" | "paused" | "waiting" | "seeking" | "stopped";
export const analyticsFailures = [
  "network",
  "credentials",
  "unsupported",
  "disk",
  "unavailable",
  "app",
] as const;
export type AnalyticsFailure = (typeof analyticsFailures)[number];

/** Optional desktop facts only. No free text, codec strings, media or provider identifiers. */
export const PlaybackDiagnostic = lazy(() =>
  type({
    "diagnostic_stage?":
      "'open' | 'probe' | 'inspect' | 'convert' | 'decode' | 'deliver' | 'unknown'",
    "diagnostic_reason?":
      "'tool_missing' | 'tool_failed' | 'probe_failed' | 'malformed_input' | 'unsupported_input' | 'decode_rejected' | 'copy_rejected' | 'conversion_failed' | 'inspection_undetermined' | 'network' | 'provider_refused' | 'provider_unavailable' | 'unknown'",
    "diagnostic_container?": "'mpegts' | 'hls' | 'mp4' | 'matroska' | 'other' | 'unknown'",
    "diagnostic_delivery?": "'direct' | 'converted' | 'unknown'",
    "diagnostic_video_codec?": "'h264' | 'hevc' | 'mpeg2' | 'unknown'",
    "diagnostic_audio_codec?":
      "'aac' | 'mpeg_audio' | 'ac3' | 'eac3' | 'dts' | 'opus' | 'flac' | 'unknown'",
    "diagnostic_fallback?": "'none' | 'audio' | 'video' | 'repair' | 'unknown'",
  }).onUndeclaredKey("reject"),
);
export type PlaybackDiagnostic = Infer<typeof PlaybackDiagnostic>;

/** Only already classified codec facts enter the allowlist, never a decoder message. */
export function diagnosticCodecs(
  video: Codec | "unknown" | null,
  audio: Codec | "unknown" | null,
): PlaybackDiagnostic {
  return {
    diagnostic_video_codec:
      video === "h264" || video === "mpeg2"
        ? video
        : video === "hevc" || video === "hevc-10bit"
          ? "hevc"
          : "unknown",
    diagnostic_audio_codec:
      audio === "aac" || audio === "aac-pce" || audio === "aac-latm"
        ? "aac"
        : audio === "mp2" || audio === "mp3"
          ? "mpeg_audio"
          : audio === "ac3" ||
              audio === "eac3" ||
              audio === "dts" ||
              audio === "opus" ||
              audio === "flac"
            ? audio
            : "unknown",
  };
}

/** Main and renderer use typed upstream evidence before any engine-only classification. */
export function streamDiagnostic(failure: StreamFailure): PlaybackDiagnostic {
  if (failure.diagnostic) return failure.diagnostic;
  switch (failure.kind) {
    case "network":
      return { diagnostic_stage: "deliver", diagnostic_reason: "network" };
    case "refused":
      return { diagnostic_stage: "deliver", diagnostic_reason: "provider_refused" };
    case "provider-error":
    case "unavailable":
      return { diagnostic_stage: "deliver", diagnostic_reason: "provider_unavailable" };
    default:
      return { diagnostic_stage: "unknown", diagnostic_reason: "unknown" };
  }
}

export function appDiagnostic(error: AppError): PlaybackDiagnostic {
  if (error.kind === "stream") return streamDiagnostic(error.failure);
  if (error.kind === "output" && error.failure.kind === "stream")
    return streamDiagnostic(error.failure.failure);
  if (error.kind === "output") {
    if (error.failure.kind === "media")
      return { diagnostic_stage: "decode", diagnostic_reason: "decode_rejected" };
    if (
      error.failure.kind === "unreachable" ||
      error.failure.kind === "not-fetched" ||
      error.failure.kind === "no-network"
    )
      return { diagnostic_stage: "deliver", diagnostic_reason: "network" };
    return { diagnostic_stage: "unknown", diagnostic_reason: "unknown" };
  }
  if (error.kind === "unreachable")
    return { diagnostic_stage: "open", diagnostic_reason: "network" };
  if (error.kind === "provider-error")
    return { diagnostic_stage: "open", diagnostic_reason: "provider_unavailable" };
  return { diagnostic_stage: "open", diagnostic_reason: "unknown" };
}

export function streamFailure(failure: StreamFailure): AnalyticsFailure {
  switch (failure.kind) {
    case "network":
      return "network";
    case "unsupported":
      return "unsupported";
    case "refused":
      return failure.status === 401 || failure.status === 403 ? "credentials" : "unavailable";
    default:
      return "unavailable";
  }
}

/**
 * Only typed categories select a code. Messages, names, addresses and paths are never
 * copied. Shared by the desktop app and the iOS app.
 */
export function appFailure(error: AppError): AnalyticsFailure {
  switch (error.kind) {
    case "stream":
      return streamFailure(error.failure);
    case "invalid-login":
    case "account-inactive":
    case "needs-secret":
    case "keychain-refused":
      return "credentials";
    case "unreachable":
      return "network";
    case "provider-error":
    case "no-subscription":
    case "channel-not-found":
    case "title-not-found":
      return "unavailable";
    case "output":
      switch (error.failure.kind) {
        case "stream":
          return streamFailure(error.failure.failure);
        case "unreachable":
        case "not-fetched":
        case "no-network":
          return "network";
        case "media":
          return "unsupported";
        default:
          return "unavailable";
      }
    default:
      return "app";
  }
}

/** Ephemeral gameplay correlation only. Main mints runs, owns clocks and events. */
export const PlaybackControl = lazy(() =>
  type({
    control: "string.uuid",
    order: "number.integer > 0",
    ongoing: "boolean",
  }),
);
export type PlaybackControl = Infer<typeof PlaybackControl>;
