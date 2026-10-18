// Smoke test for a built app: connects it to the fake provider through the login form and checks
// who updates the build: the Microsoft Store for an installed MSIX package, which runs from
// WindowsApps, and the app itself for everything else. Then it plays a stream the player decodes
// directly and one the bundled ffmpeg has to convert. Then it leaves Watch for Home and comes
// back, which must keep the one stream rather than open another. Then it plays a movie from
// Movies, which the bundled ffprobe reads and ffmpeg repackages, skips ahead and leaves it. Then
// it shows a movie's PGS subtitles and its DVD subtitles, which the bundled ffmpeg sends beside the
// picture, as stored and as DVB, for the app to draw, and starts it again inside a subtitle and
// between two. Then it shows the movie's French subtitles, which are text, with a class on the
// line that the app's own styles know, and skips past them. Then it asks what the build sends
// playback to: AirPlay on macOS, which takes the helper the app comes with, Google Cast on
// Windows, nothing on Linux. Last, it opens Chromium's and Node.js's notices, which come from
// the credits page the installer must keep. It also opens another movie after the provider
// replaces it with a bounded VP9/AAC clip, and plays converted HLS across a changed epoch with
// CEA-608 captions through the same maintained scenario as source-build verification.
//
//   node test/e2e/packaged-app.ts <app executable> [-- extra app arguments]
//
// Passes when the build names the right updater, both channels show a moving picture with decoded
// sound, Home and Watch share the stream: muted on Home, with sound in Watch, and no second request
// to the provider, and the movie plays with sound, skips 10 seconds and lets go of its connection
// when left, both subtitle tracks draw over the picture while they are due, a subtitle that began
// before the position a run starts from shows once it has loaded and one that ended before it
// doesn't, the text subtitle shows its line in place of the pictures, whatever its class, and no
// longer after a skip past it, the build offers its system's receivers, and both notices have
// text. The app runs with a throwaway profile and remote debugging on a random port; on macOS
// pass --use-mock-keychain so the test never touches a real keychain.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { hlsCompatibilityScenario } from "../../../../.cursor/skills/verify-mrstreamer/scripts/hls-compatibility.ts";
import { fixture, startFakeProvider } from "../fake-provider.ts";
import { startFakeHls } from "../fake-hls.ts";
import { fixtureTools } from "./fixture-tools.ts";
import {
  connect,
  delay,
  fill,
  key,
  launch,
  login,
  openSubscriptions,
  press,
  subscriptionRow,
  waitFor,
  type Page,
} from "./app.ts";

const [executable, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
if (!executable) throw new Error("Usage: node test/e2e/packaged-app.ts <app executable> [-- args]");
const updater = /[\\/]WindowsApps[\\/]/i.test(executable) ? "store" : "direct";
const target =
  process.platform === "darwin"
    ? "mac-arm64"
    : process.platform === "win32"
      ? "win-x64"
      : "linux-x64";
// AppImages unpack resources into a runtime mount. Package jobs retain their exact vendor input.
const toolDirectory = executable.endsWith(".AppImage")
  ? join(import.meta.dirname, "../../vendor/ffmpeg", target)
  : join(
      dirname(executable),
      process.platform === "darwin" ? "../Resources" : "resources",
      "ffmpeg",
    );
const ffmpeg =
  process.env["MR_STREAMER_FFMPEG"] ??
  join(toolDirectory, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

const CHANNELS = ["TEST | H.264 + AAC", "TEST | H.264 + MP2"];
const port = 20000 + Math.floor(Math.random() * 20000);
const profile = mkdtempSync(join(tmpdir(), "mr-streamer-e2e-"));
const evidenceRoot = join(import.meta.dirname, "../../../../.local/verification");
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, "packaged-app-"));
const observed: Record<string, unknown> = {};
const provider = await startFakeProvider({ channels: 60, live: true });
const hls = await startFakeHls({ realtime: true });
const app = launch(executable, rest, { port, profile });

