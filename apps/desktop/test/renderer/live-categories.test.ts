// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category } from "@mrstreamer/contracts/library";
import type { ChannelList } from "../../src/renderer/src/app/ui-store.ts";
import { ListPicker } from "../../src/renderer/src/features/live/ListPicker.tsx";
import { useListPicker } from "../../src/renderer/src/features/live/lists.ts";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { setLanguage, t } from "@mrstreamer/core/i18n";
import type { Locale } from "@mrstreamer/contracts/language";

const OTHER = "870468e9-b944-4e10-bcfa-6330f80b45dc";
const category = (
  id: string,
  group: string | null,
  title: string,
  count = 14,
  subscriptionId = SUBSCRIPTION,
): Category => ({
  id,
  subscriptionId,
  name: title,
  title,
  group,
  channelCount: count,
  members: [{ id, subscriptionId }],
});
const CATEGORIES = [
  category("be-sport", "Belgium", "Sport", 88),
  category("odd", null, "Ungrouped", 5),
  category("be-news", "Belgium", "Nieuws", 36),
  category("uk-sport", "United Kingdom", "Sports", 412),
  category("backup", "Belgium", "Sport", 64, OTHER),
];
let cleanup = () => {};
afterEach(() => {
  cleanup();
  setLanguage({ locale: "en-US", formats: "en-US" });
});
async function picker(
  categories: readonly Category[] = CATEGORIES,
  selected: ChannelList = { kind: "all" },
) {
  ipc.reset();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.categories().queryKey, categories);
  client.setQueryData(queries.subscriptions().queryKey, [
    { ...SAVED, name: "Main" },
    { ...SAVED, id: OTHER, name: "Backup" },
  ]);
  client.setQueryData(queries.viewing().queryKey, {
    favourites: [{ subscriptionId: SUBSCRIPTION, id: "f" }],
    recent: [{ subscriptionId: SUBSCRIPTION, id: "r" }],
    continueWatching: [],
    marked: [],
    sequence: 1,
  });
  client.setQueryData(queries.libraryStatus().queryKey, [
    {
      subscriptionId: SUBSCRIPTION,
      channelCount: 63412,
      fetchedAt: 1,
      failure: null,
      failedAt: null,
    },
  ]);
  const onPick = vi.fn();
  const onChannels = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  function View() {
    const state = useListPicker(selected);
    return createElement(ListPicker, {
      picker: state,
      selected,
      highlight: null,
      onPick,
      onChannels,
    });
  }
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(View))),
  );
  cleanup = () => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  };
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>("[data-entry]")];
  const field = () => container.querySelector<HTMLInputElement>("input")!;
  const click = async (title: string) =>
    act(async () => {
      const button = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.title === title || button.getAttribute("aria-label") === title,
      );
      expect(button, title).toBeDefined();
      button!.click();
    });
  const type = async (text: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        field(),
        text,
      );
      field().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = async (key: string) =>
    act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
      );
    });
  return { container, client, rows, field, click, type, key, onPick, onChannels };
}

describe("countries then categories", () => {
  it("keeps shortcuts and ungrouped categories in provider order, opens one country and returns focus to it", async () => {
    const p = await picker();
    expect(p.rows().map((row) => row.title)).toEqual([
      "Favourites",
      "Recently watched",
      "All channels",
      "Belgium",
      "Ungrouped",
      "United Kingdom",
    ]);
    expect(p.rows()[3]?.textContent).toContain("188");
    await p.click("Belgium");
    expect(p.rows().map((row) => row.title)).toEqual(["Sport · Main", "Nieuws", "Sport · Backup"]);
    expect(document.activeElement).toBe(p.rows()[0]);
    await p.key("ArrowLeft");
    expect(document.activeElement?.textContent).toContain("Belgium");
    await p.key("ArrowRight");
    expect(p.onChannels).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(p.rows()[3]);
    await p.click("Ungrouped");
    expect(p.onPick).toHaveBeenLastCalledWith({
      kind: "category",
      category: { subscriptionId: SUBSCRIPTION, id: "odd" },
    });
    await p.click("Favourites");
    await p.click("Recently watched");
    await p.click("All channels");
    expect(p.onPick.mock.calls.slice(-3).map(([list]) => list.kind)).toEqual([
      "favourites",
      "recent",
      "all",
    ]);
  });

  it("finds countries and categories across the catalogue, keeps source identity and offers keyboard selection", async () => {
    const p = await picker();
    await p.type("sport");
    expect(p.rows().map((row) => row.title)).toEqual([
      "Sport · Belgium · Main",
      "Sports · United Kingdom",
      "Sport · Belgium · Backup",
    ]);
    await act(async () => p.field().focus());
    await p.key("ArrowDown");
    await p.key("End");
    await p.key("Enter");
    expect(p.onPick).toHaveBeenLastCalledWith({
      kind: "category",
      category: { subscriptionId: OTHER, id: "backup" },
    });
    await p.type("belgium");
    expect(p.rows()).toHaveLength(3);
    await p.type("xyzzy");
    expect(p.rows()).toHaveLength(0);
    expect(p.container.querySelector('[role="status"]')?.textContent).toBe("No categories match.");
    await act(async () => p.field().focus());
    await p.key("Escape");
    expect(p.field().value).toBe("");
    expect(p.rows()).toHaveLength(6);
  });

  it("opens a remembered member inside its country when data arrives and recovers when that country disappears", async () => {
    const p = await picker([], {
      kind: "category",
      category: { subscriptionId: SUBSCRIPTION, id: "be-news" },
    });
    await act(async () => p.client.setQueryData(queries.categories().queryKey, CATEGORIES));
    await vi.waitFor(() => expect(p.rows()[1]?.getAttribute("aria-current")).toBe("true"));
    expect(p.rows()[1]?.getAttribute("aria-current")).toBe("true");
    await act(async () => p.client.setQueryData(queries.categories().queryKey, [CATEGORIES[3]!]));
    await vi.waitFor(() =>
      expect(p.rows().map((row) => row.title)).toEqual([
        "Favourites",
        "Recently watched",
        "All channels",
        "United Kingdom",
      ]),
    );
  });

  it.each<Locale>(["en-US", "nl-NL"])(
    "keeps a 63,000-channel catalogue compact and searchable in %s",
    async (locale) => {
      setLanguage({ locale, formats: locale });
      const large = Array.from({ length: 4500 }, (_, i) =>
        category(String(i), `Country ${Math.floor(i / 30)}`, `Category ${i}`, 14),
      );
      const p = await picker(large);
      expect(p.rows()).toHaveLength(153);
      expect(p.field().placeholder).toBe(t("Find"));
      await p.type("country 149 category 4499");
      expect(p.rows()).toHaveLength(1);
      await p.click("Category 4499 · Country 149");
      expect(p.onPick).toHaveBeenLastCalledWith({
        kind: "category",
        category: { subscriptionId: SUBSCRIPTION, id: "4499" },
      });
    },
  );
});
