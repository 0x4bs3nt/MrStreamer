// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CustomizeHome } from "../../src/renderer/src/features/home/CustomizeHome.tsx";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";

let unmount = () => {};
afterEach(() => unmount());
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(CustomizeHome, { onDone: () => {} })),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
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
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  expect(labels()[0]).toBe("Watchlist");
  const patch = ipc.argsOf("preferences.update")[0]!;
  expect(patch.homeRows?.at(-1)).toEqual({ id: "future", visible: false });
  await act(async () => held.resolve({ volume: 1, muted: false, ...patch }));
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Continue watching", "Watchlist"]);
  expect(document.activeElement).toBe(move);
  const visible = ipc.hold("preferences.update");
  await act(async () => document.querySelectorAll<HTMLInputElement>("li input")[1]!.click());
  await act(async () =>
    visible.resolve({ volume: 1, muted: false, ...ipc.argsOf("preferences.update").at(-1)! }),
  );
  await settle();
  expect(document.querySelectorAll<HTMLInputElement>("li input")[1]!.checked).toBe(true);
  const reset = ipc.hold("preferences.update");
  await act(async () => button("Reset to defaults").click());
  await act(async () =>
    reset.resolve({ volume: 1, muted: false, ...ipc.argsOf("preferences.update").at(-1)! }),
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

/** Done and reopening mount new controls around the same query client, as Home does. */
async function showReopenable() {
  ipc.reset();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function HomeControls() {
    const [open, setOpen] = useState(true);
    return open
      ? createElement(CustomizeHome, { onDone: () => setOpen(false) })
      : createElement("button", { onClick: () => setOpen(true) }, "Customize");
  }
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(TooltipProvider, null, createElement(HomeControls)),
      ),
    ),
  );
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await settle();
}

it("blocks a move during save notification and preserves the settled visibility on retry", async () => {
  await showReopenable();
  const hide = ipc.hold("preferences.update");
  await act(async () => checkbox("Watchlist").click());
  const hidden = ipc.argsOf("preferences.update")[0]!;
  hide.resolve({ volume: 1, muted: false, ...hidden });
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
  await act(async () => move.resolve({ volume: 1, muted: false, ...moved }));
  await settle();
  expect(labels().slice(0, 3)).toEqual(["Continue watching", "Watchlist", "Recommendations"]);
  expect(checkbox("Watchlist").checked).toBe(false);
});

it("blocks reopened controls until a held save settles, then retains both edits", async () => {
  await showReopenable();
  const first = ipc.hold("preferences.update");
  await act(async () => button("Move Continue watching down").click());
  const reordered = ipc.argsOf("preferences.update")[0]!;
  await act(async () => button("Done").click());
  await act(async () => button("Customize").click());
  expect(checkbox("Watchlist").disabled).toBe(true);
  expect(button("Move Watchlist down").getAttribute("aria-disabled")).toBe("true");
  await act(async () => {
    button("Move Watchlist down").click();
    button("Reset to defaults").click();
    checkbox("Watchlist").click();
  });
  expect(ipc.argsOf("preferences.update")).toHaveLength(1);
  await act(async () => first.resolve({ volume: 1, muted: false, ...reordered }));
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
  await act(async () => second.resolve({ volume: 1, muted: false, ...hidden }));
  await settle();
  expect(labels().slice(0, 2)).toEqual(["Recommendations", "Continue watching"]);
  expect(checkbox("Watchlist").checked).toBe(false);
});

it("shows a failed save after reopening, retains saved rows and allows retry then another edit", async () => {
  await showReopenable();
  const first = ipc.hold("preferences.update");
  await act(async () => checkbox("Watchlist").click());
  await act(async () => button("Done").click());
  await act(async () => button("Customize").click());
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
  await act(async () => retry.resolve({ volume: 1, muted: false, ...hidden }));
  await settle();
  expect(document.querySelector('[role="alert"]')).toBeNull();
  const next = ipc.hold("preferences.update");
  await act(async () => button("Move Watchlist up").click());
  const moved = ipc.argsOf("preferences.update")[2]!;
  await act(async () => next.resolve({ volume: 1, muted: false, ...moved }));
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
    variants: [{ id: "one", name: "Channel one", tags: [], quality: null }],
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
  ipc.always("library.channels", [channel]);
  ipc.always("library.status", []);
  ipc.always("guide.listings", {});
  ipc.always("viewing.get", {
    favourites: [channel],
    recent: [channel],
    continueWatching: [],
    marked: [],
    sequence: 0,
  });
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(HomeScreen, { active: false })),
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
  await act(async () => button("Customize").click());
  const save = async (action: () => void) => {
    const held = ipc.hold("preferences.update");
    await act(async () => action());
    await act(async () =>
      held.resolve({ ...defaultPreferences, ...ipc.argsOf("preferences.update").at(-1)! }),
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
  await act(async () => button("Done").click());
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
  ipc.always("library.channels", []);
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  unmount = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    useUi.setState(useUi.getInitialState(), true);
    measuredWidth.mockRestore();
  };
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(HomeScreen, { active: false })),
    ),
  );
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
