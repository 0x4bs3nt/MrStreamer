import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { afterAll, describe, expect, it } from "vitest";
import { artifactName, STORE_ENVIRONMENT } from "../scripts/store-release.ts";

// A stable run can build and publish two releases, a nightly of main first and then the stable
// release, through the same reusable workflows. Artifacts are named per run, so every artifact the
// two calls upload needs a name of its own: deploy-pages refuses a name it finds twice. A dry run
// can't deploy, so this reads the workflows and works out the names a run produces.
//
// A stable run also sends its package to the Microsoft Store, with the one credential these
// workflows hold for it. No run can be tried without a real submission, so this also reads which
// runs reach that job, what it is given, and what runs beside the credential.
//
// A stable release builds a commit an earlier nightly tested, under main's workflow, so the Store
// package's check works out the version with source that can be older than the check. That command
// runs here for real, on this checkout. So does CI's check of its test report, which a release runs
// on that older source too, in checkouts of either layout.

/** The parts of a workflow file this test reads. */
interface Workflow {
  readonly on: {
    readonly workflow_call?: { readonly inputs?: Record<string, { default?: unknown }> };
  };
  readonly jobs: Record<string, Job>;
}

interface Job {
  readonly if?: string;
  readonly needs?: string | readonly string[];
  /** A reusable workflow the job calls, and what it passes. */
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly secrets?: string;
  readonly permissions?: Record<string, string>;
  readonly environment?: { readonly name: string };
  readonly concurrency?: Record<string, unknown>;
  readonly defaults?: { readonly run?: { readonly "working-directory"?: string } };
  readonly outputs?: Record<string, string>;
  readonly strategy?: { readonly matrix?: { readonly include?: Record<string, string>[] } };
  readonly steps?: readonly Step[];
}

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, string>;
}

const WORKFLOWS = ".github/workflows";
const read = (name: string): Workflow => parse(readFileSync(`${WORKFLOWS}/${name}`, "utf8"));

/** Answers an expression's name, such as `inputs.version`. */
type Context = (name: string) => string;

/**
 * Substitutes `${{ ... }}` in `text`: names from `context`, quoted literals, and `a || 'b'`,
 * which takes the first non-empty value. Throws on anything else, so a new kind of expression in a
 * name makes the test say so instead of guessing.
 */
function evaluate(text: string, context: Context): string {
  return text.replace(/\$\{\{\s*(.+?)\s*\}\}/g, (_, expression: string) => {
    for (const part of expression.split("||").map((each) => each.trim())) {
      const value = /^'(.*)'$/.exec(part)?.[1] ?? context(part);
      if (value) return value;
    }
    return "";
  });
}

/** Names `values` answers, failing for any other. */
function known(values: Record<string, string>): Context {
  return (name) => {
    const value = values[name];
    if (value === undefined) throw new Error(`The test doesn't know ${name}.`);
    return value;
  };
}

/** The artifact names a run of `path` uploads, and the ones its deploy-pages steps take. */
function artifacts(path: string, context: Context): { uploaded: string[]; deployed: string[] } {
  const workflow: Workflow = parse(readFileSync(path, "utf8"));
  const defaults = workflow.on.workflow_call?.inputs ?? {};
  const uploaded: string[] = [];
  const deployed: string[] = [];
  for (const job of Object.values(workflow.jobs)) {
    // A release run is no pull request, so a job meant for one channel runs on that channel only.
    const channel = /inputs\.channel == '(\w+)'/.exec(job.if ?? "")?.[1];
    if (channel && channel !== context("inputs.channel")) continue;
    if (job.uses) {
      const called = artifacts(job.uses, (name) => {
        if (!name.startsWith("inputs.")) return context(name);
        const input = name.slice("inputs.".length);
        return evaluate(String(job.with?.[input] ?? defaults[input]?.default ?? ""), context);
      });
      uploaded.push(...called.uploaded);
      deployed.push(...called.deployed);
      continue;
    }
    for (const leg of job.strategy?.matrix?.include ?? [{}]) {
      const inLeg: Context = (name) =>
        name.startsWith("matrix.") ? (leg[name.slice("matrix.".length)] ?? "") : context(name);
      for (const step of job.steps ?? []) {
        const name = (key: string) => evaluate(String(step.with?.[key]), inLeg);
        if (/^actions\/upload(-pages)?-artifact@/.test(step.uses ?? ""))
          uploaded.push(name("name"));
        if (step.uses?.startsWith("actions/deploy-pages@")) deployed.push(name("artifact_name"));
      }
    }
  }
  return { uploaded, deployed };
}

