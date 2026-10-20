// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LiveBrowseResult } from "@mrstreamer/contracts/live-browse";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import {
  useHomeDiscovery,
  useListChannels,
  useShowList,
} from "../../src/renderer/src/features/live/lists.ts";
import { BrowseFilters } from "../../src/renderer/src/features/live/BrowseFilters.tsx";
import { queries, keepViewing, rosterOf } from "../../src/renderer/src/lib/queries.ts";

const own = (id: string) => ({ subscriptionId: SUBSCRIPTION, id });
const channel = (id: string): LiveChannel => ({
  ...own(id),
  name: id,
  title: id,
  tags: [],
  number: 1,
  logoUrl: null,
  categoryIds: [],
  variants: [{ id, name: id, tags: [], quality: null }],
  catchupDays: null,
});
const result = (ids: readonly string[]): LiveBrowseResult => ({
  channels: ids.map(channel),
  total: ids.length,
  counts: { browseTopics: 0, countries: 0, languages: 0, subscriptions: 0 },
  facets: {
    browseTopics: [],
    countries: [
      { value: "Belgium", count: 2 },
      { value: "France", count: 1 },
    ],
    languages: [],
    subscriptions: [],
  },
});
const viewing = (sequence: number, ids: readonly string[]): Viewing => ({
  sequence,
  favourites: ids.map(own),
  recent: [],
  recentTitles: [],
  continueWatching: [],
  marked: [],
});
let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  useUi.setState({ list: { kind: "all" } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  client.setQueryData(queries.viewing().queryKey, viewing(1, ["1", "2"]));
  client.setQueryData(queries.rememberedLiveBrowse().queryKey, () => ({
    kind: "topic" as const,
    topic: "music" as const,
  }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function View() {
    const list = useUi((state) => state.list);
    const browse = useListChannels(list);
    const show = useShowList();
    const home = useHomeDiscovery();
    return createElement(
      "div",
      {},
      createElement("button", { onClick: () => show({ kind: "topic", topic: "sport" }) }, "Sports"),
      createElement("button", { onClick: () => show({ kind: "favourites" }) }, "Favourites"),
      createElement("button", { onClick: () => show({ kind: "all" }) }, "All"),
      createElement("output", {}, browse.channels?.map((each) => each.id).join(",") ?? "pending"),
      createElement("p", { id: "home" }, JSON.stringify(home)),
      createElement(BrowseFilters, { list, result: browse.data }),
    );
  }
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(View))),
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await settle();
  const click = (text: string) =>
    act(async () => {
      const button = [...container.querySelectorAll("button")].find(
        (each) => each.textContent === text,
      );
      expect(button).toBeDefined();
      button!.click();
    });
  return { client, container, click, output: () => container.querySelector("output")?.textContent };
}

it("never makes old-key rows actionable and retains valid same-key rows during refetch", async () => {
  ipc.always("library.browse", result(["1"]));
  ipc.answer("liveBrowse.remember", (selection) => selection);
  const p = await mount();
  expect(p.output()).toBe("1");
  const old = ipc.hold("library.browse");
  await act(async () => {
    void p.client.invalidateQueries({ queryKey: ["library", "browse"] }, { cancelRefetch: false });
  });
  expect(p.output()).toBe("1");
  const current = ipc.hold("library.browse");
  await p.click("Sports");
  expect(p.output()).toBe("pending");
  old.resolve(result(["obsolete"]));
  await settle();
  expect(p.output()).toBe("pending");
  current.resolve(result(["sport"]));
  await settle();
  expect(p.output()).toBe("sport");
});

it("keys personal membership by exact order and rejects older viewing sequences", async () => {
  ipc.answer("library.browse", (query) =>
    result(query.scope.kind === "channels" ? query.scope.channels.map((id) => id.id) : []),
  );
  const p = await mount();
  await p.click("Favourites");
  await settle();
  expect(p.output()).toBe("1,2");
  await act(async () => keepViewing(p.client, viewing(3, ["2", "1"]), rosterOf(p.client)));
  await settle();
  expect(p.output()).toBe("2,1");
  await act(async () => keepViewing(p.client, viewing(2, ["old"]), rosterOf(p.client)));
  await settle();
  expect(p.output()).toBe("2,1");
  expect(ipc.argsOf("library.browse").at(-1)?.scope).toEqual({
    kind: "channels",
    channels: [own("2"), own("1")],
  });
});

it("shares explicit filters with Home, resets on a base change and preserves the last discovery during personal browsing", async () => {
  ipc.always("library.browse", result(["1", "2"]));
  ipc.answer("liveBrowse.remember", (selection) => selection);
  const p = await mount();
  await p.click("Sports");
  await settle();
  await act(async () =>
    p.container.querySelector<HTMLButtonElement>("[data-browse-filter=countries]")!.click(),
  );
  await p.click("Belgium2");
  await settle();
  expect(useUi.getState().list.filters?.countries).toEqual(["Belgium"]);
  expect(p.container.querySelector("#home")?.textContent).toContain("Belgium");
  await p.click("Favourites");
  await settle();
  expect(useUi.getState().list.filters).toBeUndefined();
  expect(p.container.querySelector("#home")?.textContent).toBe('{"kind":"topic","topic":"sport"}');
  await p.click("All");
  await settle();
  expect(ipc.argsOf("liveBrowse.remember").at(-1)).toEqual({ kind: "all" });
  expect(p.container.querySelector("#home")?.textContent).toBe('{"kind":"all"}');
});

it("keeps a newer acknowledged viewing sequence when a delayed read settles", async () => {
  ipc.always("library.browse", result([]));
  const p = await mount();
  const delayed = ipc.hold("viewing.get");
  const read = p.client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
  await act(async () => keepViewing(p.client, viewing(9, ["new"]), rosterOf(p.client)));
  delayed.resolve(viewing(2, ["old"]));
  // fetchQuery resolves its raw reply; commit-time acceptance protects the shared cache.
  await read;
  expect(p.client.getQueryData(queries.viewing().queryKey)?.sequence).toBe(9);
});
