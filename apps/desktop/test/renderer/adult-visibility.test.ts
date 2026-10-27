// @vitest-environment happy-dom
// Titles for adults stay out of sight whatever the views kept from before: once Settings hides
// them, and once a refresh's lists mark for adults a title they listed for everyone before.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcInput } from "@mrstreamer/contracts/ipc";
import type { OnDemandUpdate, Title, TitlePage } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import type { TitleProgress, Viewing } from "@mrstreamer/contracts/viewing";
import type { WatchlistEntry } from "@mrstreamer/contracts/watchlist";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { SearchPalette } from "../../src/renderer/src/features/search/SearchPalette.tsx";
import { TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { WatchlistPage } from "../../src/renderer/src/features/watchlist/WatchlistPage.tsx";
import { acceptPreferences, syncPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { PresentationVisible } from "../../src/renderer/src/lib/presentation.ts";
import {
  queries,
  syncOnDemand,
  syncViewing,
  syncWatchlist,
} from "../../src/renderer/src/lib/queries.ts";

const movie = (name: string, adult = false): Title => ({
  kind: "movie",
  key: `movie:${name}`,
  subscriptionId: SUBSCRIPTION,
  id: name,
  name,
  title: name,
  originalTitle: null,
  originalLanguage: null,
  tags: [],
  year: null,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: name, tags: [] }],
});
const page = (name: string, titles: readonly Title[]): TitlePage & { name: string } => ({
  name,
  total: titles.length,
  titles,
});
/** What the lists hold for adults while Settings shows them. */
const FOR_ADULTS = page("For adults", [movie("Night Reel", true), movie("Late Reel", true)]);
/** And while it hides them, as the main process answers. */
const NONE_FOR_ADULTS = page("For adults", []);
const isAdultPage = (args: IpcInput<"ondemand.collection">) => args.id === "adult";

// happy-dom has no layout; give the virtual grid a visible viewport.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 900,
});

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});

/** Lets the page's timers and answers run on the fake clock until `check` passes. */
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    },
    { interval: 1 },
  );

/** Movies, with Settings showing titles for adults, and Settings' later commits as events. */
async function mount() {
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", []);
  ipc.always("library.channels", []);
  ipc.always("library.status", []);
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.status", { lists: [], metadata: null });
  ipc.always("ondemand.rows", [{ id: "popular", ...page("Popular", [movie("Daylight")]) }]);
  ipc.answer("ondemand.collection", (args) =>
    isAdultPage(args) ? FOR_ADULTS : page("All", [movie("Daylight")]),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  const stopPreferences = syncPreferences(client, () => {});
  acceptPreferences(client, ipc.snapshot({ ...defaultPreferences, adultTitles: true }));
  const stopOnDemand = syncOnDemand(client);
  const view = queryView(client);
  const { container } = view;
  const show = (open: boolean) =>
    view.render(open ? createElement(TitlesPage, { kind: "movie", active: true }) : null);
  cleanup = () => {
    stopOnDemand();
    stopPreferences();
    view.unmount();
  };
  await show(true);
  const tabs = () =>
    [...container.querySelectorAll("nav button")].map((button) => button.textContent);
  const click = async (label: string) => {
    await until(() => expect(tabs()).toContain(label));
    const button = [...container.querySelectorAll("nav button")].find(
      (each) => each.textContent === label,
    );
    await act(async () => (button as HTMLButtonElement).click());
  };
  /** What a viewer could read on the page: the tab names, then everything else. */
  const shows = () => container.textContent ?? "";
  /** Settings commits hiding titles for adults; the main process answers without them since. */
  const hide = () => {
    ipc.answer("ondemand.collection", (args) =>
      isAdultPage(args) ? NONE_FOR_ADULTS : page("All", [movie("Daylight")]),
    );
    return act(async () =>
      ipc.emit("preferences.changed", ipc.snapshot({ ...defaultPreferences, adultTitles: false })),
    );
  };
  return { show, tabs, click, shows, hide };
}

it("opens Movies without the Adults tab or its titles once Settings hid them, before any answer", async () => {
  const view = await mount();
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
  // Home, then Settings hides titles for adults.
  await view.show(false);
  await view.hide();
  const held = ipc.hold("ondemand.collection", isAdultPage);
  await view.show(true);
  expect(view.tabs()).not.toContain("Adults");
  expect(view.shows()).not.toContain("Night Reel");
  expect(view.shows()).not.toContain("Late Reel");
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.shows()).not.toContain("Night Reel");
  await act(async () => held.resolve(NONE_FOR_ADULTS));
  await until(() => expect(view.shows()).toContain("Daylight"));
  expect(view.tabs()).not.toContain("Adults");
});

