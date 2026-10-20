import type { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import { afterEach, expect, it, vi } from "vitest";
import {
  profileSummary,
  queryRetention,
  retentionRecord,
  steadyProfiles,
  steadyRecord,
  traceSummary,
  type AttributionContext,
  type CpuProfile,
  type TraceEvent,
} from "./app-attribution.ts";
import { connect, type Page } from "./app.ts";
import { runAppProbes } from "./app-probes.ts";

const directories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("reports CDP session closure, supports listener disposal and settles pending commands", async () => {
  vi.useFakeTimers();
  const sockets: EventTarget[] = [];
  class Socket extends EventTarget {
    constructor() {
      super();
      sockets.push(this);
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send() {}
    close() {
      this.dispatchEvent(new Event("close"));
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", async () => ({
    json: async () => [
      {
        type: "page",
        url: "file:///owned/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/owned",
      },
    ],
  }));
  const connecting = connect(12345);
  await vi.advanceTimersByTimeAsync(200);
  const page = await connecting;
  const removed = vi.fn();
  page.onClose(removed)();
  const closed = vi.fn();
  page.onClose(closed);
  const pending = page.send("Tracing.end");
  sockets[0]!.dispatchEvent(new Event("close"));
  await expect(pending).resolves.toMatchObject({ error: "DevTools connection closed" });
  expect(removed).not.toHaveBeenCalled();
  expect(closed).toHaveBeenCalledOnce();
  const late = vi.fn();
  page.onClose(late)();
  expect(late).toHaveBeenCalledOnce();
  const afterClose = page.send("IO.close");
  await vi.advanceTimersByTimeAsync(10_000);
  await expect(afterClose).resolves.toMatchObject({
    error: "DevTools connection closed",
  });
  expect(vi.getTimerCount()).toBe(0);
});

function profile(): CpuProfile {
  return {
    nodes: [{ id: 1, callFrame: { functionName: "work", url: "app.js", lineNumber: 0 } }],
    samples: [1],
    timeDeltas: [1000],
    startTime: 10,
    endTime: 1010,
  };
}
const metadata: TraceEvent = {
  name: "thread_name",
  ph: "M",
  pid: 7,
  tid: 1,
  ts: 0,
  args: { name: "CrRendererMain" },
};
const task: TraceEvent = { name: "RunTask", ph: "X", pid: 7, tid: 1, ts: 0, dur: 4000, tdur: 3000 };

it("counts empty-URL prototype names as ordinary function self time", () => {
  const names = [
    "toString",
    "valueOf",
    "constructor",
    "(idle)",
    "(program)",
    "(garbage collector)",
    "(root)",
    "(idle)",
  ];
  const result = profileSummary({
    nodes: names.map((functionName, index) => ({
      id: index + 1,
      callFrame: { functionName, url: index === 7 ? "app.js" : "", lineNumber: 0 },
    })),
    samples: [1, 2, 3, 4, 5, 6, 7, 8],
    timeDeltas: [1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800],
    startTime: 0,
    endTime: 11600,
  });
  expect(result).toMatchObject({
    sampledUs: 11600,
    idleUs: 1400,
    programUs: 1500,
    garbageCollectorUs: 1600,
    javascriptUs: 5400,
  });
  expect(
    result.top.map(({ functionName, url, sampledUs }) => ({ functionName, url, sampledUs })),
  ).toEqual([
    { functionName: "(idle)", url: "app.js", sampledUs: 1800 },
    { functionName: "constructor", url: "", sampledUs: 1300 },
    { functionName: "valueOf", url: "", sampledUs: 1200 },
    { functionName: "toString", url: "", sampledUs: 1100 },
  ]);
});

it.each<[string, (value: CpuProfile) => void]>([
  [
    "missing deltas",
    (p) => {
      p.timeDeltas = [];
    },
  ],
  [
    "mismatched deltas",
    (p) => {
      p.timeDeltas.push(1000);
    },
  ],
  [
    "nonfinite deltas",
    (p) => {
      p.timeDeltas[0] = NaN;
    },
  ],
  [
    "negative deltas",
    (p) => {
      p.timeDeltas[0] = -1;
    },
  ],
  [
    "zero sampled interval",
    (p) => {
      p.timeDeltas[0] = 0;
    },
  ],
  [
    "empty samples",
    (p) => {
      p.samples = [];
      p.timeDeltas = [];
    },
  ],
  [
    "nonfinite interval",
    (p) => {
      p.endTime = Infinity;
    },
  ],
  [
    "reversed interval",
    (p) => {
      p.endTime = p.startTime;
    },
  ],
  [
    "empty nodes",
    (p) => {
      p.nodes = [];
    },
  ],
  [
    "unknown sample",
    (p) => {
      p.samples[0] = 2;
    },
  ],
  [
    "duplicate node",
    (p) => {
      p.nodes.push(p.nodes[0]!);
    },
  ],
  [
    "unknown child",
    (p) => {
      p.nodes[0]!.children = [2];
    },
  ],
  [
    "cyclic ancestry",
    (p) => {
      p.nodes[0]!.children = [1];
    },
  ],
])("rejects a CPU profile with %s instead of reporting zero work", (_, change) => {
  const value = profile();
  change(value);
  expect(() => profileSummary(value)).toThrow(/CPU profile/);
});

it("retains count and wall time for missing/partial timeline and script CPU", () => {
  const call = (name: string, tdur?: number): TraceEvent => ({
    name: "FunctionCall",
    cat: "devtools.timeline",
    ph: "X",
    pid: 7,
    tid: 1,
    ts: 10,
    dur: 1000,
    ...(tdur === undefined ? {} : { tdur }),
    args: { data: { functionName: name, lineNumber: 4 } },
  });
  const result = traceSummary(
    [metadata, task, call("missing"), call("partial", 300), call("partial")],
    7,
  );
  expect(result.rendererMainTimeline).toEqual([
    {
      name: "FunctionCall",
      count: 3,
      wallMs: 3,
      cpuMs: null,
      cpu: { status: "partial", observedMs: 0.3, observedEvents: 1, missingEvents: 2 },
    },
  ]);
  expect(result.rendererMainScripts).toEqual([
    {
      name: "FunctionCall partial:5",
      count: 2,
      wallMs: 2,
      cpuMs: null,
      cpu: { status: "partial", observedMs: 0.3, observedEvents: 1, missingEvents: 1 },
    },
    {
      name: "FunctionCall missing:5",
      count: 1,
      wallMs: 1,
      cpuMs: null,
      cpu: { status: "unsupported", observedMs: 0, observedEvents: 0, missingEvents: 1 },
    },
  ]);
  const ranked = traceSummary(
    [metadata, task, call("partial", 3000), call("partial"), call("supported", 100)],
    7,
  );
  expect(ranked.rendererMainScripts[0]).toMatchObject({
    name: "FunctionCall supported:5",
    cpuMs: 0.1,
  });
});

it("counts equal-start nested tasks outermost first regardless of event order", () => {
  const inner = { ...task, dur: 1000, tdur: 900 };
  const first = traceSummary([metadata, inner, task], 7);
  expect(first).toEqual(traceSummary([task, metadata, inner], 7));
  expect(first.threads[0]).toMatchObject({
    tasks: 1,
    wallMs: 4,
    cpu: { status: "supported", ms: 3 },
  });
});

it("keeps observed outer-task CPU and missing wall time separate from complete totals", () => {
  const missing = { ...task };
  delete missing.tdur;
  const result = traceSummary(
    [
      metadata,
      task,
      { ...missing, ts: 5000, dur: 2000 },
      { ...task, tid: 2, dur: 9000, tdur: 8000 },
      { ...missing, tid: 2, ts: 10000 },
      { ...missing, tid: 3 },
      { ...task, tid: 4, tdur: 100 },
    ],
    7,
  );
  expect(result.threads.map((t) => t.cpu)).toEqual([
    { status: "supported", ms: 0.1 },
    { status: "partial", observedMs: 8, observedTasks: 1, missingTasks: 1, missingWallMs: 4 },
    { status: "partial", observedMs: 3, observedTasks: 1, missingTasks: 1, missingWallMs: 2 },
    { status: "unsupported", observedMs: 0, observedTasks: 0, missingTasks: 1, missingWallMs: 4 },
  ]);
});

it.each([[], [metadata], [task], [{ ...metadata, pid: 8 }, task]].map((events) => ({ events })))(
  "rejects a trace without the expected renderer's main-thread tasks %#",
  ({ events }) => {
    expect(() => traceSummary(events, 7)).toThrow(/trace/);
  },
);

/** A protocol peer with controlled capture failures; it launches no app. */
function capture(mode = "success", capturedProfile = profile(), events = [metadata, task]) {
  vi.useFakeTimers();
  const directory = mkdtempSync(join(tmpdir(), "attribution-contract-"));
  directories.push(directory);
  const listeners = new Map<string, (params: unknown) => void>();
  const closes = new Set<() => void>();
  const calls: string[] = [];
  const closeTimeouts: number[] = [];
  let clock = 0;
  const page: Page = {
    async send(method, _params, timeoutMs) {
      calls.push(method);
      if (method === "IO.close") closeTimeouts.push(timeoutMs!);
      if (method === "Profiler.stop") return { result: { profile: capturedProfile } };
      if (method === "Tracing.end") {
        if (mode === "end-error") return { error: "end refused" };
        if (mode === "invalid-completion") listeners.get("Tracing.tracingComplete")?.({});
        else if (mode === "closed") for (const listener of closes) listener();
        else if (mode !== "missing-completion")
          listeners.get("Tracing.tracingComplete")?.({
            stream: "trace-stream",
            dataLossOccurred: mode === "data-loss",
          });
      }
      if (method === "IO.read") {
        if (mode === "read-error" || mode === "read-and-close-error")
          return { error: "read refused" };
        if (mode === "stream-deadline") {
          vi.advanceTimersByTime(60_001);
          return { result: { data: "partial", eof: false } };
        }
        return { result: { data: JSON.stringify({ traceEvents: events }), eof: true } };
      }
      if (method === "IO.close" && mode.includes("close-error")) return { error: "close refused" };
      return { result: {} };
    },
    on(method, listener) {
      listeners.set(method, listener);
      return () => {
        listeners.delete(method);
      };
    },
    onClose(listener) {
      closes.add(listener);
      return () => {
        closes.delete(listener);
      };
    },
    async evaluate<T>(expression: string): Promise<T> {
      let result: unknown = true;
      if (expression.includes("querySelectorAll('video')"))
        result = [{ currentTime: ++clock, paused: false, width: 1280 }];
      else if (expression.includes("Object.fromEntries")) result = {};
      return result as T;
    },
    close: vi.fn(),
  };
  const context: AttributionContext = {
    page,
    main: page,
    output: join(directory, "capture"),
    rendererPid: 7,
    action: vi.fn(),
    save: vi.fn(),
    click: vi.fn(),
    list: vi.fn(),
    metrics: async () => [],
  };
  return { context, page, directory, calls, closeTimeouts, listeners, closes };
}

it.each([
  ["missing-completion", "Trace completion timed out"],
  ["closed", "DevTools session closed"],
  ["end-error", "end refused"],
  ["read-error", "read refused"],
  ["invalid-completion", "Trace completion has no IO stream"],
  ["stream-deadline", "Trace IO stream exceeded 120 s"],
])(
  "rejects %s and reaches the owning caller's teardown with no trace listeners",
  async (mode, message) => {
    const peer = capture(mode);
    const result = steadyProfiles(peer.context, steadyRecord()).finally(() => peer.page.close());
    const rejected = expect(result).rejects.toThrow(message);
    await vi.runAllTimersAsync();
    await rejected;
    expect(peer.page.close).toHaveBeenCalledOnce();
    expect(peer.listeners.size).toBe(0);
    expect(peer.closes.size).toBe(0);
    if (mode === "read-error" || mode === "stream-deadline")
      expect(peer.calls).toContain("IO.close");
  },
);

it("retains both raw profiles and disables both targets before rejecting a malformed main profile", async () => {
  const invalid = profile();
  invalid.timeDeltas = [];
  const peer = capture();
  const ipc = ipcPeer(peer);
  const send = peer.context.main.send;
  peer.context.main.send = vi.fn(async (method, params, timeoutMs) =>
    method === "Profiler.stop" ? { result: { profile: invalid } } : send(method, params, timeoutMs),
  );
  peer.page.send = vi.fn(peer.page.send);
  const record = steadyRecord();
  const result = expect(steadyProfiles(peer.context, record)).rejects.toThrow(/CPU profile/);
  await vi.runAllTimersAsync();
  await result;
  expect(
    JSON.parse(readFileSync(`${peer.context.output}.steady-live.main.cpuprofile`, "utf8")),
  ).toEqual(invalid);
  expect(
    JSON.parse(readFileSync(`${peer.context.output}.steady-live.renderer.cpuprofile`, "utf8")),
  ).toEqual(profile());
  for (const target of [peer.context.main, peer.page])
    expect(vi.mocked(target.send).mock.calls.map(([method]) => method)).toEqual(
      expect.arrayContaining(["Profiler.stop", "Profiler.disable"]),
    );
  expect(record.windows).toEqual([]);
  expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["stop", "disable", "write"])(
  "retains renderer data and cleans up both targets after main %s fails",
  async (failure) => {
    const peer = capture();
    const ipc = ipcPeer(peer);
    const mainPath = `${peer.context.output}.steady-live.main.cpuprofile`;
    if (failure === "write") mkdirSync(mainPath);
    const primary = new Error(`main ${failure} failed`);
    const send = peer.context.main.send;
    peer.context.main.send = vi.fn(async (method, params, timeoutMs) => {
      if (method === `Profiler.${failure}`) throw primary;
      return send(method, params, timeoutMs);
    });
    peer.page.send = vi.fn(peer.page.send);
    const record = steadyRecord();
    const result = steadyProfiles(peer.context, record).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await result;
    expect(error).toBeInstanceOf(AggregateError);
    expect(String(error)).toContain(failure === "write" ? "EISDIR" : primary.message);
    expect(
      JSON.parse(readFileSync(`${peer.context.output}.steady-live.renderer.cpuprofile`, "utf8")),
    ).toEqual(profile());
    if (failure === "disable")
      expect(JSON.parse(readFileSync(mainPath, "utf8"))).toEqual(profile());
    for (const target of [peer.context.main, peer.page])
      expect(vi.mocked(target.send).mock.calls.map(([method]) => method)).toEqual(
        expect.arrayContaining(["Profiler.stop", "Profiler.disable"]),
      );
    expect(record.windows).toEqual([]);
    expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("preserves both targets' stop and disable failures alongside IPC restoration failure", async () => {
  const peer = capture();
  ipcPeer(peer);
  const failures = new Map<string, Error>();
  for (const [role, target] of [
    ["main", peer.context.main],
    ["renderer", peer.page],
  ] as const) {
    const send = target.send;
    target.send = vi.fn(async (method, params, timeoutMs) => {
      if (method === "Profiler.stop" || method === "Profiler.disable") {
        const error = new Error(`${role} ${method} failed`);
        failures.set(`${role} ${method}`, error);
        if (method === "Profiler.stop")
          peer.context.main.evaluate = async () => {
            throw new Error("IPC restore failed");
          };
        throw error;
      }
      return send(method, params, timeoutMs);
    });
  }
  const result = steadyProfiles(peer.context, steadyRecord()).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect(failures.size).toBe(4);
  for (const failure of failures.values()) expect(String(error)).toContain(failure.message);
  const causes = (error: unknown): unknown[] =>
    error instanceof AggregateError ? error.errors.flatMap(causes) : [error];
  expect(causes(error)).toEqual(expect.arrayContaining([...failures.values()]));
  expect(String(error)).toContain("IPC restore failed");
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects a captured empty trace and retains its raw file", async () => {
  const peer = capture("success", profile(), []);
  const result = expect(steadyProfiles(peer.context, steadyRecord())).rejects.toThrow(/trace/);
  await vi.runAllTimersAsync();
  await result;
  expect(JSON.parse(readFileSync(`${peer.context.output}.steady-live.trace.json`, "utf8"))).toEqual(
    { traceEvents: [] },
  );
  expect(peer.calls).toContain("IO.close");
});

it.each(["data-loss", "close-error", "read-and-close-error"])(
  "rejects %s without losing capture or cleanup evidence",
  async (mode) => {
    const peer = capture(mode);
    const record = steadyRecord();
    const error = steadyProfiles(peer.context, record).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const rejected = await error;
    expect(rejected).toBeInstanceOf(Error);
    if (mode === "data-loss") expect(String(rejected)).toContain("data loss");
    if (mode.includes("close-error")) expect(String(rejected)).toContain("close refused");
    if (mode === "read-and-close-error") expect(String(rejected)).toContain("read refused");
    else
      expect(
        JSON.parse(readFileSync(`${peer.context.output}.steady-live.trace.json`, "utf8")),
      ).toEqual({ traceEvents: [metadata, task] });
    expect(record.windows).toEqual([]);
    expect(peer.calls).toContain("IO.close");
    expect(peer.closeTimeouts).toEqual([10_000]);
    expect(peer.listeners.size + peer.closes.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);

/** Executes the probe's actual main-process expressions against an owned IPC registry. */
function ipcPeer(peer: ReturnType<typeof capture>) {
  let sizings = 0;
  const handler = async () => ({
    toJSON() {
      sizings++;
      return ["channels"];
    },
  });
  const handlers = new Map([["library.browse", handler]]);
  const runtime = createContext({
    Buffer,
    Map,
    process: {
      getBuiltinModule: () => ({
        createRequire: () => () => ({ ipcMain: { _invokeHandlers: handlers } }),
      }),
      memoryUsage: () => ({}),
    },
  });
  peer.context.main = {
    ...peer.page,
    async evaluate<T>(expression: string): Promise<T> {
      return (await runInContext(expression, runtime)) as T;
    },
  };
  return { handlers, handler, sizings: () => sizings };
}

it.each(["steady", "retention"])(
  "restores original IPC handlers after a failed %s probe",
  async (kind) => {
    const peer = capture();
    const ipc = ipcPeer(peer);
    peer.context.list = async () => {
      await ipc.handlers.get("library.browse")!();
      throw new Error("list failed");
    };
    const result = expect(
      kind === "steady"
        ? steadyProfiles(peer.context, steadyRecord())
        : queryRetention(peer.context, retentionRecord()),
    ).rejects.toThrow("list failed");
    await vi.runAllTimersAsync();
    await result;
    expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
    const before = ipc.sizings();
    await ipc.handlers.get("library.browse")!();
    expect(ipc.sizings()).toBe(before);
  },
);

it.each(["steady", "retention"])(
  "retains capture and IPC cleanup failures for %s",
  async (kind) => {
    const peer = capture();
    ipcPeer(peer);
    peer.context.list = async () => {
      peer.context.main.evaluate = async () => {
        throw new Error("IPC cleanup unavailable");
      };
      throw new Error("primary capture failed");
    };
    const result = (
      kind === "steady"
        ? steadyProfiles(peer.context, steadyRecord())
        : queryRetention(peer.context, retentionRecord())
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = String(await result);
    expect(error).toContain("primary capture failed");
    expect(error).toContain("IPC cleanup unavailable");
  },
);

it("records ISO wall-clock brackets for each profile and the separate trace", async () => {
  const peer = capture();
  const ipc = ipcPeer(peer);
  const record = steadyRecord();
  const result = steadyProfiles(peer.context, record);
  await vi.runAllTimersAsync();
  await result;
  expect(record.windows).toHaveLength(3);
  for (const window of record.windows as {
    startedAt: string;
    endedAt: string;
    profiles: { startedAt: string; endedAt: string }[];
    trace: { startedAt: string; endedAt: string };
  }[]) {
    expect(Date.parse(window.endedAt) - Date.parse(window.startedAt)).toBe(60_000);
    for (const profile of window.profiles) {
      expect(new Date(profile.startedAt).toISOString()).toBe(profile.startedAt);
      expect(Date.parse(profile.endedAt) - Date.parse(profile.startedAt)).toBe(60_000);
    }
    expect(Date.parse(window.trace.startedAt)).toBeGreaterThanOrEqual(Date.parse(window.endedAt));
    expect(Date.parse(window.trace.endedAt) - Date.parse(window.trace.startedAt)).toBe(20_000);
  }
  expect(peer.listeners.size + peer.closes.size).toBe(0);
  expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
});

it("runs the live-profile workflow after steady profiles end on Home without retention", async () => {
  const peer = capture();
  ipcPeer(peer);
  const appDirectory = join(peer.directory, "app");
  const runtime = join(peer.directory, "runtime");
  mkdirSync(join(appDirectory, "out", "renderer"), { recursive: true });
  mkdirSync(runtime);
  writeFileSync(join(appDirectory, "package.json"), "{}");
  const executable = join(runtime, "fake-electron");
  writeFileSync(executable, "protocol fixture only");
  const url = pathToFileURL(join(appDirectory, "out", "renderer", "index.html")).href;
  const metrics = [process.pid, 7].map((pid) => ({
    pid,
    creationTime: 1,
    type: "fixture",
    cpu: { cumulativeCPUUsage: 0 },
    memory: { workingSetSize: 0 },
  }));
  const mainEvaluate = peer.context.main.evaluate;
  peer.context.main.evaluate = async <T>(expression: string): Promise<T> => {
    let result: unknown;
    if (expression.includes("return { pid: process.pid"))
      result = { pid: process.pid, rendererPid: 7, userData: peer.directory, metrics };
    else if (expression.includes("return { mainPid: process.pid"))
      result = { mainPid: process.pid, rendererPid: 7, window: {}, metrics };
    else if (expression.includes("while (performance.now() - start < 150)")) result = 150;
    else return mainEvaluate<T>(expression);
    return result as T;
  };
  const browser = new Window();
  const picked: string[] = [];
  const show = (view: string) => {
    browser.document.body.innerHTML = `<header><button>Live TV</button><button>Home</button><button>Watch</button></header>
      ${view === "Live TV" ? '<nav role="navigation" aria-label="Channel categories"><button title="All channels">All channels</button><button title="TEST | Formats and failures">TEST | Formats and failures</button></nav>' : ""}`;
    for (const button of browser.document.querySelectorAll("header button"))
      button.addEventListener("click", () => show(button.textContent!));
    for (const button of browser.document.querySelectorAll("nav button"))
      button.addEventListener("click", () => picked.push(button.textContent!));
  };
  show("Live TV");
  const evaluate = peer.page.evaluate;
  peer.page.evaluate = async <T>(expression: string): Promise<T> => {
    if (expression === "location.href") return url as T;
    if (expression.includes("Channel categories") || expression.includes("const buttons"))
      return browser.eval(expression) as T;
    return evaluate<T>(expression);
  };
  const result = runAppProbes({
    page: peer.page,
    main: peer.context.main,
    app: { pid: process.pid } as ChildProcess,
    executable,
    appDirectory,
    profile: peer.directory,
    output: peer.context.output,
    idle: false,
    liveProfile: true,
    steadyProfile: true,
    queryRetention: false,
    hostCondition: "fixture",
  }).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toBeUndefined();
  const report = JSON.parse(readFileSync(peer.context.output, "utf8"));
  expect(report.status).toBe("diagnostic-complete");
  expect(report.steady.windows).toHaveLength(3);
  expect(report.profiles).toHaveLength(2);
  expect(picked).toContain("TEST | Formats and failures");
});

it.each(["available", "empty", "missing"])(
  "records truthful country-filter work and calibrated returns with %s options",
  async (countryFilter) => {
    const peer = capture();
    const ipc = ipcPeer(peer);
    const timedSizings: number[] = [];
    const browser = new Window();
    browser.document.body.innerHTML =
      countryFilter === "missing"
        ? ""
        : `<button data-browse-filter="countries">Countries</button>`;
    const filters: string[][] = [];
    const trigger = browser.document.querySelector("button");
    if (trigger)
      trigger.onclick = () => {
        const menu = browser.document.createElement("div");
        menu.setAttribute("role", "menu");
        for (const country of [
          "Any",
          ...(countryFilter === "available" ? ["United Kingdom"] : []),
        ]) {
          const option = browser.document.createElement("button");
          option.setAttribute("role", "menuitemcheckbox");
          option.textContent = country;
          option.onclick = () => {
            filters.push(country === "Any" ? [] : [country]);
            menu.remove();
          };
          menu.append(option);
        }
        browser.document.body.append(menu);
      };
    peer.context.list = async () => {
      await ipc.handlers.get("library.browse")!();
    };
    peer.page.evaluate = async <T>(expression: string): Promise<T> => {
      let result: unknown = true;
      if (expression.includes("new Promise")) {
        if (expression.includes('=== "Live TV"')) {
          const before = ipc.sizings();
          await ipc.handlers.get("library.browse")!();
          timedSizings.push(ipc.sizings() - before);
          result = 17;
        } else result = 10;
      } else if (expression === "window.__calibrationActual") result = 10;
      else if (expression.includes("getQueryCache().getAll()")) result = [];
      else if (expression.includes("Object.fromEntries")) result = {};
      else if (expression.includes("main h1")) result = "All channels";
      else if (expression.includes(".map(b => b.title)"))
        result = ["All channels", "United Kingdom"];
      else if (
        expression.includes("[role=menu]") ||
        expression.includes("[data-browse-filter=countries]")
      )
        result = browser.eval(expression);
      return result as T;
    };
    const record = retentionRecord();
    const result = queryRetention(peer.context, record).catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    const error = await result;
    if (countryFilter !== "available") {
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain(
        countryFilter === "empty" ? "No country option" : "No country filter",
      );
      expect(filters).toEqual([]);
      expect(record.workload).toBeNull();
      expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
      expect(vi.getTimerCount()).toBe(0);
      return;
    }
    expect(error).toBeUndefined();
    expect(filters).toEqual([["United Kingdom"], []]);
    expect(record.returnTiming).toMatchObject({
      method: "renderer-mutation-and-probe",
      configuredResolutionMs: 5,
      ipcReplySizing: false,
    });
    expect(record.returnTiming.calibration).toHaveLength(24);
    expect(record.returns).toEqual([
      {
        name: "warm return to Live TV",
        rowsShownMs: 17,
        ipc: { "library.browse": expect.objectContaining({ calls: 1, replyBytes: 0 }) },
      },
      {
        name: "cold return to Live TV",
        rowsShownMs: 17,
        ipc: { "library.browse": expect.objectContaining({ calls: 1, replyBytes: 0 }) },
      },
    ]);
    expect(timedSizings).toEqual([0, 0]);
    expect(ipc.sizings()).toBe(1);
    expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
    await ipc.handlers.get("library.browse")!();
    expect(ipc.sizings()).toBe(1);
    const following = retentionRecord();
    const again = queryRetention(peer.context, following);
    await vi.runAllTimersAsync();
    await again;
    expect(following.returns).toEqual(record.returns);
    expect(timedSizings).toEqual([0, 0, 0, 0]);
    expect(ipc.handlers.get("library.browse")).toBe(ipc.handler);
  },
);
