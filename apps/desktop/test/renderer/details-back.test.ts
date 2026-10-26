// @vitest-environment happy-dom
// Back over a title's details: a related title opens over them, and Back in the sheet's top bar
// returns through those it was opened from as they stood, the season picked, the scroll and the
// keyboard on the related title opened, then to the page and what had the keyboard there. Close,
// Escape and a title opened anew start over. A playing title and Settings over the details keep
// the way back. What a removed subscription, hidden titles for adults or a new account take away,
// Back no longer reaches, nor a title the lists have since marked for adults while Settings hides
// them, and it reaches back eight details at most. Back to the same title's earlier visit
// restores it at once, and only then. Search opened over the details, by pointer or shortcut,
// gives the keyboard back to them. A Back still waiting for the lists gives way to whatever the
// viewer does meanwhile: Settings, a title played, Search, another Back, Close or another title,
// opened and left again too, and the way back stays as it was.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  Episode,
  MovieDetails,
  OnDemandStatus,
  SeriesDetails,
  Title,
} from "@mrstreamer/contracts/ondemand";
import type { OwnedId, SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { syncOnDemand } from "../../src/renderer/src/lib/queries.ts";
import { App } from "../../src/renderer/src/app/App.tsx";
import {
  backDetails,
  closeTitleSheets,
  DETAILS_TRAIL,
  leaveSubscription,
  openDetails,
  openRelated,
  openView,
  resetForAccount,
  useUi,
  type DetailsTarget,
} from "../../src/renderer/src/app/ui-store.ts";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";

/** A second subscription beside the tests' own, as the main process lists it. */
const OTHER = "9d2b7c41-6e0a-4f3b-8a15-c4e7f1d09b62";
const BOTH: readonly SubscriptionSummary[] = [
  { ...SAVED, name: "Nova TV" },
  { ...SAVED, id: OTHER, name: "Skyline", server: "https://skyline.example.tv" },
];

const listed = (kind: Title["kind"], subscriptionId: string, id: string, name: string): Title => ({
  kind,
  key: `${kind}:${id}`,
  subscriptionId,
  id,
  name: `${name} (EN)`,
  title: name,
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: null,
  genres: ["Drama"],
  versions: [{ subscriptionId, id, tags: ["EN"] }],
});

// A film of the tests' subscription leads to a series of the other, which leads to a film of the
// first again. The app relates a movie only to movies and a series to series; the stand-in
// answers below mix them so one chain passes through a series' seasons.
const harbour = {
  ...listed("movie", SUBSCRIPTION, "a", "Night Harbour"),
  backdropUrl: "https://image.example/harbour.jpg",
};
const canyon = listed("series", OTHER, "b", "Canyon Hours");
// Two versions, so its details offer the menu of them beside Play.
const meridian = {
  ...listed("movie", SUBSCRIPTION, "c", "Meridian Dawn"),
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "c", tags: ["EN"] },
    { subscriptionId: SUBSCRIPTION, id: "c2", tags: ["NL"] },
  ],
};
const field = listed("movie", OTHER, "d", "Quiet Field");
const titles = new Map<string, Title>([
  ...[harbour, canyon, meridian, field].map((title) => [title.id, title] as const),
  ["c2", meridian],
]);

const episode = (season: number, number: number): Episode => ({
  subscriptionId: OTHER,
  id: `b${season}${number}`,
  seriesId: "b",
  season,
  number,
  title: `Chapter ${season}.${number}`,
  plot: null,
  duration: 2700,
  stillUrl: null,
  airDate: null,
});

const base = {
  originalTitle: null,
  plot: null,
  genres: ["Drama"],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
};

function detailsOf(id: string): MovieDetails | SeriesDetails {
  const title = titles.get(id)!;
  if (title.kind === "movie") return { ...base, kind: "movie", title };
  return {
    ...base,
    kind: "series",
    title,
    seasons: [1, 2].map((number) => ({
      number,
      name: `Season ${number}`,
      posterUrl: null,
      episodes: [episode(number, 1), episode(number, 2)],
    })),
  };
}

/** What each title's related row shows, by the version opened. */
let related: Record<string, readonly Title[]> = {};
/** The versions the lists now mark for adults, as after a provider's update. */
let forAdults = new Set<string>();

