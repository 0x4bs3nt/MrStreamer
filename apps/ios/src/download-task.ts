import { DownloadTask, File } from "expo-file-system";

// One transfer of a provider file to disk by expo-file-system's native `DownloadTask`, for
// downloads.ts. The bytes go from URLSession to the file without passing through JavaScript; this
// side hears progress and how the transfer ended.
//
// The task runs in a foreground URLSession (`sessionType: "foreground"`): it ends with the app's
// process, so no transfer goes on after a kill that the next launch couldn't see or cancel. Expo's
// background session would carry on, but registers nothing for its tasks after a relaunch: the
// finished file would be thrown away and the provider's connection held meanwhile. Pausing asks
// URLSession for resume data, which it gives only when the server allows a range and names the
// file (ETag or Last-Modified); resuming sends those back as `If-Range`, so a changed file comes
// whole from the start rather than appended.

export type TransferEnd =
  /** URLSession wrote every byte and moved the file to `destination`. */
  | { readonly kind: "complete"; readonly size: number }
  /**
   * Paused on request: `resumeData` when URLSession can go on from here. It names the request's
   * address, which carries the login, so it is a secret.
   */
  | { readonly kind: "paused"; readonly resumeData: string | null }
  /** Cancelled on request. */
  | { readonly kind: "cancelled" }
  /** The server answered `status`; nothing was moved into place. */
  | { readonly kind: "refused"; readonly status: number }
  /** The file couldn't be moved into place. */
  | { readonly kind: "folder"; readonly detail: string }
  /** The connection failed or broke; `detail` is the system's words, never the address. */
  | { readonly kind: "network"; readonly detail: string };

export interface TransferRequest {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly destination: File;
  /** Goes on from an earlier pause instead of asking from the start. */
  readonly resumeData: string | null;
  /** Bytes on disk so far, and the whole file's size, null until the server says. */
  readonly progress: (written: number, total: number | null) => void;
}

export interface Transfer {
  readonly ended: Promise<TransferEnd>;
  /** Asks the task to pause; `ended` answers `paused`, or how it ended first. */
  pause(): void;
  /**
   * Stops the task; `ended` answers `cancelled`, or how it ended first. Does nothing once the task
   * ended, so a caller still writing down a pause can cancel safely.
   */
  cancel(): void;
}

/** How expo-file-system's native code words its rejections, inside the message. */
const STATUS = /server returned HTTP (\d{3})/;
const MOVE = /Failed to move downloaded file/;

/** Starts a transfer at once. */
export function transfer(request: TransferRequest): Transfer {
  const options = {
    sessionType: "foreground" as const,
    ...(request.headers ? { headers: { ...request.headers } } : {}),
    onProgress: ({ bytesWritten, totalBytes }: { bytesWritten: number; totalBytes: number }) =>
      request.progress(bytesWritten, totalBytes >= 0 ? totalBytes : null),
  };
  const task = request.resumeData
    ? DownloadTask.fromSavable(
        {
          url: request.url,
          fileUri: request.destination.uri,
          isDirectory: false,
          resumeData: request.resumeData,
        },
        options,
      )
    : new DownloadTask(request.url, request.destination, options);
  let asked: "pause" | "cancel" | null = null;
  /**
   * Set once the native operation settled, before the handle is released. Expo still calls into
   * native code for a paused task's cancel, and a released handle rejects that call.
   */
  let over = false;
  const run = request.resumeData ? task.resumeAsync() : task.downloadAsync();
  const ended = run
    .then((file): TransferEnd => {
      // A cancel while a pause was answered settles as that pause; the caller asked for neither.
      if (asked === "cancel") return { kind: "cancelled" };
      if (file) return { kind: "complete", size: file.size ?? 0 };
      return { kind: "paused", resumeData: task.savable().resumeData ?? null };
    })
    .catch((cause: unknown): TransferEnd => {
      if (asked === "cancel") return { kind: "cancelled" };
      const message = cause instanceof Error ? cause.message : String(cause);
      const status = STATUS.exec(message)?.[1];
      if (status) return { kind: "refused", status: Number(status) };
      if (MOVE.test(message)) return { kind: "folder", detail: message };
      return { kind: "network", detail: message };
    })
    .finally(() => {
      over = true;
      task.release();
    });
  return {
    ended,
    pause() {
      if (asked || over) return;
      asked = "pause";
      try {
        task.pause();
      } catch {
        // Not active any more: `ended` says how it ended.
      }
    },
    cancel() {
      if (asked === "cancel" || over) return;
      asked = "cancel";
      task.cancel();
    },
  };
}
