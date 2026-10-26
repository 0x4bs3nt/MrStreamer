// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { acceptPreferences } from "../../src/renderer/src/lib/preferences.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "../../src/renderer/src/features/settings/SettingsPage.tsx";
import { WindowBar } from "../../src/renderer/src/components/WindowBar.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { CustomizeHome } from "../../src/renderer/src/features/home/CustomizeHome.tsx";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  useUi.setState({
    settings: null,
    view: "home",
    watching: false,
    details: null,
    savedEntry: null,
    updateDialog: null,
  });
  vi.useRealTimers();
});
/** Lets the page take in what just happened, on the fake clock. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
const labels = () =>
  [...document.querySelectorAll("li label")].map((label) => label.textContent?.trim());
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === name || button.textContent?.trim() === name,
  )!;

it("edits empty Home rows, retains focus and future IDs, serializes writes and resets defaults", async () => {
  ipc.reset();
  ipc.prefer({
    homeRows: [
      { id: "watchlist", visible: false },
      { id: "future", visible: false },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const mounted = queryView(client);
  await mounted.render(createElement(TooltipProvider, null, createElement(CustomizeHome)));
  unmount = mounted.unmount;
  await settle();
  expect(labels()).toEqual([
    "Watchlist",
    "Continue watching",
    "Recommendations",
    "Favourites",
    "Recently watched",
    "New movies",
    "New series",
    "Current category",
  ]);
  expect(document.querySelector<HTMLInputElement>("li input")?.checked).toBe(false);
  const held = ipc.hold("preferences.update");
  const move = button("Move Watchlist down");
  move.focus();
  await act(async () => {
    move.click();
    move.click();
  });
  await settle();
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  expect(document.querySelector("section[aria-busy=true]")).not.toBeNull();
  expect(document.querySelector('[role="status"]')?.textContent).toBe("Saving…");
  expect(labels()[0]).toBe("Continue watching");
  await act(async () =>
    acceptPreferences(
      client,
      ipc.snapshot({
        volume: 0.6,
        muted: false,
        audioLanguage: "nl",
        homeRows: [
          { id: "watchlist", visible: false },
          { id: "future", visible: false },
        ],
      }),
    ),
  );
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Continue watching", "Watchlist"]);
  const patch = ipc.argsOf("preferences.update")[0]!;
  expect(patch.homeRows?.at(-1)).toEqual({ id: "future", visible: false });
  await act(async () => held.resolve(ipc.snapshot({ volume: 1, muted: false, ...patch })));
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Continue watching", "Watchlist"]);
  expect(document.activeElement).toBe(move);
  const visible = ipc.hold("preferences.update");
  await act(async () => document.querySelectorAll<HTMLInputElement>("li input")[1]!.click());
  await act(async () =>
    visible.resolve(
      ipc.snapshot({ volume: 1, muted: false, ...ipc.argsOf("preferences.update").at(-1)! }),
    ),
  );
  await settle();
  expect(document.querySelectorAll<HTMLInputElement>("li input")[1]!.checked).toBe(true);
  const reset = ipc.hold("preferences.update");
  await act(async () => button("Reset to defaults").click());
  expect(ipc.argsOf("preferences.update").at(-1)?.homeRows?.at(-1)).toEqual({
    id: "future",
    visible: false,
  });
  await act(async () =>
    reset.resolve(
      ipc.snapshot({ volume: 1, muted: false, ...ipc.argsOf("preferences.update").at(-1)! }),
    ),
  );
  await settle();
  expect(labels().slice(0, 3)).toEqual(["Continue watching", "Recommendations", "Watchlist"]);
  expect(
    [...document.querySelectorAll<HTMLInputElement>("li input")].every((input) => input.checked),
  ).toBe(true);
});

const checkbox = (name: string) =>
  [...document.querySelectorAll("li label")]
    .find((label) => label.textContent?.trim() === name)!
    .querySelector<HTMLInputElement>("input")!;

/** Real Settings tab switches and closing/reopening share the same preference write. */
async function showReopenable() {
  ipc.reset();
  const mounted = queryView(new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  useUi.setState({ settings: "home" });
  await mounted.render(
    createElement(
      TooltipProvider,
      null,
      createElement(Fragment, null, createElement(WindowBar), createElement(SettingsPage)),
    ),
  );
  unmount = mounted.unmount;
  await settle();
}

it("returns from Home settings with Escape on a row checkbox", async () => {
  await showReopenable();
  const control = checkbox("Watchlist");
  control.focus();
  await act(async () =>
    control.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  expect(useUi.getState().settings).toBeNull();
});

it("blocks a move during save notification and preserves the settled visibility on retry", async () => {
  await showReopenable();
  const hide = ipc.hold("preferences.update");
  await act(async () => checkbox("Watchlist").click());
  await settle();
  const hidden = ipc.argsOf("preferences.update")[0]!;
  hide.resolve(ipc.snapshot({ volume: 1, muted: false, ...hidden }));
  // Let the IPC promise finish before React receives the scheduled observer notification.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(button("Move Watchlist up").getAttribute("aria-disabled")).toBe("true");
  button("Move Watchlist up").click();
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  await settle();
  const move = ipc.hold("preferences.update");
  await act(async () => button("Move Watchlist up").click());
  const moved = ipc.argsOf("preferences.update")[1]!;
  expect(moved.homeRows?.[1]).toEqual({ id: "watchlist", visible: false });
  await act(async () => move.resolve(ipc.snapshot({ volume: 1, muted: false, ...moved })));
  await settle();
  expect(labels().slice(0, 3)).toEqual(["Continue watching", "Watchlist", "Recommendations"]);
  expect(checkbox("Watchlist").checked).toBe(false);
});

it("blocks reopened controls until a held save settles, then retains both edits", async () => {
  await showReopenable();
  const first = ipc.hold("preferences.update");
  await act(async () => button("Move Continue watching down").click());
  const reordered = ipc.argsOf("preferences.update")[0]!;
  await act(async () => button("General").click());
  await act(async () => button("Home").click());
  expect(checkbox("Watchlist").getAttribute("aria-disabled")).toBe("true");
  expect(button("Move Watchlist down").getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    button("Move Watchlist down").click();
    button("Reset to defaults").click();
    checkbox("Watchlist").click();
  });
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  await act(async () => first.resolve(ipc.snapshot({ volume: 1, muted: false, ...reordered })));
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Recommendations", "Continue watching"]);
  const second = ipc.hold("preferences.update");
  await act(async () => checkbox("Watchlist").click());
  const hidden = ipc.argsOf("preferences.update")[1]!;
  expect(hidden.homeRows?.slice(0, 2).map((row) => row.id)).toEqual([
    "recommendations",
    "continue",
  ]);
  expect(hidden.homeRows?.[2]).toEqual({ id: "watchlist", visible: false });
  await act(async () => second.resolve(ipc.snapshot({ volume: 1, muted: false, ...hidden })));
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Recommendations", "Continue watching"]);
  expect(checkbox("Watchlist").checked).toBe(false);
});

it("shows a failed save after reopening, retains saved rows and allows retry then another edit", async () => {
  await showReopenable();
  const first = ipc.hold("preferences.update");
  await act(async () => checkbox("Watchlist").click());
  await act(async () => button("Back").click());
  await act(async () => button("Settings").click());
  await act(async () => button("Home").click());
  await act(async () => button("Move Watchlist up").click());
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  await act(async () => first.reject({ kind: "unexpected", detail: "Disk write refused" }));
  await settle();
  expect(checkbox("Watchlist").checked).toBe(true);
  expect(labels().slice(0, 3)).toEqual(["Continue watching", "Recommendations", "Watchlist"]);
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("Disk write refused");
  const retry = ipc.hold("preferences.update");
  await act(async () => checkbox("Watchlist").click());
  const hidden = ipc.argsOf("preferences.update")[1]!;
  await act(async () => retry.resolve(ipc.snapshot({ volume: 1, muted: false, ...hidden })));
  await settle();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  const next = ipc.hold("preferences.update");
  await act(async () => button("Move Watchlist up").click());
  const moved = ipc.argsOf("preferences.update")[2]!;
  await act(async () => next.resolve(ipc.snapshot({ volume: 1, muted: false, ...moved })));
  await settle();
  expect(labels()[1]).toBe("Watchlist");
  expect(checkbox("Watchlist").checked).toBe(false);
});

// The complete Home view uses the same row preferences and public title actions as its controls.
it("promotes the first visible nonempty channel row once, across title rows, moves, hides and reset", async () => {
  const { HomeScreen } = await import("../../src/renderer/src/features/home/HomeScreen.tsx");
  const { SAVED, SUBSCRIPTION } = await import("./support.ts");
  const { defaultPreferences } = await import("@mrstreamer/contracts/preferences");
  const { queries } = await import("../../src/renderer/src/lib/queries.ts");
  const channel = {
    subscriptionId: SUBSCRIPTION,
    id: "one",
    name: "Channel one",
    title: "Channel one",
    tags: [],
    number: 1,
    logoUrl: null,
    categoryIds: ["all"],
    catchupDays: null,
    variants: [{ id: "one", name: "Channel one", tags: [], quality: null }],
  };
  const film = {
    kind: "movie" as const,
    key: "movie:continuing",
    subscriptionId: SUBSCRIPTION,
    id: "film",
    name: "Continuing film",
    title: "Continuing film",
    originalTitle: null,
    originalLanguage: null,
    tags: [],
    year: null,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "film", tags: [] }],
  };
  ipc.reset();
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", [
    {
      subscriptionId: SUBSCRIPTION,
      id: "all",
      name: "Channels",
      title: "Channels",
      group: null,
      channelCount: 1,
      members: [{ subscriptionId: SUBSCRIPTION, id: "all" }],
    },
  ]);
  ipc.always("library.browse", browseResult([channel]));
  ipc.always("library.status", []);
  ipc.always("guide.listings", {});
  ipc.always("viewing.get", {
    favourites: [channel],
    recent: [channel],
    continueWatching: [
      {
        title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "film" },
        position: 500,
        duration: 1000,
        finished: false,
        at: 1,
        since: 1,
      },
    ],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.titles", [film]);
  ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  ipc.prefer({
    homeRows: [
      { id: "watchlist", visible: true },
      { id: "category", visible: true },
      { id: "recent", visible: true },
      { id: "favourites", visible: true },
    ],
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  const mounted = queryView(client);
  const { container } = mounted;
  unmount = mounted.unmount;
  await mounted.render(
    createElement(
      TooltipProvider,
      null,
      createElement(
        Fragment,
        null,
        createElement(HomeScreen, { active: false }),
        createElement(SettingsPage),
      ),
    ),
  );
  await settle();
  const promoted = () =>
    container.querySelector("[data-home-promoted]")?.getAttribute("data-home-row");
  const assertOnce = (id: string) => {
    expect(promoted()).toBe(id);
    expect(container.querySelectorAll(`[data-home-row=${id}]`)).toHaveLength(1);
  };
  assertOnce("category");
  expect(
    [...container.querySelectorAll("[data-home-row]")].map((r) => r.getAttribute("data-home-row")),
  ).toEqual(["category", "recent", "favourites", "continue"]);
  await act(async () => button("Settings").click());
  await act(async () => button("Home").click());
  expect(button("Reset to defaults")).toBeDefined();
  expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Done")).toBe(
    false,
  );
  const save = async (action: () => void) => {
    const held = ipc.hold("preferences.update");
    await act(async () => action());
    await act(async () =>
      held.resolve(
        ipc.snapshot({ ...defaultPreferences, ...ipc.argsOf("preferences.update").at(-1)! }),
      ),
    );
    await settle();
  };
  await save(() => checkbox("Current category").click());
  assertOnce("recent");
  await save(() => button("Move Favourites up").click());
  assertOnce("favourites");
  await save(() => checkbox("Favourites").click());
  assertOnce("recent");
  await save(() => button("Reset to defaults").click());
  assertOnce("favourites");
  await act(async () => button("Back").click());
  await act(async () => button("Watchlist").click());
  const { useUi } = await import("../../src/renderer/src/app/ui-store.ts");
  expect(useUi.getState().view).toBe("watchlist");
});

