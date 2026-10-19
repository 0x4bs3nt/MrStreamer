// The Windows installed upgrade check, which a stable release run makes before publishing and
// `.github/workflows/upgrade-check.yml` makes by hand from main, on a disposable GitHub-hosted
// runner. It installs the newest published stable release, then the published candidate nightly
// over it with the per-user NSIS setup into the same folder, and starts the app three times on
// one profile of its own:
//
// 1. stable: connect the fake provider, choose HD, Dutch sound and French subtitles, star two
//    channels, save a movie to the watchlist and play part of it and an episode, and save an
//    online subtitle with its timing through the subtitle panel. Download two movies and an
//    episode, play the copies and resume, then restore the original Dutch sound preference.
// 2. candidate: those settings, favourites in order, watchlist, progress and the saved subtitle
//    are all still there, with no new subtitle request. Before playing anything, require stable's
//    completed copies with their details, artwork and local progress. Play those inherited copies:
//    resume, skip, change sound track, show embedded French and saved online subtitles.
// 3. candidate-restart: the same installed files start again, and what the candidate left is all
//    still there, copies, artwork and their progress included. Remove the subscription in
//    Settings, stop the provider, TMDB, artwork and subtitle service, block outbound connections
//    of the installed app and its bundled ffmpeg and ffprobe, see the block refuse them, and play
//    the copies again from Connect's Downloads.
//
// Every change goes through the window with pointer and keys; the check reads state only through
// the app's public, read-only calls. At each start it checks the process runs the installed
// executable, the window shows the installed app.asar, and the app and Settings > About name the
// expected version and commit. Before each setup and at the end, every process the app started has
// ended, each start by a graceful close. Evidence goes beside the profile, never in it: a
// proof.json and screenshots with their text. On success the check uninstalls the app and removes
// the profile; on failure it keeps them and their lock for the workflow to upload, and changes
// nothing more.
//
//   node apps/desktop/test/e2e/installed-upgrade.ts resolve --candidate <nightly tag> [--sha <its commit>] --out <new folder>
//   node apps/desktop/test/e2e/installed-upgrade.ts run --packages <folder> --root <new folder under RUNNER_TEMP>
//
// `resolve` needs GH_TOKEN and GITHUB_REPOSITORY and runs anywhere; installed-upgrade-packages.ts
// says what it checks. `run` runs only on that runner, from main.
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { isDeepStrictEqual, parseArgs } from "node:util";
import type { Result } from "../../../../packages/contracts/src/errors.ts";
import type { IpcArgs, IpcMethod, IpcOutput } from "../../../../packages/contracts/src/ipc.ts";
import { installCatalogueWorkerProbe, type Evidence } from "./installed-catalogue-worker.ts";
import { catalogueWorkerScripts } from "./installed-worker-scripts.ts";
import { startFakeProvider, type FakeProvider } from "../fake-provider.ts";
import { startFakeTmdb } from "../fake-tmdb.ts";
import { connect, launch, type Page } from "./app.ts";
import {
  bootstrapSubtitles,
  pauseMain,
  inspectorOwner,
  resumeMain,
  startSubtitleFixture,
  configureSubtitleUi,
  seedSubtitleUi,
  observeSavedSubtitle,
  subtitleRequests,
} from "./installed-subtitles.ts";
import {
  check,
  readReceipt,
  resolvePackages,
  restGitHub,
  sha256,
  type Package,
} from "./installed-upgrade-packages.ts";
import {
  disposableRunner,
  fileSha256,
  install,
  outboundBlock,
  ownedTree,
  processes,
  toolProbe,
  uninstall,
  type Runner,
} from "./installed-upgrade-windows.ts";

/** The three starts: stable, the candidate installed over it, then that candidate again. */
type Stage = Package["stage"] | "candidate-restart";
type RunPackage = Omit<Package, "stage"> & { readonly stage: Stage };

/** A public address the window reaches before the block and not after it. Its CSP allows it. */
const OUTSIDE = "https://example.com/";
/** The same for the bundled ffmpeg and ffprobe, which read plain http and have no TLS. */
const TOOLS_OUTSIDE = "http://example.com/";

// ---------------------------------------------------------------------------------------------
// Fake services

/**
 * The fake provider and TMDB behind one loopback address that stays the same through all three
 * starts, so the subscription saved by the stable release keeps working. Their artwork links
 * point at that address too, and TMDB's own picture paths are left out, so no picture is fetched
 * from anywhere else.
 */
