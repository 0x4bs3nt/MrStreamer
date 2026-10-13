// Only the two public SubDL hosts are forwarded. Packaged apps install this boundary while
// inspect-brk still holds main, before OnlineSubtitles captures fetch. No product hook is needed.
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile, readdir, readlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { zipSync, strToU8 } from "fflate";
import type { Page } from "./app.ts";
import type { Driver } from "./installed-upgrade.ts";

/** Prove the inspector listener belongs to an already-pinned owned PID before waking main. */
export async function inspectorOwner(port: number, ownedPids: readonly number[]) {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !ownedPids.length ||
    ownedPids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)
  )
    throw new Error("Invalid inspector owner request");
  if (process.platform === "linux") {
    const endpoint = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`;
    const rows = (await readFile("/proc/net/tcp", "utf8"))
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((fields) => fields[1] === endpoint && fields[3] === "0A");
    if (rows.length !== 1 || !/^\d+$/.test(rows[0]?.[9] ?? ""))
      throw new Error("No unique loopback inspector listener");
    const inode = `socket:[${rows[0]![9]}]`;
    for (const pid of ownedPids) {
      try {
        for (const fd of await readdir(`/proc/${pid}/fd`)) {
          const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT" || error.code === "ESRCH") return null;
              throw error;
            },
          );
          if (target === inode) return pid;
        }
      } catch (error) {
        if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  } else if (process.platform === "darwin") {
    const output = execFileSync(
      "/usr/sbin/lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpn"],
      { encoding: "utf8", timeout: 5000 },
    );
    let pid: number | undefined;
    const owners: number[] = [];
    for (const line of output.trim().split("\n")) {
      if (/^p\d+$/.test(line)) pid = Number(line.slice(1));
      if (line === `n127.0.0.1:${port}` && pid) owners.push(pid);
    }
    if (owners.length === 1 && ownedPids.includes(owners[0]!)) return owners[0]!;
  } else if (process.platform === "win32") {
    const output = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$ErrorActionPreference='Stop'; $rows=@(Get-NetTCPConnection -State Listen -LocalAddress '127.0.0.1' -LocalPort ${port}); ConvertTo-Json -Compress -InputObject @($rows | ForEach-Object { [int]$_.OwningProcess })`,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    const owners: unknown = JSON.parse(output);
    if (
      Array.isArray(owners) &&
      owners.length === 1 &&
      typeof owners[0] === "number" &&
      ownedPids.includes(owners[0])
    )
      return owners[0];
  } else throw new Error("Unsupported native inspector owner platform");
  throw new Error("Inspector listener is not an owned launch process");
}

export const SUBTITLE_RELEASE = "Installed upgrade exact-file subtitle";
export const SUBTITLE_CUE = {
  start: 40,
  end: 60,
  text: "Saved online cue, retained across upgrade.",
};
export const SUBTITLE_TIMING = { offset: 2, speed: 1.02 };
const key = "synthetic-installed-subdl";

/** The same executable fetch boundary is tested with real HTTP and installed through inspector. */
interface SubtitleRequest {
  readonly at: string;
  readonly host: string;
  readonly path: string;
}
export function subtitleFetch(
  origin: string,
  request: typeof fetch,
  observe?: (request: SubtitleRequest) => void,
): typeof fetch {
  const fixture = new URL(origin);
  if (
    fixture.protocol !== "http:" ||
    fixture.hostname !== "127.0.0.1" ||
    !fixture.port ||
    fixture.pathname !== "/" ||
    fixture.search ||
    fixture.hash ||
    fixture.username ||
    fixture.password
  )
    throw new Error("Subtitle fixture must be an explicit loopback origin");
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      !["api.subdl.com", "dl.subdl.com"].includes(url.hostname)
    )
      return request(input, init);
    observe?.({ at: new Date().toISOString(), host: url.hostname, path: url.pathname });
    const target = new URL(`/${url.hostname}${url.pathname}${url.search}`, fixture);
    // Request construction preserves method/body/headers/abort; the caller's init still wins.
    return request(input instanceof Request ? new Request(target, input) : target, init);
  };
}

