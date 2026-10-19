// Installed-only media acceptance. Product pins are separate from this verifier's revision.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { createConnection } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { fixture, startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { connect, type Page } from "./app.ts";
import { closeNative } from "./analytics-exit.ts";
import { installedTelemetryPair } from "./analytics-installed-pair.ts";
import { installCatalogueWorkerProbe, type Evidence } from "./installed-catalogue-worker.ts";
import { browserFacts, probe } from "./installed-media-observer.ts";
import { ownedGroup, type OwnershipSample } from "./installed-media-posix.ts";
import { catalogueWorkerScripts, installedMainScript } from "./installed-worker-scripts.ts";
import { readReceipt } from "./installed-upgrade-packages.ts";
import { disposableRunner, ownedTree, type Runner } from "./installed-upgrade-windows.ts";
import { about, driver, type Driver } from "./installed-upgrade.ts";
import {
  bootstrapSubtitles,
  configureSubtitleUi,
  inspectorOwner,
  observeSavedSubtitle,
  pauseMain,
  resumeMain,
  seedSubtitleUi,
  startSubtitleFixture,
  subtitleRequests,
} from "./installed-subtitles.ts";

const repository = fileURLToPath(new URL("../../../../", import.meta.url));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hash = async (path: string) => digest(await readFile(path));
const json = (path: string, value: unknown) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n");
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();

type Outcome = "passed" | "failed" | "unresolved";
type Variant = "av1" | "startup-rejection" | "later-rejection" | "hevc-12bit" | "h264-10bit";
interface Pins {
  executable: string;
  asar: string;
  main: string;
  ffmpeg: string;
  ffprobe: string;
}
interface Target {
  platform: "win32" | "darwin" | "linux";
  executable: string;
  resources: string;
  version: string;
  source: string;
  pins: Pins;
}
function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: string[]) {
  assert.deepEqual(Object.keys(value).sort(), expected.toSorted(), "Unexpected target fields");
}
function string(value: unknown): string {
  assert(typeof value === "string", "Expected string");
  return value;
}
/** Explicit data only. Unknown fields, including launch commands, are refused before spawning. */
export function readTarget(input: unknown): Target {
  const data = object(input);
  keys(data, ["platform", "executable", "resources", "version", "source", "pins"]);
  const platform = data.platform;
  assert(platform === "win32" || platform === "darwin" || platform === "linux");
  assert.equal(platform, process.platform, "Target platform differs from this host");
  const executable = string(data.executable);
  const resources = string(data.resources);
  assert(isAbsolute(executable) && isAbsolute(resources), "Target paths must be absolute");
  const version = string(data.version);
  assert.match(version, /^0\.0\.16-nightly\.\d{8}\.\d+$/, "Expected a .16 nightly version");
  const source = string(data.source);
  assert.match(source, /^[a-f0-9]{40}$/, "Expected a full product source SHA");
  const pins = object(data.pins);
  keys(pins, ["executable", "asar", "main", "ffmpeg", "ffprobe"]);
  const pin = (key: keyof Pins) => {
    const value = string(pins[key]);
    assert.match(value, /^[a-f0-9]{64}$/, `Invalid ${key} pin`);
    return value;
  };
  return {
    platform,
    executable,
    resources,
    version,
    source,
    pins: {
      executable: pin("executable"),
      asar: pin("asar"),
      main: pin("main"),
      ffmpeg: pin("ffmpeg"),
      ffprobe: pin("ffprobe"),
    },
  };
}
const samePath = (left: string, right: string) =>
  process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
