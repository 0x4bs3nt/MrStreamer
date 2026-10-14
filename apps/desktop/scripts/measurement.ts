// Shared result contract for the existing measurement CLIs. Invalid instrumentation throws;
// exceeded performance budgets remain warnings and never turn a sample into zero.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { cpus, loadavg, platform, release } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type } from "arktype";

const Metric = type({
  unit: "'ms' | 'MB' | 'count'",
  samples: "number[]",
  "budget?": { limit: "number", outcome: "'pass' | 'warning'", basis: "'max' | 'median'" },
});
const Calibration = type({
  method: "string",
  knownDelayMs: "number",
  actualDelayMs: "number",
  observationErrorMs: "number",
  overheadMs: "number",
});
const Result = type({
  schemaVersion: "1",
  tool: "string",
  environment: {
    recordedAt: "string",
    platform: "string",
    cpu: "string",
    logicalCpus: "number",
    loadAverage: "number[]",
    node: "string",
    electron: "string",
    ffmpeg: "string",
    "fixtureFfmpeg?": "string",
    "playerFfmpeg?": "string",
    "appVersion?": "string",
    "buildHashScope?": "string",
    "revisionScope?": "string",
    "sourceStateScope?": "string",
    revision: "string",
    sourceDirty: "boolean | 'unknown'",
    buildMode: "string",
    buildSha256: "string",
  },
  workload: { "[string]": "string | number | boolean" },
  conditions: { "[string]": "string | number | boolean" },
  "calibration?": Calibration.array(),
  "observations?": type({ "[string]": "number | string | boolean" }).array(),
  metrics: { "[string]": Metric },
  checks: { "[string]": "boolean" },
});
export type Measurement = typeof Result.infer;
export type MetricSamples = typeof Metric.infer;

export function positiveCount(value: string, name: string, maximum: number): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > maximum)
    throw new Error(`${name} must be an integer from 1 to ${maximum}`);
  return count;
}

