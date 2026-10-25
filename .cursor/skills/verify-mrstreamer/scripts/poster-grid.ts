// Poster-grid focus through the real built window. Movies > All movies, the Movies search and the
// Watchlist share one grid: the keys move one selection that DOM focus follows, the selected
// poster is the grid's one Tab stop, names say title and year and list items their place, and
// identity holds across pages, a 960x600 window and larger text. Closing details puts the focus
// back on the poster that opened them, and a removal on the tile that took its place. Keys and
// clicks go through CDP; DOM and accessibility-tree reads observe the result.
import type { Driver } from "./language.ts";

const GRID = `document.querySelector('[role="list"]:has([role="listitem"][data-index])')`;
const DIALOG_TITLE = `document.querySelector('[role="dialog"] h2')?.textContent ?? null`;

/** The focused tile and the ringed one, the grid's Tab stops and where the focus is drawn. */
const STATE = `(() => {
  const grid = ${GRID};
  const active = document.activeElement;
  const item = active?.closest('[role="listitem"][data-index]') ?? null;
  const ring = grid?.querySelector('span.ring-2.ring-white')?.closest('[role="listitem"]') ?? null;
  const scroller = grid?.parentElement ?? null;
  const box = active?.getBoundingClientRect();
  const view = scroller?.getBoundingClientRect();
  const rowTops = [...(grid?.children ?? [])].map(row => row.getBoundingClientRect().top).sort((a, b) => a - b);
  const rowHeight = Math.min(...rowTops.slice(1).map((top, at) => top - rowTops[at]).filter(height => height > 0));
  const tiles = [...(grid?.querySelectorAll('[role="listitem"]') ?? [])];
  const top = tiles.length ? Math.min(...tiles.map((tile) => tile.getBoundingClientRect().top)) : 0;
  const lines = item ? [...item.querySelectorAll('button span.truncate')].map((line) => line.textContent) : [];
  return {
    inGrid: !!item && !!grid?.contains(item),
    index: item ? Number(item.dataset.index) : null,
    posinset: item ? Number(item.getAttribute('aria-posinset')) : null,
    setsize: item ? Number(item.getAttribute('aria-setsize')) : null,
    tag: active?.tagName ?? null,
    label: active?.getAttribute('aria-label') ?? null,
    title: active?.getAttribute('title') ?? null,
    name: lines[0] ?? null,
    caption: lines[1] ?? null,
    remove: !!active?.hasAttribute('data-remove'),
    ringIndex: ring ? Number(ring.dataset.index) : null,
    tabStops: grid ? grid.querySelectorAll('[tabindex="0"]').length : 0,
    // Mostly shown: with large text in a small window one tile is taller than the grid's view.
    inView: !!(box && view && Math.min(box.bottom, view.bottom) - Math.max(box.top, view.top) >= 0.5 * Math.min(box.height, view.height)),
    columns: tiles.filter((tile) => Math.abs(tile.getBoundingClientRect().top - top) < 2).length,
    visibleRows: view ? rowTops.filter(top => top < view.bottom && top + rowHeight > view.top).length : 0,
    fullRows: view ? rowTops.filter(top => top >= view.top && top + rowHeight <= view.bottom).length : 0,
    tiles: tiles.length,
    innerWidth,
    innerHeight,
    rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
  };
})()`;

interface GridState {
  readonly inGrid: boolean;
  readonly index: number | null;
  readonly posinset: number | null;
  readonly setsize: number | null;
  readonly tag: string | null;
  readonly label: string | null;
  readonly title: string | null;
  readonly name: string | null;
  readonly caption: string | null;
  readonly remove: boolean;
  readonly ringIndex: number | null;
  readonly tabStops: number;
  readonly inView: boolean;
  readonly columns: number;
  readonly visibleRows: number;
  readonly fullRows: number;
  readonly tiles: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly rem: number;
}

interface AxNode {
  readonly nodeId: string;
  readonly parentId?: string;
  readonly ignored?: boolean;
  readonly role?: { readonly value?: string };
  readonly name?: { readonly value?: string };
  readonly properties?: readonly {
    readonly name: string;
    readonly value: { readonly value?: unknown };
  }[];
}

