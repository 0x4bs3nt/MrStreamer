import * as React from "react";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import type { LiveCatalogue, OnDemandCatalogue, ProviderTitle } from "@mrstreamer/core/provider";
import { Window, type HTMLInputElement } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import { buildLibrary, type Channel, type Library } from "../src/library.ts";

// Search over the tabs: what it finds opens where it belongs and closes Search first, the query
// stays for the session, every movie and series that matches can be reached a page at a time, and
// what hasn't loaded or failed says so instead of claiming nothing has the name. The real screen
// runs with React DOM on a happy-dom window, as provider-form.test.ts does, with channel search
// from library.ts and movies and series from the real title owner (titles.ts): each test gives
// the subscriptions' lists, which it indexes as the app does, and TMDB's names stand in for its
// metadata store. Nothing here asks a provider for anything; a request would show in `did`.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document, Event } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  dismissed: 0,
  downloads: { items: [], series: {}, bytes: 0, free: null, ended: 0 } as DownloadList,
  opened: [] as Title[],
  presses: new Map<string, () => void>(),
  members: [] as Member[],
  /** Who listens to the subscriptions changing: the title owner. */
  roster: new Set<() => void>(),
  catalogue: { kind: "loading" } as Catalogue,
  /** TMDB's name of each title in the viewer's language, by TMDB id, once its metadata came. */
  tmdbNames: new Map<string, string>(),
  /** The title owner's notice of what the metadata store learned. */
  notify: null as ((change: { content: boolean }) => void) | null,
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
    style,
  }: Props & {
    style?: { width?: string } | ({ width?: string } | undefined)[];
    onLayout?: (event: { nativeEvent: { layout: { width: number; height: number } } }) => void;
  }) => {
    useEffect(() => {
      onLayout?.({ nativeEvent: { layout: { width: 390, height: 600 } } });
    }, []);
    const width = (Array.isArray(style) ? style.find((part) => part?.width !== undefined) : style)
      ?.width;
    return createElement("div", { "data-testid": testID, "data-width": width }, children);
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
    Pressable: ({ children, testID, onPress }: Props & { onPress: () => void }) => {
      if (testID) scenario.presses.set(testID, onPress);
      return createElement("button", { "data-testid": testID, onClick: onPress }, children);
    },
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
      renderSectionFooter,
      ListHeaderComponent,
      ListEmptyComponent,
      testID,
    }: {
      testID?: string;
      sections: readonly Section[];
      renderItem: (info: { item: unknown }) => React.ReactNode;
      renderSectionHeader: (info: { section: Section }) => React.ReactNode;
      renderSectionFooter?: (info: { section: Section }) => React.ReactNode;
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
                renderSectionFooter?.({ section }),
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
      dismiss: () => {
        scenario.dismissed++;
      },
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
vi.mock("../src/downloads.ts", () => ({ useDownloads: () => scenario.downloads }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../src/account.ts", () => ({
  currentRoster: () => ({ kind: "ready", members: scenario.members }),
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  useCatalogue: () => scenario.catalogue,
  playChannel: (channel: Channel, _place: string, options: { watch: boolean }) =>
    scenario.did.push(`play ${channel.key}${options.watch ? " in Watch" : ""}`),
  retry: (id: string) => scenario.did.push(`retry ${id}`),
  // What the title owner reads of the subscriptions. No launch is reading saved lists here.
  members: () => scenario.members,
  onRoster: (listener: () => void) => {
    scenario.roster.add(listener);
    return () => scenario.roster.delete(listener);
  },
  shownOf: (titles: { kind: string; value?: unknown; last?: unknown }) =>
    titles.kind === "ready" ? titles.value : (titles.last ?? null),
  readingSaved: () => false,
  onReadingSaved: () => () => undefined,
  onSavable: () => () => undefined,
}));
vi.mock("expo-file-system", () => ({
  File: class {},
  Directory: class {},
  Paths: { cache: "/c" },
}));
vi.mock("../src/sources.ts", () => ({
  currentSource: (id: string) => void scenario.did.push(`provider ${id}`),
  sourceOf: (id: string) => {
    scenario.did.push(`provider ${id}`);
    throw new Error(`${id} isn't signed in`);
  },
}));
vi.mock("../src/viewing.ts", () => ({ serveViewing: () => undefined }));
vi.mock("../src/watchlist.ts", () => ({
  alignWatchlist: () => undefined,
  serveWatchlist: () => undefined,
}));
vi.mock("@mrstreamer/core/metadata/store", () => ({
  metadataStore: (deps: { onChange: (change: { content: boolean }) => void }) => {
    scenario.notify = deps.onChange;
    return {
      get: () => null,
      name: (_kind: string, id: string) => {
        const name = scenario.tmdbNames.get(id);
        return name ? { name, original: null } : null;
      },
      searchName: () => "",
      searchAliases: () => [],
      services: () => [],
      expiresAt: () => Infinity,
      want: () => undefined,
      status: () => null,
    };
  },
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: (title: Title) => {
    scenario.opened.push(title);
    scenario.did.push(`details ${title.kind} ${title.id}`);
  },
}));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({ phase: { kind: "idle" } }),
  channelStatus: () => null,
}));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    useReduceMotion: () => false,
    useMotionAllowed: () => false,
    Glass: ({ children }: { children?: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({
      label,
      onPress,
      testID,
    }: {
      label: string;
      onPress: () => void;
      testID: string;
    }) =>
      createElement(
        "button",
        { "aria-label": label, "data-testid": testID, onClick: onPress },
        label,
      ),
  };
});
vi.mock("../src/telemetry/index.ts", () => ({ onSearchText: () => undefined }));
vi.mock("../src/titles-ui.tsx", () => ({ Artwork: () => null }));
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#A1A1A6", fill: "#1C1C1E", line: "#2C2C2E" },
    useRowHeight: () => 60,
    ChannelRow: ({ channel, onPress }: { channel: Channel; onPress: (c: Channel) => void }) => {
      scenario.presses.set(`channel-${channel.key}`, () => onPress(channel));
      return createElement(
        "button",
        { "data-testid": `channel-${channel.key}`, onClick: () => onPress(channel) },
        channel.title,
      );
    },
    TextButton: ({ label, onPress }: { label: string; onPress: () => void }) => {
      scenario.presses.set(`text-${label}`, onPress);
      return createElement("button", { "data-testid": `text-${label}`, onClick: onPress }, label);
    },
  };
});

