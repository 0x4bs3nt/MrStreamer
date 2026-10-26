import { createRoot, document, type Root } from "./dom.ts";
import * as React from "react";
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { indexCatalogue, kindOf, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue, ProviderTitle } from "@mrstreamer/core/provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../src/account.ts";
import type { TitleLists } from "../src/titles.ts";

// The whole watchlist, pushed on Home: every saved movie and series as a row, newest first or by
// name, a listed one opening its details, one the lists don't have saying why, and Remove taking
// out the entry as it stands. The real screen runs with React DOM on a happy-dom window over the
// real watchlist owner, whose file is written to the files stand-in (native-files.ts). The lists
// are indexed by core as the app's are; how each provider's lists stand is set by each test.

/** A system sheet that showed: its options, and what choosing one does. */
interface Sheet {
  readonly title: string | undefined;
  readonly options: readonly string[];
  choose(label: string): void;
}

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  lists: { kind: "loading" } as TitleLists,
  /** Whether every provider's lists that show are indexed. */
  complete: true,
  /** The disk refuses to write the watchlist's file. */
  refuse: false,
  sheets: [] as Sheet[],
  alerts: [] as {
    title: string;
    message: string;
    buttons: { text: string; onPress?: () => void }[];
  }[],
  did: [] as string[],
}));

vi.mock("react-native", async () => ({
  ...(await import("./react-native.ts")).reactNative,
  ActionSheetIOS: {
    showActionSheetWithOptions: (
      { title, options }: { title?: string; options: string[] },
      callback: (index: number) => void,
    ) =>
      scenario.sheets.push({
        title,
        options,
        choose: (label) => React.act(() => callback(options.indexOf(label))),
      }),
  },
  Alert: {
    alert: (title: string, message: string, buttons: { text: string; onPress?: () => void }[]) =>
      scenario.alerts.push({ title, message, buttons }),
  },
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("../src/files.ts", async (original) => {
  const files = await original<typeof import("../src/files.ts")>();
  return {
    ...files,
    writeJson: (name: string, value: unknown) => {
      if (scenario.refuse) throw new Error("The disk is full");
      files.writeJson(name, value);
    },
  };
});
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
}));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  titleLists: () => scenario.lists,
  useMetadataVersion: () => 0,
  titlesWorkedOut: () => scenario.complete,
  named: (title: Title) => title,
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: (title: Title) =>
    scenario.did.push(`details ${title.kind} ${title.subscriptionId}:${title.id}`),
}));
vi.mock("../src/titles-ui.tsx", () => ({ Artwork: () => null }));
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: { text: "#FFFFFF", dim: "#A1A1A6", fill: "#1C1C1E", line: "#2C2C2E" },
    Notice: ({ failure }: { failure: { headline: string; advice: string } }) =>
      createElement("p", null, `${failure.headline} ${failure.advice}`),
  };
});

const watchlist = await import("../src/watchlist.ts");
const { WatchlistScreen } = await import("../src/watchlist-screen.tsx");
const { readJson } = await import("../src/files.ts");

/** A provider's movie, added `days` ago. */
const movie = (
  id: string,
  name: string,
  tmdbId: string | null = null,
  days = 0,
): ProviderTitle => ({
  id,
  name,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: Date.UTC(2026, 9, 1) - days * 86_400_000,
  releaseDate: "2021-09-15",
  categoryIds: [],
  adult: false,
  container: "mp4",
  tmdbId,
});
const lists = (movies: readonly ProviderTitle[]): OnDemandCatalogue => ({
  movieCategories: [],
  movies,
  seriesCategories: [],
  series: [],
});

type Standing = Member["titles"];
const ready = (value: OnDemandCatalogue): Standing =>
  ({ kind: "ready", value, from: "provider", fetchedAt: 0, took: 1 }) as Standing;
const failure = { kind: "unexpected", detail: "" } as const;

const member = (id: string, titles: Standing, needsSecret = false): Member =>
  ({
    entry: { id },
    label: id,
    account: null,
    needsSecret,
    live: { kind: "idle" },
    titles,
  }) as Member;

