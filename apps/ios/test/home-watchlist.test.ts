import * as React from "react";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { indexCatalogue, kindOf } from "@mrstreamer/core/ondemand/catalogue";
import type { OnDemandCatalogue, ProviderTitle } from "@mrstreamer/core/provider";
import { Window } from "happy-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Member } from "../src/account.ts";
import type { TitleLists } from "../src/titles.ts";

// Home's watchlist: its heading, always there, counts every saved title and opens all of them;
// its row of posters shows the saved titles a provider that still signs in lists, each opening
// through such a provider. The real Home screen runs with React DOM on a happy-dom window over the
// real watchlist owner, whose file is written to the files stand-in (native-files.ts), and lists
// indexed by core as the app's are. What else Home shows (the Stage, On now, Favourites, Movies for
// you) stands in as nothing; how each provider stands is set by each test.

const REACT_DOM = "react-dom/client";
const window = new Window();
Object.assign(globalThis, { window, document: window.document });
const { document } = window;
type Root = { render(node: unknown): void; unmount(): void };
const { createRoot } = (await import(REACT_DOM)) as { createRoot(container: object): Root };
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const scenario = vi.hoisted(() => ({
  members: [] as Member[],
  lists: { kind: "loading" } as TitleLists,
  did: [] as string[],
}));

vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  type Props = { children?: React.ReactNode; testID?: string };
  const box = ({ children, testID }: Props) =>
    createElement("div", { "data-testid": testID }, children);
  return {
    View: box,
    ScrollView: box,
    Text: ({ children }: Props) => createElement("span", null, children),
    Pressable: ({ children, testID, onPress }: Props & { onPress?: () => void }) =>
      createElement("button", { "data-testid": testID, onClick: onPress }, children),
    ActionSheetIOS: { showActionSheetWithOptions: () => undefined },
    StyleSheet: { create: <T>(styles: T) => styles, absoluteFill: {}, hairlineWidth: 1 },
  };
});
vi.mock("expo-router", () => ({
  router: { push: (href: string) => scenario.did.push(`push ${href}`) },
}));
vi.mock("expo-video", () => ({ VideoView: () => null }));
vi.mock("expo-file-system", () => import("./native-files.ts"));
vi.mock("../src/account.ts", () => ({
  useRoster: () => ({ kind: "ready", members: scenario.members }),
  members: () => scenario.members,
  useCatalogue: () => ({ kind: "loading" }),
  playChannel: () => undefined,
  retry: () => undefined,
  retryChannels: () => undefined,
}));
vi.mock("../src/titles.ts", () => ({
  useTitleLists: () => scenario.lists,
  titleLists: () => scenario.lists,
  titlesWorkedOut: () => true,
  useMetadataVersion: () => 0,
  useCollections: () => null,
  named: (title: Title) => title,
}));
vi.mock("../src/resume.ts", () => ({
  openDetails: (title: Title) =>
    scenario.did.push(`details ${title.kind} ${title.subscriptionId}:${title.id}`),
  resume: () => undefined,
  useContinueWatching: () => [],
}));
vi.mock("../src/playback.ts", () => ({
  usePlayback: () => ({ phase: { kind: "idle" } }),
  channelStatus: () => null,
  openWatch: () => undefined,
  player: () => null,
  retry: () => undefined,
  setMuted: () => undefined,
}));
vi.mock("../src/storage.ts", () => ({ useSavedState: () => ({}) }));
vi.mock("../src/viewing.ts", () => ({
  removeFromContinue: async () => undefined,
  useViewing: () => null,
}));
vi.mock("../src/errors.ts", () => ({ failureOf: () => ({ headline: "", advice: "" }) }));
vi.mock("../src/header.tsx", () => ({ tabHref: (_tab: string, screen: string) => `/${screen}` }));
vi.mock("../src/glass.tsx", () => ({ Glass: () => null, IconButton: () => null }));
vi.mock("../src/loading.tsx", async () => {
  const { createElement, Fragment } = await import("react");
  const pass = ({ children }: { children?: React.ReactNode }) =>
    createElement(Fragment, null, children);
  return {
    Docked: pass,
    Placeholders: () => null,
    Shape: () => null,
    libraryStatus: () => null,
    useDockInset: () => 0,
  };
});
vi.mock("../src/ui.tsx", () => ({
  colors: { text: "#FFFFFF", dim: "#A1A1A6", line: "#2C2C2E" },
  ChannelLogo: () => null,
  Message: () => null,
  Notice: () => null,
}));
vi.mock("../src/titles-ui.tsx", async () => {
  const { createElement } = await import("react");
  /** A heading as its accessibility label says it, opening all of it when it can. */
  const head = (name: string, total: number, onAll?: () => void) =>
    createElement(
      "button",
      { "data-testid": `head-${name}`, onClick: onAll },
      onAll ? `${name}, all ${total}` : name,
    );
  return {
    PlaceholderShelf: () => null,
    ShelfHead: ({ name, total, onAll }: { name: string; total: number; onAll?: () => void }) =>
      head(name, total, onAll),
    /** A row of posters, each a button named by the version it opens with. */
    Shelf: ({
      name,
      titles,
      total,
      onAll,
      onPress,
    }: {
      name: string;
      titles: readonly Title[];
      total?: number;
      onAll?: () => void;
      onPress: (title: Title) => void;
    }) =>
      createElement(
        "section",
        { "data-shelf": name },
        head(name, total ?? titles.length, onAll),
        titles.map((title) =>
          createElement(
            "button",
            {
              key: title.key,
              "data-testid": `poster-${title.subscriptionId}:${title.id}`,
              onClick: () => onPress(title),
            },
            title.title,
          ),
        ),
      ),
  };
});

