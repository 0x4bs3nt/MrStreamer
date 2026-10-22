import * as React from "react";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import type { OnDemandCatalogue, ProviderTitle } from "@mrstreamer/core/provider";
import { Window, type HTMLInputElement } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Catalogue, Member } from "../src/account.ts";
import type { Channel, Library } from "../src/library.ts";

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
vi.mock("../src/watchlist.ts", () => ({ alignWatchlist: () => undefined }));
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
  openDetails: (title: { kind: TitleKind; id: string }) =>
    scenario.did.push(`details ${title.kind} ${title.id}`),
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
    live: { kind: "ready", value: {}, took: 1 },
    titles: { kind: "ready", value: titles, took: 1 },
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

beforeEach(async () => {
  Object.assign(scenario, { catalogue: ready, did: [], said: [], fontScale: 1 });
  scenario.keyboard.clear();
  scenario.tmdbNames.clear();
  await subscriptions([member("a", "Northwind", {}, duneOnly())]);
});
afterEach(() => unmount());

describe("Search over the tabs", () => {
  it("closes before a title opens in Movies or Series, and before a channel plays in Watch", async () => {
    const prophecy = { ...titled("series", "p", "", 1)[0]!, name: "Dune Prophecy" };
    await subscriptions([member("a", "Northwind", {}, lists(duneOnly().movies, [prophecy]))]);
    open();
    type("dune");
    press("search-title-7");
    press("search-title-p1");
    type("npo");
    press("channel-a:1");
    expect(scenario.did).toEqual([
      "back",
      "details movie 7",
      "back",
      "details series p1",
      "back",
      "play a:1 in Watch",
    ]);
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

  it("says what still loads, not that nothing has the name", async () => {
    await subscriptions([
      member("a", "Northwind", {}, duneOnly()),
      member("b", "Southwind", { titles: { kind: "loading", last: null } }),
    ]);
    open();
    type("npo");
    const loading =
      "Movies and series still loading, 1 of 2 providers. Movies, series and channels searched.";
    expect(text()).toContain(loading);
    expect(text()).toContain("NPO 1");
    // What Northwind lists is searched meanwhile.
    type("dune");
    expect(text()).toContain("Dune");
    type("zzq");
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
          live: { kind: "failed", error: { kind: "unexpected", detail: "" }, last: {}, since: 0 },
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

  it("leads the results with its line where the bottom can't show a whole line of it", async () => {
    await troubled();
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
    open();
    type("dune");
    expect(text()).toContain(
      "Couldn't load movies and series from Southwind. Movies, series and channels searched.",
    );
    expect(text()).toContain("Dune");
    expect(text()).toContain("Dune Prophecy");
    press("text-Retry");
    press("text-Settings");
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
      open();
      type("ocean");
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
          press(moreOf(kind, Math.min(20, left)));
          showing += Math.min(20, left);
        }
      }
      if (count === 0) expect(text()).toContain('Nothing named "ocean".');
      // The last of them, ranked last, is there to open.
      if (count > 0) {
        press(`search-title-m${count}`);
        expect(scenario.did).toEqual(["back", `details movie m${count}`]);
      }
    },
  );

  it("starts again at 20 of each for new text", async () => {
    await subscriptions([
      member(
        "a",
        "Northwind",
        {},
        lists(titled("movie", "m", "Ocean", 125), titled("series", "s", "Ocean", 125)),
      ),
    ]);
    open();
    type("ocean");
    press(moreOf("movie", 20));
    press(moreOf("movie", 20));
    press(moreOf("series", 20));
    expect(shownIds("movie")).toEqual(ids("m", 60));
    expect(shownIds("series")).toEqual(ids("s", 40));
    // The same titles match, but the text is new.
    type("ocea");
    expect(shownIds("movie")).toEqual(ids("m", 20));
    expect(shownIds("series")).toEqual(ids("s", 20));
    expect(text()).toContain("Movies · 20 of 125");
    // And going back to the text before doesn't bring back what was shown of it.
    type("ocean");
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
    open();
    type("ocean");
    press(moreOf("movie", 20));
    press(moreOf("series", 20));
    press(moreOf("series", 20));
    expect(shownIds("movie")).toEqual(ids("m", 40));
    expect(shownIds("series")).toEqual(ids("s", 60));
    press("text-Cancel");
    unmount();
    open();
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
    open();
    type("ocean");
    press(moreOf("movie", 20));
    press(moreOf("movie", 20));
    expect(shownIds("movie")).toEqual([...ids("mb", 30), ...ids("m", 30)]);
    expect(text()).toContain("Movies · 60 of 155");

    // TMDB's name arrives: the movie it names Ocean is found, still 60 showing, each once.
    scenario.tmdbNames.set("900", "Ocean Blue");
    React.act(() => scenario.notify?.({ content: true }));
    expect(text()).toContain("Movies · 60 of 156");
    expect(shownIds("movie")).toEqual([...ids("mb", 30), "mz1", ...ids("m", 29)]);
    expect(text()).toContain("Ocean Blue");

    // Showing more goes on from there.
    press(moreOf("movie", 20));
    expect(shownIds("movie")).toEqual([...ids("mb", 30), "mz1", ...ids("m", 49)]);

    // Southwind is removed: its 30 shown movies go, and the next of Northwind's take their
    // places, still 80 showing.
    await subscriptions([member("a", "Northwind", {}, lists([renamed, ...northwind]))]);
    expect(text()).toContain("Movies · 80 of 126");
    expect(shownIds("movie")).toEqual(["mz1", ...ids("m", 79)]);
    press(moreOf("movie", 20));
    press(moreOf("movie", 20));
    press(moreOf("movie", 6));
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
