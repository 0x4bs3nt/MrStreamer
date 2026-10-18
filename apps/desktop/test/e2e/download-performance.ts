// Native Electron diagnostic. Run serially for each frozen build, with the same executable:
// xvfb-run -a node apps/desktop/test/e2e/download-performance.ts --app-dir /build/apps/desktop \
//   --executable /path/to/electron --revision SHA --output .local/native-download/before
// No Xvfb on macOS. Production bundles expose root commits, not React Profiler durations.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { cpus, loadavg, platform, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import type { SeriesDetails } from "@mrstreamer/contracts/ondemand";
import { freePort, stop } from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";
import { startFakeProvider, fixture } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { connect, key, waitFor, type Page } from "./app.ts";
import { seedCopies, slowProvider } from "./download-performance-fixture.ts";

const { values } = parseArgs({
  options: {
    "app-dir": { type: "string" },
    executable: { type: "string" },
    revision: { type: "string" },
    output: { type: "string" },
  },
});
if (!values["app-dir"] || !values.executable || !values.output || !values.revision)
  throw new Error(
    "Required: --app-dir DIR --executable PATH --revision SHA --output NEW_DIRECTORY",
  );
const appDir = resolve(values["app-dir"]);
const executable = resolve(values.executable);
const output = resolve(values.output);
await mkdir(output); // Refuse to overwrite evidence, including failed runs.
const profile = await mkdtemp(join(tmpdir(), "mrstreamer-native-download-"));
const clip = join(profile, "seed.mp4");
await writeFile(clip, fixture("title-h264-aac.mp4"));
const results: Record<string, unknown> = {
  revision: values.revision,
  appDir,
  executable,
  output,
  profile,
  conditions: {
    platform: platform(),
    release: release(),
    arch: process.arch,
    node: process.version,
    cpus: cpus().length,
    cpu: cpus()[0]?.model,
    load: loadavg(),
    display: process.env["DISPLAY"],
    viewport: { width: 1280, height: 900 },
    warmup: 5,
    samples: 30,
    caches:
      "Fresh disposable profile per build; UI login then closed-app seed; one startup with seeded disk caches; five warm cached detail opens and five scroll warmups. OS page cache is not flushed.",
    labels:
      "CDP send to observed scroll / subsequent RAF is not physical paint latency. Performance metrics are renderer main-thread task time; CPU profile samples attribute JS. React instrumentation counts root commits only, not per-component duration.",
  },
};
let app: ChildProcess | undefined;
let page: Page | undefined;
let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
let proxy: Awaited<ReturnType<typeof slowProvider>> | undefined;
let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
const logs: string[] = [];
const trace: unknown[] = [];
let profiling = false;
let tracing = false;
let traceComplete = false;
const watchdog = setTimeout(() => {
  logs.push("Ten minute deadline\n");
  app?.kill("SIGTERM");
}, 600_000);
let failure: unknown;
const signals = () => {
  failure = new Error("Interrupted");
  app?.kill("SIGTERM");
};
process.once("SIGINT", signals);
process.once("SIGTERM", signals);

async function manifest(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await manifest(name));
    else
      hashes[name] = createHash("sha256")
        .update(await readFile(name))
        .digest("hex");
  }
  return hashes;
}

async function checked(method: string, params: Record<string, unknown> = {}) {
  assert(page);
  const reply = await page.send(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function start() {
  const port = await freePort();
  const started = performance.now();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("MR_STREAMER_") &&
        ![
          "ELECTRON_RUN_AS_NODE",
          "NODE_OPTIONS",
          "LANGUAGE",
          "LANG",
          "LC_ALL",
          "LC_MESSAGES",
        ].includes(name),
    ),
  );
  app = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--enable-automation",
      "--use-mock-keychain",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      appDir,
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        LANG: "en_US.UTF-8",
        LANGUAGE: "en_US",
        MR_STREAMER_UPDATE_CHECKS: "off",
        MR_STREAMER_TMDB_API: tmdb!.url,
        MR_STREAMER_TMDB_KEY: "test-key",
      },
    },
  );
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  page = await connect(port, "page", { app, pollMs: 10 });
  const command = (await checked("Browser.getBrowserCommandLine")) as { arguments: string[] };
  assert(
    command.arguments.includes(appDir) && command.arguments.includes(`--user-data-dir=${profile}`),
  );
  const url = await page.evaluate<string>("location.href");
  assert(url.startsWith(pathToFileURL(join(appDir, "out/renderer/")).href));
  await checked("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await checked("Emulation.setFocusEmulationEnabled", { enabled: true });
  await waitFor(
    () => page!.evaluate<boolean>("!!document.querySelector('header, form input')"),
    30000,
  );
  return { pid: app.pid, port, url, startedToReadyMs: performance.now() - started };
}