let failed = false;
let openPage: Page | null = null;
try {
  const page = await connect(port);
  openPage = page;
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await login(page, provider);
  const status = await page.evaluate<{ value?: { distribution: string } }>(
    `window.mrStreamer.invoke("updates.status")`,
  );
  const distribution = status.value?.distribution ?? "nothing";
  console.log(
    `${distribution === updater ? "PASS" : "FAIL"} Updates: ${distribution}, for a ${updater} build`,
  );
  failed ||= distribution !== updater;
  for (const channel of CHANNELS) {
    const result = await play(page, channel);
    console.log(`${result.ok ? "PASS" : "FAIL"} ${channel}: ${result.detail}`);
    failed ||= !result.ok;
  }
  const shared = await homeAndBack(page);
  console.log(`${shared.ok ? "PASS" : "FAIL"} Home and Watch share one stream: ${shared.detail}`);
  failed ||= !shared.ok;
  const movie = await playMovie(page);
  console.log(`${movie.ok ? "PASS" : "FAIL"} A movie plays, skips and lets go: ${movie.detail}`);
  failed ||= !movie.ok;
  const subtitles = await pictureSubtitles(page);
  console.log(`${subtitles.ok ? "PASS" : "FAIL"} Subtitles draw: ${subtitles.detail}`);
  failed ||= !subtitles.ok;
  const vp9 = await playVp9Movie(page);
  console.log(`${vp9.ok ? "PASS" : "FAIL"} Replaced VP9 movie plays and skips: ${vp9.detail}`);
  failed ||= !vp9.ok;
  await convertedHls(page);
  console.log(
    "PASS Converted HLS: decoded picture/audio and visible CEA-608 across changed epochs",
  );
  const outputs = await receivers(page);
  console.log(`${outputs.ok ? "PASS" : "FAIL"} Receivers this build plays on: ${outputs.detail}`);
  failed ||= !outputs.ok;
  const notices = await creditsNotices(page);
  console.log(`${notices.ok ? "PASS" : "FAIL"} Chromium's credits open: ${notices.detail}`);
  failed ||= !notices.ok;
  page.close();
} catch (error) {
  console.error(`FAIL ${String(error)}`);
  observed["error"] = String(error);
  if (openPage) {
    try {
      observed["failedView"] = await openPage.evaluate<string>("document.body.innerText");
      await capture(openPage, "failure");
    } catch (captureError) {
      observed["captureError"] = String(captureError);
    }
  }
  failed = true;
} finally {
  observed["hlsRequests"] = [...hls.requests()];
  observed["hlsResources"] = hls.stats();
  app.kill("SIGKILL");
  await hls.close();
  await provider.close();
  await delay(1000);
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  writeFileSync(
    join(evidence, "proof.json"),
    JSON.stringify({ status: failed ? "failed" : "passed", executable, observed }, null, 2),
  );
  console.log(`Packaged smoke evidence: ${evidence}`);
}
process.exit(failed ? 1 : 0);

/** Picks a channel through search and waits for picture and sound. */
async function play(page: Page, channel: string): Promise<{ ok: boolean; detail: string }> {
  await page.evaluate(`document.querySelector('[aria-label="Search"]').click()`);
  await delay(500);
  await page.send("Input.insertText", { text: channel });
  await delay(800);
  await key(page, "Enter", 13);
  const until = Date.now() + 25_000;
  let last = { time: 0, width: 0, audio: 0, title: "" };
  while (Date.now() < until) {
    await delay(250);
    last = await page.evaluate(`(() => {
      const video = document.querySelector("video");
      return {
        time: video?.currentTime ?? 0,
        width: video?.videoWidth ?? 0,
        audio: video?.webkitAudioDecodedByteCount ?? 0,
        title: document.querySelector("h2")?.textContent ?? "",
      };
    })()`);
    if (last.time >= 1 && last.width > 0 && last.audio > 0) {
      return {
        ok: true,
        detail: `picture ${last.width} px wide, ${last.audio} bytes of sound decoded`,
      };
    }
  }
  return {
    ok: false,
    detail: `clock ${last.time.toFixed(2)} s, width ${last.width}, sound ${last.audio} bytes, "${last.title}"`,
  };
}

