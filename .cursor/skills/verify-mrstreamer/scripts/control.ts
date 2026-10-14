#!/usr/bin/env -S node
// Drives the built Electron app through its window. Fixtures replace only provider and TMDB APIs.
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catchupHlsScenario, catchupScenario } from "./catchup.ts";
import { runDownloads } from "./downloads.ts";
import { homeStageScenario, stageChannel, stageLogo } from "./home-stage.ts";
import { startFakePlaylist } from "../../../../apps/desktop/test/fake-playlist.ts";
import { guideGridScenario, guideGridScrollScenario } from "./guide-grid.ts";
import { homeScenario } from "./home.ts";
import { liveCategoriesScenario, LONG_CATEGORY } from "./live-categories.ts";
import { languageScenario } from "./language.ts";
import {
  electronExecutable,
  evidenceDirectory,
  freePort,
  injectedFailure,
  record,
  stop,
} from "./session.ts";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { startFakeProvider } from "../../../../apps/desktop/test/fake-provider.ts";
import { startFakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { isLocale } from "../../../../packages/contracts/src/language.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const scenarios = [
  "home",
  "home-stage",
  "home-stage-live-only",
  "subscriptions",
  "background-refresh",
  "live-tv",
  "catch-up",
  "catch-up-hls",
  "live-categories",
  "guide-grid",
  "guide-grid-scroll",
  "titles",
  "watchlist",
  "downloads",
  "language",
] as const;
type Scenario = (typeof scenarios)[number];
const [command, selected] = process.argv.slice(2);
if (command === "--help" || !command) {
  console.log(`Usage: pnpm verify:desktop doctor | ${scenarios.join(" | ")}
       pnpm verify:desktop downloads <locale>, as fr-FR: Downloads in another interface language
Run from the repo root, after pnpm install --frozen-lockfile and pnpm build.
On headless Linux: xvfb-run -a pnpm verify:desktop <scenario>
Each scenario owns a fresh app/profile/ports and retains proof in .local/verification/.`);
} else if (command === "doctor") {
  console.log(JSON.stringify(await preflight(), null, 2));
} else if (command === "downloads" && (selected === undefined || isLocale(selected))) {
  const build = await preflight();
  if (!build.display) throw new Error("No display. Use xvfb-run -a pnpm verify:desktop downloads.");
  await runDownloads(build, selected);
} else if (scenarios.some((scenario) => scenario === command) && selected === undefined) {
  await run(command as Scenario);
} else {
  throw new Error("Unknown command. Run pnpm verify:desktop --help.");
}

/** Read-only build/tool checks. Importing Electron itself can download a binary, so resolve its path. */
async function preflight() {
  const executable = await electronExecutable();
  const main = await readFile(join(desktop, "out/main/index.js"));
  await access(join(desktop, "out/renderer/index.html"));
  await access(join(desktop, "test/fixtures/h264-aac.mpegts"));
  const ffmpeg = process.env["MR_STREAMER_FFMPEG"] || "ffmpeg";
  const ffprobe = process.env["MR_STREAMER_FFMPEG"]
    ? join(dirname(ffmpeg), process.platform === "win32" ? "ffprobe.exe" : "ffprobe")
    : "ffprobe";
  const version = (tool: string) =>
    execFileSync(tool, ["-version"], { encoding: "utf8" }).split("\n")[0];
  const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8")) as {
    version: string;
  };
  return {
    executable,
    appVersion: pkg.version,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    mainSha256: createHash("sha256").update(main).digest("hex"),
    ffmpeg: version(ffmpeg),
    ffprobe: version(ffprobe),
    display: process.platform !== "linux" || Boolean(process.env["DISPLAY"]),
  };
}

/** A bounded check that remains interruptible, unlike a retry that swallows cancellation. */
async function until(check: () => Promise<boolean>, signal: AbortSignal, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    if (await check()) return;
    await delay(150, undefined, { signal });
  }
  throw new Error(`Timed out waiting for ${check.toString()}`);
}