/** The providers as they stand, their lists that show indexed together as the app does. */
function providers(...each: { id: string; titles: Standing }[]) {
  scenario.members = each.map(({ id, titles }) => member(id, titles));
  const listed = each.flatMap(({ id, titles }) => {
    const catalogue =
      titles.kind === "ready" ? titles.value : "last" in titles ? titles.last : null;
    return catalogue ? [{ subscriptionId: id, catalogue }] : [];
  });
  const index = indexCatalogue(listed, "en");
  scenario.lists = listed.length > 0 ? { kind: "ready", index } : { kind: "loading" };
  React.act(() => watchlist.setWatchlistOwners(each.map(({ id }) => id)));
  rerender();
  return index;
}

/** The title the lists give `name`. */
function titled(index: IndexedCatalogue, name: string, kind: TitleKind = "movie"): Title {
  const found = kindOf(index, kind).titles.find((title) => title.title === name);
  if (!found) throw new Error(`No ${name} in the lists`);
  return found;
}
const save = (title: Title) => React.act(() => watchlist.saveTitle(title));

let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function open() {
  container = document.createElement("div");
  root = createRoot(container);
  React.act(() => root!.render(React.createElement(WatchlistScreen)));
}
const rerender = () => root && React.act(() => root!.render(React.createElement(WatchlistScreen)));
/** The rows as VoiceOver reads them, in order. */
const rows = () =>
  [...container.querySelectorAll("button[aria-label]")]
    .map((row) => row.getAttribute("aria-label")!)
    .filter((label) => !label.startsWith("Sort, "));
function press(testID: string) {
  const button = container.querySelector(`[data-testid="${testID}"]`) as {
    click(): void;
  } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
}
/** The test id of the row named `name`, or of the one `at` that place among those so named. */
function rowOf(name: string, at = 0) {
  const row = [...container.querySelectorAll('[data-testid^="watchlist-"]')]
    .filter((each) => each.getAttribute("aria-label")?.startsWith(`${name},`))
    .at(at);
  if (!row) throw new Error(`No row for ${name}`);
  return row.getAttribute("data-testid")!;
}
const lastSheet = () => scenario.sheets.at(-1)!;
const savedOwners = () =>
  watchlist.currentWatchlist().map((entry) => entry.map((each) => each.subscriptionId));

beforeEach(() => {
  Object.assign(scenario, { refuse: false, complete: true, sheets: [], alerts: [], did: [] });
  // Every save of the test before goes, the providers' kept ones too.
  for (const id of ["a", "b", "c"]) watchlist.eraseWatchlist(id);
});
afterEach(() => {
  if (root) React.act(() => root!.unmount());
  root = null;
});

