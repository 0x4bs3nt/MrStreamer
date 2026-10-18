// Measures a built app against the fake provider at the size of a large subscription: 13,000
// channels, about 2,000 of them with a guide, a continuous 720p stream from ffmpeg on every test
// channel, and a series of 520 episodes. Prints medians to compare builds, and how many streams
// each tune, switch and return to Watch opens at the provider; see docs/contributing/testing.md.
//
//   node test/e2e/measure-app.ts [--runs 3] [--subscriptions 1] [--revision sha] [--json results.json] <app executable> [-- extra app arguments]
//
// Raw samples default to .local/measurements; --json chooses a path. Needs ffmpeg on PATH
// (or MR_STREAMER_FFMPEG). On macOS pass --use-mock-keychain.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { fakeGuide, startFakeProvider } from "../fake-provider.ts";
import {
  addSubscription,
  calibrate,
  connect,
  delay,
  key,
  launch,
  login,
  observe,
  observeAcrossLoad,
  waitFor,
  type Page,
} from "./app.ts";
import {
  APP_METRICS,
  electronVersion,
  environment,
  median,
  metric,
  positiveCount,
  prepareMeasurementOutput,
  saveMeasurement,
} from "../../scripts/measurement.ts";

const { values: options, positionals } = parseArgs({
  options: {
    json: { type: "string" },
    runs: { type: "string", default: "3" },
    subscriptions: { type: "string", default: "1" },
    titles: { type: "string", default: "120" },
    series: { type: "string" },
    "search-runs": { type: "string" },
    "uncached-search": { type: "boolean", default: false },
    "cold-search": { type: "boolean", default: false },
    "covered-idle": { type: "boolean", default: false },
    revision: { type: "string" },
  },
  allowPositionals: true,
});
const [executable, ...rest] = positionals;
const appDirectory = rest.find((argument) => existsSync(join(argument, "out/main/index.js")));
if (!executable) {
  throw new Error(
    "Usage: node test/e2e/measure-app.ts [--runs 3] [--subscriptions 1] [--revision sha] [--json file] <app executable> [-- args]",
  );
}

const ffmpeg = process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg";
const RUNS = positiveCount(options.runs, "runs", 20);
const SUBSCRIPTIONS = positiveCount(options.subscriptions, "subscriptions", 4);
const TITLES = positiveCount(options.titles, "titles", 100_000);
const SERIES = options.series ? positiveCount(options.series, "series", 100_000) : undefined;
const SEARCH_RUNS = options["search-runs"]
  ? positiveCount(options["search-runs"], "search-runs", 100)
  : 0;
const TEST_CHANNELS = ["H.264 + AAC", "H.264 + MP2", "H.264 + MP3", "H.264 + AC-3"];

