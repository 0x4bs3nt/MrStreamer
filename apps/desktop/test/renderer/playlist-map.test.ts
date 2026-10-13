// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaylistGroupPage } from "@mrstreamer/contracts/playlist";
import { syncLibraryUpdates, syncOnDemand } from "../../src/renderer/src/lib/queries.ts";
import {
  PlaylistMap,
  PlaylistRows,
} from "../../src/renderer/src/features/settings/PlaylistMap.tsx";

const subscription = { ...SAVED, kind: "m3u" as const, username: "" };
const groups: PlaylistGroupPage = {
  status: { explicit: true, groups: 2, live: 1, movies: 2, series: 0, episodes: 0, omitted: 60 },
  total: 2,
  groups: [
    {
      group: "film-key",
      name: "Films",
      mode: "movie",
      entries: 2,
      samples: [{ name: "Film", groups: ["Films"], reason: null }],
    },
    {
      group: "new-key",
      name: "New group",
      mode: null,
      entries: 60,
      samples: [{ name: "Waiting", groups: ["New group"], reason: "unmapped" }],
    },
  ],
};
let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});
async function render(element: ReturnType<typeof createElement>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["subscriptions"], [subscription]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(QueryClientProvider, { client }, element)));
  // Lets Settings take in what just happened, on the fake clock.
  const settle = () => act(() => vi.advanceTimersByTimeAsync(30));
  await settle();
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  const button = (label: string) =>
    [...document.querySelectorAll("button")].find((each) => each.textContent?.trim() === label);
  const click = async (label: string) => {
    await act(async () => button(label)?.click());
    await settle();
  };
  return { client, button, click, settle, container };
}

describe("playlist mapping in Settings", () => {
  it("keeps the import snapshot through metadata arrivals and reads it again after a Live refresh", async () => {
    ipc.always("playlist.groups", groups);
    const app = await render(createElement(PlaylistMap, { subscription, onClose: () => {} }));
    const stopTitles = syncOnDemand(app.client);
    const stopLive = syncLibraryUpdates(app.client);
    try {
      expect(ipc.argsOf("playlist.groups")).toHaveLength(1);
      await act(async () => {
        for (const known of [1, 2, 3])
          ipc.emit("ondemand.updated", {
            lists: [],
            metadata: { known, wanted: 3, refused: false, fetching: true },
          });
      });
      await app.settle();
      expect(ipc.argsOf("playlist.groups")).toHaveLength(1);
      await act(async () =>
        ipc.emit("library.updated", {
          subscriptionId: subscription.id,
          channelCount: 1,
          fetchedAt: 1,
          failure: null,
          failedAt: null,
        }),
      );
      await app.settle();
      expect(ipc.argsOf("playlist.groups")).toHaveLength(2);
    } finally {
      stopTitles();
      stopLive();
    }
  });
  it("shows a group's mapping and samples, saves each pick immediately and updates the saved subscription", async () => {
    ipc.always("playlist.groups", groups);
    const app = await render(createElement(PlaylistMap, { subscription, onClose: () => {} }));
    expect(app.button("Movies")?.getAttribute("aria-pressed")).toBe("true");
    expect(document.body.textContent).toContain("Film");
    const save = ipc.hold("playlist.map");
    await app.click("Live TV");
    expect(ipc.argsOf("playlist.map")).toEqual([
      { subscriptionId: subscription.id, group: "film-key", mode: "live" },
    ]);
    expect(app.button("Movies")?.disabled).toBe(true);
    await act(async () => save.resolve({ ...subscription, playlistMapped: true }));
    await app.settle();
    expect(app.client.getQueryData(["subscriptions"])).toEqual([
      { ...subscription, playlistMapped: true },
    ]);
    expect(app.button("Movies")?.disabled).toBe(false);
  });

  it("keeps full names, groups and reasons in bounded Settings pages", async () => {
    ipc.always("playlist.groups", groups);
    ipc.always("playlist.omissions", {
      total: 60,
      entries: [
        {
          name: "Full omitted title",
          groups: ["New group", "Films"],
          reason: "conflicting-groups",
        },
      ],
    });
    const app = await render(createElement(PlaylistRows, { subscription, onMap: () => {} }));
    expect(app.container.textContent).toContain("Left out60Show");
    await app.click("Show");
    expect(app.container.textContent).toContain("Full omitted title");
    expect(app.container.textContent).toContain(
      "New group · Films · Groups have different mappings",
    );
    await app.click("Next");
    expect(ipc.argsOf("playlist.omissions")).toEqual([
      { subscriptionId: subscription.id, offset: 0, limit: 50 },
      { subscriptionId: subscription.id, offset: 50, limit: 50 },
    ]);
  });
  it("returns to a valid omission page after mapping removes entries", async () => {
    ipc.always("playlist.groups", groups);
    ipc.always("playlist.omissions", {
      total: 60,
      entries: [{ name: "Waiting", groups: ["New group"], reason: "unmapped" }],
    });
    const app = await render(createElement(PlaylistRows, { subscription, onMap: () => {} }));
    await app.click("Show");
    await app.click("Next");
    expect(app.container.textContent).toContain("51–60 of 60");
    ipc.always("playlist.omissions", {
      total: 40,
      entries: [{ name: "Remaining", groups: ["New group"], reason: "unmapped" }],
    });
    await act(async () => {
      await app.client.invalidateQueries({ queryKey: ["playlist", subscription.id, "omissions"] });
    });
    await vi.waitFor(
      async () => {
        await app.settle();
        expect(app.container.textContent).toContain("1–40 of 40");
      },
      { interval: 1 },
    );
    expect(ipc.argsOf("playlist.omissions").at(-1)).toMatchObject({ offset: 0, limit: 50 });
    expect(app.container.textContent).not.toContain("51–40");
  });
});
