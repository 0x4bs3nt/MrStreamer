// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  MovieDetails,
  OnDemandStatus,
  OnDemandUpdate,
  RelatedTitles as Related,
  Title,
} from "@mrstreamer/contracts/ondemand";
import { RelatedTitles } from "../../src/renderer/src/features/titles/RelatedTitles.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

const movie = (id: string): Title => ({
  kind: "movie",
  key: `movie:${id}`,
  subscriptionId: SUBSCRIPTION,
  id,
  name: id,
  title: id,
  originalTitle: null,
  originalLanguage: null,
  tags: [],
  year: 2020,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: null,
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id, tags: [] }],
});
const details = (id: string): MovieDetails => ({
  kind: "movie",
  title: movie(id),
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
});
/** What the main process tells of the lists fetched at `fetchedAt`, and of TMDB's answers. */
const lists = (fetchedAt: number, known = 0): OnDemandStatus => ({
  lists: [{ subscriptionId: SUBSCRIPTION, movies: 3, series: 0, fetchedAt, failure: null }],
  metadata: { known, wanted: 3, refused: false, fetching: known < 3 },
});
const picks = (...names: string[]): Related => ({
  basis: "Drama",
  titles: names.map((name) => ({ title: movie(name), reason: "Drama" })),
});
/** The picks the row offers to open. */
const offered = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((button) => button.textContent);
let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  ipc.reset();
  useUi.setState({ details: null });
  vi.useRealTimers();
});

async function mount(opened = "opened", switching = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  const stop = syncOnDemand(client);
  const mounted = queryView(client);
  const { container } = mounted;
  const render = (id: string, switching: boolean) =>
    mounted.render(
      createElement(RelatedTitles, {
        details: details(id),
        switching,
        here: (related) => ({ season: null, scroll: 0, related }),
      }),
    );
  cleanup = () => {
    stop();
    mounted.unmount();
  };
  await render(opened, switching);
  // Lets the list's timers and answers run on the fake clock until `check` passes.
  const until = async (check: () => void) =>
    vi.waitFor(
      async () => {
        await act(() => vi.advanceTimersByTimeAsync(10));
        check();
      },
      { interval: 1 },
    );
  /** Closes the details the row is part of, as Close or Settings does. */
  const close = () => mounted.render();
  /** Sends `ondemand.updated`, and lets the views take it in while nothing else answers. */
  const updated = async (status: OnDemandUpdate) => {
    await act(async () => ipc.emit("ondemand.updated", status));
    await act(() => vi.advanceTimersByTimeAsync(50));
  };
  return { container, render, until, close, updated };
}

it("opens an available exact version without repeating its heading basis, then refreshes after catalogue changes", async () => {
  ipc.always("ondemand.related", {
    basis: "Drama · Dutch",
    titles: [
      { title: movie("Harbour Lights"), reason: "Drama · Dutch" },
      { title: movie("Neighbour"), reason: "Drama" },
    ],
  });
  const { container, until } = await mount();
  await until(() => expect(container.textContent).toContain("Harbour Lights"));
  expect(container.textContent?.match(/Drama · Dutch/g)).toHaveLength(1);
  expect(container.textContent).toContain("Harbour Lights2020");
  expect(container.textContent).toContain("2020 · Drama");
  expect(ipc.argsOf("ondemand.related")).toEqual([
    { kind: "movie", version: { subscriptionId: SUBSCRIPTION, id: "opened" } },
  ]);
  await act(async () => container.querySelector("button")?.click());
  expect(useUi.getState().details).toMatchObject({
    kind: "movie",
    subscriptionId: SUBSCRIPTION,
    id: "Harbour Lights",
  });
  ipc.always("ondemand.related", { basis: null, titles: [] });
  await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
  await until(() => expect(container.textContent).toContain("Nothing like it in your lists yet."));
  expect(container.querySelector("button")).toBeNull();
  expect(
    ipc
      .methods()
      .some(
        (method) =>
          method === "ondemand.details" ||
          method === "ondemand.collection" ||
          method === "playback.openTitle",
      ),
  ).toBe(false);
});

it("waits for a version change and never leaves another version's picks clickable", async () => {
  ipc.always("ondemand.related", {
    basis: "Same category",
    titles: [{ title: movie("local"), reason: "Same category" }],
  });
  const { container, render, until } = await mount("first", true);
  expect(ipc.argsOf("ondemand.related")).toHaveLength(0);
  await render("first", false);
  await until(() => expect(container.textContent).toContain("local"));
  const held = ipc.hold("ondemand.related");
  await render("second", false);
  expect(container.querySelector("button")).toBeNull();
  await act(async () => held.resolve({ basis: null, titles: [] }));
  await until(() =>
    expect(container.textContent).toContain(
      "Titles here come from your subscriptions, not from the web.",
    ),
  );
});

it("distinguishes a read failure from no matches", async () => {
  ipc.refuse("ondemand.related", { kind: "unexpected", detail: "worker unavailable" });
  const { container, until } = await mount();
  await until(() => expect(container.textContent).toContain("Related titles couldn't be read."));
  expect(container.textContent).not.toContain("Nothing like it");
});

