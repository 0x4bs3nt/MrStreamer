// Built-app proof through the actual Settings control, with an isolated profile and loopback only.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { type } from "arktype";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import type { Result } from "@mrstreamer/contracts/errors";
import { CaptureEvent } from "../../src/main/analytics/model.ts";
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
const actions: { action: string; at: string }[] = [];
const observations: Record<string, unknown> = {};
const log: string[] = [];
let app: ChildProcess | undefined;
let page: Page | undefined;
let failure: unknown;
const cleanupErrors: string[] = [];

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
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("MR_STREAMER_") && name !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  app = spawn(
    packagedExecutable ?? (await electronExecutable()),
    [
      `--remote-debugging-port=${port}`,
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
        MR_STREAMER_TMDB_API: tmdb!.url,
        MR_STREAMER_TMDB_KEY: "test-key",
        MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT: endpoint,
      },
    },
  );
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
  page = await connect(port);
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
  observations["instance"] = { pid: app.pid, port, profile, url, endpoint };
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
}

/** Pointer input, with the element located from the current DOM rather than guessed coordinates. */
async function click(selector: string, index = 0) {
  const element = `document.querySelectorAll(${JSON.stringify(selector)})[${index}]`;
  await waitFor(() => live().evaluate<boolean>(`!!(${element})`));
  await live().evaluate(`${element}.scrollIntoView({block:'center'})`);
  const point = await live().evaluate<{ x: number; y: number }>(
    `(() => { const r=${element}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`,
  );
  for (const event of ["mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", {
      type: event,
      ...point,
      button: "left",
      clickCount: 1,
    });
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

try {
  profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-"));
  profiles.push(profile);
  provider = await startFakeProvider({ channels: 3, titles: 3 });
  tmdb = await startFakeTmdb();
  await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
  const address = capture.address();
  if (!address || typeof address === "string") throw new Error("No owned capture port.");
  endpoint = `http://127.0.0.1:${address.port}/i/v0/e/`;
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
  await waitFor(async () => payloads.length === 2);
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
  const first = CaptureEvent(payloads[0]);
  const day = CaptureEvent(payloads[1]);
  if (
    first instanceof type.errors ||
    day instanceof type.errors ||
    first.event !== "installation_observed" ||
    day.event !== "app_active_day"
  )
    throw new Error("Wrong capture events.");
  if (
    !isDeepStrictEqual(payloads[0], { api_key: "mrstreamer-local-verification", ...first }) ||
    !isDeepStrictEqual(payloads[1], { api_key: "mrstreamer-local-verification", ...day })
  )
    throw new Error("Unexpected capture properties.");
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
  if (payloads.length !== 2) throw new Error("Disabled profile captured after restart.");
  actions.push({
    action: "Restarted same profile, checkbox remains off and capture count unchanged",
    at: new Date().toISOString(),
  });
  await click(checkbox);
  await waitFor(async () => (await preference()).analyticsEnabled === true);
  await snapshot("reenabled");
  await delay(1200);
  if (payloads.length !== 2) throw new Error("Re-enable duplicated first-seen/day.");
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
  // A second fresh profile observes real pending events while the local capture boundary refuses them.
  await quit();
  rejectCapture = true;
  profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-pending-"));
  profiles.push(profile);
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
    return Array.isArray(kept["pending"]) && kept["pending"].length === 2;
  });
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
    action: "Opted out with two actual pending events; persisted queue is empty",
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
  if (tmdb) await clean(() => tmdb!.close());
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
        scenario: "analytics",
        build: packagedExecutable ? undefined : build,
        verificationSource: packagedExecutable ? build : undefined,
        mode: packagedExecutable ? "packaged-executable" : "source-build",
        observed: observations,
        cleanup: {
          appExited,
          fixturesClosed: cleanupErrors.length === 0 && !capture.listening,
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
