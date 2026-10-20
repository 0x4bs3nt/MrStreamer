// In-app updates and release channels, as the UI sees them.
import type { Channel } from "./version.ts";

/** Why a check found nothing, in terms the UI explains. */
export type CheckFailure =
  /** No connection, or the server didn't answer. */
  | { readonly kind: "offline" }
  /** GitHub is limiting requests from this network; `until` is when it allows them again. */
  | { readonly kind: "busy"; readonly until: number | null }
  /** The update server answered with an HTTP error. */
  | { readonly kind: "http"; readonly status: number }
  /** The answer wasn't an update list. */
  | { readonly kind: "invalid" };

/** Where the in-app update stands. Nothing downloads or restarts until the user asks. */
export type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "checking" }
  /** Nothing newer on the chosen channel. */
  | { readonly kind: "current" }
  | { readonly kind: "available"; readonly version: string }
  | { readonly kind: "downloading"; readonly version: string; readonly percent: number }
  /** Downloaded and checked; installs when the user confirms the restart. */
  | { readonly kind: "ready"; readonly version: string }
  /** A check the user asked for failed. Automatic checks fail quietly into `checked`. */
  | { readonly kind: "failed"; readonly step: "check"; readonly failure: CheckFailure }
  | {
      readonly kind: "failed";
      readonly step: "download" | "install";
      readonly version: string;
      readonly detail: string;
    };

/**
 * How this copy was installed, which decides who updates it. A direct copy came from the app's own
 * download, and the app updates it. A Store copy is an MSIX package, as the Microsoft Store
 * installs it: only the Store updates it, so the app never checks, downloads or installs, and
 * offers no channel. Pacman owns the files of an Arch package; upgrades use makepkg or an AUR
 * helper, and the app never updates that copy.
 */
export type Distribution = "direct" | "store" | "pacman";

/** An Arch package adds this file beside app.asar; signed direct/Homebrew apps have none. */
export const INSTALLATION_MARKER = "mrstreamer-installation.json";
export const PACMAN_INSTALLATION = { schema: 1, updates: "pacman" } as const;

/** Only direct copies use the in-app feed, channel and installer. */
export function updatesInApp(distribution: Distribution): boolean {
  switch (distribution) {
    case "direct":
      return true;
    case "store":
    case "pacman":
      return false;
  }
}

/** The release a check found for the chosen channel. */
export interface UpdateOffer {
  readonly version: string;
  /** The release notes, in Markdown, when the source has them. */
  readonly notes: string | null;
  /** The release's page, for reading more and downloading it by hand. */
  readonly page: string | null;
}

export interface UpdateStatus {
  /** The installed version. */
  readonly version: string;
  readonly distribution: Distribution;
  readonly channel: Channel;
  readonly update: UpdatePhase;
  /** What the last successful check offered; kept while later checks fail. */
  readonly offer: UpdateOffer | null;
  /** The last check, automatic or asked for, and why it failed if it did. */
  readonly checked: { readonly at: number; readonly failure: CheckFailure | null } | null;
  /** When the next automatic check runs, or null while none is planned. */
  readonly nextCheckAt: number | null;
  /** The version whose notice the viewer closed. Settings still offers it; a newer one notifies. */
  readonly dismissed: string | null;
}
