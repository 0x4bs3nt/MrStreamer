// The sheet that maps a subscription's channels to its guides' by hand, over Settings >
// Subscriptions. On the left, the subscription's channels: those without programmes, those
// mapped by hand, or all, searched by name or number. On the right, for the channel picked
// there, the channels its guides list, its own guide's and then each source's of Settings >
// Guides, searched by name or id, each with both and a source's host: nothing is ever matched by
// name, so the viewer picks the exact guide channel of the exact guide. Map takes effect at
// once, in every list, whatever the order of the guides; Automatic takes a mapping away again,
// and the channel goes back to the first guide channel its own guide ids name, or to none.
//   Both lists are drawn only where in view and read a page at a time. Once a channel is mapped
// the channels are read again, since a mapping changes which of them a filter shows and so where
// every page begins: among those without programmes the next one moves up to where the keyboard
// is. The arrow keys move through either list; Enter goes from a channel to its guide channels,
// and maps there.
import { Dialog } from "@base-ui/react/dialog";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Search } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  GuideChannel,
  GuideChannelRef,
  GuideStatus,
  MapChannel,
  MapFilter,
} from "@mrstreamer/contracts/guide";
import type { SubscriptionSummary } from "@mrstreamer/contracts/subscription";
import { searchWords } from "@mrstreamer/core/text";
import { formatNumber, type PlainKey, t } from "@mrstreamer/core/i18n";
import { Sheet } from "../../components/Sheet.tsx";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { hostOf } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { queries, subscriptionName } from "../../lib/queries.ts";
import { useDebounced } from "../../lib/use-debounced.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";
import { Marked } from "../live/ChannelTable.tsx";
import { PAGE, usePages } from "../titles/CollectionGrid.tsx";
import { Select } from "./Rows.tsx";

const ROW_REM = 2.5;
/** A search waits this long for typing to pause, as the other lists' do. */
const SEARCH_DELAY_MS = 120;

const FILTERS = [
  { value: "without", label: "Without programmes" },
  { value: "mapped", label: "Mapped by hand" },
  { value: "all", label: "All" },
] as const satisfies readonly { readonly value: MapFilter; readonly label: PlainKey }[];