async function canonical(path: string) {
  const actual = await realpath(path);
  assert(samePath(resolve(path), actual), `Path is not canonical: ${path} -> ${actual}`);
  return actual;
}
/** Hash the actual installed entry, including main extracted from the pinned ASAR manifest. */
async function installedPins(executable: string, resources: string): Promise<Pins> {
  await canonical(executable);
  await canonical(resources);
  const asar = await hash(join(resources, "app.asar"));
  return {
    executable: await hash(executable),
    asar,
    main: (await installedMainScript(resources, asar)).sha256,
    ffmpeg: await hash(
      join(resources, "ffmpeg", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg"),
    ),
    ffprobe: await hash(
      join(resources, "ffmpeg", process.platform === "win32" ? "ffprobe.exe" : "ffprobe"),
    ),
  };
}
async function verifyPins(target: Target) {
  const actual = await installedPins(target.executable, target.resources);
  assert.deepEqual(actual, target.pins, "Installed product pins differ from target");
  return { at: Date.now(), pins: actual };
}

const av1 = {
  short: {
    file: "title-av1-10bit.mkv",
    bytes: 487478,
    sha256: "1245e3b640749ec65fbf24bc7fe05dd1241c46c32ce6e3b637363806104ed729",
  },
  long: {
    file: "title-long-av1-10bit.mkv",
    bytes: 66781,
    sha256: "49148b103318044f3ea78a51e5188346fc4f1448b00a18487a1e84b58e6192b5",
  },
};
function av1Bytes(which: keyof typeof av1) {
  const pin = av1[which];
  const bytes = fixture(pin.file);
  assert.equal(bytes.length, pin.bytes, `${pin.file} size changed`);
  assert.equal(digest(bytes), pin.sha256, `${pin.file} bytes changed`);
  return bytes;
}

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function closeServer(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
async function freePort() {
  const server = createServer();
  const origin = await listen(server);
  await closeServer(server);
  return Number(new URL(origin).port);
}
async function refused(origin: string) {
  return new Promise<{ origin: string; refused: true }>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(origin).port) });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Fixture port still answers: ${origin}`));
    });
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error(`Fixture port did not refuse: ${origin}`));
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === "ECONNREFUSED") resolve({ origin, refused: true });
      else reject(error);
    });
  });
}

interface MainIdentity {
  pid: number;
  executable: string;
  resources: string;
  argv: string[];
}
interface AppIdentity extends MainIdentity {
  version: string;
  appPath: string;
  packaged: boolean;
  mainSha256: string;
}

/** One installed start. Cleanup is available even when initial identity/bootstrap fails. */
function launch(
  target: Target,
  runner: Runner | undefined,
  profile: string,
  scratch: string,
  evidence: string,
  tmdbApi: string,
  subtitleOrigin: string,
  endpoint: string,
  update: string,
  port: number,
  inspect: number,
  record: Record<string, unknown>,
  spawned: () => void,
) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.toUpperCase().startsWith("MR_STREAMER_") &&
        !["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"].includes(key.toUpperCase()),
    ),
  );
  const args = [
    `--remote-debugging-port=${port}`,
    `--inspect-brk=127.0.0.1:${inspect}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--enable-automation",
    "--lang=en-US",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
  ];
  const startedAt = Date.now();
  const app = spawn(target.executable, args, {
    cwd: repository,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...environment,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
      LANGUAGE: "en_US",
      LANG: "en_US.UTF-8",
      MR_STREAMER_TMDB_API: tmdbApi,
      MR_STREAMER_TMDB_KEY: "test-key",
      MR_STREAMER_UPDATE_CHECKS: "off",
      MR_STREAMER_UPDATE_API: update,
      MR_STREAMER_UPDATE_FEED: `${update}/updates.json`,
      MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT: endpoint,
    },
  });
  const log: string[] = [];
  app.on("error", (error) => log.push(String(error)));
  for (const stream of [app.stdout, app.stderr])
    stream.on("data", (bytes: Buffer) => log.push(bytes.toString()));
  spawned();
  // Pin either platform owner synchronously, before yielding to inspector or UI work.
  let group: ReturnType<typeof ownedGroup> | undefined;
  const ownershipSamples: OwnershipSample[] = [];
  record["ownershipSamples"] = ownershipSamples;
  let tree: ReturnType<typeof ownedTree> | undefined;
  let ownerError: unknown;
  try {
    if (runner) tree = ownedTree(runner, app);
    else
      group = ownedGroup(app, target.executable, startedAt, (sample) =>
        ownershipSamples.push(sample),
      );
  } catch (error) {
    ownerError = error;
  }

  let main: Page | undefined;
  let page: Page | undefined;
  let d: Driver | undefined;
  let workers: ReturnType<typeof installCatalogueWorkerProbe> | undefined;
  let workerTask: ReturnType<ReturnType<typeof installCatalogueWorkerProbe>["start"]> | undefined;
  let workerStartup: Awaited<NonNullable<typeof workerTask>> | undefined;
  const workerEvents: Evidence[] = [];
  let boundaryInstalled = false;
  let stopped = false;
  Object.assign(record, { pid: app.pid, args, profile, scratch, startedAt });
  return {
    async ready() {
      if (ownerError) throw ownerError;
      assert(app.pid, "No spawned app PID");
      record["processOwner"] = tree?.root ?? group?.root;
      main = await connect(inspect, "node", { app });
      assert.equal(await inspectorOwner(inspect, [app.pid]), app.pid);
      const paused = await pauseMain(main);
      const identity = await paused.evaluate<MainIdentity>(
        "({pid:process.pid,executable:process.execPath,resources:process.resourcesPath,argv:process.argv})",
      );
      assert.equal(identity.pid, app.pid);
      assert(samePath(await canonical(identity.executable), target.executable));
      assert(samePath(await canonical(identity.resources), target.resources));
      assert(identity.argv.includes(`--user-data-dir=${profile}`));
      assert(identity.argv.includes(`--inspect-brk=127.0.0.1:${inspect}`));
      record["pausedIdentity"] = identity;
      record["pausedPins"] = await verifyPins(target);
      record["subtitleBootstrap"] = await bootstrapSubtitles(paused, subtitleOrigin);
      boundaryInstalled = true;
      const provenance = await catalogueWorkerScripts(identity.resources, target.pins.asar);
      record["workerProvenance"] = provenance;
      workers = installCatalogueWorkerProbe({
        main,
        expectedWorker: provenance.expectedWorker,
        startupScriptURLs: provenance.startupScriptURLs,
        verifiedMainPID: identity.pid,
        evidence: (event) => {
          workerEvents.push(event);
        },
      });
      const enabled = await workers.ready;
      assert(enabled.ok, JSON.stringify(enabled));
      workerTask = workers.start(120_000);
      await resumeMain(main);
      page = await connect(port, "page", { app });
      assert.equal(await inspectorOwner(port, [app.pid]), app.pid);
      const command = await page.send("Browser.getBrowserCommandLine");
      const commandArgs = (command.result as { arguments?: string[] } | undefined)?.arguments ?? [];
      assert(
        commandArgs.includes(`--user-data-dir=${profile}`) &&
          commandArgs.includes(`--remote-debugging-port=${port}`),
      );
      record["browserArguments"] = commandArgs;
      const base = driver(page, evidence, "candidate");
      d = {
        ...base,
        async capture(name) {
          await base.capture(name);
          await json(
            join(evidence, `${name}-ax.json`),
            await page!.send("Accessibility.getFullAXTree"),
          );
        },
      };
      await d.wait(() => d!.page.evaluate<boolean>("!!window.mrStreamer"));
      const renderer = await page.evaluate<string>("location.href");
      assert(
        samePath(
          fileURLToPath(renderer),
          join(target.resources, "app.asar", "out", "renderer", "index.html"),
        ),
        `Unexpected renderer: ${renderer}`,
      );
      const identityAfter = await main.evaluate<AppIdentity>(`(()=>{
        const {app}=process.getBuiltinModule('module').createRequire(process.execPath)('electron');
        const fs=process.getBuiltinModule('fs'),p=process.getBuiltinModule('path'),c=process.getBuiltinModule('crypto');
        return {pid:process.pid,executable:process.execPath,resources:process.resourcesPath,argv:process.argv,
          version:app.getVersion(),appPath:app.getAppPath(),packaged:app.isPackaged,
          mainSha256:c.createHash('sha256').update(fs.readFileSync(p.join(app.getAppPath(),'out/main/index.js'))).digest('hex')};})()`);
      assert.equal(identityAfter.pid, app.pid);
      assert.equal(identityAfter.packaged, true);
      assert.equal(identityAfter.version, target.version);
      assert(
        samePath(identityAfter.executable, target.executable) &&
          samePath(identityAfter.resources, target.resources),
      );
      assert(samePath(identityAfter.appPath, join(target.resources, "app.asar")));
      assert.equal(identityAfter.mainSha256, target.pins.main);
      const status = await d.read("updates.status");
      assert.equal(status.version, target.version);
      assert.equal(status.distribution, "direct");
      assert.equal((await d.read("language.get")).locale, "en-US");
      Object.assign(record, {
        identity: identityAfter,
        renderer,
        updateStatus: status,
        actions: d.actions,
        requests: d.requests,
      });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Network.enable");
      return d;
    },
    async verifyWorker() {
      assert(workerTask, "Worker startup was not armed");
      workerStartup = await workerTask;
      assert(workerStartup.ok, JSON.stringify(workerStartup));
      tree?.sample();
    },
    subtitleRequests() {
      assert(main && boundaryInstalled, "No verified SubDL boundary");
      return subtitleRequests(main);
    },
    async failure() {
      if (d) {
        await d.capture("failure");
        record["videoAtFailure"] = await media(d);
        const facts = await browserFacts(d.page);
        record["probeAtFailure"] = facts;
        return facts;
      }
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      const errors: unknown[] = [];
      const attempt = async <T>(work: () => Promise<T>) => {
        try {
          return await work();
        } catch (error) {
          errors.push(error);
          return undefined;
        }
      };
      // close wakes waitFor; joining first can wait for a Connect that never happened.
      const workerCleanup = await attempt(async () => workers?.close());
      await attempt(async () => {
        if (workerTask) workerStartup = await workerTask;
      });
      await attempt(() =>
        json(join(evidence, "worker-evidence.json"), {
          events: workerEvents,
          startup: workerStartup,
          cleanup: workerCleanup,
        }),
      );
      if (workers && (!workerStartup?.ok || workerCleanup?.errors.length))
        errors.push(new Error("Worker startup/cleanup failed"));
      if (main && boundaryInstalled)
        record["subtitleRequests"] = await attempt(() => subtitleRequests(main!));
      main?.close();
      record["groupBeforeClose"] = await attempt(async () => group?.sample());
      const alreadyExited = app.exitCode !== null || app.signalCode !== null;
      const requestClose = async () => {
        assert(page, "No verified page available for Browser.close");
        return page.send("Browser.close");
      };
      const closed = await attempt(async () => {
        if (tree) {
          const ended = await tree.stop(requestClose);
          const exit = { ...ended, code: app.exitCode, signal: app.signalCode, alreadyExited };
          record["exit"] = exit;
          assert(
            !alreadyExited &&
              ended.graceful &&
              ended.forced.length === 0 &&
              app.exitCode === 0 &&
              app.signalCode === null,
            JSON.stringify(exit),
          );
          return exit;
        }
        const exit = await closeNative(app, requestClose);
        record["exit"] = exit;
        assert(
          !exit.alreadyExited &&
            !exit.forced &&
            exit.code === 0 &&
            exit.signal === null &&
            exit.requestError === null,
          JSON.stringify(exit),
        );
        return exit;
      });
      record["exit"] = closed ?? record["exit"];
      page?.close();
      // A failed main close stays failed and gets only an immediate survivor audit.
      const drainStartedAt = Date.now();
      const drainStarted = performance.now();
      await attempt(async () => (closed ? group?.drain() : group?.sample()));
      if (group)
        record["groupDrain"] = {
          startedAt: drainStartedAt,
          wallMs: performance.now() - drainStarted,
          waited: closed !== undefined,
        };
      const survivors = group ? ownershipSamples.at(-1)?.group : undefined;
      record["groupAfterClose"] = survivors;
      if (!closed && survivors?.length)
        errors.push(new Error("Owned process group survivors; profile retained"));
      record["exitPins"] = await attempt(() => verifyPins(target));
      await attempt(() => writeFile(join(evidence, "electron.log"), log.join("")));
      record["cleanupErrors"] = errors.map((error) => String(error));
      if (errors.length) throw new AggregateError(errors, "Installed session cleanup failed");
    },
  };
}

