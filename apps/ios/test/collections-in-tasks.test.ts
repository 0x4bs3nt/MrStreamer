import * as React from "react";
import type { CollectionId, Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { TitleMetadata } from "@mrstreamer/core/metadata/tmdb";
import { indexCatalogue, kindOf, type IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import {
  collectionRows,
  collections,
  collectionSteps,
  type Collections,
  type CollectionSource,
  type ServiceTitles,
} from "@mrstreamer/core/ondemand/collections";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { xtreamProvider } from "@mrstreamer/core/xtream";
import { Window } from "happy-dom";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inTasks } from "../src/library.ts";
import { browseFixture } from "./title-browse-fixture.ts";

// The collections Movies, Series, Home and details show, made in short tasks: worked out between
// other tasks they hold what making them at once gives, with TMDB's metadata or without. The app's
// owner (titles.ts) makes them after the lists are indexed and whenever the metadata changes what
// they show, never while a screen draws: lists show only together with collections made of them,
// those that show stay until newer lists' or metadata's are made, none made for lists that no
// longer show ever show, and a removed subscription's titles go at once. Both
// paths agree on how long collections hold: until a title passes New's 7 or 30 days, metadata
// expires, the year turns or the clock goes back; the owner then makes them again once a screen
// reads them, as Movies and a collection do when what they show by changes. The subscriptions,
// viewing, TMDB's metadata store and React Native's views stand in at the owner's edges; tasks
// run as the app runs them.

const edges = vi.hoisted(() => ({
  opened: [] as Array<{ title: Title; asked: boolean }>,
  presses: new Map<string, () => void>(),
  retries: 0,
  members: [] as Array<{
    entry: { id: string };
    needsSecret: boolean;
    titles:
      | { kind: "ready"; value: OnDemandCatalogue; took: number }
      | { kind: "loading"; last: OnDemandCatalogue | null }
      | { kind: "failed"; error: unknown; last: OnDemandCatalogue | null; since: number };
  }>,
  roster: new Set<() => void>(),
  /** Each subscription's login, as sources.ts keeps it while it is signed in. */
  sources: new Map<string, { provider: { titleFile: (kind: string, id: string) => unknown } }>(),
  /** What the metadata store answers: TMDB's metadata of each title, by kind and TMDB id. */
  known: null as ((kind: string, id: string) => TitleMetadata) | null,
  services: [] as ServiceTitles[],
  /** When the metadata store says each title's metadata, or the services without an id, expires. */
  expiry: null as ((kind: string, id?: string) => number) | null,
  /** The owner's notices of what the metadata store learned. */
  notify: null as ((change: { content: boolean }) => void) | null,
  /** What viewing says was watched lately, and who listens. */
  viewing: null as unknown,
  watching: new Set<() => void>(),
}));

vi.mock("expo-file-system", () => ({ File: class {}, Paths: { cache: "/cache" } }));
vi.mock("../src/account.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    edges.roster.add(listener);
    return () => {
      edges.roster.delete(listener);
    };
  };
  return {
    members: () => edges.members,
    onRoster: (listener: () => void) => {
      edges.roster.add(listener);
      return () => edges.roster.delete(listener);
    },
    shownOf: (titles: { kind: string; value?: unknown; last?: unknown }) =>
      titles.kind === "ready" ? titles.value : (titles.last ?? null),
    retryTitles: () => {
      edges.retries++;
    },
    reloadTitles: () => undefined,
    useRoster: () => ({
      kind: "ready",
      members: useSyncExternalStore(subscribe, () => edges.members),
    }),
    // No launch is reading saved lists here.
    readingSaved: () => false,
    onReadingSaved: () => () => undefined,
  };
});
vi.mock("../src/sources.ts", () => ({
  currentSource: (id: string) => edges.sources.get(id),
  sourceOf: (id: string) => {
    const found = edges.sources.get(id);
    if (!found) throw new Error(`${id} isn't signed in`);
    return found;
  },
}));
vi.mock("../src/viewing.ts", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    edges.watching.add(listener);
    return () => edges.watching.delete(listener);
  };
  return {
    serveViewing: () => undefined,
    useViewing: () => useSyncExternalStore(subscribe, () => edges.viewing),
  };
});
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/errors.ts", () => ({ describeError: () => "failed" }));
vi.mock("../src/tab-bar.ts", () => ({ useFixedTabBar: () => undefined }));
vi.mock("../src/resume.ts", () => ({
  detailsHref: () => "/",
  openDetails: (title: Title, asked = false) => edges.opened.push({ title, asked }),
  resume: () => undefined,
  useContinueWatching: () => [],
}));
vi.mock("react-native-safe-area-context", async () => {
  const { createElement } = await import("react");
  return {
    SafeAreaView: ({ children }: { children?: React.ReactNode }) =>
      createElement("div", null, children),
  };
});
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const box = ({ children }: { children?: React.ReactNode }) =>
    createElement("div", null, children);
  return {
    View: box,
    Text: box,
    ScrollView: box,
    Pressable: ({
      children,
      onPress,
      accessibilityLabel,
      accessibilityState,
    }: {
      children?: React.ReactNode;
      onPress?: () => void;
      accessibilityLabel?: string;
      accessibilityState?: { selected?: boolean };
    }) => {
      if (onPress && accessibilityLabel) edges.presses.set(accessibilityLabel, onPress);
      return createElement(
        "button",
        {
          onClick: onPress,
          "aria-label": accessibilityLabel,
          "aria-pressed": accessibilityState?.selected,
        },
        children,
      );
    },
    Modal: box,
    StyleSheet: { create: <T>(styles: T) => styles },
  };
});
vi.mock("../src/ui.tsx", async () => {
  const { createElement } = await import("react");
  return {
    colors: {},
    Message: ({
      text,
      action,
    }: {
      text: string;
      action?: { label: string; onPress: () => void };
    }) =>
      createElement(
        "p",
        null,
        text,
        action ? createElement("button", { onClick: action.onPress }, action.label) : null,
      ),
  };
});
vi.mock("../src/titles-ui.tsx", async () => {
  const { createElement } = await import("react");
  /** A row or a grid as the ids of its titles. */
  const shown = (name: string, titles: readonly Title[]) =>
    createElement("section", { "data-shown": name }, titles.map(ownedKey).join(","));
  return {
    Artwork: () => null,
    CollectionTileView: () => null,
    TextTabs: ({
      tabs,
      onChange,
    }: {
      tabs: readonly { value: string; label: string }[];
      onChange: (value: string) => void;
    }) =>
      createElement(
        "nav",
        null,
        tabs.map(({ value, label }) =>
          createElement("button", { key: value, onClick: () => onChange(value) }, label),
        ),
      ),
    PlaceholderShelf: () => null,
    PlaceholderGrid: ({ header }: { header?: React.ReactNode }) =>
      createElement("div", null, header, "Loading collection"),
    Shelf: ({ name, titles }: { name: string; titles: readonly Title[] }) => shown(name, titles),
    PosterGrid: ({
      titles,
      header,
      empty,
      onPress,
    }: {
      titles: readonly Title[];
      header?: React.ReactNode;
      empty?: React.ReactNode;
      onPress: (title: Title) => void;
    }) => {
      for (const title of titles) edges.presses.set(`tile:${title.id}`, () => onPress(title));
      return createElement(
        "div",
        null,
        header,
        shown("grid", titles),
        titles.length ? null : empty,
        titles.map((title) =>
          createElement("button", { key: title.key, onClick: () => onPress(title) }, title.title),
        ),
      );
    },
  };
});
vi.mock("../src/watchlist.ts", () => ({ alignWatchlist: () => undefined }));
vi.mock("../src/header.tsx", () => ({ tabHref: () => "/" }));
vi.mock("../src/loading.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Docked: ({
      children,
      status,
    }: {
      children?: React.ReactNode;
      status?: { text: string } | null;
    }) =>
      createElement(
        Fragment,
        null,
        children,
        status ? createElement("span", { role: "status" }, status.text) : null,
      ),
    Placeholders: pass,
    Shape: () => null,
    libraryStatus: () => null,
    loadingStatus: (what: string) => ({ text: `Loading ${what}.` }),
    useDockInset: () => 0,
  };
});
vi.mock("@mrstreamer/core/metadata/store", () => ({
  metadataStore: (deps: { onChange: (change: { content: boolean }) => void }) => {
    edges.notify = deps.onChange;
    return {
      get: (kind: string, id: string) => edges.known?.(kind, id) ?? null,
      name: () => null,
      searchName: () => "",
      services: () => edges.services,
      expiresAt: (kind: string, id?: string) => edges.expiry?.(kind, id) ?? Infinity,
      searchAliases: () => [],
      want: () => undefined,
      status: () => null,
    };
  },
}));

