// @vitest-environment happy-dom
// Live TV's guide grid: the switch from the list and back, kept as a preference, the keys and
// clicks that move between programmes and channels and open a programme's details, what Enter,
// Watch live and Play from start play on channels with and without catch-up, how far back and
// ahead it reaches, and the pages of the guide it reads, only those around what is in view.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { queries, syncGuideUpdates } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";

// The tests' clock: 10:40:20 on a day without a clock change, well inside most of the test
// guide's programmes (ten minutes into One's half hour, twenty-five into Two's hour) and twenty
// seconds into Four's, running on in real time. What is on now, aired or to come is then the same
// whenever the tests run, and the app's own clock, read as its modules load, agrees with it.
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 9, 14, 10, 40, 20));
});
afterAll(() => vi.useRealTimers());

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const channel = (id: string, title: string, catchupDays: number | null = null): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: title,
  title,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: [],
  variants: [{ id, name: title, tags: [], quality: null, ...(catchupDays ? { catchupDays } : {}) }],
  catchupDays,
});

/** The hour the tests' guide is laid out from. */
const BASE = Math.floor(Date.now() / HOUR) * HOUR;

/**
 * The guide the main process has: channel 1 in half hours, channel 2 in hours a quarter past,
 * channel 3 without any and channel 4 in hours from twenty to; every other channel in hours.
 */
function programmesOf(id: string): Programme[] {
  if (id === "3") return [];
  const length = id === "1" ? HOUR / 2 : HOUR;
  const offset = id === "2" ? 15 * MINUTE : id === "4" ? 40 * MINUTE : 0;
  return Array.from({ length: (2 * 7 * 24 * HOUR) / length }, (_, slot) => {
    const start = BASE - 7 * 24 * HOUR + offset + slot * length;
    return {
      start,
      stop: start + length,
      title: `${id === "1" ? "One" : id === "2" ? "Two" : `Ch${id}`} ${(start - BASE) / MINUTE}`,
      description: `About ${(start - BASE) / MINUTE}.`,
    };
  });
}
const guide = new Map<string, Programme[]>();
function titleAt(id: string, at: number): string | undefined {
  if (!guide.has(id)) guide.set(id, programmesOf(id));
  return guide.get(id)!.find((programme) => programme.start <= at && at < programme.stop)?.title;
}

// happy-dom lays nothing out: the grid gets a size, and each row its own.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset["index"] === undefined ? 900 : 49;
  },
});
Object.defineProperty(HTMLElement.prototype, "clientWidth", {
  configurable: true,
  get: () => 1000,
});

let unmount = () => {};
afterEach(() => {
  unmount();
  player.reset();
});

const ready = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { interval: 10 },
  );

