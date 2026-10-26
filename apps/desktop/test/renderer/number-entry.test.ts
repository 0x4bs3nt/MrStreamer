// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { browseResult } from "./browse-support.ts";
import { QueryClient } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, expect, it, vi } from "vitest";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { NumberEntry, numberEntry } from "../../src/renderer/src/features/watch/NumberEntry.tsx";
import { queries } from "../../src/renderer/src/lib/queries.ts";

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
      visibility: "ordinary",
    });
    return browseResult([first, duplicate]);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await client.fetchQuery(queries.preferences());
  const onChannel = vi.fn();
  const mounted = queryView(client);
  cleanup = mounted.unmount;
  await mounted.render(createElement(NumberEntry, { onChannel }));
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
