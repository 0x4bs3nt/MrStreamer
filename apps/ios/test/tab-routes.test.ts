import { beforeEach, describe, expect, it, vi } from "vitest";

// Where the top bar's destinations go, from a tab and from over Search: which tab navigation's
// state has under what shows, and what the router is asked, in order. The router's own handling of
// those requests (a POP, then a PUSH onto the existing tab's stack) is Expo Router's, and was
// checked against its installed reducers outside this suite, which CI runs without the iOS install.

const asked = vi.hoisted(() => [] as string[]);
vi.mock("expo-router", () => ({
  router: {
    dismiss: (count: number) => asked.push(`dismiss ${count}`),
    push: (href: string) => asked.push(`push ${href}`),
  },
}));
vi.mock("react-native", () => ({
  Image: () => null,
  Text: () => null,
  View: () => null,
  StyleSheet: { create: <T>(styles: T) => styles },
}));
vi.mock("../src/ui.tsx", () => ({ colors: { text: "#FFFFFF" } }));

const { openOnTabs, tabsAt } = await import("../src/header.tsx");

const TABS = ["(home)", "live", "films", "series"].map((name) => ({ name }));
/** The root stack: the tabs on `tab`, with `over` above them. */
const root = (tab: string, over: readonly string[] = []) => ({
  index: over.length,
  routes: [
    { name: "(tabs)", state: { index: TABS.findIndex((each) => each.name === tab), routes: TABS } },
    ...over.map((name) => ({ name })),
  ],
});

/** Opens `screen` from `state` and says what the router was asked. */
function open(state: Parameters<typeof tabsAt>[0], screen: "settings" | "downloads") {
  const at = tabsAt(state);
  if (!at) throw new Error("No tabs");
  openOnTabs(at, screen);
  return asked;
}

beforeEach(() => {
  asked.length = 0;
});

describe("the top bar's destinations", () => {
  it("close Search first, then open on the tab under it", () => {
    expect(open(root("live", ["search"]), "settings")).toEqual([
      "dismiss 1",
      "push /live/settings",
    ]);
  });

  it("open straight on the tab showing, Home's at the root", () => {
    expect(open(root("films"), "downloads")).toEqual(["push /films/downloads"]);
    asked.length = 0;
    expect(open(root("(home)"), "settings")).toEqual(["push /settings"]);
  });

  it("go by the tabs nearest under what shows, not the first in history", () => {
    const twice = {
      index: 2,
      routes: [
        { name: "(tabs)", state: { index: 0, routes: TABS } },
        { name: "search" },
        { name: "(tabs)", state: { index: 1, routes: TABS } },
      ],
    };
    expect(tabsAt(twice)).toEqual({ tab: "live", above: 0 });
  });

  it("find no tabs with no provider saved, where the root shows Connect and offline Downloads", () => {
    expect(tabsAt({ index: 1, routes: [{ name: "connect" }, { name: "offline" }] })).toBeNull();
  });
});
