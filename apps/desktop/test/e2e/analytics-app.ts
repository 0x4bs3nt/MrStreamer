import { preferenceValues } from "./preference-reply.ts";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
// Built-app proof through the actual Settings control, with an isolated profile and loopback only.
import { watch } from "node:fs";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type } from "arktype";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type { Result } from "@mrstreamer/contracts/errors";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import {
  CaptureEvent,
  AnalyticsRecord,
  type UsageKey,
  type CaptureName,
  type CaptureOf,
} from "../../src/main/analytics/model.ts";
import { startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { connect, delay, type Page } from "./app.ts";
import { analyticsOptions } from "./analytics-options.ts";
import { boundary } from "./analytics-boundary.ts";
import { closeNative } from "./analytics-exit.ts";
import { failRendererLaunch } from "./analytics-launch-diagnostic.ts";
import { startupProbe } from "./analytics-startup.ts";
import { runNativeTelemetry } from "./analytics-native.ts";
import { disposableRunner, ownedTree } from "./installed-upgrade-windows.ts";
import {
  electronExecutable,
  evidenceDirectory,
  injectedFailure,
  freePort,
  record,
  stop,
} from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const options = analyticsOptions(process.argv.slice(2));
const builtDesktop = options.builtDesktop;
const desktop = builtDesktop ?? join(root, "apps/desktop");
const volumeWorkload = options.volume;
const evidence = await evidenceDirectory(join(root, ".local/verification"), "analytics-");
// Retain the complete local verifier dependency surface, plus its dependency lock.
const verificationFiles = execFileSync(
  "git",
  [
    "ls-files",
    "apps/desktop/test/e2e/*.ts",
    "apps/desktop/test/fake-*.ts",
    ".cursor/skills/verify-mrstreamer/scripts/*.ts",
    "packages/contracts/src/*.ts",
    "apps/desktop/src/main/analytics/model.ts",
    "**/package.json",
    "pnpm-lock.yaml",
  ],
  { cwd: root, encoding: "utf8" },
)
  .trim()
  .split("\n");
const verificationHashes = Object.fromEntries(
  await Promise.all(
    verificationFiles.map(async (name) => {
      const bytes = await readFile(join(root, name));
      const destination = join(evidence, "verification-source", name);
      await mkdir(resolve(destination, ".."), { recursive: true });
      await writeFile(destination, bytes);
      return [name, createHash("sha256").update(bytes).digest("hex")];
    }),
  ),
);
const observeRollover = options.rollover;
const packagedExecutable = options.executable;
const packagedArgs = options.appArgs;
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const sourceAppVersion = (
  JSON.parse(await readFile(join(desktop, "package.json"), "utf8")) as { version: string }
).version;
const sourceDirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
const verificationSource = {
  revision,
  appVersion: (
    JSON.parse(await readFile(join(root, "apps/desktop/package.json"), "utf8")) as {
      version: string;
    }
  ).version,
  sourceKind: "verifier-checkout",
  sourceDirty,
};
const appVersion = options.expectedVersion ?? sourceAppVersion;
const build = {
  revision: builtDesktop
    ? (await readFile(join(desktop, "source-revision.txt"), "utf8")).trim()
    : revision,
  appVersion: sourceAppVersion,
  sourceKind: builtDesktop ? "archived-source-build" : "checkout-source-build",
  sourceDirty: builtDesktop ? null : sourceDirty,
  ...(!packagedExecutable
    ? {
        mainSha256: createHash("sha256")
          .update(await readFile(join(desktop, "out/main/index.js")))
          .digest("hex"),
      }
    : {}),
};
const bundleHashes: Record<string, string> = {};
if (!packagedExecutable) {
  const snapshot = join(evidence, "product-bundle");
  await cp(join(desktop, "out"), snapshot, { recursive: true });
  for (const entry of await readdir(snapshot, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      const path = join(entry.parentPath, entry.name);
      bundleHashes[path.slice(snapshot.length + 1)] = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
    }
  }
}
const candidate = {
  executable: packagedExecutable,
  version: appVersion,
  source: options.expectedSource ?? build.revision,
};
let target = candidate;
let localTransport = true;
const installedHashes = new Map<string, string>();
const attributions: {
  version: string;
  os: string;
  arch: string;
  distribution: string;
  buildChannel: string;
}[] = [];
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Verification interrupted."));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let profile = "";
const profiles: string[] = [];
let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
const payloads: unknown[] = [];
const payloadBytes: number[] = [];
const rawBodies: { body: string; at: number; closedAt?: number }[] = [];
let holdSummary = false;
let holdUsageOnly = false;
let rejectCapture = false;
const capture = createServer(async (req, res) => {
  const bytes: Buffer[] = [];
  for await (const chunk of req) bytes.push(Buffer.from(chunk));
  const body = Buffer.concat(bytes);
  payloads.push(JSON.parse(body.toString()));
  const wire: (typeof rawBodies)[number] = { body: body.toString(), at: Date.now() };
  rawBodies.push(wire);
  res.once("close", () => {
    wire.closedAt = Date.now();
  });
  if (
    holdSummary &&
    (holdUsageOnly ? ["usage_window"] : ["stream_summary", "usage_window"]).includes(
      String(JSON.parse(body.toString()).event),
    )
  )
    return;
  payloadBytes.push(body.byteLength);
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
let prefixProfile: string | undefined;
let prefixObserving = false;
let prefixProbe: Awaited<ReturnType<typeof boundary>> | undefined;
const prefixErrors: string[] = [];
const prefixCounters: {
  key: UsageKey;
  samples: number;
  last: Record<string, unknown>;
  transitions: { at: number; total: number }[];
}[] = [];
const pointerInputs: Record<string, unknown>[] = [];
const log: string[] = [];
let app: ChildProcess | undefined;
let page: Page | undefined;
let mainPage: Page | undefined;
let nativeTree: ReturnType<typeof ownedTree> | undefined;
let preparedExit:
  | {
      app: ChildProcess;
      sample: {
        pid: number | undefined;
        reason: string;
        startedAt: number;
        completedAt: number;
        wallMs: number;
        windowsTree: boolean;
      };
    }
  | undefined;

// The Windows owner pins PID/start-time identity. Discover its live descendants at a quiet
// point, before a held request or rename opens a product deadline. Consume once per exit.
function prepareExit(reason: string) {
  if (!app) throw new Error("No owned app to prepare for exit");
  const startedAt = Date.now();
  nativeTree?.sample();
  const completedAt = Date.now();
  const sample = {
    pid: app.pid,
    reason,
    startedAt,
    completedAt,
    wallMs: completedAt - startedAt,
    windowsTree: !!nativeTree,
  };
  preparedExit = { app, sample };
  const samples = observations["nativeProcessSamples"];
  observations["nativeProcessSamples"] = [...(Array.isArray(samples) ? samples : []), sample];
}

let debuggingPort = 0;
const broadcasts = new Set<ChildProcess>();
let failure: unknown;
const cleanupErrors: string[] = [];
const exits: Record<string, unknown>[] = [];
const endTree: unknown[] = [];

/** Validate a clone, then compare the complete raw wire body before any unknown-key deletion. */
function captured(payload: unknown): CaptureEvent {
  const event = CaptureEvent()(structuredClone(payload));
  if (event instanceof type.errors) throw new Error("Invalid capture event.");
  if (!isDeepStrictEqual(payload, { api_key: "mrstreamer-local-verification", ...event }))
    throw new Error("Unexpected raw capture fields.");
  if (
    !attributions.some(
      (identity) =>
        event.properties.app_version === identity.version &&
        event.properties.os === identity.os &&
        event.properties.arch === identity.arch &&
        event.properties.distribution === identity.distribution &&
        event.properties.build_channel === identity.buildChannel &&
        (identity.distribution === "store"
          ? event.properties.update_channel === "none"
          : event.properties.update_channel !== "none"),
    )
  )
    throw new Error("Wire attribution differs from the actual launched package");
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

let launchOrdinal = 0;
let startupSample: Awaited<ReturnType<typeof startupProbe>>["read"] | undefined;
let startupPreferences: Awaited<ReturnType<typeof startupProbe>>["preferences"] | undefined;
let startupReadDelayMs = 0;
let startupCaptureFrom = 0;
const startupSamples: unknown[] = [];
async function captureStartup() {
  const sample = startupSample;
  startupSample = undefined;
  if (!sample) return;
  const operations = await sample().catch(() => null);
  const enabled = page
    ? await page
        .evaluate<boolean | null>(
          `(() => {
        const checked = document.querySelector(${JSON.stringify(checkbox)})?.getAttribute('aria-checked');
        return checked === 'true' ? true : checked === 'false' ? false : null;
      })()`,
          2000,
        )
        .catch(() => null)
    : null;
  startupSamples.push({
    launchOrdinal,
    capturedAt: new Date().toISOString(),
    injectedReadDelayMs: startupReadDelayMs,
    operations,
    preferences: await startupPreferences?.().catch(() => null),
    captureRefusing: rejectCapture,
    receivedBodies: payloads.length - startupCaptureFrom,
    enabled,
  });
  observations.startupIO = startupSamples;
}
async function launch(readDelayMs = options.slowStartup ? 1700 : 0) {
  const ordinal = ++launchOrdinal;
  startupReadDelayMs = readDelayMs;
  startupPreferences = undefined;
  startupCaptureFrom = payloads.length;
  preparedExit = undefined;
  const port = await freePort();
  debuggingPort = port;
  const inspectorPort = await freePort();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !name.startsWith("MR_STREAMER_") &&
        name !== "ELECTRON_RUN_AS_NODE" &&
        name !== "NODE_OPTIONS",
    ),
  );
  app = spawn(
    target.executable ?? (await electronExecutable()),
    [
      `--remote-debugging-port=${port}`,
      `${options.slowStartup ? "--inspect-brk" : "--inspect"}=${inspectorPort}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--enable-automation",
      "--use-mock-keychain",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      ...(target.executable ? packagedArgs : [desktop]),
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
        ...(localTransport ? { MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT: endpoint } : {}),
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    app!.once("error", reject);
    app!.once("spawn", resolve);
  }).catch((error: unknown) => {
    app = undefined;
    throw error;
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  let comparedMainPid: number;
  if (!options.slowStartup) {
    page = await connect(port, "page", { app });
    mainPage = await connect(inspectorPort, "node", { app });
    comparedMainPid = await mainPage.evaluate<number>("process.pid");
  } else {
    mainPage = await connect(inspectorPort, "node", { app });
    const probe = await startupProbe(mainPage, profile, readDelayMs, app.pid);
    comparedMainPid = probe.pid;
    startupSample = probe.read;
    startupPreferences = probe.preferences;
    page = await connect(port, "page", { app });
  }
  if (comparedMainPid !== app.pid) throw new Error("Wrong main inspector process.");
  const identity = await send("Browser.getBrowserCommandLine");
  const arguments_ = record(identity) ? identity["arguments"] : null;
  if (
    !Array.isArray(arguments_) ||
    ![
      ...(target.executable ? [] : [desktop]),
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
    ].every((arg) => arguments_.includes(arg))
  )
    throw new Error("Wrong app instance.");
  // Navigation can destroy a blank document's context. Keep sampling this same owned page
  // within the existing allowance, then retain the ordinary launch receipt on failure.
  const navigationStarted = performance.now();
  const urlSamples: { elapsedMs: number; url?: string; error?: string }[] = [];
  let url = "";
  while (performance.now() - navigationStarted < 4000) {
    const remaining = Math.floor(4000 - (performance.now() - navigationStarted));
    if (remaining <= 0) break;
    try {
      url = await page.evaluate<string>("location.href", Math.min(500, remaining));
      urlSamples.push({ elapsedMs: performance.now() - navigationStarted, url });
      if (url !== "about:blank") break;
    } catch (error) {
      urlSamples.push({
        elapsedMs: performance.now() - navigationStarted,
        error: String(error).slice(0, 2048),
      });
    }
    const pause = Math.min(150, 4000 - (performance.now() - navigationStarted));
    if (pause > 0) await delay(pause);
  }
  if (
    target.executable
      ? !url.startsWith("file:") ||
        !/\/(?:resources|Resources)\/app\.asar\/out\/renderer\//.test(url)
      : !url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href)
  ) {
    observations.rendererLaunchWait = { launchOrdinal: ordinal, samples: urlSamples };
    await failRendererLaunch(new Error("Wrong renderer build."), {
      evidence,
      observations,
      page,
      mainPage,
      app,
      rejectedUrl: url,
      comparedMainPid,
      browserArguments: arguments_,
      pagePort: port,
      inspectorPort,
      profile,
      target,
      launchOrdinal: ordinal,
    });
  }
  const nativeIdentity = await mainPage.evaluate<{
    pid: number;
    executable: string;
    resources: string;
    appPath: string;
    version: string;
    mainSha256: string;
    platform: string;
    arch: string;
    packaged: boolean;
  }>(`(async () => {
    const {app} = process.getBuiltinModule('module').createRequire(process.execPath)('electron');
    const fs = process.getBuiltinModule('fs').promises;
    const {createHash} = process.getBuiltinModule('crypto');
    const path = process.getBuiltinModule('path');
    return {pid:process.pid, executable:process.execPath, resources:process.resourcesPath,
      appPath:app.getAppPath(), version:app.getVersion(), platform:process.platform, arch:process.arch, packaged:app.isPackaged, mainSha256:createHash('sha256')
        .update(await fs.readFile(path.join(app.getAppPath(),'out/main/index.js'))).digest('hex')};
  })()`);
  if (nativeIdentity.pid !== app.pid || nativeIdentity.version !== target.version)
    throw new Error("Main identity/version differs from the selected candidate");
  if (
    target.executable &&
    !target.executable.endsWith(".AppImage") &&
    resolve(nativeIdentity.executable).toLowerCase() !== resolve(target.executable).toLowerCase()
  )
    throw new Error("Main runs a different executable");
  await waitFor(() => live().evaluate<boolean>("!!window.mrStreamer"));
  const status = await live().evaluate<Result<UpdateStatus>>(
    "window.mrStreamer.invoke('updates.status')",
  );
  const expectedDistribution =
    target.executable && /[\\/]WindowsApps[\\/]/i.test(target.executable) ? "store" : "direct";
  if (
    !status.ok ||
    status.value.version !== target.version ||
    status.value.distribution !== expectedDistribution
  )
    throw new Error("Public installed version/distribution differs from the selected package");
  attributions.push({
    version: target.version,
    os:
      nativeIdentity.platform === "darwin"
        ? "macos"
        : nativeIdentity.platform === "win32"
          ? "windows"
          : nativeIdentity.platform,
    arch: nativeIdentity.arch,
    distribution: status.value.distribution,
    buildChannel: nativeIdentity.packaged
      ? target.version.includes("-nightly.")
        ? "nightly"
        : "stable"
      : "unknown",
  });
  const asar = target.executable ? join(nativeIdentity.resources, "app.asar") : undefined;
  if (asar && nativeIdentity.appPath.toLowerCase() !== asar.toLowerCase())
    throw new Error("Main app path differs from its installed resources");
  if (
    target.executable &&
    !url.startsWith(pathToFileURL(join(nativeIdentity.appPath, "out/renderer/")).href)
  )
    throw new Error("Renderer is outside the actual installed app");
  if (options.native && process.platform === "win32")
    nativeTree = ownedTree(disposableRunner(), app);
  observations["instance"] = {
    port,
    inspectorPort,
    profile,
    url,
    endpoint,
    ...nativeIdentity,
    expected: target,
    ...(target.executable
      ? {
          executableSha256: createHash("sha256")
            .update(await readFile(nativeIdentity.executable))
            .digest("hex"),
          launcherSha256: createHash("sha256")
            .update(await readFile(target.executable))
            .digest("hex"),
          asarSha256: createHash("sha256")
            .update(await readFile(asar!))
            .digest("hex"),
        }
      : {}),
  };
  if (asar) {
    const digest = createHash("sha256")
      .update(await readFile(asar))
      .digest("hex");
    const snapshot = join(evidence, `product-${digest}.asar`);
    try {
      await access(snapshot);
    } catch {
      await cp(asar, snapshot);
    }
  }
  if (target.executable) {
    const key = JSON.stringify(target);
    const instance = observations["instance"];
    if (!record(instance)) throw new Error("Missing installed identity");
    const hashes = JSON.stringify([
      instance["executableSha256"],
      instance["launcherSha256"],
      instance["asarSha256"],
    ]);
    const previous = installedHashes.get(key);
    if (previous && previous !== hashes)
      throw new Error("Installed candidate bytes changed between starts");
    installedHashes.set(key, hashes);
  }
  const instances = observations["instances"];
  observations["instances"] = [
    ...(Array.isArray(instances) ? instances : []),
    observations["instance"],
  ];
  await send("Page.bringToFront");
}

async function quit() {
  if (app) {
    const closing = app;
    await captureStartup();
    mainPage?.close();
    mainPage = undefined;
    if (options.native) {
      if (preparedExit?.app !== closing) prepareExit("quit-fallback");
      const preparation = { ...preparedExit!.sample, usedAt: Date.now() };
      preparedExit = undefined;
      const end = await closeNative(closing, async () => {
        await page?.send("Browser.close");
      });
      exits.push({ ...end, preparation });
      if (end.forced && process.platform !== "win32" && closing.pid) {
        try {
          process.kill(-closing.pid, "SIGKILL");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
      await waitFor(async () => broadcasts.size === 0, 4000);
      if (nativeTree) {
        endTree.push(await nativeTree.stop(async () => {}));
        nativeTree = undefined;
      }
      app = undefined;
      if (
        end.forced ||
        end.alreadyExited ||
        end.requestError ||
        end.code !== 0 ||
        end.signal !== null
      )
        throw new Error("Native quit was not graceful: " + JSON.stringify(end));
    } else await stop(closing, page);
  }
  page?.close();
  page = undefined;
  mainPage?.close();
  mainPage = undefined;
  if (options.native) await waitFor(async () => broadcasts.size === 0, 4000);
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
  if (await live().evaluate<boolean>("!!document.querySelector('[data-view=settings]')"))
    await namedButton("nav button", "Privacy");
  await waitFor(() =>
    live().evaluate<boolean>(
      "!!document.querySelector('[role=checkbox][aria-label=\"Share basic usage statistics\"]')",
    ),
  );
}

async function verifyAbout() {
  await settings();
  await namedButton("nav button", "About");
  await waitFor(() => live().evaluate<boolean>("!!document.querySelector('a[href*=\"/tree/\"]')"));
  const shown = await live().evaluate<{ source: string; text: string }>(
    `({source:document.querySelector('a[href*="/tree/"]').href.split('/tree/')[1],text:document.body.innerText})`,
  );
  if (shown.source !== target.source || !shown.text.includes(target.version))
    throw new Error("About does not match the pinned version/source");
  await snapshot("about-" + (observations["instances"] as unknown[]).length);
  await keyEscape();
}

const checkbox = '[role="checkbox"][aria-label="Share basic usage statistics"]';
async function preference() {
  const result = await live().evaluate<Result<Preferences | PreferenceSnapshot>>(
    "window.mrStreamer.invoke('preferences.get')",
  );
  if (!result.ok) throw new Error("Preferences unavailable.");
  return preferenceValues(result.value);
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

/** Counters must be durable immediately, although their HTTP capture waits for sealing. */
async function usageCount(key: UsageKey): Promise<number> {
  const observing =
    prefixObserving && (key === "action_epg_opened" || key === "action_favourite_added");
  let diagnostic = observing ? prefixCounters.find((sample) => sample.key === key) : undefined;
  if (observing && !diagnostic) {
    diagnostic = { key, samples: 0, last: {}, transitions: [] };
    prefixCounters.push(diagnostic);
  }
  if (diagnostic) {
    diagnostic.samples++;
    diagnostic.last = { readStartedAt: Date.now(), stage: "read" };
  }
  try {
    let kept: Record<string, unknown>;
    if (diagnostic) {
      const bytes = await readFile(join(profile, "analytics.json"));
      Object.assign(diagnostic.last, {
        readEndedAt: Date.now(),
        rawBase64: bytes.toString("base64"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
        stage: "parse",
      });
      const parsed: unknown = JSON.parse(bytes.toString("utf8"));
      if (!record(parsed)) throw new Error("Invalid analytics state.");
      kept = parsed;
      diagnostic.last.stage = "record-validation";
    } else kept = await analyticsFile();
    const stored = AnalyticsRecord().assert(kept);
    const active = stored.summaries?.usage;
    if (diagnostic) diagnostic.last.stage = "wire-validation";
    const received = sent();
    const total =
      received.reduce(
        (sum, event) =>
          sum + (event.event === "usage_window" ? (event.properties.counts[key] ?? 0) : 0),
        0,
      ) + (active?.event === "usage_window" ? (active.properties.counts[key] ?? 0) : 0);
    if (diagnostic) {
      Object.assign(diagnostic.last, {
        stage: "complete",
        sampledAt: Date.now(),
        total,
        active: active && { uuid: active.uuid, counts: active.properties.counts },
        pending: stored.summaries?.pending.map((item) => ({
          uuid: item.event.uuid,
          event: item.event.event,
          counts: item.event.event === "usage_window" ? item.event.properties.counts : undefined,
          attempts: item.attempts,
          failures: item.failures,
          nextAttemptAt: item.nextAttemptAt,
        })),
        receivedUsage: received.flatMap((event, index) =>
          event.event === "usage_window" ? [{ uuid: event.uuid, ...rawBodies[index] }] : [],
        ),
      });
      if (diagnostic.transitions.at(-1)?.total !== total) {
        diagnostic.transitions.push({ at: Date.now(), total });
        if (diagnostic.transitions.length > 8) diagnostic.transitions.shift();
      }
    }
    return total;
  } catch (error) {
    if (diagnostic) Object.assign(diagnostic.last, { failedAt: Date.now(), error: String(error) });
    throw error;
  }
}

// Ordinary guide/favourite prefix only: passive public renames, never an armed boundary.
async function observePrefix() {
  prefixProfile = profile;
  prefixObserving = true;
  observations.guideFavouriteDiagnostics = {
    profile,
    counters: prefixCounters,
    errors: prefixErrors,
  };
  try {
    const userData = await mainPage!.evaluate<string>(
      `process.getBuiltinModule('module').createRequire(process.execPath)('electron').app.getPath('userData')`,
    );
    const paths = {
      profile,
      userData,
      ownedReal: await realpath(profile),
      appReal: await realpath(userData),
    };
    observations.guideFavouritePaths = paths;
    if (!profiles.includes(profile) || paths.ownedReal !== paths.appReal)
      throw new Error("Passive probe requires the same real owned app profile");
    prefixProbe = await boundary(mainPage!, profile, userData);
    observations.guideFavouriteProbeInstalledAt = Date.now();
  } catch (error) {
    prefixErrors.push(`attach: ${String(error)}`);
  }
}

async function restorePrefix() {
  const probe = prefixProbe;
  prefixProbe = undefined;
  prefixObserving = false;
  if (!probe) return;
  try {
    try {
      const measurements = await probe.measurements();
      observations.guideFavouriteRenames = {
        capturedAt: Date.now(),
        count: measurements.length,
        measurements,
      };
    } finally {
      await probe.restore();
      observations.guideFavouriteProbeRestoredAt = Date.now();
    }
  } catch (error) {
    prefixErrors.push(`restore/measurements: ${String(error)}`);
  }
}

/** Retain owned bytes and public reads before screenshot/quit; preserve the original failure. */
async function capturePrefixFailure() {
  if (profile !== prefixProfile || !profiles.includes(profile)) return;
  const destination = join(evidence, "guide-favourite-failure");
  const capture = async (name: string, read: () => Promise<unknown>) => {
    const startedAt = Date.now();
    try {
      const value = await read();
      await writeFile(
        join(destination, name),
        JSON.stringify({ startedAt, completedAt: Date.now(), value }, null, 2),
      );
    } catch (error) {
      prefixErrors.push(`${name}: ${String(error)}`);
    }
  };
  try {
    await mkdir(destination, { recursive: true });
  } catch (error) {
    prefixErrors.push(`failure capture: ${String(error)}`);
    return;
  }
  await capture("fixture-guide-requests.json", async () => provider?.guideRequests());
  await capture("counter-samples.json", async () => prefixCounters);
  await capture("rename-measurements.json", async () => observations.guideFavouriteRenames);
  await capture("analytics.json.read.json", async () => {
    const bytes = await readFile(join(profile, "analytics.json"));
    await writeFile(join(destination, "analytics.json"), bytes);
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  await capture("temporary-files.json", async () => {
    const files = await readdir(profile, { withFileTypes: true });
    const temporary = files.filter(
      (file) => file.isFile() && /^analytics\.json\.[0-9a-f-]{36}\.tmp$/.test(file.name),
    );
    for (const file of temporary) {
      await capture(`${file.name}.read.json`, async () => {
        const bytes = await readFile(join(profile, file.name));
        await writeFile(join(destination, file.name), bytes);
        return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
      });
    }
    return temporary.map((file) => file.name);
  });
  if (page)
    for (const method of ["preferences.get", "viewing.get", "guide.status", "guide.sources"])
      await capture(`${method}.json`, () =>
        live().evaluate(`window.mrStreamer.invoke(${JSON.stringify(method)})`),
      );
}

async function unfinished() {
  const event = AnalyticsRecord().assert(await analyticsFile()).summaries?.unfinished?.event;
  return event?.event === "stream_summary" ? event : undefined;
}

/** A fixed browsing/channel-surf workload, shared by an archived old build and this candidate. */
async function volumePaths() {
  const before = await mainPage!.evaluate<NodeJS.ResourceUsage>("process.resourceUsage()");
  const temporaryWrites = new Set<string>();
  const watcher = watch(profile, (_event, name) => {
    if (name && /^analytics\.json\.[0-9a-f-]{36}\.tmp$/.test(name.toString()))
      temporaryWrites.add(name.toString());
  });
  const wallFrom = Date.now();
  try {
    const channels = provider!.catalogue.channels.slice(0, 2);
    for (let round = 0; round < 6; round++) {
      await keyEscape();
      await namedButton("header button", round % 2 ? "Home" : "Live TV");
      await click('button[aria-label="Search"]');
      const name = channels[round % 2]!.name;
      for (const type of ["rawKeyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key: "a",
          code: "KeyA",
          modifiers: 2,
          windowsVirtualKeyCode: 65,
        });
      await send("Input.insertText", { text: name });
      await waitFor(() =>
        live().evaluate<boolean>(
          `document.querySelector('[aria-label="Search results"] [aria-selected=true]')?.textContent.includes(${JSON.stringify(name.replace(/^TEST \| /, ""))}) ?? false`,
        ),
      );
      const priorStarts = count("stream_started");
      const priorJournal = (await unfinished())?.uuid;
      for (const type of ["rawKeyDown", "keyUp"])
        await send("Input.dispatchKeyEvent", {
          type,
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
        });
      await waitFor(
        async () =>
          count("stream_started") > priorStarts ||
          (!!(await unfinished()) && (await unfinished())?.uuid !== priorJournal),
      );
      await waitFor(() =>
        live().evaluate<boolean>(
          "!!document.querySelector('[data-view=watch]') && document.querySelector('video').videoWidth > 0 && document.querySelector('video').currentTime >= 1",
        ),
      );
      // End-only reporting must leave the currently confirmed play untransmitted.
      if (count("stream_summary") > round) throw new Error("Active surf play was sent before end.");
      await delay(1000);
    }
    await snapshot("surf-playing");
    const after = await mainPage!.evaluate<NodeJS.ResourceUsage>("process.resourceUsage()");
    await quit();
    await delay(50);
    observations.volumeWorkload = {
      rounds: 6,
      wallMs: Date.now() - wallFrom,
      mainUserCpuMs: (after.userCPUTime - before.userCPUTime) / 1000,
      mainSystemCpuMs: (after.systemCPUTime - before.systemCPUTime) / 1000,
      mainFsWriteBlocks: after.fsWrite - before.fsWrite,
      observedAtomicAnalyticsWrites: temporaryWrites.size,
      requests: payloads.length,
      bytes: payloadBytes.reduce((total, size) => total + size, 0),
      events: sent(),
      limits:
        "One Linux run. Main CPU excludes renderer/GPU/FFmpeg. fs.watch counts distinct analytics temp files; native rename latency remains separate.",
    };
  } finally {
    watcher.close();
  }
  await launch();
  await settings();
}

async function productPaths() {
  await keyEscape();
  await namedButton("header button", "Live TV");
  await observePrefix();
  // Actual guide expansion/favourite/search use, without treating schedule queries as actions.
  await click('button[aria-label="Later programmes"]');
  await waitFor(async () => (await usageCount("action_epg_opened")) === 1);
  await click('button[aria-label="Add to favourites"]');
  await waitFor(async () => (await usageCount("action_favourite_added")) === 1);
  await restorePrefix();
  await click('button[aria-label="Search"]');
  await send("Input.insertText", { text: "TEST | H.264 + AAC" });
  await waitFor(() =>
    live().evaluate<boolean>(
      "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
    ),
  );
  await waitFor(async () => (await usageCount("action_search_used")) === 1);
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
  await waitFor(async () => (await unfinished())?.properties.stream_type === "live");
  if (count("stream_summary") !== 0) throw new Error("Playback sent before its end.");
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
  if (count("stream_summary") !== 0) throw new Error("Home preview started or stopped a run.");
  await snapshot("excluded-home-preview");
  await namedButton("button", "Watch");
  await delay(2500);
  if (count("stream_summary") !== 0) throw new Error("Preview promotion ended the logical play.");
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
    async () => count("stream_summary", (e) => e.properties.stream_type === "live") === 1,
  );
  const liveStopped = Date.now();
  await waitFor(async () => (await unfinished())?.properties.stream_type === "vod");
  const titleSummaryId = (await unfinished())?.uuid;
  const liveStop = sent().find(
    (event) => event.event === "stream_summary" && event.properties.stream_type === "live",
  );
  if (liveStop?.event !== "stream_summary") throw new Error("No live stop.");
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
  if ((await unfinished()) && (await unfinished())?.uuid !== titleSummaryId)
    throw new Error("Paused seek created another start.");
  await click('[data-view="title"] button[aria-label="Play"]');
  await delay(1500);
  if ((await unfinished()) && (await unfinished())?.uuid !== titleSummaryId)
    throw new Error("Resume created another logical play.");
  await snapshot("vod-paused-seek-resume");
  await keyEscape();
  await keyEscape();
  await namedButton("header button", "Downloads");
  await namedButton("button", "Watch offline");
  await waitFor(() =>
    live().evaluate<boolean>("!!document.querySelector('[data-view=title] video')"),
  );
  await waitFor(
    async () =>
      (await unfinished())?.properties.stream_type === "vod" &&
      (await unfinished())?.uuid !== titleSummaryId,
  );
  await waitFor(
    async () => count("stream_summary", (e) => e.properties.stream_type === "vod") === 1,
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
    count("stream_summary", (e) => e.properties.stream_type === "vod") !== 2
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
  if (await live().evaluate<boolean>("!!document.querySelector('[data-view=settings]')"))
    await namedButton("nav button", "Playback");
  await click('[role="checkbox"][aria-label="Next episode"]');
  await waitFor(async () => (await usageCount("setting_autoplay_next")) === 1);
  if (await live().evaluate<boolean>("!!document.querySelector('[data-view=settings]')"))
    await namedButton("nav button", "Updates");
  const updateStatus = await live().evaluate<Result<UpdateStatus>>(
    "window.mrStreamer.invoke('updates.status')",
  );
  if (!updateStatus.ok) throw new Error("Cannot observe update distribution");
  if (updateStatus.value.distribution === "store") {
    await waitFor(() =>
      live().evaluate<boolean>(
        "document.body.textContent.includes('Microsoft Store') && Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Open Store')",
      ),
    );
    if (
      count("update_check_ended") !== 0 ||
      (await usageCount("action_update_seen")) !== 0 ||
      (await usageCount("action_update_dismissed")) !== 0
    )
      throw new Error("Store installation emitted direct-updater captures");
    observations.storeManagedUpdates = true;
    await snapshot("store-managed-updates");
  } else {
    offerUpdate = true;
    await namedButton("button", "Check now");
    await waitFor(
      async () => count("update_check_ended", (e) => e.properties.outcome === "success") === 1,
    );
    await keyEscape();
    await click("[data-update-notice]");
    await waitFor(async () => (await usageCount("action_update_seen")) === 1);
    await namedButton("button", "Not now");
    await waitFor(async () => (await usageCount("action_update_dismissed")) === 1);
    await snapshot("update-panel-dismissed");
    await settings();
    if (await live().evaluate<boolean>("!!document.querySelector('[data-view=settings]')"))
      await namedButton("nav button", "Updates");
    rejectUpdate = true;
    await namedButton("button", "Check now");
    await waitFor(
      async () => count("update_check_ended", (e) => e.properties.outcome === "failed") === 1,
    );
    await snapshot("update-check-failed");
  }
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
    if ((await usageCount(`feature_${feature}`)) < 1)
      throw new Error(`No real entry for ${feature}.`);
  for (const action of ["playlist_added", "playlist_refreshed"] as const)
    if ((await usageCount(`action_${action}`)) < 1)
      throw new Error(`Missing source action ${action}.`);
  if (observeRollover) {
    const before = count("usage_window");
    const from = Date.now();
    const boundary = Math.floor(from / 300000) * 300000 + 300000;
    // Real wall time, with no clock injection. Ordinary settings input above supplied the fact.
    while (Date.now() < boundary) {
      abort.signal.throwIfAborted();
      await delay(Math.min(1000, boundary - Date.now()));
    }
    await waitFor(async () => count("usage_window") > before);
    observations.realUsageRollover = {
      from: new Date(from).toISOString(),
      boundary: new Date(boundary).toISOString(),
      through: new Date().toISOString(),
      before,
      after: count("usage_window"),
    };
  }
  // Graceful native quit seals the last fragment. Restart keeps identity and no active play.
  await quit();
  await launch();
  await settings();
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

/** Real app, local HTTP, owned profile. Seeded baseline is labelled, never an installed upgrade. */
async function lifecyclePaths() {
  await new Promise<void>((resolve) => capture.close(() => resolve()));
  await launch();
  await connectFixture();
  await waitFor(async () => {
    const state = await loadedAnalytics();
    return (
      state.pending.length === 2 &&
      state.lifecycle?.legacyRetries.every((item) => item.failures >= 4) === true &&
      state.lifecycle.legacyRetries.length === 2 &&
      state.lifecycle.pending[0]?.failures === 4
    );
  });
  await snapshot("lifecycle-offline");
  await quit();
  const before = await loadedAnalytics();
  const original = [
    ...before.pending.map((item) => item.event),
    ...before.lifecycle!.pending.map((item) => item.event),
  ];
  if (
    original.length !== 3 ||
    before.pending.some((item) => item.attempts !== 0) ||
    before.lifecycle!.pending.some((item) => item.attempts !== 0) ||
    payloads.length
  )
    throw new Error("Offline first/day/version work lost or spent transmission attempts.");
  await writeFile(join(evidence, "offline-before-restart.json"), JSON.stringify(before, null, 2));
  await launch();
  await settings();
  const after = await loadedAnalytics();
  if (
    !isDeepStrictEqual(after.pending, before.pending) ||
    !isDeepStrictEqual(after.lifecycle, before.lifecycle)
  )
    throw new Error("Offline restart changed retained lifecycle work or backoff.");
  await new Promise<void>((resolve) =>
    capture.listen(Number(new URL(endpoint).port), "127.0.0.1", resolve),
  );
  await waitFor(
    async () =>
      count("app_version_observed") === 1 &&
      count("app_active_day") === 1 &&
      count("installation_observed") === 1,
  );
  for (const event of original) {
    const delivered = sent().find((item) => item.uuid === event.uuid);
    if (!isDeepStrictEqual(delivered, event)) throw new Error("Recovered lifecycle event changed.");
  }
  await snapshot("lifecycle-recovered");
  await click(checkbox);
  await waitFor(async () => (await preference()).analyticsEnabled === false);
  await quit();
  const disabled = await loadedAnalytics();
  if (disabled.lifecycle || disabled.summaries || disabled.pending.length)
    throw new Error("Opt-out retained work.");
  const offCount = payloads.length;
  await launch();
  await settings();
  await delay(1200);
  if ((await preference()).analyticsEnabled || payloads.length !== offCount)
    throw new Error("Disabled restart captured.");
  await snapshot("lifecycle-off");
  await click(checkbox);
  await waitFor(async () => count("app_version_observed") === 2);
  const reenabled = sent()
    .filter((event) => event.event === "app_version_observed")
    .at(-1)!;
  if (
    reenabled.properties.observation_kind !== "unknown_history" ||
    "previous_app_version" in reenabled.properties ||
    count("installation_observed") !== 1 ||
    count("app_active_day") !== 1
  )
    throw new Error("Re-enable invented prior history or repeated activity.");
  await snapshot("lifecycle-reenabled");
  await quit();
  const retained = await loadedAnalytics();
  retained.lifecycle!.baseline = { app_version: "0.0.17", build_channel: "stable" };
  await writeFile(join(profile, "analytics.json"), JSON.stringify(retained));
  await launch();
  await settings();
  await waitFor(async () => count("app_version_observed") === 3);
  const transition = sent()
    .filter((event) => event.event === "app_version_observed")
    .at(-1)!;
  if (
    transition.properties.observation_kind !== "transition" ||
    transition.properties.previous_app_version !== "0.0.17" ||
    count("app_active_day") !== 1 ||
    transition.distinct_id !== before.installationId
  )
    throw new Error("Seeded same-day transition lost identity or repeated activity.");
  await snapshot("lifecycle-seeded-transition");
  observations.lifecycle = {
    offlineFailuresPerEvent: 4,
    original,
    before,
    after,
    reenabled,
    transition,
    unchangedEvents: true,
    sameIdentity: true,
    disabledRestartSilent: true,
    seededBaseline:
      "0.0.17 stable, written only after the owned app exited; not an installed upgrade",
  };
}

async function loadedAnalytics(): Promise<AnalyticsRecord> {
  const state = AnalyticsRecord()(await analyticsFile());
  if (state instanceof type.errors) throw new Error("Invalid owned analytics record.");
  return state;
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
  if (options.lifecycle) {
    await lifecyclePaths();
  } else if (options.native) {
    await runNativeTelemetry({
      options,
      evidence,
      abort: abort.signal,
      candidate,
      page: () => live(),
      main: () => {
        if (!mainPage) throw new Error("No owned main");
        return mainPage;
      },
      profile: () => profile,
      fresh: async () => {
        await quit();
        profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-"));
        profiles.push(profile);
      },
      launch: async (selected = candidate, local = true) => {
        target = selected;
        localTransport = local;
        await launch();
      },
      connect: connectFixture,
      settings,
      verifyAbout,
      click,
      namedButton,
      escape: keyEscape,
      snapshot,
      preference,
      quit,
      prepareExit,
      waitFor,
      read: async () => AnalyticsRecord().assert(await analyticsFile()),
      bodies: rawBodies,
      events: sent,
      capture: async (mode) => {
        holdSummary = mode === "hold" || mode === "hold-usage";
        holdUsageOnly = mode === "hold-usage";
        rejectCapture = mode === "reject";
        if (mode === "offline") {
          capture.closeAllConnections();
          await new Promise<void>((resolve) => capture.close(() => resolve()));
        } else if (!capture.listening) {
          await new Promise<void>((resolve) =>
            capture.listen(Number(new URL(endpoint).port), "127.0.0.1", resolve),
          );
        }
      },
      kill: async () => {
        if (!app || app.exitCode !== null || app.signalCode !== null)
          throw new Error("No live owned main to kill");
        const owned = app;
        if (preparedExit?.app !== owned) prepareExit("kill-fallback");
        const preparation = { ...preparedExit!.sample, usedAt: Date.now() };
        preparedExit = undefined;
        const pid = await mainPage!.evaluate<number>("process.pid");
        if (pid !== owned.pid) throw new Error("Wrong main kill target");
        mainPage?.close();
        mainPage = undefined;
        owned.kill("SIGKILL");
        await waitFor(async () => owned.exitCode !== null || owned.signalCode !== null, 4000);
        const killedAt = Date.now();
        if (process.platform !== "win32" && owned.pid) {
          try {
            process.kill(-owned.pid, "SIGKILL");
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        }
        await waitFor(async () => broadcasts.size === 0, 4000);
        if (nativeTree) {
          endTree.push(await nativeTree.stop(async () => {}));
          nativeTree = undefined;
        }
        exits.push({
          pid,
          code: owned.exitCode,
          signal: owned.signalCode,
          forced: true,
          kind: "intentional-main-kill",
          preparation,
          at: Date.now(),
        });
        page?.close();
        page = undefined;
        app = undefined;
        await waitFor(async () => broadcasts.size === 0, 4000);
        return killedAt;
      },
      observations,
    });
  } else {
    await launch();
    await connectFixture();
    if (packagedExecutable) {
      await keyEscape();
      await verifyAbout();
      await settings();
    }
    await waitFor(async () => (await preference()).analyticsEnabled === true);
    await waitFor(
      async () => count("installation_observed") === 1 && count("app_active_day") === 1,
    );
    if (
      (await live().evaluate<string>(
        `document.querySelector(${JSON.stringify(checkbox)}).getAttribute('aria-checked')`,
      )) !== "true"
    )
      throw new Error("Default control is not checked.");
    await snapshot("on");
    if (options.slowStartup) {
      await quit();
      await launch();
      await settings();
      // Inspect the cached control before any helper preferences.get can refresh it.
      await waitFor(() =>
        live().evaluate<boolean>(
          `document.querySelector(${JSON.stringify(checkbox)})?.getAttribute('aria-checked') === 'true'`,
        ),
      );
      const bootReads = await mainPage!.evaluate<{ startedMs: number; enabled: boolean | null }[]>(
        "globalThis.__analyticsStartupIO.preferenceReads",
      );
      if (bootReads.length !== 1 || bootReads[0]?.enabled !== false)
        throw new Error(
          "Slow-startup cache proof needs one disabled boot reply and no refresh reads.",
        );
      observations.startupConsentCache = { bootReads, checkedAfterRecovery: true };
      await snapshot("recovered-cached-consent");
    }
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
    if (volumeWorkload) await volumePaths();
    else if (!options.slowStartup) await productPaths();
    else observations.startupPrivacyOnly = true;
    let enabledCaptures = payloads.length;
    if (new Set(sent().map((event) => event.uuid)).size !== enabledCaptures)
      throw new Error("A capture was delivered twice.");
    await click(checkbox);
    await waitFor(async () => (await preference()).analyticsEnabled === false);
    await snapshot("off");
    actions.push({
      action: "Turned sharing off through the checkbox",
      at: new Date().toISOString(),
    });
    await quit();
    if (options.slowStartup) {
      // The retained opt-out is loaded only after both boot and the UI enable call time out.
      await launch(5000);
      await settings();
      await waitFor(() =>
        live().evaluate<boolean>(
          `document.querySelector(${JSON.stringify(checkbox)})?.getAttribute('aria-checked') === 'false' && !document.querySelector(${JSON.stringify(checkbox)})?.closest('fieldset')?.disabled`,
        ),
      );
      const readReplies = startupPreferences!;
      const beforeEnable = await readReplies();
      if (
        beforeEnable.preferenceReads.length !== 1 ||
        beforeEnable.preferenceReads[0]?.enabled !== false
      )
        throw new Error("Late enable needs one disabled boot reply.");
      await click(checkbox);
      await waitFor(
        async () => (await readReplies()).preferenceUpdates.some((reply) => reply.ok === false),
        4000,
      );
      const failed = (await readReplies()).preferenceUpdates[0];
      if (
        failed?.requested !== true ||
        failed.ok !== false ||
        failed.error !== "Analytics preference could not be saved." ||
        failed.endedMs === null ||
        failed.endedMs - failed.startedMs < 1500
      )
        throw new Error("Late enable did not retain its bounded public save failure.");
      const feedback = await live().evaluate<string | null>(
        "document.querySelector('[role=alert]')?.textContent ?? null",
      );
      observations.lateConsentCommit = {
        injectedReadDelayMs: 5000,
        beforeEnable,
        failed,
        feedback,
      };
      await snapshot("late-enable-timeout");
      await waitFor(
        () =>
          live().evaluate<boolean>(
            `document.querySelector(${JSON.stringify(checkbox)})?.getAttribute('aria-checked') === 'true' && !document.querySelector('[role=alert]')`,
          ),
        10_000,
      );
      const afterEnable = await readReplies();
      const read = (await startupSample!()).find((operation) => operation.operation === "read");
      if (
        afterEnable.preferenceReads.length !== 1 ||
        read?.endedMs === null ||
        read?.endedMs === undefined ||
        read.endedMs <= failed.endedMs
      )
        throw new Error(
          "Late enable cache proof was refreshed or did not outlast its failed update.",
        );
      await waitFor(async () => count("app_version_observed") === 2);
      observations.lateConsentCommit = {
        injectedReadDelayMs: 5000,
        beforeEnable,
        failed,
        feedback,
        afterEnable,
        read,
        checkedAfterCommit: true,
        feedbackAfterCommit: await live().evaluate<string | null>(
          "document.querySelector('[role=alert]')?.textContent ?? null",
        ),
        capturesAfterCommit: payloads.length,
      };
      await snapshot("late-enable-committed");
      await click(checkbox);
      await waitFor(async () =>
        (await readReplies()).preferenceUpdates.some(
          (reply) => reply.requested === false && reply.ok === true,
        ),
      );
      await waitFor(() =>
        live().evaluate<boolean>(
          `document.querySelector(${JSON.stringify(checkbox)})?.getAttribute('aria-checked') === 'false'`,
        ),
      );
      enabledCaptures = payloads.length;
      await snapshot("late-enable-restored-off");
      await quit();
    }
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
    const versionsBeforeReenable = count("app_version_observed");
    await click(checkbox);
    await waitFor(async () => (await preference()).analyticsEnabled === true);
    await snapshot("reenabled");
    await delay(1200);
    if (
      payloads.length !== enabledCaptures + 1 ||
      count("installation_observed") !== 1 ||
      count("app_active_day") !== 1 ||
      count("app_version_observed") !== versionsBeforeReenable + 1
    )
      throw new Error("Re-enable did not observe an unknown current version exactly once.");
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
      timestamp: new Date(Date.now() - 86_400_000).toISOString(),
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
    if (
      migrated["format"] !== 2 ||
      "summary" in migrated ||
      migrated["installationId"] !== legacyId
    )
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
  }
  observations["productionAnalyticsRequests"] = 0;
  observations["productionExclusionEvidence"] =
    "Transport accepts only this literal loopback endpoint; explicit isolated profile and automation also exclude configured production transport.";
} catch (error) {
  failure = error;
  await captureStartup();
  await restorePrefix();
  await capturePrefixFailure();
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
  if (appExited && !failure && cleanupErrors.length === 0)
    for (const owned of profiles) await clean(() => rm(owned, { recursive: true, force: true }));
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (cleanupErrors.length) failure ??= new Error(cleanupErrors.join("\n"));
  await writeFile(join(evidence, "payloads.json"), JSON.stringify(payloads, null, 2));
  await writeFile(join(evidence, "wire.json"), JSON.stringify(rawBodies, null, 2));
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
        verificationSource,
        bundleHashes,
        mode: options.native
          ? "native-telemetry"
          : packagedExecutable
            ? "packaged-executable"
            : "source-build",
        exits,
        verificationHashes,
        endTree,
        retainedProfiles: failure || cleanupErrors.length ? profiles : [],
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
        mainSha256: build.mainSha256,
        limitations: [
          "Local capture, no live PostHog project/dashboard/retention acceptance",
          options.native
            ? "Only recorded nativeCases ran; selecting a subset does not establish the complete native release matrix"
            : "Main-process crash and installed compatibility remain separate acceptance",
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
