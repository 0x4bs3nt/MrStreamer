import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:timers/promises", () => ({ setTimeout: async () => undefined }));

const xcrun = `#!/usr/bin/env node
const fs = await import("node:fs");
const args = process.argv.slice(2);
const calls = fs.existsSync(process.env.STAPLE_CALLS) ? fs.readFileSync(process.env.STAPLE_CALLS, "utf8") : "";
const staples = calls.split("\\n").filter((line) => line === "staple").length;
const validations = calls.split("\\n").filter((line) => line === "validate").length;
fs.appendFileSync(process.env.STAPLE_CALLS, args[1] + "\\n");
if (args[0] === "notarytool") {
  process.stdout.write(JSON.stringify({ id: "accepted-id", status: "Accepted" }));
} else if (args[1] === "staple") {
  if (process.env.STAPLE_SCENARIO === "hang") {
    fs.writeFileSync(process.env.STAPLE_PID, String(process.pid));
    process.on("SIGTERM", () => {});
    setTimeout(() => {}, 120000);
  } else if (process.env.STAPLE_SCENARIO === "exhaust" ||
    (process.env.STAPLE_SCENARIO === "recover" && staples === 0)) {
    process.stderr.write('error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\\n');
    process.stderr.write("NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\\n");
    process.stderr.write("CloudKit's response is inconsistent with expections: (null)\\n");
    process.exitCode = 68;
  } else if (process.env.STAPLE_SCENARIO === "permanent") {
    process.stderr.write("The ticket is invalid. The staple and validate action failed! Error 68.\\n");
    process.exitCode = 68;
  } else if (process.env.STAPLE_SCENARIO === "other-network") {
    process.stderr.write("Error Domain=NSURLErrorDomain Code=-1005\\n");
    process.stderr.write("NSErrorFailingURLStringKey=https://example.com/unrelated\\n");
    process.exitCode = 68;
  } else {
    process.stdout.write("The staple and validate action worked!\\n");
  }
} else if (args[1] === "validate") {
  if (process.env.VALIDATE_SCENARIO === "hang") {
    fs.writeFileSync(process.env.STAPLE_PID, String(process.pid));
    process.on("SIGTERM", () => {});
    setTimeout(() => {}, 120000);
  } else if (process.env.VALIDATE_SCENARIO === "exhaust" ||
    (process.env.VALIDATE_SCENARIO === "recover" && validations === 0)) {
    process.stderr.write('error is Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."\\n');
    process.stderr.write("NSErrorFailingURLStringKey=https://api.apple-cloudkit.com/database/1/com.apple.gk.ticket-delivery/production/public/records/lookup\\n");
    process.exitCode = 68;
  } else if (process.env.VALIDATE_SCENARIO === "permanent") {
    process.stderr.write("The ticket is invalid. The validate action failed! Error 68.\\n");
    process.exitCode = 68;
  } else if (process.env.VALIDATE_SCENARIO === "other-network") {
    process.stderr.write("Error Domain=NSURLErrorDomain Code=-1005\\n");
    process.stderr.write("NSErrorFailingURLStringKey=https://example.com/unrelated\\n");
    process.exitCode = 68;
  } else {
    process.stdout.write("The validate action worked!\\n");
  }
}
`;