export async function startServices() {
  const provider = await startFakeProvider({ channels: 20, titles: 10 });
  const tmdb = await startFakeTmdb();
  const picture = greyPicture(60, 90);
  const catalogueRequests: {
    action: string;
    startedAt: string;
    finishedAt?: string;
    status?: number;
    rows?: number;
  }[] = [];
  let origin = "";
  const front: Server = createServer((request, response) => {
    void (async () => {
      if (request.url?.startsWith("/picture/")) {
        response.writeHead(200, { "Content-Type": "image/png" }).end(picture);
        return;
      }
      const toTmdb = request.url?.startsWith("/3/") ?? false;
      const action = new URL(request.url ?? "/", "http://fixture.local").searchParams.get("action");
      const catalogue: (typeof catalogueRequests)[number] | undefined =
        !toTmdb &&
        action &&
        ["get_vod_categories", "get_vod_streams", "get_series_categories", "get_series"].includes(
          action,
        )
          ? { action, startedAt: new Date().toISOString() }
          : undefined;
      if (catalogue) catalogueRequests.push(catalogue);
      const headers = new Headers();
      for (const name of ["range", "if-range", "if-none-match", "if-modified-since"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const upstream = await fetch(
        `${toTmdb ? new URL(tmdb.url).origin : provider.url}${request.url ?? "/"}`,
        { method: request.method ?? "GET", headers, redirect: "manual" },
      );
      let body = Buffer.from(await upstream.arrayBuffer());
      if (catalogue) {
        const rows: unknown = upstream.headers.get("content-type")?.includes("json")
          ? JSON.parse(body.toString())
          : null;
        catalogue.finishedAt = new Date().toISOString();
        catalogue.status = upstream.status;
        if (Array.isArray(rows)) catalogue.rows = rows.length;
      }
      if (upstream.headers.get("content-type")?.includes("json")) {
        const text = JSON.stringify(
          JSON.parse(body.toString(), (key: string, value: unknown) =>
            toTmdb && key.endsWith("_path") ? null : value,
          ),
        ).replaceAll("https://image.example", `${origin}/picture`);
        body = Buffer.from(text);
      }
      for (const [name, value] of upstream.headers)
        if (
          !["content-length", "transfer-encoding", "content-encoding", "connection"].includes(name)
        )
          response.setHeader(name, value);
      response.writeHead(upstream.status).end(body);
    })().catch(() => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  front.listen(0, "127.0.0.1");
  await once(front, "listening");
  origin = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  const ports = [origin, provider.url, tmdb.url].map((url) => Number(new URL(url).port));
  let stopped = false;
  return {
    url: origin,
    tmdbApi: `${origin}/3`,
    titles: provider.titles,
    // Action/count evidence only. Never retain provider login query strings.
    catalogueRequests,
    /** Stops all three and checks nothing answers on their ports any more. */
    async stop() {
      if (stopped) return { ports, refused: true };
      stopped = true;
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      await provider.close();
      await tmdb.close();
      const answered = await Promise.all(
        ports.map((port) =>
          fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) }).then(
            () => port,
            () => null,
          ),
        ),
      );
      const open = answered.filter((port) => port !== null);
      if (open.length > 0) throw new Error(`Fake services still answer on ${open.join(", ")}.`);
      return { ports, refused: true };
    },
  };
}
export type Services = Awaited<ReturnType<typeof startServices>>;

/** A plain grey PNG, which shows on the black page where a copy's artwork is. */
function greyPicture(width: number, height: number): Buffer {
  const chunk = (kind: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(kind, "ascii"), data]);
    const framing = Buffer.alloc(8);
    framing.writeUInt32BE(data.length, 0);
    framing.writeUInt32BE(crc32(body), 4);
    return Buffer.concat([framing.subarray(0, 4), body, framing.subarray(4)]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 0, 0, 0, 0], 8);
  const line = Buffer.concat([Buffer.from([0]), Buffer.alloc(width, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => line)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The fake titles the chain plays and downloads, by their ids in the provider's lists. */
export function fixtures(titles: FakeProvider["titles"]) {
  const movie = (prefix: string) => {
    const found = titles.movies.find((each) => each.name.startsWith(prefix));
    if (!found) throw new Error(`The fake provider lists no ${prefix}.`);
    return String(found.id);
  };
  return {
    long: movie("TEST | Long subtitles"),
    formats: titles.series
      .filter((each) => each.name.startsWith("TEST | Formats"))
      .map((each) => String(each.id)),
  };
}
type Fixtures = ReturnType<typeof fixtures>;

// ---------------------------------------------------------------------------------------------
// Driving the window

/** The app's read-only calls the check observes with; it changes nothing through them. */
type Read =
  | "updates.status"
  | "preferences.get"
  | "language.get"
  | "viewing.get"
  | "viewing.progress"
  | "watchlist.list"
  | "downloads.list"
  | "subscription.list"
  | "subtitles.settings";

/** A request the window made, without its query, which can hold the fake login. */
interface WindowRequest {
  readonly at: number;
  readonly url: string;
}

/** Pointer and key input to the window, screenshots, and the app's read-only calls. */
export function driver(page: Page, evidence: string, stage: Stage) {
  const actions: { at: string; action: string }[] = [];
  const requests: WindowRequest[] = [];
  page.on("Network.requestWillBeSent", (params) => {
    const url = (params as { request?: { url?: string } }).request?.url ?? "";
    const parsed = URL.canParse(url) ? new URL(url) : null;
    const shown =
      parsed && /^https?:$/.test(parsed.protocol)
        ? `${parsed.origin}${parsed.pathname}`
        : url.slice(0, 40);
    requests.push({ at: Date.now(), url: shown });
  });
  const exists = (expression: string) => page.evaluate<boolean>(`!!(${expression})`);
  const wait = async (check: () => Promise<boolean>, timeout = 30_000, what = check.toString()) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await check().catch(() => false)) return;
      await delay(200);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };
  const did = (action: string) => actions.push({ at: new Date().toISOString(), action });
  const d = {
    page,
    actions,
    requests,
    exists,
    wait,
    async click(action: string, element: string) {
      await wait(() => exists(element), 30_000, action);
      const point = await page.evaluate<{ x: number; y: number } | null>(`(() => {
        const e = (${element}); if (!e || e.disabled) return null;
        e.scrollIntoView({ block: "center" }); const r = e.getBoundingClientRect();
        return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`);
      if (!point) throw new Error(`Nothing to click for: ${action}`);
      did(action);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await page.send("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: "left",
          clickCount: 1,
        });
    },
    async key(name: string, code: number) {
      did(`Press ${name}`);
      for (const type of ["rawKeyDown", "keyUp"])
        await page.send("Input.dispatchKeyEvent", {
          type,
          key: name,
          code: name,
          windowsVirtualKeyCode: code,
        });
    },
    /** Uses the closed select's type-ahead instead of a platform-specific native popup. */
    async select(action: string, element: string, value: string): Promise<void> {
      await wait(() => exists(element), 30_000, action);
      const label = await page.evaluate<string | null>(`(() => {
        const select = (${element});
        const options = [...(select?.options ?? [])].filter(o => o.value === ${JSON.stringify(value)} && !o.disabled);
        if (options.length !== 1) return null;
        const label = options[0].label.trim();
        return [...select.options].filter(o => !o.disabled && o.label.trim() === label).length === 1 ? label : null;
      })()`);
      if (!label) throw new Error(`${action} offers no unique enabled ${value}.`);
      did(`Focus ${action}`);
      // Focusing changes no value and leaves the OS menu closed, as in the language verifier.
      await page.evaluate(`(${element}).focus()`);
      await wait(
        () => page.evaluate<boolean>(`document.activeElement === (${element})`),
        10_000,
        `${action} focus`,
      );
      for (const character of label) {
        did(`Type ${action}: ${character}`);
        await page.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: character,
          text: character,
        });
        await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
      }
      await d.key("Tab", 9);
      await wait(
        () => page.evaluate<boolean>(`(${element})?.value === ${JSON.stringify(value)}`),
        10_000,
        `${action} ${value}`,
      );
    },
    async type(action: string, text: string) {
      did(action);
      await page.send("Input.insertText", { text });
    },
    /** A screenshot and the text on screen, named for the stage. */
    async capture(name: string) {
      const shot = await page.send("Page.captureScreenshot", { format: "png" });
      const data = (shot.result as { data?: string } | undefined)?.data;
      if (!data) throw new Error("No screenshot returned.");
      await writeFile(join(evidence, `${stage}-${name}.png`), Buffer.from(data, "base64"));
      await writeFile(
        join(evidence, `${stage}-${name}.txt`),
        await page.evaluate<string>("document.body.innerText"),
      );
    },
    /** One of the app's read-only calls, as the window makes it. */
    async read<M extends Read & IpcMethod>(method: M, ...args: IpcArgs<M>): Promise<IpcOutput<M>> {
      const input = args.length > 0 ? `, ${JSON.stringify(args[0])}` : "";
      const result = await page.evaluate<Result<IpcOutput<M>>>(
        `window.mrStreamer.invoke(${JSON.stringify(method)}${input})`,
      );
      if (!result.ok) throw new Error(`${method} failed: ${JSON.stringify(result.error)}`);
      return result.value;
    },
    video: () =>
      page.evaluate<{
        time: number;
        width: number;
        audio: number;
        paused: boolean;
        title: boolean;
      }>(`(() => {
        const v = document.querySelector("video");
        return { time: v?.currentTime ?? 0, width: v?.videoWidth ?? 0, audio: v?.webkitAudioDecodedByteCount ?? 0,
          paused: v?.paused ?? true, title: !!document.querySelector("[data-view=title]") }; })()`),
  };
  return d;
}
export type Driver = ReturnType<typeof driver>;

