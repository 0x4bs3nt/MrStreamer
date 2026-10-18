import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_METRICS,
  APP_SEARCH_METRICS,
  compareMeasurements,
  metric,
  positiveCount,
  validateMeasurement,
  type Measurement,
} from "../scripts/measurement.ts";

/** Runs a Node script to its end, as CI would, without holding the test worker meanwhile. */
async function run(args: readonly string[]) {
  const child = spawn(process.execPath, args);
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const [status] = (await once(child, "close")) as [number | null];
  return { status, stdout, stderr };
}

const compareBuilds = resolve("apps/desktop/test/e2e/compare-builds.ts");

function report(): Measurement {
  return {
    schemaVersion: 1,
    tool: "app",
    environment: {
      recordedAt: "2026-10-08T00:00:00Z",
      platform: "contract",
      cpu: "fixture",
      logicalCpus: 2,
      loadAverage: [0, 0, 0],
      node: "24",
      electron: "44",
      ffmpeg: "8",
      revision: "fixture",
      sourceDirty: false,
      buildMode: "built-checkout",
      buildSha256: "fixture",
    },
    workload: { runs: 1, subscriptions: 2 },
    conditions: { timingResolutionMs: 5, cache: "fixture" },
    observations: [
      { name: "time to picture", previousTime: 0.2, currentTime: 0.21, videoWidth: 1280 },
      { name: "channel switch", previousTime: 0.2, currentTime: 0.21, videoWidth: 1280 },
    ],
    calibration: [
      {
        method: "probe-only",
        knownDelayMs: 5,
        actualDelayMs: 5,
        observationErrorMs: 1,
        overheadMs: 0.1,
      },
    ],
    metrics: Object.fromEntries(
      Object.entries(APP_METRICS).map(([name, unit]) => [
        name,
        metric(unit, [unit === "ms" ? 100 : 1]),
      ]),
    ),
    checks: { completeMetrics: true, movingPicture: true },
  };
}

describe("measurement result contract", () => {
  it("requires every warm search query and its declared sample count", () => {
    const measured = report();
    measured.workload["warmSearchRunsPerQuery"] = 30;
    for (const [name, unit] of Object.entries(APP_SEARCH_METRICS))
      measured.metrics[name] = metric(
        unit,
        Array.from({ length: 30 }, () => 150),
      );
    expect(validateMeasurement(measured).metrics["warm palette: news"]?.samples).toHaveLength(30);
    measured.metrics["warm palette: news"]!.samples.pop();
    expect(() => validateMeasurement(measured)).toThrow(/Incomplete samples/);
    delete measured.metrics["warm palette: news"];
    expect(() => validateMeasurement(measured)).toThrow(/complete metric/);
  });

  it("compares complete samples with absolute deltas, spread and warning-only budgets", () => {
    const before = report(),
      after = report();
    after.metrics["time to picture"]!.samples = [140];
    const measure = compareMeasurements([before], [after]).find(
      (value) => value.name === "time to picture",
    );
    expect(measure).toMatchObject({
      absoluteDelta: 40,
      relativeDelta: 0.4,
      baselineSpread: { min: 100, max: 100, samples: 1 },
      outcome: "warning",
    });
    expect(
      validateMeasurement({
        ...report(),
        metrics: { ...report().metrics, "time to picture": metric("ms", [100], 50) },
      }).metrics["time to picture"]?.budget?.outcome,
    ).toBe("warning");
  });

  it("rejects missing metrics, empty/non-finite samples, incorrect units and failed readiness", () => {
    const missing = report();
    delete missing.metrics["time to picture"];
    expect(() => compareMeasurements([report()], [missing])).toThrow(/complete metric/);
    for (const samples of [[], [NaN], [Infinity]]) {
      const invalid = report();
      invalid.metrics["time to picture"]!.samples = samples;
      expect(() => validateMeasurement(invalid)).toThrow();
    }
    const wrongUnit = report();
    wrongUnit.metrics["time to picture"]!.unit = "count";
    expect(() => compareMeasurements([report()], [wrongUnit])).toThrow(/unit/);
    expect(() => compareMeasurements([], [])).toThrow(/rounds/);
    const failed = report();
    failed.checks["movingPicture"] = false;
    expect(() => validateMeasurement(failed)).toThrow(/movingPicture/);
  });

  it("requires matched workload, round count and sample count", () => {
    const other = report();
    other.workload["subscriptions"] = 1;
    expect(() => compareMeasurements([report()], [other])).toThrow(/workload/);
    expect(() => compareMeasurements([report()], [report(), report()])).toThrow(/rounds/);
    const short = report();
    short.workload["runs"] = 2;
    expect(() => validateMeasurement(short)).toThrow(/samples|observations/);
  });

  it("uses calibrated resolution and handles a zero baseline without invented percentages", () => {
    const before = report(),
      after = report();
    before.metrics["streams opened, Home to Watch (count)"]!.samples = [0];
    after.calibration![0]!.observationErrorMs = 30;
    after.metrics["time to picture"]!.samples = [140];
    const result = compareMeasurements([before], [after]);
    expect(result.find((measure) => measure.name === "time to picture")).toMatchObject({
      noise: 60,
      outcome: "inconclusive",
    });
    expect(
      result.find((measure) => measure.name === "streams opened, Home to Watch (count)"),
    ).toMatchObject({ absoluteDelta: 1, relativeDelta: null, outcome: "warning" });
  });
});

