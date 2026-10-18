import * as React from "react";
import { Window, type HTMLInputElement } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import type { Channel, Library } from "../src/library.ts";
import type { TitleLists } from "../src/titles.ts";

// Search over the tabs: what it finds opens where it belongs and closes Search first, the query
// stays for the session, and what hasn't loaded or failed says so instead of claiming nothing has
// the name. The real screen runs with React DOM on a happy-dom window, as provider-form.test.ts
// does, with channel search from library.ts; the stores it reads are set by each test, and title
// search finds titles whose name holds the query.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FoundTitle {
  readonly kind: "movie" | "series";
  readonly key: string;
  readonly id: string;
  readonly subscriptionId: string;
  readonly title: string;
}

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  catalogue: { kind: "loading" } as Catalogue,
  lists: { kind: "loading" } as TitleLists,
  titles: [] as FoundTitle[],
  /** What the screen did, in order. */
  did: [] as string[],
  /** What VoiceOver was given to read out. */
  said: [] as string[],
  /** The text size the viewer chose, as a multiple of the default. */
  fontScale: 1,
  /** The keyboard's listeners, by event. */
  keyboard: new Map<string, (event: { endCoordinates: { screenY: number } }) => void>(),
}));

vi.mock("react-native", async () => {
  const { createElement, Fragment, useEffect } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  /** A view, which lays out once, as a phone's area under the search field. */
  const View = ({
    children,
    testID,
    onLayout,
  }: Props & {
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 390, height: 600 } } });
    }, []);
    return createElement("div", { "data-testid": testID }, children);
  };
  type Style = { maxHeight?: number } | undefined;
  /** A scroll view, which shows the most height it may take. */
  const ScrollView = ({ children, testID, style }: Props & { style?: Style }) =>
    createElement("div", { "data-testid": testID, "data-max-height": style?.maxHeight }, children);
  type Section = { title: string; data: readonly unknown[] };
  return {
    View,
    ScrollView,
    Text: ({ children }: Props) => createElement("span", null, children),
    Image: () => null,
    Pressable: ({ children, testID, onPress }: Props & { onPress: () => void }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }, children),
    TextInput: ({
      value,
      onChangeText,
      testID,
    }: {
      value: string;
      onChangeText: (text: string) => void;
      testID: string;
    }) =>
      createElement("input", {
        value,
        "data-testid": testID,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value),
      }),
    SectionList: ({
      sections,
      renderItem,
      renderSectionHeader,
      ListHeaderComponent,
      ListEmptyComponent,
      testID,
    }: {
      testID?: string;
      sections: readonly Section[];
      renderItem: (info: { item: unknown }) => React.ReactNode;
      renderSectionHeader: (info: { section: Section }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListEmptyComponent?: React.ReactNode;
    }) =>
      createElement(
        "div",
        { "data-testid": testID },
        ListHeaderComponent,
        sections.length === 0
          ? ListEmptyComponent
          : sections.map((section) =>
              createElement(
                Fragment,
                { key: section.title },
                renderSectionHeader({ section }),
                section.data.map((item, at) =>
                  createElement(Fragment, { key: at }, renderItem({ item })),
                ),
              ),
            ),
      ),
    Animated: {
      View: box,
      Value: class {},
      timing: () => ({ start: () => undefined }),
    },
    StyleSheet: { create: <T>(styles: T) => styles },
    AccessibilityInfo: {
      announceForAccessibilityWithOptions: (text: string) => scenario.said.push(text),
    },
    AppState: { currentState: "active", addEventListener: () => undefined },
    Keyboard: {
      addListener: (
        event: string,
        listener: (event: { endCoordinates: { screenY: number } }) => void,
      ) => {
        scenario.keyboard.set(event, listener);
        return { remove: () => scenario.keyboard.delete(event) };
      },
      scheduleLayoutAnimation: () => undefined,
    },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: scenario.fontScale }),
  };
});
vi.mock("expo-router", () => ({
  router: {
    back: () => scenario.did.push("back"),
    dismiss: (count: number) => scenario.did.push(`dismiss ${count}`),
    canGoBack: () => true,
    replace: (href: string) => scenario.did.push(`replace ${href}`),
    push: (href: string) => scenario.did.push(`push ${href}`),
  },
  useIsFocused: () => true,
  // Live is the tab under Search.
  useRootNavigationState: () => ({
    index: 1,
    routes: [
      { name: "(tabs)", state: { index: 1, routes: [{ name: "(home)" }, { name: "live" }] } },
      { name: "search" },
    ],
  }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  useCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel, _place: string, options: { watch: boolean }) =>
    scenario.did.push(`play ${channel.key}${options.watch ? " in Watch" : ""}`),
  retry: (id: string) => scenario.did.push(`retry ${id}`),
}));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  useMetadataVersion: () => 0,
  searchTitles: (_index: unknown, kind: string, query: string) => {
    const titles = scenario.titles.filter(
      (title) => title.kind === kind && title.title.toLowerCase().includes(query.toLowerCase()),
    );
    return { total: titles.length, titles };
  },
  titleCount: (_index: unknown, kind: string) =>
    scenario.titles.filter((title) => title.kind === kind).length,
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: (title: FoundTitle) => scenario.did.push(`details ${title.kind} ${title.id}`),
}));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({ phase: { kind: "idle" } }),
  playingChannel: () => null,
}));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    useReduceMotion: () => false,
    useMotionAllowed: () => false,
    Glass: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children),
  };
});
vi.mock("../src/telemetry/index.ts", () => ({ onSearchText: () => undefined }));
vi.mock("../src/titles-ui.tsx", () => ({ Artwork: () => null }));
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#A1A1A6", fill: "#1C1C1E", line: "#2C2C2E" },
    useRowHeight: () => 60,
    ChannelRow: ({ channel, onPress }: { channel: Channel; onPress: (c: Channel) => void }) =>
      createElement(
        "button",
        { "data-testid": `channel-${channel.key}`, onClick: () => onPress(channel) },
        channel.title,
      ),
    TextButton: ({ label, onPress }: { label: string; onPress: () => void }) =>
      createElement("button", { "data-testid": `text-${label}`, onClick: onPress }, label),
  };
});

