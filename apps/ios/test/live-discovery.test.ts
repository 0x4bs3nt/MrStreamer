import { createRoot, window, document, type Root } from "./dom.ts";
import { nativePlayer } from "./native-player.ts";
import * as React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Live's Find countries or categories as the viewer meets it, over the app's own owners: account.ts
// signs in to two of the desktop tests' fake Xtream panels, whose ids and names collide, and
// library.ts joins their channels as Live shows them. The real Live, discovery and category
// screens run with React DOM on a happy-dom window, as live-browse.test.ts does. Navigation is
// recorded and acted out: a push draws the screen pushed, Back the one under it, which stays as
// it was. The native player records what it is given, and every request to a panel is counted, so
// a test sees that finding and opening plays nothing and asks nothing of a provider.

const scenario = vi.hoisted(() => ({
  keychain: new Map<string, string>(),
  /** What the player was given, in order. */
  played: [] as string[],
  /** Requests to the panels' API and streams, by path and action. */
  requests: [] as string[],
  /** Where the screens went, in order. */
  routes: [] as string[],
}));

vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "0.1.0" } } }));
vi.mock("expo-secure-store", () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: async (key: string) => scenario.keychain.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => void scenario.keychain.set(key, value),
  deleteItemAsync: async (key: string) => void scenario.keychain.delete(key),
}));
vi.mock("expo-video", () => ({
  createVideoPlayer: () =>
    nativePlayer((source) => {
      scenario.played.push(source.uri);
    }),
}));

vi.mock("../src/telemetry/index.ts", () => ({ noteAction: () => undefined }));
vi.mock("react-native", async () => (await import("./react-native.ts")).reactNative);
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
  router: {
    push: (href: string) => void scenario.routes.push(href),
    back: () => void scenario.routes.push("back"),
  },
  useIsFocused: () => true,
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (_tab: string, screen: string) => `/live/${screen}`,
}));

const passThrough = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
  const url = new URL(input);
  // The provider's API and its streams; channel logos Live's rows show are pictures, not asked here.
  if (!url.pathname.startsWith("/logos/")) {
    scenario.requests.push(`${url.pathname}?${url.searchParams.get("action") ?? ""}`);
  }
  return passThrough(input, init);
});

interface FakeChannel {
  readonly streamId: number;
  readonly categoryId: string;
}
interface FakeCategory {
  readonly id: string;
  readonly name: string;
}
interface FakeProvider {
  readonly url: string;
  serveChannels(select: (all: readonly FakeChannel[]) => readonly FakeChannel[]): void;
  serveCategories(select: (all: readonly FakeCategory[]) => readonly FakeCategory[]): void;
  failCatalogue(status: number | null): void;
  hold(what: "channels"): { readonly arrived: Promise<void>; release(): void };
  close(): Promise<void>;
}
/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
const { startFakeProvider, QUALITY_STREAM_IDS } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly channels: number;
    readonly titles: number;
    readonly second?: boolean;
  }): Promise<FakeProvider>;
  QUALITY_STREAM_IDS: number;
};
/** The streams of the one channel in three qualities: its category, Belgium's Kwaliteit, has no other. */
const QUALITIES = [0, 1, 2].map((at) => QUALITY_STREAM_IDS + at);

let one: FakeProvider;
let two: FakeProvider;
beforeAll(async () => {
  [one, two] = await Promise.all([
    startFakeProvider({ username: "one", password: "one+Pw@1", channels: 400, titles: 4 }),
    startFakeProvider({
      username: "two",
      password: "two+Pw@2",
      channels: 400,
      titles: 4,
      second: true,
    }),
  ]);
});
afterAll(async () => {
  await Promise.all([one.close(), two.close()]);
});

async function until(ready: () => boolean, what: string) {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 4_000) throw new Error(`Timed out waiting for ${what}`);
    await React.act(() => new Promise((done) => setTimeout(done, 10)));
  }
}

const account = await import("../src/account.ts");
const { LiveHome, CategoryScreen } = await import("../src/live-screen.tsx");
const { DiscoverScreen } = await import("../src/live-discover.tsx");

const libraryOf = () => {
  const now = account.currentCatalogue();
  return now.kind === "ready" ? now.library : null;
};

