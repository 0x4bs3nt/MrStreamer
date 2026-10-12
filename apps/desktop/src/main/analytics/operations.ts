import type { AppError } from "@mrstreamer/contracts/errors";
import type { DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import type { CheckFailure } from "@mrstreamer/contracts/updates";
import type { SummaryFailure, SummaryOutcome } from "./summary.ts";

/** A start returns its generation-bound terminal note. No request data crosses this port. */
export type OperationObserver = () => (outcome: SummaryOutcome, failure?: SummaryFailure) => void;

function streamFailure(failure: StreamFailure): SummaryFailure {
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

/** Only typed categories select a code. Messages, names, addresses and paths are never copied. */
export function appFailure(error: AppError): SummaryFailure {
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

export function downloadFailure(failure: DownloadFailure): SummaryFailure {
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

export function checkFailure(failure: CheckFailure): SummaryFailure {
  switch (failure.kind) {
    case "offline":
      return "network";
    case "invalid":
      return "app";
    default:
      return "unavailable";
  }
}