it("sparse saved titles keep their resolved owner and unavailable-entry action without eager details", async () => {
  const measuredWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(1280);
  const { HomeScreen } = await import("../../src/renderer/src/features/home/HomeScreen.tsx");
  const { useUi } = await import("../../src/renderer/src/app/ui-store.ts");
  const { SAVED, SUBSCRIPTION } = await import("./support.ts");
  const { queries } = await import("../../src/renderer/src/lib/queries.ts");
  const title = {
    kind: "movie" as const,
    key: "movie:original",
    subscriptionId: SUBSCRIPTION,
    id: "original",
    name: "Owned movie",
    title: "Owned movie",
    originalTitle: null,
    originalLanguage: null,
    tags: [],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "original", tags: [] }],
  };
  const resolved = {
    subscriptionId: SUBSCRIPTION,
    id: "saved",
    kind: "movie" as const,
    name: title.name,
    year: title.year,
    savedAt: 1,
    title,
    artworkUrl: null,
    sources: [SUBSCRIPTION],
    listed: true,
  };
  const unavailable = { ...resolved, id: "missing", name: "Missing movie", title: null };
  ipc.reset();
  useUi.setState(useUi.getInitialState(), true);
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", []);
  ipc.always("library.browse", browseResult([]));
  ipc.always("library.status", []);
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
  ipc.always("watchlist.list", { total: 2, entries: [resolved, unavailable] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  const mounted = queryView(client);
  const { container } = mounted;
  unmount = () => {
    mounted.unmount();
    useUi.setState(useUi.getInitialState(), true);
    measuredWidth.mockRestore();
  };
  await mounted.render(createElement(HomeScreen, { active: false }));
  await settle();
  const cards = container.querySelectorAll("[data-home-row=watchlist] article");
  expect(cards).toHaveLength(2);
  expect(cards[0]?.textContent).toContain("Play");
  expect(cards[1]?.textContent).toContain("Unavailable");
  expect(cards[1]?.textContent).not.toContain("Play");
  expect(ipc.argsOf("ondemand.details")).toHaveLength(0);
  await act(async () => cards[0]!.querySelector<HTMLButtonElement>("button[title]")!.click());
  expect(useUi.getState().details).toEqual({
    kind: "movie",
    subscriptionId: SUBSCRIPTION,
    id: "original",
  });
  await act(async () =>
    [...cards[0]!.querySelectorAll("button")].find((b) => b.textContent === "Details")!.click(),
  );
  expect(useUi.getState().details).toEqual({
    kind: "movie",
    subscriptionId: SUBSCRIPTION,
    id: "original",
  });
  await act(async () =>
    [...cards[1]!.querySelectorAll("button")].find((b) => b.textContent === "Details")!.click(),
  );
  expect(useUi.getState().savedEntry).toEqual(unavailable);
});
