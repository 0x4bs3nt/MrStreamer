/** Main-process collection preference and availability. Identity is never returned to a renderer. */
export interface AnalyticsSettings {
  readonly enabled: boolean;
  /** Production configuration is absent until its project, region and disclosure are settled. */
  readonly transport: "unconfigured" | "local" | "production" | "unavailable";
}
