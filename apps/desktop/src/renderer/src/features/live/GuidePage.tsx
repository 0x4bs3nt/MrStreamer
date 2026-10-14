import { useSearchUsage } from "../../app/analytics.ts";
// Live TV: the lists on the left, the chosen list's channels with what's on now and next, and the
// current stream, muted, on top. A click on a channel opens Watch; Back returns here unchanged.
//   Guide beside Watch, or G, shows the same channels as a grid by time instead, and List, G or
// Escape goes back: see ./GuideGrid.tsx for its keys, which take the place of the list's. Which of
// the two shows is a preference, kept across restarts. A search shows one row per channel it
// found in the grid, its copies folded into the one Enter plays in the list.
//   Up and Down move the selection; PageUp, PageDown, Home and End jump. Enter watches. Right opens
//   the rest of the day and Left closes it; Left again moves to the lists and Right comes back.
//   The focus going into the lists, or into the grid, gives them the keys too.
//   A programme that aired, listed before it where the provider's catch-up keeps it, plays from
//   its start in Watch.
//   Search folds safe matches for display. Right opens their canonical copies; Left returns to
//   the group. Enter on a group uses a favourite copy, then saved subscription order.
//   Digits jump to a channel number, S stars, Escape goes Home. A button that has the focus takes
//   its own Enter and Space.
//   The field at the end of the list's title searches that list, by channel name and by the
// programmes on now and later today, and shows the channels it finds in the list's order. / goes
// to it; Down or Enter there hands the keys to the channels found. Escape clears a search before
// it goes Home, and so does another list. ⌘K searches everything for the same.
//   Reorder, beside the field of Favourites, or R, puts the favourites in another order: see
// ./reorder.ts for its keys, which replace these until the order is saved or cancelled.
//   The lists hold every saved subscription's channels. One that can't be reached keeps the
// channels it loaded, and a line under the title says so, with Retry.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Play, Search, Volume2, VolumeX, X } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { automaticSearchCopy } from "@mrstreamer/core/catalogue/search";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { LiveView } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { hasModifier, isMac, isTyping } from "../../app/platform.ts";
import { openView, openWatch, useUi } from "../../app/ui-store.ts";
import { CatalogueNotice, catalogueState } from "../../components/CatalogueNotice.tsx";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { useNow } from "../../lib/clock.ts";
import { describeError } from "../../lib/errors.ts";
import { clockTime, progressOf, timeLeft } from "../../lib/format.ts";
import { Message } from "../../lib/message.tsx";
import { call } from "../../lib/ipc.ts";
import { showSelection, useKeyboardMode } from "../../lib/input-mode.ts";
import {
  queries,
  subscriptionName,
  useCategoryMap,
  useFavouriteKeys,
  useSubscriptions,
  useToggleFavourite,
} from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";
import { usePreviewWaits } from "../../player/output.ts";
import { Picture } from "../../player/Picture.tsx";
import { player, usePlayer } from "../../player/player.ts";
import { numberEntry, NumberEntry } from "../watch/NumberEntry.tsx";
import { rowPlays, searchChannelRows } from "./search-rows.ts";
import { ChannelTable } from "./ChannelTable.tsx";
import { GuideGrid, type GridKeys } from "./GuideGrid.tsx";
import { ListPicker, listKey } from "./ListPicker.tsx";
import { listTitle, useListChannels, useListPicker, useListSearch, useShowList } from "./lists.ts";
import { orderKey, useFavouriteOrder, waits } from "./reorder.ts";

const PAGE_ROWS = 10;
const NO_CHANNELS: readonly LiveChannel[] = [];
/** The keys the grid takes while it has the keyboard. */
const GRID_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Enter",
]);

/** Plays a channel and opens Watch on it, on what already plays of it, a recording's too. */
export function watchChannel(channel: LiveChannel): void {
  player.watch(channel);
  openWatch();
}

/**
 * Plays a channel live and opens Watch on it, for a channel or programme the viewer picked to
 * watch live: a recording of it gives way to the channel live.
 */