describe("a stable run that publishes a nightly first", () => {
  /** The plan of a stable 0.0.4 run whose nightly first is 0.0.4-nightly.20261002.117. */
  const run = (attempt: number) =>
    artifacts(
      ".github/workflows/release.yml",
      known({
        "github.run_attempt": String(attempt),
        "needs.plan.outputs.channel": "stable",
        "needs.plan.outputs.version": "0.0.4",
        "needs.plan.outputs.tag": "v0.0.4",
        "needs.plan.outputs.sha": "tested-commit",
        "needs.plan.outputs.previous-tag": "v0.0.3",
        "needs.plan.outputs.first-version": "0.0.4-nightly.20261002.117",
        "needs.plan.outputs.first-tag": "v0.0.4-nightly.20261002.117",
        "needs.plan.outputs.first-sha": "main-commit",
        "needs.plan.outputs.first-previous-tag": "v0.0.4-nightly.20261002.110",
      }),
    );

  it("names every artifact it uploads apart", () => {
    const { uploaded } = run(1);

    expect(uploaded).toContain("release-mac-arm64-0.0.4-nightly.20261002.117");
    expect(uploaded).toContain("release-mac-arm64-0.0.4");
    // Each release's checks keep their own test report.
    expect(uploaded.filter((name) => name.startsWith("test-results-"))).toEqual([
      "test-results-0.0.4-nightly.20261002.117-1",
      "test-results-0.0.4-1",
    ]);
    // Only the stable release builds a Store package.
    expect(uploaded.filter((name) => name.startsWith("msix-"))).toEqual([
      "msix-0.0.4",
      "msix-failed-0.0.4",
    ]);
    expect(uploaded.filter((name, index) => uploaded.indexOf(name) !== index)).toEqual([]);
  });

  it("deploys each release's feed from its own Pages artifact, again in a later attempt", () => {
    const first = run(1);

    expect(first.deployed).toEqual([
      "github-pages-0.0.4-nightly.20261002.117-1",
      "github-pages-0.0.4-1",
    ]);
    expect(first.uploaded).toEqual(expect.arrayContaining(first.deployed));
    // Artifacts of earlier attempts stay in the run, so a re-run deploys from new names.
    expect(run(2).deployed.filter((name) => first.uploaded.includes(name))).toEqual([]);
  });
});

describe("a CI run's test report", () => {
  const step = read("ci.yml").jobs["test"]?.steps?.find(
    (each) => each.name === "Require complete test results",
  );
  // Without the links a temp folder's path can hold, as /var on macOS: the check starts in the real
  // folder and reads the report's paths against it.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "test-results-step-")));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /**
   * Runs the step as the job does, in a checkout holding `files`, which map paths to text, and this
   * checkout's installed dependencies.
   */
  const checkReport = (name: string, files: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(dir);
    symlinkSync(resolve("node_modules"), join(dir, "node_modules"), "junction");
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    writeFileSync(
      join(dir, "test-results.json"),
      JSON.stringify({
        testResults: [
          {
            name: join(dir, "test/a.test.ts"),
            status: "passed",
            assertionResults: [{ fullName: "a", status: "passed" }],
          },
        ],
      }),
    );
    expect(step?.run).toBeDefined();
    return spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step!.run!], {
      cwd: dir,
      env: { PATH: process.env["PATH"], RUNNER_TEMP: dir },
      encoding: "utf8",
    });
  };

  it("is kept under a name of its own in a run of its own", () => {
    const { uploaded } = artifacts(
      ".github/workflows/ci.yml",
      known({
        "inputs.report-name": "",
        "github.run_id": "38021750609",
        "github.run_attempt": "2",
      }),
    );

    expect(uploaded).toEqual(["test-results-38021750609-2"]);
  });

  it("must hold every test file of a source with the check", () => {
    const run = checkReport("current", {
      "scripts/ci-test-results.ts": readFileSync("scripts/ci-test-results.ts", "utf8"),
      "test/suites.ts": readFileSync("test/suites.ts", "utf8"),
      "test/a.test.ts": "",
    });

    expect(run.stdout).toContain("All 1 test files are in the report");
    expect(run.status).toBe(0);
  });
});