const labelled = (label: string) =>
  `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
const button = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)})`;
const poster = (name: string) =>
  `[...document.querySelectorAll('button[title]')].find(b=>b.title.includes(${JSON.stringify(name)}))`;
async function openMovie(d: Driver, name: string) {
  await d.click("Movies", button("header button", "Movies"));
  await d.click("All movies", button("nav button", "All movies"));
  await d.click(`Movie ${name}`, poster(name));
}
async function leave(d: Driver) {
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.video()).title, 10_000, "leaving title");
}
interface MediaObservation {
  time: number;
  width: number;
  audio: number;
  frames: number;
  paused: boolean;
  title: boolean;
  sameNode: boolean;
  caption: string;
  readyState: number;
  seeking: boolean;
  stateShown: boolean;
  position: number | null;
  sequence: number;
  window: number;
  generation: number;
}
export function media(d: { page: Pick<Page, "evaluate"> }) {
  return d.page
    .evaluate<MediaObservation>(`(()=>{const v=document.querySelector('video'),p=window.__installedMediaProbe,position=document.querySelector('[data-view=title] input[type=range][aria-label=Position]')?.getAttribute('aria-valuenow');return {
    time:v?.currentTime??0,width:v?.videoWidth??0,audio:v?.webkitAudioDecodedByteCount??0,
    frames:v?.getVideoPlaybackQuality().totalVideoFrames??0,paused:v?.paused??true,
    title:!!document.querySelector('[data-view=title]'),sameNode:!!v&&window.__installedMediaProbe?.node===v,
    caption:document.querySelector('[data-subtitle-text]')?.textContent?.trim()??'',
    readyState:v?.readyState??0,seeking:v?.seeking??false,stateShown:!!document.querySelector('[data-view=title] h2'),
    position:position===null||position===undefined?null:Number(position),sequence:p?.sequence??0,window:p?.window??0,generation:p?.generation??0};})()`);
}
async function moving(d: Driver) {
  const until = Date.now() + 45_000;
  await d.wait(
    async () => {
      const v = await media(d);
      return (
        v.title &&
        !v.paused &&
        v.width > 0 &&
        v.frames > 1 &&
        v.time > 0.5 &&
        v.audio > 0 &&
        v.sameNode
      );
    },
    45_000,
    "decoded picture and audio",
  );
  const before = await media(d);
  await d.wait(
    async () => {
      const v = await media(d);
      return (
        !v.paused &&
        v.sameNode &&
        v.time > before.time + 0.25 &&
        v.frames > before.frames &&
        v.audio > before.audio
      );
    },
    Math.max(1, until - Date.now()),
    "advancing decoded frames/audio/time",
  );
  const progress = { before, after: await media(d) };
  await d.page.evaluate(`window.__installedMediaProbe.progress=${JSON.stringify(progress)}`);
}

async function download(d: Driver, name: string) {
  await openMovie(d, name);
  await d.click(`Download ${name}`, button("[role=dialog] button", "Download"));
  await d.wait(
    () => d.exists(button("[role=dialog] button", "Watch offline")),
    90_000,
    `completed ${name}`,
  );
  await d.key("Escape", 27);
}
async function settledPointer(
  d: Driver,
  label: string,
  expression: string,
  record: Record<string, unknown>,
) {
  await d.wait(() => d.exists(expression), 10_000, `${label} exists`);
  const point = await d.page.evaluate<{ x: number; y: number }>(
    `(()=>{const e=(${expression});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`,
  );
  await d.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await d.page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const checked = await d.page.evaluate<{
    x: number;
    y: number;
    hit: boolean;
    tag?: string;
    expanded: string | null;
  } | null>(
    `(()=>{const e=(${expression});if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);return {x,y,hit:hit===e||e.contains(hit),tag:hit?.tagName,expanded:e.getAttribute('aria-expanded')}})()`,
  );
  record["pointer"] = { at: Date.now(), label, expression, before: point, after: checked };
  assert(checked?.hit, "Row target not under pointer");
  for (const type of ["mousePressed", "mouseReleased"])
    await d.page.send("Input.dispatchMouseEvent", {
      type,
      x: checked.x,
      y: checked.y,
      button: "left",
      clickCount: 1,
    });
}
async function remove(d: Driver, record: Record<string, unknown>) {
  await d.click("Settings", labelled("Settings"));
  await d.click("Subscriptions", button("nav button", "Subscriptions"));
  const row = `[...document.querySelectorAll('li')].find(r=>r.querySelector('button')?.textContent.includes(' · '))`;
  const rowButton = `(${row})?.querySelector('button[aria-expanded]')`;
  await d.wait(() => d.exists(rowButton), 10_000, "subscription header");
  const expanded = await d.page.evaluate<string>(`(${rowButton}).getAttribute('aria-expanded')`);
  record["rowState"] = { at: Date.now(), expanded };
  assert(expanded === "true" || expanded === "false");
  if (expanded === "false")
    await settledPointer(d, "Open collapsed subscription", rowButton, record);
  await d.wait(
    () => d.exists(`(${row})?.querySelector('[role=region]')`),
    10_000,
    "subscription row",
  );
  await d.click(
    "Ask removal",
    `[...(${row})?.querySelectorAll('button')??[]].find(b=>b.textContent.trim().startsWith('Remove '))`,
  );
  await d.wait(
    () => d.page.evaluate<boolean>("document.body.innerText.includes('from this device?')"),
    10_000,
    "removal confirmation",
  );
  await d.click(
    "Remove",
    `[...(${row})?.querySelectorAll('button')??[]].find(b=>b.textContent.trim()==='Remove')`,
  );
  await d.wait(() => d.exists('document.querySelector("form input")'), 30_000, "Connect");
  assert.equal((await d.read("subscription.list")).length, 0);
}

