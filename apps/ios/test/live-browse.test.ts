import * as React from "react";
import { Window } from "happy-dom";
import type { LiveCatalogue, ProviderChannel } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import { buildLibrary, type Channel, type Library } from "../src/library.ts";
import type { Phase } from "../src/playback.ts";
import type { SavedState } from "../src/storage.ts";

// Live's browsing, as the viewer meets it: All of every provider and country on first open, each
// channel once, For you with the channel watched last behind Play, a country that filters every
// tab and clears, the tab kept on return, and a category's own list. The real screen runs with
// React DOM on a happy-dom window, as loading-feedback.test.ts does, over a library library.ts
// builds from two fake providers; saved state, playback and navigation are recorded.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Sheet = { options: string[]; choose: (index: number) => void };

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  saved: {} as Partial<SavedState>,
  /** What the one player does. */
  phase: { kind: "idle" } as Phase,
  /** What the screen did, in order. */
  did: [] as string[],
  /** The system sheet last shown. */
  sheet: null as Sheet | null,
}));

// ui.tsx keeps its pictures with artwork-cache.ts: over the files stand-in here.
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("react-native", async () => {
  const { createElement, Fragment, isValidElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  const node = (part: unknown) =>
    part === undefined || part === null
      ? null
      : isValidElement(part)
        ? part
        : createElement(part as React.ComponentType);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Image: () => null,
    Pressable: ({
      children,
      testID,
      onPress,
      accessibilityLabel,
    }: Props & { onPress?: () => void; accessibilityLabel?: string }) =>
      createElement(
        "button",
        { "data-testid": testID, "aria-label": accessibilityLabel, onClick: onPress },
        children,
      ),
    FlatList: <T>({
      data,
      renderItem,
      ListHeaderComponent,
      testID,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T; index: number }) => React.ReactNode;
      ListHeaderComponent?: unknown;
      testID?: string;
    }) =>
      createElement(
        "div",
        { "data-testid": testID },
        node(ListHeaderComponent),
        data.map((item, index) =>
          createElement(Fragment, { key: index }, renderItem({ item, index })),
        ),
      ),
    ActionSheetIOS: {
      showActionSheetWithOptions: (
        { options }: { options: string[] },
        choose: (index: number) => void,
      ) => {
        scenario.sheet = { options, choose };
      },
    },
    StyleSheet: { create: <T>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
    DynamicColorIOS: () => "#000000",
    AppState: { currentState: "active", addEventListener: () => undefined },
    AccessibilityInfo: {
      isReduceTransparencyEnabled: async () => false,
      isReduceMotionEnabled: async () => false,
      addEventListener: () => undefined,
      announceForAccessibilityWithOptions: () => undefined,
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
  useIsFocused: () => true,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (_tab: string, screen: string) => `/live/${screen}`,
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  useCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel, _place: string, { watch }: { watch: boolean }) =>
    scenario.did.push(`play ${channel.key}${watch ? " in Watch" : ""}`),
  retry: () => undefined,
  retryChannels: () => undefined,
  reloadAllChannels: () => undefined,
}));
vi.mock("expo-video", () => ({ createVideoPlayer: () => ({}) }));
vi.mock("../src/playback.ts", async (original) => ({
  channelStatus: (await original<typeof import("../src/playback.ts")>()).channelStatus,
  usePlayback: () => ({ phase: scenario.phase, watch: false }),
}));
vi.mock("../src/storage.ts", () => ({
  useSavedState: () => scenario.saved,
  writeState: (change: (state: Partial<SavedState>) => Partial<SavedState>) => {
    scenario.saved = change(scenario.saved);
  },
}));

const { LiveHome, CategoryScreen } = await import("../src/live-screen.tsx");

const channel = (id: string, name: string, categoryIds: string[]): ProviderChannel => ({
  id,
  name,
  number: null,
  logoUrl: null,
  categoryIds,
  guideId: null,
  catchupDays: null,
});

const home: LiveCatalogue = {
  categories: [
    { id: "1", name: "NL | News" },
    { id: "2", name: "NL | Sport" },
    { id: "3", name: "BE | Sport" },
  ],
  channels: [
    channel("10", "NL | NOS Journaal HD", ["1"]),
    // The same channel in another quality: one channel, with this as its second stream.
    channel("14", "NL | NOS Journaal FHD", ["1"]),
    // In a category of two countries.
    channel("11", "NL | Ziggo Sport", ["2", "3"]),
    channel("12", "BE | Sporza", ["3"]),
    channel("13", "Loose", []),
  ],
};
// The second panel numbers its channels as the first does.
const cabin: LiveCatalogue = {
  categories: [
    { id: "1", name: "NL | News" },
    { id: "2", name: "NL | Kids" },
  ],
  channels: [
    channel("10", "NL | NOS Journaal HD", ["1"]),
    channel("11", "NL | RTL Nieuws", ["1"]),
    channel("12", "NL | Zappelin", ["2"]),
  ],
};
const both = buildLibrary([
  { subscriptionId: "a", label: "Home", catalogue: home },
  { subscriptionId: "b", label: "Cabin", catalogue: cabin },
]);
/** The library once a refresh found Home's Belgian category gone. */
const withoutBelgium = buildLibrary([
  {
    subscriptionId: "a",
    label: "Home",
    catalogue: { ...home, categories: home.categories.slice(0, 2) },
  },
  { subscriptionId: "b", label: "Cabin", catalogue: cabin },
]);