describe("Windows FFmpeg setup and cache inputs", () => {
  const windows = read("build-release.yml").jobs["package-windows"];
  const key = windows?.steps?.find((step) => step.id === "ffmpeg-key");
  const checkout = windows?.steps?.find(
    (step) => step.name === "Read the Windows FFmpeg toolchain",
  );
  const setup = windows?.steps?.find((step) => step.uses?.includes("/windows-ffmpeg-toolchain"));
  const actionPath = `${setup?.uses?.replace(/^\.\//, "")}/action.yml`;
  const definitionPath = "apps/desktop/scripts/windows-ffmpeg-toolchain/action.yml";
  const definition = readFileSync(definitionPath, "utf8");
  const build = readFileSync("apps/desktop/scripts/build-ffmpeg.sh", "utf8");
  const root = mkdtempSync(join(tmpdir(), "windows-ffmpeg-key-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** Runs the workflow's key command, supplying hashFiles as the Actions runner does. */
  function cacheKey(toolchain: string | undefined, source: string | undefined, workflow = "") {
    const dir = mkdtempSync(join(root, "source-"));
    mkdirSync(join(dir, "apps/desktop/scripts"), { recursive: true });
    for (const [path, contents] of [
      [actionPath, toolchain],
      ["apps/desktop/scripts/build-ffmpeg.sh", source],
      [".github/workflows/build-release.yml", workflow],
    ] as const) {
      if (contents === undefined) continue;
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), contents);
    }
    const output = join(dir, "output");
    const command = key?.run?.replace(
      /\$\{\{\s*hashFiles\((.*?)\)\s*\}\}/g,
      (_, patterns: string) => {
        const paths = [...patterns.matchAll(/'([^']+)'/g)]
          .map((match) => join(dir, match[1]!))
          .filter(existsSync)
          .sort();
        if (!paths.length) return "";
        const hash = createHash("sha256");
        for (const path of paths)
          hash.update(createHash("sha256").update(readFileSync(path)).digest());
        return hash.digest("hex");
      },
    );
    if (!command) throw new Error("Windows has no cache key command.");
    const result = spawnSync("bash", ["-e", "-c", command], {
      cwd: join(dir, "apps/desktop"),
      env: { ...process.env, GITHUB_OUTPUT: output },
      encoding: "utf8",
    });
    return {
      status: result.status,
      output: existsSync(output) ? readFileSync(output, "utf8") : "",
    };
  }

  it("sets up the same UCRT64 action that the cache hashes, from the workflow revision", () => {
    expect(checkout?.uses).toMatch(/^actions\/checkout@/);
    expect(checkout?.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".ffmpeg-toolchain",
      "sparse-checkout": "apps/desktop/scripts/windows-ffmpeg-toolchain",
      "persist-credentials": false,
    });
    expect(setup?.if).toBe("steps.ffmpeg.outputs.cache-hit != 'true'");
    const action: { runs: { using: string; steps: Step[] } } = parse(definition);
    expect(action.runs.using).toBe("composite");
    expect(action.runs.steps).toHaveLength(1);
    expect(action.runs.steps[0]?.uses).toBe(
      "msys2/setup-msys2@ec48f7c5447b3140e2b088413ae3a55687bccb6e",
    );
    expect(action.runs.steps[0]?.with).toEqual({
      msystem: "UCRT64",
      update: false,
      install:
        "make git curl mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-nasm mingw-w64-ucrt-x86_64-pkgconf",
    });
    const result = cacheKey(definition, build);
    expect(result.status).toBe(0);
    expect(result.output).toMatch(/^key=ffmpeg-win-x64-ucrt64-[a-f0-9]{64}\n$/);
    // Only the source's build script is present: promoted source need not contain the new action.
  });

  it("reuses the key after an unrelated release workflow edit", () => {
    const workflow = readFileSync(`${WORKFLOWS}/build-release.yml`, "utf8");
    const before = cacheKey(definition, build, workflow);
    const after = cacheKey(
      definition,
      build,
      workflow.replace("timeout-minutes: 60", "timeout-minutes: 61"),
    );
    expect(before.status).toBe(0);
    expect(after).toEqual(before);
  });

  it.each([
    [
      "setup action revision",
      "ec48f7c5447b3140e2b088413ae3a55687bccb6e",
      "another-action-revision",
    ],
    ["runtime", "UCRT64", "MINGW64"],
    ["package list", "make git curl", "make git curl patch"],
    ["package update policy", "update: false", "update: true"],
  ])("invalidates the key after changing the %s", (_, before, after) => {
    const baseline = cacheKey(definition, build);
    const changed = cacheKey(definition.replace(before, after), build);
    expect(changed.status).toBe(0);
    expect(changed.output).not.toBe(baseline.output);
  });

  it.each([
    ["FFmpeg source", "FFMPEG_VERSION=9.0.2", "FFMPEG_VERSION=9.0.3"],
    ["source checksum", "FFMPEG_SHA256=", "FFMPEG_SHA256=0"],
    ["x264 source", "X264_COMMIT=", "X264_COMMIT=0"],
    ["codec configuration", "--enable-decoder=h264,hevc", "--enable-decoder=h264"],
    ["build flags", "--extra-ldflags=-static", "--extra-ldflags=-static-libgcc"],
  ])("invalidates the key after changing the %s", (_, before, after) => {
    const changed = cacheKey(definition, build.replace(before, after));
    expect(changed.status).toBe(0);
    expect(changed.output).not.toBe(cacheKey(definition, build).output);
  });

  it.each(["toolchain", "source"])("refuses a key with missing %s inputs", (missing) => {
    const result = cacheKey(
      missing === "toolchain" ? undefined : definition,
      missing === "source" ? undefined : build,
    );
    expect(result.status).not.toBe(0);
    expect(result.output).toBe("");
  });
});