const output = options.json ?? join(process.cwd(), ".local/measurements", `app-${Date.now()}.json`);
prepareMeasurementOutput(output);
const providers: Awaited<ReturnType<typeof startFakeProvider>>[] = [];
for (let index = 0; index < SUBSCRIPTIONS; index++)
  providers.push(
    await startFakeProvider({
      second: index > 0,
      channels: 13_000,
      titles: TITLES,
      ...(SERIES ? { series: SERIES } : {}),
      maxConnections: 1,
      longSeries: true,
      // Every channel plays the same endless 720p programme, encoded as it goes.
      streams: (_channel, out, signal) => {
        const encoder = spawn(
          ffmpeg,
          [
            ...["-hide_banner", "-loglevel", "error", "-re"],
            ...["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=25"],
            ...["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"],
            ...["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-g", "50"],
            ...["-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-f", "mpegts", "pipe:1"],
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        encoder.stdout.pipe(out);
        signal.addEventListener("abort", () => encoder.kill("SIGKILL"), { once: true });
      },
    }),
  );
const provider = providers[0]!;
for (const provider of providers)
  provider.serveGuide(
    fakeGuide(
      {
        ...provider.catalogue,
        channels: provider.catalogue.channels.filter((channel) => channel.streamId % 6 === 0),
      },
      Date.now(),
    ),
  );

const results = new Map<keyof typeof APP_METRICS, number[]>();
const record = (name: keyof typeof APP_METRICS, value: number) =>
  results.set(name, [...(results.get(name) ?? []), value]);
const observations: { [key: string]: number | string | boolean }[] = [];
const searchSamples: Record<string, number[]> = {};
const coldSearchSamples: number[] = [];

const profile = mkdtempSync(join(tmpdir(), "mr-streamer-measure-"));
let app: ChildProcess | null = null;
let activePage: Page | undefined;
let mainInspector: Page | undefined;
let electron = "unavailable";
let calibration: Awaited<ReturnType<typeof calibrate>> = [];

const ROWS_SHOWN = `!!document.querySelector("main h1") && document.querySelectorAll("main [role=button]").length > 5`;
function rowsShown(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(ROWS_SHOWN);
}

// Require a new source and two advancing clock observations, rather than a decoded still frame.
const FRESH_PICTURE = `(() => {
  const video = document.querySelector("video");
  if (!video || !video.currentSrc || video.currentSrc === window.__source || video.videoWidth <= 0 || video.currentTime <= 0.2) return false;
  const previous = window.__movingTime;
  window.__previousMovingTime = previous;
  window.__movingTime = video.currentTime;
  return previous !== null && previous !== undefined && video.currentTime > previous;
})()`;
function freshPicture(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(FRESH_PICTURE);
}

try {
  // First run: log in, let the catalogue and guide arrive, then tune, switch and browse.
  let port = randomPort();
  const inspectPort = randomPort();
  app = launch(executable, options["covered-idle"] ? [`--inspect=${inspectPort}`, ...rest] : rest, {
    port,
    profile,
  });
  let page = await connect(port, "page", { pollMs: 5, app });
  if (options["covered-idle"]) {
    mainInspector = await connect(inspectPort, "node", { app });
    // Diagnostic-only instrumentation of Electron's registered boundary, without query text or
    // identities. This private Electron registry is deliberately checked at runtime and never
    // used by the product. Failure invalidates the capture rather than fabricating zero calls.
    await mainInspector.evaluate(`(async () => {
      const { ipcMain } = process.getBuiltinModule("module").createRequire(process.execPath)("electron");
      const handlers = ipcMain._invokeHandlers;
      if (!(handlers instanceof Map)) throw new Error("Electron IPC diagnostic registry unavailable");
      globalThis.__maintenanceCalls = [];
      for (const [method, handler] of handlers) handlers.set(method, (event, input) => {
        globalThis.__maintenanceCalls.push({ method, at: Date.now(), channels: Array.isArray(input?.channels) ? input.channels.length : 0 });
        return handler(event, input);
      });
      return true;
    })()`);
  }
  activePage = page;
  electron = electronVersion(executable);
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  for (const [index, extra] of providers.entries()) {
    if (index > 0) await addSubscription(page, extra, `Measurement ${index + 1}`);
  }
  if (SUBSCRIPTIONS > 1) await clickText(page, "Back");
  await clickText(page, "Home");
  await waitFor(
    () => Promise.resolve(providers.every((provider) => provider.guideRequests() > 0)),
    30_000,
  );
  await delay(5000);
  calibration = await calibrate(page);

  const warmupStarted = performance.now();
  await clickText(page, "Live TV");
  await waitFor(() => rowsShown(page));
  await clickText(page, "TEST | Formats and failures");
  await waitFor(() => rowsShown(page));
  await movingWarmup(page, "warmup tune", rowClick(TEST_CHANNELS[0]!));
  await movingWarmup(page, "warmup switch", () => key(page, "ArrowDown", 40));
  await key(page, "Escape", 27);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
  observations.push({ name: "playback warmup", elapsedMs: performance.now() - warmupStarted });

  for (let run = 0; run < RUNS; run++) {
    await clickText(page, "Home");
    await delay(1000);
    await timed("guide open", page, buttonClick("Live TV"), ROWS_SHOWN);
    await clickText(page, "TEST | Formats and failures");
    await delay(1000);
    await timed(
      "guide list of 13,000",
      page,
      buttonClick("All channels"),
      `document.querySelector("main h1")?.textContent === "All channels" && (${ROWS_SHOWN})`,
    );
  }
  await clickText(page, "TEST | Formats and failures");
  await waitFor(() => rowsShown(page));
  for (let run = 0; run < RUNS; run++) {
    const channel = TEST_CHANNELS[run % TEST_CHANNELS.length]!;
    const requests = streamRequests();
    await timed("time to picture", page, rowClick(channel), FRESH_PICTURE);
    await delay(1000);
    record("streams opened per tune (count)", streamRequests() - requests);
    await key(page, "Escape", 27);
    await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
  }
  await clickRow(page, TEST_CHANNELS[RUNS % TEST_CHANNELS.length]!);
  await waitFor(() => freshPicture(page));
  for (let run = 0; run < RUNS; run++) {
    const requests = streamRequests();
    await timed("channel switch", page, () => key(page, "ArrowDown", 40), FRESH_PICTURE);
    await delay(1000);
    record("streams opened per switch (count)", streamRequests() - requests);
  }
  await key(page, "Escape", 27);
  await clickText(page, "Home");
  await delay(1000);
  for (let run = 0; run < RUNS; run++) {
    await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
    await delay(500);
    await timed(
      "search, typed to programmes shown",
      page,
      () => page.send("Input.insertText", { text: "news" }),
      `document.querySelector('[role="dialog"]')?.innerText.includes("On now") && document.querySelectorAll('[role="dialog"] [data-index]').length > 0`,
    );
    await key(page, "Escape", 27);
    await delay(500);
  }

  // Each query is typed into an empty, freshly mounted palette. Repeated queries intentionally
  // measure the warm local cache, including its unchanged typing debounce. Cold process samples
  // above and below have a different cache condition and are never pooled into these percentiles.
  for (const query of SEARCH_RUNS ? ["H.264 + AAC", "TEST | Index at the end", "news"] : []) {
    const samples: number[] = [];
    searchSamples[query] = samples;
    for (let run = -1; run < SEARCH_RUNS; run++) {
      await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
      await delay(150);
      const expected =
        query === "news"
          ? `document.querySelector('[role="dialog"]')?.innerText.includes("On now")`
          : `[...document.querySelectorAll('[role="dialog"] [data-index]')].some(row => row.innerText.toLowerCase().includes(${JSON.stringify(query.toLowerCase())}))`;
      const shown = observe(page, expected);
      // Unique raw whitespace preserves normalized words while bypassing query-result caching.
      const typed = options["uncached-search"] ? query + " ".repeat(run + 2) : query;
      await page.send("Input.insertText", { text: typed });
      const elapsed = await shown;
      if (run >= 0) samples.push(elapsed);
      observations.push({
        name: "warm palette",
        query,
        run,
        elapsedMs: elapsed,
        firstResult: await page.evaluate<string>(
          `document.querySelector('[role="dialog"] [data-index]')?.innerText ?? ""`,
        ),
      });
      await key(page, "Escape", 27);
      await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[role="dialog"]')`));
    }
  }

  // Home's muted preview plays by now. Watch takes over its stream.
  await delay(3000);
  const requests = streamRequests();
  await clickText(page, "Watch");
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`));
  await delay(1000);
  if (options["covered-idle"]) {
    const started = Date.now();
    observations.push({ name: "covered idle begins", at: started });
    // Cross the existing one-minute listing poll while the underlying Home stays mounted.
    await delay(42_000);
    await delay(42_000);
    await delay(42_000);
    observations.push({ name: "covered idle ends", at: Date.now() });
    const calls = await mainInspector!.evaluate<{ method: string; at: number; channels: number }[]>(
      `globalThis.__maintenanceCalls.filter(call => call.at >= ${started})`,
    );
    for (const call of calls) observations.push({ name: "covered IPC", ...call });
    mainInspector!.close();
    mainInspector = undefined;
  }
  record("streams opened, Home to Watch (count)", streamRequests() - requests);
  page.close();
  await quit(app);

  // Cold starts: the same profile, logged in, with the catalogue and guide on disk. Each then
  // opens the long series, which the app has not asked the provider about since it started.
  for (let run = 0; run < RUNS; run++) {
    port = randomPort();
    const started = performance.now();
    app = launch(executable, rest, { port, profile });
    page = await connect(port, "page", { pollMs: 5, app });
    activePage = page;
    const loaded = await observeAcrossLoad(
      page,
      // Home's Stage names the channel its preview plays once the catalogue is read.
      `!!document.querySelector("[data-home-preview] h2") && !document.body.innerText.includes("Loading channels")`,
      started,
    );
    observations.push({ name: "cold start", initialNavigationObserved: loaded.navigationObserved });
    record("cold start to Home", loaded.elapsedMs);
    if (options["cold-search"]) {
      await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
      await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[role="combobox"]')`));
      const shown = observe(
        page,
        `document.querySelector('[role="dialog"]')?.innerText.includes("TEST | Index at the end")`,
      );
      await page.send("Input.insertText", { text: "TEST | Index at the end" });
      coldSearchSamples.push(await shown);
      await key(page, "Escape", 27);
      await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[role="dialog"]')`));
    }
    const detailRequests = providers.reduce(
      (total, provider) => total + provider.detailRequests(),
      0,
    );
    await openLongSeries(page);
    observations.push({
      name: "cold series provider details",
      run,
      requests:
        providers.reduce((total, provider) => total + provider.detailRequests(), 0) -
        detailRequests,
    });
    page.close();
    await quit(app);
  }
  app = null;

  record("installed size (MB)", installedSize(executable));
  report();
  const metrics = Object.fromEntries(
    Object.entries(APP_METRICS).map(([name, unit]) => {
      const samples = results.get(name as keyof typeof APP_METRICS) ?? [];
      const expected =
        name === "installed size (MB)" || name === "streams opened, Home to Watch (count)"
          ? 1
          : RUNS;
      if (samples.length !== expected) throw new Error(`Incomplete metric: ${name}`);
      return [name, metric(unit, samples)];
    }),
  );
  saveMeasurement(output, {
    schemaVersion: 1,
    tool: "app",
    environment: environment({
      ...(options.revision ? { revision: options.revision } : {}),
      electron,
      executable,
      ...(appDirectory ? { appDirectory } : {}),
    }),
    workload: {
      channelsPerSubscription: 13000,
      subscriptions: SUBSCRIPTIONS,
      moviesPerSubscription: provider.titles.movies.length,
      seriesPerSubscription: provider.titles.series.length,
      seriesSeasons: 20,
      stream: "720p25-h264-aac",
      runs: RUNS,
      warmSearchRunsPerQuery: SEARCH_RUNS,
      searchResultCache: options["uncached-search"] ? "uncached" : "warm",
      coldSearch: options["cold-search"],
    },
    conditions: {
      warmup: "login, guide download, one unmeasured tune and switch at measured workload",
      installedSizeScope: appDirectory
        ? "electron-runtime-folder only; unpackaged, excludes app output"
        : "installed app bundle or folder",
      sizeUnit: "decimal MB; 1000000 bytes",
      cache: "fresh profile then disk catalogue and guide for cold process starts",
      timingResolutionMs: 5,
    },
    calibration,
    observations,
    metrics: {
      ...metrics,
      ...Object.fromEntries(
        Object.entries(searchSamples).map(([query, samples]) => [
          `${options["uncached-search"] ? "uncached" : "warm"} palette: ${query}`,
          metric("ms", samples),
        ]),
      ),
      ...(options["cold-search"]
        ? { "cold process exact title search": metric("ms", coldSearchSamples) }
        : {}),
    },
    checks: {
      completeMetrics: true,
      movingPicture: ["time to picture", "channel switch"].every((name) => {
        const pictures = observations.filter((observation) => observation["name"] === name);
        return (
          pictures.length === RUNS &&
          pictures.every(
            (picture) =>
              Number(picture["currentTime"]) > Number(picture["previousTime"]) &&
              Number(picture["videoWidth"]) > 0,
          )
        );
      }),
    },
  });
  console.log(`Raw measurement: ${output}`);
} catch (error) {
  writeFileSync(
    output,
    JSON.stringify(
      {
        status: "invalid-instrumentation",
        environment: environment({
          executable,
          electron,
          ...(options.revision ? { revision: options.revision } : {}),
          ...(appDirectory ? { appDirectory } : {}),
        }),
        workload: {
          runs: RUNS,
          subscriptions: SUBSCRIPTIONS,
          moviesPerSubscription: provider.titles.movies.length,
          seriesPerSubscription: provider.titles.series.length,
          channelsPerSubscription: 13000,
          stream: "720p25-h264-aac",
          seriesSeasons: 20,
        },
        conditions: {
          warmup: "login, guide download, one unmeasured tune and switch at measured workload",
          installedSizeScope: appDirectory
            ? "electron-runtime-folder only; unpackaged, excludes app output"
            : "installed app bundle or folder",
          sizeUnit: "decimal MB; 1000000 bytes",
          cache: "fresh profile then disk catalogue and guide for cold process starts",
          timingResolutionMs: 5,
        },
        calibration,
        observations,
        partialSamples: Object.fromEntries(results),
        warmSearchSamples: searchSamples,
        coldSearchSamples,
        error: String(error),
      },
      null,
      2,
    ),
  );
  if (activePage) {
    try {
      const capture = await activePage.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(
        `${output}.failure.png`,
        Buffer.from((capture.result as { data: string }).data, "base64"),
      );
      writeFileSync(
        `${output}.failure.dom.json`,
        JSON.stringify(
          await activePage.evaluate(
            `({ text: document.body.innerText, buttons: [...document.querySelectorAll('[role="dialog"] button')].map((row) => ({ text: row.innerText, first: row.firstElementChild?.textContent, label: row.getAttribute("aria-label") })) })`,
          ),
          null,
          2,
        ),
      );
    } catch {
      /* The process may already have closed. Raw partial samples remain. */
    }
  }
  throw error;
} finally {
  mainInspector?.close();
  activePage?.close();
  if (app) await quit(app);
  await Promise.all(providers.map((provider) => provider.close()));
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  writeFileSync(
    `${output}.cleanup.json`,
    JSON.stringify(
      {
        profile,
        appExited: !app || app.exitCode !== null || app.signalCode !== null,
        profileRemoved: !existsSync(profile),
        providerServersClosed: true,
        activeProviderStreamCounters: providers.map((provider) => provider.activeStreams()),
      },
      null,
      2,
    ),
  );
}