function watchLive(channel: LiveChannel): void {
  player.watchLive(channel);
  openWatch();
}

export function GuidePage({ active }: { active: boolean }) {
  const list = useUi((state) => state.list);
  const [liveView, setLiveView] = useLiveView();
  const grid = useRef<GridKeys>(null);
  const categories = useQuery(queries.categories());
  const categoryMap = useCategoryMap();
  const { channels: listed, error } = useListChannels(list);
  const channels = listed ?? NO_CHANNELS;
  const playingKey = usePlayer((state) => (state.channel ? ownedKey(state.channel) : null));
  const favourites = useFavouriteKeys();
  const subscriptions = useSubscriptions();
  const toggleFavourite = useToggleFavourite();
  const showList = useShowList();
  const keyboard = useKeyboardMode();

  const picker = useListPicker(list);
  const { entries, entry, setEntry, openGroup: toggle } = picker;
  const [focus, setFocus] = useState<"lists" | "channels">("channels");
  /** The channel whose schedule is open, by its `ownedKey`. */
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const previousSchedule = useRef<string | null>(null);
  useEffect(() => {
    const shown = expandedKey;
    if (active && shown && shown !== previousSchedule.current)
      void call("analytics.action", "epg_opened").catch(() => {});
    previousSchedule.current = shown;
  }, [active, expandedKey]);

  const lastCategoryTitle = useRef<string>("");
  if (list.kind === "category" && categoryMap.has(ownedKey(list.category)))
    lastCategoryTitle.current = listTitle(list, categoryMap);
  const [removedCategory, setRemovedCategory] = useState<string | null>(null);

  // A remembered category can disappear after a refresh or with its subscription. One that
  // shows with another subscription's under one name is the list that holds them both.
  useEffect(() => {
    if (list.kind !== "category" || !categories.data) {
      if (list.kind !== "all") setRemovedCategory(null);
      return;
    }
    const shown = categoryMap.get(ownedKey(list.category));
    if (!shown) {
      setRemovedCategory(lastCategoryTitle.current || t("Current category"));
      showList({ kind: "all" });
    } else if (!sameOwned(shown, list.category)) {
      useUi.setState({ list: { kind: "category", category: ownedId(shown) } });
    }
    if (shown) setRemovedCategory(null);
  }, [list, categories.data, categoryMap, showList]);

  // What the field holds belongs to the list it was typed in: another list starts without a
  // search, unless the search itself moved there.
  const key = listKey(list);
  const [typed, setTyped] = useState({ key, text: "" });
  if (typed.key !== key) setTyped({ key, text: "" });
  const text = typed.key === key ? typed.text : "";
  const setText = (text: string) => setTyped({ key, text });
  const search = useListSearch(list, channels, text);
  const searching = search.query !== "";
  useSearchUsage("live", search.query, active);
  const field = useRef<HTMLInputElement>(null);

  const ordered = list.kind === "favourites";
  const order = useFavouriteOrder(active && ordered, ordered ? listed : undefined);
  const { draft } = order;
  // The rows are the list's, or what a search found of them, or the favourites as arranged.
  const [searchFocus, setSearchFocus] = useState(0);
  const [expandedCopies, setExpandedCopies] = useState<ReadonlySet<string>>(new Set());
  const searchRows = useMemo(
    () => (search.groups ? searchChannelRows(search.groups, expandedCopies, search.matches) : null),
    [search.groups, expandedCopies, search.matches],
  );
  const rows = useMemo(
    () => draft?.order ?? searchRows?.map((row) => row.channel) ?? search.channels,
    [draft?.order, searchRows, search.channels],
  );
  // The grid's rows: what a search found, each channel once, as the copy Enter plays in the list.
  const gridRows = useMemo(
    () =>
      search.groups?.map((group) => automaticSearchCopy(group, favourites, subscriptions)) ??
      search.channels,
    [search.groups, search.channels, favourites, subscriptions],
  );
  const toggleCopies = (key: string) => {
    const index = searchRows?.findIndex((row) => row.group.key === key && !row.copy) ?? -1;
    if (index >= 0) setChosen({ index, channel: rows[index] ?? null, searchKey: key });
    if (
      expandedCopies.has(key) &&
      searchRows?.[index]?.group.copies.some((copy) => ownedKey(copy) === expandedKey)
    )
      setExpandedKey(null);
    setExpandedCopies((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const playRow = (index: number) => {
    const row = searchRows?.[index];
    const channel =
      row && !row.copy ? automaticSearchCopy(row.group, favourites, subscriptions) : rows[index];
    if (channel) watchLive(channel);
  };
  // Reorder was asked for while a search hides favourites, which it never clears by itself.
  const [refused, setRefused] = useState(false);
  if (refused && (text.trim() === "" || !ordered)) setRefused(false);

  // The selection keeps to its channel when the rows change under it, as a search's do while
  // programmes begin and end, and stays among the rows once its channel has gone.
  const [chosen, setChosen] = useState<{
    index: number;
    channel: OwnedId | null;
    searchKey?: string | undefined;
  }>({
    index: 0,
    channel: null,
  });
  const byKey =
    searchRows && chosen.searchKey
      ? searchRows.findIndex((row) => row.key === chosen.searchKey)
      : -1;
  const kept =
    byKey !== -1
      ? byKey
      : chosen.channel === null || sameOwned(rows[chosen.index], chosen.channel)
        ? chosen.index
        : rows.findIndex((channel) => sameOwned(channel, chosen.channel));
  const selected = draft
    ? Math.max(
        rows.findIndex((channel) => sameOwned(channel, draft.focus.channel)),
        0,
      )
    : Math.min(kept === -1 ? chosen.index : kept, Math.max(rows.length - 1, 0));

  const page = useRef<HTMLDivElement>(null);
  const reorderButton = useRef<HTMLButtonElement>(null);
  /** Where the focus was when ordering began, to put it back: on Reorder, or nowhere in the page. */
  const entered = useRef<"button" | "page" | null>(null);
  const begin = () => {
    numberEntry.cancel();
    setExpandedKey(null);
    setFocus("channels");
    entered.current = document.activeElement === reorderButton.current ? "button" : "page";
    order.start(rows[selected] ?? null);
  };
  /** Starts ordering the favourites, or asks for a search to be cleared first. */
  const reorder = () => {
    if (!order.available || draft || liveView === "grid") return;
    if (text.trim() !== "") setRefused(true);
    else begin();
  };
  // Once the order is saved or cancelled, the selection is the channel that had the keys, and
  // the focus is back where it was before.
  const moved = draft?.focus.channel ?? null;
  const movedKey = moved && ownedKey(moved);
  const left = useRef(moved);
  useLayoutEffect(() => {
    if (moved !== null) {
      left.current = moved;
      return;
    }
    const from = entered.current;
    entered.current = null;
    if (from === null) return;
    const channel = left.current;
    setChosen((current) => ({ ...current, channel }));
    const focused = document.activeElement;
    if (from === "button") reorderButton.current?.focus();
    else if (focused instanceof HTMLElement && page.current?.contains(focused)) focused.blur();
  }, [movedKey]);

  /** Shows the grid instead of the list, or the list again; not while favourites are ordered. */
  const toggleView = () => {
    if (draft) return;
    setLiveView(liveView === "grid" ? "list" : "grid");
  };

  // A new list, or another search of it, selects its playing channel, or its first.
  const loaded = listed !== undefined;
  useEffect(() => {
    const playing = player.current();
    const index = Math.max(
      rows.findIndex((channel, at) =>
        rowPlays(channel, searchRows?.[at], playing ? ownedKey(playing) : null),
      ),
      0,
    );
    setChosen({ index, channel: rows[index] ?? null });
    setExpandedKey(null);
    setExpandedCopies(new Set());
  }, [key, loaded, search.query]);

  // ⌘K and the search button search everything for what this list is searched for.
  useEffect(() => {
    if (!active) return;
    useUi.setState({ searchFrom: text.trim() });
    return () => useUi.setState({ searchFrom: "" });
  }, [active, text]);

  // The key handler reads the latest render through a ref. Registering it again on every render
  // would drop keys: a state change from another keydown listener renders between listeners.
  const state = useRef({
    picker,
    focus,
    selected,
    entry,
    expandedKey,
    rows,
    entries,
    text,
    setText,
    toggle,
    toggleFavourite,
    showList,
    order,
    reorder,
    searchRows,
    expandedCopies,
    toggleCopies,
    playRow,
    liveView,
    toggleView,
  });
  state.current = {
    picker,
    focus,
    selected,
    entry,
    expandedKey,
    rows,
    entries,
    text,
    setText,
    toggle,
    toggleFavourite,
    showList,
    order,
    reorder,
    searchRows,
    expandedCopies,
    toggleCopies,
    playRow,
    liveView,
    toggleView,
  };

  useEffect(() => {
    if (!active) return;
    function onKey(event: KeyboardEvent) {
      const ui = useUi.getState();
      if (event.defaultPrevented || isTyping(event) || hasModifier(event) || event.isComposing)
        return;
      if (
        ui.searchOpen ||
        ui.settings ||
        ui.updateDialog ||
        ui.watching ||
        ui.playingTitle ||
        ui.details ||
        ui.view !== "live"
      )
        return;
      const now = state.current;
      // An order being made has the keys to itself: nothing plays, stars or opens meanwhile.
      if (now.order.draft) return orderKey(event, now.order);
      const { toggle, toggleFavourite, showList } = now;
      const channel = now.rows[now.selected];
      const step = (value: number, delta: number, length: number) =>
        Math.min(Math.max(value + delta, 0), Math.max(length - 1, 0));
      const select = (index: number) => {
        setChosen({
          index,
          channel: now.rows[index] ?? null,
          searchKey: now.searchRows?.[index]?.key,
        });
        setSearchFocus((asked) => asked + 1);
      };

      // A button that has the focus, as Tab gives it, takes its own Enter and Space, unless they
      // end a typed channel number.
      if (
        (event.key === "Enter" || event.key === " ") &&
        !numberEntry.active() &&
        event.target instanceof Element &&
        event.target.closest("button, a[href], select")
      )
        return;
      if (/^[0-9]$/.test(event.key)) {
        numberEntry.type(event.key);
        event.preventDefault();
        return;
      }
      // The grid has the keys that move and watch while it shows; a typed number is still the
      // page's to commit.
      if (now.liveView === "grid" && now.focus === "channels" && GRID_KEYS.has(event.key)) {
        const done =
          event.key === "Enter" && (event.repeat || numberEntry.commit())
            ? "handled"
            : (grid.current?.key(event.key) ?? "ignored");
        if (done === "lists") {
          setFocus("lists");
          const focused = document.activeElement;
          if (focused instanceof HTMLElement && page.current?.contains(focused)) focused.blur();
        }
        if (done !== "ignored") {
          event.preventDefault();
          return;
        }
      }
      switch (event.key) {
        case "ArrowUp":
        case "ArrowDown":
        case "PageUp":
        case "PageDown": {
          const direction = event.key === "ArrowDown" || event.key === "PageDown" ? 1 : -1;
          const distance = event.key.startsWith("Page") ? PAGE_ROWS : 1;
          if (now.focus === "channels") {
            select(step(now.selected, direction * distance, now.rows.length));
          } else setEntry(step(now.entry, direction * distance, now.entries.length));
          break;
        }
        case "Home":
        case "End": {
          const last = event.key === "End";
          if (now.focus === "channels") select(last ? Math.max(now.rows.length - 1, 0) : 0);
          else setEntry(last ? Math.max(now.entries.length - 1, 0) : 0);
          break;
        }
        case "Enter": {
          if (event.repeat) break;
          if (numberEntry.commit()) break;
          if (now.focus === "channels") {
            if (channel) now.playRow(now.selected);
          } else {
            const picked = now.entries[now.entry];
            if (picked?.kind === "group") toggle(picked.group);
            else if (picked) {
              showList(picked.list);
              setFocus("channels");
            }
          }
          break;
        }
        case "ArrowRight":
          setSearchFocus((asked) => asked + 1);
          if (now.focus === "lists") setFocus("channels");
          else if (
            now.searchRows?.[now.selected] &&
            !now.searchRows[now.selected]!.copy &&
            now.searchRows[now.selected]!.group.copies.length > 1
          ) {
            const row = now.searchRows[now.selected]!;
            if (!now.expandedCopies.has(row.group.key)) now.toggleCopies(row.group.key);
          } else if (channel) setExpandedKey(ownedKey(channel));
          break;
        case "ArrowLeft": {
          const row = now.searchRows?.[now.selected];
          if (now.focus === "channels" && channel && now.expandedKey === ownedKey(channel)) {
            setExpandedKey(null);
          } else if (now.focus === "channels" && row && now.expandedCopies.has(row.group.key)) {
            now.toggleCopies(row.group.key);
            select(
              now.searchRows!.findIndex(
                (candidate) => candidate.group.key === row.group.key && !candidate.copy,
              ),
            );
          } else if (now.focus === "channels") {
            setFocus("lists");
            const focused = document.activeElement;
            if (focused instanceof HTMLElement && page.current?.contains(focused)) focused.blur();
          } else now.picker.back();
          break;
        }
        case "Backspace":
          if (numberEntry.active()) numberEntry.cancel();
          else if (now.focus === "lists") now.picker.back();
          break;
        case "Escape":
          if (numberEntry.active()) numberEntry.cancel();
          else if (now.text !== "") now.setText("");
          else if (now.liveView === "grid") now.toggleView();
          else openView("home");
          break;
        case "/":
          // No field shows for a list without channels.
          if (!field.current) return;
          field.current.focus();
          field.current.select();
          break;
        case "s":
        case "S": {
          if (now.liveView === "grid") {
            const shown = grid.current?.channel();
            if (shown) toggleFavourite(shown);
            break;
          }
          const row = now.searchRows?.[now.selected];
          if (channel && (!row || row.copy || row.group.copies.length === 1))
            toggleFavourite(channel);
          break;
        }
        case "g":
        case "G":
          now.toggleView();
          break;
        case "r":
        case "R":
          now.reorder();
          break;
        default:
          return;
      }
      event.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const notice = catalogueState({ data: categories.data, error: categories.error ?? error });
  const title = listTitle(list, categoryMap);
  const waiting = waits(draft);
  /** The order was refused: its favourites changed, and are read again when the viewer says so. */
  const changed = draft?.status === "changed" || draft?.status === "reading";
  const viewSwitch = (
    <Button
      title={liveView === "grid" ? t("List (G)") : t("Guide (G)")}
      disabled={draft !== null}
      onClick={toggleView}
    >
      {liveView === "grid" ? t("List") : t("Guide")}
    </Button>
  );
  return (
    // Until an order being saved is answered, the page takes no input: nothing leaves it.
    <div ref={page} className="flex h-full flex-col" inert={waiting ? true : undefined}>
      <WindowBar className="bg-black" />
      {notice ? (
        <div className="flex flex-1 items-center justify-center pb-14">
          <CatalogueNotice state={notice} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <ListPicker
            picker={picker}
            notice={
              removedCategory
                ? t("{name} is no longer listed. Showing all channels.", { name: removedCategory })
                : null
            }
            selected={list}
            onChannels={() => setFocus("channels")}
            onFocus={() => setFocus("lists")}
            highlight={keyboard && focus === "lists" ? entry : null}
            onPick={(picked) => {
              setRemovedCategory(null);
              showList(picked);
              setFocus("channels");
            }}
            className="w-[16rem] flex-none border-r border-border px-3 pt-3 pb-6"
          />
          <main className="flex min-w-0 flex-1 flex-col">
            {/* The switch sits beside Watch, or at the end of the title while nothing plays. */}
            <NowStrip active={active} viewSwitch={viewSwitch} />
            <div className="flex h-14 flex-none items-center gap-3 px-9 pt-2 pb-3">
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{title}</h1>
              {draft ? (
                <>
                  <span
                    className={cn(
                      "min-w-0 truncate text-[0.8125rem]",
                      draft.status === "failed" || changed
                        ? "text-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {draft.status === "failed"
                      ? t("Couldn't save the order.")
                      : changed
                        ? t("Your favourites changed.")
                        : isMac
                          ? t("Option with Up or Down moves the selected row")
                          : t("Alt with Up or Down moves the selected row")}
                  </span>
                  <div className="ml-auto flex flex-none items-center gap-2">
                    <Button onClick={order.cancel} disabled={waiting}>
                      {t("Cancel")}
                    </Button>
                    <Button variant="primary" onClick={order.confirm} disabled={waiting}>
                      {draft.status === "failed" ? t("Retry") : changed ? t("Reload") : t("Save")}
                    </Button>
                  </div>
                  <span role="status" className="sr-only">
                    {draft.said}
                  </span>
                </>
              ) : (
                <>
                  {searching && listed && (
                    <span role="status" className="flex-none text-sm text-white tabular-nums">
                      {t("{count} channels", { count: search.groups?.length ?? 0 })} ·{" "}
                      {t("{count} streams", {
                        count: search.groups?.reduce((sum, group) => sum + group.streams, 0) ?? 0,
                      })}
                    </span>
                  )}
                  <div className="ml-auto flex flex-none items-center gap-2">
                    {playingKey === null && viewSwitch}
                    {order.available && liveView === "list" && (
                      <Button
                        ref={reorderButton}
                        variant="ghost"
                        size="sm"
                        title={t("Reorder (R)")}
                        onClick={reorder}
                      >
                        {t("Reorder")}
                      </Button>
                    )}
                    {channels.length > 0 && (
                      <SearchField
                        field={field}
                        list={title}
                        value={text}
                        onChange={setText}
                        onLeave={() => {
                          setFocus("channels");
                          showSelection();
                          setSearchFocus((asked) => asked + 1);
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
            <SourceNotices />
            {refused && (
              <p className="px-9 pb-2.5 text-sm text-muted-foreground">
                {t("Clear the search to reorder.")}
                {/* The field's own button clears a search too, and leaves it at that. */}
                <button
                  aria-label={t("Clear search and reorder")}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setText("");
                    begin();
                  }}
                  className="ml-3 text-white underline underline-offset-4"
                >
                  {t("Clear search")}
                </button>
              </p>
            )}
            {listed && listed.length === 0 ? (
              <p className="px-9 text-sm text-muted-foreground">
                {list.kind === "favourites" ? t("No favourites yet.") : t("No channels.")}
              </p>
            ) : listed && searching && rows.length === 0 ? (
              <NothingFound
                list={title}
                query={search.query}
                onSearchAll={
                  list.kind === "all"
                    ? null
                    : () => {
                        // The search moves to every channel with what it holds.
                        setTyped({ key: listKey({ kind: "all" }), text });
                        showList({ kind: "all" });
                      }
                }
              />
            ) : liveView === "grid" ? (
              listed && (
                <GuideGrid
                  key={`${key}\n${search.query}`}
                  ref={grid}
                  channels={gridRows}
                  playingKey={playingKey}
                  showCursor={keyboard && focus === "channels"}
                  onWatch={watchLive}
                  onKeys={() => setFocus("channels")}
                  onPlayArchive={(channel, programme) => {
                    player.playArchive(channel, programme);
                    openWatch();
                  }}
                />
              )
            ) : (
              <ChannelTable
                categories={categoryMap}
                key={`${key}\n${search.query}`}
                channels={rows}
                searchRows={searchRows}
                searchFocus={searchFocus}
                expandedCopies={expandedCopies}
                onToggleCopies={toggleCopies}
                onSelectSearch={(index) =>
                  setChosen({
                    index,
                    channel: rows[index] ?? null,
                    searchKey: searchRows?.[index]?.key,
                  })
                }
                selected={draft || (keyboard && focus === "channels") ? selected : null}
                playingKey={playingKey}
                expandedKey={expandedKey}
                favourites={favourites}
                words={search.words}
                matches={search.matches}
                order={
                  draft && {
                    saved: draft.listed,
                    focus: draft.focus,
                    locked: waiting || changed,
                    onSelect: order.select,
                    onFocused: order.focused,
                    onMove: order.move,
                  }
                }
                onWatch={(channel, index) => {
                  setChosen({ index, channel, searchKey: searchRows?.[index]?.key });
                  playRow(index);
                }}
                onWatchArchive={(channel, index, programme) => {
                  setChosen({ index, channel, searchKey: searchRows?.[index]?.key });
                  player.playArchive(channel, programme);
                  openWatch();
                }}
                onToggleSchedule={(key) =>
                  setExpandedKey((current) => (current === key ? null : key))
                }
                onToggleFavourite={toggleFavourite}
              />
            )}
          </main>
        </div>
      )}
      {active && <NumberEntry onChannel={watchLive} />}
    </div>
  );
}

/**
 * One line for each subscription whose channels couldn't be fetched, with Retry: its channels
 * show as it listed them last, among the others'. Only beside other subscriptions: a single one
 * says so in Settings, as it always did. A subscription that needs its password or link again
 * says that where it is played, and in Settings.
 */
function SourceNotices() {
  const subscriptions = useSubscriptions();
  const statuses = useQuery(queries.libraryStatus()).data;
  const now = useNow();
  const failing = (subscriptions.length > 1 ? (statuses ?? []) : []).flatMap((status) => {
    const subscription = subscriptions.find((each) => each.id === status.subscriptionId);
    const { failure } = status;
    return subscription && failure && !subscription.needsSecret
      ? [{ ...status, failure, name: subscriptionName(subscription) }]
      : [];
  });
  return (
    <div aria-live="polite">
      {failing.map(({ subscriptionId, name, failure, failedAt, fetchedAt }) => (
        <p key={subscriptionId} className="flex items-baseline gap-4 px-9 pb-2.5 text-sm">
          <span className="min-w-0 text-foreground/85">
            {failure.kind === "unreachable" && failedAt !== null
              ? t("{host} hasn't answered since {time}.", {
                  host: name,
                  time: clockTime(failedAt, now),
                })
              : `${name}: ${describeError(failure)}`}
            {fetchedAt !== null && ` ${t("Its channels show as they were then.")}`}
          </span>
          <button
            aria-label={t("Retry {name}", { name })}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void call("library.refresh", { subscriptionId }).catch(() => {})}
            className="flex-none text-white underline underline-offset-4"
          >
            {t("Retry")}
          </button>
        </p>
      ))}
    </div>
  );
}

/**
 * The field at the end of the list's title, which searches that list. Down or Enter hands the
 * keys to the channels found; Escape clears it and does the same.
 */
function SearchField({
  field,
  list,
  value,
  onChange,
  onLeave,
}: {
  field: RefObject<HTMLInputElement | null>;
  /** The list's name, which the field says it searches. */
  list: string;
  value: string;
  onChange: (text: string) => void;
  onLeave: () => void;
}) {
  return (
    <label className="group flex h-9 w-[17rem] flex-none items-center gap-2 rounded-full bg-white/8 px-3.5 focus-within:bg-white/12">
      <Search className="size-4 flex-none text-muted-foreground" />
      <input
        ref={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter that ends a composition, as for Japanese, is the text's.
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") onChange("");
          else if (event.key !== "ArrowDown" && event.key !== "Enter") return;
          event.currentTarget.blur();
          onLeave();
          event.preventDefault();
        }}
        placeholder={t("Search {list}", { list })}
        aria-label={t("Search {list}", { list })}
        spellCheck={false}
        className="min-w-0 flex-1 truncate bg-transparent text-[0.875rem] text-foreground outline-none placeholder:text-muted-foreground"
      />
      {value ? (
        <button
          aria-label={t("Clear search")}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onChange("")}
          className="-mr-1 grid size-6 flex-none place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-white"
        >
          <X className="size-3.5" />
        </button>
      ) : (
        <kbd className="flex-none rounded border border-white/15 px-1.5 font-sans text-xs leading-5 text-muted-foreground group-focus-within:hidden">
          /
        </kbd>
      )}
    </label>
  );
}

/** A search found nothing in its list: the same search in every channel, or in everything. */
function NothingFound({
  list,
  query,
  onSearchAll,
}: {
  list: string;
  query: string;
  /** Null in the list of every channel, which has no wider one. */
  onSearchAll: (() => void) | null;
}) {
  const link = "text-white underline-offset-4 hover:underline";
  return (
    <div className="px-9 text-sm text-muted-foreground">
      <p>
        <Message
          text="Nothing in {list} for {query}."
          values={{ list, query: <b className="font-semibold text-white">{query}</b> }}
        />
      </p>
      <p className="mt-3 flex gap-5">
        {onSearchAll && (
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onSearchAll}
            className={link}
          >
            {t("Search all channels")}
          </button>
        )}
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useUi.setState({ searchOpen: true })}
          className={link}
        >
          {t("Search everything")} {isMac ? "⌘K" : "Ctrl K"}
        </button>
      </p>
    </div>
  );
}

/**
 * The stream that plays, muted, with what it shows and a way back to it, then `viewSwitch`, from
 * the list to the grid and back. While a receiver on the network is connected, the channel stands
 * still and a line says why.
 */
function NowStrip({ active, viewSwitch }: { active: boolean; viewSwitch: ReactNode }) {
  const channel = usePlayer((state) => state.channel);
  const audible = usePlayer((state) => state.audible && !state.muted);
  const waits = usePreviewWaits();
  const listing = useQuery(queries.listings(channel ? [channel] : [])).data?.[
    channel ? ownedKey(channel) : ""
  ];
  const now = useNow();
  if (!channel) return null;
  const current = listing?.now ?? null;
  return (
    <section className="flex items-end gap-6 px-9 pt-5 pb-4">
      <div className="relative aspect-video w-[18rem] flex-none overflow-hidden rounded-xl bg-white/5">
        <div className="absolute inset-0 grid place-items-center">
          <ChannelLogo channel={channel} className="h-12 w-20" />
        </div>
        <Picture
          active={active && !waits}
          fit="cover"
          className="absolute inset-0"
          onClick={() => watchChannel(channel)}
        />
      </div>
      <div className="min-w-0 pb-1">
        <div className="truncate text-2xl font-semibold tracking-tight">
          {current?.title ?? channel.title}
        </div>
        <div className="mt-1 truncate text-sm text-muted-foreground">
          {current ? `${channel.title} · ${timeLeft(current, now)}` : channel.tags.join(" · ")}
        </div>
        {current && <Progress value={progressOf(current, now)} className="mt-2 w-48" />}
        <div className="mt-4 flex items-center gap-2">
          <Button variant="primary" onClick={() => watchChannel(channel)}>
            <Play className="fill-current" />
            {t("Watch")}
          </Button>
          {waits ? (
            <span className="ml-1 text-sm text-muted-foreground">{waits}</span>
          ) : (
            <Button
              variant="secondary"
              size="icon"
              aria-label={audible ? t("Mute") : t("Unmute")}
              onClick={() => player.toggleMute()}
            >
              {audible ? <Volume2 /> : <VolumeX />}
            </Button>
          )}
          {viewSwitch}
        </div>
      </div>
    </section>
  );
}

/**
 * How Live TV shows its lists, the list or the grid, as the preferences keep it, and a way to
 * change it: at once on screen, then saved. The list until the preferences are read.
 */
function useLiveView(): [LiveView, (view: LiveView) => void] {
  const client = useQueryClient();
  const view = useQuery(queries.preferences()).data?.liveView ?? "list";
  const set = (liveView: LiveView) => {
    const key = queries.preferences().queryKey;
    client.setQueryData(key, (saved) => saved && { ...saved, liveView });
    void call("preferences.update", { liveView })
      .then((saved) => client.setQueryData(key, saved))
      .catch(() => {});
  };
  return [view, set];
}