const button = (selector: string, words: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(words)})`;
const labelled = (label: string) =>
  `document.querySelector(${JSON.stringify(`[aria-label="${label}"]`)})`;
const poster = (words: string) =>
  `[...document.querySelectorAll("button[title]")].find(b => b.title.includes(${JSON.stringify(words)}))`;
const listEntry = (words: string) =>
  `[...document.querySelectorAll("button[data-entry]")].find(b => b.querySelector("span")?.textContent.trim() === ${JSON.stringify(words)})`;
const copyRow = (id: string) => `document.querySelector('[data-download="${id}"]')`;

/** Moving picture with decoded sound, past its first second. */
const playing = (d: Driver) =>
  d.wait(
    async () => {
      const v = await d.video();
      return v.title && !v.paused && v.width > 0 && v.audio > 0 && v.time > 1;
    },
    45_000,
    "a moving picture with sound",
  );
const leaveTitle = async (d: Driver) => {
  await d.key("Escape", 27);
  await d.wait(async () => !(await d.video()).title, 10_000, "leaving the title");
};
const openMovie = async (d: Driver, name: string) => {
  await d.click("Open Movies", button("header button", "Movies"));
  await d.click("Open All movies", button("nav button", "All movies"));
  await d.click(`Open ${name}`, poster(name));
};
const openSeries = async (d: Driver) => {
  await d.click("Open Series", button("header button", "Series"));
  await d.click("Open All series", button("nav button", "All series"));
  await d.click("Open the Formats series", poster("Formats"));
};

/** Stable 0.0.11 opens Watchlist on Home; earlier and newer builds have a top-bar button. */
const openWatchlist = async (d: Driver) => {
  if (!(await d.exists(button("header button", "Watchlist")))) {
    await d.click("Open Home", button("header button", "Home"));
    await d.click("Open Watchlist on Home", button("button", "Watchlist"));
  } else await d.click("Open Watchlist", button("header button", "Watchlist"));
};

/** Settings > About's version line and the commit its source link names. */
export async function about(d: Driver) {
  await d.click("Open Settings", labelled("Settings"));
  await d.click("Open About", button("nav button", "About"));
  await d.wait(
    () => d.exists(`document.querySelector('a[href*="/tree/"]')`),
    10_000,
    "About's source link",
  );
  const shown = await d.page.evaluate<{ text: string; source: string }>(
    `({ text: document.body.innerText, source: document.querySelector('a[href*="/tree/"]').href.split("/tree/")[1] })`,
  );
  await d.capture("about");
  await d.key("Escape", 27);
  return shown;
}

/** What the upgrades must keep, read through the app's public calls. */
async function state(d: Driver, titles: Fixtures) {
  const subscriptions = await d.read("subscription.list");
  if (subscriptions.length !== 1)
    throw new Error(`Expected one subscription, found ${subscriptions.length}.`);
  const subscriptionId = subscriptions[0]!.id;
  const watchlist = await d.read("watchlist.list", { sort: "saved", offset: 0, limit: 100 });
  return {
    preferences: await d.read("preferences.get"),
    favourites: (await d.read("viewing.get")).favourites,
    watchlist: {
      total: watchlist.total,
      entries: watchlist.entries.map(({ subscriptionId, id, kind, name }) => ({
        subscriptionId,
        id,
        kind,
        name,
      })),
    },
    progress: (
      await d.read("viewing.progress", {
        movies: [{ subscriptionId, id: titles.long }],
        series: titles.formats.map((id) => ({ subscriptionId, id })),
      })
    ).map(({ title, position, duration, finished }) => ({ title, position, duration, finished })),
  };
}
type State = Awaited<ReturnType<typeof state>>;
type Copies = IpcOutput<"downloads.list">["items"];

/**
 * Fails unless `now` keeps what `before` held: every preference set then, the favourites in their
 * order, the watchlist's entries, and each title's progress within two seconds and as finished
 * or not as it was. A later version may add preferences; none may change.
 */
function retained(before: State, now: State, what: string) {
  const after = new Map(Object.entries(now.preferences));
  const changed = Object.entries(before.preferences)
    .filter(([name, value]) => JSON.stringify(after.get(name)) !== JSON.stringify(value))
    .map(([name]) => name);
  const ids = (entries: State["watchlist"]["entries"]) =>
    JSON.stringify(entries.map(({ subscriptionId, id, kind }) => [subscriptionId, id, kind]));
  const lost = before.progress.filter(
    (prior) =>
      !now.progress.some(
        (each) =>
          JSON.stringify(each.title) === JSON.stringify(prior.title) &&
          Math.abs(each.position - prior.position) < 2 &&
          each.finished === prior.finished,
      ),
  );
  const problems = [
    changed.length > 0 && `preferences ${changed.join(", ")}`,
    JSON.stringify(now.favourites) !== JSON.stringify(before.favourites) &&
      "favourites or their order",
    (now.watchlist.total !== before.watchlist.total ||
      ids(now.watchlist.entries) !== ids(before.watchlist.entries)) &&
      "watchlist",
    lost.length > 0 &&
      `progress of ${lost.map((each) => `${each.title.kind} ${each.title.id}`).join(", ")}`,
  ].filter(Boolean);
  if (problems.length > 0) throw new Error(`${what} lost or changed: ${problems.join("; ")}.`);
  return {
    kept: true,
    addedPreferences: Object.keys(now.preferences).filter((name) => !(name in before.preferences)),
  };
}

/** Exact completed copies and saved details, with progress present as before and within 2 s. */
function retainedCopies(before: Copies, now: Copies, what: string) {
  if (
    before.length !== 3 ||
    now.length !== before.length ||
    new Set(before.map((each) => each.id)).size !== before.length ||
    new Set(now.map((each) => each.id)).size !== now.length
  )
    throw new Error(`${what} lost or changed the three unique copies.`);
  for (const prior of before) {
    const current = now.find((each) => each.id === prior.id);
    if (!current) throw new Error(`${what} lost the copy ${prior.id}.`);
    const { progress: priorProgress, ...priorDetails } = prior;
    const { progress, ...details } = current;
    const keptProgress =
      priorProgress === null
        ? progress === null
        : progress !== null &&
          progress.duration === priorProgress.duration &&
          Math.abs(progress.position - priorProgress.position) < 2;
    if (
      prior.status.kind !== "complete" ||
      current.status.kind !== "complete" ||
      !isDeepStrictEqual(details, priorDetails) ||
      !keptProgress
    )
      throw new Error(`${what} changed the copy ${prior.id}: ${JSON.stringify(current)}`);
  }
  return { kept: true };
}

/** The 150 s fixture must retain a nonzero position before its last 30 s of credits. */
function longCopyProgress(copies: Copies, titles: Fixtures, what: string) {
  const progress = copies.find(
    (each) => each.title.kind === "movie" && each.title.id === titles.long,
  )?.progress;
  if (
    !progress ||
    !Number.isFinite(progress.duration) ||
    !(progress.position > 0 && progress.position < progress.duration - 30)
  )
    throw new Error(`${what} left no nonzero unfinished progress on the long movie's copy.`);
  return progress;
}

// ---------------------------------------------------------------------------------------------
// The stages

/**
 * The prior stable release, from the Connect screen on, including a saved online subtitle with
 * its timing, chosen while the movie plays, then completed copies with local playback progress.
 */
export async function seedStable(d: Driver, services: Services, titles: Fixtures) {
  await d.wait(() => d.exists("document.querySelector('form input')"), 30_000, "the Connect form");
  for (const [index, text] of [services.url, "demo", "demo"].entries()) {
    await d.click(
      `Fill Connect field ${index + 1}`,
      `document.querySelectorAll('form input')[${index}]`,
    );
    await d.type(`Type Connect field ${index + 1}`, text);
  }
  await d.click("Connect", "document.querySelector('form button[type=submit]')");
  await d.wait(
    () => d.exists("document.querySelector('header')"),
    60_000,
    "the app after connecting",
  );
  await d.click("Open Settings", labelled("Settings"));
  await d.click("Open General", button("nav button", "General"));
  await d.select("Quality", labelled("Quality"), "hd");
  await d.select("Audio in", labelled("Audio in"), "nl");
  await d.select("Subtitles", labelled("Subtitles"), "fr");
  await configureSubtitleUi(d);
  await d.capture("settings");
  // Stable 0.0.11 keeps Escape in the focused subtitle opt-in checkbox.
  await d.click(
    "Leave Settings",
    `[...document.querySelectorAll('header button')].findLast(b => b.textContent.trim() === 'Back')`,
  );
  await d.click("Open Live TV", button("header button", "Live TV"));
  await d.click("Open All channels", listEntry("All channels"));
  for (let i = 1; i <= 2; i++) {
    await d.click(`Star channel ${i}`, labelled("Add to favourites"));
    await d.wait(
      async () => (await d.read("viewing.get")).favourites.length === i,
      10_000,
      `favourite ${i}`,
    );
    await d.wait(
      () =>
        d.page.evaluate<boolean>(
          `document.querySelectorAll('[aria-label="Remove from favourites"]').length === ${i}`,
        ),
      10_000,
    );
  }
  await d.click("Open Favourites", listEntry("Favourites"));
  await d.capture("favourites");
  await openMovie(d, "Long subtitles");
  await d.click("Save the movie", button('[role="dialog"] button', "Save"));
  await d.click("Play the movie", button('[role="dialog"] button', "Play"));
  await playing(d);
  const savedSubtitle = await seedSubtitleUi(d);
  await d.key("ArrowRight", 39);
  await d.key("ArrowRight", 39);
  await d.wait(async () => (await d.video()).time > 20, 30_000, "the movie past 20 s");
  await leaveTitle(d);
  await d.key("Escape", 27);
  await openSeries(d);
  await d.click(
    "Play the first episode",
    `[...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim().startsWith("Play") && !b.disabled)`,
  );
  await playing(d);
  await leaveTitle(d);
  await d.key("Escape", 27);
  await openWatchlist(d);
  await d.capture("watchlist");
  await d.wait(
    async () => (await state(d, titles)).progress.length >= 2,
    15_000,
    "movie and episode progress",
  );
  const seeded = await state(d, titles);
  const { liveQuality, audioLanguage, subtitleLanguage } = seeded.preferences;
  const movie = seeded.progress.find((each) => each.title.kind === "movie");
  if (
    liveQuality !== "hd" ||
    audioLanguage !== "nl" ||
    subtitleLanguage !== "fr" ||
    seeded.favourites.length !== 2 ||
    seeded.watchlist.total !== 1 ||
    !movie ||
    movie.finished ||
    !seeded.progress.some((each) => each.title.kind === "episode")
  )
    throw new Error(`The stable release didn't keep what was set: ${JSON.stringify(seeded)}`);
  await downloadCopies(d);
  const played = await playCopies(d, titles);
  // Stable remembers the alternate track as a global preference. Restore the original seed
  // through Settings, then require all the original state, including provider progress, intact.
  await d.click("Open Settings", labelled("Settings"));
  await d.click("Open General", button("nav button", "General"));
  await d.select("Restore Audio in", labelled("Audio in"), audioLanguage);
  await d.wait(
    async () => (await d.read("preferences.get")).audioLanguage === audioLanguage,
    10_000,
    "the original saved audio preference",
  );
  await d.capture("settings-restored");
  await d.key("Escape", 27);
  const after = await state(d, titles);
  retained(seeded, after, "Playing copies on stable");
  const copies = (await d.read("downloads.list")).items;
  if (
    copies.length !== 3 ||
    new Set(copies.map((each) => each.id)).size !== 3 ||
    copies.some((each) => each.status.kind !== "complete")
  )
    throw new Error("Stable didn't keep the three completed copies after playing them.");
  longCopyProgress(copies, titles, "Stable");
  await d.capture("copies-before-upgrade");
  return { ...seeded, savedSubtitle, played, copies, after };
}