export function environment(
  options: {
    revision?: string;
    electron?: string;
    appDirectory?: string;
    executable?: string;
  } = {},
): Measurement["environment"] {
  const command = (file: string, args: string[]) => {
    try {
      return execFileSync(file, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "unavailable";
    }
  };
  const main = options.appDirectory ? resolve(options.appDirectory, "out/main/index.js") : "";
  const builtCheckout = !!main && existsSync(main);
  const buildMode = builtCheckout
    ? "built-checkout"
    : options.executable
      ? "packaged"
      : "node-source";
  const fixtureFfmpeg =
    command(process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg", ["-version"]).split("\n")[0] ??
    "unavailable";
  const resources = options.executable
    ? platform() === "darwin"
      ? resolve(dirname(options.executable), "../Resources")
      : join(dirname(options.executable), "resources")
    : "";
  const bundled = join(resources, "ffmpeg", platform() === "win32" ? "ffmpeg.exe" : "ffmpeg");
  const playerFfmpeg = !options.executable
    ? "not-used"
    : process.env["MR_STREAMER_FFMPEG"] || builtCheckout
      ? fixtureFfmpeg
      : existsSync(bundled)
        ? (command(bundled, ["-version"]).split("\n")[0] ?? "unavailable")
        : "unavailable";
  const sourceState = command("git", ["status", "--porcelain"]);
  return {
    recordedAt: new Date().toISOString(),
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    logicalCpus: cpus().length,
    loadAverage: loadavg(),
    node: process.version,
    electron: options.electron ?? "not-used",
    // Compatibility alias: this has always measured the fixture encoder, not the player bundle.
    ffmpeg: fixtureFfmpeg,
    fixtureFfmpeg,
    playerFfmpeg,
    appVersion: builtCheckout
      ? String(
          (
            JSON.parse(readFileSync(resolve(options.appDirectory!, "package.json"), "utf8")) as {
              version: string;
            }
          ).version,
        )
      : "unavailable",
    revision:
      options.revision ??
      (buildMode === "packaged" ? "unavailable" : command("git", ["rev-parse", "HEAD"])),
    revisionScope: options.revision
      ? "explicit measured build"
      : buildMode === "packaged"
        ? "unavailable"
        : "measuring checkout HEAD; rebuild required",
    sourceDirty: sourceState === "unavailable" ? "unknown" : sourceState !== "",
    sourceStateScope: "measuring checkout, not packaged source",
    buildMode,
    buildHashScope: builtCheckout
      ? "out/main/index.js only"
      : options.executable
        ? "executable only"
        : "not-applicable",
    buildSha256:
      main && existsSync(main)
        ? createHash("sha256").update(readFileSync(main)).digest("hex")
        : options.executable
          ? createHash("sha256").update(readFileSync(options.executable)).digest("hex")
          : "not-applicable",
  };
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0 || samples.some((sample) => !Number.isFinite(sample)))
    throw new Error("Instrumentation requires nonempty finite samples");
  const sorted = samples.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function metric(
  unit: MetricSamples["unit"],
  samples: number[],
  limit?: number,
  basis: "max" | "median" = "max",
): MetricSamples {
  const value = basis === "max" ? Math.max(...samples) : median(samples);
  return {
    unit,
    samples,
    ...(limit === undefined
      ? {}
      : {
          budget: {
            limit,
            basis,
            outcome: value < limit ? ("pass" as const) : ("warning" as const),
          },
        }),
  };
}

export function validateMeasurement(input: unknown): Measurement {
  const result = Result.assert(input);
  const expected =
    result.tool === "app"
      ? APP_METRICS
      : result.tool === "guide"
        ? GUIDE_METRICS
        : result.tool === "viewing"
          ? VIEWING_METRICS
          : null;
  if (!expected) throw new Error("Unknown measurement tool");
  if (
    JSON.stringify(Object.keys(result.metrics).sort()) !==
    JSON.stringify(Object.keys(expected).sort())
  )
    throw new Error("Instrumentation requires complete metric sets");
  for (const [name, unit] of Object.entries(expected))
    if (result.metrics[name]?.unit !== unit) throw new Error(`Incorrect metric unit: ${name}`);
  const subscriptions = positiveCount(String(result.workload["subscriptions"]), "subscriptions", 4);
  if (result.tool === "app") {
    const runs = positiveCount(String(result.workload["runs"]), "runs", 20);
    for (const name of ["time to picture", "channel switch"]) {
      const pictures =
        result.observations?.filter((observation) => observation["name"] === name) ?? [];
      if (pictures.length !== runs)
        throw new Error(`Incomplete moving picture observations: ${name}`);
      for (const picture of pictures) {
        const previous = picture["previousTime"],
          current = picture["currentTime"],
          width = picture["videoWidth"];
        if (
          typeof previous !== "number" ||
          typeof current !== "number" ||
          typeof width !== "number" ||
          !Number.isFinite(previous) ||
          !Number.isFinite(current) ||
          !Number.isFinite(width) ||
          previous < 0 ||
          current <= previous ||
          width <= 0
        )
          throw new Error(`Invalid moving picture observation: ${name}`);
      }
    }
    for (const [name, measure] of Object.entries(result.metrics)) {
      const count =
        name === "installed size (MB)" || name === "streams opened, Home to Watch (count)"
          ? 1
          : runs;
      if (measure.samples.length !== count) throw new Error(`Incomplete samples: ${name}`);
    }
    if (!result.calibration?.length) throw new Error("Missing renderer calibration");
    for (const sample of result.calibration)
      if (
        [
          sample.knownDelayMs,
          sample.actualDelayMs,
          sample.observationErrorMs,
          sample.overheadMs,
        ].some((value) => !Number.isFinite(value) || value < 0)
      )
        throw new Error("Invalid renderer calibration");
  }
  if (result.tool === "guide" || result.tool === "viewing") {
    const counts = result.tool === "guide" ? GUIDE_SAMPLE_COUNTS : VIEWING_SAMPLE_COUNTS;
    for (const [name, measure] of Object.entries(result.metrics)) {
      const expectedCount =
        name === "time to ready per subscription" ? subscriptions : counts[name];
      if (measure.samples.length !== expectedCount) throw new Error(`Incomplete samples: ${name}`);
    }
  }
  if (result.tool === "guide") {
    const channels = positiveCount(
      String(result.workload["guideChannels"]),
      "guideChannels",
      50000,
    );
    const programmes = positiveCount(
      String(result.workload["programmesPerChannel"]),
      "programmesPerChannel",
      GENERATED_GUIDE_PER_CHANNEL,
    );
    if (
      result.workload["source"] === "synthetic" &&
      channels * programmes > GENERATED_GUIDE_PROGRAMMES
    )
      throw new Error(`Generated guide exceeds ${GENERATED_GUIDE_PROGRAMMES} total programmes`);
    positiveCount(
      String(result.workload["documentBytes"]),
      "documentBytes",
      Number.MAX_SAFE_INTEGER,
    );
    if (
      result.workload["screenChannels"] !== 60 ||
      result.workload["channelsPerSubscription"] !== 13000
    )
      throw new Error("Invalid guide workload");
    positiveCount(String(result.workload["mappedChannels"]), "mappedChannels", 300);
    for (const [name, limit] of Object.entries(GUIDE_BUDGETS)) {
      const budget = result.metrics[name]!.budget;
      if (budget?.limit !== limit || budget.basis !== "max")
        throw new Error(`Incorrect guide budget: ${name}`);
    }
    if (result.metrics["download and index"]!.budget)
      throw new Error("Aggregate guide refresh has no per-subscription budget");
  }
  if (result.tool === "viewing") {
    const events = positiveCount(String(result.workload["inputEvents"]), "inputEvents", 1000000);
    const recorded = positiveCount(
      String(result.workload["recordedEvents"]),
      "recordedEvents",
      events + 2000,
    );
    if (
      recorded < 1000 ||
      result.workload["samples"] !== 1000 ||
      result.workload["moves"] !== 200 ||
      result.workload["orderedFavourites"] !== 1000 ||
      result.workload["channelsPerSubscription"] !== 13000 ||
      result.workload["seed"] !== 9
    )
      throw new Error("Invalid viewing workload");
  }
  const requiredChecks =
    result.tool === "app"
      ? ["completeMetrics", "movingPicture"]
      : result.tool === "guide"
        ? result.workload["source"] === "local-file"
          ? ["localDocumentLoaded"]
          : ["searchReturnsProgrammes", "listSearchReturnsChannels", "mappingsAvailable"]
        : ["rebuiltListsMatch", "rebuiltOrderMatches"];
  for (const check of requiredChecks)
    if (result.checks[check] !== true) throw new Error(`Invalid instrumentation: ${check}`);
  for (const values of [result.workload, result.conditions])
    if (Object.values(values).some((value) => typeof value === "number" && !Number.isFinite(value)))
      throw new Error("Non-finite measurement metadata");
  if (
    !Number.isInteger(result.environment.logicalCpus) ||
    result.environment.logicalCpus < 1 ||
    result.environment.loadAverage.length !== 3 ||
    result.environment.loadAverage.some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("Invalid environment metadata");
  if (
    result.environment.fixtureFfmpeg !== undefined &&
    result.environment.fixtureFfmpeg !== result.environment.ffmpeg
  )
    throw new Error("Fixture FFmpeg alias mismatch");
  for (const observation of result.observations ?? [])
    if (
      Object.values(observation).some(
        (value) => typeof value === "number" && !Number.isFinite(value),
      )
    )
      throw new Error("Non-finite observation metadata");
  if (result.tool === "app" && !(Number(result.conditions["timingResolutionMs"]) > 0))
    throw new Error("Missing timing resolution");
  for (const [name, measure] of Object.entries(result.metrics)) {
    median(measure.samples);
    if (measure.samples.some((sample) => sample < 0)) throw new Error(`Negative sample: ${name}`);
    if (measure.unit === "count" && measure.samples.some((sample) => !Number.isInteger(sample)))
      throw new Error(`Non-integer count sample: ${name}`);
    if (measure.budget && (!Number.isFinite(measure.budget.limit) || measure.budget.limit <= 0))
      throw new Error(`Invalid budget: ${name}`);
    if (measure.budget) {
      const value =
        measure.budget.basis === "max" ? Math.max(...measure.samples) : median(measure.samples);
      if (measure.budget.outcome !== (value < measure.budget.limit ? "pass" : "warning"))
        throw new Error(`Incorrect budget outcome: ${name}`);
    }
  }
  for (const [name, passed] of Object.entries(result.checks))
    if (!passed) throw new Error(`Invalid instrumentation: ${name}`);
  return result;
}

/** Prepare the requested destination before creating a fixture, profile or expensive workload. */
export function prepareMeasurementOutput(path: string): void {
  const directory = dirname(resolve(path));
  try {
    mkdirSync(directory, { recursive: true });
    accessSync(directory, constants.W_OK);
    if (existsSync(path)) {
      accessSync(path, constants.W_OK);
      const descriptor = openSync(path, "r+");
      closeSync(descriptor);
    } else {
      const descriptor = openSync(path, "wx");
      closeSync(descriptor);
      unlinkSync(path);
    }
  } catch (error) {
    throw new Error(`Measurement destination is not writable: ${path}`, { cause: error });
  }
}

export function saveMeasurement(path: string | undefined, result: Measurement): void {
  validateMeasurement(result);
  if (path) writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
}

export const MINIMUM_COMPARISON_SAMPLES = 5;

export function compareMeasurements(baseline: unknown[], candidate: unknown[]) {
  if (!baseline.length || baseline.length !== candidate.length)
    throw new Error("Incomplete comparison rounds");
  const before = baseline.map(validateMeasurement);
  const after = candidate.map(validateMeasurement);
  const first = before[0]!;
  const names = Object.keys(first.metrics).sort();
  for (const run of [...before, ...after]) {
    if (
      run.tool !== first.tool ||
      JSON.stringify(Object.keys(run.metrics).sort()) !== JSON.stringify(names)
    )
      throw new Error("Comparison requires identical metric sets and tools");
    for (const field of [
      "platform",
      "cpu",
      "logicalCpus",
      "node",
      "electron",
      "ffmpeg",
      "buildMode",
    ] as const)
      if (run.environment[field] !== first.environment[field])
        throw new Error(`Comparison requires identical environment: ${field}`);
    for (const name of names) {
      if (run.metrics[name]!.unit !== first.metrics[name]!.unit)
        throw new Error(`Comparison requires identical units: ${name}`);
      if (run.metrics[name]!.samples.length !== first.metrics[name]!.samples.length)
        throw new Error(`Comparison requires identical sample counts: ${name}`);
    }
    for (const field of ["workload", "conditions"] as const) {
      const entries = (value: Measurement[typeof field]) =>
        JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
      if (entries(run[field]) !== entries(first[field]))
        throw new Error(`Comparison requires identical ${field}`);
    }
  }
  const noiseMs = Math.max(
    20,
    ...[...before, ...after].map((run) =>
      Math.max(
        Number(run.conditions["timingResolutionMs"]) || 0,
        ...(run.calibration ?? []).map((sample) => sample.observationErrorMs * 2),
      ),
    ),
  );
  return names.map((name) => {
    const unit = first.metrics[name]!.unit;
    const a = before.flatMap((run) => run.metrics[name]!.samples);
    const b = after.flatMap((run) => run.metrics[name]!.samples);
    const baselineMedian = median(a),
      candidateMedian = median(b);
    const absoluteDelta = candidateMedian - baselineMedian;
    const relativeDelta = baselineMedian === 0 ? null : absoluteDelta / baselineMedian;
    const noise = unit === "ms" ? noiseMs : unit === "MB" ? 10 : 0;
    // Observed separation is conservative with few samples. Report all ranges, including outliers.
    const observedRangeGap = Math.min(...b) - Math.max(...a);
    const withinBuildSpread = Math.max(
      Math.max(...a) - Math.min(...a),
      Math.max(...b) - Math.min(...b),
    );
    const spread = (values: number[]) => ({
      min: Math.min(...values),
      max: Math.max(...values),
      samples: values.length,
    });
    const insufficientSamples =
      a.length < MINIMUM_COMPARISON_SAMPLES || b.length < MINIMUM_COMPARISON_SAMPLES;
    const warning =
      observedRangeGap > noise &&
      (unit === "count" ? absoluteDelta > 0 : relativeDelta === null || relativeDelta > 0.1);
    const outcome: "warning" | "inconclusive" | "pass" = warning
      ? "warning"
      : insufficientSamples
        ? "inconclusive"
        : "pass";
    return {
      name,
      unit,
      baselineMedian,
      candidateMedian,
      absoluteDelta,
      relativeDelta,
      baselineSpread: spread(a),
      candidateSpread: spread(b),
      noise,
      observationFloor: noise,
      observedRangeGap,
      withinBuildSpread,
      insufficientSamples,
      warningPolicy:
        unit === "count"
          ? "observed ranges separated and positive count delta"
          : "observed ranges separated beyond observation floor and median +10%",
      outcome,
    };
  });
}

/** Valid instrumentation can still be inconclusive; observed warnings survive small samples. */
export function comparisonVerdict(comparison: ReturnType<typeof compareMeasurements>) {
  if (comparison.some((measure) => measure.outcome === "warning")) return "warning";
  if (comparison.some((measure) => measure.insufficientSamples)) return "inconclusive";
  return "pass";
}

export const APP_METRICS = {
  "guide open": "ms",
  "guide list of 13,000": "ms",
  "time to picture": "ms",
  "streams opened per tune (count)": "count",
  "channel switch": "ms",
  "streams opened per switch (count)": "count",
  "search, typed to programmes shown": "ms",
  "streams opened, Home to Watch (count)": "count",
  "cold start to Home": "ms",
  "long series details, name shown": "ms",
  "long series details, episodes shown": "ms",
  "installed size (MB)": "MB",
} as const;

export function electronVersion(executable: string): string {
  return execFileSync(executable, ["-p", "process.versions.electron"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  }).trim();
}

/** The most programmes a generated guide has: about what a guide may unpack to, 2 GiB. */
const GENERATED_GUIDE_PROGRAMMES = 4_000_000;
/** The most programmes a generated guide channel has: two days of one-minute programmes. */
const GENERATED_GUIDE_PER_CHANNEL = 2 * 24 * 60;
const GUIDE_METRICS = {
  "longest stall while idle": "ms",
  "download and index": "ms",
  "time to ready per subscription": "ms",
  "longest stall while downloading": "ms",
  "read from disk after a restart": "ms",
  "longest stall while reading": "ms",
  "longest stall while answering": "ms",
  "now and next for 60 channels": "ms",
  "now and next for 60 guided channels": "ms",
  "range 30 channels by 6 hours": "ms",
  "search news": "ms",
  "list search news": "ms",
  "mapping list": "ms",
  "mapping list searched": "ms",
  "guide channels searched": "ms",
  "now and next channels mapped": "ms",
  "memory held by guide": "MB",
  "resident memory added": "MB",
  "peak resident memory added while indexing": "MB",
} as const;
const VIEWING_METRICS = {
  watch: "ms",
  favourite: "ms",
  start: "ms",
  "start with rebuild": "ms",
  "database size": "MB",
  "one favourite to end": "ms",
  "events one favourite to end": "count",
  "last favourite to front": "ms",
  "events last favourite to front": "count",
  "reverse favourites": "ms",
  "events reverse favourites": "count",
  "rebuild ordered favourites": "ms",
} as const;

const GUIDE_SAMPLE_COUNTS: Record<string, number> = {
  "longest stall while idle": 1,
  "download and index": 1,
  "longest stall while downloading": 1,
  "read from disk after a restart": 1,
  "longest stall while reading": 1,
  "longest stall while answering": 1,
  "now and next for 60 channels": 100,
  "now and next for 60 guided channels": 100,
  "range 30 channels by 6 hours": 20,
  "search news": 5,
  "list search news": 20,
  "mapping list": 20,
  "mapping list searched": 20,
  "guide channels searched": 20,
  "now and next channels mapped": 100,
  "memory held by guide": 1,
  "resident memory added": 1,
  "peak resident memory added while indexing": 1,
};
const GUIDE_BUDGETS = {
  "longest stall while downloading": 50,
  "longest stall while reading": 50,
  "longest stall while answering": 50,
  "now and next for 60 channels": 5,
  "now and next for 60 guided channels": 5,
  "now and next channels mapped": 5,
  "memory held by guide": 80,
  "resident memory added": 150,
};
const VIEWING_SAMPLE_COUNTS: Record<string, number> = {
  watch: 1000,
  favourite: 1000,
  start: 1,
  "start with rebuild": 1,
  "database size": 1,
  "one favourite to end": 200,
  "events one favourite to end": 200,
  "last favourite to front": 1,
  "events last favourite to front": 1,
  "reverse favourites": 1,
  "events reverse favourites": 1,
  "rebuild ordered favourites": 1,
};