/** Leaves Watch for Home, where the stream plays on muted, then watches it again from there. */
async function homeAndBack(page: Page): Promise<{ ok: boolean; detail: string }> {
  const requests = provider.streamRequests();
  const state = () =>
    page.evaluate<{ watching: boolean; muted: boolean; playing: boolean }>(`(() => {
      const video = document.querySelector("video");
      return {
        watching: !!document.querySelector('[data-view="watch"]'),
        muted: !!video?.muted,
        playing: !!video && video.isConnected && !video.paused,
      };
    })()`);
  await key(page, "Escape", 27);
  await waitFor(async () => !(await state()).watching, 10_000);
  const home = await state();
  await page.evaluate(
    `[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Watch").click()`,
  );
  await waitFor(async () => (await state()).watching, 10_000);
  await delay(1000);
  const watch = await state();
  const extra = provider.streamRequests() - requests;
  const ok = home.playing && home.muted && watch.playing && !watch.muted && extra === 0;
  return {
    ok,
    detail: `Home ${home.playing ? "playing" : "stopped"}${home.muted ? " muted" : " with sound"}, Watch ${watch.playing ? "playing" : "stopped"}${watch.muted ? " muted" : " with sound"}, ${extra} more stream requests, ${provider.activeStreams()} open`,
  };
}

/** Plays the test movie with two sound tracks from Movies, skips ahead, then leaves it. */
async function playMovie(
  page: Page,
  title = "Two sound tracks",
  captureName?: string,
  expectedWidth?: number,
): Promise<{ ok: boolean; detail: string }> {
  await key(page, "Escape", 27);
  await page.evaluate(
    `[...document.querySelectorAll("header button")].find((b) => b.textContent.trim() === "Movies").click()`,
  );
  // Every movie is in the All movies tab, with or without TMDB's metadata.
  const allTab = `[...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "All movies")`;
  await waitFor(() => page.evaluate<boolean>(`!!${allTab}`), 60_000);
  await page.evaluate(`${allTab}.click()`);
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes(${JSON.stringify(title)}))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`), 60_000);
  await page.evaluate(`${poster}.click()`);
  const play = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => /^(Play|Resume)$/.test(b.textContent.trim()))`;
  await waitFor(() => page.evaluate<boolean>(`!!${play}`), 20_000);
  await page.evaluate(`${play}.click()`);
  const state = () =>
    page.evaluate<{ time: number; width: number; audio: number; frames: number }>(`(() => {
      const video = document.querySelector("video");
      return {
        time: video?.currentTime ?? 0,
        width: video?.videoWidth ?? 0,
        audio: video?.webkitAudioDecodedByteCount ?? 0,
        frames: video?.webkitDecodedFrameCount ?? 0,
      };
    })()`);
  let started = { time: 0, width: 0, audio: 0, frames: 0 };
  const until = Date.now() + 30_000;
  while (Date.now() < until && !(started.time >= 1 && started.width > 0 && started.audio > 0)) {
    await delay(250);
    started = await state();
  }
  if (started.time < 1 || started.audio === 0 || started.frames === 0) {
    return {
      ok: false,
      detail: `clock ${started.time.toFixed(2)} s, sound ${started.audio} bytes`,
    };
  }
  await key(page, "ArrowRight", 39);
  // A skip into what's buffered is instant. Further, a new run starts there, and the element's
  // clock reads 0 until its first picture arrives, about two seconds on a busy machine.
  let skipped = await state();
  const skipUntil = Date.now() + 10_000;
  while (Date.now() < skipUntil && skipped.time < started.time + 9) {
    await delay(250);
    skipped = await state();
  }
  if (captureName) {
    observed[captureName] = { started, skipped };
    await capture(page, captureName);
  }
  await key(page, "Escape", 27);
  await delay(1500);
  const open = provider.activeStreams();
  const ok =
    skipped.time >= started.time + 9 &&
    skipped.frames > 0 &&
    skipped.audio > 0 &&
    open === 0 &&
    (expectedWidth === undefined || started.width === expectedWidth);
  return {
    ok,
    detail: `played to ${started.time.toFixed(1)} s with ${started.audio} bytes of sound, skipped to ${skipped.time.toFixed(1)} s, ${open} connections open after leaving`,
  };
}

