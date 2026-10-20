// @vitest-environment happy-dom
import { ipc, SUBSCRIPTION } from "./support.ts";
import { browseChannels, browseChannelsOf, browseResult } from "./browse-support.ts";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IpcOutput } from "@mrstreamer/contracts/ipc";
import type { CatalogueStatus, LiveChannel } from "@mrstreamer/contracts/library";
import type { Viewing } from "@mrstreamer/contracts/viewing";
import { queries, syncLibraryUpdates } from "../../src/renderer/src/lib/queries.ts";

const channel = (id: string): LiveChannel => ({
  subscriptionId: SUBSCRIPTION,
  id,
  name: `UK | CHANNEL ${id}`,
  title: `Channel ${id}`,
  tags: [],
  number: null,
  logoUrl: null,
  categoryIds: ["1"],
  variants: [{ id, name: `UK | CHANNEL ${id}`, tags: [], quality: null }],
  catchupDays: null,
});

const viewing = (favourite: string): Viewing => ({
  favourites: [{ subscriptionId: SUBSCRIPTION, id: favourite }],
  recent: [],
  continueWatching: [],
  marked: [],
  sequence: 1,
});

const status: CatalogueStatus = {
  subscriptionId: SUBSCRIPTION,
  channelCount: 1,
  fetchedAt: 2,
  failure: null,
  failedAt: null,
};

const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

let client: QueryClient;
let stopSync: () => void;

beforeEach(() => {
  ipc.reset();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  stopSync = syncLibraryUpdates(client);
});

afterEach(() => {
  stopSync();
  client.clear();
});

/**
 * The viewer opens a list kept until the next catalogue (`staleTime: Infinity`) and leaves it
 * before its read answers. A catalogue update comes, then the answer, from the catalogue before.
 * No other update follows; back on the list, it shows the new catalogue's.
 */
async function readsAgainWhenShown<M extends "library.browse" | "viewing.get">(
  page: Pick<QueryObserver<IpcOutput<M>>, "subscribe" | "getCurrentResult">,
  method: M,
  before: IpcOutput<M>,
  after: IpcOutput<M>,
) {
  const old = ipc.hold(method);
  const leave = page.subscribe(() => {});
  await settled();
  leave();
  ipc.emit("library.updated", status);
  old.resolve(before);
  await settled();
  ipc.always(method, after);
  const back = page.subscribe(() => {});
  await settled();
  expect(ipc.argsOf(method)).toHaveLength(2);
  expect(page.getCurrentResult().data).toEqual(after);
  back();
}

describe("a catalogue update during a read", () => {
  it("reads All channels again when shown after a read under way answered from the catalogue before", () =>
    readsAgainWhenShown(
      new QueryObserver(client, browseChannels(null)),
      "library.browse",
      browseResult([channel("1")]),
      browseResult([channel("2")]),
    ));

  it("reads favourites and history again when shown after a read under way answered from the catalogue before", () =>
    readsAgainWhenShown(
      new QueryObserver(client, queries.viewing()),
      "viewing.get",
      viewing("1"),
      viewing("2"),
    ));

  it("reads a shown list again once its first read answered from the catalogue before", async () => {
    const old = ipc.hold("library.browse");
    const page = new QueryObserver(client, browseChannels(null));
    const stop = page.subscribe(() => {});
    await settled();
    ipc.emit("library.updated", status);
    ipc.always("library.browse", browseResult([channel("2")]));
    old.resolve(browseResult([channel("1")]));
    await settled();
    expect(ipc.argsOf("library.browse")).toHaveLength(2);
    expect(page.getCurrentResult().data).toEqual(browseResult([channel("2")]));
    stop();
  });

  it("gives a caller awaiting that read its answer, and reads the list again once it shows", async () => {
    const favourites = browseChannelsOf([channel("1")]);
    const old = ipc.hold("library.browse");
    const asked = client.fetchQuery(favourites);
    await settled();
    ipc.emit("library.updated", status);
    old.resolve(browseResult([channel("1")]));
    await expect(asked).resolves.toEqual(browseResult([channel("1")]));
    await settled();
    expect(ipc.argsOf("library.browse")).toHaveLength(1);
    ipc.always("library.browse", browseResult([channel("2")]));
    const page = new QueryObserver(client, favourites);
    const stop = page.subscribe(() => {});
    await settled();
    expect(ipc.argsOf("library.browse")).toHaveLength(2);
    expect(page.getCurrentResult().data).toEqual(browseResult([channel("2")]));
    stop();
  });

  it("reads a shown list once for an update after its last read", async () => {
    ipc.always("library.browse", browseResult([channel("1")]));
    const page = new QueryObserver(client, browseChannels(null));
    const stop = page.subscribe(() => {});
    await settled();
    ipc.always("library.browse", browseResult([channel("2")]));
    ipc.emit("library.updated", status);
    await settled();
    expect(ipc.argsOf("library.browse")).toHaveLength(2);
    expect(page.getCurrentResult().data).toEqual(browseResult([channel("2")]));
    stop();
  });
});