const { default: Search } = await import("../src/app/search.tsx");
const { titlesWorkedOut } = await import("../src/titles.ts");

/** When the newest title of a list was added; each one after it a day before. */
const NEWEST = Date.UTC(2026, 9, 1);

/**
 * A provider's titles of `kind` named "`name` 1" to "`name` `count`", with ids `prefix`1 on, the
 * first added last: equally good matches, search ranks the most recently added first, so this is
 * the order it finds them in.
 */
const titled = (kind: TitleKind, prefix: string, name: string, count: number, start = 0) =>
  Array.from({ length: count }, (_, at): ProviderTitle => ({
    id: `${prefix}${at + 1}`,
    name: `${name} ${at + 1}`,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: NEWEST - (start + at) * 86_400_000,
    releaseDate: null,
    categoryIds: [],
    adult: false,
    container: kind === "movie" ? "mp4" : null,
  }));

/** A provider's movie and series lists. */
const lists = (
  movies: readonly ProviderTitle[],
  series: readonly ProviderTitle[] = [],
): OnDemandCatalogue => ({ movieCategories: [], movies, seriesCategories: [], series });

/** Northwind's lists: Dune, and nothing else. */
const duneOnly = () => lists([{ ...titled("movie", "", "", 1)[0]!, id: "7", name: "Dune" }]);

const liveLists: LiveCatalogue = {
  categories: [],
  channels: ["NPO 1", "BBC One"].map((name, index) => ({
    id: String(index + 1),
    name,
    number: index + 1,
    logoUrl: null,
    categoryIds: [],
    guideId: null,
    catchupDays: null,
  })),
};
const emptyLive: LiveCatalogue = { categories: [], channels: [] };

const member = (
  id: string,
  label: string,
  standing: Partial<Member> = {},
  titles: OnDemandCatalogue = lists([]),
): Member =>
  ({
    entry: { id },
    label,
    account: null,
    needsSecret: false,
    live: { kind: "ready", value: liveLists, from: "provider", fetchedAt: 0, took: 1 },
    titles: { kind: "ready", value: titles, from: "provider", fetchedAt: 0, took: 1 },
    ...standing,
  }) as Member;

/**
 * The subscriptions as they now stand: the title owner hears of it and indexes the lists that
 * show, as it does in the app, and this waits until they show.
 */
async function subscriptions(members: Member[]) {
  scenario.members = members;
  await React.act(async () => {
    for (const listener of [...scenario.roster]) listener();
    await vi.waitFor(() => {
      if (!titlesWorkedOut()) throw new Error("Still indexing");
    });
  });
  if (activeRoot) {
    React.act(() => render());
    await settled();
  }
}

const channels = [
  { key: "a:1", title: "NPO 1" },
  { key: "a:2", title: "BBC One" },
] as unknown as Channel[];
const library = {
  regions: [{ name: "Netherlands", channels, shelves: [] }],
  channels,
  byKey: new Map(),
  placeOf: new Map(),
  labels: new Map(),
} as unknown as Library;
const ready: Catalogue = { kind: "ready", library, failing: [] };

