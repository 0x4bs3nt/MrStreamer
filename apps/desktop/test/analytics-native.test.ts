import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeNative } from "./e2e/analytics-exit.ts";
import { analyticsOptions } from "./e2e/analytics-options.ts";
import { reconcileBodies } from "./e2e/analytics-native.ts";

const sha = "a".repeat(40);
describe("native telemetry verification CLI", () => {
  it("requires independent installed version/source pins without changing source workload defaults", () => {
    expect(analyticsOptions([])).toMatchObject({ native: false, volume: false, rollover: false });
    expect(analyticsOptions([]).slowStartup).toBe(false);
    expect(analyticsOptions(["--slow-startup"])).toMatchObject({
      native: false,
      slowStartup: true,
    });
    expect(() => analyticsOptions(["--native-telemetry", "--slow-startup"])).toThrow(
      "cannot change",
    );
    expect(() => analyticsOptions(["/installed/app"])).toThrow("requires");
    expect(() =>
      analyticsOptions(["--expected-version=0.0.16", "--expected-source=main", "/installed/app"]),
    ).toThrow("SHA");
    expect(
      analyticsOptions([
        "--expected-version=0.0.16",
        `--expected-source=${sha}`,
        "/installed/app",
        "--",
        "--no-sandbox",
      ]),
    ).toMatchObject({
      executable: "/installed/app",
      expectedVersion: "0.0.16",
      expectedSource: sha,
      appArgs: ["--no-sandbox"],
      native: false,
    });
  });
  it("resolves both executable entry paths against the invoking directory", () => {
    expect(
      analyticsOptions([
        "--native-telemetry",
        "--expected-version=0.0.16",
        `--expected-source=${sha}`,
        "dist/candidate.AppImage",
        "--prior-executable=old/app",
        `--prior-source=${sha}`,
      ]),
    ).toMatchObject({
      executable: resolve("dist/candidate.AppImage"),
      priorExecutable: resolve("old/app"),
    });
  });
  it("retains a failed proof for a missing executable and starts a relative executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "analytics-cli-contract-"));
    const entry = fileURLToPath(new URL("./e2e/analytics-app.ts", import.meta.url));
    try {
      for (const [relative, native] of [
        ["missing.AppImage", false],
        ["present.AppImage", false],
        ["present.AppImage", true],
      ] as const) {
        if (relative === "present.AppImage")
          await writeFile(
            join(directory, relative),
            "#!/bin/sh\necho owned-launch-marker >&2\nexit 42\n",
            { mode: 0o700 },
          );
        const output = join(directory, relative + (native ? "-native" : "") + "-evidence");
        const child = spawn(
          process.execPath,
          [
            entry,
            "--expected-version=0.0.16",
            `--expected-source=${sha}`,
            ...(native ? ["--native-telemetry", "--native-case=consent"] : []),
            relative,
          ],
          {
            cwd: directory,
            env: { ...process.env, TMPDIR: directory, MR_STREAMER_VERIFICATION_OUTPUT: output },
            stdio: "pipe",
          },
        );
        child.stdout.resume();
        child.stderr.resume();
        const [code] = await once(child, "exit");
        expect(code).not.toBe(0);
        expect(JSON.parse(await readFile(join(output, "proof.json"), "utf8"))).toMatchObject({
          status: "failed",
          cleanup: { appExited: true, fixturesClosed: true, broadcastsExited: true },
        });
        if (native) {
          const proof = JSON.parse(await readFile(join(output, "proof.json"), "utf8"));
          expect(proof.error).toContain("code 42");
          expect(proof.observed.nativeCleanupErrors).toEqual([
            expect.stringContaining("Native quit was not graceful"),
          ]);
        }
        if (relative === "present.AppImage")
          expect(await readFile(join(output, "electron.log"), "utf8")).toContain(
            "owned-launch-marker",
          );
        else
          expect(JSON.parse(await readFile(join(output, "proof.json"), "utf8")).error).toContain(
            "ENOENT",
          );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("keeps expensive or installed compatibility options out of ordinary aggregate execution", () => {
    for (const flag of [
      "--native-case=periodic",
      "--native-case=windows-retry",
      "--installed-pair=/packages",
      "--prior-source=" + sha,
    ])
      expect(() => analyticsOptions([flag])).toThrow("require --native-telemetry");
    expect(() => analyticsOptions(["--native-telemetry", "--native-case=typo"])).toThrow(
      "Unknown native",
    );
    expect(() => analyticsOptions(["--native-telemetry", "--volume-workload"])).toThrow(
      "ordinary workload",
    );
    expect(() => analyticsOptions(["--native-telemetry", "--prior-executable=/old"])).toThrow(
      "together",
    );
  });
});
describe("Windows retry acceptance CLI", () => {
  it("requires the real Windows platform for its real-handle case", () => {
    const args = ["--native-telemetry", "--native-case=windows-retry"];
    if (process.platform === "win32")
      expect(analyticsOptions(args)).toMatchObject({ nativeCase: "windows-retry" });
    else expect(() => analyticsOptions(args)).toThrow("requires actual Windows");
  });
});
describe("ambiguous native HTTP delivery reconciliation", () => {
  const body = JSON.stringify({
    uuid: "play",
    timestamp: "2026-10-18T12:00:00Z",
    properties: { watch_duration_seconds: 8 },
  });
  it("counts byte-identical retries once while retaining the actual number of transmissions", () => {
    expect(reconcileBodies([body, body, body])).toEqual({ deliveries: 3, logicalEvents: 1 });
    expect(reconcileBodies([body, JSON.stringify({ uuid: "next" })])).toEqual({
      deliveries: 2,
      logicalEvents: 2,
    });
  });
  it("refuses the same UUID with a different timestamp, duration or serialized body", () => {
    for (const changed of [
      body.replace("12:00", "12:01"),
      body.replace(":8", ":9"),
      JSON.stringify(JSON.parse(body), null, 2),
    ])
      expect(() => reconcileBodies([body, changed])).toThrow("UUID changed");
  });
});

describe("native acceptance shutdown", () => {
  it("records a zero-code graceful exit and distinguishes forced cleanup", async () => {
    const start = async (script: string) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] });
      await once(child.stdout!, "data");
      return child;
    };
    const graceful = await start(
      "process.stdin.resume();process.stdin.on('end',()=>process.exit(0));console.log('ready')",
    );
    expect(
      await closeNative(
        graceful,
        async () => {
          graceful.stdin!.end();
        },
        1000,
      ),
    ).toMatchObject({
      code: 0,
      signal: null,
      forced: false,
      alreadyExited: false,
      requestError: null,
    });
    const hanging = await start("setInterval(()=>{},1000);console.log('ready')");
    expect(await closeNative(hanging, () => new Promise(() => {}), 50)).toMatchObject({
      forced: true,
      alreadyExited: false,
    });
  });
});
