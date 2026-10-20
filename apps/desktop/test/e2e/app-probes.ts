// Optional diagnostics for measure-app.ts. These samples are deliberately separate from the
// comparator's latency metrics: CPU, scheduler wakeups and V8 samples have different limits.
import { execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessMetric } from "electron";
import { delay, key, revealFixtureList, waitFor, type Page } from "./app.ts";

const WINDOW_MS = 60_000;
const SAMPLE_MS = 5_000;
const electron = `process.getBuiltinModule('module').createRequire(process.execPath)('electron')`;
const windowExpression = `${electron}.BrowserWindow.getAllWindows().find(w => w.webContents.getURL() === globalThis.__probeURL)`;

type LinuxProcess = {
  pid: number;
  parent: number;
  startTicks: number;
  cpuSeconds: number;
  name: string;
};
type Sample = {
  startedMs: number;
  endedMs: number;
  loadAverage: number[];
  mainPid: number;
  rendererPid: number;
  window: { visible: boolean; minimized: boolean; focused: boolean; url: string };
  metrics: ProcessMetric[];
  descendants:
    | { status: "supported"; ticksPerSecond: number; processes: LinuxProcess[] }
    | { status: "unsupported"; reason: string };
};
type CpuProfile = {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
    hitCount?: number;
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
};

/** A missing/reset counter is unknown, never zero. Percent uses one logical CPU as 100%. */
export function cpuDelta(before: number | undefined, after: number | undefined, elapsedMs: number) {
  if (
    before === undefined ||
    after === undefined ||
    !Number.isFinite(before) ||
    !Number.isFinite(after) ||
    before < 0 ||
    after < before ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs <= 0
  )
    return {
      status: "unsupported" as const,
      reason: "Missing, non-finite or reset cumulative CPU counter",
    };
  const cpuSeconds = after - before;
  return {
    status: "supported" as const,
    cpuSeconds,
    percentOneCore: (cpuSeconds * 100_000) / elapsedMs,
  };
}

export function wakeupSupport(platform: string) {
  if (platform === "darwin")
    return {
      status: "supported" as const,
      source: "Electron app.getAppMetrics idleWakeupsPerSecond, macOS task interrupt wakeups",
      unit: "wakeups/s",
      scope: "Electron processes only; excludes external descendants",
      limitation: "Shared API interval can be reset by another caller; retain raw interval samples",
    };
  return {
    status: "unsupported" as const,
    unit: "wakeups/s",
    reason:
      platform === "linux"
        ? "Chromium uses voluntary context switches on Linux, not genuine wakeups; no scheduler trace collected"
        : platform === "win32"
          ? "Electron always returns zero on Windows; zero is not a wakeup measurement"
          : "No verified genuine wakeup source on this platform",
  };
}

// No command lines are read from other processes. Only descendants of our verified main PID
// are retained. A process that vanishes between listing and reading is absent from that sample.
function descendants(pid: number): Sample["descendants"] {
  if (process.platform !== "linux")
    return {
      status: "unsupported",
      reason: "OS descendant inventory implemented for Linux /proc only",
    };
  try {
    const ticksPerSecond = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }));
    if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) throw new Error("Invalid CLK_TCK");
    const all: LinuxProcess[] = [];
    for (const name of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        const stat = readFileSync(`/proc/${name}/stat`, "utf8");
        const end = stat.lastIndexOf(")");
        const fields = stat.slice(end + 2).split(" ");
        const item = {
          pid: Number(name),
          name: stat.slice(stat.indexOf("(") + 1, end),
          parent: Number(fields[1]),
          startTicks: Number(fields[19]),
          cpuSeconds: (Number(fields[11]) + Number(fields[12])) / ticksPerSecond,
        };
        if (
          Object.values(item).some((value) => typeof value === "number" && !Number.isFinite(value))
        )
          throw new Error("Invalid /proc stat");
        all.push(item);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== "ENOENT" &&
          (error as NodeJS.ErrnoException).code !== "ESRCH"
        )
          throw error;
      }
    }
    const owned = new Set([pid]);
    for (let size = 0; size !== owned.size;) {
      size = owned.size;
      for (const item of all) if (owned.has(item.parent)) owned.add(item.pid);
    }
    const processes = all.filter((item) => owned.has(item.pid));
    if (!processes.some((item) => item.pid === pid))
      throw new Error("Owned main disappeared from /proc");
    return { status: "supported", ticksPerSecond, processes };
  } catch (error) {
    return { status: "unsupported", reason: String(error) };
  }
}

