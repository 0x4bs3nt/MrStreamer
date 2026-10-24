// The guide's channel list: a row per channel with its number, logo and name, the qualities of a
// channel with several streams, what's on now with progress and time left, and what's next. The chevron opens the rest of the day under the row,
// after today's programmes so far that the provider's catch-up keeps, which play from their start.
// Rows ask the guide for programmes only as they come into view.
//   A search shows the same rows for the channels it found, with what matched underlined: the
// name, the programme on now, or a later one, which then stands where what's next does, in white
// and at every width. The rest of the day opens on that programme.
//   While the favourites are being put in another order, the same rows stand in the order being
// made. Each has an Up and a Down button where its star and its arrow were, and plays nothing.
// One row holds the focus, the one the keys move, and keeps it wherever it goes: its row stays
// in the page while the list draws only the rows in view.
import { useQuery } from "@tanstack/react-query";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronDown, Star } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";
import {
  GUIDE_SCHEDULE,
  type Listing,
  type ListingMatch,
  type Programme,
} from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { archiveHolds } from "@mrstreamer/core/catchup";
import { matchRanges } from "@mrstreamer/core/text";
import { t } from "@mrstreamer/core/i18n";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, endOfDay, pastTime, progressOf, timeLeft } from "../../lib/format.ts";
import { useOutput } from "../../player/output.ts";
import { qualitiesLine } from "../../lib/quality.ts";
import { queries, useSearchSubscriptionNames, useSourceOf } from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";
import { useVisibleListings } from "./lists.ts";
import { rowPlays, searchQualities, type SearchChannelRow } from "./search-rows.ts";
import type { RowPart } from "./reorder.ts";

const ROW_REM = 3.75;
const NONE: readonly string[] = [];

/** The list while its channels are being put in another order. */
export interface TableOrder {
  /** The channels in their saved order, which programmes are asked for by: moving a row asks none. */
  readonly saved: readonly LiveChannel[];
  /** The part of the selected row that holds the focus, and how often the viewer chose it. */
  readonly focus: { readonly part: RowPart; readonly asked: number };
  /** Nothing moves: the order is being saved, or can't be. */
  readonly locked: boolean;
  /** A click on a row, which gives it the keys. */
  onSelect(channel: OwnedId): void;
  /** The focus went to a row's part by itself, as with Tab. */
  onFocused(channel: OwnedId, part: RowPart): void;
  /** Moves a channel `by` places, keeping the focus on `part` of its row. */
  onMove(channel: OwnedId, by: number, part: RowPart): void;
}

/**
 * One list's channels, or what a search found of them. Give each its own, by key: the list
 * before, its scroll position and what the virtualiser measured of it, would move this one when
 * a row opens.
 */
