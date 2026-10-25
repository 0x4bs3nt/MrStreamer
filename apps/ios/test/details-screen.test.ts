import * as React from "react";
import type { Download } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { byIds, indexCatalogue, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { Window } from "happy-dom";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// A film's details while the providers listing it change: a version picked from a provider that
// is removed meanwhile gives way to one still listed. And its download: the button queues the
// version shown, a copy offers Play offline from its menu, and Play keeps streaming. The real
// screen runs with React DOM on a happy-dom window, as provider-form.test.ts does; React Native's
// views stand in as plain elements, menus answer as the test picks, Play records the version it
// plays and the downloads owner records what it was asked. The version picked is kept by the
// app's own state owner (storage.ts) over real files (`native-files.ts`).

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  lists: { kind: "idle" } as { kind: "idle" } | { kind: "ready"; index: unknown },
  members: [] as Array<{ entry: { id: string }; label: string; needsSecret?: boolean }>,
  /** The version menu last shown: its options, and what picking one does. */
  menu: null as { options: readonly string[]; pick: (index: number) => void } | null,
  played: [] as OwnedId[],
  /** How far each version got, as the viewing record answers. */
  progress: [] as TitleProgress[],
  /** The film's download as the owner has it, and what it was asked to do. */
  download: undefined as Download | undefined,
  asked: [] as string[],
  /**
   * How each read of the film's details answers, given the version read and what shows facts
   * known before the answer; by default, never.
   */
  details: (_version: string, _show: (facts: unknown) => void): Promise<unknown> =>
    new Promise(() => undefined),
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({
      children,
      testID,
      disabled,
      onPress,
    }: Props & { disabled?: boolean; onPress: () => void }) =>
      createElement("button", { "data-testid": testID, disabled, onClick: onPress }, children),
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {} },
    Alert: { alert: () => undefined },
    ActionSheetIOS: {
      showActionSheetWithOptions: (
        { options }: { options: readonly string[] },
        pick: (index: number) => void,
      ) => {
        scenario.menu = { options, pick };
      },
    },
  };
});
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
}));
vi.mock("../src/viewing.ts", () => ({
  useViewing: () => null,
  progressOf: async () => scenario.progress,
  markEpisode: async () => null,
  relist: async () => undefined,
  seriesViewing: async () => ({ progress: [], marks: [] }),
  undoMark: async () => undefined,
}));
vi.mock("../src/downloads.ts", () => ({
  useDownloadOf: () => scenario.download,
  downloadList: () => ({
    items: scenario.download ? [scenario.download] : [],
    series: {},
    bytes: 0,
    free: null,
    ended: 0,
  }),
  addDownload: async (ref: TitleRef) => {
    scenario.asked.push(`add ${ref.subscriptionId}:${ref.id}`);
  },
  playDownload: (id: string) => scenario.asked.push(`play ${id}`),
  removeDownload: async (id: string) => {
    scenario.asked.push(`remove ${id}`);
  },
  retryDownload: async (id: string) => {
    scenario.asked.push(`retry ${id}`);
  },
}));
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
