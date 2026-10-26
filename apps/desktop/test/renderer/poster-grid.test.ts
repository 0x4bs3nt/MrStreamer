// @vitest-environment happy-dom
// The poster grid of Movies and Series, their search and the Watchlist: the keys move one
// selection that the focus follows, Enter opens the poster that has it, and the selection keeps
// to its title by key while the list is read again, its pages arrive, details close or a title is
// removed. The built window checks layout, Tab order and the accessibility tree; see the
// poster-grid scenario of verify-mrstreamer.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionPage, Title } from "@mrstreamer/contracts/ondemand";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { WatchlistPage } from "../../src/renderer/src/features/watchlist/WatchlistPage.tsx";
import { queries, syncOnDemand, syncWatchlist } from "../../src/renderer/src/lib/queries.ts";

// happy-dom lays nothing out, and the grid draws only the rows that fit: it gets a height. With
// no width, it is one column, so Down and Right both move one title.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 900,
});

const film = (id: string, name: string, year: number): Title => ({
  kind: "movie",
  key: `movie:tmdb:${id}`,
  subscriptionId: SUBSCRIPTION,
  id,
  name: `${name} (EN)`,
  title: name,
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: id,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id, tags: ["EN"] }],
});

const arrival = film("a", "Arrival", 2016);
const blade = film("b", "Blade Runner", 1982);
const contact = film("c", "Contact", 1997);
const dune = film("d", "Dune", 2021);

const all = (titles: readonly Title[], total = titles.length): CollectionPage => ({
  name: "All",
  titles,
  total,
});

/** A playlist subscription, whose Movies open on the whole catalogue. */
const playlist = { ...SAVED, kind: "m3u" as const, playlistMapped: true };

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  useUi.setState({
    view: "movies",
    details: null,
    savedEntry: null,
    playingTitle: false,
    searchOpen: false,
    settings: null,
  });
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

/** Lets the window take in what just happened, on the fake clock. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));

/** Presses a key where the focus is, as the keyboard does. */
const press = (key: string) =>
  act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });

/** What the focused control and the list item it is in say about themselves. */
function focused() {
  const control = document.activeElement;
  const item = control?.closest('[role="listitem"]');
  return {
    label: control?.getAttribute("aria-label") ?? null,
    position: item
      ? `${item.getAttribute("aria-posinset")} of ${item.getAttribute("aria-setsize")}`
      : null,
  };
}

/** Draws `page`, with the lists and the watchlist kept current as the app keeps them. */
async function shown(page: (active: boolean) => ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [playlist]);
  const stopLists = syncOnDemand(client);
  const stopWatchlist = syncWatchlist(client);
  const mounted = queryView(client);
  const render = (active: boolean) => mounted.render(page(active));
  await render(true);
  await settle();
  unmount = () => {
    stopLists();
    stopWatchlist();
    mounted.unmount();
  };
  return render;
}

/** Movies, on the whole catalogue: `collection` answers its pages. */
async function movies() {
  ipc.always("subscription.list", [playlist]);
  ipc.always("ondemand.status", { lists: [], metadata: null });
  ipc.always("ondemand.filterOptions", { qualities: [], languages: [], verified: [], files: 0 });
  return shown((active) => createElement(TitlesPage, { kind: "movie", active }));
}