/**
 * Fails unless a copy left at `kept` seconds started again five seconds before it, as the player
 * goes back, give or take three: a picture can start a little early, and the time is read a
 * moment after it started. Further, either way, is a jump.
 */
function resumedNear(what: string, started: number, kept: number) {
  const back = Math.max(0, kept - 5);
  if (Math.abs(started - back) > 3)
    throw new Error(`${what} started at ${started} s, not near ${back} s, 5 s before ${kept} s.`);
}

/**
 * Plays the copies on the Downloads page: skip, other sound, embedded subtitles, the saved online
 * subtitle with its timing, resume, episode. When an earlier start left the long movie's copy at
 * `kept` seconds, it must start from there.
 * Leaving it again must keep the time it was left at, and it must resume from that.
 */
async function playCopies(d: Driver, titles: Fixtures, kept?: number) {
  const copies = (await d.read("downloads.list")).items;
  const long = copies.find((each) => each.title.kind === "movie" && each.title.id === titles.long);
  const sound = copies.find((each) => each.title.kind === "movie" && each.title.id !== titles.long);
  const episode = copies.find((each) => each.title.kind === "episode");
  if (!long || !sound || !episode)
    throw new Error("The movie and episode copies aren't all listed.");
  const watch = async (id: string, what: string) => {
    await d.click(`Watch ${what} offline`, `(${copyRow(id)})?.querySelector('button')`);
    await d.wait(
      async () => {
        const v = await d.video();
        return v.title && !v.paused && v.width > 0 && v.time > 0.5;
      },
      45_000,
      `${what} playing`,
    );
  };
  const seen: Record<string, unknown> = {};
  await watch(sound.id, "the two-sound-track movie");
  const before = (await d.video()).time;
  await d.key("ArrowRight", 39);
  await d.wait(async () => (await d.video()).time >= before + 8, 15_000, "a skip of 10 s");
  seen["seek"] = { from: before, to: (await d.video()).time };
  await d.click("Open Sound", labelled("Sound"));
  seen["soundTracks"] = await d.page.evaluate<string[]>(
    "[...document.querySelectorAll('[role=dialog] [role=menuitemradio], [role=dialog] button[aria-pressed]')].map(b => b.textContent.trim())",
  );
  await d.click(
    "Choose the other sound track",
    "[...document.querySelectorAll('[role=dialog] button[aria-pressed=false], [role=dialog] [role=menuitemradio][aria-checked=false]')][0]",
  );
  await d.wait(
    async () => {
      const v = await d.video();
      return !v.paused && v.audio > 0 && v.time > 1;
    },
    45_000,
    "the other sound track",
  );
  seen["otherSound"] = await d.video();
  await d.capture("copy-other-sound");
  await leaveTitle(d);

  await watch(long.id, "the long-subtitles movie");
  const started = (await d.video()).time;
  seen["longStartedAt"] = { started, keptBefore: kept ?? null };
  if (kept !== undefined) resumedNear("The copy", started, kept);
  // Its French lines run from 40 s. The last 30 of its 150 seconds are credits, which would
  // finish it, so the skips stop short of them.
  for (let i = 0; i < 6 && (await d.video()).time < 38; i++) await d.key("ArrowRight", 39);
  await d.click("Open Subtitles", labelled("Subtitles"));
  await d.click(
    "Choose the embedded French track",
    `[...document.querySelectorAll('aside[aria-label="Subtitle choices"] button[aria-pressed]')].find(b => b.textContent.trim() === "Français")`,
  );
  await d.click("Close Subtitles", labelled("Close subtitles"));
  await d.wait(
    async () => {
      const v = await d.video();
      return !v.paused && v.time >= 40;
    },
    45_000,
    "the long movie past 40 s",
  );
  await d.wait(
    () =>
      d.page.evaluate<boolean>(
        "[...document.querySelector('video').textTracks].some(t => t.kind === 'subtitles' && (t.cues?.length ?? 0) > 0)",
      ),
    45_000,
    "embedded subtitle cues",
  );
  await d.wait(
    async () =>
      (await d.page.evaluate<string>(
        "document.querySelector('[data-subtitle-text]')?.textContent?.trim() ?? ''",
      )) !== "",
    45_000,
    "a subtitle on screen",
  );
  seen["caption"] = await d.page.evaluate<string>(
    "document.querySelector('[data-subtitle-text]').textContent.trim()",
  );
  await d.capture("copy-subtitles");
  seen["savedSubtitle"] = await observeSavedSubtitle(d, "copy");
  const left = (await d.video()).time;
  await leaveTitle(d);
  // Main keeps where it was left, and the page shows it too: Watch offline goes from there.
  const progress = async () =>
    (await d.read("downloads.list")).items.find((each) => each.id === long.id)?.progress;
  await d.wait(
    async () => {
      const now = await progress();
      if (!now || now.position < left - 2) return false;
      const shown = await d.page.evaluate<string | null>(
        `(${copyRow(long.id)})?.querySelector('span > span[style*="width"]')?.style.width ?? null`,
      );
      return shown === `${Math.round((now.position / now.duration) * 100)}%`;
    },
    15_000,
    "the copy's progress kept and shown",
  );
  // Within two seconds of the time read just before leaving, either way.
  const keptNow = (await progress())?.position ?? 0;
  if (Math.abs(keptNow - left) > 2)
    throw new Error(`The copy was left at ${left} s, but kept ${keptNow} s.`);
  await watch(long.id, "the long-subtitles movie again");
  const resumed = (await d.video()).time;
  seen["resume"] = { left, kept: keptNow, resumed };
  resumedNear("The copy again", resumed, keptNow);
  await leaveTitle(d);

  await watch(episode.id, "the episode");
  await d.capture("copy-episode");
  await leaveTitle(d);
  return seen;
}

/** Waits for the copies on the Downloads page with their artwork from this computer. */
async function copiesShown(d: Driver, count: number) {
  await d.wait(
    async () => (await d.read("downloads.list")).items.length === count,
    60_000,
    `${count} copies`,
  );
  const art = `[...document.querySelectorAll("[data-download] img")].filter(i => i.src.startsWith("mrstreamer:") && i.complete && i.naturalWidth > 0).length`;
  await d.wait(
    () => d.page.evaluate<boolean>(`${art} === ${count}`),
    30_000,
    "the copies' artwork",
  );
}

/** Downloads the existing fixture selection through stable's movie and episode controls. */
async function downloadCopies(d: Driver) {
  for (const movie of ["Two sound tracks", "Long subtitles"]) {
    await openMovie(d, movie);
    await d.click(`Download ${movie}`, button('[role="dialog"] button', "Download"));
    await d.wait(
      () => d.exists(button('[role="dialog"] button', "Watch offline")),
      90_000,
      `${movie} downloaded`,
    );
    await d.key("Escape", 27);
  }
  await openSeries(d);
  await d.click("Download S1 E2", labelled("Download S1 E2"));
  await d.wait(() => d.exists(labelled("Watch S1 E2 offline")), 90_000, "S1 E2 downloaded");
  await d.key("Escape", 27);
  await d.click("Open Downloads", button("header button", "Downloads"));
  await d.wait(
    async () =>
      (await d.read("downloads.list")).items.every((each) => each.status.kind === "complete"),
    90_000,
    "every download complete",
  );
  await copiesShown(d, 3);
  await d.capture("copies");
}

/**
 * The candidate nightly over stable: require inherited copies before any playback, then check
 * provider state and saved subtitles, and play only those same copies from their old progress.
 */
