import { type } from "arktype";

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

/** Ephemeral gameplay correlation only. Main mints runs, owns clocks and counts. */
export const PlaybackControl = type({
  control: "string.uuid",
  order: "number.integer > 0",
  ongoing: "boolean",
});
export type PlaybackControl = typeof PlaybackControl.infer;
