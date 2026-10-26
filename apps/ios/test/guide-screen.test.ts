import { createRoot, document } from "./dom.ts";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { Catalogue } from "../src/account.ts";
import type { Channel } from "../src/library.ts";
import type { Query, Result } from "../src/guide-native.ts";
import type { createGuide } from "../src/guide.ts";
import { currentSource, dropSource, setSource } from "../src/sources.ts";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import type { guideFixture } from "./native-guide.ts";
import { finish } from "@mrstreamer/core/steps";
import { combine, partSteps } from "../src/library.ts";

const state = vi.hoisted(() => ({
  catalogue: { kind: "loading" } as Catalogue,
  owner: null as ReturnType<typeof createGuide> | null,
  fixture: null as ReturnType<typeof guideFixture> | null,
  params: {} as { channel?: string; detail?: string },
  focused: true,
  focusContext: null as React.Context<boolean> | null,
  visible: 12,
  did: [] as unknown[],
  queries: [] as {
    ids: readonly string[];
    mode: string;
    from: number;
    until: number;
    after: number;
  }[],
  answer: null as
    | ((
        mode: string,
        ids: readonly string[],
        from: number,
        until: number,
        after: number,
        lease: string,
      ) => Promise<Result<Query>>)
    | null,
}));
vi.mock("../src/guide.ts", async (original) => {
  const actual = await original<typeof import("../src/guide.ts")>();
  const { guideFixture } = await import("./native-guide.ts");
  state.fixture = guideFixture();
  state.fixture.native.query = async (
    _lease,
    _generation,
    _job,
    ids,
    _at,
    mode,
    from,
    until,
    after,
  ) => {
    state.queries.push({ ids, mode, from, until, after });
    return state.answer
      ? state.answer(mode, ids, from, until, after, _lease)
      : { kind: "ok", value: { guideId: null, rows: [], more: false } };
  };
  state.owner = actual.createGuide(
    () => state.fixture!.native,
    () => Date.now(),
    (await import("../src/sources.ts")).currentSource,
  );
  return { ...actual, guide: state.owner };
});
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("expo-router", async () => {
  const { createContext, useContext } = await import("react");
  state.focusContext = createContext(true);
  return {
    useIsFocused: () => useContext(state.focusContext!) && state.focused,
    useLocalSearchParams: () => state.params,
    router: {
      push: (href: unknown) => state.did.push(href),
      navigate: (href: unknown) => state.did.push(href),
    },
  };
});
vi.mock("../src/account.ts", () => ({
  useCatalogue: () => state.catalogue,
  useRoster: () => ({ kind: "ready", members: [] }),
  playChannel: (channel: Channel, _place: string, options: { watch: boolean }) =>
    state.did.push({ play: channel.key, ...options }),
  retry: () => {},
  retryChannels: () => {},
  reloadAllChannels: () => {},
}));
vi.mock("../src/header.tsx", () => ({
  tabHref: (tab: string, name: string) => (tab === "live" ? `/live/${name}` : `/${name}`),
}));
vi.mock("../src/loading.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Docked: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    useDockInset: () => 0,
    libraryStatus: () => null,
    loadingStatus: () => null,
    PlaceholderRows: () => null,
    Placeholders: () => null,
    Shape: () => null,
  };
});
vi.mock("../src/favourites.ts", () => ({
  useFavouriteKeys: () => new Set(),
  starChannel: () => {},
  useFavourites: () => null,
}));
vi.mock("../src/favourites-screen.tsx", () => ({ FavouritesEntry: () => null }));
vi.mock("../src/glass.tsx", async () => {
  const { createElement } = await import("react");
  return {
    Glass: ({ children }: { children: React.ReactNode }) => createElement("div", null, children),
    IconButton: ({
      label,
      onPress,
      testID,
    }: {
      label: string;
      onPress: () => void;
      testID: string;
    }) => createElement("button", { onClick: onPress, "data-testid": testID }, label),
  };
});
vi.mock("../src/playback.ts", () => ({
  channelStatus: () => null,
  usePlayback: () => ({ phase: { kind: "idle" }, watch: false }),
  player: () => ({}),
  retry: () => {},
  setMuted: () => {},
  openWatch: () => state.did.push("watch"),
}));
vi.mock("../src/storage.ts", () => ({ useSavedState: () => ({}), writeState: () => {} }));
vi.mock("../src/resume.ts", () => ({
  useContinueWatching: () => [],
  openDetails: () => {},
  resume: () => {},
}));
vi.mock("../src/viewing.ts", () => ({ removeFromContinue: () => {} }));
vi.mock("../src/watchlist.ts", () => ({ useWatchlist: () => [], watchlistRows: () => [] }));
vi.mock("../src/titles.ts", () => ({
  useCollections: () => null,
  useTitleLists: () => ({ kind: "failed" }),
  useHasTitles: () => false,
  useMetadataVersion: () => 0,
  titlesWorkedOut: () => false,
  named: () => "",
}));
vi.mock("expo-video", () => ({ VideoView: () => null }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("react-native", async () => {
  const { createElement, useEffect, isValidElement } = await import("react");
  const { reactNative } = await import("./react-native.ts");
  type Props = {
    children?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityValue?: { now?: number };
  };
  const box = ({ children, testID, accessibilityRole, accessibilityValue }: Props) =>
    createElement(
      "div",
      { "data-testid": testID, role: accessibilityRole, "aria-valuenow": accessibilityValue?.now },
      children,
    );
  const node = (value: unknown) =>
    !value ? null : isValidElement(value) ? value : createElement(value as React.ComponentType);
  return {
    ...reactNative,
    View: box,
    ScrollView: box,
    Text: box,
    FlatList: <T>({
      data,
      renderItem,
      ListHeaderComponent,
      ListFooterComponent,
      ListEmptyComponent,
      onViewableItemsChanged,
      testID,
    }: {
      data: readonly T[];
      renderItem: (info: { item: T; index: number }) => React.ReactNode;
      ListHeaderComponent?: unknown;
      ListFooterComponent?: unknown;
      ListEmptyComponent?: unknown;
      testID?: string;
      onViewableItemsChanged?: (info: {
        viewableItems: { item: T; isViewable: boolean }[];
      }) => void;
    }) => {
      useEffect(() => {
        onViewableItemsChanged?.({
          viewableItems: data.slice(0, state.visible).map((item) => ({ item, isViewable: true })),
        });
      }, [data, onViewableItemsChanged]);
      return createElement(
        "div",
        { "data-testid": testID },
        node(ListHeaderComponent),
        data.length
          ? data.map((item, index) =>
              createElement("div", { key: index }, renderItem({ item, index })),
            )
          : node(ListEmptyComponent),
        node(ListFooterComponent),
      );
    },
  };
});
const { LiveHome } = await import("../src/live-screen.tsx");
const { default: Home } = await import("../src/app/(tabs)/(home)/index.tsx");
const { ScheduleScreen, ProgrammeScreen } = await import("../src/guide-screen.tsx");
let root: ReturnType<typeof createRoot>;
let container: ReturnType<typeof document.createElement>;
const at = new Date(2026, 9, 24, 12).getTime();
const current: Programme = {
  title: "Actual ocean programme",
  start: at - 30 * 60_000,
  stop: at + 30 * 60_000,
  description: "A real fixture description",
};
const next: Programme = {
  title: "Actual next programme",
  start: current.stop,
  stop: current.stop + 3600_000,
  description: null,
};
const owner = () => {
  if (!state.owner) throw new Error("Owner missing");
  return state.owner;
};
const fixture = () => {
  if (!state.fixture) throw new Error("Fixture missing");
  return state.fixture;
};
function part(id = "a", count = 3) {
  return finish(
    partSteps({
      subscriptionId: id,
      catalogue: {
        categories: [{ id: "news", name: "NL|News" }],
        channels: Array.from({ length: count }, (_, i) => ({
          id: `${i + 1}`,
          name: `Channel ${i + 1}`,
          categoryIds: ["news"],
          guideId: i === 1 ? null : `trusted-${i + 1}`,
          logoUrl: null,
          adult: false,
          number: null,
          catchupDays: null,
        })),
      },
    }),
  );
}
async function install(id = "a", count = 3, age = 0) {
  const p = part(id, count);
  fixture().control.activations.set(id, {
    lease: `lease-${id}`,
    generation: { id: `db-${id}`, fetchedAt: Date.now() - age, until: Date.now() + 7 * 86400_000 },
  });
  await owner().restore([id]);
  owner().setPart(p);
  state.catalogue = { kind: "ready", failing: [], library: combine([{ label: id, part: p }]) };
}
async function draw(node: React.ReactNode) {
  await React.act(async () => {
    root.render(node);
  });
}
async function settle() {
  await React.act(async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  });
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === label || button.getAttribute("data-testid") === label,
  );
  if (!button) throw new Error(`Missing button ${label}: ${container.textContent}`);
  await React.act(async () => button.click());
  await settle();
}
function answer(rows: readonly Programme[], more = false): Result<Query> {
  return { kind: "ok", value: { guideId: "trusted-1", rows, more } };
}
const tick = async () => {
  await React.act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  await settle();
};
function holdQueries(reply: NonNullable<typeof state.answer>) {
  const releases: (() => void)[] = [];
  let holding = true;
  state.answer = (...args) =>
    holding
      ? new Promise((resolve, reject) =>
          releases.push(() => {
            void reply(...args).then(resolve, reject);
          }),
        )
      : reply(...args);
  return {
    release: async () => {
      await React.act(async () => {
        holding = false;
        releases.splice(0).forEach((release) => release());
      });
      await settle();
    },
  };
}
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(at);
  for (const id of ["a", "b", "c"]) dropSource(id);
  state.focused = true;
  state.visible = 12;
  state.params = {};
  state.did = [];
  state.queries = [];
  for (const id of ["a", "b", "c"]) await fixture().native.forget(id);
  fixture().control.activations.clear();
  state.answer = async (_mode, ids) =>
    ids[0] === "trusted-1" ? answer([current, next]) : answer([]);
  await install();
  owner().foreground();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  container.remove();
  owner().background();
  vi.useRealTimers();
});

