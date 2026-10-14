// @vitest-environment happy-dom
// Downloads in the window: the page's queue and copies, Connect's way to them with no
// subscription saved, a movie's Download in its details, the top bar's word on how they stand,
// and a copy playing offline in the same player, which asks no provider, record, receiver or
// subtitle service.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import type { InterfaceLanguage } from "@mrstreamer/contracts/language";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { OutputStatus } from "@mrstreamer/contracts/output";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import { setLanguage } from "@mrstreamer/core/i18n";
import { App } from "../../src/renderer/src/app/App.tsx";
import { useLocale } from "../../src/renderer/src/app/language.ts";
import { openWatch, useUi } from "../../src/renderer/src/app/ui-store.ts";
import { WindowBar } from "../../src/renderer/src/components/WindowBar.tsx";
import { MovieDownload } from "../../src/renderer/src/features/downloads/DownloadControls.tsx";
import { DownloadsPage } from "../../src/renderer/src/features/downloads/DownloadsPage.tsx";
import { SettingsPage } from "../../src/renderer/src/features/settings/SettingsPage.tsx";
import { TitleWatch } from "../../src/renderer/src/features/titles/TitleWatch.tsx";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
import { syncDownloads, watchOffline } from "../../src/renderer/src/lib/downloads.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

/** A download of a movie of the test subscription, as main lists it; `over` changes it. */
function download(over: Partial<Download> = {}): Download {
  return {
    id: "d1",
    title: { kind: "movie", id: "m1" },
    subscription: { id: SUBSCRIPTION, name: "Home IPTV" },
    name: "Past Lives",
    episodeName: null,
    year: 2023,
    duration: 6360,
    originalLanguage: "ko",
    posterUrl: "mrstreamer://download/d1/poster",
    wideUrl: null,
    size: 2_300_000_000,
    status: { kind: "complete" },
    progress: null,
    ...over,
  };
}

/** A live channel of the test subscription, for Watch. */
const channel: LiveChannel = {
  subscriptionId: SUBSCRIPTION,
  id: "vrt",
  name: "BE | VRT 1",
  title: "VRT 1",
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: [],
  catchupDays: null,
  variants: [{ id: "vrt", name: "BE | VRT 1", tags: [], quality: null }],
};

const list = (items: readonly Download[], ended = 0): DownloadList => ({
  items,
  bytes: 13_000_000_000,
  free: 212_000_000_000,
  ended,
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/**
 * Waits, a little at a time, until the window shows what `ready` looks for, and fails when it
 * never does: a wait for what can't come would only make the test slow.
 */
async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !ready(); tries++) {
    await act(settle);
  }
  if (!ready()) throw new Error("The window never showed what the test waited for.");
}

let unmount = () => {};
let stopSync = () => {};
afterEach(() => {
  unmount();
  stopSync();
  titlePlayer.close();
  player.reset();
});

beforeEach(() => {
  ipc.reset();
  useUi.setState(useUi.getInitialState(), true);
});

/**
 * Renders `element` in the page with a fresh query client that hears `downloads.changed`, and
 * waits until it shows what `ready` selects, when a test names something to wait for.
 */
async function show(element: ReactElement, ready?: string): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stopSync = syncDownloads(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, element));
    await settle();
  });
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
  if (ready) await until(() => container.querySelector(ready) !== null);
  return container;
}

const button = (within: HTMLElement, text: string) =>
  [...within.querySelectorAll("button")].find(
    (each) => each.textContent?.trim() === text || each.getAttribute("aria-label") === text,
  );
const labelled = (within: HTMLElement, label: string) =>
  within.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
/** Main says the list changed; waits until the window shows what `ready` looks for. */
async function changed(next: DownloadList, ready: () => boolean): Promise<void> {
  await act(async () => ipc.emit("downloads.changed", next));
  await until(ready);
}

/** A key pressed with `target` in focus; says whether the window took it for itself. */
async function key(name: string, target: EventTarget = window): Promise<boolean> {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event.defaultPrevented;
}

const click = (element: HTMLElement | null | undefined) =>
  act(async () => {
    element?.click();
    await settle();
  });

