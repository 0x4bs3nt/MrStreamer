// Alternate builds on one host and retain every raw round. Performance warnings exit zero;
// incomplete instrumentation exits nonzero. Offline --baseline-json/--candidate-json accepts
// retained measurements for an auditable re-comparison without starting another app.
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  compareMeasurements,
  comparisonVerdict,
  MINIMUM_COMPARISON_SAMPLES,
  positiveCount,
  validateMeasurement,
} from "../../scripts/measurement.ts";
import { connect, delay, launch, observeAcrossLoad } from "./app.ts";

const { values: options, positionals } = parseArgs({
  options: {
    rounds: { type: "string", default: String(MINIMUM_COMPARISON_SAMPLES) },
    runs: { type: "string", default: "3" },
    subscriptions: { type: "string", default: "1" },
    output: { type: "string" },
    "baseline-revision": { type: "string" },
    "candidate-revision": { type: "string" },
    "baseline-json": { type: "string" },
    "candidate-json": { type: "string" },
    help: { type: "boolean" },
  },
  allowPositionals: true,
});
const usage = `Usage: compare-builds.ts [--rounds ${MINIMUM_COMPARISON_SAMPLES}] [--runs 3] [--subscriptions 1] [--output folder] <baseline> <candidate> [-- args], or --baseline-json file --candidate-json file
Defaults: ${MINIMUM_COMPARISON_SAMPLES} alternating rounds, 3 runs, 1 subscription. Offline mode rechecks one pair; fewer than ${MINIMUM_COMPARISON_SAMPLES} pooled samples per metric/side remains undersampled.`;
if (options.help) {
  console.log(usage);
  process.exit(0);
}
const rounds = positiveCount(options.rounds, "rounds", 20);
const samples = positiveCount(options.runs, "runs", 20);
const subscriptions = positiveCount(options.subscriptions, "subscriptions", 4);
const [baseline, candidate, ...appArgs] = positionals;
const offline = options["baseline-json"] && options["candidate-json"];
if (!offline && (!baseline || !candidate)) throw new Error(usage);
const folder = resolve(options.output ?? join(".local/measurements", `compare-${Date.now()}`));
mkdirSync(folder, { recursive: true });
const started = performance.now();
const runs: { baseline: unknown[]; candidate: unknown[] } = { baseline: [], candidate: [] };
const rawFiles: string[] = [];
const warmups: { executable: string; elapsedMs: number; navigationObserved: boolean }[] = [];
try {
  if (offline) {
    runs.baseline.push(JSON.parse(readFileSync(options["baseline-json"]!, "utf8")));
    runs.candidate.push(JSON.parse(readFileSync(options["candidate-json"]!, "utf8")));
    rawFiles.push(resolve(options["baseline-json"]!), resolve(options["candidate-json"]!));
  } else {
    for (const executable of [baseline!, candidate!])
      warmups.push({ executable, ...(await warmUp(executable)) });
    for (let round = 0; round < rounds; round++) {
      const order =
        round % 2 === 0
          ? (["candidate", "baseline"] as const)
          : (["baseline", "candidate"] as const);
      for (const build of order) {
        console.log(`Round ${round + 1}: ${build}`);
        const output = join(folder, `${build}-${round + 1}.json`);
        const revision = options[`${build}-revision`];
        rawFiles.push(output);
        execFileSync(
          process.execPath,
          [
            join(import.meta.dirname, "measure-app.ts"),
            "--json",
            output,
            "--runs",
            String(samples),
            "--subscriptions",
            String(subscriptions),
            ...(revision ? ["--revision", revision] : []),
            build === "baseline" ? baseline! : candidate!,
            "--",
            ...appArgs,
          ],
          { stdio: "inherit" },
        );
        runs[build].push(JSON.parse(readFileSync(output, "utf8")));
      }
      // Reject mismatched identity or instrumentation before paying for another pair.
      compareMeasurements(runs.baseline, runs.candidate);
    }
  }
  const comparison = compareMeasurements(runs.baseline, runs.candidate);
  const warnings = comparison.filter((measure) => measure.outcome === "warning");
  writeFileSync(
    join(folder, "comparison.json"),
    JSON.stringify(
      {
        status: "valid",
        verdict: comparisonVerdict(comparison),
        insufficientSamples: comparison.some((measure) => measure.insufficientSamples),
        minimumSamplesPerSide: MINIMUM_COMPARISON_SAMPLES,
        rounds: runs.baseline.length,
        elapsedMs: performance.now() - started,
        rawFiles,
        warmups,
        environments: {
          baseline: runs.baseline.map((run) => validateMeasurement(run).environment),
          candidate: runs.candidate.map((run) => validateMeasurement(run).environment),
        },
        sameBuildHash: [...runs.baseline, ...runs.candidate].every(
          (run) =>
            validateMeasurement(run).environment.buildSha256 ===
            validateMeasurement(runs.baseline[0]).environment.buildSha256,
        ),
        comparison,
      },
      null,
      2,
    ),
  );
  const shown = (value: number) => value.toFixed(1);
  const lines = [
    "| Measure | Unit | Baseline median [min, max] | Candidate median [min, max] | Absolute delta | Relative delta | Samples per side | Outcome |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const measure of comparison) {
    const before = `${shown(measure.baselineMedian)} [${shown(measure.baselineSpread.min)}, ${shown(measure.baselineSpread.max)}]`;
    const after = `${shown(measure.candidateMedian)} [${shown(measure.candidateSpread.min)}, ${shown(measure.candidateSpread.max)}]`;
    lines.push(
      `| ${measure.name} | ${measure.unit} | ${before} | ${after} | ${shown(measure.absoluteDelta)} | ${measure.relativeDelta === null ? "n/a (zero baseline)" : `${shown(measure.relativeDelta * 100)}%`} | ${measure.baselineSpread.samples}/${measure.candidateSpread.samples}${measure.insufficientSamples ? ` (insufficient; minimum ${MINIMUM_COMPARISON_SAMPLES})` : ""} | ${measure.outcome} |`,
    );
  }
  const table = lines.join("\n");
  const verdict = `Instrumentation valid; verdict ${comparisonVerdict(comparison)}${comparison.some((measure) => measure.insufficientSamples) ? "; insufficient samples" : ""}.`;
  console.log(`${verdict}\n${table}`);
  const summary = process.env["GITHUB_STEP_SUMMARY"];
  if (summary) appendFileSync(summary, `\n${verdict}\n${table}\n`);
  for (const measure of warnings)
    console.log(
      `::warning title=Performance comparison::${measure.name}: +${shown(measure.absoluteDelta)} ${measure.unit}${measure.insufficientSamples ? "; insufficient samples" : ""}; repeat on the same host before calling it a regression`,
    );
} catch (error) {
  writeFileSync(
    join(folder, "comparison.json"),
    JSON.stringify(
      {
        status: "invalid-instrumentation",
        elapsedMs: performance.now() - started,
        rawFiles,
        warmups,
        error: String(error),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  console.log(`Retained comparison: ${folder}`);
}

async function warmUp(executable: string) {
  const profile = mkdtempSync(join(tmpdir(), "mr-streamer-warm-"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const started = performance.now();
  const app = launch(executable, appArgs, { port, profile });
  try {
    const page = await connect(port, "page", { app });
    try {
      return await observeAcrossLoad(
        page,
        `!!document.querySelector('form button[type="submit"]')`,
        started,
      );
    } finally {
      page.close();
    }
  } finally {
    if (app.exitCode === null && app.signalCode === null) {
      const exited = once(app, "exit");
      app.kill("SIGTERM");
      await Promise.race([exited, delay(10_000)]);
      if (app.exitCode === null && app.signalCode === null) {
        app.kill("SIGKILL");
        await exited;
      }
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