it("takes the Adults tab away as the hide is committed, and a reply read before it can't restore it", async () => {
  const view = await mount();
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
  // A read that started while titles for adults showed, answered after Settings hid them, and
  // the read the hide itself asks for, both still under way.
  const late = ipc.hold("ondemand.collection", isAdultPage);
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  const current = ipc.hold("ondemand.collection", isAdultPage);
  await view.hide();
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.tabs()).not.toContain("Adults");
  expect(view.shows()).not.toContain("Night Reel");
  await act(async () => late.resolve(FOR_ADULTS));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(view.tabs()).not.toContain("Adults");
  expect(view.shows()).not.toContain("Night Reel");
  await act(async () => current.resolve(NONE_FOR_ADULTS));
  await until(() => expect(view.shows()).toContain("Daylight"));
  expect(view.tabs()).not.toContain("Adults");
});

it("offers the Adults tab again once Settings shows titles for adults", async () => {
  const view = await mount();
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
  await view.hide();
  await until(() => expect(view.tabs()).not.toContain("Adults"));
  ipc.answer("ondemand.collection", (args) =>
    isAdultPage(args) ? FOR_ADULTS : page("All", [movie("Daylight")]),
  );
  await act(async () =>
    ipc.emit("preferences.changed", ipc.snapshot({ ...defaultPreferences, adultTitles: true })),
  );
  await view.click("Adults");
  await until(() => expect(view.shows()).toContain("Night Reel"));
});

