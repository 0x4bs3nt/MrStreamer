import { createRoot, document, type Root } from "./dom.ts";
import * as React from "react";
import { indexCatalogue, kindOf } from "@mrstreamer/core/ondemand/catalogue";
import type { LiveCatalogue, ProviderTitle, OnDemandCatalogue } from "@mrstreamer/core/provider";
import { buildLibrary } from "../src/library.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import type { Channel, Library } from "../src/library.ts";
import type { TitleLists } from "../src/titles.ts";

// What a screen shows while its lists load, update or fail: still shapes only where content is
// missing, the status line at the bottom with what loads or failed by provider, content that is
// already there kept and usable, and the shapes' highlight moving only while it may. Live, the
// Movies tab and a group of shapes run as they are, with React DOM on a happy-dom window, as
// search-screen.test.ts does; React Native's views stand in as plain elements, a view reports a
// width when it lays out, and Animated records the loops it is asked to run.

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  rosterChanged: () => undefined as void,
  fontScale: 1,
  catalogue: { kind: "loading" } as Catalogue,
  lists: { kind: "loading" } as TitleLists,
  /** Movies' collections once made; null until then. */
  made: null as object | null,
  focused: true,
  /** Whether Watch is open over the tabs. */
  watch: false,
  /** How tall a view lays out: the screen's safe area and what lies in it. */
  height: 600,
  /** What the screen did, in order. */
  did: [] as string[],
  /** What VoiceOver was given to read out. */
  said: [] as string[],
  /** The highlight loops started and stopped, in order. */
  loops: [] as string[],
  /** Answers iOS's first question about Reduce Motion. */
  answerMotion: (_on: boolean) => undefined as void,
  /** iOS's later changes of Reduce Motion and of the app's state. */
  motionChanged: null as ((on: boolean) => void) | null,
  appChanged: null as ((state: string) => void) | null,
}));

