import type {
  AnalyticsAction,
  AnalyticsSetting,
  AnalyticsPlaybackKind,
  AnalyticsPlaybackState,
  AnalyticsFailure,
} from "@mrstreamer/contracts/analytics";

/** Ports expose fixed observations only. Transaction/service owners retain all private values. */
export interface UsageObservers {
  action(action: AnalyticsAction): () => void;
  setting(setting: AnalyticsSetting): () => void;
}
export interface RemotePlaybackObserver {
  state(state: AnalyticsPlaybackState): void;
  failure(failure: AnalyticsFailure): void;
  stop(): void;
}
export type RemotePlaybackObservers = (
  kind: AnalyticsPlaybackKind,
  control: string | null,
) => RemotePlaybackObserver;
