// @vitest-environment happy-dom
// Bounded component diagnostic. From the repo root, create .local/download-performance, then run:
// DOWNLOAD_PROBE_OUTPUT=.local/download-performance/samples.json pnpm vitest run --config apps/desktop/test/renderer/download-performance.config.ts
// Measures React/happy-dom snapshot handling, not native paint or input latency.
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { writeFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import type { Episode, SeriesDetails } from "@mrstreamer/contracts/ondemand";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import { syncDownloads } from "../../src/renderer/src/lib/downloads.ts";

const episodes: Episode[] = Array.from({ length: 520 }, (_, index) => ({
  subscriptionId: SUBSCRIPTION,
  seriesId: "series",
  id: `episode-${index}`,
  season: Math.floor(index / 26) + 1,
  number: (index % 26) + 1,
  title: `Episode ${index + 1}`,
  plot: null,
  duration: 2000,
  stillUrl: null,
  airDate: null,
}));
const details: SeriesDetails = {
  kind: "series",
  title: {
    kind: "series",
    subscriptionId: SUBSCRIPTION,
    id: "series",
    key: "series:x",
    title: "Long series",
    name: "Long series",
    originalTitle: null,
    originalLanguage: "en",
    tags: [],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "series", tags: [] }],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: Array.from({ length: 20 }, (_, index) => ({
    number: index + 1,
    name: `Season ${index + 1}`,
    posterUrl: null,
    episodes: episodes.slice(index * 26, (index + 1) * 26),
  })),
};
const download = (id: string): Download => ({
  id,
  title: { kind: "movie", id },
  subscription: { id: SUBSCRIPTION, name: "Fixture" },
  name: id,
  episodeName: null,
  year: 2024,
  duration: 2000,
  originalLanguage: "en",
  posterUrl: null,
  wideUrl: null,
  size: 1000,
  status: { kind: "complete" },
  progress: null,
  series: null,
});
const completed = Array.from({ length: 2000 }, (_, index) => download(`unrelated-${index}`));
const snapshot = (received: number): DownloadList => ({
  // Clone the complete payload as IPC does. QueryClient's normal structural sharing stays on.
  items: structuredClone([
    ...completed,
    {
      ...download("advancing"),
      status: { kind: "transferring", received, size: 100, rate: 1, restarted: false },
    },
  ]),
  series: {},
  bytes: 2_000_000 + received,
  free: 1_000_000,
  ended: 0,
});

it("records 30 bounded full-snapshot updates on actual long-series details", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  ipc.reset();
  ipc.always("ondemand.titles", [details.title]);
  ipc.always("ondemand.details", details);
  ipc.always(
    "ondemand.season",
    episodes.slice(0, 26).map((episode) => ({ ...episode, rating: null, cast: [], directors: [] })),
  );
  ipc.always("viewing.progress", []);
  ipc.always("downloads.list", snapshot(0));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [SAVED]);
  const stop = syncDownloads(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let commits = 0;
  let renderMs = 0;
  const settle = () => act(() => vi.advanceTimersByTimeAsync(10));
  try {
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            Profiler,
            {
              id: "details",
              onRender: (_id, _phase, duration) => {
                commits++;
                renderMs += duration;
              },
            },
            createElement(DetailsView, {
              target: { kind: "series", subscriptionId: SUBSCRIPTION, id: "series" },
            }),
          ),
        ),
      ),
    );
    for (let i = 0; i < 20 && !document.body.textContent?.includes("Episode 26"); i++)
      await settle();
    expect(document.body.textContent).toContain("Episode 26");
    expect(document.body.querySelectorAll('[aria-label^="Download S1 E"]')).toHaveLength(26);
    const samples = [];
    for (let i = 1; i <= 35; i++) {
      const value = snapshot(i);
      commits = 0;
      renderMs = 0;
      const cpu = process.cpuUsage();
      const start = performance.now();
      await act(async () => ipc.emit("downloads.changed", value));
      await settle();
      const elapsedMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      if (i > 5)
        samples.push({
          sample: i - 5,
          elapsedMs,
          cpuMs: (used.user + used.system) / 1000,
          renderMs,
          commits,
        });
      expect(document.body.querySelectorAll('[aria-label^="Download S1 E"]')).toHaveLength(26);
    }
    // Positive control: matching progress must still reach the row and series aggregate.
    const own = {
      ...download("own"),
      title: {
        kind: "episode" as const,
        id: "episode-0",
        seriesId: "series",
        season: 1,
        episode: 1,
      },
      status: { kind: "transferring" as const, received: 42, size: 100, rate: 1, restarted: false },
    };
    await act(async () =>
      ipc.emit("downloads.changed", { ...snapshot(36), items: [...completed, own] }),
    );
    await settle();
    expect(document.body.textContent).toContain("Downloading 42%");
    expect(document.body.querySelector('[aria-label="Cancel download of S1 E1"]')).not.toBeNull();
    const output = process.env["DOWNLOAD_PROBE_OUTPUT"];
    if (!output) throw new Error("DOWNLOAD_PROBE_OUTPUT is required to retain all observations");
    writeFileSync(
      output,
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          episodes: 520,
          seasons: 20,
          visibleEpisodes: 26,
          completedUnrelated: 2000,
          advancing: 1,
          warmup: 5,
          samples,
        },
        null,
        2,
      ),
    );
  } finally {
    act(() => root.unmount());
    stop();
    client.clear();
    container.remove();
    vi.useRealTimers();
    ipc.reset();
  }
});
