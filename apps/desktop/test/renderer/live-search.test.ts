// @vitest-environment happy-dom
// Live TV's search of the list it shows: the channels found by a name or by a programme the main
// process finds, in the list's order, the keys between the field and the channels, and what
// another list does to a search.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListingMatch, Programme } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";

const HOUR = 60 * 60 * 1000;

const channel = (id: string, title: string, name = title): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name,
  title,
  tags: [],
  number: Number(id),
  logoUrl: null,
  categoryIds: ["uk"],
  variants: [{ id, name, tags: [], quality: null }],
});

const CHANNELS = [
  channel("1", "BBC One"),
  channel("2", "ITV1"),
  channel("3", "Channel 4"),
  channel("4", "BBC News"),
  channel("5", "Euronews"),
  channel("6", "Dave", "UK | DAVE HD (COMEDY)"),
  channel("7", "Één"),
];
/** Names a channel or category by the provider's id, as the one subscription lists it. */
const own = (id: string) => ({ subscriptionId: SUBSCRIPTION, id });
/** Favourites, in the order they were starred. */
const FAVOURITES = ["4", "2", "1"].map(own);
/** What a search found per channel, as the main process answers: by each channel's own key. */
const found = (matches: Record<string, ListingMatch>): Record<string, ListingMatch> =>
  Object.fromEntries(Object.entries(matches).map(([id, match]) => [ownedKey(own(id)), match]));

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
  player.reset();
  vi.useRealTimers();
});

/**
 * Flushes React while waiting for an IPC call or the rows it renders. The fake clock moves on
 * 10 ms between tries, past the search's pause after typing.
 */
const ready = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { interval: 10 },
  );

