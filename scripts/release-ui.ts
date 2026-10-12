// Release dry-run owner: shared bundle bytes, bounded helper CLIs, required proof and exit journal.
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { crc32 } from "node:zlib";
import { record } from "../.cursor/skills/verify-mrstreamer/scripts/session.ts";

export const requiredScenarios = [
  "live-tv",
  "titles",
  "watchlist",
  "downloads",
  "language",
  "home",
  "analytics",
] as const;
type Scenario = (typeof requiredScenarios)[number];
interface BuildReceipt {
  format: 1;
  revision: string;
  tree: string;
  appVersion: string;
  files: Record<string, string>;
}
interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}
interface ScenarioResult extends Exit {
  scenario: Scenario;
  status: "passed" | "failed" | "missing";
  errors: string[];
}
const receiptName = "release-ui-build.json";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

async function inventory(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of (await readdir(directory, { recursive: true, withFileTypes: true })).sort(
    (a, b) => join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)),
  )) {
    const path = join(entry.parentPath, entry.name);
    const name = path.slice(directory.length + 1).replaceAll("\\", "/");
    if (name === receiptName || entry.isDirectory()) continue;
    if (!entry.isFile()) throw new Error(`Bundle contains a non-file: ${name}`);
    files[name] = hash(await readFile(path));
  }
  for (const name of ["main/index.js", "preload/index.cjs", "renderer/index.html"])
    if (!files[name]) throw new Error(`Bundle is missing ${name}`);
  return files;
}

/** Only release version stamping may differ from the named source commit. */
async function sourceIdentity(root: string, revision: string, appVersion: string) {
  if (!/^\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(appVersion))
    throw new Error("Invalid release version.");
  if (!/^[a-f0-9]{40}$/.test(revision) || git(root, "rev-parse", "HEAD") !== revision)
    throw new Error("Checkout does not match the full release revision.");
  const pkgPath = "apps/desktop/package.json";
  const pkg: unknown = JSON.parse(await readFile(join(root, pkgPath), "utf8"));
  const original: unknown = JSON.parse(git(root, "show", `HEAD:${pkgPath}`));
  if (
    !record(pkg) ||
    !record(original) ||
    pkg["version"] !== appVersion ||
    !isDeepStrictEqual({ ...pkg, version: original["version"] }, original)
  )
    throw new Error("Package identity differs from the release source/version.");
  const changed = git(root, "diff", "HEAD", "--name-only").split("\n").filter(Boolean);
  const untracked = git(root, "ls-files", "--others", "--exclude-standard");
  if (changed.some((name) => name !== pkgPath) || untracked)
    throw new Error("Release source has changes beyond version stamping.");
  return git(root, "rev-parse", "HEAD^{tree}");
}

/** Call immediately after building the named clean source; packaging and UI consume this same out. */
export async function recordBuild(root: string, revision: string, appVersion: string) {
  const tree = await sourceIdentity(root, revision, appVersion);
  const directory = join(root, "apps/desktop/out");
  const receipt: BuildReceipt = {
    format: 1,
    revision,
    tree,
    appVersion,
    files: await inventory(directory),
  };
  await writeFile(join(directory, receiptName), JSON.stringify(receipt, null, 2));
  return receipt;
}

/** A SHA alone cannot prove a matching build. Require the original receipt and every bundle byte. */
export async function verifyBuild(
  root: string,
  revision: string,
  appVersion: string,
): Promise<BuildReceipt> {
  const tree = await sourceIdentity(root, revision, appVersion);
  const directory = join(root, "apps/desktop/out");
  const value: unknown = JSON.parse(await readFile(join(directory, receiptName), "utf8"));
  const files = await inventory(directory);
  if (
    !record(value) ||
    value["format"] !== 1 ||
    value["revision"] !== revision ||
    value["tree"] !== tree ||
    value["appVersion"] !== appVersion ||
    !isDeepStrictEqual(value["files"], files)
  )
    throw new Error("Release bundle bytes or provenance differ from the build receipt.");
  return { format: 1, revision, tree, appVersion, files };
}

