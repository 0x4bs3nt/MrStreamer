// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, type SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ListingMatch, Programme } from "@mrstreamer/contracts/guide";
import { normalizeCatalogue } from "@mrstreamer/core/catalogue/normalize";
import { indexLiveSearch } from "@mrstreamer/core/catalogue/search";
import { liveChannels } from "@mrstreamer/core/catalogue/variants";
import { useUi, type ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { GuidePage } from "../../src/renderer/src/features/live/GuidePage.tsx";
import { SearchPalette } from "../../src/renderer/src/features/search/SearchPalette.tsx";
import { WatchScreen } from "../../src/renderer/src/features/watch/WatchScreen.tsx";
import { queries, syncLibraryUpdates, syncViewing } from "../../src/renderer/src/lib/queries.ts";
import { player } from "../../src/renderer/src/player/player.ts";

const GREEN = "3f6c1b5e-2a47-4d0e-9c1f-7b8a5d2e4f11";
const catalogue = liveChannels(
  normalizeCatalogue({
    categories: [
      { id: "0", name: "BE | VLAANDEREN" },
      { id: "1", name: "BE | GENERAL" },
    ],
    channels: [
      ["VRT 1 FHD", "0", "VRT1.be"],
      ["VRT 1 HD", "0", "VRT1.be"],
      ["VRT 1 SD", "1", "VRT1.be"],
      ["VRT CANVAS FHD", "0", "VRTCanvas.be"],
      ["VRT CANVAS HD", "1", "VRTCanvas.be"],
    ].map(([name, category, guide], index) => ({
      id: String(index + 1),
      name: `BE | ${name}`,
      number: index + 10,
      logoUrl: null,
      categoryIds: [category!],
      guideId: guide!,
      catchupDays: null,
    })),
  }).streams,
).channels;
const blue: readonly LiveChannel[] = catalogue.map((channel) => ({
  ...channel,
  subscriptionId: SUBSCRIPTION,
}));
const green: readonly LiveChannel[] = catalogue.map((channel) => ({
  ...channel,
  subscriptionId: GREEN,
}));
const all = [...blue, ...green];
const plain = (channels: readonly LiveChannel[]) =>
  channels.map(({ searchIdentity: _identity, searchGroup: _group, ...channel }) => channel);
const responses = (channels: readonly LiveChannel[]) => {
  const stamps = new Map(
    indexLiveSearch(channels).groups.flatMap((group) =>
      group.copies.map((copy, order) => [ownedKey(copy), { key: group.key, order }] as const),
    ),
  );
  return channels.map(({ searchIdentity: _identity, ...channel }) => ({
    ...channel,
    searchGroup: stamps.get(ownedKey(channel))!,
  }));
};
const stamps = (channels: readonly LiveChannel[]) =>
  indexLiveSearch(channels)
    .groups.filter((group) => group.copies.length > 1)
    .map((group) => ({ key: group.key, copies: group.copies.map(ownedKey) }));
const programme = (title: string): Programme => ({
  start: Date.now() - 1000,
  stop: Date.now() + 3600000,
  title,
  description: "From this copy's guide.",
});
const later: Programme = {
  ...programme("Evening news"),
  start: Date.now() + 3600000,
  stop: Date.now() + 7200000,
};

Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get(this: HTMLElement) {
    return this.dataset["index"] === undefined ? 900 : 60;
  },
});
let unmount = () => {};
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  act(() => player.reset());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const settled = (ms = 30) => act(() => vi.advanceTimersByTimeAsync(ms));

