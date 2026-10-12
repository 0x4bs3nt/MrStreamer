// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { Download, DownloadList, DownloadStatus } from "@mrstreamer/contracts/downloads";
import type { Episode, SeriesDetails } from "@mrstreamer/contracts/ondemand";
import type { EpisodeMark, TitleProgress } from "@mrstreamer/contracts/viewing";
import { SeriesDownload } from "../../src/renderer/src/features/downloads/SeriesDownload.tsx";
import { downloadsQuery, syncDownloads } from "../../src/renderer/src/lib/downloads.ts";

const episode = (season: number, number: number, id = `${season}-${number}`): Episode => ({
  subscriptionId: SUBSCRIPTION,
  seriesId: "series",
  id,
  season,
  number,
  title: id,
  plot: null,
  duration: 2000,
  stillUrl: null,
  airDate: null,
});
const episodes = [episode(0, 1), episode(1, 1), episode(1, 2), episode(2, 1), episode(2, 2)];
const episodeOrder = ["2-2", "0-1", "1-2", "1-1", "2-1"];
const details: SeriesDetails = {
  kind: "series",
  title: {
    kind: "series",
    subscriptionId: SUBSCRIPTION,
    id: "series",
    key: "series:x",
    title: "Harbour",
    name: "Harbour (NL)",
    originalTitle: null,
    originalLanguage: "nl",
    tags: ["NL"],
    year: 2024,
    posterUrl: null,
    backdropUrl: null,
    rating: null,
    addedAt: null,
    adult: false,
    tmdbId: null,
    genres: [],
    versions: [{ subscriptionId: SUBSCRIPTION, id: "series", tags: ["NL"] }],
  },
  originalTitle: null,
  plot: null,
  genres: [],
  cast: [],
  directors: [],
  releaseDate: null,
  duration: null,
  backdropUrl: null,
  seasons: [0, 1, 2].map((number) => ({
    number,
    name: number === 0 ? "Specials" : `Season ${number}`,
    posterUrl: null,
    episodes: episodes.filter((episode) => episode.season === number),
  })),
  episodeOrder,
};
const download = (episode: Episode, status: DownloadStatus): Download => ({
  id: `d-${episode.id}`,
  title: {
    kind: "episode",
    id: episode.id,
    seriesId: episode.seriesId,
    season: episode.season,
    episode: episode.number,
  },
  subscription: { id: SUBSCRIPTION, name: "Fixture" },
  name: "Harbour",
  episodeName: episode.title,
  year: 2024,
  duration: 2000,
  originalLanguage: "nl",
  posterUrl: null,
  wideUrl: null,
  size: null,
  status,
  progress: null,
});
const list = (items: readonly Download[]): DownloadList => ({
  items,
  bytes: 0,
  free: null,
  ended: 0,
});
let cleanup = () => {};
afterEach(() => {
  cleanup();
  ipc.reset();
});
const until = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
      check();
    },
    { timeout: 5000 },
  );

async function mount(
  items: readonly Download[] = [],
  picked = details,
  progress: readonly TitleProgress[] = [],
) {
  ipc.always("downloads.list", list(items));
  ipc.always("downloads.add", download(episodes[0]!, { kind: "queued" }));
  ipc.always("downloads.retry", null);
  ipc.always("downloads.remove", null);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = syncDownloads(client);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (value = picked, key = "series", marks: readonly EpisodeMark[] = []) =>
    act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(SeriesDownload, {
            details: value,
            progress,
            marks,
            version: "NL · Fixture",
            key,
          }),
        ),
      ),
    );
  await render();
  await until(() => expect(client.getQueryData(downloadsQuery().queryKey)).toBeDefined());
  const click = async (text: string) => {
    const target = [...document.querySelectorAll<HTMLElement>('button, [role="menuitem"]')].find(
      (element) => element.textContent === text,
    );
    expect(target).toBeDefined();
    await act(async () => target!.click());
  };
  const open = () =>
    act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Download options:"]')!.click(),
    );
  const changed = async (items: readonly Download[]) => {
    ipc.always("downloads.list", list(items));
    await act(async () => ipc.emit("downloads.changed", list(items)));
  };
  cleanup = () => {
    act(() => root.unmount());
    stop();
    client.clear();
    container.remove();
  };
  return { container, client, render, click, open, changed };
}