type Seen = Awaited<ReturnType<typeof probe>>;
type WindowStart = Awaited<ReturnType<Seen["beginWindow"]>>;
async function anchor(d: Driver) {
  await d.wait(
    () => d.page.evaluate<boolean>("!!document.querySelector('[data-view=title] video')"),
    10_000,
    "window video element",
  );
  await d.page.evaluate("window.__installedMediaProbe.node=document.querySelector('video')");
}
async function windowFacts(d: Driver, seen: Seen, window: WindowStart) {
  return {
    ...(await seen.windowFacts(window)),
    decoded: await media(d),
    progress: await d.page.evaluate<{ before: MediaObservation; after: MediaObservation }>(
      "window.__installedMediaProbe.progress",
    ),
  };
}
function requireVideoConversion(facts: Awaited<ReturnType<typeof windowFacts>>) {
  assert(
    facts.deliveries.some((item) => item.status === 200 && item.video === "convert"),
    `${facts.name}: no actual x-title-video: convert`,
  );
  assert(facts.decoded.sameNode, `${facts.name}: media element changed`);
}
class Unresolved extends Error {}

/** A track reload must deliver and decode anew before DOM clocks or old width can be evidence. */
async function settledAfter(
  d: Driver,
  before: MediaObservation,
  record: Record<string, unknown>,
  timeout: number,
  label: string,
) {
  record["before"] = before;
  let decoded: MediaObservation | undefined;
  await d.wait(
    async () => {
      const v = await media(d);
      const facts = await browserFacts(d.page);
      const buffer = facts.buffers.find((item) => item.generation === v.generation);
      const delivery = facts.deliveries.find((item) => item.requestId === buffer?.requestId);
      record["latest"] = { decoded: v, buffer, delivery };
      if (
        !delivery ||
        delivery.requestSequence <= before.sequence ||
        delivery.status !== 200 ||
        delivery.window !== before.window ||
        delivery.responseWindow !== before.window ||
        !buffer ||
        buffer.sequence <= delivery.sequence ||
        buffer.generation <= before.generation ||
        !v.title ||
        !v.sameNode ||
        v.readyState < 2 ||
        v.seeking ||
        v.stateShown ||
        v.width <= 0 ||
        v.frames <= 0 ||
        v.position === null ||
        Math.abs(v.time - v.position) >= 0.2 ||
        v.paused !== before.paused
      )
        return false;
      if (before.paused) return Math.abs(v.time - before.time) < 0.2;
      if (!decoded || decoded.generation !== v.generation) {
        decoded = v;
        return false;
      }
      return v.time > decoded.time + 0.25 && v.frames > decoded.frames && v.audio > decoded.audio;
    },
    timeout,
    label,
  );
  record["after"] = await media(d);
}

async function pauseSeekResume(
  d: Driver,
  otherSound: boolean,
  record: Record<string, unknown>,
  whilePaused?: () => Promise<void>,
) {
  const before = await media(d);
  await d.key(" ", 32);
  await d.wait(async () => (await media(d)).paused, 10_000, "paused");
  const held = await media(d);
  await delay(300);
  const still = await media(d);
  assert(
    still.paused && Math.abs(still.time - held.time) < 0.15 && still.sameNode,
    "Pause was not retained",
  );
  record["pause"] = { before, held, still };
  await d.key("ArrowRight", 39);
  await d.wait(
    async () => {
      const v = await media(d);
      return (
        v.paused &&
        Math.abs(v.time - (held.time + 10)) < 2 &&
        v.width > 0 &&
        v.readyState >= 2 &&
        !v.seeking &&
        !v.stateShown &&
        v.sameNode
      );
    },
    15_000,
    "paused ten-second seek",
  );
  const sought = await media(d);
  record["pausedSeek"] = sought;
  await d.capture("paused-seek");
  await whilePaused?.();
  if (otherSound) {
    await d.click("Sound", labelled("Sound"));
    record["soundChoices"] = await d.page.evaluate<string[]>(
      "[...document.querySelectorAll('[role=dialog] button[aria-pressed], [role=dialog] [role=menuitemradio]')].map(e=>e.textContent.trim())",
    );
    const other =
      "[...document.querySelectorAll('[role=dialog] button[aria-pressed=false], [role=dialog] [role=menuitemradio][aria-checked=false]')][0]";
    const picked = await d.page.evaluate<string>(`(${other}).textContent.trim()`);
    const soundBefore = await media(d);
    const transition: Record<string, unknown> = {};
    record["soundTransition"] = transition;
    await d.click("Other sound while paused", other);
    await d.wait(
      async () => !(await d.exists("document.querySelector('[role=dialog]')")),
      10_000,
      "sound menu closed",
    );
    await settledAfter(
      d,
      soundBefore,
      transition,
      45_000,
      "paused other sound decoded after reload",
    );
    record["pausedOtherSound"] = await media(d);
    await d.click("Read selected sound", labelled("Sound"));
    const selected = await d.page.evaluate<string>(
      "document.querySelector('[role=dialog] button[aria-pressed=true], [role=dialog] [role=menuitemradio][aria-checked=true]')?.textContent.trim()??''",
    );
    record["selectedOtherSound"] = { picked, selected };
    assert.equal(selected, picked);
    await d.capture("paused-other-sound");
    await d.click("Close Sound", labelled("Sound"));
    await d.wait(
      async () => !(await d.exists("document.querySelector('[role=dialog]')")),
      10_000,
      "selected sound menu closed",
    );
  }
  const resumeFrom = await media(d);
  assert(resumeFrom.sameNode);
  await d.key(" ", 32);
  await d.wait(
    async () => {
      const v = await media(d);
      return (
        !v.paused &&
        v.time > resumeFrom.time + 0.25 &&
        v.frames > resumeFrom.frames &&
        v.audio > resumeFrom.audio &&
        v.sameNode
      );
    },
    30_000,
    "resumed decoded frames/audio/time",
  );
  record["resumed"] = await media(d);
}

