// @vitest-environment happy-dom
import { ipc, SAVED } from "./support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
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
    const mounted = queryView(client);
    const { container } = mounted;
    cleanup = mounted.unmount;
    await mounted.render(createElement(TitlesPage, { kind, active: false }));
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
