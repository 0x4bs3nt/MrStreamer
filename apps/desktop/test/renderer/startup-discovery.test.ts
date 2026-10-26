// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { App } from "../../src/renderer/src/app/App.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { TooltipProvider } from "../../src/renderer/src/components/ui/tooltip.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";
import { titlePlayer } from "../../src/renderer/src/player/title-player.ts";

const category = { subscriptionId: SUBSCRIPTION, id: "news" };
const remembered = { kind: "category" as const, category };
const settle = () => act(() => vi.advanceTimersByTimeAsync(20));
let cleanup = () => {};
beforeEach(() => {
  vi.useFakeTimers();
  ipc.reset();
  useUi.setState(useUi.getInitialState(), true);
  ipc.always("subscription.list", [SAVED]);
  ipc.always("library.categories", [
    { ...category, name: "News", title: "News", group: null, channelCount: 1, members: [category] },
  ]);
  ipc.always("library.browse", browseResult([]));
  ipc.always("viewing.get", {
    favourites: [],
    recent: [],
    continueWatching: [],
    marked: [],
    sequence: 0,
  });
  ipc.always("ondemand.status", { lists: [], metadata: null });
});
afterEach(() => {
  cleanup();
  player.reset();
  titlePlayer.close();
  useUi.setState(useUi.getInitialState(), true);
  vi.useRealTimers();
});

async function mount(cached = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) client.setQueryData(queries.rememberedLiveBrowse().queryKey, remembered);
  const mounted = queryView(client);
  cleanup = mounted.unmount;
  await mounted.render(createElement(TooltipProvider, null, createElement(App)));
  await settle();
  return { client, container: mounted.container };
}

it.each([false, true])("opens only the restored discovery, cached=%s", async (cached) => {
  const read = ipc.hold("liveBrowse.get");
  await mount(cached);
  if (!cached) {
    expect(ipc.argsOf("library.browse")).toEqual([]);
    await act(async () => read.resolve(remembered));
    await settle();
  }
  expect(ipc.argsOf("library.browse").map(({ scope }) => scope)).toEqual([remembered]);
});

it("still browses the complete All selection when All was saved", async () => {
  ipc.always("liveBrowse.get", { kind: "all" });
  await mount();
  expect(ipc.argsOf("library.browse").map(({ scope }) => scope)).toEqual([{ kind: "all" }]);
});

it("opens All if remembered discovery fails instead of blocking the window", async () => {
  ipc.refuse("liveBrowse.get", { kind: "unexpected", detail: "Read refused." });
  await mount();
  expect(ipc.argsOf("library.browse").map(({ scope }) => scope)).toEqual([{ kind: "all" }]);
});

it("does not restore again over a later explicit selection", async () => {
  ipc.always("liveBrowse.get", remembered);
  const { client } = await mount();
  await act(async () => useUi.setState({ list: { kind: "topic", topic: "sport" } }));
  ipc.always("liveBrowse.get", { kind: "all" });
  await act(async () =>
    client.invalidateQueries({ queryKey: queries.rememberedLiveBrowse().queryKey }),
  );
  await settle();
  expect(useUi.getState().list).toEqual({ kind: "topic", topic: "sport" });
});
