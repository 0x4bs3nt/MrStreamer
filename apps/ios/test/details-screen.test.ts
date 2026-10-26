import { createRoot, document, Event } from "./dom.ts";
import * as React from "react";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { byIds, indexCatalogue, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A film's details while the providers listing it change: a version picked from a provider that
// is removed meanwhile gives way to one still listed. And its download: the button queues the
// version shown, a copy offers Play offline from its menu, and Play keeps streaming. A series'
// season and whole-series downloads queue the version shown, one episode at a time, through the
// real series-download.ts over the recorded downloads owner and signed-in logins. The real
// screen runs with React DOM on a happy-dom window, as provider-form.test.ts does; React Native's
// views stand in as plain elements, menus answer as the test picks, Play records the version it
// plays and the downloads owner records what it was asked. The version picked is kept by the
// app's own state owner (storage.ts) over real files (`native-files.ts`).

const scenario = vi.hoisted(() => ({
  lists: { kind: "idle" } as { kind: "idle" } | { kind: "ready"; index: unknown },
  members: [] as Array<{ entry: { id: string }; label: string; needsSecret?: boolean }>,
  /** The system sheet last shown: its words, options, and what picking one does. */
  menu: null as {
    title: string | undefined;
    message: string | undefined;
    options: readonly string[];
    pick: (index: number) => void;
  } | null,
  /** Alerts shown, newest last, with their buttons. */
  alerts: [] as {
    title: string;
    message: string | undefined;
    buttons: readonly { text: string; onPress?: () => void }[];
  }[],
  played: [] as OwnedId[],
  /** How far each version got, as the viewing record answers. */
  progress: [] as TitleProgress[],
  /** The film's download as the owner has it, and what it was asked to do. */
  download: undefined as Download | undefined,
  asked: [] as string[],
  /** Episodes' downloads, by "subscription:id", and who hears them change. */
  episodes: new Map<string, Download>(),
  heard: new Set<() => void>(),
  /** What an episode's addition waits for, or how it fails, before it is queued. */
  adding: (_ref: TitleRef): Promise<void> | void => undefined,
  /** The signed-in login of each provider, as sources.ts holds it. */
  sources: new Map<string, object>([
    ["a", {}],
    ["b", {}],
  ]),
  /** Screens opened on a tab. */
  opened: [] as string[],
  /**
   * How each read of the film's details answers, given the version read and what shows facts
   * known before the answer; by default, never.
   */
  details: (_version: string, _show: (facts: unknown) => void): Promise<unknown> =>
    new Promise(() => undefined),
}));

vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  Alert: {
    alert: (
      title: string,
      message?: string,
      buttons: readonly { text: string; onPress?: () => void }[] = [],
    ) => scenario.alerts.push({ title, message, buttons }),
  },
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { title, message, options }: { title?: string; message?: string; options: string[] },
      pick: (index: number) => void,
    ) => {
      scenario.menu = { title, message, options, pick };
    },
  },
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#8E8E93" },
    Message: ({ text, action }: { text: string; action?: { label: string; onPress(): void } }) =>
      createElement(
        "p",
        null,
        text,
        action
          ? createElement(
              "button",
              { "data-testid": action.label, onClick: action.onPress },
              action.label,
            )
          : null,
      ),
  };
});
vi.mock("../src/loading.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Docked: pass,
    Placeholders: pass,
    Shape: () => null,
    PlaceholderLines: () => createElement("div", { "data-testid": "placeholder-lines" }),
    loadingStatus: (what: string) => ({ text: `Loading ${what}.` }),
  };
});
vi.mock("../src/titles-ui.tsx", () => ({
  Artwork: () => null,
  ProgressLine: () => null,
  Shelf: () => null,
  TextTabs: () => null,
}));
vi.mock("../src/account.ts", () => ({
  members: () => scenario.members,
  retryTitles: () => undefined,
  useRoster: () => ({ kind: "ready", members: scenario.members }),
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: () => undefined,
  versionOf: (key: string) => {
    const at = key.indexOf(":");
    return { subscriptionId: key.slice(0, at), id: key.slice(at + 1) };
  },
}));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  useMetadataVersion: () => 0,
  titleOf: (index: IndexedCatalogue, kind: "movie" | "series", version: OwnedId) =>
    byIds(index, kind, [version])[0],
  detailsOf: (title: OwnedId, show: (facts: unknown) => void) =>
    scenario.details(`${title.subscriptionId}:${title.id}`, show),
  useCollections: () => null,
  episodesOf: async () => [],
}));
vi.mock("../src/play-title.ts", () => ({
  failureOf: () => undefined,
  useFailure: () => undefined,
  playMovie: (_title: unknown, version: OwnedId) => scenario.played.push(version),
  playEpisode: () => undefined,
  resumeMovie: (_title: unknown, version: OwnedId) => scenario.played.push(version),
  resumeEpisode: () => undefined,
  resumeSeries: () => undefined,
}));
// A version chosen asks playback to retire a Resume still waiting; details-resume.test.ts runs
// that with the real owners.
vi.mock("../src/playback.ts", () => ({ request: () => ({ stands: () => true }) }));
vi.mock("../src/viewing.ts", () => ({
  useViewing: () => null,
  progressOf: async () => scenario.progress,
  markEpisode: async () => null,
  relist: async () => undefined,
  seriesViewing: async () => ({ progress: [], marks: [] }),
  undoMark: async () => undefined,
}));
vi.mock("../src/sources.ts", () => ({
  currentSource: (id: string) => scenario.sources.get(id),
}));
vi.mock("../src/header.tsx", () => ({
  useTabs: () => ({ tab: "series", above: 0 }),
  openOnTabs: ({ tab }: { tab: string }, screen: string) =>
    scenario.opened.push(`${tab}/${screen}`),
}));
vi.mock("../src/downloads.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  const keyOf = (ref: TitleRef) => `${ref.subscriptionId}:${ref.id}`;
  const downloadOf = (ref: TitleRef) => scenario.episodes.get(keyOf(ref)) ?? scenario.download;
  const subscribe = (listener: () => void) => {
    scenario.heard.add(listener);
    return () => scenario.heard.delete(listener);
  };
  let version = 0;
  /** Queues an episode as the owner would, telling the screens. */
  const queued = (ref: TitleRef) => {
    if (ref.kind !== "episode") return;
    scenario.episodes.set(keyOf(ref), episodeDownload(ref, "queued"));
    version++;
    for (const listener of scenario.heard) listener();
  };
  return {
    useDownloadOf: (ref: TitleRef) => {
      useSyncExternalStore(subscribe, () => version);
      return downloadOf(ref);
    },
    useDownloads: () => useSyncExternalStore(subscribe, () => version),
    downloadOf,
    downloadList: () => ({
      items: [...scenario.episodes.values(), ...(scenario.download ? [scenario.download] : [])],
      series: {},
      bytes: 0,
      free: null,
      ended: 0,
    }),
    addDownload: async (ref: TitleRef) => {
      scenario.asked.push(`add ${keyOf(ref)}`);
      await scenario.adding(ref);
      queued(ref);
    },
    replaceMissingDownload: async (ref: TitleRef) => {
      scenario.asked.push(`replace ${keyOf(ref)}`);
      queued(ref);
      return { kind: "replaced", download: downloadOf(ref) };
    },
    playDownload: (id: string) => scenario.asked.push(`play ${id}`),
    removeDownload: async (id: string) => {
      scenario.asked.push(`remove ${id}`);
    },
    retryDownload: async (id: string) => {
      scenario.asked.push(`retry ${id}`);
      const found = [...scenario.episodes.values()].find((each) => each.id === id);
      if (found?.title.kind !== "episode") return "unchanged";
      queued({ ...found.title, subscriptionId: found.subscription!.id });
      return "queued";
    },
  };
});
/** An episode's download in `kind`, as the owner lists it. */
function episodeDownload(
  ref: TitleRef,
  kind: "queued" | "complete" | "missing" | "failed",
): Download {
  if (ref.kind !== "episode") throw new Error("Not an episode");
  const { subscriptionId, ...title } = ref;
  return {
    id: `d-${subscriptionId}-${ref.id}`,
    title,
    subscription: { id: subscriptionId, name: subscriptionId },
    name: "Same series (EN)",
    episodeName: null,
    year: null,
    duration: null,
    originalLanguage: null,
    posterUrl: null,
    wideUrl: null,
    size: null,
    status:
      kind === "failed"
        ? { kind, failure: { kind: "app", error: { kind: "unexpected", detail: "Stopped." } } }
        : { kind },
    progress: null,
    series: null,
  };
}
vi.mock("../src/watchlist.ts", () => ({
  useWatchlist: () => [],
  savedEntry: () => undefined,
  saveTitle: () => undefined,
  removeTitle: () => undefined,
}));

