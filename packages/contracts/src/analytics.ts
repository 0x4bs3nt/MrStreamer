/** Main-process collection preference and availability. Identity is never returned to a renderer. */
export interface AnalyticsSettings {
  readonly enabled: boolean;
  /** Reports the selected transport without exposing capture configuration or identifiers. */
  readonly transport: "unconfigured" | "local" | "production" | "unavailable";
}
