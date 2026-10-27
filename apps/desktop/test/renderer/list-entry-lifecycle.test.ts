// @vitest-environment happy-dom
// Where a list of the viewer's begins, and how a change to one ends, in Live TV. New list in a
// channel row's lists menu opens the rail's name field wherever the rail was, in a provider's
// categories or a Find, and makes the list with that channel; Escape makes none, and the list on
// screen stays. While one list is being made, another row's New list leaves its field, name and
// channel as they are. A delete or rename answered after the viewer moved on ends only what it
// began: a list chosen meanwhile stays chosen, with its new order or its own field as they are. The
// list on screen, deleted from here, gives way to All channels without saying it went, whether its
// answer or the lists read again come first, and also once Live TV was left and opened again while
// the delete was out. One that goes otherwise, after a failed delete too, still says so, and
// another window knows nothing of this one's deletes. Of changes sent side by side, the last that
// failed shows with its Retry or Close until the viewer answers it or another fails: another
// answering meanwhile leaves it. A saved order's answer gives way to lists read again while its
// channels were read, and to subscriptions saved since.
import { browseResult } from "./browse-support.ts";
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomList } from "@mrstreamer/contracts/custom-lists";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import type { OwnedId, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { App } from "../../src/renderer/src/app/App.tsx";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { SubscriptionSection } from "../../src/renderer/src/features/settings/SubscriptionSection.tsx";
import { queries, syncCustomLists } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const own = (id: string): OwnedId => ({ subscriptionId: "one", id });

/** A provider's categories in one country: News holds channels 1 and 2, Sport channel 3. */
const HOLDS: Record<string, readonly string[]> = { news: ["1", "2"], sport: ["3"] };
const category = (id: string, title: string): Category => ({
  ...own(id),
  members: [own(id)],
  name: `UK | ${title.toUpperCase()}`,
  group: "United Kingdom",
  title,
  channelCount: HOLDS[id]?.length ?? 0,
});
const CATEGORIES = [category("news", "News"), category("sport", "Sport")];

const channel = (id: string): LiveChannel => ({
  ...own(id),
  name: `UK | CHANNEL ${id}`,
  title: `Channel ${id}`,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: [id === "3" ? "sport" : "news"],
  catchupDays: null,
  variants: [{ id, name: `UK | CHANNEL ${id}`, tags: [], quality: null }],
});

const subscription: SubscriptionSummary = {
  kind: "xtream",
  id: "one",
  name: null,
  server: "http://line.example.tv",
  username: "one",
  account: { state: "active", expiresAt: null, maxConnections: 1, activeConnections: 0 },
  needsSecret: false,
};

/** One of the viewer's lists holding `ids`, in that order, at `revision`. */
const list = (id: string, name: string, ids: readonly string[], revision = 2): CustomList => ({
  id,
  name,
  revision,
  members: ids.map((each) => ({ member: `${id}-${each}`, kind: "listed", channel: own(each) })),
  away: 0,
});
const ALPHA = list("alpha", "Alpha", ["1", "2"]);
const BETA = list("beta", "Beta", ["3", "1"]);

// happy-dom lays nothing out: the list gets a height and each row its own.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset["index"] === undefined ? 900 : 60;
  },
});

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  player.reset();
  titlePlayer.close();
  vi.useRealTimers();
});

const settled = (ms = 20) => act(() => vi.advanceTimersByTimeAsync(ms));

/**
 * Live TV on `shown`, with the viewer's `lists` as stored, which `store` changes. With `app`,
 * the whole window, whose bar leaves Live TV and opens it again; with `settings`, Settings'
 * subscriptions open beside the page, as the window shows them over it.
 */
