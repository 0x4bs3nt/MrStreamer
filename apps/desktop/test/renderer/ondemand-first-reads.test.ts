// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { HomeScreen } from "../../src/renderer/src/features/home/HomeScreen.tsx";
import { TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

const movie = (name: string): Title => ({
  kind: "movie",
  key: "movie:1",
  subscriptionId: SUBSCRIPTION,
  id: "1",
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
  adult: false,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: "1", tags: [] }],
});
const page = (name: string) => ({ name: "All", total: 1, titles: [movie(name)] });
const rows = (name: string) => [{ id: "popular" as const, ...page(name) }];

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

async function mount(home: boolean) {
  const subscription = home ? { ...SAVED, kind: "m3u" as const, playlistMapped: true } : SAVED;
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
  ipc.always("ondemand.status", { lists: [], metadata: null });
  ipc.always("watchlist.list", { total: 0, entries: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [subscription]);
  const stop = syncOnDemand(client);
  const mounted = queryView(client);
  const { container } = mounted;
  cleanup = () => {
    stop();
    mounted.unmount();
  };
  await mounted.render(
    home
      ? createElement(HomeScreen, { active: false })
      : createElement(TitlesPage, { kind: "movie", active: false }),
  );
  const click = async (label: string) => {
    await until(() =>
      expect(
        [...container.querySelectorAll("button")].some((each) => each.textContent === label),
      ).toBe(true),
    );
    const button = [...container.querySelectorAll("button")].find(
      (each) => each.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  // TitlesPage remembers its last tab across mounts, just as it does in the app.
  if (!home) await click("For you");
  return { container, click };
}

it.each(["Home", "For you", "All movies"] as const)(
  "%s shows the current catalogue when it changes during the first read, ignoring its late old answer",
  async (entry) => {
    ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
    ipc.always("ondemand.rows", []);
    const firstCollection = entry === "Home" ? ipc.hold("ondemand.collection") : null;
    const firstRows = entry === "For you" ? ipc.hold("ondemand.rows") : null;
    const view = await mount(entry === "Home");
    const allCollection = entry === "All movies" ? ipc.hold("ondemand.collection") : null;
    if (allCollection) await view.click("All movies");
    const method = firstRows ? "ondemand.rows" : "ondemand.collection";
    await until(() => expect(ipc.argsOf(method).length).toBeGreaterThan(0));
    const before = ipc.argsOf(method).length;
    ipc.always("ondemand.collection", page("Current catalogue"));
    ipc.always("ondemand.rows", rows("Current catalogue"));
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await act(async () => {
      (firstCollection ?? allCollection)?.resolve(page("Old catalogue"));
      firstRows?.resolve(rows("Old catalogue"));
    });
    await until(() => {
      const shown =
        entry === "Home"
          ? [...view.container.querySelectorAll("h2")]
              .find((heading) => heading.textContent === "Movies")
              ?.closest("section")?.textContent
          : view.container.textContent;
      expect(shown).toContain("Current catalogue");
      expect(shown).not.toContain("Old catalogue");
      expect(ipc.argsOf(method).length).toBeGreaterThan(before);
    });
  },
);

it("keeps Home's cached posters visible while a changed catalogue is being read", async () => {
  ipc.always("ondemand.collection", page("Cached catalogue"));
  const view = await mount(true);
  await until(() => expect(view.container.textContent).toContain("Cached catalogue"));
  const refreshed = ipc.hold("ondemand.collection");
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  expect(view.container.textContent).toContain("Cached catalogue");
  await act(async () => refreshed.resolve(page("Current catalogue")));
  await until(() =>
    expect(
      [...view.container.querySelectorAll("h2")]
        .find((heading) => heading.textContent === "Movies")
        ?.closest("section")?.textContent,
    ).toContain("Current catalogue"),
  );
});
