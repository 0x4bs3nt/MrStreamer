// Captures the four windows the marketing site is made from, as docs/assets/marketing-*.png: a
// series' details, an episode playing with its subtitle menu open, Live TV and Home. See
// docs/contributing/marketing-artwork.md.
//
//   xvfb-run -a node apps/desktop/scripts/marketing-capture.ts --cache-dir <folder outside the repository>
//
// Runs the development build (`pnpm build` first) with a throwaway profile against the made-up
// subscription of marketing-demo.ts, and drives it through its DevTools port as a viewer would:
// it plays an episode to seed history/recommendations, stars two channels and watches two. Each
// capture is
// the window's page at 1280 × 800 and twice the pixels, 2560 × 1600, written only once it shows
// what it should: the names, a decoded picture, the tracks and the subtitle.
//
// Linux draws the app in the system's sans-serif font; the captures use Inter, which must be
// installed. Nothing here reaches a real provider: the app's images are answered from the demo
// through the page's DevTools session, and any other remote image is refused.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import manifest from "../../../docs/assets/marketing-demo-sources.json" with { type: "json" };
import { connect, delay, key, login, waitFor, type Page } from "../test/e2e/app.ts";
import {
  electronExecutable,
  freePort,
  stop,
  record,
} from "../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";
import { cacheDirectory, prepareMedia, startMarketingDemo } from "./marketing-demo.ts";

const desktop = join(import.meta.dirname, "..");
const assets = join(desktop, "../../docs/assets");
/** The window's size, and how many pixels a capture holds for each of its points. */
const WINDOW = { width: 1280, height: 800 };
const SCALE = 2;
const { featured } = manifest;
const [episode, nextEpisode] = featured.episodes;
if (!episode || !nextEpisode) throw new Error("The manifest lists no two episodes.");
/** The subtitle the capture of the playing episode shows. */
const [, line] = featured.subtitles.eng;
if (!line) throw new Error("The manifest lists no second subtitle.");