// ui.tsx keeps its pictures with artwork-cache.ts: over the files stand-in here.
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => {
  const { createElement, useEffect } = await import("react");
  const { reactNative } = await import("./react-native.ts");
  type Props = {
    children?: React.ReactNode;
    testID?: string;
    style?: Style;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };
  /** A view, which lays out once, 100 points wide and as tall as the scenario has it. */
  const View = ({ children, testID, onLayout, style }: Props) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 100, height: scenario.height } } });
    }, []);
    return createElement(
      "div",
      { "data-testid": testID, "data-width": flat(style).width },
      children,
    );
  };
  type Bounds = { maxHeight?: number; width?: string | number };
  type Style = Bounds | readonly Style[] | undefined | false | null;
  const flat = (style: Style): Bounds =>
    !style ? {} : "length" in style ? Object.assign({}, ...style.map(flat)) : style;
  /** A scroll view, which shows the most height it may take. */
  const ScrollView = ({
    children,
    testID,
    style,
    keyboardShouldPersistTaps,
  }: Props & { style?: Style; keyboardShouldPersistTaps?: string }) =>
    createElement(
      "div",
      {
        "data-testid": testID,
        "data-max-height": flat(style).maxHeight,
        "data-keyboard-taps": keyboardShouldPersistTaps,
      },
      children,
    );
  class Value {
    setValue() {}
    interpolate() {
      return this;
    }
  }
  return {
    ...reactNative,
    View,
    ScrollView,
    TextInput: () => null,
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: scenario.fontScale }),
    Easing: { linear: (at: number) => at },
    Animated: {
      Value,
      View: () => createElement("i", { "data-testid": "highlight" }),
      timing: () => ({}),
      loop: () => ({
        start: () => scenario.loops.push("start"),
        stop: () => scenario.loops.push("stop"),
      }),
    },
    AppState: {
      currentState: "active",
      addEventListener: (_event: string, listener: (state: string) => void) => {
        scenario.appChanged = listener;
      },
    },
    AccessibilityInfo: {
      isReduceTransparencyEnabled: async () => false,
      isReduceMotionEnabled: () =>
        new Promise<boolean>((answer) => {
          scenario.answerMotion = answer;
        }),
      addEventListener: (event: string, listener: (on: boolean) => void) => {
        if (event === "reduceMotionChanged") scenario.motionChanged = listener;
      },
      announceForAccessibilityWithOptions: (text: string) => scenario.said.push(text),
    },
  };
});
vi.mock("react-native-safe-area-context", async () => {
  const { createElement } = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      createElement("div", null, children),
  };
});
vi.mock("expo-glass-effect", () => ({
  GlassView: () => null,
  isGlassEffectAPIAvailable: () => false,
  isLiquidGlassAvailable: () => false,
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-router", () => ({
  router: { push: (href: string) => scenario.did.push(`push ${href}`) },
  useIsFocused: () => scenario.focused,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (tab: string, screen: string) => `${tab === "films" ? "/films" : "/live"}/${screen}`,
}));
vi.mock("../src/account.ts", () => ({
  currentRoster: () => ({ kind: "ready", members: scenario.members }),
  onRoster: (listener: () => void) => {
    scenario.rosterChanged = listener;
    return () => {};
  },
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  useCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel) => scenario.did.push(`play ${channel.key}`),
  retry: (id: string) => scenario.did.push(`retry ${id}`),
  retryChannels: () => scenario.did.push("retry channels"),
  reloadAllChannels: () => scenario.did.push("reload channels"),
  reloadTitles: (id: string) => scenario.did.push(`reload titles ${id}`),
  retryTitles: () => scenario.did.push("retry titles"),
}));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({ phase: { kind: "idle" }, watch: scenario.watch }),
  channelStatus: () => null,
}));
vi.mock("../src/storage.ts", () => ({ useSavedState: () => ({}), writeState: () => undefined }));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  useCollections: () => scenario.made,
  useFileFacts: () => 0,
  filterFilesOf: () => new Map(),
  useHolding: () => undefined,
  tilesOf: () => [],
}));
// Collections with no rows: what Movies shows when the provider lists no new or popular movie.
vi.mock("@mrstreamer/core/ondemand/collections", () => ({
  collectionRows: () => [],
  rowIds: () => [],
}));
vi.mock("../src/resume.ts", () => ({
  detailsHref: () => "/",
  openDetails: () => undefined,
  resume: () => undefined,
  useContinueWatching: () => [],
}));
vi.mock("../src/viewing.ts", () => ({ useViewing: () => null }));
vi.mock("../src/tab-bar.ts", () => ({ useFixedTabBar: () => undefined }));

const { default: Live } = await import("../src/app/(tabs)/live/index.tsx");
const { DiscoverScreen } = await import("../src/live-discover.tsx");
const { TitlesHome } = await import("../src/titles-screen.tsx");
const { Placeholders, Shape, StatusLine, libraryStatus, useProviderStatus } =
  await import("../src/loading.tsx");

const failure = { kind: "unexpected", detail: "" } as const;
const catalogueOf = {
  categories: [],
  channels: [{}],
  movieCategories: [],
  movies: [{}],
  seriesCategories: [],
  series: [],
} as never;
const emptyCatalogue = {
  categories: [],
  channels: [],
  movieCategories: [],
  movies: [],
  seriesCategories: [],
  series: [],
} as never;

const member = (id: string, label: string, standing: Partial<Member> = {}): Member =>
  ({
    entry: { id, server: "http://example.test" },
    label,
    account: null,
    needsSecret: false,
    live: { kind: "ready", value: catalogueOf, from: "provider", fetchedAt: 0, took: 1 },
    titles: { kind: "ready", value: catalogueOf, from: "provider", fetchedAt: 0, took: 1 },
    ...standing,
  }) as Member;

