import { requireNativeModule } from "expo";

// Transfers of provider files to disk by the app's own native owner, modules/background-downloads,
// for downloads.ts. It runs one background URLSession: a transfer goes on while the app is
// suspended, and after iOS ends the app's process, which the next launch finds again. The bytes go
// from URLSession to the file without passing through JavaScript.
//
// downloads.ts authorizes each request as an attempt of one download (`start`); the native side
// finishes only such an attempt, moving its file into `Documents/downloads/<id>/media.<ext>`, and
// writes down how it ended as a receipt. A receipt stays until it is acknowledged, after its
// download's record says what it means; `reconcile` answers what is still under way and every
// receipt not acknowledged, having first ended any request no attempt accounts for. Events are
// hints for the screens: what `reconcile` answers is what counts.
//
// Resume data stays on the native side, in the Keychain: a pause keeps it, and so does a request
// that broke, when URLSession gives any. A start goes on from it only when it was made for the very
// address given, which `If-Range` then checks against the provider's file. Nothing here holds an
// address once given; a receipt holds none, nor the system's words.

/** How an attempt ended. */
export type Outcome =
  /** Every byte is in its file; `expected` is the whole file's size the server announced. */
  | { readonly kind: "complete"; readonly size: number; readonly expected: number | null }
  /** Paused on request; it can go on when `resumable`. */
  | { readonly kind: "paused"; readonly resumable: boolean }
  /** Cancelled on request; its resume data went with it. */
  | { readonly kind: "cancelled" }
  /** The server answered `status`; nothing was moved into place. */
  | { readonly kind: "refused"; readonly status: number }
  /** The file couldn't be moved into its folder. */
  | { readonly kind: "folder" }
  /** The request broke: `code` in NSURLErrorDomain, or 0; it can go on when `resumable`. */
  | { readonly kind: "network"; readonly code: number; readonly resumable: boolean };

/** One attempt's ending, until it is acknowledged. */
export interface Receipt {
  readonly receipt: string;
  readonly attempt: string;
  /** The download it was an attempt of. */
  readonly id: string;
  readonly outcome: Outcome;
}

/** An attempt whose request may still be open; bytes as last heard in this process, if any. */
export interface Running {
  readonly attempt: string;
  readonly id: string;
  readonly received: number | null;
  readonly expected: number | null;
}

/** Bytes on disk so far, and the whole file's size, null until the server says. */
export interface Progress {
  readonly attempt: string;
  readonly received: number;
  readonly expected: number | null;
}

export interface StartRequest {
  readonly id: string;
  readonly attempt: string;
  /** The file's type, as the copy's file is named: `media.<ext>`. */
  readonly ext: string;
  /** The provider's address of the file, login included. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** Why the native side refused a command, as its rejection's `code` says. */
export type Refusal = "invalid" | "busy" | "unavailable" | "corrupt" | "keychain" | "folder";

interface Subscription {
  remove(): void;
}

interface BackgroundDownloads {
  /**
   * What is under way and every receipt not acknowledged, at one moment, once any request no
   * attempt accounts for has ended; `closed` counts those, which leave no receipt. Rejects while
   * its record can't be read.
   */
  reconcile(): Promise<{ running: Running[]; receipts: Receipt[]; closed: number }>;
  /**
   * Authorizes `attempt` and starts its request; answers whether it goes on from resume data.
   * The same attempt again answers as the first did. Rejects while an earlier attempt may still
   * have a request open, and when its download's folder isn't there.
   */
  start(request: StartRequest): Promise<boolean>;
  /** Answers once the attempt's request has ended; its receipt follows. */
  pause(attempt: string): Promise<void>;
  /**
   * Revokes the attempt, so it moves no file, and removes its download's resume data; answers
   * once its request has ended.
   */
  cancel(attempt: string): Promise<void>;
  /** Forgets receipts written down; other receipts stay. */
  acknowledge(receipts: readonly string[]): Promise<void>;
  /** Removes a download's resume data. */
  forgetResume(id: string): Promise<void>;
  /** Takes resume data an earlier build kept, unless the download has newer. */
  importResume(id: string, url: string, data: string): Promise<void>;
  addListener(event: "progress", listener: (progress: Progress) => void): Subscription;
  addListener(event: "receipt", listener: (receipt: Receipt) => void): Subscription;
}

export const transfers = requireNativeModule<BackgroundDownloads>("BackgroundDownloads");

const REFUSALS: Readonly<Record<string, Refusal>> = {
  ERR_DOWNLOADS_INVALID: "invalid",
  ERR_DOWNLOADS_BUSY: "busy",
  ERR_DOWNLOADS_UNAVAILABLE: "unavailable",
  ERR_DOWNLOADS_CORRUPT: "corrupt",
  ERR_DOWNLOADS_KEYCHAIN: "keychain",
  ERR_DOWNLOADS_FOLDER: "folder",
};

/** What a rejection of the native side says, or null when it isn't one of its refusals. */
export function refusalOf(cause: unknown): Refusal | null {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  return REFUSALS[code] ?? null;
}
