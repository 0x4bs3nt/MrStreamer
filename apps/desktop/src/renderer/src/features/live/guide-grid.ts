// The TV Guide grid's time and data model, apart from how it draws: how far its timeline reaches,
// which pages of channels and hours it reads with `guide.range`, and what stands at a moment on a
// channel's row, a programme or a stretch the guide has nothing for. The grid's cursor is a row
// and a moment: the cell is whatever covers that moment, so Up and Down keep the time, and the
// cell follows when the programmes come in.
//   What a programme offers follows from when it is and the channel's catch-up: see `actionsOf`.
import type { GuideSlot } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { archiveHolds, DAY_MS } from "@mrstreamer/core/catchup";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/** How far back the guide keeps programmes, and so the most the grid goes back. */
const KEPT_MS = 7 * DAY_MS;
/** How far back the grid goes when no channel of the list keeps an archive. */
const PAST_MS = 2 * HOUR_MS;
/** How far ahead the grid goes at least, where the guide ends sooner or isn't known. */
const AHEAD_MS = 2 * HOUR_MS;
/** How far ahead the grid goes at most, as far as it goes back. */
const AHEAD_MOST_MS = 7 * DAY_MS;

/** Channels one read asks for, within `GUIDE_RANGE`. */
export const PAGE_ROWS = 25;
/** Hours one read covers, aligned to the epoch, within `GUIDE_RANGE`. */
export const PAGE_MS = 6 * HOUR_MS;

/** A stretch of time, [start, stop) in epoch milliseconds. */
export interface Span {
  readonly start: number;
  readonly stop: number;
}

/** What covers a moment on a channel's row: one of its programmes, or a stretch without any. */
export type Cell =
  | (Span & { readonly kind: "programme"; readonly slot: GuideSlot })
  | (Span & { readonly kind: "gap" });

/** One `guide.range` read: a page of the grid's rows over a page of time, each by its index. */
export interface Page {
  readonly rows: number;
  readonly time: number;
}

/** What a programme of the grid plays: the channel live, or the programme from its start. */
export type GridAction = "live" | "start";

/**
 * What the cell offers on its channel at `now`, the first what Enter and a double click do. A
 * programme the channel's catch-up holds plays from its start: first once it has ended, second
 * after Watch live while it is on. Everything else, ended ones past the channel's archive among
 * them, watches the channel live.
 */
export function actionsOf(channel: LiveChannel, cell: Cell, now: number): readonly GridAction[] {
  if (cell.kind === "gap" || !archiveHolds(channel.catchupDays, cell.start, now)) return ["live"];
  return cell.stop <= now ? ["start", "live"] : ["live", "start"];
}

/** The most days of catch-up any of `channels` keeps, 0 without any. */
export function longestArchive(channels: readonly LiveChannel[]): number {
  return channels.reduce((most, channel) => Math.max(most, channel.catchupDays ?? 0), 0);
}

/**
 * The grid's timeline, in whole hours: back as far as the longest archive among the list's
 * channels, `archiveDays`, or two hours without one, at most the week the guide keeps; ahead to
 * where its programmes end, `until`, but at least two hours and at most a week.
 */
export function timeline(archiveDays: number, until: number | null, now: number): Span {
  const back = Math.min(Math.max(archiveDays * DAY_MS, PAST_MS), KEPT_MS);
  const ahead = Math.min(Math.max((until ?? now) - now, AHEAD_MS), AHEAD_MOST_MS);
  return {
    start: Math.floor((now - back) / HOUR_MS) * HOUR_MS,
    stop: Math.ceil((now + ahead) / HOUR_MS) * HOUR_MS,
  };
}

/**
 * The reads that cover the rows at `rows`, by index, over `time`: every page of rows they touch by
 * every page of hours it touches, rows first.
 */
