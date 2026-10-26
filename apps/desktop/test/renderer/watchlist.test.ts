// @vitest-environment happy-dom
// The watchlist in the window: Save in a title's details, which goes by the title in the lists
// and shows a change only once it is stored; the Watchlist page with its posters, its orders and
// the titles the provider dropped; and the short sheet that removes one of those, which goes
// for good when Settings hides titles for adults. Each of the three makes one change at a time,
// however quickly it is pressed again. Beside another subscription, they say whose a title is
// where that tells two apart.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, type ReactElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OnDemandStatus, Title } from "@mrstreamer/contracts/ondemand";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry, WatchlistPage as Page } from "@mrstreamer/contracts/watchlist";
import { App } from "../../src/renderer/src/app/App.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { SavedSheet } from "../../src/renderer/src/features/watchlist/SavedSheet.tsx";
import { WatchlistPage } from "../../src/renderer/src/features/watchlist/WatchlistPage.tsx";
import { syncWatchlist } from "../../src/renderer/src/lib/queries.ts";

const own = (id: string) => ({ subscriptionId: SUBSCRIPTION, id });

const title = (kind: Title["kind"], id: string, name: string, year: number): Title => ({
  kind,
  key: `${kind}:tmdb:${id}`,
  ...own(id),
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
  versions: [{ ...own(id), tags: ["EN"] }],
});

const film = title("movie", "hd", "Night Harbour", 2024);

const entry = (
  id: string,
  kind: Title["kind"],
  name: string,
  year: number,
  listed: Title | null,
): WatchlistEntry => ({
  ...own(id),
  kind,
  name,
  year,
  savedAt: Date.UTC(2025, 8, 12),
  title: listed,
  artworkUrl: null,
  sources: [SUBSCRIPTION],
  listed: true,
});

const canyon = entry(
  "e1",
  "series",
  "Canyon Hours",
  2024,
  title("series", "s1", "Canyon Hours", 2024),
);
const meridian = entry("e2", "movie", "Meridian Dawn", 2023, null);
const harbour = entry("e3", "movie", "Night Harbour", 2024, film);

const page = (entries: readonly WatchlistEntry[]): Page => ({ total: entries.length, entries });

type Lists = OnDemandStatus["lists"][number];

/** How a subscription's lists stand: loaded, unless `failure` says its last refresh failed. */
const lists = (failure: Lists["failure"] = null, subscriptionId = SUBSCRIPTION): Lists => ({
  subscriptionId,
  movies: 10,
  series: 5,
  fetchedAt: 1,
  failure,
});

const status = (...of: readonly Lists[]): OnDemandStatus => ({
  lists: of.length > 0 ? of : [lists()],
  metadata: null,
});

/** A second subscription beside the tests' own, as the main process lists it. */
const OTHER = "9d2b7c41-6e0a-4f3b-8a15-c4e7f1d09b62";
const BOTH: readonly SubscriptionSummary[] = [
  { ...SAVED, name: "Nova TV" },
  { ...SAVED, id: OTHER, name: "Skyline", server: "https://skyline.example.tv" },
];

// happy-dom lays nothing out, and the grid draws only the rows that fit: it gets a height.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 900,
});

/** Lets the window take in what just happened, on the fake clock. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));

const buttons = () => [...document.body.querySelectorAll("button")];
const button = (label: string) =>
  buttons().find(
    (each) => each.textContent?.trim() === label || each.getAttribute("aria-label") === label,
  );
const press = (label: string) => act(async () => button(label)?.click());
/** Presses twice in one turn: the second press lands before the window has heard of the first. */
const pressTwice = (label: string) =>
  act(async () => {
    button(label)?.click();
    button(label)?.click();
  });
const key = (name: string, modifiers: KeyboardEventInit = {}) =>
  act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, ...modifiers }));
  });
const sheet = () => document.body.querySelector('[role="dialog"]');

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

/** Draws `view` in the page, with the watchlist kept current as the app keeps it. */
async function shown(view: ReactElement): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stopSync = syncWatchlist(client);
  const mounted = queryView(client);
  await mounted.render(view);
  unmount = () => {
    stopSync();
    mounted.unmount();
  };
}

