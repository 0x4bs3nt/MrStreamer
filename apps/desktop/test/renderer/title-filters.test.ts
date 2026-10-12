// @vitest-environment happy-dom
import { ipc, SAVED, SUBSCRIPTION } from "./support.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { FilterOptions } from "@mrstreamer/contracts/title-filters";
import type { Title, TitleKind, MovieDetails } from "@mrstreamer/contracts/ondemand";
import { defaultSubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { openCollection, TitlesPage } from "../../src/renderer/src/features/titles/TitlesPage.tsx";
import { useUi } from "../../src/renderer/src/app/ui-store.ts";
import { queries } from "../../src/renderer/src/lib/queries.ts";
import { DetailsView } from "../../src/renderer/src/features/titles/DetailsView.tsx";
import type { DetailsTarget } from "../../src/renderer/src/app/ui-store.ts";

const options: FilterOptions = {
  qualities: ["4k", "full-hd", "hd", "unknown"],
  languages: ["en", "nl", "de", "fr", "es", "it", "pt", "pl", "tr", "multi", "unknown"],
  verified: [],
  files: 0,
};
const film: Title = {
  kind: "movie",
  key: "movie:603",
  subscriptionId: SUBSCRIPTION,
  id: "4k",
  name: "Night Harbour 4K (EN)",
  title: "Night Harbour",
  originalTitle: null,
  originalLanguage: "en",
  tags: ["4K", "EN"],
  year: 2024,
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  addedAt: null,
  adult: false,
  tmdbId: "603",
  genres: [],
  versions: [
    { subscriptionId: SUBSCRIPTION, id: "4k", tags: ["4K", "EN"] },
    { subscriptionId: SUBSCRIPTION, id: "hd", tags: ["1080p", "EN"] },
  ],
};

let cleanup = () => {};
afterEach(() => {
  cleanup();
  ipc.reset();
  useUi.setState({ details: null, searchOpen: false });
});

async function mount() {
  const subscription = { ...SAVED, kind: "m3u" as const, playlistMapped: true };
  ipc.always("subscription.list", [subscription]);
  ipc.always("ondemand.status", { lists: [], metadata: null });
  ipc.always("ondemand.collection", { name: "All", titles: [], total: 10 });
  ipc.always("ondemand.filterOptions", options);
  useUi.setState({
    view: "movies",
    details: null,
    playingTitle: false,
    searchOpen: false,
    settings: null,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queries.subscriptions().queryKey, [subscription]);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (kind: TitleKind, active = true) =>
    act(async () =>
      root.render(
        createElement(QueryClientProvider, { client }, createElement(TitlesPage, { kind, active })),
      ),
    );
  const showDetails = (target: DetailsTarget) =>
    act(async () =>
      root.render(
        createElement(QueryClientProvider, { client }, createElement(DetailsView, { target })),
      ),
    );
  cleanup = () => {
    act(() => root.unmount());
    client.clear();
    container.remove();
  };
  const until = (check: () => void) =>
    vi.waitFor(async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
      check();
    });
  const group = (label: string) =>
    container.querySelector<HTMLElement>(`[role=group][aria-label="${label}"]`)!;
  const click = async (label: string, inGroup?: string) => {
    if (inGroup && !document.querySelector(`[role="menu"][aria-label="${inGroup}"]`)) {
      const trigger = group(inGroup).querySelector<HTMLButtonElement>("button")!;
      await act(async () => trigger.click());
      await until(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
    }
    const parent = inGroup ? document.querySelector('[role="menu"]')! : container;
    const button = [...parent.querySelectorAll<HTMLElement>("button, [role=menuitemradio]")].find(
      (each) => each.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
    // After choosing with the pointer, leave the menu before handing keys to the grid.
    if (inGroup) await act(async () => (document.activeElement as HTMLElement)?.blur());
  };
  await render("movie");
  await click("All movies");
  await until(() => expect(container.textContent).toContain("10 of 10"));
  return { client, container, group, click, render, until, showDetails };
}

it("keeps grid arrows and Enter after a mouse click on an inline filter word", async () => {
  const page = await mount();
  const second: Title = {
    ...film,
    id: "second",
    key: "movie:second",
    versions: [{ subscriptionId: SUBSCRIPTION, id: "second", tags: ["4K", "EN"] }],
  };
  ipc.always("ondemand.collection", {
    name: "All",
    titles: [film, second],
    total: 2,
    unfiltered: 10,
  });
  await page.click("4K", "Quality");
  await page.until(() => expect(page.container.textContent).toContain("2 of 10"));
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
  });
  await act(async () => {
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
  });
  expect(useUi.getState().details).toEqual({
    kind: "movie",
    subscriptionId: SUBSCRIPTION,
    id: "second",
    asked: true,
  });
});

it("keeps additional languages reachable in one menu and returns keyboard focus to its trigger", async () => {
  const page = await mount();
  const trigger = page.group("Language").querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.click());
  await page.until(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  const polish = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
    (each) => each.textContent === "Polski",
  )!;
  await act(async () => {
    polish.focus();
    polish.click();
  });
  await page.until(() =>
    expect(ipc.argsOf("ondemand.collection").at(-1)?.filters).toEqual({ language: "pl" }),
  );
  expect(document.activeElement).toBe(trigger);
  expect(trigger.textContent).toContain("Polski");
  await page.click("Any", "Language");
  await page.until(() => expect(trigger.textContent).toBe("Language"));
});

