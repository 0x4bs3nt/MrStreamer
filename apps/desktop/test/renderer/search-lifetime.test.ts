// @vitest-environment happy-dom
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { queries } from "../../src/renderer/src/lib/queries.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function observer(client: QueryClient, query: string, list = false) {
  const node = document.createElement("div");
  const root = createRoot(node);
  function Search() {
    if (list) useQuery(queries.listSearch({}, query, 1));
    else useQuery(queries.programmes(query));
    return null;
  }
  act(() => root.render(createElement(QueryClientProvider, { client }, createElement(Search))));
  let mounted = true;
  const unmount = () => {
    if (mounted) act(() => root.unmount());
    mounted = false;
  };
  cleanups.push(unmount);
  return unmount;
}

it("keeps shared guide queries alive until the last observer leaves", async () => {
  ipc.reset();
  ipc.always("guide.cancelSearch", null);
  const held = ipc.hold("guide.search");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => client.clear());
  const first = observer(client, "fixture");
  const second = observer(client, "fixture");
  expect(ipc.argsOf("guide.search")).toHaveLength(1);
  first();
  expect(ipc.argsOf("guide.cancelSearch")).toEqual([]);
  second();
  expect(ipc.argsOf("guide.cancelSearch")).toEqual([ipc.argsOf("guide.search")[0]!.request]);
  held.resolve([]);
  await act(async () => {});
});

it("cancels an abandoned palette invocation without cancelling Live or another query", async () => {
  ipc.reset();
  ipc.always("guide.cancelSearch", null);
  const held = ipc.hold("guide.search"),
    other = ipc.hold("guide.search"),
    live = ipc.hold("guide.searchList");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => client.clear());
  const first = observer(client, "first");
  const second = observer(client, "second");
  const list = observer(client, "first", true);
  first();
  const metadata = ipc.argsOf("guide.search").map((input) => input.request);
  expect(metadata[0]!.id).not.toBe(metadata[1]!.id);
  expect(ipc.argsOf("guide.cancelSearch")).toEqual([metadata[0]]);
  expect(ipc.argsOf("guide.searchList")[0]!.request?.view).toBe("live");
  held.resolve([]);
  other.resolve([]);
  live.resolve({});
  await act(async () => {});
  second();
  list();
  // Completion removed abort listeners, so settled invocations send no cancellation.
  expect(ipc.argsOf("guide.cancelSearch")).toEqual([metadata[0]]);
});
