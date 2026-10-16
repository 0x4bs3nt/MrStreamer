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
  /** This load stops reporting: replaced, moved or recovering. The logical run goes on. */
  stop(): void;
  /** The play ended for good: stopped by the viewer or the receiver, or played to its end. */
  end(): void;
}
export type RemotePlaybackObservers = (
  kind: AnalyticsPlaybackKind,
  control: string | null,
) => RemotePlaybackObserver;