function bundleIdentity(executable: string, appDirectory: string | undefined) {
  const files: Record<string, string> = {};
  const hash = (path: string, name: string) => {
    files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  };
  const tree = (path: string, prefix: string) => {
    for (const item of readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (item.isDirectory()) tree(join(path, item.name), `${prefix}/${item.name}`);
      else if (item.isFile()) hash(join(path, item.name), `${prefix}/${item.name}`);
      else if (
        item.isSymbolicLink() &&
        realpathSync(join(path, item.name)).startsWith(runtimeRoot + sep)
      )
        files[`${prefix}/${item.name}`] = `symlink:${readlinkSync(join(path, item.name))}`;
      else
        throw new Error(
          `Bundle identity refuses an untracked symlink/special file: ${prefix}/${item.name}`,
        );
    }
  };
  const runtimeRoot = realpathSync(
    process.platform === "darwin" ? dirname(dirname(dirname(executable))) : dirname(executable),
  );
  tree(runtimeRoot, "runtime");
  if (appDirectory) {
    hash(join(appDirectory, "package.json"), "app/package.json");
    tree(join(appDirectory, "out"), "app/out");
  }
  return {
    scope: appDirectory
      ? "Entire runtime directory plus app package.json and complete out tree; excludes node_modules"
      : "Entire executable directory including resources",
    files,
  };
}

