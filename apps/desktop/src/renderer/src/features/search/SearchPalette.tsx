import { useSearchUsage } from "../../app/analytics.ts";
import { Dialog } from "@base-ui/react/dialog";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, ChevronDown, Search, Star } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import type { ProgrammeMatch } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Title } from "@mrstreamer/contracts/ondemand";
import {
  automaticSearchCopy,
  searchResultGroups,
  type LiveSearchGroup,
} from "@mrstreamer/core/catalogue/search";
import { ownedId, ownedKey } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { openDetails, useUi } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { useNow } from "../../lib/clock.ts";
import { clockTime, timeLeft } from "../../lib/format.ts";
import {
  queries,
  useCategoryMap,
  useSearchSubscriptionNames,
  useSourceOf,
  useFavouriteKeys,
  useSubscriptions,
  useToggleFavourite,
} from "../../lib/queries.ts";
import { reminderAt, useReminders } from "../../lib/reminders.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { searchQualities } from "../live/search-rows.ts";
import { cn } from "../../lib/utils.ts";
import { titlePlayer } from "../../player/title-player.ts";
import { watchChannel } from "../live/GuidePage.tsx";
import { ReminderButton } from "../reminders/ReminderButton.tsx";

/**
 * Searches channel names across every category, then movies and series, then programmes on now
 * and later today. Opens with ⌘K or Ctrl K, on what Movies or Series searched for, if anything.
 * A programme to come opens to its description and Remind me; one with a reminder shows a bell.
 */