/** Live TV on `list`, with the catalogue and the favourites at hand. */
async function guidePage(list: ChannelList = { kind: "all" }) {
  ipc.reset();
  useUi.setState({ view: "live", list, watching: false, searchOpen: false, searchFrom: "" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const byId = new Map(CHANNELS.map((each) => [each.id, each]));
  client.setQueryData(queries.categories().queryKey, [
    {
      ...own("uk"),
      members: [own("uk")],
      name: "UK | NEWS",
      group: null,
      title: "News",
      channelCount: CHANNELS.length,
    },
  ]);
  client.setQueryData(queries.channels(null).queryKey, CHANNELS);
  ipc.always("library.searchGroups", []);
  client.setQueryData(queries.channels(own("uk")).queryKey, CHANNELS);
  client.setQueryData(
    queries.channelsOf(FAVOURITES).queryKey,
    FAVOURITES.flatMap(({ id }) => byId.get(id) ?? []),
  );
  client.setQueryData(
    ["library", "status"],
    [
      {
        subscriptionId: own("uk").subscriptionId,
        channelCount: CHANNELS.length,
        fetchedAt: 1,
        failure: null,
        failedAt: null,
      },
    ],
  );
  client.setQueryData(queries.viewing().queryKey, {
    favourites: FAVOURITES,
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  const container = document.createElement("div");
  // In the page, as a field takes focus only there.
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
  await ready(() =>
    expect(container.querySelectorAll("[data-index]")).toHaveLength(
      list.kind === "favourites" ? FAVOURITES.length : CHANNELS.length,
    ),
  );

  const field = () => {
    const input = container.querySelector<HTMLInputElement>("main input");
    if (!input) throw new Error("The list has no search field.");
    return input;
  };
  return {
    categories: (categories: readonly Category[]) =>
      act(async () => {
        client.setQueryData(queries.categories().queryKey, categories);
      }),
    field,
    /** The channels shown, top to bottom. */
    rows: () =>
      [...container.querySelectorAll("[data-index]")].map(
        (row) => row.querySelector("[title]")?.firstElementChild?.textContent,
      ),
    /** A channel's row, with its programmes when the rest of its day is open. */
    row: (title: string) =>
      [...container.querySelectorAll("[data-index]")].find(
        (row) => row.querySelector("[title]")?.firstElementChild?.textContent === title,
      ),
    text: () => container.querySelector("main")?.textContent ?? "",
    notice: () => container.querySelector('[role="status"]')?.textContent ?? "",
    /** Types `text` into the field, as the whole of what it holds. */
    type: (text: string) =>
      act(async () => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setValue?.call(field(), text);
        field().dispatchEvent(new Event("input", { bubbles: true }));
      }),
    /** Presses a key in the field when the cursor is there, else in the page. */
    press: (key: string) =>
      act(async () => {
        const target = document.activeElement === field() ? field() : window;
        target.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      }),
    click: (label: string) =>
      act(async () =>
        [...container.querySelectorAll("button")]
          .find((button) => button.textContent?.trim().startsWith(label))
          ?.click(),
      ),
  };
}

/**
 * Types a search and answers it with what the main process found in the programmes, given here
 * by the provider's channel ids.
 */
async function searched(
  page: Awaited<ReturnType<typeof guidePage>>,
  text: string,
  rows: string[],
  matches: Record<string, ListingMatch> = {},
) {
  const asked = ipc.argsOf("guide.searchList").length;
  const answer = ipc.hold("guide.searchList");
  await page.type(text);
  await ready(() => {
    expect(ipc.argsOf("guide.searchList")).toHaveLength(asked + 1);
    expect(ipc.argsOf("guide.searchList").at(-1)).toMatchObject({ query: text });
  });
  await act(async () => answer.resolve(found(matches)));
  await ready(() => expect(page.rows()).toEqual(rows));
}

const later = (title: string): ListingMatch => ({
  now: false,
  later: { start: Date.now() + 2 * HOUR, title },
});

describe("searching the list Live TV shows", () => {
  it("shows All channels and names a removed category after refresh, then clears the message on another list", async () => {
    const page = await guidePage({ kind: "category", category: own("uk") });
    expect(page.text()).toContain("News");
    await page.categories([
      {
        ...own("other"),
        members: [own("other")],
        name: "Other",
        title: "Other",
        group: null,
        channelCount: 1,
      },
    ]);
    await ready(() => expect(useUi.getState().list).toEqual({ kind: "all" }));
    expect(page.notice()).toContain("News is no longer listed. Showing all channels.");
    await page.click("Favourites");
    await ready(() => expect(page.notice()).not.toContain("is no longer listed"));
  });

  it("shows the channels found by a name or a programme together, one row each in the list's order", async () => {
    const page = await guidePage();
    const answer = ipc.hold("guide.searchList");

    await page.type("News");
    await ready(() =>
      expect(ipc.argsOf("guide.searchList").at(-1)).toMatchObject({ query: "News" }),
    );

    // The names are at hand, yet the rows wait for the programmes: they change once.
    expect(page.rows()).toHaveLength(CHANNELS.length);
    expect(ipc.argsOf("guide.searchList")).toEqual([{ query: "News", until: expect.any(Number) }]);

    answer.resolve(
      found({
        "1": { now: true, later: null },
        "2": later("ITV News at Ten"),
        "4": later("Newsnight"),
      }),
    );
    await ready(() => expect(page.rows()).toEqual(["BBC One", "ITV1", "BBC News", "Euronews"]));

    expect(page.rows()).toEqual(["BBC One", "ITV1", "BBC News", "Euronews"]);
    expect(page.text()).toContain("4 channels · 4 streams");
    expect(page.row("ITV1")?.textContent).toContain("ITV News at Ten");
    // What matched is marked: in a name, inside a word, and in the later programme.
    const marked = (title: string) =>
      [...(page.row(title)?.querySelectorAll("mark") ?? [])].map((mark) => mark.textContent);
    expect(marked("BBC News")).toEqual(["News", "News"]);
    expect(marked("Euronews")).toEqual(["news"]);
    expect(marked("ITV1")).toEqual(["News"]);
  });

  it("finds names without a guide, by the provider's name too and whatever the accents", async () => {
    const page = await guidePage();
    const answer = ipc.hold("guide.searchList");
    await page.type("comedy");
    await ready(() =>
      expect(ipc.argsOf("guide.searchList").at(-1)).toMatchObject({ query: "comedy" }),
    );
    answer.reject({ kind: "unexpected", detail: "No guide." });
    await ready(() => expect(page.rows()).toEqual(["Dave"]));
    expect(page.rows()).toEqual(["Dave"]);

    await searched(page, "EEN", ["Één"]);
    await expect.poll(page.rows).toEqual(["Één"]);

    await searched(page, "bbc news", ["BBC News"]);
    expect(page.rows()).toEqual(["BBC News"]);
  });

  it("goes to the field with /, hands the keys to the channels found, and clears before it leaves", async () => {
    const page = await guidePage();

    await page.press("/");
    expect(document.activeElement).toBe(page.field());
    // In the field a digit is text, not a channel number.
    await searched(page, "4", ["Channel 4"]);
    expect(page.rows()).toEqual(["Channel 4"]);

    await searched(page, "bbc", ["BBC One", "BBC News"]);
    await page.press("ArrowDown");
    expect(document.activeElement).not.toBe(page.field());
    await page.press("ArrowDown");
    await page.press("Enter");
    expect(player.state().channel?.id).toBe("4");
    expect(useUi.getState().watching).toBe(true);

    // Back from Watch, the search stands. Escape clears it first, and only then goes Home.
    await act(async () => useUi.setState({ watching: false }));
    expect(page.rows()).toEqual(["BBC One", "BBC News"]);
    await page.press("Escape");
    expect(page.field().value).toBe("");
    expect(page.rows()).toHaveLength(CHANNELS.length);
    expect(useUi.getState().view).toBe("live");
    await page.press("Escape");
    expect(useUi.getState().view).toBe("home");
  });

  it("clears and leaves the field on Escape there, and watches the first channel found on Enter twice", async () => {
    const page = await guidePage();
    await page.press("/");
    await searched(page, "itv", ["ITV1"]);

    await page.press("Escape");
    expect(page.field().value).toBe("");
    expect(document.activeElement).not.toBe(page.field());
    expect(useUi.getState().view).toBe("live");

    await page.press("/");
    await searched(page, "euro", ["Euronews"]);
    await page.press("Enter");
    expect(useUi.getState().watching).toBe(false);
    await page.press("Enter");
    expect(player.state().channel?.id).toBe("5");
  });

  it("searches the favourites alone, and every channel for the same once asked", async () => {
    const page = await guidePage({ kind: "favourites" });
    expect(page.field().placeholder).toBe("Search Favourites");

    await searched(page, "bbc", ["BBC News", "BBC One"]);
    expect(page.rows()).toEqual(["BBC News", "BBC One"]);
    expect(ipc.argsOf("guide.searchList").at(-1)).toMatchObject({
      query: "bbc",
      channels: FAVOURITES,
    });

    await searched(page, "dave", []);
    expect(page.rows()).toEqual([]);
    expect(page.text()).toContain("Nothing in Favourites for dave.");
    expect(useUi.getState().searchFrom).toBe("dave");

    const asked = ipc.argsOf("guide.searchList").length;
    const everywhere = ipc.hold("guide.searchList");
    await page.click("Search all channels");
    await ready(() => expect(ipc.argsOf("guide.searchList")).toHaveLength(asked + 1));
    everywhere.resolve({});
    await ready(() => expect(page.rows()).toEqual(["Dave"]));
    expect(useUi.getState().list).toEqual({ kind: "all" });
    expect(page.field().value).toBe("dave");
    expect(page.rows()).toEqual(["Dave"]);
    expect(ipc.argsOf("guide.searchList").at(-1)).toEqual({
      query: "dave",
      until: expect.any(Number),
    });

    // Another list starts without the search.
    await page.click("Favourites");
    expect(page.field().value).toBe("");
    expect(page.rows()).toEqual(["BBC News", "ITV1", "BBC One"]);
  });

  it("opens the rest of the day on the later programme found, with its description", async () => {
    const page = await guidePage();
    const start = Date.now() + 2 * HOUR;
    const at = (from: number, title: string, description: string): Programme => ({
      start: from,
      stop: from + HOUR,
      title,
      description,
    });
    await searched(page, "ten", ["ITV1"], {
      "2": { now: false, later: { start, title: "News at Ten" } },
    });
    expect(page.rows()).toEqual(["ITV1"]);

    const day = ipc.hold("guide.schedule");
    await page.press("ArrowRight");
    await ready(() => expect(ipc.argsOf("guide.schedule")).toHaveLength(1));
    day.resolve([
      at(start - 2 * HOUR, "Emmerdale", "On now."),
      at(start - HOUR, "Trigger Point", "Not what was searched for."),
      at(start, "News at Ten", "The day's news."),
    ]);
    await ready(() => expect(page.row("ITV1")?.textContent).toContain("The day's news."));

    expect(ipc.argsOf("guide.schedule")).toEqual([
      { channel: { subscriptionId: SUBSCRIPTION, id: "2" } },
    ]);
    expect(page.row("ITV1")?.textContent).toContain("The day's news.");
    expect(page.row("ITV1")?.textContent).not.toContain("Not what was searched for.");
    // Opening it plays nothing: only the row itself watches the channel.
    expect(useUi.getState().watching).toBe(false);
  });
});