/** The panel is typed by Node's own lib, which the app's tsconfig leaves out: imported by name. */
const FAKE_PROVIDER = "../../desktop/test/fake-provider.ts";
interface FakeProvider {
  readonly url: string;
  readonly titles: unknown;
  serveTitles(select: (all: unknown) => unknown): void;
  close(): Promise<void>;
}
const { startFakeProvider, measurementTitles } = (await import(FAKE_PROVIDER)) as {
  startFakeProvider(options: {
    readonly username: string;
    readonly password: string;
    readonly titles: number;
  }): Promise<FakeProvider>;
  measurementTitles(all: unknown, anchor: number): { readonly titles: unknown };
};

/**
 * TMDB's metadata as the fake TMDB would give it: genres, popularity and a rating that follow
 * from the id, every third made in Dutch; `round` shifts popularity, as later answers change it.
 */
function tmdbOf(round: number) {
  return (_kind: string, id: string): TitleMetadata => {
    const n = Number(id);
    return {
      genres: [[28, 35], [35], [18, 80], [99]][n % 4] ?? [],
      language: n % 3 === 0 ? "nl" : "en",
      popularity: ((n * 7 + round * 13) % 100) + 1,
      rating: 5 + (n % 5),
      votes: n % 2 === 0 ? 200 : 10,
      collection: null,
      backdrop: null,
    };
  };
}

/** A streaming service that streams every fifth title of each kind's TMDB ids. */
const servicesOf = (index: IndexedCatalogue, kind: TitleKind): ServiceTitles[] => [
  {
    id: 8,
    name: "Netflix",
    ids: new Set(
      kindOf(index, kind).titles.flatMap((title, at) =>
        title.tmdbId && at % 5 === 0 ? [title.tmdbId] : [],
      ),
    ),
  },
];

/** What screens read of collections: every list, its name and size, rows, genres and services. */
function shown(made: Collections, like: Title | undefined) {
  const liked = like ? (`like:${ownedKey(like)}` as const) : null;
  const ids: CollectionId[] = [
    "all",
    "4k",
    "adult",
    "new-week",
    "new-month",
    "recent",
    "popular",
    "top-rated",
    ...made.genres().map((genre) => `genre:${genre.name}` as const),
    ...made.services().map((service) => `service:${service.id}` as const),
    ...(liked ? [liked] : []),
  ];
  return {
    lists: ids.map((id) => ({
      id,
      name: made.name(id),
      size: made.size(id),
      titles: made.list(id).map((title) => `${ownedKey(title)} ${title.title}`),
    })),
    byTitle: made.list("all", "title").map(ownedKey),
    forYou: collectionRows(made, "for-you", like ?? null),
    fresh: collectionRows(made, "new", null),
    genres: made.genres(),
    services: made.services(),
  };
}