const channels = [
  { key: "a:1", title: "NPO 1", tags: [], logoUrl: null },
  { key: "a:2", title: "BBC One", tags: [], logoUrl: null },
] as unknown as Channel[];
const library = {
  regions: [{ name: "Netherlands", channels, shelves: [] }],
  channels,
  byKey: new Map(),
  placeOf: new Map(),
  labels: new Map(),
} as unknown as Library;
const emptyLibrary = {
  regions: [],
  channels: [],
  byKey: new Map(),
  placeOf: new Map(),
  labels: new Map(),
} as unknown as Library;

/** Collections Movies can browse, with nothing in any row. */
const nothingMade = {
  size: () => 0,
  genres: () => [],
  services: () => [],
  list: () => [],
};

const usableMade = { ...nothingMade, size: () => 1 };

let container: ReturnType<typeof document.createElement>;
let root: Root;
let unmount = () => {};
function draw(node: React.ReactNode) {
  React.act(() => {
    scenario.rosterChanged();
    root.render(node);
  });
}
function open(node: React.ReactNode) {
  container = document.createElement("div");
  root = createRoot(container);
  draw(node);
  unmount = () => React.act(() => root.unmount());
}
const has = (testID: string) => container.querySelector(`[data-testid="${testID}"]`) !== null;
const count = (testID: string) => container.querySelectorAll(`[data-testid="${testID}"]`).length;
const line = () => container.querySelector('[data-testid="status-line"]')?.textContent ?? null;
const text = () => container.textContent ?? "";
function press(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (each) => each.textContent === label || each.getAttribute("aria-label") === label,
  );
  if (!button) throw new Error(`No ${label} on screen`);
  React.act(() => button.click());
}

beforeEach(() => {
  scenario.members = [];
  scenario.rosterChanged();
  Object.assign(scenario, {
    members: [member("a", "Northwind")],
    catalogue: { kind: "loading" },
    lists: { kind: "loading" },
    made: null,
    focused: true,
    watch: false,
    height: 600,
    fontScale: 1,
    did: [],
    said: [],
    loops: [],
  });
});
afterEach(() => unmount());

describe("Live while its channels load", () => {
  it("holds the list's place with still rows and names who it loads from", () => {
    scenario.members = [member("a", "Northwind", { live: { kind: "loading", last: null } })];
    open(React.createElement(Live));
    expect(has("placeholder-rows")).toBe(true);
    expect(line()).toBe("Loading channels from Northwind.");
    expect(scenario.said).toEqual(["Loading channels from Northwind."]);
  });

  it("says the provider lists no channels only once its list is in, with no shapes", () => {
    scenario.catalogue = { kind: "ready", library: emptyLibrary, failing: [] };
    open(React.createElement(Live));
    expect(text()).toContain("No live channels");
    expect(has("placeholder-rows")).toBe(false);
    expect(line()).toBeNull();
  });

  it("says nothing while a list loads again over the last one, as at launch and on Retry", () => {
    const last = catalogueOf;
    scenario.members = [member("a", "Northwind", { live: { kind: "loading", last } })];
    scenario.catalogue = { kind: "ready", library, failing: [] };
    open(React.createElement(Live));
    expect(line()).toBeNull();
    expect(has("placeholder-rows")).toBe(false);
    expect(text()).toContain("NPO 1");

    // Another provider loading for the first time is still named.
    scenario.members = [
      member("a", "Northwind", { live: { kind: "loading", last } }),
      member("b", "Harbor", { live: { kind: "loading", last: null } }),
    ];
    draw(React.createElement(Live));
    expect(line()).toBe("Loading channels from Harbor.");

    // Failure keeps the last list usable; Details opens recovery. Loading that list again is quiet.
    const failed = { kind: "failed", error: failure, last, since: 0 } as const;
    scenario.members = [member("a", "Northwind", { live: failed })];
    scenario.catalogue = { kind: "ready", library, failing: scenario.members };
    draw(React.createElement(Live));
    expect(line()).toBe("Northwind unavailableDetails");
    press("Details");
    expect(scenario.did).toEqual(["push /live/settings"]);
    scenario.members = [member("a", "Northwind", { live: { kind: "loading", last } })];
    scenario.catalogue = { kind: "ready", library, failing: [] };
    draw(React.createElement(Live));
    expect(line()).toBeNull();
    expect(text()).toContain("NPO 1");
  });

  it("names the unavailable provider, keeps the last list, and opens recovery", () => {
    const harbor = member("b", "Harbor", {
      live: { kind: "failed", error: failure, last: catalogueOf, since: 0 },
    });
    scenario.members = [member("a", "Northwind"), harbor];
    scenario.catalogue = { kind: "ready", library, failing: [harbor] };
    open(React.createElement(Live));
    expect(line()).toBe("Harbor unavailableDetails");
    expect(text()).toContain("BBC One");
    press("Details");
    expect(scenario.did).toEqual(["push /live/settings"]);
  });

  it("sends a provider whose password is gone to Settings", () => {
    const harbor = member("b", "Harbor", { needsSecret: true });
    scenario.members = [member("a", "Northwind"), harbor];
    scenario.catalogue = { kind: "ready", library, failing: [harbor] };
    open(React.createElement(Live));
    expect(line()).toBe("Harbor needs a passwordDetails");
    press("Details");
    expect(scenario.did).toEqual(["push /live/settings"]);
  });
});