it("queues the selected version's file for every season including Specials in source episode order", async () => {
  const first = {
    ...episodes[0]!,
    versions: [
      { id: "resumed", duration: 2000, name: "Resumed (NL)", tags: ["NL"] },
      { id: "other", duration: 1000, name: "Other (EN)", tags: ["EN"] },
    ],
  };
  const selected = {
    ...details,
    seasons: details.seasons.map((season) =>
      season.number === 0 ? { ...season, episodes: [first] } : season,
    ),
  };
  const progress: TitleProgress[] = [
    {
      title: {
        kind: "episode",
        subscriptionId: SUBSCRIPTION,
        id: "resumed",
        seriesId: "series",
        season: 0,
        episode: 1,
      },
      position: 60,
      duration: 2000,
      finished: false,
      at: 1,
      since: 1,
    },
  ];
  const page = await mount([], selected, progress);
  await page.open();
  expect(document.querySelector('[role="menu"]')?.textContent).toContain(
    "Specials, Season 1, Season 2",
  );
  await page.click("Download 5 episodes");
  await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(5));
  expect(ipc.argsOf("downloads.add").map(({ title }) => title.id)).toEqual([
    "2-2",
    "resumed",
    "1-2",
    "1-1",
    "2-1",
  ]);
  expect(page.container.textContent).toContain("Queued 5 episodes");
});

it("skips copies and every in-flight state, retries failed files and prevents duplicate activation", async () => {
  const files = episodes.map((episode, index) =>
    download(
      episode,
      index === 0
        ? { kind: "complete" }
        : index === 1
          ? { kind: "queued" }
          : index === 2
            ? { kind: "transferring", received: 3, size: 10, rate: null, restarted: false }
            : index === 3
              ? { kind: "waiting" }
              : { kind: "failed", failure: { kind: "disk-full", needed: null } },
    ),
  );
  const held = ipc.hold("downloads.retry");
  const page = await mount(files);
  await page.open();
  await page.click("Download 1 episode");
  await until(() => expect(ipc.argsOf("downloads.retry")).toEqual([{ id: "d-2-2" }]));
  await page.open();
  const add = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === "Download 1 episode",
  )!;
  expect(add.getAttribute("aria-disabled")).toBe("true");
  await act(async () => add.click());
  await page.changed(
    files.map((file) => (file.id === "d-2-2" ? { ...file, status: { kind: "queued" } } : file)),
  );
  await act(async () => held.resolve(null));
  await until(() =>
    expect(page.container.querySelector('[role="status"]')?.textContent).toContain(
      "Queued 1 episode. 1 already downloaded, 3 already queued.",
    ),
  );
  expect(ipc.argsOf("downloads.retry")).toHaveLength(1);
  expect(ipc.argsOf("downloads.add")).toHaveLength(0);
});

it("keeps successful additions after a partial queue failure and retries only the failed addition", async () => {
  const first = ipc.hold("downloads.add");
  const page = await mount();
  await page.open();
  await page.click("Download 5 episodes");
  await act(async () => first.reject({ kind: "no-subscription" }));
  await until(() =>
    expect(page.container.textContent).toContain("Queued 4 of 5. 1 couldn't be added: S2 E2."),
  );
  expect(ipc.argsOf("downloads.remove")).toHaveLength(0);
  await page.changed(
    episodes
      .filter((episode) => episode.id !== "2-2")
      .map((episode) => download(episode, { kind: "queued" })),
  );
  await page.click("Retry");
  await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(6));
  expect(ipc.argsOf("downloads.add").at(-1)?.title.id).toBe("2-2");
});

it("removes obsolete failure feedback after a language refresh and queues the current files", async () => {
  const first = ipc.hold("downloads.add");
  const page = await mount();
  await page.open();
  await page.click("Download 5 episodes");
  await act(async () => first.reject({ kind: "no-subscription" }));
  await until(() =>
    expect(page.container.textContent).toContain("Queued 4 of 5. 1 couldn't be added: S2 E2."),
  );
  const changed = {
    ...details,
    episodeOrder: episodeOrder.map((id) => `${id}-new-language`),
    seasons: details.seasons.map((season) => ({
      ...season,
      episodes: season.episodes.map((episode) => ({
        ...episode,
        id: `${episode.id}-new-language`,
        versions: [
          { id: episode.id, duration: 2000, name: "Old default (NL)", tags: ["NL"] },
          {
            id: `${episode.id}-new-language`,
            duration: 2000,
            name: "New default (EN)",
            tags: ["EN"],
          },
        ],
      })),
    })),
  };
  await page.render(changed);
  expect(page.container.querySelector('[role="status"]')).toBeNull();
  expect(
    [...page.container.querySelectorAll("button")].some((button) => button.textContent === "Retry"),
  ).toBe(false);
  expect(ipc.argsOf("downloads.remove")).toHaveLength(0);
  await page.open();
  expect(document.body.textContent).not.toContain("Retry failed");
  await page.click("Download 5 episodes");
  await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(10));
  expect(ipc.argsOf("downloads.add")[5]?.title.id).toBe("2-2-new-language");
});

