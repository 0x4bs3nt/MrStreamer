// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { call } from "../../src/renderer/src/lib/ipc.ts";
import { keepViewing, queries, rosterOf, syncViewing } from "../../src/renderer/src/lib/queries.ts";

const own = (id: string) => ({ subscriptionId: SUBSCRIPTION, id });
const viewing = (sequence: number, ids = [String(sequence)]): Viewing => ({
  sequence,
  favourites: ids.map(own),
  recent: [],
  continueWatching: [],
  marked: [],
});
let client: QueryClient;
beforeEach(() => {
  ipc.reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => client.clear());

it("keeps an acknowledged favourite when the first read and command complete together", async () => {
  const stop = syncViewing(client);
  try {
    const old = ipc.hold("viewing.get");
    const command = ipc.hold("viewing.setFavourite");
    const reading = client.fetchQuery(queries.viewing());
    const roster = rosterOf(client);
    const changing = call("viewing.setFavourite", {
      commandId: crypto.randomUUID(),
      channel: own("9"),
      favourite: true,
    }).then((saved) => {
      keepViewing(client, saved, roster);
      ipc.emit("viewing.changed", { sequence: saved.sequence });
    });
    old.resolve(viewing(2));
    command.resolve(viewing(9));
    await Promise.all([reading, changing]);
    expect(client.getQueryData(queries.viewing().queryKey)).toEqual(viewing(9));
  } finally {
    stop();
  }
});

it("keeps the acknowledgement throughout a read's promise-to-cache completion", async () => {
  // Cover the boundary before and after the pinned query lifecycle's retry promise settles.
  for (let microtasks = 0; microtasks < 9; microtasks++) {
    client.setQueryData(queries.viewing().queryKey, viewing(1));
    const reply = ipc.hold("viewing.get");
    const reading = client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
    const roster = rosterOf(client);
    reply.resolve(viewing(2));
    const acknowledge = (left: number): void => {
      if (left === 0) keepViewing(client, viewing(9), roster);
      else queueMicrotask(() => acknowledge(left - 1));
    };
    acknowledge(microtasks);
    await reading;
    // The assertion runs after either completion, independent of which finished first.
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(client.getQueryData(queries.viewing().queryKey)).toEqual(viewing(9));
  }
});

it.each(["source removal", "account replacement"])(
  "accepts a lower combined sequence after %s, including reload and the next reorder",
  async (scenario) => {
    const former = scenario === "source removal" ? "removed" : SUBSCRIPTION;
    const before: Viewing = {
      ...viewing(120, ["1", "2"]),
      favourites: [...viewing(120, ["1", "2"]).favourites, { subscriptionId: former, id: "7" }],
      recent: [{ subscriptionId: former, id: "7" }],
      continueWatching: [
        {
          title: { kind: "movie", subscriptionId: former, id: "m" },
          position: 120,
          duration: 600,
          at: 1,
          since: 1,
          finished: false,
        },
      ],
    };
    const after = viewing(100, ["1", "2"]);
    ipc.always("viewing.get", before);
    const observer = new QueryObserver(client, queries.viewing());
    const stop = observer.subscribe(() => {});
    try {
      await client.fetchQuery(queries.viewing());
      ipc.always("viewing.get", after);
      // Both roster changes invalidate existing queries, without a new viewing revision.
      await client.invalidateQueries();
      expect(observer.getCurrentResult().data).toEqual(after);
      const reloaded = await client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
      expect(reloaded).toEqual(after);
      ipc.answer("viewing.reorderFavourites", ({ original, order }) => {
        expect(original).toEqual(after.favourites);
        return { ...after, sequence: 101, favourites: order };
      });
      const roster = rosterOf(client);
      keepViewing(
        client,
        await call("viewing.reorderFavourites", {
          commandId: crypto.randomUUID(),
          original: [...reloaded.favourites],
          order: [own("2"), own("1")],
        }),
        roster,
      );
      expect(observer.getCurrentResult().data?.favourites).toEqual([own("2"), own("1")]);
    } finally {
      stop();
    }
  },
);

it("refreshes canonical IDs at the same sequence and accepts the next lower read", async () => {
  client.setQueryData(queries.viewing().queryKey, viewing(100, ["old-variant"]));
  ipc.always("viewing.get", viewing(100, ["canonical"]));
  await client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
  expect(client.getQueryData(queries.viewing().queryKey)).toEqual(viewing(100, ["canonical"]));
  ipc.always("viewing.get", viewing(20, ["new-account"]));
  await client.fetchQuery({ ...queries.viewing(), staleTime: 0 });
  expect(client.getQueryData(queries.viewing().queryKey)).toEqual(viewing(20, ["new-account"]));
});

// A command can reply after a later watch/progress event has already started a read.
it("keeps the newer event read when an older command acknowledgement arrives", async () => {
  ipc.always("viewing.get", viewing(120));
  const observer = new QueryObserver(client, queries.viewing());
  const unsubscribe = observer.subscribe(() => {});
  const stop = syncViewing(client);
  try {
    await client.fetchQuery(queries.viewing());
    const reply = ipc.hold("viewing.get");
    ipc.emit("viewing.changed", { sequence: 130 });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const roster = rosterOf(client);
    keepViewing(client, viewing(125), roster);
    reply.resolve(viewing(130, ["125", "130"]));
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toEqual(viewing(130, ["125", "130"])),
    );
  } finally {
    stop();
    unsubscribe();
  }
});