describe("the whole watchlist", () => {
  it.each([false, true])(
    "keeps a recognised saved entry hidden before indexing, storage refusal: %s",
    async (refused) => {
      const index = providers({
        id: "a",
        titles: ready(lists([movie("7", "Dune"), movie("8", "Arrival")])),
      });
      save(titled(index, "Dune"));
      save(titled(index, "Arrival"));
      open();
      const classified = lists([{ ...movie("7", "Dune"), adult: true }, movie("8", "Arrival")]);
      scenario.complete = false;
      scenario.members = [member("a", ready(classified))];
      scenario.lists = { kind: "loading" };
      scenario.refuse = refused;
      React.act(() =>
        watchlist.alignWatchlist(null, [{ subscriptionId: "a", catalogue: classified }]),
      );
      // The next raw catalogue arrives without the title before any index is published.
      providers({ id: "a", titles: ready(lists([movie("8", "Arrival")])) });
      expect(rows().some((row) => row.startsWith("Dune,"))).toBe(false);
      expect(rows()).toEqual(["Arrival, Movie · 2021"]);
      scenario.refuse = false;
      React.act(() =>
        watchlist.alignWatchlist(null, [
          { subscriptionId: "a", catalogue: lists([movie("8", "Arrival")]) },
        ]),
      );
      const restoredModule = "../src/watchlist.ts?restored-policy";
      const restored: typeof watchlist = await import(restoredModule);
      restored.setWatchlistOwners(["a"]);
      const shown = restored.watchlistRows(
        restored.currentWatchlist(),
        { index: null, complete: false, members: scenario.members, named: (title) => title },
        "newest",
      );
      expect(shown.map((row) => row.name)).toEqual(["Arrival"]);
    },
  );

  it("lists every saved title, newest first or by name, and keeps the order chosen", () => {
    const names = [
      "Film 10",
      "alpha",
      "Film 2",
      "Beta",
      ...Array.from({ length: 26 }, (_, at) => `Saga ${at + 1}`),
    ];
    const index = providers({
      id: "a",
      titles: ready(lists(names.map((name, at) => movie(`m${at}`, name)))),
    });
    for (const name of names) save(titled(index, name));
    open();
    expect(rows()).toHaveLength(30);
    expect(rows()[0]).toBe("Saga 26, Movie · 2021");
    expect(rows().at(-1)).toBe("Film 10, Movie · 2021");

    press("watchlist-sort");
    expect(lastSheet().options).toEqual(["Newest", "A–Z", "Cancel"]);
    lastSheet().choose("A–Z");
    expect(rows().slice(0, 5)).toEqual([
      "alpha, Movie · 2021",
      "Beta, Movie · 2021",
      "Film 2, Movie · 2021",
      "Film 10, Movie · 2021",
      "Saga 1, Movie · 2021",
    ]);
    expect(rows().at(-1)).toBe("Saga 26, Movie · 2021");
    // Opened again, it keeps the order chosen.
    React.act(() => root!.unmount());
    open();
    expect(rows()[0]).toBe("alpha, Movie · 2021");
    press("watchlist-sort");
    lastSheet().choose("Newest");
    expect(rows()[0]).toBe("Saga 26, Movie · 2021");
  });

  it("opens a listed title's details; its button offers Details and Remove instead", () => {
    const index = providers({ id: "a", titles: ready(lists([movie("7", "Dune", "100")])) });
    save(titled(index, "Dune"));
    open();
    press(rowOf("Dune"));
    expect(scenario.did).toEqual(["details movie a:7"]);
    press(`${rowOf("Dune")}-more`);
    // The button opens its sheet, not the details.
    expect(scenario.did).toEqual(["details movie a:7"]);
    expect(lastSheet()).toMatchObject({
      title: "Dune",
      options: ["Details", "Remove from Watchlist", "Cancel"],
    });
    lastSheet().choose("Cancel");
    expect(rows()).toEqual(["Dune, Movie · 2021"]);
    lastSheet().choose("Details");
    expect(scenario.did).toEqual(["details movie a:7", "details movie a:7"]);
  });

  it("says why a saved title isn't listed, and no longer listed only once its provider answered", () => {
    const dune = lists([movie("7", "Dune")]);
    const index = providers({ id: "a", titles: ready(dune) });
    save(titled(index, "Dune"));
    open();
    const without = lists([movie("8", "Arrival")]);
    const states: [Standing, boolean, string][] = [
      [{ kind: "loading", last: null }, true, "Lists still loading"],
      [
        { kind: "failed", error: failure, last: null, since: 0 } as Standing,
        true,
        "Lists didn't load",
      ],
      // Lists that came but aren't indexed yet may still hold it.
      [ready(without), false, "Lists still loading"],
      [ready(without), true, "No longer listed"],
    ];
    for (const [titles, complete, said] of states) {
      scenario.complete = complete;
      providers({ id: "a", titles });
      expect(rows()).toEqual([`Dune, Movie · 2021, ${said}`]);
    }
    scenario.members = [member("a", ready(without), true)];
    rerender();
    expect(rows()).toEqual(["Dune, Movie · 2021, Password needed in Settings"]);

    // Opens nothing; its sheet offers only Remove.
    press(rowOf("Dune"));
    expect(scenario.did).toEqual([]);
    press(`${rowOf("Dune")}-more`);
    expect(lastSheet().options).toEqual(["Remove from Watchlist", "Cancel"]);

    // Lists that failed to come again but still show it keep it listed.
    providers({
      id: "a",
      titles: { kind: "failed", error: failure, last: dune, since: 0 } as Standing,
    });
    expect(rows()).toEqual(["Dune, Movie · 2021"]);
    press(rowOf("Dune"));
    expect(scenario.did).toEqual(["details movie a:7"]);
  });

  it("shows nothing saved, and lets every title the lists lack be removed", () => {
    const index = providers({
      id: "a",
      titles: ready(lists([movie("7", "Dune"), movie("8", "Arrival")])),
    });
    open();
    expect(container.textContent).toContain("Nothing saved yet.");
    expect(container.querySelector('[data-testid="watchlist-sort"]')).toBeNull();
    save(titled(index, "Dune"));
    save(titled(index, "Arrival"));
    providers({ id: "a", titles: ready(lists([movie("9", "Heat")])) });
    expect(rows()).toEqual([
      "Arrival, Movie · 2021, No longer listed",
      "Dune, Movie · 2021, No longer listed",
    ]);
    for (const name of ["Arrival", "Dune"]) {
      press(`${rowOf(name)}-more`);
      lastSheet().choose("Remove from Watchlist");
    }
    expect(rows()).toEqual([]);
    expect(container.textContent).toContain("Nothing saved yet.");
  });

  it("is one entry for a film two providers list under one TMDB id, opened while either has it, removed for both", () => {
    const both = providers(
      { id: "a", titles: ready(lists([movie("7", "Dune", "100")])) },
      { id: "b", titles: ready(lists([movie("70", "Dune", "100"), movie("71", "Dune", null, 1)])) },
    );
    save(kindOf(both, "movie").titles.find((title) => title.tmdbId === "100")!);
    open();
    // The film without a TMDB id named the same is another title, not saved.
    expect(rows()).toEqual(["Dune, Movie · 2021"]);
    expect(savedOwners()).toEqual([["a", "b"]]);

    // The first no longer lists it; the second does, and it opens there.
    providers(
      { id: "a", titles: ready(lists([])) },
      { id: "b", titles: ready(lists([movie("70", "Dune", "100")])) },
    );
    press(rowOf("Dune"));
    expect(scenario.did).toEqual(["details movie b:70"]);

    press(`${rowOf("Dune")}-more`);
    lastSheet().choose("Remove from Watchlist");
    expect(rows()).toEqual([]);
    expect(readJson("watchlists.json")).toEqual({ version: 1, accounts: { a: [], b: [] } });
  });

  it("removes, from a sheet left open, only the entry as it stands then", () => {
    const index = providers({
      id: "a",
      titles: ready(lists([movie("7", "Dune"), movie("8", "Arrival")])),
    });
    save(titled(index, "Dune"));
    open();
    press(`${rowOf("Dune")}-more`);
    const stale = lastSheet();
    // Meanwhile Dune is removed and saved again, and Arrival saved.
    React.act(() => watchlist.removeTitle(titled(index, "Dune")));
    save(titled(index, "Dune"));
    save(titled(index, "Arrival"));
    stale.choose("Remove from Watchlist");
    expect(rows()).toEqual(["Arrival, Movie · 2021", "Dune, Movie · 2021"]);

    // A sheet of the entry as it stands removes it, and nothing else.
    press(`${rowOf("Dune")}-more`);
    lastSheet().choose("Remove from Watchlist");
    expect(rows()).toEqual(["Arrival, Movie · 2021"]);
  });

  it("keeps the entry and says so when the file won't take its removal", () => {
    const index = providers({
      id: "a",
      titles: ready(lists([movie("7", "Dune"), movie("8", "Arrival")])),
    });
    save(titled(index, "Dune"));
    save(titled(index, "Arrival"));
    open();
    const before = readJson("watchlists.json");
    scenario.refuse = true;
    press(`${rowOf("Dune")}-more`);
    lastSheet().choose("Remove from Watchlist");
    expect(rows()).toEqual(["Arrival, Movie · 2021", "Dune, Movie · 2021"]);
    expect(readJson("watchlists.json")).toEqual(before);
    const [alert] = scenario.alerts;
    expect(alert?.title).toBe("Couldn't remove Dune");
    expect(alert?.buttons.map((button) => button.text)).toEqual(["Cancel", "Try again"]);

    scenario.refuse = false;
    React.act(() => alert?.buttons[1]?.onPress?.());
    expect(rows()).toEqual(["Arrival, Movie · 2021"]);
  });

  it("never lets a sheet left open on a removed title remove one saved in the same millisecond", () => {
    const index = providers({
      id: "a",
      titles: ready(lists([movie("7", "Dune"), movie("8", "Arrival")])),
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2027, 0, 15));
    try {
      save(titled(index, "Dune"));
      open();
      press(`${rowOf("Dune")}-more`);
      const stale = lastSheet();
      React.act(() => watchlist.removeTitle(titled(index, "Dune")));
      // The clock hasn't moved: Arrival is saved at the very same millisecond.
      save(titled(index, "Arrival"));
      stale.choose("Remove from Watchlist");
      expect(rows()).toEqual(["Arrival, Movie · 2021"]);
      expect(savedOwners()).toEqual([["a"]]);
    } finally {
      clock.mockRestore();
    }
  });

  it("waits for another provider only for a title the lists know by its TMDB id", () => {
    const index = providers(
      { id: "a", titles: ready(lists([movie("7", "Dune", "100"), movie("8", "Heat")])) },
      { id: "b", titles: ready(lists([])) },
    );
    save(titled(index, "Dune"));
    save(titled(index, "Heat"));
    open();
    // The first's lists come again without either; the second's failed, and may list Dune.
    const failed = { kind: "failed", error: failure, last: null, since: 0 } as Standing;
    providers({ id: "a", titles: ready(lists([])) }, { id: "b", titles: failed });
    expect(rows()).toEqual([
      "Heat, Movie · 2021, No longer listed",
      "Dune, Movie · 2021, Lists didn't load",
    ]);
    providers({ id: "a", titles: ready(lists([])) }, { id: "b", titles: ready(lists([])) });
    expect(rows()).toEqual([
      "Heat, Movie · 2021, No longer listed",
      "Dune, Movie · 2021, No longer listed",
    ]);
  });

  it("removes, from a sheet left open, the entry its record joined since, and nothing for one dropped", () => {
    // The first lists Dune without a TMDB id, and Dune again; the second lists Dune by its id.
    const before = providers(
      { id: "a", titles: ready(lists([movie("7", "Dune"), movie("8", "Dune again")])) },
      { id: "b", titles: ready(lists([movie("70", "Dune", "100")])) },
    );
    save(titled(before, "Dune"));
    save(titled(before, "Dune again"));
    save(kindOf(before, "movie").titles.find((title) => title.tmdbId === "100")!);
    open();
    expect(savedOwners()).toEqual([["b"], ["a"], ["a"]]);
    press(`${rowOf("Dune again")}-more`);
    const dropped = lastSheet();
    // The first's own Dune, saved first, is the last row of that name.
    press(`${rowOf("Dune", -1)}-more`);
    const joined = lastSheet();

    // The first now lists both under TMDB's id: its two saves are one, joined with the second's.
    const after = providers(
      {
        id: "a",
        titles: ready(lists([movie("7", "Dune", "100"), movie("8", "Dune", "100")])),
      },
      { id: "b", titles: ready(lists([movie("70", "Dune", "100")])) },
    );
    React.act(() => watchlist.alignWatchlist(after));
    expect(savedOwners()).toEqual([["a", "b"]]);

    dropped.choose("Remove from Watchlist");
    expect(savedOwners()).toEqual([["a", "b"]]);
    joined.choose("Remove from Watchlist");
    expect(savedOwners()).toEqual([]);
    expect(rows()).toEqual([]);
  });
});

