import { createRequire } from "node:module";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Resolve the exact patched copy that electron-builder loads for signed Mac apps.
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve("electron-builder"));
const notarize = createRequire(builder.resolve("app-builder-lib"));
const { notarize: notarizeApp } = notarize("@electron/notarize") as {
  notarize: (options: {
    appPath: string;
    appleApiKey: string;
    appleApiKeyId: string;
    appleApiIssuer: string;
  }) => Promise<void>;
};

const fakeTool = `#!/usr/bin/env node
const fs = await import("node:fs");
const path = await import("node:path");
const tool = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const command = tool === "xcrun" ? (args[0] === "--find" ? "find" : args[1]) : tool;
const calls = fs.existsSync(process.env.STAPLE_CALLS) ? fs.readFileSync(process.env.STAPLE_CALLS, "utf8") : "";
const attempt = calls.split("\\n").filter((line) => line === "staple").length;
fs.appendFileSync(process.env.STAPLE_CALLS, command + "\\n");
if (command === "find") {
  process.stdout.write("/usr/bin/notarytool\\n");
} else if (command === "submit") {
  process.stdout.write(JSON.stringify({ id: "accepted-id", status: "Accepted" }));
} else if (command === "log") {
  process.stdout.write(JSON.stringify({ status: "Accepted", issues: null }));
} else if (command !== "staple") {
  process.exitCode = 0;
} else if (process.env.STAPLE_SCENARIO === "hang") {
  fs.writeFileSync(process.env.STAPLE_PID, String(process.pid));
  process.on("SIGTERM", () => {});
  setTimeout(() => {}, 120000);
} else if (process.env.STAPLE_SCENARIO === "exhaust" ||
  (process.env.STAPLE_SCENARIO === "recover" && attempt === 0)) {
  process.stderr.write('Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\\n');
  process.stderr.write("NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\\n");
  process.exitCode = 68;
} else if (process.env.STAPLE_SCENARIO === "permanent") {
  process.stderr.write("The ticket is invalid. Error 68.\\n");
  process.exitCode = 68;
} else if (process.env.STAPLE_SCENARIO === "other-network") {
  process.stderr.write("Error Domain=NSURLErrorDomain Code=-1005\\n");
  process.stderr.write("NSErrorFailingURLStringKey=https://example.com/unrelated\\n");
  process.exitCode = 68;
} else {
  process.stdout.write("The staple and validate action worked!\\n");
}
`;

describe.skipIf(process.platform === "win32")("stapling the notarized release app", () => {
  let directory: string;
  let appPath: string;
  let calls: string;
  let staplePid: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mrstreamer-app-staple-"));
    appPath = join(directory, "Mr. Streamer.app");
    calls = join(directory, "calls.txt");
    staplePid = join(directory, "stapler.pid");
    mkdirSync(appPath);
    for (const tool of ["xcrun", "codesign", "ditto"]) {
      const path = join(directory, tool);
      writeFileSync(path, fakeTool);
      chmodSync(path, 0o755);
    }
    originalEnv = { ...process.env };
    process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
    process.env.STAPLE_CALLS = calls;
    process.env.STAPLE_PID = staplePid;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
  });

  const commands = () => readFileSync(calls, "utf8").trim().split("\n");
  const attempts = () => commands().filter((command) => command === "staple").length;
  const submissions = () => commands().filter((command) => command === "submit").length;
  const assertStaplerExited = (): number => {
    const pid = Number(readFileSync(staplePid, "utf8"));
    expect(pid).toBeGreaterThan(0);
    let error: unknown;
    try {
      process.kill(pid, 0);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "ESRCH" });
    return pid;
  };
  const run = () =>
    notarizeApp({
      appPath,
      appleApiKey: join(directory, "fake-key.p8"),
      appleApiKeyId: "test-key",
      appleApiIssuer: "test-issuer",
    });

  async function runWithFastBackoff(): Promise<Error | undefined> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const outcome = run().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    // The public API starts asynchronous codesign, ditto and notary commands before stapling.
    const pump = setInterval(() => void vi.runOnlyPendingTimersAsync(), 10);
    try {
      return await outcome;
    } finally {
      clearInterval(pump);
    }
  }

  it("recovers the accepted app's lost CloudKit ticket connection", async () => {
    process.env.STAPLE_SCENARIO = "recover";
    expect(await runWithFastBackoff()).toBeUndefined();
    expect(attempts()).toBe(2);
    expect(submissions()).toBe(1);
  });

  it("rejects a permanent ticket failure without retrying", async () => {
    process.env.STAPLE_SCENARIO = "permanent";
    expect((await runWithFastBackoff())?.message).toContain("code: 68");
    expect(attempts()).toBe(1);
    expect(submissions()).toBe(1);
  });

  it("does not retry a lost connection outside ticket delivery", async () => {
    process.env.STAPLE_SCENARIO = "other-network";
    expect((await runWithFastBackoff())?.message).toContain("code: 68");
    expect(attempts()).toBe(1);
    expect(submissions()).toBe(1);
  });

  it("stops after four ticket-retrieval attempts", async () => {
    process.env.STAPLE_SCENARIO = "exhaust";
    expect((await runWithFastBackoff())?.message).toContain("retry budget exhausted");
    expect(attempts()).toBe(4);
    expect(submissions()).toBe(1);
  });

  it("kills a hanging stapler at the subprocess deadline", async () => {
    process.env.STAPLE_SCENARIO = "hang";
    const started = performance.now();
    await expect(run()).rejects.toThrow("code: unknown");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(70_000);
    expect(attempts()).toBe(1);
    expect(submissions()).toBe(1);
    const pid = assertStaplerExited();
    console.log(`Ignored-SIGTERM stapler PID ${pid} absent after ${Math.round(elapsed)} ms.`);
  }, 75_000);
});
