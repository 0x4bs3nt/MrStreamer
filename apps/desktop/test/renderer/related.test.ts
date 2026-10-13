// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MovieDetails, Title } from "@mrstreamer/contracts/ondemand";
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
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (id: string, switching: boolean) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(RelatedTitles, { details: details(id), switching }),
        ),
      ),
    );
  cleanup = () => {
    stop();
    act(() => root.unmount());
    client.clear();
    container.remove();
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
  return { container, render, until };
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