const status: OnDemandStatus = {
  lists: [SUBSCRIPTION, OTHER].map((subscriptionId) => ({
    subscriptionId,
    movies: 3,
    series: 1,
    fetchedAt: 1,
    failure: null,
  })),
  metadata: null,
};

/** Lets the window take in what just happened, on the fake clock. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const sheet = () => document.body.querySelector<HTMLElement>('[role="dialog"]');
/** The details' name, as the sheet is called. */
const shown = () => {
  const named = sheet()?.getAttribute("aria-labelledby");
  return named ? (document.getElementById(named)?.textContent ?? null) : null;
};
const relatedTile = (name: string) =>
  [
    ...(sheet()?.querySelectorAll<HTMLButtonElement>(
      '[aria-label="Also in your subscriptions"] button',
    ) ?? []),
  ].find((tile) => tile.textContent?.includes(name));
const inSheet = (label: string) =>
  [...(sheet()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (each) => each.textContent?.trim() === label || each.getAttribute("aria-label") === label,
  );
/** Back in the top bar the sheet keeps above its backdrop. */
const back = () =>
  [...(sheet()?.querySelectorAll<HTMLButtonElement>("header button") ?? [])].find(
    (each) => each.textContent?.trim() === "Back",
  );
/** The part of the sheet that scrolls. */
const scroller = () => sheet()?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
const press = async (button: HTMLButtonElement | undefined) => {
  if (!button) throw new Error("No such button.");
  await act(async () => button.click());
  await settle();
};
const key = (name: string, modifiers: KeyboardEventInit = {}) =>
  act(async () => {
    (document.activeElement ?? window).dispatchEvent(
      new KeyboardEvent("keydown", { key: name, bubbles: true, ...modifiers }),
    );
  });

/** Waits on the fake clock for the details of `name` with their related titles. */
async function showing(name: string) {
  await vi.waitFor(
    async () => {
      await settle();
      expect(shown()).toBe(name);
      expect(sheet()?.textContent).not.toContain("Loading related titles…");
    },
    { interval: 1 },
  );
}

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  related = { a: [canyon, field], b: [meridian, harbour], c: [field], d: [] };
  forAdults = new Set();
  ipc.always("subscription.list", BOTH);
  ipc.always("liveBrowse.get", { kind: "all" });
  ipc.always("ondemand.status", status);
  ipc.answer("ondemand.titles", ({ versions }) =>
    versions.flatMap((version) => {
      const title = titles.get(version.id);
      if (!title) return [];
      return forAdults.has(version.id) ? [{ ...title, adult: true }] : [title];
    }),
  );
  ipc.answer("ondemand.details", ({ version }) => detailsOf(version.id));
  ipc.answer("ondemand.related", ({ version }) => ({
    basis: "Drama",
    titles: (related[version.id] ?? []).map((title) => ({ title, reason: "Drama" })),
  }));
  ipc.always("viewing.progress", []);
  ipc.always("watchlist.saved", null);
  // Movies leads with Night Harbour, the most popular film.
  ipc.answer("ondemand.rows", ({ kind }) =>
    kind === "movie" ? [{ id: "popular", name: "Popular", total: 1, titles: [harbour] }] : [],
  );
  useUi.setState(useUi.getInitialState(), true);
});
afterEach(() => {
  unmount();
  useUi.setState(useUi.getInitialState(), true);
  vi.useRealTimers();
});