describe("the status line", () => {
  it("is read out only while the viewer sees it, then its latest words once", () => {
    const northwind = member("a", "Northwind", { live: { kind: "loading", last: null } });
    scenario.members = [northwind];
    open(React.createElement(Live));
    expect(scenario.said).toEqual(["Loading channels from Northwind."]);

    // Watch opens over Live, which stays in front in navigation, and Harbor fails meanwhile.
    scenario.watch = true;
    scenario.members = [
      northwind,
      member("b", "Harbor", { live: { kind: "failed", error: failure, last: null, since: 0 } }),
    ];
    draw(React.createElement(Live));
    expect(scenario.said).toEqual(["Loading channels from Northwind."]);
    scenario.watch = false;
    draw(React.createElement(Live));
    draw(React.createElement(Live));
    expect(scenario.said).toEqual([
      "Loading channels from Northwind.",
      "Couldn't load channels from Harbor. Loading channels from Northwind.",
    ]);

    // In the background too.
    React.act(() => scenario.appChanged?.("background"));
    scenario.members = [northwind];
    draw(React.createElement(Live));
    expect(scenario.said).toHaveLength(2);
    React.act(() => scenario.appChanged?.("active"));
    expect(scenario.said.at(-1)).toBe("Loading channels from Northwind.");
    expect(scenario.said).toHaveLength(3);
  });

  it("keeps two providers and accessible actions within a small screen's share", () => {
    const northwind = member("a", "Northwind", {
      live: { kind: "failed", error: failure, last: catalogueOf, since: 0 },
    });
    const harbor = member("b", "Harbor", { needsSecret: true });
    scenario.members = [northwind, harbor];
    scenario.catalogue = { kind: "ready", library, failing: [northwind, harbor] };
    // A safe area of 80 points: less than the text floor and two scaled actions took before.
    scenario.height = 80;
    open(React.createElement(Live));
    const panel = container.querySelector('[data-testid="status-line"]')!;
    const most = Number(panel.getAttribute("data-max-height") ?? NaN);
    // The whole panel scrolls within less than half the screen's safe area; the channels keep
    // the rest.
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(80 / 2);
    expect(panel.textContent).toBe("Northwind unavailable. Harbor needs a passwordDetails");
    expect(text()).toContain("NPO 1");
    // Both actions are in that scroll and still work.
    press("Details");
    press("Dismiss provider notice");
    expect(scenario.did).toEqual(["push /live/settings"]);
    expect(line()).toBeNull();
  });
});