describe("a provider whose password the Keychain lost", () => {
  /**
   * The providers stand as `standing`, whose ids lost their password, while the lists that show
   * stay as they were: a list already in when the Keychain no longer gave the password back
   * stays, as account.ts leaves it (`recoverLogin`, `restore`).
   */
  function lost(ids: readonly string[]) {
    scenario.members = scenario.members.map((each) =>
      member(each.entry.id, each.titles, ids.includes(each.entry.id)),
    );
    rerender();
  }

  it("shows what was saved and that a password is needed, opens nothing, and still removes", () => {
    const index = providers({ id: "a", titles: ready(lists([movie("7", "Dune", "100")])) });
    save(titled(index, "Dune"));
    open();
    press(`${rowOf("Dune")}-more`);
    const held = lastSheet();
    lost(["a"]);
    expect(rows()).toEqual(["Dune, Movie · 2021, Password needed in Settings"]);
    press(rowOf("Dune"));
    // Details left open in a sheet from before open nothing either.
    held.choose("Details");
    expect(scenario.did).toEqual([]);
    press(`${rowOf("Dune")}-more`);
    expect(lastSheet().options).toEqual(["Remove from Watchlist", "Cancel"]);
    lastSheet().choose("Remove from Watchlist");
    expect(rows()).toEqual([]);
    expect(readJson("watchlists.json")).toEqual({ version: 1, accounts: { a: [] } });
  });

  it("opens a title another provider lists too through that one, and removes only its entry", () => {
    const index = providers(
      { id: "a", titles: ready(lists([movie("7", "Dune", "100")])) },
      { id: "b", titles: ready(lists([movie("70", "Dune", "100"), movie("9", "Heat")])) },
    );
    save(kindOf(index, "movie").titles.find((title) => title.tmdbId === "100")!);
    save(titled(index, "Heat"));
    open();
    press(rowOf("Dune"));
    expect(scenario.did).toEqual(["details movie a:7"]);
    lost(["a"]);
    expect(rows()).toEqual(["Heat, Movie · 2021", "Dune, Movie · 2021"]);
    press(rowOf("Dune"));
    press(`${rowOf("Dune")}-more`);
    lastSheet().choose("Details");
    expect(scenario.did).toEqual(["details movie a:7", "details movie b:70", "details movie b:70"]);

    press(`${rowOf("Dune")}-more`);
    lastSheet().choose("Remove from Watchlist");
    expect(rows()).toEqual(["Heat, Movie · 2021"]);
    expect(savedOwners()).toEqual([["b"]]);
  });

  it("keeps a title listed from lists that failed to come again while the login holds", () => {
    const dune = lists([movie("7", "Dune")]);
    const index = providers({ id: "a", titles: ready(dune) });
    save(titled(index, "Dune"));
    open();
    providers({
      id: "a",
      titles: { kind: "failed", error: failure, last: dune, since: 0 } as Standing,
    });
    expect(rows()).toEqual(["Dune, Movie · 2021"]);
    press(rowOf("Dune"));
    expect(scenario.did).toEqual(["details movie a:7"]);
  });
});

describe("the watchlist's file", () => {
  it("brings back every entry at the next launch, the kept ones of a removed provider too", async () => {
    const index = providers(
      { id: "a", titles: ready(lists([movie("7", "Dune", "100")])) },
      { id: "b", titles: ready(lists([movie("70", "Dune", "100"), movie("9", "Heat")])) },
    );
    save(titled(index, "Dune"));
    save(titled(index, "Heat"));
    // The second is removed with its history kept.
    React.act(() => watchlist.setWatchlistOwners(["a"]));
    expect(savedOwners()).toEqual([["a"]]);

    vi.resetModules();
    const launched = await import("../src/watchlist.ts");
    launched.setWatchlistOwners(["a", "b"]);
    expect(
      launched.currentWatchlist().map((entry) => entry.map((each) => each.subscriptionId)),
    ).toEqual([["b"], ["a", "b"]]);
  });
});