describe.skipIf(process.platform === "win32")("notarizing and stapling a release DMG", () => {
  let directory: string;
  let dmg: string;
  let calls: string;
  let staplePid: string;
  let metadata: string;
  let originalArgv: string[];
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mrstreamer-dmg-staple-"));
    dmg = join(directory, "release.dmg");
    calls = join(directory, "calls.txt");
    staplePid = join(directory, "stapler.pid");
    metadata = join(directory, "latest-mac.yml");
    const fakeXcrun = join(directory, "xcrun");
    writeFileSync(fakeXcrun, xcrun);
    chmodSync(fakeXcrun, 0o755);
    writeFileSync(dmg, "signed DMG bytes");
    writeFileSync(`${dmg}.blockmap`, "stale");
    writeFileSync(
      metadata,
      "files:\n  - url: release.dmg\n    sha512: old\n    size: 1\n    blockMapSize: 5\n",
    );
    originalArgv = process.argv;
    originalEnv = { ...process.env };
    process.argv = [process.argv[0] ?? "node", "notarize-dmg.ts", dmg];
    process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
    process.env.APPLE_API_KEY = join(directory, "fake-key.p8");
    process.env.APPLE_API_KEY_ID = "test-key";
    process.env.APPLE_API_ISSUER = "test-issuer";
    process.env.STAPLE_CALLS = calls;
    process.env.STAPLE_PID = staplePid;
    vi.resetModules();
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.env = originalEnv;
    rmSync(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const run = () => import("../scripts/notarize-dmg.ts");
  const commands = () => readFileSync(calls, "utf8").trim().split("\n");
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

  it("recovers a lost ticket connection and still validates and updates the release metadata", async () => {
    process.env.STAPLE_SCENARIO = "recover";
    await run();

    expect(commands()).toEqual(["submit", "staple", "staple", "validate"]);
    expect(readFileSync(metadata, "utf8")).toContain(
      `sha512: ${createHash("sha512").update(readFileSync(dmg)).digest("base64")}`,
    );
    expect(readFileSync(metadata, "utf8")).not.toContain("blockMapSize:");
    expect(() => readFileSync(`${dmg}.blockmap`)).toThrow();
  });

  it("rejects a permanent ticket failure immediately", async () => {
    process.env.STAPLE_SCENARIO = "permanent";
    await expect(run()).rejects.toThrow("staple failed for");
    expect(commands()).toEqual(["submit", "staple"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
    expect(readFileSync(`${dmg}.blockmap`, "utf8")).toBe("stale");
  });

  it("does not retry a lost connection outside ticket delivery", async () => {
    process.env.STAPLE_SCENARIO = "other-network";
    await expect(run()).rejects.toThrow("staple failed for");
    expect(commands()).toEqual(["submit", "staple"]);
  });

  it("stops after the bounded ticket-retrieval retry budget", async () => {
    process.env.STAPLE_SCENARIO = "exhaust";
    await expect(run()).rejects.toThrow("after 4 attempts: retry budget exhausted");
    expect(commands()).toEqual(["submit", "staple", "staple", "staple", "staple"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
  });

  it("stops a hanging stapler at the subprocess deadline", async () => {
    process.env.STAPLE_SCENARIO = "hang";
    const started = performance.now();
    await expect(run()).rejects.toThrow("staple failed for");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(70_000);
    expect(commands()).toEqual(["submit", "staple"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
    const pid = assertStaplerExited();
    console.log(`Ignored-SIGTERM stapler PID ${pid} absent after ${Math.round(elapsed)} ms.`);
  }, 75_000);

  it("recovers a lost validation lookup before changing release metadata", async () => {
    process.env.VALIDATE_SCENARIO = "recover";
    await run();

    expect(commands()).toEqual(["submit", "staple", "validate", "validate"]);
    expect(readFileSync(metadata, "utf8")).not.toContain("sha512: old");
    expect(() => readFileSync(`${dmg}.blockmap`)).toThrow();
  });

  it("rejects a permanent validation failure without retry or metadata changes", async () => {
    process.env.VALIDATE_SCENARIO = "permanent";
    await expect(run()).rejects.toThrow("validate failed for");
    expect(commands()).toEqual(["submit", "staple", "validate"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
    expect(readFileSync(`${dmg}.blockmap`, "utf8")).toBe("stale");
  });

  it("does not retry an unrelated validation network failure", async () => {
    process.env.VALIDATE_SCENARIO = "other-network";
    await expect(run()).rejects.toThrow("validate failed for");
    expect(commands()).toEqual(["submit", "staple", "validate"]);
  });

  it("fails after four lost validation lookups and leaves metadata untouched", async () => {
    process.env.VALIDATE_SCENARIO = "exhaust";
    await expect(run()).rejects.toThrow("after 4 attempts: retry budget exhausted");
    expect(commands()).toEqual([
      "submit",
      "staple",
      "validate",
      "validate",
      "validate",
      "validate",
    ]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
    expect(readFileSync(`${dmg}.blockmap`, "utf8")).toBe("stale");
  });

  it("kills validation that ignores SIGTERM and leaves metadata untouched", async () => {
    process.env.VALIDATE_SCENARIO = "hang";
    const started = performance.now();
    await expect(run()).rejects.toThrow("validate failed for");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(70_000);
    expect(commands()).toEqual(["submit", "staple", "validate"]);
    expect(readFileSync(metadata, "utf8")).toContain("sha512: old");
    const pid = assertStaplerExited();
    console.log(`Ignored-SIGTERM validation PID ${pid} absent after ${Math.round(elapsed)} ms.`);
  }, 75_000);
});
