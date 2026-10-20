// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { NumberEntry, numberEntry } from "../../src/renderer/src/features/watch/NumberEntry.tsx";

let cleanup = () => {};
afterEach(() => {
  cleanup();
  numberEntry.cancel();
});

it.each<ChannelList>([
  {
    kind: "favourites",
    filters: { countries: ["Belgium"], languages: [], subscriptions: [SUBSCRIPTION] },
  },
  {
    kind: "topic",
    topic: "news",
    filters: { countries: [], languages: ["fr"], subscriptions: [] },
  },
])("tunes a global number from $kind and keeps the browsing descriptor", async (list) => {
  ipc.reset();
  useUi.setState({ list, settings: null, searchOpen: false, details: null, playingTitle: false });
  const first: LiveChannel = {
    subscriptionId: "another-source",
    id: "99",
    name: "Elsewhere",
    title: "Elsewhere",
    number: 99,
    tags: [],
    logoUrl: null,
    categoryIds: [],
    catchupDays: null,
    variants: [{ id: "99", name: "Elsewhere", tags: [], quality: null }],
  };
  const duplicate = { ...first, subscriptionId: SUBSCRIPTION };
  ipc.answer("library.browse", (query) => {
    expect(query).toEqual({
      scope: { kind: "all" },
      filters: { browseTopics: [], countries: [], languages: [], subscriptions: [] },
      visibility: "viewer",
    });
    return browseResult([first, duplicate]);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChannel = vi.fn();
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
      createElement(QueryClientProvider, { client }, createElement(NumberEntry, { onChannel })),
    ),
  );
  await vi.waitFor(() => expect(ipc.argsOf("library.browse")).toHaveLength(1));
  await act(async () => {
    numberEntry.type("9");
    numberEntry.type("9");
  });
  await act(async () => {
    numberEntry.commit();
  });
  expect(onChannel).toHaveBeenCalledExactlyOnceWith(first);
  expect(useUi.getState().list).toEqual(list);
});
