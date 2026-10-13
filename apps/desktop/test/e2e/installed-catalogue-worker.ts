import { posix, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Compatible with the verified main Page. This adapter owns its three NodeWorker listeners. */
export interface MainTransport {
  /** Must settle and release request resources within timeoutMs, as the shared Page does. */
  send(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<{
    result?: unknown;
    error?: unknown;
  }>;
  on(method: string, listener: (params: unknown) => void): () => void;
}

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Evidence {
  at: string;
  kind: string;
  sessionId?: string;
  data: unknown;
}
export interface StartupPause {
  readonly sessionId: string;
  readonly workerURL: string;
  readonly frameURL: string;
  readonly startupScriptURLs: readonly string[];
  readonly frameURLSource: "entry" | "caller-allowlist";
  readonly callFrameId: string;
  readonly scriptId: string;
  readonly pid: number;
  readonly reason: "Break on start";
  readonly callFrame: Readonly<Record<string, unknown>>;
}
export interface ProbeOptions {
  main: MainTransport;
  /** Exact path or canonical file URL obtained by root from the actual hashed app.asar. */
  expectedWorker: string;
  /** Exact canonical dependency URLs derived by root from its hashed ASAR and static entry imports. */
  startupScriptURLs?: readonly string[];
  verifiedMainPID: number;
  /** Synchronous recording only; asynchronous sinks must be joined by the caller outside the probe. */
  evidence: (entry: Evidence) => undefined;
  timeoutMs?: number;
}

const installed = new WeakSet<MainTransport>();
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
function errorText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Install before root resumes main, then await ready. Observation never runs or resumes a worker.
 * Node 24 with inherited inspect-brk needs explicit runToStartupPause() to expose its startup break.
 * resumeStartup() is a separate explicit request and only resumes the currently verified startup pause.
 * Await close() before closing Page. It drains commands, disables NodeWorker and unregisters its listeners.
 */
export function installCatalogueWorkerProbe(options: ProbeOptions) {
  const { main, verifiedMainPID, evidence } = options;
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(verifiedMainPID) || verifiedMainPID <= 0)
    throw new Error("A verified owned main PID is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    throw new Error("timeoutMs must be between 1 and 60000");
  const windows = /^(?:[A-Za-z]:\\|file:\/\/\/[A-Za-z]:\/)/.test(options.expectedWorker);
  const { basename, dirname, isAbsolute, join, sep } = windows ? win32 : posix;
  const fromURL = (url: string) => fileURLToPath(url, { windows });
  const toURL = (path: string) => pathToFileURL(path, { windows });
  const workerPath = options.expectedWorker.startsWith("file:")
    ? fromURL(options.expectedWorker)
    : options.expectedWorker;
  const workerURL = toURL(workerPath).href;
  if (
    !isAbsolute(workerPath) ||
    !/^catalogue-worker-[A-Za-z0-9_-]+\.js$/.test(basename(workerPath)) ||
    !["resources", "Resources"].some((directory) =>
      dirname(workerPath).endsWith(`${sep}${join(directory, "app.asar", "out", "main")}`),
    ) ||
    (options.expectedWorker.startsWith("file:") && options.expectedWorker !== workerURL) ||
    fromURL(workerURL) !== workerPath
  )
    throw new Error("Expected worker must be an exact canonical packaged catalogue-worker path");
  const startupScriptURLs = Object.freeze([...(options.startupScriptURLs ?? [])]);
  if (new Set([workerURL, ...startupScriptURLs]).size !== startupScriptURLs.length + 1)
    throw new Error("Startup script allowlist must be unique and exclude the entry");
  for (const url of startupScriptURLs) {
    if (!url.startsWith("file:"))
      throw new Error("Startup script allowlist requires canonical file URLs");
    const path = fromURL(url);
    if (
      toURL(path).href !== url ||
      dirname(path) !== dirname(workerPath) ||
      !/^[A-Za-z0-9_.-]+\.js$/.test(basename(path))
    )
      throw new Error(
        "Startup script allowlist must name exact canonical JS files beside the worker entry",
      );
  }
  const allowedStartupScripts = new Set([workerURL, ...startupScriptURLs]);
  if (installed.has(main)) throw new Error("This Page already has a catalogue worker probe");
  installed.add(main);

  let closed = false;
  let active = false;
  let sessionId: string | undefined;
  let nextId = 1;
  let pause: Record<string, unknown> | undefined;
  let startup: StartupPause | undefined;
  let resumed = false;
  let controlling = false;
  let debuggerReady: Promise<Outcome<Record<string, unknown>>> | undefined;
  const errors: string[] = [];
  const scripts = new Map<string, string>();
  const tasks = new Set<Promise<unknown>>();
  const waiters = new Set<() => void>();
  const pending = new Map<
    number,
    {
      finish: (reply: Record<string, unknown>) => void;
      fail: (error: Error) => void;
    }
  >();
  const unsubscribe: (() => void)[] = [];
  let enabled = false;
  let closing: Promise<ReturnType<typeof state>> | undefined;
  const wake = () => {
    for (const notify of [...waiters]) notify();
  };
  function fail(error: unknown) {
    errors.push(errorText(error));
    wake();
  }
  function record(kind: string, data: unknown) {
    const entry: Evidence = {
      at: new Date().toISOString(),
      kind,
      data,
      ...(sessionId === undefined ? {} : { sessionId }),
    };
    try {
      evidence(entry);
    } catch (error) {
      fail(error);
    }
  }

  function task<T>(work: () => Promise<T>): Promise<Outcome<T>> {
    const promise = Promise.resolve()
      .then(work)
      .then(
        (value): Outcome<T> => ({ ok: true, value }),
        (error: unknown): Outcome<T> => {
          fail(error);
          return { ok: false, error: errorText(error) };
        },
      );
    tasks.add(promise);
    void promise.then(() => {
      tasks.delete(promise);
      wake();
    });
    return promise;
  }
  function assertActive() {
    if (closed || !active || !sessionId) throw new Error("Catalogue worker session is not active");
    if (errors.length) throw new Error(errors[0]);
    return sessionId;
  }
  async function mainSend(method: string, params: Record<string, unknown>) {
    const reply = await main.send(method, params, timeoutMs);
    record("main-reply", { method, reply });
    if (reply.error !== undefined) throw new Error(`${method}: ${errorText(reply.error)}`);
    if (!object(reply.result)) throw new Error(`${method}: missing protocol result`);
    return reply.result;
  }

  async function workerSend(method: string, params: Record<string, unknown> = {}) {
    const ownedSession = assertActive();
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = new Promise<Record<string, unknown>>((resolve, reject) => {
      timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} worker reply timed out`));
      }, timeoutMs);
      pending.set(id, {
        finish: (message) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(message);
        },
        fail: (error) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        },
      });
    });
    const message = { id, method, params };
    record("worker-command", message);
    // Both the outer delivery acknowledgement and the inner reply are required. Replies can arrive first.
    const delivery = mainSend("NodeWorker.sendMessageToWorker", {
      sessionId: ownedSession,
      message: JSON.stringify(message),
    }).catch((error: unknown) => {
      pending.get(id)?.fail(new Error(errorText(error)));
      throw error;
    });
    try {
      const [delivered, replied] = await Promise.allSettled([delivery, reply]);
      if (delivered.status === "rejected") throw delivered.reason;
      if (replied.status === "rejected") throw replied.reason;
      const messageReply = replied.value;
      if (messageReply.error !== undefined)
        throw new Error(`${method}: ${errorText(messageReply.error)}`);
      if (!object(messageReply.result)) throw new Error(`${method}: missing worker result`);
      return messageReply.result;
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  }
  async function pausedPID(frameId: string) {
    const reply = await workerSend("Debugger.evaluateOnCallFrame", {
      callFrameId: frameId,
      expression: "process.pid",
      returnByValue: true,
      silent: true,
      throwOnSideEffect: true,
    });
    if (
      reply.exceptionDetails !== undefined ||
      !object(reply.result) ||
      reply.result.type !== "number" ||
      reply.result.value !== verifiedMainPID
    )
      throw new Error("Paused worker process.pid does not match the verified owned main PID");
    return verifiedMainPID;
  }
  async function verifyPause(current: Record<string, unknown>) {
    if (current.reason !== "Break on start") return;
    const frames = current.callFrames;
    const frame = Array.isArray(frames) ? frames[0] : undefined;
    if (
      !object(frame) ||
      typeof frame.callFrameId !== "string" ||
      !object(frame.location) ||
      typeof frame.location.scriptId !== "string"
    )
      throw new Error("Invalid startup callframe");
    const scriptId = frame.location.scriptId;
    const parsedURL = scripts.get(scriptId);
    // V8 often leaves callFrame.url empty. scriptParsed is authoritative for that same scriptId.
    const frameURL = frame.url;
    if (
      typeof parsedURL !== "string" ||
      !allowedStartupScripts.has(parsedURL) ||
      (typeof frameURL === "string" && frameURL !== "" && frameURL !== parsedURL)
    )
      throw new Error(
        "Startup callframe is not the exact catalogue worker script or a caller-listed startup script",
      );
    const pid = await pausedPID(frame.callFrameId);
    const ownedSession = assertActive();
    if (pause !== current) throw new Error("Startup pause changed during verification");
    if (scripts.get(scriptId) !== parsedURL)
      throw new Error("Startup script changed during verification");
    startup = Object.freeze({
      sessionId: ownedSession,
      workerURL,
      callFrameId: frame.callFrameId,
      scriptId,
      pid,
      frameURL: parsedURL,
      startupScriptURLs,
      frameURLSource: parsedURL === workerURL ? "entry" : "caller-allowlist",
      reason: "Break on start",
      callFrame: Object.freeze({ ...frame }),
    });
    record("verified-startup-pause", startup);
    wake();
  }
  function listen(method: string, callback: (params: Record<string, unknown>) => void) {
    unsubscribe.push(
      main.on(method, (params) => {
        if (closed) return;
        try {
          if (!object(params)) throw new Error(`Malformed ${method}`);
          callback(params);
        } catch (error) {
          fail(error);
        }
      }),
    );
  }
  listen("NodeWorker.receivedMessageFromWorker", (params) => {
    if (params.sessionId !== sessionId || !active) return;
    if (typeof params.message !== "string") throw new Error("Malformed worker message");
    const message: unknown = JSON.parse(params.message);
    if (!object(message)) throw new Error("Worker message must be an object");
    record("worker-message", message);
    if (typeof message.id === "number") {
      pending.get(message.id)?.finish(message);
      return;
    }
    if (typeof message.method !== "string" || !object(message.params))
      throw new Error("Malformed worker event");
    const event = message.params;
    if (message.method === "Debugger.scriptParsed") {
      if (typeof event.scriptId === "string" && typeof event.url === "string")
        scripts.set(event.scriptId, event.url);
    } else if (message.method === "Debugger.paused") {
      pause = event;
      startup = undefined;
      void task(() => verifyPause(event));
      wake();
    } else if (message.method === "Debugger.resumed") {
      pause = undefined;
      startup = undefined;
      wake();
    }
  });
  listen("NodeWorker.detachedFromWorker", (params) => {
    if (params.sessionId !== sessionId) return;
    record("worker-detached", params);
    active = false;
    pause = undefined;
    startup = undefined;
    for (const request of [...pending.values()]) request.fail(new Error("Owned worker detached"));
    wake();
  });
  listen("NodeWorker.attachedToWorker", (params) => {
    record("worker-attached", params);
    if (
      !object(params.workerInfo) ||
      params.workerInfo.url !== workerURL ||
      params.workerInfo.type !== "worker"
    )
      return;
    if (typeof params.sessionId !== "string" || !params.sessionId)
      throw new Error("Invalid catalogue worker sessionId");
    if (sessionId !== undefined)
      throw new Error("A second exact catalogue worker attachment is ambiguous");
    sessionId = params.sessionId;
    active = true;
    debuggerReady = task(() => workerSend("Debugger.enable"));
    wake();
  });
  const ready = task(async () => {
    if (closed) throw new Error("Probe closed before NodeWorker.enable");
    record("node-worker-enable", {
      waitForDebuggerOnStart: false,
      workerURL,
      verifiedMainPID,
      startupScriptURLs,
    });
    enabled = true;
    await mainSend("NodeWorker.enable", { waitForDebuggerOnStart: false });
  });

  function state() {
    return {
      closed,
      active,
      sessionId,
      workerURL,
      verifiedMainPID,
      startupScriptURLs,
      startup,
      resumed,
      pendingCommands: pending.size,
      pendingTasks: tasks.size,
      errors: [...errors],
    };
  }
  async function waitFor(check: () => boolean, waitMs: number) {
    if (check() || closed || errors.length) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        waiters.delete(notify);
        resolve();
      };
      const notify = () => {
        if (check() || closed || errors.length) done();
      };
      const timer = setTimeout(done, waitMs);
      waiters.add(notify);
      notify();
    });
  }
  async function settle() {
    do {
      while (tasks.size) await Promise.all([...tasks]);
    } while (tasks.size);
    return state();
  }
  const observe = () =>
    task(async () => {
      await ready;
      await waitFor(() => startup !== undefined, timeoutMs);
      if (closed || errors.length) throw new Error(errors[0] ?? "Probe closed during observation");
      return startup
        ? { kind: "startup-pause" as const, startup }
        : { kind: "no-startup-pause" as const, attached: sessionId !== undefined, active };
    });

  /** Explicitly releases the worker's inspector wait. This can run code if inspect-brk was not inherited. */
  const runToStartupPause = () =>
    task(async () => {
      assertActive();
      if (controlling || resumed || pause) throw new Error("Worker startup control is unavailable");
      controlling = true;
      try {
        await debuggerReady;
        assertActive();
        await workerSend("Runtime.runIfWaitingForDebugger");
        await waitFor(
          () =>
            startup !== undefined ||
            (pause !== undefined && pause.reason !== "Break on start") ||
            !active,
          timeoutMs,
        );
        assertActive();
        if (!startup)
          throw new Error("No verified Break on start observed after releasing inspector wait");
        return startup;
      } finally {
        controlling = false;
      }
    });
  const resumeStartup = () =>
    task(async () => {
      assertActive();
      const verified = startup;
      const current = pause;
      if (controlling || resumed || !verified || !current || current.reason !== "Break on start")
        throw new Error("Only a verified current startup pause can be resumed");
      controlling = true;
      const check = () => {
        assertActive();
        if (startup !== verified || pause !== current)
          throw new Error("Startup pause changed before resume");
        if (
          sessionId !== verified.sessionId ||
          scripts.get(verified.scriptId) !== verified.frameURL
        )
          throw new Error("Startup session or script changed before resume");
      };
      try {
        await pausedPID(verified.callFrameId);
        check();
        await workerSend("Runtime.runIfWaitingForDebugger");
        check();
        await workerSend("Debugger.resume");
        resumed = true;
        record("startup-resumed", verified);
        return verified;
      } finally {
        controlling = false;
      }
    });
  /** Waits for the exact entry while the caller drives the UI that creates the worker. */
  const start = (attachmentTimeoutMs = 60_000) =>
    task(async () => {
      if (
        !Number.isSafeInteger(attachmentTimeoutMs) ||
        attachmentTimeoutMs < 1 ||
        attachmentTimeoutMs > 120_000
      )
        throw new Error("Invalid worker attachment deadline");
      const readyResult = await ready;
      if (!readyResult.ok) throw new Error(readyResult.error);
      await waitFor(() => active, attachmentTimeoutMs);
      assertActive();
      const readyDebugger = await debuggerReady;
      if (!readyDebugger?.ok)
        throw new Error(readyDebugger?.error ?? "Worker debugger unavailable");
      if (pause?.reason === "Break on start") {
        await waitFor(() => startup !== undefined || !active, timeoutMs);
        assertActive();
      }
      if (pause && !startup) throw new Error("Initial worker pause was not verified startup");
      // Node24 can report waitingForDebugger=false while inherited inspect-brk still waits.
      const initial = startup ? { ok: true as const, value: startup } : await runToStartupPause();
      if (!initial.ok) throw new Error(initial.error);
      const result = await resumeStartup();
      if (!result.ok) throw new Error(result.error);
      return result.value;
    });
  function close() {
    if (closing) return closing;
    const detachSession = active ? sessionId : undefined;
    closed = true;
    active = false;
    for (const request of [...pending.values()]) request.fail(new Error("Probe closed"));
    wake();
    closing = (async () => {
      try {
        await settle();
        if (detachSession) {
          try {
            await mainSend("NodeWorker.detach", { sessionId: detachSession });
          } catch (error) {
            fail(error);
          }
        }
        if (enabled) await mainSend("NodeWorker.disable", {});
      } catch (error) {
        fail(error);
      } finally {
        for (const remove of unsubscribe) {
          try {
            remove();
          } catch (error) {
            fail(error);
          }
        }
        installed.delete(main);
      }
      return state();
    })();
    return closing;
  }
  return { ready, observe, runToStartupPause, resumeStartup, start, state, settle, close };
}
