// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { act, createElement } from "react";
import { queryView } from "./mount.ts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { call } from "../../src/renderer/src/lib/ipc.ts";
import {
  keepViewing,
  queries,
  rosterOf,
  syncViewing,
  useToggleFavourite,
} from "../../src/renderer/src/lib/queries.ts";

const own = { subscriptionId: SUBSCRIPTION, id: "1" };
const removed = { subscriptionId: "removed", id: "7" };
const record = (sequence: number, includesRemoved = false): Viewing => ({
  sequence,
  favourites: includesRemoved ? [own, removed] : [own],
  recent: includesRemoved ? [removed] : [],
  continueWatching: [],
  marked: [],
});
let client: QueryClient;
beforeEach(() => {
  ipc.reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

it("does not republish removed personal records from a late pre-removal favourite acknowledgement", async () => {
  const stop = syncViewing(client);
  const oldCommand = ipc.hold("viewing.setFavourite");
  client.setQueryData(queries.subscriptions().queryKey, [SAVED, { ...SAVED, id: "removed" }]);
  client.setQueryData(queries.viewing().queryKey, record(120, true));
  const newFavourite = { ...removed, id: "8" };
  const mounted = queryView(client);
  const { container } = mounted;
  function Star() {
    const toggle = useToggleFavourite();
    return createElement("button", { onClick: () => toggle(newFavourite) }, "Star");
  }
  await mounted.render(createElement(Star));
  await act(async () => container.querySelector("button")!.click());
  expect(ipc.argsOf("viewing.setFavourite").at(-1)).toMatchObject({
    channel: newFavourite,
    favourite: true,
  });
  try {
    // Main committed this command while both sources were saved. Its reply is still in flight.
    // Settings has since finished removing the latest-event source and read main's lower state.
    client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
    ipc.always("viewing.get", record(100));
    await client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
    expect(client.getQueryData(queries.viewing().queryKey)).toEqual(record(100));
    await act(async () => {
      oldCommand.resolve({ ...record(121, true), favourites: [own, removed, newFavourite] });
      for (let i = 0; i < 12; i++) await Promise.resolve();
    });
    expect(client.getQueryData(queries.viewing().queryKey)).toEqual(record(100));
  } finally {
    mounted.unmount();
    stop();
  }
});

it("refetches an initial viewing read that was in flight when a source was removed", async () => {
  const old = ipc.hold("viewing.get");
  ipc.always("viewing.get", record(100));
  client.setQueryData(queries.subscriptions().queryKey, [SAVED, { ...SAVED, id: "removed" }]);
  const observer = new QueryObserver(client, queries.viewing());
  const stop = observer.subscribe(() => {});
  try {
    // Mirror Remove.onSuccess: save remaining subscriptions, reset browse, invalidate all.
    client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
    await client.resetQueries({ queryKey: ["library", "browse"] });
    const invalidating = client.invalidateQueries();
    old.resolve(record(120, true));
    await invalidating;
    await Promise.resolve();
    expect(observer.getCurrentResult().data).toEqual(record(100));
  } finally {
    stop();
  }
});

it.each([0, 1, 2, 3, 4, 5, 6, 7, 8])(
  "re-reads an initial read whose roster changes %i microtasks after its reply",
  async (microtasks) => {
    client.setQueryData(queries.subscriptions().queryKey, [SAVED, { ...SAVED, id: "removed" }]);
    const old = ipc.hold("viewing.get");
    ipc.always("viewing.get", record(100));
    const observer = new QueryObserver(client, queries.viewing());
    const stop = observer.subscribe(() => {});
    try {
      old.resolve(record(120, true));
      const remove = (left: number): void => {
        if (left > 0) return queueMicrotask(() => remove(left - 1));
        client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
        void client.invalidateQueries();
      };
      remove(microtasks);
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(record(100)));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(observer.getCurrentResult().data).toEqual(record(100));
    } finally {
      stop();
    }
  },
);

it("re-reads a cached record whose read crossed an added source", async () => {
  client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
  client.setQueryData(queries.viewing().queryKey, record(100));
  const old = ipc.hold("viewing.get");
  const added = { ...record(130), favourites: [own, { subscriptionId: "added", id: "3" }] };
  ipc.always("viewing.get", added);
  const reading = client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
  client.setQueryData(queries.subscriptions().queryKey, [SAVED, { ...SAVED, id: "added" }]);
  old.resolve(record(101));
  await reading;
  expect(client.getQueryData(queries.viewing().queryKey)).toEqual(added);
});

it("keeps a same-roster acknowledgement that commits during a read crossing nothing", async () => {
  const stop = syncViewing(client);
  try {
    client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
    const old = ipc.hold("viewing.get");
    const command = ipc.hold("viewing.setFavourite");
    const reading = client.fetchQuery(queries.viewing());
    const roster = rosterOf(client);
    const changing = call("viewing.setFavourite", {
      commandId: crypto.randomUUID(),
      channel: own,
      favourite: true,
    }).then((saved) => {
      keepViewing(client, saved, roster);
      ipc.emit("viewing.changed", { sequence: saved.sequence });
    });
    old.resolve(record(2));
    command.resolve(record(9));
    await Promise.all([reading, changing]);
    expect(client.getQueryData(queries.viewing().queryKey)).toEqual(record(9));
  } finally {
    stop();
  }
});

it.each([2, 3])(
  "re-reads an inactive initial query crossing removal at microtask %i",
  async (microtasks) => {
    client.setQueryData(queries.subscriptions().queryKey, [SAVED, { ...SAVED, id: "removed" }]);
    const old = ipc.hold("viewing.get");
    ipc.always("viewing.get", record(100));
    const pending = client.fetchQuery(queries.viewing());
    old.resolve(record(120, true));
    const remove = (left: number): void => {
      if (left > 0) return queueMicrotask(() => remove(left - 1));
      client.setQueryData(queries.subscriptions().queryKey, [SAVED]);
      void client.invalidateQueries();
    };
    remove(microtasks);
    await pending;
    await vi.waitFor(() =>
      expect(client.getQueryData(queries.viewing().queryKey)).toEqual(record(100)),
    );
  },
);
