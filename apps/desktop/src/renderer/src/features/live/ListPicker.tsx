// Shared topic rail and Provider lists picker for the guide sidebar and Watch overlay.
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Fragment, useEffect, useRef } from "react";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { formatNumber, t } from "@mrstreamer/core/i18n";
import { sameList, type ChannelList } from "../../app/ui-store.ts";
import { SearchField } from "../../components/ui/search-field.tsx";
import { cn } from "../../lib/utils.ts";
import { PROVIDER_LISTS, type ListPickerState } from "./lists.ts";

export function ListPicker({
  picker,
  selected,
  highlight,
  onPick,
  onChannels,
  notice,
  onFocus,
  className,
}: {
  picker: ListPickerState;
  selected: ChannelList;
  highlight: number | null;
  onPick: (list: ChannelList) => void;
  onChannels: () => void;
  /** A removed category falls back to All channels; keep its explanation beside that row. */
  notice?: string | null;
  /** The focus went into the picker, as with Tab or a click on its field: it has the keys. */
  onFocus?: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const restore = useRef(false);
  const { entries, group, query, setQuery, entry, setEntry, openGroup } = picker;
  const back = () => {
    restore.current = true;
    picker.back();
  };
  useEffect(() => {
    if (!restore.current) return;
    restore.current = false;
    box.current?.querySelector<HTMLButtonElement>(`[data-entry="${entry}"]`)?.focus();
  }, [group, query, entry]);
  useEffect(() => {
    if (highlight === null) return;
    box.current?.querySelector(`[data-entry="${highlight}"]`)?.scrollIntoView({ block: "nearest" });
  }, [highlight, entries]);
  const pick = (index: number) => {
    const picked = entries[index];
    if (picked?.kind === "group") {
      restore.current = true;
      openGroup(picked.group);
    } else if (picked) {
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && box.current?.contains(focused)) focused.blur();
      onPick(picked.list);
    }
  };
  return (
    <div
      ref={box}
      role="navigation"
      aria-label={t("Channel categories")}
      className={cn("flex flex-col", className)}
      onFocus={onFocus}
      onKeyDown={(event) => {
        if (event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) return;
        const control =
          event.target instanceof HTMLButtonElement && !event.target.closest("[data-entry]");
        if (control && (event.key === "Enter" || event.key === " ")) {
          event.stopPropagation();
          return;
        }
        const typing = event.target instanceof HTMLInputElement;
        if (typing && event.key !== "ArrowDown" && event.key !== "Enter" && event.key !== "Escape")
          return;
        const index = Number(
          (event.target as HTMLElement).closest("[data-entry]")?.getAttribute("data-entry") ??
            entry,
        );
        if (!typing && event.key === "ArrowRight") {
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
          onChannels();
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        let next: number | undefined;
        if (event.key === "ArrowDown")
          next = typing || control ? 0 : Math.min(index + 1, entries.length - 1);
        else if (event.key === "ArrowUp") next = Math.max(index - 1, 0);
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = entries.length - 1;
        else if (event.key === "PageDown") next = Math.min(index + 10, entries.length - 1);
        else if (event.key === "PageUp") next = Math.max(index - 10, 0);
        else if (event.key === "Enter" && !event.repeat) pick(index);
        else if (
          (event.key === "ArrowLeft" || event.key === "Backspace" || event.key === "Escape") &&
          (group !== null || query.trim() !== "")
        )
          back();
        else if (event.key === "/" && !typing) field.current?.focus();
        else return;
        event.preventDefault();
        event.stopPropagation();
        if (next !== undefined && next >= 0) {
          setEntry(next);
          box.current?.querySelector<HTMLButtonElement>(`[data-entry="${next}"]`)?.focus();
        }
      }}
    >
      <SearchField
        ref={field}
        type="text"
        aria-label={t("Find a category")}
        placeholder={t("Find")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="mb-2 flex-none"
        end={
          query !== "" && (
            <button
              aria-label={t("Clear category search")}
              onClick={() => {
                setQuery("");
                field.current?.focus();
              }}
              className="-mr-1 grid size-6 flex-none place-items-center rounded-full text-muted-foreground hover:bg-white/10 hover:text-white"
            >
              <X className="size-3.5" />
            </button>
          )
        }
      />
      {group !== null && query.trim() === "" && (
        <button
          aria-label={group === PROVIDER_LISTS ? t("Back to topics") : t("Back to countries")}
          onClick={back}
          className="mb-1 flex h-9 flex-none items-center gap-2 rounded-lg px-3 text-left text-sm font-semibold hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-white/70"
        >
          <ChevronLeft className="size-3.5 flex-none" />
          <span className="min-w-0 flex-1 truncate" title={group}>
            {group === PROVIDER_LISTS ? t("Provider lists") : group}
          </span>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(picker.count)}
          </span>
        </button>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {entries.length === 0 && query.trim() !== "" && (
          <p role="status" className="px-3 py-2 text-sm">
            {t("No categories match.")}
          </p>
        )}
        {entries.map((item, index) => {
          const current = item.kind === "list" && sameList(item.list, selected);
          const title =
            item.kind === "group"
              ? item.group === PROVIDER_LISTS
                ? t("Provider lists")
                : item.group
              : [item.title, item.context].filter(Boolean).join(" · ");
          return (
            <Fragment key={item.kind === "group" ? `g:${item.group}` : listKey(item.list)}>
              <button
                data-entry={index}
                aria-current={current ? "true" : undefined}
                title={title}
                onFocus={() => setEntry(index)}
                onClick={() => pick(index)}
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sm text-white hover:bg-white/8 focus-visible:outline-2 focus-visible:outline-white/70 focus-visible:outline-offset-[-2px]",
                  current && "bg-white/10",
                  highlight === index && "ring-2 ring-white/70 ring-inset",
                  group === null && query.trim() === "" && index === 3 && "mt-3",
                )}
              >
                <span className="min-w-0 flex-1 truncate">
                  {item.kind === "group"
                    ? item.group === PROVIDER_LISTS
                      ? t("Provider lists")
                      : item.group
                    : item.title}
                  {item.kind === "list" && item.context && (
                    <span className="text-muted-foreground"> · {item.context}</span>
                  )}
                </span>
                <span className="flex-none text-xs text-muted-foreground tabular-nums">
                  {formatNumber(item.count)}
                </span>
                {item.kind === "group" && (
                  <ChevronRight className="size-3.5 flex-none text-muted-foreground" />
                )}
              </button>
              {notice && item.kind === "list" && item.list.kind === "all" && (
                <p role="status" className="px-3 pt-2 text-sm">
                  {notice}
                </p>
              )}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/** A stable key for a list. */
export function listKey(list: ChannelList): string {
  return list.kind === "category"
    ? `c:${ownedKey(list.category)}`
    : list.kind === "topic"
      ? `t:${list.topic}`
      : list.kind;
}