const root = join(desktop, "../..");
const evidenceRoot = join(root, ".local/marketing-captures");
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, "capture-"));
const executable = await electronExecutable();
const cache = cacheDirectory();
const media = await prepareMedia(cache);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-marketing-"));
const session = `marketing-${Date.now()}`;
const actions: { action: string; at: string }[] = [];
const captures: {
  name: string;
  file: string;
  width: number;
  height: number;
  bytes: number;
  sha256: string;
  videoBox: unknown;
}[] = [];
const proof: Record<string, unknown> = {
  status: "running",
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceDiff: execFileSync("git", ["diff", "--", "apps/desktop/scripts/marketing-capture.ts"], {
    cwd: root,
    encoding: "utf8",
  }),
  platform: process.platform,
  architecture: process.arch,
  system:
    process.platform === "darwin"
      ? execFileSync("sw_vers", { encoding: "utf8" })
      : execFileSync("uname", ["-a"], { encoding: "utf8" }),
  appVersion: JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")).version,
  mainSha256: hash(readFileSync(join(desktop, "out/main/index.js"))),
  manifestSha256: hash(readFileSync(join(root, "docs/assets/marketing-demo-sources.json"))),
  actions,
  captures,
  limitations: [
    "Native source build, not an installed or signed release.",
    "No audible audio, GPU, receiver, real-provider, mapped-M3U or locale acceptance is inferred.",
  ],
};
writeFileSync(
  join(evidence, "manifest.json"),
  readFileSync(join(root, "docs/assets/marketing-demo-sources.json")),
);
console.log(`Evidence: ${evidence}`);
let app: ChildProcess | undefined;
let demo: Awaited<ReturnType<typeof startMarketingDemo>> | undefined;
let page: Page | undefined;
let windowId: number | undefined;
let cuaStarted = false;
let log = "";
try {
  // Linux alone needs fontconfig. macOS uses its real system font.
  if (process.platform === "linux") {
    const fonts = join(profile, "fonts.conf");
    writeFileSync(
      fonts,
      `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><include ignore_missing="yes">/etc/fonts/fonts.conf</include>` +
        ["sans-serif", "system-ui"]
          .map(
            (family) =>
              `<alias binding="strong"><family>${family}</family><prefer><family>Inter</family></prefer></alias>`,
          )
          .join("") +
        `</fontconfig>`,
    );
    process.env["FONTCONFIG_FILE"] = fonts;
    const font = execFileSync("fc-match", ["-f", "%{family}", "system-ui"], { encoding: "utf8" });
    if (!font.includes("Inter")) throw new Error(`Install Inter: the system font is ${font}.`);
  }
  proof["media"] = Object.fromEntries(
    Object.entries(media).map(([name, paths]) => [
      name,
      (Array.isArray(paths) ? paths : [paths]).map((file: string) => ({
        file,
        sha256: hash(readFileSync(file)),
        bytes: readFileSync(file).length,
      })),
    ]),
  );
  demo = await startMarketingDemo(media);
  const port = await freePort();
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("MR_STREAMER_") && name !== "ELECTRON_RUN_AS_NODE",
    ),
  );
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profile}`,
    "--enable-automation",
    "--use-mock-keychain",
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    desktop,
  ];
  app = spawn(executable, args, {
    cwd: root,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      ...(process.env["MR_STREAMER_FFMPEG"]
        ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
        : {}),
      MR_STREAMER_UPDATE_CHECKS: "off",
      MR_STREAMER_TMDB_API: demo.tmdbApi,
      MR_STREAMER_TMDB_KEY: "marketing-capture",
    },
  });
  for (const stream of [app.stdout, app.stderr])
    stream?.on("data", (chunk: Buffer) => {
      log += chunk.toString();
    });
  // A rejected endpoint must never receive a failure capture or browser-wide shutdown.
  const connected = await connect(port);
  let actual: string[];
  let url: string;
  try {
    const identity = await connected.send("Browser.getBrowserCommandLine");
    actual = (identity.result as { arguments: string[] }).arguments;
    if (!args.every((arg) => actual.includes(arg))) throw new Error("CDP is not our app.");
    url = await connected.evaluate<string>("location.href");
    if (!url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href))
      throw new Error("Wrong renderer.");
  } catch (error) {
    connected.close();
    throw error;
  }
  page = connected;
  proof["instance"] = { pid: app.pid, port, profile, url, arguments: actual };
  proof["electron"] = await page.evaluate<string>("navigator.userAgent");
  if (process.platform === "darwin") {
    cua("start_session", {});
    cuaStarted = true;
    const permissions = cua("check_permissions", { prompt: false });
    proof["permissions"] = permissions;
    if (
      !record(permissions) ||
      permissions["accessibility"] !== true ||
      permissions["screen_recording"] !== true
    )
      throw new Error("CuaDriver grants missing.");
    const windows = cua("list_windows", { pid: app.pid });
    writeFileSync(join(evidence, "native-windows.json"), JSON.stringify(windows, null, 2));
    if (!record(windows) || !Array.isArray(windows["windows"])) throw new Error("No window list.");
    const owned = windows["windows"].find(
      (entry: unknown) =>
        record(entry) && entry["pid"] === app?.pid && entry["title"] === "Mr. Streamer",
    );
    if (record(owned) && typeof owned["window_id"] === "number") windowId = owned["window_id"];
    if (!windowId) throw new Error("No owned native window.");
  }
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Emulation.setDeviceMetricsOverride", {
    ...WINDOW,
    deviceScaleFactor: SCALE,
    mobile: false,
  });
  // Scroll bars stay out of the picture, as on a Mac, where they show only while scrolling.
  await page.send("Emulation.setScrollbarsHidden", { hidden: true });
  // Images come from the demo; a remote image it doesn't know is refused.
  page.on("Fetch.requestPaused", (params) => {
    const { requestId, request } = params as { requestId: string; request: { url: string } };
    const picture = demo!.artwork(request.url);
    if (!picture) {
      return void page!.send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    }
    void page!.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: "Content-Type", value: picture.contentType }],
      body: picture.body.toString("base64"),
    });
  });
  await page.send("Fetch.enable", {
    patterns: ["http://*", "https://*"].map((urlPattern) => ({
      urlPattern,
      resourceType: "Image",
    })),
  });
  action("Log in through the fake subscription form");
  await login(page, demo.provider);

  // Movies and series: the series' details, before anything was played.
  await click(page, "header button", "Series");
  await click(page, "button", featured.name);
  await shows(page, [
    featured.overview,
    ...featured.cast.map((person) => person.name),
    `Play S${episode.season} E${episode.number}`,
    episode.name,
    featured.creator,
  ]);
  await capture(page, "library", { fullScreen: true, pictures: '[role="dialog"] img' });

  // Sound and subtitles: the episode playing, its subtitle showing and the subtitle menu open.
  await click(page, '[role="dialog"] button', `Play S${episode.season} E${episode.number}`);
  const time = () => page!.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
  await waitFor(async () => (await time()) > 0.5);
  await openMenu(page, "Subtitles");
  await click(page, "[data-item]", "English");
  // Higher up, so the menu the capture shows open doesn't cover the subtitle.
  await click(page, "[role=radio]", "Higher");
  await key(page, "Escape", 27);
  const subtitle = () =>
    page!.evaluate<string>(
      `[...document.querySelector("video").textTracks].flatMap((track) => [...(track.activeCues ?? [])]).map((cue) => cue.text).join("|")`,
    );
  for (let attempt = 1; ; attempt++) {
    await waitFor(async () => (await time()) >= line.from + 0.6);
    await openMenu(page, "Subtitles");
    await shows(page, [
      featured.name,
      episode.name,
      "Off",
      "English",
      "Nederlands",
      "Next episode",
    ]);
    const taken = await capture(page, "watching", {
      video: true,
      holds: async () => (await subtitle()) === line.text,
    });
    if (taken) break;
    if (attempt === 3) throw new Error(`The capture missed "${line.text}".`);
    // Close the menu and go back ten seconds for another try.
    await key(page, "Escape", 27);
    await key(page, "ArrowLeft", 37);
  }
  await waitFor(async () => (await time()) > 12);
  action("Leave the played episode to seed real Continue watching and recommendations");
  await key(page, "Escape", 27);
  await key(page, "Escape", 27);
  await waitFor(() => page!.evaluate<boolean>(`!document.querySelector("[data-view=title]")`));
  await key(page, "Escape", 27);

  // Live TV: two favourites, and the channel watched last on top.
  await click(page, "header button", "Live TV");
  for (const channel of manifest.favourites) {
    await clickExpression(
      page,
      `${row(channel)}.querySelector('[aria-label="Add to favourites"]')`,
      `Favourite ${channel}`,
    );
  }
  await watch(page, manifest.guide);
  await shows(page, [
    "Favourites",
    "Recently watched",
    ...manifest.channels.flatMap((channel) => channel.programmes.slice(0, 2)),
  ]);
  await capture(page, "live-tv", { fullScreen: true, video: true, pictures: "img" });

  // Home: another channel on now, and the series to go on with.
  await watch(page, manifest.home);
  await click(page, "header button", "Home");
  await shows(page, [
    "Continue watching",
    "Recommendations",
    `Because you watched ${featured.name}`,
    "Watchlist",
    featured.name,
    manifest.home,
  ]);
  await waitFor(() => playing(page!));
  await capture(page, "home", { fullScreen: true, video: true, pictures: "img" });
  await click(page, 'header button[aria-label="Settings"]', "");
  await click(page, "nav button", "Home");
  await shows(page, ["Reset to defaults", "Recommendations"]);
  await retain(page, "home-customize");
  await clickExpression(
    page,
    "[...document.querySelectorAll('header button')].findLast(b => b.textContent.trim() === 'Back')",
    "Return from Home settings",
  );
  writeFileSync(
    join(assets, "marketing-capture.json"),
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        appSource: proof["source"],
        appVersion: proof["appVersion"],
        platform: proof["platform"],
        architecture: proof["architecture"],
        system: proof["system"],
        electron: proof["electron"],
        mainSha256: proof["mainSha256"],
        demoManifestSha256: proof["manifestSha256"],
        captureScriptSha256: hash(readFileSync(join(desktop, "scripts/marketing-capture.ts"))),
        captures: captures.map((capture) => ({
          ...capture,
          file: `marketing-${capture.name}.png`,
        })),
      },
      null,
      2,
    ) + "\n",
  );
  proof["status"] = "passed";
} catch (error) {
  proof["status"] = "failed";
  proof["error"] = String(error);
  if (page) await retain(page, "failure").catch(() => undefined);
  throw error;
} finally {
  try {
    if (app) await stop(app, page);
    page?.close();
    await demo?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    proof["cleanup"] = {
      appExited: !app || app.exitCode !== null || app.signalCode !== null,
      profileRemoved: !existsSync(profile),
    };
    if (cuaStarted) {
      proof["windowsAfterExit"] = cua("list_windows", { pid: app?.pid });
      cua("end_session", {});
    }
  } finally {
    writeFileSync(join(evidence, "electron.log"), log);
    writeFileSync(join(evidence, "proof.json"), JSON.stringify(proof, null, 2));
  }
}

/** Where the picture on screen is, in the window's points. */
function videoBox(page: Page) {
  return page.evaluate<{ left: number; top: number; width: number; height: number }>(`(() => {
    const video = [...document.querySelectorAll("video")].find((each) => each.offsetParent);
    const { left, top, width, height } = video.getBoundingClientRect();
    return { left, top, width, height };
  })()`);
}

/** Fills the screen, or goes back to a window. */
async function fullScreen(page: Page, on: boolean): Promise<void> {
  await page.send("Runtime.evaluate", {
    expression: on ? "document.documentElement.requestFullscreen()" : "document.exitFullscreen()",
    awaitPromise: true,
    userGesture: true,
  });
  // The main process tells the window once the system has followed.
  await waitFor(() =>
    page.evaluate<boolean>(
      `(getComputedStyle(document.querySelector("header")).paddingRight === getComputedStyle(document.querySelector("header")).paddingLeft) === ${on}`,
    ),
  );
}

/** Clicks the first element matching `selector` whose text starts with `text`, once it is there. */
async function click(page: Page, selector: string, text: string): Promise<void> {
  const target = `[...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => element.textContent.trim().startsWith(${JSON.stringify(text)}))`;
  await waitFor(() => page.evaluate<boolean>(`!!${target}`));
  await clickExpression(page, target, `Click ${text}`);
}

/** A channel's row in Live TV. */
function row(channel: string): string {
  return `[...document.querySelectorAll("main [role=button]")].find((row) => row.textContent.includes(${JSON.stringify(channel)}))`;
}

/** Watches a channel from Live TV until its picture moves, then goes back to the list. */
async function watch(page: Page, channel: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!${row(channel)}`));
  await clickExpression(page, row(channel), `Watch ${channel}`);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector('[data-view="watch"]')`));
  await waitFor(() => playing(page!));
  await key(page, "Escape", 27);
  await waitFor(() => page.evaluate<boolean>(`!document.querySelector('[data-view="watch"]')`));
}

/** The picture on screen is decoded and moving. */
function playing(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    const video = [...document.querySelectorAll("video")].find((each) => each.offsetParent);
    return !!video && video.videoWidth > 0 && video.currentTime > 1 && !video.paused;
  })()`);
}