const { DetailsScreen } = await import("../src/details-screen.tsx");
const storage = await import("../src/storage.ts");
const { native } = await import("./native-files.ts");

/** What draws the screen: as the test file imported it, or as a relaunch imports it again. */
interface App {
  readonly React: typeof React;
  readonly createRoot: typeof createRoot;
  readonly DetailsScreen: typeof DetailsScreen;
}
const launched: App = { React, createRoot, DetailsScreen };

/** The app's modules as a relaunch starts them, over the same files, with state.json read. */
const REACT_DOM = "react-dom/client";
async function relaunch(): Promise<App> {
  vi.resetModules();
  const fresh = (await import(REACT_DOM)) as { createRoot: typeof createRoot };
  const app = {
    React: await import("react"),
    createRoot: fresh.createRoot,
    DetailsScreen: (await import("../src/details-screen.tsx")).DetailsScreen,
  };
  (await import("../src/storage.ts")).readState();
  return app;
}

/** One film and one series, which both providers list under the same ids and TMDB ids. */
const catalogue: OnDemandCatalogue = {
  movieCategories: [],
  seriesCategories: [],
  series: [
    {
      id: "2",
      name: "Same series (EN)",
      tmdbId: "200001",
      container: null,
      categoryIds: [],
      posterUrl: null,
      backdropUrl: null,
      releaseDate: null,
      rating: null,
      addedAt: 1,
      adult: false,
    },
  ],
  movies: [
    {
      id: "1",
      name: "Same movie (EN)",
      tmdbId: "100001",
      container: "mp4",
      categoryIds: [],
      posterUrl: null,
      backdropUrl: null,
      releaseDate: null,
      rating: null,
      addedAt: 1,
      adult: false,
    },
  ],
};
const LABELS: Record<string, string> = { a: "Home", b: "Cabin" };