async function livePage(
  shown: ChannelList,
  lists: readonly CustomList[] = [],
  { app = false, settings = false } = {},
) {
  ipc.reset();
  useUi.setState({
    view: "live",
    list: shown,
    watching: false,
    searchOpen: false,
    searchFrom: "",
    settings: settings ? "subscriptions" : null,
    details: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchQuery(queries.preferences());
  let stored = lists;
  const viewing: Viewing = {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  };
  client.setQueryData(["subscriptions"], [subscription]);
  client.setQueryData(queries.categories().queryKey, CATEGORIES);
  client.setQueryData(
    ["library", "status"],
    [{ subscriptionId: "one", channelCount: 3, fetchedAt: 1, failure: null, failedAt: null }],
  );
  client.setQueryData(["viewing"], viewing);
  client.setQueryData(queries.customLists().queryKey, stored);
  // The library answers a category or a list of channels with their channels, in that order.
  ipc.answer("library.browse", (query) =>
    browseResult(
      query.scope.kind === "channels"
        ? query.scope.channels.map((each) => ({ ...channel(each.id), ...each }))
        : (query.scope.kind === "category"
            ? (HOLDS[query.scope.category.id] ?? [])
            : ["1", "2", "3"]
          ).map(channel),
    ),
  );
  ipc.always("library.searchGroups", []);
  ipc.answer("customLists.get", () => stored);
  ipc.always("viewing.get", viewing);
  if (app) {
    // The window reads these itself, and remembers the list shown.
    ipc.always("subscription.list", [subscription]);
    ipc.always("library.categories", CATEGORIES);
    ipc.always("ondemand.status", { lists: [], metadata: null });
    if (shown.kind === "custom") ipc.always("liveBrowse.get", { kind: "custom", id: shown.id });
  }
  if (settings) {
    client.setQueryData(["guide", "status"], []);
    client.setQueryData(["ondemand", "status"], { lists: [], metadata: null });
  }
  const stopLists = syncCustomLists(client);
  const mounted = queryView(client);
  const { container } = mounted;
  const besideView = queryView(client);
  const beside = besideView.container;
  if (settings) await besideView.render(createElement(SubscriptionSection));
  await mounted.render(
    app
      ? createElement(TooltipProvider, null, createElement(App))
      : createElement(GuidePage, { active: true }),
  );
  unmount = () => {
    stopLists();
    mounted.unmount();
    besideView.unmount();
  };
  await settled();

  const button = (label: string, within: ParentNode = container) => {
    const buttons = [...within.querySelectorAll("button")];
    return (
      buttons.find((each) => each.getAttribute("aria-label") === label) ??
      buttons.find((each) => each.textContent?.trim().startsWith(label))
    );
  };
  const press = (target: Element | null | undefined, what: string) =>
    act(async () => {
      if (!target) throw new Error(`No ${what}.`);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  /**
   * Chooses `item` in the open menu, which shows outside the page, as a pointer does: over it,
   * which makes it the menu's item, then a click.
   */
  const choose = async (item: string) => {
    await settled();
    const target = [...document.querySelectorAll('[role^="menuitem"]')].find(
      (each) => each.textContent?.trim() === item,
    );
    await act(async () => {
      target?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, movementX: 1 }));
    });
    await settled();
    await press(target, `menu item "${item}"`);
    await settled();
  };
  const rail = () => container.querySelector('[role="navigation"]')!;
  return {
    /** Stores `lists` as the main process would after a change, for the lists' next read. */
    store: (lists: readonly CustomList[]) => {
      stored = lists;
    },
    /**
     * Stores `lists` and says the lists changed, as the main process does once a change is
     * stored, whether or not its answer is out yet: the window reads them again.
     */
    changed: async (lists: readonly CustomList[]) => {
      stored = lists;
      await act(async () => ipc.emit("customLists.changed", null));
      await settled();
    },
    heading: () => container.querySelector("main h1")?.textContent,
    rows: () =>
      [...container.querySelectorAll("[data-index]")].map(
        (row) => row.querySelector("[data-name]")?.textContent,
      ),
    /** The order being made, if one is: its rows' list, and Save. */
    drafting: () =>
      !!container.querySelector('[role="list"][aria-label$="in the order to save"]') ||
      !!button("Save"),
    /** The rail's entry for `title`, if it shows. */
    entry: (title: string) => rail().querySelector<HTMLButtonElement>(`button[title="${title}"]`),
    find: () => rail().querySelector<HTMLInputElement>('input[aria-label="Find a category"]')!,
    /** New list's field in the rail, or a list's own in its header. */
    newName: () => rail().querySelector<HTMLInputElement>('input[aria-label="List name"]'),
    rename: () => container.querySelector<HTMLInputElement>('main input[aria-label="List name"]'),
    text: () => container.textContent ?? "",
    click: (label: string) => press(button(label), `button "${label}"`),
    /** Opens a page from the window's bar, as the viewer does. */
    open: async (name: string) => {
      await press(
        [...container.querySelectorAll("header nav button")].find(
          (each) => each.textContent?.trim() === name,
        ),
        `${name} in the window's bar`,
      );
      await settled();
    },
    /** Picks a list in the rail with the pointer, and waits for its channels. */
    pick: async (title: string) => {
      await press(rail().querySelector(`button[title="${title}"]`), `rail entry "${title}"`);
      await settled();
    },
    /** Opens a channel row's lists menu and chooses New list. */
    newListFrom: async (title: string) => {
      await press(button(`Lists for ${title}`), `lists menu of ${title}`);
      await choose("New list");
    },
    /** Ticks or clears each of `lists` in a row's lists menu, one after the other, then closes it. */
    tick: async (row: string, lists: readonly string[]) => {
      await press(button(`Lists for ${row}`), `lists menu of ${row}`);
      for (const name of lists) await choose(name);
      await act(async () => {
        document
          .querySelector('[role="menu"]')
          ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await settled();
    },
    /** The line under the filters for a change that failed, if one shows: its words and button. */
    alert: () => {
      const line = container.querySelector('main p[role="alert"]');
      return line
        ? `${line.firstElementChild?.textContent} ${line.lastElementChild?.textContent}`
        : null;
    },
    /** Presses that line's button: Retry, or Close. */
    respond: () =>
      press(container.querySelector('main p[role="alert"] > button'), "the line's button"),
    /** Adds a subscription in Settings with `fields`, as the main process `added` it. */
    addSubscription: async (fields: readonly string[], added: SubscriptionSummary) => {
      await press(
        [...beside.querySelectorAll("button")].find(
          (each) => each.textContent?.trim() === "Add subscription",
        ),
        "Add subscription",
      );
      await settled();
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () =>
        beside.querySelectorAll("form input").forEach((input, index) => {
          setValue.call(input, fields[index] ?? "");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }),
      );
      const sent = ipc.hold("subscription.add");
      await act(async () => {
        beside
          .querySelector("form")
          ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await settled();
      await act(async () => sent.resolve(added));
      await settled();
    },
    /** Opens the header menu of the list on screen and chooses `item`. */
    option: async (name: string, item: string) => {
      await press(button(`Options for ${name}`), `options of ${name}`);
      await choose(item);
    },
    type: (field: HTMLInputElement, text: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          field,
          text,
        );
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    key: (target: Element, key: string) =>
      act(async () => {
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }),
  };
}

describe("New list in a channel row's lists menu", () => {
  it("shows the rail's field from a provider's category, and makes the list with that channel once", async () => {
    const page = await livePage({ kind: "category", category: own("news") });
    expect(page.heading()).toBe("News");
    expect(page.newName()).toBeNull();

    await page.newListFrom("Channel 2");
    const field = page.newName();
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    // The category stays on screen while the list is named.
    expect(page.heading()).toBe("News");
    expect(page.rows()).toEqual(["Channel 1", "Channel 2"]);

    await page.type(field!, "Picks");
    const made = ipc.hold("customLists.create");
    await page.key(field!, "Enter");
    await page.key(field!, "Enter");
    expect(ipc.argsOf("customLists.create")).toEqual([
      { id: expect.any(String), name: "Picks", channel: own("2") },
    ]);
    const [{ id } = { id: "" }] = ipc.argsOf("customLists.create");
    const picks = list(id, "Picks", ["2"], 1);
    page.store([picks]);
    await act(async () => made.resolve([picks]));
    await settled();
    expect(page.heading()).toBe("Picks");
    expect(page.rows()).toEqual(["Channel 2"]);
    expect(ipc.argsOf("customLists.create")).toHaveLength(1);
  });

  it("shows the field over the rail's Find, for a channel of the list on screen", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA]);
    await page.type(page.find(), "sport");
    expect(page.entry("Alpha")).toBeNull();

    await page.newListFrom("Channel 1");
    const field = page.newName();
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    expect(page.find().value).toBe("");
    expect(page.heading()).toBe("Alpha");

    await page.type(field!, "Mornings");
    const made = ipc.hold("customLists.create");
    await page.key(field!, "Enter");
    expect(ipc.argsOf("customLists.create")).toEqual([
      { id: expect.any(String), name: "Mornings", channel: own("1") },
    ]);
    const [{ id } = { id: "" }] = ipc.argsOf("customLists.create");
    const mornings = list(id, "Mornings", ["1"], 1);
    page.store([ALPHA, mornings]);
    await act(async () => made.resolve([ALPHA, mornings]));
    await settled();
    expect(page.heading()).toBe("Mornings");
    expect(page.rows()).toEqual(["Channel 1"]);
  });

  it("keeps a list being made, its name and channel, when another row's New list is chosen", async () => {
    const page = await livePage({ kind: "all" }, [ALPHA]);
    await page.newListFrom("Channel 3");
    await page.type(page.newName()!, "Late");
    const made = ipc.hold("customLists.create");
    await page.key(page.newName()!, "Enter");
    expect(ipc.argsOf("customLists.create")).toEqual([
      { id: expect.any(String), name: "Late", channel: own("3") },
    ]);

    // New list in another row while that list is being made.
    await page.newListFrom("Channel 2");
    expect(page.newName()?.value).toBe("Late");
    expect(page.newName()?.readOnly).toBe(true);
    await page.key(page.newName()!, "Enter");
    expect(ipc.argsOf("customLists.create")).toHaveLength(1);

    // Its own answer ends it as ever: the list is made with its channel, and chosen.
    const [{ id } = { id: "" }] = ipc.argsOf("customLists.create");
    const late = list(id, "Late", ["3"], 1);
    page.store([ALPHA, late]);
    await act(async () => made.resolve([ALPHA, late]));
    await settled();
    expect(page.newName()).toBeNull();
    expect(page.heading()).toBe("Late");
    expect(page.rows()).toEqual(["Channel 3"]);

    // A later New list from a row works as ever.
    await page.pick("All channels");
    await page.newListFrom("Channel 2");
    expect(page.newName()?.value).toBe("");
    expect(document.activeElement).toBe(page.newName());
    await page.type(page.newName()!, "Early");
    const again = ipc.hold("customLists.create");
    await page.key(page.newName()!, "Enter");
    const [, { id: second } = { id: "" }] = ipc.argsOf("customLists.create");
    expect(ipc.argsOf("customLists.create")).toEqual([
      { id, name: "Late", channel: own("3") },
      { id: second, name: "Early", channel: own("2") },
    ]);
    const early = list(second, "Early", ["2"], 1);
    page.store([ALPHA, late, early]);
    await act(async () => again.resolve([ALPHA, late, early]));
    await settled();
    expect(page.heading()).toBe("Early");
    expect(page.rows()).toEqual(["Channel 2"]);
  });

  it("starts another list from a row once the one being made failed", async () => {
    const page = await livePage({ kind: "all" }, [ALPHA]);
    await page.newListFrom("Channel 3");
    await page.type(page.newName()!, "Late");
    const made = ipc.hold("customLists.create");
    await page.key(page.newName()!, "Enter");
    await act(async () => made.reject({ kind: "unexpected", detail: "database is locked" }));
    await settled();
    expect(page.text()).toContain("Couldn't save.");

    await page.newListFrom("Channel 2");
    expect(page.newName()?.value).toBe("");
    expect(page.newName()?.readOnly).toBe(false);
    await page.type(page.newName()!, "Early");
    const again = ipc.hold("customLists.create");
    await page.key(page.newName()!, "Enter");
    expect(ipc.argsOf("customLists.create").at(-1)).toEqual({
      id: expect.any(String),
      name: "Early",
      channel: own("2"),
    });
    const [, { id } = { id: "" }] = ipc.argsOf("customLists.create");
    const early = list(id, "Early", ["2"], 1);
    page.store([ALPHA, early]);
    await act(async () => again.resolve([ALPHA, early]));
    await settled();
    expect(page.heading()).toBe("Early");
    expect(page.rows()).toEqual(["Channel 2"]);
  });

  it("makes no list on Escape, and leaves the category on screen", async () => {
    const page = await livePage({ kind: "category", category: own("news") });
    await page.newListFrom("Channel 1");
    const field = page.newName();
    expect(document.activeElement).toBe(field);
    await page.type(field!, "Never mind");
    await page.key(field!, "Escape");
    await settled();

    expect(page.newName()).toBeNull();
    expect(ipc.argsOf("customLists.create")).toEqual([]);
    expect(useUi.getState()).toMatchObject({
      view: "live",
      list: { kind: "category", category: own("news") },
    });
    expect(page.heading()).toBe("News");
    expect(page.rows()).toEqual(["Channel 1", "Channel 2"]);
  });
});

describe("a delete or rename answered after the viewer moved on", () => {
  it("leaves the list chosen meanwhile chosen, with its new order, when the delete is answered", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    expect(ipc.argsOf("customLists.remove")).toEqual([{ id: "alpha" }]);

    await page.pick("Beta");
    await page.click("Reorder");
    await page.click("Move Channel 3 down");
    expect(page.rows()).toEqual(["Channel 1", "Channel 3"]);

    // The lists are read again without Alpha before its delete is answered.
    await page.changed([BETA]);
    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(page.entry("Alpha")).toBeNull();
    expect(page.text()).not.toContain("no longer listed");
    expect(useUi.getState().list).toEqual({ kind: "custom", id: "beta" });
    expect(page.heading()).toBe("Beta");
    expect(page.drafting()).toBe(true);
    expect(page.rows()).toEqual(["Channel 1", "Channel 3"]);

    // Beta's Save is Beta's alone.
    const arranged = ipc.hold("customLists.arrange");
    await page.click("Save");
    expect(ipc.argsOf("customLists.arrange")).toEqual([
      { list: "beta", revision: 2, order: ["beta-1", "beta-3"] },
    ]);
    const saved = list("beta", "Beta", ["1", "3"], 3);
    page.store([saved]);
    await act(async () => arranged.resolve([saved]));
    await settled();
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(["Channel 1", "Channel 3"]);
  });

  it("leaves the field another list opened meanwhile, when the delete is answered", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    await page.pick("Beta");
    await page.option("Beta", "Rename");
    await page.type(page.rename()!, "Beta weekend");

    await page.changed([BETA]);
    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(useUi.getState().list).toEqual({ kind: "custom", id: "beta" });
    expect(page.rename()?.value).toBe("Beta weekend");
  });

  it("leaves the field another list opened meanwhile, when a rename is answered", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Rename");
    await page.type(page.rename()!, "Alpha news");
    const renamed = ipc.hold("customLists.rename");
    await page.key(page.rename()!, "Enter");
    expect(ipc.argsOf("customLists.rename")).toEqual([{ id: "alpha", name: "Alpha news" }]);

    await page.pick("Beta");
    await page.option("Beta", "Rename");
    await page.type(page.rename()!, "Beta weekend");
    const news = { ...ALPHA, name: "Alpha news", revision: 3 };
    page.store([news, BETA]);
    await act(async () => renamed.resolve([news, BETA]));
    await settled();
    expect(page.entry("Alpha news")).not.toBeNull();
    expect(page.rename()?.value).toBe("Beta weekend");
  });

  it("leaves a newer field of the same list, when its earlier rename is answered", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Rename");
    await page.type(page.rename()!, "Alpha news");
    const renamed = ipc.hold("customLists.rename");
    await page.key(page.rename()!, "Enter");

    await page.pick("Beta");
    await page.pick("Alpha");
    await page.option("Alpha", "Rename");
    await page.type(page.rename()!, "Alpha late");
    const news = { ...ALPHA, name: "Alpha news", revision: 3 };
    page.store([news, BETA]);
    await act(async () => renamed.resolve([news, BETA]));
    await settled();
    expect(page.rename()?.value).toBe("Alpha late");
  });
});

