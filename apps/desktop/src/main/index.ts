// Composition root: creates the window and wires the services to IPC.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  app,
  dialog,
  powerMonitor,
  autoUpdater,
  BrowserWindow,
  Menu,
  powerSaveBlocker,
  protocol,
  safeStorage,
  session,
  shell,
  type Rectangle,
} from "electron";
import { ARTWORK_SCHEME, DOWNLOAD_ARTWORK } from "@mrstreamer/contracts/downloads";
import type { IpcEvent, IpcEvents, IpcInput } from "@mrstreamer/contracts/ipc";
import { Diagnostics } from "@mrstreamer/core/diagnostics";
import { Failed } from "@mrstreamer/core/failure";
import { t } from "@mrstreamer/core/i18n";
import { Guide } from "@mrstreamer/core/guide/service";
import { updatesInApp } from "@mrstreamer/contracts/updates";
import { discovery, metadataFileFor } from "@mrstreamer/core/updates/feed";
import { ViewingRecord } from "@mrstreamer/core/viewing/service";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Stream from "effect/Stream";
import { WINDOW_BAR } from "../shared/window-bar.ts";
import { analyticsBuild } from "./analytics/build.ts";
import { Analytics } from "./analytics/service.ts";
import { profileOrigin } from "./analytics/storage.ts";
import { analyticsTransport } from "./analytics/transport.ts";
import { subscriptionHandlers } from "./handlers/subscriptions.ts";
import { libraryHandlers } from "./handlers/library.ts";
import { guideHandlers } from "./handlers/guide.ts";
import { titleHandlers } from "./handlers/titles.ts";
import { playbackHandlers } from "./handlers/playback.ts";
import { subtitleHandlers } from "./handlers/subtitles.ts";
import { outputHandlers } from "./handlers/output.ts";
import { viewingHandlers } from "./handlers/viewing.ts";
import { customListHandlers } from "./handlers/custom-lists.ts";
import { downloadHandlers } from "./handlers/downloads.ts";
import { analyticsHandlers } from "./handlers/analytics.ts";
import { preferenceHandlers } from "./handlers/preferences.ts";
import { updateHandlers } from "./handlers/updates.ts";
import { aboutHandlers } from "./handlers/about.ts";
import { emit, registerIpc, type IpcHandlers } from "./ipc.ts";
import { applyLanguage, languageFor } from "./language.ts";
import { miniPlayer, miniPlayerAvailable } from "./mini-player.ts";
import { installedDistribution } from "./platform/installation.ts";
import { electronInstaller } from "./platform/installer.ts";
import { diagnosticsExporter } from "./platform/diagnostics-export.ts";
import { removeUnfinishedWrites } from "./platform/json-file.ts";
import { keychainSecrets } from "./platform/secrets.ts";
import type { ReceiverAdapter, ScreenRect } from "./receivers/adapter.ts";
import { airplayAdapter } from "./receivers/airplay/adapter.ts";
import { castAdapter } from "./receivers/cast/adapter.ts";
// electron-vite builds the worker as its own file and hands back a function that starts it; the
// lint plugin reads the source file, which has no default export.
// oxlint-disable-next-line import/default
import createCatalogueWorker from "./ondemand/catalogue-worker.ts?nodeWorker";
// oxlint-disable-next-line import/default
import createGuideIndexWorker from "./guide/index-worker.ts?nodeWorker";
// oxlint-disable-next-line import/default
import createGuideSearchWorker from "./guide/search-worker.ts?nodeWorker";
import { mainLayer } from "./runtime.ts";
import { Downloads } from "./services/downloads.ts";
import { Library } from "./services/library.ts";
import { OnDemand } from "./services/ondemand.ts";
import { Output } from "./services/output.ts";
import { Licences } from "./services/licences.ts";
import { PlaybackCoordination } from "./services/playback-coordination.ts";
import { Playback } from "./services/playback.ts";
import { OnlineSubtitles } from "./services/online-subtitles.ts";
import { Settings } from "./services/preferences.ts";
import { preferencePublication } from "./preference-publication.ts";
import { Roster } from "./services/roster.ts";
import { Subscriptions } from "./services/subscription.ts";
import { DEFAULT_SCHEDULE, Updates, type UpdatesConfig } from "./services/updates.ts";
import { Watchlist } from "./services/watchlist.ts";
import { CustomLists } from "./services/custom-lists.ts";

// Matches `appId` in electron-builder.yml: Windows groups taskbar entries and notifications by it.
const APP_ID = "app.mrstreamer.player";
const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

