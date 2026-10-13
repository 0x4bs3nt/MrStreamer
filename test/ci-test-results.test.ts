import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// CI's Test job runs scripts/ci-test-results.ts on Vitest's JSON report. Here it runs as there, from
// the root of a repository made for each test: it finds that repository's test files with the
// globs Vitest uses, and reads a report written for them.

const cli = resolve("scripts/ci-test-results.ts");

type Status = "passed" | "failed" | "skipped" | "pending" | "todo";

/** A file's entry in a report: one passed test unless it says otherwise. */
interface Entry {
  readonly file: string;
  readonly tests?: readonly Status[];
  readonly status?: "passed" | "failed";
  readonly message?: string;
}

const downloads = "apps/desktop/test/downloads.test.ts";
const airplayKey = "apps/desktop/test/airplay-helper-key.test.ts";
const testFiles = [
  "test/release.test.ts",
  "packages/core/test/guide.test.ts",
  "apps/desktop/test/renderer/downloads.test.ts",
  downloads,
  airplayKey,
];
const complete: readonly Entry[] = testFiles.map((file) => ({ file }));
const replace = (entry: Entry): Entry[] =>
  complete.map((each) => (each.file === entry.file ? entry : each));

/**
 * Runs the CLI in a repository holding `files`, on `report`: entries, or the report's text. Answers
 * its exit status and what it printed.
 */
async function check(
  report: string | readonly Entry[],
  files: readonly string[] = testFiles,
): Promise<{ status: number | null; output: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mrstreamer-ci-results-")));
  try {
    for (const file of files) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    const text =
      typeof report === "string"
        ? report
        : JSON.stringify({
            testResults: report.map(({ file, tests = ["passed"], status, message = "" }) => ({
              name: join(root, file),
              status: status ?? (tests.includes("failed") ? "failed" : "passed"),
              message,
              assertionResults: tests.map((each, index) => ({
                fullName: `case ${index + 1}`,
                status: each,
              })),
            })),
          });
    writeFileSync(join(root, "report.json"), text);
    const run = spawn(process.execPath, [cli, "report.json"], { cwd: root, timeout: 10_000 });
    let output = "";
    run.stdout.setEncoding("utf8").on("data", (text: string) => (output += text));
    run.stderr.setEncoding("utf8").on("data", (text: string) => (output += text));
    const [status] = (await once(run, "close")) as [number | null];
    return { status, output };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// Each check runs the CLI apart, in a repository of its own, so they run side by side.
describe("CI's test report", { concurrent: true }, () => {
  it("passes when every test file is in it, each test passed", async () => {
    // Helpers beside the tests and files outside the test folders are no test files.
    const run = await check(complete, [
      ...testFiles,
      "apps/desktop/test/fake-provider.ts",
      "docs/notes.test.ts",
    ]);

    expect(run.output).toContain("All 5 test files are in the report: 5 tests passed.");
    expect(run.status).toBe(0);
  });

  it("requires a new test file as soon as it exists, with no list to add it to", async () => {
    const run = await check(complete, [...testFiles, "apps/desktop/test/recordings.test.ts"]);

    expect(run.output).toContain("apps/desktop/test/recordings.test.ts: not in the report.");
    expect(run.status).toBe(1);
  });

  describe("with dot-named test files and folders, which Vitest runs too", () => {
    const hidden = ["test/.hidden.test.ts", "apps/desktop/test/.cases/nested.test.ts"];
    const files = [...testFiles, ...hidden];

    it("passes when they are in it", async () => {
      const run = await check([...complete, ...hidden.map((file) => ({ file }))], files);

      expect(run.output).toContain("All 7 test files are in the report: 7 tests passed.");
      expect(run.status).toBe(0);
    });

    it("fails when they are left out", async () => {
      const run = await check(complete, files);

      for (const file of hidden) expect(run.output).toContain(`${file}: not in the report.`);
      expect(run.status).toBe(1);
    });
  });

  it.each([
    {
      name: "missing",
      report: complete.filter((entry) => entry.file !== downloads),
      says: "not in the report",
    },
    {
      name: "skipped where ffmpeg was missing",
      report: replace({ file: downloads, tests: ["passed", "skipped"] }),
      says: "case 2 (skipped)",
    },
    {
      name: "failed",
      report: replace({ file: downloads, tests: ["failed", "passed"] }),
      says: "case 1 (failed)",
    },
    {
      name: "left pending",
      report: replace({ file: downloads, tests: ["pending"] }),
      says: "case 1 (pending)",
    },
    {
      name: "failed to load",
      report: replace({
        file: downloads,
        tests: [],
        status: "failed",
        message: "Cannot find module",
      }),
      says: "ran no tests. Cannot find module",
    },
    {
      name: "failed after its tests passed",
      report: replace({ file: downloads, status: "failed", message: "Hook timed out" }),
      says: "failed. Hook timed out",
    },
    {
      name: "reported twice",
      report: [...complete, { file: downloads }],
      says: "in the report 2 times",
    },
  ])("fails when a file's tests are $name", async ({ report, says }) => {
    const run = await check(report);

    expect(run.output).toContain(`${downloads}: ${says}`);
    expect(run.status).toBe(1);
  });

  it("lets the macOS-only file skip elsewhere, and no other", async () => {
    const run = await check(replace({ file: airplayKey, tests: ["skipped"] }));

    expect(run.status).toBe(process.platform === "darwin" ? 1 : 0);
    if (process.platform !== "darwin")
      expect(run.output).toContain(`${airplayKey} skipped 1, which run on darwin alone.`);
  });

  it.each([
    {
      name: "missing",
      report: complete.filter((entry) => entry.file !== airplayKey),
      says: "not in the report",
    },
    {
      name: "empty",
      report: replace({ file: airplayKey, tests: [], status: "failed" }),
      says: "ran no tests.",
    },
    {
      name: "failed",
      report: replace({ file: airplayKey, tests: ["failed"] }),
      says: "case 1 (failed)",
    },
  ])("still fails when the macOS-only file is $name", async ({ report, says }) => {
    const run = await check(report);

    expect(run.output).toContain(`${airplayKey}: ${says}`);
    expect(run.status).toBe(1);
  });

  it("fails for a file it doesn't have, as from another checkout", async () => {
    const run = await check([...complete, { file: "apps/desktop/test/elsewhere.test.ts" }]);

    expect(run.output).toContain(
      "apps/desktop/test/elsewhere.test.ts: in the report, but no test file here.",
    );
    expect(run.status).toBe(1);
  });

  it.each([
    { name: "no JSON", report: "Test Files  5 passed", says: "Couldn't read report.json as JSON" },
    {
      name: "another kind of JSON",
      report: '{"testResults":[{"name":1}]}',
      says: "report.json is no Vitest JSON report",
    },
  ])("fails for a report that is $name", async ({ report, says }) => {
    const run = await check(report);

    expect(run.output).toContain(says);
    expect(run.status).toBe(1);
  });

  it("fails where it finds no test files", async () => {
    const run = await check([], []);

    expect(run.output).toContain("No test files under");
    expect(run.status).toBe(1);
  });
});