describe("Save in a title's details", () => {
  /**
   * The film's details, open, with the lists' answer in and the provider's still to come: what
   * it returns answers for the provider.
   */
  async function details(saved: WatchlistEntry | null) {
    ipc.reset();
    const listed = ipc.hold("ondemand.titles");
    const progress = ipc.hold("viewing.progress");
    const membership = ipc.hold("watchlist.saved");
    const opened = ipc.hold("ondemand.details");
    const subscribed = ipc.hold("subscription.list");
    await shown(createElement(DetailsView, { target: { kind: "movie", ...own("hd") } }));
    await act(async () => subscribed.resolve([SAVED]));
    await act(async () => listed.resolve([film]));
    // The sheet asks how far the title got and whether it is saved once it drew the title. With
    // those answers given after it asked, the wait that follows them is sure to draw them.
    await settle();
    await act(async () => progress.resolve([]));
    await act(async () => membership.resolve(saved && own(saved.id)));
    await settle();
    return opened;
  }

  it("saves from the title in the lists while its details load, and says Saved once it is stored", async () => {
    await details(null);
    // The provider hasn't answered: the sheet has the title from the lists, and Save works.
    expect(document.body.textContent).toContain("Loading…");
    expect(button("Save")?.getAttribute("aria-pressed")).toBe("false");
    expect(button("Save")?.disabled).toBe(false);
    const stored = ipc.hold("watchlist.save");

    // Pressed again at once, and once more while the first press is being stored.
    await pressTwice("Save");
    await press("Save");

    // Asked once, by the version alone, and nothing says Saved before the answer.
    expect(ipc.argsOf("watchlist.save")).toEqual([{ kind: "movie", version: own("hd") }]);
    expect(button("Save")?.getAttribute("aria-pressed")).toBe("false");
    expect(button("Saved")).toBeUndefined();

    await act(async () => stored.resolve(own("e3")));
    await settle();

    expect(button("Saved")?.getAttribute("aria-pressed")).toBe("true");
    expect(ipc.methods()).not.toContain("viewing.recordProgress");

    // Stored, the button takes the next press: it takes the title off, by the entry it got.
    await pressTwice("Saved");
    expect(ipc.argsOf("watchlist.remove")).toEqual([{ entry: own("e3") }]);
    expect(ipc.argsOf("watchlist.save")).toHaveLength(1);
  });

  it("says a save wasn't stored, keeps Save, and saves on the next press", async () => {
    await details(null);
    const refused = ipc.hold("watchlist.save");
    await press("Save");
    await act(async () => refused.reject({ kind: "unexpected", detail: "database is locked" }));
    await settle();

    expect(document.body.textContent).toContain("Couldn't save. Try again.");
    expect(button("Save")?.getAttribute("aria-pressed")).toBe("false");

    const stored = ipc.hold("watchlist.save");
    await pressTwice("Save");
    await act(async () => stored.resolve(own("e3")));
    await settle();

    expect(ipc.argsOf("watchlist.save")).toHaveLength(2);
    expect(button("Saved")).toBeDefined();
    expect(document.body.textContent).not.toContain("Couldn't save");
  });

  it("removes a saved title by its entry, and stays Saved when the removal isn't stored", async () => {
    await details(harbour);
    expect(button("Saved")?.getAttribute("aria-pressed")).toBe("true");
    const refused = ipc.hold("watchlist.remove");

    await pressTwice("Saved");
    await act(async () => refused.reject({ kind: "unexpected", detail: "database is locked" }));
    await settle();

    expect(ipc.argsOf("watchlist.remove")).toEqual([{ entry: own("e3") }]);
    expect(document.body.textContent).toContain("Couldn't remove. Try again.");
    expect(button("Saved")).toBeDefined();

    const removed = ipc.hold("watchlist.remove");
    await pressTwice("Saved");
    await act(async () => removed.resolve(null));
    await settle();

    expect(ipc.argsOf("watchlist.remove")).toHaveLength(2);
    expect(button("Save")?.getAttribute("aria-pressed")).toBe("false");
    expect(ipc.methods()).not.toContain("viewing.removeFromContinue");
  });

  it("stays beside Play once the details arrive, as it was", async () => {
    const opened = await details(harbour);
    await act(async () =>
      opened.resolve({
        kind: "movie",
        title: film,
        originalTitle: null,
        plot: null,
        genres: [],
        cast: [],
        directors: [],
        releaseDate: null,
        duration: 6000,
        backdropUrl: null,
      }),
    );
    await settle();

    const labels = buttons().map((each) => each.textContent?.trim());
    expect(labels.indexOf("Play")).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf("Saved")).toBeGreaterThan(labels.indexOf("Play"));
    expect(ipc.argsOf("watchlist.saved")).toHaveLength(1);
  });
});

