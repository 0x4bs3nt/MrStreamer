import * as React from "react";
import { Window } from "happy-dom";
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

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
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

vi.mock("react-native", async () => {
  const { createElement, useEffect } = await import("react");
  type Props = {
    children?: React.ReactNode;
    testID?: string;
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  };
  /** A view, which lays out once, 100 points wide and as tall as the scenario has it. */
  const View = ({ children, testID, onLayout }: Props) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 100, height: scenario.height } } });
    }, []);
    return createElement("div", { "data-testid": testID }, children);
  };
  type Style = { maxHeight?: number } | readonly Style[] | undefined;
  const flat = (style: Style): { maxHeight?: number } =>
    style === undefined ? {} : "length" in style ? Object.assign({}, ...style.map(flat)) : style;
  /** A scroll view, which shows the most height it may take. */
  const ScrollView = ({ children, testID, style }: Props & { style?: Style }) =>
    createElement(
      "div",
      { "data-testid": testID, "data-max-height": flat(style).maxHeight },
      children,
    );
  class Value {
    setValue() {}
    interpolate() {
      return this;
    }
  }
  return {
    View,
    ScrollView,
    Text: ({ children }: Props) => createElement("span", null, children),
    Image: () => null,
    Pressable: ({ children, testID, onPress }: Props & { onPress?: () => void }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }, children),
    FlatList: <T>({
      data,
      renderItem,
      testID,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T; index: number }) => React.ReactNode;
      testID?: string;
    }) =>
      createElement(
        "div",
        { "data-testid": testID },
        data.map((item, index) =>
          createElement("div", { key: index }, renderItem({ item, index })),
        ),
      ),
    ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1 },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
    DynamicColorIOS: () => "#000000",
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
  playingChannel: () => null,
}));
vi.mock("../src/storage.ts", () => ({ useSavedState: () => ({}), writeState: () => undefined }));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  useCollections: () => scenario.made,
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
const { TitlesHome } = await import("../src/titles-screen.tsx");
const { Placeholders, Shape } = await import("../src/loading.tsx");

const failure = { kind: "unexpected", detail: "" } as const;
const catalogueOf = {} as never;

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
  byKey: new Map(),
  placeOf: new Map(),
} as unknown as Library;
const emptyLibrary = { regions: [], byKey: new Map(), placeOf: new Map() } as unknown as Library;

/** Collections Movies can browse, with nothing in any row. */
const nothingMade = {
  size: () => 0,
  genres: () => [],
  services: () => [],
  list: () => [],
};

let container: ReturnType<typeof document.createElement>;
let root: Root;
let unmount = () => {};
function draw(node: React.ReactNode) {
  React.act(() => root.render(node));
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
    (each) => each.textContent === label,
  );
  if (!button) throw new Error(`No ${label} on screen`);
  React.act(() => button.click());
}

beforeEach(() => {
  Object.assign(scenario, {
    members: [member("a", "Northwind")],
    catalogue: { kind: "loading" },
    lists: { kind: "loading" },
    made: null,
    focused: true,
    watch: false,
    height: 600,
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

  it("keeps the channels usable while their list updates, then drops the line", () => {
    const last = catalogueOf;
    scenario.members = [member("a", "Northwind", { live: { kind: "loading", last } })];
    scenario.catalogue = { kind: "ready", library, failing: [] };
    open(React.createElement(Live));
    expect(line()).toBe("Updating channels from Northwind.");
    expect(has("placeholder-rows")).toBe(false);
    expect(text()).toContain("NPO 1");

    scenario.members = [member("a", "Northwind")];
    draw(React.createElement(Live));
    expect(line()).toBeNull();
    expect(text()).toContain("NPO 1");
  });

  it("says an update failed, keeps the last list, and retries that provider", () => {
    const harbor = member("b", "Harbor", {
      live: { kind: "failed", error: failure, last: catalogueOf, since: 0 },
    });
    scenario.members = [member("a", "Northwind"), harbor];
    scenario.catalogue = { kind: "ready", library, failing: [harbor] };
    open(React.createElement(Live));
    expect(line()).toBe("Couldn't update channels from Harbor. Showing the last list.Retry");
    expect(text()).toContain("BBC One");
    press("Retry");
    expect(scenario.did).toEqual(["retry b"]);
  });

  it("sends a provider whose password is gone to Settings", () => {
    const harbor = member("b", "Harbor", { needsSecret: true });
    scenario.members = [member("a", "Northwind"), harbor];
    scenario.catalogue = { kind: "ready", library, failing: [harbor] };
    open(React.createElement(Live));
    expect(line()).toBe("Enter the password for Harbor in Settings.Settings");
    press("Settings");
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

  it("keeps two providers' long line and both actions in one scroll within a small screen's share", () => {
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
    expect(panel.textContent).toBe(
      "Couldn't update channels from Northwind. Showing the last list. Enter the password for Harbor in Settings.RetrySettings",
    );
    expect(text()).toContain("NPO 1");
    // Both actions are in that scroll and still work.
    press("Retry");
    press("Settings");
    expect(scenario.did).toEqual(["retry a", "push /live/settings"]);
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

  it("keeps what one provider listed when another's update fails, and reads that one again", () => {
    scenario.members = [
      member("a", "Northwind", { titles: { kind: "loading", last: null } }),
      member("b", "Harbor", {
        titles: { kind: "failed", error: failure, last: catalogueOf, since: 0 },
      }),
    ];
    scenario.lists = { kind: "ready", index: {} } as TitleLists;
    scenario.made = nothingMade;
    open(React.createElement(TitlesHome, { kind: "movie" }));
    expect(line()).toBe(
      "Couldn't update movies and series from Harbor. Showing the last list. Loading movies and series from Northwind.Retry",
    );
    expect(has("movie-for-you")).toBe(true);
    press("Retry");
    expect(scenario.did).toEqual(["reload titles b"]);
  });
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