async function run(scenario: Scenario) {
  const build = await preflight();
  if (!build.display)
    throw new Error("No display. Use xvfb-run -a pnpm verify:desktop <scenario>.");
  const evidenceRoot = join(root, ".local/verification");
  const evidence = await evidenceDirectory(evidenceRoot, `${scenario}-`);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = {};
  let profile: string | undefined;
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let playlist: Awaited<ReturnType<typeof startFakePlaylist>> | undefined;
  let other: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let releaseGuide: (() => void) | undefined;
  let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
  let app: ChildProcess | undefined;
  let page: Page | undefined;
  let failed: unknown;
  const log: string[] = [];
  try {
    profile = await mkdtemp(join(tmpdir(), "mrstreamer-verify-"));
    const stage = scenario === "home-stage" || scenario === "home-stage-live-only";
    provider = await startFakeProvider({
      channels:
        scenario === "live-categories" ? 64000 : scenario === "guide-grid-scroll" ? 20000 : 60,
      titles: 30,
      live: true,
      ...(scenario === "guide-grid"
        ? {
            guideHours: { past: 6, ahead: 24 },
            // The playable test channels get guides of their own, but for the third.
            channelOf: (channel) =>
              channel.fixture && channel.streamId !== 1002
                ? { ...channel, guideId: channel.guideId ?? `test${channel.streamId}.grid` }
                : channel,
          }
        : {}),
      ...(scenario === "guide-grid-scroll"
        ? {
            guideHours: { past: 24, ahead: 24 },
            // Every second listed channel has a guide channel of its own.
            channelOf: (channel) =>
              channel.fixture || channel.streamId < 2000
                ? channel
                : { ...channel, guideId: channel.streamId % 2 ? null : `grid${channel.streamId}` },
          }
        : {}),
      ...(scenario === "live-categories"
        ? {
            channelOf: (channel) =>
              channel.fixture || channel.streamId < 2000
                ? channel
                : { ...channel, name: `${channel.name} ${channel.streamId}`, guideId: null },
          }
        : {}),
      ...(stage ? { channelOf: stageChannel, logoSvg: stageLogo, adultChannels: true } : {}),
    });
    if (scenario === "live-categories")
      other = await startFakeProvider({ channels: 300, titles: 10, live: true });
    if (scenario === "live-categories")
      provider.serveCategories((all) =>
        all.map((category) =>
          category.id === "1" ? { ...category, name: LONG_CATEGORY } : category,
        ),
      );
    if (scenario === "home-stage-live-only") playlist = await startFakePlaylist();
    if (scenario === "catch-up-hls") {
      playlist = await startFakePlaylist({ catchup: true });
      playlist.nameGuide(true);
    }
    if (scenario === "home-stage")
      other = await startFakeProvider({
        channels: 60,
        titles: 30,
        live: true,
        second: true,
        channelOf: stageChannel,
        logoSvg: stageLogo,
      });
    if (scenario === "background-refresh") releaseGuide = provider.hold("guide").release;
    tmdb = await startFakeTmdb();
    const ownedProfile = profile;
    const ownedTmdb = tmdb;
    let port = 0;
    /**
     * Starts the app on this run's profile, with the system's language `system` as Linux reads
     * it from the environment (English unless a scenario says otherwise), and waits for its
     * window. Scenarios that restart call it again after `quit`.
     */
    const launch = async (system = "en_US") => {
      port = await freePort();
      const args = [
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
        `--user-data-dir=${ownedProfile}`,
        "--enable-automation",
        "--use-mock-keychain",
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        desktop,
      ];
      // Discard ambient test overrides; this run's external services are its own loopback fixtures.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith("MR_STREAMER_") &&
            name !== "ELECTRON_RUN_AS_NODE" &&
            !/^(LANGUAGE|LANG|LC_ALL|LC_MESSAGES)$/.test(name),
        ),
      );
      const started = spawn(build.executable, args, {
        cwd: root,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...env,
          ...(process.env["MR_STREAMER_FFMPEG"]
            ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
            : {}),
          ...(process.platform === "linux" ? { LANGUAGE: system, LANG: `${system}.UTF-8` } : {}),
          MR_STREAMER_UPDATE_CHECKS: "off",
          MR_STREAMER_TMDB_API: ownedTmdb.url,
          MR_STREAMER_TMDB_KEY: "test-key",
        },
      });
      app = started;
      let spawnError: Error | undefined;
      started.on("error", (error) => {
        spawnError = error;
      });
      for (const stream of [started.stdout, started.stderr])
        stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      page = await connect(port);
      if (spawnError) throw spawnError;
      // The CDP target can answer before the renderer's initial navigation finishes.
      await until(
        () =>
          live().evaluate<boolean>(
            `location.href.startsWith(${JSON.stringify(pathToFileURL(join(desktop, "out/renderer/")).href)})`,
          ),
        abort.signal,
      );
      await doctor();
      await send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await send("Network.enable");
      await send("Network.setBlockedURLs", { urls: ["*image.example*", "*image.tmdb.org*"] });
    };
    /** Quits the app as the viewer does, keeping the profile for the next `launch`. */
    const quit = async () => {
      if (app) await stop(app, page);
      page?.close();
      page = undefined;
    };
    const live = () => {
      if (!page) throw new Error("The app isn't running.");
      return page;
    };
    const send = async (method: string, params: Record<string, unknown> = {}) => {
      abort.signal.throwIfAborted();
      const reply = await live().send(method, params);
      if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
      return reply.result;
    };
    const doctor = async () => {
      if (app?.exitCode !== null || app?.signalCode !== null) throw new Error("Owned app exited.");
      const reply = await send("Browser.getBrowserCommandLine");
      if (!record(reply) || !Array.isArray(reply["arguments"]))
        throw new Error("No browser identity.");
      for (const expected of [
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${port}`,
        desktop,
      ]) {
        if (!reply["arguments"].includes(expected))
          throw new Error("CDP belongs to a different app instance.");
      }
      const url = await live().evaluate<string>("location.href");
      if (!url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href))
        throw new Error(`Wrong renderer: ${url}`);
      observed["doctor"] = {
        pid: app?.pid,
        port,
        profile,
        fixturePorts: [
          Number(new URL(provider!.url).port),
          Number(new URL(tmdb!.url).port),
          ...(playlist ? [Number(new URL(playlist.origin).port)] : []),
          ...(other ? [Number(new URL(other.url).port)] : []),
        ],
        url,
        ...build,
      };
    };
    await launch();
    const livePage = {
      evaluate: <T>(expression: string) => live().evaluate<T>(expression),
    };
    const wait = (check: () => Promise<boolean>, timeout?: number) =>
      until(check, abort.signal, timeout);
    const exists = (expression: string) => livePage.evaluate<boolean>(`!!(${expression})`);
    const action = (label: string) => actions.push({ action: label, at: new Date().toISOString() });
    const capture = async (name: string) => {
      // DOM readiness can precede Chromium's paint, especially immediately after a locale switch.
      await livePage.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await delay(200, undefined, { signal: abort.signal });
      const shot = await send("Page.captureScreenshot", { format: "png" });
      if (!record(shot) || typeof shot["data"] !== "string")
        throw new Error("No screenshot returned.");
      await writeFile(join(evidence, `${name}.png`), Buffer.from(shot["data"], "base64"));
      const tree = await send("Accessibility.getFullAXTree");
      await writeFile(join(evidence, `${name}.ax.json`), JSON.stringify(tree, null, 2));
    };
    const click = async (label: string, element: string) => {
      await wait(() => exists(element));
      await livePage.evaluate(`(${element})?.scrollIntoView({ block: "nearest" })`);
      // Popup transitions and late details can move a button after it enters the DOM. Like a
      // viewer, press its painted, enabled control, never coordinates from the initial layout.
      await wait(() =>
        livePage.evaluate<boolean>(`(async () => {
        const target = ${element};
        if (!target?.isConnected || !target.checkVisibility() ||
            target.matches(':disabled, [aria-disabled=true]')) return false;
        for (let parent = target; parent; parent = parent.parentElement)
          if (parent.getAnimations().some(a => a.playState === 'running' || a.pending)) return false;
        const before = target.getBoundingClientRect();
        const inViewport = box => {
          const x = box.x + box.width / 2, y = box.y + box.height / 2;
          return box.width > 0 && box.height > 0 && x >= 0 && x < innerWidth && y >= 0 && y < innerHeight;
        };
        // Late details can push an already scrolled control below the window. Reposition it,
        // then let the next probe require stable geometry and a hit on the control itself.
        if (!inViewport(before)) {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
          return false;
        }
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const after = target.getBoundingClientRect();
        if (!inViewport(after)) {
          target.scrollIntoView({ block: "nearest", inline: "nearest" });
          return false;
        }
        const hit = document.elementFromPoint(after.x + after.width / 2, after.y + after.height / 2);
        return target.isConnected && after.width > 0 && after.height > 0 &&
          ['x', 'y', 'width', 'height'].every(key => Math.abs(before[key] - after[key]) < 0.5) &&
          !!hit && target.contains(hit);
      })()`),
      );
      action(label);
      const point = await livePage.evaluate<{ x: number; y: number }>(`(() => {
        const box = ${element}.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      })()`);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, ...point, button: "left", clickCount: 1 });
      }
    };
    const button = (selector: string, text: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
    const key = async (name: string, code: number) => {
      action(`Press ${name}`);
      const native = name === "Enter" || name === " ";
      await send("Input.dispatchKeyEvent", {
        type: native ? "keyDown" : "rawKeyDown",
        key: name,
        windowsVirtualKeyCode: code,
        ...(native ? { text: name === "Enter" ? "\r" : " " } : {}),
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: name,
        windowsVirtualKeyCode: code,
      });
    };
    await wait(() =>
      livePage.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    );
    await capture("before-connect");
    if (playlist) {
      await click("Use a Live-only M3U link", button("form button", "Use an M3U link"));
      await wait(() =>
        livePage.evaluate<boolean>("document.querySelectorAll('form input').length === 1"),
      );
    }
    for (const [index, value] of (playlist
      ? [playlist.link]
      : [provider.url, "demo", "demo"]
    ).entries()) {
      await click(
        `Fill Connect field ${index + 1} with fixture data`,
        `document.querySelectorAll('form input')[${index}]`,
      );
      await send("Input.insertText", { text: value });
    }
    await click("Submit Connect", "document.querySelector('form button[type=submit]')");
    await wait(() =>
      livePage.evaluate<boolean>(
        "!!document.querySelector('header') && !document.body.innerText.includes('Loading channels')",
      ),
    );
    await capture("connected");
    injectedFailure(scenario);
    if (stage) {
      await homeStageScenario(
        {
          profile,
          observed,
          evaluate: livePage.evaluate,
          send,
          wait,
          exists,
          click,
          key,
          capture,
          action,
          launch,
          quit,
        },
        {
          liveOnly: !!playlist,
          otherUrl: other?.url,
          counts: () => ({
            titleLists: provider!.titleListRequests(),
            details: provider!.detailRequests(),
            files: provider!.fileRequests(),
            tmdbDetails: tmdb!.detailRequests(),
            tmdbAbout: tmdb!.aboutRequests(),
          }),
          streams: () => ({
            requests: provider!.streamRequests(),
            active: provider!.activeStreams(),
          }),
        },
      );
    } else if (scenario === "home") {
      await homeScenario(
        {
          profile,
          observed,
          evaluate: livePage.evaluate,
          send,
          wait,
          exists,
          click,
          key,
          capture,
          action,
          launch,
          quit,
        },
        () => ({
          titleLists: provider!.titleListRequests(),
          details: provider!.detailRequests(),
          files: provider!.fileRequests(),
          tmdbDetails: tmdb!.detailRequests(),
          tmdbAbout: tmdb!.aboutRequests(),
        }),
      );
    } else if (scenario === "background-refresh") {
      await click("Stay on Live TV while the guide waits", button("button", "Watch"));
      await wait(() => exists("document.querySelector('[data-view=watch]')"));
      // Status reads readiness without fetching. Home may already have requested missing lists.
      await wait(() =>
        livePage.evaluate<boolean>(`(async () => {
          const status = await window.mrStreamer.invoke('ondemand.status');
          return status.ok && status.value.lists.length === 1 &&
            status.value.lists[0].fetchedAt !== null;
        })()`),
      );
      observed["titlesReadyBeforeGuideRelease"] = true;
      observed["titleListRequests"] = provider.titleListRequests();
      observed["fileRequests"] = provider.fileRequests();
      observed["detailRequests"] = provider.detailRequests();
      if (
        provider.titleListRequests() !== 4 ||
        provider.fileRequests() !== 0 ||
        provider.detailRequests() !== 0
      )
        throw new Error("Background refresh fetched duplicate lists or eager title files/details.");
      await wait(() =>
        livePage.evaluate<boolean>(`(() => {
          const video = document.querySelector('video');
          return !!video && !video.paused && video.currentTime >= 1 &&
            video.videoWidth > 0 && video.webkitAudioDecodedByteCount > 0;
        })()`),
      );
      observed["playingWithGuideHeld"] = true;
      await capture("titles-ready-guide-held");
      releaseGuide?.();
      releaseGuide = undefined;
      await wait(() =>
        livePage.evaluate<boolean>(`(async () => {
          const status = await window.mrStreamer.invoke('guide.status');
          return status.ok && status.value.some(guide => guide.availability === 'available');
        })()`),
      );
      observed["guideReadyAfterRelease"] = true;
    } else if (scenario === "subscriptions") {
      await click("Open Settings", "document.querySelector('button[aria-label=Settings]')");
      await click("Open Subscriptions", button("nav button", "Subscriptions"));
      await wait(() =>
        livePage.evaluate<boolean>(
          "[...document.querySelectorAll('li')].some(row => row.querySelector('button')?.textContent.includes(' · '))",
        ),
      );
      observed["subscriptionRows"] = await livePage.evaluate<number>(
        "[...document.querySelectorAll('li')].filter(row => row.querySelector('button')?.textContent.includes(' · ')).length",
      );
    } else if (scenario === "language") {
      await languageScenario({
        profile: ownedProfile,
        observed,
        evaluate: (expression) => livePage.evaluate(expression),
        send,
        wait,
        exists,
        click,
        key,
        capture,
        action,
        launch,
        quit,
      });
    } else if (scenario === "live-categories") {
      await liveCategoriesScenario(
        {
          profile,
          observed,
          evaluate: livePage.evaluate,
          send,
          wait,
          exists,
          click,
          key,
          capture,
          action,
          launch,
          quit,
        },
        {
          otherUrl: other!.url,
          refresh: (kind) => {
            provider!.serveCategories((all) =>
              all
                .filter((category) => kind !== "remove" || category.name !== "BE | Entertainment")
                .map((category) =>
                  category.id === "1" ? { ...category, name: LONG_CATEGORY } : category,
                )
                .toReversed(),
            );
            other!.serveCategories((all) =>
              all
                .filter((category) => kind !== "remove" || category.name !== "BE | Entertainment")
                .toReversed(),
            );
          },
          streams: () => ({
            requests: provider!.streamRequests(),
            active: provider!.activeStreams(),
          }),
        },
      );
    } else if (scenario === "catch-up") {
      await catchupScenario(
        {
          profile,
          observed,
          evaluate: livePage.evaluate,
          send,
          wait,
          exists,
          click,
          key,
          capture,
          action,
          launch,
          quit,
        },
        {
          archiveRequests: () => provider!.archiveRequests(),
          breakNextArchive: (pieces) => provider!.breakNextArchive(pieces),
          streams: () => ({
            requests: provider!.streamRequests(),
            active: provider!.activeStreams(),
          }),
        },
      );
    } else if (scenario === "catch-up-hls") {
      await catchupHlsScenario(
        {
          profile,
          observed,
          evaluate: livePage.evaluate,
          send,
          wait,
          exists,
          click,
          key,
          capture,
          action,
          launch,
          quit,
        },
        playlist!,
      );
    } else if (scenario === "guide-grid" || scenario === "guide-grid-scroll") {
      const driver = {
        profile,
        observed,
        evaluate: livePage.evaluate,
        send,
        wait,
        exists,
        click,
        key,
        capture,
        action,
        launch,
        quit,
      };
      if (scenario === "guide-grid")
        await guideGridScenario(driver, {
          streams: () => ({
            requests: provider!.streamRequests(),
            active: provider!.activeStreams(),
          }),
          archiveRequests: () => provider!.archiveRequests(),
        });
      else await guideGridScrollScenario(driver);
    } else if (scenario === "live-tv") {
      await click("Open global Search", "document.querySelector('button[aria-label=Search]')");
      action("Search TEST | H.264 + AAC");
      await send("Input.insertText", { text: "TEST | H.264 + AAC" });
      await wait(() =>
        livePage.evaluate<boolean>(
          "document.querySelector('[aria-label=\"Search results\"] [aria-selected=true]')?.textContent.includes('H.264 + AAC') ?? false",
        ),
      );
      await key("Enter", 13);
      const video = () =>
        livePage.evaluate<{
          time: number;
          width: number;
          audio: number;
          muted: boolean;
          paused: boolean;
          watching: boolean;
        }>(`(() => {
        const v = document.querySelector('video');
        return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0,
          audio: v?.webkitAudioDecodedByteCount ?? 0, muted: v?.muted ?? false,
          paused: v?.paused ?? true, watching: !!document.querySelector('[data-view=watch]') };
      })()`);
      await wait(async () => {
        const v = await video();
        return v.time >= 1 && v.width > 0 && v.audio > 0 && v.watching;
      });
      observed["playback"] = await video();
      await capture("playing");
      const requests = provider.streamRequests();
      await key("Escape", 27);
      await wait(async () => {
        const v = await video();
        return !v.watching && v.muted && !v.paused;
      });
      observed["home"] = await video();
      await capture("home-preview");
      await click("Return through Watch", button("button", "Watch"));
      await wait(async () => {
        const v = await video();
        return v.watching && !v.muted && !v.paused;
      });
      await delay(1000, undefined, { signal: abort.signal });
      observed["additionalStreamRequests"] = provider.streamRequests() - requests;
      if (observed["additionalStreamRequests"] !== 0 || provider.activeStreams() !== 1)
        throw new Error("Home/Watch opened another stream.");
    } else {
      await click("Open Movies", button("header button", "Movies"));
      await click("Open All movies", button("nav button", "All movies"));
      const poster = `[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Two sound tracks'))`;
      await click("Open fixture movie details", poster);
      await wait(() => exists(button('[role="dialog"] button', "Save")));
      await wait(() => exists(button('[role="dialog"] button', "Play")));
      await wait(async () => tmdb!.aboutRequests() >= 1);
      await capture("movie-details");
      if (scenario === "watchlist") {
        await click("Save movie", button('[role="dialog"] button', "Save"));
        await wait(() => exists(button('[role="dialog"] button', "Saved")));
        observed["savedButton"] = true;
        await capture("saved");
        await key("Escape", 27);
        await click("Return Home", button("header button", "Home"));
        await click("Open Watchlist from top navigation", button("header button", "Watchlist"));
        await wait(() =>
          livePage.evaluate<boolean>(
            "document.querySelector('h1')?.textContent === 'Watchlist' && [...document.querySelectorAll('button[title]')].some(b => b.title.includes('Two sound tracks'))",
          ),
        );
        observed["watchlistTitles"] = await livePage.evaluate<string[]>(
          "[...document.querySelectorAll('button[title]')].map(b => b.title)",
        );
      } else {
        await key("Escape", 27);
        await click("Open Series", button("header button", "Series"));
        await click("Open All series", button("nav button", "All series"));
        await click(
          "Open fixture series details",
          `[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Formats'))`,
        );
        await wait(() => exists(button('[role="dialog"] button', "Save")));
        await wait(() =>
          livePage.evaluate<boolean>(
            "[...document.querySelectorAll('[role=dialog] button')].some(b => b.textContent.trim().startsWith('Play'))",
          ),
        );
        await wait(async () => tmdb!.aboutRequests() >= 2);
        observed["tmdbAboutRequests"] = tmdb.aboutRequests();
        if (tmdb.aboutRequests() < 2)
          throw new Error("Movie and series details never reached fixture TMDB.");
      }
    }
    observed["streamRequests"] = provider.streamRequests();
    observed["activeStreams"] = provider.activeStreams();
    const profileFiles = await readdir(profile);
    observed["profileFiles"] = profileFiles;
    if (!profileFiles.includes("mrstreamer.db")) throw new Error("No persisted app database.");
    await capture("result");
    await doctor();
  } catch (error) {
    failed = error;
    if (scenario === "live-categories" && page)
      observed["failedFixtureUi"] = await page
        .evaluate("document.body.innerText")
        .catch(() => "unavailable");
    if (page) {
      const shot = await page
        .send("Page.captureScreenshot", { format: "png" })
        .catch(() => undefined);
      if (record(shot?.result) && typeof shot.result["data"] === "string")
        await writeFile(join(evidence, "failure.png"), Buffer.from(shot.result["data"], "base64"));
    }
  } finally {
    releaseGuide?.();
    const cleanupErrors: string[] = [];
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    };
    if (app) {
      const ownedApp = app;
      await clean(() => stop(ownedApp, page));
    }
    page?.close();
    if (provider) {
      const ownedProvider = provider;
      await clean(() => ownedProvider.close());
      // The provider hears a stream's socket close a moment after the app's process ends.
      for (let i = 0; i < 20 && ownedProvider.activeStreams() !== 0; i++) await delay(100);
      observed["streamsAfterAppExit"] = ownedProvider.activeStreams();
      if (ownedProvider.activeStreams() !== 0)
        cleanupErrors.push("Provider still has active streams after app exit.");
    }
    if (playlist) {
      const ownedPlaylist = playlist;
      await clean(() => ownedPlaylist.close());
    }
    if (other) {
      const ownedOther = other;
      await clean(() => ownedOther.close());
    }
    if (tmdb) {
      const ownedTmdb = tmdb;
      await clean(() => ownedTmdb.close());
    }
    if (profile && (!app || app.exitCode !== null || app.signalCode !== null)) {
      const ownedProfile = profile;
      await clean(() => rm(ownedProfile, { recursive: true, force: true, maxRetries: 5 }));
    }
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (cleanupErrors.length) failed ??= new Error(cleanupErrors.join("\n"));
    await writeFile(join(evidence, "electron.log"), log.join(""));
    await writeFile(
      join(evidence, "proof.json"),
      JSON.stringify(
        {
          scenario,
          build,
          status: failed ? "failed" : "passed",
          actions,
          observed,
          error: failed ? String(failed) : null,
          cleanup: {
            fixturesClosed: cleanupErrors.length === 0,
            appExited: !app || app.exitCode !== null || app.signalCode !== null,
            profileRemoved: profile
              ? await access(profile).then(
                  () => false,
                  () => true,
                )
              : true,
            errors: cleanupErrors,
          },
          limits: [
            "Fake provider/TMDB; no real subscription acceptance",
            "Development build; no installer/update proof",
            "Decoded audio does not prove audible output",
            "No hardware acceleration, TV receiver or performance claim",
            ...(scenario === "catch-up" || scenario === "catch-up-hls"
              ? [
                  scenario === "catch-up"
                    ? "Xtream timeshift only; playlist conventions are covered by apps/desktop/test/catchup.test.ts"
                    : "Playlist Flussonic HLS only; Xtream timeshift is the catch-up scenario",
                ]
              : []),
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failed ? "FAIL" : "PASS"} ${scenario}: ${evidence}`);
    await access(join(evidence, "proof.json"));
  }
  if (failed) throw failed;
}