async function laterRejections(d: Driver, record: Record<string, unknown>) {
  const position = (await media(d)).time;
  const steps: Record<string, unknown>[] = [];
  record["actualLaterRejections"] = steps;
  let priorGeneration = 0;
  let recoverySequence = 0;
  let recoveryRequestId: number | null = null;
  for (const phase of ["audio", "video"] as const) {
    await d.wait(
      () =>
        d.page.evaluate<boolean>(
          `(()=>{const p=window.__installedMediaProbe,b=p.buffers.at(-1);return !!p.buffer&&!p.buffer.updating&&p.generation>${priorGeneration}&&b.sequence>${recoverySequence}&&b.window===p.window&&(${recoveryRequestId}===null||b.requestId===${recoveryRequestId});})()`,
        ),
      10_000,
      "new idle real SourceBuffer after recovery",
    );
    const before = await browserFacts(d.page);
    priorGeneration = before.generation;
    const window = before.window;
    const step: Record<string, unknown> = {
      phase,
      before,
      window,
      generation: priorGeneration,
    };
    steps.push(step);
    const injection = await d.page.evaluate<{ sequence: number }>(
      `(()=>{const p=window.__installedMediaProbe,b=p.buffers.at(-1);
        const injection={...p.stamp(),requestId:b.requestId,deliverySequence:b.deliverySequence,generation:p.generation};
        p.injections.push(injection);p.buffer.appendBuffer(new Uint8Array([0,0,0,4,109,111,111,102]));return injection;})()`,
    );
    step["injection"] = injection;
    await d.wait(
      async () =>
        (await browserFacts(d.page)).errors
          .slice(before.errors.length)
          .some(
            (error) =>
              error.code === 3 &&
              error.generation === priorGeneration &&
              error.window === window &&
              error.sequence > injection.sequence,
          ),
      30_000,
      "new actual browser code3 parser error",
    );
    const error = (await browserFacts(d.page)).errors
      .slice(before.errors.length)
      .find(
        (error) =>
          error.code === 3 &&
          error.generation === priorGeneration &&
          error.window === window &&
          error.sequence > injection.sequence,
      )!;
    step["error"] = error;
    await d.wait(
      async () =>
        (await browserFacts(d.page)).deliveries.some(
          (delivery) =>
            delivery.window === window &&
            delivery.responseWindow === window &&
            delivery.requestSequence > error.sequence,
        ),
      30_000,
      "response following actual parser error",
    );
    const next = (await browserFacts(d.page)).deliveries.find(
      (delivery) =>
        delivery.window === window &&
        delivery.responseWindow === window &&
        delivery.requestSequence > error.sequence,
    )!;
    step["followingDelivery"] = next;
    assert.equal(next.status, 200);
    assert.equal(next.video, phase === "audio" ? "copy" : "convert");
    if (phase === "audio") assert.equal(next.audio, "convert");
    assert.equal(
      new URL(next.url).searchParams.get(phase === "audio" ? "sound" : "picture"),
      "convert",
    );
    recoverySequence = next.sequence;
    recoveryRequestId = next.requestId;
    await d.wait(
      async () => {
        const v = await media(d);
        const buffer = (await browserFacts(d.page)).buffers.find(
          (item) => item.generation === v.generation,
        );
        step["recoveryBuffer"] = buffer;
        return (
          !!buffer &&
          buffer.sequence > next.sequence &&
          buffer.requestId === next.requestId &&
          v.paused &&
          Math.abs(v.time - position) < 0.2 &&
          v.width > 0 &&
          v.frames > 1 &&
          v.sameNode &&
          v.readyState >= 2 &&
          !v.seeking &&
          !v.stateShown
        );
      },
      30_000,
      "position, element and pause retained",
    );
    step["recoveredPaused"] = await media(d);
    await d.capture(`later-${phase}-recovered-paused`);
  }
}

async function embeddedFrench(
  d: Driver,
  record: Record<string, unknown>,
  save: () => Promise<void>,
) {
  const transition: Record<string, unknown> = {};
  const attempts: Record<string, unknown>[] = [];
  record["embeddedFrenchTransition"] = transition;
  record["embeddedFrenchSeeks"] = attempts;
  await d.click("Open Subtitles", labelled("Subtitles"));
  const before = await media(d);
  transition["before"] = before;
  await save();
  try {
    await d.click(
      "Choose embedded French",
      `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button[aria-pressed]')].find(b=>b.textContent.trim()==='Français')`,
    );
    await d.click("Close Subtitles", labelled("Close subtitles"));
    transition["afterSelection"] = await media(d);
    await settledAfter(d, before, transition, 15_000, "French selection decoded after reload");
  } finally {
    transition["after"] = await media(d);
    transition["browser"] = await browserFacts(d.page);
    await save();
  }
  // Stop below the two-second cue at 60, then play into it within the existing cue wait.
  for (let attempt = 0; (await media(d)).time < 48 && attempt < 7; attempt++) {
    const before = await media(d);
    const observation: Record<string, unknown> = {
      before,
      key: { name: "ArrowRight", code: 39, nodeRequestedAt: Date.now() },
    };
    attempts.push(observation);
    await save();
    try {
      await d.key("ArrowRight", 39);
      await d.wait(
        async () => {
          const v = await media(d);
          observation["latest"] = v;
          return (
            !v.paused &&
            v.width > 0 &&
            Math.abs(v.time - (before.time + 10)) < 2 &&
            v.readyState >= 2 &&
            !v.seeking &&
            !v.stateShown &&
            v.sameNode &&
            v.position !== null &&
            Math.abs(v.position - v.time) < 0.2
          );
        },
        15_000,
        "French cue seek",
      );
    } finally {
      observation["after"] = await media(d);
      observation["browser"] = await browserFacts(d.page);
      await save();
    }
  }
  await d.wait(
    async () => (await media(d)).caption === "Soixante",
    15_000,
    "visible embedded French cue",
  );
  const shown = await media(d);
  assert(shown.sameNode);
  await d.capture("offline-long-embedded-french");
  return shown;
}

interface CaseProof {
  variant: Variant;
  outcome: Outcome | "running";
  profile: string;
  startedAt: number;
  facts: Record<string, unknown>;
  session: Record<string, unknown>;
  cleanupErrors: string[];
  error?: string;
  endedAt?: number;
  profileRemoved?: boolean;
}