/** The providers saved now, each listing the film. */
function providers(...ids: string[]) {
  scenario.lists = {
    kind: "ready",
    index: indexCatalogue(
      ids.map((subscriptionId) => ({ subscriptionId, catalogue })),
      "en",
    ),
  };
  scenario.members = ids.map((id) => ({ entry: { id }, label: LABELS[id] ?? id }));
}

/** Until the progress read for the screen has answered. */
async function settled() {
  for (let at = 0; at < 5; at++) await React.act(async () => await Promise.resolve());
}

/** The providers whose password the Keychain no longer gives back, their lists still showing. */
function lost(...ids: string[]) {
  scenario.members = scenario.members.map((member) => ({
    ...member,
    needsSecret: ids.includes(member.entry.id),
  }));
}

let unmount = () => {};
afterEach(() => {
  unmount();
  scenario.menu = null;
  scenario.alerts.length = 0;
  scenario.episodes.clear();
  scenario.adding = () => undefined;
  scenario.sources = new Map([
    ["a", {}],
    ["b", {}],
  ]);
  scenario.opened.length = 0;
  scenario.played.length = 0;
  scenario.download = undefined;
  scenario.asked.length = 0;
  scenario.details = () => new Promise(() => undefined);
  scenario.progress = [];
  storage.writeState(() => ({ subscription: null, recent: [], region: null }));
});

/** A film's facts as the details owner answers them, with `plot`. */
const factsOf = (plot: string) => ({
  kind: "movie",
  plot,
  directors: [],
  cast: [],
  genres: [],
  duration: null,
  backdropUrl: null,
});

/** The `kind`'s details as `version` opens them, `asked` for or not, drawn by `app`. */
function mount({
  version = "a:1",
  asked = false,
  app = launched,
  kind = "movie" as "movie" | "series",
} = {}) {
  const { React, createRoot, DetailsScreen } = app;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = () =>
    React.act(() => root.render(React.createElement(DetailsScreen, { kind, version, asked })));
  render();
  unmount = () => React.act(() => root.unmount());
  const press = (testID: string) =>
    React.act(() =>
      container
        .querySelector(`[data-testid="${testID}"]`)!
        .dispatchEvent(new Event("click", { bubbles: true })),
    );
  return {
    /** The screen again, as a change of the lists draws it. */
    render,
    press,
    text: () => container.textContent ?? "",
    has: (testID: string) => container.querySelector(`[data-testid="${testID}"]`) !== null,
    /** Plays, and answers whose version played. */
    play() {
      press("details-play");
      return scenario.played.at(-1)?.subscriptionId;
    },
    openVersions() {
      press("details-version");
      const menu = scenario.menu;
      if (!menu) throw new Error("No version menu");
      return (label: string) =>
        React.act(() => menu.pick(menu.options.findIndex((each) => each.startsWith(label))));
    },
  };
}

describe("a film's version", () => {
  it("plays from a provider still saved once the one picked is removed, and the pick once it is back", () => {
    providers("a", "b");
    const page = mount();
    expect(page.play()).toBe("a");
    page.openVersions()("Cabin");
    expect(page.play()).toBe("b");

    providers("a");
    page.render();
    expect(page.play()).toBe("a");
    // Added again with its history, the pick it kept plays again.
    providers("a", "b");
    page.render();
    expect(page.play()).toBe("b");
  });

  it("ignores a pick from a menu shown before its provider was removed", () => {
    providers("a", "b");
    const page = mount();
    const pick = page.openVersions();
    providers("a");
    page.render();
    pick("Cabin");
    expect(page.play()).toBe("a");
  });

  it("keeps the pick saved when a menu shown before the lists changed offers a version they dropped", () => {
    providers("a", "b", "c");
    mount().openVersions()("Cabin");
    unmount();
    const page = mount();
    expect(page.play()).toBe("b");
    const pick = page.openVersions();
    // Provider c, still saved, no longer lists the film.
    providers("a", "b");
    scenario.members.push({ entry: { id: "c" }, label: "c" });
    page.render();
    pick("c");
    expect(page.play()).toBe("b");
    unmount();
    expect(mount().play()).toBe("b");
  });

  for (const answer of ["c", "Automatic"]) {
    it(`keeps the pick saved when ${answer} answers a menu whose title the lists dropped`, () => {
      providers("a", "b", "c");
      const page = mount();
      page.openVersions()("Cabin");
      const pick = page.openVersions();
      // Every provider is still saved; the lists no longer have the film, so its details go.
      scenario.lists = {
        kind: "ready",
        index: indexCatalogue(
          ["a", "b", "c"].map((subscriptionId) => ({
            subscriptionId,
            catalogue: { ...catalogue, movies: [] },
          })),
          "en",
        ),
      };
      page.render();
      expect(page.text()).toContain("The provider no longer lists this title.");
      pick(answer);
      providers("a", "b", "c");
      page.render();
      expect(page.play()).toBe("b");
      unmount();
      expect(mount().play()).toBe("b");
    });
  }

  it("keeps the pick saved on Automatic from a menu shown for a title the lists no longer have", () => {
    providers("a", "b");
    const page = mount();
    page.openVersions()("Cabin");
    const automatic = page.openVersions();
    // The lists now gather the film's versions under another TMDB id: another title.
    scenario.lists = {
      kind: "ready",
      index: indexCatalogue(
        ["a", "b"].map((subscriptionId) => ({
          subscriptionId,
          catalogue: {
            ...catalogue,
            movies: catalogue.movies.map((movie) => ({ ...movie, tmdbId: "100002" })),
          },
        })),
        "en",
      ),
    };
    page.render();
    automatic("Automatic");
    unmount();
    providers("a", "b");
    expect(mount().play()).toBe("b");
  });
});