describe("the Watchlist page", () => {
  /**
   * The page, with `first` as what is saved, `state` as how the lists stand and `subscriptions`
   * as those saved.
   */
  async function watchlist(first: Page, state = status(), subscriptions = [SAVED]) {
    ipc.reset();
    useUi.setState({ view: "watchlist", details: null, savedEntry: null, searchOpen: false });
    const listed = ipc.hold("watchlist.list");
    const stand = ipc.hold("ondemand.status");
    const saved = ipc.hold("subscription.list");
    await shown(createElement(WatchlistPage, { active: true }));
    await act(async () => saved.resolve(subscriptions));
    await act(async () => stand.resolve(state));
    await act(async () => listed.resolve(first));
    await settle();
  }

  /** What each tile says: its name, and the line under it. */
  const tiles = () =>
    buttons()
      .filter((each) => each.querySelector("span.truncate"))
      .map((each) => [...each.querySelectorAll("span.truncate")].map((line) => line.textContent));

  it("shows what is saved as posters, newest first, with one the provider dropped marked Unavailable", async () => {
    await watchlist(page([canyon, meridian, harbour]));

    expect(ipc.argsOf("watchlist.list")).toEqual([{ sort: "saved", offset: 0, limit: 120 }]);
    expect(document.body.querySelector("h1")?.parentElement?.textContent).toBe("Watchlist3");
    expect(tiles()).toEqual([
      ["Canyon Hours", "Series · 2024"],
      ["Meridian Dawn", "Unavailable · Movie · 2023"],
      ["Night Harbour", "Movie · 2024"],
    ]);
    // Nothing asked the provider, or for any title's details.
    expect(ipc.methods()).not.toContain("ondemand.details");

    // A poster opens its title's details; the dropped one opens what was kept of it.
    await act(async () =>
      buttons()
        .find((each) => each.textContent?.includes("Canyon"))
        ?.click(),
    );
    expect(useUi.getState().details).toEqual({ kind: "series", ...own("s1") });
    await act(async () => useUi.setState({ details: null }));
    await act(async () =>
      buttons()
        .find((each) => each.textContent?.includes("Meridian"))
        ?.click(),
    );
    expect(useUi.getState().savedEntry).toEqual(meridian);
    expect(useUi.getState().details).toBeNull();
  });

  it("orders by name when asked, and opens the title the arrow keys are on with Enter", async () => {
    await watchlist(page([canyon, meridian, harbour]));
    const byName = ipc.hold("watchlist.list");

    await press("A to Z");
    await act(async () => byName.resolve(page([canyon, meridian, harbour])));
    await settle();

    expect(ipc.argsOf("watchlist.list").at(-1)).toEqual({ sort: "title", offset: 0, limit: 120 });
    expect(button("A to Z")?.getAttribute("aria-pressed")).toBe("true");

    await key("ArrowDown");
    await key("Enter");
    expect(useUi.getState().savedEntry).toEqual(meridian);
    // No key of its own takes a title off the list.
    await act(async () => useUi.setState({ savedEntry: null }));
    await key("Delete");
    await key("Backspace");
    expect(ipc.methods()).not.toContain("watchlist.remove");
  });

  it("takes a title off with its cross once the main process has, and says when it couldn't", async () => {
    await watchlist(page([canyon, meridian, harbour]));
    const refused = ipc.hold("watchlist.remove");

    await pressTwice("Remove Meridian Dawn from Watchlist");
    await act(async () => refused.reject({ kind: "unexpected", detail: "database is locked" }));
    await settle();

    expect(ipc.argsOf("watchlist.remove")).toEqual([{ entry: own("e2") }]);
    expect(document.body.textContent).toContain("Couldn't remove. Try again.");
    expect(tiles()).toHaveLength(3);

    const removed = ipc.hold("watchlist.remove");
    const after = ipc.hold("watchlist.list");
    await pressTwice("Remove Meridian Dawn from Watchlist");
    await act(async () => removed.resolve(null));
    await act(async () => after.resolve(page([canyon, harbour])));
    await settle();

    expect(ipc.argsOf("watchlist.remove")).toHaveLength(2);
    expect(tiles().map(([name]) => name)).toEqual(["Canyon Hours", "Night Harbour"]);
    expect(document.body.textContent).not.toContain("Couldn't remove");

    // Done, the page takes the next cross.
    await press("Remove Night Harbour from Watchlist");
    expect(ipc.argsOf("watchlist.remove").at(-1)).toEqual({ entry: own("e3") });
  });

  it("reads again when a title is saved elsewhere, and says how to save when nothing is", async () => {
    await watchlist(page([]));
    expect(document.body.textContent).toContain(
      "Nothing saved yet. Save a movie or series from its details.",
    );
    expect(button("A to Z")).toBeUndefined();

    const changed = ipc.hold("watchlist.list");
    await act(async () => ipc.emit("watchlist.changed", null));
    await act(async () => changed.resolve(page([harbour])));
    await settle();

    expect(tiles()).toEqual([["Night Harbour", "Movie · 2024"]]);
  });

  it("keeps showing what was saved when the lists couldn't be refreshed, without calling it unavailable", async () => {
    await watchlist(
      page([{ ...harbour, title: null, listed: false }]),
      status({ ...lists({ kind: "provider-error", status: 503 }), fetchedAt: null }),
    );

    expect(document.body.textContent).toContain(
      "The provider answered with an error (HTTP 503). Showing what was saved.",
    );
    expect(tiles()).toEqual([["Night Harbour", "Movie · 2024"]]);

    await press("Try again");
    expect(ipc.argsOf("ondemand.refresh")).toEqual([{ subscriptionId: SUBSCRIPTION }]);
  });

  it("beside another subscription, says whose a title is where two read the same, and whose lists couldn't be refreshed", async () => {
    // One film both list, and a film of each that reads the same without being one.
    const both: Title = {
      ...film,
      versions: [...film.versions, { subscriptionId: OTHER, id: "hd-there", tags: ["EN"] }],
    };
    const twin = title("movie", "t1", "Paper Moons", 2025);
    const theirs = entry("e6", "movie", "Paper Moons", 2025, {
      ...twin,
      subscriptionId: OTHER,
      versions: [{ subscriptionId: OTHER, id: "t1", tags: ["EN"] }],
      ambiguous: true,
    });
    await watchlist(
      page([
        { ...harbour, title: both, sources: [SUBSCRIPTION, OTHER] },
        entry("e5", "movie", "Paper Moons", 2025, { ...twin, ambiguous: true }),
        { ...theirs, subscriptionId: OTHER, sources: [OTHER] },
      ]),
      status(lists(), lists({ kind: "provider-error", status: 503 }, OTHER)),
      [...BOTH],
    );

    // The film both list is one poster, which names no subscription: Play offers each.
    expect(tiles()).toEqual([
      ["Night Harbour", "Movie · 2024"],
      ["Paper Moons", "Movie · 2025 · Nova TV"],
      ["Paper Moons", "Movie · 2025 · Skyline"],
    ]);
    expect(document.body.textContent).toContain(
      "Skyline: The provider answered with an error (HTTP 503). Showing what was saved.",
    );
    expect(document.body.textContent).not.toContain("Nova TV:");

    await press("Try again");
    expect(ipc.argsOf("ondemand.refresh")).toEqual([{ subscriptionId: OTHER }]);
    // Each cross names its own entry, by the subscription that saved it.
    await act(async () => document.body.querySelectorAll<HTMLElement>("[data-remove]")[2]?.click());
    expect(ipc.argsOf("watchlist.remove")).toEqual([
      { entry: { subscriptionId: OTHER, id: "e6" } },
    ]);
  });

  it("says why the watchlist can't be read, and reads it again on Try again", async () => {
    ipc.reset();
    useUi.setState({ view: "watchlist", details: null, savedEntry: null });
    const failed = ipc.hold("watchlist.list");
    await shown(createElement(WatchlistPage, { active: true }));
    await act(async () => failed.reject({ kind: "unexpected", detail: "unable to open database" }));
    await settle();

    expect(document.body.textContent).toContain("Something went wrong: unable to open database");
    const again = ipc.hold("watchlist.list");
    await press("Try again");
    await act(async () => again.resolve(page([canyon])));
    await settle();

    expect(tiles()).toEqual([["Canyon Hours", "Series · 2024"]]);
  });
});

