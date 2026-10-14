// @vitest-environment happy-dom
// Settings > Subscriptions > Map: the sheet that maps a subscription's channels to its guides'
// by hand. Its channels are read a page at a time and drawn only where in view, the guides'
// channels are searched by name or id, a mapping is made for the exact guide channel of the exact
// guide picked, the channels are read again after it, and the keyboard goes through both lists.
import { ipc } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GuideChannelPage,
  GuideStatus,
  MapChannel,
  MapChannelPage,
} from "@mrstreamer/contracts/guide";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { SubscriptionSection } from "../../src/renderer/src/features/settings/SubscriptionSection.tsx";
import { syncGuideUpdates } from "../../src/renderer/src/lib/queries.ts";

// happy-dom lays nothing out, and the lists draw only the rows that fit: each gets a height.
Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
  configurable: true,
  get: () => 400,
});

let unmount = () => {};
afterEach(() => unmount());

const holiday: SubscriptionSummary = {
  kind: "xtream",
  id: "holiday",
  name: "Holiday house",
  server: "https://panel.sunhouse.example",
  username: "viewer02",
  account: { state: "active", expiresAt: null, maxConnections: 2, activeConnections: 0 },
  needsSecret: false,
};
/** A source of Settings > Guides, whose channels the sheet lists after the own guide's. */
const ORIGIN = "https://guide.example.org";
const guide: GuideStatus = {
  subscriptionId: holiday.id,
  channels: 412,
  supplied: [{ source: { id: "source-1", origin: ORIGIN }, channels: 412 }],
  listed: 1180,
  guideChannels: 1204,
  fetchedAt: Date.now(),
  availability: "available",
  mapped: 1,
  unresolved: 0,
  processing: { state: "ready", channels: 412, programmes: 80_000, until: null, fetchedAt: 0 },
};

/** A guide channel of the source, as the main process names it. */
const sourced = (id: string) => ({ ref: `source-1:${id}`, id, origin: ORIGIN });

const channel = (id: string, title: string, mappedTo: string | null = null): MapChannel => ({
  id,
  number: Number(id),
  title,
  shown: mappedTo === null ? null : sourced(mappedTo),
  mapped: mappedTo === null ? null : sourced(mappedTo),
  listed: true,
});
/** The channels a search of those without programmes found. */
const WITHOUT: MapChannelPage = {
  total: 3,
  channels: [
    channel("12", "Canal Nord Sport"),
    channel("14", "Canal Nord HD"),
    channel("22", "News 24", "news24.ex"),
  ],
  revision: "7.2",
};
const OPTIONS: GuideChannelPage = {
  total: 3,
  listed: 1204,
  channels: [
    { ...sourced("canalnord.ex"), name: "Canal Nord", programmes: true },
    { ...sourced("canalnord-plus1.ex"), name: "Canal Nord +1", programmes: false },
    { ...sourced("canalnordsport.ex"), name: "Canal Nord Sport", programmes: true },
  ],
};

/** Flushes React while waiting for the requested list, mapping or keyboard focus. */
const ready = (check: () => void) =>
  vi.waitFor(
    async () => {
      await act(async () => {});
      check();
    },
    { interval: 10 },
  );