export async function upgradeToCandidate(
  d: Driver,
  titles: Fixtures,
  seeded: Awaited<ReturnType<typeof seedStable>>,
) {
  const kept = retained(seeded, await state(d, titles), "Upgrading to candidate");
  const inherited = (await d.read("downloads.list")).items;
  const copiesKept = retainedCopies(seeded.copies, inherited, "Upgrading to candidate");
  const stableLongProgress = longCopyProgress(seeded.copies, titles, "Stable");
  longCopyProgress(inherited, titles, "Upgrading to candidate");
  await d.click("Open Downloads", button("header button", "Downloads"));
  await copiesShown(d, inherited.length);
  await d.capture("copies-kept");
  await d.click("Open Settings", labelled("Settings"));
  await d.click("Open General", button("nav button", "General"));
  await d.capture("settings");
  await d.key("Escape", 27);
  await d.click("Open Live TV", button("header button", "Live TV"));
  await d.click("Open Favourites", listEntry("Favourites"));
  await d.capture("favourites");
  await openWatchlist(d);
  await d.capture("watchlist");

  await openMovie(d, "Long subtitles");
  await d.click(
    "Play or resume with the saved subtitle",
    `[...document.querySelectorAll('[role="dialog"] button')].find(b => ['Play', 'Resume'].includes(b.textContent.trim()))`,
  );
  await playing(d);
  const savedSubtitle = await observeSavedSubtitle(d);
  await leaveTitle(d);
  await d.key("Escape", 27);
  await d.click("Open Downloads", button("header button", "Downloads"));
  const played = await playCopies(d, titles, stableLongProgress.position);
  return {
    kept,
    inherited: { ...copiesKept, copies: inherited },
    savedSubtitle,
    played,
    copies: (await d.read("downloads.list")).items,
    after: await state(d, titles),
  };
}
export type AfterCandidate = Awaited<ReturnType<typeof upgradeToCandidate>>;

/** What the offline part needs of the machine: the block, and what it refused. */
export interface Offline {
  /** Stops the fake services, blocks the app and its tools, and proves the block refuses them. */
  cutOff(d: Driver): Promise<Record<string, unknown>>;
  /** Connections of the blocked programs refused since `since`. */
  refused(since: Date): unknown[];
}

/**
 * The same candidate started again: everything the upgrade left kept, copies included. Then the
 * subscription goes in Settings, the network goes for the app, and the copies play from Connect's
 * Downloads.
 */
export async function restartCandidate(
  d: Driver,
  titles: Fixtures,
  upgraded: AfterCandidate,
  offline: Offline,
) {
  const operation = "Restarting candidate";
  const kept = retained(upgraded.after, await state(d, titles), operation);
  await d.click("Open Downloads", button("header button", "Downloads"));
  await copiesShown(d, upgraded.copies.length);
  const copies = (await d.read("downloads.list")).items;
  retainedCopies(upgraded.copies, copies, operation);
  const left = longCopyProgress(copies, titles, operation);
  await d.capture("copies-kept");

  await d.click("Open Settings", labelled("Settings"));
  await d.click("Open Subscriptions", button("nav button", "Subscriptions"));
  const row = `[...document.querySelectorAll('li')].find(r => r.querySelector('button')?.textContent.includes(' · '))`;
  for (let attempt = 1; ; attempt++) {
    await d.click(
      `Open the subscription (attempt ${attempt})`,
      `(${row})?.querySelector('button')`,
    );
    const opened = await d
      .wait(() => d.exists(`(${row})?.querySelector('[role=region]')`), 3000)
      .then(
        () => true,
        () => false,
      );
    if (opened) break;
    if (attempt === 3) throw new Error("The subscription's row didn't open.");
  }
  await d.click(
    "Ask to remove it",
    `[...(${row})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim().startsWith("Remove "))`,
  );
  await d.wait(
    async () =>
      (await d.page.evaluate<string>("document.body.innerText")).includes("from this device?"),
    10_000,
    "the removal question",
  );
  await d.capture("remove-subscription");
  await d.click(
    "Confirm removal",
    `[...(${row})?.querySelectorAll('button') ?? []].find(b => b.textContent.trim() === "Remove")`,
  );
  await d.wait(() => d.exists("document.querySelector('form input')"), 30_000, "the Connect form");
  await d.wait(() => d.exists(button("button", "Downloads")), 10_000, "Downloads on Connect");
  if ((await d.read("subscription.list")).length !== 0)
    throw new Error("The subscription is still saved.");

  const cutOff = await offline.cutOff(d);
  await d.click("Open Downloads from Connect", button("button", "Downloads"));
  await copiesShown(d, upgraded.copies.length);
  await d.wait(
    async () =>
      (await d.page.evaluate<string>("document.body.innerText")).includes(
        "Subscription removed, copy kept",
      ),
    10_000,
  );
  const standalone = (await d.read("downloads.list")).items;
  retainedCopies(
    copies.map((each) => ({ ...each, subscription: null })),
    standalone,
    "Removing the subscription",
  );
  longCopyProgress(standalone, titles, "Removing the subscription");
  await d.capture("copies-without-subscription");
  const from = new Date();
  const requestsFrom = d.requests.length;
  const played = await playCopies(d, titles, left.position);
  const outside = d.requests
    .slice(requestsFrom)
    .filter(
      (request) =>
        !/^(mrstreamer:|data:|blob:|file:|http:\/\/127\.0\.0\.1:\d+\/)/.test(request.url),
    );
  if (outside.length > 0)
    throw new Error(
      `The window asked beyond this computer while offline: ${JSON.stringify(outside)}`,
    );
  return {
    kept,
    copies: standalone,
    cutOff,
    played,
    refusedWhilePlaying: offline.refused(from),
    windowRequestsWhilePlaying: d.requests.length - requestsFrom,
  };
}

// ---------------------------------------------------------------------------------------------
// Commands

const usage = `Usage:
  node apps/desktop/test/e2e/installed-upgrade.ts resolve --candidate <nightly tag> [--sha <its commit>] --out <new folder>
  node apps/desktop/test/e2e/installed-upgrade.ts run --packages <folder> --root <new folder under RUNNER_TEMP>
  node apps/desktop/test/e2e/installed-upgrade.ts telemetry --packages <resolved .15 pair> --root <new folder under RUNNER_TEMP>`;

/**
 * Resolves the newest published stable and the candidate nightly, and writes their setups with
 * receipt.json into a new folder.
 */
async function resolveCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { candidate: { type: "string" }, sha: { type: "string" }, out: { type: "string" } },
  });
  const [token, repository] = [process.env["GH_TOKEN"], process.env["GITHUB_REPOSITORY"]];
  if (!token || !repository) throw new Error("Set GH_TOKEN and GITHUB_REPOSITORY.");
  if (!values.candidate || !values.out || !isAbsolute(values.out)) throw new Error(usage);
  const { receipt, files } = await resolvePackages(restGitHub(repository, token), {
    tag: values.candidate,
    sha: values.sha || undefined,
  });
  await mkdir(values.out);
  for (const [name, bytes] of files) await writeFile(join(values.out, name), bytes);
  await writeFile(join(values.out, "receipt.json"), JSON.stringify(receipt, null, 2));
  for (const each of receipt.packages)
    console.log(
      `${each.stage}: ${each.version} from ${each.source}, ${each.file} SHA-256 ${each.sha256}`,
    );
}

/**
 * Launches the installed app on the profile with main held at its first line, checks it is the
 * installed build it should be, points SubDL at the fixture at `subtitleOrigin` and watches the
 * catalogue worker start, then resumes it.
 */
