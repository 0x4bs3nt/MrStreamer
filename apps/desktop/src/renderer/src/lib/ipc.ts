import { AppFailure } from "@mrstreamer/contracts/errors";
import type {
  IpcArgs,
  IpcEvent,
  IpcEvents,
  IpcInput,
  IpcMethod,
  IpcOutput,
} from "@mrstreamer/contracts/ipc";

/** Calls the main process. Resolves with the result or throws `AppFailure` carrying a typed error. */
export async function call<M extends IpcMethod>(
  method: M,
  ...args: IpcArgs<M>
): Promise<IpcOutput<M>> {
  const result = await window.mrStreamer.invoke(method, ...args);
  if (!result.ok) throw new AppFailure(result.error);
  return result.value;
}

/** Subscribes to an event from the main process. Returns the unsubscribe function. */
export function listen<E extends IpcEvent>(
  event: E,
  listener: (payload: IpcEvents[E]) => void,
): () => void {
  return window.mrStreamer.on(event, listener);
}

/** TanStack owns the signal: a shared query is cancelled only after its last observer leaves. */
export async function searchCall<M extends "guide.search" | "guide.searchList">(
  method: M,
  input: IpcInput<M>,
  signal: AbortSignal,
  view: string,
): Promise<IpcOutput<M>> {
  if (signal.aborted) throw new DOMException("Search cancelled", "AbortError");
  const request = { view, id: crypto.randomUUID() };
  const cancel = () => {
    void call("guide.cancelSearch", request).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await window.mrStreamer.invoke(
      method,
      ...([{ ...input, request }] as IpcArgs<M>),
    );
    if (!result.ok) throw new AppFailure(result.error);
    return result.value;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