describe("Movies while its lists load", () => {
  it("holds For you's place with still shapes until the first collections are made", () => {
    scenario.members = [member("a", "Northwind", { titles: { kind: "loading", last: null } })];
    open(React.createElement(TitlesHome, { kind: "movie" }));
    expect(has("movie-loading")).toBe(true);
    expect(count("placeholder-shelf")).toBe(2);
    expect(line()).toBe("Loading movies and series from Northwind.");
    expect(text()).not.toContain("Nothing new or popular yet");
  });

  it("says nothing is new or popular only once collections are made, with no shapes", () => {
    scenario.lists = { kind: "ready", index: {} } as TitleLists;
    scenario.made = nothingMade;
    open(React.createElement(TitlesHome, { kind: "movie" }));
    expect(text()).toContain("Nothing new or popular yet. All lists every movie.");
    expect(has("placeholder-shelf")).toBe(false);
    expect(line()).toBeNull();
  });

  it("keeps what one provider listed when another's update fails, and opens recovery", () => {
    scenario.members = [
      member("a", "Northwind", { titles: { kind: "loading", last: null } }),
      member("b", "Harbor", {
        titles: { kind: "failed", error: failure, last: catalogueOf, since: 0 },
      }),
    ];
    scenario.lists = { kind: "ready", index: {} } as TitleLists;
    scenario.made = usableMade;
    open(React.createElement(TitlesHome, { kind: "movie" }));
    expect(line()).toBe("Harbor unavailable. Loading movies and series from Northwind.Details");
    expect(has("movie-for-you")).toBe(true);
    press("Details");
    expect(scenario.did).toEqual(["push /films/settings"]);
  });
});

