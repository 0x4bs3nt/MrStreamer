import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";

// Publishing the website is the one place these workflows hold a credential, the Vercel token. A
// run can't be tried without publishing, so this reads the two workflows and checks who can start
// a publication, which job gets the token, and that what runs beside it is pinned. The step that
// keeps an overtaken build from being published runs here for real, against repositories made
// for it, and so does the gate that admits a finished release run, with a stand-in for gh that
// answers by the job names the release workflows give.

/** The parts of a workflow file this test reads. */
interface Workflow {
  readonly on: {
    readonly push?: { readonly branches?: readonly string[]; readonly paths?: readonly string[] };
    readonly workflow_run?: {
      readonly workflows: readonly string[];
      readonly types: readonly string[];
      readonly branches: readonly string[];
    };
  };
  readonly concurrency?: { readonly group: string; readonly "cancel-in-progress": boolean };
  readonly jobs: Record<string, Job>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  readonly outputs?: Record<string, string>;
  readonly environment?: { readonly name: string };
  readonly steps: readonly {
    readonly id?: string;
    readonly if?: string;
    readonly with?: Record<string, unknown>;
    readonly uses?: string;
    readonly run?: string;
    readonly env?: Record<string, string>;
  }[];
}

const read = (name: string): { text: string; workflow: Workflow } => {
  const text = readFileSync(`.github/workflows/${name}`, "utf8");
  return { text, workflow: parse(text) as Workflow };
};
const build = read("marketing.yml");
const deploy = read("marketing-deploy.yml");
const { publish, ...others } = deploy.workflow.jobs;