export function pagesFor(rows: readonly number[], time: Span): Page[] {
  if (time.stop <= time.start) return [];
  const first = Math.floor(time.start / PAGE_MS);
  const last = Math.floor((time.stop - 1) / PAGE_MS);
  return [...new Set(rows.map((row) => Math.floor(row / PAGE_ROWS)))].flatMap((page) =>
    Array.from({ length: last - first + 1 }, (_, at) => ({ rows: page, time: first + at })),
  );
}

/**
 * One row's programmes from the pages read for it, in time order without overlaps: a programme
 * read on both sides of a page's edge shows once, and one that overlaps the programme before it,
 * as a careless guide has them, gives way to it.
 */
export function mergeSlots(
  pages: readonly (readonly GuideSlot[] | undefined)[],
): readonly GuideSlot[] {
  const all = pages.flatMap((page) => page ?? []).toSorted((a, b) => a.start - b.start);
  const merged: GuideSlot[] = [];
  for (const programme of all) {
    const last = merged.at(-1);
    if (programme.stop > programme.start && (!last || programme.start >= last.stop))
      merged.push(programme);
  }
  return merged;
}

/**
 * What covers `at` on a row with `programmes` in time order: the programme on then, or the hour of
 * the stretch without one that `at` is in, so a long gap is crossed an hour at a time. Within
 * `bounds`, the grid's timeline.
 */
export function cellAt(programmes: readonly GuideSlot[], at: number, bounds: Span): Cell {
  let low = 0;
  let high = programmes.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (programmes[middle]!.start <= at) low = middle + 1;
    else high = middle;
  }
  const before = programmes[low - 1];
  const after = programmes[low];
  if (before && before.stop > at)
    return { kind: "programme", start: before.start, stop: before.stop, slot: before };
  const hour = Math.floor(at / HOUR_MS) * HOUR_MS;
  return {
    kind: "gap",
    start: Math.max(before?.stop ?? bounds.start, hour, bounds.start),
    stop: Math.min(after?.start ?? bounds.stop, hour + HOUR_MS, bounds.stop),
  };
}

/** The cell after `cell` on its row, or before it, or null at the end of the timeline. */
export function nextCell(
  programmes: readonly GuideSlot[],
  cell: Span,
  direction: -1 | 1,
  bounds: Span,
): Cell | null {
  const at = direction > 0 ? cell.stop : cell.start - 1;
  return at >= bounds.start && at < bounds.stop ? cellAt(programmes, at, bounds) : null;
}

/**
 * What a row draws over `shown`: its programmes there, and where the guide answered with
 * nothing, within `known`, a stretch without programmes. Where no answer is in yet, nothing.
 */
export function blocksIn(
  programmes: readonly GuideSlot[],
  known: readonly Span[],
  shown: Span,
): Cell[] {
  const on = programmes.filter(
    (programme) => programme.stop > shown.start && programme.start < shown.stop,
  );
  const blocks: Cell[] = on.map((slot) => ({
    kind: "programme",
    start: slot.start,
    stop: slot.stop,
    slot,
  }));
  for (const span of known) {
    let at = Math.max(span.start, shown.start);
    const stop = Math.min(span.stop, shown.stop);
    for (const programme of on) {
      if (at >= stop) break;
      if (programme.stop <= at) continue;
      if (programme.start > at)
        blocks.push({ kind: "gap", start: at, stop: Math.min(programme.start, stop) });
      at = Math.max(at, programme.stop);
    }
    if (at < stop) blocks.push({ kind: "gap", start: at, stop });
  }
  return blocks.toSorted((a, b) => a.start - b.start);
}

/** Adjacent spans joined: the pages of time read for a row, as one stretch where they touch. */
export function joinSpans(spans: readonly Span[]): Span[] {
  const joined: Span[] = [];
  for (const span of spans.toSorted((a, b) => a.start - b.start)) {
    const last = joined.at(-1);
    if (last && span.start <= last.stop)
      joined[joined.length - 1] = { start: last.start, stop: Math.max(last.stop, span.stop) };
    else joined.push(span);
  }
  return joined;
}
