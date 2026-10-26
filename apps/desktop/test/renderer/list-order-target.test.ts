// @vitest-environment happy-dom
// A new order belongs to the list it was made in. Choosing another list ends it, even one that
// shows the very same channels, so Save never writes a list that isn't the one on screen: not
// from one of the viewer's lists to another, nor between Favourites and a list, either way. The
// list now chosen orders as ever, and the one left shows its saved order again.
import { browseChannels, browseResult } from "./browse-support.ts";
import { ipc } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CustomList } from "@mrstreamer/contracts/custom-lists";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { OwnedId, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { queries, syncCustomLists } from "../../src/renderer/src/lib/queries.ts";

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
  vi.useRealTimers();
});

const settled = (ms = 20) => act(() => vi.advanceTimersByTimeAsync(ms));
const titles = (ids: readonly string[]) => ids.map((id) => `Channel ${id}`);

/**
 * Live TV on `shown`, where Favourites and the lists Alpha and Beta all hold channels 1 and 2 in
 * that order: their rows are one answer of the library, which the lists' cache shares.
 */
async function sameChannelsPage(shown: ChannelList) {
  ipc.reset();
  useUi.setState({ view: "live", list: shown, watching: false, searchOpen: false, searchFrom: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchQuery(queries.preferences());
  const lists = [list("alpha", "Alpha", ["1", "2"]), list("beta", "Beta", ["1", "2"])];
  const viewing: Viewing = {
    favourites: [own("1"), own("2")],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  };
  client.setQueryData(["subscriptions"], [subscription]);
  client.setQueryData(queries.categories().queryKey, [
    {
      ...own("uk"),
      members: [own("uk")],
      name: "UK | NEWS",
      group: null,
      title: "News",
      channelCount: 2,
    },
  ]);
  client.setQueryData(browseChannels(null).queryKey, browseResult(["1", "2"].map(channel)));
  client.setQueryData(
    ["library", "status"],
    [{ subscriptionId: "one", channelCount: 2, fetchedAt: 1, failure: null, failedAt: null }],
  );
  client.setQueryData(["viewing"], viewing);
  client.setQueryData(queries.customLists().queryKey, lists);
  // The library answers a list of channels with those channels, in the order asked.
  ipc.answer("library.browse", (query) =>
    browseResult(
      query.scope.kind === "channels"
        ? query.scope.channels.map((each) => channel(each.id))
        : ["1", "2"].map(channel),
    ),
  );
  ipc.always("library.searchGroups", []);
  ipc.always("customLists.get", lists);
  ipc.always("viewing.get", viewing);
  const stopLists = syncCustomLists(client);
  const mounted = queryView(client);
  const { container } = mounted;
  await mounted.render(createElement(GuidePage, { active: true }));
  unmount = () => {
    stopLists();
    mounted.unmount();
  };
  await settled();

  const button = (label: string) => {
    const buttons = [...container.querySelectorAll("button")];
    return (
      buttons.find((each) => each.getAttribute("aria-label") === label) ??
      buttons.find((each) => each.textContent?.trim().startsWith(label))
    );
  };
  const click = (target: Element | null | undefined, what: string) =>
    act(async () => {
      if (!target) throw new Error(`No ${what}.`);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  return {
    lists,
    viewing,
    button,
    rows: () =>
      [...container.querySelectorAll("[data-index]")].map(
        (row) => row.querySelector("[title]")?.firstElementChild?.textContent,
      ),
    heading: () => container.querySelector("main h1")?.textContent,
    /** The order being made, if one is: its rows' list, and Save. */
    drafting: () =>
      !!container.querySelector('[role="list"][aria-label$="in the order to save"]') ||
      !!button("Save"),
    inert: () => container.firstElementChild?.hasAttribute("inert") ?? false,
    click: (label: string) => click(button(label), `button "${label}"`),
    /** Picks a list in Live TV's lists with the pointer. */
    pick: (title: string) =>
      click(
        container.querySelector(`[role="navigation"] button[title="${title}"]`),
        `list "${title}"`,
      ),
  };
}

describe("a new order and the list it was made in", () => {
  it("ends when another of the viewer's lists is chosen, though it shows the same channels", async () => {
    const page = await sameChannelsPage({ kind: "custom", id: "alpha" });
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    expect(page.rows()).toEqual(titles(["2", "1"]));

    await page.pick("Beta");
    expect(page.heading()).toBe("Beta");
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["1", "2"]));

    // Beta orders as ever, and its own Save writes Beta alone.
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    const answer = ipc.hold("customLists.arrange");
    await page.click("Save");
    expect(ipc.argsOf("customLists.arrange")).toEqual([
      { list: "beta", revision: 2, order: ["beta-2", "beta-1"] },
    ]);
    const [alpha] = page.lists;
    if (!alpha) throw new Error("Alpha is there");
    await act(async () => answer.resolve([alpha, list("beta", "Beta", ["2", "1"], 3)]));
    await settled();
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["2", "1"]));

    // Back on Alpha, its saved order, nothing of the draft it had.
    await page.pick("Alpha");
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["1", "2"]));
    expect(ipc.argsOf("customLists.arrange").map(({ list }) => list)).toEqual(["beta"]);
    expect(ipc.argsOf("viewing.reorderFavourites")).toEqual([]);
  });

  it("ends when Favourites gives way to a list with the same channels, and the other way round", async () => {
    const page = await sameChannelsPage({ kind: "favourites" });
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    await page.pick("Beta");
    expect(page.heading()).toBe("Beta");
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["1", "2"]));
    await page.pick("Favourites");
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["1", "2"]));

    await page.pick("Alpha");
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    await page.pick("Favourites");
    expect(page.heading()).toBe("Favourites");
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["1", "2"]));

    // Favourites' own order is saved for Favourites, from the favourites it was read from.
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    const answer = ipc.hold("viewing.reorderFavourites");
    await page.click("Save");
    expect(ipc.argsOf("viewing.reorderFavourites")).toMatchObject([
      { original: [own("1"), own("2")], order: [own("2"), own("1")] },
    ]);
    await act(async () =>
      answer.resolve({ ...page.viewing, favourites: [own("2"), own("1")], sequence: 2 }),
    );
    await settled();
    expect(page.rows()).toEqual(titles(["2", "1"]));
    expect(ipc.argsOf("customLists.arrange")).toEqual([]);
  });

  it("leaves no draft in another list when its list goes while the order is being saved", async () => {
    const page = await sameChannelsPage({ kind: "custom", id: "alpha" });
    await page.click("Reorder");
    await page.click("Move Channel 1 down");
    const answer = ipc.hold("customLists.arrange");
    await page.click("Save");
    expect(page.inert()).toBe(true);

    // Alpha is deleted meanwhile, as another change of the lists says: Live TV shows every channel.
    const [, beta] = page.lists;
    if (!beta) throw new Error("Beta is there");
    ipc.always("customLists.get", [beta]);
    await act(async () => ipc.emit("customLists.changed", null));
    await settled();
    expect(page.heading()).toBe("All channels");
    expect(page.drafting()).toBe(false);
    expect(page.inert()).toBe(false);

    // The write was already sent, and its late answer brings back no draft.
    await act(async () => answer.reject({ kind: "no-list" }));
    await settled();
    expect(page.drafting()).toBe(false);
    await page.pick("Beta");
    expect(page.drafting()).toBe(false);
    expect(page.rows()).toEqual(titles(["1", "2"]));
  });
});
