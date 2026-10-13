import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const workflow = parse(readFileSync(".github/workflows/build-release.yml", "utf8")) as {
  jobs: { package: { steps: { name?: string; run?: string }[] } };
};
const check = workflow.jobs.package.steps.find(
  (step) => step.name === "Check the macOS signature",
)?.run;

const xcrun = `#!/usr/bin/env node
const fs = await import("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, args.join(" ") + "\\n");
if (process.env.FAIL_APP === "1" && args[2]?.endsWith(".app")) {
  process.stderr.write("The ticket is invalid. The validate action failed! Error 68.\\n");
  process.exitCode = 68;
} else {
  process.stdout.write("The validate action worked!\\n");
}
`;

describe.skipIf(process.platform === "win32")("Mac release ticket checks", () => {
  let directory: string;
  let calls: string;
  let app: string;
  let dmg: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "mrstreamer-mac-ticket-check-"));
    calls = join(directory, "calls.txt");
    app = join(directory, "dist/mac-arm64/Mr. Streamer.app");
    dmg = join(directory, "dist/release.dmg");
    mkdirSync(app, { recursive: true });
    writeFileSync(dmg, "notarized DMG bytes");
    const bin = join(directory, "bin");
    mkdirSync(bin);
    for (const [name, body] of [
      ["xcrun", xcrun],
      ["codesign", '#!/bin/sh\nprintf "TeamIdentifier=test-team\\nflags=0x10000(runtime)\\n"\n'],
      ["spctl", "#!/bin/sh\nexit 0\n"],
    ] as const) {
      const path = join(bin, name);
      writeFileSync(path, body);
      chmodSync(path, 0o755);
    }
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  const run = (directory: string, calls: string, failApp = false) =>
    spawnSync("bash", ["-e", "-o", "pipefail", "-c", check ?? "exit 99"], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
        TEAM_ID: "test-team",
        CALLS: calls,
        FAIL_APP: failApp ? "1" : "0",
      },
    });

  it("runs the app and DMG ticket checks through the new executable", () => {
    mkdirSync(join(directory, "scripts"));
    copyFileSync(
      "apps/desktop/scripts/stapler-ticket.ts",
      join(directory, "scripts/stapler-ticket.ts"),
    );
    const result = run(directory, calls);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual([
      "stapler validate dist/mac-arm64/Mr. Streamer.app",
      "stapler validate dist/release.dmg",
    ]);
  });

  it("keeps the original fail-closed checks for an older tested source", () => {
    const result = run(directory, calls, true);

    expect(result.status).toBe(68);
    expect(readFileSync(calls, "utf8").trim()).toBe(
      "stapler validate dist/mac-arm64/Mr. Streamer.app",
    );
  });

  it("stops on a rejected app ticket even when the helper exists", () => {
    mkdirSync(join(directory, "scripts"));
    copyFileSync(
      "apps/desktop/scripts/stapler-ticket.ts",
      join(directory, "scripts/stapler-ticket.ts"),
    );
    const result = run(directory, calls, true);

    expect(result.status).not.toBe(0);
    expect(readFileSync(calls, "utf8").trim()).toBe(
      "stapler validate dist/mac-arm64/Mr. Streamer.app",
    );
  });
});
