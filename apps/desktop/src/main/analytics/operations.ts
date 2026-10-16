import { appFailure, streamFailure, type AnalyticsFailure } from "@mrstreamer/contracts/analytics";
import type { DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { CheckFailure } from "@mrstreamer/contracts/updates";

// The playback classifiers live in contracts, shared with the iOS app.
export { appFailure, streamFailure };

export type OperationOutcome = "success" | "failed" | "interrupted";

/** A start returns its consent-bound terminal note. No request data crosses this port. */
export type OperationObserver = () => (
  outcome: OperationOutcome,
  failure?: AnalyticsFailure,
) => void;

export function downloadFailure(failure: DownloadFailure): AnalyticsFailure {
  switch (failure.kind) {
    case "disk-full":
    case "folder":
      return "disk";
    case "stream":
      return streamFailure(failure.failure);
    case "app":
      return appFailure(failure.error);
  }
}

export function checkFailure(failure: CheckFailure): AnalyticsFailure {
  switch (failure.kind) {
    case "offline":
      return "network";
    case "invalid":
      return "app";
    default:
      return "unavailable";
  }
}