describe("the Downloads page", () => {
  it("says how each download stands and does what its row offers", async () => {
    ipc.always(
      "downloads.list",
      list([
        download({
          id: "running",
          name: "Dune: Part Two",
          status: {
            kind: "transferring",
            received: 2_500_000_000,
            size: 4_100_000_000,
            rate: 2_000_000,
            restarted: false,
          },
        }),
        download({
          id: "waiting",
          name: "Severance",
          title: { kind: "episode", id: "e3", seriesId: "s", season: 2, episode: 3 },
          episodeName: "Who Is Alive?",
          status: { kind: "waiting" },
        }),
        download({
          id: "full",
          name: "Shōgun",
          status: { kind: "failed", failure: { kind: "disk-full", needed: 1_200_000_000 } },
        }),
        download({ id: "copy", progress: { position: 3900, duration: 6360 } }),
        download({ id: "kept", name: "Oppenheimer", subscription: null }),
      ]),
    );
    const page = await show(createElement(DownloadsPage), "[data-download]");
    const text = page.textContent ?? "";
    expect(text).toContain("13 GB on this computer · 212 GB free");
    expect(text).toContain("60% · 2.5 GB of 4.1 GB · 13 min left");
    expect(text).toContain("Severance · S2 E3 · Who Is Alive?");
    expect(text).toContain("Waiting while Home IPTV plays");
    expect(text).toContain("Disk full. Free 1.2 GB, then retry.");
    expect(text).toContain("41 min left");
    expect(text).toContain("Subscription removed, copy kept");
    // The queue comes before the copies.
    expect(text.indexOf("Queue")).toBeLessThan(text.indexOf("On this computer"));

    const row = (id: string) => page.querySelector<HTMLElement>(`[data-download="${id}"]`)!;
    await click(button(row("running"), "Cancel"));
    await click(button(row("full"), "Retry"));
    expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "running" }]);
    expect(ipc.argsOf("downloads.retry")).toEqual([{ id: "full" }]);
    // A copy goes only once the viewer says so twice.
    await click(button(row("kept"), "Delete"));
    expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "running" }]);
    await click(button(row("kept"), "Delete copy"));
    expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "running" }, { id: "kept" }]);
  });

  it("follows main's word on the list as it changes", async () => {
    ipc.always("downloads.list", list([download({ status: { kind: "queued" } })]));
    const page = await show(createElement(DownloadsPage), "[data-download]");
    expect(page.textContent).toContain("Queued");
    await changed(list([download()], 2), () => button(page, "Watch offline") !== undefined);
    expect(button(page, "Watch offline")).toBeDefined();
    expect(page.textContent).toContain("Unfinished downloads ended with their subscription.");
  });

  it("keeps main's later word over a list it was still reading", async () => {
    const read = ipc.hold("downloads.list");
    const page = await show(createElement(DownloadsPage), "h1");
    await changed(list([download()]), () => button(page, "Watch offline") !== undefined);
    // The list main read before that copy was complete answers only now.
    await act(async () => {
      read.resolve(list([]));
      await settle();
    });
    expect(button(page, "Watch offline")).toBeDefined();
    expect(page.textContent).not.toContain("Nothing downloaded yet");
  });
});

describe("with no subscription saved", () => {
  it("opens the copies from Connect, and Add subscription goes back to the form", async () => {
    ipc.always("subscription.list", []);
    ipc.always("downloads.list", list([download({ subscription: null })]));
    const app = await show(createElement(App), "form");
    expect(app.querySelector("form")).not.toBeNull();
    // Connect offers Downloads once the list it reads says a copy is here.
    await until(() => button(app, "Downloads") !== undefined);
    await click(button(app, "Downloads"));
    expect(app.querySelector("form")).toBeNull();
    expect(app.textContent).toContain("Past Lives");
    expect(app.textContent).toContain("Subscription removed, copy kept");
    // Only Downloads is a page here.
    expect(
      [...app.querySelectorAll("header button")].map((each) => each.textContent?.trim()),
    ).toEqual(["Downloads", "Add subscription"]);
    // A copy plays over it, with nothing in its bar that needs a subscription.
    const opened = ipc.hold("playback.openCopy");
    await click(button(app, "Watch offline"));
    await until(() => app.querySelector("[data-view=title]") !== null);
    expect(ipc.argsOf("playback.openCopy")).toEqual([
      {
        copy: "d1",
        decoders: expect.any(Array),
        measurement: ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement,
      },
    ]);
    expect(labelled(app, "Search")).toBeNull();
    expect(labelled(app, "Settings")).toBeNull();
    opened.reject({ kind: "stream", failure: { kind: "unavailable", status: 404 } });
    await until(() => app.textContent?.includes("Download missing") ?? false);
    expect(app.textContent).toContain("Its file is no longer on this computer.");
    await act(async () => {
      titlePlayer.close();
      useUi.setState({ playingTitle: false });
      await settle();
    });
    await click(button(app, "Add subscription"));
    expect(app.querySelector("form")).not.toBeNull();
  });

  it("offers no Downloads on Connect while nothing is on this computer", async () => {
    ipc.always("subscription.list", []);
    ipc.always("downloads.list", list([]));
    const app = await show(createElement(App), "form");
    expect(app.querySelector("form")).not.toBeNull();
    expect(button(app, "Downloads")).toBeUndefined();
  });
});