export async function startSubtitleFixture() {
  const bytes = zipSync({
    "installed-upgrade.srt": strToU8(`1\n00:00:40,000 --> 00:01:00,000\n${SUBTITLE_CUE.text}\n`),
  });
  const requests: { at: string; host: string; path: string; method: string }[] = [];
  let stopped = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const host = url.pathname.split("/")[1] ?? "";
    requests.push({
      at: new Date().toISOString(),
      host,
      path: url.pathname,
      method: request.method ?? "GET",
    });
    if (request.method !== "GET") return void response.writeHead(405).end();
    if (url.pathname === "/api.subdl.com/api/v1/subtitles") {
      if (
        url.searchParams.get("api_key") !== key ||
        url.searchParams.get("type") !== "movie" ||
        !url.searchParams.get("languages")?.split(",").includes("EN")
      )
        return void response.writeHead(400).end();
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          status: true,
          results: [{ tmdb_id: Number(url.searchParams.get("tmdb_id")), type: "movie" }],
          subtitles: [
            {
              language: "English",
              release_name: SUBTITLE_RELEASE,
              url: "https://dl.subdl.com/installed-upgrade.zip",
            },
          ],
        }),
      );
    } else if (url.pathname === "/dl.subdl.com/installed-upgrade.zip") {
      response
        .writeHead(200, { "Content-Type": "application/zip", "Content-Length": bytes.length })
        .end(bytes);
    } else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No subtitle fixture port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    zipSha256: createHash("sha256").update(bytes).digest("hex"),
    async stop() {
      if (!stopped) {
        stopped = true;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
      return { stopped, requests: requests.length };
    },
  };
}

/** Caller must verify paused main PID, profile, native executable/resources and hashes first. */
export async function bootstrapSubtitles(
  main: Awaited<ReturnType<typeof pauseMain>>,
  origin: string,
) {
  // Node strips types before function serialization; Vitest transpiles them too.
  subtitleFetch(origin, fetch);
  const expression = `(() => {
    if (typeof globalThis.fetch !== 'function') throw new Error('Paused packaged main has no fetch');
    const requests = [];
    const boundary = Symbol.for('mrstreamer.installedSubtitles');
    if (globalThis[boundary]) throw new Error('Subtitle boundary already installed');
    globalThis[boundary] = { requests };
    globalThis.fetch = (${subtitleFetch.toString()})(${JSON.stringify(origin)}, globalThis.fetch, request => {
      if (requests.length >= 1000) throw new Error('Subtitle request evidence limit exceeded');
      requests.push(request);
    });
    return { pid: process.pid, origin: ${JSON.stringify(origin)}, boundary: 'SubDL fetch only' };
  })()`;
  return main.evaluate<{ pid: number; origin: string; boundary: string }>(expression);
}