export function SearchPalette() {
  const open = useUi((state) => state.searchOpen);
  // What had the keyboard as search opened, as a control of the details that stay open under it,
  // gets it back as search closes. The search field takes the keyboard as it mounts, before Base
  // UI notes what had it, so it is noted here, as the store says search opens.
  const opener = useRef<Element | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  useEffect(
    () =>
      useUi.subscribe((state, previous) => {
        if (state.searchOpen && !previous.searchOpen) opener.current = document.activeElement;
      }),
    [],
  );
  const finalFocus = () => {
    // The keyboard went on elsewhere, as to details a result opened: it stays there.
    const focused = document.activeElement;
    if (focused && focused !== document.body && !popup.current?.contains(focused)) return false;
    const element = opener.current;
    return element instanceof HTMLElement && element !== document.body && element.isConnected
      ? element
      : true;
  };
  return (
    <Dialog.Root open={open} onOpenChange={(next) => useUi.setState({ searchOpen: next })}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/70 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          ref={popup}
          finalFocus={finalFocus}
          className="fixed top-[12vh] left-1/2 z-50 w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 overflow-hidden rounded-3xl bg-black text-white shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0"
        >
          <Dialog.Title className="sr-only">{t("Search")}</Dialog.Title>
          <Palette />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A search result: a channel, a movie or series, or a programme on the channel that shows it. */
type Result =
  | {
      readonly kind: "channel";
      readonly channel: LiveChannel;
      readonly group: LiveSearchGroup;
      readonly copy: boolean;
      readonly key: string;
    }
  | { readonly kind: "title"; readonly title: Title }
  | { readonly kind: "programme"; readonly match: ProgrammeMatch; readonly key: string };

/** Channel results listed before the rest. */
const CHANNEL_RESULTS = 20;
/** Movies, and then series, listed after the channels. */
const TITLE_RESULTS = 6;

function Palette() {
  const resultsId = useId();
  const visible = useUi((state) => state.searchOpen);
  // Mounted each time it opens.
  const [query, setQuery] = useState(() => useUi.getState().searchFrom);
  const client = useQueryClient();
  // Complete fresh answers need no typing delay. Other searches keep the existing debounce.
  const fresh =
    query.trim() !== "" &&
    [queries.search(query), queries.programmes(query), queries.titleSearch(query)].every(
      (options) => {
        const cached = client.getQueryCache().get(hashKey(options.queryKey));
        return (
          cached?.state.status === "success" &&
          cached.state.fetchStatus === "idle" &&
          typeof options.staleTime === "number" &&
          !cached.isStaleByTime(options.staleTime)
        );
      },
    );
  const searched = useDebounced(query, fresh ? 0 : 120);
  useSearchUsage("global", searched, true);
  // Share the Guide's catalogue read so the first name search builds during the typing delay.
  useQuery({ ...queries.searchGroups(), enabled: visible && query.trim() !== "" });
  const raw = useRef(query);
  const current = visible && query === searched && query.trim() !== "";
  const asked = current ? searched : "";
  const channels = useQuery({
    ...queries.search(asked),
    queryKey: current ? queries.search(asked).queryKey : ["library", "search", "paused", searched],
    placeholderData: (previous) => (current ? undefined : previous),
  });
  const programmes = useQuery({
    ...queries.programmes(asked),
    queryKey: current
      ? queries.programmes(asked).queryKey
      : ["guide", "search", "paused", searched],
    placeholderData: (previous) => (current ? undefined : previous),
  });
  const titles = useQuery({
    ...queries.titleSearch(asked),
    queryKey: current
      ? queries.titleSearch(asked).queryKey
      : ["ondemand", "search", "paused", searched],
    placeholderData: (previous) => (current ? undefined : previous),
  });
  const pending =
    !current ||
    channels.isFetching ||
    programmes.isFetching ||
    titles.isFetching ||
    channels.isPending ||
    programmes.isPending ||
    titles.isPending;
  const failed = channels.isError || programmes.isError || titles.isError;
  const categories = useCategoryMap();
  // Results come from every subscription: one says whose it is where another reads the same.
  const sourceOf = useSourceOf();
  const now = useNow();
  const favourites = useFavouriteKeys();
  const subscriptions = useSubscriptions();
  const reminders = useReminders().data;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const groups = useMemo(
    () => searchResultGroups(channels.data ?? []).slice(0, CHANNEL_RESULTS),
    [channels.data],
  );
  const [open, setOpen] = useState<string | null>(null);
  const [selected, select] = useState<string | null>(null);
  const results = useMemo((): Result[] => {
    if (!query.trim() || !searched.trim()) return [];
    return [
      ...groups.flatMap((group): Result[] => {
        const channel = group.copies[0]!;
        return [
          { kind: "channel", group, channel, copy: false, key: group.key },
          ...(expanded.has(group.key) && group.copies.length > 1
            ? group.copies.map((channel): Result => ({
                kind: "channel",
                group,
                channel,
                copy: true,
                key: `${group.key}/copy/${ownedKey(channel)}`,
              }))
            : []),
        ];
      }),
      ...[
        ...(titles.data?.movies ?? []).slice(0, TITLE_RESULTS),
        ...(titles.data?.series ?? []).slice(0, TITLE_RESULTS),
      ].map((title): Result => ({ kind: "title", title })),
      ...(programmes.data ?? []).map((match): Result => ({
        kind: "programme",
        match,
        key: `${ownedKey(match.channel)}:${match.programme.start}`,
      })),
    ];
  }, [query, searched, groups, expanded, titles.data, programmes.data]);

  const identity = (result: Result) =>
    result.kind === "title" ? `title/${result.title.key}` : `${result.kind}/${result.key}`;
  const kept = results.findIndex((result) => identity(result) === selected);
  const active = Math.max(kept, 0);
  const setActive = (index: number) => select(results[index] ? identity(results[index]!) : null);
  useLayoutEffect(() => {
    if (current && results[active]) select(identity(results[active]!));
  }, [current, results, active]);

  // Keep the highlighted result in view while moving through the list with the keyboard.
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  /** Group rows use Automatic; expanded copies keep their real subscription and quality choices. */
  const choose = (index: number) => {
    const result = results[index];
    if (!result || !current || raw.current !== searched || !useUi.getState().searchOpen) return;
    setActive(index);
    if (result.kind === "channel")
      watchChannel(
        result.copy ? result.channel : automaticSearchCopy(result.group, favourites, subscriptions),
      );
    else if (result.kind === "title") {
      // Details show over the page, so a title playing gives way first, saving how far it got.
      if (useUi.getState().playingTitle) {
        titlePlayer.close();
        useUi.setState({ playingTitle: false });
      }
      openDetails({ kind: result.title.kind, ...ownedId(result.title) });
    } else if (result.match.programme.start <= Date.now()) watchChannel(result.match.channel);
    else setOpen((current) => (current === result.key ? null : result.key));
  };

  function onKey(event: KeyboardEvent) {
    if (
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    )
      return;
    if (!current || raw.current !== searched) return;
    if (event.key === "Enter" && event.target instanceof HTMLButtonElement) return;
    if (event.key === "ArrowDown") setActive(Math.min(active + 1, results.length - 1));
    else if (event.key === "ArrowUp") setActive(Math.max(active - 1, 0));
    else if (event.key === "Enter") choose(active);
    else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const result = results[active];
      if (result?.kind !== "channel" || result.group.copies.length < 2) return;
      if (event.key === "ArrowRight" && !result.copy && !expanded.has(result.group.key))
        setExpanded((current) => new Set(current).add(result.group.key));
      else if (event.key === "ArrowLeft" && expanded.has(result.group.key)) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(result.group.key);
          return next;
        });
        setActive(
          results.findIndex((row) => row.kind === "channel" && row.key === result.group.key),
        );
      } else return;
    } else return;
    event.preventDefault();
  }

  return (
    <div onKeyDown={onKey}>
      <div className="flex items-center gap-3 border-b border-border px-5">
        <Search className="size-5 text-muted-foreground" />
        <input
          autoFocus
          role="combobox"
          aria-label={t("Search channels, movies, series and programmes")}
          aria-haspopup="tree"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? resultsId : undefined}
          aria-activedescendant={current && results[active] ? `${resultsId}-${active}` : undefined}
          value={query}
          onChange={(event) => {
            raw.current = event.target.value;
            select(null);
            setExpanded(new Set());
            setOpen(null);
            setQuery(event.target.value);
          }}
          placeholder={t("Search channels, movies, series and programmes")}
          spellCheck={false}
          className="h-16 flex-1 bg-transparent text-lg text-foreground outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      {searched.trim() && groups.length > 0 && (
        <div role="status" className="px-5 py-2 text-xs">
          {t("{count} channels", { count: groups.length })} ·{" "}
          {t("{count} streams", {
            count: groups.reduce((sum, group) => sum + group.streams, 0),
          })}
        </div>
      )}
      {results.length > 0 && (
        <div
          ref={list}
          inert={!current}
          aria-disabled={!current}
          onClickCapture={(event) => {
            if (current && raw.current === searched) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          id={resultsId}
          role="tree"
          aria-label={t("Search results")}
          className="max-h-[28rem] overflow-y-auto overscroll-contain p-2"
        >
          {results.map((result, index) => {
            if (result.kind === "title") {
              const { title } = result;
              return (
                <button
                  key={title.key}
                  id={`${resultsId}-${index}`}
                  role="treeitem"
                  aria-level={1}
                  aria-selected={index === active}
                  data-index={index}
                  onFocus={() => setActive(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => choose(index)}
                  className={cn(
                    "flex w-full items-center gap-3.5 rounded-2xl px-3 py-2 text-left hover:bg-white/6",
                    index === active && "bg-white/10 hover:bg-white/10",
                  )}
                >
                  <span className="block h-12 w-8 flex-none overflow-hidden rounded-md">
                    <Artwork
                      url={title.posterUrl}
                      name={title.title}
                      size="thumb"
                      className="text-[0.5rem]"
                    />
                  </span>
                  <span className="min-w-0 flex-1" title={title.name}>
                    <span className="block truncate text-[0.9375rem] text-foreground">
                      {title.title}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[
                        title.kind === "movie" ? t("Movie") : t("Series"),
                        title.year,
                        ...title.tags,
                        sourceOf(title),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </span>
                </button>
              );
            }
            if (result.kind === "programme") {
              const { channel, programme } = result.match;
              const source = sourceOf(channel);
              const shows = source ? `${channel.title} · ${source}` : channel.title;
              const later = programme.start > now;
              const detail = later
                ? `${clockTime(programme.start, now)} · ${shows}`
                : `${t("On now")} · ${shows} · ${timeLeft(programme, now)}`;
              const reminded = reminderAt(reminders, channel, programme.start) !== undefined;
              return (
                <div
                  key={result.key}
                  id={`${resultsId}-${index}`}
                  role="treeitem"
                  aria-level={1}
                  aria-selected={index === active}
                  aria-expanded={later ? open === result.key : undefined}
                  data-index={index}
                  onFocus={() => setActive(index)}
                  className={cn(
                    "rounded-2xl hover:bg-white/6",
                    index === active && "bg-white/10 hover:bg-white/10",
                  )}
                >
                  <button
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(index)}
                    className="flex w-full items-center gap-3.5 px-3 py-2.5 text-left"
                  >
                    <ChannelLogo channel={channel} className="h-8 w-12 self-start" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[0.9375rem] text-white">
                        {programme.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">{detail}</span>
                      {open === result.key && programme.description && (
                        <span className="mt-1.5 block text-[0.8125rem] leading-relaxed text-muted-foreground">
                          {programme.description}
                        </span>
                      )}
                    </span>
                    {reminded && (
                      <Bell
                        role="img"
                        aria-label={t("Reminder set")}
                        className="size-3.5 flex-none self-start text-muted-foreground"
                      />
                    )}
                  </button>
                  {open === result.key && later && (
                    <ReminderButton
                      key={result.key}
                      channel={channel}
                      start={programme.start}
                      className="pb-3 pl-[4.875rem]"
                    />
                  )}
                </div>
              );
            }
            const { channel, group, copy } = result;
            const [categoryId] = channel.categoryIds;
            const category = categoryId
              ? categories.get(ownedKey({ subscriptionId: channel.subscriptionId, id: categoryId }))
              : undefined;
            return (
              <LiveResultRow
                id={`${resultsId}-${index}`}
                key={result.key}
                channel={channel}
                group={group}
                copy={copy}
                index={index}
                active={active === index}
                expanded={expanded.has(group.key)}
                category={
                  category ? [category.group, category.title].filter(Boolean).join(" · ") : ""
                }
                onWatch={() => choose(index)}
                onSelect={() => setActive(index)}
                onToggle={() => {
                  const selectedRow = results[active];
                  if (
                    expanded.has(group.key) &&
                    selectedRow?.kind === "channel" &&
                    selectedRow.copy &&
                    selectedRow.group.key === group.key
                  )
                    setActive(index);
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  });
                }}
              />
            );
          })}
        </div>
      )}
      {query.trim() && (pending || failed) && (
        <div
          role="status"
          className="border-t border-border px-5 py-3 text-xs text-muted-foreground"
        >
          {(
            [
              [t("Channels"), channels],
              [t("Movies and series"), titles],
              [t("Guide"), programmes],
            ] as const
          )
            .flatMap(([label, source]) =>
              source.isError
                ? [`${label}: ${t("Service unavailable")}`]
                : !current || source.isPending || source.isFetching
                  ? [`${label}: ${t("Searching")}`]
                  : [],
            )
            .join(" · ")}
        </div>
      )}
      {current && results.length === 0 && !pending && !failed && (
        <div className="border-t border-border px-5 py-3 text-xs text-muted-foreground">
          {t("No matches")}
        </div>
      )}
    </div>
  );
}