/** A previously unopened address makes main probe the actual replacement VP9/AAC bytes. */
async function playVp9Movie(page: Page): Promise<{ ok: boolean; detail: string }> {
  const output = join(profile, "vp9-aac.mp4");
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-stream_loop",
    "-1",
    "-i",
    join(import.meta.dirname, "../fixtures/codecs/vp9-10bit.mp4"),
    "-stream_loop",
    "-1",
    "-i",
    join(import.meta.dirname, "../fixtures/title-h264-eac3-subs.mkv"),
    "-t",
    "24",
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-ac",
    "2",
    "-movflags",
    "+faststart",
    "-y",
    output,
  ];
  const tools = fixtureTools(ffmpeg, profile);
  const made = spawnSync(tools.ffmpeg, args, { encoding: "utf8" });
  if (made.error) throw made.error;
  if (made.status !== 0) throw new Error(`VP9 fixture creation failed: ${made.stderr}`);
  const probe = spawnSync(
    tools.ffprobe,
    [
      "-v",
      "error",
      "-count_frames",
      "-show_entries",
      "stream=codec_type,codec_name,nb_read_frames:format=duration",
      "-of",
      "json",
      output,
    ],
    { encoding: "utf8" },
  );
  if (probe.error) throw probe.error;
  if (probe.status !== 0) throw new Error(`VP9 fixture probe failed: ${probe.stderr}`);
  const source = JSON.parse(probe.stdout) as {
    streams: { codec_type: string; codec_name: string; nb_read_frames: string }[];
    format: { duration: string };
  };
  if (
    !source.streams.some(
      (stream) => stream.codec_name === "vp9" && Number(stream.nb_read_frames) > 0,
    ) ||
    !source.streams.some(
      (stream) => stream.codec_name === "aac" && Number(stream.nb_read_frames) > 0,
    ) ||
    Math.abs(Number(source.format.duration) - 24) > 0.2
  )
    throw new Error("Expected a finite 24-second VP9/AAC fixture");
  const bytes = readFileSync(output);
  const movie = provider.titles.movies.find((each) => each.name.includes("Index at the end"));
  if (!movie) throw new Error("No unopened MP4 movie to replace");
  provider.replaceMovieFile(movie.id, bytes);
  observed["vp9Source"] = {
    source,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    ffmpeg: tools.ffmpeg,
    tools,
    args,
  };
  return playMovie(page, "Index at the end", "vp9-movie", 96);
}

/** Real Settings/M3U connection, then the existing epoch/sound/caption scenario. */
async function convertedHls(page: Page): Promise<void> {
  await openSubscriptions(page);
  await press(page, "Add subscription");
  await press(page, "Use an M3U link");
  await waitFor(
    () => page.evaluate<boolean>("document.querySelectorAll('form input').length === 2"),
    20_000,
  );
  await fill(page, ["HLS compatibility", hls.link]);
  await waitFor(() => page.evaluate<boolean>(`!!${subscriptionRow("HLS compatibility")}`), 30_000);
  await press(page, "Settings");
  await hlsCompatibilityScenario(
    {
      observed,
      evaluate: page.evaluate,
      send: page.send,
      wait: (check, timeout = 30_000) => waitFor(check, timeout),
      exists: (expression) => page.evaluate<boolean>(`!!(${expression})`),
      click: async (label, element) => {
        console.log(label);
        await waitFor(() => page.evaluate<boolean>(`!!(${element})`), 30_000);
        await page.evaluate(`(${element}).click()`);
      },
      key: (name, code) => key(page, name, code),
      capture: (name) => capture(page, name),
    },
    false,
  );
  observed["hlsRequests"] = hls.requests();
  observed["hlsResources"] = hls.stats();
}