/** The film of provider "a", downloaded. */
const copy: Download = {
  id: "d-1",
  title: { kind: "movie", id: "1" },
  subscription: { id: "a", name: "Home" },
  name: "Same movie (EN)",
  episodeName: null,
  year: null,
  duration: 6000,
  originalLanguage: null,
  posterUrl: null,
  wideUrl: null,
  size: 2_100_000_000,
  status: { kind: "complete" },
  progress: null,
  series: null,
};

describe("a film's version picked", () => {
  it("plays again when the film is opened again, and after a relaunch", async () => {
    providers("a", "b");
    const page = mount();
    page.openVersions()("Cabin");
    unmount();
    expect(mount().play()).toBe("b");
    unmount();

    const again = await relaunch();
    expect(mount({ app: again }).play()).toBe("b");
  });

  it("goes with Automatic, which plays the film's own choice from then on", () => {
    providers("a", "b");
    const page = mount();
    page.openVersions()("Cabin");
    expect(page.play()).toBe("b");
    page.openVersions()("Automatic");
    expect(page.play()).toBe("a");
    unmount();
    expect(mount().play()).toBe("a");
  });

  it("gives way to a version asked for, as a 4K tile asks, which doesn't replace it", () => {
    providers("a", "b");
    const page = mount();
    page.openVersions()("Cabin");
    unmount();

    const asked = mount({ asked: true });
    expect(asked.play()).toBe("a");
    // A choice from the menu goes over what was asked.
    asked.openVersions()("Cabin");
    expect(asked.play()).toBe("b");
    unmount();
    expect(mount({ asked: true }).play()).toBe("a");
    unmount();
    expect(mount().play()).toBe("b");
  });

  it("goes with the film's own choice on Automatic, over the version asked for", () => {
    providers("a", "b");
    const page = mount({ version: "b:1", asked: true });
    expect(page.play()).toBe("b");
    page.openVersions()("Automatic");
    expect(page.play()).toBe("a");
  });

  it("reads picks in a shape it doesn't know as none, keeping the rest of what was saved", async () => {
    providers("a", "b");
    const saved = { subscription: null, recent: [], region: "NL", titleVersions: { b: 7 } };
    writeFileSync(join(native.root, "documents", "state.json"), JSON.stringify(saved));
    const again = await relaunch();
    expect(mount({ app: again }).play()).toBe("a");
    expect((await import("../src/storage.ts")).readState()).toMatchObject({ region: "NL" });
  });

  it("plays the pick over another version a list names without asking for it", () => {
    providers("a", "b");
    expect(mount({ version: "b:1" }).play()).toBe("b");
    unmount();
    const page = mount();
    page.openVersions()("Home");
    unmount();
    expect(mount({ version: "b:1" }).play()).toBe("a");
  });
});

