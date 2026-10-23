import type { Page } from "./app.ts";

/** Observe owned startup I/O before the entrypoint runs. No record bytes or paths leave main. */
export async function startupProbe(
  main: Page,
  profile: string,
  delayMs: number,
  expectedPid: number | undefined,
) {
  const paused = Promise.withResolvers<void>();
  const removePauseListener = main.on("Debugger.paused", () => paused.resolve());
  await main.send("Debugger.enable");
  const started = await main.send("Runtime.runIfWaitingForDebugger");
  if (started.error) throw new Error("Could not start owned debugger.");
  let pauseTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      paused.promise,
      new Promise<never>((_resolve, reject) => {
        pauseTimer = setTimeout(() => reject(new Error("Owned startup did not pause.")), 2000);
      }),
    ]);
  } finally {
    if (pauseTimer) clearTimeout(pauseTimer);
    removePauseListener();
  }
  // Awaiting a promise while paused prevents Node's inspector from answering. Installation is
  // synchronous, and must complete before resuming the entrypoint.
  const reply = await main.send(
    "Runtime.evaluate",
    {
      expression: `(${install.toString()})(${JSON.stringify(profile)},${delayMs})`,
      awaitPromise: false,
      returnByValue: true,
    },
    2000,
  );
  const result = reply.result as
    { result?: { value?: { pid?: unknown } }; exceptionDetails?: unknown } | undefined;
  const pid = result?.result?.value?.pid;
  if (reply.error || result?.exceptionDetails || typeof pid !== "number")
    throw new Error("Could not install owned startup probe.");
  if (pid !== expectedPid) throw new Error("Wrong main inspector process.");
  const resumed = await main.send("Debugger.resume");
  if (resumed.error) throw new Error("Could not resume owned startup.");
  await main.send("Debugger.disable");
  return {
    pid,
    read: () =>
      main.evaluate<ReturnType<typeof install>["operations"]>(
        "globalThis.__analyticsStartupIO.operations",
        2000,
      ),
    preferences: () =>
      main.evaluate<Pick<ReturnType<typeof install>, "preferenceReads" | "preferenceUpdates">>(
        "({preferenceReads:globalThis.__analyticsStartupIO.preferenceReads,preferenceUpdates:globalThis.__analyticsStartupIO.preferenceUpdates})",
        2000,
      ),
  };
}

