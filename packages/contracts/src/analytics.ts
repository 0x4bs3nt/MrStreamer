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