export function GuideMap({
  subscription,
  guide,
  onClose,
}: {
  subscription: SubscriptionSummary;
  guide: GuideStatus;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const subscriptionId = subscription.id;
  const [filter, setFilter] = useState<MapFilter>("without");
  const [text, setText] = useState("");
  const query = useDebounced(text.trim(), SEARCH_DELAY_MS);
  const listKey = `${subscriptionId}:${filter}:${query}`;
  const { pages, load } = usePages(listKey);
  const loaded = useQueries({
    queries: pages.map((page) =>
      queries.mapChannels(subscriptionId, filter, query, page * PAGE, PAGE),
    ),
  });
  const byPage = new Map(pages.map((page, index) => [page, loaded[index]?.data]));
  const first = byPage.get(0);
  const total = first?.total ?? 0;
  const channelAt = (index: number) => byPage.get(Math.floor(index / PAGE))?.channels[index % PAGE];
  /**
   * Where the keyboard is in the list, which is the channel being mapped: back at the top of
   * another list, and on the last channel once those after it left this one.
   */
  const [at, setAt] = useState({ list: listKey, index: 0 });
  const index = at.list === listKey ? Math.max(0, Math.min(at.index, total - 1)) : 0;
  const picked = channelAt(index);
  const channelList = useRef<HTMLDivElement>(null);
  const optionField = useRef<HTMLInputElement>(null);
  const failed = loaded.find((each) => each.error)?.error;

  const without = Math.max(0, guide.listed - guide.channels);
  return (
    <Sheet onClose={onClose} overSettings initialFocus={channelList}>
      <div className="flex h-full flex-col px-8 pt-7 pb-6">
        <Dialog.Title className="text-2xl font-semibold tracking-tight">
          {t("Map channels")}
        </Dialog.Title>
        <p className="mt-1 text-[0.9375rem] text-muted-foreground">
          {[
            subscriptionName(subscription),
            t("{count} channels without programmes", { count: without }),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        <div className="mt-4 grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-x-8 gap-y-4 md:grid-cols-2 md:grid-rows-1">
          <section className="flex min-h-0 min-w-0 flex-col">
            <div className="mb-2 flex min-h-9 items-center gap-3 text-[0.9375rem]">
              <h3 className="min-w-0 flex-1 truncate font-semibold">
                {t("Channels")}
                {first && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {formatNumber(first.total)}
                  </span>
                )}
              </h3>
              <Select
                label={t("Channels shown")}
                value={filter}
                options={FILTERS.map((each) => ({ value: each.value, label: t(each.label) }))}
                onChange={setFilter}
              />
            </div>
            <SearchField
              label={t("Search channels")}
              value={text}
              onChange={setText}
              onDown={() => channelList.current?.focus()}
            />
            {failed ? (
              <p role="alert" className="text-sm text-destructive">
                {describeError(appError(failed))}
              </p>
            ) : first?.total === 0 ? (
              <p className="text-[0.9375rem] text-muted-foreground">
                {query
                  ? t("No channel matches.")
                  : filter === "without"
                    ? t("Every channel has programmes.")
                    : filter === "mapped"
                      ? t("No channel is mapped by hand.")
                      : t("No channels.")}
              </p>
            ) : (
              <Options
                key={listKey}
                box={channelList}
                label={t("Channels")}
                total={total}
                active={index}
                onActive={(next) => setAt({ list: listKey, index: next })}
                onVisible={load}
                onEnter={() => optionField.current?.focus()}
                row={(position) => {
                  const channel = channelAt(position);
                  return (
                    channel && (
                      <>
                        <span className="w-9 flex-none text-right text-xs text-muted-foreground tabular-nums">
                          {channel.number ?? ""}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{channel.title}</span>
                        <span className="max-w-[55%] flex-none truncate text-[0.8125rem] text-muted-foreground">
                          {stateOf(channel)}
                        </span>
                      </>
                    )
                  );
                }}
              />
            )}
          </section>
          {picked ? (
            <Picker
              key={picked.id}
              subscriptionId={subscriptionId}
              channel={picked}
              revision={first?.revision ?? ""}
              field={optionField}
              onMapped={() => {
                // Every page of them that was read, as the main process has them now.
                void client.invalidateQueries({
                  queryKey: ["guide", "map", subscriptionId, "channels"],
                });
                channelList.current?.focus();
              }}
              onChanged={() =>
                client.invalidateQueries({ queryKey: ["guide", "map", subscriptionId] })
              }
              onLeave={() => channelList.current?.focus()}
            />
          ) : (
            <section />
          )}
        </div>
        <div className="mt-4 flex items-center gap-3 border-t border-white/8 pt-3 text-sm text-muted-foreground">
          {t("Mappings apply at once to Live TV, Home and search.")}
          <Button size="sm" className="ml-auto" onClick={onClose}>
            {t("Done")}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** A guide channel by its id, after its source's host when it isn't the subscription's own guide's. */
function nameOf(guideChannel: GuideChannelRef): string {
  return guideChannel.origin
    ? `${hostOf(guideChannel.origin)} · ${guideChannel.id}`
    : guideChannel.id;
}

/** How a channel gets its programmes, in a few words beside its name. */
function stateOf(channel: MapChannel): string {
  if (!channel.listed) return t("no longer listed");
  if (channel.mapped === null) return channel.shown ? nameOf(channel.shown) : t("no id match");
  return channel.shown === null
    ? `${t("mapped")} · ${nameOf(channel.mapped)} · ${t("not in this guide")}`
    : `${t("mapped")} · ${nameOf(channel.mapped)}`;
}

/**
 * The guide channels to map one channel to: Automatic first, then the guides', those the field
 * finds. The field starts with the channel's name, as a search to begin from; whatever it
 * finds, the viewer picks.
 */
function Picker({
  subscriptionId,
  channel,
  revision,
  field,
  onMapped,
  onChanged,
  onLeave,
}: {
  subscriptionId: string;
  channel: MapChannel;
  /** Names the guides the channel was read from, which a mapping is refused without. */
  revision: string;
  field: RefObject<HTMLInputElement | null>;
  /** The channel is mapped as asked, so the channels no longer stand as they were read. */
  onMapped: () => void;
  /** The guide is another one than the lists were read from, or no longer has the channel. */
  onChanged: () => void;
  /** The keyboard leaves for the channels. */
  onLeave: () => void;
}) {
  const [text, setText] = useState(channel.listed ? channel.title : "");
  const query = useDebounced(text.trim(), SEARCH_DELAY_MS);
  const listKey = `${subscriptionId}:${query}`;
  const { pages, load } = usePages(listKey);
  const loaded = useQueries({
    queries: pages.map((page) => queries.mapOptions(subscriptionId, query, page * PAGE, PAGE)),
  });
  const byPage = new Map(pages.map((page, index) => [page, loaded[index]?.data]));
  const total = byPage.get(0)?.total ?? 0;
  /** Automatic is the first option; the guides' channels follow it. */
  const optionAt = (index: number): GuideChannel | undefined =>
    byPage.get(Math.floor((index - 1) / PAGE))?.channels[(index - 1) % PAGE];
  const visible = useCallback(
    (from: number, to: number) => load(Math.max(0, from - 1), to - 1),
    [load],
  );
  const [at, setAt] = useState({ list: listKey, index: 0 });
  const active = at.list === listKey ? at.index : 0;
  const list = useRef<HTMLDivElement>(null);
  const words = searchWords(query);

  const map = useMutation({
    mutationFn: (ref: string | null) =>
      call("guide.map", { subscriptionId, channelId: channel.id, guide: ref, revision }),
    onSuccess: () => onMapped(),
    onError: (cause) => {
      const error = appError(cause);
      const changed = error.kind === "guide" && error.failure.kind === "changed";
      if (changed || error.kind === "channel-not-found") onChanged();
    },
  });
  /** Maps the channel to the option at `index`, or back to automatic at the first. */
  const choose = (index: number) => {
    if (map.isPending) return;
    const ref = index === 0 ? null : optionAt(index)?.ref;
    if (ref === undefined || ref === (channel.mapped?.ref ?? null)) return;
    // Only a channel the provider still lists can be mapped anew.
    if (ref !== null && !channel.listed) return;
    map.mutate(ref);
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <div className="mb-2 flex min-h-9 items-center text-[0.9375rem]">
        <h3 className="min-w-0 truncate font-semibold">
          {t("Guide for {name}", { name: channel.title })}
        </h3>
      </div>
      <SearchField
        field={field}
        label={t("Search guide channels")}
        value={text}
        onChange={setText}
        onDown={() => list.current?.focus()}
      />
      <Options
        key={listKey}
        box={list}
        label={t("Guide channels for {name}", { name: channel.title })}
        total={total + 1}
        active={active}
        onActive={(next) => setAt({ list: listKey, index: next })}
        onVisible={visible}
        onEnter={choose}
        onLeave={onLeave}
        row={(index, isActive) => {
          if (index === 0) {
            return (
              <>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {channel.mapped === null
                    ? `${t("Automatic")} · ${channel.shown ? nameOf(channel.shown) : t("no id match")}`
                    : t("Automatic")}
                </span>
                <Choice
                  current={channel.mapped === null}
                  offered={isActive}
                  pending={map.isPending}
                  label={t("Restore")}
                  onChoose={() => choose(0)}
                />
              </>
            );
          }
          const option = optionAt(index);
          return (
            option && (
              <>
                <span className="min-w-0 flex-1 truncate">
                  <Marked text={option.name} words={words} />
                  {!option.programmes && (
                    <span className="text-muted-foreground"> · {t("no programmes")}</span>
                  )}
                </span>
                <span className="max-w-[45%] flex-none truncate font-mono text-xs text-muted-foreground">
                  {nameOf(option)}
                </span>
                <Choice
                  current={option.ref === channel.mapped?.ref}
                  offered={isActive && channel.listed}
                  pending={map.isPending}
                  label={t("Map")}
                  onChoose={() => choose(index)}
                />
              </>
            )
          );
        }}
      />
      <div aria-live="polite" className="min-h-6 pt-1 text-[0.8125rem] text-muted-foreground">
        {map.error ? (
          <span role="alert" className="text-destructive">
            {describeError(appError(map.error))}
          </span>
        ) : query ? (
          t("{shown} of {total} shown", { shown: total, total: byPage.get(0)?.listed ?? 0 })
        ) : null}
      </div>
    </section>
  );
}

/** What a row of guide channels ends with: that it is the one in use, or the button that picks it. */
function Choice({
  current,
  offered,
  pending,
  label,
  onChoose,
}: {
  current: boolean;
  /** The row has the keyboard or the pointer, and can be picked. */
  offered: boolean;
  pending: boolean;
  label: string;
  onChoose: () => void;
}) {
  if (current) {
    return <span className="flex-none px-3.5 text-[0.8125rem] opacity-60">{t("Current")}</span>;
  }
  return (
    <Button
      size="sm"
      tabIndex={-1}
      disabled={pending}
      className={cn("flex-none", !offered && "opacity-0 group-hover:opacity-100")}
      onClick={(event) => {
        event.stopPropagation();
        onChoose();
      }}
    >
      {label}
    </Button>
  );
}

/** A search field over a list. Down hands the keyboard to the list. */
function SearchField({
  field,
  label,
  value,
  onChange,
  onDown,
}: {
  field?: RefObject<HTMLInputElement | null>;
  label: string;
  value: string;
  onChange: (text: string) => void;
  onDown: () => void;
}) {
  return (
    <label className="mb-2 flex h-9 flex-none items-center gap-2 rounded-full bg-white/8 px-3.5 focus-within:bg-white/12">
      <Search className="size-4 flex-none text-muted-foreground" />
      <input
        ref={field}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Enter that ends a composition, as for Japanese, is the text's.
          if (event.nativeEvent.isComposing) return;
          if (event.key !== "ArrowDown" && event.key !== "Enter") return;
          onDown();
          event.preventDefault();
        }}
        placeholder={label}
        aria-label={label}
        spellCheck={false}
        className="min-w-0 flex-1 truncate bg-transparent text-[0.875rem] text-foreground outline-none placeholder:text-muted-foreground"
      />
    </label>
  );
}

/**
 * A list of `total` rows of one height, drawing only those in view, with one of them active: the
 * arrow keys, Page Up and Down, Home and End move it, a click picks it, and Enter acts on it.
 * `onVisible` says which rows are in view, for whoever reads them a page at a time; `row` draws
 * one, or nothing while its page loads.
 */
function Options({
  box,
  label,
  total,
  active,
  onActive,
  onVisible,
  onEnter,
  onLeave,
  row,
}: {
  box: RefObject<HTMLDivElement | null>;
  label: string;
  total: number;
  active: number;
  onActive: (index: number) => void;
  onVisible: (first: number, last: number) => void;
  onEnter: (index: number) => void;
  /** Up from the first row, where there is somewhere to go. */
  onLeave?: () => void;
  row: (index: number, active: boolean) => ReactNode;
}) {
  const rem = useRem();
  const id = useId();
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => box.current,
    estimateSize: () => ROW_REM * rem,
    overscan: 8,
  });
  useEffect(() => virtualizer.measure(), [rem, virtualizer]);
  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? -1;
  useEffect(() => onVisible(first, last), [first, last, onVisible]);

  function onKey(event: KeyboardEvent) {
    const page = Math.max(1, items.length - 2);
    const to =
      event.key === "ArrowDown"
        ? active + 1
        : event.key === "ArrowUp"
          ? active - 1
          : event.key === "PageDown"
            ? active + page
            : event.key === "PageUp"
              ? active - page
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? total - 1
                  : null;
    if (event.key === "Enter") onEnter(active);
    else if (to === null) return;
    else if (to < 0 && onLeave) onLeave();
    else {
      const next = Math.min(Math.max(to, 0), Math.max(total - 1, 0));
      onActive(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
    }
    event.preventDefault();
  }

  return (
    <div
      ref={box}
      role="listbox"
      aria-label={label}
      aria-activedescendant={total > 0 ? `${id}-${active}` : undefined}
      tabIndex={0}
      onKeyDown={onKey}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-lg text-[0.875rem] outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => (
          <div
            key={item.key}
            id={`${id}-${item.index}`}
            role="option"
            aria-selected={item.index === active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onActive(item.index)}
            className={cn(
              "group absolute inset-x-0 flex items-center gap-3 rounded-lg px-2.5 hover:bg-white/5",
              item.index === active && "bg-white/8",
            )}
            style={{ top: item.start, height: item.size }}
          >
            {row(item.index, item.index === active)}
          </div>
        ))}
      </div>
    </div>
  );
}