async function capture(page: Page, name: string): Promise<void> {
  const shot = await page.send("Page.captureScreenshot", { format: "png" });
  const result = shot.result;
  if (
    !result ||
    typeof result !== "object" ||
    !("data" in result) ||
    typeof result.data !== "string"
  )
    throw new Error("No packaged smoke screenshot");
  writeFileSync(join(evidence, `${name}.png`), Buffer.from(result.data, "base64"));
}

/**
 * Plays the movie with picture subtitles: English PGS from 2 to 4 s, then Dutch DVD subtitles
 * from 8 to 10 s, each chosen under CC. Then, paused, starts it again inside the PGS subtitle from
 * 5 to 7 s, which began before the keyframe at 6 s, and after the DVD subtitle of those seconds.
 * Counts the pixels drawn over the picture. Last, still paused, starts it inside the French text
 * subtitle of those seconds, reads the line on screen, and skips past its end.
 */
async function pictureSubtitles(page: Page): Promise<{ ok: boolean; detail: string }> {
  // The French line gets a WebVTT class that the app's own styles hide things with, which must
  // not hide the line. It is as long as the line it replaces, so nothing else in the file moves.
  const clip = Buffer.from(fixture("title-h264-picture-subs.mkv"));
  clip.write("<c.hidden>Oui", clip.indexOf("Cinq secondes"));
  const movie = provider.titles.movies.find((each) => each.name.includes("Picture subtitles"));
  provider.replaceMovieFile(movie?.id ?? 0, clip);
  await key(page, "Escape", 27);
  await delay(500);
  const poster = `[...document.querySelectorAll("button[title]")].find((b) => b.title.includes("Picture subtitles"))`;
  await waitFor(() => page.evaluate<boolean>(`!!${poster}`), 20_000);
  await page.evaluate(`${poster}.click()`);
  const play = `[...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Play")`;
  await waitFor(() => page.evaluate<boolean>(`!!${play}`), 20_000);
  await page.evaluate(`${play}.click()`);
  const time = () => page.evaluate<number>(`document.querySelector("video")?.currentTime ?? 0`);
  const drawn = () =>
    page.evaluate<number>(`(() => {
      const canvas = document.querySelector("canvas[aria-hidden]");
      const data = canvas?.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 3; index < (data?.length ?? 0); index += 4) if (data[index] > 0) count++;
      return count;
    })()`);
  const choose = async (label: string) => {
    await page.evaluate(
      `document.querySelector("[data-view=title]").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))`,
    );
    const menu = `document.querySelector('[data-view="title"] button[aria-label="Subtitles"]')`;
    const panel = `document.querySelector('aside[aria-label="Subtitle choices"]')`;
    await waitFor(() => page.evaluate<boolean>(`!!${menu}`), 10_000);
    if (!(await page.evaluate<boolean>(`!!${panel}`))) await page.evaluate(`${menu}.click()`);
    const track = `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button[data-item]')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
    await waitFor(() => page.evaluate<boolean>(`!!${track}`), 10_000);
    await page.evaluate(`${track}.click()`);
    // The panel stays open to compare choices. Close it before the next playback key.
    await page.evaluate(`${panel}.querySelector('[aria-label="Close subtitles"]').click()`);
    await waitFor(() => page.evaluate<boolean>(`!${panel}`), 10_000);
  };
  await waitFor(async () => (await time()) > 0.1, 30_000);
  await choose("English");
  await waitFor(async () => (await time()) >= 2.5, 30_000);
  await delay(300);
  const english = await drawn();
  await choose("Nederlands · Forced");
  await waitFor(async () => (await time()) >= 8.5, 30_000);
  await delay(300);
  const dutch = await drawn();
  // Choosing subtitles starts a run where the title is. Paused, at a position within what's
  // loaded, only that run puts anything on screen.
  const startAt = async (position: number, label: string) => {
    // The player follows the position on timeupdate, which a paused seek fires as it lands. A
    // choice made before then starts its run where the title was.
    const before = await page.evaluate<string>(`new Promise((resolve) => {
      const video = document.querySelector("video");
      video.addEventListener("timeupdate", () => resolve(video.src), { once: true });
      video.currentTime = ${position};
    })`);
    await choose(label);
    await waitFor(
      () =>
        page.evaluate<boolean>(`(() => {
          const video = document.querySelector("video");
          return video.src !== ${JSON.stringify(before)} && !video.seeking &&
            video.readyState >= 2 && Math.abs(video.currentTime - ${position}) < 0.1;
        })()`),
      30_000,
    );
    // The picture doesn't wait for the subtitles: the view says they are loading until what was
    // on screen at the position is there.
    await waitFor(
      async () =>
        !(await page.evaluate<boolean>(
          `document.querySelector('[role="status"]')?.textContent === "Subtitles loading"`,
        )),
      15_000,
    );
    await delay(300);
    return drawn();
  };
  await key(page, " ", 32);
  await waitFor(() => page.evaluate<boolean>(`document.querySelector("video").paused`), 10_000);
  const inside = await startAt(6.5, "English");
  const after = await startAt(7.5, "Nederlands · Forced");
  // Text shows as lines over the picture, where the pictures of the track before have gone.
  // What the viewer can read of it: text a style hides isn't part of that.
  const text = () =>
    page.evaluate<string>(`document.querySelector("[data-subtitle-text]")?.innerText ?? ""`);
  const pictures = await startAt(6.5, "Français");
  const french = await text();
  // A skip within what's loaded, still paused: the line ended at 7 s.
  await page.evaluate(`document.querySelector("video").currentTime = 7.5`);
  await waitFor(
    () =>
      page.evaluate<boolean>(
        `!document.querySelector("video").seeking && document.querySelector("video").currentTime === 7.5`,
      ),
    10_000,
  );
  await delay(300);
  const skipped = await text();
  await key(page, "Escape", 27);
  return {
    ok:
      english > 0 &&
      dutch > 0 &&
      inside > 0 &&
      after === 0 &&
      french === "Oui" &&
      pictures === 0 &&
      skipped === "",
    detail: `${english} pixels of PGS at 2.5 s, ${dutch} of DVD subtitles at 8.5 s, ${inside} of PGS in a run from 6.5 s, ${after} of DVD subtitles in a run from 7.5 s, "${french}" as text in a run from 6.5 s with ${pictures} pixels of pictures, "${skipped}" after a skip to 7.5 s`,
  };
}

/**
 * What the build sends playback to, which on macOS takes the helper the app comes with, where the
 * app looks for it. Whether that helper runs, the release workflow checks on the signed build.
 */
async function receivers(page: Page): Promise<{ ok: boolean; detail: string }> {
  const expected =
    process.platform === "darwin" ? ["airplay"] : process.platform === "win32" ? ["cast"] : [];
  const status = await page.evaluate<{ value?: { offers: string[] } }>(
    `window.mrStreamer.invoke("output.status")`,
  );
  const offers = status.value?.offers ?? [];
  return { ok: offers.join() === expected.join(), detail: offers.join(", ") || "none" };
}

/**
 * Opens Chromium's and Node.js's notices as Settings > About does. Both come from Chromium's
 * credits page, which each installer has to keep where the app looks for it.
 */
async function creditsNotices(page: Page): Promise<{ ok: boolean; detail: string }> {
  const opened = await page.evaluate<string[]>(`(async () => {
    const list = await window.mrStreamer.invoke("licences.list");
    if (!list.ok) return [list.error.detail];
    return Promise.all(["Chromium", "Node.js"].map(async (name) => {
      const notice = list.value.find((each) => each.name === name);
      if (!notice) return name + " isn't listed";
      const text = await window.mrStreamer.invoke("licences.text", { id: notice.id });
      return text.ok && text.value.length > 0
        ? name + ", " + text.value.length + " characters"
        : name + ": " + (text.ok ? "empty" : text.error.detail);
    }));
  })()`);
  return { ok: opened.every((each) => each.endsWith(" characters")), detail: opened.join("; ") };
}