async function quit() {
  if (app) await stop(app, page);
  page?.close();
  page = undefined;
  app = undefined;
}

const button = (scope: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(scope)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const poster = (text: string) =>
  `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(text)}))`;
async function click(element: string) {
  await waitFor(() => page!.evaluate<boolean>(`!!(${element})`), 15000);
  await page!.evaluate(`(${element}).scrollIntoView({block:'nearest'})`);
  const point = await page!.evaluate<{ x: number; y: number }>(
    `(() => { const b=(${element}).getBoundingClientRect(); return {x:b.x+b.width/2,y:b.y+b.height/2}; })()`,
  );
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await checked("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}
async function capture(name: string) {
  const shot = (await checked("Page.captureScreenshot", { format: "png" })) as { data: string };
  await writeFile(join(output, `${name}.png`), Buffer.from(shot.data, "base64"));
}
async function list() {
  return page!.evaluate<DownloadList>(
    "window.mrStreamer.invoke('downloads.list').then(r=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value})",
  );
}
async function openSeries() {
  await click(button("header button", "Series"));
  await click(button("nav button", "All series"));
  await waitFor(() => page!.evaluate<boolean>(`!!(${poster("Long-running")})`), 15000);
  // Metadata can reorder the first catalogue load. Settle before choosing its pointer target;
  // this navigation preparation is outside the measured details-open window.
  await delay(1000);
}
async function details() {
  const start = performance.now();
  await click(poster("Long-running"));
  await waitFor(
    () =>
      page!.evaluate<boolean>(
        "document.querySelectorAll('[aria-label^=\"Download S1 E\"]').length === 26",
      ),
    15000,
  );
  return performance.now() - start;
}
async function identity() {
  return page!.evaluate<{ rows: string[]; seasons: string[]; versions: string[] }>(`(() => {
    const d=document.querySelector('[role=dialog]');
    return { rows:[...d.querySelectorAll('[aria-label^="Download S1 E"]')].map(b=>b.getAttribute('aria-label')),
      seasons:[...d.querySelectorAll('button[aria-pressed]')].filter(b=>/^(Season|Seizoen) \\d+$/.test(b.textContent.trim())).map(b=>b.textContent.trim()+':'+b.getAttribute('aria-pressed')),
      versions:[...d.querySelectorAll('[aria-label*="version" i]')].map(b=>b.getAttribute('aria-label')+':'+b.textContent) };
  })()`);
}
async function catalogueIdentity() {
  const subscriptionId = (await list()).items[0]?.subscription?.id;
  assert(subscriptionId);
  const details = await page!.evaluate<SeriesDetails>(`window.mrStreamer.invoke('ondemand.details',
    {kind:'series',version:{id:'70000',subscriptionId:${JSON.stringify(subscriptionId)}}})
    .then(r=>{if(!r.ok)throw Error(JSON.stringify(r));return r.value})`);
  assert.equal(details.seasons.length, 20);
  const ordered = details.seasons.flatMap((s) =>
    s.episodes.map((e) => ({
      subscriptionId: e.subscriptionId,
      id: e.id,
      season: e.season,
      number: e.number,
    })),
  );
  assert.equal(ordered.length, 520);
  assert.deepEqual(
    ordered.map((e) => e.id),
    Array.from({ length: 520 }, (_, i) => String(7000000 + i)),
  );
  return { ordered, versions: details.title.versions };
}
async function metrics() {
  const reply = (await checked("Performance.getMetrics")) as {
    metrics: { name: string; value: number }[];
  };
  return Object.fromEntries(reply.metrics.map((m) => [m.name, m.value]));
}

try {
  results["hashesBefore"] = await manifest(join(appDir, "out"));
  provider = await startFakeProvider({ channels: 20, titles: 12, series: 12, longSeries: true });
  // Keep a valid movie at its front; trailing padding only lengthens the actual transfer.
  provider.replaceMovieFile(
    90000,
    Buffer.concat([fixture("title-h264-eac3-subs.mkv"), Buffer.alloc(8 * 1024 * 1024)]),
  );
  provider.replaceEpisodeFile(
    7000000,
    Buffer.concat([fixture("title-h264-aac.mp4"), Buffer.alloc(2 * 1024 * 1024)]),
  );
  proxy = await slowProvider(provider.url);
  tmdb = await startFakeTmdb();
  results["loginStart"] = await start();
  await waitFor(
    () => page!.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    15000,
  );
  for (const [index, text] of [proxy.url, "demo", "demo"].entries()) {
    await click(`document.querySelectorAll('form input')[${index}]`);
    await checked("Input.insertText", { text });
  }
  await click("document.querySelector('form button[type=submit]')");
  await waitFor(() => page!.evaluate<boolean>("!!document.querySelector('header')"), 30000);
  await openSeries();
  await details();
  results["fixtureIdentity"] = await identity();
  await quit();
  results["seed"] = await seedCopies(profile, clip);
  results["seededStart"] = await start();
  await waitFor(() => page!.evaluate<boolean>("!!document.querySelector('header')"), 30000);
  assert.equal(
    (await list()).items.filter((i) => i.status.kind === "complete" && i.subscription).length,
    2000,
  );
  // Reload installs a read-only React DevTools hook before React initializes. Startup above is
  // measured without it. Neither this hook nor the event observer changes application state.
  await checked("Page.enable");
  await checked("Page.addScriptToEvaluateOnNewDocument", {
    source: `
    window.__rootCommits=[];
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true, inject:()=>1,
      onCommitFiberRoot:()=>window.__rootCommits.push(performance.now()),
      onCommitFiberUnmount:()=>{}, onPostCommitFiberRoot:()=>{}};
  `,
  });
  await checked("Page.reload");
  await waitFor(
    () =>
      page!.evaluate<boolean>(
        "!!document.querySelector('header') && !!window.__rootCommits?.length",
      ),
    15000,
  );
  await key(page!, "Escape", 27);
  await openSeries();
  await click(button("header button", "Movies"));
  await click(button("nav button", "All movies"));
  await click(poster("Two sound tracks"));
  await click(button('[role="dialog"] button', "Download"));
  await waitFor(
    async () =>
      (await list()).items.some(
        (i) =>
          i.title.kind === "movie" && i.title.id === "90000" && i.status.kind === "transferring",
      ),
    15000,
  );
  await key(page!, "Escape", 27);
  await openSeries();
  results["contentTransferBefore"] = (await list()).items.find(
    (i) => i.status.kind === "transferring",
  );
  const content: { sample: number; warmup: boolean; cdpTo26RowsMs: number }[] = [];
  results["content"] = content;
  for (let index = 0; index < 35; index++) {
    content.push({ sample: index - 4, warmup: index < 5, cdpTo26RowsMs: await details() });
    await key(page!, "Escape", 27);
    await waitFor(() => page!.evaluate<boolean>("!document.querySelector('[role=dialog]')"), 5000);
  }
  results["contentTransferAfter"] = (await list()).items.find(
    (i) => i.status.kind === "transferring",
  );
  await details();
  const beforeIdentity = await identity();
  const beforeCatalogue = await catalogueIdentity();
  results["beforeIdentity"] = beforeIdentity;
  results["beforeCatalogue"] = beforeCatalogue;
  assert.equal(beforeIdentity.rows.length, 26);
  assert.equal(beforeIdentity.seasons.length, 20);
  await page!.evaluate(
    `document.querySelector('[aria-label="Download S1 E1"]').scrollIntoView({block:'center'})`,
  );
  await capture("details-before");
  await page!.evaluate(`(() => {
    const d=document.querySelector('[role=dialog]');
    const s=[d,...d.querySelectorAll('*')].find(e=>e.scrollHeight>e.clientHeight+200 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    if(!s) throw Error('No native scrolling details container');
    window.__scrollElement=s; window.__frames=[]; window.__events=[];
    window.__stopDownloadObserver=window.mrStreamer.on('downloads.changed',list=>{
      const a=list.items.filter(i=>i.status.kind==='transferring');
      window.__events.push({at:performance.now(),count:list.items.length,bytes:list.bytes,
        advancing:a.map(i=>({id:i.title.id,kind:i.title.kind,received:i.status.received,size:i.status.size})),
        complete:list.items.filter(i=>i.status.kind==='complete').length});
    });
    window.__framing=true; let previous=performance.now();
    function frame(now){window.__frames.push({at:now,interval:now-previous});previous=now;if(window.__framing)requestAnimationFrame(frame)}
    requestAnimationFrame(frame);
  })()`);
  await checked("Performance.enable");
  await checked("Profiler.enable");
  await checked("Profiler.setSamplingInterval", { interval: 1000 });
  await checked("Profiler.start");
  profiling = true;
  page!.on("Tracing.dataCollected", (params) =>
    trace.push(...(params as { value: unknown[] }).value),
  );

  page!.on("Tracing.tracingComplete", () => {
    traceComplete = true;
  });
  await checked("Tracing.start", {
    categories: "devtools.timeline,v8,blink.user_timing",
    options: "record-as-much-as-possible",
  });
  tracing = true;
  const samples: Record<string, unknown>[] = [];
  results["scroll"] = samples;
  for (let index = 0; index < 35; index++) {
    const prior = await metrics();
    const armed = await page!.evaluate<{
      top: number;
      max: number;
      x: number;
      y: number;
      events: number;
      commits: number;
      at: number;
    }>(`(() => {
      const s=window.__scrollElement,b=s.getBoundingClientRect();
      window.__inputSample={top:s.scrollTop,armed:performance.now(),scroll:null,raf:null};
      const f=()=>{if(s.scrollTop===window.__inputSample.top)return; s.removeEventListener('scroll',f);
        window.__inputSample.scroll=performance.now();window.__inputSample.observedTop=s.scrollTop;
        requestAnimationFrame(t=>{window.__inputSample.raf=performance.now();window.__inputSample.rafFrameStamp=t})};
      s.addEventListener('scroll',f,{passive:true});
      return {top:s.scrollTop,max:s.scrollHeight-s.clientHeight,x:b.x+b.width*.7,y:Math.min(b.bottom-40,b.y+150),
        events:window.__events.length,commits:window.__rootCommits.length,at:performance.now()};
    })()`);
    const sentEpochMs = Date.now();
    await checked("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: armed.x,
      y: armed.y,
      deltaX: 0,
      deltaY: armed.top >= armed.max - 600 ? -480 : armed.top <= 100 ? 480 : index % 2 ? -480 : 480,
    });
    await delay(350);
    const after = await metrics();
    const observed = await page!.evaluate<{
      input: { top: number; observedTop?: number; scroll: number | null; raf: number | null };
      events: unknown[];
      commits: number;
      epochOffset: number;
    }>(
      `({input:window.__inputSample,events:window.__events.slice(${armed.events}),commits:window.__rootCommits.length-${armed.commits},epochOffset:performance.timeOrigin})`,
    );
    const sample = {
      sample: index - 4,
      warmup: index < 5,
      sentEpochMs,
      armed,
      ...observed,
      sendToScrollMs:
        observed.input.scroll === null
          ? null
          : observed.epochOffset + observed.input.scroll - sentEpochMs,
      sendToRafMs:
        observed.input.raf === null
          ? null
          : observed.epochOffset + observed.input.raf - sentEpochMs,
      metricsBefore: prior,
      metricsAfter: after,
      taskMs: ((after["TaskDuration"] ?? NaN) - (prior["TaskDuration"] ?? NaN)) * 1000,
      scriptMs: ((after["ScriptDuration"] ?? NaN) - (prior["ScriptDuration"] ?? NaN)) * 1000,
    };
    samples.push(sample);
    assert(
      observed.input.scroll !== null &&
        observed.input.raf !== null &&
        observed.input.observedTop !== armed.top,
      "Wheel must cause native scroll and subsequent RAF",
    );
  }
  const cpu = (await checked("Profiler.stop")) as { profile: unknown };
  profiling = false;
  await writeFile(join(output, "renderer.cpuprofile"), JSON.stringify(cpu.profile));
  await checked("Tracing.end");
  tracing = false;
  await waitFor(async () => traceComplete, 10000);
  await writeFile(join(output, "renderer-trace.json"), JSON.stringify({ traceEvents: trace }));
  results["nativeObservation"] = await page!.evaluate(
    `({events:window.__events,frames:window.__frames,rootCommits:window.__rootCommits})`,
  );
  await page!.evaluate("window.__framing=false;window.__stopDownloadObserver()");
  assert.deepEqual(
    await identity(),
    beforeIdentity,
    "Unrelated progress must preserve complete ordered controls and selected versions",
  );
  results["afterCatalogue"] = await catalogueIdentity();
  assert.deepEqual(
    results["afterCatalogue"],
    beforeCatalogue,
    "All 520 ordered exact files and version choices must remain unchanged",
  );
  const events = (
    results["nativeObservation"] as {
      events: { advancing: { received: number; id: string }[]; count: number; complete: number }[];
    }
  ).events;
  assert(
    events.length >= 30 &&
      events.every(
        (e) =>
          e.count === 2001 &&
          e.complete === 2000 &&
          e.advancing.length === 1 &&
          e.advancing[0]?.id === "90000",
      ),
  );
  assert(
    new Set(events.flatMap((e) => e.advancing.map((a) => a.received))).size >= 30,
    "Need 30 real advancing progress snapshots",
  );
  await capture("details-after");
  // Positive control through the actual row: cancel the unrelated movie in Downloads first.
  await key(page!, "Escape", 27);
  await click(button("header button", "Downloads"));
  const moving = (await list()).items.find((i) => i.status.kind === "transferring");
  assert(moving);
  await click(`document.querySelector('[data-download="${moving.id}"] button')`);
  await waitFor(async () => !(await list()).items.some((i) => i.id === moving.id), 10000);
  await openSeries();
  await details();
  await click("document.querySelector('[aria-label=\"Download S1 E1\"]')");
  await waitFor(
    () =>
      page!.evaluate<boolean>(
        "!!document.querySelector('[aria-label=\"Cancel download of S1 E1\"]')",
      ),
    10000,
  );
  await page!.evaluate(
    `document.querySelector('[aria-label="Cancel download of S1 E1"]').scrollIntoView({block:'center'})`,
  );
  const positive: unknown[] = [];
  results["positiveControl"] = positive;
  for (let i = 0; i < 2; i++) {
    await delay(1800);
    const own = (await list()).items.find(
      (d) => d.title.kind === "episode" && d.title.id === "7000000",
    );
    assert(own?.status.kind === "transferring");
    const shown = await page!.evaluate<{ cancel: boolean; text: string }>(
      `({cancel:!!document.querySelector('[aria-label="Cancel download of S1 E1"]'),text:document.querySelector('[role=dialog]').innerText})`,
    );
    assert(shown.cancel && /Downloading \d+%/.test(shown.text));
    positive.push({ status: own.status, shown });
  }
  assert.notDeepEqual(positive[0], positive[1]);
  await capture("matching-progress");
  results["transferBoundary"] = proxy.observed();
  results["hashesAfter"] = await manifest(join(appDir, "out"));
  assert.deepEqual(
    results["hashesAfter"],
    results["hashesBefore"],
    "Frozen build changed during capture",
  );
  results["status"] = "passed";
} catch (error) {
  failure = error;
  results["status"] = "failed";
  results["failure"] = error instanceof Error ? error.stack : String(error);
  if (page) {
    if (profiling) {
      const cpu = await checked("Profiler.stop").catch(String);
      await writeFile(join(output, "failed-renderer-profile.json"), JSON.stringify(cpu));
    }
    if (tracing) {
      await checked("Tracing.end").catch(() => {});
      await waitFor(async () => traceComplete, 5000).catch(() => {});
      await writeFile(
        join(output, "failed-renderer-trace.json"),
        JSON.stringify({ traceEvents: trace }),
      );
    }
    results["failedNativeObservation"] = await page
      .evaluate("({events:window.__events,frames:window.__frames})")
      .catch(String);
    await capture("failure").catch(() => {});
    results["failureDom"] = await page.evaluate("document.body.innerText").catch(String);
    results["failureInstrumentation"] = await page
      .evaluate("({commits:window.__rootCommits,hook:!!window.__REACT_DEVTOOLS_GLOBAL_HOOK__})")
      .catch(String);
  }
} finally {
  clearTimeout(watchdog);
  process.removeListener("SIGINT", signals);
  process.removeListener("SIGTERM", signals);
  const cleanup: string[] = [];
  try {
    await quit();
    cleanup.push("Owned Electron exited");
    await rm(profile, { recursive: true, force: true });
    cleanup.push("Owned disposable profile removed");
  } catch (error) {
    failure ??= error;
    cleanup.push(`FAILED ${String(error)}`);
  }
  for (const boundary of [proxy, provider, tmdb]) {
    try {
      await boundary?.close();
    } catch (error) {
      failure ??= error;
      cleanup.push(`FAILED ${String(error)}`);
    }
  }
  results["cleanup"] = cleanup;
  if (failure) results["status"] = "failed";
  results["conditionsEnd"] = { load: loadavg(), at: new Date().toISOString() };
  await writeFile(join(output, "raw.json"), JSON.stringify(results, null, 2));
  await writeFile(join(output, "electron.log"), logs.join(""));
}
console.log(`${failure ? "FAIL" : "PASS"} ${output}`);
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
