// Built-app proof through the actual Settings control, with an isolated profile and loopback only.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type } from "arktype";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type { Result } from "@mrstreamer/contracts/errors";
import { CaptureEvent, type CaptureName, type CaptureOf } from "../../src/main/analytics/model.ts";
import { startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { connect, delay, type Page } from "./app.ts";
import {
  electronExecutable,
  evidenceDirectory,
  injectedFailure,
  freePort,
  record,
  stop,
} from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const evidenceRoot = join(root, ".local/verification");
const evidence = await evidenceDirectory(evidenceRoot, "analytics-");
const [packagedExecutable, ...packagedArgs] = process.argv.slice(2);
const appVersion = (
  JSON.parse(await readFile(join(desktop, "package.json"), "utf8")) as { version: string }
).version;
const build = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  appVersion,
  mainSha256: createHash("sha256")
    .update(await readFile(join(desktop, "out/main/index.js")))
    .digest("hex"),
};
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Verification interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let profile = "";
const profiles: string[] = [];
let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
const payloads: unknown[] = [];
let rejectCapture = false;
const capture = createServer(async (req, res) => {
  const bytes: Buffer[] = [];
  for await (const chunk of req) bytes.push(Buffer.from(chunk));
  payloads.push(JSON.parse(Buffer.concat(bytes).toString()));
  res.statusCode = rejectCapture ? 503 : 200;
  res.end("ok");
});
let endpoint = "";
let rejectUpdate = false;
let offerUpdate = false;
let updateEndpoint = "";
const updateFeed = createServer((_req, res) => {
  res.statusCode = rejectUpdate ? 503 : 200;
  res.setHeader("Content-Type", "application/json");
  const offeredRelease = {
    published: new Date().toISOString(),
    page: "https://example.test/release",
    files: updateEndpoint + "/files/",
    notes: "Loopback fixture release",
    platforms: ["latest-linux.yml", "latest-mac.yml", "latest.yml"],
  };
  res.end(
    JSON.stringify({
      schema: 1,
      generated: new Date().toISOString(),
      stable: offerUpdate
        ? {
            version: "99.0.0",
            ...offeredRelease,
          }
        : null,
      nightly: offerUpdate
        ? {
            version: "99.0.0-nightly.20261013.999",
            ...offeredRelease,
          }
        : null,
    }),
  );
});
const actions: { action: string; at: string }[] = [];
const observations: Record<string, unknown> = {};
const pointerInputs: Record<string, unknown>[] = [];
const log: string[] = [];
let app: ChildProcess | undefined;
let page: Page | undefined;
let mainPage: Page | undefined;
let debuggingPort = 0;
const broadcasts = new Set<ChildProcess>();
let failure: unknown;
const cleanupErrors: string[] = [];

/** Validate a clone, then compare the complete raw wire body before any unknown-key deletion. */
function captured(payload: unknown): CaptureEvent {
  const event = CaptureEvent()(structuredClone(payload));
  if (event instanceof type.errors) throw new Error("Invalid capture event.");
  if (!isDeepStrictEqual(payload, { api_key: "mrstreamer-local-verification", ...event }))
    throw new Error("Unexpected raw capture fields.");
  return event;
}

/** Every decoded capture so far, in arrival order. */
function sent(): CaptureEvent[] {
  return payloads.map(captured);
}

/** How many captures of one event arrived, optionally matching their fixed properties. */
function count<Name extends CaptureName>(
  name: Name,
  match: (event: CaptureOf<Name>) => boolean = () => true,
): number {
  return sent()
    .filter((event): event is CaptureOf<Name> => event.event === name)
    .filter(match).length;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    abort.signal.throwIfAborted();
    if (await check()) return;
    await delay(150);
  }
  throw new Error(`Timed out: ${check.toString()}`);
}

function live() {
  if (!page) throw new Error("No owned window.");
  return page;
}

