// @vitest-environment happy-dom
// A series' details list the provider's episodes at once, and TMDB's details for the season
// shown once they come: the other seasons ask for nothing until their tab opens. The sheet shows
// the title from the lists while the provider answers, and TMDB's details once they arrive.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Episode, SeriesDetails, Title } from "@mrstreamer/contracts/ondemand";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

/** The series version these tests open, as requests name it. */
const HARBOUR = { subscriptionId: SUBSCRIPTION, id: "harbour" };

const series: Title = {
  kind: "series",
  key: "series:harbour",
  subscriptionId: SUBSCRIPTION,
  id: "harbour",
  name: "Night Harbour (NL)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "nl",
  tags: ["NL"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "90000",
  genres: [],
  versions: [{ subscriptionId: SUBSCRIPTION, id: "harbour", tags: ["NL"] }],
};

/** What the provider says about an episode: a number and a length. */
const episode = (season: number, number: number): Episode => ({
  subscriptionId: SUBSCRIPTION,
  id: `${season}-${number}`,
  seriesId: "harbour",
  season,
  number,
  title: `Episode ${number}`,
  plot: null,
  duration: 2700,
  stillUrl: null,
  airDate: null,
});

const details: SeriesDetails = {
  kind: "series",
  title: series,
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [1, 2].map((number) => ({
    number,
    name: `Season ${number}`,
    posterUrl: null,
    episodes: [episode(number, 1), episode(number, 2)],
  })),
};

let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
});

const text = () => document.body.textContent ?? "";
/** Waits until `check` passes, moving the fake clock so React Query passes the answers on. */
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      check();
    },
    // A busy suite can take a while; a stuck sheet still fails.
    { timeout: 5000 },
  );

describe("a series' episodes", () => {
  it("show TMDB's details for the season shown, and ask for another only once it opens", async () => {
    ipc.reset();
    const listed = ipc.hold("ondemand.titles");
    const progress = ipc.hold("viewing.progress");
    const opened = ipc.hold("ondemand.details");
    const season = ipc.hold("ondemand.season");
    const client = new QueryClient();
    client.setQueryData(["subscriptions"], [SAVED]);
    const stopSync = syncOnDemand(client);
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(DetailsView, {
            target: { kind: "series", subscriptionId: SUBSCRIPTION, id: "harbour" },
          }),
        ),
      ),
    );
    unmount = () => {
      stopSync();
      act(() => root.unmount());
    };
    await act(async () => listed.resolve([series]));
    await act(async () => progress.resolve([]));
    await act(async () => opened.resolve(details));

    // The provider's episodes, with nothing made up while TMDB answers.
    await until(() => {
      expect(text()).toContain("Episode 2");
      expect(ipc.argsOf("ondemand.season")).toEqual([{ series: HARBOUR, season: 1 }]);
    });
    expect(text()).not.toContain("★");
    expect(text()).not.toContain("Directed by");

    // Catalogue metadata does not interrupt the open season or reread its provider details.
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    expect(ipc.argsOf("ondemand.details")).toHaveLength(1);
    expect(ipc.argsOf("ondemand.season")).toHaveLength(1);

    await act(async () =>
      season.resolve([
        {
          ...episode(1, 1),
          title: "The Ferry",
          plot: "Mara takes the night ferry.",
          airDate: "2024-03-05",
          rating: 7.4,
          cast: [
            { name: "Ana Costa", role: "Mara", photoUrl: null },
            { name: "Joris Wouters", role: "Ben", photoUrl: null },
            { name: "Eva Vos", role: "Radio", photoUrl: null },
          ],
          directors: ["Lotte Smit"],
        },
        // TMDB knew nothing more about this one.
        { ...episode(1, 2), rating: null, cast: [], directors: [] },
      ]),
    );

    await until(() => expect(text()).toContain("The Ferry"));
    expect(text()).toContain("★ 7.4");
    expect(text()).toContain("Mara takes the night ferry.");
    expect(text()).toContain("Directed by Lotte Smit · With Ana Costa, Joris Wouters");
    expect(text()).not.toContain("Eva Vos");
    expect(text()).toContain("Episode 2");
    expect(ipc.argsOf("ondemand.season")).toHaveLength(1);

    const tab = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Season 2",
    );
    await act(async () => tab?.click());

    await until(() => expect(ipc.argsOf("ondemand.season")).toHaveLength(2));
    expect(ipc.argsOf("ondemand.season")).toEqual([
      { series: HARBOUR, season: 1 },
      { series: HARBOUR, season: 2 },
    ]);
  });
});

describe("a series' details", () => {
  it("head the sheet with the listed title at once, and take TMDB's once they arrive", async () => {
    ipc.reset();
    const listed = ipc.hold("ondemand.titles");
    const progress = ipc.hold("viewing.progress");
    const provider = ipc.hold("ondemand.details");
    const withTmdb = ipc.hold("ondemand.details");
    const client = new QueryClient();
    client.setQueryData(["subscriptions"], [SAVED]);
    const stopSync = syncOnDemand(client);
    const root = createRoot(document.createElement("div"));
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(DetailsView, {
            target: { kind: "series", subscriptionId: SUBSCRIPTION, id: "harbour" },
          }),
        ),
      ),
    );
    unmount = () => {
      stopSync();
      act(() => root.unmount());
    };
    await act(async () => listed.resolve([series]));
    await act(async () => progress.resolve([]));

    // The lists' title while the provider answers.
    await until(() => expect(text()).toContain("Night Harbour"));
    expect(text()).toContain("2024");
    expect(text()).toContain("Loading…");

    // The first provider answer still belongs to the open details after a catalogue update.
    await act(async () => ipc.emit("ondemand.updated", { lists: [], metadata: null }));
    await act(async () => provider.resolve({ ...details, plot: "All about Night Harbour." }));
    await until(() => expect(text()).toContain("All about Night Harbour."));
    expect(ipc.argsOf("ondemand.details")).toHaveLength(1);
    expect(text()).toContain("Episode 2");

    // TMDB's arrive after the provider's: the main process says so, and the sheet reads them.
    await act(async () =>
      ipc.emit("ondemand.detailsChanged", {
        kind: "series",
        subscriptionId: SUBSCRIPTION,
        id: "harbour",
      }),
    );
    await act(async () => withTmdb.resolve({ ...details, plot: "TMDB's story of Night Harbour." }));
    await until(() => expect(text()).toContain("TMDB's story of Night Harbour."));
    expect(text()).not.toContain("All about Night Harbour.");
  });
});
