import { ipcMain, type WebContents } from "electron";
import { type } from "arktype";
import type { Result } from "@mrstreamer/contracts/errors";
import {
  ipcInputs,
  type IpcEvent,
  type IpcEvents,
  type IpcInput,
  type IpcMethod,
  type IpcOutput,
} from "@mrstreamer/contracts/ipc";
import { Diagnostics, outcomeOf } from "@mrstreamer/core/diagnostics";
import type { Failed } from "@mrstreamer/core/failure";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

/**
 * One handler per IPC method. `frame` associates observations with the current main frame only;
 * it is derived by main, never supplied by the renderer or captured. `Failed` answers a typed error.
 */
export type IpcHandlers = {
  readonly [M in IpcMethod]: (
    input: IpcInput<M>,
    frame: string | null,
  ) => Effect.Effect<IpcOutput<M>, Failed>;
};

/**
 * Registers every IPC method. Input is validated against its schema before the handler runs on
 * `run`, the main runtime, and any failure resolves to a typed error instead of a rejected promise.
 * Failed calls go to the diagnostics.
 */
export function registerIpc(
  run: <A>(effect: Effect.Effect<A, Failed>) => Promise<Exit.Exit<A, Failed>>,
  handlers: IpcHandlers,
  isTrusted: (sender: WebContents) => boolean,
): void {
  // Entries live only while an invocation runs. No renderer can address another sender/frame.
  const pending = new Map<WebContents, Map<string, AbortController>>();
  const cleanups = new Map<WebContents, () => void>();
  const requestKey = (frame: string, request: IpcInput<"guide.cancelSearch">) =>
    JSON.stringify([frame, request.view, request.id]);
  const track = (sender: WebContents, key: string) => {
    let requests = pending.get(sender);
    if (!requests) {
      requests = new Map();
      pending.set(sender, requests);
      sender.on("destroyed", stop);
      sender.on("render-process-gone", stop);
      sender.on("did-start-navigation", navigate);
      cleanups.set(sender, () => {
        sender.removeListener("destroyed", stop);
        sender.removeListener("render-process-gone", stop);
        sender.removeListener("did-start-navigation", navigate);
      });
    }
    const controller = new AbortController();
    requests.set(key, controller);
    function stop() {
      for (const controller of pending.get(sender)?.values() ?? []) controller.abort();
    }
    function navigate(details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) {
      if (details.isMainFrame && !details.isSameDocument) stop();
    }
    return {
      signal: controller.signal,
      done: () => {
        requests.delete(key);
        if (requests.size !== 0) return;
        pending.delete(sender);
        cleanups.get(sender)?.();
        cleanups.delete(sender);
      },
    };
  };
  for (const method of Object.keys(ipcInputs) as IpcMethod[]) {
    // TypeScript cannot pair `ipcInputs[method]` with `handlers[method]` inside a loop over all
    // methods, so the loop uses erased types. `IpcHandlers` keeps each handler fully typed.
    const schema: () => (data: unknown) => unknown = ipcInputs[method];
    const handler = handlers[method] as (
      input: unknown,
      frame: string | null,
    ) => Effect.Effect<unknown, Failed>;
    // Built on the method's first call, not while the app starts.
    let validate: ((data: unknown) => unknown) | null = null;

    ipcMain.handle(method, async (event, raw: unknown): Promise<Result<unknown>> => {
      if (
        !isTrusted(event.sender) ||
        (method.startsWith("analytics.") && event.senderFrame !== event.sender.mainFrame)
      ) {
        return {
          ok: false,
          error: { kind: "unexpected", detail: "IPC call from an unknown window." },
        };
      }
      validate ??= schema();
      const input = validate(raw);
      if (input instanceof type.errors) {
        return {
          ok: false,
          error: {
            kind: "invalid-input",
            detail: method.startsWith("analytics.")
              ? "Invalid analytics observation."
              : `${method}: ${input.summary}`,
          },
        };
      }
      const frame =
        event.senderFrame && event.senderFrame === event.sender.mainFrame
          ? `${event.senderFrame.processId}:${event.senderFrame.routingId}`
          : null;
      if (method === "guide.cancelSearch") {
        if (!frame)
          return {
            ok: false,
            error: { kind: "invalid-input", detail: "Search needs the main frame." },
          };
        const request = ipcInputs["guide.cancelSearch"]()(input);
        if (!(request instanceof type.errors))
          pending.get(event.sender)?.get(requestKey(frame, request))?.abort();
        return { ok: true, value: null };
      }
      let owned: ReturnType<typeof track> | undefined;
      if (
        (method === "guide.search" || method === "guide.searchList") &&
        typeof input === "object" &&
        input !== null &&
        "request" in input &&
        input.request !== undefined
      ) {
        const request = ipcInputs["guide.cancelSearch"]()(input.request);
        if (!frame || request instanceof type.errors)
          return {
            ok: false,
            error: { kind: "invalid-input", detail: "Search needs the main frame." },
          };
        const key = requestKey(frame, request);
        const requests = pending.get(event.sender);
        if (requests?.has(key) || (requests?.size ?? 0) >= 256)
          return {
            ok: false,
            error: {
              kind: "invalid-input",
              detail: "Search request already active or limit reached.",
            },
          };
        owned = track(event.sender, key);
      }
      let work = Effect.suspend(() => handler(input, frame));
      if (owned) {
        const { signal } = owned;
        const cancelled = Effect.callback<never>((resume) => {
          const stop = () => resume(Effect.interrupt);
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", stop));
        });
        // raceFirst waits for the interrupted handler's finalizers, including guide file holds.
        work = Effect.raceFirst(work, cancelled);
      }
      const exit = await run(
        work.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || closing(exit)
              ? Effect.void
              : Effect.map(Diagnostics, (diagnostics) =>
                  diagnostics.record({ op: "call", method, outcome: outcomeOf(exit) }),
                ),
          ),
        ),
      ).finally(() => owned?.done());
      if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
      const failed = Cause.findErrorOption(exit.cause);
      if (failed._tag === "Some") return { ok: false, error: failed.value.error };
      if (closing(exit)) return { ok: false, error: { kind: "unexpected", detail: "Closing." } };
      console.error(`[ipc] ${method} failed`, Cause.pretty(exit.cause));
      const cause = Cause.squash(exit.cause);
      const detail = cause instanceof Error ? cause.message : String(cause);
      return { ok: false, error: { kind: "unexpected", detail } };
    });
  }
}

/**
 * Pure interruption is expected for owned search cancellation and runtime shutdown. Neither
 * records a diagnostics failure or logs an unexpected exception.
 */
function closing(exit: Exit.Exit<unknown, unknown>): boolean {
  return Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
}

export function emit<E extends IpcEvent>(
  target: WebContents,
  event: E,
  payload: IpcEvents[E],
): void {
  if (!target.isDestroyed()) target.send(event, payload);
}