it.each(["Quality", "Sort"])(
  "leaves a collection with Escape from a closed %s control",
  async (label) => {
    const page = await mount();
    await act(async () => openCollection("movie", "genre:Drama"));
    const back = () =>
      [...page.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Back",
      );
    await page.until(() => expect(back()).toBeDefined());
    const trigger = page.group(label).querySelector<HTMLButtonElement>("button")!;
    await act(async () => {
      trigger.focus();
      trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await page.until(() => expect(back()).toBeUndefined());
  },
);

it("closes the popup on the first Escape and leaves the collection on the next", async () => {
  const page = await mount();
  await act(async () => openCollection("movie", "genre:Drama"));
  const trigger = page.group("Quality").querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.click());
  await page.until(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="menuitemradio"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  await page.until(() => expect(document.querySelector('[role="menu"]')).toBeNull());
  expect(page.container.textContent).toContain("Back");
  expect(document.activeElement).toBe(trigger);
  await act(async () =>
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  await page.until(() => expect(page.container.textContent).not.toContain("Back"));
});

it.each(["Quality", "Sort"])(
  "lets application modifier shortcuts pass the closed %s control",
  async (label) => {
    const page = await mount();
    const trigger = page.group(label).querySelector<HTMLButtonElement>("button")!;
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    try {
      await act(async () => {
        trigger.focus();
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }),
        );
        trigger.dispatchEvent(
          new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
        );
      });
      expect(shortcut).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("keydown", shortcut);
    }
  },
);