describe("a film's version picked from a provider that lost its password", () => {
  it("gives way to the version another provider opened, and comes back with the password", () => {
    providers("a", "b");
    const read: string[] = [];
    scenario.details = (version) => {
      read.push(version);
      return new Promise(() => undefined);
    };
    mount().openVersions()("Home");
    unmount();
    // Opened through Cabin, as the Watchlist opens a title Home lists too: the pick still wins.
    expect(mount({ version: "b:1" }).play()).toBe("a");
    unmount();

    lost("a");
    read.length = 0;
    const page = mount({ version: "b:1" });
    expect(page.play()).toBe("b");
    expect(read).toEqual(["b:1"]);
    // Its password back, the pick saved plays again, picked once only.
    lost();
    page.render();
    expect(page.play()).toBe("a");
  });

  it("goes with the version opened over progress on a provider that lost its password", async () => {
    providers("a", "b");
    const read: string[] = [];
    scenario.details = (version) => {
      read.push(version);
      return new Promise(() => undefined);
    };
    // Stopped partway in Cabin's version.
    const partway = { position: 600, duration: 6000, finished: false, at: 1, since: 1 };
    scenario.progress = [{ title: { kind: "movie", subscriptionId: "b", id: "1" }, ...partway }];
    const page = mount();
    await settled();
    expect(page.play()).toBe("b");

    // Cabin's password lost: Home's own version, opened as the watchlist opens it, plays.
    lost("b");
    page.render();
    await settled();
    expect(page.play()).toBe("a");
    expect(read.at(-1)).toBe("a:1");
    // Its password back, the progress decides again.
    lost();
    page.render();
    await settled();
    expect(page.play()).toBe("b");
    // Cabin remembered from the menu too: with its password lost, neither keeps it.
    page.openVersions()("Cabin");
    unmount();
    lost("b");
    const picked = mount();
    await settled();
    expect(picked.play()).toBe("a");
    unmount();

    // A series goes on where its last episode played, by the same rule.
    scenario.progress = [
      {
        title: {
          kind: "episode",
          subscriptionId: "b",
          id: "21",
          seriesId: "2",
          season: 1,
          episode: 1,
        },
        ...partway,
      },
    ];
    mount({ kind: "series", version: "a:2" });
    await settled();
    expect(read.at(-1)).toBe("a:2");
  });

  it("goes with Automatic to a provider that signs in when the film's own lost its password", async () => {
    providers("a", "b", "c");
    const read: string[] = [];
    scenario.details = (version) => {
      read.push(version);
      return new Promise(() => undefined);
    };
    // Home's version is the film's own; Home lost its password. Opened through Cabin, as the
    // watchlist opens it, then Automatic chosen.
    lost("a");
    const page = mount({ version: "b:1" });
    await settled();
    expect(page.play()).toBe("b");
    page.openVersions()("Automatic");
    await settled();
    expect(page.play()).toBe("b");
    expect(read.at(-1)).toBe("b:1");
    // Its password back, Automatic goes with the film's own again.
    lost();
    page.render();
    await settled();
    expect(page.play()).toBe("a");
    // Home chosen from the menu stays chosen with its password lost.
    page.openVersions()("Home");
    lost("a");
    page.render();
    await settled();
    expect(page.play()).toBe("a");
    unmount();

    // How far c's version got still goes first under Automatic.
    scenario.progress = [
      {
        title: { kind: "movie", subscriptionId: "c", id: "1" },
        ...{ position: 600, duration: 6000, finished: false, at: 1, since: 1 },
      },
    ];
    const resumed = mount({ version: "b:1" });
    resumed.openVersions()("Automatic");
    await settled();
    expect(resumed.play()).toBe("c");
  });

  it("goes with Automatic over progress on a provider that lost its password, and not a version chosen", async () => {
    providers("a", "b");
    const read: string[] = [];
    scenario.details = (version) => {
      read.push(version);
      return new Promise(() => undefined);
    };
    scenario.progress = [
      {
        title: { kind: "movie", subscriptionId: "b", id: "1" },
        ...{ position: 600, duration: 6000, finished: false, at: 1, since: 1 },
      },
    ];
    const page = mount();
    await settled();
    page.openVersions()("Automatic");
    expect(page.play()).toBe("b");

    // Cabin's password lost while Automatic stands: the film's own version.
    lost("b");
    page.render();
    await settled();
    expect(page.play()).toBe("a");
    expect(read.at(-1)).toBe("a:1");
    // Its password back, the progress decides again.
    lost();
    page.render();
    await settled();
    expect(page.play()).toBe("b");

    // Cabin chosen from the menu stays chosen, its password lost or not.
    page.openVersions()("Cabin");
    lost("b");
    page.render();
    await settled();
    expect(page.play()).toBe("b");
  });

  it("still plays a version asked for, as a 4K tile asks, from that provider", () => {
    providers("a", "b");
    mount().openVersions()("Cabin");
    unmount();
    lost("a");
    expect(mount({ version: "a:1", asked: true }).play()).toBe("a");
  });
});

describe("a film's download", () => {
  it("queues the version shown at once", async () => {
    providers("a", "b");
    const page = mount();
    page.openVersions()("Cabin");
    scenario.menu = null;
    page.press("details-download");
    await React.act(async () => undefined);
    expect(scenario.asked).toEqual(["add b:1"]);
    expect(scenario.menu).toBeNull();
  });

  it("offers a copy offline from its menu while Play keeps streaming", () => {
    providers("a");
    scenario.download = copy;
    const page = mount();
    expect(page.text()).toContain("Downloaded, 2.1 GB");
    expect(page.play()).toBe("a");
    expect(scenario.asked).toEqual([]);

    page.press("details-download");
    expect(scenario.menu?.options).toEqual(["Play offline", "Delete download", "Cancel"]);
    React.act(() => scenario.menu!.pick(0));
    expect(scenario.asked).toEqual(["play d-1"]);
  });

  it("asks before deleting a copy", async () => {
    providers("a");
    scenario.download = copy;
    const page = mount();
    page.press("details-download");
    React.act(() => scenario.menu!.pick(1));
    expect(scenario.asked).toEqual([]);
    expect(scenario.menu?.options).toEqual(["Delete download", "Cancel"]);
    React.act(() => scenario.menu!.pick(0));
    await React.act(async () => undefined);
    expect(scenario.asked).toEqual(["remove d-1"]);
  });
});