describe("selected A public guide UI with the real guide owner", () => {
  it("shows actual Home programmes and keeps tile preview separate from Schedule", async () => {
    await draw(React.createElement(Home));
    await settle();
    expect(container.textContent).toContain(current.title);
    expect(container.textContent).toContain(next.title);
    expect(container.querySelector('[data-testid="home-stage"]')?.textContent).toContain(
      current.title,
    );
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "50",
    );
    await click("home-channel-a:1");
    expect(state.did).toContainEqual({ play: "a:1", watch: false });
    state.did = [];
    await click("home-schedule-a:1");
    expect(state.did).toEqual([{ pathname: "/schedule", params: { channel: "a:1" } }]);
  });

  it("shows actual Live programmes and category fallback, with Guide separate from Play", async () => {
    await draw(React.createElement(LiveHome));
    await settle();
    expect(container.textContent).toContain(current.title);
    await click("Guide");
    expect(container.textContent).toContain(current.title);
    expect(container.querySelector('[data-testid="channel-a:2"]')?.textContent).toContain("News");
    state.did = [];
    await click("schedule-a:1");
    expect(state.did).toEqual([{ pathname: "/live/schedule", params: { channel: "a:1" } }]);
    state.did = [];
    await click("channel-a:1");
    expect(state.did).toEqual([{ play: "a:1", watch: true }]);
  });

  it("pages the schedule, inspects one programme and plays only through Watch live", async () => {
    state.params = { channel: "a:1" };
    state.answer = async (mode, _ids, _from, _until, after) =>
      mode === "detail" ? answer([current]) : after < 0 ? answer([current], true) : answer([next]);
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(state.did).toEqual([]);
    await click("Show more");
    expect(container.textContent).toContain(next.title);
    await click(`programme-${current.start}`);
    const route = state.did[0] as { pathname: string; params: { channel: string; detail: string } };
    expect(route.pathname).toBe("/live/programme");
    expect(route.params.detail).toMatch(/^g/);
    state.params = route.params;
    await draw(React.createElement(ProgrammeScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain(current.description);
    expect(state.did).toHaveLength(1);
    await click("Watch live");
    expect(state.did[1]).toEqual({ play: "a:1", watch: true });
    // Returning to the existing Schedule screen reads its original channel without playing.
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain("Today");
    expect(state.did).toHaveLength(2);
  });

  it("retires a held day read on day changes and provider replacement, and settles unavailable reads", async () => {
    state.params = { channel: "a:1" };
    let release: ((value: Result<Query>) => void) | undefined;
    state.answer = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    await draw(React.createElement(ScheduleScreen, { origin: "home" }));
    await settle();
    const first = state.queries.at(-1)!;
    state.answer = async () => answer([]);
    await click("Next day");
    expect(state.queries.at(-1)!.from).toBe(first.until);
    await React.act(async () => {
      release?.(answer([current]));
    });
    await settle();
    expect(container.textContent).not.toContain(current.title);
    expect(container.textContent).toContain("No programme information");
    await React.act(async () => {
      await install("b");
    });
    await draw(React.createElement(ScheduleScreen, { origin: "home" }));
    expect(container.textContent).toContain("Channel unavailable");
    state.params = { channel: "b:1" };
    state.answer = async () => {
      throw new Error("private error must not escape");
    };
    await draw(React.createElement(ScheduleScreen, { origin: "home" }));
    await settle();
    expect(container.textContent).toContain("Guide unavailable");
    expect(container.textContent).not.toContain("private error");
  });

  it("keeps stale last-good programmes and has honest cold, gap and failed states", async () => {
    await install("a", 3, 7 * 3600_000);
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain("Guide may be out of date");
    expect(container.textContent).toContain(current.title);
    state.answer = async () => answer([]);
    await React.act(async () => owner().foreground());
    await settle();
    expect(container.textContent).toContain(current.title);
    await React.act(async () => owner().forget("a"));
    await settle();
    expect(container.textContent).toContain("No programme information");
    expect(container.textContent).not.toContain("Loading schedule");
  });

  it("bounds Live to 40 visible keys and Home to 12, with no per-row clocks", async () => {
    await install("a", 75);
    state.visible = 60;
    await draw(React.createElement(LiveHome));
    await settle();
    expect(state.queries.length).toBeLessThanOrEqual(52);
    expect(new Set(state.queries.flatMap((query) => query.ids))).toHaveLength(39);
    expect(state.queries.some((query) => query.ids.includes("trusted-41"))).toBe(false);
    state.queries = [];
    await draw(React.createElement(Home));
    await settle();
    expect(state.queries.length).toBeLessThanOrEqual(12);
    await React.act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(state.queries.length).toBeLessThanOrEqual(24);
  });

  it("reconciles Today at midnight and issues local calendar bounds across DST", async () => {
    state.params = { channel: "a:1" };
    state.answer = async () => answer([]);
    vi.setSystemTime(new Date(2026, 9, 24, 23, 59, 30));
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    const before = state.queries.at(-1)!;
    await React.act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(state.queries.at(-1)!.from).toBe(before.until);
    expect(container.textContent).toContain("Today");
    const oldZone = process.env.TZ;
    process.env.TZ = "Europe/Amsterdam";
    try {
      vi.setSystemTime(new Date(2026, 9, 25, 12));
      await React.act(async () => owner().foreground());
      await settle();
      let query = state.queries.at(-1)!;
      expect(query.until - query.from).toBe(25 * 3600_000);
      vi.setSystemTime(new Date(2026, 2, 29, 12));
      await React.act(async () => owner().foreground());
      await settle();
      // Restore a currently usable fixture generation for the spring clock.
      await React.act(async () => install());
      await settle();
      query = state.queries.at(-1)!;
      expect(query.until - query.from).toBe(23 * 3600_000);
    } finally {
      if (oldZone === undefined) delete process.env.TZ;
      else process.env.TZ = oldZone;
    }
  });
  it("navigates real local day boundaries when midnight is skipped", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Santiago";
    try {
      vi.setSystemTime(new Date(2026, 8, 6, 12));
      state.params = { channel: "a:1" };
      state.answer = async () => answer([]);
      await install();
      await draw(React.createElement(ScheduleScreen, { origin: "live" }));
      await settle();
      const from = new Date(2026, 8, 6).getTime();
      const until = new Date(2026, 8, 7).getTime();
      expect(state.queries.at(-1)).toMatchObject({ from, until });
      expect(until - from).toBe(23 * 3600_000);
      expect(container.textContent).not.toContain("Guide unavailable");
      await click("Next day");
      expect(state.queries.at(-1)).toMatchObject({
        from: until,
        until: new Date(2026, 8, 8).getTime(),
      });
      await click("Previous day");
      expect(state.queries.at(-1)).toMatchObject({ from, until });
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it("retires held listings on provider removal and never paints the old channel after replacement", async () => {
    const releases: ((value: Result<Query>) => void)[] = [];
    state.answer = (_mode, _ids, _from, _until, _after, lease) =>
      lease === "lease-a"
        ? new Promise((resolve) => {
            releases.push(resolve);
          })
        : Promise.resolve(answer([]));
    await draw(React.createElement(Home));
    await settle();
    await React.act(async () => {
      await owner().forget("a");
      await install("b");
    });
    state.answer = async () => answer([]);
    await draw(React.createElement(Home));
    await settle();
    await React.act(async () => {
      for (const release of releases) release(answer([current]));
    });
    await settle();
    expect(container.textContent).not.toContain(current.title);
    expect(container.querySelector('[data-testid="home-channel-b:1"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="home-channel-a:1"]')).toBeNull();
  });

  it("uses the owner minute tick for progress and drops subscriptions and reads on blur", async () => {
    await draw(React.createElement(Home));
    await settle();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "50",
    );
    await React.act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await settle();
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "52",
    );
    state.focused = false;
    await draw(React.createElement(Home));
    await settle();
    const count = state.queries.length;
    await React.act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await settle();
    expect(state.queries).toHaveLength(count);
    state.focused = true;
    await draw(React.createElement(Home));
    await settle();
    expect(state.queries.length).toBeGreaterThan(count);
    expect(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe(
      "55",
    );
  });

  it("shows a real next programme in a gap without fabricated progress and settles read-admission refusal", async () => {
    state.answer = async () => answer([next]);
    await draw(React.createElement(Home));
    await settle();
    expect(container.textContent).toContain(next.title);
    expect(container.querySelector('[data-testid="home-stage"]')?.textContent).toContain(
      next.title,
    );
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.textContent).toContain("News");
    fixture().native.revoke("a");
    state.params = { channel: "a:1" };
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    expect(container.textContent).toContain("No programme information");
    expect(container.textContent).not.toContain("Loading schedule");
  });
  it("shows unavailable guide recovery through existing settings without inventing a retry queue", async () => {
    const restore = fixture().native.restore;
    try {
      fixture().native.restore = async () => {
        throw new Error("private native description");
      };
      await install("c");
      await draw(React.createElement(LiveHome));
      await settle();
      await click("Guide");
      expect(container.textContent).toContain("Guide unavailable");
      expect(container.textContent).not.toContain("private native description");
      await click("Provider settings");
      expect(state.did).toEqual(["/live/settings"]);
    } finally {
      fixture().native.restore = restore;
    }
  });

  it.each([
    ["Home", Home],
    ["Live", LiveHome],
  ] as const)(
    "keeps settled %s programmes mounted through a held minute read and failure",
    async (_name, Screen) => {
      await draw(React.createElement(Screen));
      await settle();
      const gate = holdQueries(async () =>
        answer([{ ...current, title: "Updated broadcast" }, next]),
      );
      await tick();
      expect(container.textContent).toContain(current.title);
      expect(container.textContent).not.toContain("Loading programme");
      await gate.release();
      expect(container.textContent).toContain("Updated broadcast");
      state.answer = async () => {
        throw new Error("private read failure");
      };
      await tick();
      expect(container.textContent).toContain("Updated broadcast");
      expect(container.textContent).not.toContain("private read failure");
    },
  );

  it("retains the represented schedule span across a held tick, mounted Programme and Back, then replaces both pages atomically", async () => {
    state.params = { channel: "a:1" };
    const pages = async (
      _mode: string,
      _ids: readonly string[],
      _from: number,
      _until: number,
      after: number,
    ) => (after < 0 ? answer([current], true) : answer([next]));
    state.answer = pages;
    let inspection = false;
    const stack = () =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          state.focusContext!.Provider,
          { value: !inspection },
          React.createElement(ScheduleScreen, { origin: "home" }),
        ),
        inspection
          ? React.createElement(
              state.focusContext!.Provider,
              { value: true },
              React.createElement(ProgrammeScreen, { origin: "home" }),
            )
          : null,
      );
    await draw(stack());
    await settle();
    await click("Next day");
    const representedDay = state.queries.at(-1)!.from;
    await click("Show more");
    const schedule = container.querySelector('[data-testid="guide-schedule"]')!;
    const row = schedule.querySelector(`[data-testid="programme-${next.start}"]`);
    let gate = holdQueries(pages);
    await tick();
    expect(schedule.textContent).toContain(current.title);
    expect(schedule.textContent).toContain(next.title);
    expect(schedule.querySelector(`[data-testid="programme-${next.start}"]`)).toBe(row);
    await gate.release();
    expect(schedule.textContent).toContain(next.title);
    await click(`programme-${current.start}`);
    state.params = (state.did.at(-1) as { params: typeof state.params }).params;
    state.answer = async (mode, ids, from, until, after) =>
      mode === "detail" ? answer([current]) : pages(mode, ids, from, until, after);
    inspection = true;
    await draw(stack());
    await settle();
    expect(schedule.textContent).toContain(next.title);
    const dayReads = state.queries.filter((query) => query.mode === "day").length;
    await tick();
    expect(state.queries.filter((query) => query.mode === "day")).toHaveLength(dayReads);
    gate = holdQueries(pages);
    inspection = false;
    await draw(stack());
    await settle();
    expect(schedule.textContent).toContain(next.title);
    expect(schedule.textContent).not.toContain("Loading schedule");
    expect(state.queries.filter((query) => query.mode === "day").at(-1)!.from).toBe(representedDay);
    await gate.release();
    expect(schedule.textContent).toContain(next.title);
    let releaseSecond: (() => void) | undefined;
    state.answer = async (_mode, _ids, _from, _until, after) =>
      after < 0
        ? answer([{ ...current, title: "New first page" }], true)
        : new Promise((resolve) => {
            releaseSecond = () => resolve(answer([{ ...next, title: "New second page" }]));
          });
    const activation = fixture().control.activations.get("a")!;
    fixture().control.activations.set("a", {
      ...activation,
      generation: {
        id: "new-generation",
        fetchedAt: Date.now() + 1,
        until: Date.now() + 86400_000,
      },
    });
    await React.act(async () => {
      await owner().restore(["a"]);
    });
    await settle();
    expect(schedule.textContent).toContain(next.title);
    expect(schedule.textContent).not.toContain("New first page");
    expect(releaseSecond).toBeDefined();
    await React.act(async () => releaseSecond?.());
    await settle();
    expect(schedule.textContent).toContain("New first page");
    expect(schedule.textContent).toContain("New second page");
    expect(schedule.textContent).not.toContain(current.title);
    expect(schedule.textContent).not.toContain(next.title);
    state.answer = async () => {
      throw new Error("private refresh error");
    };
    await tick();
    expect(schedule.textContent).toContain("New second page");
    expect(schedule.textContent).toContain("Couldn't update schedule");
  });

  it("fences source replacement with the same catalogue and retires held answers from the previous login", async () => {
    const provider = xtreamProvider(
      { server: "https://fixture.test", username: "fixture", password: "canary" },
      { userAgent: "fixture" },
    );
    await React.act(async () => {
      setSource("a", { revision: 1, provider, login: [] });
      await owner().attach("a");
    });
    const catalogue = state.catalogue;
    const oldLease = fixture().control.activations.get("a")!.lease;
    await draw(React.createElement(Home));
    await settle();
    expect(container.textContent).toContain(current.title);
    const gate = holdQueries(async (_mode, _ids, _from, _until, _after, lease) =>
      answer([
        { ...current, title: lease === oldLease ? "Retired source title" : "New source title" },
      ]),
    );
    await tick();
    await React.act(async () => {
      setSource("a", { revision: 2, provider, login: [] });
      await owner().attach("a");
    });
    await settle();
    expect(state.catalogue).toBe(catalogue);
    expect(container.textContent).not.toContain(current.title);
    await gate.release();
    expect(container.textContent).toContain("New source title");
    expect(container.textContent).not.toContain("Retired source title");
    expect(currentSource("a")?.revision).toBe(2);
  });

  it.each([true, false])(
    "keeps separate provider lines on two providers, populated guide: %s",
    async (populated) => {
      const a = part("a"),
        b = part("b");
      state.answer = async () => answer(populated ? [current, next] : []);
      fixture().control.activations.set("b", {
        lease: "lease-b",
        generation: { id: "db-b", fetchedAt: Date.now(), until: Date.now() + 86400_000 },
      });
      await owner().restore(["a", "b"]);
      owner().setPart(a);
      owner().setPart(b);
      state.catalogue = {
        kind: "ready",
        failing: [],
        library: combine([
          { label: "line.alpha-tv.example", part: a },
          { label: "line.beta-tv.example", part: b },
        ]),
      };
      await draw(React.createElement(LiveHome));
      await settle();
      await click("Guide");
      state.did = [];
      for (const [id, label] of [
        ["a", "line.alpha-tv.example"],
        ["b", "line.beta-tv.example"],
      ] as const) {
        const row = container.querySelector(`[data-testid="channel-${id}:1"]`)!;
        if (populated) expect(row.textContent).toContain(current.title);
        expect(row.textContent).toContain(label);
        expect(row.getAttribute("aria-label")).toContain(label);
        expect(row.getAttribute("aria-label")!.split(label)).toHaveLength(2);
        if (populated) expect(row.getAttribute("aria-label")).toContain(current.title);
        expect(
          container.querySelector(`[data-testid="schedule-${id}:1"]`)?.getAttribute("aria-label"),
        ).toContain(label);
        await click(`channel-${id}:1`);
        await click(`schedule-${id}:1`);
        expect(state.did).toContainEqual({ play: `${id}:1`, watch: true });
        expect(state.did).toContainEqual({
          pathname: "/live/schedule",
          params: { channel: `${id}:1` },
        });
      }
      await draw(React.createElement(Home));
      await settle();
      state.did = [];
      for (const [id, label] of [
        ["a", "line.alpha-tv.example"],
        ["b", "line.beta-tv.example"],
      ] as const) {
        const tile = container.querySelector(`[data-testid="home-channel-${id}:1"]`)!;
        if (populated) expect(tile.textContent).toContain(current.title);
        expect(tile.textContent).toContain(label);
        expect([...tile.querySelectorAll("div")].some((line) => line.textContent === label)).toBe(
          true,
        );
        expect(tile.getAttribute("aria-label")).toContain(label);
        if (populated) expect(tile.getAttribute("aria-label")).toContain(current.title);
        expect(
          container
            .querySelector(`[data-testid="home-schedule-${id}:1"]`)
            ?.getAttribute("aria-label"),
        ).toContain(label);
        await click(`home-channel-${id}:1`);
        await click(`home-schedule-${id}:1`);
        expect(state.did).toContainEqual({ play: `${id}:1`, watch: false });
        expect(state.did).toContainEqual({ pathname: "/schedule", params: { channel: `${id}:1` } });
      }
    },
  );

  it("keeps inspected programme text mounted across a held minute read and settles retired details", async () => {
    state.params = { channel: "a:1" };
    state.answer = async () => answer([current]);
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    await click(`programme-${current.start}`);
    state.params = (state.did.at(-1) as { params: typeof state.params }).params;
    await draw(React.createElement(ProgrammeScreen, { origin: "live" }));
    await settle();
    const detail = container.querySelector('[data-testid="guide-programme"]')!;
    const text = detail.textContent;
    const gate = holdQueries(async () => answer([current]));
    await tick();
    expect(detail.textContent).toBe(text);
    expect(detail.textContent).toContain(current.description);
    await gate.release();
    fixture().control.activations.set("a", {
      ...fixture().control.activations.get("a")!,
      generation: { id: "replacement", fetchedAt: Date.now() + 1, until: Date.now() + 86400_000 },
    });
    await React.act(async () => owner().restore(["a"]));
    await settle();
    expect(detail.textContent).toContain("Programme unavailable");
    expect(detail.textContent).not.toContain("Loading programme");
  });

  it("does not append a held Show more reply over a refresh and keeps known rows after failed pagination", async () => {
    state.params = { channel: "a:1" };
    const pages = async (
      _mode: string,
      _ids: readonly string[],
      _from: number,
      _until: number,
      after: number,
    ) => (after < 0 ? answer([current], true) : answer([next]));
    state.answer = pages;
    await draw(React.createElement(ScheduleScreen, { origin: "live" }));
    await settle();
    const gate = holdQueries(pages);
    await click("Show more");
    await tick();
    expect(container.textContent).toContain(current.title);
    await gate.release();
    expect(container.querySelectorAll(`[data-testid="programme-${current.start}"]`)).toHaveLength(
      1,
    );
    await click("Show more");
    expect(container.querySelectorAll(`[data-testid="programme-${next.start}"]`)).toHaveLength(1);
    // Start a new day so its own initial page has an independent valid cursor.
    await click("Next day");
    state.answer = async () => {
      throw new Error("private pagination error");
    };
    await click("Show more");
    expect(container.textContent).toContain(current.title);
    expect(container.textContent).toContain("Couldn't update schedule");
    expect(container.textContent).not.toContain("private pagination error");
  });
});
