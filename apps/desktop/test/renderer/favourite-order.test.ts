// @vitest-environment happy-dom
// Putting the favourites in another order in Live TV: the buttons of a row and the keys, where
// the focus goes as a channel moves through a list longer than the window, what Save sends once
// and what a failure leaves, that nothing plays meanwhile, and what ends a draft or keeps one.
import { browseChannels, browseChannelsOf, browseResult } from "./browse-support.ts";
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import {
  ownedKey,
  type OwnedId,
  type SubscriptionSummary,
} from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import {
  queries,
  syncGuideUpdates,
  syncLibraryUpdates,
  syncViewing,
} from "../../src/renderer/src/lib/queries.ts";

/** Names a channel or category by the provider's id, as the subscription "one" lists it. */
const own = (id: string): OwnedId => ({ subscriptionId: "one", id });

const channel = (id: string): LiveChannel => ({
  ...own(id),
  name: `UK | CHANNEL ${id}`,
  title: `Channel ${id}`,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: ["uk"],
  catchupDays: null,
  variants: [{ id, name: `UK | CHANNEL ${id}`, tags: [], quality: null }],
});

/** Favourites the list doesn't show: one for adults, and one the provider no longer lists. */
const HIDDEN = ["adult", "gone"] as const;

const subscription = (id: string): SubscriptionSummary => ({
  kind: "xtream",
  id,
  name: null,
  server: "http://line.example.tv",
  username: id,
  account: { state: "active", expiresAt: null, maxConnections: 1, activeConnections: 0 },
  needsSecret: false,
});

// happy-dom lays nothing out, and the list draws only the rows that fit: the list gets a height
// and each row its own.
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
  vi.useRealTimers();
});

/**
 * Lets the page take in what just happened, and a search's pause in typing pass, on the fake
 * clock.
 */
const settled = (ms = 20) => act(() => vi.advanceTimersByTimeAsync(ms));

const titles = (ids: readonly string[]) => ids.map((id) => `Channel ${id}`);

/**
 * Live TV on Favourites, with `count` channels starred in the order of their numbers. The record
 * also holds the two favourites the list doesn't show, after the first channel and at the end.
 */