let container: ReturnType<typeof document.createElement>;
let activeRoot = false;
let render = () => {};
let unmount = () => {};
function startOpen() {
  container = document.createElement("div");
  const root = createRoot(container);
  render = () => root.render(React.createElement(Search));
  React.act(render);
  activeRoot = true;
  unmount = () => {
    React.act(() => root.unmount());
    activeRoot = false;
  };
}
const field = () => container.querySelector('[data-testid="search-field"]') as HTMLInputElement;
function startType(text: string) {
  React.act(() => {
    const input = field();
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function startPress(testID: string) {
  const button = container.querySelector(`[data-testid="${testID}"]`) as {
    click(): void;
  } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
}
/** Wait for query work, including React's publication, without pretending DOM is native paint. */
async function settled() {
  for (let attempt = 0; attempt < 100; attempt++) {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (!text().includes("Searching.")) return;
  }
  throw new Error("Search did not settle");
}
async function open() {
  startOpen();
  await settled();
}
async function type(text: string) {
  startType(text);
  await settled();
}
async function press(testID: string) {
  startPress(testID);
  await settled();
}
const text = () => container.textContent ?? "";

beforeEach(async () => {
  Object.assign(scenario, {
    catalogue: ready,
    did: [],
    opened: [],
    said: [],
    fontScale: 1,
    dismissed: 0,
    downloads: { items: [], series: {}, bytes: 0, free: null, ended: 0 },
  });
  scenario.presses.clear();
  scenario.keyboard.clear();
  scenario.tmdbNames.clear();
  await subscriptions([]);
  await subscriptions([member("a", "Northwind", {}, duneOnly())]);
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

describe("Search over the tabs", () => {
  it("opens the live queue on its original tab and keeps the query for the next search", async () => {
    scenario.downloads = {
      ...scenario.downloads,
      items: [
        {
          id: "d-1",
          name: "Paper Harbor",
          title: { kind: "movie", id: "1" },
          subscription: { id: "a", name: "Northwind" },
          status: { kind: "queued" },
          episodeName: null,
          year: null,
          duration: null,
          originalLanguage: null,
          posterUrl: null,
          wideUrl: null,
          size: null,
          progress: null,
          series: null,
        },
      ],
    };
    await open();
    await type("dune");
    expect(container.querySelector('[data-testid="search-downloads"]')?.textContent).toBe("1");
    await press("search-downloads");
    expect(scenario.did.slice(-2)).toEqual(["dismiss 1", "push /live/downloads"]);
    expect(scenario.dismissed).toBe(1);
    unmount();
    scenario.downloads = { ...scenario.downloads, items: [] };
    await open();
    expect(field().value).toBe("dune");
    expect(container.querySelector('[data-testid="search-downloads"]')).toBeNull();
  });

  it("closes before a title opens in Movies or Series, and before a channel plays in Watch", async () => {
    const prophecy = { ...titled("series", "p", "", 1)[0]!, name: "Dune Prophecy" };
    await subscriptions([member("a", "Northwind", {}, lists(duneOnly().movies, [prophecy]))]);
    await open();
    await type("dune");
    await press("search-title-7");
    unmount();
    await open();
    await press("search-title-p1");
    unmount();
    await open();
    await type("npo");
    await press("channel-a:1");
    expect(scenario.did).toEqual([
      "back",
      "details movie 7",
      "back",
      "details series p1",
      "back",
      "play a:1 in Watch",
    ]);
  });

  it("opens again on the query it closed with", async () => {
    await open();
    await type("bbc");
    await press("text-Cancel");
    unmount();
    await open();
    expect(field().value).toBe("bbc");
    expect(text()).toContain("BBC One");
  });

  it("says what still loads, not that nothing has the name", async () => {
    await subscriptions([
      member("a", "Northwind", {}, duneOnly()),
      member("b", "Southwind", { titles: { kind: "loading", last: null } }),
    ]);
    await open();
    await type("npo");
    const loading =
      "Movies and series still loading, 1 of 2 providers. Movies, series and channels searched.";
    expect(text()).toContain(loading);
    expect(text()).toContain("NPO 1");
    // What Northwind lists is searched meanwhile.
    await type("dune");
    expect(text()).toContain("Dune");
    await type("zzq");
    expect(text()).not.toContain("Nothing named");
    // Read out once, not again for each search while the lists stand as they were.
    expect(scenario.said).toEqual([loading]);
  });

  /** Two providers in trouble: Northwind's channels didn't update, Southwind lost its password. */
  const troubled = () =>
    subscriptions([
      member(
        "a",
        "Northwind",
        {
          live: {
            kind: "failed",
            error: { kind: "unexpected", detail: "" },
            last: liveLists,
            since: 0,
          },
        } as Partial<Member>,
        duneOnly(),
      ),
      member("b", "Southwind", { needsSecret: true }),
    ]);
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

  it("keeps its line, Retry and Settings in one scroll that the keyboard shrinks and frees", async () => {
    await troubled();
    await open();
    await type("dune");
    const open600 = placed();
    expect(open600).toMatch(/^bottom \d/);
    // The keyboard takes the bottom 400 of the window, leaving 200 of the 600 under the field.
    keyboardTo(444);
    const shrunk = Number(placed()!.split(" ")[1]);
    expect(shrunk).toBeGreaterThan(0);
    expect(shrunk).toBeLessThan(200 / 2);
    expect(shrunk).toBeLessThan(Number(open600!.split(" ")[1]));
    const panel = statusLine()!;
    expect(panel.textContent).toContain("Southwind needs a password");
    // Retry and Settings are in that same bounded scroll.
    expect(panel.textContent).toContain("DetailsRetry");
    expect(text()).toContain("Dune");
    await press("text-Retry");
    // With the keyboard down the line has its room again, before Details closes Search.
    keyboardDown();
    expect(placed()).toBe(open600);
    await press("text-Details");
    expect(scenario.did).toEqual(["retry a", "dismiss 1", "push /live/settings"]);
  });

  it("leads the results with its line where the bottom can't show a whole line of it", async () => {
    await troubled();
    // The largest accessibility text size.
    scenario.fontScale = 3.1;
    await open();
    await type("dune");
    expect(placed()).toMatch(/^bottom \d/);
    // The keyboard leaves 200 points under the field: at this size its share there would be
    // less than a line, so the line moves above the results, whole, and they keep the rest.
    keyboardTo(444);
    expect(placed()).toBe("results");
    expect(statusLine()!.textContent).toMatch(
      /^Northwind unavailable\. Southwind needs a password.*DetailsRetry/,
    );
    expect(text()).toContain("Dune");
    await press("text-Retry");
    // A keyboard over the whole area still leaves the line, and the results, in the one scroll.
    keyboardTo(200);
    expect(placed()).toBe("results");
    expect(text()).toContain("Dune");
    // Down again, the line returns to the bottom, and it was read out once throughout.
    keyboardDown();
    expect(placed()).toMatch(/^bottom \d/);
    expect(scenario.said).toHaveLength(1);
    await press("text-Details");
    expect(scenario.did).toEqual(["retry a", "dismiss 1", "push /live/settings"]);
  });

  it("says it is searching until the current text has results", async () => {
    await open();
    await type("dun");
    startType("dune");
    expect(text()).toContain("Searching.");
    expect(text()).not.toContain("Nothing named");
    await settled();
    expect(text()).not.toContain("Searching.");
    expect(text()).toContain("Dune");
    expect(scenario.said).toEqual([]);
  });

  it("replaces pending text, clears immediately and rejects a previously displayed result tap", async () => {
    await open();
    await type("dune");
    // An onPress already sent by native may arrive after its row's query was replaced.
    const oldTap = scenario.presses.get("search-title-7")!;
    vi.useFakeTimers();
    startType("bbc");
    React.act(oldTap);
    expect(scenario.did).toEqual([]);
    expect(text()).toContain("Searching.");
    expect(text()).not.toContain("Dune");
    startType("npo");
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).toContain("NPO 1");
    expect(text()).not.toContain("BBC One");
    const oldChannelTap = scenario.presses.get("channel-a:1")!;
    startType("bbc");
    startType("");
    expect(field().value).toBe("");
    expect(text()).not.toMatch(/Searching\.|NPO 1|BBC One|Nothing named/);
    React.act(oldChannelTap);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).not.toMatch(/NPO 1|BBC One|Nothing named/);
    // No browse navigation, playback or provider requests came from typing or old taps.
    expect(scenario.did).toEqual([]);
    startPress("text-Cancel");
    expect(scenario.dismissed).toBe(1);
    unmount();
    startOpen();
    expect(field().value).toBe("");
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).not.toMatch(/NPO 1|BBC One|Nothing named/);
  });

  it("restarts a query that replaces itself within one native input batch", async () => {
    await open();
    await type("dune");
    const oldTap = scenario.presses.get("search-title-7")!;
    vi.useFakeTimers();
    React.act(() => {
      startType("bbc");
      startType("dune");
      oldTap();
    });
    expect(scenario.did).toEqual([]);
    expect(field().value).toBe("dune");
    expect(text()).toContain("Searching.");
    expect(text()).not.toContain("Dune");
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).toContain("Dune");
    startPress("search-title-7");
    expect(scenario.did).toEqual(["back", "details movie 7"]);
  });

  it("cancels before pending work completes and reopens on the retained query without old work", async () => {
    await open();
    await type("npo");
    const oldTap = scenario.presses.get("channel-a:1")!;
    vi.useFakeTimers();
    startType("dune");
    startPress("text-Cancel");
    expect(scenario.did).toEqual(["back"]);
    expect(scenario.dismissed).toBe(1);
    React.act(oldTap);
    // Deliberately keep the dismissed screen mounted until its pending tasks drain.
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).not.toContain("Dune");
    expect(scenario.did).toEqual(["back"]);
    unmount();
    startOpen();
    expect(field().value).toBe("dune");
    startType("bbc");
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).toContain("BBC One");
    expect(text()).not.toContain("Dune");
    expect(scenario.did).toEqual(["back"]);
  });

  it("abandons work when the native Back gesture unmounts Search", async () => {
    await open();
    vi.useFakeTimers();
    startType("dune");
    expect(text()).toContain("Searching.");
    unmount();
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(container.textContent).toBe("");
    expect(scenario.did).toEqual([]);
    startOpen();
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).toContain("Dune");
  });

  it("names a provider that failed, retries it, and opens Settings on the tab under Search", async () => {
    // Southwind's lists didn't load again: what it listed before is still searched.
    const before = lists([], [{ ...titled("series", "p", "", 1)[0]!, name: "Dune Prophecy" }]);
    await subscriptions([
      member("a", "Northwind", {}, duneOnly()),
      member("b", "Southwind", {
        titles: {
          kind: "failed",
          error: { kind: "unexpected", detail: "" },
          last: before,
          since: 0,
        },
      }),
    ]);
    await open();
    await type("dune");
    expect(text()).toContain("Southwind unavailable. Movies, series and channels searched.");
    expect(text()).toContain("Dune");
    expect(text()).toContain("Dune Prophecy");
    await press("text-Retry");
    await press("text-Details");
    // Search closes, then Settings goes on Live's own stack (tab-routes.test.ts).
    expect(scenario.did).toEqual(["retry b", "dismiss 1", "push /live/settings"]);
  });

  it("doesn't say nothing has the name when a provider's lists failed", async () => {
    await subscriptions([
      member("a", "Northwind", {
        live: { kind: "failed", error: { kind: "unexpected", detail: "" }, last: null, since: 0 },
      }),
    ]);
    scenario.catalogue = {
      kind: "failed",
      error: { kind: "unexpected", detail: "" },
      member: scenario.members[0]!,
    };
    await open();
    await type("zzq");
    expect(text()).toContain("Couldn't load channels from Northwind.RetrySettings");
    expect(placed()).toBe("results");
    expect(container.querySelector('[data-testid="dismiss-provider-notice"]')).toBeNull();
    expect(text()).not.toContain("Nothing named");
  });

  const failure = { kind: "unexpected", detail: "" } as const;
  const failedLive = (last: LiveCatalogue | null = liveLists, since = 0): Member["live"] => ({
    kind: "failed",
    error: failure,
    last,
    since,
  });
  const failedTitles = (last: OnDemandCatalogue | null = duneOnly()): Member["titles"] => ({
    kind: "failed",
    error: failure,
    last,
    since: 0,
  });
  const notice = () => container.querySelector('[data-testid="dismiss-provider-notice"]');

  it("keeps inline recovery for globally filtered-empty channels and published title collections", async () => {
    const rawLive: LiveCatalogue = {
      categories: [{ id: "adult", name: "Adult" }],
      channels: [{ ...liveLists.channels[0]!, categoryIds: ["adult"] }],
    };
    const hidden = { ...titled("movie", "hidden", "Restricted", 1)[0]!, adult: true };
    const rawTitles = lists([hidden], [{ ...hidden, container: null }]);
    const derived = buildLibrary([{ subscriptionId: "a", label: "Northwind", catalogue: rawLive }]);
    expect(derived.channels).toHaveLength(0);
    await subscriptions([
      member("a", "Northwind", { live: failedLive(rawLive), titles: failedTitles(rawTitles) }),
    ]);
    scenario.catalogue = { kind: "ready", library: derived, failing: scenario.members };
    await open();
    await type("unmatched");
    expect(text()).toContain("Couldn't update channels, movies and series from Northwind.");
    expect(text()).toContain("RetrySettings");
    expect(notice()).toBeNull();
    expect(placed()).toBe("results");
    expect(scenario.did).toEqual([]);
  });

  it.each(["movie", "series"] as const)(
    "keeps compact notices with usable %s collections even when the query has no matches",
    async (kind) => {
      const visible = titled(kind, "visible", "Dune", 1);
      const hidden = [
        {
          ...titled(kind === "movie" ? "series" : "movie", "hidden", "Restricted", 1)[0]!,
          adult: true,
        },
      ];
      const raw = kind === "movie" ? lists(visible, hidden) : lists(hidden, visible);
      await subscriptions([
        member("a", "Northwind", { live: failedLive(emptyLive), titles: failedTitles(raw) }),
      ]);
      scenario.catalogue = { kind: "ready", library: buildLibrary([]), failing: scenario.members };
      await open();
      await type("zzq-unmatched");
      expect(text()).not.toContain("Dune 1");
      expect(text()).toContain("Northwind unavailable");
      expect(notice()).not.toBeNull();
      await press("dismiss-provider-notice");
      expect(text()).not.toContain("Northwind unavailable");
      expect(notice()).toBeNull();
      expect(scenario.members[0]!.titles.kind).toBe("failed");
      expect(scenario.did).toEqual([]);
    },
  );

  it("keeps an acknowledged failure quiet through navigation, rename and retry without changing provider state", async () => {
    const failed = member("a", "Northwind", { live: failedLive() }, duneOnly());
    await subscriptions([failed]);
    await open();
    await type("dune");
    expect(text()).toContain("Northwind unavailable");
    await press("dismiss-provider-notice");
    expect(notice()).toBeNull();
    expect(text()).not.toContain("unavailable");
    expect(scenario.members[0]).toBe(failed);
    expect(scenario.members[0]!.live.kind).toBe("failed");
    await press("text-Retry");
    expect(scenario.did).toEqual(["retry a"]);
    await press("text-Cancel");
    unmount();
    await subscriptions([
      member("a", "Renamed", { live: { kind: "loading", last: liveLists } }, duneOnly()),
    ]);
    await open();
    expect(text()).toContain("Dune");
    expect(text()).toContain("Channels still loading");
    expect(text()).not.toMatch(/unavailable|Couldn't/);
    await subscriptions([member("a", "Renamed", { live: failedLive(liveLists, 99) }, duneOnly())]);
    expect(notice()).toBeNull();
    expect(text()).not.toMatch(/unavailable|Couldn't/);
    expect(scenario.members[0]!.live.kind).toBe("failed");
    await press("search-title-7");
    expect(scenario.did).toEqual(["retry a", "back", "back", "details movie 7"]);
  });

  it("keeps Searching, provider progress, Retry and announcements when its compact failure is dismissed", async () => {
    await subscriptions([
      member("a", "Northwind", { live: failedLive() }, duneOnly()),
      member("b", "Southwind", {
        live: { kind: "loading", last: null },
        titles: { kind: "loading", last: null },
      }),
    ]);
    await open();
    await type("dune");
    expect(text()).toContain("Northwind unavailable");
    expect(text().match(/still loading/g)).toHaveLength(1);
    expect(container.querySelector('[data-width="50%"]')).not.toBeNull();
    const said = scenario.said.length;
    vi.useFakeTimers();
    startType("bbc");
    expect(text()).toContain("Searching.");
    startPress("dismiss-provider-notice");
    expect(text()).toContain("Searching.");
    expect(text()).toContain("1 of 2 providers");
    expect(text()).not.toContain("unavailable");
    expect(container.querySelector('[data-width="50%"]')).not.toBeNull();
    expect(scenario.said).toHaveLength(said);
    startPress("text-Retry");
    expect(scenario.did).toEqual(["retry a"]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).toContain("BBC One");
    expect(text()).not.toContain("Searching.");
    expect(scenario.said.at(-1)).toContain("1 of 2 providers");
    startPress("text-Cancel");
    expect(scenario.did).toEqual(["retry a", "back"]);
    expect(scenario.dismissed).toBe(1);
  });

  it("treats equal labels as distinct providers and password loss as a separate incident", async () => {
    await subscriptions([member("a", "Same", { live: failedLive() }, duneOnly())]);
    await open();
    await type("dune");
    await press("dismiss-provider-notice");
    await subscriptions([
      member("a", "Same", { live: failedLive() }, duneOnly()),
      member("b", "Same", { live: failedLive() }),
    ]);
    expect(text().match(/Same unavailable/g)).toHaveLength(1);
    await press("dismiss-provider-notice");
    await subscriptions([
      member("a", "Same", { needsSecret: true, live: { kind: "idle" }, titles: { kind: "idle" } }),
      member("b", "Same"),
    ]);
    expect(text()).toContain("Same needs a password");
    await press("text-Details");
    expect(scenario.did).toEqual(["dismiss 1", "push /live/settings"]);
    expect(scenario.dismissed).toBe(1);
    unmount();
    // A successful provider answer ends the password incident too.
    await subscriptions([member("a", "Same", {}, duneOnly()), member("b", "Same")]);
    await open();
    expect(text()).not.toContain("needs a password");
    await subscriptions([
      member("a", "Same", { needsSecret: true, live: { kind: "idle" }, titles: { kind: "idle" } }),
      member("b", "Same"),
    ]);
    expect(text()).toContain("Same needs a password");
    await press("dismiss-provider-notice");
    expect(notice()).toBeNull();
    await subscriptions([member("b", "Same")]);
    await subscriptions([
      member("a", "Same", { needsSecret: true, live: { kind: "idle" }, titles: { kind: "idle" } }),
      member("b", "Same"),
    ]);
    expect(notice()).not.toBeNull();
    expect(text()).toContain("Same needs a password");
  });

  it("waits for actual recovery of every failed source and forgets a removed provider's acknowledgement", async () => {
    await subscriptions([member("a", "Northwind", { live: failedLive(), titles: failedTitles() })]);
    await open();
    await type("dune");
    await press("dismiss-provider-notice");
    const readyLive: Member["live"] = {
      kind: "ready",
      value: liveLists,
      from: "provider",
      fetchedAt: 1,
      took: 1,
    };
    // Recovering channels alone leaves the title failure acknowledged.
    await subscriptions([member("a", "Northwind", { live: readyLive, titles: failedTitles() })]);
    expect(notice()).toBeNull();
    await subscriptions([
      member("a", "Northwind", {
        live: { ...readyLive, from: "cache" },
        titles: { kind: "ready", value: duneOnly(), from: "cache", fetchedAt: 0, took: null },
      }),
    ]);
    await subscriptions([member("a", "Northwind", { live: failedLive(), titles: failedTitles() })]);
    expect(notice()).toBeNull();
    // Both provider answers end the incident; a later failure is new.
    await subscriptions([member("a", "Northwind", {}, duneOnly())]);
    await subscriptions([member("a", "Northwind", { live: failedLive() }, duneOnly())]);
    expect(text()).toContain("Northwind unavailable");
    await press("dismiss-provider-notice");
    await subscriptions([]);
    await subscriptions([member("a", "Northwind", { live: failedLive() }, duneOnly())]);
    expect(text()).toContain("Northwind unavailable");
    expect(notice()).not.toBeNull();
  });

  it("keeps detailed empty-list recovery in the results after acknowledging a floating notice", async () => {
    await subscriptions([member("a", "Northwind", { live: failedLive(), titles: failedTitles() })]);
    await open();
    await type("dune");
    await press("dismiss-provider-notice");
    scenario.catalogue = { kind: "ready", library: buildLibrary([]), failing: scenario.members };
    await subscriptions([
      member("a", "Northwind", { live: failedLive(emptyLive), titles: failedTitles(lists([])) }),
    ]);
    expect(text()).toContain("Couldn't update channels, movies and series from Northwind.");
    expect(placed()).toBe("results");
    expect(notice()).toBeNull();
    expect(text()).not.toContain("Nothing named");
    await press("text-Retry");
    expect(scenario.did).toEqual(["retry a"]);
    // First-load failures without any retained list keep the same recovery path.
    await subscriptions([
      member("a", "Northwind", { live: failedLive(null), titles: failedTitles(null) }),
    ]);
    expect(text()).toContain("Couldn't load channels, movies and series from Northwind.");
    expect(placed()).toBe("results");
    expect(notice()).toBeNull();
    await press("text-Settings");
    expect(scenario.did).toEqual(["retry a", "dismiss 1", "push /live/settings"]);
  });

  it("keeps the searched status after dismissing a password notice for an unmatched query", async () => {
    await subscriptions([
      member("a", "Northwind", {
        needsSecret: true,
        live: { kind: "idle" },
        titles: { kind: "idle" },
      }),
      member("b", "Southwind", {}, duneOnly()),
    ]);
    await open();
    await type("zzq");
    expect(text()).toContain("Northwind needs a password");
    await press("dismiss-provider-notice");
    expect(text()).toContain("Movies, series and channels searched.");
    expect(notice()).toBeNull();
    expect(text()).not.toMatch(/Retry|Nothing named/);
    await type("zzx");
    expect(text()).toContain("Movies, series and channels searched.");
    expect(scenario.did).toEqual([]);
    // With every remaining provider available, an unmatched query can be conclusive again.
    await subscriptions([member("b", "Southwind", {}, duneOnly())]);
    expect(text()).toContain('Nothing named "zzx".');
    expect(text()).toContain("Searched 2 channels, 1 movie and 0 series.");
  });

  it("says nothing has the name only with everything in, and how much it looked through", async () => {
    await open();
    await type("zzq");
    expect(text()).toContain('Nothing named "zzq".');
    expect(text()).toContain("Searched 2 channels, 1 movie and 0 series.");
  });
});