describe("a film's facts", () => {
  it("offer Try again when they couldn't be read, and show as loading until it answers", async () => {
    providers("a");
    let answer: (facts: unknown) => void = () => undefined;
    scenario.details = () => Promise.reject(new Error("The provider didn't answer"));
    const page = mount();
    await React.act(async () => undefined);
    expect(page.has("Try again")).toBe(true);
    // The title and Play stay while its facts failed.
    expect(page.has("details-play")).toBe(true);

    scenario.details = () => new Promise((resolve) => (answer = resolve));
    page.press("Try again");
    expect(page.has("Try again")).toBe(false);
    expect(page.has("placeholder-lines")).toBe(true);

    await React.act(async () =>
      answer({
        kind: "movie",
        plot: "A film that answered the second time.",
        directors: [],
        cast: [],
        genres: [],
        duration: null,
        backdropUrl: null,
      }),
    );
    expect(page.text()).toContain("A film that answered the second time.");
    expect(page.has("placeholder-lines")).toBe(false);
  });

  it("show saved facts while fresh ones are asked, then the fresh ones", async () => {
    providers("a");
    let answer: (facts: unknown) => void = () => undefined;
    scenario.details = (_version, show) => {
      show(factsOf("The story saved on the phone."));
      return new Promise((resolve) => (answer = resolve));
    };
    const page = mount();
    await React.act(async () => undefined);
    expect(page.text()).toContain("The story saved on the phone.");
    expect(page.has("placeholder-lines")).toBe(false);

    await React.act(async () => answer(factsOf("The provider's story now.")));
    expect(page.text()).toContain("The provider's story now.");
    expect(page.text()).not.toContain("The story saved on the phone.");
  });

  it("never show what a read of another version shows once that version is left", async () => {
    providers("a", "b");
    const shows = new Map<string, (facts: unknown) => void>();
    scenario.details = (version, show) => {
      shows.set(version, show);
      return new Promise(() => undefined);
    };
    const page = mount();
    await React.act(async () => undefined);
    page.openVersions()("Cabin");
    await React.act(async () => undefined);
    await React.act(async () => shows.get("a:1")?.(factsOf("Home's saved story.")));
    expect(page.text()).not.toContain("Home's saved story.");
    expect(page.has("placeholder-lines")).toBe(true);

    await React.act(async () => shows.get("b:1")?.(factsOf("Cabin's saved story.")));
    expect(page.text()).toContain("Cabin's saved story.");
  });
});

/** An episode of series 2 as `subscriptionId`'s details list it. */
const listed = (subscriptionId: string, id: string, season: number, number: number) => ({
  subscriptionId,
  id,
  seriesId: "2",
  season,
  number,
  title: `Episode ${id}`,
  plot: null,
  duration: null,
  stillUrl: null,
  airDate: null,
});

/**
 * Series 2's details from `subscriptionId`: Season 1, Specials, Season 2, in that order, with the
 * playlist's own order when `order` is given.
 */
function seriesFacts(subscriptionId: string, order?: readonly string[]) {
  const at = (id: string, season: number, number: number) =>
    listed(subscriptionId, id, season, number);
  return {
    kind: "series",
    plot: null,
    directors: [],
    cast: [],
    genres: [],
    duration: null,
    backdropUrl: null,
    title: {},
    seasons: [
      {
        number: 1,
        name: "Season 1",
        posterUrl: null,
        episodes: [at("101", 1, 1), at("102", 1, 2), at("103", 1, 3)],
      },
      { number: 0, name: "Specials", posterUrl: null, episodes: [at("900", 0, 1)] },
      {
        number: 2,
        name: "Season 2",
        posterUrl: null,
        episodes: [at("201", 2, 1), at("202", 2, 2)],
      },
    ],
    ...(order ? { episodeOrder: order } : {}),
  };
}

const episodeRef = (subscriptionId: string, id: string, season = 1, episode = 1): TitleRef => ({
  kind: "episode",
  subscriptionId,
  id,
  seriesId: "2",
  season,
  episode,
});
/** Gives `subscriptionId`'s episode `id` a download in `kind`. */
function has(
  subscriptionId: string,
  id: string,
  kind: "queued" | "complete" | "missing" | "failed",
) {
  scenario.episodes.set(
    `${subscriptionId}:${id}`,
    episodeDownload(episodeRef(subscriptionId, id), kind),
  );
}

/** Lets a run go through its episodes, each a turn of the timers apart. */
async function ran() {
  for (let at = 0; at < 12; at++) {
    await React.act(async () => await new Promise((done) => setTimeout(done, 0)));
  }
}

/** Series 2 as `version` opens it, its details answered by `facts` of the version read. */
async function mountSeries(
  version = "a:2",
  facts = (read: string) => seriesFacts(read.split(":")[0]!),
) {
  scenario.details = async (read) => facts(read);
  const page = mount({ kind: "series", version });
  await settled();
  return page;
}

/** Picks the sheet's option starting with `label`. */
function choose(label: string) {
  const menu = scenario.menu;
  if (!menu) throw new Error("No sheet");
  const at = menu.options.findIndex((each) => each.startsWith(label));
  if (at < 0) throw new Error(`No "${label}" in ${menu.options.join(", ")}`);
  React.act(() => menu.pick(at));
}

/** Presses the last alert's `label`. */
function answer(label: string) {
  const button = scenario.alerts.at(-1)?.buttons.find((each) => each.text === label);
  if (!button) throw new Error(`No "${label}" in the last alert`);
  React.act(() => button.onPress?.());
}