/** Turns inspect-brk's waiting debugger into the initial code pause, before main executes. */
export async function pauseMain(main: Page) {
  let paused: { callFrames: { callFrameId: string; url: string }[]; reason: string } | undefined;
  main.on("Debugger.paused", (params) => {
    paused = params as typeof paused;
  });
  for (const method of ["Debugger.enable", "Runtime.runIfWaitingForDebugger"]) {
    const result = await main.send(method);
    if (result.error) throw new Error(`${method}: ${JSON.stringify(result.error)}`);
  }
  const until = Date.now() + 10_000;
  while (!paused && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  const frame = paused?.callFrames[0];
  if (!frame || paused?.reason !== "Break on start")
    throw new Error("Packaged main did not pause before its entry point");
  // Runtime.evaluate with awaitPromise cannot finish while the event loop is paused.
  // Use the actual initial call frame for these synchronous identity/boundary operations.
  return {
    ...main,
    location: { url: frame.url, reason: paused.reason },
    async evaluate<T>(expression: string, timeoutMs = 10_000): Promise<T> {
      const reply = await main.send(
        "Debugger.evaluateOnCallFrame",
        { callFrameId: frame.callFrameId, expression, returnByValue: true },
        timeoutMs,
      );
      if (reply.error) throw new Error(JSON.stringify(reply.error));
      const result = reply.result as { result: { value: T }; exceptionDetails?: unknown };
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
  };
}

/** Resume only the initial pause held for the verified network bootstrap. */
export async function resumeMain(main: Page) {
  const result = await main.send("Debugger.resume");
  if (result.error) throw new Error(`Debugger.resume: ${JSON.stringify(result.error)}`);
}

const button = (words: string) =>
  `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
const driftToggle = `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button[aria-expanded]')].find(b => b.querySelector('span')?.textContent === 'Drift and frame rate')`;
const savedChoice = `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button[aria-pressed]')].find(b => b.textContent.includes('Saved for this version') && [...b.querySelectorAll('span')].some(s => s.textContent === ${JSON.stringify(SUBTITLE_RELEASE)}))`;
const labelled = (label: string) =>
  `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
async function input(d: Driver, label: string, selector: string, value: string) {
  await d.click(label, selector);
  // Command on Mac, Control elsewhere. Editing remains actual keyboard and text input.
  const modifiers = process.platform === "darwin" ? 4 : 2;
  for (const type of ["rawKeyDown", "keyUp"])
    await d.page.send("Input.dispatchKeyEvent", {
      type,
      key: "a",
      code: "KeyA",
      windowsVirtualKeyCode: 65,
      modifiers,
      ...(process.platform === "darwin" && type === "rawKeyDown"
        ? { commands: ["selectAll"] }
        : {}),
    });
  await d.type(label, value);
  await d.key("Tab", 9);
}

/** Called in the already-open General settings, after stable Connect. */
export async function configureSubtitleUi(d: Driver) {
  const section = `[...document.querySelectorAll('section')].find(s => s.textContent.includes('Online subtitles'))`;
  await d.click("Set up SubDL", `(${section})?.querySelector('button')`);
  await input(d, "Synthetic SubDL API key", labelled("SubDL API key"), key);
  await d.click("Save SubDL", `(${section})?.querySelector('form button[type=submit]')`);
  await d.wait(
    async () => (await d.read("subtitles.settings")).configured.subdl,
    10_000,
    "saved SubDL account",
  );
  const checkbox = labelled("Online subtitle search");
  // Limit this test to its one synthetic account; unrelated service searches remain unchanged.
  const services = labelled("Subtitle search services");
  await d.select("Choose SubDL search", services, "subdl");
  await d.wait(
    async () => (await d.read("subtitles.settings")).service === "subdl",
    10_000,
    "SubDL-only search",
  );
  if (!(await d.page.evaluate<boolean>(`(${checkbox})?.checked`)))
    await d.click("Enable subtitle search", checkbox);
  await d.wait(
    () => d.page.evaluate<boolean>(`(${checkbox})?.checked && !(${checkbox})?.disabled`),
    10_000,
    "subtitle search opt-in",
  );
}

/** Selects a real service result while the long movie plays, before its download is queued. */
export async function seedSubtitleUi(d: Driver) {
  await d.click("Open Subtitles", labelled("Subtitles"));
  const select = labelled("Subtitle search language");
  await d.select("Choose English search", select, "en");
  await d.wait(
    () => d.page.evaluate<boolean>(`(${select}).value === 'en'`),
    10_000,
    "English search",
  );
  await d.click("Search subtitles", button("Search subtitles"));
  await d.click(
    "Choose fixture subtitle",
    `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button')].find(b => b.querySelector('span')?.textContent === ${JSON.stringify(SUBTITLE_RELEASE)} && b.textContent.includes('SubDL'))`,
  );
  await d.wait(
    () => d.exists(`document.querySelector('#subtitle-offset')`),
    30_000,
    "saved subtitle timing",
  );
  await input(
    d,
    "Set saved subtitle offset",
    "document.querySelector('#subtitle-offset')",
    String(SUBTITLE_TIMING.offset),
  );
  await d.click("Open subtitle drift", driftToggle);
  await input(
    d,
    "Set saved subtitle drift",
    "document.querySelector('#subtitle-speed')",
    String(SUBTITLE_TIMING.speed),
  );
  await d.click("Close Subtitles", labelled("Close subtitles"));
  return observeSavedSubtitle(d);
}