/** Live TV on all of `channels`, in the grid, with the guide answering from `programmesOf`. */
async function gridPage(
  channels: readonly LiveChannel[],
  view: "list" | "grid" = "grid",
  /** Where the subscription's guide ends, as its status says; unknown without. */
  until: number | null = null,
  /** What the main process does before the page opens, as holding its first answers. */
  before: () => void = () => {},
) {
  ipc.reset();
  ipc.prefer({ liveView: view });
  const all = (id: string) => guide.get(id) ?? guide.set(id, programmesOf(id)).get(id)!;
  // Slots without descriptions, each of the channel's own guide channel, as the main process
  // answers them; the details read the description by the slot's guide and start.
  ipc.answer("guide.range", ({ channels: asked, from, to }) =>
    Object.fromEntries(
      asked.flatMap((owned) => {
        const slots = all(owned.id)
          .filter((programme) => programme.stop > from && programme.start < to)
          .map(({ start, stop, title }) => ({ start, stop, title, guide: `${owned.id}.guide` }));
        return slots.length ? [[ownedKey(owned), slots]] : [];
      }),
    ),
  );
  ipc.answer(
    "guide.programme",
    ({ channel, guide, start }) =>
      (guide === `${channel.id}.guide` &&
        all(channel.id).find((programme) => programme.start === start)) ||
      null,
  );
  ipc.answer("preferences.update", (patch) => ({ ...defaultPreferences, ...patch }));
  ipc.always("guide.status", [
    {
      subscriptionId: SUBSCRIPTION,
      channels: 3,
      supplied: [{ source: null, channels: 3 }],
      listed: channels.length,
      guideChannels: 3,
      fetchedAt: 1,
      availability: "available",
      mapped: 0,
      unresolved: 0,
      processing:
        until === null
          ? { state: "reading", programmes: 10, since: 1 }
          : { state: "ready", channels: 3, programmes: 10, until, fetchedAt: 1 },
    },
  ]);
  ipc.always("library.searchGroups", []);
  ipc.always("guide.listings", {});
  before();
  useUi.setState({
    view: "live",
    list: { kind: "all" },
    watching: false,
    searchOpen: false,
    searchFrom: "",
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.categories().queryKey, [
    {
      subscriptionId: SUBSCRIPTION,
      id: "all",
      members: [{ subscriptionId: SUBSCRIPTION, id: "all" }],
      name: "All",
      group: null,
      title: "All",
      channelCount: channels.length,
    },
  ]);
  client.setQueryData(queries.channels(null).queryKey, channels);
  client.setQueryData(
    ["library", "status"],
    [
      {
        subscriptionId: SUBSCRIPTION,
        channelCount: channels.length,
        fetchedAt: 1,
        failure: null,
        failedAt: null,
      },
    ],
  );
  client.setQueryData(queries.viewing().queryKey, {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(GuidePage, { active: true })),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  const grid = () => container.querySelector<HTMLElement>('[role="grid"]');
  return {
    client,
    grid,
    /** The cell the grid names as its active one, by its accessible name. */
    active: () => {
      const id = grid()?.getAttribute("aria-activedescendant");
      return id ? (document.getElementById(id)?.getAttribute("aria-label") ?? null) : null;
    },
    /** A cell's accessible name, by what it shows. */
    label: (title: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="gridcell"]')]
        .find((cell) => cell.textContent === title)
        ?.getAttribute("aria-label") ?? null,
    /** The details' button called `label`. */
    action: (label: string) =>
      [
        ...container.querySelectorAll<HTMLButtonElement>('[role="grid"] [role="region"] button'),
      ].find((button) => button.textContent?.trim() === label),
    /** The channel rows drawn, by name. */
    rows: () =>
      [...container.querySelectorAll('[role="row"] [role="rowheader"]')].map((cell) =>
        cell.getAttribute("title"),
      ),
    /** The indexes of the rows drawn. */
    drawn: () =>
      [...container.querySelectorAll<HTMLElement>("[data-index]")].map((row) =>
        Number(row.dataset["index"]),
      ),
    /** The cell with the cursor, by what it shows. */
    selected: () =>
      container.querySelector('[role="gridcell"][aria-selected="true"]')?.textContent ?? null,
    /** The details open under a row, or null. */
    details: () => container.querySelector('[role="grid"] [role="region"]')?.textContent ?? null,
    cell: (title: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="gridcell"]')].find(
        (cell) => cell.textContent === title,
      ),
    rowHeader: (title: string) =>
      [...container.querySelectorAll<HTMLElement>('[role="rowheader"]')].find((cell) =>
        cell.textContent?.includes(title),
      ),
    press: (key: string) =>
      act(async () => {
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }),
    click: (label: string) =>
      act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.trim() === label)
          ?.click(),
      ),
    /** Scrolls the grid across to `left` pixels from its start. */
    scrollAcross: (left: number) =>
      act(async () => {
        const element = grid()!;
        element.scrollLeft = left;
        element.dispatchEvent(new Event("scroll"));
      }),
    /** The labels of the details' buttons, in order. */
    actions: () =>
      [...container.querySelectorAll('[role="grid"] [role="region"] button')].map((button) =>
        button.textContent?.trim(),
      ),
    scroll: (by: { top?: number; left?: number }) =>
      act(async () => {
        const element = grid()!;
        element.scrollTop += by.top ?? 0;
        element.scrollLeft += by.left ?? 0;
        element.dispatchEvent(new Event("scroll"));
      }),
  };
}