async function start(
  runner: Runner,
  profile: string,
  evidence: string,
  pkg: RunPackage,
  tmdbApi: string,
  subtitleOrigin: string,
) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const inspectPort = port + 20000;
  process.env["MR_STREAMER_TMDB_API"] = tmdbApi;
  const beforeLaunch = {
    executable: await fileSha256(runner.executable),
    appAsar: await fileSha256(join(runner.installRoot, "resources", "app.asar")),
    tools: Object.fromEntries(
      await Promise.all(runner.tools.map(async (tool) => [tool, await fileSha256(tool)])),
    ),
  };
  const app = launch(
    runner.executable,
    [
      "--remote-debugging-address=127.0.0.1",
      "--enable-automation",
      "--lang=en-US",
      `--inspect-brk=127.0.0.1:${inspectPort}`,
    ],
    { port, profile },
  );
  if (app.pid === undefined) throw new Error(`${runner.executable} didn't start.`);
  const tree = ownedTree(runner, app);
  let page: Page | undefined;
  let verifiedPage: Page | undefined;
  let main: Page | undefined;
  let bootstrap: Awaited<ReturnType<typeof bootstrapSubtitles>> | undefined;
  let workers: ReturnType<typeof installCatalogueWorkerProbe> | undefined;
  let workerControl:
    ReturnType<ReturnType<typeof installCatalogueWorkerProbe>["start"]> | undefined;
  const workerDiagnostics: {
    provenance?: Awaited<ReturnType<typeof catalogueWorkerScripts>>;
    events: Evidence[];
    startup?: Awaited<NonNullable<typeof workerControl>>;
    cleanup?: Awaited<ReturnType<ReturnType<typeof installCatalogueWorkerProbe>["close"]>>;
  } = { events: [] };
  const closeWorkers = async () => {
    if (!workers) return;
    workerDiagnostics.cleanup = await workers.close();
    if (workerControl) workerDiagnostics.startup = await workerControl;
    if (workerDiagnostics.cleanup.errors.length)
      throw new Error(`Catalogue worker cleanup: ${workerDiagnostics.cleanup.errors.join("; ")}`);
  };
  const stop = async () => {
    let workerError: unknown;
    try {
      await closeWorkers();
    } catch (error) {
      workerError = error;
    }
    const exitedBeforeClose = app.exitCode !== null || app.signalCode !== null;
    main?.close();
    const ended = await tree
      .stop(() => verifiedPage?.send("Browser.close") ?? Promise.resolve())
      .catch((error: unknown) => {
        if (workerError)
          throw new AggregateError(
            [workerError, error],
            "Worker and installed process cleanup failed",
          );
        throw error;
      });
    const exit = { code: app.exitCode, signal: app.signalCode };
    if (
      exitedBeforeClose ||
      (exit.code !== null && exit.code !== 0) ||
      (ended.forced.length === 0 && (exit.code !== 0 || exit.signal !== null)) ||
      (ended.forced.length > 0 && exit.signal !== null && exit.signal !== "SIGKILL")
    ) {
      const error = new Error(`The installed app exited unexpectedly: ${JSON.stringify(exit)}.`);
      throw workerError
        ? new AggregateError([workerError, error], "Worker cleanup and installed exit failed")
        : error;
    }
    if (workerError) throw workerError;
    return {
      ...ended,
      exit,
      graceful: ended.graceful && exit.code === 0 && exit.signal === null,
      gate: ended.forced.length === 0 ? "graceful" : "forced-terminated",
    };
  };
  try {
    main = await connect(inspectPort, "node");
    const owner = await inspectorOwner(inspectPort, [app.pid]);
    if (owner !== app.pid || app.exitCode !== null || app.signalCode !== null)
      throw new Error("Inspector owner exited before initial pause");
    const paused = await pauseMain(main);
    const identity = await paused.evaluate<{
      pid: number;
      executable: string;
      resources: string;
      argv: string[];
    }>(
      `({pid:process.pid,executable:process.execPath,resources:process.resourcesPath,argv:process.argv})`,
    );
    tree.sample();
    if (
      identity.pid !== app.pid ||
      identity.executable.toLowerCase() !== runner.executable.toLowerCase() ||
      identity.resources.toLowerCase() !== join(runner.installRoot, "resources").toLowerCase() ||
      !identity.argv.includes(`--user-data-dir=${profile}`)
    )
      throw new Error("Paused main is not the owned installed app");
    if (
      (await fileSha256(identity.executable)) !== beforeLaunch.executable ||
      (await fileSha256(join(identity.resources, "app.asar"))) !== beforeLaunch.appAsar ||
      (
        await Promise.all(
          runner.tools.map(async (tool) => (await fileSha256(tool)) === beforeLaunch.tools[tool]),
        )
      ).some((same) => !same)
    )
      throw new Error("Paused installed executable changed");
    bootstrap = await bootstrapSubtitles(paused, subtitleOrigin);
    if (bootstrap.pid !== app.pid) throw new Error("Subtitle bootstrap PID changed");
    const provenance = await catalogueWorkerScripts(identity.resources, beforeLaunch.appAsar);
    workerDiagnostics.provenance = provenance;
    workers = installCatalogueWorkerProbe({
      main,
      expectedWorker: provenance.expectedWorker,
      startupScriptURLs: provenance.startupScriptURLs,
      verifiedMainPID: identity.pid,
      evidence: (event) => {
        workerDiagnostics.events.push(event);
        return undefined;
      },
    });
    const enabled = await workers.ready;
    if (!enabled.ok) throw new Error(enabled.error);
    // Join this control task after the UI stage, including Connect which creates the worker.
    workerControl = workers.start(120_000);
    await resumeMain(main);
    page = await connect(port);
    const d = driver(page, evidence, pkg.stage);
    const command = await page.send("Browser.getBrowserCommandLine");
    const args = (command.result as { arguments?: string[] } | undefined)?.arguments ?? [];
    if (
      !args.includes(`--user-data-dir=${profile}`) ||
      !args.includes(`--remote-debugging-port=${port}`)
    )
      throw new Error("The debugging port belongs to another app.");
    const renderer = await page.evaluate<string>("location.href");
    const asar = join(runner.installRoot, "resources", "app.asar", "out", "renderer", "index.html");
    if (
      !renderer.startsWith("file:") ||
      fileURLToPath(renderer).toLowerCase() !== asar.toLowerCase()
    )
      throw new Error(`The window shows ${renderer}, not the installed app.asar.`);
    await d.wait(() => d.page.evaluate<boolean>("!!window.mrStreamer"), 30_000, "the app's bridge");
    const status = await d.read("updates.status");
    if (status.version !== pkg.version || status.distribution !== "direct")
      throw new Error(
        `The app says ${status.version} (${status.distribution}), not ${pkg.version} direct.`,
      );
    const rendererOwnerPid = await inspectorOwner(port, [app.pid]);
    if (rendererOwnerPid !== app.pid || app.exitCode !== null || app.signalCode !== null)
      throw new Error("Renderer listener is not the active owned app");
    tree.sample();
    verifiedPage = page;
    const language = await d.read("language.get");
    if (language.locale !== "en-US")
      throw new Error(`The check requires English: ${JSON.stringify(language)}.`);
    await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await page.send("Network.enable");
    return {
      d,
      tree,
      async verifyWorker() {
        if (!workers || !workerControl) return;
        workerDiagnostics.startup = await workerControl;
        await closeWorkers();
        if (!workerDiagnostics.startup?.ok)
          throw new Error(workerDiagnostics.startup?.error ?? "Worker startup was not verified");
      },
      subtitleRequests: () => (main ? subtitleRequests(main) : Promise.resolve([])),
      identity: {
        subtitleBootstrap: bootstrap,
        catalogueWorker: workerDiagnostics,
        rendererOwnerPid,
        language,
        beforeLaunch,
        pid: app.pid,
        createdAt: tree.root.created,
        port,
        profile,
        executable: tree.root.path,
        renderer,
        status,
        binary: {
          executable: await fileSha256(runner.executable),
          appAsar: await fileSha256(join(runner.installRoot, "resources", "app.asar")),
          tools: Object.fromEntries(
            await Promise.all(runner.tools.map(async (tool) => [tool, await fileSha256(tool)])),
          ),
        },
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Installed startup and cleanup failed");
    } finally {
      page?.close();
    }
    throw error;
  }
}

/** Observes the setup child owned by this driver while the existing NSIS helper waits for it. */
export async function installPublished(
  runner: Runner,
  setup: string,
  version: string,
  previous: string | null,
) {
  const setupSha256 = await fileSha256(setup);
  const since = Date.now();
  const pending = install(runner, setup, version, previous);
  // install has spawned its child before yielding. Snapshot only; no process is stopped by id.
  let observed: ReturnType<typeof processes> = [];
  let observationError: unknown;
  try {
    observed = processes().filter(
      (each) =>
        each.parent === process.pid &&
        each.path?.toLowerCase() === setup.toLowerCase() &&
        Date.parse(each.created) >= since,
    );
  } catch (error) {
    observationError = error;
  }
  const result = await pending;
  check(
    !observationError && observed.length === 1,
    "The setup cannot be identified as one installer child owned by this driver.",
  );
  const installer = observed[0]!;
  check(
    !processes().some((each) => each.pid === installer.pid && each.created === installer.created),
    "The owned installer is still running after setup completed.",
  );
  check((await fileSha256(setup)) === setupSha256, "The setup changed while the installer ran.");
  return {
    ...result,
    installer: {
      pid: installer.pid,
      parent: installer.parent,
      executable: installer.path,
      createdAt: installer.created,
      setupSha256,
      ended: true,
    },
  };
}

/** What a run leaves on the runner, and how each part is taken down. */
export interface Leftovers {
  /** Puts back the network, when the run blocked it. */
  readonly network: (() => unknown) | null;
  readonly services: () => unknown;
  readonly uninstall: () => unknown;
  readonly installRoot: string;
  readonly profile: string;
  readonly lock: string;
}

