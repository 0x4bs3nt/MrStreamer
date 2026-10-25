// @vitest-environment happy-dom
// A series' details list the provider's episodes at once, and TMDB's details for the season
// shown once they come: the other seasons ask for nothing until their tab opens. The sheet shows
// the title from the lists while the provider answers, and TMDB's details once they arrive.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Episode, SeriesDetails, Title } from "@mrstreamer/contracts/ondemand";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { syncOnDemand } from "../../src/renderer/src/lib/queries.ts";
import { syncDownloads } from "../../src/renderer/src/lib/downloads.ts";

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

it("leaves episode selection alone on other-file progress and updates its own facts, still and action", async () => {
  ipc.reset();
  const file: Download = {
    id: "copy",
    title: { kind: "episode", id: "1-1", seriesId: "harbour", season: 1, episode: 1 },
    subscription: { id: SUBSCRIPTION, name: "Fixture" },
    name: "Night Harbour",
    episodeName: "Episode 1",
    year: 2024,
    duration: 2700,
    originalLanguage: "nl",
    posterUrl: null,
    wideUrl: null,
    size: 100,
    status: { kind: "transferring", received: 20, size: 100, rate: null, restarted: false },
    progress: null,
    series: null,
  };
  const list = (items: readonly Download[]): DownloadList => ({
    items,
    series: {},
    bytes: 0,
    free: null,
    ended: 0,
  });
  const other = { ...file, id: "other", title: { kind: "movie" as const, id: "unrelated" } };
  ipc.always("ondemand.titles", [series]);
  ipc.always("ondemand.details", details);
  ipc.always(
    "ondemand.season",
    details.seasons[0]!.episodes.map((episode) => ({
      ...episode,
      rating: null,
      cast: [],
      directors: [],
    })),
  );
  ipc.always("viewing.progress", []);
  ipc.always("downloads.list", list([other]));
  ipc.always("downloads.remove", null);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [SAVED]);
  const stop = syncDownloads(client);
  const root = createRoot(document.createElement("div"));
  let commits = 0;
  unmount = () => {
    stop();
    act(() => root.unmount());
    client.clear();
  };
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Profiler,
          {
            id: "details",
            onRender: () => {
              commits++;
            },
          },
          createElement(DetailsView, {
            target: { kind: "series", subscriptionId: SUBSCRIPTION, id: "harbour" },
          }),
        ),
      ),
    ),
  );
  await until(() => expect(text()).toContain("Episode 2"));
  await act(() => vi.advanceTimersByTimeAsync(50));
  commits = 0;
  await act(async () =>
    ipc.emit(
      "downloads.changed",
      list([
        {
          ...other,
          status: {
            kind: "transferring",
            received: 42,
            size: 100,
            rate: null,
            restarted: false,
          },
        },
      ]),
    ),
  );
  await act(() => vi.advanceTimersByTimeAsync(50));
  expect(commits).toBe(0);
  expect(text()).not.toContain("Downloading");
  await act(async () => ipc.emit("downloads.changed", list([file, other])));
  await until(() => expect(text()).toContain("Downloading 20%"));
  const cancel = document.querySelector<HTMLButtonElement>(
    '[aria-label="Cancel download of S1 E1"]',
  );
  expect(cancel).not.toBeNull();
  const row = cancel!.parentElement!.parentElement!;
  expect(
    [...row.querySelectorAll<HTMLElement>("[style]")].some(
      (element) => element.style.width === "20%",
    ),
  ).toBe(true);
  await act(async () =>
    ipc.emit(
      "downloads.changed",
      list([
        {
          ...file,
          status: { kind: "transferring", received: 80, size: 100, rate: null, restarted: false },
        },
        other,
      ]),
    ),
  );
  await until(() => expect(row.textContent).toContain("Downloading 80%"));
  expect(
    [...row.querySelectorAll<HTMLElement>("[style]")].some(
      (element) => element.style.width === "80%",
    ),
  ).toBe(true);
  await act(async () =>
    ipc.emit("downloads.changed", list([{ ...file, status: { kind: "complete" } }, other])),
  );
  await until(() =>
    expect(document.querySelector('[aria-label="Watch S1 E1 offline"]')).not.toBeNull(),
  );
  expect(row.textContent).toContain("Downloaded");
  expect(
    [...row.querySelectorAll<HTMLElement>("[style]")].some(
      (element) => element.style.width === "80%",
    ),
  ).toBe(false);
});

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