it("comparison CLI retains a warning verdict but exits nonzero for invalid instrumentation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "measurement-contract-"));
  try {
    const before = join(directory, "before.json");
    writeFileSync(before, JSON.stringify(report()));
    const slower = report();
    slower.metrics["time to picture"]!.samples = [140];
    const incomplete = report();
    delete incomplete.metrics["time to picture"];
    /** Compares the baseline with `candidate` offline, each into its own retained folder. */
    const compare = async (name: string, candidate: Measurement) => {
      const after = join(directory, `${name}.json`),
        output = join(directory, name);
      writeFileSync(after, JSON.stringify(candidate));
      const result = await run([
        compareBuilds,
        "--baseline-json",
        before,
        "--candidate-json",
        after,
        "--output",
        output,
      ]);
      return {
        after,
        result,
        saved: JSON.parse(readFileSync(join(output, "comparison.json"), "utf8")),
      };
    };
    const [valid, inconclusive, invalid] = await Promise.all([
      compare("warning", slower),
      compare("inconclusive", report()),
      compare("invalid", incomplete),
    ]);
    expect(valid.result.status, valid.result.stderr).toBe(0);
    expect(valid.saved).toMatchObject({
      status: "valid",
      verdict: "warning",
      insufficientSamples: true,
      minimumSamplesPerSide: 5,
      rawFiles: [before, valid.after],
    });
    expect(valid.result.stdout).toContain("insufficient samples");
    expect(valid.result.stdout).toContain("1/1 (insufficient; minimum 5)");
    expect(valid.result.stdout).toContain(
      "::warning title=Performance comparison::time to picture: +40.0 ms; insufficient samples;",
    );
    expect(inconclusive.result.status, inconclusive.result.stderr).toBe(0);
    expect(inconclusive.saved).toMatchObject({
      status: "valid",
      verdict: "inconclusive",
      insufficientSamples: true,
    });
    expect(inconclusive.result.stdout).toContain(
      "Instrumentation valid; verdict inconclusive; insufficient samples",
    );
    expect(invalid.result.status).toBe(1);
    expect(invalid.saved).toMatchObject({
      status: "invalid-instrumentation",
      rawFiles: [before, invalid.after],
    });
    expect(readFileSync(before, "utf8")).toBeTruthy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // Three Node processes at once, which a busy suite can hold up.
}, 20_000);

it("counts are whole numbers from 1 to their maximum", () => {
  expect(positiveCount("1", "rounds", 20)).toBe(1);
  expect(positiveCount("20", "rounds", 20)).toBe(20);
  for (const value of ["0", "21", "NaN", "2.5", "-1", ""])
    expect(() => positiveCount(value, "rounds", 20)).toThrow(
      "rounds must be an integer from 1 to 20",
    );
});