describe("a series' bulk download", () => {
  it("counts the season shown and queues its remaining episodes of the version shown", async () => {
    providers("a", "b");
    has("a", "101", "complete");
    has("a", "102", "queued");
    // The other provider's episode of the same id is its own download.
    has("b", "103", "complete");
    const page = await mountSeries();
    expect(page.text()).toContain("2 of 3 saved or queued");

    page.press("bulk-season-start");
    expect(scenario.menu).toMatchObject({
      title: "Download Season 1?",
      message:
        "3 episodes. 2 already saved or queued. Size unavailable. Uses the selected version.",
      options: ["Download 1 episode", "Cancel"],
    });
    choose("Download 1 episode");
    await ran();
    expect(scenario.asked).toEqual(["add a:103"]);
    expect(scenario.alerts.at(-1)).toMatchObject({ title: "Season 1", message: "1 queued." });
    expect(page.text()).toContain("3 of 3 saved or queued");
  });

  it("reviews the whole series in its own order, specials included, each exact file once", async () => {
    providers("a", "b");
    const order = ["201", "101", "900", "102", "202", "103"];
    const page = await mountSeries("a:2", (read) => {
      const facts = seriesFacts(read.split(":")[0]!, order);
      const [first, specials, second] = facts.seasons;
      // Details that list a file twice, or another provider's file, queue neither again.
      return {
        ...facts,
        seasons: [
          { ...first!, episodes: [...first!.episodes, listed("b", "104", 1, 4)] },
          specials!,
          { ...second!, episodes: [...second!.episodes, first!.episodes[0]!] },
        ],
      };
    });
    expect(page.text()).toContain("Whole series · 6 episodes");
    page.press("bulk-series-start");
    expect(scenario.menu).toMatchObject({
      title: "Download all of Same series?",
      message: "6 episodes in 3 seasons. Size unavailable. Uses the selected version.",
      options: ["Download 6 episodes", "Cancel"],
    });
    choose("Download 6 episodes");
    await ran();
    expect(scenario.asked).toEqual(order.map((id) => `add a:${id}`));
    expect(scenario.alerts.at(-1)?.message).toBe("6 queued.");
  });

  it("follows the season listing, specials where listed, without a playlist order", async () => {
    providers("a");
    const page = await mountSeries();
    page.press("bulk-series-start");
    choose("Download 6 episodes");
    await ran();
    expect(scenario.asked).toEqual(
      ["101", "102", "103", "900", "201", "202"].map((id) => `add a:${id}`),
    );
  });

  it("retries failed ones, replaces a missing copy only when asked, and skips what changed since", async () => {
    providers("a");
    has("a", "101", "failed");
    has("a", "102", "missing");
    const page = await mountSeries();
    page.press("bulk-season-start");
    expect(scenario.menu?.message).toBe(
      "3 episodes. 1 failed and will be retried. 1 saved file is missing. Size unavailable. Uses the selected version.",
    );
    expect(scenario.menu?.options).toEqual([
      "Download 2 episodes",
      "Download 2 and replace 1 missing",
      "Cancel",
    ]);
    choose("Download 2 episodes");
    await ran();
    expect(scenario.asked).toEqual(["retry d-a-101", "add a:103"]);

    // Asked again for the missing copy; meanwhile the viewer queued another episode by hand.
    scenario.asked.length = 0;
    has("a", "101", "failed");
    scenario.episodes.delete("a:103");
    page.press("bulk-season-start");
    has("a", "103", "queued");
    choose("Download 2 and replace 1 missing");
    await ran();
    expect(scenario.asked).toEqual(["retry d-a-101", "replace a:102"]);
    expect(scenario.alerts.at(-1)?.message).toBe(
      "1 retried. 1 replaced. 1 changed meanwhile and stayed as they were.",
    );
  });

  it("keeps what was queued when one fails, and Retry failed asks for that one alone", async () => {
    providers("a");
    let refused = true;
    scenario.adding = (ref) => {
      if (ref.id === "102" && refused) {
        refused = false;
        throw new Error("The provider didn't answer");
      }
    };
    const page = await mountSeries();
    page.press("bulk-season-start");
    choose("Download 3 episodes");
    await ran();
    expect(scenario.asked).toEqual(["add a:101", "add a:102", "add a:103"]);
    expect(scenario.alerts.at(-1)?.message).toMatch(/^2 queued\. 1 failed: /);
    expect(page.text()).toContain("2 of 3 saved or queued");

    scenario.asked.length = 0;
    answer("Retry failed");
    await ran();
    expect(scenario.asked).toEqual(["add a:102"]);
    expect(scenario.alerts.at(-1)?.message).toBe("1 queued.");
  });

  it("stops at Cancel remaining, the addition already asked settling", async () => {
    providers("a");
    const held = Promise.withResolvers<void>();
    scenario.adding = (ref) => (ref.id === "101" ? held.promise : undefined);
    const page = await mountSeries();
    page.press("bulk-season-start");
    choose("Download 3 episodes");
    await ran();
    expect(page.text()).toContain("Adding 1 of 3");
    page.press("bulk-season-cancel");
    await React.act(async () => held.resolve());
    await ran();
    expect(scenario.asked).toEqual(["add a:101"]);
    expect(scenario.episodes.get("a:101")?.status.kind).toBe("queued");
    expect(scenario.alerts.at(-1)?.message).toBe("1 queued. Cancelled before 2 episodes.");
    expect(page.text()).toContain("1 of 3 saved or queued");
  });

  it("runs once however often it is pressed and confirmed", async () => {
    providers("a");
    const held = Promise.withResolvers<void>();
    scenario.adding = (ref) => (ref.id === "101" ? held.promise : undefined);
    const page = await mountSeries();
    page.press("bulk-season-start");
    const first = scenario.menu!;
    page.press("bulk-season-start");
    const second = scenario.menu!;
    React.act(() => first.pick(0));
    React.act(() => first.pick(0));
    await ran();
    React.act(() => second.pick(0));
    expect(scenario.alerts.at(-1)?.message).toBe(
      "Episodes of another download are still being added.",
    );
    // The whole series waits while the season's run goes.
    page.press("bulk-series-start");
    expect(scenario.menu).toBe(second);
    await React.act(async () => held.resolve());
    await ran();
    expect(scenario.asked).toEqual(["add a:101", "add a:102", "add a:103"]);
  });

  it("does nothing for a sheet answered once another version shows", async () => {
    providers("a", "b");
    const page = await mountSeries();
    page.press("bulk-season-start");
    const sheet = scenario.menu!;
    page.openVersions()("Cabin");
    await settled();
    React.act(() => sheet.pick(0));
    await ran();
    expect(scenario.asked).toEqual([]);
    expect(scenario.alerts.at(-1)?.message).toBe("The version or its provider changed. Try again.");
  });

  for (const change of ["another version", "a new login", "the provider's removal", "leaving"]) {
    it(`stops before the next episode on ${change}`, async () => {
      providers("a", "b");
      const held = Promise.withResolvers<void>();
      scenario.adding = (ref) => (ref.id === "101" ? held.promise : undefined);
      const page = await mountSeries();
      page.press("bulk-season-start");
      choose("Download 3 episodes");
      await ran();
      if (change === "another version") {
        page.openVersions()("Cabin");
        await settled();
      } else if (change === "a new login") scenario.sources.set("a", {});
      else if (change === "the provider's removal") scenario.sources.delete("a");
      else unmount();
      await React.act(async () => held.resolve());
      await ran();
      expect(scenario.asked).toEqual(["add a:101"]);
      expect(scenario.episodes.get("a:101")?.status.kind).toBe("queued");
    });
  }

  for (const choice of ["Automatic", "Home"]) {
    it(`stops before the next episode once ${choice} is accepted, the same version still shown`, async () => {
      providers("a", "b");
      const held = Promise.withResolvers<void>();
      scenario.adding = (ref) => (ref.id === "101" ? held.promise : undefined);
      const page = await mountSeries();
      page.press("bulk-season-start");
      choose("Download 3 episodes");
      await ran();
      page.openVersions()(choice);
      await settled();
      await React.act(async () => held.resolve());
      await ran();
      expect(scenario.asked).toEqual(["add a:101"]);
      expect(scenario.alerts.at(-1)?.message).toBe(
        "1 queued. Stopped before 2 episodes: a version was chosen meanwhile.",
      );

      // Confirmed afresh, the rest goes.
      scenario.asked.length = 0;
      page.press("bulk-season-start");
      choose("Download 2 episodes");
      await ran();
      expect(scenario.asked).toEqual(["add a:102", "add a:103"]);
    });
  }

  it("does nothing for a sheet answered once the version shown was accepted again", async () => {
    providers("a", "b");
    const page = await mountSeries();
    page.press("bulk-season-start");
    const sheet = scenario.menu!;
    page.openVersions()("Home");
    await settled();
    React.act(() => sheet.pick(0));
    await ran();
    expect(scenario.asked).toEqual([]);
    expect(scenario.alerts.at(-1)?.message).toBe("The version or its provider changed. Try again.");
  });

  it("keeps going when the version menu is cancelled", async () => {
    providers("a", "b");
    const held = Promise.withResolvers<void>();
    scenario.adding = (ref) => (ref.id === "101" ? held.promise : undefined);
    const page = await mountSeries();
    page.press("bulk-season-start");
    choose("Download 3 episodes");
    await ran();
    page.openVersions()("Cancel");
    await settled();
    await React.act(async () => held.resolve());
    await ran();
    expect(scenario.asked).toEqual(["add a:101", "add a:102", "add a:103"]);
  });

  it("keeps going while the same version's details are drawn again", async () => {
    providers("a");
    const held = Promise.withResolvers<void>();
    scenario.adding = (ref) => (ref.id === "101" ? held.promise : undefined);
    const page = await mountSeries();
    page.press("bulk-season-start");
    choose("Download 3 episodes");
    await ran();
    // TMDB's metadata renames titles: the lists and the screen draw again.
    providers("a");
    page.render();
    await settled();
    await React.act(async () => held.resolve());
    await ran();
    expect(scenario.asked).toEqual(["add a:101", "add a:102", "add a:103"]);
  });

  it("asks nothing while the provider isn't signed in", async () => {
    providers("a");
    scenario.sources.delete("a");
    const page = await mountSeries();
    page.press("bulk-season-start");
    expect(scenario.menu).toBeNull();
    expect(scenario.alerts.at(-1)?.title).toBe("Couldn't download Season 1");
    expect(scenario.asked).toEqual([]);
  });

  it("opens Downloads on the series tab once everything is saved or queued", async () => {
    providers("a");
    for (const id of ["101", "102", "103"]) has("a", id, "complete");
    const page = await mountSeries();
    page.press("bulk-season-start");
    expect(scenario.menu).toBeNull();
    expect(scenario.alerts.at(-1)?.title).toBe("All 3 episodes are saved or queued.");
    answer("Open Downloads");
    expect(scenario.opened).toEqual(["series/downloads"]);
  });
});