describe("a collection", () => {
  it("moves the focus with the selection, names the poster and its place, and opens it with Enter", async () => {
    ipc.always("ondemand.collection", all([arrival, blade, contact]));
    await movies();

    await press("ArrowDown");
    expect(focused()).toEqual({ label: "Blade Runner, 1982", position: "2 of 3" });
    // One stop in the Tab order: the poster the keys are on.
    expect(
      [...document.querySelectorAll('[role="listitem"] button')].map((each) =>
        each.getAttribute("tabindex"),
      ),
    ).toEqual(["-1", "0", "-1"]);

    // Enter where the focus is opens that poster, once.
    await press("Enter");
    expect(useUi.getState().details).toEqual({
      kind: "movie",
      subscriptionId: SUBSCRIPTION,
      id: "b",
      asked: false,
    });
  });

  it("keeps the focus on its title when the list is read again in another order", async () => {
    ipc.always("ondemand.collection", all([arrival, blade, contact]));
    await movies();
    await press("ArrowDown");
    await press("ArrowDown");
    expect(focused().label).toBe("Contact, 1997");

    // A refresh adds a title before it.
    ipc.always("ondemand.collection", all([dune, arrival, blade, contact]));
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await settle();

    expect(focused()).toEqual({ label: "Contact, 1997", position: "4 of 4" });
    await press("ArrowUp");
    expect(focused().label).toBe("Blade Runner, 1982");
  });

  it("puts the focus back on the poster that opened details, wherever the list moved it", async () => {
    ipc.always("ondemand.collection", all([arrival, blade, contact]));
    const render = await movies();
    await press("ArrowDown");
    await press("Enter");
    expect(useUi.getState().details?.id).toBe("b");

    // Details cover the page, and the list changes under them.
    await render(false);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    ipc.always("ondemand.collection", all([dune, contact, arrival, blade]));
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await settle();
    await act(async () => useUi.setState({ details: null }));
    await render(true);
    await settle();

    expect(focused()).toEqual({ label: "Blade Runner, 1982", position: "4 of 4" });
  });

  /**
   * Two pages of titles, read by offset from `catalogue`, with the keys on Title 119: the last of
   * the first page. `titles` is the list as it was.
   */
  async function twoPages() {
    const titles = Array.from({ length: 240 }, (_, index) =>
      film(`t${index}`, `Title ${index}`, 2000),
    );
    const list = { catalogue: titles };
    ipc.answer("ondemand.collection", ({ offset, limit }) =>
      all(list.catalogue.slice(offset, offset + limit), list.catalogue.length),
    );
    const render = await movies();
    // Both pages are in before the keys come back to the first.
    await press("End");
    await settle();
    await press("Home");
    for (let step = 0; step < 119; step++) await press("ArrowRight");
    expect(focused()).toEqual({ label: "Title 119, 2000", position: "120 of 240" });
    return { titles, list, render };
  }

  /** A title added at the top of the list: it pushes Title 119 into the second page. */
  const added = film("new", "Added", 2026);

  it.each([
    ["the first page", 0],
    ["the second page", 120],
  ])(
    "keeps the selected title when a refresh moves it across pages and %s answers last",
    async (_, late) => {
      const { titles, list } = await twoPages();
      const held = ipc.hold("ondemand.collection", ({ offset }) => offset === late);
      list.catalogue = [added, ...titles];
      await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
      await settle();
      // Half the list is read again: Title 119 is in neither page, or still in the old one.
      // Nothing else takes its place.
      expect(focused().label ?? "Title 119, 2000").toBe("Title 119, 2000");

      await act(async () =>
        held.resolve(all(list.catalogue.slice(late, late + 120), list.catalogue.length)),
      );
      await settle();
      expect(focused()).toEqual({ label: "Title 119, 2000", position: "121 of 241" });
      await press("Enter");
      expect(useUi.getState().details?.id).toBe("t119");
    },
  );

  it("keeps focus on an already loaded moved title when another refresh shortens its old page", async () => {
    const { titles, list } = await twoPages();
    await press("End");
    expect(focused()).toEqual({ label: "Title 239, 2000", position: "240 of 240" });

    const oldPage = ipc.hold(
      "ondemand.collection",
      ({ id, offset, limit }) => id === "all" && offset === 120 && limit === 120,
    );
    list.catalogue = [...titles.slice(0, 50), titles[239]!, ...titles.slice(50, 239)];
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await settle();
    // Its new first-page position has answered; its old second-page copy is still cached.
    expect(focused()).toEqual({ label: "Title 239, 2000", position: "240 of 240" });

    const first = ipc.hold(
      "ondemand.collection",
      ({ id, offset, limit }) => id === "all" && offset === 0 && limit === 120,
    );
    list.catalogue = list.catalogue.slice(0, 220);
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await settle();
    // The old slot is now empty. The loaded title keeps the keys before the first page answers.
    expect(focused()).toEqual({ label: "Title 239, 2000", position: "51 of 240" });
    expect(document.querySelectorAll('[role="listitem"] [tabindex="0"]')).toHaveLength(1);
    await press("Enter");
    expect(useUi.getState().details?.id).toBe("t239");

    await act(async () => oldPage.resolve(all(titles.slice(120), titles.length)));
    await act(async () => first.resolve(all(list.catalogue.slice(0, 120), list.catalogue.length)));
    await settle();
    expect(focused()).toEqual({ label: "Title 239, 2000", position: "51 of 220" });
  });

  it("moves the selection to what took a removed title's place once its pages answer", async () => {
    const { titles, list } = await twoPages();
    const held = ipc.hold("ondemand.collection", ({ offset }) => offset === 120);
    list.catalogue = titles.filter((title) => title.id !== "t119");
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await settle();
    await act(async () => held.resolve(all(list.catalogue.slice(120, 240), list.catalogue.length)));
    await settle();
    expect(focused()).toEqual({ label: "Title 120, 2000", position: "120 of 239" });
  });

  it.each([
    ["before", true],
    ["after", false],
  ])(
    "puts the focus back on the poster that opened details when its moved page answers %s they close",
    async (_, beforeClose) => {
      const { titles, list, render } = await twoPages();
      await press("Enter");
      expect(useUi.getState().details?.id).toBe("t119");

      // Details cover the page; a refresh moves the title, and its new page answers late.
      await render(false);
      await act(async () => (document.activeElement as HTMLElement | null)?.blur());
      const held = ipc.hold("ondemand.collection", ({ offset }) => offset === 120);
      list.catalogue = [added, ...titles];
      await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
      await settle();
      const answer = () =>
        act(async () => held.resolve(all(list.catalogue.slice(120, 240), list.catalogue.length)));
      if (beforeClose) await answer();
      await act(async () => useUi.setState({ details: null }));
      await render(true);
      await settle();
      if (!beforeClose) {
        expect(focused().label ?? "Title 119, 2000").toBe("Title 119, 2000");
        await answer();
        await settle();
      }
      expect(focused()).toEqual({ label: "Title 119, 2000", position: "121 of 241" });
    },
  );

  it.each([
    ["nowhere", false],
    ["on a poster", true],
  ])(
    "leaves the focus in the field the viewer chose while a page the keys asked for loads, from %s",
    async (_, fromPoster) => {
      const titles = Array.from({ length: 300 }, (_, index) =>
        film(`t${index}`, `Title ${index}`, 2000),
      );
      ipc.answer("ondemand.collection", ({ offset, limit }) =>
        all(titles.slice(offset, offset + limit), titles.length),
      );
      const last = ipc.hold("ondemand.collection", ({ offset }) => offset === 240);
      await movies();
      if (fromPoster) {
        await press("ArrowDown");
        expect(focused().label).toBe("Title 1, 2000");
      }

      await press("End");
      await settle();
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Search movies"]')!;
      await act(async () => field.focus());
      await act(async () => last.resolve(all(titles.slice(240), titles.length)));
      await settle();
      expect(document.activeElement).toBe(field);
      // The keys still went to the end: Tab enters there.
      expect(
        document.querySelector('[role="listitem"][aria-posinset="300"] [tabindex="0"]'),
      ).not.toBeNull();
    },
  );

  it.each([false, true])(
    "drops the old selection and late page after adult reclassification, with outside focus %s",
    async (outside) => {
      const { titles, list } = await twoPages();
      // Same catalogue timestamps, but the second update marks the selected title for adults.
      const late = ipc.hold("ondemand.collection", ({ offset }) => offset === 120);
      await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
      await settle();
      list.catalogue = titles.filter((title) => title.id !== "t119");
      const current = ipc.hold(
        "ondemand.collection",
        ({ id, offset, limit }) => id === "all" && offset === 0 && limit === 120,
      );
      await act(async () =>
        ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
      );
      await settle();
      expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0);
      await press("Enter");
      expect(useUi.getState().details).toBeNull();
      const field = document.querySelector<HTMLInputElement>('input[aria-label="Search movies"]')!;
      if (outside) await act(async () => field.focus());

      // The pre-reset page cannot restore its selected title, cursor or pending focus.
      await act(async () => late.resolve(all(titles.slice(120), titles.length)));
      await settle();
      expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0);
      await act(async () =>
        current.resolve(all(list.catalogue.slice(0, 120), list.catalogue.length)),
      );
      await settle();
      expect(document.body.textContent).not.toContain("Title 119");
      const stop = document.querySelector('[role="listitem"] [tabindex="0"]');
      expect(stop?.getAttribute("aria-label")).toBe("Title 0, 2000");
      expect(stop?.closest('[role="listitem"]')?.getAttribute("aria-posinset")).toBe("1");
      if (outside) expect(document.activeElement).toBe(field);
      else expect(focused()).toEqual({ label: "Title 0, 2000", position: "1 of 239" });
    },
  );

  it("returns from details to a safe first poster after a marked reset, without reviving the old opener", async () => {
    const { titles, list, render } = await twoPages();
    await press("Enter");
    expect(useUi.getState().details?.id).toBe("t119");
    await render(false);
    await act(async () => (document.activeElement as HTMLElement | null)?.blur());
    list.catalogue = titles.filter((title) => title.id !== "t119");
    const current = ipc.hold(
      "ondemand.collection",
      ({ id, offset, limit }) => id === "all" && offset === 0 && limit === 120,
    );
    await act(async () =>
      ipc.emit("ondemand.updated", { lists: [], metadata: null, markedForAdults: true }),
    );
    await settle();
    await act(async () => useUi.setState({ details: null }));
    await render(true);
    await settle();
    expect(document.querySelectorAll('[role="listitem"]')).toHaveLength(0);
    await act(async () =>
      current.resolve(all(list.catalogue.slice(0, 120), list.catalogue.length)),
    );
    await settle();
    expect(document.body.textContent).not.toContain("Title 119");
    expect(focused()).toEqual({ label: "Title 0, 2000", position: "1 of 239" });
    await press("Enter");
    expect(useUi.getState().details?.id).toBe("t0");
  });

  it("moves the focus to the last poster once its page arrives, and keeps it there while scrolled away", async () => {
    const titles = Array.from({ length: 300 }, (_, index) =>
      film(`t${index}`, `Title ${index}`, 2000),
    );
    ipc.answer("ondemand.collection", ({ offset, limit }) =>
      all(titles.slice(offset, offset + limit), titles.length),
    );
    const last = ipc.hold("ondemand.collection", ({ offset }) => offset === 240);
    await movies();

    await press("End");
    // The page that holds it is on its way: nothing has the focus in the grid yet.
    expect(focused().position).toBeNull();
    await act(async () => last.resolve(all(titles.slice(240), titles.length)));
    await settle();
    expect(focused()).toEqual({ label: "Title 299, 2000", position: "300 of 300" });

    // The list scrolls back to its top under the pointer; the poster with the focus stays.
    const poster = document.activeElement;
    const scroller = document.querySelector('[role="list"]')!.parentElement!;
    await act(async () => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await settle();
    expect(document.querySelector('[role="listitem"][aria-posinset="1"]')).not.toBeNull();
    expect(document.activeElement).toBe(poster);
    expect(poster?.isConnected).toBe(true);
  });
});