it("removes the old resumed-file Retry when the episode is marked watched", async () => {
  const selected = {
    ...details,
    seasons: details.seasons.map((season) => ({
      ...season,
      episodes: season.episodes.map((episode) =>
        episode.id === "2-2"
          ? {
              ...episode,
              versions: [
                { id: "2-2", duration: 2000, name: "Default (NL)", tags: ["NL"] },
                { id: "resumed", duration: 2000, name: "Resumed (EN)", tags: ["EN"] },
              ],
            }
          : episode,
      ),
    })),
  };
  const progress: TitleProgress[] = [
    {
      title: {
        kind: "episode",
        subscriptionId: SUBSCRIPTION,
        id: "resumed",
        seriesId: "series",
        season: 2,
        episode: 2,
      },
      position: 60,
      duration: 2000,
      finished: false,
      at: 1,
      since: 1,
    },
  ];
  const first = ipc.hold("downloads.add");
  const page = await mount([], selected, progress);
  await page.open();
  await page.click("Download 5 episodes");
  await act(async () => first.reject({ kind: "no-subscription" }));
  await until(() => expect(page.container.textContent).toContain("1 couldn't be added: S2 E2."));
  expect(ipc.argsOf("downloads.add")[0]?.title.id).toBe("resumed");
  const copies = episodes
    .filter((episode) => episode.id !== "2-2")
    .map((episode) => download(episode, { kind: "queued" }));
  await page.changed(copies);
  await page.render(selected, "series", [
    { season: 2, episode: 2, watched: true, at: 2, revision: 2 },
  ]);
  expect(page.container.querySelector('[role="status"]')).toBeNull();
  await page.open();
  expect(document.body.textContent).not.toContain("Retry failed");
  await page.click("Download 1 episode");
  await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(6));
  expect(ipc.argsOf("downloads.add").at(-1)?.title.id).toBe("2-2");
  expect(ipc.argsOf("downloads.remove")).toHaveLength(0);
});

it("stops further additions after switching series versions while a submitted call finishes", async () => {
  const first = ipc.hold("downloads.add");
  const page = await mount();
  await page.open();
  await page.click("Download 5 episodes");
  await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(1));
  await page.render(
    { ...details, title: { ...details.title, id: "another-version" } },
    "another-version",
  );
  await act(async () => first.resolve(download(episodes[4]!, { kind: "queued" })));
  expect(ipc.argsOf("downloads.add")).toHaveLength(1);
  expect(page.container.textContent).not.toContain("Queued 5 episodes");
});

it("cancels only unfinished files in this version, leaving completed and failed files available", async () => {
  const files = [
    download(episodes[0]!, { kind: "queued" }),
    download(episodes[1]!, { kind: "complete" }),
    download(episodes[2]!, { kind: "failed", failure: { kind: "folder", detail: "fixture" } }),
  ];
  const page = await mount(files);
  await page.open();
  await page.click("Cancel the rest");
  await until(() => expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "d-0-1" }]));
});

it("replaces a missing copy through Delete then Add and keeps unrelated copies", async () => {
  const page = await mount([
    download(episodes[0]!, { kind: "missing" }),
    ...episodes.slice(1).map((episode) => download(episode, { kind: "complete" })),
  ]);
  await page.open();
  await page.click("Download 1 episode");
  await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(1));
  expect(ipc.argsOf("downloads.remove")).toEqual([{ id: "d-0-1" }]);
  expect(ipc.argsOf("downloads.add")[0]?.title.id).toBe("0-1");
});

it.each(["success", "failure"])(
  "stops additions and suppresses a late %s after episode files change",
  async (outcome) => {
    const first = ipc.hold("downloads.add");
    const page = await mount();
    await page.open();
    await page.click("Download 5 episodes");
    await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(1));
    const changed = {
      ...details,
      episodeOrder: episodeOrder.map((id) => `${id}-new-language`),
      seasons: details.seasons.map((season) => ({
        ...season,
        episodes: season.episodes.map((episode) => ({
          ...episode,
          id: `${episode.id}-new-language`,
        })),
      })),
    };
    await page.render(changed);
    await act(async () => {
      if (outcome === "success") first.resolve(download(episodes[4]!, { kind: "queued" }));
      else first.reject({ kind: "no-subscription" });
    });
    expect(page.container.querySelector('[role="status"]')).toBeNull();
    expect(ipc.argsOf("downloads.add")).toHaveLength(1);
    expect(ipc.argsOf("downloads.remove")).toHaveLength(0);
    await page.open();
    expect(document.body.textContent).not.toContain("Retry failed");
    await page.click("Download 5 episodes");
    await until(() => expect(ipc.argsOf("downloads.add")).toHaveLength(6));
    expect(ipc.argsOf("downloads.add")[1]?.title.id).toBe("2-2-new-language");
  },
);