describe("Every movie and series that matches", () => {
  /** The ids of the movies or series that show, in order. */
  const shownIds = (kind: TitleKind) =>
    [...container.querySelectorAll('[data-testid^="search-title-"]')]
      .map((row) => row.getAttribute("data-testid")!.slice("search-title-".length))
      .filter((id) => id.startsWith(kind === "movie" ? "m" : "s"));
  /** The ids "`prefix`1" to "`prefix``count`". */
  const ids = (prefix: string, count: number, from = 1) =>
    Array.from({ length: count }, (_, at) => `${prefix}${from + at}`);
  const name = { movie: ["Movies", "movie", "movies"], series: ["Series", "series", "series"] };
  const moreOf = (kind: TitleKind, count: number) =>
    `text-Show ${count} more ${count === 1 ? name[kind][1] : name[kind][2]}`;
  /** The Show more buttons of `kind` on screen, whatever count they offer. */
  const moreButtons = (kind: TitleKind) =>
    [...container.querySelectorAll('[data-testid^="text-Show "]')]
      .map((button) => button.getAttribute("data-testid")!)
      .filter((testID) =>
        kind === "series" ? testID.endsWith(" series") : / movies?$/.test(testID),
      );

  it.each([0, 20, 21, 61, 125])(
    "shows %i matches of each kind 20 at a time, best first, each kind on its own",
    async (count) => {
      await subscriptions([
        member(
          "a",
          "Northwind",
          {},
          lists(titled("movie", "m", "Ocean", count), titled("series", "s", "Ocean", count)),
        ),
      ]);
      await open();
      await type("ocean");
      for (const [kind, prefix] of [
        ["movie", "m"],
        ["series", "s"],
      ] as const) {
        // Showing every movie first leaves the series as they were, at 20.
        let showing = Math.min(20, count);
        for (;;) {
          expect(shownIds(kind)).toEqual(ids(prefix, showing));
          const header = name[kind][0];
          if (count === 0) expect(text()).not.toContain(`${header} ·`);
          else if (showing < count) expect(text()).toContain(`${header} · ${showing} of ${count}`);
          else {
            expect(text()).toContain(`${header} · ${count}`);
            expect(text()).not.toContain(`${header} · ${count} of`);
          }
          const left = count - showing;
          // One Show more while any are left, for the next 20 or the few left; none after.
          expect(moreButtons(kind)).toEqual(left === 0 ? [] : [moreOf(kind, Math.min(20, left))]);
          if (left === 0) break;
          await press(moreOf(kind, Math.min(20, left)));
          showing += Math.min(20, left);
        }
      }
      if (count === 0) expect(text()).toContain('Nothing named "ocean".');
      // The last of them, ranked last, is there to open.
      if (count > 0) {
        await press(`search-title-m${count}`);
        expect(scenario.did).toEqual(["back", `details movie m${count}`]);
      }
    },
  );

  it("keeps both independent page requests when their taps arrive before matching runs", async () => {
    await subscriptions([
      member(
        "a",
        "Northwind",
        {},
        lists(titled("movie", "m", "Ocean", 61), titled("series", "s", "Ocean", 61)),
      ),
    ]);
    await open();
    await type("ocean");
    const movieMore = scenario.presses.get(moreOf("movie", 20))!;
    const seriesMore = scenario.presses.get(moreOf("series", 20))!;
    vi.useFakeTimers();
    React.act(() => {
      movieMore();
      seriesMore();
    });
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(shownIds("movie")).toEqual(ids("m", 40));
    expect(shownIds("series")).toEqual(ids("s", 40));
    expect(scenario.did).toEqual([]);
  });

  it("starts again at 20 of each for new text", async () => {
    await subscriptions([
      member(
        "a",
        "Northwind",
        {},
        lists(titled("movie", "m", "Ocean", 125), titled("series", "s", "Ocean", 125)),
      ),
    ]);
    await open();
    await type("ocean");
    await press(moreOf("movie", 20));
    await press(moreOf("movie", 20));
    await press(moreOf("series", 20));
    expect(shownIds("movie")).toEqual(ids("m", 60));
    expect(shownIds("series")).toEqual(ids("s", 40));
    // The same titles match, but the text is new.
    await type("ocea");
    expect(shownIds("movie")).toEqual(ids("m", 20));
    expect(shownIds("series")).toEqual(ids("s", 20));
    expect(text()).toContain("Movies · 20 of 125");
    // And going back to the text before doesn't bring back what was shown of it.
    await type("ocean");
    expect(shownIds("movie")).toEqual(ids("m", 20));
    expect(shownIds("series")).toEqual(ids("s", 20));
    expect(scenario.did).toEqual([]);
  });

  it("opens again on the text it closed with, at 20 of each", async () => {
    await subscriptions([
      member(
        "a",
        "Northwind",
        {},
        lists(titled("movie", "m", "Ocean", 125), titled("series", "s", "Ocean", 125)),
      ),
    ]);
    await open();
    await type("ocean");
    await press(moreOf("movie", 20));
    await press(moreOf("series", 20));
    await press(moreOf("series", 20));
    expect(shownIds("movie")).toEqual(ids("m", 40));
    expect(shownIds("series")).toEqual(ids("s", 60));
    await press("text-Cancel");
    unmount();
    await open();
    expect(field().value).toBe("ocean");
    expect(shownIds("movie")).toEqual(ids("m", 20));
    expect(shownIds("series")).toEqual(ids("s", 20));
    expect(text()).toContain("Movies · 20 of 125");
    expect(text()).toContain("Series · 20 of 125");
    expect(scenario.did).toEqual(["back"]);
  });

  it("finds them again in new lists and names, keeping how many show, never twice", async () => {
    // Northwind lists 125 movies; Southwind 30 newer than all of them, ranked first.
    const northwind = titled("movie", "m", "Ocean", 125);
    const southwind = titled("movie", "mb", "Ocean deep", 30, -31);
    // A movie no provider calls Ocean, but TMDB does: newer than Northwind's, older than
    // Southwind's.
    const renamed: ProviderTitle = {
      ...titled("movie", "mz", "Zee", 1, -1)[0]!,
      tmdbId: "900",
    };
    await subscriptions([
      member("a", "Northwind", {}, lists([renamed, ...northwind])),
      member("b", "Southwind", {}, lists(southwind)),
    ]);
    await open();
    await type("ocean");
    await press(moreOf("movie", 20));
    await press(moreOf("movie", 20));
    expect(shownIds("movie")).toEqual([...ids("mb", 30), ...ids("m", 30)]);
    expect(text()).toContain("Movies · 60 of 155");

    // TMDB's name arrives: the movie it names Ocean is found, still 60 showing, each once.
    scenario.tmdbNames.set("900", "Ocean Blue");
    React.act(() => scenario.notify?.({ content: true }));
    await settled();
    expect(text()).toContain("Movies · 60 of 156");
    expect(shownIds("movie")).toEqual([...ids("mb", 30), "mz1", ...ids("m", 29)]);
    expect(text()).toContain("Ocean Blue");

    // Showing more goes on from there.
    await press(moreOf("movie", 20));
    expect(shownIds("movie")).toEqual([...ids("mb", 30), "mz1", ...ids("m", 49)]);

    // Southwind is removed: its 30 shown movies go, and the next of Northwind's take their
    // places, still 80 showing.
    await subscriptions([member("a", "Northwind", {}, lists([renamed, ...northwind]))]);
    expect(text()).toContain("Movies · 80 of 126");
    expect(shownIds("movie")).toEqual(["mz1", ...ids("m", 79)]);
    await press(moreOf("movie", 20));
    await press(moreOf("movie", 20));
    await press(moreOf("movie", 6));
    expect(shownIds("movie")).toEqual(["mz1", ...ids("m", 125)]);
    expect(moreButtons("movie")).toEqual([]);

    // Northwind's lists come again with fewer movies: those show, all of them.
    await subscriptions([
      member("a", "Northwind", {}, lists([renamed, ...northwind.slice(0, 40)])),
    ]);
    expect(shownIds("movie")).toEqual(["mz1", ...ids("m", 40)]);
    expect(text()).toContain("Movies · 41");
    expect(moreButtons("movie")).toEqual([]);
    expect(scenario.did).toEqual([]);
  });
});