async function page(
  kind: "guide" | "palette",
  query = "VRT",
  realPlayback = false,
  listed: readonly LiveChannel[] = responses(all),
  list: ChannelList = { kind: "all" },
) {
  ipc.reset();
  const watch = vi.spyOn(player, "watch");
  if (!realPlayback) watch.mockImplementation(() => {});
  useUi.setState({
    view: "live",
    list,
    watching: false,
    playingTitle: false,
    searchOpen: kind === "palette",
    settings: null,
    details: null,
    searchFrom: query,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stopLibrary = syncLibraryUpdates(client);
  const stopViewing = syncViewing(client);
  client.setQueryData(queries.subscriptions().queryKey, [
    { ...SAVED, name: "Blue" },
    { ...SAVED, id: GREEN, name: "Green" },
  ]);
  if (kind === "guide") {
    client.setQueryData(queries.channels(null).queryKey, plain(listed));
    client.setQueryData(queries.channelsOf(listed).queryKey, plain(listed));
  }
  ipc.always("library.searchGroups", stamps(all));
  client.setQueryData(
    queries.categories().queryKey,
    ["0", "1"].map((id) => ({
      subscriptionId: SUBSCRIPTION,
      id,
      name: id === "0" ? "BE | VLAANDEREN" : "BE | GENERAL",
      group: "Belgium",
      title: id === "0" ? "Vlaanderen" : "General",
      members: [SUBSCRIPTION, GREEN].map((subscriptionId) => ({ subscriptionId, id })),
      channelCount: all.length,
    })),
  );
  client.setQueryData(queries.libraryStatus().queryKey, [
    { subscriptionId: SUBSCRIPTION, channelCount: 4, fetchedAt: 1, failure: null, failedAt: null },
    { subscriptionId: GREEN, channelCount: 4, fetchedAt: 1, failure: null, failedAt: null },
  ]);
  client.setQueryData(queries.viewing().queryKey, {
    favourites: list.kind === "favourites" ? listed : [green[1]!],
    recent: list.kind === "recent" ? listed : [],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  client.setQueryData(queries.search(query).queryKey, query === "VRT" ? responses(all) : []);
  client.setQueryData(queries.titleSearch(query).queryKey, { movies: [], series: [] });
  client.setQueryData(
    queries.programmes(query).queryKey,
    query === "news" ? [{ channel: green[1]!, programme: later }] : [],
  );
  ipc.always(
    "guide.listings",
    Object.fromEntries(
      all.map((channel) => [
        ownedKey(channel),
        {
          now: programme(
            `${channel.subscriptionId === GREEN ? "Green" : "Blue"} guide ${channel.id}`,
          ),
          next: null,
        },
      ]),
    ),
  );
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          Fragment,
          null,
          kind === "guide"
            ? createElement(GuidePage, { active: true })
            : createElement(SearchPalette),
          realPlayback ? createElement(WatchScreen) : null,
        ),
      ),
    ),
  );
  unmount = () => {
    stopLibrary();
    stopViewing();
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  await settled();
  const scope = () => (kind === "guide" ? container : document.body);
  const field = () =>
    scope().querySelector<HTMLInputElement>(kind === "guide" ? "main input" : "input")!;
  const press = (key: string, target: EventTarget = document.activeElement ?? field()) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  const rows = () =>
    kind === "guide"
      ? [...container.querySelectorAll<HTMLElement>('[data-index] [role="button"]')]
      : [...document.querySelectorAll<HTMLElement>("button[data-group-row]")];
  const button = (label: string, row?: HTMLElement) =>
    [...(row ?? scope()).querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === label,
    )!;
  const click = (target: HTMLElement) => act(async () => target.click());
  const type = async (text: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
        field(),
        text,
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const search = async (text: string, matches: Record<string, ListingMatch> = {}) => {
    const answer = ipc.hold("guide.searchList");
    await type(text);
    await settled(150);
    answer.resolve(matches);
    await settled();
  };
  return { client, watch, field, press, rows, button, click, type, search, scope };
}

describe("real search components with two subscriptions", () => {
  it("starts the palette catalogue read during typing and shares it across searches and reopen", async () => {
    const p = await page("palette", "");
    expect(ipc.argsOf("library.searchGroups")).toEqual([]);
    expect(ipc.argsOf("library.channels")).toEqual([]);
    const groups = ipc.hold("library.searchGroups");
    const names = ipc.hold("library.channels");
    const programmes = ipc.hold("guide.search");
    const titles = ipc.hold("ondemand.search");
    await p.type("Canvas");
    await settled();
    expect(ipc.argsOf("library.searchGroups")).toEqual([undefined]);
    expect(ipc.argsOf("library.channels")).toEqual([]);
    expect(p.rows()).toHaveLength(0);
    groups.resolve(stamps(all));
    await settled(150);
    expect(ipc.argsOf("library.channels")).toEqual([{ query: "Canvas" }]);
    names.resolve(responses(all.filter((channel) => channel.title === "VRT Canvas")));
    programmes.resolve([]);
    titles.resolve({ movies: [], series: [] });
    await settled();
    expect(p.rows()).toHaveLength(1);
    await p.type("");
    await settled(150);
    ipc.always("library.channels", responses(all));
    ipc.always("guide.search", []);
    ipc.always("ondemand.search", { movies: [], series: [] });
    await p.type("VRT");
    await settled(150);
    await settled();
    expect(p.rows()).toHaveLength(2);
    await act(async () => useUi.setState({ searchOpen: false }));
    await settled(200);
    await act(async () => useUi.setState({ searchOpen: true, searchFrom: "VRT" }));
    await settled(200);
    expect(p.rows()).toHaveLength(2);
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(1);
    await p.press("ArrowRight", p.field());
    await p.press("ArrowDown", p.field());
    await p.press("Enter", p.field());
    expect(p.watch).toHaveBeenLastCalledWith(expect.objectContaining(ownedId(blue[0]!)));
  });

  it.each(["all", "favourites"] as const)(
    "keeps the selected exact copy and row focus through singleton fallback and regroup in %s",
    async (kind) => {
      const listed = kind === "all" ? all : green;
      const p = await page("guide", "", false, listed, { kind });
      await p.search("VRT");
      await p.press("ArrowDown", p.field());
      await p.press("ArrowDown");
      await p.press("ArrowRight");
      const copy = p
        .rows()
        .find((row) =>
          row.getAttribute("aria-label")?.startsWith("VRT Canvas, Green, Belgium, General"),
        )!;
      await act(async () => copy.focus());
      expect(document.activeElement).toBe(copy);
      const groups = ipc.hold("library.searchGroups");
      const channels = ipc.hold("library.channels");
      await act(async () =>
        ipc.emit("library.updated", {
          subscriptionId: GREEN,
          channelCount: listed.length,
          fetchedAt: 2,
          failure: null,
          failedAt: null,
        }),
      );
      channels.resolve(plain(listed));
      await settled();
      const singleton = p
        .rows()
        .find((row) =>
          row.getAttribute("aria-label")?.startsWith("VRT Canvas, Green, Belgium, General"),
        )!;
      expect(singleton.className).toContain("ring-2");
      expect(document.activeElement).toBe(singleton);
      await p.press("Enter");
      expect(p.watch).toHaveBeenLastCalledWith(expect.objectContaining(ownedId(green[3]!)));
      await act(async () => useUi.setState({ watching: false, view: "live" }));
      groups.resolve(stamps(all));
      await settled();
      const regrouped = p
        .rows()
        .find((row) =>
          row.getAttribute("aria-label")?.startsWith("VRT Canvas, Green, Belgium, General"),
        )!;
      expect(regrouped.className).toContain("ring-2");
      expect(document.activeElement).toBe(regrouped);
      await p.press("Enter");
      expect(p.watch).toHaveBeenLastCalledWith(expect.objectContaining(ownedId(green[3]!)));
      expect(p.watch).toHaveBeenCalledTimes(2);
    },
  );

  it("restores a chosen companion copy after its programme match regroups", async () => {
    const p = await page("guide");
    await p.search("news", { [ownedKey(green[3]!)]: { now: true, later: null } });
    p.field().blur();
    await p.press("ArrowRight", window);
    const chosenRow = () =>
      p
        .rows()
        .find((row) =>
          row.getAttribute("aria-label")?.startsWith("VRT Canvas, Blue, Belgium, Vlaanderen"),
        )!;
    await act(async () => chosenRow().focus());
    expect(chosenRow().className).toContain("ring-2");
    const groups = ipc.hold("library.searchGroups");
    const channels = ipc.hold("library.channels");
    await act(async () =>
      ipc.emit("library.updated", {
        subscriptionId: GREEN,
        channelCount: all.length,
        fetchedAt: 2,
        failure: null,
        failedAt: null,
      }),
    );
    channels.resolve(plain(all));
    await settled();
    expect(p.rows()).toHaveLength(1);
    expect(document.activeElement).toBe(p.rows()[0]);
    groups.resolve(stamps(all));
    await settled();
    expect(chosenRow().className).toContain("ring-2");
    expect(document.activeElement).toBe(chosenRow());
    await p.press("Enter");
    expect(p.watch).toHaveBeenLastCalledWith(expect.objectContaining(ownedId(blue[2]!)));
  });

  it("falls back to current singletons when the first stamp read fails, and keeps a retried search filtered", async () => {
    const p = await page("guide");
    const groups = ipc.hold("library.searchGroups");
    await p.search("Canvas");
    groups.reject({ kind: "unexpected", detail: "Unavailable" });
    await settled();
    expect(p.rows()).toHaveLength(4);
    expect(p.rows().every((row) => row.getAttribute("aria-label")?.startsWith("VRT Canvas,"))).toBe(
      true,
    );
    expect(p.button("Show copies")).toBeUndefined();
    expect(p.scope().textContent).toContain("4 channels · 4 streams");
    await p.type("");
    await settled();
    expect(p.rows()).toHaveLength(8);
    const retry = ipc.hold("library.searchGroups");
    await p.search("Canvas");
    expect(p.field().value).toBe("Canvas");
    expect(p.rows()).toHaveLength(4);
    expect(p.rows().every((row) => row.getAttribute("aria-label")?.startsWith("VRT Canvas,"))).toBe(
      true,
    );
    expect(p.scope().textContent).toContain("4 channels · 4 streams");
    await p.press("ArrowDown", p.field());
    await p.press("Enter");
    expect(p.watch).toHaveBeenLastCalledWith(expect.objectContaining(ownedId(blue[2]!)));
    retry.resolve(stamps(all));
    await settled();
    expect(p.rows()).toHaveLength(1);
    expect(p.scope().textContent).toContain("1 channel · 4 streams");
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(2);
  });

  it("does not accept a first stamp answer made obsolete by a catalogue update", async () => {
    const p = await page("guide");
    const old = ipc.hold("library.searchGroups");
    await p.search("VRT");
    const current = all.map((channel) =>
      channel.subscriptionId === GREEN && channel.title === "VRT 1"
        ? { ...channel, searchIdentity: { ...channel.searchIdentity!, guideId: "different.be" } }
        : channel,
    );
    const listed = ipc.hold("library.channels");
    const fresh = ipc.hold("library.searchGroups");
    await act(async () =>
      ipc.emit("library.updated", {
        subscriptionId: GREEN,
        channelCount: current.length,
        fetchedAt: 2,
        failure: null,
        failedAt: null,
      }),
    );
    listed.resolve(plain(current));
    old.resolve(stamps(all));
    await settled();
    expect(p.rows().every((row) => !row.hasAttribute("aria-label"))).toBe(true);
    fresh.resolve(stamps(current));
    await settled();
    expect(p.rows()).toHaveLength(3);
    expect(
      p.rows().filter((row) => row.getAttribute("aria-label")?.startsWith("VRT 1,")),
    ).toHaveLength(2);
  });

  it("starts cold catalogue stamps during typing but waits for both authoritative stamps and programmes", async () => {
    const p = await page("guide");
    const groups = ipc.hold("library.searchGroups");
    const programmes = ipc.hold("guide.searchList");
    await p.type("V");
    await settled();
    expect(ipc.argsOf("library.searchGroups")).toEqual([undefined]);
    expect(ipc.argsOf("guide.searchList")).toEqual([]);
    await p.type("VRT");
    await settled(150);
    expect(p.rows()).toHaveLength(8);
    programmes.resolve({});
    await settled();
    expect(p.rows().every((row) => !row.hasAttribute("aria-label"))).toBe(true);
    groups.resolve(stamps(all));
    await settled();
    expect(p.rows()).toHaveLength(2);
    expect(ipc.argsOf("library.channels")).toEqual([]);
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(1);
    expect(ipc.argsOf("guide.searchList")).toEqual([{ query: "VRT", until: expect.any(Number) }]);
  });

  it("keeps Search all channels filtered without a second grouping read", async () => {
    const p = await page("guide", "", false, [blue[2]!], { kind: "favourites" });
    await act(async () => p.client.setQueryData(queries.channels(null).queryKey, plain(all)));
    await p.search("VRT 1");
    expect(p.rows()).toHaveLength(0);
    const programmes = ipc.hold("guide.searchList");
    const searchAll = [...p.scope().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Search all channels",
    )!;
    await p.click(searchAll);
    await settled();
    expect(p.field().value).toBe("VRT 1");
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.getAttribute("aria-label")).toMatch(/^VRT 1,/);
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(1);
    programmes.resolve({});
    await settled();
    expect(p.rows()).toHaveLength(1);
  });

  it("keeps a recent list filtered when another channel is watched", async () => {
    const p = await page("guide", "", false, [blue[2]!], { kind: "recent" });
    await p.search("Canvas");
    const viewing = p.client.getQueryData(queries.viewing().queryKey)!;
    const changed = ipc.hold("viewing.get");
    const listed = ipc.hold("library.channels");
    await act(async () => ipc.emit("viewing.changed", { sequence: viewing.sequence + 1 }));
    changed.resolve({ ...viewing, recent: [blue[0]!, blue[2]!], sequence: viewing.sequence + 1 });
    await settled();
    listed.resolve(plain([blue[0]!, blue[2]!]));
    await settled();
    expect(p.field().value).toBe("Canvas");
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.getAttribute("aria-label")).toMatch(/^VRT Canvas,/);
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(1);
  });

  it("keeps a subset apart while a hidden full-catalogue conflict is awaiting fresh stamps", async () => {
    const unguided = {
      ...green[0]!,
      searchIdentity: { ...green[0]!.searchIdentity!, guideId: null },
    };
    const subset = [blue[0]!, unguided];
    const hidden: LiveChannel = {
      ...blue[0]!,
      id: "hidden",
      searchIdentity: {
        ...blue[0]!.searchIdentity!,
        guideId: "other.be",
      },
    };
    const p = await page("guide", "", false, subset, { kind: "favourites" });
    ipc.always("library.searchGroups", stamps(subset));
    await p.search("VRT");
    expect(p.rows()).toHaveLength(1);
    const listed = ipc.hold("library.channels");
    const groups = ipc.hold("library.searchGroups");
    await act(async () =>
      ipc.emit("library.updated", {
        subscriptionId: SUBSCRIPTION,
        channelCount: 3,
        fetchedAt: 2,
        failure: null,
        failedAt: null,
      }),
    );
    listed.resolve(plain(subset));
    await settled();
    expect(p.rows()).toHaveLength(2);
    expect(p.button("Show copies")).toBeUndefined();
    groups.resolve(stamps([...subset, hidden]));
    await settled();
    expect(p.rows()).toHaveLength(2);
    expect(p.button("Show copies")).toBeUndefined();
  });

  it("ignores a late programme answer for a category the viewer left", async () => {
    const category = { subscriptionId: SUBSCRIPTION, id: "0" };
    const p = await page("guide");
    await act(async () => {
      p.client.setQueryData(queries.channels(category).queryKey, plain([blue[0]!]));
      useUi.setState({ list: { kind: "category", category } });
    });
    const old = ipc.hold("guide.searchList");
    await p.type("news");
    await settled(150);
    await act(async () => useUi.setState({ list: { kind: "all" } }));
    await p.search("Canvas");
    expect(p.rows()).toHaveLength(1);
    old.resolve({ [ownedKey(blue[0]!)]: { now: true, later: null } });
    await settled();
    expect(p.field().value).toBe("Canvas");
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.getAttribute("aria-label")).toMatch(/^VRT Canvas,/);
  });

  it("clears immediately while stamps are held and ignores their late arrival", async () => {
    const p = await page("guide");
    const groups = ipc.hold("library.searchGroups");
    await p.search("Canvas");
    await p.type("");
    expect(p.rows()).toHaveLength(8);
    expect(p.rows().every((row) => !row.hasAttribute("aria-label"))).toBe(true);
    groups.resolve(stamps(all));
    await settled();
    expect(p.rows()).toHaveLength(8);
    await p.search("Canvas");
    expect(p.rows()).toHaveLength(1);
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(1);
  });

  it("keeps removed copies out and newly matching channels playable while grouping refreshes", async () => {
    const p = await page("guide");
    await p.search("VRT");
    const added: LiveChannel = {
      ...plain([blue[0]!])[0]!,
      id: "extra",
      title: "VRT Extra",
      name: "VRT Extra",
      variants: [{ id: "extra", name: "VRT Extra", quality: null, tags: [] }],
    };
    const current = [...blue, added];
    const listed = ipc.hold("library.channels");
    const groups = ipc.hold("library.searchGroups");
    await act(async () =>
      ipc.emit("library.updated", {
        subscriptionId: SUBSCRIPTION,
        channelCount: current.length,
        fetchedAt: 2,
        failure: null,
        failedAt: null,
      }),
    );
    listed.resolve(plain(current));
    await settled();
    expect(p.rows()).toHaveLength(5);
    expect(p.scope().textContent).toContain("5 channels · 6 streams");
    expect(p.rows().some((row) => row.getAttribute("aria-label")?.includes("Green"))).toBe(false);
    for (const row of p.rows()) await p.click(row);
    expect(p.watch.mock.calls.map(([channel]) => ownedKey(channel))).toEqual(current.map(ownedKey));
    groups.resolve(stamps(current));
    await settled();
    expect(p.rows()).toHaveLength(3);
    expect(p.scope().textContent).toContain("3 channels · 6 streams");
  });

  it("rejects stale joins after the same owned channels acquire conflicting guide metadata", async () => {
    const p = await page("guide");
    await p.search("VRT");
    await p.search("");
    const current = all.map((channel) =>
      channel.subscriptionId === GREEN && channel.title === "VRT 1"
        ? { ...channel, searchIdentity: { ...channel.searchIdentity!, guideId: "different.be" } }
        : channel,
    );
    const listed = ipc.hold("library.channels");
    await act(async () =>
      ipc.emit("library.updated", {
        subscriptionId: GREEN,
        channelCount: current.length,
        fetchedAt: 2,
        failure: null,
        failedAt: null,
      }),
    );
    listed.resolve(plain(current));
    await settled();
    const groups = ipc.hold("library.searchGroups");
    await p.search("VRT");
    expect(p.rows()).toHaveLength(8);
    expect(p.button("Show copies")).toBeUndefined();
    groups.resolve(stamps(current));
    await settled();
    expect(p.rows()).toHaveLength(3);
    expect(
      p.rows().filter((row) => row.getAttribute("aria-label")?.startsWith("VRT 1,")),
    ).toHaveLength(2);
  });

  it("retains the name filter when removing a favourite changes its list", async () => {
    const favourites = [blue[0]!, blue[2]!, green[2]!];
    const p = await page("guide", "", false, favourites, { kind: "favourites" });
    await p.search("Canvas");
    expect(p.rows()).toHaveLength(1);
    const viewing = p.client.getQueryData(queries.viewing().queryKey)!;
    const remaining = favourites.slice(0, 2);
    const changed = ipc.hold("viewing.setFavourite");
    const listed = ipc.hold("library.channels");
    await p.click(p.button("Show copies", p.rows()[0]));
    await p.click(p.button("Remove from favourites", p.rows()[2]));
    changed.resolve({
      ...viewing,
      favourites: remaining.map(ownedId),
      sequence: viewing.sequence + 1,
    });
    await settled();
    listed.resolve(plain(remaining));
    await settled();
    expect(p.field().value).toBe("Canvas");
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.getAttribute("aria-label")).toMatch(/^VRT Canvas,/);
    expect(ipc.argsOf("library.searchGroups")).toHaveLength(1);
  });

  it("hands keyboard input to the lists without leaving Space on a stale channel row", async () => {
    const p = await page("guide");
    await p.search("VRT");
    await p.press("ArrowDown", p.field());
    expect(document.activeElement).toBe(p.rows()[0]);
    await p.press("ArrowLeft");
    expect(document.activeElement).not.toBe(p.rows()[0]);
    await p.press(" ");
    expect(p.watch).not.toHaveBeenCalled();
    await p.press("ArrowRight");
    await p.press(" ");
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: green[1]!.subscriptionId, id: green[1]!.id }),
    );
  });

  it("keeps focus on a different group's button when reached from the selected row", async () => {
    const p = await page("guide");
    await p.search("VRT");
    await p.press("ArrowDown", p.field());
    const copies = p.button("Show copies", p.rows()[1]);
    await act(async () => copies.focus());
    expect(document.activeElement).toBe(copies);
    await p.click(copies);
    expect(p.rows()).toHaveLength(6);
    expect(document.activeElement).toBe(copies);
    expect(copies.getAttribute("aria-label")).toBe("Hide copies");
    await p.press("Enter", copies);
    expect(p.watch).not.toHaveBeenCalled();
    await p.click(copies);
    expect(p.rows()).toHaveLength(2);
    expect(document.activeElement).toBe(copies);
  });

  it("keeps Tab on unrelated controls when pointer use changes to keyboard use", async () => {
    const p = await page("guide");
    await p.search("VRT");
    const other = [...p.scope().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) =>
        !button.closest("[data-index]") && button.getAttribute("aria-label") !== "Clear search",
    )!;
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousemove", { movementX: 3, movementY: 3 }));
      other.focus();
    });
    await p.press("Tab", other);
    expect(document.activeElement).toBe(other);
    await p.press("ArrowDown", p.field());
    expect(document.activeElement).toBe(p.rows()[0]);
    await p.press("ArrowDown");
    expect(document.activeElement).toBe(p.rows()[1]);
  });

  it("closes hidden copy schedules with the copies before Left hands focus to lists", async () => {
    const p = await page("guide");
    await p.search("VRT");
    await p.press("ArrowDown", p.field());
    await p.press("ArrowRight");
    await p.press("ArrowDown");
    const schedule = ipc.hold("guide.schedule");
    await p.press("ArrowRight");
    schedule.resolve([later]);
    await settled();
    expect(ipc.argsOf("guide.schedule").at(-1)).toEqual({
      channel: { subscriptionId: SUBSCRIPTION, id: "1" },
      from: expect.any(Number),
      until: expect.any(Number),
    });
    expect(p.rows()[1]!.parentElement?.textContent).toContain("Evening news");
    await p.press("ArrowDown");
    await p.press("ArrowLeft");
    expect(p.rows()).toHaveLength(2);
    expect(document.activeElement).toBe(p.rows()[0]);
    await p.press("ArrowLeft");
    expect(p.rows()).not.toContain(document.activeElement);
    await p.press("ArrowRight");
    await p.press("ArrowRight");
    expect(p.rows()).toHaveLength(6);
    expect(p.rows()[1]!.parentElement?.textContent).not.toContain("Evening news");
    await p.click(p.button("Later programmes", p.rows()[1]));
    await settled();
    expect(p.rows()[1]!.parentElement?.textContent).toContain("Evening news");
  });

  it("announces each single Guide result's owned source, category, number, quality and matched programme", async () => {
    const listed = responses(all).filter((channel) =>
      [ownedKey(green[1]!), ownedKey(blue[2]!)].includes(ownedKey(channel)),
    );
    const p = await page("guide", "VRT", false, listed);
    await p.search("news", {
      [ownedKey(green[1]!)]: { now: true, later: null },
      [ownedKey(blue[2]!)]: { now: false, later: { title: later.title, start: later.start } },
    });
    expect(p.rows()).toHaveLength(2);
    await expect
      .poll(() => p.rows()[1]!.getAttribute("aria-label"))
      .toBe("VRT 1, Green, Belgium, General, 12, SD, Green guide 3");
    expect(p.rows()[0]!.getAttribute("aria-label")).toBe(
      "VRT Canvas, Blue, Belgium, Vlaanderen, 13, FHD, Evening news",
    );
  });

  it("selects the playing channel's collapsed group even when a different copy represents it", async () => {
    vi.spyOn(player, "current").mockReturnValue(green[2]!);
    const p = await page("guide");
    await p.search("VRT");
    await p.press("ArrowDown", p.field());
    expect(document.activeElement).toBe(p.rows()[1]);
    expect(p.rows()[1]?.textContent).toContain("VRT Canvas");
    await p.press("Enter");
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: SUBSCRIPTION, id: "4" }),
    );
  });

  it("GuidePage preserves ordinary lists, counts groups, chooses a favourite, expands exact copies and returns focus on Left", async () => {
    const p = await page("guide");
    expect(p.rows()).toHaveLength(8);
    expect(ipc.argsOf("library.channels")).toEqual([]);
    const groups = ipc.hold("library.searchGroups");
    await p.search("VRT");
    expect(ipc.argsOf("library.channels")).toEqual([]);
    expect(ipc.argsOf("library.searchGroups")).toEqual([undefined]);
    expect(p.rows()).toHaveLength(8);
    groups.resolve(stamps(all));
    await settled();
    expect(p.rows().map((row) => row.getAttribute("aria-label")?.split(",")[0])).toEqual([
      "VRT 1",
      "VRT Canvas",
    ]);
    expect(p.scope().textContent).toContain("2 channels · 10 streams");
    expect(p.rows()[0]!.getAttribute("aria-label")).toContain("2 subscriptions");
    expect(p.rows()[0]!.getAttribute("aria-label")).toContain("6 streams");
    p.field().blur();
    await p.press("Enter", window);
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: green[1]!.subscriptionId, id: green[1]!.id }),
    );
    await act(async () => useUi.setState({ watching: false }));
    await p.press("ArrowRight", window);
    expect(p.rows()).toHaveLength(6);
    expect(p.rows()[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(p.rows()[1]!.textContent).toContain("FHD · HD");
    expect(p.rows()[1]!.textContent).toContain("Blue");
    expect(p.rows()[1]!.textContent).toContain("Belgium · Vlaanderen");
    const summary = p.rows()[1]!.querySelector<HTMLElement>("span[title] span[title]")!;
    expect(summary.textContent).toBe("FHD · HD · Blue · Belgium · Vlaanderen");
    expect(summary.title).toBe("FHD · HD · Blue · Belgium · Vlaanderen");
    expect(p.rows()[2]!.querySelector("span[title] span[title]")?.textContent).toBe(
      "SD · Blue · Belgium · General",
    );
    expect(p.rows()[1]!.getAttribute("aria-label")).toContain("Belgium, Vlaanderen, 10");
    await expect
      .poll(async () => {
        await settled();
        return p.rows()[3]!.textContent;
      })
      .toContain("Green guide 1");
    await p.press("ArrowDown", window);
    await p.press("Enter", window);
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: blue[0]!.subscriptionId, id: blue[0]!.id }),
    );
    expect(p.watch.mock.calls.at(-1)![0].variants.map((variant) => variant.id)).toEqual(["1", "2"]);
    await act(async () => useUi.setState({ watching: false }));
    await p.click(p.button("Add to favourites", p.rows()[1]));
    expect(ipc.argsOf("viewing.setFavourite").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id: "1" },
      favourite: true,
    });
    await p.press("ArrowLeft", window);
    expect(p.rows()).toHaveLength(2);
    expect(document.activeElement).toBe(p.rows()[0]);
    expect(p.scope().textContent).toContain("2 channels · 10 streams");
    await p.search("");
    expect(p.rows()).toHaveLength(8);
  });

  it("GuidePage plays the selected ordinary row after leaving an empty search field", async () => {
    const p = await page("guide", "");
    expect(p.rows().every((row) => !row.hasAttribute("aria-label"))).toBe(true);
    await p.press("/", window);
    await p.press("ArrowDown", p.field());
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    await p.press("Enter");
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: blue[2]!.subscriptionId, id: blue[2]!.id }),
    );
  });

  it("GuidePage commits a typed channel number from a focused search row", async () => {
    const p = await page("guide");
    await p.search("VRT");
    await p.press("ArrowDown", p.field());
    await p.press("1");
    await p.press("3");
    await p.press("Enter");
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: blue[2]!.subscriptionId, id: blue[2]!.id }),
    );
  });

  it("GuidePage keeps the actual matching copy's programme and schedule while retaining the entire group", async () => {
    const p = await page("guide");
    await p.search("news", {
      [ownedKey(green[1]!)]: { now: false, later: { title: later.title, start: later.start } },
    });
    expect(p.rows()).toHaveLength(1);
    expect(p.rows()[0]!.textContent).toContain("Evening news");
    expect(p.scope().textContent).toContain("1 channel · 6 streams");
    p.field().blur();
    await p.press("ArrowRight", window);
    expect(p.rows()).toHaveLength(5);
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    await p.press("ArrowDown", window);
    const day = ipc.hold("guide.schedule");
    await p.press("ArrowRight", window);
    day.resolve([later]);
    await settled();
    expect(ipc.argsOf("guide.schedule").at(-1)).toEqual({
      channel: { subscriptionId: GREEN, id: "3" },
      from: expect.any(Number),
      until: expect.any(Number),
    });
    expect(p.rows()[4]!.parentElement?.textContent).toContain("From this copy's guide.");
  });

  it("SearchPalette uses the same groups, favourite default, exact copy play, stars and keyboard collapse", async () => {
    const p = await page("palette");
    expect(p.rows()).toHaveLength(2);
    expect(p.scope().textContent).toContain("2 channels · 10 streams");
    expect(ipc.argsOf("library.channels")).toEqual([]);
    expect(p.rows()[0]!.getAttribute("aria-label")).toContain(
      "2 subscriptions, 6 streams, FHD · HD · SD",
    );
    expect(p.rows()[1]!.getAttribute("aria-label")).toContain(
      "2 subscriptions, 4 streams, FHD · HD",
    );
    await p.press("Enter", p.field());
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: green[1]!.subscriptionId, id: green[1]!.id }),
    );
    // Keep this mounted popup's input available for the keyboard path after playback closes it.
    await act(async () => useUi.setState({ watching: false, searchOpen: true }));
    await settled();
    await p.press("ArrowRight", p.field());
    expect(p.rows()).toHaveLength(6);
    expect(p.rows()[1]!.textContent).toContain("Belgium · Vlaanderen · Blue · 10 · FHD · HD");
    await p.press("ArrowDown", p.field());
    await p.press("Enter", p.field());
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: blue[0]!.subscriptionId, id: blue[0]!.id }),
    );
    await act(async () => useUi.setState({ watching: false, searchOpen: true }));
    await settled();
    await p.press("ArrowRight", p.field());
    await p.press("ArrowDown", p.field());
    await p.click(p.button("Add to favourites", p.rows()[1]!.parentElement!));
    expect(ipc.argsOf("viewing.setFavourite").at(-1)).toMatchObject({
      channel: { subscriptionId: SUBSCRIPTION, id: "1" },
    });
    await p.press("ArrowLeft", p.field());
    expect(p.rows()).toHaveLength(2);
    expect(document.activeElement).toBe(p.field());
  });

  it("Q after an explicit copy opens only that subscription's qualities and remembers its choice", async () => {
    const p = await page("guide", "VRT", true);
    await p.search("VRT");
    p.field().blur();
    await p.press("ArrowRight", window);
    await p.click(p.rows()[3]!);
    await settled();
    expect(player.state().channel).toMatchObject({ subscriptionId: GREEN, id: "1" });
    expect(ipc.argsOf("playback.open").at(-1)).toMatchObject({
      channel: { subscriptionId: GREEN, id: "1" },
    });
    expect(ipc.argsOf("subscription.updatePreferences")).toEqual([]);
    await p.press("q", window);
    await settled();
    const choices = [...document.querySelectorAll<HTMLButtonElement>("[data-item]")];
    expect(choices.map((choice) => choice.textContent)).toEqual(
      expect.arrayContaining(["Full HD", "HD"]),
    );
    const hd = choices.find((choice) => choice.textContent === "HD")!;
    ipc.always("subscription.updatePreferences", {
      ...defaultSubscriptionPreferences,
      channelVariants: { "1": "2" },
    });
    await p.click(hd);
    await settled();
    expect(ipc.argsOf("subscription.updatePreferences").at(-1)).toEqual({
      subscriptionId: GREEN,
      patch: { channelVariants: { "1": "2" } },
    });
    expect(ipc.argsOf("playback.open").at(-1)).toMatchObject({
      channel: { subscriptionId: GREEN, id: "1" },
    });
    expect(ipc.argsOf("playback.open")).toHaveLength(2);
    expect(player.state().channel?.subscriptionId).toBe(GREEN);
  });

  it("SearchPalette keeps later programme rows and opens their description without playing", async () => {
    const p = await page("palette", "news");
    expect(p.rows()).toHaveLength(0);
    const row = document.querySelector<HTMLElement>('button[role="treeitem"]')!;
    expect(row.textContent).toContain("Evening news");
    expect(row.textContent).not.toContain("From this copy's guide.");
    await p.press("Enter", p.field());
    expect(row.textContent).toContain("From this copy's guide.");
    expect(p.watch).not.toHaveBeenCalled();
  });

  it("keeps a programme's open description attached when channel copies change its row position", async () => {
    const p = await page("palette", "news");
    await act(async () => {
      p.client.setQueryData(queries.search("news").queryKey, responses(all));
      p.client.setQueryData(
        queries.programmes("news").queryKey,
        ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"].map((title, at) => ({
          channel: green[1]!,
          programme: {
            ...later,
            title,
            start: later.start + at * 1000,
            description: `About ${title}`,
          },
        })),
      );
    });
    await settled();
    const programmeRow = (title: string) =>
      [...document.querySelectorAll<HTMLElement>('button[role="treeitem"]')].find((row) =>
        row.textContent?.includes(title),
      )!;
    await p.click(programmeRow("Epsilon"));
    expect(programmeRow("Epsilon").textContent).toContain("About Epsilon");
    await p.click(
      p.rows()[0]!.parentElement!.querySelector<HTMLElement>('[aria-label="Show copies"]')!,
    );
    expect(programmeRow("Epsilon").textContent).toContain("About Epsilon");
    expect(programmeRow("Alpha").textContent).not.toContain("About Alpha");
    await p.click(
      p.rows()[0]!.parentElement!.querySelector<HTMLElement>('[aria-label="Hide copies"]')!,
    );
    expect(programmeRow("Epsilon").textContent).toContain("About Epsilon");
    expect(p.watch).not.toHaveBeenCalled();
  });

  it("SearchPalette retains both an on-now programme and its later match", async () => {
    const p = await page("palette", "news");
    await act(async () =>
      p.client.setQueryData(queries.programmes("news").queryKey, [
        {
          channel: green[1]!,
          programme: { ...programme("Morning news"), start: Date.now() - 120000 },
        },
        { channel: green[1]!, programme: later },
      ]),
    );
    await settled();
    const rows = [...document.querySelectorAll<HTMLElement>('button[role="treeitem"]')];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Morning news");
    expect(rows[0]!.textContent).toContain("On now");
    expect(rows[1]!.textContent).toContain("Evening news");
    await p.press("Enter", p.field());
    expect(p.watch).toHaveBeenLastCalledWith(
      expect.objectContaining({ subscriptionId: green[1]!.subscriptionId, id: green[1]!.id }),
    );
  });

  it("SearchPalette retains programme matches beyond the twenty channel-name results", async () => {
    const p = await page("palette", "news");
    const names = Array.from({ length: 25 }, (_, index): LiveChannel => ({
      ...blue[0]!,
      id: `news-${index}`,
      name: `News ${index}`,
      title: `News ${index}`,
      searchIdentity: {
        title: `news ${index}`,
        region: "Belgium",
        language: null,
        topics: ["Belgium|news"],
        guideId: null,
      },
      variants: [{ id: `news-${index}`, name: `News ${index}`, tags: [], quality: null }],
    }));
    await act(async () => p.client.setQueryData(queries.search("news").queryKey, responses(names)));
    await expect.poll(() => p.rows().length).toBe(20);
    const rows = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    expect(rows).toHaveLength(21);
    expect(rows[20]!.textContent).toContain("Evening news");
    expect(p.scope().textContent).toContain("20 channels · 20 streams");
    for (let index = 0; index < 20; index++) await p.press("ArrowDown", p.field());
    expect(p.field().getAttribute("aria-activedescendant")).toBe(rows[20]!.id);
    await p.press("Enter", p.field());
    expect(rows[20]!.textContent).toContain("From this copy's guide.");
    expect(p.watch).not.toHaveBeenCalled();
  });

  // VRT 1's two copies, then VRT Canvas on its own row, all from the first subscription.
  it.each(["guide", "palette"] as const)(
    "%s names a channel's subscription on its search rows only while several are saved",
    async (kind) => {
      const listed = [blue[0]!, blue[1]!, blue[2]!];
      const named = async (saved: readonly SubscriptionSummary[]) => {
        const p = await page(kind, kind === "guide" ? "" : "VRT", false, responses(listed));
        ipc.always("library.searchGroups", stamps(listed));
        await act(async () => {
          p.client.setQueryData(queries.subscriptions().queryKey, saved);
          p.client.setQueryData(queries.search("VRT").queryKey, responses(listed));
        });
        await settled();
        if (kind === "guide") {
          await p.search("VRT");
          p.field().blur();
          await p.press("ArrowRight", window);
        } else await p.press("ArrowRight", p.field());
        const rows = p.rows();
        expect(rows.map((row) => row.getAttribute("aria-label")?.split(",")[0])).toEqual([
          "VRT 1",
          "VRT 1",
          "VRT 1",
          "VRT Canvas",
        ]);
        const names = rows.map((row) =>
          `${row.getAttribute("aria-label")} ${row.textContent}`.includes("Northline"),
        );
        unmount();
        return names;
      };
      const northline = { ...SAVED, name: "Northline" };
      expect(await named([northline])).toEqual([false, false, false, false]);
      // A subscription whose login can't be read is still saved.
      expect(
        await named([northline, { ...SAVED, id: GREEN, name: "Green", needsSecret: true }]),
      ).toEqual([false, true, true, true]);
    },
  );
});
