import { createRoot, document, Event } from "./dom.ts";
import { nativePlayer } from "./native-player.ts";
import * as React from "react";
import type { Episode, SeriesDetails } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import type { SeriesViewing, TitleProgress } from "@mrstreamer/contracts/viewing";
import { byIds, indexCatalogue, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { afterEach, describe, expect, it, vi } from "vitest";

// Resume pressed in a title's details waits for the saves before it and for the record's answer.
// Meanwhile the viewer may choose another version, or the screen may show another or go: the
// version pressed then plays no more, and nothing else plays in its place. The real details
// screen, play-title and playback run with React DOM on a happy-dom window, as
// details-screen.test.ts does; the record's reads answer when the test says, the provider's file
// records which version opened, and the native player is a stand-in. Nothing here proves
// AVPlayer or an iPhone.

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

const scenario = vi.hoisted(() => ({
  lists: { kind: "idle" } as { kind: "idle" } | { kind: "ready"; index: unknown },
  members: [] as Array<{ entry: { id: string }; label: string; needsSecret?: boolean }>,
  /** The version menu last shown: its options, and what picking one does. */
  menu: null as { options: readonly string[]; pick: (index: number) => void } | null,
  /** Each file the provider was asked for, by kind, subscription and id. */
  opened: [] as string[],
  /** Set, the next read of how far titles got, or of a series' episodes, answers with it. */
  next: {
    progress: null as Promise<readonly TitleProgress[]> | null,
    standing: null as Promise<SeriesViewing> | null,
  },
  details: (_version: OwnedId): Promise<unknown> => new Promise(() => undefined),
  download: undefined,
}));

vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { options }: { options: readonly string[] },
      pick: (index: number) => void,
    ) => {
      scenario.menu = { options, pick };
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
  detailsOf: (title: OwnedId) => scenario.details(title),
  titleFile: async (ref: { kind: string; subscriptionId: string; id: string }) => {
    scenario.opened.push(`${ref.kind} ${ref.subscriptionId}:${ref.id}`);
    return { url: `file:${ref.subscriptionId}:${ref.id}`, container: "mp4" };
  },
  useCollections: () => null,
  episodesOf: async (_title: unknown, season: { episodes: readonly Episode[] }) => season.episodes,
}));
vi.mock("../src/viewing.ts", () => ({
  useViewing: () => null,
  progressOf: async () => {
    const held = scenario.next.progress;
    scenario.next.progress = null;
    return held ?? [];
  },
  seriesViewing: async () => {
    const held = scenario.next.standing;
    scenario.next.standing = null;
    return held ?? { progress: [], marks: [], undoable: null };
  },
  recordProgress: async () => undefined,
  finishSeries: async () => undefined,
  markEpisode: async () => null,
  relist: async () => undefined,
  undoMark: async () => undefined,
}));
vi.mock("../src/downloads.ts", () => ({
  useDownloadOf: () => undefined,
  useDownloads: () => undefined,
  downloadOf: () => undefined,
  downloadList: () => ({ items: [], bytes: 0, free: null, ended: 0 }),
  addDownload: async () => undefined,
  playDownload: () => undefined,
  removeDownload: async () => undefined,
  retryDownload: async () => undefined,
}));
vi.mock("../src/watchlist.ts", () => ({
  useWatchlist: () => [],
  savedEntry: () => undefined,
  saveTitle: () => undefined,
  removeTitle: () => undefined,
}));
vi.mock("../src/sources.ts", () => ({
  loginOf: () => [],
  currentSource: () => undefined,
  onSignedIn: () => () => {},
}));
vi.mock("../src/header.tsx", () => ({ useTabs: () => null, openOnTabs: () => undefined }));
const native = vi.hoisted(() => ({ player: null as ReturnType<typeof nativePlayer> | null }));
vi.mock("expo-video", () => ({
  createVideoPlayer: () => {
    const port = nativePlayer();
    port.currentTime = 120;
    native.player = port;
    return port;
  },
}));

const playback = await import("../src/playback.ts");
const { DetailsScreen } = await import("../src/details-screen.tsx");
const storage = await import("../src/storage.ts");

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

/** Providers a and b, each listing the film and the series; the series' details answer. */
function providers() {
  const index = indexCatalogue(
    ["a", "b"].map((subscriptionId) => ({ subscriptionId, catalogue })),
    "en",
  );
  scenario.lists = { kind: "ready", index };
  scenario.members = ["a", "b"].map((id) => ({ entry: { id }, label: LABELS[id] ?? id }));
  scenario.details = async (version) => {
    const title = byIds(index, "series", [version])[0];
    if (!title) return new Promise(() => undefined);
    const episode: Episode = {
      subscriptionId: version.subscriptionId,
      id: "e1",
      seriesId: version.id,
      season: 1,
      number: 1,
      title: "Pilot",
      plot: null,
      duration: 600,
      stillUrl: null,
      airDate: null,
    };
    const facts: SeriesDetails = {
      kind: "series",
      title,
      originalTitle: null,
      plot: null,
      genres: [],
      cast: [],
      directors: [],
      releaseDate: null,
      duration: 600,
      backdropUrl: null,
      seasons: [{ number: 1, name: "Season 1", posterUrl: null, episodes: [episode] }],
    };
    return facts;
  };
}

/** Until what was answered, and what follows from it, has drawn. */
async function settled() {
  for (let at = 0; at < 8; at++) await React.act(async () => await Promise.resolve());
}

