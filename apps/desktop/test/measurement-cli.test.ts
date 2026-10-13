import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { MINIMUM_COMPARISON_SAMPLES } from "../scripts/measurement.ts";

const comparisonCli = resolve("apps/desktop/test/e2e/compare-builds.ts");

it("comparison CLI help describes its adequate default and one-pair offline mode", () => {
  const result = spawnSync(process.execPath, [comparisonCli, "--help"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain(`Defaults: ${MINIMUM_COMPARISON_SAMPLES} alternating rounds`);
  expect(result.stdout).toContain("Offline mode rechecks one pair");
});

// These executables exercise public process/metadata contracts, without Electron or an encoder.
it.skipIf(process.platform === "win32")(
  "comparison CLI retains the original failure and removes a signal-exited warmup profile",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "measurement-signal-contract-"));
    try {
      const executable = join(directory, "signalled-executable");
      const receipt = join(directory, "arguments.txt");
      const output = join(directory, "comparison");
      writeFileSync(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' "$$" "$@" > "$MR_STREAMER_FIXTURE_ARGUMENTS"\nkill -TERM "$$"\n',
        { mode: 0o755 },
      );
      const result = spawnSync(
        process.execPath,
        [comparisonCli, "--rounds", "1", "--runs", "1", "--output", output, executable, executable],
        {
          encoding: "utf8",
          env: { ...process.env, MR_STREAMER_FIXTURE_ARGUMENTS: receipt },
          timeout: 15_000,
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("The app exited (SIGTERM) before opening a window.");
      expect(result.stderr).not.toContain("unsettled top-level await");
      expect(result.stdout).toContain(`Retained comparison: ${output}`);
      expect(JSON.parse(readFileSync(join(output, "comparison.json"), "utf8"))).toMatchObject({
        status: "invalid-instrumentation",
        error: "Error: The app exited (SIGTERM) before opening a window.",
      });
      const [pid, ...args] = readFileSync(receipt, "utf8").trim().split("\n");
      const profile = args.find((arg) => arg.startsWith("--user-data-dir="))!.split("=")[1]!;
      expect(existsSync(profile)).toBe(false);
      expect(() => process.kill(Number(pid), 0)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it.skipIf(process.platform === "win32")(
  "app CLI records checkout metadata with a trailing app flag and cleans up its failed process",
  () => {
    const directory = mkdtempSync(join(tmpdir(), "measurement-metadata-contract-"));
    try {
      const executable = join(directory, "malformed-cdp.cjs");
      const output = join(directory, "app.json");
      writeFileSync(
        executable,
        `#!${process.execPath}
const http = require("node:http");
const port = Number(process.argv.find(arg => arg.startsWith("--remote-debugging-port=")).split("=")[1]);
http.createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify([{ type: "page", url: "fixture", webSocketDebuggerUrl: "invalid websocket URL" }]));
}).listen(port, "127.0.0.1");
`,
        { mode: 0o755 },
      );
      const appDirectory = join(directory, "built-app");
      // A small built-checkout fixture proves filename/hash metadata, not an actual product build.
      mkdirSync(join(appDirectory, "out/main"), { recursive: true });
      writeFileSync(join(appDirectory, "out/main/index.js"), "fixture main bundle");
      writeFileSync(join(appDirectory, "package.json"), JSON.stringify({ version: "fixture" }));
      const result = spawnSync(
        process.execPath,
        [
          resolve("apps/desktop/test/e2e/measure-app.ts"),
          "--runs",
          "1",
          "--json",
          output,
          executable,
          "--",
          appDirectory,
          "--use-mock-keychain",
        ],
        { encoding: "utf8", timeout: 25_000 },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      const raw = JSON.parse(readFileSync(output, "utf8"));
      expect(raw).toMatchObject({
        status: "invalid-instrumentation",
        environment: {
          buildMode: "built-checkout",
          appVersion: "fixture",
          buildHashScope: "out/main/index.js only",
          revisionScope: "measuring checkout HEAD; rebuild required",
          revision: expect.stringMatching(/^[0-9a-f]{40}$/),
          buildSha256: "3739c702241dac80e2fc3041b1783038aeb0fb3f5fd747d0c3919dfaf5f8ffee",
        },
        conditions: {
          installedSizeScope: "electron-runtime-folder only; unpackaged, excludes app output",
        },
      });
      expect(JSON.parse(readFileSync(`${output}.cleanup.json`, "utf8"))).toMatchObject({
        appExited: true,
        profileRemoved: true,
        providerServersClosed: true,
        activeProviderStreamCounters: [0],
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
