import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// The Windows installed upgrade check installs builds on a runner and reads releases and runs. It
// must stay a check: started by hand from main, able to read and nothing more, with GitHub's token
// in the one step that reads GitHub and no secret anywhere.

interface Step {
  readonly name?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly env?: Record<string, string>;
  readonly with?: Record<string, unknown>;
}

const text = readFileSync(".github/workflows/windows-installed-upgrade.yml", "utf8");
const workflow = parse(text) as {
  readonly on: {
    readonly workflow_dispatch: {
      readonly inputs: Record<
        string,
        {
          readonly type: string;
          readonly required: boolean;
          readonly default?: string;
          readonly options?: string[];
        }
      >;
    };
  };
  readonly permissions: Record<string, string>;
  readonly jobs: Record<
    string,
    { readonly if?: string; readonly permissions?: unknown; readonly steps: readonly Step[] }
  >;
};
const jobs = Object.values(workflow.jobs);

describe("the Windows installed upgrade check", () => {
  it("defaults old dispatches to legacy and lets either mode supply only its four pins", () => {
    const inputs = workflow.on.workflow_dispatch.inputs;
    expect(inputs["mode"]).toMatchObject({
      type: "choice",
      default: "legacy",
      options: ["legacy", "published-pair"],
    });
    for (const pin of [
      "a-tag",
      "a-sha",
      "b-run",
      "b-sha",
      "stable-tag",
      "stable-sha",
      "candidate-tag",
      "candidate-sha",
    ])
      expect(inputs[pin]).toMatchObject({ type: "string", required: false });
  });
  it("starts only by hand, from main of this repository", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    for (const job of jobs) {
      expect(job.if).toContain("github.repository == 'Mr-Streamer-OSS/MrStreamer'");
      expect(job.if).toContain(
        "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
      );
    }
  });

  // Execute the actual dispatch step with a recording CLI. Invalid selections must never call it.
  it.skipIf(process.platform === "win32").each([
    [
      "legacy",
      {
        A_TAG: "v0.0.10-nightly.20261010.282",
        A_SHA: "a".repeat(40),
        B_RUN: "900",
        B_SHA: "b".repeat(40),
      },
      "resolve",
      0,
    ],
    [
      "published-pair",
      {
        STABLE_TAG: "v0.0.11",
        STABLE_SHA: "a".repeat(40),
        CANDIDATE_TAG: "v0.0.12-nightly.20261013.330",
        CANDIDATE_SHA: "b".repeat(40),
      },
      "resolve-published",
      0,
    ],
    ["legacy", { A_TAG: "v0.0.10-nightly.20261010.282" }, "", 2],
    [
      "published-pair",
      {
        STABLE_TAG: "v0.0.11",
        STABLE_SHA: "a".repeat(40),
        CANDIDATE_TAG: "v0.0.12-nightly.20261013.330",
      },
      "",
      2,
    ],
    [
      "published-pair",
      {
        STABLE_TAG: "v0.0.11",
        STABLE_SHA: "a".repeat(40),
        CANDIDATE_TAG: "v0.0.12-nightly.20261013.330",
        CANDIDATE_SHA: "b".repeat(40),
        B_RUN: "900",
      },
      "",
      2,
    ],
    ["other", {}, "", 2],
  ])("dispatch mode %s validates its pins before resolution", (mode, pins, command, status) => {
    const folder = mkdtempSync(join(tmpdir(), "upgrade-dispatch-"));
    const log = join(folder, "commands");
    const step = jobs
      .flatMap((job) => job.steps)
      .find((step) => step.name === "Find and check the three installers")!;
    try {
      const result = spawnSync(
        "bash",
        ["-e", "-c", `node() { printf '%s\\n' "$@" > "$COMMAND_LOG"; }\n${step.run}`],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            A_TAG: "",
            A_SHA: "",
            B_RUN: "",
            B_SHA: "",
            STABLE_TAG: "",
            STABLE_SHA: "",
            CANDIDATE_TAG: "",
            CANDIDATE_SHA: "",
            ...pins,
            MODE: mode,
            RUNNER_TEMP: folder,
            COMMAND_LOG: log,
          },
        },
      );
      expect(result.status, result.stderr).toBe(status);
      if (status === 0) {
        const args = readFileSync(log, "utf8").trim().split("\n");
        expect(args.slice(0, 2)).toEqual(["apps/desktop/test/e2e/installed-upgrade.ts", command]);
        for (const value of Object.values(pins)) expect(args).toContain(value);
        expect(args.at(-1)).toBe(join(folder, "installed-upgrade-packages"));
      } else expect(() => readFileSync(log)).toThrow();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32").each([
    ["legacy", "run"],
    ["published-pair", "run-published"],
  ])("runs the matching native command for %s", (mode, command) => {
    const step = jobs
      .flatMap((job) => job.steps)
      .find((step) => step.name === "Install, retain state and check offline copies")!;
    const result = spawnSync("bash", ["-e", "-c", `node() { printf '%s\\n' "$@"; }\n${step.run}`], {
      encoding: "utf8",
      env: { ...process.env, MODE: mode, RUNNER_TEMP: "/runner-temp" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual([
      "apps/desktop/test/e2e/installed-upgrade.ts",
      command,
      "--packages",
      "/runner-temp/installed-upgrade-packages",
      "--root",
      "/runner-temp/installed-upgrade",
    ]);
  });

  it("can read releases, runs and pull requests, and change nothing", () => {
    expect(workflow.permissions).toEqual({
      contents: "read",
      actions: "read",
      "pull-requests": "read",
    });
    for (const job of jobs) expect(job.permissions).toBeUndefined();
  });

  it("holds no secret, and gives the token to the step that reads GitHub alone", () => {
    expect(text).not.toMatch(/secrets\./);
    const holders = jobs
      .flatMap((job) => job.steps)
      .filter((step) => JSON.stringify(step).includes("github.token"));
    expect(holders.map((step) => step.name)).toEqual(["Find and check the three installers"]);
    expect(holders[0]?.run).toMatch(/installed-upgrade\.ts resolve /);
    const checkout = jobs
      .flatMap((job) => job.steps)
      .find((step) => /checkout@/.test(step.uses ?? ""));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
  });
});
