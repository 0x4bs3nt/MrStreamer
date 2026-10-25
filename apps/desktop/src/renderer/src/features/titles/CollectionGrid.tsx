// A collection as a grid of posters, in rows that fit the width, fetched a page at a time and
// drawn only where in view; search results and the watchlist use the same grid. A poster opens
// its details over the grid, which stays where it was.
//   The arrow keys move the selection through the grid, Page Up and Down by a screen, Home and End
//   to the ends; Enter opens the title. The focus goes with the selection, and the selected
//   poster is the grid's one place in the Tab order. The selection keeps to its title by key
//   while pages arrive, the list is read again or the width changes, and closing what a poster
//   opened gives the focus back to that title. The pointer only hovers; a poster it opens becomes
//   the selection.
import { useQueries } from "@tanstack/react-query";
import { usePresentationVisible } from "../../lib/presentation.ts";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import type {
  CollectionId,
  CollectionSort,
  Title,
  TitleKind,
} from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
import type { TitleFilters } from "@mrstreamer/contracts/title-filters";
import { formatDecimal } from "@mrstreamer/core/i18n";
import { hasModifier, isTyping } from "../../app/platform.ts";
import { openDetails, useUi } from "../../app/ui-store.ts";
import {
  PosterContent,
  POSTER_ASPECT_RATIO,
  POSTER_CAPTION_HEIGHT_REM,
} from "../../components/TitleArt.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { useKeyboardMode } from "../../lib/input-mode.ts";
import { queries, useSourceOf } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { FilterEmpty, TitleFilterBar, type TitleFilterControls } from "./TitleFilters.tsx";

/** Titles asked for together as rows come into view. */
export const PAGE = 120;
const FIRST_PAGE: ReadonlySet<number> = new Set([0]);
const POSTER_REM = 9;
const GAP_REM = 1.25;

/**
 * Which pages of the list `listKey` names to fetch: the first, and those the grid asked for
 * since. Another list starts again from its first. `load` asks for the pages around the positions
 * in view.
 */
export function usePages(listKey: string): {
  readonly pages: readonly number[];
  readonly load: (first: number, last: number) => void;
} {
  const [asked, setAsked] = useState<{ key: string; pages: ReadonlySet<number> }>(() => ({
    key: listKey,
    pages: FIRST_PAGE,
  }));
  const pages = asked.key === listKey ? asked.pages : FIRST_PAGE;
  const load = useCallback(
    (first: number, last: number) => {
      // Nothing in view yet, before the grid has measured its rows.
      if (last < first || last < 0) return;
      const from = Math.floor(Math.max(0, first) / PAGE);
      const wanted = Array.from({ length: Math.floor(last / PAGE) - from + 1 }, (_, i) => from + i);
      setAsked((current) => {
        const had = current.key === listKey ? current.pages : FIRST_PAGE;
        return wanted.every((page) => had.has(page)) && current.key === listKey
          ? current
          : { key: listKey, pages: new Set([...had, ...wanted]) };
      });
    },
    [listKey],
  );
  return { pages: [...pages], load };
}

/**
 * A collection's titles, fetched a page at a time as the grid asks. `titleAt` answers for loaded
 * positions; `load` asks for the pages around the positions in view. `settled` is false while a
 * page is being read, for the first time or again after the lists changed.
 */
export function useCollection(
  kind: TitleKind,
  id: CollectionId,
  sort?: CollectionSort,
  filters?: TitleFilters,
) {
  const visible = usePresentationVisible();
  const { pages, load } = usePages(`${kind}:${id}:${sort ?? ""}:${JSON.stringify(filters ?? {})}`);
  const loaded = useQueries({
    queries: pages.map((page) => ({
      ...queries.collection(kind, id, sort, page * PAGE, PAGE, filters),
      enabled: visible,
    })),
  });
  const byPage = new Map(pages.map((page, index) => [page, loaded[index]?.data]));
  const first = byPage.get(0);
  return {
    name: first?.name ?? null,
    total: first ? first.total : null,
    unfiltered: first ? (first.unfiltered ?? first.total) : null,
    titleAt: (index: number) => byPage.get(Math.floor(index / PAGE))?.titles[index % PAGE],
    load,
    settled: loaded.every((each) => !each.isFetching),
    error: loaded.find((each) => each.error)?.error ?? null,
  };
}