/** Opens one of the player's menus by its button's label, with the controls awake. */
async function openMenu(page: Page, label: string): Promise<void> {
  const button = `document.querySelector('[data-view=title] [aria-label=${JSON.stringify(label)}]')`;
  await page.evaluate(
    `document.querySelector("[data-view=title]").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`,
  );
  await waitFor(() => page.evaluate<boolean>(`!!${button}`));
  await clickExpression(page, button, `Open ${label}`);
  await waitFor(() => page.evaluate<boolean>(`!!document.querySelector("[data-item]")`));
}

/** Waits until the window shows every one of these texts. */
async function shows(page: Page, texts: readonly string[]): Promise<void> {
  await waitFor(() =>
    page.evaluate<boolean>(
      `${JSON.stringify(texts)}.every((text) => document.body.innerText.includes(text))`,
    ),
  );
}

/**
 * Writes the window as docs/assets/marketing-<name>.png once it is whole: every image in view
 * matching `pictures` loaded, and with `video`, the picture decoded, which the capture itself must
 * show. `fullScreen` fills the screen for the capture: a page's top bar then keeps no room for the
 * window's buttons, which a capture doesn't show. A player stays in its window, where it keeps the
 * top bar. `holds` is asked once the capture is taken; when it no longer does, nothing is written
 * and the answer is false.
 */