describe("a copy playing offline", () => {
  const offers: OutputStatus = {
    offers: ["airplay"],
    airplayRoutes: true,
    scanning: false,
    receivers: [],
    output: { kind: "local" },
  };

  it("plays from this computer with its own progress, and asks nobody online", async () => {
    ipc.emit("output.changed", offers);
    const opened = ipc.hold("playback.openCopy");
    const watch = await show(createElement(TitleWatch));
    await act(async () => {
      useUi.setState({ playingTitle: true });
      // Left at 1200 s a moment ago: main kept it, the list the window holds still says 300 s.
      watchOffline(download({ progress: { position: 300, duration: 6360 } }));
      opened.resolve({
        sessionId: "c1",
        copy: "d1",
        url: "http://127.0.0.1/title/c1.mp4",
        duration: 6360,
        audio: [],
        subtitles: [],
        progress: { position: 1200, duration: 6360 },
      });
      await settle();
    });
    expect(ipc.argsOf("playback.openCopy")).toEqual([
      {
        copy: "d1",
        decoders: expect.any(Array),
        measurement: ipc.argsOf("analytics.playbackBegin").at(-1)!.measurement,
      },
    ]);
    expect(watch.textContent).toContain("Past Lives");
    expect(watch.textContent).toContain("2023 · Offline");
    // A copy plays here only: the receivers' button isn't offered.
    expect(labelled(watch, "AirPlay")).toBeNull();
    await click(labelled(watch, "Subtitles"));
    expect(document.body.textContent).not.toContain("Find online");
    await act(async () => {
      titlePlayer.close();
      await settle();
    });
    // Resumed a few seconds back, and kept with the copy as it closes.
    expect(ipc.argsOf("downloads.recordProgress")).toEqual([
      { id: "d1", position: 1195, duration: 6360 },
    ]);
    const methods = ipc.methods();
    for (const online of [
      "playback.openTitle",
      "viewing.recordProgress",
      "viewing.episodes",
      "output.openTitle",
      "subtitles.search",
      "ondemand.details",
    ] as const) {
      expect(methods).not.toContain(online);
    }
  });

  it("starts over once main says it was watched to its end", async () => {
    const opened = ipc.hold("playback.openCopy");
    await show(createElement(TitleWatch));
    await act(async () => {
      useUi.setState({ playingTitle: true });
      watchOffline(download({ progress: { position: 1200, duration: 6360 } }));
      opened.resolve({
        sessionId: "c1",
        copy: "d1",
        url: "http://127.0.0.1/title/c1.mp4",
        duration: 6360,
        audio: [],
        subtitles: [],
        progress: { position: 6300, duration: 6360 },
      });
      await settle();
    });
    expect(titlePlayer.state().position).toBe(0);
  });
});

describe("a movie's Download in its details", () => {
  const ref = { kind: "movie", subscriptionId: SUBSCRIPTION, id: "m1" } as const;

  it("queues the exact version and follows it to Watch offline", async () => {
    ipc.always("downloads.list", list([]));
    ipc.always("downloads.add", download({ status: { kind: "queued" } }));
    const details = await show(createElement(MovieDownload, { title: ref }), "button");
    await click(button(details, "Download"));
    expect(ipc.argsOf("downloads.add")).toEqual([{ title: ref }]);
    const running = download({
      status: { kind: "transferring", received: 62, size: 100, rate: null, restarted: false },
    });
    await changed(
      list([running]),
      () => labelled(details, "Downloading 62%, cancel download") !== null,
    );
    expect(labelled(details, "Downloading 62%, cancel download")).not.toBeNull();
    const full = download({
      status: { kind: "failed", failure: { kind: "disk-full", needed: null } },
    });
    const retry = () =>
      [...details.querySelectorAll("button")].find((each) => each.textContent?.includes("Retry"));
    await changed(list([full]), () => retry() !== undefined);
    expect(retry()?.textContent).toContain("Disk full");
    await click(retry());
    expect(ipc.argsOf("downloads.retry")).toEqual([{ id: "d1" }]);
    await changed(list([download()]), () => button(details, "Watch offline") !== undefined);
    expect(button(details, "Watch offline")).toBeDefined();
  });

  it("is another version's own: a download of one version isn't shown for another", async () => {
    ipc.always("downloads.list", list([download({ title: { kind: "movie", id: "other" } })]));
    const details = await show(createElement(MovieDownload, { title: ref }), "button");
    expect(button(details, "Download")).toBeDefined();
  });
});