describe("deleting the list on screen", () => {
  it("falls back to All channels, saying nothing, when the delete is answered first", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    page.store([BETA]);
    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(useUi.getState().list).toEqual({ kind: "all" });
    expect(page.heading()).toBe("All channels");
    expect(page.entry("Alpha")).toBeNull();
    expect(page.text()).not.toContain("no longer listed");

    // The change it stored is said afterwards, and read again.
    await page.changed([BETA]);
    expect(page.heading()).toBe("All channels");
    expect(page.text()).not.toContain("no longer listed");
  });

  it("says nothing either when the lists are read without it before the delete is answered", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    await page.changed([BETA]);
    expect(useUi.getState().list).toEqual({ kind: "all" });
    expect(page.heading()).toBe("All channels");
    expect(page.text()).not.toContain("no longer listed");

    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(page.heading()).toBe("All channels");
    expect(page.entry("Alpha")).toBeNull();
    expect(page.text()).not.toContain("no longer listed");
  });

  it("says nothing when an earlier delete of it failed while a later one was out", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const earlier = ipc.hold("customLists.remove");
    await page.click("Delete list");
    await page.pick("Beta");
    await page.pick("Alpha");
    await page.option("Alpha", "Delete list");
    const later = ipc.hold("customLists.remove");
    await page.click("Delete list");
    expect(ipc.argsOf("customLists.remove")).toEqual([{ id: "alpha" }, { id: "alpha" }]);

    await act(async () => earlier.reject({ kind: "unexpected", detail: "database is locked" }));
    await settled();
    await page.changed([BETA]);
    await act(async () => later.resolve([BETA]));
    await settled();
    expect(page.heading()).toBe("All channels");
    expect(page.text()).not.toContain("no longer listed");
  });

  it("leaves another list's notice when a late delete is answered", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    await page.pick("Beta");
    // Beta goes otherwise, and says so; Alpha's answer leaves that as it is.
    await page.changed([]);
    expect(page.text()).toContain("Beta is no longer listed. Showing all channels.");
    await act(async () => removed.resolve([]));
    await settled();
    expect(page.heading()).toBe("All channels");
    expect(page.text()).toContain("Beta is no longer listed. Showing all channels.");
  });

  it("starts another window without this one's deletes", async () => {
    const first = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await first.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await first.click("Delete list");
    first.store([BETA]);
    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(first.heading()).toBe("All channels");
    unmount();

    // Another window, with a client of its own, shows Alpha until it goes otherwise.
    const second = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    expect(second.heading()).toBe("Alpha");
    await second.changed([BETA]);
    expect(second.text()).toContain("Alpha is no longer listed. Showing all channels.");
  });

  it("keeps the list and Retry when the delete fails, and says so when it goes otherwise", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    await act(async () => removed.reject({ kind: "unexpected", detail: "database is locked" }));
    await settled();
    expect(page.heading()).toBe("Alpha");
    expect(page.entry("Alpha")).not.toBeNull();
    expect(page.text()).toContain("Couldn't save.");

    await page.changed([BETA]);
    expect(page.heading()).toBe("All channels");
    expect(page.text()).toContain("Alpha is no longer listed. Showing all channels.");
  });
});