/** The grid for a collection, or why there is none. */
export function CollectionGrid({
  kind,
  id,
  sort,
  active,
  filters,
  onFilters,
  sortControl,
  hideCount,
}: {
  kind: TitleKind;
  id: CollectionId;
  sort?: CollectionSort;
  active: boolean;
  sortControl?: ReactNode;
  hideCount?: boolean;
} & Partial<TitleFilterControls>) {
  const listed = useCollection(kind, id, sort, filters);
  // Each poster is the version the grid lists, as the 4K tab's are their 4K versions.
  const open = (title: Title) =>
    openDetails({
      kind: title.kind,
      ...ownedId(title),
      asked: id === "4k" || (!!filters && Object.keys(filters).length > 0),
    });
  return (
    <>
      {filters && onFilters && (
        <TitleFilterBar
          kind={kind}
          filters={filters}
          onFilters={onFilters}
          total={listed.total}
          unfiltered={listed.unfiltered}
          sortControl={sortControl}
          hideCount={hideCount ?? false}
        />
      )}
      {listed.error ? (
        <p className="text-sm text-destructive">{describeError(appError(listed.error))}</p>
      ) : listed.total === 0 ? (
        filters && Object.keys(filters).length > 0 ? (
          <FilterEmpty filters={filters} />
        ) : (
          <p className="text-[0.9375rem] text-muted-foreground">Nothing here yet.</p>
        )
      ) : (
        <Grid
          key={`${kind}:${id}:${sort ?? ""}:${JSON.stringify(filters ?? {})}`}
          total={listed.total ?? 0}
          itemAt={listed.titleAt}
          keyOf={titleKey}
          onVisible={listed.load}
          settled={listed.settled}
          active={active}
          onOpen={open}
          tile={(title, grid) => <GridPoster title={title} caption={describe(title)} grid={grid} />}
        />
      )}
    </>
  );
}

/** A title stays the same poster while the lists change around it, as `Title.key` says. */
const titleKey = (title: Title) => title.key;

/** What a poster says under its name: the year, the first genre and the rating. */
function describe(title: Title): string {
  return [title.year, title.genres[0], title.rating ? `★ ${formatDecimal(title.rating, 1)}` : null]
    .filter(Boolean)
    .join(" · ");
}

const nothing = () => {};

/**
 * Titles already at hand, such as search results, as the same grid. `takeFocus` hands it the
 * keys from the search field; see `Grid`.
 */
export function TitleGrid({
  titles,
  active,
  caption = describe,
  asked = false,
  takeFocus = false,
  onFocusTaken,
}: {
  titles: readonly Title[];
  active: boolean;
  caption?: (title: Title) => string;
  /** Filtered results open the matching version even when it is the usual primary version. */
  asked?: boolean;
  takeFocus?: boolean;
  onFocusTaken?: () => void;
}) {
  const open = (title: Title) => openDetails({ kind: title.kind, ...ownedId(title), asked });
  return (
    <Grid
      total={titles.length}
      itemAt={(index) => titles[index]}
      keyOf={titleKey}
      onVisible={nothing}
      active={active}
      onOpen={open}
      takeFocus={takeFocus}
      {...(onFocusTaken ? { onFocusTaken } : {})}
      tile={(title, grid) => <GridPoster title={title} caption={caption(title)} grid={grid} />}
    />
  );
}

/**
 * What the grid tells each tile it draws. One tile holds the selection the keys move, and its
 * controls are the grid's one place in the Tab order.
 */
export interface GridTile {
  /** The keys are on it, so it shows the white ring while the keyboard is in use. */
  readonly selected: boolean;
  /** 0 on the selected tile's controls and -1 on every other tile's, so Tab stops once. */
  readonly tabIndex: 0 | -1;
  /** Opens the item, as Enter does, and moves the selection to it. */
  readonly open: () => void;
}

/** Where the keys are: an item by its key, and the position it was last seen at. */
interface Chosen {
  readonly key: string | null;
  readonly index: number;
}

/**
 * The position of the chosen item now: where it was, or where its key went among the loaded
 * pages. An empty old position still looks for its key in the other loaded pages. Null when
 * they don't have it: it was removed, it moved past them, or its page hasn't answered.
 */
