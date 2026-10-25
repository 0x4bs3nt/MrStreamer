// The Watchlist: every movie and series the viewer saved, whichever subscriptions list it, in one
// grid of posters, the one saved last first, or by name. It reads what was saved and what the
// lists have of it, and asks no provider anything: a title's details load when it opens. A title
// no provider lists any more stays, dimmed, until the viewer removes it.
//   The grid takes the same keys as a collection's. The cross on the selected tile, reached with
//   Tab after its poster, takes it off the list; no key of its own does.
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { create } from "zustand";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import type { WatchlistEntry, WatchlistSort } from "@mrstreamer/contracts/watchlist";
import { formatNumber, type PlainKey, t } from "@mrstreamer/core/i18n";
import { Sorts } from "../../components/Sorts.tsx";
import { WindowBar } from "../../components/WindowBar.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries, subscriptionName, useSubscriptions } from "../../lib/queries.ts";
import { useRemoveSaved } from "../../lib/watchlist.ts";
import { Grid, PAGE, usePages } from "../titles/CollectionGrid.tsx";
import { openSaved, SavedTile } from "./SavedTile.tsx";

const SORTS: readonly { value: WatchlistSort; label: PlainKey }[] = [
  { value: "saved", label: "Saved" },
  { value: "title", label: "A to Z" },
];

/** How the list is ordered, kept while the viewer goes elsewhere and comes back. */
const useOrder = create<{ sort: WatchlistSort }>(() => ({ sort: "saved" }));

/**
 * The watchlist in `sort`, fetched a page at a time as the grid asks. `settled` is false while a
 * page is being read, for the first time or again after the watchlist changed.
 */
function useWatchlist(sort: WatchlistSort) {
  const { pages, load } = usePages(sort);
  const loaded = useQueries({
    queries: pages.map((page) => queries.watchlist(sort, page * PAGE, PAGE)),
  });
  const byPage = new Map(pages.map((page, index) => [page, loaded[index]?.data]));
  const first = byPage.get(0);
  return {
    total: first ? first.total : null,
    entryAt: (index: number) => byPage.get(Math.floor(index / PAGE))?.entries[index % PAGE],
    load,
    settled: loaded.every((each) => !each.isFetching),
    error: loaded.find((each) => each.error)?.error ?? null,
    retry: () => void Promise.all(loaded.map((each) => each.refetch())),
  };
}

export function WatchlistPage({ active }: { active: boolean }) {
  const sort = useOrder((state) => state.sort);
  const saved = useWatchlist(sort);
  const removal = useRemoveSaved();
  const stale = useStale();

  // A cross pressed with the keyboard leaves the focus on the cross of the tile that takes its
  // place, or of the one before it when the last tile went (see Grid). Once nothing is left, the
  // page takes the focus that went with the last cross, unless the viewer put it elsewhere since.
  const page = useRef<HTMLDivElement>(null);
  const hadFocus = useRef(false);
  const { total } = saved;
  useEffect(() => {
    const box = page.current;
    if (!hadFocus.current || !box || removal.isPending) return;
    hadFocus.current = false;
    const focused = document.activeElement;
    if (total === 0 && (!focused || focused === document.body)) box.focus();
  }, [total, removal.isPending]);

  const remove = (entry: WatchlistEntry) => {
    hadFocus.current = page.current?.contains(document.activeElement) ?? false;
    removal.remove(entry);
  };

  return (
    <div className="flex h-full flex-col">
      <WindowBar className="bg-black" />
      <div
        ref={page}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col pt-2 pl-10 outline-none"
      >
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Watchlist")}</h1>
          {total ? (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatNumber(total)}
            </span>
          ) : null}
        </div>
        {saved.error ? (
          <Notice words={describeError(appError(saved.error))} onRetry={saved.retry} />
        ) : total === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t("Nothing saved yet. Save a movie or series from its details.")}
          </p>
        ) : (
          <>
            <Sorts
              options={SORTS}
              value={sort}
              onChange={(next) => useOrder.setState({ sort: next })}
            />
            {stale.map(({ subscriptionId, words }) => (
              <Notice
                key={subscriptionId}
                words={`${words} ${t("Showing what was saved.")}`}
                onRetry={() => void call("ondemand.refresh", { subscriptionId }).catch(() => {})}
              />
            ))}
            {removal.error && <Notice words={t("Couldn't remove. Try again.")} />}
            <Grid
              key={sort}
              total={total ?? 0}
              itemAt={saved.entryAt}
              keyOf={ownedKey}
              onVisible={saved.load}
              settled={saved.settled}
              active={active}
              onOpen={openSaved}
              tile={(entry, grid) => (
                <SavedTile entry={entry} grid={grid} onRemove={() => remove(entry)} />
              )}
            />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Why a subscription's lists are older than they should be, for each whose last refresh failed:
 * what was saved shows as the lists last had it. Beside other subscriptions the line names its
 * own. One that needs its password again says so where it plays, and in Settings.
 */
function useStale(): readonly { readonly subscriptionId: string; readonly words: string }[] {
  const subscriptions = useSubscriptions();
  const lists = useQuery(queries.onDemandStatus()).data?.lists ?? [];
  return lists.flatMap(({ subscriptionId, failure }) => {
    const subscription = subscriptions.find((each) => each.id === subscriptionId);
    if (!subscription || !failure || subscription.needsSecret) return [];
    const words = describeError(failure);
    return [
      {
        subscriptionId,
        words: subscriptions.length > 1 ? `${subscriptionName(subscription)}: ${words}` : words,
      },
    ];
  });
}

/** A line saying what went wrong, with a way to try again where trying can help. */
function Notice({ words, onRetry }: { words: string; onRetry?: () => void }) {
  return (
    <p className="mb-4 text-sm text-destructive">
      {words}
      {onRetry && (
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRetry}
          className="ml-2 text-white underline-offset-4 hover:underline"
        >
          {t("Try again")}
        </button>
      )}
    </p>
  );
}