describe("Windows FFmpeg provenance across promoted source revisions", () => {
  const root = mkdtempSync(join(tmpdir(), "ffmpeg-provenance-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const command = read("build-release.yml").jobs["package-windows"]?.steps?.find(
    (step) => step.name === "Check and record Windows ffmpeg provenance",
  )?.run;

  it.each([
    {
      name: "UCRT64 source with its cached provenance",
      script: "# MSYS2 UCRT64",
      stamp: "C runtime UCRT; MSYS2 UCRT64; packages mingw-w64-ucrt-x86_64-gcc 15.2.0-8",
      status: 0,
    },
    {
      name: "UCRT64 source with an obsolete cached binary",
      script: "# MSYS2 UCRT64",
      stamp: "MSYS2 packages ",
      status: 1,
    },
  ])("checks $name", ({ name, script, stamp, status }) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "vendor/ffmpeg/win-x64"), { recursive: true });
    writeFileSync(join(dir, "scripts/build-ffmpeg.sh"), script);
    writeFileSync(join(dir, "vendor/ffmpeg/win-x64/README.txt"), `Built with: ${stamp}\n`);
    expect(command).toBeDefined();
    const checked = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", command!],
      {
        cwd: dir,
        encoding: "utf8",
      },
    );
    expect(checked.status).toBe(status);
    if (status === 0) expect(checked.stdout).toContain(`Built with: ${stamp}`);
  });
});