/** Check PNG chunks/CRC and nonempty dimensions. Painted content still needs visual inspection. */
function validPng(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return false;
  let offset = 8,
    image = false,
    header = false;
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset);
    const end = offset + 12 + size;
    if (end > bytes.length) return false;
    const kind = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!header) {
      if (
        kind !== "IHDR" ||
        size !== 13 ||
        !bytes.readUInt32BE(offset + 8) ||
        !bytes.readUInt32BE(offset + 12)
      )
        return false;
      header = true;
    }
    if (kind === "IDAT") image = true;
    if (kind === "IEND") return size === 0 && image && end === bytes.length;
    offset = end;
  }
  return false;
}

/** Treat absent, skipped, invalid and unsuccessful proof as failure, even if the CLI returned zero. */
export async function inspectScenario(
  directory: string,
  scenario: Scenario,
  build: BuildReceipt,
  exit: Exit,
): Promise<ScenarioResult> {
  const errors: string[] = [];
  if (exit.code !== 0 || exit.signal) errors.push(`CLI exit ${exit.code}, signal ${exit.signal}`);
  try {
    const proof: unknown = JSON.parse(await readFile(join(directory, "proof.json"), "utf8"));
    if (!record(proof)) throw new Error("Invalid proof object.");
    if (proof["scenario"] !== scenario || proof["status"] !== "passed")
      errors.push("Required scenario did not pass.");
    const identity = proof["build"];
    if (
      !record(identity) ||
      identity["revision"] !== build.revision ||
      identity["appVersion"] !== build.appVersion ||
      identity["mainSha256"] !== build.files["main/index.js"]
    )
      errors.push("Scenario build identity differs from the shared bundle.");
    const cleanup = proof["cleanup"];
    if (
      !record(cleanup) ||
      cleanup["appExited"] !== true ||
      cleanup["profileRemoved"] !== true ||
      cleanup["fixturesClosed"] !== true ||
      !Array.isArray(cleanup["errors"]) ||
      cleanup["errors"].length
    )
      errors.push("Cleanup is incomplete or invalid.");
    if (
      !Array.isArray(proof["actions"]) ||
      !proof["actions"].length ||
      !proof["actions"].every(
        (action) =>
          record(action) &&
          typeof action["action"] === "string" &&
          action["action"].length > 0 &&
          typeof action["at"] === "string" &&
          Number.isFinite(Date.parse(action["at"])),
      )
    )
      errors.push("Missing or invalid actions.");
    if (!record(proof["observed"]) || !Object.keys(proof["observed"]).length)
      errors.push("Missing observable side effects.");
    const pngs = (await readdir(directory)).filter((name) => name.endsWith(".png"));
    if (!pngs.length) errors.push("No screenshots.");
    for (const name of pngs) {
      const bytes = await readFile(join(directory, name));
      if (!validPng(bytes)) errors.push(`Invalid screenshot: ${name}`);
    }
    await readFile(join(directory, "electron.log"));
  } catch (error) {
    errors.push(String(error));
  }
  return { scenario, status: errors.length ? "failed" : "passed", errors, ...exit };
}

/** One child at a time; signal its helper first so its owned Electron and fixtures run finally. */
async function execute(
  root: string,
  args: string[],
  directory: string,
  signal: AbortSignal,
  timeoutMs: number,
  fail?: Scenario,
) {
  await mkdir(directory, { recursive: true });
  const started = performance.now();
  const command = [process.execPath, ...args];
  const child = spawn(command[0]!, args, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      MR_STREAMER_VERIFICATION_OUTPUT: directory,
      MR_STREAMER_VERIFICATION_FAIL: fail ?? "",
    },
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  let reason: string | undefined;
  let kill: ReturnType<typeof setTimeout> | undefined;
  const interrupt = (why: string) => {
    if (reason) return;
    reason = why;
    child.kill("SIGTERM");
    // A forced helper termination cannot prove finally ran. Missing cleanup fails the report.
    kill = setTimeout(() => child.kill("SIGKILL"), 45_000);
  };
  const abort = () => interrupt("cancelled");
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => interrupt("timeout"), timeoutMs);
  let spawnError: string | undefined;
  const exit = await new Promise<Exit>((resolveExit) => {
    child.once("error", (error) => {
      spawnError = String(error);
      resolveExit({ code: null, signal: null });
    });
    child.once("close", (code, signal) => resolveExit({ code, signal }));
  });
  clearTimeout(timer);
  if (kill) clearTimeout(kill);
  signal.removeEventListener("abort", abort);
  await writeFile(join(directory, "stdout.log"), Buffer.concat(stdout));
  await writeFile(join(directory, "stderr.log"), Buffer.concat(stderr));
  const journal = { command, ...exit, reason, spawnError, wallMs: performance.now() - started };
  await writeFile(join(directory, "cli.json"), JSON.stringify(journal, null, 2));
  return journal;
}