/** The sheet, opened from Holiday house's Map, with its first channels and their guide's answered. */
async function sheet(pages: { channels?: MapChannelPage; options?: GuideChannelPage } = {}) {
  ipc.reset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["subscriptions"], [holiday]);
  client.setQueryData(["guide", "status"], [guide]);
  client.setQueryData(["library", "status"], []);
  client.setQueryData(["ondemand", "status"], { lists: [], metadata: null });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SubscriptionSection))),
  );
  // As the app does: what the main process reports of the guides is read again.
  const stopSync = syncGuideUpdates(client);
  unmount = () => {
    stopSync();
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  const dialog = () => document.body.querySelector('[role="dialog"]');
  const lists = () => [...(dialog()?.querySelectorAll('[role="listbox"]') ?? [])];
  /** A list's rows as they read, with the one the keyboard is on marked. */
  const rows = (list: Element | undefined) =>
    [...(list?.querySelectorAll('[role="option"]') ?? [])].map(
      (row) => `${row.getAttribute("aria-selected") === "true" ? "> " : ""}${row.textContent}`,
    );
  const press = async (target: Element | null | undefined, key: string) => {
    await act(async () => {
      target?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  };
  const click = async (element: Element | null | undefined) => {
    await act(async () => (element as HTMLElement | null | undefined)?.click());
  };
  const type = async (field: Element | null | undefined, value: string) => {
    const method =
      field === dialog()?.querySelector("input") ? "guide.mapChannels" : "guide.mapOptions";
    const asked = ipc.argsOf(method).length;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(field, value);
      field?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ready(() => {
      expect(ipc.argsOf(method)).toHaveLength(asked + 1);
      expect(ipc.argsOf(method).at(-1)).toMatchObject({ query: value.trim() });
    });
  };

  const channels = ipc.hold("guide.mapChannels");
  const options = ipc.hold("guide.mapOptions");
  await click(container.querySelector('[aria-label="Map channels of Holiday house"]'));
  await ready(() => expect(ipc.argsOf("guide.mapChannels")).toHaveLength(1));
  channels.resolve(pages.channels ?? WITHOUT);
  await ready(() => {
    expect(rows(lists()[0]).length).toBeGreaterThan(0);
    expect(ipc.argsOf("guide.mapOptions")).toHaveLength(1);
  });
  options.resolve(pages.options ?? OPTIONS);
  await ready(() => {
    expect(rows(lists()[1])).toHaveLength((pages.options ?? OPTIONS).channels.length + 1);
    expect(document.activeElement).toBe(lists()[0]);
  });
  return {
    dialog,
    press,
    click,
    type,
    channels: () => rows(lists()[0]),
    options: () => rows(lists()[1]),
    channelList: () => lists()[0],
    optionList: () => lists()[1],
    fields: () => [...(dialog()?.querySelectorAll("input") ?? [])],
    button: (text: string, within: Element | null | undefined = dialog()) =>
      [...(within?.querySelectorAll("button") ?? [])].find(
        (each) => each.textContent?.trim() === text,
      ),
    alert: () => dialog()?.querySelector('[role="alert"]')?.textContent ?? null,
  };
}

describe("mapping channels to a guide's by hand", () => {
  it("lists the channels without programmes a page at a time, and the guide's channels for the one picked", async () => {
    const { dialog, channels, options, fields } = await sheet();

    expect(dialog()?.textContent).toContain("Map channels");
    expect(dialog()?.textContent).toContain("Holiday house · 768 channels without programmes");
    // Asked for by the page, never all at once.
    expect(ipc.argsOf("guide.mapChannels")).toEqual([
      { subscriptionId: holiday.id, filter: "without", query: "", offset: 0, limit: 120 },
    ]);
    expect(channels()).toEqual([
      "> 12Canal Nord Sportno id match",
      "14Canal Nord HDno id match",
      "22News 24mapped · guide.example.org · news24.ex",
    ]);
    // The first channel is picked, and its name is where the search of the guide starts.
    expect(dialog()?.textContent).toContain("Guide for Canal Nord Sport");
    expect(fields()[1]?.value).toBe("Canal Nord Sport");
    expect(ipc.argsOf("guide.mapOptions")).toEqual([
      { subscriptionId: holiday.id, query: "Canal Nord Sport", offset: 0, limit: 120 },
    ]);
    // Each guide channel shows its name and its id; none is picked for the viewer.
    expect(options()).toEqual([
      "> Automatic · no id matchCurrent",
      "Canal Nordguide.example.org · canalnord.exMap",
      "Canal Nord +1 · no programmesguide.example.org · canalnord-plus1.exMap",
      "Canal Nord Sportguide.example.org · canalnordsport.exMap",
    ]);
    expect(dialog()?.textContent).toContain(`3 of ${(1204).toLocaleString()} shown`);
    expect(ipc.methods()).not.toContain("guide.map");
  });

  it("draws only the channels in view of a long list, and asks for no more than its first page", async () => {
    const page = Array.from({ length: 120 }, (_, at) =>
      channel(String(at + 1), `Channel ${at + 1}`),
    );
    const { channels } = await sheet({ channels: { total: 768, channels: page, revision: "7.2" } });

    expect(channels().length).toBeLessThan(40);
    expect(channels()[0]).toBe("> 1Channel 1no id match");
    expect(ipc.argsOf("guide.mapChannels")).toHaveLength(1);
  });

  it("maps the channel to the exact guide channel picked, reads the channels again, and back to automatic", async () => {
    const { click, button, channels, options, optionList } = await sheet();
    const sport = channel("12", "Canal Nord Sport", "canalnordsport.ex");
    /** Answers the channels' next reading with the first of them as `first`. */
    const readAgain = (first: MapChannel) =>
      ipc.hold("guide.mapChannels").resolve({
        ...WITHOUT,
        channels: [first, ...WITHOUT.channels.slice(1)],
      });
    const mapped = ipc.hold("guide.map");
    readAgain(sport);

    await click(button("Map", optionList()?.querySelectorAll('[role="option"]')[3]));
    await ready(() => expect(ipc.argsOf("guide.map")).toHaveLength(1));
    mapped.resolve(sport);
    await ready(() =>
      expect(channels()[0]).toBe(
        "> 12Canal Nord Sportmapped · guide.example.org · canalnordsport.ex",
      ),
    );

    expect(ipc.argsOf("guide.map")).toEqual([
      {
        subscriptionId: holiday.id,
        channelId: "12",
        guide: "source-1:canalnordsport.ex",
        revision: "7.2",
      },
    ]);
    // The list shows what the main process answers once it is mapped, not what was read before.
    expect(ipc.argsOf("guide.mapChannels")).toHaveLength(2);
    expect(channels()[0]).toBe(
      "> 12Canal Nord Sportmapped · guide.example.org · canalnordsport.ex",
    );
    expect(options()[0]).toBe("> AutomaticRestore");
    expect(options()[3]).toBe("Canal Nord Sportguide.example.org · canalnordsport.exCurrent");

    const restored = ipc.hold("guide.map");
    readAgain(channel("12", "Canal Nord Sport"));
    await click(button("Restore"));
    await ready(() => expect(ipc.argsOf("guide.map")).toHaveLength(2));
    restored.resolve(channel("12", "Canal Nord Sport"));
    await ready(() => expect(channels()[0]).toBe("> 12Canal Nord Sportno id match"));

    expect(ipc.argsOf("guide.map")[1]).toMatchObject({ channelId: "12", guide: null });
    expect(ipc.argsOf("guide.mapChannels")).toHaveLength(3);
    expect(channels()[0]).toBe("> 12Canal Nord Sportno id match");
  });

  it("moves on to the next channel once the one mapped leaves the list, with every page after it in step", async () => {
    // What the main process lists without programmes: 250 channels, less each one mapped.
    const without = Array.from({ length: 250 }, (_, at) =>
      channel(String(at + 1), `Channel ${at + 1}`),
    );
    /** Answers the next reading of a page from `without` as it is then, as the main process does. */
    const page = () => {
      const held = ipc.hold("guide.mapChannels");
      return (offset: number) =>
        held.resolve({
          total: without.length,
          channels: without.slice(offset, offset + 120),
          revision: "7.2",
        });
    };
    const { click, button, dialog, channels, channelList, optionList } = await sheet({
      channels: { total: 250, channels: without.slice(0, 120), revision: "7.2" },
    });
    const mapped = ipc.hold("guide.map");
    const first = page();

    await click(button("Map", optionList()?.querySelectorAll('[role="option"]')[1]));
    await ready(() => expect(ipc.argsOf("guide.map")).toHaveLength(1));
    mapped.resolve(channel("1", "Channel 1", "canalnord.ex"));
    without.shift();
    await ready(() => expect(ipc.argsOf("guide.mapChannels")).toHaveLength(2));
    // The page that was read is asked for again, and answered as the list is by now.
    expect(ipc.argsOf("guide.mapChannels").map((each) => each.offset)).toEqual([0, 0]);
    first(0);
    await ready(() => expect(channels()[0]).toBe("> 2Channel 2no id match"));

    // The channel has programmes now and left; the keyboard is on the one that took its place.
    expect(dialog()?.textContent).toContain("Channels · 249");
    expect(channels()[0]).toBe("> 2Channel 2no id match");
    expect(dialog()?.textContent).toContain("Guide for Channel 2");
    expect(document.activeElement).toBe(channelList());

    // Further down, where the first page ends and the second begins.
    const second = page();
    const list = channelList();
    await act(async () => {
      if (list) list.scrollTop = 112 * 40;
      list?.dispatchEvent(new Event("scroll"));
    });
    await ready(() =>
      expect(ipc.argsOf("guide.mapChannels").at(-1)).toMatchObject({ offset: 120 }),
    );
    expect(ipc.argsOf("guide.mapChannels").at(-1)).toMatchObject({ offset: 120 });
    second(120);
    await ready(() =>
      expect(channels().some((row) => row.startsWith("122Channel 122"))).toBe(true),
    );

    // No channel is left out between the pages, and none shows twice.
    const numbers = channels().map((row) => Number.parseInt(row, 10));
    expect(numbers).toContain(121);
    expect(numbers).toContain(122);
    expect(numbers).toEqual(numbers.map((_, at) => (numbers[0] ?? 0) + at));
  });

  it("goes through both lists by the keyboard, and maps with Enter", async () => {
    const { press, channels, options, channelList, optionList, fields } = await sheet();
    expect(document.activeElement).toBe(channelList());
    ipc.hold("guide.mapOptions").resolve(OPTIONS);

    await press(channelList(), "ArrowDown");

    await ready(() =>
      expect(ipc.argsOf("guide.mapOptions").at(-1)).toMatchObject({ query: "Canal Nord HD" }),
    );
    await ready(() => expect(options()).toHaveLength(OPTIONS.channels.length + 1));
    expect(channels()[1]).toBe("> 14Canal Nord HDno id match");
    expect(ipc.argsOf("guide.mapOptions").at(-1)).toMatchObject({ query: "Canal Nord HD" });
    // Enter goes on to that channel's guide channels, and Down into them.
    await press(channelList(), "Enter");
    await ready(() => expect(document.activeElement).toBe(fields()[1]));
    expect(document.activeElement).toBe(fields()[1]);
    await press(fields()[1], "ArrowDown");
    await ready(() => expect(document.activeElement).toBe(optionList()));
    expect(document.activeElement).toBe(optionList());
    await press(optionList(), "ArrowDown");
    expect(options()[1]).toBe("> Canal Nordguide.example.org · canalnord.exMap");

    const mapped = ipc.hold("guide.map");
    const hd = channel("14", "Canal Nord HD", "canalnord.ex");
    ipc.hold("guide.mapChannels").resolve({
      ...WITHOUT,
      channels: WITHOUT.channels.map((each) => (each.id === hd.id ? hd : each)),
    });
    await press(optionList(), "Enter");
    await ready(() => expect(ipc.argsOf("guide.map")).toHaveLength(1));
    mapped.resolve(hd);
    await ready(() => {
      expect(channels()[1]).toBe("> 14Canal Nord HDmapped · guide.example.org · canalnord.ex");
      expect(document.activeElement).toBe(channelList());
    });

    expect(ipc.argsOf("guide.map")).toEqual([
      {
        subscriptionId: holiday.id,
        channelId: "14",
        guide: "source-1:canalnord.ex",
        revision: "7.2",
      },
    ]);
    // The keyboard is back in the channels, to go on to the next.
    expect(document.activeElement).toBe(channelList());
    expect(channels()[1]).toBe("> 14Canal Nord HDmapped · guide.example.org · canalnord.ex");
    // Up from the first guide channel leaves for the channels too.
    await press(optionList(), "ArrowUp");
    await press(optionList(), "ArrowUp");
    expect(document.activeElement).toBe(channelList());
  });

  it("searches and filters the channels, and searches the guide by what is typed", async () => {
    const { type, dialog, fields, channels, options } = await sheet();

    ipc.hold("guide.mapChannels").resolve({
      total: 1,
      channels: [channel("14", "Canal Nord HD")],
      revision: "7.2",
    });
    await type(fields()[0], " nord hd ");
    expect(ipc.argsOf("guide.mapChannels").at(-1)).toMatchObject({
      filter: "without",
      query: "nord hd",
      offset: 0,
    });
    await ready(() => expect(channels()).toEqual(["> 14Canal Nord HDno id match"]));
    expect(channels()).toEqual(["> 14Canal Nord HDno id match"]);

    ipc
      .hold("guide.mapOptions")
      .resolve({ total: 1, listed: 1204, channels: OPTIONS.channels.slice(0, 1) });
    await type(fields()[1], "canalnord.ex");
    expect(ipc.argsOf("guide.mapOptions").at(-1)).toMatchObject({ query: "canalnord.ex" });
    await ready(() =>
      expect(options()).toEqual([
        "> Automatic · no id matchCurrent",
        "Canal Nordguide.example.org · canalnord.exMap",
      ]),
    );
    expect(options()).toEqual([
      "> Automatic · no id matchCurrent",
      "Canal Nordguide.example.org · canalnord.exMap",
    ]);

    const select = dialog()?.querySelector("select");
    ipc.hold("guide.mapChannels").resolve({ total: 0, channels: [], revision: "7.2" });
    await act(async () => {
      if (select) select.value = "mapped";
      select?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await ready(() => {
      expect(ipc.argsOf("guide.mapChannels").at(-1)).toMatchObject({ filter: "mapped" });
      expect(dialog()?.textContent).toContain("No channel matches.");
    });
    expect(ipc.argsOf("guide.mapChannels").at(-1)).toMatchObject({ filter: "mapped" });
    expect(dialog()?.textContent).toContain("No channel matches.");
  });

  it("says when the guide is another one than the lists were read from, and reads them again", async () => {
    const { click, button, alert, optionList } = await sheet();
    const asked = ipc.argsOf("guide.mapChannels").length;
    ipc.hold("guide.map").reject({ kind: "guide", failure: { kind: "changed" } });

    await click(button("Map", optionList()?.querySelectorAll('[role="option"]')[1]));

    await ready(() => expect(alert()).toBe("The guide changed meanwhile, so nothing was changed."));
    expect(alert()).toBe("The guide changed meanwhile, so nothing was changed.");
    expect(ipc.argsOf("guide.mapChannels").length).toBeGreaterThan(asked);
  });

  it("reads the channels again when the main process reports a guide that loaded meanwhile", async () => {
    const { channels } = await sheet();
    ipc.hold("guide.mapChannels").resolve({
      ...WITHOUT,
      total: 1,
      channels: WITHOUT.channels.slice(1, 2),
    });

    await act(async () => ipc.emit("guide.updated", null));
    await ready(() => expect(channels()).toEqual(["> 14Canal Nord HDno id match"]));

    expect(channels()).toEqual(["> 14Canal Nord HDno id match"]);
  });

  it("leaves a channel the provider no longer lists only its mapping to take away, and closes on Done", async () => {
    const gone: MapChannel = {
      ...channel("77", "Old Channel", "old.ex"),
      number: null,
      shown: null,
      listed: false,
    };
    const { click, button, channels, options, dialog, fields } = await sheet({
      channels: { total: 1, channels: [gone], revision: "7.2" },
    });

    expect(channels()).toEqual(["> Old Channelno longer listed"]);
    // Nothing is searched for it, and nothing can be mapped anew.
    expect(fields()[1]?.value).toBe("");
    expect(options()[0]).toBe("> AutomaticRestore");
    const cleared = ipc.hold("guide.map");
    ipc.hold("guide.mapChannels").resolve({ total: 0, channels: [], revision: "7.2" });
    await click(button("Restore"));
    await ready(() => expect(ipc.argsOf("guide.map")).toHaveLength(1));
    cleared.resolve(null);
    await ready(() => expect(channels()).toEqual([]));
    expect(ipc.argsOf("guide.map")).toEqual([
      { subscriptionId: holiday.id, channelId: "77", guide: null, revision: "7.2" },
    ]);
    // Nothing is left of it once its mapping is gone.
    expect(channels()).toEqual([]);

    await click(button("Done"));
    await ready(() => expect(dialog()).toBeNull());
    expect(dialog()).toBeNull();
  });
});