describe("sending a stable release to the Microsoft Store", () => {
  const release = read("release.yml");
  const build = read("build-release.yml");
  const store = read("microsoft-store.yml");
  const { gate, store: submit, ...others } = store.jobs;
  const steps = submit?.steps ?? [];
  const called = "./.github/workflows/microsoft-store.yml";

  it("happens only for a published stable release started by hand from main, whose package passed", () => {
    const job = build.jobs["store"];

    expect(job?.uses).toBe(called);
    expect(job?.needs).toEqual(["publish", "msix"]);
    expect(job?.if?.split(/\s+/).join(" ")).toBe("inputs.channel == 'stable'");
    // No push, tag, release, schedule or pull request starts the Store workflow itself.
    expect(Object.keys(store.on)).toEqual(["workflow_call", "workflow_dispatch"]);
    // And nothing else calls it or names its environment.
    for (const file of readdirSync(WORKFLOWS)) {
      const jobs = Object.entries(read(file).jobs);
      const calling = jobs.filter(([, each]) => each.uses === called).map(([name]) => name);
      expect(calling).toEqual(file === "build-release.yml" ? ["store"] : []);
      const named = jobs.filter(([, each]) => each.environment?.name === STORE_ENVIRONMENT);
      expect(named.map(([name]) => name)).toEqual(file === "microsoft-store.yml" ? ["store"] : []);
    }
  });

  it("takes the package under the name the build job gives one that passed its checks", () => {
    const version = known({ "inputs.version": "0.0.4", "github.run_attempt": "2" });
    const uploads = (build.jobs["msix"]?.steps ?? []).filter((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));

    // The upload without a condition runs only when every step before it succeeded.
    expect(
      uploads.map((step) => [step.if, evaluate(String(step.with?.["name"]), version)]),
    ).toEqual([
      [undefined, artifactName("0.0.4")],
      [undefined, "package-receipt-win-x64-store-0.0.4-attempt-2"],
      ["failure()", "msix-failed-0.0.4"],
    ]);
    expect(evaluate(String(download?.with?.["name"]), version)).toBe(artifactName("0.0.4"));
    expect(build.jobs["store"]?.with).toEqual({
      version: "${{ inputs.version }}",
      sha: "${{ inputs.sha }}",
      sha256: "${{ needs.msix.outputs.sha256 }}",
    });
  });

  it("names the environment only once the setup is checked, and queues behind any other Store job", () => {
    expect(others).toEqual({});
    expect(gate?.environment).toBeUndefined();
    expect(JSON.stringify(gate)).not.toContain("secrets.");
    expect(submit?.needs).toBe("gate");
    expect(submit?.if).toBe("needs.gate.outputs.ready == 'true'");
    expect(submit?.concurrency).toEqual({
      group: "microsoft-store",
      "cancel-in-progress": false,
      queue: "max",
    });
  });

  it("gives the credential to the last step of a job that runs main's scripts and installs nothing", () => {
    const holding = steps.filter((step) => JSON.stringify(step).includes("secrets."));

    expect(holding).toEqual([steps.at(-1)]);
    expect(holding[0]?.env?.["STORE_CLIENT_SECRET"]).toBe("${{ secrets.STORE_CLIENT_SECRET }}");
    for (const step of [...(gate?.steps ?? []), ...steps]) {
      // Pinned actions, none of which installs packages, and a checkout of the run's own commit.
      if (step.uses) expect(step.uses).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) expect(step.with).toBeUndefined();
      const commands = (step.run ?? "").split("\n").filter((line) => !/^(args[=+]|\[ )/.test(line));
      for (const command of commands.filter(Boolean)) {
        expect(command).toMatch(/^node scripts\/store-(release|submission)\.ts /);
      }
    }
  });

  it("is granted, by every workflow that calls it, the permissions its jobs ask for", () => {
    const asked = [gate, submit].flatMap((job) => Object.entries(job?.permissions ?? {}));
    const callers = [build.jobs["store"], release.jobs["release"], release.jobs["nightly-first"]];

    expect(asked).toContainEqual(["actions", "read"]);
    for (const caller of callers) {
      for (const [scope, level] of asked) {
        expect([level, "write"]).toContain(caller?.permissions?.[scope]);
      }
    }
    // The called job's credential is the environment's, which reaches it only this way.
    expect(build.jobs["store"]?.secrets).toBe("inherit");
  });

  it("reads only settings the setup wizard stores and the runbook explains", () => {
    const text = readFileSync(`${WORKFLOWS}/microsoft-store.yml`, "utf8");
    const settings = [
      ...new Set([...text.matchAll(/\b(?:vars|secrets)\.(\w+)/g)].map(([, name]) => name)),
    ];
    const wizard = readFileSync("scripts/setup-microsoft-store.sh", "utf8");
    const runbook = readFileSync("docs/maintainers/microsoft-store.md", "utf8");

    expect(settings.toSorted()).toEqual([
      "STORE_AUTOMATION_ENABLED",
      "STORE_CLIENT_ID",
      "STORE_CLIENT_SECRET",
      "STORE_CLIENT_SECRET_EXPIRES",
      "STORE_TENANT_ID",
    ]);
    for (const setting of settings) {
      expect(wizard).toContain(setting);
      expect(runbook).toContain(`\`${setting}\``);
    }
  });
});

