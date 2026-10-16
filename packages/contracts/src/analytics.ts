import { type } from "arktype";
import type { AppError } from "./errors.ts";
import type { StreamFailure } from "./playback.ts";
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