// Only the lists say which titles are for adults, and a refresh can mark one that a row read
// before still names. The main process leaves those out of every new answer.

it("opens again without the picks of lists that were refreshed since, until their answer", async () => {
  ipc.always("ondemand.related", picks("Later For Adults", "Neighbour"));
  const { container, render, until, close, updated } = await mount();
  await until(() => expect(offered(container).join()).toContain("Later For Adults"));
  await updated(lists(1));
  await until(() => expect(offered(container).join()).toContain("Later For Adults"));
  await close();
  // Settings refreshed the lists while the details were closed.
  await updated(lists(2));
  const reread = ipc.hold("ondemand.related");
  await render("opened", false);
  expect(offered(container).join()).not.toContain("Later For Adults");
  expect(container.textContent).toContain("Loading related titles…");
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(offered(container).join()).not.toContain("Later For Adults");
  await act(async () => reread.resolve(picks("Neighbour")));
  await until(() => expect(offered(container).join()).toContain("Neighbour"));
  expect(offered(container).join()).not.toContain("Later For Adults");
});

it("takes an open row's picks away as the lists change, before its new answer", async () => {
  ipc.always("ondemand.related", picks("Later For Adults", "Neighbour"));
  const { container, until, updated } = await mount();
  await updated(lists(1));
  await until(() => expect(offered(container).join()).toContain("Later For Adults"));
  const reread = ipc.hold("ondemand.related");
  await updated(lists(2));
  expect(offered(container)).toEqual([]);
  expect(container.textContent).toContain("Loading related titles…");
  await act(async () => reread.resolve(picks("Neighbour")));
  await until(() => expect(offered(container).join()).toContain("Neighbour"));
  expect(offered(container).join()).not.toContain("Later For Adults");
});

it("keeps picks while new metadata is read, and drops them and that late answer once the lists change", async () => {
  ipc.always("ondemand.related", picks("Later For Adults", "Neighbour"));
  const { container, until, updated } = await mount();
  await updated(lists(1));
  await until(() => expect(offered(container).join()).toContain("Later For Adults"));
  // TMDB's answers alone: the same lists, so the row stays on screen while it is read again.
  const late = ipc.hold("ondemand.related");
  await updated(lists(1, 2));
  expect(offered(container).join()).toContain("Later For Adults");
  expect(offered(container).join()).toContain("Neighbour");
  const current = ipc.hold("ondemand.related");
  await updated(lists(2, 2));
  expect(offered(container)).toEqual([]);
  // What the earlier lists answered arrives after they changed.
  await act(async () => late.resolve(picks("Later For Adults", "Neighbour")));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(offered(container).join()).not.toContain("Later For Adults");
  await act(async () => current.resolve(picks("Neighbour")));
  await until(() => expect(offered(container).join()).toContain("Neighbour"));
  expect(offered(container).join()).not.toContain("Later For Adults");
  expect(ipc.argsOf("ondemand.related")).toHaveLength(4);
});

// The worker's clock can give two accepted lists the same fetch time, so only the update's own
// word says that new lists marked a title for adults.

it("takes picks away once an update says lists marked one for adults, even at the same fetch time", async () => {
  ipc.always("ondemand.related", picks("Later For Adults", "Neighbour"));
  const { container, until, updated } = await mount();
  await updated(lists(1));
  await until(() => expect(offered(container).join()).toContain("Later For Adults"));
  // TMDB's answers alone keep the picks while they are read again.
  const late = ipc.hold("ondemand.related");
  await updated(lists(1, 2));
  expect(offered(container).join()).toContain("Later For Adults");
  const current = ipc.hold("ondemand.related");
  await updated({ ...lists(1, 2), markedForAdults: true });
  expect(offered(container)).toEqual([]);
  expect(container.textContent).toContain("Loading related titles…");
  // What the earlier lists answered arrives after they marked it.
  await act(async () => late.resolve(picks("Later For Adults", "Neighbour")));
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(offered(container).join()).not.toContain("Later For Adults");
  await act(async () => current.resolve(picks("Neighbour")));
  await until(() => expect(offered(container).join()).toContain("Neighbour"));
  expect(offered(container).join()).not.toContain("Later For Adults");
  expect(ipc.argsOf("ondemand.related")).toHaveLength(4);
});

it("opens again without picks once an update marked one for adults at the same fetch time", async () => {
  ipc.always("ondemand.related", picks("Later For Adults", "Neighbour"));
  const { container, render, until, close, updated } = await mount();
  await updated(lists(1));
  await until(() => expect(offered(container).join()).toContain("Later For Adults"));
  await close();
  await updated({ ...lists(1), markedForAdults: true });
  const reread = ipc.hold("ondemand.related");
  await render("opened", false);
  expect(offered(container).join()).not.toContain("Later For Adults");
  expect(container.textContent).toContain("Loading related titles…");
  await act(async () => reread.resolve(picks("Neighbour")));
  await until(() => expect(offered(container).join()).toContain("Neighbour"));
  expect(offered(container).join()).not.toContain("Later For Adults");
});
