import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { GuideFailure } from "@mrstreamer/contracts/guide";
import type { OutputFailure } from "@mrstreamer/contracts/output";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { GUIDE_LIMITS } from "@mrstreamer/core/guide/limits";
import { formatDate, formatMebibytes, t } from "@mrstreamer/core/i18n";
import { isMac } from "../app/platform.ts";

/** The typed error behind a failed call, or an `unexpected` error for anything else. */
export function appError(cause: unknown): AppError {
  if (cause instanceof AppFailure) return cause.error;
  return { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };
}

/** One sentence the UI can show for an error. */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case "incomplete-login":
      return error.detail;
    case "invalid-login":
      return t("The provider rejected this username or password.");
    case "account-inactive":
      if (error.state === "expired" && error.expiresAt) {
        return t("This subscription expired on {date}.", {
          date: formatDate(Date.parse(error.expiresAt), "date"),
        });
      }
      return error.state === "expired"
        ? t("The provider reports this subscription as expired.")
        : error.state === "banned"
          ? t("The provider reports this subscription as banned.")
          : t("The provider reports this subscription as disabled.");
    case "unreachable":
      return `${t("Can't reach {server}.", { server: error.server.replace(/^https?:\/\//, "") })} ${error.detail}`;
    case "unencrypted-only":
      return t("{server} has no encrypted connection.", {
        server: URL.parse(error.server)?.hostname ?? error.server,
      });
    case "provider-error":
      return t("The provider answered with an error (HTTP {status}).", {
        status: String(error.status),
      });
    case "no-subscription":
      return t("No subscription is connected.");
    case "needs-secret":
      return t("This subscription needs its password or link again, in Settings.");
    case "keychain-refused":
      return isMac
        ? t(
            'The macOS Keychain would not store your password. Open Keychain Access, delete "Mr. Streamer Safe Storage", then quit and reopen Mr. Streamer.',
          )
        : t("Your system's keychain would not store your password.");
    case "channel-not-found":
      return t("This channel is no longer in the provider's list.");
    case "catch-up":
      return error.reason === "none"
        ? t("This channel has no catch-up.")
        : t("Catch-up on this channel goes back {count} days.", { count: error.days });
    case "title-not-found":
      return t("The provider no longer lists this title.");
    case "stream":
      return describeStreamFailure(error.failure);
    case "output":
      return describeOutputFailure(error.failure);
    case "guide":
      return describeGuideFailure(error.failure);
    case "favourites-changed":
      return t("Your favourites changed.");
    case "mark-changed":
      return t("This can no longer be undone.");
    case "incomplete-catalogue":
      if (error.list === "movies")
        return t("The provider sent no movies, so the previous list stays.");
      if (error.list === "series")
        return t("The provider sent no series, so the previous list stays.");
      return error.received === 0
        ? t("The provider sent an empty channel list, so the previous list stays.")
        : t("The provider sent {received} of {previous} channels, so the previous list stays.", {
            received: error.received,
            previous: error.previous,
          });
    case "invalid-input":
    case "unexpected":
      return t("Something went wrong: {detail}", { detail: error.detail });
  }
}

/** Why a movie or episode didn't open. */
function describeStreamFailure(failure: StreamFailure): string {
  switch (failure.kind) {
    case "refused":
      return t("The provider refused this title. Another device may be using your connection.");
    case "unavailable":
      return t("The provider has no file for this title right now.");
    case "provider-error":
      return t("The provider answered with an error (HTTP {status}).", {
        status: String(failure.status),
      });
    case "network":
      return `${t("The connection to the provider failed.")} ${failure.detail}`;
    case "unsupported":
      return `${t("Mr. Streamer can't play this file.")} ${failure.detail}`;
  }
}

/** Why a receiver on the network doesn't play. */
function describeOutputFailure(failure: OutputFailure): string {
  switch (failure.kind) {
    case "unreachable":
      return t("The receiver didn't answer.");
    case "not-fetched":
      return t(
        "The receiver couldn't reach this computer. Check that your firewall allows Mr. Streamer on private networks.",
      );
    case "media":
      return `${t("The receiver couldn't play this.")} ${failure.detail}`;
    case "no-network":
      return t("This computer isn't on a local network.");
    case "unavailable":
      return `${t("Mr. Streamer can't reach receivers right now.")} ${failure.detail}`;
    case "stream":
      return describeStreamFailure(failure.failure);
  }
}

/** Why a guide can't be used, or why a change to one didn't happen. */
function describeGuideFailure(failure: GuideFailure): string {
  switch (failure.kind) {
    case "address":
      return t("Enter the address of an XMLTV guide.");
    case "locked":
      return t("This guide needs its address again.");
    case "redirect":
      return failure.reason === "unencrypted"
        ? t("The address redirected to an unencrypted one, so Mr. Streamer stopped.")
        : t("The address redirected too many times.");
    case "not-xmltv":
      return t("The address answered, but not with an XMLTV guide.");
    case "incomplete":
      return t("The guide stopped before its end, or is damaged.");
    case "empty":
      return t("The guide lists no programmes.");
    case "ended":
      return t("Every programme in this guide has ended.");
    case "too-large":
      return t("This guide is larger than Mr. Streamer reads: {limit}.", {
        limit: tooLarge(failure.limit),
      });
    case "changed":
      return t("The guide changed meanwhile, so nothing was changed.");
    case "cancelled":
      return t("Stopped.");
  }
}

/** Which of the limits a guide is read under it is past, in the limit's own measure. */
function tooLarge(limit: Extract<GuideFailure, { kind: "too-large" }>["limit"]): string {
  switch (limit) {
    case "bytes":
      return t("over {size} unpacked", { size: formatMebibytes(GUIDE_LIMITS.bytes) });
    case "element":
      return t("one of its entries is over {size}", {
        size: formatMebibytes(GUIDE_LIMITS.elementBytes),
      });
    case "channels":
      return t("over {count} channels", { count: GUIDE_LIMITS.channels });
  }
}