const THREE = [channel("1", "One"), channel("2", "Two"), channel("3", "Three")];

describe("the guide grid", () => {
  it("switches from the list with Guide and back with List, and with G", async () => {
    const page = await gridPage(THREE, "list");
    expect(page.grid()).toBeNull();
    await page.click("Guide");
    await ready(() => expect(page.rows()).toEqual(["One", "Two", "Three"]));
    expect(ipc.argsOf("preferences.update")).toEqual([{ liveView: "grid" }]);
    // The view is the preferences' and shows once they say so.
    await page.click("List");
    await ready(() => expect(page.grid()).toBeNull());
    await page.press("g");
    await ready(() => expect(page.grid()).not.toBeNull());
    await page.press("G");
    await ready(() => expect(page.grid()).toBeNull());
    expect(ipc.argsOf("preferences.update").at(-1)).toEqual({ liveView: "list" });
  });

  it("opens in the grid when that is the view kept, and Escape goes to the list before Home", async () => {
    const page = await gridPage(THREE);
    await ready(() => expect(page.rows()).toEqual(["One", "Two", "Three"]));
    await page.press("Escape");
    await ready(() => expect(page.grid()).toBeNull());
    expect(useUi.getState().view).toBe("live");
    await page.press("Escape");
    expect(useUi.getState().view).toBe("home");
  });

  it("moves between programmes with the arrows, keeps the time between channels, and opens the details of each", async () => {
    const page = await gridPage(THREE);
    await ready(() => expect(page.cell(titleAt("1", Date.now())!)).toBeDefined());
    const now = titleAt("1", Date.now())!;
    const after = titleAt("1", Date.now() + HOUR / 2)!;

    await page.press("ArrowRight");
    expect(page.selected()).toBe(after);
    expect(page.details()).toContain(after);
    expect(page.details()).toContain("Watch live");

    // Down keeps to the moment the cursor is at, and a channel without a guide says so.
    const start = guide.get("1")!.find((programme) => programme.title === after)!.start;
    await page.press("ArrowDown");
    expect(page.selected()).toBe(titleAt("2", start));
    await page.press("ArrowDown");
    expect(page.details()).toContain("No programme information");
    await page.press("ArrowUp");
    await page.press("ArrowUp");
    expect(page.selected()).toBe(after);

    // Into the past, where a programme still only watches the channel live.
    await page.press("ArrowLeft");
    await page.press("ArrowLeft");
    expect(page.selected()).toBe(titleAt("1", Date.now() - HOUR / 2));
    expect(page.selected()).not.toBe(now);
    expect(page.details()).toContain("Watch live");
    expect(page.details()).not.toContain("Play from start");

    await page.press("Enter");
    expect(player.state().channel?.id).toBe("1");
    expect(useUi.getState().watching).toBe(true);
  });

  it("hands the keys to the lists from the start of the grid, and takes them back with Right", async () => {
    const page = await gridPage(THREE);
    await ready(() => expect(page.cell(titleAt("1", Date.now())!)).toBeDefined());
    // The grid reaches a couple of hours back: fewer than ten half hours.
    for (let press = 0; press < 10; press++) await page.press("ArrowLeft");
    const first = page.details();
    expect(first).not.toBeNull();
    await page.press("ArrowDown");
    expect(page.details()).toBe(first);
    await page.press("ArrowRight");
    await page.press("ArrowDown");
    const start = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
    expect(page.details()).toContain(titleAt("2", start));
  });

  it("jumps ten channels with PageDown and to the ends with Home and End", async () => {
    const many = Array.from({ length: 40 }, (_, at) => channel(String(at + 10), `Channel ${at}`));
    const page = await gridPage(many);
    await ready(() => expect(page.rows().length).toBeGreaterThan(10));
    await page.press("PageDown");
    expect(page.details()).toContain(titleAt("20", Date.now()));
    await page.press("End");
    await ready(() => expect(page.details()).toContain(titleAt("49", Date.now())));
    await page.press("Home");
    await ready(() => expect(page.details()).toContain(titleAt("10", Date.now())));
  });

  it("opens a programme's details with a click, closes them with another, and watches from the channel", async () => {
    const page = await gridPage(THREE);
    const later = titleAt("2", Date.now() + 2 * HOUR)!;
    await ready(() => expect(page.cell(later)).toBeDefined());

    await act(async () => page.cell(later)!.click());
    expect(page.details()).toContain(later);
    expect(page.details()).toContain("Watch live");
    await act(async () => page.cell(later)!.click());
    expect(page.details()).toBeNull();

    await act(async () => page.cell(later)!.click());
    await page.click("Watch live");
    expect(player.state().channel?.id).toBe("2");
    expect(useUi.getState().watching).toBe(true);

    await act(async () => useUi.setState({ watching: false }));
    await act(async () => page.rowHeader("Three")!.click());
    expect(player.state().channel?.id).toBe("3");
  });

  it("plays an aired programme from its start where the channel keeps catch-up, and only live where it doesn't", async () => {
    const page = await gridPage([channel("1", "One", 3), channel("2", "Two")]);
    await ready(() => expect(page.cell(titleAt("1", Date.now())!)).toBeDefined());
    expect(page.rowHeader("One")?.querySelector('[aria-label="Catch-up"]')).not.toBeNull();
    expect(page.rowHeader("Two")?.querySelector('[aria-label="Catch-up"]')).toBeNull();

    // On now: Watch live first, Play from start second; the details read the description.
    await page.press("ArrowRight");
    await page.press("ArrowLeft");
    const now = guide.get("1")!.find((p) => p.start <= Date.now() && Date.now() < p.stop)!;
    await ready(() => expect(page.details()).toContain(now.description));
    expect(page.actions()).toEqual(["Watch live", "Play from start"]);

    // Ended, within the archive: Play from start comes first, and Enter plays it.
    await page.press("ArrowLeft");
    const aired = guide.get("1")!.find((p) => p.stop === now.start)!;
    expect(page.selected()).toBe(aired.title);
    expect(page.actions()).toEqual(["Play from start", "Watch live"]);
    await ready(() => expect(page.details()).toContain(aired.description));
    await page.press("Enter");
    expect(player.state().channel?.id).toBe("1");
    expect(player.state().archive).toEqual(aired);
    expect(useUi.getState().watching).toBe(true);

    // Ended on a channel without catch-up: dimmed, and only live.
    await act(async () => {
      useUi.setState({ watching: false });
      player.reset();
    });
    await page.press("ArrowDown");
    await page.press("ArrowLeft");
    const before = guide.get("2")!.find((p) => p.title === page.selected())!;
    expect(before.stop).toBeLessThanOrEqual(Date.now());
    // Ended programmes the archive can play say so, those it can't, dimmed, don't.
    const earlier = guide.get("2")!.find((p) => p.stop === before.start)!;
    const older = guide.get("1")!.find((p) => p.stop === aired.start)!;
    expect(page.label(earlier.title)).not.toContain("Catch-up");
    expect(page.label(older.title)).toContain("Catch-up");
    expect(page.actions()).toEqual(["Watch live"]);
    await page.press("Enter");
    expect(player.state().channel?.id).toBe("2");
    expect(player.state().archive).toBeNull();
  });

  it("plays a programme that began within the minute from its start too", async () => {
    const page = await gridPage([channel("4", "Four", 3)]);
    const four = guide.get("4") ?? programmesOf("4");
    const begun = four.find((p) => p.start <= Date.now() && Date.now() < p.stop)!;
    expect(Date.now() - begun.start).toBeLessThan(MINUTE);
    await ready(() => expect(page.cell(begun.title)).toBeDefined());
    await act(async () => page.cell(begun.title)!.click());
    expect(page.actions()).toEqual(["Watch live", "Play from start"]);
    await page.click("Play from start");
    expect(player.state().archive?.title).toBe(begun.title);
  });

  it("plays the programme on now from its start with Play from start, and an aired one with a double click", async () => {
    const page = await gridPage([channel("1", "One", 3)]);
    const now = titleAt("1", Date.now())!;
    await ready(() => expect(page.cell(now)).toBeDefined());
    await act(async () => page.cell(now)!.click());
    await page.click("Play from start");
    expect(player.state().archive?.title).toBe(now);

    await act(async () => {
      useUi.setState({ watching: false });
      player.reset();
    });
    const aired = titleAt("1", Date.now() - HOUR)!;
    await act(async () =>
      page.cell(aired)!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    expect(player.state().archive?.title).toBe(aired);
  });

  it("shows a search's copies of one channel as one row, the copy Enter plays in the list", async () => {
    const copy = { ...channel("1", "One"), subscriptionId: "870468e9-b944-4e10-bcfa-6330f80b45dc" };
    const page = await gridPage([channel("1", "One"), channel("2", "Two"), copy]);
    await ready(() => expect(page.rows()).toEqual(["One", "Two", "One"]));
    ipc.always("library.searchGroups", [
      { key: "one", copies: [ownedKey(channel("1", "One")), ownedKey(copy)] },
    ]);
    ipc.always("guide.searchList", {});
    await page.press("/");
    await act(async () => {
      const field = document.activeElement as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(field, "one");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ready(() => expect(page.rows()).toEqual(["One"]));
  });

  it("watches the channel live from a recording of it, by Watch live, Enter on now and the channel", async () => {
    const page = await gridPage([channel("1", "One", 3), channel("2", "Two")]);
    await ready(() => expect(page.cell(titleAt("1", Date.now())!)).toBeDefined());
    const recording = async () => {
      await act(async () => useUi.setState({ watching: false }));
      // A click opens the programme's details, or closes them when they were open on it.
      const aired = page.cell(titleAt("1", Date.now() - HOUR)!)!;
      await act(async () => aired.click());
      if (!page.action("Play from start")) await act(async () => aired.click());
      await page.click("Play from start");
      expect(player.state().archive).not.toBeNull();
      await act(async () => useUi.setState({ watching: false }));
    };

    await recording();
    await page.click("Watch live");
    expect(player.state().archive).toBeNull();
    expect(player.state().channel?.id).toBe("1");
    expect(useUi.getState().watching).toBe(true);

    await recording();
    await act(async () => page.cell(titleAt("1", Date.now())!)!.click());
    await page.press("Enter");
    expect(player.state().archive).toBeNull();

    await recording();
    await act(async () => page.rowHeader("One")!.click());
    expect(player.state().archive).toBeNull();
  });

  it("leaves Enter to a details button that has the focus", async () => {
    const page = await gridPage([channel("1", "One", 3)]);
    const aired = titleAt("1", Date.now() - HOUR)!;
    await ready(() => expect(page.cell(aired)).toBeDefined());
    await act(async () => page.cell(aired)!.click());
    expect(page.actions()).toEqual(["Play from start", "Watch live"]);
    const live = page.action("Watch live")!;
    live.focus();
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => live.dispatchEvent(enter));
    // The page leaves it to the button, which a browser then presses.
    expect(enter.defaultPrevented).toBe(false);
    expect(player.state().channel).toBeNull();
    await act(async () => live.click());
    expect(player.state().channel?.id).toBe("1");
    expect(player.state().archive).toBeNull();
  });

  it("drops a range read that was under way when the guide changed, and shows the new guide", async () => {
    let held: ReturnType<typeof ipc.hold<"guide.range">> | undefined;
    const page = await gridPage(THREE, "grid", null, () => (held = ipc.hold("guide.range")));
    await ready(() => expect(ipc.argsOf("guide.range").length).toBeGreaterThan(0));
    const first = ipc.argsOf("guide.range")[0]!;
    const answer = (title: string, from: number, to: number, asked: typeof first.channels) =>
      Object.fromEntries(
        asked.map((owned) => [
          ownedKey(owned),
          programmesOf(owned.id)
            .filter((programme) => programme.stop > from && programme.start < to)
            .map(({ start, stop }) => ({ start, stop, title, guide: title })),
        ]),
      );
    ipc.answer("guide.range", ({ channels: asked, from, to }) =>
      answer("New guide", from, to, asked),
    );
    const stop = syncGuideUpdates(page.client);
    try {
      await act(async () => ipc.emit("guide.updated", null));
      await act(async () =>
        held!.resolve(answer("Old guide", first.from, first.to, first.channels)),
      );
      await ready(() => expect(page.cell("New guide")).toBeDefined());
      // Long enough for the old answer to show, were it kept.
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(page.cell("Old guide")).toBeUndefined();
      expect(page.rowHeader("One")?.closest('[role="row"]')?.textContent).toContain("New guide");
    } finally {
      stop();
    }
  });

  it("names the cell with the cursor as the grid's active one, a stretch without guide too", async () => {
    const page = await gridPage(THREE);
    await ready(() => expect(page.cell(titleAt("1", Date.now())!)).toBeDefined());
    await page.press("ArrowRight");
    expect(document.activeElement).toBe(page.grid());
    expect(page.active()).toContain(titleAt("1", Date.now() + HOUR / 2));
    await page.press("ArrowDown");
    await page.press("ArrowDown");
    expect(page.active()).toContain("No programme information");
  });

  it("takes the keys back from the lists when the focus comes into the grid, and gives them up when it goes there", async () => {
    const page = await gridPage(THREE);
    await ready(() => expect(page.cell(titleAt("1", Date.now())!)).toBeDefined());
    // Left past the grid's start hands the keys to the lists: Down there moves no programme.
    for (let press = 0; press < 10; press++) await page.press("ArrowLeft");
    const first = page.details();
    await page.press("ArrowDown");
    expect(page.details()).toBe(first);

    // Tab into the grid: Down moves its cursor, and Enter watches the cell it is on.
    await act(async () => page.grid()!.focus());
    await page.press("ArrowDown");
    const start = Math.floor((Date.now() - 2 * HOUR) / HOUR) * HOUR;
    expect(page.details()).toContain(titleAt("2", start));
    await page.press("Enter");
    expect(player.state().channel?.id).toBe("2");
    expect(useUi.getState().watching).toBe(true);

    // The focus going into the lists' field gives the lists the keys again.
    await act(async () => useUi.setState({ watching: false }));
    const shown = page.details();
    await act(async () =>
      document.querySelector<HTMLInputElement>('[role="navigation"] input')!.focus(),
    );
    await act(async () => (document.activeElement as HTMLElement).blur());
    await page.press("ArrowDown");
    expect(page.details()).toBe(shown);
  });

  it("keeps the cursor on its channel when the list changes under it", async () => {
    const page = await gridPage(THREE);
    await ready(() => expect(page.cell(titleAt("2", Date.now())!)).toBeDefined());
    await page.press("ArrowDown");
    const two = titleAt("2", Date.now())!;
    expect(page.details()).toContain(two);
    await act(async () =>
      page.client.setQueryData(queries.channels(null).queryKey, [THREE[2]!, THREE[1]!, THREE[0]!]),
    );
    await ready(() => expect(page.rows()).toEqual(["Three", "Two", "One"]));
    expect(page.details()).toContain(two);
    await page.press("ArrowDown");
    expect(page.details()).toContain(titleAt("1", Date.now()));
  });

  it("reaches back as far as the list's longest archive, and ahead to where its guide ends", async () => {
    const until = Date.now() + 5 * HOUR;
    const page = await gridPage([channel("1", "One", 3), channel("2", "Two")], "grid", until);
    await ready(() => expect(ipc.argsOf("guide.range").length).toBeGreaterThan(0));
    await page.scrollAcross(0);
    await ready(() =>
      expect(Math.min(...ipc.argsOf("guide.range").map((args) => args.from))).toBeLessThan(
        Date.now() - 3 * 24 * HOUR + 6 * HOUR,
      ),
    );
    const earliest = Math.min(...ipc.argsOf("guide.range").map((args) => args.from));
    expect(earliest).toBeGreaterThan(Date.now() - 3 * 24 * HOUR - 7 * HOUR);

    await page.scrollAcross(10_000_000);
    const latest = () => Math.max(...ipc.argsOf("guide.range").map((args) => args.to));
    await ready(() => expect(latest()).toBeGreaterThanOrEqual(until));
    expect(latest()).toBeLessThanOrEqual(until + 6 * HOUR);
  });

  it("reads the guide only for the channels and hours in view, and the next ones as it scrolls", async () => {
    const many = Array.from({ length: 2000 }, (_, at) => channel(String(at + 1), `Channel ${at}`));
    const page = await gridPage(many);
    const reads = () =>
      ipc.argsOf("guide.range").map((args) => ({
        from: args.from,
        to: args.to,
        rows: args.channels.map((each) => Number(each.id) - 1),
      }));
    /** Waits until no read has been asked for a while: those for what is drawn are all in. */
    const settled = async () => {
      let count = -1;
      await vi.waitFor(
        async () => {
          await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
          const now = reads().length;
          const same = now === count;
          count = now;
          expect(same && now > 0).toBe(true);
        },
        { interval: 10, timeout: 5000 },
      );
    };
    const pageOf = (row: number) => Math.floor(row / 25);
    await settled();

    // The first rows in view, and a few hours around now.
    for (const read of reads()) {
      expect(Math.max(...read.rows)).toBeLessThan(50);
      expect(read.to - read.from).toBeLessThanOrEqual(6 * HOUR);
      expect(read.from).toBeGreaterThan(Date.now() - 12 * HOUR);
      expect(read.to).toBeLessThan(Date.now() + 12 * HOUR);
    }

    // Down a thousand rows: the pages of the rows drawn there, and the cursor's, at the top,
    // which stays drawn so the keys find its programmes.
    let asked = reads().length;
    await page.scroll({ top: 1000 * 49 });
    await ready(() =>
      expect(
        reads()
          .slice(asked)
          .some((read) => Math.min(...read.rows) > 800),
      ).toBe(true),
    );
    await settled();
    const drawn = new Set(page.drawn().map(pageOf));
    expect(Math.min(...page.drawn().filter((row) => row > 0))).toBeGreaterThan(800);
    for (const read of reads().slice(asked)) expect(drawn).toContain(pageOf(read.rows[0]!));

    // A day ahead: only the hours around then.
    asked = reads().length;
    const hourPx = 14 * 16;
    await page.scroll({ left: 24 * hourPx });
    await ready(() => expect(reads().length).toBeGreaterThan(asked));
    await settled();
    for (const read of reads().slice(asked)) {
      expect(read.from).toBeGreaterThan(Date.now() + 12 * HOUR);
      expect(read.to).toBeLessThan(Date.now() + 36 * HOUR);
      expect(drawn).toContain(pageOf(read.rows[0]!));
    }

    // Every page of channels and hours was read once.
    const pages = reads().map((read) => `${read.rows[0]} ${read.from}`);
    expect(new Set(pages).size).toBe(pages.length);
  });
});