function streamRequests() {
  return providers.reduce((total, provider) => total + provider.streamRequests(), 0);
}
async function timed(
  name: keyof typeof APP_METRICS,
  page: Page,
  act: string | (() => Promise<unknown>),
  condition: string,
): Promise<void> {
  if (condition === FRESH_PICTURE)
    await page.evaluate(
      `window.__source = document.querySelector("video")?.currentSrc ?? ""; window.__movingTime = null`,
    );
  const observation = observe(page, condition, typeof act === "string" ? act : "");
  const [elapsed] = await Promise.all([
    observation,
    typeof act === "string" ? Promise.resolve() : act(),
  ]);
  record(name, elapsed);
  if (condition === FRESH_PICTURE) {
    observations.push({
      name,
      ...(await page.evaluate<{ previousTime: number; currentTime: number; videoWidth: number }>(
        `({ previousTime: window.__previousMovingTime, currentTime: window.__movingTime, videoWidth: document.querySelector("video").videoWidth })`,
      )),
      streamsOpened: streamRequests(),
    });
    if (name === "time to picture" && results.get(name)?.length === 1) {
      const capture = await page.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(
        `${output}.picture.png`,
        Buffer.from((capture.result as { data: string }).data, "base64"),
      );
      writeFileSync(
        `${output}.picture.ax.json`,
        JSON.stringify((await page.send("Accessibility.getFullAXTree")).result, null, 2),
      );
    }
  }
}

