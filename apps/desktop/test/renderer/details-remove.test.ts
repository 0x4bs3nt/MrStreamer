// @vitest-environment happy-dom
// Remove from Continue watching in a film's details takes every version of it out, and the button
// goes once the record has it, while Resume stays; a removal that fails says why.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MovieDetails, Title } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress, Viewing } from "@mrstreamer/contracts/viewing";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { syncViewing } from "../../src/renderer/src/lib/queries.ts";

/** A film in two versions: HD, shown first, and 4K, watched halfway. */
const film: Title = {
  kind: "movie",
  key: "movie:hd",
  subscriptionId: SUBSCRIPTION,
  id: "hd",
  name: "Night Harbour 1080p (EN)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["EN", "1080p"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "603",
  genres: [],
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["EN", "1080p"] },
    { subscriptionId: SUBSCRIPTION, id: "4k", tags: ["EN", "4K"] },
  ],
};

const details: MovieDetails = {
  kind: "movie",
  title: { ...film, id: "4k" },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: 6000,
  backdropUrl: null,
};

const halfway: TitleProgress = {
  title: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "4k" },
  position: 3000,
  duration: 6000,
  finished: false,
  at: 1,
  since: 1,
};

const viewing = (sequence: number, continueWatching: readonly TitleProgress[]): Viewing => ({
  favourites: [],
  recent: [],
  continueWatching,
  marked: [],
  sequence,
});

/** Lets the sheet take in what just happened, on the fake clock. */
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));

const REMOVE = "Remove from Continue watching";

const button = (page: HTMLElement, label: string) =>
  [...page.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

/** The film's details, open with the film halfway and in Continue watching. */
async function openDetails(): Promise<HTMLElement> {
  ipc.reset();
  const listed = ipc.hold("ondemand.titles");
  const progress = ipc.hold("viewing.progress");
  const record = ipc.hold("viewing.get");
  const opened = ipc.hold("ondemand.details");
  const client = new QueryClient();
  client.setQueryData(["subscriptions"], [SAVED]);
  const stopSync = syncViewing(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(DetailsView, {
          target: { kind: "movie", subscriptionId: SUBSCRIPTION, id: "hd" },
        }),
      ),
    ),
  );
  unmount = () => {
    stopSync();
    act(() => root.unmount());
    container.remove();
  };
  await act(async () => listed.resolve([film]));
  await act(async () => progress.resolve([halfway]));
  await act(async () => record.resolve(viewing(5, [halfway])));
  await settle();
  await act(async () => opened.resolve(details));
  // The sheet draws its actions once the details and the record are in.
  for (let tries = 0; tries < 50 && !button(document.body, REMOVE); tries++) await settle();
  return document.body;
}

describe("Remove from Continue watching in a film's details", () => {
  it("takes every version out, and goes once the record has it while Resume stays", async () => {
    const page = await openDetails();
    const removal = ipc.hold("viewing.removeFromContinue");
    // What the change notice reads again.
    const record = ipc.hold("viewing.get");
    const progress = ipc.hold("viewing.progress");

    await act(async () => button(page, REMOVE)?.click());
    await settle();
    expect(ipc.argsOf("viewing.removeFromContinue")).toEqual([
      {
        commandId: expect.any(String),
        titles: {
          movies: [
            { subscriptionId: SUBSCRIPTION, id: "hd" },
            { subscriptionId: SUBSCRIPTION, id: "4k" },
          ],
        },
      },
    ]);

    await act(async () => removal.resolve(viewing(6, [])));
    await act(async () => ipc.emit("viewing.changed", { sequence: 6 }));
    await act(async () => record.resolve(viewing(6, [])));
    await act(async () => progress.resolve([halfway]));
    await settle();

    expect(button(page, REMOVE)).toBeUndefined();
    expect(button(page, "Resume")).toBeDefined();
  });

  it("says why a removal failed, and keeps the button", async () => {
    const page = await openDetails();
    const removal = ipc.hold("viewing.removeFromContinue");

    await act(async () => button(page, REMOVE)?.click());
    await act(async () => removal.reject({ kind: "unexpected", detail: "database is locked" }));
    await settle();

    expect(page.textContent).toContain("Something went wrong: database is locked");
    expect(button(page, REMOVE)).toBeDefined();
  });
});