describe("after a refresh marks a listed title for adults", () => {
  /** Listed for everyone until the refresh, which marks it for adults. */
  const LATER = movie("Later Reel");
  const DAYLIGHT = movie("Daylight");
  /** What `ondemand.updated` says of lists fetched at `fetchedAt`. */
  const updated = (fetchedAt: number, markedForAdults?: true): OnDemandUpdate => ({
    lists: [{ subscriptionId: SUBSCRIPTION, movies: 3, series: 0, fetchedAt, failure: null }],
    metadata: null,
    ...(markedForAdults ? { markedForAdults } : {}),
  });
  const saved = (title: Title): WatchlistEntry => ({
    subscriptionId: SUBSCRIPTION,
    id: title.id,
    kind: title.kind,
    name: title.title,
    year: null,
    savedAt: 1,
    title,
    artworkUrl: null,
    sources: [SUBSCRIPTION],
    listed: true,
  });
  const recommended = (titles: readonly Title[]) =>
    titles.map((title) => ({ title, seed: "Seed Reel", reason: "Drama" }));
  const asPage = (titles: readonly Title[]) => page("All", titles);
  const isAll = (args: IpcInput<"ondemand.collection">) => args.id === "all";

  /**
   * A view that lists titles by one read: `answer` gives that read's titles from now on, `hold`
   * holds its next call, and `open` and `close` go to the view and away as the viewer does.
   */
  interface Browse {
    answer(titles: readonly Title[]): void;
    hold(): { resolve(titles: readonly Title[]): void };
    open(first: boolean): Promise<void>;
    close(): Promise<void>;
  }

  async function browse(name: (typeof VIEWS)[number]) {
    ipc.always("subscription.list", [SAVED]);
    ipc.always("library.categories", []);
    ipc.always("library.channels", []);
    ipc.always("library.status", []);
    ipc.always("library.searchGroups", []);
    ipc.always("guide.search", []);
    ipc.always("viewing.get", {
      favourites: [],
      recent: [],
      continueWatching: [],
      marked: [],
      sequence: 0,
      recentTitles: [
        {
          title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "Seed Reel" },
          position: 600,
          duration: 1200,
          finished: false,
          at: 1,
          since: 1,
        },
      ],
    });
    ipc.always("ondemand.status", { lists: [], metadata: null });
    ipc.always("ondemand.rows", []);
    ipc.always("watchlist.list", { total: 0, entries: [] });
    ipc.answer("ondemand.collection", (args) =>
      isAdultPage(args) ? NONE_FOR_ADULTS : asPage([DAYLIGHT]),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
    const stops = [syncPreferences(client, () => {}), syncOnDemand(client), syncWatchlist(client)];
    acceptPreferences(client, ipc.snapshot(defaultPreferences));
    const mounted = queryView(client);
    const { container } = mounted;
    const render = (view: ReactElement | null) =>
      mounted.render(createElement(TooltipProvider, null, view));
    cleanup = () => {
      for (const stop of stops) stop();
      mounted.unmount();
      useUi.setState({ searchOpen: false, searchFrom: "" });
    };
    const press = async (label: string) => {
      await until(() =>
        expect([...container.querySelectorAll("button")].map((b) => b.textContent)).toContain(
          label,
        ),
      );
      const button = [...container.querySelectorAll("button")].find(
        (each) => each.textContent === label,
      );
      await act(async () => (button as HTMLButtonElement).click());
    };
    const type = async (label: string, text: string) => {
      await until(() =>
        expect(container.querySelector(`input[aria-label="${label}"]`)).not.toBeNull(),
      );
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setValue.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    const titlesPage = createElement(TitlesPage, { kind: "movie", active: true });
    const views: Record<(typeof VIEWS)[number], Browse> = {
      "Home recommendations": {
        answer: (titles) => ipc.always("ondemand.recommendations", recommended(titles)),
        hold: () => {
          const held = ipc.hold("ondemand.recommendations");
          return { resolve: (titles) => held.resolve(recommended(titles)) };
        },
        open: () => render(createElement(HomeScreen, { active: true })),
        close: () => render(null),
      },
      "All movies": {
        answer: (titles) =>
          ipc.answer("ondemand.collection", (args) =>
            isAdultPage(args) ? NONE_FOR_ADULTS : asPage(titles),
          ),
        hold: () => {
          const held = ipc.hold("ondemand.collection", isAll);
          return { resolve: (titles) => held.resolve(asPage(titles)) };
        },
        open: async (first) => {
          await render(titlesPage);
          if (first) await press("All movies");
        },
        close: () => render(null),
      },
      "Movies search": {
        answer: (titles) => ipc.always("ondemand.searchKind", { titles, total: titles.length }),
        hold: () => {
          const held = ipc.hold("ondemand.searchKind");
          return { resolve: (titles) => held.resolve({ titles, total: titles.length }) };
        },
        open: async (first) => {
          await render(titlesPage);
          if (!first) return;
          await press("For you");
          await type("Search movies", "Reel");
        },
        close: () => render(null),
      },
      Watchlist: {
        answer: (titles) =>
          ipc.always("watchlist.list", { total: titles.length, entries: titles.map(saved) }),
        hold: () => {
          const held = ipc.hold("watchlist.list", (query) => query.limit !== 1);
          return {
            resolve: (titles) => held.resolve({ total: titles.length, entries: titles.map(saved) }),
          };
        },
        open: () => render(createElement(WatchlistPage, { active: true })),
        close: () => render(null),
      },
      "Search palette": {
        answer: (titles) => ipc.always("ondemand.search", { movies: titles, series: [] }),
        hold: () => {
          const held = ipc.hold("ondemand.search");
          return { resolve: (titles) => held.resolve({ movies: titles, series: [] }) };
        },
        open: async () => {
          await render(createElement(SearchPalette));
          await act(async () => useUi.setState({ searchOpen: true, searchFrom: "Reel" }));
        },
        close: () => act(async () => useUi.setState({ searchOpen: false, searchFrom: "" })),
      },
    };
    const emit = (update: OnDemandUpdate) => act(async () => ipc.emit("ondemand.updated", update));
    // The palette opens in a portal, outside the container.
    return { ...views[name], shows: () => document.body.textContent ?? "", emit };
  }

  const VIEWS = [
    "Home recommendations",
    "All movies",
    "Movies search",
    "Watchlist",
    "Search palette",
  ] as const;

  it.each(VIEWS)("%s opens again without it, before the new answer", async (name) => {
    const view = await browse(name);
    view.answer([LATER, DAYLIGHT]);
    await view.open(true);
    await until(() => expect(view.shows()).toContain("Later Reel"));
    await view.close();
    await view.emit(updated(2, true));
    const held = view.hold();
    await view.open(false);
    expect(view.shows()).not.toContain("Later Reel");
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.shows()).not.toContain("Later Reel");
    await act(async () => held.resolve([DAYLIGHT]));
    await until(() => expect(view.shows()).toContain("Daylight"));
    expect(view.shows()).not.toContain("Later Reel");
  });

  it("takes it off an open grid before the new answer, and drops a late answer from before", async () => {
    const view = await browse("All movies");
    view.answer([LATER, DAYLIGHT]);
    await view.open(true);
    await until(() => expect(view.shows()).toContain("Later Reel"));
    // An ordinary refresh keeps the posters while the grid is read again, and that read is
    // still under way when a later refresh marks Later Reel for adults.
    const late = view.hold();
    await view.emit(updated(1));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.shows()).toContain("Later Reel");
    const current = view.hold();
    await view.emit(updated(2, true));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.shows()).not.toContain("Later Reel");
    await act(async () => late.resolve([LATER, DAYLIGHT]));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.shows()).not.toContain("Later Reel");
    await act(async () => current.resolve([DAYLIGHT]));
    await until(() => expect(view.shows()).toContain("Daylight"));
    expect(view.shows()).not.toContain("Later Reel");
    expect(ipc.argsOf("ondemand.collection").filter(isAll)).toHaveLength(3);
  });
});