// A release owes the sources of what its installers carry, and a pull request's dry run is the
// only run that can show a source went missing before a release needs it.
describe("the source archives of a release", () => {
  const { jobs } = read("build-release.yml");
  const { sources, publish } = jobs;
  const version = known({ "inputs.version": "0.0.7" });

  /** Whether a job runs in every run: it and the jobs it waits for have no condition. */
  const unconditional = (name: string): boolean => {
    const job = jobs[name];
    return job !== undefined && !job.if && [job.needs ?? []].flat().every(unconditional);
  };

  it("are prepared in a dry run too, which publishes nothing", () => {
    expect(unconditional("sources")).toBe(true);
    expect(publish?.if).toBe("github.event_name != 'pull_request'");
  });

  it("reach the release with the installers, which never publishes without them", () => {
    const upload = sources?.steps?.find((step) =>
      step.uses?.startsWith("actions/upload-artifact@"),
    );
    const download = publish?.steps?.find((step) =>
      step.uses?.startsWith("actions/download-artifact@"),
    );
    const uploaded = evaluate(String(upload?.with?.["name"]), version);
    const taken = evaluate(String(download?.with?.["pattern"]), version);

    expect(publish?.needs).toContain("sources");
    expect(uploaded).toBe("release-sources-0.0.7");
    expect(uploaded).toMatch(new RegExp(`^${taken.replace("*", ".*")}$`));
  });
});