it.each(["filter", "4k tab", "normal list"] as const)(
  "opens the correct version over a remembered choice from %s and keeps menu alternatives",
  async (entry) => {
    const page = await mount();
    const details: MovieDetails = {
      kind: "movie",
      title: film,
      originalTitle: null,
      plot: null,
      genres: [],
      cast: [],
      directors: [],
      releaseDate: null,
      duration: null,
      backdropUrl: null,
    };
    page.client.setQueryData(queries.subscriptionPreferences(SUBSCRIPTION).queryKey, {
      ...defaultSubscriptionPreferences,
      titleVersions: { "movie:603": "hd" },
    });
    ipc.always("ondemand.collection", { name: "All", titles: [film], total: 1, unfiltered: 10 });
    ipc.always("ondemand.titles", [film]);
    ipc.always("viewing.progress", []);
    ipc.always("ondemand.details", details);
    if (entry === "filter") await page.click("4K", "Quality");
    else if (entry === "4k tab") await page.click("4K");
    else await page.client.invalidateQueries({ queryKey: ["ondemand", "collection"] });
    await page.until(() => expect(page.container.textContent).toContain("1 of 10"));
    if (entry === "filter") {
      const control = page.group("Quality").querySelector<HTMLButtonElement>("button")!;
      expect(document.activeElement).not.toBe(control);
      await act(async () => {
        control.focus();
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        control.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      });
      expect(useUi.getState().details).toBeNull();
      // Leaving a keyboard-focused word returns the keys to the grid.
      control.blur();
    }
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    const target = useUi.getState().details;
    expect(target).toEqual({
      kind: "movie",
      subscriptionId: SUBSCRIPTION,
      id: "4k",
      asked: entry !== "normal list",
    });
    await page.showDetails(target!);
    await page.until(() =>
      expect(ipc.argsOf("ondemand.details").at(-1)?.version.id).toBe(
        entry === "normal list" ? "hd" : "4k",
      ),
    );
    // Simply opening a matching tile does not rewrite the remembered preference.
    expect(ipc.argsOf("subscription.updatePreferences")).toHaveLength(0);
    await page.until(() =>
      expect(document.querySelector('[aria-label="Versions"]')).not.toBeNull(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Versions"]')!.click(),
    );
    await page.until(() => expect(document.querySelector('[role="menuitemradio"]')).not.toBeNull());
    const hd = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((item) =>
      item.textContent?.includes("FHD"),
    );
    expect(hd).toBeDefined();
    await act(async () => hd!.click());
    await page.until(() => expect(ipc.argsOf("ondemand.details").at(-1)?.version.id).toBe("hd"));
    await page.until(() =>
      expect(
        page.client.getQueryData<{ titleVersions: Record<string, string> }>(
          queries.subscriptionPreferences(SUBSCRIPTION).queryKey,
        )?.titleVersions["movie:603"],
      ).toBe("hd"),
    );
    const returning = useUi.getState().details!;
    // App unmounts this sheet while Settings or playback covers it.
    await page.render("movie");
    await page.showDetails(returning);
    await page.until(() =>
      expect(document.querySelector('[aria-label="Versions"]')).not.toBeNull(),
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[aria-label="Versions"]')!.click(),
    );
    await page.until(() =>
      expect(
        document.querySelector('[role="menuitemradio"][aria-checked="true"]')?.textContent,
      ).toContain("FHD"),
    );
  },
);

it("uses current-kind words, keeps Unknown and MULTI reachable, resets between kinds and makes no file reads", async () => {
  const page = await mount();
  await act(async () => page.group("Language").querySelector<HTMLButtonElement>("button")!.click());
  await page.until(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Polski"),
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("Unknown");
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("MULTI");
  await page.click("Polski", "Language");
  await page.until(() =>
    expect(ipc.argsOf("ondemand.collection")).toContainEqual(
      expect.objectContaining({ kind: "movie", id: "all", filters: { language: "pl" } }),
    ),
  );
  expect(page.group("Language").querySelector("button")?.textContent).toBe("LanguagePolski");
  ipc.always("ondemand.collection", { name: "All", titles: [], total: 3, unfiltered: 10 });
  await page.click("4K", "Quality");
  await page.until(() => expect(page.container.textContent).toContain("3 of 10"));
  expect(ipc.argsOf("ondemand.collection").at(-1)?.filters).toEqual({
    language: "pl",
    quality: "4k",
  });
  await page.click("Reset");
  await page.until(() =>
    expect(page.group("Quality").querySelector("button")?.textContent).toBe("Quality"),
  );
  await page.click("Unknown", "Language");
  await page.render("series");
  await page.until(() =>
    expect(page.group("Language").querySelector("button")?.textContent).toBe("Language"),
  );
  expect(
    ipc
      .argsOf("ondemand.collection")
      .filter((entry) => entry.kind === "series")
      .every((entry) => !entry.filters),
  ).toBe(true);
  await page.render("movie");
  expect(page.group("Language").querySelector("button")?.textContent).toBe("Language");
  expect(
    ipc
      .methods()
      .filter((method) => method === "ondemand.details" || method.startsWith("playback.")),
  ).toEqual([]);
});

it("refreshes locally verified choices after playback and keeps a late old-filter answer out of the new selection", async () => {
  const page = await mount();
  await page.render("movie", false);
  ipc.always("ondemand.filterOptions", {
    ...options,
    files: 1,
    verified: [
      { kind: "subtitles", language: "nl" },
      { kind: "audio", language: "unknown" },
    ],
  });
  await page.render("movie", true);
  await act(async () => page.group("Verified").querySelector<HTMLButtonElement>("button")!.click());
  await page.until(() =>
    expect(document.querySelector('[role="menu"]')?.textContent).toContain("Dutch subtitles"),
  );
  expect(document.querySelector('[role="menu"]')?.textContent).toContain("1 current file");
  await act(async () =>
    document
      .querySelector<HTMLElement>('[role="menu"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
  );
  const old = ipc.hold("ondemand.collection");
  await page.click("4K", "Quality");
  await page.until(() =>
    expect(ipc.argsOf("ondemand.collection").at(-1)?.filters?.quality).toBe("4k"),
  );
  const current = ipc.hold("ondemand.collection");
  await page.click("Full HD", "Quality");
  await page.until(() =>
    expect(ipc.argsOf("ondemand.collection").at(-1)?.filters?.quality).toBe("full-hd"),
  );
  await act(async () => current.resolve({ name: "All", titles: [], total: 2, unfiltered: 10 }));
  await page.until(() => expect(page.container.textContent).toContain("2 of 10"));
  await act(async () => old.resolve({ name: "All", titles: [], total: 7, unfiltered: 10 }));
  expect(page.container.textContent).not.toContain("7 of 10");
  ipc.always("ondemand.collection", { name: "All", titles: [], total: 0, unfiltered: 10 });
  await page.click("Dutch subtitles", "Verified");
  await page.until(() => expect(page.container.textContent).toContain("0 of 10"));
  expect(page.container.textContent).toContain("Filtering opens no files.");
  expect(ipc.methods()).not.toContain("ondemand.file");
});

it("filters the tab search while global search remains unfiltered and filter-button keys do not play a title", async () => {
  const page = await mount();
  ipc.always("ondemand.searchKind", { titles: [], total: 0, unfiltered: 4 });
  ipc.always("ondemand.search", { movies: [], series: [] });
  await page.click("4K", "Quality");
  const field = page.container.querySelector<HTMLInputElement>('[aria-label="Search movies"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      field,
      "Harbour",
    );
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.until(() =>
    expect(ipc.argsOf("ondemand.searchKind")).toContainEqual({
      kind: "movie",
      query: "Harbour",
      filters: { quality: "4k" },
    }),
  );
  await page.client.fetchQuery(queries.titleSearch("Harbour"));
  expect(ipc.argsOf("ondemand.search").at(-1)).toEqual({ query: "Harbour" });
  const quality = page.group("Quality").querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    quality.focus();
    quality.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  expect(useUi.getState().details).toBeNull();
  expect(ipc.argsOf("ondemand.details")).toHaveLength(0);
  // Leave the singleton tab search where it began, so later mounted pages start clean.
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
});

const second: Title = {
  ...film,
  id: "second",
  key: "movie:second",
  versions: [{ subscriptionId: SUBSCRIPTION, id: "second", tags: ["4K", "EN"] }],
};

it("Shift+ArrowRight on a closed filter control stays out of the grid", async () => {
  const page = await mount();
  ipc.always("ondemand.collection", {
    name: "All",
    titles: [film, second],
    total: 2,
    unfiltered: 10,
  });
  await page.client.invalidateQueries({ queryKey: ["ondemand", "collection"] });
  await page.until(() => expect(page.container.textContent).toContain("2 of 10"));
  const control = page.group("Quality").querySelector<HTMLButtonElement>("button")!;
  await act(async () => {
    control.focus();
    control.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
    );
  });
  control.blur();
  await act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  // The grid's own selection should still be the first poster.
  expect(useUi.getState().details?.id).toBe("4k");
});

it("Shift+Enter inside an open filter menu does not open a poster", async () => {
  const page = await mount();
  ipc.always("ondemand.collection", {
    name: "All",
    titles: [film, second],
    total: 2,
    unfiltered: 10,
  });
  await page.client.invalidateQueries({ queryKey: ["ondemand", "collection"] });
  await page.until(() => expect(page.container.textContent).toContain("2 of 10"));
  const trigger = page.group("Quality").querySelector<HTMLButtonElement>("button")!;
  await act(async () => trigger.click());
  await page.until(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
  await act(async () => {
    document
      .querySelector<HTMLElement>('[role="menuitemradio"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
  });
  expect(useUi.getState().details).toBeNull();
});

it("announces a collection's count when filtering changes it", async () => {
  const page = await mount();
  await act(async () => openCollection("movie", "genre:Drama"));
  const count = page.container.querySelector<HTMLElement>('[aria-live="polite"]');
  expect(count).not.toBeNull();
  await page.until(() => expect(count?.textContent).toBe("10 of 10"));
  ipc.always("ondemand.collection", { name: "Drama", titles: [], total: 2, unfiltered: 10 });
  await page.click("4K", "Quality");
  await page.until(() => expect(count?.textContent).toBe("2 of 10"));
});