describe("leaving Live TV while the delete of its list is out", () => {
  /** Live TV on Alpha, whose delete is sent and held, left for Home and opened again. */
  async function leftAndBack() {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA], { app: true });
    await page.option("Alpha", "Delete list");
    const removed = ipc.hold("customLists.remove");
    await page.click("Delete list");
    await page.open("Home");
    expect(useUi.getState().view).toBe("home");
    await page.open("Live TV");
    expect(page.heading()).toBe("Alpha");
    return { page, removed };
  }

  it("says nothing when the lists are read without it before the delete is answered", async () => {
    const { page, removed } = await leftAndBack();
    await page.changed([BETA]);
    expect(page.heading()).toBe("All channels");
    expect(page.text()).not.toContain("no longer listed");
    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(page.heading()).toBe("All channels");
    expect(page.text()).not.toContain("no longer listed");
  });

  it("says nothing when the delete is answered first", async () => {
    const { page, removed } = await leftAndBack();
    page.store([BETA]);
    await act(async () => removed.resolve([BETA]));
    await settled();
    expect(page.heading()).toBe("All channels");
    expect(page.text()).not.toContain("no longer listed");
    await page.changed([BETA]);
    expect(page.text()).not.toContain("no longer listed");
  });

  it("says so when the delete failed meanwhile and the list goes otherwise", async () => {
    const { page, removed } = await leftAndBack();
    await act(async () => removed.reject({ kind: "unexpected", detail: "database is locked" }));
    await settled();
    expect(page.heading()).toBe("Alpha");
    await page.changed([BETA]);
    expect(page.heading()).toBe("All channels");
    expect(page.text()).toContain("Alpha is no longer listed. Showing all channels.");
  });
});