describe("Continue watching, after a refresh marks a title in it for adults", () => {
  /** Listed for everyone until the refresh, which marks it for adults. */
  const LATER = movie("Later Reel");
  const DAYLIGHT = movie("Daylight");
  const EVENING = movie("Evening Reel");
  const played = (title: Title, at: number): TitleProgress => ({
    title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: title.id },
    position: 600,
    duration: 1200,
    finished: false,
    at,
    since: at,
  });
  const record = (titles: readonly Title[], sequence: number): Viewing => ({
    favourites: [],
    recent: [],
    continueWatching: titles.map((title, index) => played(title, 100 - index)),
    marked: [],
    sequence,
  });
  const ordinary: OnDemandUpdate = {
    lists: [{ subscriptionId: SUBSCRIPTION, movies: 3, series: 0, fetchedAt: 1, failure: null }],
    metadata: null,
  };
  const marked: OnDemandUpdate = { ...ordinary, markedForAdults: true };

  /** Home with two films to continue; `refresh` has the lists mark Later Reel for adults. */
  async function home() {
    const listed = new Map([LATER, DAYLIGHT, EVENING].map((title) => [title.id, title]));
    ipc.always("subscription.list", [SAVED]);
    ipc.always("library.categories", []);
    ipc.always("library.channels", []);
    ipc.always("library.status", []);
    ipc.always("ondemand.status", { lists: [], metadata: null });
    ipc.always("ondemand.rows", []);
    ipc.always("ondemand.collection", page("All", []));
    ipc.always("watchlist.list", { total: 0, entries: [] });
    ipc.always("viewing.get", record([LATER, DAYLIGHT], 1));
    const answer = ({ versions }: IpcInput<"ondemand.titles">) =>
      versions.flatMap((version) => listed.get(version.id) ?? []);
    ipc.answer("ondemand.titles", answer);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
    const stops = [
      syncPreferences(client, () => {}),
      syncOnDemand(client),
      syncWatchlist(client),
      syncViewing(client),
    ];
    acceptPreferences(client, ipc.snapshot(defaultPreferences));
    const view = queryView(client);
    const { container } = view;
    cleanup = () => {
      for (const stop of stops) stop();
      view.unmount();
    };
    /** Home open or not, and in view or covered, as by Watch or a playing title. */
    const show = (open: boolean, visible = true) =>
      view.render(
        createElement(
          TooltipProvider,
          null,
          createElement(
            PresentationVisible,
            { value: visible },
            open ? createElement(HomeScreen, { active: visible }) : null,
          ),
        ),
      );
    const refresh = () => {
      listed.set(LATER.id, { ...LATER, adult: true });
      return act(async () => ipc.emit("ondemand.updated", marked));
    };
    /** Holds the next title lookup, answered as the lists say then. */
    const hold = () => {
      const held = ipc.hold("ondemand.titles");
      return {
        resolve: (titles: readonly Title[]) => act(async () => held.resolve(titles)),
      };
    };
    return { container, show, refresh, hold, listed };
  }

  it("opens Home again without it, before the new answer", async () => {
    const view = await home();
    await view.show(true);
    await until(() => expect(view.container.textContent).toContain("Later Reel"));
    await view.show(false);
    await view.refresh();
    const held = view.hold();
    await view.show(true);
    expect(view.container.textContent).not.toContain("Later Reel");
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.container.textContent).not.toContain("Later Reel");
    await held.resolve([{ ...LATER, adult: true }, DAYLIGHT]);
    await until(() => expect(view.container.textContent).toContain("Daylight"));
    expect(view.container.textContent).not.toContain("Later Reel");
  });

  it("takes it off an open Home before the new answer, and drops a late answer from before", async () => {
    const view = await home();
    await view.show(true);
    await until(() => expect(view.container.textContent).toContain("Later Reel"));
    // An ordinary refresh keeps it while the films are looked up again, still under way when a
    // later refresh marks Later Reel for adults.
    const late = view.hold();
    await act(async () => ipc.emit("ondemand.updated", ordinary));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.container.textContent).toContain("Later Reel");
    const current = view.hold();
    await view.refresh();
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.container.textContent).not.toContain("Later Reel");
    await late.resolve([LATER, DAYLIGHT]);
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.container.textContent).not.toContain("Later Reel");
    await current.resolve([{ ...LATER, adult: true }, DAYLIGHT]);
    await until(() => expect(view.container.textContent).toContain("Daylight"));
    expect(view.container.textContent).not.toContain("Later Reel");
  });

  it("shows it nowhere once a covered Home is in view again", async () => {
    const view = await home();
    await view.show(true);
    await until(() => expect(view.container.textContent).toContain("Later Reel"));
    // Watch covers Home: its lookups wait, keeping what they had.
    await view.show(true, false);
    await view.refresh();
    const held = view.hold();
    await view.show(true, true);
    expect(view.container.textContent).not.toContain("Later Reel");
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.container.textContent).not.toContain("Later Reel");
    await held.resolve([{ ...LATER, adult: true }, DAYLIGHT]);
    await until(() => expect(view.container.textContent).toContain("Daylight"));
    expect(view.container.textContent).not.toContain("Later Reel");
  });

  it("lends a new lookup nothing from the one before the refresh", async () => {
    const view = await home();
    await view.show(true);
    await until(() => expect(view.container.textContent).toContain("Later Reel"));
    const again = view.hold();
    await view.refresh();
    // A third film is played: the films to look up change while Later Reel's lookup waits. Home
    // shows the latest it may, here with room for one.
    const third = view.hold();
    ipc.always("viewing.get", record([EVENING, LATER, DAYLIGHT], 2));
    await act(async () => ipc.emit("viewing.changed", { sequence: 2 }));
    await act(() => vi.advanceTimersByTimeAsync(50));
    expect(view.container.textContent).not.toContain("Later Reel");
    await again.resolve([{ ...LATER, adult: true }, DAYLIGHT]);
    await third.resolve([{ ...LATER, adult: true }, DAYLIGHT, EVENING]);
    await until(() => expect(view.container.textContent).toContain("Evening Reel"));
    expect(view.container.textContent).not.toContain("Later Reel");
  });
});
