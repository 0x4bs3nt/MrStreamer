// Live TV's guide grid, the second view of a list beside its rows: the list's channels down the
// side, time across, the past included, and a line at now that moves on the minute.
//   Left and Right move between programmes, Up and Down between channels at the same time, and
// PageUp, PageDown, Home and End jump as in the list. The programme with the cursor opens its
// details under its channel's row. Enter, or Watch live there, watches the channel. Left at the
// start of the grid hands the keys to the lists; the focus coming back into the grid, with Tab or
// a click, or a picked programme takes them back. Only the keyboard scrolls the grid to the
// cursor.
// A key that moves the cursor gives the grid the focus, and the grid names the cursor's cell as
// its active one, a programme or a stretch without guide, so assistive technology follows it.
// Watch live, a click on the channel and Enter on a programme on now or to come play the channel
// live, also when a recording of it plays.
//   A programme the channel's catch-up keeps plays from its start, by Enter once it has ended and
// by Play from start in its details, second to Watch live while it is on. One past the channel's
// archive is dimmed and watches the channel live, as every other programme does; see
// `actionsOf`. An aired one that plays says "Catch-up" in its name. A channel with catch-up shows its sign beside its name. While a receiver has
// playback, programmes watch live only: catch-up plays on this computer.
//   A click on a programme opens its details, and on it again closes them; a double click does
// what Enter does, and a click on the channel watches it. Wheels and trackpads scroll both ways.
//   A programme still to come offers Remind me beside Watch live in its details, and once a
// reminder is set its cell shows a bell (../reminders/).
//   The timeline goes back as far as the list's longest archive, and ahead to where the guide
// ends: see `timeline`. Rows are drawn as they come into view, and each draws only the hours in
// view. The grid reads slots with `guide.range` in pages of channels by hours, those in view and
// a little around them, and draws where a page has none as hatched: no guide there. Until a page
// is in, nothing. The details read the programme's description with `guide.programme`.
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { Bell, History, Play, RotateCcw } from "lucide-react";
import {
  memo,
  useCallback,
  useId,
  useMemo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from "react";
import type { GuideSlot, Programme } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { ReminderList } from "@mrstreamer/contracts/reminders";
import { ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useNow } from "../../lib/clock.ts";
import { usePresentationVisible } from "../../lib/presentation.ts";
import { comingTime, endOfDay, pastTime, progressOf, timeLeft } from "../../lib/format.ts";
import { queries } from "../../lib/queries.ts";
import { reminderAt, useReminders } from "../../lib/reminders.ts";
import { useOutput } from "../../player/output.ts";
import { archiveHolds } from "@mrstreamer/core/catchup";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";
import { ReminderButton } from "../reminders/ReminderButton.tsx";
import {
  blocksIn,
  cellAt,
  HOUR_MS,
  joinSpans,
  actionsOf,
  longestArchive,
  mergeSlots,
  MINUTE_MS,
  nextCell,
  PAGE_MS,
  PAGE_ROWS,
  pagesFor,
  timeline,
  type Cell,
  type GridAction,
  type Span,
} from "./guide-grid.ts";

/** An hour's width: 196 px at the 14 px rem the design was drawn at. */
const HOUR_REM = 14;
/** The channels' column. */
const COLUMN_REM = 14;
/** A channel's row, 48 px at 14 px. */
const ROW_REM = 48 / 14;
/** The times along the top. */
const HEAD_REM = 2;
/** Rows above and below the view that are drawn, and read, before they scroll in. */
const OVERSCAN = 6;
const HALF_HOUR_MS = HOUR_MS / 2;
const JUMP_ROWS = 10;

/** What Live TV's keys do in the grid. */
export interface GridKeys {
  /**
   * Moves the cursor or watches for `key`: "handled", "lists" when Left passes the start of the
   * grid, or "ignored" for a key the grid has no use for.
   */
  key(key: string): "handled" | "lists" | "ignored";
  /** The channel the cursor is on. */
  channel(): LiveChannel | undefined;
}

/** The cursor: a row, kept to its channel, and a moment. `asked` counts the keys that moved it. */
interface Cursor {
  readonly index: number;
  readonly channel: OwnedId | null;
  readonly at: number;
  readonly asked: number;
}

/** A row's programmes from the pages read for it, and the stretches those pages cover. */
interface RowGuide {
  readonly pages: readonly (readonly GuideSlot[] | undefined)[];
  readonly covered: string;
  readonly programmes: readonly GuideSlot[];
  readonly known: readonly Span[];
}

const NO_GUIDE: RowGuide = { pages: [], covered: "", programmes: [], known: [] };

/**
 * One list's channels by time. Give each list, and each search of it, its own grid by key: the
 * cursor and the scroll position belong to the list they were made in.
 */
export function GuideGrid({
  channels,
  playingKey,
  showCursor,
  onWatch,
  onPlayArchive,
  onKeys,
  ref,
}: {
  channels: readonly LiveChannel[];
  /** The channel that plays, by its `ownedKey`. */
  playingKey: string | null;
  /** The keyboard is in use and the grid has it, so the cursor shows without details open. */
  showCursor: boolean;
  /** Watches the channel live, a recording of it giving way. */
  onWatch: (channel: LiveChannel) => void;
  /** Plays a programme that aired from the channel's catch-up archive, from its start. */
  onPlayArchive: (channel: LiveChannel, programme: Programme) => void;
  /** The grid took the keys from the lists: the focus went into it, or a programme was picked. */
  onKeys: () => void;
  ref?: Ref<GridKeys>;
}) {
  const rem = useRem();
  const ids = useId();
  const client = useQueryClient();
  const remote = useOutput((state) => state.status.output.kind !== "local");
  // Where the guide of the list's channels ends: the furthest any of their subscriptions' guides
  // reaches. One that is being read again, or kept after a failed download, says no end: as far
  // as the grid goes.
  const statuses = useQuery(queries.guideStatus()).data;
  const subscriptionIds = useMemo(
    () => new Set(channels.map((channel) => channel.subscriptionId)),
    [channels],
  );
  const until = (statuses ?? []).reduce<number | null>(
    (furthest, { subscriptionId, processing }) => {
      if (!subscriptionIds.has(subscriptionId)) return furthest;
      const ends =
        processing.state === "ready"
          ? processing.until
          : processing.state === "empty" ||
              (processing.state === "failed" && processing.kept === null)
            ? null
            : Infinity;
      return ends === null ? furthest : Math.max(furthest ?? 0, ends);
    },
    null,
  );
  const archiveDays = useMemo(() => longestArchive(channels), [channels]);
  const reminders = useReminders().data;
  const now = useNow();
  const visible = usePresentationVisible();
  const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
  const scroller = useRef<HTMLDivElement>(null);
  const msPx = (HOUR_REM * rem) / HOUR_MS;
  const columnPx = COLUMN_REM * rem;
  const headPx = HEAD_REM * rem;
  // Whole pixels, its line included: a row measures as estimated, so one scrolling in moves no
  // other, and the thousands of rows aren't laid out again.
  const rowPx = Math.round(ROW_REM * rem);

  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // The cursor starts on the playing channel at now, and keeps to its channel when the list
  // changes under it.
  const [cursor, setCursor] = useState<Cursor>(() => {
    const index = Math.max(
      channels.findIndex((channel) => ownedKey(channel) === playingKey),
      0,
    );
    return { index, channel: channels[index] ?? null, at: now, asked: 0 };
  });
  // Found again once per list and cursor, not on each render as the grid scrolls.
  const index = useMemo(() => {
    const found =
      cursor.channel && !sameOwned(channels[cursor.index], cursor.channel)
        ? channels.findIndex((channel) => sameOwned(channel, cursor.channel))
        : cursor.index;
    return Math.min(found === -1 ? cursor.index : found, Math.max(channels.length - 1, 0));
  }, [channels, cursor]);
  // The cursor's row stays drawn while it is scrolled out of view, with its details, so the keys
  // find its programmes.
  const rangeExtractor = useCallback(
    (range: Range) => {
      const drawn = defaultRangeExtractor(range);
      if (index >= range.count || drawn.includes(index)) return drawn;
      return [...drawn, index].sort((a, b) => a - b);
    },
    [index],
  );
  // The virtualizer places every row again when this changes: once per list, not per render.
  const getItemKey = useCallback(
    (index: number) => {
      const channel = channels[index];
      return channel ? ownedKey(channel) : index;
    },
    [channels],
  );
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowPx,
    getItemKey,
    paddingStart: headPx,
    paddingEnd: 2 * rem,
    scrollPaddingStart: headPx,
    overscan: OVERSCAN,
    rangeExtractor,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rem, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const { start: origin, stop: end } = timeline(archiveDays, until, minute);
  const totalPx = columnPx + (end - origin) * msPx;

  // Where the grid is scrolled to across: the moment at the programmes' left edge, kept through
  // a timeline that starts an hour later or ends elsewhere, or a window that grows, and the hours
  // drawn around it.
  const geometry = useRef({ origin, end, msPx, columnPx, minute, rem });
  geometry.current = { origin, end, msPx, columnPx, minute, rem };
  const leftAt = useRef<number | null>(null);
  const [drawn, setDrawn] = useState<Span>({ start: 0, stop: 0 });
  const [day, setDay] = useState(0);
  // The titles of programmes that began left of the view move into it, as far as leaves room for
  // a letter and an ellipsis: a style on each title, from where each programme is, so scrolling
  // draws no row again. Written before the next frame is laid out, from the scroll position the
  // last scroll read, so nothing is laid out twice.
  const scrolled = useRef(0);
  const shifting = useRef(0);
  const shiftTitles = useCallback(() => {
    if (shifting.current) return;
    shifting.current = requestAnimationFrame(() => {
      shifting.current = 0;
      const element = scroller.current;
      if (element) shiftAt(element, scrolled.current, 2.75 * geometry.current.rem);
    });
  }, []);
  useLayoutEffect(shiftTitles);
  useEffect(() => () => cancelAnimationFrame(shifting.current), []);
  const follow = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const { origin, end, msPx, columnPx } = geometry.current;
    const from = Math.min(origin + element.scrollLeft / msPx, end);
    const to = from + Math.max(element.clientWidth - columnPx, 0) / msPx;
    leftAt.current = from;
    if (element.scrollLeft !== scrolled.current) {
      scrolled.current = element.scrollLeft;
      shiftTitles();
    }
    setDay(new Date(from).setHours(0, 0, 0, 0));
    const start = Math.max(Math.floor(from / HOUR_MS) * HOUR_MS - HOUR_MS, origin);
    const stop = Math.min(Math.ceil(to / HOUR_MS) * HOUR_MS + HOUR_MS, end);
    setDrawn((current) =>
      current.start === start && current.stop === stop ? current : { start, stop },
    );
  }, [shiftTitles]);
  /** Scrolls across to put `at` at the programmes' left edge. */
  const scrollTo = useCallback(
    (at: number) => {
      const element = scroller.current;
      if (!element) return;
      const { origin, msPx } = geometry.current;
      leftAt.current = at;
      element.scrollLeft = Math.max(0, (at - origin) * msPx);
      follow();
    },
    [follow],
  );
  /** Now, a quarter of the way across. */
  const nowAt = useCallback(() => {
    const { msPx, columnPx, minute } = geometry.current;
    const room = Math.max((scroller.current?.clientWidth ?? 0) - columnPx, 0);
    return minute - room / 4 / msPx;
  }, []);
  useLayoutEffect(() => {
    if (width === 0) return;
    scrollTo(leftAt.current ?? nowAt());
  }, [origin, end, msPx, width, scrollTo, nowAt]);

  // The reads for the rows drawn over the hours drawn.
  const pages = pagesFor(
    items.map((item) => item.index),
    drawn,
  );
  const reads = useQueries({
    queries: pages.map((page) => ({
      ...queries.range(
        channels.slice(page.rows * PAGE_ROWS, (page.rows + 1) * PAGE_ROWS),
        page.time * PAGE_MS,
        (page.time + 1) * PAGE_MS,
      ),
      enabled: visible,
    })),
  });
  const answers = new Map<string, Readonly<Record<string, readonly GuideSlot[]>>>();
  for (const [index, page] of pages.entries()) {
    const data = reads[index]?.data;
    if (data) answers.set(`${page.rows}:${page.time}`, data);
  }
  // Each row keeps its programmes while its pages' answers stay the same, so rows already drawn
  // draw nothing again as others scroll in.
  const kept = useRef(new Map<string, RowGuide>());
  const rowGuide = (index: number): RowGuide => {
    const channel = channels[index];
    if (!channel || drawn.stop <= drawn.start) return NO_GUIDE;
    const key = ownedKey(channel);
    const rows = Math.floor(index / PAGE_ROWS);
    const times: number[] = [];
    for (
      let time = Math.floor(drawn.start / PAGE_MS);
      time <= Math.floor((drawn.stop - 1) / PAGE_MS);
      time++
    )
      times.push(time);
    const answered = times.filter((time) => answers.has(`${rows}:${time}`));
    const pagesRead = answered.map((time) => answers.get(`${rows}:${time}`)?.[key]);
    const covered = answered.join(",");
    const before = kept.current.get(key);
    // A row whose page is being read again, as when the list changed around it, keeps what it
    // showed until the answer is in, rather than showing nothing meanwhile.
    if (before && answered.length === 0) return before;
    if (
      before &&
      before.covered === covered &&
      before.pages.length === pagesRead.length &&
      before.pages.every((page, at) => page === pagesRead[at])
    )
      return before;
    const guide: RowGuide = {
      pages: pagesRead,
      covered,
      programmes: mergeSlots(pagesRead),
      known: joinSpans(
        answered.map((time) => ({ start: time * PAGE_MS, stop: (time + 1) * PAGE_MS })),
      ),
    };
    kept.current.set(key, guide);
    return guide;
  };
  useEffect(() => {
    // Forget rows long out of view.
    if (kept.current.size > 4 * (items.length + PAGE_ROWS)) kept.current.clear();
  });

  const [open, setOpen] = useState(false);
  const bounds = { start: origin, stop: end };
  // A moment the timeline no longer reaches, as it starts later, is its nearest end.
  const at = Math.min(Math.max(cursor.at, origin), end - 1);

  /**
   * What `cell` of `channel` offers now, the first what Enter does. By the clock, not the minute
   * the grid is drawn at: a programme that began within the minute has begun, and plays from its
   * start as the list's do. The details show the same as Enter does.
   */
  const offered = (channel: LiveChannel, cell: Cell): readonly GridAction[] =>
    remote ? ["live"] : actionsOf(channel, cell, now);
  /** Watches `channel` live, or plays `cell` from its start. */
  const act = (channel: LiveChannel, cell: Cell, action: GridAction) => {
    if (action === "live" || cell.kind === "gap") return onWatch(channel);
    const { slot } = cell;
    const read = client.getQueryData(queries.programme(channel, slot).queryKey);
    onPlayArchive(channel, {
      start: slot.start,
      stop: slot.stop,
      title: slot.title,
      description: read?.description ?? null,
    });
  };
  // Keys and the rows' callbacks read the latest render.
  const latest = useRef({
    channels,
    index,
    cursor,
    at,
    bounds,
    rowGuide,
    act,
    offered,
    open,
    onKeys,
  });
  latest.current = { channels, index, cursor, at, bounds, rowGuide, act, offered, open, onKeys };
  useImperativeHandle(
    ref,
    () => ({
      key(key) {
        const { channels, index, cursor, at: now, bounds, rowGuide, act, offered } = latest.current;
        const channel = channels[index];
        if (!channel) return "ignored";
        const move = (to: number, at = now) => {
          const target = Math.min(Math.max(to, 0), channels.length - 1);
          setCursor({
            index: target,
            channel: channels[target] ?? null,
            at,
            asked: cursor.asked + 1,
          });
          setOpen(true);
          // The grid takes the focus, so assistive technology follows its cursor.
          const grid = scroller.current;
          if (grid && document.activeElement !== grid) grid.focus({ preventScroll: true });
          return "handled" as const;
        };
        switch (key) {
          case "ArrowUp":
          case "ArrowDown":
          case "PageUp":
          case "PageDown": {
            const by = key.startsWith("Page") ? JUMP_ROWS : 1;
            return move(index + (key === "ArrowUp" || key === "PageUp" ? -by : by));
          }
          case "Home":
            return move(0);
          case "End":
            return move(channels.length - 1);
          case "ArrowLeft":
          case "ArrowRight": {
            const { programmes } = rowGuide(index);
            const cell = cellAt(programmes, now, bounds);
            const next = nextCell(programmes, cell, key === "ArrowLeft" ? -1 : 1, bounds);
            if (next) return move(index, next.start);
            return key === "ArrowLeft" ? "lists" : "handled";
          }
          case "Enter": {
            const cell = cellAt(rowGuide(index).programmes, now, bounds);
            act(channel, cell, offered(channel, cell)[0] ?? "live");
            return "handled";
          }
          default:
            return "ignored";
        }
      },
      channel: () => latest.current.channels[latest.current.index],
    }),
    [],
  );

  // The grid opens on the playing channel, once its channels are in.
  useEffect(() => {
    let initial = index;
    if (channels.length && cursor.channel === null && cursor.asked === 0) {
      initial = Math.max(
        channels.findIndex((channel) => ownedKey(channel) === playingKey),
        0,
      );
      setCursor({ ...cursor, index: initial, channel: channels[initial] ?? null });
    }
    if (initial > 0) virtualizer.scrollToIndex(initial, { align: "center" });
  }, [channels.length > 0]);

  // A key that moved the cursor brings it into view, the row and then the programme.
  useEffect(() => {
    if (cursor.asked === 0) return;
    virtualizer.scrollToIndex(index, { align: "auto" });
    const element = scroller.current;
    if (!element) return;
    const { programmes } = latest.current.rowGuide(index);
    const cell = cellAt(programmes, latest.current.at, latest.current.bounds);
    const { origin, msPx, columnPx } = geometry.current;
    const left = element.scrollLeft;
    const room = element.clientWidth - columnPx;
    const from = (Math.max(cell.start, origin) - origin) * msPx;
    const to = (cell.stop - origin) * msPx;
    const margin = rem;
    let target = left;
    if (from < left) target = from - margin;
    else if (to > left + room) target = Math.min(from - margin, to - room + margin);
    if (target !== left) scrollTo(origin + Math.max(target, 0) / msPx);
  }, [cursor.asked]);

  const watchLive = useRef(onWatch);
  watchLive.current = onWatch;
  const watch = useCallback((channel: LiveChannel) => watchLive.current(channel), []);
  /** A double click: what Enter does on that cell. */
  const play = useCallback((channel: LiveChannel, cell: Cell) => {
    const { act, offered } = latest.current;
    act(channel, cell, offered(channel, cell)[0] ?? "live");
  }, []);
  const doAction = useCallback(
    (channel: LiveChannel, cell: Cell, action: GridAction) =>
      latest.current.act(channel, cell, action),
    [],
  );
  /** A click on a programme, or a stretch without one, of row `row` at `at`. */
  const pick = useCallback((row: number, at: number) => {
    const { channels, index, cursor, at: before, bounds, rowGuide, open, onKeys } = latest.current;
    onKeys();
    const cell = cellAt(rowGuide(index).programmes, before, bounds);
    const again = open && row === index && at >= cell.start && at < cell.stop;
    setCursor({ index: row, channel: channels[row] ?? null, at, asked: cursor.asked });
    setOpen(!again);
  }, []);

  const cursorCell = cellAt(rowGuide(index).programmes, at, bounds);
  const cursorShown = showCursor || open;
  const nowPx = columnPx + (minute - origin) * msPx;
  return (
    <div className="flex min-h-0 flex-1 flex-col px-6">
      <div
        ref={scroller}
        onScroll={follow}
        onFocus={onKeys}
        role="grid"
        aria-label={t("Guide")}
        aria-rowcount={channels.length}
        tabIndex={0}
        aria-activedescendant={cursorShown ? cellId(ids, index, cursorCell) : undefined}
        className="min-h-0 flex-1 overflow-auto overscroll-contain outline-none"
      >
        <div className="relative" style={{ width: totalPx, height: virtualizer.getTotalSize() }}>
          <Head
            origin={origin}
            drawn={drawn}
            day={day}
            minute={minute}
            msPx={msPx}
            columnPx={columnPx}
            onNow={() => scrollTo(nowAt())}
          />
          {/* Under the rows: programmes show it through, the channels and details cover it. */}
          {minute >= origin && minute < end && (
            <div
              aria-hidden
              className="pointer-events-none absolute w-px bg-white"
              style={{ left: nowPx, top: headPx, height: virtualizer.getTotalSize() - headPx }}
            />
          )}
          {items.map((item) => {
            const channel = channels[item.index];
            if (!channel) return null;
            const guide = rowGuide(item.index);
            const here = item.index === index;
            return (
              <div
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                className="absolute top-0 left-0"
                style={{ width: totalPx, transform: `translateY(${item.start}px)` }}
              >
                <GridRow
                  channel={channel}
                  index={item.index}
                  programmes={guide.programmes}
                  known={guide.known}
                  drawnStart={drawn.start}
                  drawnStop={drawn.stop}
                  origin={origin}
                  msPx={msPx}
                  columnPx={columnPx}
                  rowPx={rowPx}
                  minute={minute}
                  playing={ownedKey(channel) === playingKey}
                  ids={ids}
                  cursor={here && cursorShown ? cursorCell : null}
                  details={here && open ? width : null}
                  actions={here && open ? offered(channel, cursorCell) : null}
                  remind={
                    here && open && cursorCell.kind === "programme" && cursorCell.slot.start > now
                  }
                  remote={remote}
                  reminders={reminders}
                  onPick={pick}
                  onWatch={watch}
                  onPlay={play}
                  onAction={doAction}
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The id of the cell of row `index` that starts at `cell.start`, for `aria-activedescendant`. */
function cellId(ids: string, index: number, cell: Span): string {
  return `${ids}-${index}-${cell.start}`;
}

/**
 * Moves the title of each programme drawn in `grid` that began left of `scrolled` right by as much
 * as is out of view, keeping `room` for its first letter and an ellipsis.
 */
function shiftAt(grid: HTMLElement, scrolled: number, room: number) {
  for (const block of grid.querySelectorAll<HTMLElement>("[data-left]")) {
    const start = Number(block.dataset["left"]);
    const width = Number(block.dataset["width"]);
    const shift = Math.min(Math.max(scrolled - start, 0), Math.max(width - room, 0));
    const title = block.firstElementChild;
    const margin = shift > 0 ? `${Math.round(shift)}px` : "";
    if (title instanceof HTMLElement && title.style.marginLeft !== margin)
      title.style.marginLeft = margin;
  }
}

/** The day at the left edge, Now, and the half hours along the top, with the time at the line. */
function Head({
  origin,
  drawn,
  day,
  minute,
  msPx,
  columnPx,
  onNow,
}: {
  origin: number;
  drawn: Span;
  day: number;
  minute: number;
  msPx: number;
  columnPx: number;
  onNow: () => void;
}) {
  const ticks: number[] = [];
  for (
    let at = Math.ceil(drawn.start / HALF_HOUR_MS) * HALF_HOUR_MS;
    at < drawn.stop;
    at += HALF_HOUR_MS
  )
    ticks.push(at);
  const x = (at: number) => (at - origin) * msPx;
  return (
    <div
      className="sticky top-0 z-20 flex bg-black text-xs text-muted-foreground tabular-nums"
      style={{ height: `${HEAD_REM}rem` }}
    >
      <div
        className="sticky left-0 z-10 flex flex-none items-center gap-2 bg-black pl-3 whitespace-nowrap"
        style={{ width: columnPx }}
      >
        {day > 0 && formatDate(day, "weekdayDay")}
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={onNow}
          className="flex h-[1.375rem] items-center rounded-full bg-white/10 px-2.5 text-white hover:bg-white/16"
        >
          {t("Now")}
        </button>
      </div>
      <div className="relative flex-1 overflow-clip">
        {ticks.map((at) => (
          // A time the label at the line would cover keeps only its mark.
          <span
            key={at}
            className="absolute inset-y-0 border-l border-white/8 pl-1.5 leading-[2rem] whitespace-nowrap"
            style={{ left: x(at) }}
          >
            {at > minute - 29 * MINUTE_MS && at < minute + 11 * MINUTE_MS
              ? null
              : new Date(at).getHours() === 0 && new Date(at).getMinutes() === 0
                ? formatDate(at, "weekdayDay")
                : formatDate(at, "time")}
          </span>
        ))}
        {minute >= drawn.start && minute < drawn.stop && (
          <span
            className="absolute top-0 -translate-x-1/2 bg-black px-1.5 leading-[2rem] font-semibold text-white"
            style={{ left: x(minute) }}
          >
            {formatDate(minute, "time")}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * A channel's row: its number, logo and name, and its programmes over the hours drawn. Drawn
 * again only when what it shows changes.
 */
const GridRow = memo(function GridRow({
  channel,
  index,
  programmes,
  known,
  drawnStart,
  drawnStop,
  origin,
  msPx,
  columnPx,
  rowPx,
  minute,
  playing,
  cursor,
  details,
  actions,
  remind,
  remote,
  reminders,
  ids,
  onPick,
  onWatch,
  onPlay,
  onAction,
}: {
  channel: LiveChannel;
  index: number;
  programmes: readonly GuideSlot[];
  known: readonly Span[];
  drawnStart: number;
  drawnStop: number;
  origin: number;
  msPx: number;
  columnPx: number;
  rowPx: number;
  minute: number;
  playing: boolean;
  /** The cell with the cursor, on the cursor's row while it shows. */
  cursor: Cell | null;
  /** The width of the details under the row, while they are open. */
  details: number | null;
  /** What the cursor's programme offers, while its details are open. */
  actions: readonly GridAction[] | null;
  /** The cursor's programme is still to come, by the clock: its details offer Remind me. */
  remind: boolean;
  /** A receiver has playback, so programmes watch live only. */
  remote: boolean;
  /** The reminders set, whose programmes' cells show a bell. */
  reminders: ReminderList | undefined;
  /** The grid's prefix for its cells' ids, which name the cursor's to assistive technology. */
  ids: string;
  onPick: (row: number, at: number) => void;
  onWatch: (channel: LiveChannel) => void;
  /** A double click on a cell: what Enter does there. */
  onPlay: (channel: LiveChannel, cell: Cell) => void;
  onAction: (channel: LiveChannel, cell: Cell, action: GridAction) => void;
}) {
  const blocks = blocksIn(programmes, known, { start: drawnStart, stop: drawnStop });
  const place = (cell: Span) => {
    const start = Math.max(cell.start, origin);
    return { left: (start - origin) * msPx, width: (cell.stop - start) * msPx };
  };
  /** The moment under the pointer, within `cell`. */
  const pointed = (event: MouseEvent<HTMLElement>, cell: Span) => {
    const area = event.currentTarget.parentElement?.getBoundingClientRect();
    const at = origin + (event.clientX - (area?.left ?? 0)) / msPx;
    return Math.min(Math.max(at, cell.start, origin), cell.stop - 1);
  };
  const selected = (cell: Span) =>
    cursor !== null && cursor.start === cell.start && cursor.stop === cell.stop;
  return (
    <div role="row" aria-rowindex={index + 1}>
      <div
        className={cn("flex border-t border-white/8", playing && "bg-white/5")}
        style={{ height: rowPx }}
      >
        <div
          role="rowheader"
          title={channel.name}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onWatch(channel)}
          className="sticky left-0 z-10 flex-none bg-black"
          style={{ width: columnPx }}
        >
          <div
            className={cn(
              "flex h-full items-center gap-2.5 pr-2 pl-3 hover:bg-white/8",
              playing && "bg-white/5",
            )}
          >
            <span className="w-6 flex-none text-right text-xs text-muted-foreground tabular-nums">
              {channel.number ?? ""}
            </span>
            <ChannelLogo channel={channel} className="h-[1.875rem] w-[2.875rem] rounded-md" />
            <span className={cn("min-w-0 flex-1 truncate text-sm", playing && "font-semibold")}>
              {channel.title}
            </span>
            {playing && <span className="size-1.5 flex-none rounded-full bg-white" />}
            {channel.catchupDays !== null && (
              <History
                role="img"
                aria-label={t("Catch-up")}
                className="size-[0.8125rem] flex-none text-muted-foreground"
              />
            )}
          </div>
        </div>
        <div className="relative flex-1">
          {blocks.map((block) => {
            if (block.kind === "gap")
              return (
                <div
                  key={`gap ${block.start}`}
                  role="gridcell"
                  aria-selected={false}
                  aria-label={t("No programme information")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={(event) => onPick(index, pointed(event, block))}
                  onDoubleClick={() => onPlay(channel, block)}
                  className="absolute inset-y-0 bg-[repeating-linear-gradient(135deg,rgb(255_255_255/7%)_0_1px,transparent_1px_9px)]"
                  style={place(block)}
                />
              );
            const { slot } = block;
            const ended = slot.stop <= minute;
            const on = slot.start <= minute && !ended;
            const replay = ended && archiveHolds(channel.catchupDays, slot.start, minute);
            const chosen = selected(block);
            const box = place(block);
            const reminded = reminderAt(reminders, channel, slot.start) !== undefined;
            return (
              <div
                key={slot.start}
                data-left={box.left}
                data-width={box.width}
                id={cellId(ids, index, block)}
                role="gridcell"
                aria-selected={chosen}
                aria-label={[
                  slot.title,
                  spanText(slot, minute),
                  replay && !remote && t("Catch-up"),
                  reminded && t("Reminder set"),
                ]
                  .filter(Boolean)
                  .join(", ")}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => onPick(index, pointed(event, block))}
                onDoubleClick={() => onPlay(channel, block)}
                className={cn(
                  "absolute inset-y-0 flex flex-col justify-center overflow-clip whitespace-nowrap before:pointer-events-none before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-white/12 hover:bg-white/5",
                  ended && !replay && "text-foreground/38",
                  replay && "bg-white/[0.035]",
                  !ended && !on && "text-foreground/85",
                  chosen &&
                    "z-[1] rounded-lg bg-white/10 text-white ring-2 ring-white/70 ring-inset before:bg-transparent hover:bg-white/10",
                )}
                style={box}
              >
                {/* Padding stays inside the clipped cell, so tiny slots keep their timeline width.
                    The grid moves this title into view when the programme's start is scrolled past. */}
                <span className={cn("truncate px-2.5 text-sm", on && "font-semibold")}>
                  {reminded && (
                    <Bell aria-hidden className="mr-1.5 -mt-0.5 inline size-3 align-middle" />
                  )}
                  {slot.title}
                </span>
              </div>
            );
          })}
          {cursor?.kind === "gap" && (
            <div
              id={cellId(ids, index, cursor)}
              role="gridcell"
              aria-selected
              aria-label={`${t("No programme information")}, ${spanText(cursor, minute)}`}
              className="pointer-events-none absolute inset-y-0 z-[1] rounded-lg bg-white/10 ring-2 ring-white/70 ring-inset"
              style={place(cursor)}
            />
          )}
        </div>
      </div>
      {cursor && details !== null && (
        <Details
          channel={channel}
          cell={cursor}
          minute={minute}
          width={details}
          actions={actions ?? ["live"]}
          remind={remind}
          onAction={(action) => onAction(channel, cursor, action)}
        />
      )}
    </div>
  );
});

/**
 * What the cursor's programme is, under its row: its title, when it is on, its description once
 * read, and what it plays, the first of `actions` foremost, then Remind me while it is to come.
 */
function Details({
  channel,
  cell,
  minute,
  width,
  actions,
  remind,
  onAction,
}: {
  channel: LiveChannel;
  cell: Cell;
  minute: number;
  /** The grid's width in view: the details stay in place while it scrolls across. */
  width: number;
  actions: readonly GridAction[];
  /** It is still to come: Remind me follows what it plays. */
  remind: boolean;
  onAction: (action: GridAction) => void;
}) {
  const slot = cell.kind === "programme" ? cell.slot : null;
  const read = useQuery({
    ...queries.programme(channel, slot ?? { guide: "", start: 0 }),
    enabled: slot !== null,
  }).data;
  const on = slot !== null && slot.start <= minute && minute < slot.stop;
  return (
    <div
      role="region"
      aria-label={slot?.title ?? channel.title}
      className="sticky left-0 z-10 rounded-b-xl bg-[#141414] pt-3.5 pr-4 pb-4"
      style={{ width, paddingLeft: `${COLUMN_REM + 2.5}rem` }}
    >
      <div className="truncate text-lg font-semibold tracking-tight">
        {slot?.title ?? t("No programme information")}
      </div>
      <div className="mt-1 truncate text-sm text-muted-foreground">
        {on ? `${spanText(cell, minute)} · ${timeLeft(slot, minute)}` : spanText(cell, minute)}
      </div>
      {on && <Progress value={progressOf(slot, minute)} className="mt-2 w-48" />}
      {read?.description && (
        <p className="mt-1.5 line-clamp-2 max-w-[40rem] text-[0.8125rem] leading-normal text-muted-foreground select-text">
          {read.description}
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions.map((action, at) => (
          <Button
            key={action}
            variant={at === 0 ? "primary" : "secondary"}
            size="sm"
            onClick={() => onAction(action)}
          >
            {action === "live" ? <Play className="fill-current" /> : <RotateCcw />}
            {action === "live" ? t("Watch live") : t("Play from start")}
          </Button>
        ))}
        {slot && remind && (
          <ReminderButton
            key={`${ownedKey(channel)}:${slot.start}`}
            channel={channel}
            start={slot.start}
          />
        )}
      </div>
    </div>
  );
}

/** "15:00 to 15:45", with the day when it isn't today: "yesterday 23:00 to 01:00". */
function spanText(span: Span, now: number): string {
  const start =
    span.start <= now
      ? pastTime(span.start, now)
      : span.start < endOfDay(now)
        ? formatDate(span.start, "time")
        : comingTime(span.start, now);
  return t("{start} to {end}", { start, end: formatDate(span.stop, "time") });
}
