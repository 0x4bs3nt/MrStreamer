// The downloads-queue scenario of `pnpm verify:desktop`: Pause, Resume, Up and Down on the
// Downloads page's rows and Pause all in its heading, driven through the built app's window with
// pointer and key input, on one profile started twice. Four movies are queued from their details,
// the first failing at once. The transfer is paused from the keyboard, a queued one moved up from
// the keyboard, the queue paused whole with the pointer and one resumed, then a title of the same
// subscription plays: what was resumed waits for it, what the viewer paused stays paused. The next
// start must find the pauses and the order kept; a paused file the provider replaced starts again
// and says so, Cancel takes a partial file with it. The fake provider counts files sent at once.
//   With `--previous <executable>`, a build from before pauses existed (stable 0.0.19's, as its
// AppImage unpacks) starts on the same profile between the two: it must read every download,
// transfer the paused ones in the order they were added, which is the limit of going back, and
// keep what this build wrote through its own transfer, retry and progress writes, so the next
// start finds the unfinished ones paused and in their places again.
//   Main's connections are recorded by network-hook.cjs for this build's starts; the window of
// either build resolves no host but loopback. Proof stays in `.local/verification/`.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connect, type Page } from "../../../../apps/desktop/test/e2e/app.ts";
import { fixture, startFakeProvider } from "../../../../apps/desktop/test/fake-provider.ts";
import { startFakeTmdb } from "../../../../apps/desktop/test/fake-tmdb.ts";
import { SOURCE_LOCALE } from "../../../../packages/contracts/src/language.ts";
import { setLanguage, t } from "../../../../packages/core/src/i18n.ts";
import { evidenceDirectory, freePort, injectedFailure, record, stop } from "./session.ts";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const desktop = join(root, "apps/desktop");
const hook = fileURLToPath(new URL("./network-hook.cjs", import.meta.url));

/** A download as main lists it to the window: read as an observation, never changed. */
interface Listed {
  readonly id: string;
  readonly status: { readonly kind: string; readonly received?: number };
  readonly progress: { readonly position: number } | null;
  readonly title: { readonly kind: string; readonly id: string };
}

/** Which build a start runs: this checkout's, or an earlier one's packaged executable. */
type Build =
  { readonly kind: "candidate" } | { readonly kind: "previous"; readonly executable: string };