describe("provider notice incidents", () => {
  const failed = (since = 0, last = catalogueOf) =>
    ({ kind: "failed", error: failure, last, since }) as const;
  const show = (members: Member[]) => {
    scenario.members = members;
    scenario.catalogue = { kind: "ready", library, failing: members };
    scenario.lists = { kind: "ready", index: {} } as TitleLists;
    scenario.made = usableMade;
  };

  it("dismisses across tabs, resume, renamed labels and an unchanged retry without clearing the error or lists", () => {
    const state = failed();
    show([member("a", "Northwind", { live: state, titles: state })]);
    open(React.createElement(Live));
    press("Dismiss provider notice");
    expect(line()).toBeNull();
    expect(text()).toContain("NPO 1");
    expect(scenario.members[0]!.live).toBe(state);
    expect(scenario.members[0]!.titles).toBe(state);
    expect(scenario.did).toEqual([]);
    draw(React.createElement(TitlesHome, { kind: "movie" }));
    expect(line()).toBeNull();
    React.act(() => scenario.appChanged?.("background"));
    React.act(() => scenario.appChanged?.("active"));
    show([member("a", "Renamed", { live: { kind: "loading", last: catalogueOf }, titles: state })]);
    draw(React.createElement(Live));
    show([member("a", "Renamed", { live: failed(42), titles: failed(42) })]);
    draw(React.createElement(Live));
    expect(line()).toBeNull();
    expect(scenario.said).toEqual(["Northwind unavailable"]);
  });

  it("waits for all failed sources to recover, including while screens are absent, then shows a new failure", () => {
    show([member("a", "Northwind", { live: failed(), titles: failed() })]);
    open(React.createElement(Live));
    press("Dismiss provider notice");
    show([member("a", "Northwind", { titles: failed() })]);
    draw(React.createElement(Live));
    show([member("a", "Northwind", { live: failed(1), titles: failed() })]);
    draw(React.createElement(Live));
    expect(line()).toBeNull();
    draw(React.createElement("p", null, "Settings"));
    React.act(() => {
      scenario.members = [member("a", "Northwind")];
      scenario.rosterChanged();
      scenario.members = [member("a", "Northwind", { live: failed(2), titles: failed(2) })];
      scenario.rosterChanged();
    });
    draw(React.createElement(TitlesHome, { kind: "movie" }));
    expect(line()).toBe("Northwind unavailableDetails");
  });

  it("does not treat a saved copy or a loading transition as successful recovery", () => {
    show([member("a", "Northwind", { live: failed() })]);
    open(React.createElement(Live));
    press("Dismiss provider notice");
    const cached = {
      kind: "ready",
      value: catalogueOf,
      from: "cache",
      fetchedAt: 0,
      took: null,
    } as const;
    show([member("a", "Northwind", { live: cached })]);
    draw(React.createElement(Live));
    show([member("a", "Northwind", { live: { kind: "loading", last: catalogueOf } })]);
    draw(React.createElement(Live));
    show([member("a", "Northwind", { live: failed(3) })]);
    draw(React.createElement(Live));
    expect(line()).toBeNull();
  });

  it("does not confuse providers with the same label, password loss, or a removed provider added again", () => {
    show([member("a", "Same", { live: failed() })]);
    open(React.createElement(Live));
    press("Dismiss provider notice");
    show([member("a", "Same", { live: failed() }), member("b", "Same", { live: failed() })]);
    draw(React.createElement(Live));
    expect(line()).toBe("Same unavailableDetails");
    press("Dismiss provider notice");
    show([member("a", "Same", { live: failed(), needsSecret: true })]);
    draw(React.createElement(Live));
    expect(line()).toBe("Same needs a passwordDetails");
    press("Dismiss provider notice");
    expect(scenario.members[0]!.needsSecret).toBe(true);
    show([]);
    draw(React.createElement(Live));
    show([member("a", "Same", { live: failed() })]);
    draw(React.createElement(Live));
    expect(line()).toBe("Same unavailableDetails");
  });

  it("keeps recovery visible for empty retained lists after acknowledgement on a populated screen", () => {
    show([member("a", "Northwind", { live: failed() })]);
    open(React.createElement(Live));
    press("Dismiss provider notice");
    show([member("a", "Northwind", { live: failed(1, emptyCatalogue) })]);
    scenario.catalogue = { kind: "ready", library: emptyLibrary, failing: scenario.members };
    draw(React.createElement(Live));
    expect(text()).toContain("No live channels");
    expect(line()).toBe(
      "Couldn't update channels from Northwind. Showing the last list.RetrySettings",
    );
    expect(has("dismiss-provider-notice")).toBe(false);
    press("Retry");
    press("Settings");
    expect(scenario.did).toEqual(["retry a", "push /live/settings"]);
  });

  it("keeps first-load failure explanation and recovery even when a different tab acknowledged it", () => {
    show([
      member("a", "Northwind", {
        live: failed(),
        titles: { kind: "failed", error: failure, last: null, since: 0 },
      }),
    ]);
    open(React.createElement(Live));
    press("Dismiss provider notice");
    scenario.made = null;
    draw(React.createElement(TitlesHome, { kind: "movie" }));
    expect(line()).toBe("Couldn't load movies and series from Northwind.RetrySettings");
    expect(has("dismiss-provider-notice")).toBe(false);
    press("Retry");
    press("Settings");
    expect(scenario.did).toEqual(["reload titles a", "push /films/settings"]);
  });

  it("preserves composed Search progress, actions and announcements when only the failure is dismissed", () => {
    // Search's public adapter contract, without writing the concurrently owned Search screen.
    function SearchStatus({ text = "Searching. " }: { text?: string }) {
      const provider = libraryStatus(scenario.members, {
        channels: true,
        titles: true,
        usableContent:
          scenario.catalogue.kind === "ready" && scenario.catalogue.library.channels.length > 0,
        retry: () => {},
        settings: () => scenario.did.push("settings"),
      });
      const status = useProviderStatus(
        provider && {
          ...provider,
          text: text + provider.text,
          progress: 0.5,
          actions: [{ label: "Stop search", onPress: () => scenario.did.push("stop") }],
        },
      );
      return status ? React.createElement(StatusLine, { status, space: 200 }) : null;
    }
    show([member("a", "Northwind", { live: failed() })]);
    scenario.fontScale = 3;
    open(React.createElement(SearchStatus));
    const panel = container.querySelector('[data-testid="status-line"]')!;
    expect(panel.getAttribute("data-max-height")).toBe("80");
    expect(panel.getAttribute("data-keyboard-taps")).toBe("handled");
    expect(line()).toBe("Northwind unavailable. Searching. DetailsStop search");
    expect(container.querySelector('[data-width="50%"]')).not.toBeNull();
    press("Details");
    press("Dismiss provider notice");
    expect(line()).toBe("Searching. Stop search");
    expect(container.querySelector('[data-width="50%"]')).not.toBeNull();
    draw(React.createElement(SearchStatus, { text: "" }));
    expect(line()).toBe("Stop search");
    expect(container.querySelector('[data-width="50%"]')).not.toBeNull();
    press("Stop search");
    expect(scenario.did).toEqual(["settings", "stop"]);
    expect(scenario.said).toEqual(["Northwind unavailable. Searching. ", "Searching. "]);
  });
});