export async function runReleaseUI(options: {
  root: string;
  revision: string;
  appVersion: string;
  output: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  failScenario?: Scenario | undefined;
}) {
  const { root, revision, appVersion } = options;
  const output = resolve(options.output);
  await mkdir(output, { recursive: true });
  if ((await readdir(output)).length) throw new Error("Use an empty aggregate evidence directory.");
  const started = performance.now();
  const signal = options.signal ?? new AbortController().signal;
  const results: ScenarioResult[] = [];
  let build: BuildReceipt | undefined;
  let failure: string | undefined;
  let exitCode = 0;
  try {
    build = await verifyBuild(root, revision, appVersion);
    await writeFile(join(output, receiptName), JSON.stringify(build, null, 2));
    const doctor = await execute(
      root,
      [".cursor/skills/verify-mrstreamer/scripts/control.ts", "doctor"],
      join(output, "doctor"),
      signal,
      60_000,
    );
    if (doctor.code !== 0 || doctor.signal || doctor.reason || doctor.spawnError)
      throw new Error("Desktop doctor failed; see its original CLI journal.");
    for (const scenario of requiredScenarios) {
      if (signal.aborted) {
        results.push({
          scenario,
          status: "missing",
          errors: ["Cancelled before scenario started."],
          code: null,
          signal: null,
        });
        continue;
      }
      const args =
        scenario === "analytics"
          ? ["apps/desktop/test/e2e/analytics-app.ts"]
          : [".cursor/skills/verify-mrstreamer/scripts/control.ts", scenario];
      const directory = join(output, scenario);
      const cli = await execute(
        root,
        args,
        directory,
        signal,
        options.timeoutMs ?? 300_000,
        options.failScenario,
      );
      let result = await inspectScenario(directory, scenario, build, cli);
      if (cli.reason || cli.spawnError) {
        result.errors.push(cli.reason ?? cli.spawnError!);
        result = { ...result, status: "failed" };
      }
      results.push(result);
      if (result.status !== "passed" && exitCode === 0)
        exitCode = cli.code && cli.code > 0 ? cli.code : 1;
    }
    await verifyBuild(root, revision, appVersion);
  } catch (error) {
    failure = String(error);
    exitCode ||= 1;
  }
  for (const scenario of requiredScenarios)
    if (!results.some((result) => result.scenario === scenario))
      results.push({
        scenario,
        status: "missing",
        errors: ["Aggregate could not start scenario."],
        code: null,
        signal: null,
      });
  if (signal.aborted) exitCode = 130;
  const report = {
    format: 1,
    status: exitCode ? "failed" : "passed",
    exitCode,
    failure,
    build,
    requiredScenarios,
    results,
    wallMs: performance.now() - started,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    limits: [
      "Built-app fixture proof; native installed/upgrade, audible/GPU and real-provider acceptance remain separate.",
      "Screenshots require maintainer inspection; PNG validation alone cannot establish visual acceptance.",
    ],
  };
  await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, revision, appVersion, output, fail] = process.argv.slice(2);
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (!revision || !appVersion || !["record", "verify", "run"].includes(mode ?? ""))
    throw new Error(
      "Usage: node scripts/release-ui.ts record|verify <full-sha> <version>, or run <full-sha> <version> <empty-output> [--fail-scenario=<name>]",
    );
  if (mode === "record") await recordBuild(root, revision, appVersion);
  else if (mode === "verify") await verifyBuild(root, revision, appVersion);
  else {
    if (!output) throw new Error("Name an empty evidence directory.");
    const failScenario = requiredScenarios.find(
      (scenario) => fail === `--fail-scenario=${scenario}`,
    );
    if (fail && !failScenario) throw new Error("Unknown failure scenario.");
    const abort = new AbortController();
    const interrupted = () => abort.abort();
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    const report = await runReleaseUI({
      root,
      revision,
      appVersion,
      output,
      signal: abort.signal,
      failScenario,
    });
    process.off("SIGINT", interrupted);
    process.off("SIGTERM", interrupted);
    console.log(`${report.status}: ${join(resolve(output), "report.json")}`);
    process.exitCode = report.exitCode;
  }
}
