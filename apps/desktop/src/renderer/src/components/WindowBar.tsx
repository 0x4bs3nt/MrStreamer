import { ChevronLeft, Search, Settings } from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefCallback,
} from "react";
import type { Locale } from "@mrstreamer/contracts/language";
import { hasTitles } from "@mrstreamer/contracts/subscription";
import { useLocale } from "../app/language.ts";
import { isMac, useWindowFullScreen } from "../app/platform.ts";
import {
  backDetails,
  closeWatch,
  withoutTitles,
  openView,
  useUi,
  type View,
} from "../app/ui-store.ts";
import { DownloadsNotice, useDownloadsStatus } from "../features/downloads/DownloadsNotice.tsx";
import { UpdateNotice, updateNoticeLabel } from "../features/updates/UpdateNotice.tsx";
import { useQuery } from "@tanstack/react-query";
import { type PlainKey, t } from "@mrstreamer/core/i18n";
import { queries, useSubscriptions } from "../lib/queries.ts";
import { cn } from "../lib/utils.ts";
import { WINDOW_BAR } from "../../../shared/window-bar.ts";
import { Logo } from "./Logo.tsx";
import { TmdbProgress } from "./TmdbProgress.tsx";
import { Button } from "./ui/button.tsx";

const VIEWS = [
  { view: "home", label: "Home" },
  { view: "live", label: "Live TV" },
  { view: "movies", label: "Movies" },
  { view: "series", label: "Series" },
  { view: "watchlist", label: "Watchlist" },
  { view: "downloads", label: "Downloads" },
] as const satisfies readonly { readonly view: View; readonly label: PlainKey }[];

/**
 * The top of the window: brand, the pages, how far TMDB has come, search and settings. It is also
 * the window's drag area; macOS draws its traffic lights on the left and Windows its controls on
 * the right, except in full screen, where the bar takes their room. Over Settings, Watch or a
 * title's details, Back takes the pages' place and returns to the page underneath; over details
 * a related title opened, it first returns through those it was opened from (`backDetails`).
 * Details get a bar of their own above their backdrop for it (`App.tsx`). `onBack` overrides
 * where it goes, as a playing title or an open collection does. Subscriptions with
 * live TV only have no Movies or Series; Watchlist stays reachable. Where the window is too
 * narrow for every page's name, Downloads goes beside Search as a button of its own, under the same name. That
 * place also says how the downloads stand while one is under way, waits or stopped, except over
 * the Downloads page itself while its name is in the bar. Where even the other names, or Back,
 * don't fit beside those words, Downloads and Update keep their icons alone, with their words
 * on hover and focus.
 */
