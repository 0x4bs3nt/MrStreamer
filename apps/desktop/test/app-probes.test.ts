import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { profileSummary, traceSummary, type TraceEvent } from "./e2e/app-attribution.ts";
import { cpuDelta, wakeupSupport } from "./e2e/app-probes.ts";

it("reports cumulative CPU in seconds and percent of one core over the actual window", () => {
  expect(cpuDelta(20, 21.2, 60_000)).toMatchObject({
    status: "supported",
    cpuSeconds: expect.closeTo(1.2),
    percentOneCore: expect.closeTo(2),
  });
  expect(cpuDelta(20, 20, 60_000)).toMatchObject({
    status: "supported",
    cpuSeconds: 0,
    percentOneCore: 0,
  });
  for (const [before, after, elapsed] of [
    [undefined, 1, 60_000],
    [1, undefined, 60_000],
    [2, 1, 60_000],
    [0, NaN, 60_000],
    [0, 1, 0],
  ] as const)
    expect(cpuDelta(before, after, elapsed).status).toBe("unsupported");
});

it("does not label Linux context switches or Windows placeholder zero as wakeups", () => {
  expect(wakeupSupport("linux").status).toBe("unsupported");
  expect(wakeupSupport("win32").status).toBe("unsupported");
  expect(wakeupSupport("darwin")).toMatchObject({ status: "supported", unit: "wakeups/s" });
});

it("refuses ambiguous diagnostic CLI invocations before starting an app", () => {
  for (const args of [
    ["--diagnostics-only"],
    ["--covered-idle", "--idle-probes"],
    ["--covered-idle", "--query-retention"],
    ["--host-condition", "possibly-quiet"],
  ]) {
    const result = spawnSync(process.execPath, ["apps/desktop/test/e2e/measure-app.ts", ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(
      /requires --idle-probes, --live-profile, --steady-profile or --query-retention|Run --covered-idle separately|--host-condition must/,
    );
  }
});

it("attributes V8 self time by function and keeps idle, native and collector time apart", () => {
  const frame = (functionName: string, lineNumber = 0, url = "app.js") => ({
    functionName,
    url: functionName.startsWith("(") ? "" : url,
    lineNumber,
  });
  const summary = profileSummary({
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 3, 5, 6] },
      { id: 2, callFrame: frame("render", 9), children: [4] },
      { id: 3, callFrame: frame("(idle)") },
      { id: 4, callFrame: frame("hashKey", 41) },
      { id: 5, callFrame: frame("(program)") },
      { id: 6, callFrame: frame("tick", 3), children: [7] },
      { id: 7, callFrame: frame("hashKey", 41) },
    ],
    samples: [4, 4, 7, 3, 3, 3, 5, 2],
    timeDeltas: [1000, 1000, 1000, 5000, 5000, 5000, 2000, 1000],
    startTime: 0,
    endTime: 21_000,
  });
  expect(summary).toMatchObject({
    sampledUs: 21_000,
    idleUs: 15_000,
    programUs: 2000,
    javascriptUs: 4000,
  });
  expect(summary.top[0]).toMatchObject({
    functionName: "hashKey",
    lineNumber: 42,
    sampledUs: 3000,
    shareOfBusy: 0.5,
    stacks: [
      { stack: "render:10", sampledUs: 2000 },
      { stack: "tick:4", sampledUs: 1000 },
    ],
  });
});

it("counts each thread's outer task time once and never reports missing thread time as zero", () => {
  const task = (tid: number, ts: number, dur: number, tdur?: number): TraceEvent => ({
    name: "ThreadControllerImpl::RunTask",
    cat: "toplevel",
    ph: "X",
    pid: 7,
    tid,
    ts,
    dur,
    ...(tdur === undefined ? {} : { tdur }),
  });
  const summary = traceSummary(
    [
      { name: "process_name", ph: "M", pid: 7, tid: 0, ts: 0, args: { name: "Renderer" } },
      { name: "thread_name", ph: "M", pid: 7, tid: 1, ts: 0, args: { name: "CrRendererMain" } },
      { name: "thread_name", ph: "M", pid: 7, tid: 2, ts: 0, args: { name: "Compositor" } },
      task(1, 0, 4000, 3000),
      task(1, 1000, 1000, 900),
      task(1, 10_000, 2000, 1000),
      {
        name: "FunctionCall",
        cat: "devtools.timeline",
        ph: "X",
        pid: 7,
        tid: 1,
        ts: 100,
        dur: 3000,
        tdur: 2500,
        args: { data: { functionName: "refresh", lineNumber: 11 } },
      },
      task(2, 0, 500),
    ],
    7,
  );
  expect(summary.threads).toEqual([
    expect.objectContaining({
      thread: "CrRendererMain",
      renderer: true,
      tasks: 2,
      wallMs: 6,
      cpu: { status: "supported", ms: 4 },
    }),
    expect.objectContaining({
      thread: "Compositor",
      cpu: expect.objectContaining({ status: "unsupported" }),
    }),
  ]);
  expect(summary.rendererMainScripts).toEqual([
    { name: "FunctionCall refresh:12", count: 1, wallMs: 3, cpuMs: 2.5 },
  ]);
});
