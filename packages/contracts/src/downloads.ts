// Movies and episodes downloaded to this computer, as the UI sees them. A download names the exact
// provider file it was made from, but a finished copy needs no subscription: it plays from disk,
// with its own details, artwork and progress, after its subscription expired or was removed. Paths,
// addresses and logins stay in the main process; artwork comes through the app's own scheme.
import type { AppError } from "./errors.ts";
import type { RawTitleRef } from "./ondemand.ts";
import type { AudioTrack, StreamFailure, SubtitleTrack } from "./playback.ts";

/** Why a download stopped before it finished. Retry starts it again. */
export type DownloadFailure =
  /** The disk has less room than the rest of the file needs; `needed` bytes when known. */
  | { readonly kind: "disk-full"; readonly needed: number | null }
  /** The app's downloads folder is gone or can't be written. */
  | { readonly kind: "folder"; readonly detail: string }
  /** The provider refused the file, doesn't have it, or the connection broke. */
  | { readonly kind: "stream"; readonly failure: StreamFailure }
  /** The subscription or its title couldn't be asked: no password, not listed, and the like. */
  | { readonly kind: "app"; readonly error: AppError };

/** Where a download is. */
export type DownloadStatus =
  /** Waiting for its turn: one download transfers at a time. */
  | { readonly kind: "queued" }
  /** Its subscription plays something, which has the provider's connection until it stops. */
  | { readonly kind: "waiting" }
  /**
   * The viewer paused it. It keeps its place in the queue and its partial file, and takes its
   * turn again only once resumed: playback ending never resumes it.
   */
  | {
      readonly kind: "paused";
      /** Bytes in its partial file, as last written down. */
      readonly received: number;
      /** The whole file's size, when the provider said. */
      readonly size: number | null;
    }
  | {
      readonly kind: "transferring";
      readonly received: number;
      /** The whole file's size, when the provider said. */
      readonly size: number | null;
      /** Bytes a second lately; null until measured. */
      readonly rate: number | null;
      /** The provider's file changed or couldn't be resumed, so it started again from the start. */
      readonly restarted: boolean;
    }
  | { readonly kind: "failed"; readonly failure: DownloadFailure }
  /** On this computer, ready to play. */
  | { readonly kind: "complete" }
  /** Finished, but its file is no longer in the app's folder. */
  | { readonly kind: "missing" };

/** One movie or episode in the queue or on this computer. */
export interface Download {
  readonly id: string;
  /** The provider's own ids of the exact file it was made from. */
  readonly title: RawTitleRef;
  /**
   * The saved subscription of the account it came from, as it is now; null once none is, after
   * it was removed. A finished copy plays either way.
   */
  readonly subscription: { readonly id: string; readonly name: string } | null;
  /** The movie's or the series' name to show. */
  readonly name: string;
  /** For episodes: its own name, without the series and numbers. */
  readonly episodeName: string | null;
  readonly year: number | null;
  /** Seconds, as the details said. */
  readonly duration: number | null;
  /** The language the title was made in, which "Original language" sound plays. */
  readonly originalLanguage: string | null;
  /** Local artwork addresses, of this app's own scheme; null when none was kept. */
  readonly posterUrl: string | null;
  /** A wide picture: an episode's still, or the movie's backdrop. */
  readonly wideUrl: string | null;
  /** Bytes on disk once complete, or the file's size once the provider said. */
  readonly size: number | null;
  readonly status: DownloadStatus;
  /** How far the copy was watched here, kept with it. */
  readonly progress: { readonly position: number; readonly duration: number } | null;
}

/**
 * Every download: the queue first, in the order it goes (the transfer under way, then the others
 * waiting their turn, paused ones in their place, then the failed ones), then the finished ones,
 * newest first.
 */
export interface DownloadList {
  readonly items: readonly Download[];
  /** Bytes the app's downloads take on this computer, partial ones included. */
  readonly bytes: number;
  /** Free bytes on the disk the downloads are kept on; null when it can't be read. */
  readonly free: number | null;
  /**
   * Unfinished downloads that ended with their subscription since the app started: the page says
   * so once, as the subscription went with them.
   */
  readonly ended: number;
}

/** What plays a downloaded copy: like a title session, of a file on this computer. */
export interface CopySession {
  readonly sessionId: string;
  readonly copy: string;
  /** Loopback URL. Carries no path. */
  readonly url: string;
  readonly duration: number | null;
  readonly audio: readonly AudioTrack[];
  readonly subtitles: readonly SubtitleTrack[];
  /**
   * How far the copy was watched as it opened, every save asked for before the open counted: what
   * Watch offline goes on from, though `downloads.changed` may not have told the window yet.
   */
  readonly progress: Download["progress"];
}

/** The artwork a download keeps: what `posterUrl` and `wideUrl` serve. */
export const DOWNLOAD_ARTWORK = ["poster", "wide"] as const;
export type DownloadArtwork = (typeof DOWNLOAD_ARTWORK)[number];

/** The app's own scheme for kept artwork: `mrstreamer://download/<id>/<poster|wide>`. */
export const ARTWORK_SCHEME = "mrstreamer";

export function artworkUrl(id: string, artwork: DownloadArtwork): string {
  return `${ARTWORK_SCHEME}://download/${encodeURIComponent(id)}/${artwork}`;
}
