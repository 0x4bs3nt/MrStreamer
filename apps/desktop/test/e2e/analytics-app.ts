// Built-app proof through the actual Settings control, with an isolated profile and loopback only.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { connect, delay, waitFor, type Page } from "./app.ts";
import {
  electronExecutable,
  freePort,
  record,
  stop,
} from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const evidenceRoot = join(root, ".local/verification");
await mkdir(evidenceRoot, { recursive: true });
const evidence = await mkdtemp(join(evidenceRoot, "analytics-"));
const profile = await mkdtemp(join(tmpdir(), "mrstreamer-analytics-"));
const provider = await startFakeProvider({ channels: 3, titles: 3 });
const tmdb = await startFakeTmdb();
const payloads: unknown[] = [];
const capture = createServer(async (req, res) => {
  const bytes: Buffer[] = [];
  for await (const chunk of req) bytes.push(Buffer.from(chunk));
  payloads.push(JSON.parse(Buffer.concat(bytes).toString()));
  res.end("ok");
});
await new Promise<void>((resolve) => capture.listen(0, "127.0.0.1", resolve));
const address = capture.address();
if (!address || typeof address === "string") throw new Error("No owned capture port.");
const endpoint = `http://127.0.0.1:${address.port}/i/v0/e/`;
const executable = await electronExecutable();
const actions: { action: string; at: string }[] = [];
const observations: Record<string, unknown> = {};
const log: string[] = [];
let app: ChildProcess | undefined;
let page: Page | undefined;
let failure: unknown;
let cleanup = false;

function live() {
  if (!page) throw new Error("No owned window.");
  return page;
}

async function send(method: string, params: Record<string, unknown> = {}) {
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
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profile}`,
      "--enable-automation",
      "--use-mock-keychain",
      ...(process.platform === "linux" ? ["--no-sandbox"] : []),
      desktop,
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
        MR_STREAMER_TMDB_API: tmdb.url,
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
    ![desktop, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`].every((arg) =>
      arguments_.includes(arg),
    )
  )
    throw new Error("Wrong app instance.");
  const url = await live().evaluate<string>("location.href");
  if (!url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href))
    throw new Error("Wrong renderer build.");
  observations["instance"] = { pid: app.pid, port, profile, url, endpoint };
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
  const shot = await send("Page.captureScreenshot", { format: "png" });
  if (!record(shot) || typeof shot["data"] !== "string") throw new Error("No screenshot.");
  await writeFile(join(evidence, `${name}.png`), Buffer.from(shot["data"], "base64"));
  await writeFile(
    join(evidence, `${name}-tree.json`),
    JSON.stringify(await send("Accessibility.getFullAXTree"), null, 2),
  );
}

try {
  await launch();
  await waitFor(() =>
    live().evaluate<boolean>("document.querySelectorAll('form input').length>=3"),
  );
  for (const [index, value] of [provider.url, "demo", "demo"].entries()) {
    await click("form input", index);
    await send("Input.insertText", { text: value });
  }
  await click('form button[type="submit"]');
  await settings();
  await waitFor(async () => (await preference()).analyticsEnabled === true);
  await waitFor(async () => payloads.length === 2);
  if (
    (await live().evaluate<string>(
      `document.querySelector(${JSON.stringify(checkbox)}).getAttribute('aria-checked')`,
    )) !== "true"
  )
    throw new Error("Default control is not checked.");
  await snapshot("on");
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
  observations["productionAnalyticsRequests"] = 0;
  observations["productionExclusionEvidence"] =
    "Transport accepts only this literal loopback endpoint; explicit isolated profile and automation also exclude configured production transport.";
} catch (error) {
  failure = error;
  if (page) await snapshot("failure").catch(() => {});
} finally {
  try {
    await quit();
    await provider.close();
    await tmdb.close();
    capture.closeAllConnections();
    await new Promise<void>((resolve) => capture.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
    cleanup = true;
  } catch (error) {
    failure ??= error;
  }
  await writeFile(join(evidence, "payloads.json"), JSON.stringify(payloads, null, 2));
  await writeFile(join(evidence, "electron.log"), log.join(""));
  await writeFile(
    join(evidence, "proof.json"),
    JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        error: failure instanceof Error ? failure.message : undefined,
        actions,
        observations,
        cleanup,
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: root,
          encoding: "utf8",
        }).trim(),
        mainSha256: createHash("sha256")
          .update(await readFile(join(desktop, "out/main/index.js")))
          .digest("hex"),
        limitations: [
          "Local capture, no live PostHog project/dashboard/retention acceptance",
          "Source build on Linux; installed native platform acceptance pending",
        ],
      },
      null,
      2,
    ),
  );
}
console.log(evidence);
if (failure) throw failure;