describe("changes sent side by side", () => {
  const locked = { kind: "unexpected", detail: "database is locked" } as const;

  it("keeps a failure and its Retry when an earlier change succeeds after it", async () => {
    const page = await livePage({ kind: "all" }, [ALPHA, BETA]);
    const toAlpha = ipc.hold("customLists.setMember", (change) => change.list === "alpha");
    const fromBeta = ipc.hold("customLists.setMember", (change) => change.list === "beta");
    await page.tick("Channel 3", ["Alpha", "Beta"]);
    expect(ipc.argsOf("customLists.setMember")).toEqual([
      { list: "alpha", channel: own("3"), member: true },
      { list: "beta", channel: own("3"), member: false },
    ]);
    await act(async () => fromBeta.reject(locked));
    await settled();
    expect(page.alert()).toBe("Couldn't save. Retry");
    await act(async () => toAlpha.resolve([list("alpha", "Alpha", ["1", "2", "3"], 3), BETA]));
    await settled();
    expect(page.alert()).toBe("Couldn't save. Retry");

    // Retry sends Beta's change again, the one that failed.
    const again = ipc.hold("customLists.setMember");
    await page.respond();
    expect(ipc.argsOf("customLists.setMember").at(-1)).toEqual({
      list: "beta",
      channel: own("3"),
      member: false,
    });
    await act(async () =>
      again.resolve([list("alpha", "Alpha", ["1", "2", "3"], 3), list("beta", "Beta", ["1"], 3)]),
    );
    await settled();
    expect(page.alert()).toBeNull();
  });

  it("keeps an earlier failure while a later change starts and succeeds, until it is closed", async () => {
    const page = await livePage({ kind: "all" }, [ALPHA, BETA]);
    const toAlpha = ipc.hold("customLists.setMember");
    await page.tick("Channel 3", ["Alpha"]);
    await act(async () => toAlpha.reject({ kind: "list-changed" }));
    await settled();
    expect(page.alert()).toBe("This list changed. Close");

    const toBeta = ipc.hold("customLists.setMember");
    await page.tick("Channel 2", ["Beta"]);
    expect(page.alert()).toBe("This list changed. Close");
    await act(async () => toBeta.resolve([ALPHA, list("beta", "Beta", ["3", "1", "2"], 3)]));
    await settled();
    expect(page.alert()).toBe("This list changed. Close");
    await page.respond();
    expect(page.alert()).toBeNull();
  });

  it("retries the change whose failure shows, whatever answers before it", async () => {
    const page = await livePage({ kind: "all" }, [ALPHA, BETA]);
    const toAlpha = ipc.hold("customLists.setMember", (change) => change.list === "alpha");
    const fromBeta = ipc.hold("customLists.setMember", (change) => change.list === "beta");
    await page.tick("Channel 3", ["Alpha", "Beta"]);
    await act(async () => fromBeta.reject(locked));
    await settled();

    // The viewer sends Beta's again. Alpha's fails meanwhile, then Beta's goes through.
    const betaAgain = ipc.hold("customLists.setMember", (change) => change.list === "beta");
    await page.respond();
    expect(page.alert()).toBeNull();
    await act(async () => toAlpha.reject(locked));
    await settled();
    expect(page.alert()).toBe("Couldn't save. Retry");
    await act(async () => betaAgain.resolve([ALPHA, list("beta", "Beta", ["1"], 3)]));
    await settled();
    expect(page.alert()).toBe("Couldn't save. Retry");

    const alphaAgain = ipc.hold("customLists.setMember", (change) => change.list === "alpha");
    await page.respond();
    expect(ipc.argsOf("customLists.setMember").at(-1)).toEqual({
      list: "alpha",
      channel: own("3"),
      member: true,
    });
    await act(async () =>
      alphaAgain.resolve([
        list("alpha", "Alpha", ["1", "2", "3"], 3),
        list("beta", "Beta", ["1"], 3),
      ]),
    );
    await settled();
    expect(page.alert()).toBeNull();
  });
});