async function favouritesPage(count: number, list: ChannelList = { kind: "favourites" }) {
  ipc.reset();
  useUi.setState({ view: "live", list, watching: false, searchOpen: false, searchFrom: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchQuery(queries.preferences());
  const shown = Array.from({ length: count }, (_, index) => String(index + 1));
  const favourites = [...shown.slice(0, 1), HIDDEN[0], ...shown.slice(1), HIDDEN[1]].map(own);
  const channels = shown.map(channel);
  client.setQueryData(["subscriptions"], [subscription("one")]);
  client.setQueryData(queries.categories().queryKey, [
    {
      ...own("uk"),
      members: [own("uk")],
      name: "UK | NEWS",
      group: null,
      title: "News",
      channelCount: count,
    },
  ]);
  client.setQueryData(browseChannels(null).queryKey, browseResult(channels));
  client.setQueryData(browseChannelsOf(favourites).queryKey, browseResult(channels));
  ipc.always("library.searchGroups", []);
  client.setQueryData(
    ["library", "status"],
    [{ subscriptionId: "one", channelCount: count, fetchedAt: 1, failure: null, failedAt: null }],
  );
  const viewing: Viewing = {
    favourites,
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  };
  client.setQueryData(["viewing"], viewing);
  const view = queryView(client);
  const { container } = view;
  await view.render(createElement(GuidePage, { active: true }));
  unmount = view.unmount;
  await settled();

  /** A button by its label, or else by the words it begins with. */
  const button = (label: string) => {
    const buttons = [...container.querySelectorAll("button")];
    return (
      buttons.find((each) => each.getAttribute("aria-label") === label) ??
      buttons.find((each) => each.textContent?.trim().startsWith(label))
    );
  };
  const rowOf = (title: string) =>
    [...container.querySelectorAll("[data-index]")].find(
      (row) => row.querySelector("[data-name]")?.textContent === title,
    );
  return {
    client,
    favourites,
    viewing,
    button,
    /** The channels drawn, top to bottom: the rows in view, and the one that holds the focus. */
    rows: () =>
      [...container.querySelectorAll("[data-index]")].map(
        (row) => row.querySelector("[data-name]")?.textContent,
      ),
    /** Where a channel stands in the list, from 0, when its row is drawn. */
    indexOf: (title: string) => Number(rowOf(title)?.getAttribute("data-index") ?? Number.NaN),
    /** What has the focus, by its name: a row's channel, or a button's label. */
    focused: () => document.activeElement?.getAttribute("aria-label") ?? null,
    /** What a screen reader was told last. */
    said: () => container.querySelector('[role="status"]')?.textContent ?? "",
    text: () => container.querySelector("main")?.textContent ?? "",
    /** Whether the page takes input at all. */
    inert: () => container.firstElementChild?.hasAttribute("inert") ?? false,
    click: (label: string, { shift = false } = {}) =>
      act(async () => {
        const target = button(label);
        if (!target) throw new Error(`No button "${label}".`);
        target.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: shift }),
        );
      }),
    clickRow: (title: string) =>
      act(async () => {
        rowOf(title)?.firstElementChild?.firstElementChild?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true }),
        );
      }),
    /** Presses a key where the focus is. */
    press: (key: string, { alt = false } = {}) =>
      act(async () => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key, altKey: alt, bubbles: true, cancelable: true }),
        );
      }),
    type: (text: string) =>
      act(async () => {
        const field = container.querySelector<HTMLInputElement>("main input");
        if (!field) throw new Error("The list has no search field.");
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setValue?.call(field, text);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }),
    /** The record as the main process answers it once `shown` is the order of the channels. */
    saved: (order: readonly string[], sequence = 2): Viewing => ({
      ...viewing,
      favourites: [...order.slice(0, 1), HIDDEN[0], ...order.slice(1), HIDDEN[1]].map(own),
      sequence,
    }),
  };
}