describe("the search of a kind", () => {
  it("hands the focus to the first result once the results are the query's, and not once the field has it again", async () => {
    ipc.always("ondemand.collection", all([arrival, blade, contact]));
    await movies();
    const answer = ipc.hold("ondemand.searchKind", ({ query }) => query === "a");
    const field = document.querySelector<HTMLInputElement>('input[aria-label="Search movies"]')!;
    const type = (value: string) =>
      act(async () => {
        field.focus();
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        set.call(field, value);
        field.dispatchEvent(new Event("input", { bubbles: true }));
      });

    await type("a");
    // Down before the results are in hands them the keys.
    await act(async () =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })),
    );
    expect(document.activeElement).not.toBe(field);
    await settle();
    await act(async () => answer.resolve({ titles: [arrival, blade], total: 2 }));
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(focused()).toEqual({ label: "Arrival, 2016", position: "1 of 2" });

    // Typing again: new results never take the focus from the field.
    ipc.always("ondemand.searchKind", { titles: [arrival], total: 1 });
    await type("ar");
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(document.activeElement).toBe(field);
  });
});

describe("the Watchlist", () => {
  const entry = (title: Title): WatchlistEntry => ({
    subscriptionId: SUBSCRIPTION,
    id: `e-${title.id}`,
    kind: title.kind,
    name: title.title,
    year: title.year,
    savedAt: Date.UTC(2025, 8, 12),
    title,
    artworkUrl: null,
    sources: [SUBSCRIPTION],
    listed: true,
  });
  const saved = [arrival, blade, contact].map(entry);
  const cross = () => document.activeElement?.getAttribute("aria-label");

  it("leaves the focus on the cross of the tile that took a removed one's place, or of the one before the last", async () => {
    ipc.always("subscription.list", [playlist]);
    ipc.always("ondemand.status", { lists: [], metadata: null });
    ipc.always("watchlist.list", { total: 3, entries: saved });
    ipc.always("watchlist.remove", null);
    useUi.setState({ view: "watchlist" });
    await shown((active) => createElement(WatchlistPage, { active }));

    // Tab reaches the selected tile's poster, then its cross.
    const tabbable = () =>
      [...document.querySelectorAll<HTMLElement>('[role="listitem"] [tabindex="0"]')].map((each) =>
        each.getAttribute("aria-label"),
      );
    expect(tabbable()).toEqual(["Arrival, Movie, 2016", "Remove Arrival from Watchlist"]);
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Remove Arrival from Watchlist"]')!.focus(),
    );

    // The cross pressed with the keyboard, as Enter presses a focused button.
    ipc.always("watchlist.list", { total: 2, entries: saved.slice(1) });
    await act(async () => (document.activeElement as HTMLElement).click());
    await settle();
    expect(cross()).toBe("Remove Blade Runner from Watchlist");
    expect(tabbable()).toEqual(["Blade Runner, Movie, 1982", "Remove Blade Runner from Watchlist"]);

    // The last one goes: the one before it takes the focus.
    await act(async () => (document.activeElement as HTMLElement).blur());
    await press("End");
    await act(async () =>
      document.querySelector<HTMLElement>('[aria-label="Remove Contact from Watchlist"]')!.focus(),
    );
    ipc.always("watchlist.list", { total: 1, entries: saved.slice(1, 2) });
    await act(async () => (document.activeElement as HTMLElement).click());
    await settle();
    expect(cross()).toBe("Remove Blade Runner from Watchlist");
    expect(ipc.argsOf("watchlist.remove").map(({ entry }) => entry.id)).toEqual(["e-a", "e-c"]);
  });

  /** The Watchlist with `entries` saved, and the next removal held until the test answers it. */
  async function watchlist(entries: readonly WatchlistEntry[]) {
    ipc.always("subscription.list", [playlist]);
    ipc.always("ondemand.status", { lists: [], metadata: null });
    ipc.always("watchlist.list", { total: entries.length, entries });
    const removal = ipc.hold("watchlist.remove");
    useUi.setState({ view: "watchlist" });
    await shown((active) => createElement(WatchlistPage, { active }));
    return removal;
  }

  it.each([
    ["two titles remain", "removal answers", 3],
    ["two titles remain", "list changes", 3],
    ["nothing remains", "removal answers", 1],
    ["nothing remains", "list changes", 1],
  ])(
    "leaves the focus on the window bar the viewer moved to while a removal ran, when %s and the %s first",
    async (_, order, count) => {
      const entries = saved.slice(0, count);
      const removal = await watchlist(entries);
      const pressed = document.querySelector<HTMLElement>(
        `[aria-label="Remove ${entries[0]!.name} from Watchlist"]`,
      )!;
      // The cross pressed with the keyboard, then Tab on to the window bar before it answers.
      await act(async () => {
        pressed.focus();
        pressed.click();
      });
      await settle();
      const outside = document.querySelector<HTMLElement>("header button")!;
      await act(async () => outside.focus());

      ipc.always("watchlist.list", { total: count - 1, entries: entries.slice(1) });
      if (order === "list changes") {
        await act(async () => ipc.emit("watchlist.changed", null));
        await settle();
      }
      await act(async () => removal.resolve(null));
      await settle();
      expect(document.body.textContent?.includes("Nothing saved yet")).toBe(count === 1);
      expect(document.activeElement).toBe(outside);
    },
  );

  it("gives the page the focus once the last title goes with the cross that had it", async () => {
    const removal = await watchlist(saved.slice(0, 1));
    const only = document.querySelector<HTMLElement>(
      '[aria-label="Remove Arrival from Watchlist"]',
    )!;
    await act(async () => {
      only.focus();
      only.click();
    });
    ipc.always("watchlist.list", { total: 0, entries: [] });
    await act(async () => removal.resolve(null));
    await settle();
    expect(document.body.textContent).toContain("Nothing saved yet");
    expect(document.activeElement?.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement?.textContent).toContain("Watchlist");
  });
});