describe("a saved order's answer, and lists newer than it", () => {
  /** Saves Alpha's order with Channel 1 moved down, and holds the read of the answer's channels. */
  async function savedOrder(
    page: Awaited<ReturnType<typeof livePage>>,
    answer: readonly CustomList[],
  ) {
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    const arranged = ipc.hold("customLists.arrange");
    await page.click("Save");
    const reading = ipc.hold(
      "library.browse",
      (query) =>
        query.scope.kind === "channels" &&
        query.scope.channels.map((each) => each.id).join() === "2,1",
    );
    await act(async () => arranged.resolve(answer));
    await settled();
    return () => act(async () => reading.resolve(browseResult([channel("2"), channel("1")])));
  }

  it("keeps lists read again while the answer's channels were read", async () => {
    const page = await livePage({ kind: "custom", id: "alpha" }, [ALPHA, BETA]);
    const saved = list("alpha", "Alpha", ["2", "1"], 3);
    const read = await savedOrder(page, [saved, BETA]);
    // Meanwhile Beta is deleted, Gamma made and Alpha renamed.
    await page.changed([
      { ...saved, name: "Alpha news", revision: 4 },
      list("gamma", "Gamma", ["3"], 1),
    ]);
    await read();
    await settled();
    expect(page.drafting()).toBe(false);
    expect(page.heading()).toBe("Alpha news");
    expect(page.rows()).toEqual(["Channel 2", "Channel 1"]);
    expect(page.entry("Beta")).toBeNull();
    expect(page.entry("Gamma")).not.toBeNull();
  });

  it("leaves the answer for the subscriptions saved before one was added meanwhile", async () => {
    // Alpha keeps a channel of a subscription that isn't saved: one away.
    const away = { ...ALPHA, away: 1 };
    const page = await livePage({ kind: "custom", id: "alpha" }, [away, BETA], { settings: true });
    expect(page.text()).toContain("from a subscription that isn't saved");
    const read = await savedOrder(page, [
      { ...list("alpha", "Alpha", ["2", "1"], 3), away: 1 },
      BETA,
    ]);

    // That subscription is added in Settings meanwhile, and the lists read again hold its
    // channel among Alpha's.
    const two: SubscriptionSummary = {
      ...subscription,
      id: "two",
      name: "Backup",
      username: "two",
    };
    const back = list("alpha", "Alpha", ["2", "1"], 3);
    ipc.always("subscription.list", [subscription, two]);
    page.store([
      {
        ...back,
        members: [
          ...back.members,
          { member: "alpha-9", kind: "listed", channel: { subscriptionId: "two", id: "9" } },
        ],
      },
      BETA,
    ]);
    await page.addSubscription(["Backup", "tv.backup.example:8080", "two", "s3cret"], two);
    await read();
    await settled();
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(["Channel 2", "Channel 1", "Channel 9"]);
    expect(page.text()).not.toContain("from a subscription that isn't saved");
  });
});