describe("usable content reported by the existing catalogue owners", () => {
  const failureState = (last: LiveCatalogue): Member["live"] => ({
    kind: "failed",
    error: failure,
    last,
    since: 0,
  });
  const restricted = (mode: "flag" | "category"): LiveCatalogue => ({
    categories: [{ id: "restricted", name: "Adult" }],
    channels: [
      {
        id: "only",
        name: "Restricted",
        number: null,
        logoUrl: null,
        categoryIds: mode === "category" ? ["restricted"] : [],
        guideId: null,
        adult: mode === "flag",
        catchupDays: null,
      },
    ],
  });
  const publish = (raw: LiveCatalogue) => {
    scenario.members = [member("a", "Northwind", { live: failureState(raw) })];
    const library = buildLibrary([{ subscriptionId: "a", label: "Northwind", catalogue: raw }]);
    scenario.catalogue = { kind: "ready", library, failing: scenario.members };
    return library;
  };

  it.each(["flag", "category"] as const)(
    "keeps recovery for %s-filtered retained channels, including after acknowledgement",
    (mode) => {
      const raw = restricted(mode);
      const mixed = {
        ...raw,
        channels: [
          ...raw.channels,
          { ...raw.channels[0]!, id: "visible", name: "News", categoryIds: [], adult: false },
        ],
      };
      expect(publish(mixed).channels).toHaveLength(1);
      open(React.createElement(Live));
      expect(line()).toBe("Northwind unavailableDetails");
      press("Dismiss provider notice");
      expect(line()).toBeNull();
      expect(publish(raw).channels).toHaveLength(0);
      draw(React.createElement(Live));
      expect(text()).toContain("No live channels");
      expect(line()).toBe(
        "Couldn't update channels from Northwind. Showing the last list.RetrySettings",
      );
      expect(has("dismiss-provider-notice")).toBe(false);
      press("Retry");
      press("Settings");
      expect(scenario.did).toEqual(["retry a", "push /live/settings"]);
      // Discover uses the same whole derived library, rather than its query's matches.
      draw(React.createElement(DiscoverScreen));
      expect(line()).toContain("RetrySettings");
      expect(has("dismiss-provider-notice")).toBe(false);
    },
  );

  it("keeps failure recovery while the derived channel owner is still pending", () => {
    publish({ categories: [], channels: [{ ...restricted("flag").channels[0]!, adult: false }] });
    scenario.catalogue = { kind: "loading" };
    open(React.createElement(Live));
    expect(line()).toContain("RetrySettings");
    expect(has("dismiss-provider-notice")).toBe(false);
    expect(has("placeholder-rows")).toBe(true);
  });

  it.each(["movie", "series"] as const)(
    "keeps recovery when the published %s collection filters every retained title",
    async (kind) => {
      const { collections } = await vi.importActual<
        typeof import("@mrstreamer/core/ondemand/collections")
      >("@mrstreamer/core/ondemand/collections");
      const providerTitle: ProviderTitle = {
        id: "hidden",
        name: "Restricted",
        adult: true,
        posterUrl: null,
        backdropUrl: null,
        rating: null,
        addedAt: null,
        releaseDate: null,
        categoryIds: [],
        container: null,
      };
      const raw: OnDemandCatalogue = {
        movieCategories: [],
        movies: [providerTitle],
        seriesCategories: [],
        series: [providerTitle],
      };
      const index = indexCatalogue([{ subscriptionId: "a", catalogue: raw }], "en");
      scenario.made = collections({
        kind,
        titles: kindOf(index, kind).titles,
        language: "en",
        metadata: () => null,
        names: () => null,
        services: [],
        now: Date.now(),
      });
      scenario.members = [
        member("a", "Northwind", {
          titles: { kind: "failed", error: failure, last: raw, since: 0 },
        }),
      ];
      scenario.lists = { kind: "ready", index };
      open(React.createElement(TitlesHome, { kind }));
      expect(line()).toBe(
        "Couldn't update movies and series from Northwind. Showing the last list.RetrySettings",
      );
      expect(has("dismiss-provider-notice")).toBe(false);
      press("Retry");
      press("Settings");
      expect(scenario.did).toEqual([
        "reload titles a",
        kind === "movie" ? "push /films/settings" : "push /live/settings",
      ]);
    },
  );
});

