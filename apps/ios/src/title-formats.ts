import { AppFailure } from "@mrstreamer/contracts/errors";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { statusFailure } from "./errors.ts";

// Files AVPlayer can't open, such as Matroska, played through `modules/title-formats`: the
// native side reads the file, from the provider or from the phone, and serves it to AVPlayer as
// HLS on 127.0.0.1. For playback.ts, which owns the one session that may be open.
//
// A session reads the provider's file over one request at a time and holds the provider's
// connection until `closed` resolves, after `close` or a failure, whether or not it opened. One
// that opened says when it stops serving, which AVPlayer may not.

type NativeFailure =
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "network"; readonly detail: string }
  | { readonly kind: "unsupported"; readonly detail: string };

type NativeOpened =
  | { readonly kind: "session"; readonly playlist: string }
  | { readonly kind: "direct" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly failure: NativeFailure };

interface TitleFormatsModule {
  create(
    id: string,
    url: string,
    headers: Readonly<Record<string, string>> | null,
    start: number,
  ): void;
  open(id: string): Promise<NativeOpened>;
  close(id: string): void;
  closed(id: string): Promise<void>;
  failure(id: string): NativeFailure | null;
  /** The session's requests to the provider so far, without their address, for native proofs. */
  trace(id: string): readonly Readonly<Record<string, number | string>>[];
  /** Once per session that opened and then stopped serving, with what `failure` answers. */
  addListener(
    event: "onFailure",
    listener: (event: { readonly id: string; readonly failure: NativeFailure }) => void,
  ): { remove(): void };
}

/**
 * The native module, found where Expo installs every module before the app's JavaScript runs,
 * as `requireNativeModule` finds it first. Looked up on first use, so the tests, which run in
 * Node without Expo, load the player without it.
 */
function native(): TitleFormatsModule {
  const host: { expo?: { modules?: { TitleFormats?: TitleFormatsModule } } } = globalThis;
  const found = host.expo?.modules?.TitleFormats;
  if (!found) throw new Error("This build has no TitleFormats module.");
  return found;
}

function streamFailure(failure: NativeFailure): StreamFailure {
  return failure.kind === "status" ? statusFailure(failure.status) : failure;
}

export interface FormatSession {
  /** The loopback playlist to give AVPlayer. It carries no login. */
  readonly playlist: string;
  /** Why it stopped serving, if it did. */
  failure(): StreamFailure | null;
  /**
   * Resolves when it stops serving, as soon as it does: AVPlayer may only wait on a request that
   * failed, without an error. Never resolves for a session that closed first.
   */
  readonly failed: Promise<StreamFailure>;
}

export type Opened =
  | { readonly kind: "session"; readonly session: FormatSession }
  /** An MP4 or MOV, whatever its name said: AVPlayer opens the address itself. */
  | { readonly kind: "direct" };

let made = 0;

/**
 * Opens `url`, to play from `start` seconds: the stream says so, and the file is read there
 * first rather than at its start. `closed` resolves once the provider's request ended, which is before the session
 * answers for a file AVPlayer opens itself or that failed; `close` stops it at once. Rejects with
 * the stream's failure, or as aborted when `signal` aborted first.
 */
export function openFormat(
  url: string,
  headers: Readonly<Record<string, string>> | undefined,
  start: number,
  signal: AbortSignal,
): {
  readonly opened: Promise<Opened>;
  readonly close: () => void;
  readonly closed: Promise<void>;
} {
  const id = String(++made);
  // Listening from before the session exists, until it closed, for its own failure only.
  let stopped!: (failure: StreamFailure) => void;
  const failed = new Promise<StreamFailure>((resolve) => (stopped = resolve));
  const listening = native().addListener("onFailure", (event) => {
    if (event.id === id) stopped(streamFailure(event.failure));
  });
  native().create(id, url, headers ?? null, start);
  const closed = native().closed(id);
  void closed.then(() => listening.remove());
  const close = () => native().close(id);
  if (signal.aborted) close();
  else signal.addEventListener("abort", close, { once: true });
  const answer = native().open(id);
  const opened = answer.then((result): Opened => {
    if (signal.aborted || result.kind === "closed") throw signal.reason ?? new Error("closed");
    if (result.kind === "failed") {
      throw new AppFailure({ kind: "stream", failure: streamFailure(result.failure) });
    }
    if (result.kind === "direct") return result;
    const failure = () => {
      const found = native().failure(id);
      return found ? streamFailure(found) : null;
    };
    return { kind: "session", session: { playlist: result.playlist, failure, failed } };
  });
  return { opened, close, closed };
}