// A release is only as good as the jobs it waits for, and a Store package only as slow as the ones
// it needs. A dry run reads the same graph, so these read it for every run at once.
describe("what each job of a release waits for", () => {
  const { jobs } = read("build-release.yml");
  const { publish, msix, package: unix, "package-windows": windows } = jobs;

  const uploads = (name: string) =>
    (jobs[name]?.steps ?? [])
      .filter((step) => step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => String(step.with?.["name"]));

  it("publishes only after every job that makes a release file, the sources and the checks", () => {
    const makers = Object.keys(jobs).filter((name) =>
      uploads(name).some((artifact) => artifact.startsWith("release-")),
    );

    expect(makers.toSorted()).toEqual(["package", "package-windows", "sources"]);
    expect([publish?.needs].flat().toSorted()).toEqual(["checks", ...makers].toSorted());
    // A dry run builds all of it and publishes none.
    expect(publish?.if).toBe("github.event_name != 'pull_request'");
  });

  it("starts the Store package once the Windows installer is built, whatever the other platforms do", () => {
    expect([msix?.needs].flat()).toEqual(["package-windows"]);
    expect(unix?.strategy?.matrix?.include?.map((leg) => leg["target"])).toEqual([
      "mac-arm64",
      "linux-x64",
    ]);
    expect(uploads("package-windows")).toEqual([
      "release-win-x64-${{ inputs.version }}",
      "package-receipt-win-x64-direct-${{ inputs.version }}-attempt-${{ github.run_attempt }}",
    ]);
  });

  it("gives the Store package the JS bundle the Windows installer has already taken", () => {
    const downloads = (name: string) =>
      (jobs[name]?.steps ?? [])
        .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
        .map((step) => String(step.with?.["name"]));

    expect(uploads("bundle")).toEqual(["js-bundle-${{ inputs.version }}"]);
    // The Windows job can't succeed without the bundle, so the Store package, which waits for
    // that job, finds it as well.
    expect([windows?.needs].flat()).toEqual(["bundle"]);
    expect(downloads("package-windows")).toEqual(uploads("bundle"));
    expect(downloads("msix")).toEqual(uploads("bundle"));
  });

  it("hands the Store package the Windows ffmpeg under the key that job saved it with", () => {
    const save = windows?.steps?.find((step) => step.id === "ffmpeg");
    const restore = msix?.steps?.find((step) => step.uses?.startsWith("actions/cache/restore@"));
    const key = windows?.steps?.find((step) => step.id === "ffmpeg-key");

    expect(save?.uses).toMatch(/^actions\/cache@/);
    expect(save?.with?.["key"]).toBe("${{ steps.ffmpeg-key.outputs.key }}");
    expect(windows?.outputs?.["ffmpeg-key"]).toBe("${{ steps.ffmpeg-key.outputs.key }}");
    expect(key?.run).toBeTruthy();
    expect(save?.with?.["restore-keys"]).toBeUndefined();
    // The cache is saved when the job succeeds, so a cold build is there for the job that needs it.
    expect(restore?.with).toEqual({
      path: save?.with?.["path"],
      key: "${{ needs.package-windows.outputs.ffmpeg-key }}",
      "fail-on-cache-miss": true,
    });
  });
});

// The AirPlay helper compiles in every Mac build. Its cache holds the compiler's output and is
// found by what the script says the output is built from; the Developer ID signature is made on
// the copy inside the app, later.
describe("the cached AirPlay helper of a Mac build", () => {
  const steps = read("build-release.yml").jobs["package"]?.steps ?? [];
  const find = (id: string) => steps.find((step) => step.id === id);
  const build = steps.find((step) => step.name === "Build the AirPlay helper");
  const { mac } = parse(readFileSync("apps/desktop/electron-builder.yml", "utf8")) as {
    mac: { extraResources: { from: string; to: string }[] };
  };

  it("is found by the key the build script prints and rebuilt only on a miss", () => {
    expect(find("airplay-key")?.run).toContain(
      "scripts/build-airplay-helper.sh --key ${{ matrix.target }}",
    );
    expect(find("airplay")?.with?.["key"]).toBe("${{ steps.airplay-key.outputs.key }}");
    expect(build?.if).toBe("runner.os == 'macOS' && steps.airplay.outputs.cache-hit != 'true'");
    expect(steps.indexOf(build!)).toBeGreaterThan(steps.indexOf(find("airplay")!));
  });

  it("holds the folder electron-builder copies into the app to sign, and nothing it makes", () => {
    // The copy in the app is signed; the cached original never is.
    expect(find("airplay")?.with?.["path"]).toBe(
      "apps/desktop/vendor/airplay/${{ matrix.target }}",
    );
    expect(mac.extraResources.map((resource) => resource.from)).toContain(
      "vendor/airplay/mac-${arch}",
    );
  });
});