/**
 * Where updates are found: the feed the release workflow publishes, and GitHub's API when the
 * feed is missing. Tests point both at local servers; MR_STREAMER_UPDATE_CHECKS=off stops the
 * automatic checks, as the packaged-app test and measurements do.
 */
const UPDATE_FEED =
  process.env["MR_STREAMER_UPDATE_FEED"] ??
  "https://mr-streamer-oss.github.io/MrStreamer/updates.json";
const UPDATE_API = process.env["MR_STREAMER_UPDATE_API"] ?? "https://api.github.com";
const REPOSITORY = "Mr-Streamer-OSS/MrStreamer";

/**
 * A copy installed as an MSIX package, from the Microsoft Store or sideloaded, runs with the
 * package's identity. The Store updates it, so the app never does, and it keeps a data folder of
 * its own: Windows lets a package change files that a direct install left in AppData, while
 * keeping the files it creates to itself, so sharing that folder would mix two profiles. An
 * explicit --user-data-dir, as tests pass, still wins.
 */
const storeCopy = process.windowsStore === true;
if (storeCopy && !app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", join(app.getPath("appData"), "Mr. Streamer Store"));
}
// Capture the evidence before application services or their migrations create profile files.
const initialProfileOrigin = profileOrigin(app.getPath("userData"));
/** The app's page in the Microsoft Store, by the Store ID Partner Center gave it. */
const STORE_PAGE = "ms-windows-store://pdp/?ProductId=9N45GG76ZP4T";
const STORE_REVIEW = "ms-windows-store://review/?ProductId=9N45GG76ZP4T";

/**
 * Chromium's own cache, mostly posters and backdrops, on disk at most this big; the oldest go
 * first. Artwork shown this session stays in memory either way.
 */
const DISK_CACHE_BYTES = 64 * 1024 * 1024;
app.commandLine.appendSwitch("disk-cache-size", String(DISK_CACHE_BYTES));

// The pictures kept with downloads load from the app's own scheme, as a page's images do.
protocol.registerSchemesAsPrivileged([
  { scheme: ARTWORK_SCHEME, privileges: { standard: true, secure: true } },
]);

let mainWindow: BrowserWindow | null = null;
/**
 * The viewer closed the window while a receiver had playback, and macOS keeps it, out of sight:
 * its page is what counts down to the next episode and answers the media keys. The Dock brings it
 * back, and it closes for good once the receiver lets go (see `start`).
 */
let away = false;
/**
 * The window the system's list of receivers opens from, and where its page was on screen when the
 * list was asked for, from then until the viewer is done at that list. The list hangs from a
 * place in that page, so it goes once the page is elsewhere or out of sight, and doesn't open
 * when that happens first (see `start`).
 */
let listedFrom: { readonly window: BrowserWindow; readonly page: Rectangle } | null = null;
/** How long to wait for a window on its way into full screen to say it arrived. */
const FULL_SCREEN_MS = 2000;
/**
 * How long the system's list waits after the window arrived in full screen. As macOS finishes
 * the change of Space it gives the window's app the front once more, and takes it from the helper
 * when that has just opened the list, which then closes by itself. On one Mac that happened to
 * lists opened up to 63 ms after `enter-full-screen` and to none from 65 ms on. The system names
 * no event for it, so this is that time with room to spare.
 */
const FULL_SCREEN_SETTLE_MS = 250;
/** When the window arrived in full screen, by `performance.now()`; null once it has left it. */
let filledAt: number | null = null;
/** The smallest the window gets, except as the mini player. */
const MIN_SIZE = { minWidth: 960, minHeight: 600 } as const;
/** Each window's mini player, which remembers where the window was. */
const miniPlayers = new WeakMap<BrowserWindow, ReturnType<typeof miniPlayer>>();

/**
 * Takes the window out of sight in place of closing it, with its page running as if on screen.
 * Chromium wakes a hidden page's timers once a minute after the first, which would hold the next
 * episode back by minutes, so the page isn't told it is hidden. A full-screen window leaves full
 * screen first: macOS shows a black screen in place of one that hides.
 */
function putAway(window: BrowserWindow): void {
  away = true;
  window.webContents.setBackgroundThrottling(false);
  if (!window.isFullScreen()) return window.hide();
  window.once("leave-full-screen", () => {
    // Not when it was brought back meanwhile.
    if (away) window.hide();
  });
  window.setFullScreen(false);
}

/** Puts the window on screen and in front, from out of sight or minimised. */
function bringBack(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (!away) return;
  away = false;
  window.webContents.setBackgroundThrottling(true);
}

/** Whether the viewer can see `window` as a window: not closed, hidden or minimised. */
function onScreen(window: BrowserWindow): boolean {
  return (
    !window.isDestroyed() &&
    window.isVisible() &&
    !window.isMinimized() &&
    !(isMac && app.isHidden())
  );
}