describe("the top bar's word on the downloads", () => {
  const transfer = (received: number, size: number | null) =>
    download({
      id: "running",
      status: { kind: "transferring", received, size, rate: null, restarted: false },
    });
  /** The bar's Downloads beside Search, which names how they stand while there is something to say. */
  const notice = (within: HTMLElement) =>
    within.querySelector<HTMLButtonElement>('header [aria-label^="Downloads, "]');

  it("follows the one transfer, then what waits, and says nothing of copies", async () => {
    useUi.setState({ view: "movies" });
    const read = ipc.hold("downloads.list");
    const bar = await show(createElement(WindowBar), "header");
    // Nothing until main's list is read.
    expect(notice(bar)).toBeNull();
    await act(async () => {
      read.resolve(list([download(), download({ id: "gone", status: { kind: "missing" } })]));
      await settle();
    });
    expect(notice(bar)).toBeNull();

    const queued = download({ id: "next", status: { kind: "queued" } });
    const waiting = download({ id: "other", status: { kind: "waiting" } });
    // The transfer speaks before what waits or is queued, floored as its row is.
    await changed(list([queued, waiting, transfer(4_299, 10_000)]), () => notice(bar) !== null);
    expect(notice(bar)?.textContent).toBe("42%");
    expect(notice(bar)?.getAttribute("aria-label")).toBe("Downloads, 42%");
    await changed(
      list([queued, transfer(9_999, 10_000)]),
      () => notice(bar)?.textContent === "99%",
    );
    // Without a size, the bytes so far, and Starting before the first.
    await changed(list([transfer(0, null)]), () => notice(bar)?.textContent === "Starting");
    await changed(list([transfer(118_000_000, null)]), () => notice(bar)?.textContent === "118 MB");
    // Between transfers, what waits for playback comes before what is queued.
    await changed(list([queued, waiting]), () => notice(bar)?.textContent === "Waiting");
    await changed(list([queued]), () => notice(bar)?.textContent === "Queued");
    // A failure speaks once nothing else is left, while Retry can still reach its subscription.
    const failed = download({
      id: "full",
      status: { kind: "failed", failure: { kind: "disk-full", needed: null } },
    });
    await changed(
      list([failed, download()]),
      () => notice(bar)?.textContent === "Download stopped",
    );
    await changed(list([{ ...failed, subscription: null }]), () => notice(bar) === null);
    expect(notice(bar)).toBeNull();
    // Every change came as main's event: the list was read once.
    expect(ipc.argsOf("downloads.list")).toHaveLength(1);
  });

  it("leaves the Downloads page to say it while its name is in the bar", async () => {
    ipc.always("downloads.list", list([transfer(25, 100)]));
    useUi.setState({ view: "downloads" });
    const bar = await show(createElement(WindowBar), "header");
    await settle();
    expect(button(bar, "Downloads")?.getAttribute("aria-current")).toBe("page");
    expect(notice(bar)).toBeNull();
    // Settings over the page has Back in the bar instead of the pages.
    await act(async () => useUi.setState({ settings: "general" }));
    await until(() => notice(bar) !== null);
    expect(notice(bar)?.textContent).toBe("25%");
    await click(notice(bar));
    expect(useUi.getState()).toMatchObject({ view: "downloads", settings: null });
  });

  it("opens Downloads from Watch, whose Enter opens the channels everywhere else", async () => {
    ipc.always("downloads.list", list([transfer(40, 100)]));
    ipc.hold("playback.open");
    openWatch();
    player.play(channel);
    const watch = await show(createElement(WatchScreen), "header [data-downloads-notice]");
    const focused = notice(watch)!;
    focused.focus();
    expect(await key("Enter", focused)).toBe(false);
    expect(await key(" ", focused)).toBe(false);
    expect(useUi.getState().channelsOpen).toBe(false);
    await click(focused);
    expect(useUi.getState()).toMatchObject({ view: "downloads", watching: false });

    await act(async () => openWatch());
    expect(await key("Enter")).toBe(true);
    expect(useUi.getState().channelsOpen).toBe(true);
  });

  it("opens Downloads from a title playing, which leaves it as Back does", async () => {
    ipc.always("subscription.list", [SAVED]);
    ipc.always("downloads.list", list([download({ id: "copy" }), transfer(40, 100)]));
    const opened = ipc.hold("playback.openCopy");
    const app = await show(createElement(App), "header");
    await act(async () => {
      watchOffline(download({ id: "copy", progress: { position: 1200, duration: 6360 } }));
      opened.resolve({
        sessionId: "c1",
        copy: "copy",
        url: "http://127.0.0.1/title/c1.mp4",
        duration: 6360,
        audio: [],
        subtitles: [],
        progress: { position: 1200, duration: 6360 },
      });
      await settle();
    });
    const title = () => app.querySelector<HTMLElement>("[data-view=title]");
    await until(() => title() !== null && notice(title()!) !== null);
    expect(notice(title()!)?.textContent).toBe("40%");
    // Enter and Space with the notice in focus are its own, to press it; the title's keys stay
    // the title's everywhere else, and K with the notice in focus too.
    const focused = notice(title()!)!;
    focused.focus();
    expect(await key("Enter", focused)).toBe(false);
    expect(await key(" ", focused)).toBe(false);
    expect(await key("k", focused)).toBe(true);
    expect(await key(" ")).toBe(true);
    expect(title()).not.toBeNull();
    await click(focused);
    await until(() => app.querySelector("h1")?.textContent === "Downloads");
    expect(title()).toBeNull();
    expect(app.querySelector("h1")?.textContent).toBe("Downloads");
    // The copy closed as Back closes it, keeping where it got to.
    expect(ipc.argsOf("downloads.recordProgress")).toEqual([
      { id: "copy", position: 1195, duration: 6360 },
    ]);
  });

  /**
   * Lays the bar out `width` CSS px wide, as a browser would and happy-dom doesn't: the pages, or
   * Back in their place, get what the brand, Search, Settings, an update notice and the Downloads
   * button leave, each sized by what it reads, and ResizeObserver tells of it once `resize` says
   * the layout changed.
   */
  function layOut(width: number) {
    const observers = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe() {
          observers.add(this.callback);
        }
        unobserve() {}
        disconnect() {
          observers.delete(this.callback);
        }
      },
    );
    const wide = (text: string, padding: number) => padding + 7 * text.length;
    // The pages' place: the nav with their names, or the slot Back stands in.
    const place = (element: HTMLElement) => element.matches("header > :nth-child(2)");
    const room = (pages: HTMLElement) => {
      const header = pages.closest("header")!;
      const notice = header.querySelector("[data-downloads-notice]")?.textContent ?? null;
      const update = header.querySelector("[data-update-notice]");
      return (
        width -
        363 -
        (notice === null ? 0 : notice ? wide(notice, 51) : 32) -
        (update ? (update.textContent ? 88 : 32) : 0)
      );
    };
    const names = (pages: HTMLElement) =>
      [...pages.children].reduce((sum, each) => sum + wide(each.textContent ?? "", 24) + 4, -4);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return place(this) ? room(this) : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return place(this) ? Math.max(room(this), names(this)) : 0;
    });
    return {
      resize: (next = width) =>
        act(async () => {
          width = next;
          for (const observer of observers) observer([], {} as ResizeObserver);
          await settle();
        }),
    };
  }
  const pages = (bar: HTMLElement) =>
    [...bar.querySelectorAll("nav button")].map((each) => each.textContent);
  const failed = download({
    id: "full",
    status: { kind: "failed", failure: { kind: "disk-full", needed: null } },
  });

  describe("where the bar is narrow", () => {
    beforeEach(() => {
      ipc.always("subscription.list", [SAVED]);
      useUi.setState({ view: "movies" });
    });
    afterEach(() => {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    });

    it("gives the arrow its words back once they fit, with the window as wide as it was", async () => {
      const update: UpdateStatus = {
        version: "0.0.9",
        distribution: "direct",
        channel: "stable",
        update: { kind: "available", version: "0.0.10" },
        offer: null,
        checked: null,
        nextCheckAt: null,
        dismissed: null,
      };
      ipc.always("updates.status", update);
      ipc.always("updates.dismiss", { ...update, dismissed: "0.0.10" });
      ipc.always("downloads.list", list([failed]));
      const layout = layOut(900);
      const bar = await show(createElement(WindowBar), "header [data-downloads-notice]");
      await until(() => button(bar, "Update") !== undefined);
      await layout.resize();
      const updateTrigger = labelled(bar, "Update")!;
      expect(updateTrigger.textContent).toBe("");
      updateTrigger.focus();
      await layout.resize(1300);
      expect(labelled(bar, "Update")).toBe(updateTrigger);
      expect(updateTrigger.textContent).toBe("Update");
      expect(document.activeElement).toBe(updateTrigger);
      await layout.resize(900);
      expect(labelled(bar, "Update")).toBe(updateTrigger);
      expect(updateTrigger.textContent).toBe("");
      expect(document.activeElement).toBe(updateTrigger);
      // Beside Update, the five names leave the notice its arrow alone; it says the rest aloud.
      expect(notice(bar)?.textContent).toBe("");
      expect(notice(bar)?.getAttribute("aria-label")).toBe("Downloads, Download stopped");
      expect(pages(bar)).toEqual(["Home", "Live TV", "Movies", "Series", "Watchlist"]);

      // Not now takes Update away, and with it room enough for the words.
      await click(button(bar, "Update"));
      await click(button(document.body, "Not now"));
      await until(() => button(bar, "Update") === undefined);
      await layout.resize();
      expect(notice(bar)?.textContent).toBe("Download stopped");
      expect(pages(bar)).toEqual(["Home", "Live TV", "Movies", "Series", "Watchlist"]);

      // Shorter words fit where the longer didn't, though nothing resized: Retry's transfer.
      await layout.resize(820);
      expect(notice(bar)?.textContent).toBe("");
      await changed(list([transfer(40, 100)]), () => notice(bar)?.textContent === "40%");
      expect(pages(bar)).toEqual(["Home", "Live TV", "Movies", "Series", "Watchlist"]);
    });

    it("gives the arrow its words back when Settings' language pick shortens Back", async () => {
      const language = (locale: "en-US" | "nl-NL"): InterfaceLanguage => ({
        choice: locale,
        system: "en-US",
        locale,
        formats: locale,
      });
      ipc.always("downloads.list", list([transfer(40, 100)]));
      ipc.always("language.get", language("nl-NL"));
      ipc.always("language.set", language("en-US"));
      setLanguage(language("nl-NL"));
      useUi.setState({ settings: "general" });
      // Back has room beside the percentage at this width; the longer Terug doesn't.
      layOut(490);
      function Localized() {
        useLocale();
        return createElement(SettingsPage);
      }
      try {
        const settings = await show(createElement(Localized), "header [data-downloads-notice]");
        const said = () => settings.querySelector("header [data-downloads-notice]")?.textContent;
        await until(() => said() === "");
        expect(said()).toBe("");
        expect(button(settings, "Terug")).toBeDefined();

        const picker = () =>
          settings.querySelector<HTMLSelectElement>('select[aria-label="Taal van de interface"]');
        await until(() => picker()?.value === "nl-NL");
        await act(async () => {
          picker()!.value = "en-US";
          picker()!.dispatchEvent(new Event("change", { bubbles: true }));
          await settle();
        });
        expect(ipc.argsOf("language.set")).toEqual([{ choice: "en-US" }]);
        await until(() => said() === "40%");
        expect(button(settings, "Back")).toBeDefined();
        expect(said()).toBe("40%");
      } finally {
        setLanguage(language("en-US"));
      }
    });

    it("keeps the notice in focus as its words go and come back", async () => {
      ipc.always("downloads.list", list([download({ id: "next", status: { kind: "queued" } })]));
      const layout = layOut(820);
      const bar = await show(createElement(WindowBar), "header [data-downloads-notice]");
      await layout.resize();
      expect(notice(bar)?.textContent).toBe("Queued");
      const focused = notice(bar)!;
      focused.focus();

      // Longer words fold it to its arrow; shorter ones, or more room, give them back.
      await changed(
        list([failed]),
        () => notice(bar)?.getAttribute("aria-label") === "Downloads, Download stopped",
      );
      await layout.resize();
      expect(notice(bar)?.textContent).toBe("");
      await changed(
        list([download({ id: "next", status: { kind: "queued" } })]),
        () => notice(bar)?.textContent === "Queued",
      );
      await layout.resize(700);
      expect(notice(bar)?.textContent).toBe("");
      await layout.resize(820);
      expect(notice(bar)?.textContent).toBe("Queued");
      // The same button all along, still in focus and pressed as itself.
      expect(notice(bar)).toBe(focused);
      expect(document.activeElement).toBe(focused);
      await click(focused);
      expect(useUi.getState().view).toBe("downloads");
    });
  });
});
