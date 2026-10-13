// @vitest-environment happy-dom
// A title's details show its name and original language from the lists. When the lists change,
// as TMDB's metadata arrives, opening the details again reads them again. TMDB's progress alone
// updates the status and reads no list again.
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type { MovieDetails } from "@mrstreamer/contracts/ondemand";
import { queries, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";

const details: MovieDetails = {
  kind: "movie",
  title: {
    kind: "movie",
    key: "movie:1",
    subscriptionId: SUBSCRIPTION,
    id: "1",
    name: "Night Harbour (NL)",
    title: "Night Harbour",
    originalTitle: null,
    originalLanguage: null,
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: "603",
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "1", tags: ["NL"] }],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
};

describe("a title's details", () => {
  it("are read again when opened after the lists changed", async () => {
    ipc.reset();
    const client = new QueryClient();
    syncOnDemand(client);
    const first = ipc.hold("ondemand.details");
    const opening = client.fetchQuery(
      queries.details("movie", { subscriptionId: SUBSCRIPTION, id: "1" }),
    );
    first.resolve(details);
    await opening;

    ipc.emit("ondemand.updated", {
      lists: [{ subscriptionId: SUBSCRIPTION, movies: 1, series: 0, fetchedAt: 1, failure: null }],
      metadata: null,
    });
    void client.fetchQuery(queries.details("movie", { subscriptionId: SUBSCRIPTION, id: "1" }));

    expect(ipc.argsOf("ondemand.details")).toHaveLength(2);
  });
});

describe("TMDB's progress", () => {
  const metadata = { known: 5, wanted: 10, refused: false, fetching: true };
  const lists = [
    { subscriptionId: SUBSCRIPTION, movies: 1, series: 0, fetchedAt: 1, failure: null },
  ];
  const statusKey = queries.onDemandStatus().queryKey;

  it("updates only the progress of the status, and reads no list again", async () => {
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    ipc.reset();
    ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
    const client = new QueryClient();
    const stop = syncOnDemand(client);
    // An open list: it is observed, so anything that invalidated it would read it again.
    const list = queries.collection("movie", "all", undefined, 0, 50);
    const unsubscribe = new QueryObserver(client, list).subscribe(() => {});
    await vi.waitFor(() => expect(client.getQueryData(list.queryKey)).toBeDefined());
    // A status that is newer than the progress: its lists stand.
    client.setQueryData(statusKey, { lists, metadata: null });

    ipc.emit("ondemand.progress", metadata);
    expect(client.getQueryData(statusKey)).toEqual({ lists, metadata });

    const later = { ...metadata, known: 6 };
    ipc.emit("ondemand.progress", later);
    expect(client.getQueryData(statusKey)).toEqual({ lists, metadata: later });
    // Long enough for a read that anything asked for to start.
    await vi.advanceTimersByTimeAsync(20);
    expect(ipc.argsOf("ondemand.collection")).toHaveLength(1);
    expect(ipc.methods()).not.toContain("ondemand.status");

    // New content, by contrast, reads the open list again.
    ipc.emit("ondemand.updated", { lists, metadata });
    await vi.waitFor(() => expect(ipc.argsOf("ondemand.collection")).toHaveLength(2));
    unsubscribe();
    stop();
  });

  it("leaves a status not yet read to be read, with its progress", () => {
    ipc.reset();
    const client = new QueryClient();
    const stop = syncOnDemand(client);
    ipc.emit("ondemand.progress", metadata);
    expect(client.getQueryData(statusKey)).toBeUndefined();
    stop();
  });
});