let a = "";
let b = "";
/** What discovery said while the first provider's channels were still to come. */
let firstLoad = "";
beforeAll(async () => {
  await account.restore();
  const held = one.hold("channels");
  a = (await account.add({ server: one.url, username: "one", password: "one+Pw@1" })) ?? "";
  await held.arrived;
  const shown = document.createElement("div");
  const early = createRoot(shown);
  React.act(() => early.render(React.createElement(DiscoverScreen)));
  firstLoad = shown.textContent ?? "";
  React.act(() => early.unmount());
  held.release();
  b =
    (await account.add({
      server: two.url,
      username: "two",
      password: "two+Pw@2",
      name: "Cabin",
    })) ?? "";
  await until(() => libraryOf()?.labels.size === 2 && account.channelsWorkedOut(), "both lists");
});

/**
 * The screens on Live's stack, bottom first, as the recorded navigation leaves them: a push adds
 * the screen it names, Back takes the top one away and shows the one under it as it was.
 */
let stack: React.ReactElement[] = [];
let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function draw() {
  React.act(() =>
    root!.render(
      React.createElement(
        React.Fragment,
        null,
        stack.map((screen, at) =>
          React.createElement(
            "div",
            { key: at, "data-screen": at, hidden: at !== stack.length - 1 },
            screen,
          ),
        ),
      ),
    ),
  );
}
const screenFor = (href: string): React.ReactElement => {
  if (href === "/live/discover") return React.createElement(DiscoverScreen);
  const category = /^\/live\/category\?region=([^&]*)&name=(.*)$/.exec(href);
  if (category) {
    return React.createElement(CategoryScreen, {
      region: decodeURIComponent(category[1] ?? ""),
      name: decodeURIComponent(category[2] ?? ""),
    });
  }
  throw new Error(`No screen for ${href}`);
};
/** Acts out the navigation the screens asked for since the last call. */
function navigate() {
  for (const route of scenario.routes.splice(0)) {
    if (route === "back") stack = stack.slice(0, -1);
    else stack = [...stack, screenFor(route)];
  }
  draw();
}
const top = () => container.querySelector(`[data-screen="${stack.length - 1}"]`)!;
const find = (testID: string) => top().querySelector(`[data-testid="${testID}"]`);
function press(testID: string) {
  const button = find(testID) as { click(): void } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
  navigate();
}
function type(text: string) {
  const field = find("discover-field") as unknown as {
    value: string;
    dispatchEvent(event: unknown): void;
  } | null;
  if (!field) throw new Error("No field on screen");
  React.act(() => {
    // React reads the new value through the field's own setter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(field, text);
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
}
const value = () => (find("discover-field") as unknown as { value: string } | null)?.value;
/** Each result on the discovery screen: its name, kind and line, as VoiceOver reads it. */
const results = () =>
  [
    ...top().querySelectorAll(
      '[data-testid^="discover-country-"], [data-testid^="discover-category-"]',
    ),
  ].map((row) => row.getAttribute("aria-label") ?? "");
/** The channel rows on the screen showing, by their keys. */
const rows = () =>
  [...top().querySelectorAll('[data-testid^="channel-"]')].map(
    (row) => row.getAttribute("data-testid")?.slice("channel-".length) ?? "",
  );

beforeEach(() => {
  container = document.createElement("div");
  root = createRoot(container);
  stack = [React.createElement(LiveHome)];
  draw();
  // Live under the discovery screen shows its tiles rather than every provider's 800 rows.
  press("tab-categories");
  scenario.routes.length = 0;
  scenario.requests.length = 0;
  scenario.played.length = 0;
});
afterEach(() => {
  React.act(() => root!.unmount());
  root = null;
  // Nothing found or opened plays, or asks a provider for anything.
  expect(scenario.played).toEqual([]);
});

/** The system's back button, over the screen on top. */
function back() {
  scenario.routes.push("back");
  navigate();
}
const shelvesCalled = (name: string) =>
  libraryOf()!.regions.flatMap((region) =>
    region.shelves.filter((shelf) => shelf.title === name).map((shelf) => ({ region, shelf })),
  );

describe("finding a category", () => {
  it("finds every country's category of a name, each named by its country", () => {
    press("live-discover");
    expect(value()).toBe("");
    type("news");
    const news = shelvesCalled("News");
    // Far more than For you's six shelves, and every one of them.
    expect(news.length).toBeGreaterThan(6);
    expect(results()).toEqual(
      news.map(
        ({ region, shelf }) => `News, category, ${region.name} · ${shelf.channels.length} channels`,
      ),
    );
    expect(new Set(news.map(({ region }) => region.name)).size).toBe(news.length);
    expect(scenario.requests).toEqual([]);
  });

  it("opens the whole category, each provider's channels in it, and Back finds the results again", () => {
    press("live-discover");
    type("news");
    const before = results();
    // The last country's, far past For you's shelves.
    const shelf = shelvesCalled("News").at(-1)!.shelf;
    press(`discover-category-${shelf.id}`);
    expect(rows()).toEqual(shelf.channels.map((channel) => channel.key));
    // Both providers list a channel there, each its own though their ids are the same.
    expect(new Set(shelf.channels.map((channel) => channel.subscriptionId))).toEqual(
      new Set([a, b]),
    );
    back();
    expect(value()).toBe("news");
    expect(results()).toEqual(before);
    expect(scenario.requests).toEqual([]);
  });
});

describe("finding a country", () => {
  it("shows the country in Live on the tab it showed, and Cancel leaves Live as it was", () => {
    const tabbed = () => container.querySelector('[data-testid="live-categories"]') !== null;
    expect(tabbed()).toBe(true);
    press("live-discover");
    const [, second] = libraryOf()!.regions;
    type(second!.name);
    expect(results()[0]).toBe(`${second!.name}, country, ${second!.channels.length} channels`);
    press("discover-cancel");
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe("All countries");
    expect(tabbed()).toBe(true);

    press("live-discover");
    // Each opening starts with an empty field.
    expect(value()).toBe("");
    type(second!.name);
    press(`discover-country-${second!.name}`);
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe(second!.name);
    expect(tabbed()).toBe(true);
    press("live-country-clear");
  });
});

describe("the first channels", () => {
  it("are said to be loading until a provider's come, with the field there", () => {
    expect(firstLoad).toBe("CancelChannels are still loading.");
  });
});

describe("the field", () => {
  it("empties on Clear and stays open, and says when nothing has the name", () => {
    press("live-discover");
    type("kids");
    expect(results().length).toBeGreaterThan(0);
    press("discover-clear");
    expect(value()).toBe("");
    expect(results()).toEqual([]);
    expect(stack).toHaveLength(2);
    type("zzqx");
    expect(find("discover-results")).toBeNull();
    expect(top().textContent).toContain("No country or category is called “zzqx”.");
  });
});

describe("as the providers' lists change", () => {
  it("keeps finding the last channels while a reload fails, and says so", async () => {
    one.failCatalogue(503);
    account.reloadChannels(a);
    await until(() => account.members()[0]?.live.kind === "failed", "the failure");
    press("live-discover");
    type("news");
    expect(results()).toHaveLength(shelvesCalled("News").length);
    // The status line names it, as Live's does (loading-feedback.test.ts): its list is the last.
    const now = account.currentCatalogue();
    expect(now.kind === "ready" && now.failing.map((member) => member.entry.id)).toEqual([a]);
    // Its last list shows, so a name in none of the lists is in none of its channels either.
    type("zzqx");
    expect(top().textContent).toContain("No country or category is called “zzqx”.");
    one.failCatalogue(null);
    const before = libraryOf();
    account.reloadChannels(a);
    await until(() => libraryOf() !== before && account.channelsWorkedOut(), "the list again");
  });

  it("drops a category no provider lists any more, and its screen says it is gone", async () => {
    press("live-discover");
    type("kwaliteit");
    const [kwaliteit] = shelvesCalled("Kwaliteit");
    expect(results()).toEqual([`Kwaliteit, category, ${kwaliteit!.region.name} · 2 channels`]);
    press(`discover-category-${kwaliteit!.shelf.id}`);
    expect(rows()).toHaveLength(2);

    for (const panel of [one, two]) {
      panel.serveChannels((all) => all.filter((each) => !QUALITIES.includes(each.streamId)));
    }
    const before = libraryOf();
    account.reloadChannels(a);
    account.reloadChannels(b);
    await until(
      () =>
        libraryOf() !== before &&
        account.channelsWorkedOut() &&
        shelvesCalled("Kwaliteit").length === 0,
      "the lists without it",
    );
    draw();
    expect(top().textContent).toContain("This category isn't listed any more.");
    back();
    expect(results()).toEqual([]);
    expect(top().textContent).toContain("No country or category is called “kwaliteit”.");

    for (const panel of [one, two]) panel.serveChannels((all) => all);
    const without = libraryOf();
    account.reloadChannels(a);
    account.reloadChannels(b);
    await until(
      () => libraryOf() !== without && shelvesCalled("Kwaliteit").length === 1,
      "the lists with it again",
    );
  });
});

/** Reloads both providers' channels with what their panels list now, and waits for Live. */
async function relistBoth() {
  const before = libraryOf();
  account.reloadChannels(a);
  account.reloadChannels(b);
  await until(
    () =>
      libraryOf() !== before &&
      account.channelsWorkedOut() &&
      account.members().every((member) => member.live.kind === "ready"),
    "both lists again",
  );
}

describe("an Other channels region holding more than its category", () => {
  it("is found as the country too, which shows every one of its channels", async () => {
    // Home's panel names a category Other channels; both panels list channels in no category.
    const unplaced = (all: readonly FakeChannel[]) =>
      all.map((each) => (each.categoryId === "4" ? { ...each, categoryId: "999" } : each));
    one.serveCategories((all) =>
      all.map((each) => (each.id === "2" ? { ...each, name: "Other channels" } : each)),
    );
    one.serveChannels(unplaced);
    two.serveChannels(unplaced);
    await relistBoth();
    const region = libraryOf()!.regions.find((each) => each.name === "Other channels")!;
    const [shelf] = region.shelves;
    const keys = region.channels.map((channel) => channel.key);
    expect(region.shelves).toHaveLength(1);
    expect(shelf!.channels.length).toBeLessThan(keys.length);
    expect(new Set(region.channels.map((channel) => channel.subscriptionId))).toEqual(
      new Set([a, b]),
    );

    press("live-discover");
    type("other channels");
    expect(results()).toEqual([
      `Other channels, country, ${keys.length} channels`,
      `Other channels, category, ${shelf!.channels.length} channels`,
    ]);
    press("discover-country-Other channels");
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe("Other channels");
    press("tab-all");
    expect(rows()).toEqual(keys);
    press("live-country-clear");
    press("tab-categories");

    one.serveCategories((all) => all);
    one.serveChannels((all) => all);
    two.serveChannels((all) => all);
    await relistBoth();
    expect(scenario.requests.filter((each) => each.includes("/live/"))).toEqual([]);
  });
});

describe("a provider whose channels haven't come", () => {
  let three: FakeProvider;
  let c = "";
  beforeAll(async () => {
    three = await startFakeProvider({
      username: "three",
      password: "three+Pw@3",
      channels: 40,
      titles: 4,
    });
    // A category only this panel lists.
    three.serveCategories((all) =>
      all.map((each) => (each.id === "2" ? { ...each, name: "UK | Harbour Lights" } : each)),
    );
  });
  afterAll(() => three.close());
  afterEach(async () => {
    if (c) await account.remove(c, { keepHistory: false });
    c = "";
    await until(() => libraryOf()?.labels.size === 2, "two providers again");
  });
  const third = () => account.members().find((member) => member.entry.id === c);
  const add = () =>
    account
      .add({ server: three.url, username: "three", password: "three+Pw@3", name: "Annex" })
      .then((id) => void (c = id ?? ""));

  it("is said to be loading, not missing, until its list comes with the name", async () => {
    const held = three.hold("channels");
    await add();
    await held.arrived;
    press("live-discover");
    type("harbour");
    expect(top().textContent).toContain(
      "No country or category is called “harbour” yet. Channels from Annex are still loading.",
    );
    // What the others list shows meanwhile.
    type("news");
    expect(results().length).toBeGreaterThan(0);
    type("harbour");
    held.release();
    await until(() => libraryOf()?.labels.size === 3 && account.channelsWorkedOut(), "its list");
    // One channel, in the United Kingdom group the panel names its first category after.
    expect(results()).toEqual(["Harbour Lights, category, United Kingdom · 1 channel"]);
  });

  it("says whose list didn't load, when none of it shows", async () => {
    three.failCatalogue(503);
    await add();
    await until(() => third()?.live.kind === "failed", "its failure");
    press("live-discover");
    type("harbour");
    expect(top().textContent).toContain(
      "No country or category is called “harbour” in the channels that loaded. Couldn't load channels from Annex.",
    );
    three.failCatalogue(null);
  });

  it("says no providers list channels only once every one has answered", async () => {
    one.serveChannels(() => []);
    two.serveChannels(() => []);
    await relistBoth();
    const held = three.hold("channels");
    three.serveChannels(() => []);
    await add();
    await held.arrived;
    press("live-discover");
    expect(top().textContent).toContain("Channels from Annex are still loading.");
    expect(top().textContent).not.toContain("list no channels");
    held.release();
    await until(() => libraryOf()?.labels.size === 3, "its empty list");
    expect(top().textContent).toContain("Your providers list no channels.");

    three.serveChannels((all) => all);
    one.serveChannels((all) => all);
    two.serveChannels((all) => all);
    await relistBoth();
  });
});

describe("a country found with one category", () => {
  // Home's panel names its second category as Iceland's only one.
  beforeAll(async () => {
    one.serveCategories((all) =>
      all.map((each) => (each.id === "2" ? { ...each, name: "IS | Single" } : each)),
    );
    await relistBoth();
  });
  afterAll(async () => {
    one.serveCategories((all) => all);
    await relistBoth();
  });
  const tiles = () =>
    [...top().querySelectorAll('[data-testid^="live-category-"]')].map((tile) =>
      tile.getAttribute("data-testid"),
    );
  /** Finds Iceland and shows it in Live, as its result does. */
  function iceland() {
    press("live-discover");
    type("iceland");
    const [region] = libraryOf()!.regions.filter((each) => each.name === "Iceland");
    expect(region?.shelves.map((shelf) => shelf.title)).toEqual(["Single"]);
    expect(results()[0]).toBe(`Iceland, country, ${region!.channels.length} channels`);
    press("discover-country-Iceland");
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe("Iceland");
    return region!;
  }

  it("keeps Categories, showing its one category, and every category again once cleared", () => {
    expect(find("live-categories")).not.toBeNull();
    const all = tiles().length;
    const region = iceland();
    expect(find("live-categories")).not.toBeNull();
    expect(tiles()).toEqual([`live-category-${region.shelves[0]!.id}`]);
    press("live-country-clear");
    expect(find("live-categories")).not.toBeNull();
    expect(tiles()).toHaveLength(all);
  });

  it("keeps For you, with its one category as a shelf", () => {
    press("tab-for-you");
    expect(find("live-for-you")).not.toBeNull();
    iceland();
    expect(find("live-for-you")).not.toBeNull();
    expect(find("live-for-you")?.textContent).toContain("Single");
    press("live-country-clear");
    expect(find("live-for-you")).not.toBeNull();
  });
});

describe("a country found with no category", () => {
  // Home's panel lists category 4's channels in no category: Other channels, with no shelf.
  beforeAll(async () => {
    one.serveChannels((all) =>
      all.map((each) => (each.categoryId === "4" ? { ...each, categoryId: "999" } : each)),
    );
    await relistBoth();
  });
  afterAll(async () => {
    one.serveChannels((all) => all);
    await relistBoth();
  });

  it("shows its channels in All, and Categories again once cleared", () => {
    expect(find("live-categories")).not.toBeNull();
    press("live-discover");
    type("other channels");
    const region = libraryOf()!.regions.find((each) => each.name === "Other channels")!;
    expect(region.shelves).toEqual([]);
    expect(results()).toEqual([`Other channels, country, ${region.channels.length} channels`]);
    press("discover-country-Other channels");
    expect(stack).toHaveLength(1);
    expect(find("live-country")?.textContent).toBe("Other channels");
    expect(find("tab-for-you")).toBeNull();
    expect(rows()).toEqual(region.channels.map((channel) => channel.key));
    press("live-country-clear");
    expect(find("live-categories")).not.toBeNull();
  });
});