/**
 * Resolves once `window` has settled in full screen, for one on its way there or just arrived,
 * and at once for any other. A list opened before that loses the front to the window's app, and
 * closes by itself (see `FULL_SCREEN_SETTLE_MS`). The way out of full screen takes no list down.
 *
 * The wait also ends when `signal` gives it up or the window closes. However it ends, it leaves
 * no timer and no listener behind.
 */
function settledInFullScreen(window: BrowserWindow, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      clearTimeout(timer);
      window.off("enter-full-screen", arrived).off("closed", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    /** The window is there, or never said so in time: what is left of its time to settle. */
    const arrived = () => {
      clearTimeout(timer);
      const left = filledAt === null ? 0 : filledAt + FULL_SCREEN_SETTLE_MS - performance.now();
      if (left > 0) timer = setTimeout(done, left);
      else done();
    };
    window.once("closed", done);
    signal.addEventListener("abort", done, { once: true });
    // On its way: the window says it is full screen from the start, and tells when it arrived.
    if (filledAt === null && window.isFullScreen()) {
      window.once("enter-full-screen", arrived);
      timer = setTimeout(arrived, FULL_SCREEN_MS);
    } else arrived();
  });
}

/** Whether the window's page is at the same place and of the same size as it was. */
function samePage(now: Rectangle, was: Rectangle): boolean {
  return now.x === was.x && now.y === was.y && now.width === was.width && now.height === was.height;
}

/**
 * Where the system's list of receivers opens from: `anchor`, a place in the window's page in CSS
 * pixels, as a place on screen in points, with where the page is there and whether the window
 * has the keyboard, as the one the viewer is at does. Null while the window is out of sight, when
 * no list can hang from it.
 *
 * The page's zoom turns its pixels into points. A place outside the page, as one measured before
 * the window changed, gives way to the middle of the page.
 */
function listPlace(
  window: BrowserWindow,
  anchor: IpcInput<"output.pick">["anchor"],
): { readonly place: ScreenRect; readonly page: Rectangle; readonly front: boolean } | null {
  if (!onScreen(window)) return null;
  const page = window.getContentBounds();
  const zoom = window.webContents.getZoomFactor();
  const place = {
    x: page.x + anchor.x * zoom,
    y: page.y + anchor.y * zoom,
    width: anchor.width * zoom,
    height: anchor.height * zoom,
  };
  const inside = (at: number, from: number, length: number) => at >= from && at <= from + length;
  const inPage =
    inside(place.x + place.width / 2, page.x, page.width) &&
    inside(place.y + place.height / 2, page.y, page.height);
  return {
    page,
    front: window.isFocused(),
    place: inPage
      ? place
      : { x: page.x + page.width / 2, y: page.y + page.height / 2, width: 0, height: 0 },
  };
}

/**
 * Opens the app's window. `keeps` says, when the viewer closes it, whether it only goes out of
 * sight; `closeStreams` runs once it is gone. `changed` runs whenever it moves, changes size or
 * goes out of sight, and once it is gone.
 */
function openWindow(
  closeStreams: () => void,
  keeps: () => boolean,
  changed: (window: BrowserWindow) => void,
  observe: (window: BrowserWindow) => void,
): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    ...MIN_SIZE,
    show: false,
    backgroundColor: "#000000",
    // The picture fills the window. macOS keeps its traffic lights top left; Windows draws its
    // window controls top right over a transparent strip.
    ...(isMac
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: WINDOW_BAR.trafficLights }
      : {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#ffffff",
            height: WINDOW_BAR.height,
          },
        }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.once("ready-to-show", () => window.show());
  // Full screen hides the traffic lights and the Windows controls; the top bar takes their room.
  const fullScreen = () => emit(window.webContents, "window.fullScreen", window.isFullScreen());
  window.on("enter-full-screen", () => {
    filledAt = performance.now();
    fullScreen();
  });
  window.on("leave-full-screen", () => {
    filledAt = null;
    fullScreen();
  });
  window.webContents.on("did-finish-load", fullScreen);
  window.on("close", (event) => {
    if (!keeps()) return;
    event.preventDefault();
    putAway(window);
  });
  window.on("closed", () => {
    // Forgotten first: ending its streams can tell of a change at once, and nothing may be sent
    // to a window that is gone.
    if (mainWindow === window) {
      mainWindow = null;
      away = false;
      filledAt = null;
    }
    // Nothing can be watching once the window is gone, so release the provider connection.
    closeStreams();
  });
  const moved = () => changed(window);
  window
    .on("move", moved)
    .on("resize", moved)
    .on("hide", moved)
    .on("minimize", moved)
    .on("enter-full-screen", moved)
    .on("leave-full-screen", moved)
    .on("closed", moved);
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  miniPlayers.set(window, miniPlayer(window, MIN_SIZE));

  // Attach lifecycle observation before loadFile/loadURL can emit the initial renderer start.
  observe(window);
  const devServer = process.env["ELECTRON_RENDERER_URL"];
  if (devServer) void window.loadURL(devServer);
  else void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  return window;
}