it.concurrent.each([
  ["test/e2e/compare-builds.ts", "--rounds", "21", "unused", "unused"],
  ["test/e2e/measure-app.ts", "--runs", "NaN", "unused"],
  ["scripts/measure-guide.ts", "--guide-channels=-1"],
  ["scripts/measure-viewing.ts", "--events", "2.5"],
])(
  "public %s CLI rejects invalid count %s %s before workloads",
  async (file, ...args) => {
    const result = await run([resolve("apps/desktop", file), ...args]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toMatch(/must be an integer from 1/);
  },
  // A Node process each, all at once, which a busy suite can hold up.
  20_000,
);

it("rejects retained reports with forged movement or unmatched execution environments", () => {
  const mutations: ((value: Measurement) => void)[] = [
    (value) => {
      delete value.observations;
    },
    (value) => {
      value.observations![0]!["currentTime"] = 0.2;
    },
    (value) => {
      value.observations![0]!["videoWidth"] = 0;
    },
    (value) => {
      value.observations!.push(value.observations![0]!);
    },
    ...(["platform", "cpu", "node", "electron", "ffmpeg"] as const).map(
      (field) => (value: Measurement) => {
        value.environment[field] = "different";
      },
    ),
    (value) => {
      value.environment.logicalCpus = 4;
    },
    (value) => {
      value.environment.loadAverage = [Infinity, 0, 0];
    },
  ];
  for (const mutate of mutations) {
    const value = report();
    mutate(value);
    expect(() => compareMeasurements([report()], [value])).toThrow();
  }
});

it("small public workloads create nested destinations and reject incomplete retained service reports", async () => {
  const directory = mkdtempSync(join(tmpdir(), "measurement-services-"));
  try {
    // A regular file cannot be a destination directory. Fail before generating even this tiny guide.
    const blocker = join(directory, "blocker");
    writeFileSync(blocker, "occupied");
    const workloads = [
      ["guide", ["--guide-channels", "2", "--programmes", "70"], "now and next for 60 channels"],
      ["viewing", ["--events", "1"], "watch"],
    ] as const;
    const [denied, ...measured] = await Promise.all([
      run([
        "--expose-gc",
        resolve("apps/desktop/scripts/measure-guide.ts"),
        "--guide-channels",
        "2",
        "--json",
        join(blocker, "result.json"),
      ]),
      ...workloads.map(([tool, args]) =>
        run([
          "--expose-gc",
          resolve(`apps/desktop/scripts/measure-${tool}.ts`),
          ...args,
          "--json",
          join(directory, tool, "nested", "result.json"),
        ]),
      ),
    ]);
    expect(denied!.status).toBe(1);
    expect(denied!.stderr).toContain("Measurement destination is not writable");
    for (const [index, [tool, , metricName]] of workloads.entries()) {
      expect(measured[index]!.status, measured[index]!.stderr).toBe(0);
      const retained = JSON.parse(
        readFileSync(join(directory, tool, "nested", "result.json"), "utf8"),
      ) as Measurement;
      expect(retained.tool).toBe(tool);
      expect(() => compareMeasurements([retained], [retained])).not.toThrow();
      const mutations: ((value: Measurement) => void)[] = [
        (value) => {
          value.metrics[metricName]!.samples = [1];
        },
        (value) => {
          value.workload["subscriptions"] = 99;
        },
        (value) => {
          value.workload[tool === "guide" ? "programmesPerChannel" : "inputEvents"] = -1;
        },
      ];
      for (const mutate of mutations) {
        const value = structuredClone(retained);
        mutate(value);
        expect(() => compareMeasurements([value], [value])).toThrow();
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  // The guide workload indexes in a worker thread started from source.
}, 60000);

it("reports separated slowdowns, overlapping ranges and insufficient samples", () => {
  // Two samples are enough to inspect ranges, but do not claim repeated-comparison confidence.
  const before = report(),
    after = report();
  for (const value of [before, after]) {
    value.workload["runs"] = 2;
    for (const [name, measure] of Object.entries(value.metrics))
      if (name !== "installed size (MB)" && name !== "streams opened, Home to Watch (count)")
        measure.samples.push(measure.samples[0]!);
    value.observations!.push(...structuredClone(value.observations!));
  }
  before.metrics["time to picture"]!.samples = [100, 130];
  after.metrics["time to picture"]!.samples = [120, 200];
  after.metrics["channel switch"]!.samples = [140, 160];
  const comparison = compareMeasurements([before], [after]);
  expect(comparison.find((value) => value.name === "time to picture")).toMatchObject({
    outcome: "inconclusive",
    insufficientSamples: true,
    observedRangeGap: -10,
  });
  expect(comparison.find((value) => value.name === "channel switch")).toMatchObject({
    outcome: "warning",
    observedRangeGap: 40,
  });
});

it("requires five pooled samples and warns on separated count increases, including exactly one", () => {
  const countReport = (count: number) => {
    const value = report();
    value.metrics["streams opened per tune (count)"]!.samples = [count];
    return value;
  };
  const baseline = [1, 1, 2, 1, 1].map(countReport);
  const candidate = [2, 2, 2, 2, 2].map(countReport);
  const overlap = compareMeasurements(baseline, candidate);
  expect(overlap.find((value) => value.name === "streams opened per tune (count)")).toMatchObject({
    absoluteDelta: 1,
    observedRangeGap: 0,
    insufficientSamples: false,
    outcome: "pass",
  });
  expect(overlap.every((value) => value.outcome === "pass")).toBe(true);
  expect(
    compareMeasurements(baseline.slice(0, 4), candidate.slice(0, 4)).every(
      (value) => value.outcome === "inconclusive" && value.insufficientSamples,
    ),
  ).toBe(true);
  const separated = compareMeasurements(
    Array.from({ length: 5 }, () => countReport(10)),
    Array.from({ length: 5 }, () => countReport(11)),
  );
  expect(separated.find((value) => value.name === "streams opened per tune (count)")).toMatchObject(
    {
      absoluteDelta: 1,
      relativeDelta: 0.1,
      observedRangeGap: 1,
      outcome: "warning",
    },
  );
});
