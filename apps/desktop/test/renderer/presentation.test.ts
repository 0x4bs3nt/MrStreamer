// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultPreferences } from "@mrstreamer/contracts/preferences";
import { homeRows } from "@mrstreamer/core/home/rows";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { useNow } from "../../src/renderer/src/lib/clock.ts";
import { PresentationVisible } from "../../src/renderer/src/lib/presentation.ts";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { NowPlayingBar } from "../../src/renderer/src/features/watch/NowPlaying.tsx";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import type { Title } from "@mrstreamer/contracts/ondemand";

let cleanup = () => {};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});

function Clock({ name }: { name: string }) {
  return createElement("output", { "aria-label": name }, String(useNow()));
}

it("keeps a covered page's clock still while Watch advances and refreshes on return", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
  };
  const render = (visible: boolean) =>
    act(() =>
      root.render(
        createElement(
          "div",
          null,
          createElement(
            PresentationVisible,
            { value: visible },
            createElement(Clock, { name: "page" }),
          ),
          createElement(Clock, { name: "Watch" }),
        ),
      ),
    );
  vi.setSystemTime(100_000);
  render(true);
  render(false);
  const held = container.querySelector('[aria-label="page"]')?.textContent;
  await act(() => vi.advanceTimersByTimeAsync(75_000));
  expect(container.querySelector('[aria-label="page"]')?.textContent).toBe(held);
  expect(Number(container.querySelector('[aria-label="Watch"]')?.textContent)).toBeGreaterThan(
    Number(held),
  );
  render(true);
  expect(Number(container.querySelector('[aria-label="page"]')?.textContent)).toBe(Date.now());
});

it("skips disabled Home title rows even before saved preferences answer, then reads an enabled row", async () => {
  const preferences = ipc.hold("preferences.get");
  const saved = {
    ...defaultPreferences,
    homeRows: homeRows(undefined).map((row) => ({ ...row, visible: false })),
  };
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", []);
  ipc.always("library.browse", browseResult([]));
  ipc.always("library.status", []);
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    continueWatching: [progress(film.id)],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.collection", { name: "New movies", total: 0, titles: [] });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(HomeScreen, { active: false })),
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(ipc.argsOf("ondemand.collection")).toEqual([]);
  expect(ipc.argsOf("ondemand.titles")).toEqual([]);
  await act(async () => preferences.resolve(ipc.snapshot(saved)));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(ipc.argsOf("ondemand.collection")).toEqual([]);
  expect(ipc.argsOf("watchlist.list")).toEqual([]);
  expect(ipc.argsOf("ondemand.recommendations")).toEqual([]);
  expect(ipc.argsOf("ondemand.titles")).toEqual([]);
  ipc.prefer({
    homeRows: saved.homeRows.map((row) => ({ ...row, visible: row.id === "new-movies" })),
  });
  await act(async () => client.invalidateQueries({ queryKey: ["preferences"] }));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(ipc.argsOf("ondemand.collection").map((query) => query.kind)).toEqual(["movie"]);
});

const film: Title = {
  kind: "movie",
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
const progress = (id: string) => ({
  title: { kind: "movie" as const, subscriptionId: SUBSCRIPTION, id },
  position: 500,
  duration: 1000,
  finished: false,
  at: 1,
  since: 1,
});

async function showContinuingHome() {
  const channels = ["one", "two"].map((id) => ({
    subscriptionId: SUBSCRIPTION,
    id,
    name: `Channel ${id}`,
    title: `Channel ${id}`,
    tags: [],
    number: null,
    logoUrl: null,
    categoryIds: [],
    catchupDays: null,
    variants: [{ id, name: `Channel ${id}`, tags: [], quality: null }],
  }));
  const viewing = {
    favourites: [channels[1]!],
    recent: [],
    continueWatching: [progress(film.id)],
    marked: [],
    sequence: 0,
  };
  ipc.prefer({
    homeRows: homeRows(undefined).map((row) => ({ ...row, visible: row.id === "continue" })),
  });
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", []);
  ipc.answer("library.browse", ({ scope }) =>
    browseResult(
      scope.kind === "channels"
        ? channels.filter((channel) => scope.channels.some(({ id }) => id === channel.id))
        : channels,
    ),
  );
  ipc.always("library.status", []);
  ipc.always("viewing.get", viewing);
  ipc.always("ondemand.titles", [film]);
  ipc.always("guide.listings", {});
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  const render = async (visible: boolean) => {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            TooltipProvider,
            null,
            createElement(
              Fragment,
              null,
              createElement(
                PresentationVisible,
                { value: visible },
                createElement(HomeScreen, { active: false }),
              ),
              !visible &&
                createElement(NowPlayingBar, {
                  visible: true,
                  channel: channels[0]!,
                  categories: new Map(),
                  menu: null,
                  keyboardMenu: false,
                  fullscreen: false,
                  onMenu: () => {},
                  onToggleFullscreen: () => {},
                  onOpenChannels: () => {},
                  onSwitch: () => {},
                }),
            ),
          ),
        ),
      ),
    );
    await act(() => vi.advanceTimersByTimeAsync(50));
  };
  await render(true);
  return { client, container, render, viewing };
}