let provider: FakeProvider;
let catalogue: OnDemandCatalogue;
beforeAll(async () => {
  provider = await startFakeProvider({ username: "fixture", password: "pass", titles: 6000 });
  // Added in the last days, so New this week and this month hold titles by the clock now.
  const { titles } = measurementTitles(provider.titles, Math.floor(Date.now() / 1000) - 3600);
  provider.serveTitles(() => titles);
  catalogue = await xtreamProvider(
    { server: provider.url, username: "fixture", password: "pass" },
    { userAgent: "fixture" },
  ).onDemandCatalogue();
});
afterAll(() => provider.close());

describe("collections made in tasks", () => {
  it("hold what making them at once gives, with TMDB's metadata or without, in any language", async () => {
    for (const language of ["en", "nl"]) {
      const index = indexCatalogue([{ subscriptionId: "a", catalogue }], language);
      for (const known of [null, tmdbOf(0)]) {
        for (const kind of ["movie", "series"] as const) {
          const source: CollectionSource = {
            kind,
            titles: kindOf(index, kind).titles,
            language,
            metadata: (id) => known?.(kind, id) ?? null,
            names: () => null,
            services: known ? servicesOf(index, kind) : [],
            now: Date.now(),
          };
          const made = await inTasks(collectionSteps(source), () => true);
          if (!made) throw new Error("Stopped");
          const like = kindOf(index, kind).titles.find((title) => title.tmdbId && !title.adult);
          const atOnce = shown(collections(source), like);
          expect(shown(made, like)).toEqual(atOnce);
          expect(atOnce.lists.every((list) => list.size === list.titles.length)).toBe(true);
          expect(atOnce.lists.find((list) => list.id === "4k")?.size).toBeGreaterThan(0);
          expect(atOnce.fresh.length).toBeGreaterThan(0);
          if (known) expect(atOnce.genres.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("hold for as long as making them at once holds: New's cutoffs, the year, expiry and the clock", async () => {
    const DAY = 86_400_000;
    const index = indexCatalogue([{ subscriptionId: "a", catalogue }], "en");
    const now = Date.now();
    const titles = kindOf(index, "movie").titles;
    // A few titles' metadata expires soon, and once already; the services in a while.
    const ids = titles.flatMap((title) => (title.tmdbId ? [title.tmdbId] : []));
    const soon = new Map(ids.slice(0, 5).map((id, at) => [id, now + (at + 1) * 60_000]));
    soon.set(ids[5] ?? "", now - 1);
    for (const expiresAt of [
      undefined,
      (id?: string) => (id ? (soon.get(id) ?? Infinity) : now + 3 * DAY),
    ]) {
      const source: CollectionSource = {
        kind: "movie",
        titles,
        language: "en",
        metadata: tmdbOf(0).bind(null, "movie"),
        names: () => null,
        services: servicesOf(index, "movie"),
        now,
        ...(expiresAt ? { expiresAt } : {}),
      };
      const made = await inTasks(collectionSteps(source), () => true);
      if (!made) throw new Error("Stopped");
      const atOnce = collections(source);
      const year = Date.UTC(new Date(now).getUTCFullYear() + 1, 0, 1);
      const cutoffs = titles
        .flatMap((title) =>
          title.addedAt ? [title.addedAt + 7 * DAY, title.addedAt + 30 * DAY] : [],
        )
        .filter((at) => at > now)
        .sort((a, b) => a - b)
        .slice(0, 3);
      const probes = [now - 1, now, now + 3 * DAY, year, ...cutoffs, ...soon.values()].flatMap(
        (at) => [at - 1, at, at + 1],
      );
      expect(probes.map((at) => made.validAt(at))).toEqual(probes.map((at) => atOnce.validAt(at)));
      expect(made.validAt(now)).toBe(true);
      expect(made.validAt(now - 1)).toBe(false);
      // The earliest of what it was made with, past or absent expiries left out.
      const earliest = Math.min(year, ...cutoffs, ...(expiresAt ? [now + 60_000] : []));
      expect([made.validAt(earliest - 1), made.validAt(earliest)]).toEqual([true, false]);
    }
  });
});

describe("the collections Movies, Series, Home and details show", () => {
  type Owner = typeof import("../src/titles.ts");
  let titles: Owner;

  /** The app's owner as a launch starts it, with no subscriptions yet. */
  /** How far the clock is moved from the real one. */
  let shift = 0;
  beforeEach(async () => {
    vi.resetModules();
    edges.members = [];
    edges.opened = [];
    edges.presses.clear();
    edges.retries = 0;
    edges.roster.clear();
    edges.sources.clear();
    edges.known = null;
    edges.services = [];
    edges.expiry = null;
    edges.viewing = null;
    edges.watching.clear();
    shift = 0;
    const real = Date.now.bind(Date);
    vi.spyOn(Date, "now").mockImplementation(() => real() + shift);
    titles = await import("../src/titles.ts");
  });
  afterEach(() => vi.restoreAllMocks());

  const subscribe = (...ids: string[]) => list(ids.map((id) => [id, catalogue]));
  /** Subscriptions with these lists, as their provider gave them, in this order. */
  const list = (lists: ReadonlyArray<readonly [string, OnDemandCatalogue]>) => {
    edges.members = lists.map(([id, value]) => ({
      entry: { id },
      needsSecret: false,
      titles: { kind: "ready", value, took: 1 },
    }));
    for (const listener of edges.roster) listener();
  };
  /** The same lists as a provider gives them again: other objects, as a reload brings. */
  const again = (): OnDemandCatalogue => ({ ...catalogue, movies: [...catalogue.movies] });
  /** Whether `titles` holds a title of subscription `id`. */
  const holds = (titles: readonly Title[], id: string) =>
    titles.some((title) => title.versions.some((each) => each.subscriptionId === id));
  /** Whether `made` lists a title of subscription `id`. */
  const listsFrom = (made: Collections, id: string) => holds(made.list("all"), id);
  /** Whether `made` holds the titles `index` lists of `kind`, whatever metadata ranked them. */
  const madeOf = (made: Collections | null, kind: TitleKind, index: IndexedCatalogue | null) => {
    if (!made || !index) return false;
    const keys = (list: readonly Title[]) => list.map(ownedKey).toSorted().join(",");
    return keys(made.list("all")) === keys(atOnce(kind, index).list("all"));
  };
  /** What a screen reads each time the lists change, while `ready` doesn't hold yet. */
  async function watch(ready: () => boolean, what: string) {
    const views: Array<{
      index: IndexedCatalogue | null;
      movie: Collections | null;
      series: Collections | null;
    }> = [];
    const stop = titles.onTitleLists(() =>
      views.push({
        index: indexed(),
        movie: titles.collectionsOf("movie"),
        series: titles.collectionsOf("series"),
      }),
    );
    /** Tasks in which lists showed without both kinds' collections. */
    let bare = 0;
    await until(() => {
      if (indexed() && (!titles.collectionsOf("movie") || !titles.collectionsOf("series"))) bare++;
      return ready();
    }, what);
    stop();
    return { views, bare };
  }
  const indexed = () => {
    const lists = titles.titleLists();
    return lists.kind === "ready" ? lists.index : null;
  };
  /** Resolves once `ready` holds, checking after each task; fails after a few seconds. */
  async function until(ready: () => boolean, what: string) {
    for (let waited = 0; !ready(); waited += 1) {
      if (waited > 4000) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, 1));
    }
  }
  /** What making `kind`'s collections at once gives for the lists that show and metadata now. */
  const atOnce = (kind: TitleKind, index: IndexedCatalogue) =>
    collections({
      kind,
      titles: kindOf(index, kind).titles,
      language: titles.language,
      metadata: (id) => edges.known?.(kind === "movie" ? "movie" : "tv", id) ?? null,
      names: () => null,
      services: edges.services,
      expiresAt: (id) => edges.expiry?.(kind === "movie" ? "movie" : "tv", id) ?? Infinity,
      now: Date.now(),
    });
  const seedOf = (index: IndexedCatalogue) =>
    kindOf(index, "movie").titles.find((title) => title.tmdbId && !title.adult);
  /**
   * Resolves once `kind`'s collections show what making them at once now gives, comparing each
   * collections the owner holds once.
   */
  async function latest(kind: TitleKind, index: IndexedCatalogue, like?: Title) {
    const expected = JSON.stringify(shown(atOnce(kind, index), like));
    let checked: Collections | null = null;
    await until(() => {
      const made = titles.collectionsOf(kind);
      if (!made || made === checked) return false;
      checked = made;
      return JSON.stringify(shown(made, like)) === expected;
    }, "the latest collections");
  }
  /** The metadata store learned something lists show, and says so. */
  const learn = (round: number) => {
    edges.known = tmdbOf(round);
    edges.notify?.({ content: true });
  };

  it("show the lists only with both kinds' collections made of them, as making them at once gives", async () => {
    // Until then screens show Loading, and never make any while they draw.
    subscribe("a");
    expect(titles.collectionsOf("movie")).toBeNull();
    const { views, bare } = await watch(() => indexed() !== null, "the lists");
    expect(bare).toBe(0);
    expect(views).toHaveLength(1);
    const [view] = views;
    const index = indexed();
    if (!view || !index) throw new Error("No lists");
    expect(view.index).toBe(index);
    for (const kind of ["movie", "series"] as const) {
      const made = view[kind];
      if (!made) throw new Error("No collections");
      expect(titles.collectionsOf(kind)).toBe(made);
      expect(shown(made, undefined)).toEqual(shown(atOnce(kind, index), undefined));
    }
  });

  it("keep the last made while newer metadata's are made, then show the latest, with no screen open", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const first = titles.collectionsOf("movie");
    const index = indexed();
    if (!index) throw new Error("No lists");
    // Metadata arrives three times in a row, then again once collections are being made.
    learn(1);
    learn(2);
    learn(3);
    expect(titles.collectionsOf("movie")).toBe(first);
    await new Promise((done) => setTimeout(done, 0));
    expect(titles.collectionsOf("movie")).toBe(first);
    edges.services = servicesOf(index, "movie");
    learn(4);
    // However often it changed, what shows at last is made of the metadata as it stands now.
    const seed = seedOf(index);
    if (!seed) throw new Error("No seed");
    await latest("movie", index, seed);
    // More like this, as details show it while Movies isn't the open tab, has titles.
    expect(titles.collectionsOf("movie")?.list(`like:${ownedKey(seed)}`).length).toBeGreaterThan(0);
  });

  it("are none once no subscription lists titles, and those being made then never show", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    learn(1);
    await new Promise((done) => setTimeout(done, 0));
    edges.members = [];
    for (const listener of edges.roster) listener();
    expect(titles.collectionsOf("movie")).toBeNull();
    expect(titles.collectionsOf("series")).toBeNull();
    for (let task = 0; task < 200; task++) await new Promise((done) => setTimeout(done, 1));
    expect(titles.collectionsOf("movie")).toBeNull();
    expect(titles.collectionsOf("series")).toBeNull();
  });

  it("are of the new lists once they show, and those being made for the old never show", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const before = indexed();
    const first = titles.collectionsOf("movie");
    // Another subscription's lists are indexed while metadata changes the old lists' collections.
    subscribe("a", "b");
    learn(1);
    expect(indexed()).toBe(before);
    expect(titles.collectionsOf("movie")).toBe(first);
    /** Each collections the owner held once the new lists showed. */
    const seen = new Set<Collections>();
    const { views, bare } = await watch(() => {
      const made = titles.collectionsOf("movie");
      if (indexed() !== before && made) seen.add(made);
      return seen.size > 0;
    }, "the new lists' collections");
    // The old lists and their collections showed until the new ones replaced both at once.
    expect(bare).toBe(0);
    const index = indexed();
    expect(views).toHaveLength(1);
    expect(views[0]?.index).toBe(index);
    expect(madeOf(views[0]?.movie ?? null, "movie", index)).toBe(true);
    expect(madeOf(views[0]?.series ?? null, "series", index)).toBe(true);
    if (!index) throw new Error("No lists");
    for (const made of seen) expect(listsFrom(made, "b")).toBe(true);
    await latest("movie", index);
  });

  it("keep what shows while a subscription's lists come again, metadata changing meanwhile", async () => {
    edges.known = tmdbOf(0);
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const before = indexed();
    // A reload brings the same lists again, as a launch's from a saved copy, then TMDB answers.
    list([["a", again()]]);
    learn(1);
    learn(2);
    const { views, bare } = await watch(() => indexed() !== before, "the lists again");
    expect(bare).toBe(0);
    const index = indexed();
    expect(views).toHaveLength(1);
    expect(madeOf(views[0]?.movie ?? null, "movie", index)).toBe(true);
    expect(madeOf(views[0]?.series ?? null, "series", index)).toBe(true);
    if (!index) throw new Error("No lists");
    // A reload that fails keeps the last lists: nothing is indexed or made again for it.
    const shownNow = titles.collectionsOf("series");
    edges.members = edges.members.map((member) => ({
      ...member,
      titles: {
        kind: "failed",
        error: null,
        last: member.titles.kind === "ready" ? member.titles.value : member.titles.last,
        since: 0,
      },
    }));
    for (const listener of edges.roster) listener();
    for (let task = 0; task < 100; task++) await new Promise((done) => setTimeout(done, 1));
    expect(indexed()).toBe(index);
    expect(titles.collectionsOf("series")).toBe(shownNow);
    await latest("movie", index);
  });

  it("drop a removed subscription's titles at once, the others showing again once made without it", async () => {
    subscribe("a", "b");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const first = titles.collectionsOf("movie");
    expect(first && listsFrom(first, "b")).toBe(true);
    /** Reads that showed b's titles after its removal. */
    let retired = 0;
    const stop = titles.onTitleLists(() => {
      const index = indexed();
      const made = titles.collectionsOf("movie");
      if (index && holds(kindOf(index, "movie").titles, "b")) retired++;
      if (made && listsFrom(made, "b")) retired++;
    });
    subscribe("a");
    expect(titles.titleLists().kind).toBe("loading");
    expect(titles.collectionsOf("movie")).toBeNull();
    expect(titles.collectionsOf("series")).toBeNull();
    await until(() => {
      const made = titles.collectionsOf("movie");
      if (made && listsFrom(made, "b")) retired++;
      return made !== null;
    }, "the rest");
    stop();
    expect(retired).toBe(0);
    const index = indexed();
    expect(madeOf(titles.collectionsOf("movie"), "movie", index)).toBe(true);
    expect(madeOf(titles.collectionsOf("series"), "series", index)).toBe(true);
  });

  describe("a title's file asked for while the lists are made again without a removed subscription", () => {
    /** A login whose provider names each file by it. */
    const loginOf = (login: string) => ({
      provider: {
        titleFile: async (kind: string, id: string) => ({ url: `${login}/${kind}/${id}` }),
      },
    });
    /** Both subscriptions' lists showing, then b removed: a film of a's, and how many listen. */
    async function removedB() {
      edges.sources.set("a", loginOf("first"));
      edges.sources.set("b", loginOf("other"));
      subscribe("a", "b");
      await until(() => titles.collectionsOf("movie") !== null, "the first collections");
      const index = indexed();
      const film =
        index &&
        kindOf(index, "movie")
          .titles.flatMap((title) => title.versions)
          .find((version) => version.subscriptionId === "a" && version.container);
      if (!film) throw new Error("No film of a's");
      const listening = edges.roster.size;
      edges.sources.delete("b");
      subscribe("a");
      expect(titles.titleLists().kind).toBe("loading");
      return { ref: { kind: "movie", subscriptionId: "a", id: film.id } as const, listening };
    }

    it("answers once they show, under the login that stands then", async () => {
      const { ref, listening } = await removedB();
      const asked = titles.titleFile(ref, new AbortController().signal);
      // a signs in again, with a new password, while the request waits.
      edges.sources.set("a", loginOf("second"));
      for (const listener of edges.roster) listener();
      expect(await asked).toMatchObject({ url: `second/movie/${ref.id}` });
      expect(edges.roster.size).toBe(listening);
    });

    it("settles at once when it stops waiting or its subscription goes, leaving nothing behind", async () => {
      const { ref, listening } = await removedB();
      const controller = new AbortController();
      const stopped = titles.titleFile(ref, controller.signal);
      const removed = titles.titleFile(ref, new AbortController().signal);
      controller.abort(new Error("Another title was chosen"));
      await expect(stopped).rejects.toThrow("Another title was chosen");
      edges.sources.delete("a");
      edges.members = [];
      for (const listener of edges.roster) listener();
      await expect(removed).rejects.toMatchObject({ error: { kind: "no-subscription" } });
      expect(edges.roster.size).toBe(listening);
    });
  });

  it("never show lists replaced before they were indexed and made", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const before = indexed();
    const showed: Array<IndexedCatalogue | null> = [];
    const stop = titles.onTitleLists(() => showed.push(indexed()));
    // b's lists come, then go again before they show; a's come again meanwhile.
    subscribe("a", "b");
    await new Promise((done) => setTimeout(done, 1));
    list([["a", again()]]);
    const { bare } = await watch(() => indexed() !== before, "the latest lists");
    stop();
    expect(bare).toBe(0);
    expect(showed).toEqual([indexed()]);
    const index = indexed();
    if (!index) throw new Error("No lists");
    expect(holds(kindOf(index, "movie").titles, "b")).toBe(false);
    expect(madeOf(titles.collectionsOf("movie"), "movie", index)).toBe(true);
  });

  it("are made again once time passes what they hold, the last made showing meanwhile", async () => {
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const index = indexed();
    const first = titles.collectionsOf("movie");
    if (!index || !first) throw new Error("No collections");
    expect(first.size("new-week")).toBeGreaterThan(0);
    // Six days on, what was new this week no longer is.
    shift = 6 * 86_400_000;
    expect(titles.collectionsOf("movie")).toBe(first);
    await latest("movie", index);
    expect(titles.collectionsOf("movie")?.size("new-week")).toBe(0);
    // The clock goes back a day: what was made for later is made again for now.
    const later = titles.collectionsOf("movie");
    shift = -86_400_000;
    expect(titles.collectionsOf("movie")).toBe(later);
    await until(() => titles.collectionsOf("movie") !== later, "collections for now");
    await latest("movie", index);
    expect(titles.collectionsOf("movie")?.size("new-week")).toBeGreaterThan(0);
  });

  it("are made again once the metadata they were made with expires, and then hold", async () => {
    const made = Date.now();
    edges.known = tmdbOf(0);
    edges.expiry = () => made + 5_000;
    subscribe("a");
    await until(() => titles.collectionsOf("movie") !== null, "the first collections");
    const index = indexed();
    const first = titles.collectionsOf("movie");
    if (!index || !first) throw new Error("No collections");
    expect(first.validAt(made + 4_000)).toBe(true);
    shift = 6_000;
    expect(titles.collectionsOf("movie")).toBe(first);
    await until(() => titles.collectionsOf("movie") !== first, "collections made again");
    // Expired metadata doesn't make them again on every read.
    const again = titles.collectionsOf("movie");
    for (let task = 0; task < 100; task++) await new Promise((done) => setTimeout(done, 1));
    expect(titles.collectionsOf("movie")).toBe(again);
  });

  describe("on screen", () => {
    const window = new Window();
    const REACT_DOM = "react-dom/client";
    type Root = { render(node: unknown): void; unmount(): void };
    let root: Root;
    let container: ReturnType<typeof window.document.createElement>;
    beforeEach(async () => {
      Object.assign(globalThis, { window, document: window.document });
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const { createRoot } = (await import(REACT_DOM)) as {
        createRoot(container: object): Root;
      };
      container = window.document.createElement("div");
      window.document.body.append(container);
      root = createRoot(container);
    });
    afterEach(async () => {
      await React.act(async () => root.unmount());
      container.remove();
    });

    const draw = (node: React.ReactNode) => React.act(async () => root.render(node));
    /** What a row or grid shows, as its titles' ids; null when it isn't there. */
    const showing = (name: string) =>
      container.querySelector(`[data-shown="${name}"]`)?.textContent ?? null;
    /** Runs tasks inside act until `ready`, as the app's tasks run between draws. */
    async function settled(ready: () => boolean, what: string) {
      for (let task = 0; !ready(); task++) {
        if (task > 1000) throw new Error(`Timed out waiting for ${what}`);
        await React.act(async () => {
          await new Promise((done) => setTimeout(done, 1));
        });
      }
    }
    const ids = (titles: readonly Title[]) => titles.map(ownedKey).join(",");

    const click = async (label: string) => {
      const button = [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === label || button.textContent === label,
      );
      if (!button) throw new Error(`No button ${label}. ${container.textContent}`);
      await React.act(async () => button.click());
    };
    const press = async (label: string) => {
      const action = edges.presses.get(label);
      if (!action) throw new Error(`No press ${label}`);
      await React.act(async () => action());
    };

    it.each(["movie", "series"] as const)(
      "shows %s collection controls, counts, matching activation and reset",
      async (kind) => {
        const { CollectionScreen } = await import("../src/titles-screen.tsx");
        list([["a", browseFixture(kind).catalogue]]);
        await until(() => titles.collectionsOf(kind) !== null, "fixture collections");
        await draw(React.createElement(CollectionScreen, { kind, id: "all" }));
        expect(container.textContent).toContain(`4 of 4 ${kind === "movie" ? "movies" : "series"}`);
        await click("Sort & filter");
        expect(container.textContent).toContain("Unavailable. Verified track information");
        expect(container.textContent).toContain("provider name hints, not verified tracks");
        await click("4K · 2");
        await click("English · 1");
        expect(showing("grid")).toBe("a:en-4k");
        expect(container.textContent).toContain("Show 1");
        await click(`Show 1 ${kind === "movie" ? "movies" : "series"}`);
        await press("tile:en-4k");
        expect(edges.opened.at(-1)).toMatchObject({ title: { id: "en-4k" }, asked: true });
        await click("Sort & filter");
        await click("Nederlands · 1");
        expect(showing("grid")).toBe("a:nl-4k");
        await press("tile:nl-4k");
        expect(edges.opened.at(-1)).toMatchObject({ title: { id: "nl-4k" }, asked: true });
        await click("HD · 0");
        expect(container.textContent).toContain("No titles match these filters.");
        await click("Reset");
        expect(showing("grid")).toBe("a:en-hd,a:en-4k,a:unknown,a:tie");
        expect(container.textContent).toContain("Show 4");
      },
    );

    it.each(
      (["movie", "series"] as const).flatMap((kind) =>
        (["All tab", "4K tab", "pushed collection"] as const).map((place) => ({ kind, place })),
      ),
    )(
      "opens fresh $kind $place taps after password replacement with retained failed-refresh lists",
      async ({ kind, place }) => {
        const { CollectionScreen, TitlesHome } = await import("../src/titles-screen.tsx");
        const fixture = browseFixture(kind);
        edges.sources.set("a", { provider: { titleFile: () => null } });
        list([["a", fixture.catalogue]]);
        await until(() => titles.collectionsOf(kind) !== null, "collections");
        if (place === "pushed collection") {
          await draw(React.createElement(CollectionScreen, { kind, id: "all" }));
        } else {
          await draw(React.createElement(TitlesHome, { kind }));
          await click(place === "All tab" ? "All" : "4K");
        }
        const id = place === "4K tab" ? "nl-4k" : "en-hd";
        const oldTap = edges.presses.get(`tile:${id}`)!;
        const oldMade = titles.collectionsOf(kind);
        const replacement = { provider: { titleFile: () => null } };
        await React.act(async () => {
          edges.sources.set("a", replacement);
          edges.members = edges.members.map((member) => ({
            ...member,
            titles: {
              kind: "failed",
              error: { kind: "network" },
              last: fixture.catalogue,
              since: 1,
            },
          }));
          for (const listener of edges.roster) listener();
        });
        // The roster rerenders this same mounted route. Collections deliberately stay retained.
        expect(titles.collectionsOf(kind)).toBe(oldMade);
        await React.act(async () => oldTap());
        expect(edges.opened).toEqual([]);
        await press(`tile:${id}`);
        expect(edges.opened).toHaveLength(1);
        expect(edges.opened[0]).toMatchObject({
          title: { subscriptionId: "a", id },
          asked: place === "4K tab",
        });
        await React.act(async () => oldTap());
        expect(edges.opened).toHaveLength(1);
        edges.opened = [];
        const freshTap = edges.presses.get(`tile:${id}`)!;
        edges.sources.delete("a");
        await React.act(async () => freshTap());
        expect(edges.opened).toEqual([]);
        edges.sources.set("a", replacement);
        await click("Sort & filter");
        await click(place === "4K tab" ? "English · 1" : "4K · 2");
        await React.act(async () => freshTap());
        expect(edges.opened).toEqual([]);
        const filteredTap = edges.presses.get("tile:en-4k")!;
        await React.act(async () => list([]));
        await React.act(async () => filteredTap());
        expect(edges.opened).toEqual([]);
        await draw(React.createElement("div"));
        await React.act(async () => filteredTap());
        expect(edges.opened).toEqual([]);
      },
    );

    it("keeps pending pushed collection controls without failure copy or an invented count", async () => {
      const { CollectionScreen } = await import("../src/titles-screen.tsx");
      edges.members = [
        { entry: { id: "a" }, needsSecret: false, titles: { kind: "loading", last: null } },
      ];
      for (const listener of edges.roster) listener();
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
      expect(titles.titleLists().kind).toBe("loading");
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading movies.");
      expect(container.textContent).not.toContain("Catalogue unavailable");
      expect(container.textContent).not.toContain(" of ");
      await click("Sort & filter");
      expect(container.textContent).not.toContain("Catalogue unavailable");
      expect(container.textContent).not.toContain(" of ");
      await click("Reset");
      await click("Done");
    });

    it.each(["All", "4K"] as const)(
      "keeps truthful loading feedback on a pending %s tab",
      async (tab) => {
        const { TitlesHome } = await import("../src/titles-screen.tsx");
        list([["a", browseFixture("movie").catalogue]]);
        await until(() => titles.collectionsOf("movie") !== null, "collections");
        await draw(React.createElement(TitlesHome, { kind: "movie" }));
        await click(tab);
        await React.act(async () => {
          edges.members = [
            { entry: { id: "a" }, needsSecret: false, titles: { kind: "loading", last: null } },
          ];
          for (const listener of edges.roster) listener();
        });
        expect(titles.titleLists().kind).toBe("loading");
        expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading movies.");
        expect(container.textContent).not.toContain("Catalogue unavailable");
        expect(container.textContent).not.toContain(" of ");
        await click("Sort & filter");
        expect(container.textContent).not.toContain("Catalogue unavailable");
        await click("Reset");
        await click("Done");
      },
    );

    it("retains session choices across tabs, collection routes and Back, with core sorting", async () => {
      const { CollectionScreen, TitlesHome } = await import("../src/titles-screen.tsx");
      list([
        [
          "a",
          { ...browseFixture("movie").catalogue, series: browseFixture("series").catalogue.series },
        ],
      ]);
      await until(() => titles.collectionsOf("movie") !== null, "collections");
      await draw(React.createElement(TitlesHome, { kind: "movie" }));
      await click("All");
      await click("Sort & filter");
      await click("Title");
      expect(showing("grid")).toBe("a:en-hd,a:en-4k,a:tie,a:unknown");
      await click("4K · 2");
      await click("Show 2 movies");
      expect(showing("grid")).toBe("a:nl-4k,a:en-4k");
      await draw(React.createElement(CollectionScreen, { kind: "series", id: "all" }));
      expect(showing("grid")).toBe("a:en-hd,a:en-4k,a:unknown,a:tie");
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "4k" }));
      await click("Sort & filter");
      await click("English · 1");
      expect(showing("grid")).toBe("a:en-4k");
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
      expect(showing("grid")).toBe("a:nl-4k,a:en-4k");
      await draw(React.createElement(TitlesHome, { kind: "movie" }));
      expect(showing("grid")).toBe("a:nl-4k,a:en-4k");
    });

    it("cancels stale tile taps on refresh, source replacement, removal and leaving the route", async () => {
      const { CollectionScreen } = await import("../src/titles-screen.tsx");
      const fixture = browseFixture("movie");
      list([["a", fixture.catalogue]]);
      await until(() => titles.collectionsOf("movie") !== null, "collections");
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
      const before = edges.presses.get("tile:en-hd")!;
      await React.act(async () => list([["a", { ...fixture.catalogue }]]));
      await React.act(async () => before());
      expect(edges.opened).toEqual([]);
      await settled(() => titles.titlesWorkedOut(), "refresh");
      const refreshed = edges.presses.get("tile:en-hd")!;
      edges.sources.set("a", { provider: { titleFile: () => null } });
      await React.act(async () => refreshed());
      expect(edges.opened).toEqual([]);
      await click("Sort & filter");
      expect(container.textContent).toContain("Reset");
      await React.act(async () => list([]));
      await React.act(async () => refreshed());
      expect(edges.opened).toEqual([]);
      expect(container.textContent).toContain("Sort & filter");
      await click("Sort & filter");
      await click("Reset");
      expect(container.textContent).not.toContain("Catalogue unavailable");
      expect(container.textContent).toContain("No movies in this collection.");
      await React.act(async () => list([["a", fixture.catalogue]]));
      await settled(() => titles.titlesWorkedOut(), "readded");
      const leaving = edges.presses.get("tile:en-hd")!;
      await draw(React.createElement("div"));
      await React.act(async () => leaving());
      expect(edges.opened).toEqual([]);
    });

    it("updates metadata and removed options without dropping controls or confusing empty results with an empty catalogue", async () => {
      const { CollectionScreen } = await import("../src/titles-screen.tsx");
      const fixture = browseFixture("movie");
      list([["a", fixture.catalogue]]);
      await until(() => titles.collectionsOf("movie") !== null, "collections");
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
      await click("Sort & filter");
      await click("4K · 2");
      const before = titles.collectionsOf("movie");
      await React.act(async () => learn(2));
      await settled(() => titles.collectionsOf("movie") !== before, "metadata refresh");
      expect(container.textContent).toContain("2 of 4 movies");
      await React.act(async () =>
        list([
          [
            "a",
            {
              ...fixture.catalogue,
              movies: fixture.catalogue.movies.filter((row) => !row.name.includes("4K")),
            },
          ],
        ]),
      );
      await settled(() => titles.titlesWorkedOut(), "new declarations");
      expect(container.textContent).toContain("0 of 3 movies");
      expect(container.textContent).toContain("Selected quality: 4K. No matching files listed.");
      expect(container.textContent).toContain("No titles match these filters.");
      await click("Reset");
      expect(container.textContent).toContain("3 of 3 movies");
      await React.act(async () => list([["a", { ...fixture.catalogue, movies: [] }]]));
      await settled(() => titles.titlesWorkedOut(), "empty catalogue");
      expect(container.textContent).toContain("No movies in this collection.");
      expect(container.textContent).not.toContain("No titles match");
      expect(container.textContent).toContain("Reset");
    });

    it("keeps the selected 4K tab and its controls when its catalogue empties or disappears", async () => {
      const { TitlesHome } = await import("../src/titles-screen.tsx");
      const fixture = browseFixture("movie");
      list([["a", fixture.catalogue]]);
      await until(() => titles.collectionsOf("movie") !== null, "collections");
      await draw(React.createElement(TitlesHome, { kind: "movie" }));
      await click("4K");
      await click("Sort & filter");
      await click("Nederlands · 1");
      await click("Show 1 movies");
      const stale = edges.presses.get("tile:nl-4k")!;
      await React.act(async () => list([["a", { ...fixture.catalogue, movies: [] }]]));
      await settled(() => titles.titlesWorkedOut(), "empty 4K catalogue");
      expect(container.textContent).toContain("No movies in this collection.");
      expect(container.textContent).toContain("Sort & filter");
      await click("Sort & filter");
      expect(container.textContent).toContain("Selected file language: Nederlands");
      await click("Reset");
      await React.act(async () => stale());
      expect(edges.opened).toEqual([]);
      await React.act(async () => list([]));
      expect(container.textContent).toContain("Sort & filter");
      expect(container.textContent).toContain("No movies in this collection.");
      await click("Sort & filter");
      await click("Reset");
      await React.act(async () => list([["a", fixture.catalogue]]));
      await settled(() => titles.titlesWorkedOut(), "returning 4K catalogue");
      expect(showing("grid")).toBe("a:nl-4k,a:en-4k");
    });

    it("recovers an initial persistent collection failure through Try again with controls present", async () => {
      const { CollectionScreen } = await import("../src/titles-screen.tsx");
      edges.members = [
        {
          entry: { id: "a" },
          needsSecret: false,
          titles: { kind: "failed", error: { kind: "network" }, last: null, since: 1 },
        },
      ];
      for (const listener of edges.roster) listener();
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
      expect(container.textContent).toContain("failed");
      expect(container.textContent).not.toContain("Loading collection");
      await click("Sort & filter");
      await click("Reset");
      await click("Try again");
      expect(edges.retries).toBe(1);
      await React.act(async () => list([["a", browseFixture("movie").catalogue]]));
      await settled(() => titles.titlesWorkedOut(), "retry");
      expect(container.textContent).toContain("4 of 4 movies");
    });

    it("shows For you as it stands now once what was watched changes, after the clock passed New's days", async () => {
      const { TitlesHome } = await import("../src/titles-screen.tsx");
      edges.known = tmdbOf(0);
      subscribe("a");
      await until(() => titles.collectionsOf("movie") !== null, "the first collections");
      const index = indexed();
      const seed = index && seedOf(index);
      if (!index || !seed) throw new Error("No lists");
      await draw(React.createElement(TitlesHome, { kind: "movie" }));
      expect(showing("New this week")).not.toBeNull();
      // Six days on, nothing is new this week any more; then a film is watched.
      shift = 6 * 86_400_000;
      expect(atOnce("movie", index).list("new-week")).toEqual([]);
      await React.act(async () => {
        edges.viewing = { recentTitles: [{ title: seed }] };
        for (const listener of edges.watching) listener();
      });
      await settled(() => showing("New this week") === null, "For you as it stands now");
      const now = atOnce("movie", index);
      expect(showing("Popular")).toBe(ids(now.list("popular").slice(0, 24)));
    }, 20_000);

    it("shows a collection as it stands now when the screen turns to another, after the clock passed", async () => {
      const { CollectionScreen } = await import("../src/titles-screen.tsx");
      subscribe("a");
      await until(() => titles.collectionsOf("movie") !== null, "the first collections");
      const index = indexed();
      if (!index) throw new Error("No lists");
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "all" }));
      expect(showing("grid")).toBe(ids(atOnce("movie", index).list("all")));
      shift = 6 * 86_400_000;
      // The same screen turns to New this week, which has emptied by now.
      await draw(React.createElement(CollectionScreen, { kind: "movie", id: "new-week" }));
      await settled(() => showing("grid") === "", "the collection as it stands now");
      expect(atOnce("movie", index).list("new-week")).toEqual([]);
    }, 20_000);
  });
});
