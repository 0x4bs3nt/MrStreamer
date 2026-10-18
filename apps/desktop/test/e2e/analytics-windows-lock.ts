import { spawn } from "node:child_process";
import { disposableRunner } from "./installed-upgrade-windows.ts";
import { relative, isAbsolute } from "node:path";
import { delay } from "./app.ts";

/** An owned PowerShell child holds a real OS delete-sharing denial, without ACL or admin changes. */
export async function windowsDeleteLock(profile: string) {
  const runner = disposableRunner();
  const under = relative(runner.temp, profile);
  if (!under || under.startsWith("..") || isAbsolute(under))
    throw new Error("Lock profile must be owned under RUNNER_TEMP");
  const script = `
$ErrorActionPreference='Stop'
$target=Join-Path $env:MR_STREAMER_LOCK_PROFILE 'analytics.json'
$handle=[IO.File]::Open($target,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try {
  [Console]::Out.WriteLine('locked'); [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'release') { throw 'Owner did not release its handle' }
} finally { $handle.Dispose() }
`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MR_STREAMER_LOCK_PROFILE: profile },
  });
  let stdout = "",
    stderr = "";
  let error: unknown;
  child.stdout.on("data", (part: Buffer) => {
    stdout += part.toString();
  });
  child.stderr.on("data", (part: Buffer) => {
    stderr += part.toString();
  });
  child.stdin.on("error", (cause) => {
    error ??= cause;
  });
  child.once("error", (cause) => {
    error = cause;
  });
  const close = async () => {
    child.stdin.end("release\n");
    const deadline = Date.now() + 4000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline)
      await delay(20);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      throw new Error("Owned file lock did not release");
    }
    if (error || child.exitCode !== 0 || child.signalCode !== null)
      throw new Error(`File lock failed: ${String(error ?? stderr)}`);
  };
  try {
    const deadline = Date.now() + 4000;
    while (!stdout.includes("locked") && !error && child.exitCode === null && Date.now() < deadline)
      await delay(20);
    if (!stdout.includes("locked"))
      throw new Error(`OS handle did not become ready: ${String(error ?? stderr)}`);
    return {
      ready: { pid: child.pid, profile, share: "ReadWrite without Delete", at: Date.now() },
      close,
    };
  } catch (cause) {
    await close().catch(() => undefined);
    throw cause;
  }
}