/** Exercise the actual encoder and player before measuring, retaining cost and movement. */
async function movingWarmup(page: Page, name: string, act: string | (() => Promise<unknown>)) {
  await page.evaluate(
    `window.__source = document.querySelector("video")?.currentSrc ?? ""; window.__movingTime = null`,
  );
  const [elapsedMs] = await Promise.all([
    observe(page, FRESH_PICTURE, typeof act === "string" ? act : ""),
    typeof act === "string" ? Promise.resolve() : act(),
  ]);
  observations.push({
    name,
    elapsedMs,
    ...(await page.evaluate<{ previousTime: number; currentTime: number; videoWidth: number }>(
      `({ previousTime: window.__previousMovingTime, currentTime: window.__movingTime, videoWidth: document.querySelector("video").videoWidth })`,
    )),
    streamsOpened: streamRequests(),
  });
}

/**
 * Opens the long series from All series, the newest first, and times in the window when its name
 * shows and when the first season's 26 episodes do.
 */
async function openLongSeries(page: Page): Promise<void> {
  await page.evaluate(
    `[...document.querySelectorAll("header button")].find((b) => b.textContent.trim() === "Series").click()`,
  );
  const allTab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "All series")`;
  await waitFor(() => page.evaluate<boolean>(`!!${allTab}`));
  await page.evaluate(`${allTab}.click()`);
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes("Long-running"))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`));
  await delay(1000);
  const dialog = `document.querySelector('[role="dialog"]')`;
  const title = observe(
    page,
    `${dialog}?.querySelector("h2")?.textContent.includes("Long-running")`,
  );
  const episodes = observe(
    page,
    `[...(${dialog}?.querySelectorAll("button") ?? [])].filter((row) => Number.isInteger(Number(row.firstElementChild?.textContent.trim())) && Number(row.firstElementChild?.textContent.trim()) > 0).length >= 26`,
  );
  // Attach handlers for both observers before dispatching the click or awaiting anything else.
  const pending = Promise.all([title, episodes, page.evaluate(`${poster}.click()`)]);
  const [titleMs, episodesMs] = await pending;
  record("long series details, name shown", titleMs);
  record("long series details, episodes shown", episodesMs);
  await key(page, "Escape", 27);
}