function LiveResultRow({
  id,
  channel,
  group,
  copy,
  index,
  active,
  expanded,
  category,
  onWatch,
  onSelect,
  onToggle,
}: {
  id: string;
  channel: LiveChannel;
  group: LiveSearchGroup;
  copy: boolean;
  index: number;
  active: boolean;
  expanded: boolean;
  category: string;
  onWatch: () => void;
  onSelect: () => void;
  onToggle: () => void;
}) {
  const nameOf = useSearchSubscriptionNames();
  const favourites = useFavouriteKeys();
  const toggleFavourite = useToggleFavourite();
  const grouped = !copy && group.copies.length > 1;
  const subscriptionCount = new Set(group.copies.map((copy) => copy.subscriptionId)).size;
  const listing = useQuery({ ...queries.listings([channel]), enabled: copy });
  const guide = listing.data?.[ownedKey(channel)];
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={copy ? 2 : 1}
      aria-selected={active}
      aria-expanded={grouped ? expanded : undefined}
      onFocus={onSelect}
      data-index={index}
      className={cn("flex items-center hover:bg-white/6", copy && "ml-8", active && "bg-white/10")}
    >
      <button
        data-group-row={index}
        aria-label={[
          channel.title,
          category,
          grouped ? t("{count} subscriptions", { count: subscriptionCount }) : null,
          grouped ? t("{count} streams", { count: group.streams }) : null,
          grouped ? searchQualities(group.copies) : null,
          !grouped ? nameOf(channel.subscriptionId) : null,
          !grouped ? channel.number : null,
          !grouped ? searchQualities([channel]) : null,
        ]
          .filter((part) => part != null && part !== "")
          .join(", ")}
        aria-expanded={grouped ? expanded : undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onWatch}
        className="flex min-w-0 flex-1 items-center gap-3.5 px-3 py-2.5 text-left"
      >
        <ChannelLogo channel={channel} className="h-8 w-12 self-start" />
        <span className="min-w-0 flex-1" title={channel.name}>
          <span className="block truncate text-[0.9375rem] text-white">{channel.title}</span>
          <span className="block truncate text-xs">
            {grouped
              ? [
                  category,
                  t("{count} subscriptions", { count: subscriptionCount }),
                  t("{count} streams", { count: group.streams }),
                  searchQualities(group.copies),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : [
                  category,
                  nameOf(channel.subscriptionId),
                  channel.number,
                  searchQualities([channel]),
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(" · ")}
          </span>
          {copy && guide?.now ? (
            <span className="block truncate text-xs">
              {guide.now.title}
              {guide.next ? ` · ${t("Next {title}", { title: guide.next.title })}` : ""}
            </span>
          ) : null}
        </span>
      </button>
      {grouped ? (
        <button
          aria-label={expanded ? t("Hide copies") : t("Show copies")}
          aria-expanded={expanded}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onToggle}
          className="p-3"
        >
          <ChevronDown className={cn("size-4", !expanded && "-rotate-90")} />
        </button>
      ) : (
        <button
          aria-label={
            favourites.has(ownedKey(channel)) ? t("Remove from favourites") : t("Add to favourites")
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") event.stopPropagation();
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => toggleFavourite(channel)}
          className="p-3"
        >
          <Star className={cn("size-4", favourites.has(ownedKey(channel)) && "fill-current")} />
        </button>
      )}
    </div>
  );
}