/** Shows the exact saved result and nondefault timing, then observes its shifted cue clock. */
export async function observeSavedSubtitle(d: Driver, context: "provider" | "copy" = "provider") {
  await d.click("Open saved Subtitles", labelled("Subtitles"));
  await d.click("Show saved online subtitle", savedChoice);
  await d.wait(
    () => d.page.evaluate<boolean>(`(${savedChoice})?.getAttribute('aria-pressed') === 'true'`),
    10_000,
    "saved exact-file result",
  );
  if (!(await d.exists("document.querySelector('#subtitle-speed')")))
    await d.click("Read saved subtitle drift", driftToggle);
  const timing = await d.page.evaluate<{ offset: number; speed: number }>(
    `({offset:Number(document.querySelector('#subtitle-offset')?.value),speed:Number(document.querySelector('#subtitle-speed')?.value)})`,
  );
  if (timing.offset !== SUBTITLE_TIMING.offset || timing.speed !== SUBTITLE_TIMING.speed)
    throw new Error(`Saved subtitle timing changed: ${JSON.stringify(timing)}`);
  await d.capture(`saved-${context}-subtitle-timing`);
  await d.click("Close saved Subtitles", labelled("Close subtitles"));
  const seekDeadline = Date.now() + 45_000;
  const skip = async (direction: -1 | 1) => {
    const before = await d.video();
    const target = Math.max(0, before.time + direction * 10);
    await d.key(direction === -1 ? "ArrowLeft" : "ArrowRight", direction === -1 ? 37 : 39);
    // Stream seeking briefly resets the video clock. Wait for the landing before another key.
    await d.wait(
      async () => {
        const video = await d.video();
        return !video.paused && video.width > 0 && Math.abs(video.time - target) < 2;
      },
      Math.max(1, seekDeadline - Date.now()),
      `saved subtitle seek to ${target}`,
    );
  };
  for (let attempts = 0; (await d.video()).time > 38 && attempts < 15; attempts++) await skip(-1);
  for (let attempts = 0; (await d.video()).time < 32 && attempts < 15; attempts++) await skip(1);
  const start = SUBTITLE_CUE.start * timing.speed + timing.offset;
  const end = SUBTITLE_CUE.end * timing.speed + timing.offset;
  const caption = () =>
    d.page.evaluate<string>(
      "document.querySelector('[data-subtitle-text]')?.textContent?.trim() ?? ''",
    );
  await d.wait(
    async () => (await d.video()).time >= 41,
    Math.max(1, seekDeadline - Date.now()),
    "time before shifted cue",
  );
  const observe = () =>
    d.page.evaluate<{ time: number; caption: string }>(
      `({time: document.querySelector('video')?.currentTime ?? 0, caption: document.querySelector('[data-subtitle-text]')?.textContent?.trim() ?? ''})`,
    );
  const before = await observe();
  if (before.time >= start || before.caption !== "")
    throw new Error(`Cue did not use its saved timing: ${JSON.stringify(before)}`);
  await d.wait(async () => (await caption()) === SUBTITLE_CUE.text, 15_000, "saved online cue");
  const shown = await observe();
  if (shown.time < start || shown.time >= end || shown.caption !== SUBTITLE_CUE.text)
    throw new Error(`Saved cue outside shifted interval: ${JSON.stringify(shown)}`);
  await d.capture(`saved-${context}-subtitle-cue`);
  return {
    release: SUBTITLE_RELEASE,
    timing,
    cue: SUBTITLE_CUE,
    interval: { start, end },
    before,
    shown,
  };
}

/** Read-only counts include attempts after the fixture stops, not just received HTTP requests. */
export function subtitleRequests(main: Page) {
  return main.evaluate<SubtitleRequest[]>(`(() => {
    const boundary = globalThis[Symbol.for('mrstreamer.installedSubtitles')];
    if (!boundary) throw new Error('No installed subtitle boundary');
    return boundary.requests;
  })()`);
}