const member = (id: string, label: string): Member =>
  ({
    entry: { id, server: "http://example.test" },
    label,
    account: null,
    needsSecret: false,
    live: { kind: "ready", value: {}, from: "provider", fetchedAt: 0, took: 1 },
    titles: { kind: "ready", value: {}, from: "provider", fetchedAt: 0, took: 1 },
  }) as Member;

const ready = (library: Library): Catalogue => ({ kind: "ready", library, failing: [] });

let container: ReturnType<typeof document.createElement>;
let root: Root;
let unmount = () => {};
function draw(node: React.ReactNode) {
  React.act(() => root.render(node));
}
function open(node: React.ReactNode = React.createElement(LiveHome)) {
  unmount();
  container = document.createElement("div");
  root = createRoot(container);
  draw(node);
  unmount = () => {
    React.act(() => root.unmount());
    unmount = () => {};
  };
}
const find = (testID: string) => container.querySelector(`[data-testid="${testID}"]`);
const has = (testID: string) => find(testID) !== null;
const count = (prefix: string) => container.querySelectorAll(`[data-testid^="${prefix}"]`).length;
const text = (testID?: string) => (testID ? find(testID) : container)?.textContent ?? "";
const rows = () =>
  [...container.querySelectorAll('[data-testid^="channel-"]')].map((row) =>
    row.getAttribute("data-testid")?.slice("channel-".length),
  );