describe("publishing the website", () => {
  it("starts only from main, and only once the owner turned it on", () => {
    expect(Object.keys(deploy.workflow.on)).toEqual(["push", "workflow_dispatch", "workflow_run"]);
    expect(deploy.workflow.on.push?.branches).toEqual(["main"]);
    expect(deploy.workflow.on.workflow_run).toEqual({
      workflows: ["Release"],
      types: ["completed"],
      branches: ["main"],
    });
    // A run started by hand from another branch builds nothing, so it publishes nothing.
    expect(others["build"]?.needs).toBe("trigger");
    expect(others["build"]?.if).toBe(
      "github.ref == 'refs/heads/main' && needs.trigger.outputs.allowed == 'true'",
    );
    expect(publish?.needs).toBe("build");
    expect(publish?.if).toBe("vars.MARKETING_DEPLOY_ENABLED == 'true'");
  });

  it("queues runs by branch, so one from another branch never replaces a waiting one from main", () => {
    expect(deploy.workflow.concurrency).toEqual({
      group: "marketing-production-${{ github.ref }}",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("gives the token to the publishing job alone, which runs nothing from the repository", () => {
    expect(build.text).not.toContain("secrets.");
    for (const job of Object.values(others)) {
      expect(JSON.stringify(job)).not.toContain("secrets.");
      expect(job.environment).toBeUndefined();
    }
    expect(publish?.environment?.name).toBe("marketing-production");
    const uses = publish?.steps.flatMap((step) => step.uses ?? []) ?? [];
    expect(uses.some((action) => action.startsWith("actions/checkout@"))).toBe(false);
  });

  it("compiles website analytics only into the published build, from public variables", () => {
    const step = others["build"]?.steps.find((step) =>
      step.run?.includes("mrstreamer-marketing build"),
    );
    expect(step?.env).toEqual({
      GH_TOKEN: "${{ github.token }}",
      MR_STREAMER_SITE_ANALYTICS_RELEASE_BUILD: "1",
      MR_STREAMER_SITE_ANALYTICS_HOST: "${{ vars.POSTHOG_HOST }}",
      MR_STREAMER_SITE_ANALYTICS_PROJECT_TOKEN: "${{ vars.POSTHOG_PROJECT_TOKEN }}",
    });
    expect(build.text).not.toContain("MR_STREAMER_SITE_ANALYTICS");
  });

  it("notifies only an actual successful production publication, without owner secrets or a checkout", () => {
    const notify = others["indexnow"];
    const failure = notify?.steps.find((step) => step.if === "failure()");
    expect(failure?.run).toContain("website is already deployed");
    expect(notify?.needs).toEqual(["build", "publish"]);
    expect(notify?.if).toBe(
      "success() && github.ref == 'refs/heads/main' && vars.MARKETING_DEPLOY_ENABLED == 'true' && needs.publish.result == 'success' && needs.publish.outputs.deployed == 'true'",
    );
    expect(publish?.outputs?.["deployed"]).toBe("${{ steps.deployment.outputs.deployed }}");
    const deployment = publish?.steps.find((step) => step.id === "deployment");
    expect(deployment?.run?.indexOf('echo "deployed=true"')).toBeGreaterThan(
      deployment?.run?.indexOf("vercel@") ?? 0,
    );
    expect(deployment?.if).toBe("steps.newest.outputs.superseded != 'true'");
    expect(notify?.steps.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(false);
    expect(JSON.stringify(notify)).not.toContain("secrets.");
    expect(JSON.stringify(notify)).not.toContain("VERCEL_TOKEN");
    expect(
      notify?.steps
        .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
        .map((step) => step.with?.["name"]),
    ).toEqual(["marketing-output", "marketing-indexnow"]);
    expect(
      notify?.steps.find((step) => step.run?.startsWith("node marketing-indexnow/"))?.run,
    ).toBe('node marketing-indexnow/indexnow.ts marketing-output/static "$BUILT"');
  });

  it("pins every action to a commit and the Vercel CLI to a version", () => {
    const steps = [build, deploy].flatMap(({ workflow }) =>
      Object.values(workflow.jobs).flatMap((job) => job.steps),
    );
    for (const step of steps) {
      if (step.uses) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
    }
    const published = steps.filter((step) => step.run?.includes("vercel"));
    expect(published.map((step) => /vercel@\S+/.exec(step.run ?? "")?.[0])).toEqual([
      "vercel@62.2.0",
    ]);
  });
});

/** The files a push must change to start a publication, one for each path the workflow lists. */
const websiteFiles = (deploy.workflow.on.push?.paths ?? []).map((path) =>
  path.replace("**", "page.html"),
);
/**
 * More files than GitHub's own comparison of two commits names, 300, and ahead of every website
 * file in the order it lists them, by path.
 */
const otherFiles = Array.from({ length: 301 }, (_, index) => `.a/file-${index}.txt`);

/**
 * What the publish job decides about a build once main has moved on: true when it leaves
 * publishing to a newer run. main holds the built commit, then a commit that changes `later`.
 * `built` names another commit as the build's. Throws when the step fails, which publishes
 * nothing either.
 */
function leftToNewerRun(later: readonly string[], built?: string): boolean {
  const folder = mkdtempSync(join(tmpdir(), "mr-streamer-marketing-"));
  // Git as the workflow's runner has it: no settings of whoever runs the tests.
  const env = {
    PATH: process.env["PATH"],
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const origin = join(folder, "origin.git");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: origin, env, encoding: "utf8" }).trim();
  const commit = (files: readonly string[], contents: string) => {
    for (const file of files) {
      mkdirSync(dirname(join(origin, file)), { recursive: true });
      writeFileSync(join(origin, file), contents);
    }
    git("add", "--all");
    git("commit", "--quiet", "--allow-empty", "--message", contents);
  };
  try {
    mkdirSync(origin);
    git("init", "--quiet", "--initial-branch=main");
    commit([...websiteFiles, ...otherFiles], "built");
    const head = git("rev-parse", "HEAD");
    commit(later, "later");
    const output = join(folder, "output");
    writeFileSync(output, "");
    const step = publish?.steps.find((each) => each.id === "newest");
    // As a runner starts a step's script.
    execFileSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", step?.run ?? "exit 1"],
      {
        env: {
          ...env,
          // What the build job reads from the push trigger's paths.
          INPUTS: (deploy.workflow.on.push?.paths ?? []).join(" "),
          BUILT: built ?? head,
          GITHUB_SERVER_URL: `file://${folder}`,
          GITHUB_REPOSITORY: "origin",
          GITHUB_OUTPUT: output,
          RUNNER_TEMP: folder,
        },
        stdio: "pipe",
      },
    );
    return readFileSync(output, "utf8").includes("superseded=true");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The step is a bash script, as the workflow's Linux runner runs it.
describe.skipIf(process.platform === "win32")("a build that main has moved past", () => {
  it("is published when main changed nothing of the website, however many files it changed", () => {
    expect(leftToNewerRun([])).toBe(false);
    expect(leftToNewerRun(otherFiles)).toBe(false);
  });

  it.each(websiteFiles)("is left to a newer run when %s changed among 301 other files", (file) => {
    expect(leftToNewerRun([...otherFiles, file])).toBe(true);
  });

  it("is not published when its commit is no longer part of main", () => {
    expect(() => leftToNewerRun([], "0".repeat(40))).toThrow();
  });
});

/** The display names of a workflow's jobs, which GitHub's job records carry. */
const jobNames = (name: string): Record<string, string | undefined> => {
  const { jobs } = parse(readFileSync(`.github/workflows/${name}`, "utf8")) as {
    jobs: Record<string, { name?: string }>;
  };
  return Object.fromEntries(Object.entries(jobs).map(([id, job]) => [id, job.name]));
};
const releaseJobs = jobNames("release.yml");
/** The job that records a stable release on main, as build-release.yml names it. */
const recorded = jobNames("build-release.yml")["finalize"];

/**
 * Whether the trigger job lets the run a finished release run started build the website, when
 * GitHub lists `jobs` for that release run. A stand-in gh answers from them as gh applies --jq.
 */
function admits(jobs: readonly { name: string; conclusion: string }[]): boolean {
  const folder = mkdtempSync(join(tmpdir(), "mr-streamer-marketing-trigger-"));
  try {
    writeFileSync(join(folder, "jobs.json"), JSON.stringify({ jobs }));
    writeFileSync(
      join(folder, "gh"),
      '#!/bin/bash\nwhile [ "$#" -gt 0 ]; do [ "$1" = --jq ] && filter=$2; shift; done\njq -r "$filter" "$JOBS"\n',
    );
    chmodSync(join(folder, "gh"), 0o755);
    const output = join(folder, "output");
    writeFileSync(output, "");
    const step = others["trigger"]?.steps.find((each) => each.id === "trigger");
    execFileSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", step?.run ?? "exit 1"],
      {
        env: {
          PATH: `${folder}:${process.env["PATH"]}`,
          JOBS: join(folder, "jobs.json"),
          GITHUB_EVENT_NAME: "workflow_run",
          GITHUB_OUTPUT: output,
          GH_REPO: "Mr-Streamer-OSS/MrStreamer",
          RELEASE_RUN: "1",
        },
        stdio: "pipe",
      },
    );
    return readFileSync(output, "utf8").includes("allowed=true");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

// The step is a bash script, as the workflow's Linux runner runs it.
describe.skipIf(process.platform === "win32")("a finished release run", () => {
  // GitHub names a job of a called workflow after the job that called it.
  const job = (caller: string, conclusion: string) => ({
    name: `${releaseJobs[caller]} / ${recorded}`,
    conclusion,
  });

  it("builds the website once it recorded a stable release, by the name build-release.yml gives that job", () => {
    expect(recorded).toBeDefined();
    expect(admits([job("nightly-first", "skipped"), job("release", "success")])).toBe(true);
  });

  it("builds nothing after a nightly, a dry run or a stable release that wasn't recorded", () => {
    expect(admits([job("release", "skipped")])).toBe(false);
    expect(admits([job("nightly-first", "skipped"), job("release", "failure")])).toBe(false);
  });
});

// An actual shell step can only authorize notification after the deployment command returned.
describe.skipIf(process.platform === "win32")("notification after the Publish shell step", () => {
  it.each([0, 1])("sets deployed only when the publishing CLI exits %s", (exit) => {
    const folder = mkdtempSync(join(tmpdir(), "mr-marketing-publish-"));
    try {
      writeFileSync(
        join(folder, "npx"),
        `#!/bin/bash\n[ "$FAKE_EXIT" = 0 ] && echo https://fixture.vercel.app\nexit "$FAKE_EXIT"\n`,
      );
      chmodSync(join(folder, "npx"), 0o755);
      const output = join(folder, "output");
      const summary = join(folder, "summary");
      writeFileSync(output, "");
      writeFileSync(summary, "");
      const run = () =>
        execFileSync(
          "bash",
          [
            "--noprofile",
            "--norc",
            "-eo",
            "pipefail",
            "-c",
            publish?.steps.find((step) => step.id === "deployment")?.run ?? "exit 1",
          ],
          {
            env: {
              PATH: `${folder}:${process.env["PATH"]}`,
              FAKE_EXIT: String(exit),
              VERCEL_TOKEN: "fake-fixture-token",
              BUILT: "fixture-source",
              GITHUB_OUTPUT: output,
              GITHUB_STEP_SUMMARY: summary,
            },
            stdio: "pipe",
          },
        );
      if (exit === 0) run();
      else expect(run).toThrow();
      expect(readFileSync(output, "utf8").includes("deployed=true")).toBe(exit === 0);
      expect(readFileSync(summary, "utf8").includes("### Deployed")).toBe(exit === 0);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