function locate<T>(
  chosen: Chosen,
  total: number,
  itemAt: (index: number) => T | undefined,
  keyOf: (item: T) => string,
): number | null {
  const kept = Math.min(chosen.index, Math.max(total - 1, 0));
  if (chosen.key === null) return kept;
  const there = chosen.index < total ? itemAt(chosen.index) : undefined;
  if (there && keyOf(there) === chosen.key) return kept;
  // Nearest first: an insertion or a removal moves it only a little.
  const span = Math.max(chosen.index, total - 1 - chosen.index);
  for (let distance = 1; distance <= span; distance++) {
    for (const at of [chosen.index - distance, chosen.index + distance]) {
      const item = at >= 0 && at < total ? itemAt(at) : undefined;
      if (item && keyOf(item) === chosen.key) return at;
    }
  }
  return null;
}

/** The selected tile's control the focus belongs on: `part` 0 is the one that opens it. */
function controlOf(scroller: HTMLElement, index: number, part: number): HTMLElement | null {
  const controls = scroller.querySelectorAll<HTMLElement>(`[data-index="${index}"] button`);
  return controls[Math.min(part, controls.length - 1)] ?? null;
}

/**
 * Tiles in rows that fit the width, drawing only the rows in view: a collection's posters, or
 * whatever `tile` draws for an item, 2:3 with a name and one line under it. The grid is a list
 * whose items say their place in it, and the selected one stays drawn when scrolled away, so it
 * keeps the focus and the Tab stop. `takeFocus` asks the selected tile to take the focus once it
 * is drawn, unless the focus went to another control first; `onFocusTaken` says it did. `settled`
 * is false while a page of the list is still being read, as a refresh reads them one at a time.
 */
