// Built-checkout proof through the actual Movies and Downloads UI. System tools on Linux are
// source-build evidence; run installed/bundled acceptance separately on each native platform.
// xvfb-run -a node apps/desktop/test/e2e/title-compatibility.ts [h264-10bit | hevc-12bit | h264-rejected-copy | h264-later-rejection]
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  electronExecutable,
  evidenceDirectory,
  freePort,
  stop,
} from "../../../../.cursor/skills/verify-mrstreamer/scripts/session.ts";
import { fixture, startFakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { connect, key, login, waitFor, type Page } from "./app.ts";

const variant = process.argv[2] ?? "h264-10bit";
if (!["h264-10bit", "hevc-12bit", "h264-rejected-copy", "h264-later-rejection"].includes(variant))
  throw new Error("Unknown fixture");
const executable = await electronExecutable();
const desktop = resolve("apps/desktop");
const evidence = await evidenceDirectory(resolve(".local/verification"), `title-${variant}-`);
const profile = await mkdtemp(join(tmpdir(), "mrstreamer-title-compatibility-"));
const provider = await startFakeProvider({ channels: 60, titles: 30, live: true });
const tmdb = await startFakeTmdb();
const movie = provider.titles.movies.find((each) => each.name.includes("Two sound tracks"))!;
const clip = Buffer.from(
  fixture(`title-${variant.startsWith("h264-") ? "h264-10bit" : variant}.mkv`),
);
if (variant === "h264-rejected-copy") {
  // Invalid AVC configuration profile, valid High 10 SPS/pictures. Copy preserves that invalid
  // MSE codec declaration, while ffmpeg can decode the SPS and produce a valid H.264 stream.
  const configuration = clip.indexOf(Buffer.from([1, 110, 0, 10, 255, 225]));
  if (configuration < 0) throw new Error("Fixture AVC configuration changed");
  clip[configuration + 1] = 255;
}
provider.replaceMovieFile(movie.id, clip);
const port = await freePort();
const args = [
  `--remote-debugging-port=${port}`,
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profile}`,
  "--enable-automation",
  "--use-mock-keychain",
  ...(process.platform === "linux" ? ["--no-sandbox"] : []),
  desktop,
];
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("MR_STREAMER_") && name !== "ELECTRON_RUN_AS_NODE",
  ),
);
const app = spawn(executable, args, {
  detached: process.platform !== "win32",
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...env,
    LANG: "en_US.UTF-8",
    LANGUAGE: "en_US",
    MR_STREAMER_UPDATE_CHECKS: "off",
    MR_STREAMER_TMDB_API: tmdb.url,
    MR_STREAMER_TMDB_KEY: "test-key",
    ...(process.env["MR_STREAMER_FFMPEG"]
      ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
      : {}),
  },
});
const logs: string[] = [];
for (const output of [app.stdout, app.stderr])
  output?.on("data", (data: Buffer) => logs.push(data.toString()));
const observations: Record<string, unknown> = {};
const deliveries: unknown[] = [];
const actions: string[] = [];
let page: Page | undefined;
let failure: string | undefined;
let cleaned = false;
try {
  page = await connect(port, "page", { app });
  const live = page;
  const doctor = async () => {
    if (app.exitCode !== null || app.signalCode !== null) throw new Error("Owned app exited");
    const reply = await live.send("Browser.getBrowserCommandLine");
    const command = reply.result as { arguments?: string[] } | undefined;
    if (
      ![desktop, `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`].every((part) =>
        command?.arguments?.includes(part),
      )
    )
      throw new Error("Wrong app identity");
    const url = await live.evaluate<string>("location.href");
    if (!url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href))
      throw new Error("Wrong renderer");
    observations["identity"] = {
      pid: app.pid,
      port,
      profile,
      executable,
      url,
      mainSha256: createHash("sha256")
        .update(await readFile(join(desktop, "out/main/index.js")))
        .digest("hex"),
    };
  };
  await doctor();
  await live.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await live.send("Media.enable");
  const media: unknown[] = [];
  live.on("Media.playerPropertiesChanged", (event) => media.push(event));
  live.on("Media.playerEventsAdded", (event) => media.push(event));
  observations["chromiumMedia"] = media;
  await live.send("Network.enable");
  await live.send("Network.setBlockedURLs", { urls: ["*image.example*", "*image.tmdb.org*"] });
  live.on("Network.responseReceived", (event) => {
    const response = (
      event as { response: { url: string; status: number; headers: Record<string, string> } }
    ).response;
    const url = new URL(response.url);
    if (url.pathname.startsWith("/title/") && !url.searchParams.has("only"))
      deliveries.push({ query: url.search, status: response.status, headers: response.headers });
  });
  await live.evaluate(
    `window.__compatibility = { checks: [], errors: [] }; const original = MediaSource.isTypeSupported.bind(MediaSource); MediaSource.isTypeSupported = (type) => { const supported = original(type); window.__compatibility.checks.push({ type, supported }); return supported; }; document.addEventListener('error', e => { if (e.target instanceof HTMLVideoElement) window.__compatibility.errors.push({ code: e.target.error?.code, message: e.target.error?.message, time: e.target.currentTime }); }, true);`,
  );
  await live.evaluate(
    `const add = MediaSource.prototype.addSourceBuffer; MediaSource.prototype.addSourceBuffer = function(type) { const buffer = add.call(this, type); window.__compatibility.buffer = buffer; return buffer; };`,
  );
  await login(live, provider);
  const click = async (description: string, expression: string) => {
    await waitFor(() => live.evaluate<boolean>(`!!(${expression})`), 30_000);
    const rect = await live.evaluate<{ x: number; y: number }>(
      `(() => { const r = (${expression}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await live.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...rect,
      button: "left",
      clickCount: 1,
    });
    await live.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...rect,
      button: "left",
      clickCount: 1,
    });
    actions.push(description);
  };
  const shot = async (name: string) => {
    const result = await live.send("Page.captureScreenshot", { format: "png" });
    const png = (result.result as { data?: string } | undefined)?.data;
    if (!png) throw new Error("Missing screenshot");
    await writeFile(join(evidence, `${name}.png`), Buffer.from(png, "base64"));
    await writeFile(
      join(evidence, `${name}.ax.json`),
      JSON.stringify(await live.send("Accessibility.getFullAXTree"), null, 2),
    );
  };
  const video = () =>
    live.evaluate<{
      time: number;
      width: number;
      audio: number;
      audioEnergy: number;
      frames: number;
      paused: boolean;
      same: boolean;
    }>(
      `(() => { const v = document.querySelector('video');
    let energy = 0;
    if (v && v.readyState >= 2) {
      const proof = window.__compatibility;
      if (proof.audioNode !== v) {
        proof.audioNode = v;
        proof.audioContext?.close();
        const stream = v.captureStream();
        if (stream.getAudioTracks().length) {
          const context = new AudioContext();
          const analyser = context.createAnalyser();
          context.createMediaStreamSource(stream).connect(analyser);
          const muted = context.createGain(); muted.gain.value = 0;
          analyser.connect(muted).connect(context.destination);
          proof.audioContext = context; proof.analyser = analyser;
          context.resume();
        }
      }
      if (proof.analyser) {
        const samples = new Float32Array(proof.analyser.fftSize);
        proof.analyser.getFloatTimeDomainData(samples);
        energy = samples.reduce((sum, value) => sum + value * value, 0);
      }
    }
    return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, audio: v?.webkitAudioDecodedByteCount ?? 0, audioEnergy: energy, frames: v?.getVideoPlaybackQuality().totalVideoFrames ?? 0, paused: v?.paused ?? true, same: !window.__compatibility.node || window.__compatibility.node === v }; })()`,
    );
  const moving = () =>
    waitFor(async () => {
      const v = await video();
      return (
        !v.paused && v.time > 1 && v.width > 0 && (v.audio > 0 || v.audioEnergy > 0) && v.frames > 1
      );
    }, 30_000);
  await click(
    "Movies",
    `[...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Movies')`,
  );
  await click(
    "All movies",
    `[...document.querySelectorAll('nav button')].find(b => b.textContent.trim() === 'All movies')`,
  );
  await click(
    "Two sound tracks details",
    `[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Two sound tracks'))`,
  );
  await click(
    "Download exact high-depth file",
    `[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Download')`,
  );
  await waitFor(
    () =>
      live.evaluate<boolean>(
        `[...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim() === 'Watch offline')`,
      ),
    30_000,
  );
  await click(
    "Play provider file",
    `[...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Play')`,
  );
  await moving();
  observations["onlineDecoded"] = await video();
  await live.evaluate("window.__compatibility.node = document.querySelector('video')");
  await shot("online-recovered");
  if (variant === "h264-later-rejection") {
    await key(live, " ", 32);
    await waitFor(async () => (await video()).paused);
    const position = (await video()).time;
    for (const fallback of ["sound=convert", "picture=convert"]) {
      const before = deliveries.length;
      // This invokes the real MSE parser with an impossible ISO box size. No engine method or
      // synthetic media error is involved. The browser's MediaError must drive recovery.
      await live.evaluate(
        `window.__compatibility.buffer.appendBuffer(new Uint8Array([0, 0, 0, 4, 109, 111, 111, 102]));`,
      );
      await waitFor(async () =>
        deliveries.slice(before).some((entry) => JSON.stringify(entry).includes(fallback)),
      );
      await waitFor(async () => {
        const v = await video();
        return v.paused && v.time >= position - 0.1 && v.frames > 1;
      });
      observations[`later-${fallback}`] = await video();
    }
    observations["actualLaterRejections"] = await live.evaluate("window.__compatibility.errors");
    await shot("later-recovered-paused");
    const held = await video();
    await key(live, " ", 32);
    await waitFor(async () => {
      const resumed = await video();
      return (
        !resumed.paused &&
        resumed.time > held.time + 0.25 &&
        resumed.frames > held.frames &&
        resumed.audio > held.audio
      );
    });
  }

  await key(live, " ", 32);
  await waitFor(async () => (await video()).paused);
  await key(live, "ArrowRight", 39);
  await waitFor(async () => {
    const v = await video();
    return v.paused && v.time > 10 && v.width > 0;
  });
  observations["pausedSeek"] = await video();
  await click("Sound", `document.querySelector('[aria-label=Sound]')`);
  await click(
    "Other audio track while paused",
    `[...document.querySelectorAll('[role=dialog] button[aria-pressed=false], [role=dialog] [role=menuitemradio][aria-checked=false]')][0]`,
  );
  await waitFor(async () => {
    const v = await video();
    return v.paused && v.time > 10 && v.width > 0;
  });
  observations["pausedOtherTrack"] = await video();
  await key(live, "p", 80);
  await waitFor(() => live.evaluate<boolean>("!!document.querySelector('[data-mini]')"));
  if (!(await video()).same) throw new Error("Mini player replaced media node");
  await shot("mini-paused");
  await key(live, "p", 80);
  await waitFor(() => live.evaluate<boolean>("!document.querySelector('[data-mini]')"));
  await key(live, "f", 70);
  await waitFor(() => live.evaluate<boolean>("!!document.fullscreenElement"));
  if (!(await video()).same) throw new Error("Fullscreen replaced media node");
  await shot("fullscreen-paused");
  await key(live, "f", 70);
  await waitFor(() => live.evaluate<boolean>("!document.fullscreenElement"));
  const held = await video();
  await key(live, " ", 32);
  await waitFor(async () => {
    const resumed = await video();
    return (
      !resumed.paused &&
      resumed.time > held.time + 0.25 &&
      resumed.frames > held.frames &&
      resumed.audio > held.audio
    );
  });
  observations["resumed"] = await video();
  await key(live, "Escape", 27);
  await waitFor(() => live.evaluate<boolean>("!document.querySelector('[data-view=title]')"));
  await waitFor(async () => provider.activeStreams() === 0);
  observations["oneReader"] = {
    most: provider.mostFilesAtOnce(),
    active: provider.activeStreams(),
  };
  if (provider.mostFilesAtOnce() > 1) throw new Error("Overlapping provider readers");
  // Leaving playback returns to details, and leaving details can return to its collection.
  for (let back = 0; back < 3; back++) {
    if (
      await live.evaluate<boolean>(
        `[...document.querySelectorAll('header button')].some(b => b.textContent.trim() === 'Downloads')`,
      )
    )
      break;
    await key(live, "Escape", 27);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const requests = provider.fileRequests();
  await provider.close();
  await tmdb.close();
  await click(
    "Downloads",
    `[...document.querySelectorAll('header button')].find(b => b.textContent.trim() === 'Downloads')`,
  );
  await click(
    "Watch offline with provider closed",
    `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Watch offline')`,
  );
  await moving();
  observations["offlineDecoded"] = await video();
  observations["offlineProviderRequests"] = provider.fileRequests() - requests;
  if (provider.fileRequests() !== requests) throw new Error("Offline copy requested provider");
  await shot("offline-recovered");
  const checks = await live.evaluate<{
    checks: { type: string; supported: boolean }[];
    errors: unknown[];
  }>("({ checks: window.__compatibility.checks, errors: window.__compatibility.errors })");
  observations["actualMse"] = checks;
  if (
    variant === "h264-rejected-copy" &&
    !checks.checks.some((check) => !check.supported && check.type.toLowerCase().includes("avc1.ff"))
  )
    throw new Error("No actual invalid copied AVC configuration rejection observed");
  if (
    variant === "h264-rejected-copy" &&
    !deliveries.some((entry) => JSON.stringify(entry).includes('"x-title-video":"convert"'))
  )
    throw new Error("No converted response observed");
  await doctor();
  await shot("complete");
} catch (error) {
  failure = String(error);
  if (page)
    observations["actualMseAtFailure"] = await page
      .evaluate(
        "({ checks: window.__compatibility?.checks, errors: window.__compatibility?.errors })",
      )
      .catch(() => null);
  if (page) {
    const shot = await page.send("Page.captureScreenshot", { format: "png" }).catch(() => null);
    const data = (shot?.result as { data?: string } | undefined)?.data;
    if (data) await writeFile(join(evidence, "failure.png"), Buffer.from(data, "base64"));
  }
} finally {
  try {
    await stop(app, page);
    page?.close();
    await provider.close();
    await tmdb.close();
    await rm(profile, { recursive: true, force: true });
    cleaned = true;
  } catch (error) {
    failure = `${failure ?? ""} cleanup: ${error}`;
  }
  await writeFile(join(evidence, "electron.log"), logs.join(""));
  await writeFile(
    join(evidence, "proof.json"),
    JSON.stringify(
      {
        status: failure ? "failed" : "passed",
        variant,
        failure,
        actions,
        observations,
        deliveries,
        cleanup: { cleaned, exitCode: app.exitCode, signal: app.signalCode },
        limits: [
          "Built checkout, system tools, Linux/Xvfb when used",
          "No installed/native bundled, HDR or audible-output acceptance",
          "HEVC may convert directly when the platform rejects the initial family probe",
        ],
      },
      null,
      2,
    ),
  );
  console.log(evidence);
}
if (failure) throw new Error(failure);