async function runCase(
  target: Target,
  runner: Runner | undefined,
  variant: Variant,
  root: string,
  endpoint: string,
  update: string,
  proof: CaseProof,
  save: () => Promise<void>,
  spawned: () => void,
) {
  const evidence = join(root, "evidence", variant);
  await mkdir(evidence);
  await mkdir(proof.profile);
  const scratch = join(proof.profile, "tmp");
  await mkdir(scratch);
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
  let subtitles: Awaited<ReturnType<typeof startSubtitleFixture>> | undefined;
  let session: ReturnType<typeof launch> | undefined;
  let laterCopyDecoded = false;
  let stopped = false;
  const stopFixtures = async () => {
    if (!stopped) {
      const outcomes = await Promise.allSettled([
        provider?.close(),
        tmdb?.close(),
        subtitles?.stop(),
      ]);
      const failures = outcomes.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed");
      stopped = true;
    }
    return Promise.all(
      [provider?.url, tmdb?.url, subtitles?.origin]
        .filter((origin): origin is string => !!origin)
        .map(refused),
    );
  };
  try {
    // Every local boundary is listening before the very first installed spawn.
    provider = await startFakeProvider({ channels: 20, titles: 10 });
    tmdb = await startFakeTmdb();
    subtitles = await startSubtitleFixture();
    const short = provider.titles.movies.find((movie) =>
      movie.name.startsWith("TEST | Two sound tracks"),
    );
    const long = provider.titles.movies.find((movie) =>
      movie.name.startsWith("TEST | Long subtitles"),
    );
    assert(short && long);
    const original =
      variant === "av1"
        ? av1Bytes("short")
        : fixture(variant === "hevc-12bit" ? "title-hevc-12bit.mkv" : "title-h264-10bit.mkv");
    const clip = Buffer.from(original);
    proof.facts["fixture"] = { originalSha256: digest(original), bytes: clip.length };
    if (variant === "av1") {
      const longBytes = av1Bytes("long");
      provider.replaceMovieFile(long.id, longBytes);
      proof.facts["av1Fixtures"] = av1;
    }
    if (variant === "startup-rejection") {
      const offset = clip.indexOf(Buffer.from([1, 110, 0, 10, 255, 225]));
      assert(offset >= 0, "Expected original valid High10 AVC configuration");
      clip[offset + 1] = 255;
      proof.facts["invalidAvcConfiguration"] = {
        offset: offset + 1,
        originalSha256: digest(original),
        mutatedSha256: digest(clip),
        original: 110,
        mutated: 255,
      };
    }
    provider.replaceMovieFile(short.id, clip);
    proof.facts["servedFixtureSha256"] = digest(clip);
    proof.session["beforeSpawnPins"] = await verifyPins(target);
    await save();
    const port = await freePort();
    let inspect = await freePort();
    while (inspect === port) inspect = await freePort();
    session = launch(
      target,
      runner,
      proof.profile,
      scratch,
      evidence,
      tmdb.url,
      subtitles.origin,
      endpoint,
      update,
      port,
      inspect,
      proof.session,
      spawned,
    );
    const d = await session.ready();
    const seen = await probe(d.page);
    proof.facts["media"] = seen;
    await d.wait(() => d.exists('document.querySelector("form input")'), 30_000, "Connect");
    for (const [index, value] of [provider.url, "demo", "demo"].entries()) {
      await d.click(`Connect field ${index}`, `document.querySelectorAll('form input')[${index}]`);
      await d.type("Type fake login", value);
    }
    await d.click("Connect", "document.querySelector('form button[type=submit]')");
    await d.wait(() => d.exists('document.querySelector("header")'), 60_000, "Home");
    await session.verifyWorker();
    const shown = await about(d);
    proof.facts["about"] = shown;
    assert.equal(shown.source, target.source);
    assert(shown.text.includes(target.version), "About version differs");
    await save();
    const windows: Awaited<ReturnType<typeof windowFacts>>[] = [];
    proof.facts["windows"] = windows;
    if (variant === "av1") {
      await d.click("Settings", labelled("Settings"));
      await configureSubtitleUi(d);
      await d.key("Escape", 27);
      await openMovie(d, "Long subtitles");
      const window = await seen.beginWindow("provider-long");
      await d.click("Play long AV1", button("[role=dialog] button", "Play"));
      await anchor(d);
      await moving(d);
      proof.facts["savedProviderSubtitle"] = await seedSubtitleUi(d);
      const facts = await windowFacts(d, seen, window);
      windows.push(facts);
      requireVideoConversion(facts);
      await save();
      await leave(d);
      await d.key("Escape", 27);
      await download(d, "Long subtitles");
    }
    await download(d, "Two sound tracks");
    await openMovie(d, "Two sound tracks");
    const online = await seen.beginWindow("provider-short");
    await d.click("Play provider file", button("[role=dialog] button", "Play"));
    await anchor(d);
    await moving(d);
    proof.facts["onlineDecoded"] = await media(d);
    const initial = await windowFacts(d, seen, online);
    proof.facts["initialDelivery"] = initial;
    if (variant === "later-rejection") {
      const active = initial.deliveries.at(-1);
      if (
        active?.video === "convert" ||
        initial.deliveries.some((delivery) => delivery.video === "convert")
      )
        throw new Unresolved(
          "Later rejection unavailable: video converted before copied decoded start",
        );
      if (
        active?.audio === "convert" ||
        initial.errors.length ||
        initial.checks.some((check) => !check.supported)
      )
        throw new Unresolved(
          "Later rejection unavailable: initial copy required recovery before decoded start",
        );
      assert.equal(initial.deliveries[0]?.video, "copy");
      assert.equal(initial.deliveries[0]?.audio, "copy");
      assert.equal(active?.video, "copy");
      assert.equal(active?.audio, "copy");
      laterCopyDecoded = true;
    }
    const controls: Record<string, unknown> = {};
    proof.facts["providerControls"] = controls;
    await pauseSeekResume(
      d,
      true,
      controls,
      variant === "later-rejection" ? () => laterRejections(d, proof.facts) : undefined,
    );
    const onlineFacts = await windowFacts(d, seen, online);
    windows.push(onlineFacts);
    if (variant === "av1") requireVideoConversion(onlineFacts);
    if (variant === "hevc-12bit" || variant === "h264-10bit") {
      const first = onlineFacts.deliveries[0];
      assert(first && (first.video === "copy" || first.video === "convert"));
      const rejection = [
        ...onlineFacts.checks.filter((check) => !check.supported),
        ...onlineFacts.errors.filter((error) => error.code === 3),
      ]
        .sort((a, b) => a.sequence - b.sequence)
        .find((item) =>
          onlineFacts.deliveries.some(
            (delivery) =>
              delivery.video === "copy" &&
              delivery.sequence < item.sequence &&
              delivery.requestId === item.requestId,
          ),
        );
      const converted = onlineFacts.deliveries.find((delivery) => delivery.video === "convert");
      if (first.video === "copy" && converted)
        assert(
          rejection !== undefined && converted.requestSequence > rejection.sequence,
          "Depth copy changed delivery without observed browser rejection",
        );
      proof.facts["depthBehavior"] = {
        initialVideo: first.video,
        copiedRejection:
          first.video === "copy" && converted && rejection !== undefined
            ? "observed"
            : "unobserved",
        provenNative: first.video === "copy" && !converted && rejection === undefined,
        decodedWithControls: onlineFacts.decoded,
      };
    }
    await save();
    await leave(d);
    await d.key("Escape", 27);
    const copies = (await d.read("downloads.list")).items;
    proof.facts["completedCopies"] = copies;
    assert.equal(copies.length, variant === "av1" ? 2 : 1);
    assert(copies.every((copy) => copy.status.kind === "complete"));
    await remove(d, proof.facts);
    const cutoff = {
      at: Date.now(),
      rendererRequestsFrom: d.requests.length,
      providerServedReads: provider.fileRequests(),
      subtitleAttempts: (await session.subtitleRequests()).length,
    };
    proof.facts["offlineCutoff"] = cutoff;
    proof.facts["fixturePortsRefused"] = await stopFixtures();
    proof.facts["fixturesStoppedAt"] = Date.now();
    await save();
    await d.click("Downloads from Connect", button("button", "Downloads"));
    const standalone = (await d.read("downloads.list")).items;
    proof.facts["standaloneCopies"] = standalone;
    assert.deepEqual(
      standalone.map((copy) => copy.id).sort(),
      copies.map((copy) => copy.id).sort(),
    );
    assert(
      standalone.every((copy) => copy.status.kind === "complete" && copy.subscription === null),
    );
    await d.capture("copies-without-subscription");
    const shortCopy = standalone.find(
      (copy) => copy.title.kind === "movie" && copy.title.id === String(short.id),
    );
    assert(shortCopy);
    const offline = await seen.beginWindow("offline-short");
    await d.click(
      "Watch short owned copy",
      `document.querySelector('[data-download="${shortCopy.id}"] button')`,
    );
    await anchor(d);
    await moving(d);
    const offlineFacts = await windowFacts(d, seen, offline);
    windows.push(offlineFacts);
    await d.capture("offline-short-decoded");
    if (variant === "av1") requireVideoConversion(offlineFacts);
    if (variant === "startup-rejection") {
      const copy = offlineFacts.deliveries[0];
      if (!copy || copy.video !== "copy")
        throw new Unresolved(
          "Startup copied rejection unavailable: no initial video-copy delivery",
        );
      const rejected = offlineFacts.checks.find(
        (check) =>
          !check.supported &&
          /avc1\.ff/i.test(check.type) &&
          check.sequence > copy.sequence &&
          check.requestId === copy.requestId,
      );
      if (!rejected)
        throw new Unresolved(
          "Startup copied rejection unavailable: browser accepted invalid AVC or no actual refusal observed",
        );
      const converted = offlineFacts.deliveries.find(
        (delivery) =>
          delivery.requestSequence > rejected.sequence &&
          delivery.video === "convert" &&
          new URL(delivery.url).searchParams.get("picture") === "convert",
      );
      assert(converted, "No actual picture=convert/video-convert delivery after avc1.ff refusal");
      proof.facts["startupSequence"] = {
        copy,
        rejected,
        converted,
        decodedAt: Date.now(),
        decoded: offlineFacts.decoded,
      };
    }
    await save();
    await leave(d);
    if (variant === "av1") {
      const longCopy = standalone.find(
        (copy) => copy.title.kind === "movie" && copy.title.id === String(long.id),
      );
      assert(longCopy);
      const window = await seen.beginWindow("offline-long-first-open");
      await d.click(
        "Watch long owned copy",
        `document.querySelector('[data-download="${longCopy.id}"] button')`,
      );
      await anchor(d);
      await moving(d);
      const longControls: Record<string, unknown> = {};
      proof.facts["offlineLongControls"] = longControls;
      await pauseSeekResume(d, false, longControls);
      proof.facts["embeddedFrench"] = await embeddedFrench(d, proof.facts, save);
      proof.facts["savedOfflineSubtitle"] = await observeSavedSubtitle(d, "copy");
      const longFacts = await windowFacts(d, seen, window);
      windows.push(longFacts);
      requireVideoConversion(longFacts);
      const left = (await media(d)).time;
      await leave(d);
      const progress = async () =>
        (await d.read("downloads.list")).items.find((copy) => copy.id === longCopy.id)?.progress;
      const row = `document.querySelector('[data-download="${longCopy.id}"]')`;
      await d.wait(
        async () => {
          const kept = await progress();
          if (!kept || Math.abs(kept.position - left) >= 2) return false;
          const shown = await d.page.evaluate<string | null>(
            `(${row})?.querySelector('span > span[style*="width"]')?.style.width??null`,
          );
          return shown === `${Math.round((100 * kept.position) / kept.duration)}%`;
        },
        15_000,
        "saved copy local progress kept and shown",
      );
      const kept = await progress();
      assert(kept);
      const percentage = await d.page.evaluate<string | null>(
        `(${row})?.querySelector('span > span[style*="width"]')?.style.width??null`,
      );
      assert(percentage && Number.isFinite(parseFloat(percentage)), "No row progress percentage");
      assert(
        Math.abs(parseFloat(percentage) - (100 * kept.position) / kept.duration) < 2,
        "Row progress differs from saved copy",
      );
      const resume = await seen.beginWindow("offline-long-resume");
      await d.click("Resume long owned copy", `(${row})?.querySelector('button')`);
      await anchor(d);
      await moving(d);
      const resumed = (await media(d)).time;
      assert(
        Math.abs(resumed - Math.max(0, kept.position - 5)) < 3,
        "Copy resume differs from strict five-second rewind",
      );
      proof.facts["offlineSavedResume"] = { left, kept, percentage, resumed };
      const resumedFacts = await windowFacts(d, seen, resume);
      windows.push(resumedFacts);
      requireVideoConversion(resumedFacts);
      await d.capture("offline-long-saved-resume");
      await leave(d);
    }
    proof.facts["providerServedReadsAfterCutoff"] =
      provider.fileRequests() - cutoff.providerServedReads;
    assert.equal(proof.facts["providerServedReadsAfterCutoff"], 0);
    proof.facts["rendererRequestAttemptsAfterCutoff"] = d.requests
      .slice(cutoff.rendererRequestsFrom)
      .filter((request) =>
        [provider!.url, tmdb!.url, subtitles!.origin].some(
          (origin) => new URL(request.url, "file:///").origin === new URL(origin).origin,
        ),
      );
    const attempts = (await session.subtitleRequests()).slice(cutoff.subtitleAttempts);
    proof.facts["subtitleAttemptsAfterCutoff"] = attempts;
    assert.equal(attempts.length, 0, "Saved subtitle attempted a new service request after cutoff");
    proof.facts["finalBrowserFacts"] = await browserFacts(d.page);
    proof.outcome = "passed";
  } catch (error) {
    proof.outcome = error instanceof Unresolved ? "unresolved" : "failed";
    proof.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
    const facts = await session?.failure().catch((error) => {
      proof.facts["failureCaptureError"] = String(error);
    });
    const initiallyConverted =
      variant === "later-rejection"
        ? !laterCopyDecoded && !!facts?.deliveries.some((delivery) => delivery.video === "convert")
        : facts?.deliveries[0]?.video === "convert";
    const acceptedInvalidAvc = facts?.checks.some(
      (check) => check.supported && /avc1\.ff/i.test(check.type),
    );
    // Capability facts explain the failure; only an explicit branch decision is Unresolved.
    proof.facts["capabilityAtFailure"] = { initiallyConverted, acceptedInvalidAvc };
  } finally {
    // Preserve the original case error even if any later cleanup fails.
    for (const cleanup of [async () => session?.stop(), stopFixtures]) {
      try {
        await cleanup();
      } catch (error) {
        proof.cleanupErrors.push(String(error));
        proof.outcome = "failed";
      }
    }
    if (subtitles)
      proof.facts["subtitleFixture"] = {
        requests: subtitles.requests,
        zipSha256: subtitles.zipSha256,
      };
    proof.endedAt = Date.now();
    await save();
  }
}