it("retains Continue's data, controls and title key beyond GC while covered and refetching on return", async () => {
  const { client, container, render } = await showContinuingHome();
  const control = container.querySelector<HTMLButtonElement>('button[title="Continuing film"]')!;
  expect(control).not.toBeNull();
  control.focus();
  const page = container.firstElementChild!;
  page.scrollTop = 280;
  const key = queries.continuing("movie", [film]).queryKey;
  const query = client.getQueryCache().find({ queryKey: key });
  const data = client.getQueryData(key);
  await render(false);
  await act(async () => client.invalidateQueries({ queryKey: key }));
  const titleCalls = ipc.argsOf("ondemand.titles").length;
  const homePolls = ipc
    .argsOf("guide.listings")
    .filter(({ channels }) => channels.length > 1).length;
  const watchPolls = ipc
    .argsOf("guide.listings")
    .filter(({ channels }) => channels.length === 1).length;
  expect(homePolls).toBeGreaterThan(0);
  expect(watchPolls).toBeGreaterThan(0);
  await act(() => vi.advanceTimersByTimeAsync(310_000));
  expect(ipc.argsOf("ondemand.titles")).toHaveLength(titleCalls);
  expect(ipc.argsOf("guide.listings").filter(({ channels }) => channels.length > 1)).toHaveLength(
    homePolls,
  );
  expect(
    ipc.argsOf("guide.listings").filter(({ channels }) => channels.length === 1).length,
  ).toBeGreaterThanOrEqual(watchPolls + 2);
  expect(client.getQueryCache().find({ queryKey: key })).toBe(query);
  expect(client.getQueryData(key)).toBe(data);
  expect(container.querySelector('button[title="Continuing film"]')).toBe(control);
  const pending = ipc.hold("ondemand.titles");
  await render(true);
  expect(ipc.argsOf("ondemand.titles")).toHaveLength(titleCalls + 1);
  expect(container.querySelector('button[title="Continuing film"]')).toBe(control);
  expect(document.activeElement).toBe(control);
  expect(page.scrollTop).toBe(280);
  await act(async () => pending.resolve([film]));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(container.querySelector('button[title="Continuing film"]')).toBe(control);
});

it("retains the existing Continue control when a new play changes its disabled query while covered", async () => {
  const { client, container, render, viewing } = await showContinuingHome();
  const control = container.querySelector<HTMLButtonElement>('button[title="Continuing film"]')!;
  control.focus();
  await render(false);
  const titleCalls = ipc.argsOf("ondemand.titles").length;
  ipc.always("viewing.get", {
    ...viewing,
    continueWatching: [...viewing.continueWatching, progress("new")],
    sequence: 1,
  });
  await act(async () => client.invalidateQueries({ queryKey: queries.viewing().queryKey }));
  await act(() => vi.advanceTimersByTimeAsync(50));
  await act(() => vi.advanceTimersByTimeAsync(310_000));
  expect(ipc.argsOf("ondemand.titles")).toHaveLength(titleCalls);
  expect(container.querySelector('button[title="Continuing film"]')).toBe(control);
  const key = queries.continuing("movie", [
    film,
    { subscriptionId: SUBSCRIPTION, id: "new" },
  ]).queryKey;
  expect(client.getQueryCache().find({ queryKey: key })).toBeDefined();
  const pending = ipc.hold("ondemand.titles");
  await render(true);
  expect(
    ipc
      .argsOf("ondemand.titles")
      .at(-1)
      ?.versions.map(({ id }) => id),
  ).toEqual(["film", "new"]);
  expect(container.querySelector('button[title="Continuing film"]')).toBe(control);
  expect(document.activeElement).toBe(control);
  await act(async () => pending.resolve([film]));
});

it("accepts an already pending title read while Home is covered and keeps it through GC and return", async () => {
  const pending = ipc.hold("ondemand.titles");
  const { client, container, render } = await showContinuingHome();
  expect(container.querySelector('button[title="Continuing film"]')).toBeNull();
  await render(false);
  await act(async () => pending.resolve([film]));
  await act(() => vi.advanceTimersByTimeAsync(50));
  const control = container.querySelector<HTMLButtonElement>('button[title="Continuing film"]');
  expect(control).not.toBeNull();
  const key = queries.continuing("movie", [film]).queryKey;
  await act(async () => client.invalidateQueries({ queryKey: key }));
  const calls = ipc.argsOf("ondemand.titles").length;
  await act(() => vi.advanceTimersByTimeAsync(310_000));
  expect(ipc.argsOf("ondemand.titles")).toHaveLength(calls);
  const returning = ipc.hold("ondemand.titles");
  await render(true);
  expect(container.querySelector('button[title="Continuing film"]')).toBe(control);
  await act(async () => returning.resolve([film]));
});