async function command<T>(page: Page, method: string, params: Record<string, unknown> = {}) {
  const reply = await page.send(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result as T;
}

function summarize(samples: Sample[]) {
  const first = samples[0]!,
    last = samples.at(-1)!;
  const elapsedMs = last.startedMs - first.startedMs;
  const processes = first.metrics.map((before) => {
    const after = last.metrics.find(
      (item) => item.pid === before.pid && item.creationTime === before.creationTime,
    );
    const stable = samples.every((sample) =>
      sample.metrics.some(
        (item) => item.pid === before.pid && item.creationTime === before.creationTime,
      ),
    );
    const wakeups = wakeupSupport(process.platform);
    const rates = samples.slice(1).map((sample, index) => ({
      elapsedMs: sample.startedMs - samples[index]!.startedMs,
      rate: sample.metrics.find(
        (item) => item.pid === before.pid && item.creationTime === before.creationTime,
      )?.cpu.idleWakeupsPerSecond,
    }));
    return {
      wakeups:
        wakeups.status !== "supported"
          ? wakeups
          : !stable ||
              rates.some(
                (item) => item.rate === undefined || !Number.isFinite(item.rate) || item.rate < 0,
              )
            ? { status: "unsupported", reason: "Missing/reset wakeup rate" }
            : {
                ...wakeups,
                timeWeightedAverageRate:
                  rates.reduce((sum, item) => sum + item.rate! * item.elapsedMs, 0) / elapsedMs,
                intervalAssumption:
                  "No other caller reset app.getAppMetrics intervals; rates are Electron averages, not raw event counts",
              },
      pid: before.pid,
      creationTime: before.creationTime,
      type: before.type,
      role:
        before.pid === first.mainPid
          ? "main"
          : before.pid === first.rendererPid
            ? "renderer"
            : "electron-child",
      cpu: cpuDelta(
        before.cpu.cumulativeCPUUsage,
        stable ? after?.cpu.cumulativeCPUUsage : undefined,
        elapsedMs,
      ),
    };
  });
  const os =
    first.descendants.status === "supported" && last.descendants.status === "supported"
      ? first.descendants.processes.map((before) => {
          const after =
            last.descendants.status === "supported"
              ? last.descendants.processes.find(
                  (item) => item.pid === before.pid && item.startTicks === before.startTicks,
                )
              : undefined;
          return {
            pid: before.pid,
            name: before.name,
            startTicks: before.startTicks,
            cpu: cpuDelta(before.cpuSeconds, after?.cpuSeconds, elapsedMs),
          };
        })
      : null;
  return {
    elapsedMs,
    processes,
    osDescendantCpu: os,
    scope:
      "Per-process endpoint deltas, no invented total for transient/unobserved children; OS process counters include their threads",
    maxSnapshotMs: Math.max(...samples.map((sample) => sample.endedMs - sample.startedMs)),
  };
}

/** Drive only the disposable app created by measure-app; checkpoint each sample before waiting. */
export async function runAppProbes(options: {
  page: Page;
  main: Page;
  app: ChildProcess;
  executable: string;
  appDirectory: string | undefined;
  profile: string;
  output: string;
  idle: boolean;
  liveProfile: boolean;
  hostCondition: string;
}) {
  const { main, page, app, output } = options;
  const actions: { at: string; name: string }[] = [];
  const windows: {
    state: string;
    requestedMs: number;
    samples: Sample[];
    summary?: ReturnType<typeof summarize>;
    boundary?: unknown;
  }[] = [];
  const calibration: unknown[] = [];
  const profiles: unknown[] = [];
  const identity = bundleIdentity(options.executable, options.appDirectory);
  const harnessIdentity = Object.fromEntries(
    ["measure-app.ts", "app-probes.ts", "app.ts"].map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(join(import.meta.dirname, file)))
        .digest("hex"),
    ]),
  );
  let status = "running";
  let error: string | undefined;
  let processIdentity: unknown;
  const save = () =>
    writeFileSync(
      output,
      JSON.stringify(
        {
          schemaVersion: 1,
          tool: "app-probes",
          status,
          error,
          hostCondition: options.hostCondition,
          thresholdStatus:
            "unfrozen; quiet unchanged-build repeats required before a product hot-path patch",
          observation: {
            cpuUnit: "seconds and percent of one logical CPU",
            wakeups: wakeupSupport(process.platform),
            intervalMs: SAMPLE_MS,
            requestedWindowMs: WINDOW_MS,
            windowClock:
              "Harness monotonic clock; retain actual endpoint duration and snapshot uncertainty",
            observer:
              "One main-inspector snapshot per 5 seconds; renderer read only at window boundaries; no V8 profiler during idle windows",
            limitations:
              "Inspector and snapshot cost included. No native paint/GPU claim. Electron does not enumerate all external tools. Child births/exits between samples can be missed.",
          },
          identity,
          harnessIdentity,
          processIdentity,
          calibration,
          windows,
          profiles,
          actions,
        },
        null,
        2,
      ),
    );
  const action = (name: string) => {
    actions.push({ at: new Date().toISOString(), name });
    save();
  };
  let expectedMain: number | undefined, expectedRenderer: number | undefined;
  let mainBirth: number | undefined, rendererBirth: number | undefined;
  const snapshot = async (): Promise<Sample> => {
    const startedMs = performance.now();
    const raw = await main.evaluate<
      Omit<Sample, "startedMs" | "endedMs" | "loadAverage" | "descendants">
    >(`(() => {
      const w = ${windowExpression};
      if (!w) throw new Error('Owned renderer window disappeared');
      return { mainPid: process.pid, rendererPid: w.webContents.getOSProcessId(),
        window: { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), url: w.webContents.getURL() },
        metrics: ${electron}.app.getAppMetrics() };
    })()`);
    if (
      raw.mainPid !== app.pid ||
      raw.mainPid !== expectedMain ||
      raw.rendererPid !== expectedRenderer
    )
      throw new Error("Main/renderer process identity changed");
    for (const [pid, birth] of [
      [raw.mainPid, mainBirth],
      [raw.rendererPid, rendererBirth],
    ]) {
      if (!raw.metrics.some((item) => item.pid === pid && item.creationTime === birth))
        throw new Error("Process creation identity changed");
    }
    return {
      ...raw,
      startedMs,
      descendants: descendants(raw.mainPid),
      loadAverage: loadavg(),
      endedMs: performance.now(),
    };
  };
  const click = async (text: string) => {
    if (text === "All channels" || text === "TEST | Formats and failures") {
      if (await revealFixtureList(page, text)) action(`Reveal fixture list ${text}`);
    }
    action(`Click ${text}`);
    await page.evaluate(
      `(() => { const buttons = [...document.querySelectorAll('button, [role=button]')]; const b = buttons.find(b => b.title === ${JSON.stringify(text)} || b.textContent.trim() === ${JSON.stringify(text)}) ?? buttons.find(b => b.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) throw new Error('Missing button ' + ${JSON.stringify(text)}); b.click(); })()`,
    );
  };
  const list = async () => {
    await click("Live TV");
    await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('main [data-index]')`));
  };
  const boundary = () =>
    page.evaluate<{
      visibility: string;
      watch: boolean;
      rows: number;
      video: { currentTime: number; paused: boolean; width: number }[];
    }>(
      `({ visibility: document.visibilityState, watch: !!document.querySelector('[data-view="watch"]'), rows: document.querySelectorAll('main [data-index]').length, video: [...document.querySelectorAll('video')].map(v => ({ currentTime: v.currentTime, paused: v.paused, width: v.videoWidth })) })`,
    );
  try {
    const url = await page.evaluate<string>("location.href");
    if (
      !options.appDirectory ||
      !fileURLToPath(url).startsWith(join(resolve(options.appDirectory), "out", "renderer") + sep)
    )
      throw new Error("App probes currently require an identified built checkout renderer");
    processIdentity =
      await main.evaluate(`(() => { globalThis.__probeURL = ${JSON.stringify(url)}; const w = ${windowExpression};
      if (!w) throw new Error('No matching BrowserWindow'); return { pid: process.pid, argv: process.argv,
        execPath: process.execPath, userData: ${electron}.app.getPath('userData'), versions: process.versions,
        rendererPid: w.webContents.getOSProcessId(), url: w.webContents.getURL(), metrics: ${electron}.app.getAppMetrics() }; })()`);
    const owned = processIdentity as {
      pid: number;
      rendererPid: number;
      userData: string;
      metrics: ProcessMetric[];
    };
    if (owned.pid !== app.pid || owned.userData !== options.profile)
      throw new Error("Inspector is not the owned profile/process");
    expectedMain = owned.pid;
    expectedRenderer = owned.rendererPid;
    mainBirth = owned.metrics.find((item) => item.pid === owned.pid)?.creationTime;
    rendererBirth = owned.metrics.find((item) => item.pid === owned.rendererPid)?.creationTime;
    await snapshot();
    save();
    for (let run = 0; run < 3; run++) {
      const before = await snapshot();
      const after = await snapshot();
      calibration.push({ role: "observer", run, before, after, delta: summarize([before, after]) });
      save();
    }
    // A known busy pulse validates counter units and records snapshot cost. It cannot measure
    // host variance or establish an idle regression threshold, especially on a shared host.
    for (const [role, target] of [
      ["main", main],
      ["renderer", page],
    ] as const) {
      for (let run = 0; run < 3; run++) {
        const before = await snapshot();
        const pulse = await target.evaluate(
          `(() => { const start = performance.now(); while (performance.now() - start < 150) {} return performance.now() - start; })()`,
        );
        const after = await snapshot();
        calibration.push({
          role,
          run,
          requestedBusyMs: 150,
          observedBusyMs: pulse,
          before,
          after,
          delta: summarize([before, after]),
        });
        save();
      }
    }
    await list();
    await click("All channels");
    await waitFor(() =>
      page.evaluate<boolean>(
        `document.querySelector('main h1')?.textContent === 'All channels' && document.querySelectorAll('main [data-index]').length > 5`,
      ),
    );
    if (options.idle) {
      await command(page, "Emulation.setFocusEmulationEnabled", { enabled: false });
      for (const state of ["visible", "covered", "hidden"] as const) {
        if (state === "covered") {
          await click("Watch");
          await waitFor(() =>
            page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`),
          );
        }
        if (state === "hidden") await main.evaluate(`${windowExpression}.hide()`);
        // Let transitions settle before priming the cumulative and interval counters.
        await delay(2_000);
        const before = await boundary();
        if (
          before.watch !== (state !== "visible") ||
          before.rows === 0 ||
          !before.video.some((video) => !video.paused && video.width > 0)
        )
          throw new Error(`Unexpected ${state} workload before CPU window`);
        action(`Begin ${state} 60-second CPU window`);
        const window: (typeof windows)[number] = {
          state,
          requestedMs: WINDOW_MS,
          samples: [],
          boundary: { before },
        };
        windows.push(window);
        window.samples.push(await snapshot());
        save();
        const start = window.samples[0]!.startedMs;
        for (let index = 1; index <= WINDOW_MS / SAMPLE_MS; index++) {
          const deadline = start + index * SAMPLE_MS;
          // Timers can fire just before their requested deadline after millisecond rounding.
          while (performance.now() < deadline)
            await delay(Math.max(1, deadline - performance.now()));
          const sample = await snapshot();
          if (sample.window.visible !== (state !== "hidden"))
            throw new Error(`Window visibility changed during ${state}`);
          window.samples.push(sample);
          save();
        }
        const after = await boundary();
        window.boundary = { before, after };
        if (
          after.watch !== before.watch ||
          after.rows === 0 ||
          !after.video.some(
            (video, index) =>
              !video.paused &&
              video.width > 0 &&
              video.currentTime > (before.video[index]?.currentTime ?? Infinity),
          )
        )
          throw new Error(`Playback/view changed during ${state} CPU window`);
        window.summary = summarize(window.samples);
        // CPU resolution is a source property, not an empirical slowdown threshold.
        const os = window.samples[0]!.descendants;
        calibration.push({
          state,
          cpuCounterBoundaryFloor:
            os.status === "supported"
              ? {
                  source:
                    "Linux /proc user+system counters, two endpoints each; conservative four-tick floor",
                  cpuSeconds: 4 / os.ticksPerSecond,
                  percentOneCore: 400_000 / os.ticksPerSecond / window.summary.elapsedMs,
                }
              : {
                  status: "unsupported",
                  reason: "No verified cumulative CPU resolution on this platform",
                },
          thresholds: null,
        });
        save();
        action(`End ${state} CPU window`);
      }
      await main.evaluate(`${windowExpression}.show()`);
      await key(page, "Escape", 27);
      await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
      await list();
    }
    if (options.liveProfile) {
      const targets = [
        ["main", main],
        ["renderer", page],
      ] as const;
      const started: (typeof targets)[number][] = [];
      let pathError: unknown;
      action("Profile Live TV list, category, grid, programme search, Watch and return");
      try {
        for (const target of targets) {
          await command(target[1], "Profiler.enable");
          await command(target[1], "Profiler.setSamplingInterval", { interval: 1_000 });
          await command(target[1], "Profiler.start");
          started.push(target);
        }
        await click("TEST | Formats and failures");
        await waitFor(() =>
          page.evaluate<boolean>(
            `document.querySelector('main h1')?.textContent === 'TEST | Formats and failures'`,
          ),
        );
        await click("All channels");
        await waitFor(() =>
          page.evaluate<boolean>(`document.querySelectorAll('main [data-index]').length > 5`),
        );
        const scroll = async (selector: string) => {
          const start = await page.evaluate<number>(`${selector}.scrollTop`);
          const point = await page.evaluate<{ x: number; y: number }>(
            `(() => { const b = ${selector}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
          );
          for (let index = 0; index < 30; index++) {
            await command(page, "Input.dispatchMouseEvent", {
              type: "mouseWheel",
              ...point,
              deltaX: 0,
              deltaY: 120,
            });
            await delay(16);
          }
          await waitFor(() => page.evaluate<boolean>(`${selector}.scrollTop > ${start}`));
          action(`Scroll reached ${await page.evaluate<number>(`${selector}.scrollTop`)}px`);
        };
        action("Wheel Live TV list");
        await scroll("document.querySelector('main [data-index]').parentElement.parentElement");
        action("Open and wheel guide grid");
        await key(page, "g", 71);
        await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[role="grid"]')`));
        await scroll("document.querySelector('[role=grid]')");
        await key(page, "g", 71);
        action("Search programmes for news");
        await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
        await waitFor(() =>
          page.evaluate<boolean>(`!!document.querySelector('[role="combobox"]')`),
        );
        await command(page, "Input.insertText", { text: "news" });
        await waitFor(() =>
          page.evaluate<boolean>(
            `document.querySelector('[role="dialog"]')?.innerText.includes('On now') && document.querySelectorAll('[role="dialog"] [data-index]').length > 0`,
          ),
        );
        await key(page, "Escape", 27);
        // The closing search dialog still owns keyboard focus until its popup is gone.
        await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[role="dialog"]')`));
        await click("Watch");
        await waitFor(() =>
          page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`),
        );
        action("Open Watch channel overlay");
        await command(page, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 400 });
        await waitFor(() =>
          page.evaluate<boolean>(
            `!!document.querySelector('[data-view="watch"] button[aria-label="Channels"]')`,
          ),
        );
        await page.evaluate(
          `document.querySelector('[data-view="watch"] button[aria-label="Channels"]').click()`,
        );
        await waitFor(() =>
          page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"] [role=button]')`),
        );
        action("Return from playback");
        await key(page, "Escape", 27);
        // Let the overlay close before Escape addresses Watch, including on the native Mac.
        await waitFor(() =>
          page.evaluate<boolean>(`!document.querySelector('[data-view="watch"] [role=button]')`),
        );
        await key(page, "Escape", 27);
        await waitFor(() =>
          page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`),
        );
        await list();
      } catch (error) {
        pathError = error;
      }
      for (const [role, target] of started.reverse()) {
        try {
          const capture = await command<{ profile: CpuProfile }>(target, "Profiler.stop");
          if (
            !capture.profile?.nodes?.length ||
            !capture.profile.samples?.length ||
            !capture.profile.timeDeltas?.length
          )
            throw new Error(`Empty ${role} CPU profile`);
          const path = `${output}.${role}.cpuprofile`;
          writeFileSync(path, JSON.stringify(capture.profile));
          const total = capture.profile.timeDeltas.reduce((sum, value) => sum + value, 0);
          const times = new Map<number, number>();
          capture.profile.samples.forEach((id, index) =>
            times.set(id, (times.get(id) ?? 0) + capture.profile.timeDeltas[index]!),
          );
          profiles.push({
            role,
            pid: role === "main" ? expectedMain : expectedRenderer,
            path,
            intervalUs: 1_000,
            durationUs: capture.profile.endTime - capture.profile.startTime,
            scope:
              "V8 isolate sampled self time; excludes worker isolates, native CPU, GPU and paint; idle/program samples retained",
            busiest: capture.profile.nodes
              .map((node) => ({
                ...node.callFrame,
                sampledUs: times.get(node.id) ?? 0,
                share: (times.get(node.id) ?? 0) / total,
              }))
              .sort((a, b) => b.sampledUs - a.sampledUs)
              .slice(0, 20),
          });
          await command(target, "Profiler.disable");
          save();
        } catch (error) {
          pathError ??= error;
        }
      }
      if (pathError) throw pathError;
    }
    await snapshot();
    if (
      JSON.stringify(identity) !==
      JSON.stringify(bundleIdentity(options.executable, options.appDirectory))
    )
      throw new Error("Measured bundle changed during probes");
    status = "diagnostic-complete";
  } catch (failure) {
    status = "invalid-instrumentation";
    error = String(failure);
    throw failure;
  } finally {
    save();
  }
}