// These run the Mac steps' commands, as the runner's bash runs them, in a checkout with stand-ins
// for the build tools.
describe("a Mac build", () => {
  const steps = read("build-release.yml").jobs["package"]?.steps ?? [];
  const keyStep = steps.find((step) => step.id === "airplay-key");
  const buildStep = steps.find((step) => step.name === "Build for macOS, signed and notarized");
  const matrix: Record<string, string> = { target: "mac-arm64", builder: "--mac --arm64" };
  const secrets = Object.fromEntries(
    [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY_P8",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
    ].map((name) => [name, "secret"]),
  );

  const root = mkdtempSync(join(tmpdir(), "release-steps-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A checkout holding only the scripts given, with a pnpm and a node that log their calls. */
  const checkout = (name: string, scripts: Record<string, string>) => {
    const dir = join(root, name);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "bin"));
    for (const [file, body] of Object.entries(scripts))
      writeFileSync(join(dir, "scripts", file), body, { mode: 0o755 });
    const tool = (name: string, exit: string) => {
      writeFileSync(
        join(dir, "bin", name),
        `#!/bin/sh\necho "${name} $*" >> calls.log\ncat >/dev/null\n${exit}\n`,
      );
      chmodSync(join(dir, "bin", name), 0o755);
    };
    tool("pnpm", 'exit "${PNPM_EXIT:-0}"');
    tool("node", "exit 0");
    return dir;
  };

  /** Runs a step's commands in the checkout, as the runner's bash does. */
  const run = (dir: string, step: Step | undefined, env: Record<string, string> = {}) => {
    const command = String(step?.run).replace(
      /\$\{\{ matrix\.(\w+) \}\}/g,
      (_, name: string) => matrix[name] ?? "",
    );
    const { status } = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-eo", "pipefail", "-c", command],
      {
        cwd: dir,
        stdio: "ignore",
        env: {
          PATH: `${join(dir, "bin")}:${process.env["PATH"]}`,
          GITHUB_OUTPUT: join(dir, "outputs"),
          RUNNER_TEMP: dir,
          VERSION: "0.0.9",
          SHA: "0123456789abcdef",
          ...env,
        },
      },
    );
    const read = (file: string) =>
      existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8") : "";
    return {
      status,
      outputs: read("outputs"),
      calls: read("calls.log").split("\n").filter(Boolean),
    };
  };

  it("keys the helper by what a script that names --key prints, and stops when that fails", () => {
    const prints = checkout("key", {
      "build-airplay-helper.sh": "#!/bin/sh\n# --key prints the inputs\necho abc123\n",
    });
    const fails = checkout("failing-key", {
      "build-airplay-helper.sh":
        "#!/bin/sh\n# --key prints the inputs\necho no swiftc >&2; exit 3\n",
    });

    expect(run(prints, keyStep)).toMatchObject({
      status: 0,
      outputs: "key=airplay-mac-arm64-abc123\n",
    });
    expect(run(fails, keyStep)).toMatchObject({ status: 3, outputs: "" });
  });

  it("builds and notarizes with the phase timer", () => {
    const timed = run(checkout("timed", { "mac-release-phases.ts": "" }), buildStep, secrets);

    expect(timed.status).toBe(0);
    expect(timed.calls.toSorted()).toEqual([
      "node scripts/mac-release-phases.ts Mac release phases, 0.0.9 from 0123456789ab",
      "node scripts/notarize-dmg.ts dist/*.dmg",
      "pnpm exec electron-builder --mac --arm64 --publish never",
    ]);
  });

  it("fails the step before notarizing when the build fails", () => {
    const failed = run(checkout("timed-failure", { "mac-release-phases.ts": "" }), buildStep, {
      ...secrets,
      PNPM_EXIT: "7",
    });

    expect(failed.status).not.toBe(0);
    expect(failed.calls.join("\n")).not.toContain("notarize-dmg");
  });
});