export function WindowBar({ className, onBack }: { className?: string; onBack?: () => void }) {
  const view = useUi((state) => state.view);
  // An unmapped playlist has live TV only; explicit mapping enables the title pages.
  const subscriptions = useSubscriptions();
  const liveOnly = !subscriptions.some(hasTitles);
  // A copy playing with no subscription saved: there is nothing to search, and no Settings page.
  const alone = useQuery(queries.subscriptions()).data?.length === 0;
  const watching = useUi((state) => state.watching);
  const settingsOpen = useUi((state) => state.settings !== null);
  const detailsOpen = useUi((state) => state.details !== null);
  const savedOpen = useUi((state) => state.savedEntry !== null);
  const status = useDownloadsStatus();
  const locale = useLocale();
  const update = useQuery(queries.updates()).data;
  const updateOpen = useUi((state) => state.updateDialog === "panel");
  const updateWords = updateNoticeLabel(update, updateOpen);
  const [pages, fold] = useFolds(status?.text, updateWords, locale);
  const [backRoom, backFold] = useFolds(status?.text, updateWords, locale);
  const folded = fold !== "none";
  const back =
    onBack ??
    (settingsOpen
      ? () => useUi.setState({ settings: null })
      : watching
        ? closeWatch
        : detailsOpen
          ? () => void backDetails()
          : savedOpen
            ? () => useUi.setState({ savedEntry: null })
            : null);
  const shown = liveOnly ? VIEWS.filter((entry) => withoutTitles(entry.view)) : VIEWS;
  return (
    <BarFrame className={className}>
      <Brand />
      {back ? (
        <div ref={backRoom} className="flex min-w-0 flex-1 overflow-hidden">
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={back}
            className="flex h-8 flex-none items-center gap-1 rounded-full pr-3 pl-1.5 text-[0.875rem] font-semibold text-white hover:text-white/75"
          >
            <ChevronLeft className="size-4" />
            {t("Back")}
          </button>
        </div>
      ) : (
        <nav ref={pages} className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          {shown
            .filter((entry) => !(folded && entry.view === "downloads"))
            .map((entry) => (
              <PageButton key={entry.view} view={entry.view} current={entry.view === view}>
                {t(entry.label)}
              </PageButton>
            ))}
        </nav>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <UpdateNotice compact={(back ? backFold : fold) === "arrow"} />
        <TmdbProgress />
        {back ? (
          <DownloadsNotice status={status} compact={backFold === "arrow"} />
        ) : folded ? (
          <DownloadsNotice
            status={status}
            page
            current={view === "downloads"}
            compact={fold === "arrow"}
          />
        ) : (
          view !== "downloads" && <DownloadsNotice status={status} />
        )}
        {!alone && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Search")}
              onClick={() => useUi.setState({ searchOpen: true })}
            >
              <Search />
            </Button>
            <Button
              variant={settingsOpen ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={t("Settings")}
              aria-pressed={settingsOpen}
              onClick={() => useUi.setState({ settings: settingsOpen ? null : "general" })}
            >
              <Settings />
            </Button>
          </>
        )}
      </div>
    </BarFrame>
  );
}

/**
 * The bar's frame: the window's drag area, clear of macOS's traffic lights on the left and the
 * Windows controls on the right, except in full screen, where the bar takes their room.
 */
export function BarFrame({
  className,
  children,
}: {
  className?: string | undefined;
  children: ReactNode;
}) {
  const controls = !useWindowFullScreen();
  return (
    <header
      className={cn("drag flex flex-none items-center gap-1 px-4", className)}
      style={{
        height: WINDOW_BAR.height,
        ...(controls &&
          (isMac
            ? { paddingLeft: WINDOW_BAR.macInset }
            : { paddingRight: WINDOW_BAR.windowsInset })),
      }}
    >
      {children}
    </header>
  );
}

export function Brand() {
  return (
    <span className="mr-4 flex flex-none items-center gap-2">
      <Logo className="size-5" />
      <b className="text-[0.9375rem] tracking-tight">mr. streamer</b>
    </span>
  );
}

/** A page's name in the bar: bold and white for the page on screen. */
export function PageButton({
  view,
  current,
  children,
}: {
  view: View;
  current: boolean;
  children: ReactNode;
}) {
  return (
    <button
      aria-current={current ? "page" : undefined}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => openView(view)}
      className={cn(
        "h-8 flex-none rounded-full px-3 text-[0.875rem] transition-colors",
        current ? "font-semibold text-white" : "text-muted-foreground hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

/**
 * How far the bar folds: "none" while every page's name fits; "downloads" once they don't fit
 * where the bar holds them, which puts Downloads beside Search; "arrow" once the other names
 * don't fit beside that button's words either, which leaves it its arrow alone. Back, in the
 * pages' place, folds the same way, with nothing for "downloads" to fold.
 */
type Fold = "none" | "downloads" | "arrow";

/**
 * How far the pages' names fold (see `Fold`), for the bar's notice saying `words` in the interface
 * language `locale`. Each fold holds until there is room again for as much as was missing, so the
 * bar never flips back and forth at one width. Downloads comes back once the pages have the room
 * all their names took, a little more than they need while it stands beside Search. The arrow
 * tries its words again whenever the pages' room grows, the words change or the language does, as
 * Back's name can while the words read the same, and keeps them only if the names still fit beside
 * them; the try is measured before the bar is drawn, so it shows nothing when it fails.
 */
function useFolds(
  words: string | undefined,
  updateWords: string | undefined,
  locale: Locale,
): [RefCallback<HTMLElement>, Fold] {
  const [fold, setFold] = useState<Fold>("none");
  // The room all the pages' names took when they stopped fitting, and the room the pages had
  // beside the arrow when last measured.
  const needed = useRef(0);
  const besideArrow = useRef(Infinity);
  const measured = useRef<(again: boolean) => void>(undefined);
  const ref = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    // `again`: what the bar holds changed, so the arrow tries its words whatever the room.
    const measure = (again: boolean) =>
      setFold((was) => {
        const room = element.clientWidth;
        const over = element.scrollWidth > room;
        switch (was) {
          case "none":
            if (!over) return "none";
            needed.current = element.scrollWidth;
            return "downloads";
          case "downloads":
            if (!over) return room < needed.current ? "downloads" : "none";
            besideArrow.current = Infinity;
            return "arrow";
          case "arrow":
            if (again || room > besideArrow.current) return "downloads";
            besideArrow.current = room;
            return "arrow";
        }
      });
    measured.current = measure;
    // The pages come back after Back with the fold they had, and the bar may have changed meanwhile.
    measure(true);
    const observer = new ResizeObserver(() => measure(false));
    observer.observe(element);
    return () => {
      observer.disconnect();
      measured.current = undefined;
    };
  }, []);
  // A fold can leave the pages' room as it was, as when Downloads' words stand beside Search
  // before and after its name goes, so nothing resizes: measured again before it is drawn. Words
  // or a language that changes resize nothing either while the arrow stands alone.
  useLayoutEffect(() => measured.current?.(false), [fold]);
  useLayoutEffect(() => measured.current?.(true), [words, updateWords, locale]);
  return [ref, fold];
}