function press(testID: string) {
  const button = find(testID) as { click(): void } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
}
const labels = () =>
  [...container.querySelectorAll("button[aria-label]")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
function pressLabel(label: string) {
  const button = container.querySelector(`button[aria-label="${label}"]`) as {
    click(): void;
  } | null;
  if (!button) throw new Error(`No ${label} on screen`);
  React.act(() => button.click());
}
/** Opens the country sheet and picks `option`. */
function country(option: string) {
  press("live-country");
  const sheet = scenario.sheet;
  const index = sheet?.options.findIndex((each) => each.replace("✓ ", "") === option) ?? -1;
  if (!sheet || index < 0) throw new Error(`No ${option} in the sheet`);
  React.act(() => sheet.choose(index));
}

beforeEach(() => {
  Object.assign(scenario, {
    members: [member("a", "Home"), member("b", "Cabin")],
    catalogue: ready(both),
    // A country an earlier build saved: Live no longer opens on it.
    saved: { region: "Belgium", recentChannels: [] },
    phase: { kind: "idle" },
    did: [],
    sheet: null,
  });
});
// Back to every country's All for the next test, as the viewer would set it.
afterEach(() => {
  scenario.catalogue = ready(both);
  open();
  country("All countries");
  press("tab-all");
  unmount();
});

describe("Live's All", () => {
  it("opens on every provider's channels in every country, each channel once", () => {
    open();
    expect(text("live-country")).toBe("All countries");
    expect(rows()).toEqual(["a:10", "b:10", "b:11", "a:11", "b:12", "a:12", "a:13"]);
    // Both providers list NOS Journaal: two rows, each naming its provider.
    expect(text("channel-a:10")).toContain("Netherlands · News · Home");
    expect(text("channel-b:10")).toContain("Netherlands · News · Cabin");
    expect(text("channel-b:11")).not.toContain("Cabin");
    expect(scenario.did).toEqual([]);
  });

  it("plays a row in Watch", () => {
    open();
    press("channel-a:12");
    expect(scenario.did).toEqual(["play a:12 in Watch"]);
  });
});

describe("For you", () => {
  it("leads with the channel watched last, playing it only on Play", () => {
    // The first key is the second stream of a:10: one channel, shown once.
    scenario.saved = { recentChannels: ["a:14", "b:11", "a:10"] };
    open();
    press("tab-for-you");
    expect(text("live-lead")).toContain("NOS Journaal");
    expect(text("live-lead")).toContain("Last watched · Netherlands · News · Home");
    expect(count("live-tile-a:10")).toBe(2); // Recent, and the News shelf
    expect(count("live-tile-b:11")).toBe(2);
    expect(scenario.did).toEqual([]);
    press("live-play");
    expect(scenario.did).toEqual(["play a:10 in Watch"]);
  });

  it("says how the channel it marks stands: connecting, paused or playing", () => {
    scenario.saved = { recentChannels: ["a:10"] };
    const item = {
      id: "a:10",
      subscriptionId: "a",
      title: "NOS Journaal",
      place: "Netherlands · News · Home",
      live: true,
      next: false,
      versions: false,
    };
    const shown = (kind: "loading" | "paused" | "playing") => {
      scenario.phase = { kind, item };
      open();
      press("tab-for-you");
      const lead = text("live-lead");
      const tile = text("live-tile-a:10");
      press("tab-all");
      return { lead, tile, row: text("channel-a:10") };
    };
    const words = ["Connecting", "Paused", "Playing"];
    for (const [kind, word] of [
      ["loading", "Connecting"],
      ["paused", "Paused"],
      ["playing", "Playing"],
    ] as const) {
      const { lead, tile, row } = shown(kind);
      for (const line of [lead, tile, row]) {
        expect(line).toContain(word);
        for (const other of words.filter((each) => each !== word)) {
          expect(line).not.toContain(other);
        }
      }
    }
    // Another channel keeps its place.
    expect(text("channel-b:10")).toContain("Netherlands · News · Cabin");
  });

  it("names its shelves by category and country, telling one name's providers apart", () => {
    open();
    press("tab-for-you");
    expect(has("live-lead")).toBe(false);
    expect(text()).not.toContain("Recent");
    expect(labels().filter((label) => /, all \d+$/.test(label))).toEqual([
      "News · Netherlands, all 3",
      "Sport · Netherlands, all 1",
      "Kids · Netherlands, all 1",
      "Sport · Belgium, all 2",
    ]);
    expect(text("live-tile-b:10")).toContain("Cabin");
    press("live-tile-a:12");
    expect(scenario.did).toEqual(["play a:12 in Watch"]);
  });

  it("opens a shelf's category by its country and name", () => {
    open();
    press("tab-for-you");
    pressLabel("News · Netherlands, all 3");
    expect(scenario.did).toEqual(["push /live/category?region=Netherlands&name=News"]);
  });
});

describe("the country", () => {
  it("filters Live, is named while chosen, and clears back to every country", () => {
    scenario.saved = { region: null, recentChannels: ["a:12"] };
    open();
    press("tab-for-you");
    country("Belgium");
    expect(scenario.saved.region).toBe("Belgium");
    // One category in Belgium: For you stays, with its shelf, as Live showed it.
    expect(text("live-country")).toBe("Belgium");
    expect(has("live-for-you")).toBe(true);
    expect(text("live-for-you")).toContain("Sport");
    expect(text("live-lead")).toContain("Sporza");
    press("tab-all");
    expect(rows()).toEqual(["a:11", "a:12"]);
    press("tab-for-you");

    press("live-country-clear");
    expect(text("live-country")).toBe("All countries");
    // For you again, as it was chosen.
    expect(has("live-for-you")).toBe(true);
    expect(text("live-lead")).toContain("Sporza");
  });

  it("shows All for a country with no category, and the tab Live showed once cleared", () => {
    for (const [tab, shown] of [
      ["tab-categories", "live-categories"],
      ["tab-for-you", "live-for-you"],
    ] as const) {
      open();
      press(tab);
      country("Other channels");
      // Its channels are in no category: no shelf or tile to show them, so All lists them.
      expect(text("live-country")).toBe("Other channels");
      expect(has("tab-for-you")).toBe(false);
      expect(rows()).toEqual(["a:13"]);
      press("live-country-clear");
      expect(has(shown)).toBe(true);
    }
    expect(scenario.did).toEqual([]);
  });

  it("leaves only All when every country together has one category", () => {
    scenario.catalogue = ready(
      buildLibrary([
        {
          subscriptionId: "a",
          label: "Home",
          catalogue: {
            categories: [{ id: "1", name: "NL | News" }],
            channels: [channel("10", "NL | NOS Journaal HD", ["1"])],
          },
        },
      ]),
    );
    open();
    expect(has("tab-for-you")).toBe(false);
    expect(has("tab-categories")).toBe(false);
    expect(rows()).toEqual(["a:10"]);
  });

  it("chosen, then gone after a refresh, says so over every country's channels", () => {
    open();
    country("Belgium");
    scenario.catalogue = ready(withoutBelgium);
    draw(React.createElement(LiveHome));
    expect(text()).toContain("Belgium isn't listed any more.");
    expect(text("live-country")).toBe("All countries");
    expect(rows()).toContain("a:10");
  });
});

describe("returning to Live", () => {
  it("shows the tab left, with every category as a tile", () => {
    open();
    press("tab-categories");
    unmount();
    open();
    expect(has("live-categories")).toBe(true);
    expect(labels()).toContain("Sport · Belgium, 2");
    press("live-category-a:1");
    expect(scenario.did).toEqual(["push /live/category?region=Netherlands&name=News"]);
  });
});

describe("a category's screen", () => {
  it("lists all its channels from every provider under its name", () => {
    open(React.createElement(CategoryScreen, { region: "Netherlands", name: "News" }));
    expect(text("live-category-list")).toContain("News · Netherlands");
    expect(rows()).toEqual(["a:10", "b:10", "b:11"]);
  });

  it("says a category no provider lists any more is gone", () => {
    open(React.createElement(CategoryScreen, { region: "Belgium", name: "Kids" }));
    expect(text()).toContain("This category isn't listed any more.");
  });
});