const watchlist = await import("../src/watchlist.ts");
const { default: Home } = await import("../src/app/(tabs)/(home)/index.tsx");

const movie = (id: string, name: string, tmdbId: string | null = null): ProviderTitle => ({
  id,
  name,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: Date.UTC(2026, 9, 1),
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
function providers(...each: { id: string; titles: Standing; lost?: boolean }[]) {
  scenario.members = each.map(({ id, titles, lost }) => member(id, titles, lost));
  const listed = each.flatMap(({ id, titles }) => {
    const catalogue =
      titles.kind === "ready" ? titles.value : "last" in titles ? titles.last : null;
    return catalogue ? [{ subscriptionId: id, catalogue }] : [];
  });
  const index = indexCatalogue(listed, "en");
  scenario.lists = { kind: "ready", index };
  React.act(() => watchlist.setWatchlistOwners(each.map(({ id }) => id)));
  draw();
  return index;
}

let container: ReturnType<typeof document.createElement>;
let root: Root | null = null;
function draw() {
  if (!root) {
    container = document.createElement("div");
    root = createRoot(container);
  }
  React.act(() => root!.render(React.createElement(Home)));
}
/** The watchlist's posters, by the version each opens with. */
const posters = () =>
  [...container.querySelectorAll('[data-shelf="Watchlist"] [data-testid^="poster-"]')].map(
    (poster) => poster.getAttribute("data-testid")!.slice("poster-".length),
  );
const heading = () => container.querySelector('[data-testid="head-Watchlist"]');
function press(testID: string) {
  const button = container.querySelector(`[data-testid="${testID}"]`) as {
    click(): void;
  } | null;
  if (!button) throw new Error(`No ${testID} on screen`);
  React.act(() => button.click());
}
const dune = (index: ReturnType<typeof indexCatalogue>) =>
  kindOf(index, "movie").titles.find((title) => title.tmdbId === "100")!;

beforeEach(() => {
  scenario.did = [];
  for (const id of ["a", "b"]) watchlist.eraseWatchlist(id);
});
afterEach(() => {
  if (root) React.act(() => root!.unmount());
  root = null;
});

describe("Home's watchlist", () => {
  it("shows its heading with nothing saved, opening the whole watchlist", () => {
    providers({ id: "a", titles: ready(lists([movie("7", "Dune", "100")])) });
    expect(posters()).toEqual([]);
    expect(heading()?.textContent).toBe("Watchlist, all 0");
    press("head-Watchlist");
    expect(scenario.did).toEqual(["push /watchlist"]);
  });

  it("drops a title only a provider that lost its password lists, keeping its heading", () => {
    const shown = lists([movie("7", "Dune", "100")]);
    const index = providers({ id: "a", titles: ready(shown) });
    React.act(() => watchlist.saveTitle(dune(index)));
    draw();
    expect(posters()).toEqual(["a:7"]);

    providers({ id: "a", titles: ready(shown), lost: true });
    expect(posters()).toEqual([]);
    // The heading still counts it and opens the whole watchlist, where it can be removed.
    expect(heading()?.textContent).toBe("Watchlist, all 1");
    press("head-Watchlist");
    expect(scenario.did).toEqual(["push /watchlist"]);
  });

  it("opens a title another provider lists too through that one", () => {
    const a = lists([movie("7", "Dune", "100")]);
    const b = lists([movie("70", "Dune", "100")]);
    const index = providers({ id: "a", titles: ready(a) }, { id: "b", titles: ready(b) });
    React.act(() => watchlist.saveTitle(dune(index)));
    draw();
    expect(posters()).toEqual(["a:7"]);

    providers({ id: "a", titles: ready(a), lost: true }, { id: "b", titles: ready(b) });
    expect(posters()).toEqual(["b:70"]);
    press("poster-b:70");
    expect(scenario.did).toEqual(["details movie b:70"]);
  });

  it("keeps a title from lists that failed to come again while the login holds", () => {
    const shown = lists([movie("7", "Dune", "100")]);
    const index = providers({ id: "a", titles: ready(shown) });
    React.act(() => watchlist.saveTitle(dune(index)));
    const failed = {
      kind: "failed",
      error: { kind: "unexpected", detail: "" },
      last: shown,
      since: 0,
    } as Standing;
    providers({ id: "a", titles: failed });
    expect(posters()).toEqual(["a:7"]);
    expect(heading()?.textContent).toBe("Watchlist, all 1");
  });
});