export function Grid<T>({
  total,
  itemAt,
  keyOf,
  onVisible,
  active,
  onOpen,
  tile,
  takeFocus = false,
  onFocusTaken,
  settled = true,
}: {
  total: number;
  /** The item at a position, or undefined while its page loads. */
  itemAt: (index: number) => T | undefined;
  /** What stays the same of an item while the list around it changes. */
  keyOf: (item: T) => string;
  onVisible: (first: number, last: number) => void;
  active: boolean;
  /** Opens an item, for Enter or a press on its tile. */
  onOpen: (item: T) => void;
  tile: (item: T, tile: GridTile) => ReactNode;
  takeFocus?: boolean;
  onFocusTaken?: () => void;
  settled?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const rem = useRem();
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const gap = GAP_REM * rem;
  const inner = Math.max(0, width - 2 * rem);
  const columns = Math.max(1, Math.floor((inner + gap) / (POSTER_REM * rem + gap)));
  const tileWidth = (inner - gap * (columns - 1)) / columns;
  // A poster, its name and one line, then the gap before the next row.
  const rowHeight = tileWidth / POSTER_ASPECT_RATIO + POSTER_CAPTION_HEIGHT_REM * rem + gap;
  const rows = Math.ceil(total / columns);

  const [chosen, setChosen] = useState<Chosen>({ key: null, index: 0 });
  const found = locate(chosen, total, itemAt, keyOf);
  // A title the loaded pages lack keeps its key while a page is still being read: a refresh
  // answers them one at a time, and the title can be in none of them for a moment. Meanwhile it
  // shows no ring, takes no focus and opens nothing. Once every page answered, a title still
  // missing counts as gone, and what now stands at its position takes its place. One that moved
  // past the pages loaded so far isn't looked for beyond them.
  const pending = found === null && !settled;
  const selected = found ?? Math.min(chosen.index, Math.max(total - 1, 0));
  const selectedItem = itemAt(selected);
  const selectedKey = pending || !selectedItem ? chosen.key : keyOf(selectedItem);
  // Kept where it was found, so the next render needn't look for it again.
  if (selected !== chosen.index || selectedKey !== chosen.key)
    setChosen({ key: selectedKey, index: selected });
  const selectedRow = Math.floor(selected / columns);

  // The rows in view and their overscan, without the selected row drawn beside them.
  const drawn = useRef<readonly number[]>([]);
  const visibleRows = useRef(1);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const shown = defaultRangeExtractor(range);
      drawn.current = shown;
      visibleRows.current = Math.max(1, range.endIndex - range.startIndex + 1);
      return selectedRow >= range.count || shown.includes(selectedRow)
        ? shown
        : [...shown, selectedRow].sort((a, b) => a - b);
    },
    [selectedRow],
  );
  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => box.current,
    estimateSize: () => rowHeight,
    overscan: 2,
    rangeExtractor,
  });
  useEffect(() => virtual.measure(), [rowHeight, virtual]);
  const items = virtual.getVirtualItems();
  const firstRow = drawn.current[0] ?? 0;
  const lastRow = drawn.current.at(-1) ?? 0;
  useEffect(() => {
    // The next rows' posters load before they scroll into view.
    onVisible(firstRow * columns, Math.min(total - 1, (lastRow + 3) * columns - 1));
  }, [firstRow, lastRow, columns, total, onVisible]);
  // So does the selected one's, drawn wherever it is, before the view gets there.
  useEffect(() => onVisible(selected, selected), [selected, onVisible]);

  const keyboard = useKeyboardMode();
  // A key moved the selection, or what opened details is back: the focus follows once its tile is
  // drawn.
  const follow = useRef(false);
  // Which control of the selected tile has the focus while the grid has it, 0 the one that opens
  // it; still set when that tile went from under the focus, as a removal takes it.
  const part = useRef<number | null>(null);
  // Set when an item opened, to give the focus back to it once what it opened closes.
  const reopen = useRef<{ readonly focus: boolean } | null>(null);
  // The viewer put the focus on another control: what the grid still meant to focus, a selection
  // whose page hadn't come or the place of a tile that went, is no longer the grid's to take.
  useEffect(() => {
    const elsewhere = (event: Event) => {
      if (event.target instanceof Node && box.current?.contains(event.target)) return;
      follow.current = false;
      part.current = null;
    };
    document.addEventListener("focusin", elsewhere);
    return () => document.removeEventListener("focusin", elsewhere);
  }, []);
  const select = (index: number) => {
    const item = itemAt(index);
    setChosen({ key: item ? keyOf(item) : null, index });
  };
  const open = (index: number, focus: boolean) => {
    const item = itemAt(index);
    if (!item) return;
    reopen.current = { focus: focus || !!box.current?.contains(document.activeElement) };
    setChosen({ key: keyOf(item), index });
    onOpen(item);
  };
  const state = useRef({
    selected,
    pending,
    columns,
    total,
    rowsInView: visibleRows.current,
    select,
    open,
  });
  state.current = {
    selected,
    pending,
    columns,
    total,
    rowsInView: visibleRows.current,
    select,
    open,
  };
  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (ui.searchOpen || ui.settings || ui.updateDialog || ui.details || ui.playingTitle) return;
      const target = event.target instanceof Element ? event.target : null;
      // A dialog's or a menu's keys are its own, wherever it is drawn.
      if (target?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]'))
        return;
      const current = state.current;
      // Enter on a focused button, such as a tab or a tile's cross, is the button's. On the poster
      // that opens the selected tile it is the grid's, so the title opens once.
      const opener = !!box.current && controlOf(box.current, current.selected, 0) === target;
      if (event.key === "Enter" && target instanceof HTMLButtonElement && !opener) return;
      const move = (delta: number) => {
        const next = Math.min(
          Math.max(current.selected + delta, 0),
          Math.max(current.total - 1, 0),
        );
        current.select(next);
        // Another key before the next render goes on from here.
        current.selected = next;
        follow.current = true;
        virtual.scrollToIndex(Math.floor(next / current.columns), { align: "auto" });
      };
      switch (event.key) {
        case "ArrowRight":
          move(1);
          break;
        case "ArrowLeft":
          move(-1);
          break;
        case "ArrowDown":
          move(current.columns);
          break;
        case "ArrowUp":
          move(-current.columns);
          break;
        case "PageDown":
          move(current.columns * current.rowsInView);
          break;
        case "PageUp":
          move(-current.columns * current.rowsInView);
          break;
        case "Home":
          move(-current.selected);
          break;
        case "End":
          move(current.total);
          break;
        case "Enter":
          if (!current.pending) current.open(current.selected, true);
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, virtual]);

  // The focus goes with the selection when a key moved it, when the search handed the keys over,
  // when the grid has it, and when the tile that had it went. It is never taken from elsewhere,
  // and waits while the selected title's pages are still being read.
  useLayoutEffect(() => {
    const scroller = box.current;
    if (!scroller || !active || pending) return;
    const focused = document.activeElement;
    const within = !!focused && scroller.contains(focused);
    const idle = !focused || focused === document.body;
    const lost = idle && part.current !== null;
    const handed = takeFocus && (within || idle);
    if (!follow.current && !handed && !within && !lost) return;
    const target = controlOf(
      scroller,
      selected,
      follow.current || handed ? 0 : (part.current ?? 0),
    );
    // Its page is still on its way.
    if (!target) return;
    follow.current = false;
    if (handed) onFocusTaken?.();
    if (target !== focused) target.focus({ preventScroll: true });
  });

  // Back from what an item opened: the selection is that item, by its key, or what took its place
  // once its removal settled, and so is the focus when the keyboard opened it. The sheet gives the
  // focus back to what had it before, or else to what had it before an earlier popup, in a
  // microtask queued as it closed; this one runs after it. When the sheet put the focus on another
  // tile, that tile's selection is undone too.
  const wasActive = useRef(active);
  useLayoutEffect(() => {
    const back = active && !wasActive.current ? reopen.current : null;
    wasActive.current = active;
    if (!back) return;
    reopen.current = null;
    const opener = chosen;
    if (back.focus) virtual.scrollToIndex(selectedRow, { align: "auto" });
    queueMicrotask(() => {
      const scroller = box.current;
      const focused = document.activeElement;
      if (!scroller || (!back.focus && !(focused && scroller.contains(focused)))) return;
      // A new object, so the grid draws again and its focus effect runs.
      setChosen({ ...opener });
      follow.current = true;
    });
  }, [active]);

  // A new width or text size moves the rows; the selection keeps to its item, and stays in view
  // while it has the focus.
  useEffect(() => {
    if (box.current?.contains(document.activeElement))
      virtual.scrollToIndex(Math.floor(state.current.selected / columns), { align: "auto" });
  }, [columns, rowHeight, virtual]);

  return (
    <div
      ref={box}
      onFocus={(event: FocusEvent) => {
        const tile = event.target.closest<HTMLElement>("[data-index]");
        if (!tile) return;
        const controls = [...tile.querySelectorAll("button")];
        part.current = Math.max(
          controls.findIndex((control) => control === event.target),
          0,
        );
        // The focus went to another tile by itself, as a screen reader moves it: so does the
        // selection.
        const index = Number(tile.dataset["index"]);
        if (Number.isInteger(index) && index !== state.current.selected)
          state.current.select(index);
      }}
      onBlur={(event: FocusEvent) => {
        // The focus went to another control. A tile that went from under it is still owed it.
        if (event.target.isConnected && !box.current?.contains(event.relatedTarget))
          part.current = null;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-8 pb-10"
    >
      <div role="list" className="relative" style={{ height: virtual.getTotalSize() }}>
        {items.map((row) => {
          // Keys stay unique in a row even while two pages read at different times overlap.
          const seen = new Set<string>();
          return (
            <div
              key={row.key}
              className="absolute inset-x-0 grid"
              style={{
                top: row.start,
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                columnGap: gap,
              }}
            >
              {Array.from({ length: columns }, (_, column) => {
                const index = row.index * columns + column;
                if (index >= total) return null;
                const item = itemAt(index);
                if (!item)
                  return (
                    <div key={`loading:${index}`}>
                      <div className="aspect-[2/3] rounded-xl bg-white/4" />
                    </div>
                  );
                const key = keyOf(item);
                const unique = seen.has(key) ? `${key}@${index}` : key;
                seen.add(key);
                return (
                  <div
                    key={unique}
                    role="listitem"
                    aria-posinset={index + 1}
                    aria-setsize={total}
                    data-index={index}
                    className="min-w-0"
                  >
                    {tile(item, {
                      selected: keyboard && active && !pending && index === selected,
                      tabIndex: index === selected ? 0 : -1,
                      open: () => open(index, false),
                    })}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A title's poster: its name and year, with whose it is where that tells it apart. */
function GridPoster({ title, caption, grid }: { title: Title; caption: string; grid: GridTile }) {
  // Whose it is, where another subscription's title reads the same and isn't this one.
  const source = useSourceOf()(title);
  return (
    <button
      tabIndex={grid.tabIndex}
      aria-label={[title.title, title.year, source].filter(Boolean).join(", ")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={grid.open}
      className="group block w-full min-w-0 text-left outline-none"
      title={title.name}
    >
      <PosterContent
        artworkUrl={title.posterUrl}
        name={title.title}
        selected={grid.selected}
        caption={[caption, source].filter(Boolean).join(" · ")}
      />
    </button>
  );
}