/**
 * Takes down what a run left. The network and the fake services always go back. The install,
 * then the profile, then its lock go only while nothing has failed, so a failed run, or a failed
 * step here, leaves the rest as it was for the workflow to upload. `failed` is the run's own
 * failure, or the first step's; `kept` names what is still on disk.
 */
export async function cleanUp(failure: unknown, left: Leftovers) {
  let failed = failure;
  const steps: Record<string, unknown> = {};
  const attempt = async (what: string, action: () => unknown) => {
    try {
      steps[what] = (await action()) ?? true;
    } catch (error) {
      steps[what] = `failed: ${String(error)}`;
      failed ??= error;
    }
  };
  if (left.network) await attempt("network", left.network);
  await attempt("services", left.services);
  if (!failed) await attempt("uninstall", left.uninstall);
  if (!failed)
    await attempt("profile", () =>
      rm(left.profile, { recursive: true, force: true, maxRetries: 5 }),
    );
  if (!failed) await attempt("lock", () => rm(left.lock));
  const paths = {
    installation: left.installRoot,
    profile: left.profile,
    "profile.lock": left.lock,
  };
  const kept = Object.entries(paths).flatMap(([name, path]) => (existsSync(path) ? [name] : []));
  return { failed, steps, kept };
}

/**
 * Stable, the candidate over it and the candidate's restart on the disposable runner, with their
 * evidence and cleanup. Refuses before installing anything unless it runs from main in the
 * receipt's repository and both setups still match the receipt.
 */
export async function runCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { packages: { type: "string" }, root: { type: "string" } },
  });
  const runner = disposableRunner();
  const root = values.root ?? "";
  const under = relative(runner.temp, root);
  if (
    !values.packages ||
    !isAbsolute(root) ||
    !under ||
    under.startsWith("..") ||
    isAbsolute(under)
  )
    throw new Error(`${usage}\nThe root must be a new folder under RUNNER_TEMP.`);
  const raw: unknown = JSON.parse(await readFile(join(values.packages, "receipt.json"), "utf8"));
  const receipt = readReceipt(raw);
  check(
    /^[0-9a-f]{40}$/.test(process.env["GITHUB_SHA"] ?? ""),
    "GITHUB_SHA must name the verification workflow's commit.",
  );
  check(
    process.env["GITHUB_REF"] === "refs/heads/main",
    "The installed upgrade check runs only from main.",
  );
  check(
    receipt.repository === process.env["GITHUB_REPOSITORY"],
    "The receipt belongs to another repository.",
  );
  // Both packages must still match before the first setup starts.
  for (const pkg of receipt.packages) {
    const bytes = await readFile(join(values.packages, pkg.file));
    check(
      bytes.length === pkg.bytes && sha256(bytes) === pkg.sha256,
      `${pkg.file} changed since resolution.`,
    );
    check(
      (!pkg.provenance.assetDigest || pkg.provenance.assetDigest === `sha256:${pkg.sha256}`) &&
        pkg.provenance.metadata.sha512 === createHash("sha512").update(bytes).digest("base64"),
      `${pkg.file} no longer matches its resolved published metadata.`,
    );
  }
  const profile = join(root, "profile");
  const evidence = join(root, "evidence");
  const lock = join(root, "profile.lock");
  await mkdir(root);
  // Fresh folders only: an earlier attempt's profile is never reused or rewritten.
  await mkdir(profile);
  await mkdir(evidence);
  await writeFile(
    lock,
    JSON.stringify({
      runner: runner.id,
      profile,
      installRoot: runner.installRoot,
      startedAt: new Date().toISOString(),
    }),
  );
  // The synthetic TMDB key keeps the built-in key out of fixture requests.
  for (const name of Object.keys(process.env))
    if (
      name.startsWith("MR_STREAMER_") ||
      name === "NODE_OPTIONS" ||
      name === "ELECTRON_RUN_AS_NODE"
    )
      delete process.env[name];
  process.env["MR_STREAMER_TMDB_KEY"] = "synthetic-installed-upgrade";

  /** What each stage did, by stage, for proof.json. */
  type ByStage = Partial<Record<Stage, unknown>>;
  const proof = {
    runner: runner.id,
    verification: {
      workflowCommit: process.env["GITHUB_SHA"] ?? null,
      runId: process.env["GITHUB_RUN_ID"] ?? null,
      runAttempt: process.env["GITHUB_RUN_ATTEMPT"] ?? null,
      driverSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
      workerHelperSha256: sha256(
        await readFile(new URL("./installed-catalogue-worker.ts", import.meta.url)),
      ),
      workerScriptsHelperSha256: sha256(
        await readFile(new URL("./installed-worker-scripts.ts", import.meta.url)),
      ),
      appHelperSha256: sha256(await readFile(new URL("./app.ts", import.meta.url))),
      subtitleHelperSha256: sha256(
        await readFile(new URL("./installed-subtitles.ts", import.meta.url)),
      ),
    },
    receipt,
    installs: {} as ByStage,
    starts: {} as ByStage,
    about: {} as ByStage,
    stages: {} as ByStage,
    actions: {} as ByStage,
    ends: {} as ByStage,
    status: "running" as "running" | "passed" | "failed",
    error: null as string | null,
    cleanup: {} as Record<string, unknown>,
    limits: [] as string[],
  };
  const record = (part: ByStage, stage: Stage, value: unknown) => (part[stage] = value);
  const services = await startServices();
  const titles = fixtures(services.titles);
  const subtitles = await startSubtitleFixture().catch(async (error) => {
    try {
      await services.stop();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Subtitle startup and provider cleanup failed");
    }
    throw error;
  });
  const block = outboundBlock(runner);
  let blocking = false;
  let failed: unknown;
  let seeded: Awaited<ReturnType<typeof seedStable>> | undefined;
  let upgraded: AfterCandidate | undefined;
  try {
    let previous: string | null = null;
    let previousBinary: Awaited<ReturnType<typeof start>>["identity"]["binary"] | undefined;
    const packages: readonly RunPackage[] = [
      ...receipt.packages,
      { ...receipt.packages[1], stage: "candidate-restart" },
    ];
    for (const pkg of packages) {
      const setup = join(values.packages, pkg.file);
      if (sha256(await readFile(setup)) !== pkg.sha256)
        throw new Error(`${pkg.file} changed since it was checked.`);
      if (pkg.stage !== "candidate-restart")
        record(
          proof.installs,
          pkg.stage,
          await installPublished(runner, setup, pkg.version, previous),
        );
      previous = pkg.version;
      const session = await start(
        runner,
        profile,
        evidence,
        pkg,
        services.tmdbApi,
        subtitles.origin,
      );
      try {
        record(proof.starts, pkg.stage, session.identity);
        if (
          pkg.stage === "candidate-restart" &&
          JSON.stringify(session.identity.binary) !== JSON.stringify(previousBinary)
        )
          throw new Error(
            "The candidate executable, app.asar or bundled tools changed before its restart.",
          );
        previousBinary = session.identity.binary;
        // Settings opens once a subscription is saved: after connecting on the stable release,
        // before anything else on the subsequent starts.
        const checkAbout = async () => {
          const shown = await about(session.d);
          if (!shown.text.includes(pkg.version) || shown.source !== pkg.source)
            throw new Error(`About shows ${shown.source}, not ${pkg.version} from ${pkg.source}.`);
          record(proof.about, pkg.stage, shown.source);
        };
        if (pkg.stage !== "stable") await checkAbout();
        let requestsAtCutoff: number | undefined;
        const offline: Offline = {
          async cutOff(d) {
            const probeTools = () =>
              Promise.all(
                runner.tools.map(async (tool) => ({
                  tool,
                  ...(await toolProbe(tool, TOOLS_OUTSIDE)),
                })),
              );
            const reachedBefore = await d.page.evaluate<string>(probe);
            const toolsBefore = await probeTools();
            const stopped = await services.stop();
            const subtitlesStopped = await subtitles.stop();
            requestsAtCutoff = (await session.subtitleRequests()).length;
            const since = new Date();
            blocking = true;
            const applied = block.apply();
            const app = await d.page.evaluate<string>(probe);
            const tools = await probeTools();
            const checkReaches = await Promise.all([OUTSIDE, TOOLS_OUTSIDE].map(reaches));
            let refused: ReturnType<typeof block.blocked> = [];
            for (let i = 0; i < 30; i++) {
              refused = block.blocked(since);
              if (
                block.programs.every((program) =>
                  refused.some((each) => each.application === program),
                )
              )
                break;
              await delay(1000);
            }
            const proven = {
              endpoints: { window: OUTSIDE, tools: TOOLS_OUTSIDE },
              servicesStopped: stopped,
              subtitlesStopped,
              appReachedOutsideBeforeBlock: reachedBefore,
              toolsBeforeBlock: toolsBefore,
              applied,
              appAfterBlock: app,
              toolsAfterBlock: tools,
              checkStillReaches: checkReaches,
              refused,
            };
            const unrefused = block.programs.filter(
              (program) => !refused.some((each) => each.application === program),
            );
            if (
              reachedBefore !== "reached" ||
              toolsBefore.some((each) => !each.connected) ||
              app === "reached" ||
              tools.some((each) => !each.attempted || each.connected) ||
              checkReaches.some((each) => each.status === null) ||
              unrefused.length > 0
            )
              throw new Error(
                `The outbound block can't be shown to work: ${JSON.stringify(proven)}`,
              );
            return proven;
          },
          refused: (since) => block.blocked(since),
        };
        session.tree.sample();
        if (pkg.stage === "stable") seeded = await seedStable(session.d, services, titles);
        else if (pkg.stage === "candidate")
          upgraded = await upgradeToCandidate(session.d, titles, seeded!);
        else
          record(
            proof.stages,
            pkg.stage,
            await restartCandidate(session.d, titles, upgraded!, offline),
          );
        if (pkg.stage === "candidate" && (await session.subtitleRequests()).length !== 0)
          throw new Error(
            "Candidate migration fetched a new online subtitle instead of retaining stable's saved file",
          );
        if (
          requestsAtCutoff !== undefined &&
          (await session.subtitleRequests()).length !== requestsAtCutoff
        )
          throw new Error("Offline copies attempted new subtitle service requests");
        if (pkg.stage === "stable") await checkAbout();
        if (pkg.stage === "stable") record(proof.stages, "stable", seeded);
        if (pkg.stage === "candidate")
          record(proof.stages, pkg.stage, {
            kept: upgraded!.kept,
            inherited: upgraded!.inherited,
            savedSubtitle: upgraded!.savedSubtitle,
            played: upgraded!.played,
            copies: upgraded!.copies,
            after: upgraded!.after,
          });
        await session.verifyWorker();
        session.tree.sample();
      } catch (error) {
        await session.d.capture("failure").catch(() => undefined);
        failed = error;
      }
      // Every process of this start ends before the next setup, or the chain stops here. A stage
      // that failed keeps its own error; a stop that fails after a passing stage is the failure.
      record(proof.actions, pkg.stage, session.d.actions);
      try {
        const ended = await session.stop();
        record(proof.ends, pkg.stage, ended);
        // Each start must close cleanly before the next setup or restart.
        if (!ended.graceful) failed ??= new Error("The installed app required forced termination.");
      } catch (error) {
        record(proof.ends, pkg.stage, `failed: ${String(error)}`);
        failed = failed
          ? new AggregateError([failed, error], "Installed stage and cleanup failed")
          : error;
      }
      session.d.page.close();
      if (failed) break;
    }
  } catch (error) {
    failed = error;
  } finally {
    const left = await cleanUp(failed, {
      network: blocking ? () => block.restore() : null,
      services: async () => {
        const outcomes = await Promise.allSettled([services.stop(), subtitles.stop()]);
        const failures = outcomes.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "Fixture cleanup failed",
          );
        return outcomes;
      },
      uninstall: () => uninstall(runner),
      installRoot: runner.installRoot,
      profile,
      lock,
    });
    failed = left.failed;
    proof.status = failed ? "failed" : "passed";
    proof.error =
      failed instanceof Error ? (failed.stack ?? failed.message) : failed ? String(failed) : null;
    Object.assign(proof, {
      subtitleFixture: { requests: subtitles.requests, zipSha256: subtitles.zipSha256 },
    });
    proof.cleanup = {
      ...left.steps,
      kept: left.kept,
      failureProfile: left.kept.includes("profile")
        ? "The workflow uploads the profile without Chromium's caches. It holds only the fake provider's demo subscription, fixtures and synthetic TMDB and SubDL keys."
        : null,
    };
    proof.limits = [
      ...receipt.limits,
      "Decoded sound is not audible output; GPU, native menus and dialogs are not checked.",
      "The stable episode is a 12-second clip, recorded as finished: unfinished-episode resume is not shown. The movie's unfinished progress and its copy's resume are.",
      "Completed copies, saved online subtitles and local progress are seeded on stable through UI with a paused-main SubDL boundary. Copies are checked before candidate playback after the real installer upgrade, then played on the same candidate's offline restart, not a second upgrade.",
      "Installs are by the silent setup, not by the in-app updater, and the direct setup alone, not the Microsoft Store package.",
    ];
    await writeFile(join(evidence, "proof.json"), JSON.stringify(proof, null, 2));
    console.log(`${failed ? "FAIL" : "PASS"} installed upgrade: ${evidence}`);
  }
  if (failed) throw failed;
}

