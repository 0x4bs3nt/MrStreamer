// Failures the UI knows how to explain. Every IPC call resolves to a value or one of these.
import type { GuideFailure } from "./guide.ts";
import type { OutputFailure } from "./output.ts";
import type { StreamFailure } from "./playback.ts";

export type AppError =
  /** The login form is missing something, or the server address is not a URL. */
  | { readonly kind: "incomplete-login"; readonly detail: string }
  /** The provider rejected the username or password. */
  | { readonly kind: "invalid-login" }
  /** The login is valid but the account cannot stream. */
  | {
      readonly kind: "account-inactive";
      readonly state: "expired" | "banned" | "disabled";
      readonly expiresAt: string | null;
    }
  /** DNS failure, refused connection, timeout, or a server that is not an Xtream API. */
  | { readonly kind: "unreachable"; readonly server: string; readonly detail: string }
  /**
   * An address typed without http:// or https:// didn't work over https, `server`, so connecting
   * stopped before the login went out unencrypted. The UI asks before trying it with http://.
   */
  | { readonly kind: "unencrypted-only"; readonly server: string }
  /** The provider answered with an HTTP status the app does not expect. */
  | { readonly kind: "provider-error"; readonly status: number }
  | { readonly kind: "no-subscription" }
  /**
   * The subscription is saved, but its password or playlist link can no longer be read, so
   * nothing of it plays or refreshes until the viewer enters it again.
   */
  | { readonly kind: "needs-secret"; readonly subscriptionId: string }
  /** The system keychain would not store the password, or no longer gives it back. */
  | { readonly kind: "keychain-refused" }
  | { readonly kind: "channel-not-found"; readonly channelId: string }
  /**
   * A programme asked for from the provider's catch-up archive that it doesn't keep: the channel
   * has no catch-up (`none`), or the programme starts outside the `days` it keeps, including one
   * that hasn't started yet (`outside`).
   */
  | { readonly kind: "catch-up"; readonly reason: "none" }
  | { readonly kind: "catch-up"; readonly reason: "outside"; readonly days: number }
  /** A movie, series or episode the provider no longer lists. */
  | { readonly kind: "title-not-found"; readonly titleId: string }
  /** A stream couldn't be opened: the provider refused it, or it can't play. */
  | { readonly kind: "stream"; readonly failure: StreamFailure }
  /**
   * The provider sent no channels, or far fewer than before; or no movies or no series, where it
   * had some. Not twice in a row: the second time counts. The previous list stays.
   */
  | {
      readonly kind: "incomplete-catalogue";
      readonly received: number;
      readonly previous: number;
      /** Which list, when it isn't the channels. */
      readonly list?: "movies" | "series";
    }
  /**
   * A new order for the favourites was made from a list that no longer holds: a favourite was
   * added or removed since, the catalogue joined or split a channel's streams, or a subscription
   * with favourites went or took another's place. Nothing was saved; the UI reads the favourites
   * again.
   */
  | { readonly kind: "favourites-changed" }
  /**
   * An episode's mark can't be undone any more: the series was marked again, played or taken out
   * of Continue watching since. Nothing was changed.
   */
  | { readonly kind: "mark-changed" }
  /** A channel list that is no longer there: the viewer deleted it. Nothing was changed. */
  | { readonly kind: "no-list" }
  /** Another channel list has that name, apart from case and accents. Nothing was changed. */
  | { readonly kind: "list-name-taken" }
  /**
   * An order made from lists, or from a list's channels, that no longer hold: a list or a channel
   * was added or removed since, or a channel shown then no longer shows. Nothing was saved; the
   * UI reads the lists again.
   */
  | { readonly kind: "list-changed" }
  /** A receiver on the network didn't take what it was sent, or can't be reached. */
  | { readonly kind: "output"; readonly failure: OutputFailure }
  /** A programme guide that can't be used, or a change to one that no longer applies. */
  | { readonly kind: "guide"; readonly failure: GuideFailure }
  /** An IPC call carried input that failed validation. Indicates a UI bug. */
  | { readonly kind: "invalid-input"; readonly detail: string }
  | { readonly kind: "unexpected"; readonly detail: string };

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };

/** Thrown inside the main process to fail an IPC call with a specific AppError. */
export class AppFailure extends Error {
  readonly error: AppError;

  constructor(error: AppError) {
    super(error.kind);
    this.name = "AppFailure";
    this.error = error;
  }
}
