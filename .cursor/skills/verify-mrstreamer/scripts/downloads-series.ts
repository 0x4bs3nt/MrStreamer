// The downloads-series scenario of `pnpm verify:desktop`: downloaded episodes of a series grouped on
// the Downloads page and played on, copy after copy, in the offline player, driven through the
// built app's window with pointer and key input on one profile started several times. Episodes of
// the two-season Dutch "Formats" version are downloaded from its details; the provider, TMDB and
// the picture server then stop. With the subscription still saved, autoplay off offers the next
// copy without a countdown and Settings holds a countdown. The subscription is removed; with none
// saved, the countdown opens the next copy, a next episode with no copy stops it, Cancel keeps the
// copy, Next mid-play saves where it got to first, a save main refuses while another connection
// holds the database keeps the copy until Next is pressed once the lock goes, and a next copy whose
// file is removed during the countdown stops it on the copy before. A last start finds the
// progress and the missing file.
//   With `--previous <executable>`, stable 0.0.19's build (as its AppImage unpacks) starts on the
// same profile after the first start: it finishes an episode this build queued, plays one of this
// build's copies and downloads an episode itself. This build must find its series kept through
// those writes, and 0.0.19's own copy alone, playing with nothing next.
//   Main's connections are recorded by network-hook.cjs for this build's starts; the window of
// either build resolves no host but loopback. Proof stays in `.local/verification/`.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { startFakeProvider } from "../../../../apps/desktop/test/fake-provider.ts";
import { startFakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { SOURCE_LOCALE } from "../../../../packages/contracts/src/language.ts";
import { setLanguage, t } from "../../../../packages/core/src/i18n.ts";
import { episodeLabel } from "../../../../packages/core/src/ondemand/names.ts";
import { pictureServer, summarise } from "./downloads-queue.ts";
import { evidenceDirectory, freePort, injectedFailure, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const hook = fileURLToPath(new URL("./network-hook.cjs", import.meta.url));
/** The next-episode delay the run saves through Settings: short, yet long enough to act in. */
const DELAY = 4;

/** A download as main lists it to the window: read as an observation, never changed. */
interface Listed {
  readonly id: string;
  readonly title: { readonly kind: string; readonly id: string };
  readonly status: { readonly kind: string };
  readonly progress: { readonly position: number; readonly duration: number } | null;
  readonly series?: string | null;
}

/** Which build a start runs: this checkout's, or an earlier one's packaged executable. */
type Build =
  { readonly kind: "candidate" } | { readonly kind: "previous"; readonly executable: string };

export async function runDownloadsSeries(
  build: Record<string, unknown> & { executable: string },
  previous?: string,
) {
  setLanguage({ locale: SOURCE_LOCALE, formats: SOURCE_LOCALE });
  const evidence = await evidenceDirectory(
    join(root, ".local/verification"),
    previous ? "downloads-series-previous-" : "downloads-series-",
  );
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = { build };
  const log: string[] = [];
  const networkLog = join(evidence, "main-network.jsonl");
  const windowRequests: { at: number; url: string }[] = [];
  let profile: string | undefined;
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
  let pictures: Server | undefined;
  let running: { app: ChildProcess; page?: Page } | undefined;
  /** Another connection to the run's profile database, holding its write lock while set. */
  let locked: DatabaseSync | undefined;
  let failed: unknown;
  const cleanupErrors: string[] = [];
  const now = () => new Date().toISOString();
  const action = (label: string) => actions.push({ action: label, at: now() });
  try {
    if (previous) {
      await access(previous);
      const asar = await readFile(join(dirname(previous), "resources/app.asar"));
      // The earlier build's download record, from its first key to its last.
      const from = asar.indexOf('sourceStamp: "string"');
      const declared = asar.subarray(from, asar.indexOf("completedAt", from)).toString();
      observed["previous"] = {
        executable: previous,
        appAsarSha256: createHash("sha256").update(asar).digest("hex"),
        recordFound: from >= 0,
        // What its record knows: no series among its keys.
        recordDeclaresSeries: declared.includes("series"),
      };
    }
    profile = await mkdtemp(join(tmpdir(), "mrstreamer-verify-"));
    provider = await startFakeProvider({ channels: 20, titles: 10, live: true });
    tmdb = await startFakeTmdb();
    pictures = await pictureServer();
    const picturesUrl = `http://127.0.0.1:${(pictures.address() as AddressInfo).port}`;
    const fixturePorts = [provider.url, tmdb.url, picturesUrl].map((url) =>
      Number(new URL(url).port),
    );
    observed["fixturePorts"] = fixturePorts;
    const starts: Record<string, unknown>[] = [];
    observed["starts"] = starts;
    const ownedProvider = provider;

    /** Starts `which` on the run's profile and checks the window is that build's, on that profile. */
    const start = async (label: string, which: Build) => {
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
      const executable = which.kind === "candidate" ? build.executable : which.executable;
      const app = spawn(
        executable,
        [
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          `--user-data-dir=${profile}`,
          "--enable-automation",
          "--use-mock-keychain",
          // The window reaches loopback only: no artwork host, whichever build draws it.
          "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
          ...(process.platform === "linux" ? ["--no-sandbox"] : []),
          ...(which.kind === "candidate" ? [desktop] : []),
        ],
        {
          cwd: root,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...env,
            ...(which.kind === "candidate" && process.env["MR_STREAMER_FFMPEG"]
              ? { MR_STREAMER_FFMPEG: process.env["MR_STREAMER_FFMPEG"] }
              : {}),
            LANGUAGE: "en_US",
            LANG: "en_US.UTF-8",
            MR_STREAMER_UPDATE_CHECKS: "off",
            MR_STREAMER_TMDB_API: tmdb!.url,
            MR_STREAMER_TMDB_KEY: "test-key",
            // A packaged build takes no --require: its main's requests are only the fixtures'.
            ...(which.kind === "candidate"
              ? {
                  NODE_OPTIONS: `--require ${JSON.stringify(hook).slice(1, -1)}`,
                  VERIFY_NETWORK_LOG: networkLog,
                  VERIFY_IMAGES: picturesUrl,
                }
              : {}),
          },
        },
      );
      running = { app };
      for (const stream of [app.stdout, app.stderr])
        stream?.on("data", (chunk: Buffer) => log.push(chunk.toString()));
      const page = await Promise.race([
        connect(port, "page", { app }),
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
        !args.includes(`--remote-debugging-port=${port}`) ||
        (which.kind === "candidate" && !args.includes(desktop))
      )
        throw new Error("CDP belongs to a different app instance.");
      const renderer =
        which.kind === "candidate"
          ? pathToFileURL(join(desktop, "out/renderer/")).href
          : pathToFileURL(join(dirname(which.executable), "resources/app.asar/")).href;
      const deadline = Date.now() + 30_000;
      let url = "";
      while (Date.now() < deadline && !url.startsWith(renderer)) {
        url = await page.evaluate<string>("location.href").catch(() => "");
        if (!url.startsWith(renderer)) await delay(150, undefined, { signal: abort.signal });
      }
      if (!url.startsWith(renderer)) throw new Error(`Wrong renderer: ${url}`);
      starts.push({ label, build: which.kind, executable, pid: app.pid, port, profile, url });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.send("Network.enable");
      page.on("Network.requestWillBeSent", (params) => {
        if (record(params) && record(params["request"]))
          windowRequests.push({ at: Date.now(), url: String(params["request"]["url"]) });
      });
      action(
        `Start ${which.kind === "candidate" ? "this build" : "the earlier build"} (${label}) on the run's profile`,
      );
      return driver(page);
    };
    const quit = async (label: string) => {
      if (!running) return;
      action(`Quit the app (${label})`);
      await stop(running.app, running.page);
      running.page?.close();
      running = undefined;
    };

    /** Window driving with real pointer and key input; observations read the DOM or main's list. */
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
        await page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        const shot = await page.send("Page.captureScreenshot", { format: "png" });
        if (!record(shot.result) || typeof shot.result["data"] !== "string")
          throw new Error("No screenshot returned.");
        await writeFile(join(evidence, `${name}.png`), Buffer.from(shot.result["data"], "base64"));
        const tree = await page.send("Accessibility.getFullAXTree");
        await writeFile(join(evidence, `${name}.ax.json`), JSON.stringify(tree.result, null, 2));
      };
      const click = async (label: string, element: string) => {
        await wait(() => exists(element));
        await page.evaluate(`${element}.scrollIntoView({ block: "nearest" })`);
        // Pressed only where the pointer reaches it: a closing dialog can still cover it.
        await wait(() =>
          page.evaluate<boolean>(`(() => {
            const target = ${element};
            if (!target || target.matches(":disabled")) return false;
            const box = target.getBoundingClientRect();
            return box.width > 0 && box.height > 0 &&
              target.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
          })()`),
        );
        action(label);
        const point = await page.evaluate<{ x: number; y: number }>(`(() => {
          const box = ${element}.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        })()`);
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
          await page.send("Input.dispatchMouseEvent", {
            type,
            ...point,
            button: "left",
            clickCount: 1,
          });
      };
      const key = async (name: string, code: number, modifiers = 0) => {
        action(`Press ${name}`);
        for (const type of ["rawKeyDown", "keyUp"])
          await page.send("Input.dispatchKeyEvent", {
            type,
            key: name,
            code: name.length === 1 ? `Key${name.toUpperCase()}` : name,
            windowsVirtualKeyCode: code,
            modifiers,
          });
      };
      const text = (selector = "body") =>
        page.evaluate<string>(
          `document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`,
        );
      const video = () =>
        page.evaluate<{
          time: number;
          duration: number;
          width: number;
          paused: boolean;
          frames: number;
          title: string | null;
        }>(`(() => {
          const v = document.querySelector('video');
          return { time: v?.currentTime ?? 0, duration: v?.duration ?? 0, width: v?.videoWidth ?? 0,
            paused: v?.paused ?? true, frames: v?.getVideoPlaybackQuality().totalVideoFrames ?? 0,
            title: document.querySelector('[data-view=title]')?.innerText ?? null };
        })()`);
      const listed = () =>
        page.evaluate<Listed[]>(
          "window.mrStreamer.invoke('downloads.list').then(r => r.ok ? r.value.items : [])",
        );
      return { page, wait, exists, capture, click, key, text, video, listed };
    };
    type Driver = ReturnType<typeof driver>;

    const button = (selector: string, words: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const labelled = (label: string) =>
      `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
    const row = (id: string) => `document.querySelector('[data-download="${id}"]')`;
    const inRow = (id: string, words: string) =>
      `[...(${row(id)})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const formats = ownedProvider.titles.series.find((each) => each.name === "TEST | Formats (NL)");
    if (!formats) throw new Error("No Dutch Formats series in the fixture.");
    const fileOf = (season: number, number: number) => {
      const file = formats.seasons[season - 1]?.[number - 1];
      if (!file) throw new Error(`No file of S${season} E${number}`);
      return file;
    };
    const idOf = async (d: Driver, season: number, number: number) => {
      const found = (await d.listed()).find(
        (item) => item.title.id === String(fileOf(season, number).id),
      );
      if (!found) throw new Error(`No download of S${season} E${number}`);
      return found.id;
    };
    const standing = async (d: Driver) =>
      (await d.listed()).map((item) => ({
        id: item.id,
        file: item.title.id,
        status: item.status.kind,
        progress: item.progress,
        series: item.series ?? null,
      }));
    const shelf = (d: Driver) =>
      d.page.evaluate(`(() => {
        const section = document.querySelector('section[aria-label=${JSON.stringify(t("On this computer"))}]');
        return [...(section?.children ?? [])].slice(1).map((child) => child.dataset.series !== undefined
          ? { series: child.getAttribute('aria-label'), text: child.innerText,
              copies: [...child.querySelectorAll('[data-download]')].map((r) => r.dataset.download) }
          : { copy: child.dataset.download ?? null, text: child.innerText });
      })()`);
    const openDownloads = async (d: Driver) => {
      await d.click("Open Downloads", button("header button", t("Downloads")));
      await d.wait(() =>
        d.exists(`document.querySelector('h1')?.textContent === ${JSON.stringify(t("Downloads"))}`),
      );
    };
    const openSettings = async (d: Driver) => {
      await d.key(",", 188, process.platform === "darwin" ? 4 : 2);
      await d.click("Open Playback settings", button("nav button", t("Playback")));
      await d.wait(() => d.exists(labelled(t("Next episode delay"))));
    };
    const closeSettings = async (d: Driver) => {
      await d.key("Escape", 27);
      // Escape in the delay field only ends its editing: the bar's Back closes Settings then.
      if (await d.exists(labelled(t("Next episode delay"))))
        await d.click(
          "Close Settings with Back",
          button('[data-view="settings"] header button', t("Back")),
        );
      await d.wait(async () => !(await d.exists(labelled(t("Next episode delay")))));
    };
    /** Starts `id` from its row, and waits for a moving picture of it. */
    const watch = async (d: Driver, id: string, label: string) => {
      await d.click(label, inRow(id, t("Watch offline")));
      await d.wait(async () => {
        const v = await d.video();
        return v.title !== null && !v.paused && v.width > 0 && v.time > 0.3;
      }, 45_000);
    };
    /** Reaches the Position scrubber with Tab, as a keyboard viewer does, and seeks to the end. */
    const seekEnd = async (d: Driver) => {
      const focused = () =>
        d.exists("document.activeElement?.matches('input[type=range][aria-label=Position]')");
      for (let tabs = 0; tabs < 24 && !(await focused()); tabs++) await d.key("Tab", 9);
      if (!(await focused())) throw new Error("Keyboard could not reach the Position scrubber");
      await d.key("End", 35);
    };
    const playing = (d: Driver, episode: string) =>
      d.wait(async () => {
        const v = await d.video();
        return (
          !!v.title?.includes(episode) &&
          !v.title.includes(t("Finished")) &&
          !v.paused &&
          v.width > 0 &&
          v.time > 0.3 &&
          v.frames > 0
        );
      }, 45_000);
    const remaining = async (d: Driver) =>
      new RegExp(t("Plays in {seconds}", { seconds: "(\\d+)" })).exec(await d.text())?.[1] ?? null;
    const leave = async (d: Driver) => {
      await d.key("Escape", 27);
      await d.wait(async () => (await d.video()).title === null);
    };
    /** What main and the window asked of the network between two moments, but the proxy's own. */
    const during = (from: number, until: number, requestsFrom: number) => {
      const local = (url: string) =>
        /^(mrstreamer:|data:|blob:|file:|devtools:|http:\/\/127\.0\.0\.1:\d+\/(title|source)\/)/.test(
          url,
        );
      const main = readLines(networkLog).filter(
        (line) => line.at >= from && line.at <= until && line.kind !== "ipc",
      );
      const seen = windowRequests.slice(requestsFrom).filter((request) => request.at <= until);
      return {
        main,
        window: seen.filter((request) => !local(request.url)),
        windowRequests: seen.length,
      };
    };

    // 1. Online: connect, save a short delay, and download S1 E2, S1 E3 and S2 E2 of the Dutch
    // version from its rows. S2 E2 is held by the provider when the earlier build follows.
    const online = await start("online", { kind: "candidate" });
    await online.wait(() =>
      online.page.evaluate<boolean>("document.querySelectorAll('form input').length >= 3"),
    );
    for (const [index, value] of [ownedProvider.url, "demo", "demo"].entries()) {
      await online.click(
        `Fill Connect field ${index + 1}`,
        `document.querySelectorAll('form input')[${index}]`,
      );
      await online.page.send("Input.insertText", { text: value });
    }
    await online.click("Submit Connect", "document.querySelector('form button[type=submit]')");
    await online.wait(() => online.exists("document.querySelector('header')"));
    injectedFailure("downloads-series");
    await openSettings(online);
    const delayField = labelled(t("Next episode delay"));
    await online.click(`Edit the delay to ${DELAY}`, delayField);
    await online.wait(() => online.exists(`document.activeElement === ${delayField}`));
    await online.page.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 4 : 2,
      commands: ["selectAll"],
    });
    await online.page.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      windowsVirtualKeyCode: 65,
      modifiers: process.platform === "darwin" ? 4 : 2,
    });
    await online.page.send("Input.insertText", { text: String(DELAY) });
    await online.key("Enter", 13);
    await online.wait(() =>
      online.page.evaluate<boolean>(
        `window.mrStreamer.invoke('preferences.get').then(r => r.ok && r.value.preferences.nextEpisodeDelaySeconds === ${DELAY})`,
      ),
    );
    await closeSettings(online);
    await online.click("Open Series", button("header button", t("Series")));
    await online.click("Open All series", button("nav button", t("All series")));
    await online.click(
      "Open the Formats series",
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Formats'))`,
    );
    // Automatic prefers the English version, which has one season: the viewer picks the Dutch one.
    await online.click(
      "Open its versions",
      `document.querySelector('[role=dialog] button[aria-label=${JSON.stringify(t("Versions"))}]')`,
    );
    await online.click(
      "Choose the two-season Dutch version",
      `[...document.querySelectorAll('[role=menuitemradio]')].find(e => e.getAttribute('aria-label')?.includes('Formats (NL)'))`,
    );
    const downloadEpisode = async (season: number, number: number) => {
      const episode = episodeLabel(season, number);
      await online.click(
        `Download ${episode}`,
        labelled(t("Download {title}", { title: episode })),
      );
    };
    const downloaded = (season: number, number: number) =>
      online.wait(
        () =>
          online.exists(
            labelled(t("Watch {title} offline", { title: episodeLabel(season, number) })),
          ),
        60_000,
      );
    await online.click("Open season 1", button("[role=dialog] button", "Seizoen 1"));
    await downloadEpisode(1, 2);
    await downloadEpisode(1, 3);
    await downloaded(1, 2);
    await downloaded(1, 3);
    if (previous) ownedProvider.stallEpisodeFile(fileOf(2, 2).id, 30_000, 120_000);
    await online.click("Open season 2", button("[role=dialog] button", "Season 2"));
    await downloadEpisode(2, 2);
    if (previous)
      await online.wait(
        async () =>
          (await online.listed()).some(
            (item) =>
              item.title.id === String(fileOf(2, 2).id) && item.status.kind === "transferring",
          ),
        60_000,
      );
    else await downloaded(2, 2);
    await online.capture("episodes-downloaded");
    await online.key("Escape", 27);
    await openDownloads(online);
    const ids = {
      s1e2: await idOf(online, 1, 2),
      s1e3: await idOf(online, 1, 3),
      s2e2: await idOf(online, 2, 2),
    };
    observed["ids"] = ids;
    observed["online"] = { standing: await standing(online), shelf: await shelf(online) };
    await online.capture("downloads-online");
    await quit("online");

    // 2. Optional: stable 0.0.19 on the same profile. It finishes S2 E2 (its transfer and settle
    // writes), plays this build's S1 E2 (its progress write) and downloads S1 E1 itself.
    if (previous) {
      ownedProvider.stallEpisodeFile(fileOf(2, 2).id, Number.MAX_SAFE_INTEGER, 0);
      const older = await start("previous", { kind: "previous", executable: previous });
      await older.wait(() => older.exists("document.querySelector('header')"), 60_000);
      await openDownloads(older);
      await older.wait(
        async () =>
          (await older.listed()).find((item) => item.id === ids.s2e2)?.status.kind === "complete",
        60_000,
      );
      await older.capture("previous-finished-the-queued-episode");
      await watch(older, ids.s1e2, "Watch this build's S1 E2 in the earlier build");
      await delay(2500, undefined, { signal: abort.signal });
      await leave(older);
      await older.wait(
        async () =>
          ((await older.listed()).find((item) => item.id === ids.s1e2)?.progress?.position ?? 0) >
          0,
      );
      await older.click("Open Series", button("header button", t("Series")));
      await older.click("Open All series", button("nav button", t("All series")));
      await older.click(
        "Open the Formats series",
        `[...document.querySelectorAll('button[title]')].find(b => b.title.includes('Formats'))`,
      );
      await older.click(
        "Open its versions",
        `document.querySelector('[role=dialog] button[aria-label=${JSON.stringify(t("Versions"))}]')`,
      );
      await older.click(
        "Choose the two-season Dutch version",
        `[...document.querySelectorAll('[role=menuitemradio]')].find(e => e.getAttribute('aria-label')?.includes('Formats (NL)'))`,
      );
      await older.click("Open season 1", button("[role=dialog] button", "Seizoen 1"));
      await older.click(
        "Download S1 E1 in the earlier build",
        labelled(t("Download {title}", { title: episodeLabel(1, 1) })),
      );
      await older.wait(
        () => older.exists(labelled(t("Watch {title} offline", { title: episodeLabel(1, 1) }))),
        60_000,
      );
      await older.key("Escape", 27);
      await openDownloads(older);
      observed["previousStart"] = { standing: await standing(older) };
      await older.capture("previous-downloads");
      await quit("previous");
    }

    // 3. The provider, TMDB and pictures stop. With the subscription saved, the copies are one
    // series, 0.0.19's own copy alone; autoplay off offers the next copy, Settings holds one.
    await ownedProvider.close();
    await tmdb.close();
    await new Promise<void>((resolve) => pictures!.close(() => resolve()));
    action("Stop the fake provider, TMDB and picture server");
    const stopped = await start("provider stopped", { kind: "candidate" });
    await stopped.wait(() => stopped.exists("document.querySelector('header')"));
    await openDownloads(stopped);
    await stopped.wait(async () => (await stopped.listed()).length === (previous ? 4 : 3));
    const legacy = previous ? await idOf(stopped, 1, 1) : null;
    const afterRestart = await standing(stopped);
    observed["providerStopped"] = { standing: afterRestart, shelf: await shelf(stopped) };
    const keyOf = (id: string) => afterRestart.find((item) => item.id === id)?.series ?? null;
    if (
      !keyOf(ids.s1e2) ||
      keyOf(ids.s1e2) !== keyOf(ids.s1e3) ||
      keyOf(ids.s1e2) !== keyOf(ids.s2e2) ||
      (legacy !== null && keyOf(legacy) !== null)
    )
      throw new Error(
        `The copies aren't one series, or 0.0.19's has one: ${JSON.stringify(afterRestart)}`,
      );
    const group = `document.querySelector('[data-series]')`;
    await stopped.wait(async () =>
      (await stopped.text("[data-series]")).includes(
        t("{episode} isn't on this computer", { episode: episodeLabel(2, 1) }),
      ),
    );
    if (
      legacy !== null &&
      (await stopped.exists(`(${group})?.querySelector('[data-download="${legacy}"]')`))
    )
      throw new Error("0.0.19's copy went into the series.");
    await stopped.capture("series-grouped");

    await openSettings(stopped);
    const autoplay = `document.querySelector('[role=checkbox][aria-label=${JSON.stringify(t("Next episode"))}]')`;
    await stopped.click("Turn autoplay off", autoplay);
    await stopped.wait(() =>
      stopped.page.evaluate<boolean>(
        "window.mrStreamer.invoke('preferences.get').then(r => r.ok && r.value.preferences.autoplayNext === false)",
      ),
    );
    await closeSettings(stopped);
    await watch(stopped, ids.s1e2, "Watch S1 E2 with autoplay off");
    await seekEnd(stopped);
    await stopped.wait(async () =>
      (await stopped.text()).includes(t("Finished {episode}", { episode: episodeLabel(1, 2) })),
    );
    await delay((DELAY + 2) * 1000, undefined, { signal: abort.signal });
    const autoplayOff = {
      text: await stopped.text(),
      remaining: await remaining(stopped),
      video: await stopped.video(),
    };
    observed["autoplayOff"] = autoplayOff;
    if (autoplayOff.remaining !== null || !autoplayOff.video.title?.includes(episodeLabel(1, 2)))
      throw new Error(
        `Autoplay off still counted down or moved on: ${JSON.stringify(autoplayOff)}`,
      );
    await stopped.capture("autoplay-off-offers-next");
    await stopped.click("Next episode", button("[data-view=title] button", t("Next episode")));
    await playing(stopped, episodeLabel(1, 3));
    await stopped.capture("next-copy-from-button");
    await leave(stopped);

    await openSettings(stopped);
    await stopped.click("Turn autoplay on", autoplay);
    await stopped.wait(() =>
      stopped.page.evaluate<boolean>(
        "window.mrStreamer.invoke('preferences.get').then(r => r.ok && r.value.preferences.autoplayNext === true)",
      ),
    );
    await closeSettings(stopped);
    await watch(stopped, ids.s1e2, "Watch S1 E2 again");
    await seekEnd(stopped);
    await stopped.wait(async () => (await remaining(stopped)) !== null);
    await openSettings(stopped);
    const held = await remaining(stopped);
    await delay((DELAY + 2) * 1000, undefined, { signal: abort.signal });
    const whileHeld = { held, after: await remaining(stopped), video: await stopped.video() };
    observed["settingsHold"] = whileHeld;
    if (whileHeld.after !== held || !whileHeld.video.title?.includes(episodeLabel(1, 2)))
      throw new Error(`Settings didn't hold the countdown: ${JSON.stringify(whileHeld)}`);
    await stopped.capture("countdown-held-by-settings");
    await closeSettings(stopped);
    await playing(stopped, episodeLabel(1, 3));
    await leave(stopped);

    // Remove the subscription through Settings: its copies stay.
    await stopped.click("Open Settings", labelled(t("Settings")));
    await stopped.click("Open Subscriptions", button("nav button", t("Subscriptions")));
    const subscriptionRow = `[...document.querySelectorAll('li')].find(r => r.querySelector('button')?.textContent.includes(' · '))`;
    for (let attempt = 1; ; attempt++) {
      await stopped.click(
        `Open the subscription (attempt ${attempt})`,
        `(${subscriptionRow})?.querySelector('button')`,
      );
      const opened = await stopped
        .wait(() => stopped.exists(`(${subscriptionRow})?.querySelector('[role=region]')`), 3000)
        .then(
          () => true,
          () => false,
        );
      if (opened) break;
      if (attempt === 3) throw new Error("The subscription's row didn't open.");
    }
    const [removeBefore, removeAfter] = t("Remove {name}", { name: "\n" }).split("\n");
    await stopped.click(
      "Ask to remove it",
      `[...(${subscriptionRow})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim().startsWith(${JSON.stringify(removeBefore?.trim() ?? "")}) && b.textContent.trim().endsWith(${JSON.stringify(removeAfter?.trim() ?? "")}))`,
    );
    await stopped.click(
      "Confirm removal",
      `[...(${subscriptionRow})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(t("Remove"))})`,
    );
    await stopped.wait(() => stopped.exists("document.querySelector('form input')"), 30_000);
    await quit("provider stopped");

    // 4. With no subscription saved: the countdown opens the next copy, which stops at S2 E1, not
    // on this computer, though S2 E2 is. Cancel keeps the copy; Next mid-play saves first; a next
    // file removed during the countdown stops it. Neither main nor the window reaches beyond the
    // app's loopback proxy meanwhile.
    const alone = await start("no subscription", { kind: "candidate" });
    await alone.click("Open Downloads from Connect", button("button", t("Downloads")));
    await alone.wait(async () => (await alone.listed()).length === (previous ? 4 : 3));
    await alone.wait(async () =>
      (await alone.text("[data-series]")).includes(t("Subscription removed, copy kept")),
    );
    observed["standalone"] = { standing: await standing(alone), shelf: await shelf(alone) };
    await alone.capture("series-without-subscription");
    const offlineFrom = Date.now();
    const offlineRequests = windowRequests.length;

    await watch(alone, ids.s1e2, "Watch S1 E2 without a subscription");
    await seekEnd(alone);
    await alone.wait(async () => (await remaining(alone)) !== null);
    observed["countdown"] = { text: await alone.text("[data-view=title]") };
    await alone.capture("countdown-to-next-copy");
    await playing(alone, episodeLabel(1, 3));
    observed["continued"] = { video: await alone.video() };
    await alone.capture("next-copy-playing");
    await seekEnd(alone);
    const gap = t("{episode} isn't on this computer", { episode: episodeLabel(2, 1) });
    await alone.wait(async () => (await alone.text()).includes(gap));
    await delay((DELAY + 2) * 1000, undefined, { signal: abort.signal });
    // Main kept the end of S1 E3's own copy: the copy that played was that one.
    const stoppedAtGap = {
      text: await alone.text("[data-view=title]"),
      video: await alone.video(),
      progress: (await standing(alone)).find((item) => item.id === ids.s1e3)?.progress ?? null,
    };
    observed["stoppedAtGap"] = stoppedAtGap;
    if (
      !stoppedAtGap.video.title?.includes(episodeLabel(1, 3)) ||
      (await remaining(alone)) !== null ||
      !stoppedAtGap.progress ||
      stoppedAtGap.progress.position < stoppedAtGap.progress.duration - 1
    )
      throw new Error(`Something played past the gap: ${JSON.stringify(stoppedAtGap)}`);
    await alone.capture("stopped-at-gap");
    await alone.click("Back from the end", button("[data-view=title] button", t("Back")));
    await alone.wait(async () => (await alone.video()).title === null);

    await watch(alone, ids.s1e2, "Watch S1 E2, to cancel its countdown");
    await seekEnd(alone);
    await alone.wait(async () => (await remaining(alone)) !== null);
    await alone.click("Cancel the countdown", button("[data-view=title] button", t("Cancel")));
    await delay((DELAY + 2) * 1000, undefined, { signal: abort.signal });
    const cancelled = {
      video: await alone.video(),
      remaining: await remaining(alone),
      progress: (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress ?? null,
    };
    observed["cancelled"] = cancelled;
    if (
      cancelled.remaining !== null ||
      !cancelled.video.title?.includes(t("Finished {episode}", { episode: episodeLabel(1, 2) })) ||
      !cancelled.progress ||
      cancelled.progress.position < cancelled.progress.duration - 1
    )
      throw new Error(`Cancel didn't keep the copy and its progress: ${JSON.stringify(cancelled)}`);
    await alone.capture("countdown-cancelled");
    await alone.click(
      "Next episode after Cancel",
      button("[data-view=title] button", t("Next episode")),
    );
    await playing(alone, episodeLabel(1, 3));
    await leave(alone);

    await watch(alone, ids.s1e2, "Watch S1 E2, to press N mid-play");
    await alone.wait(async () => (await alone.video()).time > 2);
    await alone.key("n", 78);
    await playing(alone, episodeLabel(1, 3));
    const midPlay = (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress ?? null;
    observed["nextMidPlay"] = { savedBeforeHandoff: midPlay, video: await alone.video() };
    if (!midPlay || midPlay.position < 1.5 || midPlay.position > midPlay.duration - 3)
      throw new Error(`N didn't save where S1 E2 got to first: ${JSON.stringify(midPlay)}`);
    await leave(alone);

    // While another connection holds the database's write lock past main's one-second wait,
    // S1 E2's progress can't be saved: N mid-play and the countdown at its end both keep S1 E2,
    // say so, and go on to nothing by themselves. Once the lock goes, Next plays S1 E3, saving
    // first. The lock is taken and read through the run's own profile, as a second copy of the
    // app would hold it; the window is driven as before.
    const stored = () =>
      (
        JSON.parse(
          String(
            locked?.prepare("select record from downloads where id = ?").get(ids.s1e2)?.["record"],
          ),
        ) as { progress: { position: number } | null }
      ).progress;
    const lock = () => {
      locked = new DatabaseSync(join(profile!, "mrstreamer.db"), { timeout: 5000 });
      locked.exec("begin immediate");
      action("Hold the profile database's write lock from another connection");
    };
    const unlock = () => {
      locked?.exec("rollback");
      locked?.close();
      locked = undefined;
      action("Let the profile database's write lock go");
    };
    // Every word the player's note says, as the window draws it: an observation only.
    await alone.page.evaluate(`(() => {
      const said = window.__noteSaid = [];
      new MutationObserver(() => {
        for (const note of document.querySelectorAll('[role=status]')) {
          const text = note.textContent.trim();
          if (text && said.at(-1) !== text) said.push(text);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    })()`);
    const noted = () => alone.page.evaluate<string[]>("window.__noteSaid ?? []");
    const refused = t("Couldn't save. Try again.");
    await watch(alone, ids.s1e2, "Watch S1 E2, to press N while its progress can't be saved");
    await alone.wait(async () => (await alone.video()).time > 2);
    const before = (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress ?? null;
    lock();
    await alone.key("n", 78);
    // Main gives up on the lock after a second; the next copy would have opened by now.
    await delay(4000, undefined, { signal: abort.signal });
    const refusedMidPlay = {
      video: await alone.video(),
      noted: await noted(),
      listed: (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress ?? null,
      stored: stored(),
      before,
    };
    observed["checkpointRefusedMidPlay"] = refusedMidPlay;
    await alone.capture("checkpoint-refused-mid-play");
    if (
      !refusedMidPlay.video.title?.includes(episodeLabel(1, 2)) ||
      refusedMidPlay.video.title.includes(episodeLabel(1, 3)) ||
      refusedMidPlay.video.paused ||
      !refusedMidPlay.noted.includes(refused) ||
      JSON.stringify(refusedMidPlay.listed) !== JSON.stringify(before)
    )
      throw new Error(`N went on from a save main refused: ${JSON.stringify(refusedMidPlay)}`);
    unlock();
    await alone.key("n", 78);
    await playing(alone, episodeLabel(1, 3));
    const keptMidPlay = (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress;
    observed["checkpointKeptMidPlay"] = { progress: keptMidPlay, video: await alone.video() };
    if (!keptMidPlay || keptMidPlay.position <= (before?.position ?? 0))
      throw new Error(`N after the lock went didn't save first: ${JSON.stringify(keptMidPlay)}`);
    await leave(alone);

    await watch(alone, ids.s1e2, "Watch S1 E2, to end while its progress can't be saved");
    await alone.page.evaluate("window.__noteSaid.length = 0");
    lock();
    await seekEnd(alone);
    await alone.wait(async () => (await remaining(alone)) !== null);
    // The countdown's end, main's second on the lock and as long again: nothing goes on.
    await delay((DELAY * 2 + 3) * 1000, undefined, { signal: abort.signal });
    const refusedAtEnd = {
      video: await alone.video(),
      remaining: await remaining(alone),
      noted: await noted(),
      listed: (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress ?? null,
      stored: stored(),
    };
    observed["checkpointRefusedAtEnd"] = refusedAtEnd;
    await alone.capture("checkpoint-refused-at-end");
    if (
      refusedAtEnd.remaining !== null ||
      !refusedAtEnd.video.title?.includes(
        t("Finished {episode}", { episode: episodeLabel(1, 2) }),
      ) ||
      !refusedAtEnd.noted.includes(refused)
    )
      throw new Error(
        `The countdown went on from a save main refused: ${JSON.stringify(refusedAtEnd)}`,
      );
    unlock();
    await alone.click(
      "Next episode once the lock went",
      button("[data-view=title] button", t("Next episode")),
    );
    await playing(alone, episodeLabel(1, 3));
    const keptAtEnd = (await standing(alone)).find((item) => item.id === ids.s1e2)?.progress;
    observed["checkpointKeptAtEnd"] = { progress: keptAtEnd, video: await alone.video() };
    if (!keptAtEnd || keptAtEnd.position < keptAtEnd.duration - 1)
      throw new Error(
        `Next after the lock went didn't save the end first: ${JSON.stringify(keptAtEnd)}`,
      );
    await leave(alone);

    await watch(alone, ids.s1e2, "Watch S1 E2, its next file to be removed");
    await seekEnd(alone);
    await alone.wait(async () => (await remaining(alone)) !== null);
    const folder = join(profile, "downloads", ids.s1e3);
    const media = (await readdir(folder)).find((name) => name.startsWith("media."));
    if (!media) throw new Error("S1 E3's copy has no file to remove.");
    await rm(join(folder, media));
    action("Remove S1 E3's copy file from the run's profile during the countdown");
    const goneNext = t("{episode} isn't on this computer", { episode: episodeLabel(1, 3) });
    await alone.wait(async () => (await alone.text()).includes(goneNext), (DELAY + 10) * 1000);
    const missingNext = {
      text: await alone.text("[data-view=title]"),
      video: await alone.video(),
      standing: await standing(alone),
    };
    observed["missingNext"] = missingNext;
    if (
      !missingNext.video.title?.includes(t("Finished {episode}", { episode: episodeLabel(1, 2) }))
    )
      throw new Error(`A missing next file moved off the copy: ${JSON.stringify(missingNext)}`);
    await alone.capture("next-file-gone");
    await alone.click("Back from the end", button("[data-view=title] button", t("Back")));
    await alone.wait(async () => (await alone.video()).title === null);

    if (legacy !== null) {
      await watch(alone, legacy, "Watch 0.0.19's S1 E1");
      await seekEnd(alone);
      await alone.wait(async () => (await alone.text()).includes(t("Play again")), 60_000);
      await delay((DELAY + 2) * 1000, undefined, { signal: abort.signal });
      const legacyEnd = { text: await alone.text("[data-view=title]"), video: await alone.video() };
      observed["legacyEnd"] = legacyEnd;
      if (
        (await remaining(alone)) !== null ||
        !legacyEnd.video.title?.includes(episodeLabel(1, 1)) ||
        legacyEnd.text.includes(t("Downloads"))
      )
        throw new Error(`0.0.19's copy offered something next: ${JSON.stringify(legacyEnd)}`);
      await alone.capture("previous-copy-ends-alone");
      // Its end keeps the controls, the Position thumb holding the keyboard: Back leaves.
      await alone.click("Back from 0.0.19's copy", button("[data-view=title] button", t("Back")));
      await alone.wait(async () => (await alone.video()).title === null);
    }
    observed["offlinePlayback"] = during(offlineFrom, Date.now(), offlineRequests);
    observed["standaloneAfter"] = { standing: await standing(alone) };
    await quit("no subscription");

    // 5. A last start: progress and the gone file are as left, and the copies still play.
    const last = await start("restart", { kind: "candidate" });
    await last.click("Open Downloads from Connect", button("button", t("Downloads")));
    await last.wait(async () => (await last.listed()).length === (previous ? 4 : 3));
    const restartFrom = Date.now();
    const restartRequests = windowRequests.length;
    const restarted = await standing(last);
    observed["restart"] = { standing: restarted, shelf: await shelf(last) };
    if (
      restarted.find((item) => item.id === ids.s1e3)?.status !== "missing" ||
      !restarted.find((item) => item.id === ids.s1e2)?.progress
    )
      throw new Error(`The restart lost progress or the gone file: ${JSON.stringify(restarted)}`);
    await last.wait(async () =>
      (await last.text(`[data-download="${ids.s1e3}"]`)).includes(
        t("The file is no longer on this computer."),
      ),
    );
    await last.capture("restart-progress-and-gone-file");
    await watch(last, ids.s2e2, "Watch S2 E2 after the restart");
    await seekEnd(last);
    await last.wait(async () => (await last.text()).includes(t("That was the last episode")));
    await last.capture("last-episode");
    await leave(last);
    observed["restartPlayback"] = during(restartFrom, Date.now(), restartRequests);
    await quit("restart");

    for (const name of ["offlinePlayback", "restartPlayback"]) {
      const seen = observed[name] as ReturnType<typeof during>;
      if (seen.main.length > 0 || seen.window.length > 0)
        throw new Error(`${name} reached beyond the app's loopback proxy: ${JSON.stringify(seen)}`);
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
    // The app's own writes as it quits wait on the lock: it goes first.
    if (locked) {
      const held = locked;
      await clean(async () => {
        held.exec("rollback");
        held.close();
      });
      locked = undefined;
    }
    observed["lockReleased"] = locked === undefined;
    if (running) {
      const owned = running;
      await clean(() => stop(owned.app, owned.page));
      owned.page?.close();
    }
    if (provider) {
      observed["streamsAfterExit"] = provider.activeStreams();
      await clean(() => provider!.close());
    }
    if (tmdb) await clean(() => tmdb!.close());
    if (pictures?.listening)
      await clean(() => new Promise<void>((resolve) => pictures!.close(() => resolve())));
    observed["mainNetwork"] = summarise(networkLog, observed["fixturePorts"]);
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
          scenario: "downloads-series",
          build,
          previous: previous ?? null,
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
            "Main's connections are recorded for this build's starts only; a packaged earlier build takes no --require",
            "A copy's identity is observed through main's list, which keeps progress by copy, and the player's words",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failed ? "FAIL" : "PASS"} downloads-series: ${evidence}`);
  }
  if (failed) throw failed;
}

/** The network hook's lines, or none before it wrote any. */
function readLines(path: string): { at: number; kind: string }[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { at: number; kind: string });
  } catch {
    return [];
  }
}
