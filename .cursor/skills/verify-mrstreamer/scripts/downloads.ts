// The downloads scenario of `pnpm verify:desktop`: the built app, started three times on one
// profile, driven through its window. It downloads a movie and an episode from their details,
// gives a running download's connection to playback of the same subscription, cancels, retries
// and deletes through the Downloads page, then plays a copy offline: seeking, changing its sound
// track, leaving and resuming. The second start has the fake provider, TMDB and picture server
// stopped; the subscription is removed there, and the third start plays both copies from the
// Connect screen's Downloads with no subscription saved, then opens a copy whose file it removed
// and returns to the page, which must say it is missing. Along the way the top bar's notice is read
// as it says how the downloads stand, pressed with the pointer, Enter and Space, from a playing
// title and Watch too, and laid out at 960 and 760 CSS px, where every page's name must still
// fit. Main's outbound connections are recorded
// by network-hook.cjs, the window's requests over CDP, and each local playback window must have
// none but the window's own loopback proxy requests. It runs in the interface language it is
// given, English unless asked for another, by starting the app on a system in that language:
// what it looks for is the catalogue's text in it, so untranslated text fails the run.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { SOURCE_LOCALE, type Locale } from "../../../../packages/contracts/src/language.ts";
import { setLanguage, t } from "../../../../packages/core/src/i18n.ts";
import { episodeLabel } from "../../../../packages/core/src/ondemand/names.ts";
import {
  startFakeProvider,
  type FakeProvider,
} from "../../../../apps/desktop/test/fake-provider.ts";
import { startFakeTmdb, type FakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { evidenceDirectory, injectedFailure, freePort, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const hook = fileURLToPath(new URL("./network-hook.cjs", import.meta.url));

/** One connection a main process made, as network-hook.cjs wrote it. */
interface Connection {
  readonly at: number;
  readonly kind: "tcp" | "udp" | "ipc" | "artwork";
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
}

/** A request the window made, as CDP said it. */
interface WindowRequest {
  readonly at: number;
  readonly url: string;
}

export async function runDownloads(
  build: Record<string, unknown> & { executable: string },
  locale: Locale = SOURCE_LOCALE,
) {
  // The text expected below, in the language the app shows.
  setLanguage({ locale, formats: locale });
  const evidenceRoot = join(root, ".local/verification");
  const evidence = await evidenceDirectory(
    evidenceRoot,
    locale === SOURCE_LOCALE ? "downloads-" : `downloads-${locale}-`,
  );
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = { build, locale };
  const log: string[] = [];
  const networkLog = join(evidence, "main-network.jsonl");
  const windowRequests: WindowRequest[] = [];
  let profile: string | undefined;
  let provider: FakeProvider | undefined;
  let tmdb: FakeTmdb | undefined;
  let pictures: Server | undefined;
  /** The started app, owned from spawn on; its page only once CDP answers. */
  let running: { app: ChildProcess; page?: Page } | undefined;
  let failed: unknown;
  const cleanupErrors: string[] = [];
  try {
    profile = await mkdtemp(join(tmpdir(), "mrstreamer-verify-"));
    provider = await startFakeProvider({ channels: 20, titles: 10, live: true });
    tmdb = await startFakeTmdb();
    pictures = await pictureServer();
    const picturesUrl = `http://127.0.0.1:${(pictures.address() as AddressInfo).port}`;
    const fixturePorts = [provider.url, tmdb.url, picturesUrl].map((url) =>
      Number(new URL(url).port),
    );
    observed["fixturePorts"] = fixturePorts;
    /** Each start's own process, debugging port, profile and renderer, as checked. */
    const starts: Record<string, unknown>[] = [];
    observed["starts"] = starts;

    /** Starts the app on the run's profile, its main process recorded, and checks it is ours. */
    const start = async (label: string) => {
      const port = await freePort();
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !name.startsWith("MR_STREAMER_") &&
            name !== "ELECTRON_RUN_AS_NODE" &&
            name !== "NODE_OPTIONS" &&
            !/^(LANGUAGE|LANG|LC_ALL|LC_MESSAGES)$/.test(name),
        ),
      );
      // The system's language, as Linux reads it: System default shows the app in `locale`.
      const system = locale.replace("-", "_");
      const app = spawn(
        build.executable,
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
            ...(process.env["MR_STREAMER_FFMPEG"]
              ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
              : {}),
            LANGUAGE: system,
            LANG: `${system}.UTF-8`,
            MR_STREAMER_UPDATE_CHECKS: "off",
            MR_STREAMER_TMDB_API: tmdb!.url,
            MR_STREAMER_TMDB_KEY: "test-key",
            NODE_OPTIONS: `--require ${JSON.stringify(hook).slice(1, -1)}`,
            VERIFY_NETWORK_LOG: networkLog,
            VERIFY_IMAGES: picturesUrl,
          },
        },
      );
      running = { app };
      for (const stream of [app.stdout, app.stderr])
        stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      // A spawn error or an interrupt ends the wait for the window as the run's failure.
      const page = await Promise.race([
        connect(port),
        new Promise<never>((_, reject) => {
          app.on("error", reject);
          abort.signal.addEventListener("abort", () => reject(abort.signal.reason), {
            once: true,
          });
        }),
      ]);
      running = { app, page };
      const command = await page.send("Browser.getBrowserCommandLine");
      const args = record(command.result) ? command.result["arguments"] : null;
      if (
        !Array.isArray(args) ||
        !args.includes(`--user-data-dir=${profile}`) ||
        !args.includes(desktop)
      )
        throw new Error("CDP belongs to a different app instance.");
      const url = await page.evaluate<string>("location.href");
      if (!url.startsWith(pathToFileURL(join(desktop, "out/renderer/")).href))
        throw new Error(`Wrong renderer: ${url}`);
      starts.push({ label, pid: app.pid, port, profile, renderer: url, at: now() });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Network.enable");
      page.on("Network.requestWillBeSent", (params) => {
        if (record(params) && record(params["request"]))
          windowRequests.push({ at: Date.now(), url: String(params["request"]["url"]) });
      });
      actions.push({ action: `Start the app (${label}) on the run's profile`, at: now() });
      return driver(page);
    };

    const quit = async (label: string) => {
      if (!running) return;
      actions.push({ action: `Quit the app (${label})`, at: now() });
      await stop(running.app, running.page);
      running.page?.close();
      running = undefined;
    };

    /** Window driving with real pointer and key input; observations read the DOM. */
    const driver = (page: Page) => {
      const wait = async (check: () => Promise<boolean>, timeout = 30_000) => {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          abort.signal.throwIfAborted();
          if (await check().catch(() => false)) return;
          await delay(150, undefined, { signal: abort.signal });
        }
        throw new Error(`Timed out waiting for ${check.toString()}`);
      };
      const exists = (expression: string) => page.evaluate<boolean>(`!!(${expression})`);
      const capture = async (name: string) => {
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        if (!record(shot.result) || typeof shot.result["data"] !== "string")
          throw new Error("No screenshot returned.");
        await writeFile(join(evidence, `${name}.png`), Buffer.from(shot.result["data"], "base64"));
        const tree = await page.send("Accessibility.getFullAXTree");
        await writeFile(join(evidence, `${name}.ax.json`), JSON.stringify(tree.result, null, 2));
      };
      const click = async (label: string, element: string) => {
        await wait(() => exists(element));
        actions.push({ action: label, at: now() });
        await page.evaluate(`${element}.scrollIntoView({ block: "nearest" })`);
        const point = await page.evaluate<{ x: number; y: number }>(`(() => {
          const box = ${element}.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        })()`);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await page.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            clickCount: 1,
          });
        }
      };
      const key = async (name: string, code: number) => {
        actions.push({ action: `Press ${name}`, at: now() });
        for (const type of ["rawKeyDown", "keyUp"])
          await page.send("Input.dispatchKeyEvent", {
            type,
            key: name,
            code: name,
            windowsVirtualKeyCode: code,
          });
      };
      /** Enter or Space as a keyboard sends it, with its character, which presses a focused button. */
      const press = async (name: "Enter" | " ") => {
        actions.push({ action: `Press ${name === " " ? "Space" : name}`, at: now() });
        const which =
          name === " "
            ? { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " }
            : { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" };
        await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...which });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...which });
      };
      /** Tab, as the viewer presses it, until `element` has the keyboard. */
      const tabTo = async (label: string, element: string) => {
        for (let tabs = 0; tabs < 150; tabs++) {
          if (await exists(`(${element}) === document.activeElement`)) {
            actions.push({ action: `${label} (${tabs} Tab presses)`, at: now() });
            return;
          }
          await page.send("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Tab",
            code: "Tab",
            windowsVirtualKeyCode: 9,
          });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab" });
        }
        throw new Error(`Tab never reached ${element}`);
      };
      const text = (selector = "body") =>
        page.evaluate<string>(
          `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`,
        );
      const video = () =>
        page.evaluate<{
          time: number;
          width: number;
          audio: number;
          paused: boolean;
          title: boolean;
        }>(`(() => {
          const v = document.querySelector('video');
          return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0,
            audio: v?.webkitAudioDecodedByteCount ?? 0, paused: v?.paused ?? true,
            title: !!document.querySelector('[data-view=title]') };
        })()`);
      /** Main's list, read as the window reads it: an observation, never a change. */
      const listed = () =>
        page.evaluate<
          {
            id: string;
            name: string;
            status: { kind: string };
            subscription: { id: string } | null;
            progress: { position: number; duration: number } | null;
            posterUrl: string | null;
            title: { kind: "movie" | "episode"; id: string };
          }[]
        >("window.mrStreamer.invoke('downloads.list').then(r => r.ok ? r.value.items : [])");
      return { page, wait, exists, capture, click, key, press, tabTo, text, video, listed };
    };
    type Driver = ReturnType<typeof driver>;

    const button = (selector: string, words: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const labelled = (label: string) =>
      `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
    const poster = (words: string) =>
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(words)}))`;
    const row = (id: string) => `document.querySelector('[data-download="${id}"]')`;
    /** The top bar's notice in `scope`'s bar: Downloads beside Search, named with how they stand. */
    const notice = (scope = "header") =>
      `document.querySelector(${JSON.stringify(`${scope} [aria-label^="${t("Downloads, {status}", { status: "" })}"]`)})`;
    /** The bar as it is laid out: the pages' names, and each Downloads control beside Search. */
    const barOf = (d: Driver) =>
      d.page.evaluate<{
        pages: string[];
        /** Whether the pages' names overflow the room they have, or a control of the bar is cut. */
        clipped: boolean;
        /** Whether a control of the bar reaches past the bar or the window. */
        overflows: boolean;
        /** The pages' room in the bar, and what their names take of it, in CSS px. */
        room: number;
        needs: number;
        downloads: { text: string; label: string | null; current: string | null; width: number }[];
      }>(`(() => {
        const bar = document.querySelector('header');
        const label = ${JSON.stringify(t("Downloads"))};
        return {
          pages: [...bar.querySelectorAll('nav button')].map(b => b.textContent.trim()),
          clipped: (n => !!n && n.scrollWidth > n.clientWidth)(bar.querySelector('nav')) ||
            [...bar.querySelectorAll('button')].some(b => (r => (p => r.left < p.left - 0.5 || r.right > p.right + 0.5)(b.parentElement.getBoundingClientRect()))(b.getBoundingClientRect())),
          overflows: bar.scrollWidth > bar.clientWidth || [...bar.querySelectorAll('button')]
            .some(b => (r => r.left < 0 || r.right > innerWidth)(b.getBoundingClientRect())),
          room: bar.querySelector('nav')?.clientWidth ?? 0,
          needs: (n => n && n.children.length
            ? n.lastElementChild.getBoundingClientRect().right - n.firstElementChild.getBoundingClientRect().left
            : 0)(bar.querySelector('nav')),
          downloads: [...bar.querySelectorAll('button')]
            .filter(b => b.getAttribute('aria-label')?.startsWith(label))
            .map(b => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'),
              current: b.getAttribute('aria-current'), width: b.getBoundingClientRect().width })),
        };
      })()`);
    const noticeSays = (d: Driver, scope?: string) =>
      d.page.evaluate<string | null>(`(${notice(scope)})?.textContent.trim() ?? null`);
    const onDownloadsPage = (d: Driver) =>
      d.exists(`document.querySelector('h1')?.textContent === ${JSON.stringify(t("Downloads"))}`);
    const notices: Record<string, unknown> = {};
    observed["notice"] = notices;
    type Bar = Awaited<ReturnType<typeof barOf>>;
    /** Fails the run where the bar cuts a page's name or a control, or says other than `says`. */
    const fits = (where: string, bar: Bar, says?: (label: string) => boolean) => {
      if (bar.clipped || bar.overflows)
        throw new Error(`The bar doesn't fit ${where}: ${JSON.stringify(bar)}`);
      if (says && !(bar.downloads.length === 1 && says(bar.downloads[0]!.label ?? "")))
        throw new Error(
          `The bar doesn't say how the downloads stand ${where}: ${JSON.stringify(bar)}`,
        );
      return bar;
    };
    const named = (status: string) => (label: string) =>
      label === t("Downloads, {status}", { status });
    const percent = (label: string) => /\d/.test(label);
    /** Lays the window out `width` CSS px wide, as a narrow or zoomed window has it, or as it is. */
    const layOut = async (d: Driver, width: number | null) => {
      if (width === null) await d.page.send("Emulation.clearDeviceMetricsOverride");
      else
        await d.page.send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 720,
          deviceScaleFactor: 1,
          mobile: false,
        });
      actions.push({
        action:
          width === null
            ? "Lay the window out at its own width"
            : `Lay the window out ${width} CSS px wide`,
        at: now(),
      });
    };
    /** The bar once it stopped folding: the same read twice, a few frames apart. */
    const settledBar = async (d: Driver) => {
      let bar = await barOf(d);
      await d.wait(async () => {
        await delay(250, undefined, { signal: abort.signal });
        const next = await barOf(d);
        const same = JSON.stringify(next) === JSON.stringify(bar);
        bar = next;
        return same;
      });
      return bar;
    };
    /**
     * The bar at the window's least width and at 760 CSS px, below it: each must fit every page's
     * name and say how the downloads stand. Then the window's own width again, with every name.
     */
    const atWidths = async (d: Driver, name: string, says: (label: string) => boolean) => {
      const bars: Record<number, Bar> = {};
      for (const width of [960, 760]) {
        await layOut(d, width);
        bars[width] = fits(`${name} at ${width} CSS px`, await settledBar(d), says);
        await d.capture(`notice-${name}-${width}`);
      }
      await layOut(d, null);
      await d.wait(async () => (await barOf(d)).pages.includes(t("Downloads")));
      notices[`${name}AtWidths`] = bars;
    };
    /** The id of the download of a provider's title, as main lists it. */
    const idOf = async (d: Driver, kind: "movie" | "episode", id?: number) => {
      const found = (await d.listed()).find(
        (item) => item.title.kind === kind && (id === undefined || item.title.id === String(id)),
      );
      if (!found) throw new Error(`No download of ${kind} ${id ?? ""}`);
      return found.id;
    };

    /** Plays a copy from its row on the Downloads page, and proves a moving picture. */
    const watchOffline = async (d: Driver, id: string, label: string) => {
      await d.click(label, `(${row(id)})?.querySelector('button')`);
      await d.wait(async () => {
        const v = await d.video();
        return v.title && !v.paused && v.width > 0 && v.time > 0.5;
      }, 45_000);
    };

    // 1. Online: connect, then download a movie and an episode from their details.
    const online = await start("online");
    await online.wait(() =>
      online.page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    );
    for (const [index, value] of [provider.url, "demo", "demo"].entries()) {
      await online.click(
        `Fill Connect field ${index + 1}`,
        `document.querySelectorAll('form input')[${index}]`,
      );
      await online.page.send("Input.insertText", { text: value });
    }
    await online.click("Submit Connect", "document.querySelector('form button[type=submit]')");
    await online.wait(() => online.exists("document.querySelector('header')"));
    // Every word the visible notice says, as the window draws it: an observation, never a change.
    await online.page.evaluate(`(() => {
      const said = window.__noticeSaid = [];
      const read = () => {
        const shown = [...document.querySelectorAll(${JSON.stringify(`header [aria-label^="${t("Downloads, {status}", { status: "" })}"]`)})]
          .find(n => n.checkVisibility());
        const text = shown ? shown.textContent.trim() : null;
        if (said.at(-1)?.text !== text) said.push({ at: Date.now(), text });
      };
      new MutationObserver(read).observe(document.body,
        { subtree: true, childList: true, characterData: true, attributes: true });
    })()`);
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.click("Open All movies", button("nav button", t("All movies")));
    await online.click("Open the two-sound-track movie", poster("Two sound tracks"));
    await online.click("Download the movie", button('[role="dialog"] button', t("Download")));
    await online.wait(
      () => online.exists(button('[role="dialog"] button', t("Watch offline"))),
      60_000,
    );
    await online.capture("movie-downloaded");
    injectedFailure("downloads");
    await online.key("Escape", 27);

    await online.click("Open Series", button("header button", t("Series")));
    await online.click("Open All series", button("nav button", t("All series")));
    await online.click("Open the Formats series", poster("Formats"));
    await online.click(
      "Download S1 E2",
      labelled(t("Download {title}", { title: episodeLabel(1, 2) })),
    );
    await online.wait(
      () => online.exists(labelled(t("Watch {title} offline", { title: episodeLabel(1, 2) }))),
      60_000,
    );
    await online.capture("episode-downloaded");
    await online.key("Escape", 27);

    // 2. Playback of the same subscription takes a running download's connection.
    const slow = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Long subtitles"),
    )!;
    provider.stallMovieFile(slow.id, 40_000, 20_000);
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.click("Open All movies", button("nav button", t("All movies")));
    await online.click("Open the long-subtitles movie", poster("Long subtitles"));
    await online.click(
      "Download it, held by the provider at 40 kB",
      button('[role="dialog"] button', t("Download")),
    );
    await online.wait(async () => (await online.text('[role="dialog"]')).includes("%"));
    await online.key("Escape", 27);
    // The bar says how far the transfer is, as the details did, in the language's own numbers.
    await online.wait(async () => /\d/.test((await noticeSays(online)) ?? ""));
    notices["transferring"] = fits("while one transfers", await barOf(online), percent);
    await online.capture("notice-transferring");
    await online.click("Open the index-at-the-end movie", poster("Index at the end"));
    const filesBefore = provider.fileRequests();
    await online.click(
      "Play it from the same subscription",
      button('[role="dialog"] button', t("Play")),
    );
    await online.wait(async () => {
      const v = await online.video();
      return v.title && !v.paused && v.width > 0 && v.time > 1;
    }, 45_000);
    const waiting = (await online.listed()).find(
      (item) => item.name.includes("Long") || item.status.kind === "waiting",
    );
    observed["preemption"] = {
      downloadStatusWhilePlaying: waiting?.status.kind ?? null,
      mostProviderFilesAtOnce: provider.mostFilesAtOnce(),
      providerFileRequestsForPlayback: provider.fileRequests() - filesBefore,
      playback: await online.video(),
    };
    await online.capture("playing-while-download-waits");
    if (waiting?.status.kind !== "waiting")
      throw new Error("The download didn't wait for playback.");
    if (provider.mostFilesAtOnce() !== 1) throw new Error("The provider saw two files at once.");
    // Over the title, its bar's notice says the download waits. Space on it, reached with Tab,
    // presses it rather than pausing the title: it leaves the title as Back does, saving where
    // it got to, and opens Downloads, with nothing of the title or its details left over it.
    const titleBar = "[data-view=title] header";
    await online.wait(async () => (await noticeSays(online, titleBar)) === t("Waiting"));
    const wake = async () => {
      await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
      await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 420, y: 320 });
      await online.wait(() =>
        online.exists("document.querySelector('[data-view=title][data-controls]')"),
      );
      // The bar fades in over 300 ms.
      await delay(400, undefined, { signal: abort.signal });
    };
    await wake();
    await online.capture("notice-waiting-over-title");
    await wake();
    const indexed = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Index at the end"),
    )!;
    /**
     * What main saved of how far the playing title got: an observation, never a change. A title
     * playing saves every minute, so a position saved before then was saved as it was left.
     */
    const saved = () =>
      online.page.evaluate<{ position: number } | null>(
        `window.mrStreamer.invoke('viewing.progress', { movies: [${JSON.stringify({ subscriptionId: waiting.subscription?.id, id: String(indexed.id) })}] }).then(r => r.ok ? (r.value[0] ?? null) : null)`,
      );
    await online.tabTo("Tab to the notice over the playing title", notice(titleBar));
    const before = await saved();
    const pressedOn = await online.video();
    await online.press(" ");
    await online.wait(async () => !(await online.video()).title && (await onDownloadsPage(online)));
    const progress = await saved();
    notices["fromTitle"] = {
      title: (await online.video()).title,
      details: await online.exists("document.querySelector('[role=dialog]')"),
      downloadsPage: await onDownloadsPage(online),
      playingWhenPressed: !pressedOn.paused,
      timeWhenPressed: pressedOn.time,
      savedBefore: before,
      saved: progress,
      bar: await barOf(online),
    };
    if (pressedOn.paused) throw new Error("The title was paused before its notice was pressed.");
    if (before || !progress || progress.position < pressedOn.time - 1)
      throw new Error(`Leaving the title didn't save where it got to: ${JSON.stringify(progress)}`);
    await online.capture("notice-opened-downloads-from-title");
    await online.wait(
      async () => (await online.listed()).every((item) => item.status.kind === "complete"),
      60_000,
    );
    observed["afterPlaybackDownloads"] = (await online.listed()).map((item) => [
      item.name,
      item.status.kind,
    ]);
    if (provider.mostFilesAtOnce() !== 1) throw new Error("The provider saw two files at once.");

    // Home's muted preview of a channel is playback too: a download held by the provider waits
    // behind it, and the details, opened over Home from Search, say so on the control that
    // cancels it. A search result names the provider's title in its tooltip.
    const recording = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Broadcast recording"),
    )!;
    provider.stallMovieFile(recording.id, 30_000, 120_000);
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.click("Open All movies", button("nav button", t("All movies")));
    await online.click("Open the broadcast-recording movie", poster("Broadcast recording"));
    await online.click(
      "Download it, held by the provider",
      button('[role="dialog"] button', t("Download")),
    );
    await online.wait(async () => (await online.text('[role="dialog"]')).includes("%"));
    await online.key("Escape", 27);
    const search = async (words: string, label: string) => {
      await online.click("Open global Search", labelled(t("Search")));
      actions.push({ action: `Search ${words}`, at: now() });
      await online.page.send("Input.insertText", { text: words });
      await online.wait(() =>
        online.page.evaluate<boolean>(
          `(e => !!e && (e.textContent.includes(${JSON.stringify(label)}) || [...e.querySelectorAll('[title]')].some(n => n.title.includes(${JSON.stringify(label)}))))(document.querySelector('[role=tree] [aria-selected=true]'))`,
        ),
      );
      await online.key("Enter", 13);
    };
    await search("TEST | H.264 + AAC", "H.264 + AAC");
    await online.wait(async () => {
      const v = await online.video();
      return (await online.exists("document.querySelector('[data-view=watch]')")) && v.time > 0.5;
    }, 45_000);
    // Watch's bar says the download waits for the channel, as the title's did.
    await online.wait(
      async () => (await noticeSays(online, "[data-view=watch] header")) === t("Waiting"),
      45_000,
    );
    notices["overWatch"] = await noticeSays(online, "[data-view=watch] header");
    await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
    await delay(400, undefined, { signal: abort.signal });
    await online.capture("notice-waiting-over-watch");
    // Enter on it, reached with Tab, presses it rather than opening the channels: Watch closes
    // over Downloads, no page that previews, so the channel lets the provider's connection go
    // and the download takes it on.
    const recordingStatus = async () =>
      (await online.listed()).find((item) => item.title.id === String(recording.id))?.status.kind;
    // The request that takes the download on starts where the held one stopped, past its hold:
    // held again further on, so it is still under way once Home's preview wants the connection.
    provider.stallMovieFile(recording.id, 60_000, 120_000);
    actions.push({ action: "Hold the recording's file again at 60 kB", at: now() });
    await online.tabTo("Tab to the notice over Watch", notice("[data-view=watch] header"));
    await online.press("Enter");
    await online.wait(
      async () =>
        !(await online.exists("document.querySelector('[data-view=watch]')")) &&
        (await onDownloadsPage(online)),
    );
    await online.wait(async () => (await recordingStatus()) === "transferring", 45_000);
    const recordingRow = row(
      (await online.listed()).find((item) => item.title.id === String(recording.id))!.id,
    );
    await online.wait(async () =>
      /\d\s?%/.test(await online.page.evaluate<string>(`(${recordingRow})?.innerText ?? ""`)),
    );
    notices["fromWatch"] = {
      watch: await online.exists("document.querySelector('[data-view=watch]')"),
      downloadsPage: await onDownloadsPage(online),
      download: await recordingStatus(),
      mostProviderFilesAtOnce: provider.mostFilesAtOnce(),
    };
    await online.capture("notice-opened-downloads-from-watch");
    // Home shows the channel again, muted, and the download waits behind it, which the bar says
    // there at every width.
    await online.click("Open Home", button("header button", t("Home")));
    await online.wait(async () => (await recordingStatus()) === "waiting", 45_000);
    await online.wait(async () => (await noticeSays(online)) === t("Waiting"));
    await atWidths(online, "waiting", named(t("Waiting")));
    await search("Broadcast recording", "Broadcast recording");
    const waitingControl = button(
      '[role="dialog"] button',
      `${t("Waiting for playback")} · ${t("Cancel")}`,
    );
    await online.wait(() => online.exists(waitingControl));
    observed["waitingBehindPreview"] = {
      status: await recordingStatus(),
      details: await online.page.evaluate<string>(
        `(${waitingControl})?.closest('[role=dialog]')?.innerText ?? ''`,
      ),
      preview: await online.page.evaluate<{ time: number; paused: boolean }[]>(
        "[...document.querySelectorAll('video')].map(v => ({ time: v.currentTime, paused: v.paused }))",
      ),
      mostProviderFilesAtOnce: provider.mostFilesAtOnce(),
    };
    await online.capture("waiting-behind-home-preview");
    await online.click("Cancel the waiting download", waitingControl);
    await online.wait(async () => (await recordingStatus()) === undefined);
    await online.key("Escape", 27);

    // 3. Failure, retry, delete and cancel through the page and the details.
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.click("Open All movies", button("nav button", t("All movies")));
    await online.click("Open the missing-file movie", poster("Missing file"));
    await online.click(
      "Download a file the provider doesn't have",
      button('[role="dialog"] button', t("Download")),
    );
    await online.wait(async () => (await online.text('[role="dialog"]')).includes(t("Retry")));
    const retried = provider.fileRequests();
    await online.click(
      "Retry from the details",
      `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes(${JSON.stringify(t("Retry"))}))`,
    );
    await online.wait(async () => provider!.fileRequests() > retried);
    await online.key("Escape", 27);
    const held = provider.titles.movies.find((each) =>
      each.name.startsWith("TEST | Index with a gap"),
    )!;
    provider.stallMovieFile(held.id, 30_000, 60_000);
    await online.click("Open the index-with-a-gap movie", poster("Index with a gap"));
    // Download stopped is all the bar has to say, with Back in the pages' place over the details.
    // Narrowed 20 CSS px at a time until it keeps its arrow alone, the bar then gets the held
    // movie's percentage as it starts, nothing resized: those shorter words fit beside Back.
    const stopped = named(t("Download stopped"));
    const labelOf = (bar: Bar) => bar.downloads[0]?.label ?? "";
    await online.wait(async () => stopped(labelOf(await barOf(online))));
    let narrow = 960;
    let arrowAlone = await settledBar(online);
    for (; narrow > 520; narrow -= 20) {
      await layOut(online, narrow);
      arrowAlone = fits(`stopped at ${narrow} CSS px`, await settledBar(online), stopped);
      if (arrowAlone.downloads[0]!.text === "") break;
    }
    if (arrowAlone.downloads[0]!.text !== "")
      throw new Error("Download stopped kept its words down to 520 CSS px.");
    await online.capture(`notice-stopped-arrow-${narrow}`);
    await online.click(
      "Download it, held by the provider",
      button('[role="dialog"] button', t("Download")),
    );
    await online.wait(async () => percent(labelOf(await barOf(online))));
    const shorter = fits(`transferring at ${narrow} CSS px`, await settledBar(online), percent);
    if (shorter.downloads[0]!.text === "")
      throw new Error(`The percentage stayed behind the arrow at ${narrow} CSS px, where it fits.`);
    notices["stoppedToTransferring"] = {
      width: narrow,
      stopped: arrowAlone,
      transferring: shorter,
    };
    await online.capture(`notice-transferring-${narrow}`);
    await layOut(online, null);
    await online.wait(async () => (await online.text('[role="dialog"]')).includes("%"));
    await online.key("Escape", 27);
    // The transfer speaks over the failure. Wide, Downloads keeps its place among the pages and
    // the notice stands beside Search; Enter on it opens the page, which then says it alone.
    await online.wait(async () => /\d/.test((await noticeSays(online)) ?? ""));
    notices["wide"] = fits("wide", await barOf(online), percent);
    await atWidths(online, "transferring", percent);
    await online.tabTo("Tab to the notice", notice());
    await online.press("Enter");
    await online.wait(() => onDownloadsPage(online));
    await online.wait(async () => (await noticeSays(online)) === null);
    notices["wideOnDownloads"] = await barOf(online);
    await online.capture("notice-hidden-on-downloads");
    // Narrower than the pages' names need: Downloads folds beside Search as one button, marked
    // on its page and named with the notice's words, its arrow alone where the other names need
    // the room. The window's least width is 960, so the narrower layout is emulated, as a zoomed
    // window or longer page names give it.
    const folded = async (current: boolean) => {
      const bar = await barOf(online);
      return (
        !bar.pages.includes(t("Downloads")) &&
        bar.downloads.length === 1 &&
        (bar.downloads[0]!.current === "page") === current &&
        percent(bar.downloads[0]!.label ?? "")
      );
    };
    // Header copy changes how many CSS pixels the pages need. Find the actual fold while
    // still requiring its current-page marker, percentage label and keyboard behavior below.
    // The bar folds a frame or more after the resize, so each width is read once it has settled;
    // read sooner, a slow runner steps past the fold to a width where no names fit.
    let foldedWidth: number | undefined;
    for (let width = 760; width >= 520; width -= 20) {
      await layOut(online, width);
      await settledBar(online);
      if (await folded(true)) {
        foldedWidth = width;
        break;
      }
    }
    if (foldedWidth === undefined)
      throw new Error("Downloads did not fold within the emulated width bounds.");
    notices["foldedWidth"] = foldedWidth;
    notices["foldedOnDownloads"] = fits("folded on Downloads", await settledBar(online), percent);
    await online.capture("notice-folded-on-downloads");
    await online.click("Open Movies, folded", button("header nav button", t("Movies")));
    await online.wait(() => folded(false));
    notices["foldedElsewhere"] = fits("folded on Movies", await settledBar(online), percent);
    await online.capture("notice-folded-on-movies");
    await online.tabTo("Tab to the folded Downloads", notice());
    await online.press(" ");
    await online.wait(() => onDownloadsPage(online));
    await online.wait(() => folded(true));
    await layOut(online, null);
    await online.wait(async () => (await barOf(online)).pages.includes(t("Downloads")));
    await online.click("Open Downloads", button("header button", t("Downloads")));
    await online.wait(async () =>
      (await online.text()).includes(t("The provider has no file for this title right now.")),
    );
    await online.capture("downloads-queue-and-copies");
    const heldId = await idOf(online, "movie", held.id);
    const missingId = await idOf(
      online,
      "movie",
      provider.titles.movies.find((each) => each.name.startsWith("TEST | Missing file"))!.id,
    );
    // Among the pages, the folded Downloads button keeps the keyboard as its words go and come
    // back. At the narrowest width where it says the percentage, so Download stopped won't fit:
    // Tab to it, cancel the transfer from its row with the pointer, which leaves Download stopped
    // to its arrow. On Movies, Tab to it again, widen and narrow the window. On hover the arrow
    // says the words. Enter on it then opens Downloads.
    let narrowest = 0;
    for (let width = 960; width > 520; width -= 20) {
      await layOut(online, width);
      const says = (await settledBar(online)).downloads[0]?.text;
      if (says) narrowest = width;
      else if (says === "") break;
    }
    if (!narrowest) throw new Error("The folded Downloads never said the percentage.");
    await layOut(online, narrowest);
    await online.wait(async () => {
      const bar = await barOf(online);
      return percent(labelOf(bar)) && bar.downloads[0]!.text !== "";
    });
    await online.tabTo("Tab to the folded Downloads saying the percentage", notice());
    await online.page.evaluate("void (window.__focusedNotice = document.activeElement)");
    const kept = async (where: string, bar: Bar, words: boolean) => {
      fits(where, bar, stopped);
      if ((bar.downloads[0]!.text !== "") !== words)
        throw new Error(`The notice ${words ? "kept its arrow" : "kept its words"} ${where}.`);
      const focus = await online.page.evaluate<{ same: boolean; active: string | null }>(
        "({ same: document.activeElement === window.__focusedNotice && window.__focusedNotice.isConnected, active: document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.tagName ?? null })",
      );
      if (!focus.same) throw new Error(`The notice lost the keyboard ${where}: ${focus.active}`);
      return { ...bar, focus: focus.active };
    };
    const focused: Record<string, unknown> = { width: narrowest };
    notices["focusAcrossFolds"] = focused;
    await online.click("Cancel the held download", `(${row(heldId)})?.querySelector('button')`);
    await online.wait(
      async () => provider!.activeStreams() === 0 && !(await online.exists(row(heldId))),
    );
    await online.wait(async () => stopped(labelOf(await barOf(online))));
    focused["stoppedOnDownloads"] = await kept(
      `once stopped at ${narrowest} CSS px`,
      await settledBar(online),
      false,
    );
    // Every page draws its own bar, so Movies has the keyboard start over.
    await online.click("Open Movies with the pointer", button("header nav button", t("Movies")));
    await online.wait(async () => (await barOf(online)).downloads[0]?.current === null);
    await online.tabTo("Tab to the folded Downloads with its arrow alone", notice());
    await online.page.evaluate("void (window.__focusedNotice = document.activeElement)");
    focused["stoppedOnMovies"] = await kept(
      `on Movies at ${narrowest} CSS px`,
      await settledBar(online),
      false,
    );
    const centre = await online.page.evaluate<{ x: number; y: number }>(`(() => {
      const box = (${notice()}).getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    })()`);
    actions.push({ action: "Point at the notice's arrow", at: now() });
    await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...centre });
    const tip = `[...document.querySelectorAll('[data-side]')].find(e => !e.closest('header') && e.checkVisibility() && e.textContent.trim() === ${JSON.stringify(t("Download stopped"))})`;
    await online.wait(() => online.exists(tip));
    focused["tooltip"] = await online.page.evaluate<string>(`(${tip}).textContent.trim()`);
    await online.capture(`notice-arrow-tooltip-${narrowest}`);
    actions.push({ action: "Point away from the bar", at: now() });
    await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 400 });
    await online.wait(async () => !(await online.exists(tip)));
    await layOut(online, null);
    await online.wait(async () => (await barOf(online)).downloads[0]?.text !== "");
    focused["wide"] = await kept("at the window's own width", await settledBar(online), true);
    await online.capture("notice-stopped-focused-wide");
    await layOut(online, narrowest);
    await online.wait(async () => (await barOf(online)).downloads[0]?.text === "");
    focused["narrowAgain"] = await kept(
      `at ${narrowest} CSS px again`,
      await settledBar(online),
      false,
    );
    await online.capture(`notice-stopped-focused-${narrowest}`);
    await online.press("Enter");
    await online.wait(() => onDownloadsPage(online));
    focused["enterOpenedDownloads"] = true;
    await layOut(online, null);
    // With the failed download alone left, the bar says it stopped, away from the page that says
    // why, and the notice leads back there.
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.wait(async () => (await noticeSays(online)) === t("Download stopped"));
    notices["stopped"] = fits("stopped", await barOf(online), named(t("Download stopped")));
    await online.capture("notice-download-stopped");
    await atWidths(online, "stopped", named(t("Download stopped")));
    // Settings over the page has Back in the pages' place, which folds the same way: at 520 CSS
    // px, as a window zoomed past its least width has it, the words go and Back stays whole.
    await online.click("Open Settings", labelled(t("Settings")));
    await online.wait(() => online.exists(notice()));
    const overSettings: Record<number, Bar> = {};
    for (const width of [960, 520]) {
      await layOut(online, width);
      overSettings[width] = fits(
        `over Settings at ${width} CSS px`,
        await settledBar(online),
        named(t("Download stopped")),
      );
      await online.capture(`notice-stopped-over-settings-${width}`);
    }
    notices["stoppedOverSettings"] = overSettings;
    if (overSettings[520]!.downloads[0]!.text !== "")
      throw new Error("The notice kept its words where Back had no room for them.");
    await layOut(online, null);
    await online.click("Close Settings", labelled(t("Settings")));
    await online.wait(async () => (await barOf(online)).pages.includes(t("Downloads")));
    await online.click("Press the stopped notice", notice());
    await online.wait(() => onDownloadsPage(online));
    await online.click(
      "Delete the failed download",
      `[...(${row(missingId)})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(t("Delete"))})`,
    );
    await online.wait(async () => !(await online.exists(row(missingId))));
    observed["afterCancelAndDelete"] = (await online.listed()).map((item) => [
      item.name,
      item.status.kind,
    ]);
    await online.capture("downloads-after-cancel-delete");
    // Copies alone: nothing to say, on any page.
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.wait(async () => (await noticeSays(online)) === null);
    notices["copiesOnly"] = fits("with copies alone", await barOf(online));
    notices["said"] = await online.page.evaluate("window.__noticeSaid");
    await quit("online");

    // 4. Offline: the provider, TMDB and pictures are gone. Play the movie's copy, seek, change
    // its sound, leave and resume.
    await provider.close();
    await tmdb.close();
    await new Promise<void>((resolve) => pictures!.close(() => resolve()));
    actions.push({ action: "Stop the fake provider, TMDB and picture server", at: now() });
    const offline = await start("network denied");
    await offline.wait(() => offline.exists("document.querySelector('header')"));
    await offline.click("Open Downloads", button("header button", t("Downloads")));
    // The movie, the episode, and the movie that waited for playback.
    await offline.wait(async () => (await offline.listed()).length === 3);
    // Their pictures come from this computer, with the picture server gone.
    const posters = () =>
      offline.page.evaluate<number>(
        "[...document.querySelectorAll('img')].filter(i => i.src.startsWith('mrstreamer:') && i.complete && i.naturalWidth > 0).length",
      );
    await offline.wait(async () => (await posters()) === 3);
    observed["offlineArtworkLoaded"] = await posters();
    await offline.capture("downloads-offline");
    const movieId = await idOf(
      offline,
      "movie",
      provider.titles.movies.find((each) => each.name.startsWith("TEST | Two sound tracks"))!.id,
    );
    const episodeId = await idOf(offline, "episode");
    const playedFrom = Date.now();
    const requestsFrom = windowRequests.length;
    await watchOffline(offline, movieId, "Watch the movie offline");
    await offline.capture("copy-playing");
    const beforeSeek = (await offline.video()).time;
    await offline.key("ArrowRight", 39);
    await offline.wait(async () => (await offline.video()).time >= beforeSeek + 8);
    await offline.wait(async () => !(await offline.video()).paused);
    observed["seek"] = { from: beforeSeek, to: (await offline.video()).time };
    await offline.click("Open Sound", labelled(t("Sound")));
    const sounds = await offline.page.evaluate<string[]>(
      "[...document.querySelectorAll('[role=dialog] [role=menuitemradio], [role=dialog] button[aria-pressed]')].map(b => b.textContent.trim())",
    );
    observed["soundTracks"] = sounds;
    await offline.click(
      "Choose the other sound track",
      "[...document.querySelectorAll('[role=dialog] button[aria-pressed=false], [role=dialog] [role=menuitemradio][aria-checked=false]')][0]",
    );
    await offline.wait(async () => {
      const v = await offline.video();
      return !v.paused && v.audio > 0 && v.time > 1;
    }, 45_000);
    observed["afterTrackChange"] = await offline.video();
    await offline.capture("copy-other-sound");
    await offline.key("Escape", 27);
    await offline.wait(async () => !(await offline.video()).title);

    // The 20-second movie is all credits: resume and subtitles go by the 150-second one.
    const longId = await idOf(offline, "movie", slow.id);
    await watchOffline(offline, longId, "Watch the long-subtitles movie offline");
    for (let skip = 0; skip < 4; skip++) await offline.key("ArrowRight", 39);
    await offline.click("Open Subtitles", labelled(t("Subtitles")));
    await offline.click(
      "Choose the file's French text track",
      `[...document.querySelectorAll('aside[aria-label=${JSON.stringify(t("Subtitle choices"))}] button[aria-pressed]')].find(b => b.textContent.trim() === 'Français')`,
    );
    await offline.click("Close Subtitles", labelled(t("Close subtitles")));
    await offline.wait(async () => {
      const v = await offline.video();
      return !v.paused && v.time >= 40;
    }, 45_000);
    await offline.wait(
      () =>
        offline.page.evaluate<boolean>(
          "[...document.querySelector('video').textTracks].some(t => t.kind === 'subtitles' && (t.cues?.length ?? 0) > 0)",
        ),
      45_000,
    );
    observed["embeddedSubtitleCues"] = await offline.page.evaluate<number>(
      "[...document.querySelector('video').textTracks].filter(t => t.kind === 'subtitles').reduce((n, t) => n + (t.cues?.length ?? 0), 0)",
    );
    // A cue due on the screen, as the viewer reads it.
    await offline.wait(
      async () =>
        (await offline.page.evaluate<string>(
          "document.querySelector('[data-subtitle-text]')?.textContent?.trim() ?? ''",
        )) !== "",
      45_000,
    );
    observed["captionShown"] = await offline.page.evaluate<string>(
      "document.querySelector('[data-subtitle-text]').textContent.trim()",
    );
    await offline.capture("copy-subtitles");
    const leftAt = (await offline.video()).time;
    await offline.key("Escape", 27);
    await offline.wait(async () => !(await offline.video()).title);
    // Main keeps where it was left: Watch offline goes from there at once, as the page hears of
    // it only a moment later.
    const longProgress = async () =>
      (await offline.listed()).find((item) => item.id === longId)?.progress;
    await offline.wait(async () => ((await longProgress())?.position ?? 0) >= leftAt - 2);
    const keptAtLeave = await longProgress();
    const shownAtResume = await offline.page.evaluate<string | null>(
      `(${row(longId)})?.querySelector('span > span[style*="width"]')?.style.width ?? null`,
    );
    await watchOffline(offline, longId, "Resume the long-subtitles movie offline");
    const resumedAt = (await offline.video()).time;
    observed["resume"] = { leftAt, kept: keptAtLeave, shownAtResume, resumedAt };
    if (resumedAt < leftAt - 8) throw new Error("The copy didn't resume where it was left.");
    await offline.key("Escape", 27);
    await offline.wait(async () => !(await offline.video()).title);
    // The page shows where it was left too.
    await offline.wait(async () => {
      const progress = await longProgress();
      const shown = await offline.page.evaluate<string | null>(
        `(${row(longId)})?.querySelector('span > span[style*="width"]')?.style.width ?? null`,
      );
      return (
        !!progress && shown === `${Math.round((progress.position / progress.duration) * 100)}%`
      );
    });
    const playedUntil = Date.now();
    observed["offlinePlayback"] = during(playedFrom, playedUntil, requestsFrom);

    // 5. Remove the subscription through Settings, restart, and play both copies with none saved.
    await offline.click("Open Settings", labelled(t("Settings")));
    await offline.click("Open Subscriptions", button("nav button", t("Subscriptions")));
    const subscriptionRow = `[...document.querySelectorAll('li')].find(r => r.querySelector('button')?.textContent.includes(' · '))`;
    for (let attempt = 1; ; attempt++) {
      await offline.click(
        `Open the subscription (attempt ${attempt})`,
        `(${subscriptionRow})?.querySelector('button')`,
      );
      const opened = await offline
        .wait(() => offline.exists(`(${subscriptionRow})?.querySelector('[role=region]')`), 3000)
        .then(
          () => true,
          () => false,
        );
      if (opened) break;
      if (attempt === 3) throw new Error("The subscription's row didn't open.");
    }
    const [removeBefore, removeAfter] = t("Remove {name}", { name: "\n" }).split("\n");
    await offline.click(
      "Ask to remove it",
      `[...(${subscriptionRow})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim().startsWith(${JSON.stringify(removeBefore?.trim() ?? "")}) && b.textContent.trim().endsWith(${JSON.stringify(removeAfter?.trim() ?? "")}))`,
    );
    // The question after the subscription's name, which the fixture chose.
    const question = t("Remove {name}, and the lists loaded with it, from this device?", {
      name: "\n",
    }).split("\n");
    await offline.wait(async () => (await offline.text()).includes(question.at(-1) ?? ""));
    await offline.capture("remove-subscription-question");
    // In the row: the page under Settings has buttons of the same name in some languages, as
    // French Delete and Remove are both Supprimer.
    await offline.click(
      "Confirm removal",
      `[...(${subscriptionRow})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(t("Remove"))})`,
    );
    await offline.wait(() => offline.exists("document.querySelector('form input')"), 30_000);
    await offline.wait(() => offline.exists(button("button", t("Downloads"))));
    await offline.capture("connect-with-downloads");
    await quit("network denied");

    const alone = await start("no subscription");
    await alone.click("Open Downloads from Connect", button("button", t("Downloads")));
    await alone.wait(async () => (await alone.listed()).length === 3);
    await alone.wait(async () =>
      (await alone.text()).includes(t("Subscription removed, copy kept")),
    );
    observed["standalone"] = {
      items: (await alone.listed()).map((item) => ({
        name: item.name,
        status: item.status.kind,
        subscription: item.subscription,
        progress: item.progress,
        poster: item.posterUrl,
      })),
      artworkLoaded: await alone.page.evaluate<number>(
        "[...document.querySelectorAll('img')].filter(i => i.src.startsWith('mrstreamer:') && i.naturalWidth > 0).length",
      ),
    };
    await alone.capture("downloads-without-subscription");
    const aloneFrom = Date.now();
    const aloneRequests = windowRequests.length;
    await watchOffline(alone, episodeId, "Watch the episode offline");
    await alone.capture("episode-playing-without-subscription");
    await alone.key("Escape", 27);
    await alone.wait(async () => !(await alone.video()).title);
    await watchOffline(alone, longId, "Resume the long movie without a subscription");
    observed["resumeWithoutSubscription"] = await alone.video();
    await alone.key("Escape", 27);
    await alone.wait(async () => !(await alone.video()).title);
    observed["playbackWithoutSubscription"] = during(aloneFrom, Date.now(), aloneRequests);

    // A copy whose file went from the app's folder: opening it finds it gone, and the page the
    // viewer returns to hears so from main, before anything here asks for the list again.
    const copyFolder = join(profile, "downloads", movieId);
    const media = (await readdir(copyFolder)).find((name) => name.startsWith("media."));
    if (!media) throw new Error("The movie's copy has no file to remove.");
    await rm(join(copyFolder, media));
    actions.push({ action: "Remove the movie copy's file from the run's profile", at: now() });
    await alone.click(
      "Watch the movie whose file is gone",
      `(${row(movieId)})?.querySelector('button')`,
    );
    await alone.wait(async () => (await alone.text()).includes(t("Download missing")));
    await alone.capture("copy-missing-player");
    await alone.click("Back from the missing copy", button("button", t("Back")));
    const rowSays = () =>
      alone.page.evaluate<{ text: string; watchOffline: boolean } | null>(
        `(() => { const r = ${row(movieId)}; return r && { text: r.textContent, watchOffline: [...r.querySelectorAll('button')].some(b => b.textContent.trim() === ${JSON.stringify(t("Watch offline"))}) }; })()`,
      );
    await alone.wait(async () => {
      const says = await rowSays();
      return (
        !!says &&
        says.text.includes(t("The file is no longer on this computer.")) &&
        !says.watchOffline
      );
    });
    observed["missingCopy"] = {
      row: await rowSays(),
      listed: (await alone.listed()).find((item) => item.id === movieId)?.status.kind ?? null,
    };
    await alone.capture("downloads-copy-missing");
    await alone.click("Back to the form", button("button", t("Add subscription")));
    await alone.wait(() => alone.exists("document.querySelector('form input')"));
    await quit("no subscription");

    for (const name of ["offlinePlayback", "playbackWithoutSubscription"]) {
      const seen = observed[name] as ReturnType<typeof during>;
      if (seen.main.length > 0 || seen.window.length > 0)
        throw new Error(`${name} reached beyond the app's loopback proxy: ${JSON.stringify(seen)}`);
    }

    /** What main and the window asked of the network between two moments, but the proxy's own. */
    function during(from: number, until: number, requestsFrom: number) {
      const lines = readLines(networkLog).filter((line) => line.at >= from && line.at <= until);
      const local = (url: string) =>
        /^(mrstreamer:|data:|blob:|file:|http:\/\/127\.0\.0\.1:\d+\/(title|source)\/)/.test(url);
      return {
        main: lines.filter((line) => line.kind !== "ipc"),
        window: windowRequests
          .slice(requestsFrom)
          .filter((request) => request.at <= until && !local(request.url)),
        windowRequests: windowRequests.slice(requestsFrom).filter((request) => request.at <= until)
          .length,
      };
    }
  } catch (error) {
    failed = error;
    if (running?.page) {
      const shot = await running.page
        .send("Page.captureScreenshot", { format: "png" })
        .catch(() => undefined);
      if (record(shot?.result) && typeof shot.result["data"] === "string")
        await writeFile(join(evidence, "failure.png"), Buffer.from(shot.result["data"], "base64"));
    }
  } finally {
    const clean = async (operation: () => Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    };
    if (running) {
      const owned = running;
      await clean(() => stop(owned.app, owned.page));
      owned.page?.close();
    }
    if (provider) await clean(() => provider!.close());
    if (tmdb) await clean(() => tmdb!.close());
    if (pictures?.listening)
      await clean(() => new Promise<void>((resolve) => pictures!.close(() => resolve())));
    observed["mainNetwork"] = summarise(readLines(networkLog), observed["fixturePorts"]);
    if (profile && (!running || running.app.exitCode !== null || running.app.signalCode !== null))
      await clean(() => rm(profile!, { recursive: true, force: true, maxRetries: 5 }));
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (cleanupErrors.length) failed ??= new Error(cleanupErrors.join("\n"));
    await writeFile(join(evidence, "electron.log"), log.join(""));
    await writeFile(
      join(evidence, "proof.json"),
      JSON.stringify(
        {
          scenario: "downloads",
          build,
          locale,
          status: failed ? "failed" : "passed",
          actions,
          observed,
          error: failed ? String(failed) : null,
          cleanup: {
            fixturesClosed: cleanupErrors.length === 0,
            appExited: !running || running.app.exitCode !== null || running.app.signalCode !== null,
            profileRemoved: profile
              ? await access(profile).then(
                  () => false,
                  () => true,
                )
              : true,
            errors: cleanupErrors,
          },
          limits: [
            "Fake provider/TMDB and a loopback picture server; no real subscription acceptance",
            "Development build on this platform; no installer or native-platform proof",
            "Decoded audio does not prove audible output",
            "Main's connections are recorded in JavaScript; Chromium's own, over CDP",
            "Bars narrower than the window's 960 px least width (760 and 520 CSS px) are CDP viewport emulation",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failed ? "FAIL" : "PASS"} downloads ${locale}: ${evidence}`);
  }
  if (failed) throw failed;
}

function now(): string {
  return new Date().toISOString();
}

/** Every connection network-hook.cjs wrote down. */
function readLines(path: string): Connection[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Connection);
  } catch {
    return [];
  }
}

/** Main's connections by where they went, with the fixtures named. */
function summarise(lines: readonly Connection[], fixtures: unknown) {
  const ports = new Set(Array.isArray(fixtures) ? fixtures : []);
  const by = new Map<string, number>();
  for (const line of lines) {
    if (line.kind === "ipc") continue;
    const where =
      line.kind === "artwork"
        ? `artwork ${line.host}`
        : `${line.kind} ${line.host}:${line.port}${ports.has(line.port) ? " (fixture)" : ""}`;
    by.set(where, (by.get(where) ?? 0) + 1);
  }
  return Object.fromEntries(by);
}

/** Answers every path with a picture of its own colour, as an artwork CDN would. */
async function pictureServer(): Promise<Server> {
  const server = createServer((request, response) => {
    const [r, g, b] = createHash("sha256")
      .update(request.url ?? "/")
      .digest();
    response
      .writeHead(200, { "Content-Type": "image/png" })
      .end(solidPng(300, 450, [r! / 2 + 40, g! / 2 + 40, b! / 2 + 40]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

/** A PNG of one colour. */
function solidPng(width: number, height: number, rgb: readonly number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const line = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) line.set(rgb.map(Math.round), 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: height }, () => line));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