let unmount = () => {};
afterEach(async () => {
  unmount();
  unmount = () => {};
  scenario.menu = null;
  scenario.opened.length = 0;
  scenario.next = { progress: null, standing: null };
  await playback.stop();
  storage.writeState(() => ({ subscription: null, recent: [], region: null }));
});

/** The `kind`'s details as provider a's version opens them. */
async function mount(kind: "movie" | "series" = "movie") {
  providers();
  const container = document.createElement("div");
  const root = createRoot(container);
  /** Draws the screen again, for `version` when given, `asked` for as another opener would. */
  const render = (version = `a:${kind === "movie" ? 1 : 2}`, asked = false) =>
    React.act(() => root.render(React.createElement(DetailsScreen, { kind, version, asked })));
  render();
  unmount = () => React.act(() => root.unmount());
  await settled();
  const press = (testID: string) =>
    React.act(() =>
      container
        .querySelector(`[data-testid="${testID}"]`)!
        .dispatchEvent(new Event("click", { bubbles: true })),
    );
  return {
    render,
    press,
    text: () => container.textContent ?? "",
    /** Opens the version menu and picks the option starting with `label`. */
    choose(label: string) {
      press("details-version");
      const menu = scenario.menu;
      if (!menu) throw new Error("No version menu");
      React.act(() => menu.pick(menu.options.findIndex((each) => each.startsWith(label))));
    },
  };
}

/** The next read of how far films got waits; answers it with nothing played. */
function holdProgress() {
  const held = deferred<readonly TitleProgress[]>();
  scenario.next.progress = held.promise;
  return () => held.resolve([]);
}

/** The next read of how a series' episodes stand waits; answers it with nothing played. */
function holdStanding() {
  const held = deferred<SeriesViewing>();
  scenario.next.standing = held.promise;
  return () => held.resolve({ progress: [], marks: [], undoable: null });
}

/** Something played earlier and closed, its save still going; answers the save. */
async function closedWithSaveGoing() {
  const save = deferred<void>();
  const item = {
    id: "old",
    subscriptionId: "a",
    title: "Earlier",
    place: "",
    live: false,
    next: false,
    versions: false,
  };
  await playback.play(
    item,
    {
      kind: "file",
      originalLanguage: null,
      open: async () => ({ url: "file:old", container: "mp4" }),
    },
    {
      watch: true,
      login: [],
      progress: () => save.promise,
    },
  );
  native.player?.state(true);
  void playback.closeWatch();
  native.player?.state(false);
  return () => save.resolve();
}

describe("a film's Resume, then another version", () => {
  it("plays nothing when another version is chosen while the record answers; that one's Resume plays it", async () => {
    const page = await mount();
    const answer = holdProgress();
    page.press("details-play");
    await settled();
    page.choose("Cabin");
    expect(page.text()).toContain("Cabin");
    answer();
    await settled();
    expect(scenario.opened).toEqual([]);
    page.press("details-play");
    await settled();
    expect(scenario.opened).toEqual(["movie b:1"]);
  });

  it("plays nothing when another version is chosen while Close's save is still going", async () => {
    const page = await mount();
    const saved = await closedWithSaveGoing();
    page.press("details-play");
    await settled();
    page.choose("Cabin");
    saved();
    await settled();
    expect(scenario.opened).toEqual([]);
  });

  it("plays nothing once Automatic is chosen, even when it shows the same version", async () => {
    const page = await mount();
    const answer = holdProgress();
    page.press("details-play");
    await settled();
    page.choose("Automatic");
    answer();
    await settled();
    expect(scenario.opened).toEqual([]);
  });

  it("plays the version pressed when the menu is cancelled or the screen only draws again", async () => {
    const page = await mount();
    const answer = holdProgress();
    page.press("details-play");
    await settled();
    page.choose("Cancel");
    page.render();
    answer();
    await settled();
    expect(scenario.opened).toEqual(["movie a:1"]);
  });

  it("plays nothing when the same screen is opened again for another version", async () => {
    const page = await mount();
    const answer = holdProgress();
    page.press("details-play");
    await settled();
    page.render("b:1", true);
    expect(page.text()).toContain("Cabin");
    answer();
    await settled();
    expect(scenario.opened).toEqual([]);
  });

  it("plays nothing once the details are gone", async () => {
    const page = await mount();
    const answer = holdProgress();
    page.press("details-play");
    await settled();
    unmount();
    unmount = () => {};
    answer();
    await settled();
    expect(scenario.opened).toEqual([]);
    expect(page.text()).toBe("");
  });
});

describe("a series' Play or an episode, then another version", () => {
  it("plays no episode of the version pressed once another is chosen", async () => {
    for (const pressed of ["details-play", "episode-e1"]) {
      const page = await mount("series");
      const answer = holdStanding();
      page.press(pressed);
      await settled();
      page.choose("Cabin");
      answer();
      await settled();
      expect(scenario.opened).toEqual([]);
      unmount();
      unmount = () => {};
      storage.writeState(() => ({ subscription: null, recent: [], region: null }));
    }
  });

  it("plays the episode pressed when nothing else was chosen", async () => {
    const page = await mount("series");
    const answer = holdStanding();
    page.press("episode-e1");
    await settled();
    answer();
    await settled();
    expect(scenario.opened).toEqual(["episode a:e1"]);
  });
});
