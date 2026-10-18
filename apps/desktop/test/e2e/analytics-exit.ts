import type { ChildProcess } from "node:child_process";

/** A forced cleanup is evidence of failure, even when it successfully removes the owned child. */
export async function closeNative(
  app: ChildProcess,
  close: () => Promise<unknown>,
  graceMs = 4000,
) {
  const started = Date.now();
  const alreadyExited = app.exitCode !== null || app.signalCode !== null;
  const wait = (ms: number) =>
    new Promise<boolean>((resolve) => {
      if (app.exitCode !== null || app.signalCode !== null) {
        resolve(true);
        return;
      }
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        app.off("exit", exit);
        resolve(exited);
      };
      const exit = () => finish(true);
      const timer = setTimeout(() => finish(false), ms);
      app.once("exit", exit);
    });
  let requestError: string | null = null;
  if (!alreadyExited)
    void Promise.resolve()
      .then(close)
      .catch((error: unknown) => {
        requestError = String(error);
      });
  const forced = !alreadyExited && !(await wait(Math.max(0, graceMs - (Date.now() - started))));
  if (forced) {
    app.kill("SIGKILL");
    if (!(await wait(3000))) throw new Error("Owned native app survived forced cleanup");
  }
  return {
    code: app.exitCode,
    signal: app.signalCode,
    forced,
    alreadyExited,
    requestError,
    wallMs: Date.now() - started,
  };
}
