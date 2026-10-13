// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";

let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  ipc.reset();
  vi.useRealTimers();
});

it.each(["movie", "series"] as const)(
  "opens the complete %s catalogue for mapped-only playlists",
  async (kind) => {
    const subscription = { ...SAVED, kind: "m3u" as const, playlistMapped: true, username: "" };
    ipc.always("subscription.list", [subscription]);
    ipc.always("ondemand.status", { lists: [], metadata: null });
    ipc.always("ondemand.collection", { name: "All", total: 0, titles: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(queries.subscriptions().queryKey, [subscription]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    cleanup = () => {
      act(() => root.unmount());
      container.remove();
      client.clear();
    };
    await act(async () =>
      root.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(TitlesPage, { kind, active: false }),
        ),
      ),
    );
    await vi.waitFor(async () => {
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(container.querySelector('nav [aria-pressed="true"]')?.textContent).toBe(
        kind === "movie" ? "All movies" : "All series",
      );
      expect(container.textContent).toContain("Nothing here yet.");
      expect(ipc.argsOf("ondemand.collection")).toContainEqual(
        expect.objectContaining({ kind, id: "all", offset: 0 }),
      );
    });
  },
);