async function capture(
  page: Page,
  name: string,
  wanted: {
    readonly fullScreen?: boolean;
    readonly video?: boolean;
    readonly pictures?: string;
    readonly holds?: () => Promise<boolean>;
  },
): Promise<boolean> {
  if (wanted.fullScreen) await fullScreen(page, true);
  if (wanted.pictures) {
    await waitFor(() =>
      page.evaluate<boolean>(`(() => {
        // Those in view: the app loads the rest once they scroll in.
        const images = [...document.querySelectorAll(${JSON.stringify(wanted.pictures)})].filter(
          (image) => image.getBoundingClientRect().top < innerHeight,
        );
        return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
      })()`),
    );
  }
  // The pointer rests in a corner, over nothing that lights up, while transitions settle.
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 1, y: 1 });
  await delay(600);
  const reply = await page.send("Page.captureScreenshot", { format: "png" });
  if (reply.error) throw new Error(JSON.stringify(reply.error));
  if (wanted.holds && !(await wanted.holds())) return false;
  const box = wanted.video ? await videoBox(page) : null;

  const image = sharp(Buffer.from((reply.result as { data: string }).data, "base64"));
  const { width, height } = await image.metadata();
  const expected = { width: WINDOW.width * SCALE, height: WINDOW.height * SCALE };
  if (width !== expected.width || height !== expected.height) {
    throw new Error(`${name} is ${width} × ${height}, not ${expected.width} × ${expected.height}.`);
  }
  if (box) {
    const left = Math.max(Math.round(box.left * SCALE), 0);
    const top = Math.max(Math.round(box.top * SCALE), 0);
    const stats = await image
      .clone()
      .extract({
        left,
        top,
        width: Math.min(Math.round(box.width * SCALE), expected.width - left),
        height: Math.min(Math.round(box.height * SCALE), expected.height - top),
      })
      .stats();
    // A picture that didn't reach the capture is one flat colour.
    const spread = Math.max(...stats.channels.map((channel) => channel.stdev));
    if (spread < 10) throw new Error(`${name} shows no picture where the video is.`);
  }
  const file = join(assets, `marketing-${name}.png`);
  // Lossless: every pixel as the window drew it, without the alpha channel it never uses.
  await image.removeAlpha().png({ compressionLevel: 9 }).toFile(file);
  await retain(page, name, Buffer.from((reply.result as { data: string }).data, "base64"));
  captures.push({
    name,
    file,
    width,
    height,
    bytes: readFileSync(file).length,
    sha256: hash(readFileSync(file)),
    videoBox: box,
  });
  if (wanted.fullScreen) await fullScreen(page, false);
  console.log(`Wrote ${file}`);
  return true;
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function action(label: string): void {
  console.log(label);
  actions.push({ action: label, at: new Date().toISOString() });
}
/** Pointer input into real rendered controls; never writes app state directly. */
async function clickExpression(page: Page, target: string, label: string): Promise<void> {
  await waitFor(() => page.evaluate<boolean>(`!!(${target}) && !(${target}).disabled`));
  await page.evaluate(`(${target}).scrollIntoView({ block: "nearest" })`);
  const point = await page.evaluate<{ x: number; y: number }>(
    `(() => { const box = (${target}).getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
  );
  action(label);
  for (const type of ["mousePressed", "mouseReleased"])
    await page.send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
}
function cua(tool: string, arguments_: Record<string, unknown>) {
  const result: unknown = JSON.parse(
    execFileSync(
      "/Users/rentamac/.local/bin/cua-driver",
      ["call", tool, JSON.stringify({ session, ...arguments_ })],
      { encoding: "utf8" },
    ),
  );
  if (record(result) && result["isError"]) throw new Error(JSON.stringify(result));
  return result;
}
/** Retains the actual page PNG, accessibility tree and native owned window without altering pixels. */
async function retain(page: Page, name: string, captured?: Buffer): Promise<void> {
  if (!captured) {
    const reply = await page.send("Page.captureScreenshot", { format: "png" });
    if (reply.error) throw new Error(JSON.stringify(reply.error));
    captured = Buffer.from((reply.result as { data: string }).data, "base64");
  }
  writeFileSync(join(evidence, `${name}-raw.png`), captured);
  writeFileSync(
    join(evidence, `${name}-ax.json`),
    JSON.stringify(await page.send("Accessibility.getFullAXTree"), null, 2),
  );
  if (windowId) {
    const native = cua("get_window_state", {
      pid: app?.pid,
      window_id: windowId,
      max_image_dimension: 0,
      include_accessibility_tree: false,
      screenshot_out_file: join(evidence, `${name}-native.png`),
    });
    writeFileSync(join(evidence, `${name}-native.json`), JSON.stringify(native, null, 2));
    const image = sharp(join(evidence, `${name}-native.png`));
    const size = await image.metadata();
    const stats = await image.stats();
    if (
      !size.width ||
      size.width < WINDOW.width - 10 ||
      !size.height ||
      size.height < WINDOW.height - 10 ||
      Math.max(...stats.channels.map((channel) => channel.stdev)) < 10
    )
      throw new Error(`Native ${name} window is incomplete; inspect the retained PNG.`);
  }
}