async function send(method: string, params: Record<string, unknown> = {}) {
  abort.signal.throwIfAborted();
  const reply = await live().send(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
}

async function launch() {
  const port = await freePort();
  debuggingPort = port;
  const inspectorPort = await freePort();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("MR_STREAMER_") && name !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  app = spawn(
    packagedExecutable ?? (await electronExecutable()),
    [
      `--remote-debugging-port=${port}`,
      `--inspect=${inspectorPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--enable-automation",
      "--use-mock-keychain",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ...(packagedExecutable ? packagedArgs : [desktop]),
    ],
    {
      cwd: root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...env,
        LANGUAGE: "en_US",
        LANG: "en_US.UTF-8",
        MR_STREAMER_UPDATE_CHECKS: "off",
        MR_STREAMER_UPDATE_FEED: `${updateEndpoint}/updates.json`,
        MR_STREAMER_UPDATE_API: updateEndpoint,
        MR_STREAMER_TMDB_API: tmdb!.url,
        MR_STREAMER_TMDB_KEY: "test-key",
        MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT: endpoint,
      },
    },
  );
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  page = await connect(port);
  mainPage = await connect(inspectorPort, "node");
  if ((await mainPage.evaluate<number>("process.pid")) !== app.pid)
    throw new Error("Wrong main inspector process.");
  const identity = await send("Browser.getBrowserCommandLine");
  const arguments_ = record(identity) ? identity["arguments"] : null;
  if (
    !Array.isArray(arguments_) ||
    ![
      ...(packagedExecutable ? [] : [desktop]),
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
    ].every((arg) => arguments_.includes(arg))
  )
    throw new Error("Wrong app instance.");
  const url = await live().evaluate<string>("location.href");
  if (
    packagedExecutable
      ? !url.startsWith("file:") ||
        !/\/(?:resources|Resources)\/app\.asar\/out\/renderer\//.test(url)
      : !url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href)
  )
    throw new Error("Wrong renderer build.");
  observations["instance"] = { pid: app.pid, port, inspectorPort, profile, url, endpoint };
  const instances = observations["instances"];
  observations["instances"] = [
    ...(Array.isArray(instances) ? instances : []),
    observations["instance"],
  ];
  await send("Page.bringToFront");
}

async function quit() {
  if (app) await stop(app, page);
  page?.close();
  page = undefined;
  mainPage?.close();
  mainPage = undefined;
}

/** Re-resolve named targets and require settled geometry and a hit before actual pointer input. */
async function click(selector: string, index = 0, match?: { name: string; title: boolean }) {
  const elements = `[...document.querySelectorAll(${JSON.stringify(selector)})]`;
  const element = match
    ? `${elements}.find(b => ${match.title ? `b.title.includes(${JSON.stringify(match.name)})` : `b.textContent.trim() === ${JSON.stringify(match.name)}`})`
    : `${elements}[${index}]`;
  const frame = `new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`;
  let point = { x: 0, y: 0 };
  await waitFor(async () => {
    if (!(await live().evaluate<boolean>(`!!(${element})`))) return false;
    await live().evaluate(`(async () => {
      (${element}).scrollIntoView({behavior:'instant',block:'center'});
      await ${frame};
    })()`);
    const before = await live().evaluate<{ x: number; y: number }>(
      `(() => { const r=(${element}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
    );
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...before });
    // Hover, scrolling and the preceding action can all change layout. Check again before down.
    const settled = await live().evaluate<{ x: number; y: number } | null>(`(async () => {
      await ${frame};
      const target=(${element});
      if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return null;
      const r=target.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
      const hit=document.elementFromPoint(x,y);
      if (r.width<=0 || r.height<=0 || Math.abs(x-${before.x})>.25 || Math.abs(y-${before.y})>.25 || !hit || !target.contains(hit)) return null;
      const describe=e => e ? {tag:e.tagName, text:(e.textContent||'').trim().slice(0,80), title:e.getAttribute('title'), label:e.getAttribute('aria-label')} : null;
      window.__analyticsPointer={intended:describe(target), hit:describe(hit), point:{x,y}, actual:null};
      const down=e => {
        const matched=e.target instanceof Node && target.contains(e.target);
        window.__analyticsPointer.actual={target:describe(e.target), x:e.clientX, y:e.clientY, matched};
        if (!matched) { e.preventDefault(); e.stopImmediatePropagation(); }
      };
      const guard=e => {
        if (!window.__analyticsPointer.actual?.matched) { e.preventDefault(); e.stopImmediatePropagation(); }
      };
      document.addEventListener('mousedown',down,{capture:true,once:true});
      document.addEventListener('click',guard,true);
      window.__analyticsPointerCleanup=() => {
        document.removeEventListener('mousedown',down,true);
        document.removeEventListener('click',guard,true);
      };
      return {x,y};
    })()`);
    if (!settled) return false;
    point = settled;
    return true;
  });
  try {
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
  } finally {
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
  }
  const input = await live().evaluate<{ actual: { matched: boolean } | null }>(`(() => {
    window.__analyticsPointerCleanup();
    return window.__analyticsPointer;
  })()`);
  pointerInputs.push({
    selector,
    index: match ? undefined : index,
    match,
    at: new Date().toISOString(),
    ...input,
  });
  if (!input.actual?.matched)
    throw new Error(`Pointer target changed before pressing ${match?.name ?? selector}.`);
}

async function settings() {
  await waitFor(() => live().evaluate<boolean>("!!document.querySelector('header')"));
  await click('button[aria-label="Settings"]');
  await waitFor(() =>
    live().evaluate<boolean>(
      "!!document.querySelector('[role=checkbox][aria-label=\"Share basic usage statistics\"]')",
    ),
  );
}

const checkbox = '[role="checkbox"][aria-label="Share basic usage statistics"]';
async function preference() {
  const result = await live().evaluate<Result<Preferences>>(
    "window.mrStreamer.invoke('preferences.get')",
  );
  if (!result.ok) throw new Error("Preferences unavailable.");
  return result.value;
}

async function snapshot(name: string) {
  // DOM preference completion can precede Chromium's painted checkbox and headings.
  await live().evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  await delay(200);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (!record(shot) || typeof shot["data"] !== "string") throw new Error("No screenshot.");
  await writeFile(join(evidence, `${name}.png`), Buffer.from(shot["data"], "base64"));
  await writeFile(
    join(evidence, `${name}-tree.json`),
    JSON.stringify(await send("Accessibility.getFullAXTree"), null, 2),
  );
}

async function connectFixture() {
  await waitFor(() =>
    live().evaluate<boolean>("document.querySelectorAll('form input').length>=3"),
  );
  for (const [index, value] of [provider!.url, "demo", "demo"].entries()) {
    await click("form input", index);
    await send("Input.insertText", { text: value });
  }
  await click('form button[type="submit"]');
  await settings();
}

async function keyEscape() {
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await delay(250);
}

async function namedButton(selector: string, name: string, title = false) {
  await click(selector, 0, { name, title });
  actions.push({ action: `Pressed ${name}`, at: new Date().toISOString() });
}

async function analyticsFile(): Promise<Record<string, unknown>> {
  const kept: unknown = JSON.parse(await readFile(join(profile, "analytics.json"), "utf8"));
  if (!record(kept)) throw new Error("Invalid analytics state.");
  return kept;
}

async function productPaths() {
  await keyEscape();
  await namedButton("header button", "Live TV");
  // Actual guide expansion/favourite/search use, without treating schedule queries as actions.
  await click('button[aria-label="Later programmes"]');
  await waitFor(async () => count("epg_opened") === 1);
  await click('button[aria-label="Add to favourites"]');
  await waitFor(async () => count("favourite_added") === 1);
  await click('button[aria-label="Search"]');
  await send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await waitFor(() =>
    live().evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await waitFor(async () => count("search_used") === 1);
  await send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await waitFor(
    async () => count("stream_started", (e) => e.properties.stream_type === "live") === 1,
  );
  const liveStarted = Date.now();
  await waitFor(() =>
    live().evaluate<boolean>(
      "!!document.querySelector('[data-view=watch]') && document.querySelector('video').videoWidth > 0",
    ),
  );
  // Real eligible elapsed time, rather than media position or an injected duration.
  await delay(34_000);
  await snapshot("confirmed-live-watch");
  await keyEscape();
  await namedButton("header button", "Home");
  await waitFor(() =>
    live().evaluate<boolean>(
      "!document.querySelector('[data-view=watch]') && document.querySelector('video').muted && !document.querySelector('video').paused",
    ),
  );
  const previewFrom = Date.now();
  await delay(12_000);
  const previewTo = Date.now();
  if (count("stream_started") !== 1 || count("stream_stopped") !== 0)
    throw new Error("Home preview started or stopped a run.");
  await snapshot("excluded-home-preview");
  await namedButton("button", "Watch");
  await delay(2500);
  if (count("stream_started") !== 1) throw new Error("Preview promotion counted another start.");
  await keyEscape();
  await namedButton("header button", "Movies");
  await namedButton("nav button", "All movies");
  await namedButton("button[title]", "Index at the end", true);
  await namedButton('[role="dialog"] button', "Save");
  await namedButton('[role="dialog"] button', "Download");
  await waitFor(
    async () => count("download_ended", (e) => e.properties.outcome === "success") === 1,
  );
  await snapshot("download-complete");
  await namedButton('[role="dialog"] button', "Play");
  // The title's run ends the live run, which reports its own active time once.
  await waitFor(
    async () => count("stream_stopped", (e) => e.properties.stream_type === "live") === 1,
  );
  const liveStopped = Date.now();
  await waitFor(
    async () => count("stream_started", (e) => e.properties.stream_type === "vod") === 1,
  );
  const liveStop = sent().find(
    (event) => event.event === "stream_stopped" && event.properties.stream_type === "live",
  );
  if (liveStop?.event !== "stream_stopped") throw new Error("No live stop.");
  const watched = liveStop.properties.watch_duration_seconds;
  const wall = (liveStopped - liveStarted) / 1000;
  const preview = (previewTo - previewFrom) / 1000;
  // Measured from the sink's view of the start, so the real run can be up to ~3 s longer.
  if (watched < 32 || watched > wall - preview + 3)
    throw new Error(`Live watch time ${watched}s is outside ${wall}s minus ${preview}s preview.`);
  observations["liveRun"] = { watched, wallSeconds: wall, previewSeconds: preview };
  await snapshot("provider-title-open");
  await click('button[aria-label="Pause"]');
  await click('button[aria-label="Forward 10 seconds"]');
  await delay(1200);
  if (count("stream_started", (e) => e.properties.stream_type === "vod") !== 1)
    throw new Error("Paused seek created another start.");
  await click('[data-view="title"] button[aria-label="Play"]');
  await delay(1500);
  if (count("stream_started", (e) => e.properties.stream_type === "vod") !== 1)
    throw new Error("Resume created another start.");
  await snapshot("vod-paused-seek-resume");
  await keyEscape();
  await keyEscape();
  await namedButton("header button", "Downloads");
  await namedButton("button", "Watch offline");
  await waitFor(() =>
    live().evaluate<boolean>("!!document.querySelector('[data-view=title] video')"),
  );
  await waitFor(
    async () => count("stream_started", (e) => e.properties.stream_type === "vod") === 2,
  );
  await waitFor(
    async () => count("stream_stopped", (e) => e.properties.stream_type === "vod") === 1,
  );
  await snapshot("copy-playing");
  await keyEscape();
  await namedButton("header button", "Movies");
  const held = provider!.titles.movies.find((movie) => movie.name.includes("Long recording"));
  if (!held) throw new Error("No cancellable transfer fixture.");
  provider!.stallMovieFile(held.id, 40_000, 60_000);
  await namedButton("button[title]", "Long recording", true);
  await namedButton('[role="dialog"] button', "Download");
  await waitFor(() =>
    live().evaluate<boolean>(
      "!!document.querySelector('[role=dialog] button[aria-label$=\"cancel download\"]')",
    ),
  );
  await snapshot("transfer-running");
  await click('[role="dialog"] button[aria-label$="cancel download"]');
  await waitFor(
    async () => count("download_ended", (e) => e.properties.outcome === "interrupted") === 1,
  );
  await keyEscape();
  await namedButton("button[title]", "Missing file", true);
  await namedButton('[role="dialog"] button', "Download");
  await waitFor(
    async () => count("download_ended", (e) => e.properties.outcome === "failed") === 1,
  );
  await namedButton('[role="dialog"] button', "Play");
  // A failure before playing: one fixed error, with no start for that run.
  await waitFor(async () => count("stream_error", (e) => e.properties.stream_type === "vod") === 1);
  await delay(1500);
  if (
    count("stream_error") !== 1 ||
    count("stream_started", (e) => e.properties.stream_type === "vod") !== 2
  )
    throw new Error("A failed open repeated its error or started.");
  const failedOpen = sent().find((event) => event.event === "stream_error");
  if (
    !failedOpen ||
    failedOpen.event !== "stream_error" ||
    failedOpen.properties.diagnostic_stage !== "deliver" ||
    failedOpen.properties.diagnostic_reason !== "provider_unavailable"
  )
    throw new Error("The failed open lost its fixed provider failure context.");
  observations.failedOpenDiagnostic = failedOpen;
  await snapshot("failed-open");
  await keyEscape();
  await keyEscape();
  await namedButton("header button", "Series");
  await namedButton("header button", "Home");
  await namedButton("button", "Watchlist");
  await click('button[aria-label="Search"]');
  await snapshot("search-entry");
  await keyEscape();
  await settings();
  await click('[role="checkbox"][aria-label="Next episode"]');
  await waitFor(
    async () =>
      count("settings_changed", (e) => e.properties.setting_key === "autoplay_next") === 1,
  );
  offerUpdate = true;
  await namedButton("button", "Check now");
  await waitFor(
    async () => count("update_check_ended", (e) => e.properties.outcome === "success") === 1,
  );
  await keyEscape();
  await click("[data-update-notice]");
  await waitFor(async () => count("update_seen") === 1);
  await namedButton("button", "Not now");
  await waitFor(async () => count("update_dismissed") === 1);
  await snapshot("update-panel-dismissed");
  await settings();
  rejectUpdate = true;
  await namedButton("button", "Check now");
  await waitFor(
    async () => count("update_check_ended", (e) => e.properties.outcome === "failed") === 1,
  );
  await snapshot("update-check-failed");
  if (!mainPage) throw new Error("No owned main inspector.");
  // A real renderer crash in our disposable process, with main left alive to receive the exit.
  const electronModule = `process.getBuiltinModule('module').createRequire(${JSON.stringify(join(desktop, "package.json"))})('electron')`;
  await mainPage.evaluate(`(() => {
    const window = ${electronModule}.BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('No owned primary window.');
    window.webContents.forcefullyCrashRenderer();
    return true;
  })()`);
  await waitFor(async () => count("renderer_exited") === 1);
  await mainPage.evaluate(
    `(() => { ${electronModule}.BrowserWindow.getAllWindows()[0].webContents.reload(); return true; })()`,
  );
  page?.close();
  page = await connect(debuggingPort);
  await send("Page.bringToFront");
  await settings();
  await snapshot("renderer-recovered");
  actions.push({
    action:
      "Crashed only the owned renderer, main observed one unexpected exit; reloaded its primary window",
    at: new Date().toISOString(),
  });
  await delay(1500);
  for (const feature of [
    "home",
    "live_tv",
    "movies",
    "series",
    "watchlist",
    "downloads",
    "search",
    "settings",
    "player",
    "details",
  ] as const)
    if (count("feature_opened", (e) => e.properties.feature === feature) < 1)
      throw new Error(`No real entry for ${feature}.`);
  for (const action of ["playlist_added", "playlist_refreshed"] as const)
    if (count(action) < 1) throw new Error(`Missing source action ${action}.`);
  const enabled = sent();
  if (payloads.some((payload) => record(payload) && payload["event"] === "app_summary_day"))
    throw new Error("A daily summary was sent.");
  if (count("installation_observed") !== 1 || count("app_active_day") !== 1)
    throw new Error("Wrong first-seen/day observations.");
  // One raw property-key set per event name: the exact wire allowlist observed.
  observations["wireAllowlist"] = Object.fromEntries(
    payloads.flatMap((payload) =>
      record(payload) && record(payload["properties"])
        ? [[payload["event"], Object.keys(payload["properties"]).sort()]]
        : [],
    ),
  );
  observations["enabledCaptures"] = enabled.map((event) => ({
    event: event.event,
    ...Object.fromEntries(
      Object.entries(event.properties).filter(
        ([key]) =>
          ![
            "app_version",
            "build_channel",
            "update_channel",
            "os",
            "arch",
            "distribution",
            "profile_origin",
            "$process_person_profile",
            "$geoip_disable",
          ].includes(key),
      ),
    ),
  }));
  observations["streamFacts"] = enabled.filter((event) => event.event.startsWith("stream_"));
  rejectUpdate = false;
}

try {
  profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-"));
  profiles.push(profile);
  provider = await startFakeProvider({
    channels: 3,
    titles: 3,
    streams: (_channel, out, signal) => {
      // A continuous fake broadcast is needed to observe a real rounded watch minute. The usual
      // three-second fixture deliberately stalls, which is useful for recovery tests instead.
      const stream = spawn(
        process.env["MR_STREAMER_FFMPEG"] ?? "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-re",
          "-stream_loop",
          "-1",
          "-i",
          join(desktop, "test/fixtures/h264-aac.mpegts"),
          "-c",
          "copy",
          "-f",
          "mpegts",
          "pipe:1",
        ],
        { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"] },
      );
      broadcasts.add(stream);
      stream.once("close", () => broadcasts.delete(stream));
      stream.once("error", () => out.destroy(new Error("Fixture broadcast unavailable.")));
      stream.stdout.pipe(out);
      signal.addEventListener("abort", () => stream.kill("SIGTERM"), { once: true });
    },
  });
  tmdb = await startFakeTmdb();
  await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
  const address = capture.address();
  if (!address || typeof address === "string") throw new Error("No owned capture port.");
  endpoint = `http://127.0.0.1:${address.port}/i/v0/e/`;
  await new Promise<void>((resolve) => updateFeed.listen(0, "127.0.0.1", resolve));
  const updateAddress = updateFeed.address();
  if (!updateAddress || typeof updateAddress === "string")
    throw new Error("No local update endpoint.");
  updateEndpoint = `http://127.0.0.1:${updateAddress.port}`;
  if (packagedExecutable)
    observations["packagedExecutable"] = {
      path: packagedExecutable,
      args: packagedArgs,
      sha256: createHash("sha256")
        .update(await readFile(packagedExecutable))
        .digest("hex"),
    };
  await launch();
  await connectFixture();
  await waitFor(async () => (await preference()).analyticsEnabled === true);
  await waitFor(async () => count("installation_observed") === 1 && count("app_active_day") === 1);
  if (
    (await live().evaluate<string>(
      `document.querySelector(${JSON.stringify(checkbox)}).getAttribute('aria-checked')`,
    )) !== "true"
  )
    throw new Error("Default control is not checked.");
  await snapshot("on");
  injectedFailure("analytics");
  actions.push({
    action: "Opened real General Privacy control, default checked",
    at: new Date().toISOString(),
  });
  const first = sent().find((event) => event.event === "installation_observed");
  const day = sent().find((event) => event.event === "app_active_day");
  if (!first || !day) throw new Error("Wrong capture events.");
  for (const payload of payloads) {
    if (
      !record(payload) ||
      Object.keys(payload).sort().join() !==
        ["api_key", "distinct_id", "event", "properties", "timestamp", "uuid"].sort().join()
    )
      throw new Error("Unexpected capture envelope.");
    if (payload["api_key"] !== "mrstreamer-local-verification")
      throw new Error("Wrong local project.");
  }
  const expectedChannel = packagedExecutable
    ? appVersion.includes("-nightly.")
      ? "nightly"
      : "stable"
    : "unknown";
  for (const event of [first, day]) {
    if (
      event.properties.app_version !== appVersion ||
      event.properties.build_channel !== expectedChannel
    )
      throw new Error("Capture version/channel does not match this invocation.");
  }
  observations["channelAttribution"] = {
    expected: expectedChannel,
    actual: first.properties.build_channel,
    appVersion,
  };
  observations["firstSeenOrigin"] = first.properties.profile_origin;
  observations["payloadAllowlist"] = Object.keys(first.properties).sort();
  observations["activityAllowlist"] = Object.keys(day.properties).sort();
  await productPaths();
  const enabledCaptures = payloads.length;
  if (new Set(sent().map((event) => event.uuid)).size !== enabledCaptures)
    throw new Error("A capture was delivered twice.");
  await click(checkbox);
  await waitFor(async () => (await preference()).analyticsEnabled === false);
  await snapshot("off");
  actions.push({ action: "Turned sharing off through the checkbox", at: new Date().toISOString() });
  await quit();
  await launch();
  await settings();
  if ((await preference()).analyticsEnabled !== false)
    throw new Error("Opt-out did not survive restart.");
  await snapshot("restart-off");
  await delay(1200);
  if (payloads.length !== enabledCaptures)
    throw new Error("Disabled profile captured after restart.");
  actions.push({
    action: "Restarted same profile, checkbox remains off and capture count unchanged",
    at: new Date().toISOString(),
  });
  await click(checkbox);
  await waitFor(async () => (await preference()).analyticsEnabled === true);
  await snapshot("reenabled");
  await delay(1200);
  if (payloads.length !== enabledCaptures) throw new Error("Re-enable duplicated first-seen/day.");
  const diagnostics = await live().evaluate<unknown>(
    "window.mrStreamer.invoke('diagnostics.preview')",
  );
  if (JSON.stringify(diagnostics).includes(first.distinct_id))
    throw new Error("Installation identity leaked into diagnostics.");
  const stored: unknown = JSON.parse(await readFile(join(profile, "analytics.json"), "utf8"));
  if (
    !record(stored) ||
    stored["installationId"] !== first.distinct_id ||
    !Array.isArray(stored["pending"]) ||
    stored["pending"].length !== 0
  )
    throw new Error("Wrong persisted identity/outbox.");
  observations["captures"] = payloads.length;
  observations["optOutSurvivedRestart"] = true;
  observations["identityPreserved"] = true;
  observations["diagnosticsExcludeIdentity"] = true;
  // A format-one profile with a queued daily summary: the summary and its counts are discarded,
  // never sent, while consent, identity and the other queued event survive with their UUID.
  await quit();
  profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-legacy-"));
  profiles.push(profile);
  const legacyId = randomUUID();
  const legacyEnvelope = (event: string, extra: object) => ({
    uuid: randomUUID(),
    distinct_id: legacyId,
    timestamp: "2026-10-12T09:00:00.000Z",
    event,
    properties: { ...first.properties, profile_origin: "upgrading", ...extra },
  });
  const legacyInstall = legacyEnvelope("installation_observed", {});
  const legacySummary = legacyEnvelope("app_summary_day", {
    summary_date: "2026-10-11",
    counts: { features: { home: 2 }, saturated: false },
  });
  await writeFile(
    join(profile, "analytics.json"),
    JSON.stringify({
      format: 1,
      enabled: true,
      installationId: legacyId,
      profileOrigin: "upgrading",
      firstSeen: true,
      lastDay: "2026-10-12",
      summary: {
        day: "2026-10-13",
        counts: { features: { home: 1 }, saturated: false },
        properties: legacyInstall.properties,
        ready: null,
        reportedDay: "2026-10-11",
      },
      pending: [
        { event: legacyInstall, attempts: 1 },
        { event: legacySummary, attempts: 0 },
      ],
    }),
  );
  const legacyFrom = payloads.length;
  await launch();
  await waitFor(async () =>
    payloads
      .slice(legacyFrom)
      .some((payload) => record(payload) && payload["uuid"] === legacyInstall.uuid),
  );
  await waitFor(async () =>
    payloads
      .slice(legacyFrom)
      .some((payload) => record(payload) && payload["event"] === "app_active_day"),
  );
  await delay(2000);
  const legacySent = payloads.slice(legacyFrom).map(captured);
  if (
    payloads
      .slice(legacyFrom)
      .some(
        (payload) =>
          record(payload) &&
          (payload["event"] === "app_summary_day" || payload["uuid"] === legacySummary.uuid),
      )
  )
    throw new Error("A migrated daily summary was sent.");
  if (!isDeepStrictEqual(legacySent[0], legacyInstall))
    throw new Error("The queued legacy event changed identity or content.");
  if (legacySent.some((event) => event.distinct_id !== legacyId))
    throw new Error("Migration changed the installation identity.");
  const migrated = await analyticsFile();
  if (migrated["format"] !== 2 || "summary" in migrated || migrated["installationId"] !== legacyId)
    throw new Error("Migrated state kept daily counts or lost identity.");
  observations["legacyMigration"] = {
    sent: legacySent.map((event) => event.event),
    legacyEventSentUnchanged: true,
    summaryNeverSent: true,
    storedAfter: migrated,
  };
  await snapshot("legacy-migrated");
  actions.push({
    action: "Started a seeded format-one profile; its queued summary was discarded, not sent",
    at: new Date().toISOString(),
  });
  // A fresh profile observes real pending events while the local capture boundary refuses them.
  await quit();
  rejectCapture = true;
  profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-pending-"));
  profiles.push(profile);
  const refusedFrom = payloads.length;
  await launch();
  await connectFixture();
  const outbox = async () => {
    const kept: unknown = JSON.parse(await readFile(join(profile, "analytics.json"), "utf8"));
    if (!record(kept) || !Array.isArray(kept["pending"]))
      throw new Error("Invalid analytics outbox.");
    return kept;
  };
  await waitFor(async () => {
    const kept = await outbox();
    return Array.isArray(kept["pending"]) && kept["pending"].length >= 2;
  });
  // A refused event is retried with the same UUID, timestamp and body.
  await waitFor(async () => {
    const refused = payloads.slice(refusedFrom).filter(record);
    return refused.some((payload, index) =>
      refused.slice(index + 1).some((later) => isDeepStrictEqual(later, payload)),
    );
  });
  observations["refusedRetriedIdentically"] = true;
  observations["pendingBeforeOptOut"] = await outbox();
  await snapshot("pending-on");
  await click(checkbox);
  await waitFor(async () => {
    const kept = await outbox();
    return (
      kept["enabled"] === false && Array.isArray(kept["pending"]) && kept["pending"].length === 0
    );
  });
  observations["pendingAfterOptOut"] = await outbox();
  await snapshot("pending-cleared");
  actions.push({
    action: "Opted out with actual pending events; persisted queue is empty",
    at: new Date().toISOString(),
  });
  await quit();
  const countAfterQuit = payloads.length;
  await launch();
  await settings();
  await delay(1200);
  if ((await preference()).analyticsEnabled !== false || payloads.length !== countAfterQuit)
    throw new Error("Pending profile captured after opt-out restart.");
  await snapshot("pending-restart-off");
  observations["pendingQueueCleared"] = true;
  observations["pendingRestartCaptures"] = payloads.length - countAfterQuit;
  observations["productionAnalyticsRequests"] = 0;
  observations["productionExclusionEvidence"] =
    "Transport accepts only this literal loopback endpoint; explicit isolated profile and automation also exclude configured production transport.";
} catch (error) {
  failure = error;
  if (page) await snapshot("failure").catch(() => {});
} finally {
  const clean = async (operation: () => Promise<unknown>) => {
    try {
      await operation();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
  };
  await clean(quit);
  if (provider) await clean(() => provider!.close());
  for (const broadcast of broadcasts) await clean(() => stop(broadcast, undefined));
  if (tmdb) await clean(() => tmdb!.close());
  if (updateFeed.listening)
    await clean(async () => {
      updateFeed.closeAllConnections();
      await new Promise<void>((resolve) => updateFeed.close(() => resolve()));
    });
  if (capture.listening)
    await clean(async () => {
      capture.closeAllConnections();
      await new Promise<void>((resolve) => capture.close(() => resolve()));
    });
  const appExited = !app || app.exitCode !== null || app.signalCode !== null;
  if (appExited)
    for (const owned of profiles) await clean(() => rm(owned, { recursive: true, force: true }));
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (cleanupErrors.length) failure ??= new Error(cleanupErrors.join("\n"));
  await writeFile(join(evidence, "payloads.json"), JSON.stringify(payloads, null, 2));
  await writeFile(join(evidence, "electron.log"), log.join(""));
  await writeFile(
    join(evidence, "proof.json"),
    JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        error: failure instanceof Error ? failure.message : undefined,
        actions,
        pointerInputs,
        scenario: "analytics",
        build: packagedExecutable ? undefined : build,
        verificationSource: packagedExecutable ? build : undefined,
        mode: packagedExecutable ? "packaged-executable" : "source-build",
        observed: observations,
        cleanup: {
          appExited,
          fixturesClosed: cleanupErrors.length === 0 && !capture.listening,
          broadcastsExited: broadcasts.size === 0,
          profileRemoved: (
            await Promise.all(
              profiles.map((owned) =>
                access(owned).then(
                  () => false,
                  () => true,
                ),
              ),
            )
          ).every(Boolean),
          errors: cleanupErrors,
        },
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        mainSha256: createHash("sha256")
          .update(await readFile(join(desktop, "out/main/index.js")))
          .digest("hex"),
        limitations: [
          "Local capture, no live PostHog project/dashboard/retention acceptance",
          "Abrupt termination without quit loses an unflushed stream_stopped; not exercised",
          packagedExecutable
            ? "Packaged executable against local capture; installed upgrade/native acceptance remains separate"
            : "Source build; native installed acceptance pending",
        ],
      },
      null,
      2,
    ),
  );
}
console.log(evidence);
if (failure) throw failure;
