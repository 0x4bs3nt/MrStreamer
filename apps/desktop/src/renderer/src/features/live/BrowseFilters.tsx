import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  EMPTY_LIVE_FILTERS,
  type LiveFilters,
  type LiveBrowseResult,
} from "@mrstreamer/contracts/live-browse";
import { formatLanguageName, formatNumber, t } from "@mrstreamer/core/i18n";
import { useUi, type ChannelList } from "../../app/ui-store.ts";
import { menuSurface } from "../../components/ui/menu.ts";
import { subscriptionName, useSubscriptions } from "../../lib/queries.ts";
import { cn } from "../../lib/utils.ts";

const DIMENSIONS = ["countries", "languages", "subscriptions"] as const;
const LABELS = {
  countries: "Country",
  languages: "Language",
  subscriptions: "Channel source",
} as const;

/** Session-only filters on the shared descriptor. Watch offers the same summary and reset. */
export function BrowseFilters({
  list,
  result,
  summaryOnly = false,
}: {
  list: ChannelList;
  result?: LiveBrowseResult | undefined;
  summaryOnly?: boolean;
}) {
  const filters = list.filters ?? EMPTY_LIVE_FILTERS;
  const subscriptions = useSubscriptions();
  const [open, setOpen] = useState<keyof LiveFilters | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const active = DIMENSIONS.some((dimension) => filters[dimension].length > 0);
  const label = (dimension: keyof LiveFilters, value: string) => {
    if (dimension === "languages") return formatLanguageName(value) ?? value;
    if (dimension !== "subscriptions") return value;
    const source = subscriptions.find((each) => each.id === value);
    return source ? subscriptionName(source) : t("Source unavailable");
  };
  const change = (next: LiveFilters) => useUi.setState({ list: { ...list, filters: next } });
  const close = () => {
    if (open) triggers.current.get(open)?.focus();
    setOpen(null);
  };
  useLayoutEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, [open]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const popup = menu.current;
      if (!popup) return;
      popup.style.transform = "";
      const bounds = popup.getBoundingClientRect();
      const shift = Math.max(8 - bounds.left, Math.min(0, window.innerWidth - 8 - bounds.right));
      popup.style.transform = `translateX(${shift}px)`;
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open, filters, result]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !box.current?.contains(event.target)) setOpen(null);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  if (summaryOnly && !active) return null;
  return (
    <div
      ref={box}
      className={
        summaryOnly
          ? "flex flex-wrap items-center gap-x-4 gap-y-1 px-7 pb-3 text-xs"
          : "relative flex h-8 flex-none items-center gap-5 px-9 text-xs"
      }
      aria-label={t("Channel filters")}
      onKeyDown={(event) => {
        if (!open) return;
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
        const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next =
          event.key === "ArrowDown"
            ? (index + 1) % buttons.length
            : event.key === "ArrowUp"
              ? (index - 1 + buttons.length) % buttons.length
              : event.key === "Home"
                ? 0
                : event.key === "End"
                  ? buttons.length - 1
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          buttons[next]?.focus();
        }
      }}
    >
      {DIMENSIONS.map((dimension) => {
        const selected = filters[dimension];
        if (dimension === "languages" && selected.length === 0 && !result?.facets.languages.length)
          return null;
        const text = selected.length
          ? selected.map((value) => label(dimension, value)).join(", ")
          : t("Any");
        if (summaryOnly)
          return selected.length ? (
            <span key={dimension}>
              {t(LABELS[dimension])} {text}
            </span>
          ) : null;
        const options = new Map(result?.facets[dimension].map((each) => [each.value, each.count]));
        for (const value of selected) if (!options.has(value)) options.set(value, 0);
        return (
          <div key={dimension} className="relative min-w-0">
            <button
              ref={(node) => {
                if (node) triggers.current.set(dimension, node);
                else triggers.current.delete(dimension);
              }}
              data-browse-filter={dimension}
              aria-haspopup="menu"
              aria-expanded={open === dimension}
              onClick={() => setOpen(open === dimension ? null : dimension)}
              className="-mx-2 flex h-7 max-w-52 items-center gap-1 rounded-lg px-2 text-left outline-none hover:bg-white/8 focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="text-muted-foreground">{t(LABELS[dimension])}</span>
              <span className="truncate">{text}</span>
              <ChevronDown className="size-3 flex-none" />
            </button>
            {open === dimension && (
              <div
                ref={menu}
                role="menu"
                aria-label={t(LABELS[dimension])}
                className={cn(
                  menuSurface,
                  "absolute top-full left-0 z-30 mt-1 max-h-72 w-max min-w-48 max-w-[min(24rem,calc(100vw-1rem))] overflow-y-auto",
                )}
              >
                <button
                  role="menuitemcheckbox"
                  aria-checked={selected.length === 0}
                  onClick={() => {
                    change({ ...filters, [dimension]: [] });
                    close();
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                >
                  <span className="flex-1">{t("Any")}</span>
                  {result && (
                    <span className="flex-none text-muted-foreground tabular-nums">
                      {formatNumber(result.counts[dimension])}
                    </span>
                  )}
                  {selected.length === 0 && <Check className="size-3 flex-none" />}
                </button>
                {[...options].map(([value, count]) => (
                  <button
                    key={value}
                    role="menuitemcheckbox"
                    aria-checked={selected.includes(value)}
                    onClick={() =>
                      change({
                        ...filters,
                        [dimension]: selected.includes(value)
                          ? selected.filter((each) => each !== value)
                          : [...selected, value],
                      })
                    }
                    className="flex h-8 w-full items-center gap-3 rounded-lg px-2 text-left hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                  >
                    <span className="min-w-0 flex-1 truncate" title={label(dimension, value)}>
                      {label(dimension, value)}
                    </span>
                    <span className="flex-none text-muted-foreground tabular-nums">
                      {formatNumber(count)}
                    </span>
                    {selected.includes(value) && <Check className="size-3 flex-none" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {active && (
        <button
          onClick={() => change(EMPTY_LIVE_FILTERS)}
          className="flex-none underline underline-offset-4"
        >
          {t("Reset filters")}
        </button>
      )}
      {!summaryOnly && result && (
        <span className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums">
          {formatNumber(result.channels.length)} / {formatNumber(result.total)}
        </span>
      )}
    </div>
  );
}
