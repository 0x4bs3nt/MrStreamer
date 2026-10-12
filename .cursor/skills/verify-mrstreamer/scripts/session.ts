// Shared ownership and process cleanup for the desktop and website verification helpers.
import { execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { Page } from "../../../../apps/desktop/test/e2e/app.ts";

/** Aggregate runs assign an empty evidence directory to each child; standalone runs stay unique. */
export async function evidenceDirectory(root: string, prefix: string) {
  const assigned = process.env["MR_STREAMER_VERIFICATION_OUTPUT"];
  if (assigned) {
    await mkdir(assigned, { recursive: true });
    return assigned;
  }
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

/** Exercise the real scenario's failure/finally path, never turn a failed result into a pass. */
export function injectedFailure(scenario: string) {
  if (process.env["MR_STREAMER_VERIFICATION_FAIL"] === scenario)
    throw new Error(`Intentionally failed required scenario: ${scenario}`);
}

export async function electronExecutable() {
  const desktop = fileURLToPath(new URL("../../../../apps/desktop/", import.meta.url));
  const require = createRequire(join(desktop, "package.json"));
  const directory = dirname(require.resolve("electron/package.json"));
  const binary = (await readFile(join(directory, "path.txt"), "utf8")).trim();
  const executable = join(directory, "dist", binary);
  await access(executable);
  return executable;
}

/** Ask the OS for an unused loopback port. Ownership is checked again against Electron's arguments. */
export async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No loopback port allocated.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Graceful quit first; escalation targets only the app or process group this run created. */
export async function stop(app: ChildProcess, page: Page | undefined) {
  const exited = () => app.exitCode !== null || app.signalCode !== null;
  if (exited()) return;
  if (page) await page.send("Browser.close").catch(() => undefined);
  else app.kill("SIGTERM");
  for (let i = 0; i < 40 && !exited(); i++) await delay(100);
  if (!exited() && app.pid) {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/PID", String(app.pid), "/T", "/F"]);
    else process.kill(-app.pid, "SIGKILL");
    for (let i = 0; i < 30 && !exited(); i++) await delay(100);
  }
  if (!exited()) throw new Error("Owned app did not exit; profile is retained for safe recovery.");
}
