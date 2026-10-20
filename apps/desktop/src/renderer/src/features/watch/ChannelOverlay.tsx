// Watch's channel list over the left of the picture: the current list with what's on now. Its
// title swaps in the list picker, so another category is one click away without leaving Watch.
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Star, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Listing } from "@mrstreamer/contracts/guide";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import type { ChannelList } from "../../app/ui-store.ts";
import { ChannelLogo } from "../../components/ChannelLogo.tsx";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { useNow } from "../../lib/clock.ts";
import { categoryOf, progressOf, timeLeft } from "../../lib/format.ts";
import {
  useCategoryMap,
  useFavouriteKeys,
  useSourceOf,
  useToggleFavourite,
} from "../../lib/queries.ts";
import { useRem } from "../../lib/use-rem.ts";
import { cn } from "../../lib/utils.ts";
import { BrowseFilters } from "../live/BrowseFilters.tsx";
import { ListPicker } from "../live/ListPicker.tsx";
import { listTitle, useVisibleListings, type ListPickerState } from "../live/lists.ts";

const ROW_REM = 3.75;

export function ChannelOverlay({
  list,
  channels,
  playing,
  picking,
  selected,
  picker,
  entry,
  onPlay,
  onPick,
  onTogglePicking,
  onClose,
}: {
  list: ChannelList;
  channels: readonly LiveChannel[];
  /** The channel that plays. */
  playing: OwnedId | null;
  /** The list picker shows instead of the channels. */
  picking: boolean;
  /** The keyboard selection among the channels, or null. */
  selected: number | null;
  picker: ListPickerState;
  /** The keyboard selection in the picker, or null. */
  entry: number | null;
  onPlay: (channel: LiveChannel) => void;
  onPick: (list: ChannelList) => void;
  onTogglePicking: () => void;
  onClose: () => void;
}) {
  const categories = useCategoryMap();
  return (
    <div className="no-drag absolute inset-y-0 left-0 z-20 flex">
      <div className="flex h-full w-[26rem] flex-col bg-black pt-16">
        <header className="flex items-center gap-2 px-5 pb-3">
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onTogglePicking}
            className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xl font-semibold tracking-tight hover:bg-white/8"
          >
            <span className="truncate">{listTitle(list, categories)}</span>
            <ChevronDown className={cn("size-4 flex-none", picking && "rotate-180")} />
          </button>
          <span className="flex-1" />
          <Button variant="ghost" size="icon-sm" aria-label={t("Close")} onClick={onClose}>
            <X />
          </Button>
        </header>
        <BrowseFilters list={list} summaryOnly />
        {picking ? (
          <ListPicker
            picker={picker}
            selected={list}
            highlight={entry}
            onPick={onPick}
            onChannels={onTogglePicking}
            className="min-h-0 flex-1 px-3 pb-6"
          />
        ) : (
          <Channels
            channels={channels}
            playingKey={playing && ownedKey(playing)}
            selected={selected}
            categories={categories}
            onPlay={onPlay}
          />
        )}
      </div>
      <div className="h-full w-24 bg-gradient-to-r from-black to-transparent" />
    </div>
  );
}

function Channels({
  channels,
  playingKey,
  selected,
  categories,
  onPlay,
}: {
  channels: readonly LiveChannel[];
  /** The channel that plays, by its `ownedKey`. */
  playingKey: string | null;
  selected: number | null;
  categories: ReturnType<typeof useCategoryMap>;
  onPlay: (channel: LiveChannel) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rem = useRem();
  const now = useNow();
  const favourites = useFavouriteKeys();
  const toggleFavourite = useToggleFavourite();
  const sourceOf = useSourceOf();
  const virtualizer = useVirtualizer({
    count: channels.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_REM * rem,
    overscan: 8,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [rem, virtualizer]);
  // Opens on the playing channel.
  useEffect(() => {
    const index = channels.findIndex((channel) => ownedKey(channel) === playingKey);
    if (index > 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [channels.length > 0]);
  // Only the keyboard scrolls the list.
  useEffect(() => {
    if (selected !== null) virtualizer.scrollToIndex(selected, { align: "auto" });
  }, [selected, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const listings = useVisibleListings(
    channels,
    items.map((item) => item.index),
  );
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-6">
      <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const channel = channels[item.index];
          if (!channel) return null;
          const key = ownedKey(channel);
          return (
            <Row
              key={key}
              channel={channel}
              listing={listings.get(key) ?? null}
              // The channel's own line, with whose it is where another is called the same.
              named={[channel.title, sourceOf(channel)].filter(Boolean).join(" · ")}
              category={[categoryOf(channel, categories), sourceOf(channel)]
                .filter(Boolean)
                .join(" · ")}
              now={now}
              playing={key === playingKey}
              selected={item.index === selected}
              favourite={favourites.has(key)}
              top={item.start}
              height={item.size - 4}
              onPlay={() => onPlay(channel)}
              onToggleFavourite={() => toggleFavourite(channel)}
            />
          );
        })}
      </div>
    </div>
  );
}

function Row({
  channel,
  listing,
  named,
  category,
  now,
  playing,
  selected,
  favourite,
  top,
  height,
  onPlay,
  onToggleFavourite,
}: {
  channel: LiveChannel;
  listing: Listing | null;
  /** The channel's name, as the line under a programme says it. */
  named: string;
  category: string;
  now: number;
  playing: boolean;
  selected: boolean;
  favourite: boolean;
  top: number;
  height: number;
  onPlay: () => void;
  onToggleFavourite: () => void;
}) {
  const current = listing?.now ?? null;
  return (
    <div
      role="button"
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onPlay}
      className={cn(
        "group absolute inset-x-0 flex items-center gap-3.5 px-3 hover:bg-white/8",
        playing && "bg-white/6",
        selected && "ring-2 ring-white/70 ring-inset",
      )}
      style={{ top, height }}
    >
      <span className="w-9 flex-none text-right text-xs text-muted-foreground tabular-nums">
        {channel.number ?? ""}
      </span>
      <ChannelLogo channel={channel} className="h-8 w-12" />
      <span className="min-w-0 flex-1" title={channel.name}>
        <span
          className={cn("block truncate text-[0.9375rem]", playing && "font-semibold text-white")}
        >
          {current?.title ?? channel.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {current ? `${named} · ${timeLeft(current, now)}` : category}
        </span>
        {current && <Progress value={progressOf(current, now)} className="mt-1 w-28" />}
      </span>
      {playing && (
        <span className="size-2 flex-none rounded-full bg-white" aria-label={t("Playing")} />
      )}
      <button
        aria-label={favourite ? t("Remove from favourites") : t("Add to favourites")}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.stopPropagation();
          onToggleFavourite();
        }}
        className={cn(
          "grid size-8 flex-none place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-white",
          !favourite && !selected && "opacity-0 group-hover:opacity-100",
        )}
      >
        <Star className={cn("size-4", favourite && "fill-current")} />
      </button>
    </div>
  );
}