describe("Same-query Search continuity", () => {
  const titleRows = () => container.querySelectorAll('[data-testid^="search-title-"]').length;
  const movieRows = () => container.querySelectorAll('[data-testid^="search-title-m"]').length;
  const seriesRows = () => container.querySelectorAll('[data-testid^="search-title-s"]').length;

  /** Publish the real title owner's replacement index, leaving Search's next task pending. */
  async function replaceLists(members: Member[]) {
    scenario.members = members;
    React.act(() => {
      for (const listener of [...scenario.roster]) listener();
      render();
    });
    for (let attempt = 0; !titlesWorkedOut(); attempt++) {
      if (attempt === 100) throw new Error("Replacement lists did not settle");
      await React.act(async () => {
        vi.runOnlyPendingTimers();
      });
    }
    React.act(render);
  }

  it("retains both sections through Show more and ignores a repeated retained footer tap", async () => {
    await subscriptions([
      member(
        "a",
        "Northwind",
        {},
        lists(titled("movie", "m", "Ocean", 60), titled("series", "s", "Ocean", 60)),
      ),
    ]);
    await open();
    await type("ocean");
    expect([movieRows(), seriesRows()]).toEqual([20, 20]);
    vi.useFakeTimers();
    startPress("text-Show 20 more movies");
    expect([movieRows(), seriesRows()]).toEqual([20, 20]);
    expect(text()).toContain("Searching.");
    startPress("text-Show 20 more movies");
    // Series stays independently actionable while only Movies is being replaced.
    startPress("text-Show 20 more series");
    expect([movieRows(), seriesRows()]).toEqual([20, 20]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect([movieRows(), seriesRows()]).toEqual([40, 40]);
    expect(text()).not.toContain("Searching.");
    expect(scenario.did).toEqual([]);
  });

  it("retains Dune during a metadata notice, blocking its current and delayed old taps", async () => {
    await open();
    await type("dune");
    const oldTap = scenario.presses.get("search-title-7")!;
    vi.useFakeTimers();
    React.act(() => scenario.notify?.({ content: true }));
    expect(text()).toContain("Dune");
    expect(text()).toContain("Searching.");
    startPress("search-title-7");
    expect(scenario.did).toEqual([]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).toContain("Dune");
    expect(text()).not.toContain("Searching.");
    React.act(oldTap);
    expect(scenario.did).toEqual([]);
    startPress("search-title-7");
    expect(scenario.did).toEqual(["back", "details movie 7"]);
  });

  it("keeps retained metadata rows and their footer inert without requesting another page", async () => {
    await subscriptions([member("a", "Northwind", {}, lists(titled("movie", "m", "Dune", 60)))]);
    await open();
    await type("dune");
    vi.useFakeTimers();
    React.act(() => scenario.notify?.({ content: true }));
    expect(movieRows()).toBe(20);
    startPress("search-title-m1");
    startPress("text-Show 20 more movies");
    expect(scenario.did).toEqual([]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(movieRows()).toBe(20);
    startPress("text-Show 20 more movies");
    expect(movieRows()).toBe(20);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(movieRows()).toBe(40);
  });

  it("retains removed title rows inert through a catalogue refresh, then shows only current rows", async () => {
    const old = { ...duneOnly().movies[0]!, id: "8", name: "Dune Old" };
    await subscriptions([member("a", "Northwind", {}, lists([...duneOnly().movies, old]))]);
    await open();
    await type("dune");
    expect(titleRows()).toBe(2);
    const oldTap = scenario.presses.get("search-title-7")!;
    vi.useFakeTimers();
    const revised = { ...duneOnly().movies[0]!, name: "Dune Revised" };
    await replaceLists([member("a", "Northwind", {}, lists([revised]))]);
    expect(text()).toContain("Searching.");
    expect(titleRows()).toBe(2);
    expect(text()).toContain("Dune Old");
    expect(text()).not.toContain("Dune Revised");
    startPress("search-title-7");
    startPress("search-title-8");
    expect(scenario.did).toEqual([]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(titleRows()).toBe(1);
    expect(text()).toContain("Dune Revised");
    expect(text()).not.toContain("Dune Old");
    React.act(oldTap);
    expect(scenario.did).toEqual([]);
    startPress("search-title-7");
    expect(scenario.opened.map((title) => [title.subscriptionId, title.id, title.name])).toEqual([
      ["a", "7", "Dune Revised"],
    ]);
  });

  it("blocks stale same-query rows when a replacement provider reuses the title id", async () => {
    await open();
    await type("dune");
    const oldTap = scenario.presses.get("search-title-7")!;
    vi.useFakeTimers();
    await replaceLists([member("b", "Southwind", {}, duneOnly())]);
    expect(text()).toContain("Dune");
    expect(text()).toContain("Searching.");
    startPress("search-title-7");
    expect(scenario.did).toEqual([]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    React.act(oldTap);
    expect(scenario.did).toEqual([]);
    startPress("search-title-7");
    expect(scenario.opened.map((title) => [title.subscriptionId, title.id])).toEqual([["b", "7"]]);
  });

  it("retains a removed channel inert until the current library publishes its matches", async () => {
    await open();
    await type("npo");
    vi.useFakeTimers();
    scenario.catalogue = { ...ready, library: { ...library, channels: [] } };
    React.act(render);
    expect(text()).toContain("NPO 1");
    expect(text()).toContain("Searching.");
    startPress("channel-a:1");
    expect(scenario.did).toEqual([]);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(container.querySelector('[data-testid="channel-a:1"]')).toBeNull();
    expect(text()).toContain('Nothing named "npo".');
    expect(scenario.did).toEqual([]);
  });

  it("clears retained rows immediately on close or when a request has no source", async () => {
    await open();
    await type("npo");
    vi.useFakeTimers();
    scenario.catalogue = { kind: "loading" };
    React.act(render);
    expect(container.querySelector('[data-testid="channel-a:1"]')).toBeNull();
    scenario.catalogue = ready;
    React.act(render);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    startType("dune");
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    React.act(() => scenario.notify?.({ content: true }));
    expect(text()).toContain("Dune");
    startPress("text-Cancel");
    expect(text()).not.toMatch(/Dune|Nothing named|Searching\./);
    await React.act(async () => {
      await vi.runAllTimersAsync();
    });
    expect(text()).not.toContain("Dune");
    expect(scenario.did).toEqual(["back"]);
    expect(scenario.dismissed).toBe(1);
  });
});