const { default: Search } = await import("../src/app/search.tsx");

const member = (id: string, label: string, standing: Partial<Member> = {}): Member =>
  ({
    entry: { id },
    label,
    account: null,
    needsSecret: false,
    live: { kind: "ready", value: {}, took: 1 },
    titles: { kind: "ready", value: {}, took: 1 },
    ...standing,
  }) as Member;

const channels = [
  { key: "a:1", title: "NPO 1" },
  { key: "a:2", title: "BBC One" },
] as unknown as Channel[];
const library = {
  regions: [{ name: "Netherlands", channels, shelves: [] }],
  byKey: new Map(),
  placeOf: new Map(),
} as unknown as Library;
const ready: Catalogue = { kind: "ready", library, failing: [] };
const indexed = { kind: "ready", index: {} } as TitleLists;
const dune: FoundTitle = {
  kind: "movie",
  key: "a:7",
  id: "7",
  subscriptionId: "a",
  title: "Dune",
};

let container: ReturnType<typeof document.createElement>;
let unmount = () => {};
function open() {
  container = document.createElement("div");
  const root = createRoot(container);
  React.act(() => root.render(React.createElement(Search)));
  unmount = () => React.act(() => root.unmount());
}
const field = () => container.querySelector('[data-testid="search-field"]') as HTMLInputElement;
function type(text: string) {
  React.act(() => {
    const input = field();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function press(testID: string) {
  const button = container.querySelector(`[data-testid="${testID}"]`) as {
    click(): void;
  } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
}
const text = () => container.textContent ?? "";

beforeEach(() => {
  Object.assign(scenario, {
    members: [member("a", "Northwind")],
    catalogue: ready,
    lists: indexed,
    titles: [dune],
    did: [],
    said: [],
    fontScale: 1,
  });
  scenario.keyboard.clear();
});
afterEach(() => unmount());

describe("Search over the tabs", () => {
  it("closes before a movie opens in Movies, and before a channel plays in Watch", () => {
    open();
    type("dune");
    press("search-title-7");
    type("npo");
    press("channel-a:1");
    expect(scenario.did).toEqual(["back", "details movie 7", "back", "play a:1 in Watch"]);
  });

  it("opens again on the query it closed with", () => {
    open();
    type("bbc");
    press("text-Cancel");
    unmount();
    open();
    expect(field().value).toBe("bbc");
    expect(text()).toContain("BBC One");
  });

  it("says what still loads, not that nothing has the name", () => {
    scenario.members = [
      member("a", "Northwind"),
      member("b", "Southwind", { titles: { kind: "loading", last: null } }),
    ];
    scenario.lists = { kind: "loading" };
    open();
    type("npo");
    expect(text()).toContain(
      "Movies and series still loading, 1 of 2 providers. Channels searched.",
    );
    expect(text()).toContain("NPO 1");
    type("zzq");
    expect(text()).not.toContain("Nothing named");
    // Read out once, not again for each search while the lists stand as they were.
    expect(scenario.said).toEqual([
      "Movies and series still loading, 1 of 2 providers. Channels searched.",
    ]);
  });

  /** Two providers in trouble: Northwind's channels didn't update, Southwind lost its password. */
  const troubled = () => [
    member("a", "Northwind", {
      live: { kind: "failed", error: { kind: "unexpected", detail: "" }, last: {}, since: 0 },
    } as Partial<Member>),
    member("b", "Southwind", { needsSecret: true }),
  ];
  /** The keyboard covering the bottom of an 844-point window from `top` down, or going away. */
  const keyboardTo = (top: number) =>
    React.act(() =>
      scenario.keyboard.get("keyboardWillChangeFrame")?.({ endCoordinates: { screenY: top } }),
    );
  const keyboardDown = () =>
    React.act(() =>
      scenario.keyboard.get("keyboardWillHide")?.({ endCoordinates: { screenY: 844 } }),
    );
  const statusLine = () => container.querySelector('[data-testid="status-line"]');
  /** Where the line is: at the bottom with the most height it may take, or leading the results. */
  const placed = () => {
    const line = statusLine();
    if (!line) return null;
    return container.querySelector('[data-testid="search-list"]')!.contains(line)
      ? "results"
      : `bottom ${line.getAttribute("data-max-height")}`;
  };

  it("keeps its line, Retry and Settings in one scroll that the keyboard shrinks and frees", () => {
    scenario.members = troubled();
    open();
    type("dune");
    const open600 = placed();
    expect(open600).toMatch(/^bottom \d/);
    // The keyboard takes the bottom 400 of the window, leaving 200 of the 600 under the field.
    keyboardTo(444);
    const shrunk = Number(placed()!.split(" ")[1]);
    expect(shrunk).toBeGreaterThan(0);
    expect(shrunk).toBeLessThan(200 / 2);
    expect(shrunk).toBeLessThan(Number(open600!.split(" ")[1]));
    const panel = statusLine()!;
    expect(panel.textContent).toContain("Enter the password for Southwind in Settings.");
    // Retry and Settings are in that same bounded scroll.
    expect(panel.textContent).toMatch(/searched\.RetrySettings$/);
    expect(text()).toContain("Dune");
    press("text-Retry");
    press("text-Settings");
    expect(scenario.did).toEqual(["retry a", "dismiss 1", "push /live/settings"]);

    // With the keyboard down the line has its room again.
    keyboardDown();
    expect(placed()).toBe(open600);
  });

  it("leads the results with its line where the bottom can't show a whole line of it", () => {
    scenario.members = troubled();
    // The largest accessibility text size.
    scenario.fontScale = 3.1;
    open();
    type("dune");
    expect(placed()).toMatch(/^bottom \d/);
    // The keyboard leaves 200 points under the field: at this size its share there would be
    // less than a line, so the line moves above the results, whole, and they keep the rest.
    keyboardTo(444);
    expect(placed()).toBe("results");
    expect(statusLine()!.textContent).toMatch(
      /^Couldn't load channels from Northwind\..*RetrySettings$/,
    );
    expect(text()).toContain("Dune");
    press("text-Retry");
    press("text-Settings");
    expect(scenario.did).toEqual(["retry a", "dismiss 1", "push /live/settings"]);
    // A keyboard over the whole area still leaves the line, and the results, in the one scroll.
    keyboardTo(200);
    expect(placed()).toBe("results");
    expect(text()).toContain("Dune");
    // Down again, the line returns to the bottom, and it was read out once throughout.
    keyboardDown();
    expect(placed()).toMatch(/^bottom \d/);
    expect(scenario.said).toHaveLength(1);
  });

  it("says it is searching while the latest text waits, keeping the last results", () => {
    open();
    type("dun");
    const shown: string[] = [];
    const observer = new window.MutationObserver(() => undefined);
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    type("dune");
    for (const record of observer.takeRecords()) {
      for (const node of record.addedNodes) shown.push(node.textContent ?? "");
    }
    observer.disconnect();
    expect(shown.some((each) => each.includes("Searching."))).toBe(true);
    // Once searched, the line goes and Dune is still there.
    expect(text()).not.toContain("Searching.");
    expect(text()).toContain("Dune");
    expect(scenario.said).toEqual([]);
  });

  it("names a provider that failed, retries it, and opens Settings on the tab under Search", () => {
    scenario.members = [
      member("a", "Northwind"),
      member("b", "Southwind", {
        titles: { kind: "failed", error: { kind: "unexpected", detail: "" }, last: null, since: 0 },
      }),
    ];
    open();
    type("dune");
    expect(text()).toContain(
      "Couldn't load movies and series from Southwind. Movies, series and channels searched.",
    );
    expect(text()).toContain("Dune");
    press("text-Retry");
    press("text-Settings");
    // Search closes, then Settings goes on Live's own stack (tab-routes.test.ts).
    expect(scenario.did).toEqual(["retry b", "dismiss 1", "push /live/settings"]);
  });

  it("doesn't say nothing has the name when a provider's lists failed", () => {
    scenario.members = [
      member("a", "Northwind", {
        live: { kind: "failed", error: { kind: "unexpected", detail: "" }, last: null, since: 0 },
      }),
    ];
    scenario.catalogue = {
      kind: "failed",
      error: { kind: "unexpected", detail: "" },
      member: scenario.members[0]!,
    };
    open();
    type("zzq");
    expect(text()).toContain("Couldn't load channels from Northwind. Movies and series searched.");
    expect(text()).not.toContain("Nothing named");
  });

  it("says nothing has the name only with everything in, and how much it looked through", () => {
    open();
    type("zzq");
    expect(text()).toContain('Nothing named "zzq".');
    expect(text()).toContain("Searched 2 channels, 1 movie and 0 series.");
  });
});