const button = (selector: string, text: string) =>
  `[...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.trim() === ${JSON.stringify(text)})`;
const expect = (value: boolean, message: string) => {
  if (!value) throw new Error(message);
};

export async function posterGridScenario(
  d: Driver,
  counts: () => Record<string, number>,
): Promise<void> {
  const steps: Record<string, unknown>[] = [];
  d.observed["posterGridSteps"] = steps;
  const state = () => d.evaluate<GridState>(STATE);
  const shiftTab = async () => {
    d.action("Press Shift+Tab");
    for (const type of ["rawKeyDown", "keyUp"])
      await d.send("Input.dispatchKeyEvent", {
        type,
        key: "Tab",
        code: "Tab",
        windowsVirtualKeyCode: 9,
        modifiers: 8,
      });
  };
  /** The focused accessibility node, with the roles above it that aren't ignored. */
  const focusedAx = async () => {
    const tree = (await d.send("Accessibility.getFullAXTree")) as { nodes: readonly AxNode[] };
    const byId = new Map(tree.nodes.map((node) => [node.nodeId, node]));
    // The document says it has the focus too; the element that holds it is below it.
    const focused = tree.nodes.findLast(
      (node) =>
        node.role?.value !== "RootWebArea" &&
        !!node.properties?.some((each) => each.name === "focused" && each.value.value === true),
    );
    const ancestors: string[] = [];
    for (
      let node = focused?.parentId ? byId.get(focused.parentId) : undefined;
      node && ancestors.length < 4;
      node = node.parentId ? byId.get(node.parentId) : undefined
    )
      if (!node.ignored && node.role?.value && node.role.value !== "generic")
        ancestors.push(node.role.value);
    return { role: focused?.role?.value ?? null, name: focused?.name?.value ?? null, ancestors };
  };
  /**
   * Waits until the focus and the ring are on tile `index` together, then checks what the tile
   * says about itself. A title's poster is named by its name and year; a saved one by its name
   * and the facts under it, and its cross is a second Tab stop.
   */
  const aligned = async (step: string, index: number, total: number, saved = false) => {
    await d.wait(async () => {
      const now = await state();
      return now.inGrid && now.index === index && now.ringIndex === index && !now.remove;
    }, 15_000);
    const now = await state();
    steps.push({ step, ...now });
    expect(now.posinset === index + 1 && now.setsize === total, `${step}: wrong list position`);
    expect(now.tabStops === (saved ? 2 : 1), `${step}: ${now.tabStops} Tab stops in the grid`);
    expect(now.inView, `${step}: the focused poster is out of view`);
    const year = /^(\d{4})\b/.exec(now.caption ?? "")?.[1];
    const named = saved
      ? [now.name, ...(now.caption ?? "").split(" · ")].join(", ")
      : [now.name, year].filter(Boolean).join(", ");
    expect(now.label === named, `${step}: named "${now.label}", expected "${named}"`);
    return now;
  };
  const totalShown = async () =>
    Number(
      (
        await d.evaluate<string>(
          `document.querySelector('p.tabular-nums[aria-live="polite"]')?.textContent ?? ''`,
        )
      )
        .split(" ")[0]!
        .replace(/[^0-9]/g, ""),
    );
  /**
   * Reads the open details' name and closes them with Escape. Fake TMDB renames titles as its
   * answers arrive, and the grid reads them a moment after the details do, so the name is the
   * poster's from before it opened, from after it closed, or what the focused poster comes to.
   */
  const closeDetails = async (step: string, before: string) => {
    await d.wait(() => d.evaluate<boolean>(`${DIALOG_TITLE} !== null`));
    const title = await d.evaluate<string>(DIALOG_TITLE);
    await d.key("Escape", 27);
    await d.wait(() => d.evaluate<boolean>(`!document.querySelector('[role="dialog"]')`));
    return async (after: GridState) => {
      const same = (name: string | null) => !!name && title.includes(name);
      if (!same(before) && !same(after.name))
        await d.wait(async () => same((await state()).name), 15_000);
      steps.push({ step: `${step}: details`, title, before, after: (await state()).name });
    };
  };

  // A. Movies > All movies, over several pages.
  await d.click("Open Movies", button("header button", "Movies"));
  await d.click("Open All movies", button("nav button", "All movies"));
  await d.wait(() =>
    d.evaluate<boolean>(`(${GRID})?.querySelectorAll('[role="listitem"]').length > 8`),
  );
  await d.wait(async () => (await totalShown()) > 240);
  const total = await totalShown();
  d.observed["collectionTotal"] = total;
  const start = await state();
  steps.push({ step: "opened", ...start });
  expect(start.tabStops === 1, "The grid has more than one Tab stop before any key");

  // Tab enters on the selected poster, and the next Tab leaves the grid.
  const tabs: Record<string, unknown>[] = [];
  for (let press = 0; press < 40 && !(await state()).inGrid; press++) {
    await d.key("Tab", 9);
    const now = await state();
    tabs.push({ tag: now.tag, label: now.label, inGrid: now.inGrid, index: now.index });
  }
  d.observed["tabIntoGrid"] = tabs;
  await aligned("Tab enters the grid", 0, total);
  await d.key("Tab", 9);
  const left = await state();
  steps.push({ step: "Tab leaves the grid", ...left });
  expect(!left.inGrid, "Tab stayed in the grid");
  await shiftTab();
  await aligned("Shift+Tab returns to the selected poster", 0, total);

  let columns = (await state()).columns;
  d.observed["columns1280"] = columns;
  await d.key("ArrowRight", 39);
  await aligned("ArrowRight", 1, total);
  await d.key("ArrowRight", 39);
  await aligned("ArrowRight again", 2, total);
  await d.key("ArrowDown", 40);
  await aligned("ArrowDown", 2 + columns, total);
  await d.key("ArrowLeft", 37);
  await aligned("ArrowLeft", 1 + columns, total);
  await d.key("ArrowUp", 38);
  const arrowed = await aligned("ArrowUp", 1, total);
  const ax = await focusedAx();
  d.observed["focusedAx"] = ax;
  expect(
    ax.role === "button" && ax.name === arrowed.label && ax.ancestors.includes("listitem"),
    `Accessibility tree: ${JSON.stringify(ax)}`,
  );
  await d.capture("collection-arrows");
  await d.key("Enter", 13);
  const opened = await closeDetails("Enter opens the focused poster", arrowed.name!);
  await opened(await aligned("Escape returns to the poster that opened details", 1, total));
  await d.capture("collection-returned");

  // Pages: Page Down across the first page's end, End to the last page, Home back.
  let previous = 1;
  const pages: number[] = [];
  while (previous < 130) {
    const beforePage = await state();
    const least = Math.min(
      total - 1,
      previous + beforePage.columns * Math.max(1, beforePage.fullRows),
    );
    const most = Math.min(total - 1, previous + beforePage.columns * beforePage.visibleRows);
    await d.key("PageDown", 34);
    await d.wait(async () => {
      const now = await state();
      return (
        now.inGrid && now.index !== null && now.index > previous && now.ringIndex === now.index
      );
    }, 15_000);
    const now = await aligned(`PageDown from ${previous}`, (await state()).index!, total);
    expect(
      now.index! >= least && now.index! <= most,
      `PageDown from ${previous}: expected ${least}..${most}, got ${now.index}`,
    );
    previous = now.index!;
    pages.push(previous);
  }
  d.observed["pageDownIndexes"] = pages;
  await d.key("End", 35);
  await aligned("End", total - 1, total);
  await d.capture("collection-end");
  const beforeUp = await state();
  await d.key("PageUp", 33);
  await d.wait(async () => (await state()).index !== total - 1);
  const up = await aligned("PageUp goes back one visible page", (await state()).index!, total);
  const leastUp = Math.max(0, total - 1 - beforeUp.columns * beforeUp.visibleRows);
  const mostUp = Math.max(0, total - 1 - beforeUp.columns * Math.max(1, beforeUp.fullRows));
  expect(
    up.index! >= leastUp && up.index! <= mostUp,
    `PageUp: expected ${leastUp}..${mostUp}, got ${up.index}`,
  );
  await d.key("Home", 36);
  await aligned("Home", 0, total);

  // The pointer only hovers; a click opens its poster, and closing returns the focus to it.
  const fourth = `(${GRID}).querySelector('[data-index="3"] button')`;
  await d.click("Open the fourth poster with the pointer", fourth);
  const clicked = await d.evaluate<string>(`${fourth}.querySelector('span.truncate').textContent`);
  const pressed = await closeDetails("A click opens its poster", clicked);
  await d.wait(async () => (await state()).index === 3);
  const afterClick = await state();
  steps.push({ step: "Escape after a click", ...afterClick });
  expect(afterClick.inGrid && afterClick.index === 3, "Focus is not on the clicked poster");
  await pressed(afterClick);
  await d.key("ArrowRight", 39);
  await aligned("ArrowRight goes on from the clicked poster", 4, total);

  // A 960x600 window and larger text keep the selected title, in view and focused.
  for (let press = 0; press < 3; press++) await d.key("ArrowDown", 40);
  const before = await state();
  const resize = async (width: number, height: number) => {
    await d.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await d.wait(() => d.evaluate<boolean>(`innerWidth === ${width} && innerHeight === ${height}`));
  };
  const kept = async (step: string) => {
    await d.wait(async () => {
      const now = await state();
      return now.inGrid && now.title === before.title && now.inView && now.ringIndex === now.index;
    }, 15_000);
    const now = await state();
    steps.push({ step, ...now });
    return now;
  };
  await resize(960, 600);
  const small = await kept("960x600 keeps the selected title");
  columns = small.columns;
  d.observed["columns960"] = columns;
  await d.capture("collection-960x600");
  // As settings does, a larger root size stands in for larger text; a resize makes the grid
  // measure it, as zoom does.
  await d.evaluate("document.documentElement.style.fontSize = '21px'");
  await resize(961, 601);
  await resize(960, 600);
  const large = await kept("Large text keeps the selected title");
  expect(large.rem === 21, "Root size did not apply");
  await d.capture("collection-large-text");
  expect(
    await d.evaluate<boolean>("document.documentElement.scrollWidth <= innerWidth"),
    "Large text overflows the window",
  );
  await d.key("ArrowRight", 39);
  await aligned("ArrowRight at large text", large.index! + 1, total);
  await d.evaluate("document.documentElement.style.fontSize = ''");
  await d.send("Emulation.clearDeviceMetricsOverride");
  await d.wait(() => d.evaluate<boolean>("innerWidth === 1280"));

  // B. The Movies search: Down hands the keys and the focus to the first result.
  const field = `document.querySelector('input[aria-label="Search movies"]')`;
  await d.click("Focus the Movies search", field);
  await d.send("Input.insertText", { text: "Story" });
  // Before the results are the query's: the first one takes the focus once they are.
  await d.key("ArrowDown", 40);
  await d.wait(async () => (await state()).inGrid);
  const found = await state();
  expect(
    !!found.name?.toLowerCase().includes("story"),
    `The focused result "${found.name}" isn't the query's`,
  );
  await aligned("Down hands the focus to the first result", 0, found.setsize!);
  await d.key("ArrowRight", 39);
  const second = await aligned("ArrowRight in the results", 1, found.setsize!);
  await d.capture("search-results");
  await d.key("Enter", 13);
  const result = await closeDetails("Enter opens the focused result", second.name!);
  await result(await aligned("Escape returns to the result", 1, found.setsize!));
  // Typing again keeps the focus in the field while the results change.
  await d.click("Focus the Movies search again", field);
  await d.send("Input.insertText", { text: " 1" });
  await d.wait(() => d.evaluate<boolean>(`${field}.value === "Story 1"`));
  await d.evaluate("new Promise(resolve => setTimeout(resolve, 1000))");
  const typing = await d.evaluate<{ field: boolean }>(
    `({ field: document.activeElement === ${field} })`,
  );
  steps.push({ step: "Results refresh while typing", ...typing });
  expect(typing.field, "Refreshed results took the focus from the field");
  await d.key("Escape", 27);
  await d.wait(() => d.evaluate<boolean>(`${field}.value === ""`));

  // C. The Watchlist: four titles saved through details, opened from the grid with Enter.
  await d.wait(() =>
    d.evaluate<boolean>(`(${GRID})?.querySelectorAll('[role="listitem"]').length > 8`),
  );
  const saved: string[] = [];
  await d.key("Home", 36);
  for (let index = 0; index < 4; index++) {
    if (index > 0) await d.key("ArrowRight", 39);
    const now = await aligned(`Select title ${index + 1} to save`, index, total);
    await d.key("Enter", 13);
    await d.click(`Save title ${index + 1}`, button('[role="dialog"] button', "Save"));
    await d.wait(() => d.exists(button('[role="dialog"] button', "Saved")));
    saved.push(now.name!);
    await d.key("Escape", 27);
    await d.wait(() => d.evaluate<boolean>(`!document.querySelector('[role="dialog"]')`));
    await d.wait(async () => (await state()).index === index);
  }
  d.observed["savedTitles"] = saved;
  await d.click("Open Watchlist", button("header button", "Watchlist"));
  await d.wait(() =>
    d.evaluate<boolean>(
      `document.querySelector('h1')?.textContent === 'Watchlist' && (${GRID})?.querySelectorAll('[role="listitem"]').length === 4`,
    ),
  );
  for (let press = 0; press < 40 && !(await state()).inGrid; press++) await d.key("Tab", 9);
  await aligned("Tab enters the Watchlist", 0, 4, true);
  await d.key("Tab", 9);
  await d.wait(async () => (await state()).remove);
  const cross = await state();
  steps.push({ step: "Tab reaches the selected tile's cross", ...cross });
  expect(cross.index === 0 && cross.remove, "Tab did not reach the selected tile's cross");
  await d.key("Tab", 9);
  expect(!(await state()).inGrid, "Tab stayed in the Watchlist grid");
  await shiftTab();
  await d.wait(async () => {
    const now = await state();
    return now.remove && now.index === 0;
  });
  const crossAx = await focusedAx();
  d.observed["watchlistFocusedAx"] = crossAx;
  expect(crossAx.role === "button" && crossAx.name === cross.label, "The cross's accessible name");
  const first = cross.label;
  await d.key("Enter", 13);
  await d.wait(async () => (await state()).tiles === 3);
  await d.wait(async () => {
    const now = await state();
    return now.remove && now.index === 0 && now.label !== first;
  });
  const replaced = await state();
  steps.push({
    step: "Removing with the keyboard leaves the focus on the next cross",
    ...replaced,
  });
  await d.capture("watchlist-removed");
  await shiftTab();
  await aligned("Shift+Tab to the poster of the tile that took its place", 0, 3, true);
  await d.key("End", 35);
  await aligned("End in the Watchlist", 2, 3, true);
  await d.key("Tab", 9);
  await d.wait(async () => {
    const now = await state();
    return now.remove && now.index === 2;
  });
  await d.key("Enter", 13);
  await d.wait(async () => (await state()).tiles === 2);
  await d.wait(async () => {
    const now = await state();
    return now.remove && now.index === 1;
  });
  steps.push({
    step: "Removing the last tile leaves the focus on the one before it",
    ...(await state()),
  });
  await shiftTab();
  const last = await aligned("The poster before it", 1, 2, true);
  await d.key("Enter", 13);
  const entry = await closeDetails("Enter opens a Watchlist title", last.name!);
  await entry(await aligned("Escape returns to the Watchlist tile", 1, 2, true));
  await d.capture("watchlist-returned");
  d.observed["requests"] = counts();
}
