// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});

it("shows a mapped series' current exact progress, then drops its bar when that file is replaced", async () => {
  const subscription = { ...SAVED, kind: "m3u" as const, playlistMapped: true, username: "" };
  const series: Title = {
    kind: "series",
    key: "series:m3u",
    subscriptionId: subscription.id,
    id: "series",
    name: "Playlist show",
    title: "Playlist show",
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
    versions: [
      {
        subscriptionId: subscription.id,
        id: "series",
        tags: [],
        episodeFiles: ["original", "alternate"],
      },
    ],
  };
  ipc.always("subscription.list", [subscription]);
  ipc.always("library.categories", []);
  ipc.always("library.channels", []);
  ipc.always("library.status", []);
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    marked: [],
    sequence: 1,
    continueWatching: [
      {
        title: {
          kind: "episode",
          subscriptionId: subscription.id,
          id: "alternate",
          seriesId: "series",
          season: 2,
          episode: 3,
        },
        position: 500,
        duration: 1000,
        finished: false,
        at: 2,
        since: 1,
      },
    ],
  });
  ipc.always("ondemand.titles", [series]);
  ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [subscription]);
  const stop = syncOnDemand(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanup = () => {
    stop();
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await act(async () =>
    root.render(
      createElement(QueryClientProvider, { client }, createElement(HomeScreen, { active: false })),
    ),
  );
  const until = (check: () => void) =>
    vi.waitFor(async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    });
  await until(() => expect(container.textContent).toContain("S2 E3"));
  expect(
    [...container.querySelectorAll<HTMLElement>("span[style]")].some(
      (element) => element.style.width === "50%",
    ),
  ).toBe(true);
  ipc.always("ondemand.titles", [
    { ...series, versions: [{ ...series.versions[0]!, episodeFiles: ["replacement"] }] },
  ]);
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  await until(() => expect(container.textContent).toContain("Next episode"));
  expect(container.textContent).not.toContain("S2 E3");
  expect(
    [...container.querySelectorAll<HTMLElement>("span[style]")].some(
      (element) => element.style.width === "50%",
    ),
  ).toBe(false);
  expect(ipc.argsOf("ondemand.details")).toHaveLength(0);
});

it("shows mapped titles without live channels or invented added dates, and opens their full list", async () => {
  const subscription = { ...SAVED, kind: "m3u" as const, playlistMapped: true, username: "" };
  const title: Title = {
    kind: "movie",
    key: "movie:exact",
    subscriptionId: subscription.id,
    id: "exact",
    name: "Playlist film",
    title: "Playlist film",
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
    versions: [{ subscriptionId: subscription.id, id: "exact", tags: [] }],
  };
  ipc.always("subscription.list", [subscription]);
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
  ipc.always("ondemand.collection", { name: "All", total: 1, titles: [title] });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [subscription]);
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
  await vi.waitFor(async () => {
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(container.textContent).toContain("Playlist film");
  });
  expect(container.textContent).not.toContain("No live channels");
  const navigation = container.querySelector("header");
  expect(navigation?.textContent).toContain("Movies");
  expect(navigation?.textContent).toContain("Series");
  expect(navigation?.textContent).toContain("Watchlist");
  const watchlist = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Watchlist",
  );
  expect(watchlist).toBeDefined();
  await act(async () => watchlist?.click());
  expect(useUi.getState().view).toBe("watchlist");
  expect(ipc.argsOf("ondemand.collection").every((query) => query.id === "all")).toBe(true);
  expect(ipc.argsOf("watchlist.list")).toHaveLength(1);
  const heading = [...container.querySelectorAll("h2")].find(
    (element) => element.textContent === "Movies",
  );
  const movies = heading?.closest("section")?.querySelector("button");
  expect(movies).toBeDefined();
  await act(async () => movies?.click());
  expect(useUi.getState().view).toBe("movies");
});