/** The window on Movies with both subscriptions, as the app draws it, and its query client. */
async function window_(): Promise<QueryClient> {
  useUi.setState({ view: "movies" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stopLists = syncOnDemand(client);
  const mounted = queryView(client);
  await mounted.render(createElement(TooltipProvider, null, createElement(App)));
  unmount = () => {
    stopLists();
    mounted.unmount();
  };
  await vi.waitFor(
    async () => {
      await settle();
      expect(document.querySelector("header")).not.toBeNull();
    },
    { interval: 1 },
  );
  return client;
}

/** The page's own control labelled `label`, once it shows. */
async function onPage(label: string): Promise<HTMLButtonElement> {
  let control: HTMLButtonElement | undefined;
  await vi.waitFor(
    async () => {
      await settle();
      control = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (each) => each.textContent?.trim() === label && !each.closest('[role="dialog"]'),
      );
      expect(control).toBeDefined();
    },
    { interval: 1 },
  );
  return control!;
}

/**
 * Opens Night Harbour from the keyboard on Movies' Details, then its related Canyon Hours, on
 * Season 2 and scrolled, then Meridian Dawn: the control the keyboard was on.
 */
async function threeDeep(): Promise<HTMLButtonElement> {
  await window_();
  const opener = await onPage("Details");
  opener.focus();
  await press(opener);
  await showing("Night Harbour");
  await press(relatedTile("Canyon Hours"));
  await showing("Canyon Hours");
  await press(inSheet("Season 2"));
  scroller()!.scrollTop = 240;
  await press(relatedTile("Meridian Dawn"));
  await showing("Meridian Dawn");
  return opener;
}

const ownedOf = (title: Title): OwnedId => ({ subscriptionId: title.subscriptionId, id: title.id });

describe("Back over details", () => {
  it("returns through each related title's details as they stood, then to the page", async () => {
    const opener = await threeDeep();

    await press(back());
    await showing("Canyon Hours");
    // The season picked and the scroll stand, and the keyboard is on the title opened from here.
    expect(inSheet("Season 2")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(240);
    expect(document.activeElement).toBe(relatedTile("Meridian Dawn"));

    await press(back());
    await showing("Night Harbour");
    expect(document.activeElement).toBe(relatedTile("Canyon Hours"));

    await press(back());
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("closes to the page with Close or Escape, and a title opened again starts over", async () => {
    const opener = await threeDeep();
    await press(inSheet("Close"));
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);

    await act(async () => openDetails({ kind: "movie", ...ownedOf(meridian) }));
    await showing("Meridian Dawn");
    await press(back());
    expect(sheet()).toBeNull();

    await act(async () => openDetails({ kind: "movie", ...ownedOf(harbour) }));
    await showing("Night Harbour");
    await press(relatedTile("Canyon Hours"));
    await showing("Canyon Hours");
    await key("Escape");
    await settle();
    expect(sheet()).toBeNull();
  });

  it("returns the keyboard to the page's control after a menu opened and closed in the details", async () => {
    const opener = await threeDeep();
    const versions = inSheet("Versions")!;
    versions.focus();
    await press(versions);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await key("Escape");
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(shown()).toBe("Meridian Dawn");

    await press(inSheet("Close"));
    expect(sheet()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("keeps the way back through a title played and Settings, and the title adds no step", async () => {
    await threeDeep();
    ipc.hold("playback.openTitle");
    await press(inSheet("Play"));
    expect(document.querySelector("[data-view=title]")).not.toBeNull();
    expect(sheet()).toBeNull();
    await press(
      [...document.querySelectorAll<HTMLButtonElement>("[data-view=title] header button")].find(
        (each) => each.textContent?.trim() === "Back",
      ),
    );
    await showing("Meridian Dawn");

    await key(",", { ctrlKey: true, metaKey: true });
    await settle();
    expect(useUi.getState().settings).toBe("general");
    expect(sheet()).toBeNull();
    await press(
      [
        ...document.querySelectorAll<HTMLButtonElement>('[data-view="settings"] header button'),
      ].find((each) => each.textContent?.trim() === "Back"),
    );
    await showing("Meridian Dawn");

    await press(back());
    await showing("Canyon Hours");
    await press(back());
    await showing("Night Harbour");
    await press(back());
    expect(sheet()).toBeNull();
  });

  it("gives the keyboard to the sheet when the title opened from it is no longer related", async () => {
    await threeDeep();
    // Long enough away for what Canyon Hours showed to be forgotten, and its related titles change.
    related = { ...related, b: [harbour] };
    await act(() => vi.advanceTimersByTimeAsync(6 * 60_000));
    await press(back());
    await showing("Canyon Hours");
    expect(relatedTile("Meridian Dawn")).toBeUndefined();
    expect(inSheet("Season 2")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(240);
    expect(document.activeElement).toBe(sheet());
  });
});

describe("Back after the lists or the sheet changed", () => {
  it("passes over a title the lists now mark for adults while they are hidden, never showing it", async () => {
    await threeDeep();
    // The provider now marks Canyon Hours for adults: the lists say so, and related rows leave it out.
    forAdults.add("b");
    related = { ...related, a: [field] };
    const shown: (string | null)[] = [];
    onTestFinished(useUi.subscribe((state) => shown.push(state.details?.id ?? null)));
    await press(back());
    await showing("Night Harbour");
    expect(shown).not.toContain("b");
    expect(document.body.textContent).not.toContain("Canyon Hours");
    await press(back());
    expect(sheet()).toBeNull();
  });

  it("returns to a title the lists now mark for adults while Settings shows them", async () => {
    ipc.prefer({ adultTitles: true });
    await threeDeep();
    forAdults.add("b");
    await press(back());
    await showing("Canyon Hours");
  });

  it("restores an earlier visit of the same title at once, and nothing restores it again later", async () => {
    related = { ...related, c: [field, canyon] };
    const client = await window_();
    await act(async () => openDetails({ kind: "series", ...ownedOf(canyon) }));
    await showing("Canyon Hours");
    await press(inSheet("Season 2"));
    scroller()!.scrollTop = 240;
    await press(relatedTile("Meridian Dawn"));
    await showing("Meridian Dawn");
    await press(relatedTile("Canyon Hours"));
    await showing("Canyon Hours");
    expect(inSheet("Season 1")?.getAttribute("aria-pressed")).toBe("true");
    scroller()!.scrollTop = 40;
    // The tests' own subscription goes, Meridian Dawn with it, as Settings removes one: the way
    // back keeps the earlier Canyon Hours alone, and everything is read again, so its related
    // titles no longer have Meridian Dawn.
    related = { ...related, b: [] };
    await act(async () => {
      leaveSubscription(SUBSCRIPTION);
      void client.invalidateQueries();
    });
    await vi.waitFor(
      async () => {
        await settle();
        expect(relatedTile("Meridian Dawn")).toBeUndefined();
      },
      { interval: 1 },
    );
    await showing("Canyon Hours");

    await press(back());
    await showing("Canyon Hours");
    expect(inSheet("Season 2")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(240);
    expect(document.activeElement).toBe(sheet());

    // A title played from it, then Settings: each time the sheet opens afresh, as before.
    ipc.hold("playback.openTitle");
    await press(
      [...(sheet()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((each) =>
        /^Play S1/.test(each.textContent?.trim() ?? ""),
      ),
    );
    expect(document.querySelector("[data-view=title]")).not.toBeNull();
    await press(
      [...document.querySelectorAll<HTMLButtonElement>("[data-view=title] header button")].find(
        (each) => each.textContent?.trim() === "Back",
      ),
    );
    await showing("Canyon Hours");
    expect(inSheet("Season 1")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(0);
    await key(",", { ctrlKey: true, metaKey: true });
    await settle();
    await press(
      [
        ...document.querySelectorAll<HTMLButtonElement>('[data-view="settings"] header button'),
      ].find((each) => each.textContent?.trim() === "Back"),
    );
    await showing("Canyon Hours");
    expect(inSheet("Season 1")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(0);
  });

  it("gives the keyboard back to the details after Search from their bar or its shortcut", async () => {
    await threeDeep();
    inSheet("Play")!.focus();
    await press(sheet()!.querySelector<HTMLButtonElement>('header button[aria-label="Search"]')!);
    expect(useUi.getState().searchOpen).toBe(true);
    await key("Escape");
    await settle();
    expect(useUi.getState().searchOpen).toBe(false);
    expect(document.activeElement).toBe(inSheet("Play"));

    await key("k", { ctrlKey: true, metaKey: true });
    await settle();
    expect(useUi.getState().searchOpen).toBe(true);
    await key("Escape");
    await settle();
    expect(document.activeElement).toBe(inSheet("Play"));
  });
});

describe("a Back still waiting for the lists", () => {
  /** Holds the lists' answer about Canyon Hours, which Back asks for, until the test gives it. */
  const holdCanyon = () =>
    ipc.hold("ondemand.titles", ({ versions }) => versions.some((version) => version.id === "b"));
  const answer = async (held: ReturnType<typeof holdCanyon>) => {
    await act(async () => held.resolve([canyon]));
    await settle();
  };
  const leaveSettings = () =>
    press(
      [
        ...document.querySelectorAll<HTMLButtonElement>('[data-view="settings"] header button'),
      ].find((each) => each.textContent?.trim() === "Back"),
    );
  const leaveTitle = () =>
    press(
      [...document.querySelectorAll<HTMLButtonElement>("[data-view=title] header button")].find(
        (each) => each.textContent?.trim() === "Back",
      ),
    );
  /** Back again, answered at once: Canyon Hours as it stood, so the way back stayed whole. */
  const stillLeadsToCanyon = async () => {
    await press(back());
    await showing("Canyon Hours");
    expect(inSheet("Season 2")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(240);
  };

  it("discards an older Back answer when accepted lists mark its target for adults", async () => {
    await threeDeep();
    await act(async () => ipc.emit("ondemand.updated", status));
    await showing("Meridian Dawn");
    const held = holdCanyon();
    await press(back());
    ipc.answer("ondemand.titles", ({ versions }) =>
      versions.flatMap((version) => {
        const title = titles.get(version.id);
        return title ? [{ ...title, adult: version.id === "b" }] : [];
      }),
    );
    await act(async () => ipc.emit("ondemand.updated", { ...status, markedForAdults: true }));
    await answer(held);
    expect(shown()).toBe("Meridian Dawn");
    await press(back());
    await showing("Night Harbour");
  });

  it("waits for refreshed related tiles before restoring season, scroll and focus", async () => {
    await threeDeep();
    const held = ipc.hold("ondemand.related", ({ version }) => version.id === "b");
    await act(async () => ipc.emit("ondemand.updated", status));
    await press(back());
    expect(shown()).toBe("Canyon Hours");
    expect(sheet()?.textContent).toContain("Loading related titles…");
    expect(inSheet("Season 2")?.getAttribute("aria-pressed")).toBe("true");
    await act(async () =>
      held.resolve({ basis: "Drama", titles: [{ title: meridian, reason: "Drama" }] }),
    );
    await showing("Canyon Hours");
    expect(scroller()?.scrollTop).toBe(240);
    expect(document.activeElement).toBe(relatedTile("Meridian Dawn"));
  });

  it.each(["settings", "playback"] as const)(
    "does not apply a delayed related restore behind %s",
    async (cover) => {
      const play = () =>
        [...(sheet()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((button) =>
          /^Play\b/.test(button.textContent?.trim() ?? ""),
        );
      await threeDeep();
      const held = ipc.hold("ondemand.related", ({ version }) => version.id === "b");
      await act(async () => ipc.emit("ondemand.updated", status));
      await press(back());
      expect(shown()).toBe("Canyon Hours");
      expect(sheet()?.textContent).toContain("Loading related titles…");
      await vi.waitFor(
        async () => {
          await settle();
          expect(play()).toBeDefined();
        },
        { interval: 1 },
      );
      if (cover === "settings") await key(",", { ctrlKey: true, metaKey: true });
      else {
        ipc.hold("playback.openTitle");
        await press(play());
      }
      await settle();
      const focused = document.activeElement;
      await act(async () =>
        held.resolve({ basis: "Drama", titles: [{ title: meridian, reason: "Drama" }] }),
      );
      await settle();
      expect(document.activeElement).toBe(focused);
      expect(document.querySelector('[aria-label="Also in your subscriptions"]')).toBeNull();
      if (cover === "settings") await leaveSettings();
      else await leaveTitle();
      await showing("Canyon Hours");
      await vi.waitFor(
        async () => {
          await settle();
          expect(play()).toBeDefined();
          expect(document.activeElement).toBe(play());
        },
        { interval: 1 },
      );
      await settle();
      expect(document.activeElement).toBe(play());
    },
  );

  it("gives way to Settings opened meanwhile, whether the lists answer before or after it closes", async () => {
    await threeDeep();
    const held = holdCanyon();
    await press(back());
    await key(",", { ctrlKey: true, metaKey: true });
    await settle();
    expect(useUi.getState().settings).toBe("general");
    await answer(held);
    await leaveSettings();
    await showing("Meridian Dawn");
    await stillLeadsToCanyon();

    await press(relatedTile("Meridian Dawn"));
    await showing("Meridian Dawn");
    const late = holdCanyon();
    await press(back());
    await key(",", { ctrlKey: true, metaKey: true });
    await settle();
    await leaveSettings();
    await showing("Meridian Dawn");
    await answer(late);
    expect(shown()).toBe("Meridian Dawn");
    await press(back());
    await showing("Canyon Hours");
  });

  it("gives way to a title played meanwhile, whether the lists answer before or after it is left", async () => {
    await threeDeep();
    ipc.hold("playback.openTitle");
    const held = holdCanyon();
    await press(back());
    await press(inSheet("Play"));
    expect(document.querySelector("[data-view=title]")).not.toBeNull();
    await answer(held);
    await leaveTitle();
    await showing("Meridian Dawn");
    await stillLeadsToCanyon();

    await press(relatedTile("Meridian Dawn"));
    await showing("Meridian Dawn");
    const late = holdCanyon();
    await press(back());
    await press(inSheet("Play"));
    await leaveTitle();
    await showing("Meridian Dawn");
    await answer(late);
    expect(shown()).toBe("Meridian Dawn");
    await press(back());
    await showing("Canyon Hours");
  });

  it("gives way to Search opened meanwhile, which gives the keyboard back to the details", async () => {
    await threeDeep();
    inSheet("Play")!.focus();
    const held = holdCanyon();
    await press(back());
    await press(sheet()!.querySelector<HTMLButtonElement>('header button[aria-label="Search"]')!);
    expect(useUi.getState().searchOpen).toBe(true);
    await answer(held);
    await key("Escape");
    await settle();
    expect(shown()).toBe("Meridian Dawn");
    expect(document.activeElement).toBe(inSheet("Play"));
    await stillLeadsToCanyon();
  });

  it("gives way to a newer Back, to Close and to another title", async () => {
    await threeDeep();
    const first = holdCanyon();
    await press(back());
    const second = holdCanyon();
    await press(back());
    await answer(first);
    expect(shown()).toBe("Meridian Dawn");
    await answer(second);
    await showing("Canyon Hours");

    await press(relatedTile("Meridian Dawn"));
    await showing("Meridian Dawn");
    const closed = holdCanyon();
    await press(back());
    await press(inSheet("Close"));
    expect(sheet()).toBeNull();
    await answer(closed);
    expect(sheet()).toBeNull();

    await act(async () => openDetails({ kind: "movie", ...ownedOf(harbour) }));
    await showing("Night Harbour");
    await press(relatedTile("Canyon Hours"));
    await showing("Canyon Hours");
    await press(relatedTile("Meridian Dawn"));
    await showing("Meridian Dawn");
    const replaced = holdCanyon();
    await press(back());
    await act(async () => openDetails({ kind: "movie", ...ownedOf(field) }));
    await showing("Quiet Field");
    await answer(replaced);
    expect(shown()).toBe("Quiet Field");
    await press(back());
    expect(sheet()).toBeNull();
  });
});

describe("the way back", () => {
  const target = (id: string, subscriptionId = SUBSCRIPTION): DetailsTarget => ({
    kind: "movie",
    subscriptionId,
    id,
  });
  const here = (related: string) => ({ season: null, scroll: 0, related });
  /** Presses Back until the details close: the version each Back shows, the page last. */
  async function backs(): Promise<(string | null)[]> {
    const seen: (string | null)[] = [];
    while (useUi.getState().details) {
      await backDetails();
      seen.push(useUi.getState().details?.id ?? null);
    }
    return seen;
  }
  /** Opens `ids` one from the other, the first from the page. */
  function chain(...targets: DetailsTarget[]) {
    const [first, ...rest] = targets;
    openDetails(first!);
    for (const next of rest) openRelated(next, here(next.id));
  }

  it(`reaches back ${DETAILS_TRAIL} details at most, the latest first`, async () => {
    chain(...Array.from({ length: DETAILS_TRAIL + 3 }, (_, at) => target(`t${at}`)));
    expect(useUi.getState().details?.id).toBe(`t${DETAILS_TRAIL + 2}`);
    expect(await backs()).toEqual([
      ...Array.from({ length: DETAILS_TRAIL }, (_, at) => `t${DETAILS_TRAIL + 1 - at}`),
      null,
    ]);
  });

  it("passes over a removed subscription's titles, and closes on its details", async () => {
    chain(target("a"), target("b", OTHER), target("c"));
    leaveSubscription(OTHER);
    expect(useUi.getState().details?.id).toBe("c");
    expect(await backs()).toEqual(["a", null]);

    chain(target("a"), target("b", OTHER), target("c"));
    leaveSubscription(SUBSCRIPTION);
    expect(useUi.getState().details).toBeNull();
    await backDetails();
    expect(useUi.getState().details).toBeNull();
  });

  it("passes over titles the lists now mark for adults, and forgets them", async () => {
    chain(target("a"), target("b"), target("c"), target("d"));
    forAdults.add("b").add("c");
    expect(await backs()).toEqual(["a", null]);
  });

  it("goes when titles for adults are hidden, the account starts over or a page opens", async () => {
    for (const end of [closeTitleSheets, resetForAccount, () => openView("movies")]) {
      chain(target("a"), target("b"), target("c"));
      end();
      expect(useUi.getState().details).toBeNull();
      await backDetails();
      expect(useUi.getState().details).toBeNull();
    }
  });

  it("starts over when a title opens anew, as from search or the player", async () => {
    chain(target("a"), target("b"));
    openDetails(target("d"));
    expect(await backs()).toEqual([null]);
  });
});

describe("grid and related details", () => {
  it("closes a keyboard related chain to its grid opener after the poster moved", async () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
    onTestFinished(() => {
      if (original) Object.defineProperty(HTMLElement.prototype, "offsetHeight", original);
      else Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    });
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 900,
    });
    let grid = [harbour, field];
    ipc.answer("ondemand.collection", ({ id, offset, limit }) => ({
      name: "All movies",
      total: id === "all" ? grid.length : 0,
      titles: id === "all" ? grid.slice(offset, offset + limit) : [],
    }));
    ipc.always("ondemand.filterOptions", { qualities: [], languages: [], verified: [], files: 0 });
    await window_();
    await press(await onPage("All movies"));
    await settle();
    await vi.waitFor(
      async () => {
        await settle();
        expect(document.querySelector('[role="listitem"][data-index="0"] button')).not.toBeNull();
      },
      { interval: 1 },
    );
    const opener = document.querySelector<HTMLButtonElement>(
      '[role="listitem"][data-index="0"] button',
    );
    expect(opener).not.toBeNull();
    opener!.focus();
    await key("Home");
    await key("Enter");
    await showing("Night Harbour");
    await press(relatedTile("Canyon Hours"));
    await showing("Canyon Hours");
    await press(inSheet("Season 2"));
    scroller()!.scrollTop = 240;
    await press(relatedTile("Meridian Dawn"));
    await showing("Meridian Dawn");
    grid = [field, harbour];
    const held = ipc.hold("ondemand.related", ({ version }) => version.id === "b");
    await act(async () =>
      ipc.emit("ondemand.updated", {
        ...status,
        lists: status.lists.map((list) => ({ ...list, fetchedAt: 2 })),
      }),
    );
    await press(back());
    expect(sheet()?.textContent).toContain("Loading related titles…");
    await act(async () =>
      held.resolve({ basis: "Drama", titles: [{ title: meridian, reason: "Drama" }] }),
    );
    await showing("Canyon Hours");
    expect(inSheet("Season 2")?.getAttribute("aria-pressed")).toBe("true");
    expect(scroller()?.scrollTop).toBe(240);
    expect(document.activeElement).toBe(relatedTile("Meridian Dawn"));
    await press(back());
    await showing("Night Harbour");
    await key("Escape");
    await settle();
    expect(sheet()).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toContain("Night Harbour");
    expect(
      document.activeElement?.closest('[role="listitem"]')?.getAttribute("aria-posinset"),
    ).toBe("2");
    expect(document.activeElement?.querySelector("span.ring-2.ring-white")).not.toBeNull();
  });
});