async function start(): Promise<void> {
  await app.whenReady();
  if (!isMac) {
    // Windows and Linux have no app menu to keep; macOS gets its menu in the interface language,
    // with the Edit shortcuts fields need, such as paste (see `applyLanguage`).
    Menu.setApplicationMenu(null);
    app.setAppUserModelId(APP_ID);
    // Nothing checks spelling, so Chromium has no reason to download a dictionary from Google.
    // macOS uses its own spellchecker and downloads nothing.
    session.defaultSession.setSpellCheckerLanguages([]);
  }
  if (process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text") {
    // No keyring (GNOME Keyring or KWallet) to hold the key. Like Chromium's own passwords, the
    // login then uses a fixed key: it still saves, but other programs of the same user can read it.
    safeStorage.setUsePlainTextEncryption(true);
  }
  const dataDir = app.getPath("userData");
  // Installation validation can fail before the runtime loads Settings.
  applyLanguage(languageFor(await Settings.readInterfaceLanguage(dataDir).catch(() => undefined)));
  const distribution = await installedDistribution({
    platform: process.platform,
    packaged: app.isPackaged,
    store: storeCopy,
    resources: process.resourcesPath,
  });
  const appUpdates = updatesInApp(distribution);
  await removeUnfinishedWrites(dataDir);
  // And in the folder of the guides of Settings > Guides.
  await removeUnfinishedWrites(join(dataDir, "guides"));
  const userAgent = `MrStreamer/${app.getVersion()}`;

  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(permission === "fullscreen");
  });

  // Local verification explicitly names its isolated profile. Production capture requires release
  // configuration; packaging and update-check preferences alone cannot enable it.
  const localEndpoint = app.commandLine.hasSwitch("user-data-dir")
    ? process.env["MR_STREAMER_ANALYTICS_LOCAL_ENDPOINT"]
    : undefined;
  const buildProperties = analyticsBuild({
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    store: storeCopy,
  });
  let refreshConsent: (() => Promise<void>) | undefined;
  const analytics = new Analytics({
    dataDir,
    consentChanged: () => refreshConsent?.(),
    playbackReset: () => {
      if (mainWindow) emit(mainWindow.webContents, "analytics.reset", null);
    },
    origin: initialProfileOrigin,
    properties: {
      ...buildProperties,
      update_channel: appUpdates ? "stable" : "none",
    },
    transport: analyticsTransport({
      production: __ANALYTICS_CAPTURE__,
      releaseBuild: __ANALYTICS_RELEASE_BUILD__ && buildProperties.build_channel !== "unknown",
      packaged: app.isPackaged,
      isolated: app.commandLine.hasSwitch("user-data-dir"),
      automated:
        ["development", "test"].includes(process.env["NODE_ENV"] ?? "") ||
        [
          "enable-automation",
          "remote-debugging-port",
          "inspect",
          "inspect-brk",
          "use-mock-keychain",
        ].some((flag) => app.commandLine.hasSwitch(flag)),
      localEndpoint,
    }),
  });
  powerMonitor.on("suspend", () => analytics.suspendPlayback());
  powerMonitor.on("resume", () => analytics.suspendPlayback());
  // Outcomes of work begun before the update channel is read would carry a guessed dimension.
  let dimensionsReady = !appUpdates;
  const observeOperation = (event: "download_ended" | "update_check_ended") => () =>
    dimensionsReady ? analytics.observeOperation(event) : () => {};

  const updatesConfig = (): UpdatesConfig => {
    switch (distribution) {
      case "store":
        return { installed: app.getVersion(), openStore: () => shell.openExternal(STORE_PAGE) };
      case "pacman":
        return { installed: app.getVersion(), managed: "pacman" };
      case "direct":
        return {
          installed: app.getVersion(),
          onChannelChanged: (channel) => {
            analytics.setUpdateChannel(channel);
            analytics.noteSetting("update_channel");
          },
          observeCheck: (channel) => {
            analytics.setUpdateChannel(channel);
            dimensionsReady = true;
            return observeOperation("update_check_ended")();
          },
          discover: discovery({
            feedUrl: UPDATE_FEED,
            api: UPDATE_API,
            repository: REPOSITORY,
            metadataFile: metadataFileFor(process.platform),
            userAgent,
            // A test feed serves its own files.
            ...(process.env["MR_STREAMER_UPDATE_FEED"] ? { filesFrom: "" } : {}),
          }),
          installer: electronInstaller(),
          schedule: process.env["MR_STREAMER_UPDATE_CHECKS"] === "off" ? null : DEFAULT_SCHEDULE,
        };
    }
  };

  const runtime = ManagedRuntime.make(
    mainLayer({
      dataDir,
      usage: {
        action: (action) => analytics.actionObserver(action),
        setting: (setting) => analytics.settingObserver(setting),
      },
      downloads: { observeTransfer: observeOperation("download_ended") },
      secrets: keychainSecrets,
      userAgent,
      ffmpeg: toolPath("ffmpeg"),
      ffprobe: toolPath("ffprobe"),
      catalogueWorker: (setup) => createCatalogueWorker({ workerData: setup }),
      guideIndexWorker: (options) => createGuideIndexWorker(options),
      guideSearchWorker: (options) => createGuideSearchWorker(options),
      output: {
        adapters: receiverAdapters(),
        observePlayback: (kind, control) => analytics.remotePlayback(kind, control),
      },
      // MR_STREAMER_TMDB_KEY at run time overrides the key built in, for testing.
      tmdbKey: process.env["MR_STREAMER_TMDB_KEY"] || __TMDB_KEY__ || null,
      region: app.getLocaleCountryCode() || "US",
      ...(process.env["MR_STREAMER_TMDB_API"]
        ? { tmdbApi: process.env["MR_STREAMER_TMDB_API"] }
        : {}),
      updates: updatesConfig(),
    }),
  );
  const {
    subscriptions,
    roster,
    settings,
    library,
    onDemand,
    playback,
    coordination,
    onlineSubtitles,
    output,
    updates,
    guide,
    viewing,
    watchlist,
    customLists,
    diagnostics,
    licences,
    downloads,
  } = await runtime.runPromise(
    Effect.all({
      subscriptions: Subscriptions,
      roster: Roster,
      settings: Settings,
      library: Library,
      onDemand: OnDemand,
      playback: Playback,
      coordination: PlaybackCoordination,
      onlineSubtitles: OnlineSubtitles,
      output: Output,
      updates: Updates,
      guide: Guide,
      viewing: ViewingRecord,
      watchlist: Watchlist,
      customLists: CustomLists,
      diagnostics: Diagnostics,
      licences: Licences,
      downloads: Downloads,
    }),
  );

  // Back from sleep or unlocked, the clock may have moved past where a guide hands a channel on.
  powerMonitor.on("resume", () => void runtime.runFork(guide.checkTime));
  powerMonitor.on("unlock-screen", () => void runtime.runFork(guide.checkTime));

  // mrstreamer://download/<id>/<poster|wide>: a download's kept picture, from its own folder.
  // Nothing else answers: no other host, path or file.
  protocol.handle(ARTWORK_SCHEME, async (request) => {
    const url = URL.parse(request.url);
    const [, id, artwork, extra] = url?.pathname.split("/") ?? [];
    const kind = DOWNLOAD_ARTWORK.find((each) => each === artwork);
    if (url?.host !== "download" || !id || !kind || extra !== undefined) {
      return new Response(null, { status: 404 });
    }
    const kept = await runtime.runPromise(downloads.artwork(decodeURIComponent(id), kind));
    const bytes = kept && (await readFile(kept.path).catch(() => null));
    return bytes
      ? new Response(bytes, { headers: { "Content-Type": kept.type, "Cache-Control": "no-store" } })
      : new Response(null, { status: 404 });
  });
  const updateStatus = await runtime.runPromise(updates.status);
  analytics.setUpdateChannel(
    updatesInApp(updateStatus.distribution) ? updateStatus.channel : "none",
  );
  dimensionsReady = true;
  const preferences = await runtime.runPromise(
    preferencePublication({
      read: Effect.gen(function* () {
        const viewing = yield* settings.get;
        const collection = yield* Effect.promise(() => analytics.settings());
        return { ...viewing, analyticsEnabled: collection.enabled };
      }),
      write: (patch) => settings.update(patch),
      consent: (enabled) =>
        Effect.tryPromise({
          try: () => analytics.configure(enabled),
          catch: () =>
            new Failed({
              error: { kind: "unexpected", detail: "Analytics preference could not be saved." },
            }),
        }),
      reconfigure: onDemand.reconfigure,
      publish: (snapshot) => {
        if (mainWindow) emit(mainWindow.webContents, "preferences.changed", snapshot);
      },
      stale: () => {
        if (mainWindow) emit(mainWindow.webContents, "preferences.stale", null);
      },
    }),
  );
  refreshConsent = async () => {
    await runtime.runPromise(preferences.get);
  };
  // Replay initial consent once composition exists, including reads settled before it was ready.
  void analytics.loaded.then(refreshConsent).catch(() => {});
  // The interface language, before the window asks for it.
  let language = languageFor(await runtime.runPromise(settings.interfaceLanguage));
  applyLanguage(language);

  const exporter = diagnosticsExporter(dataDir, async () => {
    const [saved, status] = await Promise.all([
      runtime.runPromise(subscriptions.list),
      runtime.runPromise(updates.status),
    ]);
    return {
      version: app.getVersion(),
      commit: __BUILD_COMMIT__,
      platform: process.platform,
      arch: process.arch,
      distribution: status.distribution,
      channel: status.channel,
      subscriptions: {
        xtream: saved.filter((entry) => entry.kind === "xtream").length,
        m3u: saved.filter((entry) => entry.kind === "m3u").length,
      },
      acceleratedVideoDecodeDisabled: app.commandLine.hasSwitch("disable-accelerated-video-decode"),
      checked: status.checked && {
        at: status.checked.at,
        failure: status.checked.failure?.kind ?? null,
      },
    };
  });

  /** Sends each change to the window, while there is one. */
  const forward = <A, E extends IpcEvent>(
    changes: Stream.Stream<A>,
    event: E,
    payload: (change: A) => IpcEvents[E],
  ) =>
    runtime.runFork(
      Stream.runForEach(changes, (change) =>
        Effect.sync(() => {
          if (mainWindow) emit(mainWindow.webContents, event, payload(change));
        }),
      ),
    );
  forward(library.changes, "library.updated", (status) => status);
  forward(onDemand.changes, "ondemand.updated", (status) => status);
  forward(onDemand.progressChanges, "ondemand.progress", (metadata) => metadata);
  forward(onDemand.detailsChanged, "ondemand.detailsChanged", (title) => title);
  forward(guide.changes, "guide.updated", () => null);
  forward(viewing.changes, "viewing.changed", (sequence) => ({ sequence }));
  forward(watchlist.changes, "watchlist.changed", () => null);
  forward(customLists.changes, "customLists.changed", () => null);
  forward(updates.changes, "updates.changed", (status) => {
    analytics.setUpdateChannel(updatesInApp(status.distribution) ? status.channel : "none");
    return status;
  });
  forward(downloads.changes, "downloads.changed", (list) => list);
  forward(playback.fileReplaced, "playback.fileReplaced", (sessionId) => ({ sessionId }));
  forward(playback.readingAhead, "playback.readingAhead", (sessionId) => ({ sessionId }));
  forward(playback.tracksChanged, "playback.tracksChanged", (sessionId) => ({ sessionId }));
  // A receiver plays from this computer, so it stays awake while one does. The display may sleep.
  let awake: number | null = null;
  runtime.runFork(
    Stream.runForEach(output.changes, (status) =>
      Effect.sync(() => {
        // A window out of sight is there for the receiver only. Once the receiver lets go it
        // closes, as the viewer asked, before its page hears of it: the page would carry on
        // here, or start a preview, with nobody watching.
        if (away && status.output.kind === "local") mainWindow?.destroy();
        if (mainWindow) emit(mainWindow.webContents, "output.changed", status);
        const playing = status.output.kind === "receiver" && status.output.media !== null;
        if (playing && awake === null) awake = powerSaveBlocker.start("prevent-app-suspension");
        if (!playing && awake !== null) {
          powerSaveBlocker.stop(awake);
          awake = null;
        }
      }),
    ),
  );

  const pickList: IpcHandlers["output.pick"] = ({ anchor, request }) =>
    Effect.suspend(() => {
      const window = mainWindow;
      const asked = window && listPlace(window, anchor);
      // No window on screen for the list to open from: nothing changes.
      if (!window || !asked) return output.status;
      // The list is this window's from here on, also while it waits for the window to
      // settle: `followList` ends it with the window, the output service with what the
      // viewer chooses next, and the page with the view it asked from, by its name.
      const mine = { window, page: asked.page };
      listedFrom = mine;
      return output
        .pick(async (signal) => {
          await settledInFullScreen(window, signal);
          // The window closed or went elsewhere meanwhile, or another took its place, which
          // leaves the place asked for behind: no list opens.
          const from = mainWindow === window ? listPlace(window, anchor) : null;
          if (!from || !samePage(from.page, asked.page)) return null;
          // Nor when the viewer went to another app while the window settled: the list
          // would open over that app, and its helper would take the keyboard from it. A
          // window that had no keyboard when asked isn't held to this: leaving the mini
          // player takes it away for a moment, and an O can arrive in that. Once the helper
          // is asked for the list, it follows where the viewer goes itself (see
          // native/airplay/Picker.swift), and takes the keyboard from this window to do so.
          return asked.front && !from.front ? null : from.place;
        }, request)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (listedFrom === mine) listedFrom = null;
            }),
          ),
        );
    });

  registerIpc(
    (effect) => runtime.runPromiseExit(effect),
    {
      ...subscriptionHandlers({ subscriptions, roster, settings }),
      ...libraryHandlers({ library, subscriptions, roster, settings }),
      ...guideHandlers({ guide, library }),
      ...titleHandlers({ onDemand, watchlist, viewing, subscriptions, roster }),
      ...playbackHandlers({
        playback,
        coordination,
        library,
        onDemand,
        downloads,
        output,
        settings,
        analytics,
      }),
      ...subtitleHandlers({ onlineSubtitles }),
      ...outputHandlers({ output, coordination, library, onDemand, settings, analytics, pickList }),
      ...viewingHandlers({ viewing, settings }),
      ...customListHandlers({ customLists }),
      ...downloadHandlers({ downloads }),
      ...analyticsHandlers({ analytics, playback }),
      ...preferenceHandlers({ preferences }),
      ...updateHandlers({
        updates,
        storeReview: storeCopy ? () => shell.openExternal(STORE_REVIEW) : null,
      }),
      ...aboutHandlers({ licences, exporter, window: () => mainWindow }),
      "language.get": () => Effect.succeed(language),
      "language.set": ({ choice }) =>
        Effect.gen(function* () {
          yield* settings.setInterfaceLanguage(choice);
          language = languageFor(choice);
          applyLanguage(language);
          return language;
        }),
      "window.miniPlayerAvailable": () => Effect.succeed(miniPlayerAvailable()),
      "window.setMiniPlayer": ({ on }) =>
        Effect.promise(async () => {
          const mini = mainWindow && miniPlayers.get(mainWindow);
          await mini?.set(on);
          return null;
        }),
    },
    (sender) => sender === mainWindow?.webContents,
  );

  // What plays here ends with the window, and so does a connect to a receiver still under way:
  // with no window, nothing plays and nothing connects. With a receiver as the output a window
  // closes only as the app quits, and the quit ends that playback itself.
  const closeStreams = () =>
    void runtime.runFork(
      Effect.flatMap(output.remote, (remote) =>
        remote ? Effect.void : Effect.andThen(output.disconnect, playback.closeAll),
      ),
    );
  /**
   * Takes the system's list down, or keeps one that still waits for its window from opening.
   * Only the list goes. A receiver that plays goes on, and what plays here does too.
   */
  const closeList = () => {
    listedFrom = null;
    void runtime.runFork(output.closePicker());
  };
  /**
   * Ends the system's list once the window it opens from is elsewhere, another size or out of
   * sight: the button it hangs from is no longer there.
   */
  const followList = (window: BrowserWindow) => {
    if (listedFrom?.window !== window) return;
    if (onScreen(window) && samePage(window.getContentBounds(), listedFrom.page)) return;
    closeList();
  };
  /**
   * The app is quitting, or restarting into an update: its window closes for good, whatever
   * plays. Both say so before they close the window. An update's restart closes it before
   * `before-quit`, and would wait forever for a window that only went out of sight.
   */
  let leaving = false;
  /** Only the primary window on screen with keyboard focus counts as foreground app use. */
  const trackForeground = (window: BrowserWindow) => {
    let requestedClose = false;
    window.on("close", (event) => {
      requestedClose = !event.defaultPrevented;
    });
    window.webContents.on("did-start-loading", () => {
      requestedClose = false;
      analytics.rendererGone();
    });
    window.webContents.on("render-process-gone", (_event, details) => {
      analytics.rendererGone();
      if (leaving || requestedClose || details.reason === "clean-exit") return;
      analytics.noteRendererExit(
        details.reason === "crashed" ? "crashed" : details.reason === "killed" ? "killed" : "other",
      );
    });
    const observe = () =>
      analytics.setForeground(
        !leaving &&
          !window.isDestroyed() &&
          window.isVisible() &&
          !window.isMinimized() &&
          window.isFocused(),
      );
    window
      .on("focus", observe)
      .on("blur", observe)
      .on("show", observe)
      .on("hide", observe)
      .on("minimize", observe)
      .on("restore", observe)
      .on("closed", observe);
    observe();
  };
  const leave = () => {
    leaving = true;
    analytics.rendererGone();
    analytics.setForeground(false);
    // No list opens from a window on its way out.
    closeList();
  };
  app.on("before-quit", leave);
  autoUpdater.on("before-quit-for-update", leave);
  // On macOS the app outlives its window. While a receiver has playback, or is gone with what it
  // played still to pick up, closing the window keeps it out of sight. Other systems quit with
  // their window, which ends the receiver's playback.
  const keeps = () => isMac && !leaving && runtime.runSync(output.remote);
  mainWindow = openWindow(closeStreams, keeps, followList, trackForeground);
  // How long the app took to show its window, from the start of the process.
  mainWindow.once("ready-to-show", () =>
    diagnostics.record({ op: "start", ms: Math.round(performance.now()), outcome: "ok" }),
  );
  /** Set by the first quit: the runtime closes once, however often the app is asked to quit. */
  let closing = false;
  app.on("activate", () => {
    // Nothing opens on a runtime that is closing.
    if (closing) return;
    if (!mainWindow) {
      mainWindow = openWindow(closeStreams, keeps, followList, trackForeground);
    } else if (away) bringBack(mainWindow);
  });
  app.on("will-quit", (event) => {
    // The quit waits for the runtime to close, which stops background work, closes the database
    // and writes the diagnostics still queued. An update's restart comes this way too: its
    // installer has started by then and waits for the app to exit, so the wait takes nothing
    // from it.
    event.preventDefault();
    if (closing) return;
    closing = true;
    // Streams close right away, so no ffmpeg or provider connection outlives the app.
    runtime.runSyncExit(playback.closeAll);
    // Exits instead of quitting again: with nothing left to write, closing can finish before this
    // handler returns to Electron, which ignores a quit asked for until then. Every window has
    // closed by now, so exiting skips nothing.
    const exit = () => app.exit();
    void Promise.all([analytics.close(), runtime.dispose()]).then(exit, exit);
  });

  // Keeps account status, the channel lists and the guides current without making the UI wait.
  runtime.runFork(roster.refreshDue);
}