describe("a saved title the provider no longer lists", () => {
  /** The sheet of `saved`, with `subscriptions` as those saved. */
  async function dropped(saved: WatchlistEntry, subscriptions = [SAVED]) {
    ipc.reset();
    useUi.setState({ savedEntry: saved, details: null });
    const listed = ipc.hold("subscription.list");
    await shown(createElement(SavedSheet, { entry: saved }));
    await act(async () => listed.resolve(subscriptions));
    await settle();
  }

  it("shows what was kept of it with Remove alone, and closes once it is removed", async () => {
    await dropped(meridian);

    expect(sheet()?.textContent).toContain("Meridian Dawn");
    expect(sheet()?.textContent).toContain("2023 · Movie · Saved");
    expect(sheet()?.textContent).toContain(
      "Your provider doesn't list it right now. It stays here until you remove it.",
    );
    expect(
      [...(sheet()?.querySelectorAll("button") ?? [])].map(
        (each) => each.textContent?.trim() || each.getAttribute("aria-label"),
      ),
    ).toEqual(["Remove from Watchlist", "Close"]);

    const refused = ipc.hold("watchlist.remove");
    await pressTwice("Remove from Watchlist");
    await act(async () => refused.reject({ kind: "unexpected", detail: "database is locked" }));
    await settle();
    expect(sheet()?.textContent).toContain("Couldn't remove. Try again.");
    expect(useUi.getState().savedEntry).toEqual(meridian);

    const removed = ipc.hold("watchlist.remove");
    await pressTwice("Remove from Watchlist");
    await act(async () => removed.resolve(null));
    await settle();

    expect(ipc.argsOf("watchlist.remove")).toEqual([{ entry: own("e2") }, { entry: own("e2") }]);
    expect(useUi.getState().savedEntry).toBeNull();
  });

  it("says the lists haven't loaded, rather than that the provider dropped it, when they weren't there to look in", async () => {
    await dropped({ ...meridian, listed: false });

    expect(sheet()?.textContent).toContain(
      "Your provider's lists haven't loaded. It stays here until you remove it.",
    );
    expect(sheet()?.textContent).not.toContain("doesn't list it");
  });

  it("beside another subscription, names those it was saved from", async () => {
    await dropped({ ...meridian, sources: [SUBSCRIPTION, OTHER] }, [...BOTH]);
    expect(sheet()?.textContent).toContain(
      "Nova TV and Skyline don't list it right now. It stays here until you remove it.",
    );
    unmount();

    await dropped({ ...meridian, sources: [OTHER], listed: false }, [...BOTH]);
    expect(sheet()?.textContent).toContain(
      "Skyline's lists haven't loaded. It stays here until you remove it.",
    );
  });

  it("is gone from the window once Settings hides titles for adults, and stays saved", async () => {
    // A series for adults the provider dropped, saved while Settings shows such titles.
    const afterDark = entry("e4", "series", "After Dark", 2022, null);
    ipc.reset();
    ipc.always("liveBrowse.get", { kind: "all" });
    ipc.prefer({ adultTitles: true });
    useUi.setState({ ...useUi.getInitialState(), view: "watchlist" }, true);
    const subscribed = ipc.hold("subscription.list");
    const stand = ipc.hold("ondemand.status");
    const listed = ipc.hold("watchlist.list");
    await shown(createElement(TooltipProvider, null, createElement(App)));
    await act(async () => subscribed.resolve([SAVED]));
    // Connected, the window draws the page, which asks what is saved. As in `details`, the
    // answers are given after it asked.
    await settle();
    await act(async () => stand.resolve(status()));
    await act(async () => listed.resolve(page([afterDark, harbour])));
    await settle();
    await act(async () =>
      buttons()
        .find((each) => each.textContent?.includes("After Dark"))
        ?.click(),
    );
    expect(sheet()?.textContent).toContain("After Dark");

    // Settings opens over the sheet with its shortcut, and the viewer unticks For adults.
    await key(",", { ctrlKey: true, metaKey: true });
    await settle();
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-view="settings"] nav button')]
        .find((button) => button.textContent === "Movies and series")!
        .click(),
    );
    await settle();
    const stored = ipc.hold("preferences.update");
    await act(async () =>
      document.body
        .querySelector<HTMLElement>('[role="checkbox"][aria-label="For adults"]')
        ?.click(),
    );
    expect(ipc.argsOf("preferences.update")).toEqual([{ adultTitles: false }]);

    // Back on the page before the main process answered: the sheet doesn't come back.
    await key("Escape");
    await settle();
    expect(useUi.getState().settings).toBeNull();
    expect(sheet()).toBeNull();

    // Stored, the main process lists the watchlist without it, as often as it is asked.
    ipc.prefer({ adultTitles: false });
    ipc.hold("ondemand.status").resolve(status());
    for (let asked = 0; asked < 3; asked++) ipc.hold("watchlist.list").resolve(page([harbour]));
    await act(async () =>
      stored.resolve(ipc.snapshot({ ...defaultPreferences, adultTitles: false })),
    );
    await settle();

    expect(document.body.textContent).not.toContain("After Dark");
    expect(document.body.textContent).toContain("Night Harbour");
    expect(sheet()).toBeNull();
    // Nothing took it off the watchlist: it shows again once Settings shows such titles.
    expect(ipc.methods()).not.toContain("watchlist.remove");
    useUi.setState(useUi.getInitialState(), true);
  });
});