const usage = `Usage:
  node apps/desktop/test/e2e/installed-media.ts --packages <validated .15/candidate pair> --out <new absolute directory under RUNNER_TEMP> [--sha <full product source>]
  node apps/desktop/test/e2e/installed-media.ts --target <explicit pin JSON, POSIX only> --out <new absolute directory>`;

/** Public CLI: a failed preflight still writes a receipt, and only passed can exit zero. */
export async function installedMedia(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      target: { type: "string" },
      packages: { type: "string" },
      out: { type: "string" },
      sha: { type: "string" },
    },
  });
  assert(values.out && isAbsolute(values.out), usage);
  const out = join(await realpath(dirname(values.out)), basename(values.out));
  if (process.platform === "win32") {
    const temp = await realpath(process.env["RUNNER_TEMP"] ?? "");
    const under = relative(temp, out);
    assert(
      under && !under.startsWith("..") && !isAbsolute(under),
      "--out must be under RUNNER_TEMP",
    );
  }
  await mkdir(out); // An existing output is never overwritten, even for a failed preflight.
  const evidence = join(out, "evidence");
  await mkdir(evidence);
  const profiles = join(out, "profiles");
  await mkdir(profiles);
  const proof: {
    outcome: Outcome | "running";
    startedAt: number;
    spawns: number;
    cases: CaseProof[];
    limits: string[];
    details: Record<string, unknown>;
  } = {
    outcome: "running",
    startedAt: Date.now(),
    spawns: 0,
    cases: [],
    details: {},
    limits: [
      "Stopped provider/TMDB/SubDL and refused fixture ports prove source-unavailable playback, not OS network denial. Renderer attempts are separate from provider served reads; main attempts beyond SubDL are unobserved.",
      "R3's separate audited app/ffmpeg/ffprobe block and Node online control are unchanged. No injected offline later error or already-paused startup failure is claimed.",
      "Decoded audio bytes are not audible output. No hardware GPU, HDR, physical receiver, signing, updater or Store certification.",
      "Hosted derived target and native-installs MUST be compared with independently accepted product/setup/tool pins before acceptance; mismatch rejects acceptance.",
    ],
  };
  const save = () => json(join(evidence, "proof-incremental.json"), proof);
  let pair: Awaited<ReturnType<typeof installedTelemetryPair>> | undefined;
  let target: Target | undefined;
  const wire: {
    at: number;
    method: string | undefined;
    url: string | undefined;
    headers: IncomingHttpHeaders;
    body: string;
  }[] = [];
  const captureErrors: string[] = [];
  const captureTasks = new Set<Promise<void>>();
  const capture = createServer((request, response) => {
    const task = (async () => {
      try {
        const chunks: Buffer[] = [];
        for await (const bytes of request) chunks.push(Buffer.from(bytes));
        wire.push({
          at: Date.now(),
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString(),
        });
        await json(join(evidence, "loopback-capture.json"), wire);
        response.end("ok");
      } catch (error) {
        captureErrors.push(String(error));
        response.writeHead(500).end();
      }
    })();
    captureTasks.add(task);
    void task.finally(() => captureTasks.delete(task));
  });
  const feed = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        schema: 1,
        generated: new Date().toISOString(),
        stable: null,
        nightly: null,
      }),
    );
  });
  try {
    assert(
      process.platform === "win32"
        ? values.packages && !values.target
        : values.target && !values.packages,
      "--packages is Windows-only; --target is POSIX-only",
    );
    assert(!values.sha || values.packages, "--sha belongs to --packages mode");
    assert(!values.sha || /^[a-f0-9]{40}$/.test(values.sha), "Expected a full product source SHA");
    let runner: Runner | undefined;
    let setup: { sha256: string; file: string; bytes: number } | undefined;
    if (values.packages) {
      runner = disposableRunner();
      const receipt = readReceipt(
        JSON.parse(await readFile(join(values.packages, "receipt.json"), "utf8")),
      );
      const candidate = receipt.packages[1];
      assert(
        !values.sha || candidate.source === values.sha,
        "--sha differs from validated product source",
      );
      pair = await installedTelemetryPair(values.packages, evidence, {
        executable: runner.executable,
        version: candidate.version,
        source: candidate.source,
      });
      await pair.select("candidate");
      const executable = await realpath(runner.executable);
      const resources = await realpath(join(runner.installRoot, "resources"));
      target = readTarget({
        platform: process.platform,
        executable,
        resources,
        version: candidate.version,
        source: candidate.source,
        pins: await installedPins(executable, resources),
      });
      setup = { sha256: candidate.sha256, file: candidate.file, bytes: candidate.bytes };
    } else {
      target = readTarget(JSON.parse(await readFile(values.target!, "utf8")));
    }
    proof.details["target"] = target;
    // Write before preflight and before first spawn, so even a pin refusal retains its target.
    const helpers = [
      "app.ts",
      "installed-media-observer.ts",
      "installed-media-posix.ts",
      "analytics-exit.ts",
      "analytics-installed-pair.ts",
      "installed-upgrade.ts",
      "installed-upgrade-packages.ts",
      "installed-upgrade-windows.ts",
      "installed-subtitles.ts",
      "installed-worker-scripts.ts",
      "installed-catalogue-worker.ts",
      "../fake-provider.ts",
      "../fake-tmdb.ts",
    ];
    const verifier = {
      revision: git("rev-parse", "HEAD"),
      tree: git("rev-parse", "HEAD^{tree}"),
      status: git("status", "--porcelain"),
      githubSha: process.env["GITHUB_SHA"] ?? null,
      driver: {
        path: fileURLToPath(import.meta.url),
        sha256: await hash(fileURLToPath(import.meta.url)),
      },
      helpers: await Promise.all(
        helpers.map(async (name) => ({
          path: name,
          sha256: await hash(fileURLToPath(new URL(name, import.meta.url))),
        })),
      ),
    };
    await json(join(evidence, "target.json"), { ...target, setup, verifier });
    proof.details["preflightPins"] = await verifyPins(target);
    av1Bytes("short");
    av1Bytes("long");
    const endpoint = `${await listen(capture)}/i/v0/e/`;
    const update = await listen(feed);
    proof.details["localBoundaries"] = { endpoint, update };
    await save();
    const variants: Variant[] = [
      "av1",
      "startup-rejection",
      "later-rejection",
      ...(process.platform === "darwin" ? (["hevc-12bit", "h264-10bit"] as const) : []),
    ];
    for (const variant of variants) {
      const scenario: CaseProof = {
        variant,
        outcome: "running",
        profile: join(profiles, variant),
        startedAt: Date.now(),
        facts: {},
        session: {},
        cleanupErrors: [],
      };
      proof.cases.push(scenario);
      await save();
      console.log(`MEDIA_BEGIN ${variant}`);
      await runCase(target, runner, variant, out, endpoint, update, scenario, save, () => {
        proof.spawns++;
      });
      console.log(`MEDIA_${scenario.outcome.toUpperCase()} ${variant}`);
      await save();
      if (scenario.outcome !== "passed") {
        proof.outcome = scenario.outcome === "unresolved" ? "unresolved" : "failed";
        break;
      }
    }
    if (
      proof.cases.length === variants.length &&
      proof.cases.every((scenario) => scenario.outcome === "passed")
    )
      proof.outcome = "passed";
  } catch (error) {
    proof.outcome = "failed";
    proof.details["error"] =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    const cleanupErrors: string[] = [];
    for (const server of [capture, feed]) {
      try {
        await closeServer(server);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    await Promise.all(captureTasks);
    cleanupErrors.push(...captureErrors);
    if (target) {
      try {
        proof.details["finalPins"] = await verifyPins(target);
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    proof.details["captureErrors"] = captureErrors;
    if (cleanupErrors.length) proof.outcome = "failed";
    proof.details["cleanupErrors"] = cleanupErrors;
    // Profiles/install remain on any failure. Uninstall is success-only after every socket/child check.
    if (proof.outcome === "passed") {
      try {
        if (pair) {
          pair.accepted();
          await pair.close();
        }
        for (const scenario of proof.cases) {
          await rm(scenario.profile, { recursive: true });
          scenario.profileRemoved = true;
        }
      } catch (error) {
        proof.outcome = "failed";
        cleanupErrors.push(String(error));
      }
    }
    proof.details["endedAt"] = Date.now();
    await json(join(evidence, "loopback-capture.json"), wire);
    await save();
    await json(join(evidence, "proof.json"), proof);
    console.log(`MEDIA_FINAL ${proof.outcome}: ${evidence}`);
  }
  return proof.outcome === "passed" ? 0 : 1;
}
if (import.meta.main) {
  installedMedia(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(String(error));
      process.exitCode = 1;
    },
  );
}