/**
 * Clicks the button that reads `text`, or else the first that starts with it: Home's Watch, not
 * the top bar's Watchlist.
 */
function buttonClick(text: string): string {
  return `(() => {
    const reads = (element) => element.textContent.trim();
    const buttons = [...document.querySelectorAll("button, [role=button]")];
    const target = buttons.find((element) => reads(element) === ${JSON.stringify(text)})
      ?? buttons.find((element) => reads(element).startsWith(${JSON.stringify(text)}));
    if (!target) throw new Error("No button " + ${JSON.stringify(text)});
    target.click();
  })()`;
}
function clickText(page: Page, text: string): Promise<unknown> {
  return page.evaluate(buttonClick(text));
}

function rowClick(channel: string): string {
  return `(() => {
    window.__source = document.querySelector("video")?.currentSrc ?? "";
    [...document.querySelectorAll("[role=button]")]
      .find((row) => row.textContent.includes(${JSON.stringify(channel)})).click();
  })()`;
}
function clickRow(page: Page, channel: string): Promise<unknown> {
  return page.evaluate(rowClick(channel));
}

async function quit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(10_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

/** Bundle/folder bytes; for a checkout this is runtime-only, recorded in installedSizeScope. */
function installedSize(file: string): number {
  const folder = process.platform === "darwin" ? dirname(dirname(dirname(file))) : dirname(file);
  const bytes = sizeOf(folder);
  return bytes / 1e6;
}

function sizeOf(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) total += sizeOf(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}

function report(): void {
  console.log(`| Measure | Median | Runs |\n| --- | --- | --- |`);
  for (const [name, values] of results) {
    const unit = name.includes("(") ? "" : " ms";
    const shown = (value: number) => `${Math.round(value * 10) / 10}${unit}`;
    console.log(`| ${name} | ${shown(median(values))} | ${values.map(shown).join(", ")} |`);
  }
}

function randomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}