export async function runDownloadsQueue(
  build: Record<string, unknown> & { executable: string },
  previous?: string,
) {
  setLanguage({ locale: SOURCE_LOCALE, formats: SOURCE_LOCALE });
  const evidence = await evidenceDirectory(
    join(root, ".local/verification"),
    previous ? "downloads-queue-previous-" : "downloads-queue-",
  );
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Verification interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const actions: { action: string; at: string }[] = [];
  const observed: Record<string, unknown> = { build };
  const log: string[] = [];
  const networkLog = join(evidence, "main-network.jsonl");
  let profile: string | undefined;
  let provider: Awaited<ReturnType<typeof startFakeProvider>> | undefined;
  let tmdb: Awaited<ReturnType<typeof startFakeTmdb>> | undefined;
  let pictures: Server | undefined;
  let running: { app: ChildProcess; page?: Page } | undefined;
  let failed: unknown;
  const cleanupErrors: string[] = [];
  const now = () => new Date().toISOString();
  const action = (label: string) => actions.push({ action: label, at: now() });
  try {
    if (previous) {
      const executable = previous;
      await access(executable);
      const asar = await readFile(join(dirname(executable), "resources/app.asar"));
      observed["previous"] = {
        executable,
        appAsarSha256: createHash("sha256").update(asar).digest("hex"),
        // What the earlier build's record knows: no pause or place among its keys.
        declaresPausedAt: asar.includes("pausedAt"),
        states: asar.includes("'queued' | 'failed' | 'complete'"),
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
      starts.push({
        label,
        build: which.kind,
        executable,
        pid: app.pid,
        port,
        profile,
        url,
        at: now(),
      });
      await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
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
      const key = async (name: string, code: number) => {
        action(`Press ${name}`);
        for (const type of ["rawKeyDown", "keyUp"])
          await page.send("Input.dispatchKeyEvent", {
            type,
            key: name,
            code: name,
            windowsVirtualKeyCode: code,
          });
      };
      /** Enter or Space as a keyboard sends it, which presses a focused button. */
      const press = async (name: "Enter" | " ") => {
        action(`Press ${name === " " ? "Space" : name}`);
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
            action(`${label} (${tabs} Tab presses)`);
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
        page.evaluate<{ time: number; width: number; paused: boolean; title: boolean }>(`(() => {
          const v = document.querySelector('video');
          return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, paused: v?.paused ?? true,
            title: !!document.querySelector('[data-view=title]') };
        })()`);
      const listed = () =>
        page.evaluate<Listed[]>(
          "window.mrStreamer.invoke('downloads.list').then(r => r.ok ? r.value.items : [])",
        );
      /** The download rows in the order the page draws them. */
      const rows = () =>
        page.evaluate<string[]>(
          "[...document.querySelectorAll('[data-download]')].map(r => r.dataset.download)",
        );
      /** What has the keyboard: its aria-label, else its words. */
      const focused = () =>
        page.evaluate<string | null>(
          "document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? null",
        );
      return {
        page,
        wait,
        exists,
        capture,
        click,
        key,
        press,
        tabTo,
        text,
        video,
        listed,
        rows,
        focused,
      };
    };
    type Driver = ReturnType<typeof driver>;

    const button = (selector: string, words: string) =>
      `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const poster = (words: string) =>
      `[...document.querySelectorAll('button[title]')].find(b => b.title.includes(${JSON.stringify(words)}))`;
    const row = (id: string) => `document.querySelector('[data-download="${id}"]')`;
    const inRow = (id: string, words: string) =>
      `[...(${row(id)})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
    const hold = (id: string) => `(${row(id)})?.querySelector('[data-hold]')`;
    const arrow = (id: string, by: -1 | 1) => `(${row(id)})?.querySelector('[data-move="${by}"]')`;
    const notice = () =>
      `document.querySelector(${JSON.stringify(`header [aria-label^="${t("Downloads, {status}", { status: "" })}"]`)})`;
    const statuses = async (d: Driver) =>
      Object.fromEntries((await d.listed()).map((item) => [item.id, item.status]));
    const statusOf = async (d: Driver, id: string) =>
      (await d.listed()).find((item) => item.id === id)?.status;
    const openDownloads = async (d: Driver) => {
      await d.click("Open Downloads", button("header button", t("Downloads")));
      await d.wait(() =>
        d.exists(`document.querySelector('h1')?.textContent === ${JSON.stringify(t("Downloads"))}`),
      );
    };
    const movies = ownedProvider.titles.movies;
    const named = (words: string) => {
      const found = movies.find((each) => each.name.startsWith(words));
      if (!found) throw new Error(`No movie ${words}`);
      return found;
    };
    const missing = named("TEST | Missing file");
    const first = named("TEST | Two sound tracks and subtitles (MULTI)");
    const second = named("TEST | Old AVI");
    const third = named("TEST | Long subtitles");
    const idOf = async (d: Driver, movieId: number) => {
      const found = (await d.listed()).find((item) => item.title.id === String(movieId));
      if (!found) throw new Error(`No download of movie ${movieId}`);
      return found.id;
    };
    /** A copy's file in the run's profile, by its SHA-256: an observation of the disk. */
    const copyDigest = async (id: string) => {
      const folder = join(profile!, "downloads", id);
      const media = (await readdir(folder)).find(
        (name) => name.startsWith("media.") && !name.endsWith(".part"),
      );
      if (!media) return null;
      return createHash("sha256")
        .update(await readFile(join(folder, media)))
        .digest("hex");
    };
    const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

    // 1. Connect, then queue four movies from their details: the first fails at once, the next
    // transfers, held by the provider, and the other two wait their turn.
    ownedProvider.stallMovieFile(first.id, 200_000, 120_000);
    ownedProvider.stallMovieFile(second.id, 30_000, 120_000);
    ownedProvider.stallMovieFile(third.id, 30_000, 120_000);
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
    injectedFailure("downloads-queue");
    const queue = async (movie: { readonly name: string }, words: string, until: string) => {
      await online.click("Open Movies", button("header button", t("Movies")));
      await online.click("Open All movies", button("nav button", t("All movies")));
      await online.click(
        `Open ${words}`,
        poster(movie.name.replace(/^TEST \| /, "").replace(/ \(.*$/, "")),
      );
      await online.click(`Download ${words}`, button('[role="dialog"] button', t("Download")));
      await online.wait(async () => (await online.text('[role="dialog"]')).includes(until), 60_000);
      await online.key("Escape", 27);
    };
    await queue(missing, "the missing-file movie", t("Retry"));
    await queue(first, "the two-sound-track movie", "%");
    await queue(second, "the AVI movie", t("Queued"));
    await queue(third, "the long-subtitles movie", t("Queued"));
    await openDownloads(online);
    const [d, a, b, c] = [
      await idOf(online, missing.id),
      await idOf(online, first.id),
      await idOf(online, second.id),
      await idOf(online, third.id),
    ];
    observed["ids"] = { failing: d, first: a, second: b, third: c };
    await online.wait(async () => (await statusOf(online, a))?.received === 200_000);
    await online.capture("queue-transferring");
    if ((await online.rows()).join() !== [a, b, c, d].join())
      throw new Error(`The queue isn't drawn in its order: ${await online.rows()}`);

    // Where the keyboard is and the rows' order, each time either changes: an observation only.
    await online.page.evaluate(`(() => {
      const log = window.__keyboard = [];
      const start = performance.now();
      const at = () => Math.round(performance.now() - start);
      const name = (element) =>
        element ? element.getAttribute('aria-label') ?? element.textContent.trim() : null;
      for (const type of ['focusin', 'focusout'])
        document.addEventListener(type, (event) => log.push([at(), type, name(event.target)]), true);
      new MutationObserver(() => log.push([at(), 'rows',
        [...document.querySelectorAll('[data-download]')].map((row) => row.dataset.download.slice(0, 8))]))
        .observe(document.querySelector('section'), { childList: true });
    })()`);
    const keyboardLog = () => online.page.evaluate<unknown[]>("window.__keyboard ?? []");

    // 2. Pause the transfer from the keyboard: it stops once its request ended, keeps its bytes,
    // and the keyboard stays on its row's control, now Resume, though the row moved.
    await online.tabTo("Tab to the transfer's Pause", hold(a));
    await online.press(" ");
    await online.wait(async () => (await statusOf(online, a))?.kind === "paused");
    await online.wait(async () =>
      (await online.text(`[data-download="${a}"]`)).includes(t("Paused")),
    );
    await online.wait(async () => (await statusOf(online, b))?.received === 30_000);
    const pausedTransfer = {
      status: await statusOf(online, a),
      row: await online.text(`[data-download="${a}"]`),
      keyboard: await online.focused(),
      keyboardOnItsRow: await online.exists(`(${hold(a)}) === document.activeElement`),
      rows: await online.rows(),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
    };
    observed["pausedTransfer"] = pausedTransfer;
    if (!pausedTransfer.keyboardOnItsRow || pausedTransfer.keyboard !== t("Resume download"))
      throw new Error(`The keyboard left the paused row: ${JSON.stringify(pausedTransfer)}`);
    await online.capture("transfer-paused-from-keyboard");

    // 3. Move the last one up from the keyboard: past the paused one, to the top of those waiting,
    // where Up goes no further and Down has the keyboard. The transfer under way doesn't stop.
    const asked = ownedProvider.fileRequests();
    await online.tabTo("Tab to the last one's Up", arrow(c, -1));
    await online.press("Enter");
    await online.wait(async () => (await online.rows()).join() === [b, c, a, d].join());
    await online
      .wait(() => online.exists(`(${arrow(c, 1)}) === document.activeElement`), 5000)
      .finally(async () => {
        observed["keyboardLog"] = await keyboardLog().catch(() => null);
      });
    const moved = {
      rows: await online.rows(),
      keyboard: await online.focused(),
      upDisabled: await online.exists(`(${arrow(c, -1)}).disabled`),
      transfer: await statusOf(online, b),
      newFileRequests: ownedProvider.fileRequests() - asked,
    };
    observed["movedFromKeyboard"] = moved;
    if (moved.transfer?.kind !== "transferring" || moved.newFileRequests !== 0)
      throw new Error(`The move stopped the transfer: ${JSON.stringify(moved)}`);
    await online.capture("moved-from-keyboard");

    // 4. Pause all with the pointer: the transfer stops too, the heading offers Resume all, and
    // the top bar on another page says Paused, quietly.
    await online.click("Pause all", button("button", t("Pause all")));
    await online.wait(async () => {
      const now = await statuses(online);
      return [a, b, c].every((id) => now[id]?.kind === "paused") && now[d]?.kind === "failed";
    });
    await online.wait(async () => ownedProvider.activeStreams() === 0, 5000);
    await online.wait(() => online.exists(button("button", t("Resume all"))));
    observed["allPaused"] = { statuses: await statuses(online), rows: await online.rows() };
    await online.capture("all-paused");
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.wait(
      async () =>
        (await online.page.evaluate<string | null>(`(${notice()})?.textContent.trim() ?? null`)) ===
        t("Paused"),
    );
    observed["noticeAllPaused"] = await online.page.evaluate(`(() => {
      const n = ${notice()};
      return { text: n.textContent.trim(), label: n.getAttribute('aria-label'),
        quiet: n.className.includes('text-muted-foreground') };
    })()`);
    await online.capture("notice-paused");
    await openDownloads(online);

    // 5. Resume the one moved first; then play a title of the same subscription: it waits for
    // playback, while the paused ones stay paused, and only one file is sent at a time.
    await online.click("Resume the one moved first", hold(c));
    await online.wait(async () => (await statusOf(online, c))?.received === 30_000);
    await online.click("Open Movies", button("header button", t("Movies")));
    await online.click("Open All movies", button("nav button", t("All movies")));
    await online.click("Open the index-at-the-end movie", poster("Index at the end"));
    await online.click(
      "Play it from the same subscription",
      button('[role="dialog"] button', t("Play")),
    );
    await online.wait(async () => {
      const v = await online.video();
      return v.title && !v.paused && v.width > 0 && v.time > 1;
    }, 45_000);
    await online.wait(async () => (await statusOf(online, c))?.kind === "waiting");
    const whilePlaying = {
      statuses: await statuses(online),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
      playback: await online.video(),
    };
    observed["whilePlaying"] = whilePlaying;
    if (![a, b].every((id) => whilePlaying.statuses[id]?.kind === "paused"))
      throw new Error(`Playback changed a pause: ${JSON.stringify(whilePlaying)}`);
    await online.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 400, y: 300 });
    await delay(400, undefined, { signal: abort.signal });
    await online.capture("paused-and-waiting-while-playing");
    // Held again further on, so it is seen going on once playback ends.
    ownedProvider.stallMovieFile(third.id, 60_000, 120_000);
    await online.key("Escape", 27);
    await online.wait(async () => !(await online.video()).title);
    await online.wait(async () => {
      const status = await statusOf(online, c);
      return status?.kind === "transferring" && status.received === 60_000;
    });
    // Given back, the connection goes to the resumed one only, however long it waits.
    await delay(2000, undefined, { signal: abort.signal });
    const afterPlayback = {
      statuses: await statuses(online),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
    };
    observed["afterPlayback"] = afterPlayback;
    if (
      ![a, b].every((id) => afterPlayback.statuses[id]?.kind === "paused") ||
      afterPlayback.mostFilesAtOnce !== 1
    )
      throw new Error(`Playback ending took a paused download: ${JSON.stringify(afterPlayback)}`);
    await quit("online");
    ownedProvider.stallMovieFile(third.id, 80_000, 120_000);

    // Optional: the earlier build on the same profile. It can't know a pause or a place: it reads
    // every download, transfers them in the order added, the paused first one among them, keeps
    // the keys through its writes, retries the failed one and keeps a copy's progress.
    if (previous) {
      ownedProvider.stallMovieFile(second.id, 60_000, 120_000);
      const older = await start("previous", { kind: "previous", executable: previous });
      await older.wait(() => older.exists("document.querySelector('header')"), 60_000);
      await openDownloads(older);
      const read = await older.listed();
      await older.wait(async () => (await statusOf(older, a))?.kind === "complete", 60_000);
      await older.wait(async () => ((await statusOf(older, b))?.received ?? 0) >= 60_000, 60_000);
      const transferred = await statuses(older);
      await older.capture("previous-transfers-in-added-order");
      await older.click("Retry the failed one in the earlier build", inRow(d, t("Retry")));
      await older.wait(async () => (await statusOf(older, d))?.kind !== "failed");
      await older.click(
        "Watch the first copy offline in the earlier build",
        inRow(a, t("Watch offline")),
      );
      await older.wait(async () => {
        const v = await older.video();
        return v.title && !v.paused && v.width > 0 && v.time > 3;
      }, 45_000);
      await older.key("Escape", 27);
      await older.wait(async () => !(await older.video()).title);
      await older.wait(
        async () =>
          ((await older.listed()).find((item) => item.id === a)?.progress?.position ?? 0) > 0,
      );
      observed["previousStart"] = {
        readOnStart: read.map((item) => [item.id, item.status.kind]),
        transferred,
        afterRetryAndPlayback: (await older.listed()).map((item) => [
          item.id,
          item.status,
          item.progress,
        ]),
        rows: await older.rows(),
      };
      await older.capture("previous-after-retry-and-playback");
      await quit("previous");
    }

    // 6. Start again: the pauses and the order are kept. The one moved first goes before the
    // others; a failed one queued again by the earlier build keeps its own place before it.
    const again = await start("again", { kind: "candidate" });
    await again.wait(() => again.exists("document.querySelector('header')"), 60_000);
    await openDownloads(again);
    await again.wait(async () => {
      const status = await statusOf(again, c);
      return status?.kind === "transferring" && status.received === 80_000;
    }, 60_000);
    const restarted = { statuses: await statuses(again), rows: await again.rows() };
    observed["afterRestart"] = restarted;
    if (restarted.statuses[b]?.kind !== "paused")
      throw new Error(`The second one lost its pause: ${JSON.stringify(restarted)}`);
    if (!previous && restarted.statuses[a]?.kind !== "paused")
      throw new Error(`The first one lost its pause: ${JSON.stringify(restarted)}`);
    if (restarted.rows.indexOf(c) > restarted.rows.indexOf(b))
      throw new Error(`The order wasn't kept: ${JSON.stringify(restarted)}`);
    await again.capture("after-restart");

    // 7. Cancel the transfer with the pointer: its row and partial file go.
    await again.click("Cancel the transfer", inRow(c, t("Cancel")));
    await again.wait(async () => !(await again.exists(row(c))));
    const cancelledFolder = await stat(join(profile, "downloads", c)).then(
      () => "kept",
      () => "gone",
    );
    observed["cancelled"] = {
      folder: cancelledFolder,
      listed: (await again.listed()).some((item) => item.id === c),
    };
    if (cancelledFolder !== "gone") throw new Error("Cancel kept the partial file.");

    // 8. The provider replaced the second one's file: resumed from the keyboard, it starts again
    // and says so, and the copy is the new file whole.
    const replacement = fixture("title-long-subs.mkv");
    ownedProvider.replaceMovieFile(second.id, replacement);
    ownedProvider.stallMovieFile(second.id, 30_000, 3000);
    action("Replace the second movie's file at the provider");
    await again.tabTo("Tab to the second one's Resume", hold(b));
    await again.press(" ");
    await again.wait(async () =>
      (await again.text(`[data-download="${b}"]`)).includes(t("started again, the file changed")),
    );
    await again.capture("resumed-file-changed");
    await again.wait(async () => (await statusOf(again, b))?.kind === "complete", 60_000);
    observed["changedFile"] = {
      copy: await copyDigest(b),
      replacement: digest(replacement),
    };
    if ((observed["changedFile"] as { copy: string | null }).copy !== digest(replacement))
      throw new Error("The resumed copy isn't the provider's new file.");

    // 9. What is left: the first one resumed when still paused, the failed one deleted.
    if ((await statusOf(again, a))?.kind === "paused") {
      ownedProvider.stallMovieFile(first.id, Number.MAX_SAFE_INTEGER, 0);
      await again.click("Resume the first one", hold(a));
    }
    await again.wait(async () => (await statusOf(again, a))?.kind === "complete", 60_000);
    await again.wait(async () => (await statusOf(again, d))?.kind === "failed", 60_000);
    await again.click("Delete the failed one", inRow(d, t("Delete")));
    await again.wait(async () => !(await again.exists(row(d))));
    observed["final"] = {
      statuses: await statuses(again),
      firstCopy: await copyDigest(a),
      firstFile: digest(fixture(first.fixture!)),
      mostFilesAtOnce: ownedProvider.mostFilesAtOnce(),
    };
    await again.capture("final");
    if (
      (observed["final"] as { firstCopy: string | null }).firstCopy !==
      digest(fixture(first.fixture!))
    )
      throw new Error("The first copy isn't the provider's file.");
    if (ownedProvider.mostFilesAtOnce() !== 1)
      throw new Error("The provider sent two files at once.");
    await quit("again");
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
          scenario: "downloads-queue",
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
            "A receiver taking the connection is covered by the service tests, not this window",
            "Main's connections are recorded for this build's starts only; a packaged earlier build takes no --require",
          ],
        },
        null,
        2,
      ),
    );
    console.log(`${failed ? "FAIL" : "PASS"} downloads-queue: ${evidence}`);
  }
  if (failed) throw failed;
}

/** Main's connections by where they went, with the fixtures named. */
function summarise(path: string, fixtures: unknown) {
  const ports = new Set(Array.isArray(fixtures) ? fixtures : []);
  const by = new Map<string, number>();
  let lines: { kind: string; host?: string; port?: number }[] = [];
  try {
    lines = readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { kind: string; host?: string; port?: number });
  } catch {
    // No connection written down.
  }
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

/** Answers every path with the same small picture, as an artwork CDN would. */
async function pictureServer(): Promise<Server> {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk2PH/PwAFTgKWx2D3tQAAAABJRU5ErkJggg==",
    "base64",
  );
  const server = createServer((_request, response) =>
    response.writeHead(200, { "Content-Type": "image/png" }).end(png),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}