/**
 * The ffmpeg that converts streams the player cannot decode, or the ffprobe that reads movie
 * files: bundled with packaged builds, from PATH during development. MR_STREAMER_FFMPEG points at
 * another ffmpeg, with its ffprobe beside it.
 */
function toolPath(tool: "ffmpeg" | "ffprobe"): string | null {
  const executable = isWindows ? `${tool}.exe` : tool;
  const override = process.env["MR_STREAMER_FFMPEG"];
  if (override) return tool === "ffmpeg" ? override : join(dirname(override), executable);
  if (!app.isPackaged) return tool;
  const bundled = join(process.resourcesPath, "ffmpeg", executable);
  return existsSync(bundled) ? bundled : null;
}

/**
 * The ways this build reaches receivers on the network. AirPlay on macOS, through the helper the
 * app comes with (see scripts/build-airplay-helper.sh), where it is there. Google Cast on Windows;
 * on other systems only when MR_STREAMER_CAST=on asks for it, since nobody has tried it there.
 * MR_STREAMER_AIRPLAY_LOG=1 prints what the AirPlay helper says, which is the record of what a
 * receiver did.
 */
function receiverAdapters(): ReceiverAdapter[] {
  const adapters: ReceiverAdapter[] = [];
  if (isMac) {
    const helper = app.isPackaged
      ? join(process.resourcesPath, "airplay", "MrStreamerAirPlay")
      : join(app.getAppPath(), "vendor", "airplay", "mac-arm64", "MrStreamerAirPlay");
    if (existsSync(helper)) {
      adapters.push(
        airplayAdapter({
          helper,
          ...(process.env["MR_STREAMER_AIRPLAY_LOG"] === "1"
            ? { log: (line) => console.error(`[airplay] ${line}`) }
            : {}),
        }),
      );
    }
  }
  if (isWindows || process.env["MR_STREAMER_CAST"] === "on") adapters.push(castAdapter());
  return adapters;
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// One copy per profile: a second would keep its own copy of the settings and write over the
// first's. Opening the app again brings the running copy's window forward instead.
if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => {
    if (mainWindow) bringBack(mainWindow);
  });
  // Quitting hands the profile on at once: an update's AppImage starts its new copy just before
  // this one quits.
  app.on("before-quit", () => app.releaseSingleInstanceLock());
  void start().catch((error: unknown) => {
    console.error("[startup]", error);
    dialog.showErrorBox(
      t("Mr. Streamer could not start"),
      error instanceof Error ? error.message : String(error),
    );
    app.exit(1);
  });
} else {
  app.quit();
}