function install(profile: string, delayMs: number) {
  if (
    !process.argv.includes(`--user-data-dir=${profile}`) ||
    !process.argv.includes("--enable-automation")
  )
    throw new Error("Startup probe requires the owned automated profile");
  const native = process.getBuiltinModule("fs");
  const fs = native.promises;
  const path = process.getBuiltinModule("path");
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const owned = normalize(native.realpathSync(profile));
  const matches = (value: unknown, directory: boolean) => {
    if (typeof value !== "string" || (!directory && path.basename(value) !== "analytics.json"))
      return false;
    try {
      return normalize(native.realpathSync(directory ? value : path.dirname(value))) === owned;
    } catch {
      return false;
    }
  };
  const operations: {
    operation: "read" | "directory" | "replace";
    startedMs: number;
    endedMs: number | null;
    code: string | null;
    format: 1 | 2 | null;
  }[] = [];
  const started = performance.now();
  const preferenceReads: { startedMs: number; enabled: boolean | null }[] = [];
  const preferenceUpdates: {
    startedMs: number;
    endedMs: number | null;
    requested: boolean | null;
    ok: boolean | null;
    error: string | null;
  }[] = [];
  const { ipcMain } = process.getBuiltinModule("module").createRequire(process.execPath)(
    "electron",
  ) as typeof import("electron");
  ipcMain.handle = new Proxy(ipcMain.handle, {
    apply(target, receiver, [channel, listener]: Parameters<typeof ipcMain.handle>) {
      if (channel !== "preferences.get" && channel !== "preferences.update")
        return Reflect.apply(target, receiver, [channel, listener]);
      return Reflect.apply(target, receiver, [
        channel,
        new Proxy(listener, {
          async apply(handler, context, args) {
            const sample = {
              startedMs: performance.now() - started,
              enabled: null as boolean | null,
            };
            const patch: unknown = args[1];
            const update = {
              startedMs: sample.startedMs,
              endedMs: null as number | null,
              requested:
                patch &&
                typeof patch === "object" &&
                "analyticsEnabled" in patch &&
                typeof patch.analyticsEnabled === "boolean"
                  ? patch.analyticsEnabled
                  : null,
              ok: null as boolean | null,
              error: null as string | null,
            };
            if (channel === "preferences.get" && preferenceReads.length < 32)
              preferenceReads.push(sample);
            if (channel === "preferences.update" && preferenceUpdates.length < 32)
              preferenceUpdates.push(update);
            const reply: unknown = await Reflect.apply(handler, context, args);
            update.endedMs = performance.now() - started;
            if (
              reply &&
              typeof reply === "object" &&
              "ok" in reply &&
              typeof reply.ok === "boolean"
            )
              update.ok = reply.ok;
            if (
              reply &&
              typeof reply === "object" &&
              "error" in reply &&
              reply.error &&
              typeof reply.error === "object" &&
              "detail" in reply.error &&
              reply.error.detail === "Analytics preference could not be saved."
            )
              update.error = reply.error.detail;
            if (
              reply &&
              typeof reply === "object" &&
              "value" in reply &&
              reply.value &&
              typeof reply.value === "object" &&
              "preferences" in reply.value &&
              reply.value.preferences &&
              typeof reply.value.preferences === "object" &&
              "analyticsEnabled" in reply.value.preferences &&
              typeof reply.value.preferences.analyticsEnabled === "boolean"
            )
              sample.enabled = reply.value.preferences.analyticsEnabled;
            return reply;
          },
        }),
      ]);
    },
  });
  let delayed = false;
  const observe = async (
    operation: "read" | "directory" | "replace",
    run: () => Promise<unknown>,
  ) => {
    const sample = {
      operation,
      startedMs: performance.now() - started,
      endedMs: null as number | null,
      code: null as string | null,
      format: null as 1 | 2 | null,
    };
    if (operations.length < 32) operations.push(sample);
    try {
      if (operation === "read" && delayMs && !delayed) {
        delayed = true;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
      const value = await run();
      if (
        operation === "read" &&
        (typeof value === "string" || Buffer.isBuffer(value)) &&
        Buffer.byteLength(value) <= 128 * 1024
      ) {
        try {
          const parsed: unknown = JSON.parse(value.toString());
          if (
            parsed &&
            typeof parsed === "object" &&
            "format" in parsed &&
            (parsed.format === 1 || parsed.format === 2)
          )
            sample.format = parsed.format;
        } catch {
          /* Invalid records stay unknown; never retain parse errors or values. */
        }
      }
      return value;
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : null;
      sample.code =
        typeof code === "string" &&
        ["ENOENT", "EPERM", "EACCES", "EBUSY", "EIO", "ENOSPC"].includes(code)
          ? code
          : "other";
      throw error;
    } finally {
      sample.endedMs = performance.now() - started;
    }
  };
  const wrap = <T extends (...args: never[]) => Promise<unknown>>(
    method: T,
    operation: "read" | "directory" | "replace",
    argument: number,
  ): T =>
    new Proxy(method, {
      apply(target, receiver, args: unknown[]) {
        const run = () => Reflect.apply(target, receiver, args) as Promise<unknown>;
        return matches(args[argument], operation === "directory") ? observe(operation, run) : run();
      },
    });
  fs.readFile = wrap(fs.readFile, "read", 0);
  fs.readdir = wrap(fs.readdir, "directory", 0);
  fs.rename = wrap(fs.rename, "replace", 1);
  process.getBuiltinModule("module").syncBuiltinESMExports();
  const probe = { operations, preferenceReads, preferenceUpdates, pid: process.pid };
  Object.assign(globalThis, { __analyticsStartupIO: probe });
  return probe;
}