export function ChannelTable({
  channels,
  searchRows = null,
  searchFocus = 0,
  categories,
  expandedCopies = new Set<string>(),
  onToggleCopies,
  onSelectSearch,
  selected,
  playingKey,
  expandedKey,
  favourites,
  words,
  matches,
  order = null,
  onWatch,
  onWatchArchive,
  onToggleSchedule,
  onToggleFavourite,
}: {
  channels: readonly LiveChannel[];
  searchRows?: readonly SearchChannelRow[] | null;
  /** Changes when a result-navigation key explicitly asks the selected row to take focus. */
  searchFocus?: number;
  categories?: ReadonlyMap<string, Category>;
  expandedCopies?: ReadonlySet<string>;
  onToggleCopies?: (key: string) => void;
  onSelectSearch?: (index: number) => void;
  /**
   * The keyboard selection, or null while the pointer is in use. While `order` is set, the row
   * that holds the focus, whichever is in use.
   */
  selected: number | null;
  /** The channel that plays and the one whose schedule is open, each by its `ownedKey`. */
  playingKey: string | null;
  expandedKey: string | null;
  /** The favourite channels, by `ownedKey`. */
  favourites: ReadonlySet<string>;
  /** The words of the search the channels were found by; none without one. */
  words: readonly string[];
  /** What that search found in each channel's programmes, by the channel's `ownedKey`. */
  matches: Readonly<Record<string, ListingMatch>>;
  /** Set while `channels` are the favourites in an order being made. */
  order?: TableOrder | null;
  onWatch: (channel: LiveChannel, index: number) => void;
  /** A programme of the channel's schedule that aired, to play from its catch-up archive. */
  onWatchArchive: (channel: LiveChannel, index: number, programme: Programme) => void;
  onToggleSchedule: (channelKey: string) => void;
  onToggleFavourite: (channel: LiveChannel) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const asked = useRef(searchFocus);
  const focusedRow = useRef<HTMLElement | null>(null);
  // Selection can show because Tab enabled keyboard mode. Only navigation or focus already
  // owned by a result row moves DOM focus; disclosure buttons keep their own Tab position.
  useLayoutEffect(() => {
    const requested = asked.current !== searchFocus;
    asked.current = searchFocus;
    const focused = document.activeElement;
    const ownsFocus =
      (focused?.hasAttribute("data-search-row") && scroller.current?.contains(focused)) ||
      // A regroup replaces the focused row's node. Keep its focus on the selected exact copy.
      (focused === document.body && focusedRow.current !== null && !focusedRow.current.isConnected);
    if (!searchRows || selected === null || (!requested && !ownsFocus)) return;
    scroller.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"] [data-search-row]`)
      ?.focus({ preventScroll: true });
  }, [selected, searchRows, searchFocus]);
  const rem = useRem();
  const now = useNow();
  const sourceOf = useSourceOf();
  const subscriptionName = useSearchSubscriptionNames();
  // The row with the focus stays in the page when it scrolls out of view, so it keeps the focus.
  const kept = order || searchRows ? selected : null;
  const rangeExtractor = useCallback(
    (range: Range) => {
      const drawn = defaultRangeExtractor(range);
      if (kept === null || kept >= range.count || drawn.includes(kept)) return drawn;
      return [...drawn, kept].sort((a, b) => a - b);
    },
    [kept],
  );
  // Whole pixels, as the virtualizer measures a row: one scrolling in measures as estimated, and
  // the thousands after it aren't placed again.
  const rowPx = Math.round(ROW_REM * rem);
  // The virtualizer places every row again when this changes: once per list or search, not on
  // each render while it scrolls.
  const getItemKey = useCallback(
    (index: number) => {
      const channel = channels[index];
      return searchRows?.[index]?.key ?? (channel ? ownedKey(channel) : index);
    },
    [channels, searchRows],
  );
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => rowPx,
    getItemKey,
    overscan: 8,
    rangeExtractor,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rem, virtualizer]);

  // The list opens on the playing channel.
  useEffect(() => {
    const index = channels.findIndex((channel, at) =>
      rowPlays(channel, searchRows?.[at], playingKey),
    );
    virtualizer.scrollToIndex(Math.max(index, 0), { align: index > 0 ? "center" : "start" });
    // Only once its channels are in, not when another channel starts.
  }, [channels.length > 0]);

  // Only the keyboard scrolls the list, and a channel moved in it by either.
  useEffect(() => {
    if (selected !== null) virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const saved = order?.saved;
  const savedAt = useMemo(
    () => new Map(saved?.map((channel, index) => [ownedKey(channel), index])),
    [saved],
  );
  const listings = useVisibleListings(
    saved ?? channels,
    items.flatMap((item) => {
      if (!saved) return item.index;
      const channel = channels[item.index];
      return (channel && savedAt.get(ownedKey(channel))) ?? [];
    }),
  );

  return (
    <div
      ref={scroller}
      onFocusCapture={(event) => {
        focusedRow.current = event.target.hasAttribute("data-search-row") ? event.target : null;
      }}
      onBlurCapture={(event) => {
        if (event.target.isConnected) focusedRow.current = null;
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pb-8"
    >
      <div
        className="relative"
        style={{ height: virtualizer.getTotalSize() }}
        {...(order ? { role: "list", "aria-label": t("Favourites, in the order to save") } : {})}
      >
        {items.map((item) => {
          const channel = channels[item.index];
          if (!channel) return null;
          const key = ownedKey(channel);
          return (
            <div
              key={item.key}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="absolute inset-x-0"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <ChannelRow
                channel={channel}
                source={
                  searchRows?.[item.index]?.copy
                    ? subscriptionName(channel.subscriptionId)
                    : sourceOf(channel)
                }
                subscription={subscriptionName(channel.subscriptionId)}
                searchRow={searchRows?.[item.index] ?? null}
                category={
                  channel.categoryIds
                    .map((id) =>
                      categories?.get(ownedKey({ subscriptionId: channel.subscriptionId, id })),
                    )
                    .find(Boolean) ?? null
                }
                copiesOpen={expandedCopies.has(searchRows?.[item.index]?.group.key ?? "")}
                onToggleCopies={() => {
                  const row = searchRows?.[item.index];
                  if (row) onToggleCopies?.(row.group.key);
                }}
                onSelectSearch={() => onSelectSearch?.(item.index)}
                listing={listings.get(key) ?? null}
                now={now}
                playing={rowPlays(channel, searchRows?.[item.index], playingKey)}
                selected={item.index === selected}
                expanded={
                  key === expandedKey &&
                  !(
                    searchRows?.[item.index] &&
                    !searchRows[item.index]!.copy &&
                    searchRows[item.index]!.group.copies.length > 1
                  )
                }
                favourite={favourites.has(key)}
                words={words}
                match={matches[key] ?? null}
                order={
                  order && {
                    position: item.index + 1,
                    count: channels.length,
                    focus: item.index === selected ? order.focus : null,
                    locked: order.locked,
                    onSelect: () => order.onSelect(channel),
                    onFocused: (part) => order.onFocused(channel, part),
                    onMove: (by, part) => order.onMove(channel, by, part),
                  }
                }
                onWatch={() => onWatch(channel, item.index)}
                onWatchArchive={(programme) => onWatchArchive(channel, item.index, programme)}
                onToggleSchedule={() => onToggleSchedule(key)}
                onToggleFavourite={() => onToggleFavourite(channel)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ChannelRow({
  channel,
  source,
  subscription,
  searchRow,
  category,
  copiesOpen,
  onToggleCopies,
  onSelectSearch,
  listing,
  now,
  playing,
  selected,
  expanded,
  favourite,
  words,
  match,
  order,
  onWatch,
  onWatchArchive,
  onToggleSchedule,
  onToggleFavourite,
}: {
  channel: LiveChannel;
  /** The subscription it is from, by name, where another's channel is called the same. */
  source: string | null;
  subscription: string | null;
  searchRow: SearchChannelRow | null;
  category: Category | null;
  copiesOpen: boolean;
  onToggleCopies: () => void;
  onSelectSearch: () => void;
  listing: Listing | null;
  now: number;
  playing: boolean;
  selected: boolean;
  expanded: boolean;
  favourite: boolean;
  words: readonly string[];
  match: ListingMatch | null;
  /** Set while the list is being put in another order: the row moves, and plays nothing. */
  order: RowOrder | null;
  onWatch: () => void;
  onWatchArchive: (programme: Programme) => void;
  onToggleSchedule: () => void;
  onToggleFavourite: () => void;
}) {
  const searching = words.length > 0;
  const grouped = searchRow && !searchRow.copy && searchRow.group.copies.length > 1;
  const subscriptionCount = grouped
    ? new Set(searchRow.group.copies.map((copy) => copy.subscriptionId)).size
    : 0;
  const groupSummary = grouped
    ? `${t("{count} subscriptions", { count: subscriptionCount })} · ${searchQualities(searchRow.group.copies)}`
    : null;
  const copySummary = searchRow?.copy
    ? [searchQualities([channel]), source, category?.group, category?.title]
        .filter(Boolean)
        .join(" · ")
    : null;
  const current = listing?.now ?? null;
  const next = listing?.next ?? null;
  // A match that began since it was found is the programme on now.
  const later = match?.later && match.later.start > now ? match.later : null;
  const row = useRef<HTMLDivElement>(null);
  // The row the keys move takes the focus when the viewer chooses it, and again after each move,
  // which counts as choosing it: the page puts a moved row's node elsewhere, and that drops the
  // focus it had. So does a page that took no input while the order was saved.
  const part = order?.focus?.part;
  const asked = order?.focus?.asked;
  const locked = order?.locked;
  useLayoutEffect(() => {
    if (!part) return;
    const target =
      part === "row"
        ? row.current
        : row.current?.querySelector<HTMLElement>(`[data-move="${part}"]`);
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
  }, [part, asked, locked]);
  return (
    <div className="pb-1">
      <div
        ref={row}
        onMouseDown={(event) => event.preventDefault()}
        {...(order
          ? {
              role: "listitem",
              "aria-label": source ? `${channel.title}, ${source}` : channel.title,
              "aria-posinset": order.position,
              "aria-setsize": order.count,
              // Tab stops at the row the keys move, and goes on to its two buttons.
              tabIndex: order.focus ? 0 : -1,
              onClick: order.onSelect,
              onFocus: (event: FocusEvent) => {
                if (event.target === event.currentTarget) order.onFocused("row");
              },
            }
          : {
              role: "button",
              "data-search-row": searchRow ? "" : undefined,
              tabIndex: searchRow && selected ? 0 : -1,
              onClick: onWatch,
              onFocus: searchRow
                ? (event: FocusEvent) => {
                    if (event.target === event.currentTarget && !selected) onSelectSearch();
                  }
                : undefined,
              "aria-label": searchRow
                ? [
                    channel.title,
                    grouped ? groupSummary : null,
                    grouped ? t("{count} streams", { count: searchRow.group.streams }) : null,
                    !grouped ? subscription : null,
                    !grouped ? category?.group : null,
                    !grouped ? category?.title : null,
                    !grouped ? channel.number : null,
                    !grouped ? searchQualities([channel]) : null,
                    match?.now ? current?.title : later?.title,
                  ]
                    .filter((part) => part != null && part !== "")
                    .join(", ")
                : undefined,
              ...(grouped ? { "aria-expanded": copiesOpen } : {}),
              onKeyDown: (event) => {
                if (!searchRow || event.target !== event.currentTarget || event.repeat) return;
                // Enter belongs to the page, which also commits a typed channel number.
                if (event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  onWatch();
                }
              },
            })}
        className={cn(
          "group flex h-[3.5rem] items-center gap-4 rounded-lg px-3 outline-none hover:bg-white/8",
          expanded && "rounded-b-none bg-white/8",
          searchRow && "text-white",
          searchRow?.copy && "ml-8",
          playing && !expanded && "bg-white/5",
          selected && "ring-2 ring-white/70 ring-inset",
        )}
      >
        <span className="w-9 flex-none text-right text-xs text-muted-foreground tabular-nums">
          {grouped ? "" : (channel.number ?? "")}
        </span>
        <ChannelLogo channel={channel} className="h-8 w-12" />
        <span
          className={cn(
            "flex w-[13rem] flex-none gap-2",
            grouped || searchRow?.copy ? "flex-wrap items-center gap-y-0" : "items-center",
          )}
          title={channel.name}
        >
          <span className={cn("truncate text-[0.9375rem]", playing && "font-semibold text-white")}>
            <Marked text={channel.title} words={words} />
          </span>
          {playing && <span className="size-1.5 flex-none rounded-full bg-white" />}
          <span
            className={cn(
              "text-xs text-muted-foreground",
              grouped || searchRow?.copy ? "w-full truncate text-white" : "flex-none",
            )}
            title={copySummary ?? undefined}
          >
            {grouped ? groupSummary : searchRow?.copy ? copySummary : qualitiesLine(channel)}
          </span>
          {/* Plain text in the name's cell, which gives way before the name does. */}
          {!grouped && !searchRow?.copy && (source || channel.browse?.country) && (
            <span className="min-w-0 flex-shrink-[3] truncate text-xs text-muted-foreground">
              · {[channel.browse?.country, source].filter(Boolean).join(" · ")}
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-4">
          {current && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[0.9375rem]">
                  {match?.now ? <Marked text={current.title} words={words} /> : current.title}
                </span>
                <Progress
                  value={progressOf(current, now)}
                  className="mt-1.5 w-[70%] max-w-[16rem]"
                />
              </span>
              {/* A search keeps the column after this one at every width, which takes its room. */}
              <span
                className={cn(
                  "flex-none text-xs text-muted-foreground",
                  searching && "hidden xl:block",
                )}
              >
                {timeLeft(current, now)}
              </span>
            </>
          )}
        </span>
        <span
          className={cn(
            "flex-none truncate text-sm",
            searching ? "w-[11rem] xl:w-[15rem]" : "hidden w-[15rem] xl:block",
            later ? "text-foreground" : "text-muted-foreground",
          )}
        >
          {later ? (
            <>
              {clockTime(later.start, now)} <Marked text={later.title} words={words} />
            </>
          ) : next ? (
            `${clockTime(next.start, now)} ${next.title}`
          ) : (
            ""
          )}
        </span>
        <span className="flex w-[4.5rem] flex-none items-center justify-end gap-1">
          {order ? (
            <>
              <MoveButton by={-1} channel={channel} order={order} />
              <MoveButton by={1} channel={channel} order={order} />
            </>
          ) : (
            <>
              {!grouped && (
                <IconButton
                  label={favourite ? t("Remove from favourites") : t("Add to favourites")}
                  onClick={onToggleFavourite}
                  className={cn(!favourite && !selected && "opacity-0 group-hover:opacity-100")}
                >
                  <Star className={cn("size-4", favourite && "fill-current")} />
                </IconButton>
              )}
              {grouped ? (
                <IconButton
                  label={copiesOpen ? t("Hide copies") : t("Show copies")}
                  onClick={onToggleCopies}
                >
                  <ChevronDown className={cn("size-4", !copiesOpen && "-rotate-90")} />
                </IconButton>
              ) : (
                listing && (
                  <IconButton
                    label={expanded ? t("Hide later programmes") : t("Later programmes")}
                    onClick={onToggleSchedule}
                    className={cn(!expanded && !selected && "opacity-0 group-hover:opacity-100")}
                  >
                    <ChevronDown className={cn("size-4", expanded && "rotate-180")} />
                  </IconButton>
                )
              )}
            </>
          )}
        </span>
      </div>
      {expanded && (
        <Schedule
          channel={channel}
          now={now}
          words={words}
          match={match}
          onWatch={onWatch}
          onWatchArchive={onWatchArchive}
        />
      )}
    </div>
  );
}

/** A row of the list while its channels are being put in another order. */
interface RowOrder {
  /** Where the row stands, from 1, among `count`. */
  readonly position: number;
  readonly count: number;
  /** The part of this row that holds the focus; null on every other row. */
  readonly focus: TableOrder["focus"] | null;
  readonly locked: boolean;
  onSelect(): void;
  onFocused(part: RowPart): void;
  onMove(by: number, part: RowPart): void;
}

/**
 * Moves a row one place up or down, or to the top or bottom with Shift. At the end it can't pass
 * it stays in reach of Tab and the focus, dimmed, and does nothing.
 */
function MoveButton({ by, channel, order }: { by: -1 | 1; channel: LiveChannel; order: RowOrder }) {
  const part = by < 0 ? "up" : "down";
  const ended = by < 0 ? order.position === 1 : order.position === order.count;
  const off = ended || order.locked;
  const Icon = by < 0 ? ArrowUp : ArrowDown;
  return (
    <button
      data-move={part}
      aria-label={
        by < 0
          ? t("Move {name} up", { name: channel.title })
          : t("Move {name} down", { name: channel.title })
      }
      title={
        by < 0
          ? t("Move up, or to the top with Shift")
          : t("Move down, or to the bottom with Shift")
      }
      aria-disabled={off}
      tabIndex={order.focus ? 0 : -1}
      onMouseDown={(event) => event.preventDefault()}
      onFocus={() => order.onFocused(part)}
      onClick={(event) => {
        event.stopPropagation();
        if (off) return;
        // Pressed with a key, the button has the focus and keeps it; a click leaves it on the row.
        const held = document.activeElement === event.currentTarget ? part : "row";
        order.onMove(event.shiftKey ? by * Infinity : by, held);
      }}
      className={cn(
        "grid size-8 place-items-center rounded-full text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        off ? "opacity-35" : "hover:bg-white/10 hover:text-white",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/** `text` with what a search's `words` matched in it underlined. */
export function Marked({ text, words }: { text: string; words: readonly string[] }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [start, end] of matchRanges(text, words)) {
    parts.push(
      text.slice(at, start),
      <mark
        key={start}
        className="bg-transparent text-white underline decoration-white/60 underline-offset-[0.2em]"
      >
        {text.slice(start, end)}
      </mark>,
    );
    at = end;
  }
  return [...parts, text.slice(at)];
}

/**
 * The rest of the day. The programme on now plays; a later one shows its description. It opens
 * on the later programme a search found, with its description, and marks what the search found.
 *
 * Before them, the programmes of today that aired and the provider's catch-up keeps, at least the
 * last few early in the day, each playing from its start. Only those the guide still lists, and
 * none while a receiver has playback: catch-up plays on this computer.
 */
function Schedule({
  channel,
  now,
  words,
  match,
  onWatch,
  onWatchArchive,
}: {
  channel: LiveChannel;
  now: number;
  words: readonly string[];
  match: ListingMatch | null;
  onWatch: () => void;
  onWatchArchive: (programme: Programme) => void;
}) {
  // Today, with what aired for catch-up, and at least a few either side of now when the day has
  // fewer: the main process reads no more than that.
  const today = new Date(now).setHours(0, 0, 0, 0);
  const midnight = endOfDay(now);
  const schedule = useQuery(queries.schedule(channel, today, midnight));
  const remote = useOutput((state) => state.status.output.kind !== "local");
  const found = match?.later?.start ?? null;
  const [open, setOpen] = useState(found);
  const programmes = useMemo(() => {
    const all = schedule.data ?? [];
    const aired = remote
      ? []
      : all.filter(
          (programme) =>
            programme.stop <= now && archiveHolds(channel.catchupDays, programme.start, now),
        );
    return [
      ...aired.filter(
        (programme, index) =>
          programme.start >= today || index >= aired.length - GUIDE_SCHEDULE.atLeast,
      ),
      ...all
        .filter((programme) => programme.stop > now)
        .filter((programme, index) => programme.start < midnight || index < GUIDE_SCHEDULE.atLeast),
    ];
  }, [schedule.data, now, today, midnight, remote, channel.catchupDays]);
  return (
    <div className="rounded-b-lg bg-white/5 py-2 pr-4 pl-[17.5rem]">
      {programmes.map((programme) => (
        <ScheduleLine
          key={programme.start}
          programme={programme}
          now={now}
          open={open === programme.start}
          found={programme.start === found}
          words={
            programme.stop > now &&
            (programme.start <= now ? match?.now : programme.start === found)
              ? words
              : NONE
          }
          onClick={() =>
            programme.stop <= now
              ? onWatchArchive(programme)
              : programme.start <= now
                ? onWatch()
                : setOpen((current) => (current === programme.start ? null : programme.start))
          }
        />
      ))}
    </div>
  );
}

function ScheduleLine({
  programme,
  now,
  open,
  found,
  words,
  onClick,
}: {
  programme: Programme;
  now: number;
  open: boolean;
  /** The later programme a search found, which the day opens on. */
  found: boolean;
  /** The search's words when this programme matched them; none otherwise. */
  words: readonly string[];
  onClick: () => void;
}) {
  const aired = programme.stop <= now;
  const onNow = !aired && programme.start <= now;
  const line = useRef<HTMLButtonElement>(null);
  // The day opens on what's on now, below what aired before it, unless a search found later.
  useEffect(() => {
    if (found || onNow) line.current?.scrollIntoView({ block: "nearest" });
    // Only when it opens, not as the programme on now changes.
  }, [found]);
  return (
    <button
      ref={line}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex w-full gap-4 rounded-lg px-2 py-1.5 text-left hover:bg-white/8",
        found && "bg-white/6",
      )}
    >
      <span className="w-[6.5rem] flex-none text-sm text-muted-foreground tabular-nums">
        {aired
          ? pastTime(programme.start, now)
          : onNow
            ? timeLeft(programme, now)
            : clockTime(programme.start, now)}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block text-sm", onNow && "font-medium text-white")}>
          <Marked text={programme.title} words={words} />
        </span>
        {onNow && <Progress value={progressOf(programme, now)} className="mt-1 w-40" />}
        {(open || onNow) && programme.description && (
          <span className="mt-1 block text-[0.8125rem] leading-relaxed text-muted-foreground select-text">
            {programme.description}
          </span>
        )}
      </span>
    </button>
  );
}

function IconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className={cn(
        "grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-white",
        className,
      )}
    >
      {children}
    </button>
  );
}
