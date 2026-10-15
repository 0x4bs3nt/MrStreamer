import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { withoutAddresses } from "@mrstreamer/core/provider";

/** The typed error behind a failed call, or an `unexpected` error for anything else. */
export function appError(cause: unknown): AppError {
  if (cause instanceof AppFailure) return cause.error;
  return { kind: "unexpected", detail: cause instanceof Error ? cause.message : String(cause) };
}

/**
 * One sentence for the errors the iOS app meets so far, in the desktop app's words (its
 * renderer's lib/errors.ts), so both say the same and share their translations.
 */
export function describeError(error: AppError): string {
  switch (error.kind) {
    case "incomplete-login":
    case "invalid-input":
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
    case "provider-error":
      return t("The provider answered with an error (HTTP {status}).", {
        status: String(error.status),
      });
    case "keychain-refused":
      return t("Your system's keychain would not store your password.");
    case "channel-not-found":
      return t("This channel is no longer in the provider's list.");
    default:
      return error.kind === "unexpected" ? error.detail : error.kind;
  }
}

/**
 * `text` as the viewer may see it, for messages the native player writes: every address cut to
 * its origin (core's rule for provider messages), and each part of `login` gone however an
 * address spells it, should a message quote a path or query without its scheme.
 */
export function withoutLogin(text: string, login: readonly string[]): string {
  const spellings = login
    .filter((part) => part !== "")
    .flatMap((part) => [
      part,
      encodeURIComponent(part),
      new URLSearchParams({ part }).toString().slice("part=".length),
    ])
    // The longest first, so a part inside a longer spelling doesn't leave the rest behind.
    .toSorted((a, b) => b.length - a.length)
    .map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const shown = withoutAddresses(text);
  return spellings.length === 0 ? shown : shown.replace(new RegExp(spellings.join("|"), "gi"), "…");
}