describe("putting the favourites in another order", () => {
  it("is offered on Favourites with two channels or more, and asks for a search to be cleared first", async () => {
    expect((await favouritesPage(1)).button("Reorder")).toBeUndefined();
    unmount();
    expect((await favouritesPage(4, { kind: "all" })).button("Reorder")).toBeUndefined();
    unmount();

    const page = await favouritesPage(4);
    const search = ipc.hold("guide.searchList");
    await page.type("channel 3");
    await settled(150);
    search.resolve({});
    await settled();
    expect(page.rows()).toEqual(titles(["3"]));

    // The search stays, and so do its rows: clearing it is the viewer's to do.
    await page.press("r");
    expect(page.text()).toContain("Clear the search to reorder.");
    expect(page.rows()).toEqual(titles(["3"]));
    expect(page.button("Save")).toBeUndefined();

    // The line's own link clears it and starts, with the keys on the channel that was found.
    await page.click("Clear search and reorder");
    expect(page.rows()).toEqual(titles(["1", "2", "3", "4"]));
    expect(page.button("Save")).toBeDefined();
    expect(page.focused()).toBe("Channel 3");
    expect(page.text()).not.toContain("Clear the search to reorder.");
  });

  it("moves a channel one place with its buttons and to an end with Shift, and plays nothing", async () => {
    const page = await favouritesPage(5);
    await page.click("Reorder");

    await page.click("Move Channel 2 down");
    expect(page.rows()).toEqual(titles(["1", "3", "2", "4", "5"]));
    expect(page.focused()).toBe("Channel 2");
    expect(page.said()).toBe("Channel 2, 3 of 5");

    await page.click("Move Channel 4 up", { shift: true });
    expect(page.rows()).toEqual(titles(["4", "1", "3", "2", "5"]));
    expect(page.focused()).toBe("Channel 4");
    await page.click("Move Channel 1 down", { shift: true });
    expect(page.rows()).toEqual(titles(["4", "3", "2", "5", "1"]));

    // The ends stay where they are, and say so.
    expect(page.button("Move Channel 4 up")?.getAttribute("aria-disabled")).toBe("true");
    expect(page.button("Move Channel 1 down")?.getAttribute("aria-disabled")).toBe("true");
    expect(page.button("Move Channel 3 up")?.getAttribute("aria-disabled")).toBe("false");
    await page.click("Move Channel 4 up");
    await page.click("Move Channel 1 down");
    expect(page.rows()).toEqual(titles(["4", "3", "2", "5", "1"]));

    // A row takes the keys when clicked, and neither it nor a key of the guide plays or stars.
    await page.clickRow("Channel 5");
    expect(page.focused()).toBe("Channel 5");
    for (const key of ["5", "s", "ArrowRight", "/"]) await page.press(key);
    expect(useUi.getState().watching).toBe(false);
    expect(ipc.methods().filter((method) => /^(playback|viewing|output)\./.test(method))).toEqual(
      [],
    );
  });

  it("moves the selection with the keys and the channel with Alt, and keeps the focus on it through a long list", async () => {
    const page = await favouritesPage(60);
    await page.press("r");
    expect(page.focused()).toBe("Channel 1");

    await page.press("ArrowDown");
    await page.press("ArrowDown");
    expect(page.focused()).toBe("Channel 3");
    // Tab stops at this row and its buttons alone.
    const stops = [...document.querySelectorAll('[role="listitem"][tabindex="0"]')];
    expect(stops.map((row) => row.getAttribute("aria-label"))).toEqual(["Channel 3"]);

    await page.press("ArrowDown", { alt: true });
    expect(page.rows().slice(0, 5)).toEqual(titles(["1", "2", "4", "3", "5"]));
    expect(page.focused()).toBe("Channel 3");
    await page.press("PageDown", { alt: true });
    expect([page.indexOf("Channel 3"), page.said()]).toEqual([13, "Channel 3, 14 of 60"]);

    // The last place is far outside the rows the list draws: the row is there, with the focus.
    await page.press("End", { alt: true });
    await settled();
    expect(page.indexOf("Channel 3")).toBe(59);
    expect(page.focused()).toBe("Channel 3");
    expect(page.rows().length).toBeLessThan(40);
    await page.press("ArrowDown", { alt: true });
    expect(page.indexOf("Channel 3")).toBe(59);

    await page.press("PageUp", { alt: true });
    expect(page.indexOf("Channel 3")).toBe(49);
    await page.press("Home", { alt: true });
    await settled();
    expect(page.rows().slice(0, 3)).toEqual(titles(["3", "1", "2"]));
    expect(page.focused()).toBe("Channel 3");

    // Without Alt the same keys move the selection, and no channel.
    await page.press("End");
    await settled();
    expect(page.focused()).toBe("Channel 60");
    await page.press("PageUp");
    expect(page.focused()).toBe("Channel 50");
    await page.press("Home");
    await settled();
    expect(page.focused()).toBe("Channel 3");
    expect(page.rows().slice(0, 3)).toEqual(titles(["3", "1", "2"]));

    // Programmes were asked for by the saved order, forty channels at a time: once for each
    // forty that came into view, and never again for a channel that moved.
    const asked = ipc.argsOf("guide.listings").map(({ channels }) => channels);
    const saved = Array.from({ length: 60 }, (_, index) => own(String(index + 1)));
    expect(asked).toEqual([saved.slice(0, 40), saved.slice(40)]);
  });

  it("saves once with Enter, for the subscription and the favourites it was made from", async () => {
    const page = await favouritesPage(4);
    await page.click("Reorder");
    await page.click("Move Channel 4 up", { shift: true });
    const answer = ipc.hold("viewing.reorderFavourites");

    await page.press("Enter");
    // Until the answer is in nothing moves, nothing is sent again and nothing leaves the page.
    await page.press("Enter");
    await page.press("Escape");
    await page.click("Save");
    await page.click("Cancel");
    await page.click("Move Channel 4 down");
    expect(page.inert()).toBe(true);
    expect(ipc.argsOf("viewing.reorderFavourites")).toEqual([
      {
        commandId: expect.any(String),
        original: page.favourites,
        order: ["4", "1", "2", "3"].map(own),
      },
    ]);

    const saved = page.saved(["4", "1", "2", "3"]);
    const listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await act(async () => answer.resolve(saved));
    // The list is the main process's to name, and the page waits for it too.
    expect(ipc.argsOf("library.browse").filter((query) => query.scope.kind === "channels")).toEqual(
      [browseChannelsOf(saved.favourites).queryKey[2]],
    );
    expect(page.inert()).toBe(true);
    await act(async () => listed.resolve(browseResult(["4", "1", "2", "3"].map(channel))));
    expect(page.button("Save")).toBeUndefined();
    expect(page.button("Reorder")).toBeDefined();
    expect(page.inert()).toBe(false);
    expect(page.rows()).toEqual(titles(["4", "1", "2", "3"]));
    expect(page.client.getQueryData(["viewing"])).toEqual(saved);
    // The guide has its keys back, on the channel that was moved.
    await page.press("s");
    expect(ipc.argsOf("viewing.setFavourite")).toMatchObject([{ channel: own("4") }]);
  });

  it("keeps the draft when saving fails, and sends it again under the same id until it changes", async () => {
    const page = await favouritesPage(4);
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    const sent = () => ipc.argsOf("viewing.reorderFavourites");

    let answer = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    await act(async () => answer.reject({ kind: "unexpected", detail: "disk full" }));
    expect(page.text()).toContain("Couldn't save the order.");
    expect(page.rows()).toEqual(titles(["2", "1", "3", "4"]));
    expect(page.focused()).toBe("Channel 1");
    // No second try by itself.
    await settled(50);
    expect(sent()).toHaveLength(1);

    answer = ipc.hold("viewing.reorderFavourites");
    await page.click("Retry");
    expect(sent()[1]).toEqual(sent()[0]);
    await act(async () => answer.reject({ kind: "unexpected", detail: "disk full" }));

    // Another order is another save.
    await page.press("ArrowDown", { alt: true });
    expect(page.text()).not.toContain("Couldn't save the order.");
    answer = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    expect(sent()[2]).toMatchObject({ order: ["2", "3", "1", "4"].map(own) });
    expect(sent()[2]?.commandId).not.toBe(sent()[0]?.commandId);

    const listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await act(async () => answer.resolve(page.saved(["2", "3", "1", "4"])));
    await act(async () => listed.resolve(browseResult(["2", "3", "1", "4"].map(channel))));
    expect(page.button("Save")).toBeUndefined();
    expect(page.rows()).toEqual(titles(["2", "3", "1", "4"]));
  });

  it("reloads and saves favourites after removing the source with the latest viewing sequence", async () => {
    const page = await favouritesPage(4);
    const removed = { subscriptionId: "removed", id: "7" };
    page.client.setQueryData(
      browseChannelsOf([...page.viewing.favourites, removed]).queryKey,
      browseResult(["1", "2", "3", "4"].map(channel)),
    );
    await act(async () =>
      page.client.setQueryData(queries.viewing().queryKey, {
        ...page.viewing,
        sequence: 120,
        favourites: [...page.viewing.favourites, removed],
      }),
    );
    await settled();
    await page.click("Reorder");
    await page.click("Move Channel 1 down", { shift: true });
    const answer = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    await act(async () => answer.reject({ kind: "favourites-changed" }));

    expect(page.text()).toContain("Your favourites changed.");
    expect(page.button("Retry")).toBeUndefined();
    // The draft can't be saved, so it moves no further.
    await page.press("ArrowUp", { alt: true });
    expect(page.rows()).toEqual(titles(["2", "3", "4", "1"]));

    // Main has removed the source that changed last and Channel 4 was unstarred too.
    // The combined sequence is now lower, and Reload must discard the removed favourite.
    const record = ipc.hold("viewing.get");
    const listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await page.click("Reload");
    const fresh: Viewing = {
      favourites: ["1", "adult", "2", "3", "gone"].map(own),
      recent: [],
      continueWatching: [],
      marked: [],
      sequence: 100,
    };
    await act(async () => record.resolve(fresh));
    await act(async () => listed.resolve(browseResult(["1", "2", "3"].map(channel))));
    expect(
      ipc
        .argsOf("library.browse")
        .filter((query) => query.scope.kind === "channels")
        .at(-1),
    ).toEqual(browseChannelsOf(fresh.favourites).queryKey[2]);
    expect(page.rows()).toEqual(titles(["1", "2", "3"]));
    expect(page.button("Save")).toBeDefined();
    expect(page.focused()).toBe("Channel 1");

    // The order made now is one of the favourites as they are.
    await page.press("End", { alt: true });
    await page.press("Enter");
    expect(ipc.argsOf("viewing.reorderFavourites").at(-1)).toMatchObject({
      original: fresh.favourites,
      order: ["2", "3", "1"].map(own),
    });
  });

  it("throws the draft away on Cancel, on Escape and when the list or its channels change", async () => {
    const page = await favouritesPage(4);
    const inOrder = titles(["1", "2", "3", "4"]);
    const reordering = async () => {
      await page.click("Reorder");
      await page.click("Move Channel 3 up", { shift: true });
      expect(page.rows()).toEqual(titles(["3", "1", "2", "4"]));
    };

    await reordering();
    await page.press("Escape");
    expect(page.rows()).toEqual(inOrder);
    expect(page.button("Save")).toBeUndefined();
    // Escape left the order, not the page.
    expect(useUi.getState().view).toBe("live");

    // Started from the button with the focus on it, as with Tab, the focus returns there.
    page.button("Reorder")?.focus();
    await reordering();
    await page.click("Cancel");
    expect(page.rows()).toEqual(inOrder);
    expect(document.activeElement).toBe(page.button("Reorder"));

    await reordering();
    await page.click("Recently watched");
    await page.click("Favourites");
    expect(page.rows()).toEqual(inOrder);
    expect(page.button("Save")).toBeUndefined();

    // A new catalogue lists another channel under the favourites: the draft was of the old ones.
    await reordering();
    await act(async () =>
      page.client.setQueryData(
        browseChannelsOf(page.favourites).queryKey,
        browseResult(["1", "2", "3"].map(channel)),
      ),
    );
    await settled();
    expect(page.button("Save")).toBeUndefined();
    expect(page.rows()).toEqual(titles(["1", "2", "3"]));
    expect(ipc.argsOf("viewing.reorderFavourites")).toEqual([]);
  });

  it("keeps the draft through a read that finds the same channels, a new guide and a watch, and ends it once a channel changed", async () => {
    const page = await favouritesPage(4);
    const stop = [
      syncLibraryUpdates(page.client),
      syncGuideUpdates(page.client),
      syncViewing(page.client),
    ];
    const status = {
      subscriptionId: "one",
      channelCount: 4,
      fetchedAt: 2,
      failure: null,
      failedAt: null,
    };
    await page.click("Reorder");
    await page.click("Move Channel 3 up", { shift: true });
    const arranged = titles(["3", "1", "2", "4"]);

    // A refresh that brought the same channels: the list is read again, and is the same list.
    let listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await act(async () => ipc.emit("library.updated", status));
    await act(async () => listed.resolve(browseResult(["1", "2", "3", "4"].map(channel))));
    expect(ipc.argsOf("library.browse").filter((query) => query.scope.kind === "channels")).toEqual(
      [browseChannelsOf(page.favourites).queryKey[2]],
    );
    // A new guide has a programme for one of them, and a channel watched meanwhile moves the
    // record on and leaves the favourites alone.
    const guide = queries.listings(["1", "2", "3", "4"].map(own)).queryKey;
    await act(async () => page.client.setQueryData(guide, {}));
    const programmes = ipc.hold("guide.listings");
    await act(async () => ipc.emit("guide.updated", null));
    const now = { start: Date.now() - 60_000, stop: Date.now() + 3_600_000 };
    await act(async () =>
      programmes.resolve({
        [ownedKey(own("2"))]: {
          now: { ...now, title: "Evening News", description: null },
          next: null,
        },
      }),
    );
    await settled();
    expect(page.text()).toContain("Evening News");
    const record = ipc.hold("viewing.get");
    await act(async () => ipc.emit("viewing.changed", { sequence: 5 }));
    await act(async () => record.resolve({ ...page.viewing, recent: [own("2")], sequence: 5 }));
    await settled();
    expect(page.client.getQueryData(["viewing"])).toMatchObject({ recent: [own("2")] });
    expect(page.rows()).toEqual(arranged);
    expect(page.button("Save")).toBeDefined();
    expect(page.focused()).toBe("Channel 3");

    // The next refresh joined a second stream to one of the same four channels, under the same
    // id: the draft was of the channels as they were, and the list shows them as they are.
    const joined: LiveChannel = {
      ...channel("2"),
      title: "Channel 2 in two qualities",
      variants: [
        ...channel("2").variants,
        { id: "20", name: "UK | CHANNEL 2 HD", tags: [], quality: "hd" },
      ],
    };
    listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await act(async () => ipc.emit("library.updated", status));
    await act(async () =>
      listed.resolve(browseResult([channel("1"), joined, channel("3"), channel("4")])),
    );
    await settled();
    expect(page.button("Save")).toBeUndefined();
    expect(page.rows()).toEqual(["Channel 1", joined.title, "Channel 3", "Channel 4"]);
    expect(ipc.argsOf("viewing.reorderFavourites")).toEqual([]);
    for (const each of stop) each();
  });

  it("ends the draft when a subscription is added beside it, and no late answer brings it back", async () => {
    const page = await favouritesPage(4);
    const inOrder = titles(["1", "2", "3", "4"]);
    // The subscriptions saved: the one the favourites are of, alone or with another beside it.
    const saved = { one: [subscription("one")], two: [subscription("one"), subscription("two")] };
    const connect = async (roster: keyof typeof saved) => {
      await act(async () => page.client.setQueryData(["subscriptions"], saved[roster]));
      await settled();
    };
    const arranging = async () => {
      await connect("one");
      await page.click("Reorder");
      await page.click("Move Channel 4 up", { shift: true });
      expect(page.rows()).toEqual(titles(["4", "1", "2", "3"]));
    };
    /** No draft shows, in any of its states, and the list is the one saved. */
    const ended = () => {
      expect(page.inert()).toBe(false);
      for (const label of ["Save", "Retry", "Reload", "Cancel"]) {
        expect(page.button(label)).toBeUndefined();
      }
      expect(page.rows()).toEqual(inOrder);
      expect(page.client.getQueryData(["viewing"])).toEqual(page.viewing);
    };

    // Arranged and not yet saved.
    await arranging();
    await connect("two");
    ended();
    expect(ipc.argsOf("viewing.reorderFavourites")).toEqual([]);

    // Being saved: the answer is of the favourites as they were with one subscription, and no
    // news for the lists, or of a draft, once there are two.
    await arranging();
    let late = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    await connect("two");
    ended();
    await act(async () => late.resolve(page.saved(["4", "1", "2", "3"], 7)));
    await settled();
    ended();
    expect(ipc.argsOf("library.browse").filter((query) => query.scope.kind === "channels")).toEqual(
      [],
    );

    // Nor is a failure, or a refusal, that comes late.
    for (const error of [
      { kind: "unexpected", detail: "disk full" },
      { kind: "favourites-changed" },
    ] as const) {
      await arranging();
      late = ipc.hold("viewing.reorderFavourites");
      await page.click("Save");
      await connect("two");
      await act(async () => late.reject(error));
      await settled();
      ended();
    }

    // Refused, and the favourites being read again as the other is added.
    await arranging();
    late = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    await act(async () => late.reject({ kind: "favourites-changed" }));
    const record = ipc.hold("viewing.get");
    const listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await page.click("Reload");
    await connect("two");
    ended();
    await act(async () => record.resolve(page.viewing));
    await act(async () => listed.resolve(browseResult(["1", "2", "3", "4"].map(channel))));
    await settled();
    ended();
  });

  it("shows the channels the main process names for the record it answers with, never the draft's", async () => {
    const page = await favouritesPage(4);
    await page.click("Reorder");
    await page.click("Move Channel 4 up", { shift: true });
    let answer = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    await act(async () => answer.reject({ kind: "unexpected", detail: "no answer" }));

    // The order was saved all the same, and since then a channel was starred, another order made
    // and a channel renamed. Sent again under its id, the order is done already, and the answer
    // is the record as it stands.
    answer = ipc.hold("viewing.reorderFavourites");
    let listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await page.click("Retry");
    const current: Viewing = {
      favourites: ["5", "adult", "3", "4", "1", "2", "gone"].map(own),
      recent: [],
      continueWatching: [],
      marked: [],
      sequence: 8,
    };
    await act(async () => answer.resolve(current));
    expect(ipc.argsOf("library.browse").filter((query) => query.scope.kind === "channels")).toEqual(
      [browseChannelsOf(current.favourites).queryKey[2]],
    );
    const renamed = { ...channel("1"), title: "Channel 1 as it is now" };
    const named = [channel("5"), channel("3"), channel("4"), renamed, channel("2")];
    await act(async () => listed.resolve(browseResult(named)));

    expect(page.button("Save")).toBeUndefined();
    expect(page.rows()).toEqual(named.map(({ title }) => title));
    expect(page.client.getQueryData(["viewing"])).toEqual(current);
    expect(
      page.client.getQueryData(browseChannelsOf(current.favourites).queryKey)?.channels,
    ).toEqual(named);
    unmount();

    // A later record, in another order, reaches the lists before the answer does, and the
    // answer is that same record: the list stays the one the main process named for it.
    const next = await favouritesPage(4);
    const reversed = ["4", "3", "2", "1"];
    const newer = next.saved(reversed, 9);
    const sent = () => ipc.argsOf("viewing.reorderFavourites").length;
    /** Moves a channel one place, in either order, and saves with the answer held. */
    const saving = async () => {
      const held = ipc.hold("viewing.reorderFavourites");
      const before = sent();
      await next.click("Reorder");
      await next.click("Move Channel 2 up");
      await next.click("Save");
      expect(sent()).toBe(before + 1);
      return held;
    };
    let late = await saving();
    listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await act(async () => next.client.setQueryData(["viewing"], newer));
    await act(async () => listed.resolve(browseResult(reversed.map(channel))));
    await settled();
    listed = ipc.hold("library.browse", (query) => query.scope.kind === "channels");
    await act(async () => late.resolve(newer));
    await act(async () => listed.resolve(browseResult(reversed.map(channel))));
    expect(next.button("Save")).toBeUndefined();
    expect(next.rows()).toEqual(titles(reversed));
    expect(next.client.getQueryData(["viewing"])).toEqual(newer);

    // An answer older than the record the lists hold changes nothing, and asks for no list.
    const asked = ipc
      .argsOf("library.browse")
      .filter((query) => query.scope.kind === "channels").length;
    late = await saving();
    await act(async () => late.resolve(next.saved(["1", "2", "3", "4"], 5)));
    expect(next.button("Save")).toBeUndefined();
    expect(next.rows()).toEqual(titles(reversed));
    expect(next.client.getQueryData(["viewing"])).toEqual(newer);
    expect(
      ipc.argsOf("library.browse").filter((query) => query.scope.kind === "channels"),
    ).toHaveLength(asked);
  });
});