describe("the shapes' highlight", () => {
  // One run of the app: iOS answers about Reduce Motion once, then reports changes.
  it("moves only once Reduce Motion is known to be off, on the screen in front, with the app active", async () => {
    const group = () =>
      React.createElement(
        Placeholders,
        null,
        React.createElement(Shape),
        React.createElement(Shape),
        React.createElement(Shape),
      );
    open(group());
    // Before iOS says, nothing moves.
    expect(scenario.loops).toEqual([]);
    expect(count("highlight")).toBe(0);

    // Reduce Motion on: still shapes.
    await React.act(async () => scenario.answerMotion(true));
    expect(scenario.loops).toEqual([]);
    expect(count("highlight")).toBe(0);

    // Turned off: one loop for the group, a band on each shape.
    React.act(() => scenario.motionChanged?.(false));
    expect(scenario.loops).toEqual(["start"]);
    expect(count("highlight")).toBe(3);

    // In the background it stops, and starts again on return.
    React.act(() => scenario.appChanged?.("background"));
    expect(scenario.loops).toEqual(["start", "stop"]);
    expect(count("highlight")).toBe(0);
    React.act(() => scenario.appChanged?.("active"));
    expect(scenario.loops).toEqual(["start", "stop", "start"]);

    // Another screen in front stops it.
    scenario.focused = false;
    draw(group());
    expect(scenario.loops).toEqual(["start", "stop", "start", "stop"]);
    scenario.focused = true;
    draw(group());

    // Watch open over the screen, which stays in front in navigation, stops it; closing it
    // starts it again.
    scenario.watch = true;
    draw(group());
    expect(scenario.loops).toEqual(["start", "stop", "start", "stop", "start", "stop"]);
    expect(count("highlight")).toBe(0);
    scenario.watch = false;
    draw(group());
    expect(scenario.loops).toEqual(["start", "stop", "start", "stop", "start", "stop", "start"]);
    expect(count("highlight")).toBe(3);

    // Content replacing the shapes stops it.
    draw(React.createElement("p", null, "Content"));
    expect(scenario.loops).toEqual([
      "start",
      "stop",
      "start",
      "stop",
      "start",
      "stop",
      "start",
      "stop",
    ]);
  });
});