/** Whether this check's own Node process, which no rule blocks, gets an answer from `url`. */
const reaches = (url: string): Promise<{ url: string; status: number | null; error?: string }> =>
  fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(20_000) }).then(
    (response) => ({ url, status: response.status }),
    (error: unknown) => ({ url, status: null, error: String(error) }),
  );

/** The window's request to a public address, which the block must stop. */
const probe = `fetch(${JSON.stringify(OUTSIDE)}, { mode: "no-cors", cache: "no-store" }).then(() => "reached", (error) => "refused: " + error.message)`;

/** The frozen .15 telemetry matrix uses the same resolved pair and disposable install owner. */
export async function telemetryCommand(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      packages: { type: "string" },
      root: { type: "string" },
      "native-case": { type: "string", default: "all" },
      sha: { type: "string" },
    },
  });
  check(
    values["native-case"] === "all" || values["native-case"] === "compatibility",
    "Installed telemetry accepts --native-case all or compatibility",
  );
  check(!values.sha || /^[0-9a-f]{40}$/.test(values.sha), "Expected a full candidate SHA");
  check(
    values["native-case"] !== "compatibility" || !!values.sha,
    "Focused compatibility requires an explicit full candidate --sha",
  );
  const runner = disposableRunner();
  const root = values.root ?? "";
  const under = relative(runner.temp, root);
  if (
    !values.packages ||
    !isAbsolute(root) ||
    !under ||
    under.startsWith("..") ||
    isAbsolute(under)
  )
    throw new Error("Telemetry requires --packages and a new --root under RUNNER_TEMP");
  check(process.env["GITHUB_REF"] === "refs/heads/main", "Installed telemetry runs from main only");
  const receipt = readReceipt(
    JSON.parse(await readFile(join(values.packages, "receipt.json"), "utf8")),
  );
  check(
    receipt.resolved.stableTag === "v0.0.15",
    "Frozen telemetry acceptance requires published v0.0.15",
  );
  check(
    receipt.packages[0].source === "cc6980d88673c838a5da4ee80af9495e430a4210",
    "Frozen telemetry acceptance requires the published .15 source",
  );
  check(
    !values.sha || values.sha === receipt.packages[1].source,
    "Candidate pin differs from the resolved receipt",
  );
  check(
    receipt.repository === process.env["GITHUB_REPOSITORY"],
    "Receipt belongs to another repository",
  );
  await mkdir(root);
  const profiles = join(root, "profiles");
  await mkdir(profiles);
  const pkg = receipt.packages[1];
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./analytics-app.ts", import.meta.url)),
      "--native-telemetry",
      ...(values["native-case"] === "compatibility" ? ["--native-case=compatibility"] : []),
      `--installed-pair=${values.packages}`,
      `--expected-version=${pkg.version}`,
      `--expected-source=${pkg.source}`,
      runner.executable,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        TMPDIR: profiles,
        TEMP: profiles,
        TMP: profiles,
        MR_STREAMER_VERIFICATION_OUTPUT: join(root, "evidence"),
        MR_STREAMER_FFMPEG: runner.tools[0],
      },
    },
  );
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  if (code !== 0 || signal !== null) throw new Error(`Native telemetry failed: ${code ?? signal}`);
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "resolve") await resolveCommand(args);
  else if (command === "run") await runCommand(args);
  else if (command === "telemetry") await telemetryCommand(args);
  else {
    console.error(usage);
    process.exit(2);
  }
}
