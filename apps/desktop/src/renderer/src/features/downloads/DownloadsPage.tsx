// Downloads: the queue on top, the copies on this computer below, each a row with what it is,
// how it stands and what can be done with it. The queue goes in its order: its one transfer leads
// with its progress, then the downloads waiting their turn, then the failed ones, which say why,
// with Retry. Up and Down move a waiting one a place among them, kept at once; the transfer and
// every waiting one have Pause, or Resume once paused. A download the viewer paused says so and
// keeps its partial file until resumed, while one whose subscription plays waits for that. Pause
// all in the heading pauses everything that can be, then Resume all lets it all go on. A pause, a
// resume or a move that can't be kept says so on its row, or under the heading, its control there
// to press again. A button of a row keeps the keyboard wherever the list moves its row, and where
// the row reached an end the other arrow takes it. A copy plays offline from here, with
// how far it was watched, and says so once its subscription went. Two or more copies of one series
// go together under its name, which folds them away, season by season in the series' order, with
// the episodes between them that aren't on this computer (see @mrstreamer/core/downloads/series).
// Everything here is read from this computer; artwork comes from the copies' own folders.
//   With no subscription saved the page stands alone, opened from Connect: its bar has only
//   Downloads, and Add subscription goes back to the form.
import { useMutation } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, Pause, Play } from "lucide-react";
import { Fragment, useLayoutEffect, useMemo, useState } from "react";
import type { Download } from "@mrstreamer/contracts/downloads";
import { copyShelf, type ShelfSeries } from "@mrstreamer/core/downloads/series";
import { formatBytes, formatNumber, t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { openView } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Artwork } from "../../components/TitleArt.tsx";
import { Button } from "../../components/ui/button.tsx";
import { BarFrame, Brand, PageButton, WindowBar } from "../../components/WindowBar.tsx";
import { statusLine, transferred, useDownloads, watchOffline } from "../../lib/downloads.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { runtime, timeLeftOf } from "../../lib/titles.ts";
import { cn } from "../../lib/utils.ts";
import { episodeLine } from "../../player/title-player.ts";
import { isFinished } from "@mrstreamer/core/viewing/titles";

/**
 * Hands the keyboard on where drawing the list turned off the arrow that had it, `had` being where
 * it was as the list came: the row's other arrow takes it. React gives a button the keyboard back
 * when the list moves its row, but can't give it to an arrow turned off at an end. Anything else,
 * as a button that went with its row or a keyboard the viewer had elsewhere, is left alone.
 */
function handOn(had: Element | null) {
  if (!(had instanceof HTMLButtonElement) || !had.disabled || !had.isConnected) return;
  const by = Number(had.dataset["move"]);
  const now = document.activeElement;
  if (!by || (now !== had && now !== null && now !== document.body)) return;
  const other = had.closest("[data-download]")?.querySelector(`[data-move="${-by}"]`);
  if (other instanceof HTMLButtonElement && !other.disabled) other.focus();
}

export function DownloadsPage({ standalone = false }: { standalone?: boolean }) {
  const list = useDownloads();
  const items = list.data?.items ?? [];
  const queue = items.filter((item) => !onComputer(item));
  const shelf = useMemo(() => (list.data ? copyShelf(list.data) : []), [list.data]);
  // Main lists the ones waiting together, after the transfer.
  const line = queue.filter(waiting);
  const pausable = queue.some(
    (item) =>
      item.status.kind === "transferring" || (waiting(item) && item.status.kind !== "paused"),
  );
  const paused = queue.some((item) => item.status.kind === "paused");
  const all = useMutation({
    mutationFn: (pause: boolean) =>
      pause ? call("downloads.pauseAll") : call("downloads.resumeAll"),
  });
  // Where the keyboard is as this list is drawn, for `handOn` once it is.
  const had = document.activeElement;
  useLayoutEffect(() => handOn(had));
  const summary = list.data
    ? [
        list.data.bytes > 0
          ? t("{size} on this computer", { size: formatBytes(list.data.bytes) })
          : null,
        list.data.free !== null ? t("{size} free", { size: formatBytes(list.data.free) }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div className="flex h-full flex-col">
      {standalone ? <OfflineBar /> : <WindowBar className="bg-black" />}
      <div className="min-h-0 flex-1 overflow-y-auto px-10 pt-2 pb-10">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{t("Downloads")}</h1>
          {items.length > 0 && (
            <span className="text-sm text-muted-foreground tabular-nums">
              {formatNumber(items.length)}
            </span>
          )}
          <span className="ml-auto text-[0.8125rem] text-muted-foreground tabular-nums">
            {summary}
          </span>
          {(pausable || paused) && (
            <Button
              size="sm"
              className="self-center"
              onClick={() => {
                // Pressed again while it is under way, it does nothing: it stays pressable.
                if (!all.isPending) all.mutate(pausable);
              }}
            >
              {pausable ? <Pause className="fill-current" /> : <Play className="fill-current" />}
              {pausable ? t("Pause all") : t("Resume all")}
            </Button>
          )}
        </div>
        {all.error && (
          <p role="alert" className="mb-2 text-[0.8125rem] text-destructive">
            {t("Couldn't save. Try again.")}
          </p>
        )}
        {list.error ? (
          <p className="text-sm text-destructive">{describeError(appError(list.error))}</p>
        ) : list.data && items.length === 0 ? (
          <p className="text-[0.9375rem] text-muted-foreground">
            {t("Nothing downloaded yet. Download a movie or an episode from its details.")}
          </p>
        ) : null}
        {queue.length > 0 && (
          <section aria-label={t("Queue")}>
            <h2 className="mt-2 mb-1 text-[0.9375rem] font-semibold">{t("Queue")}</h2>
            {queue.map((item) => (
              <Row key={item.id} item={item} first={line[0] === item} last={line.at(-1) === item} />
            ))}
          </section>
        )}
        {shelf.length > 0 && (
          <section aria-label={t("On this computer")}>
            <h2
              className={cn(
                "mb-1 text-[0.9375rem] font-semibold",
                queue.length > 0 ? "mt-6" : "mt-2",
              )}
            >
              {t("On this computer")}
            </h2>
            {shelf.map((item) =>
              item.kind === "copy" ? (
                <Row key={item.copy.id} item={item.copy} />
              ) : (
                <SeriesCopies key={item.key} series={item} />
              ),
            )}
          </section>
        )}
        {list.data && list.data.ended > 0 && (
          <p className="mt-4 text-[0.8125rem] text-muted-foreground">
            {t("Unfinished downloads ended with their subscription.")}
          </p>
        )}
      </div>
    </div>
  );
}

/** The bar of the page standing alone: Downloads, and the way back to adding a subscription. */
function OfflineBar() {
  return (
    <BarFrame className="bg-black">
      <Brand />
      <PageButton view="downloads" current>
        {t("Downloads")}
      </PageButton>
      <div className="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => openView("home")}>
          {t("Add subscription")}
        </Button>
      </div>
    </BarFrame>
  );
}

/** A copy, finished or with its file gone, rather than something in the queue. */
function onComputer(item: Download): boolean {
  return item.status.kind === "complete" || item.status.kind === "missing";
}

/** Waiting its turn in the queue, paused or not: what Up and Down move. */
function waiting(item: Download): boolean {
  return (
    item.status.kind === "queued" || item.status.kind === "waiting" || item.status.kind === "paused"
  );
}

/**
 * Two or more copies of one series together: a row with its name, its subscription, how many of its
 * episodes and seasons are on this computer and their size, then season by season each copy in the
 * series' order, with the episodes between them that aren't here. The arrow folds the episodes
 * away, and back, in place.
 */
function SeriesCopies({ series }: { series: ShelfSeries }) {
  const [open, setOpen] = useState(true);
  const [newest] = series.copies;
  if (!newest) return null;
  const seasons = new Set(
    series.copies.flatMap(({ title }) => (title.kind === "episode" ? [title.season] : [])),
  );
  const size = series.copies.reduce((sum, copy) => sum + (copy.size ?? 0), 0);
  const facts = [
    newest.subscription?.name ?? t("Subscription removed, copy kept"),
    t("{count} episodes", { count: series.copies.length }),
    t("{count} seasons", { count: seasons.size }),
    size > 0 ? formatBytes(size) : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      role="group"
      aria-label={newest.name}
      data-series={series.key}
      className="border-b border-white/8 last:border-b-0 [&>:last-child]:border-b-0"
    >
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-4 border-b border-white/8 py-3">
        <span className="block aspect-[2/3] overflow-hidden rounded-md">
          <Artwork url={newest.posterUrl} name={newest.name} size="thumb" plain />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-medium">{newest.name}</div>
          <div className="truncate text-xs text-muted-foreground">{facts}</div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={newest.name}
          aria-expanded={open}
          className={cn(open && "text-foreground")}
          onClick={() => setOpen(!open)}
        >
          <ChevronDown className={cn(!open && "-rotate-90")} />
        </Button>
      </div>
      {open &&
        series.seasons.map((season) => (
          <Fragment key={season.key}>
            <div className="mt-2.5 ml-14 text-[0.8125rem] font-semibold">
              {season.number === 0
                ? t("Specials")
                : t("Season {number}", { number: String(season.number) })}
            </div>
            {season.entries.map((entry) =>
              entry.kind === "copy" ? (
                <Row key={entry.copy.id} item={entry.copy} inSeries />
              ) : (
                <Gap
                  key={`gap:${entry.episodes[0]}`}
                  season={season.number}
                  episodes={entry.episodes}
                />
              ),
            )}
          </Fragment>
        ))}
    </div>
  );
}

/** Episodes the series lists between two of its copies, none of which is on this computer. */
function Gap({ season, episodes }: { season: number; episodes: readonly number[] }) {
  const [first = 0] = episodes;
  const last = episodes.at(-1) ?? first;
  return (
    <div className="ml-14 grid grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-4 border-b border-white/8 py-1.5 text-xs text-muted-foreground last:border-b-0">
      <span />
      <span className="truncate">
        {episodes.length > 1
          ? t("{from} to {to} aren't on this computer", {
              from: episodeLabel(season, first),
              to: episodeLabel(season, last),
            })
          : t("{episode} isn't on this computer", { episode: episodeLabel(season, first) })}
      </span>
    </div>
  );
}

function Row({
  item,
  first = false,
  last = false,
  inSeries = false,
}: {
  item: Download;
  /** Whether it is the first, or last, of the downloads waiting their turn. */
  first?: boolean;
  last?: boolean;
  /** A copy among its series' copies, which name the series: it says its number and its name. */
  inSeries?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({ mutationFn: () => call("downloads.remove", { id: item.id }) });
  const retry = useMutation({ mutationFn: () => call("downloads.retry", { id: item.id }) });
  const hold = useMutation({
    mutationFn: (pause: boolean) =>
      pause ? call("downloads.pause", { id: item.id }) : call("downloads.resume", { id: item.id }),
  });
  const move = useMutation({
    mutationFn: (by: -1 | 1) => call("downloads.move", { id: item.id, by }),
  });
  // Pressed again while it is under way, a change does nothing; it isn't disabled meanwhile,
  // which would leave the keyboard on a button that can't be pressed.
  const holding = (pause: boolean) => () => {
    if (hold.isPending) return;
    move.reset();
    hold.mutate(pause);
  };
  const moving = (by: -1 | 1) => () => {
    if (move.isPending) return;
    hold.reset();
    move.mutate(by);
  };
  const { status, title } = item;
  const episode = episodeLine(item);
  const label = title.kind === "episode" ? episodeLabel(title.season, title.episode) : null;
  const numbered = inSeries && title.kind === "episode";
  const name =
    numbered && label
      ? (item.episodeName ?? label)
      : episode
        ? `${item.name} · ${episode}`
        : item.name;
  const copy = onComputer(item);
  const seen =
    status.kind === "complete" &&
    !!item.progress &&
    isFinished(item.progress.position, item.progress.duration);
  const facts = (
    numbered
      ? [item.duration ? runtime(item.duration) : null, seen ? t("Watched") : null]
      : [
          title.kind === "movie" ? item.year : null,
          copy && item.duration ? runtime(item.duration) : null,
          !copy ? item.subscription?.name : null,
          item.size ? formatBytes(item.size) : null,
          copy && !item.subscription ? t("Subscription removed, copy kept") : null,
        ]
  )
    .filter(Boolean)
    .join(" · ");
  const done = transferred(item);
  const watched =
    status.kind === "complete" &&
    item.progress &&
    !isFinished(item.progress.position, item.progress.duration)
      ? item.progress
      : null;
  const line = statusLine(item);
  const failed = status.kind === "failed" || status.kind === "missing";
  const error = remove.error ?? retry.error;
  const unkept = hold.error ?? move.error;
  return (
    <div
      data-download={item.id}
      className={cn(
        "grid items-center gap-4 border-b border-white/8 last:border-b-0",
        numbered
          ? "ml-14 grid-cols-[1.75rem_minmax(0,1fr)_auto] py-1.5"
          : "grid-cols-[2.5rem_minmax(0,1fr)_auto] py-3",
      )}
    >
      {numbered && title.kind === "episode" ? (
        <span className="text-right text-xs text-muted-foreground tabular-nums">
          {title.episode}
        </span>
      ) : (
        <span className="block aspect-[2/3] overflow-hidden rounded-md">
          <Artwork url={item.posterUrl} name={item.name} size="thumb" plain />
        </span>
      )}
      <div className="min-w-0">
        <div className="truncate text-[0.9375rem] font-medium">{name}</div>
        {facts && <div className="truncate text-xs text-muted-foreground">{facts}</div>}
        {(line || watched) && (
          <div
            className={cn(
              "mt-1 flex items-center gap-2 text-[0.8125rem] tabular-nums",
              failed ? "text-destructive" : status.kind === "queued" ? "text-muted-foreground" : "",
            )}
          >
            {done !== null && <Progress value={done} className="w-28" />}
            {watched && (
              <>
                <Progress value={watched.position / watched.duration} className="w-20" />
                <span className="text-muted-foreground">
                  {timeLeftOf({ ...watched, finished: false })}
                </span>
              </>
            )}
            {line && <span className="min-w-0 truncate">{line}</span>}
          </div>
        )}
        {error && (
          <div className="mt-1 text-xs text-destructive">{describeError(appError(error))}</div>
        )}
        {unkept && (
          <div role="alert" className="mt-1 text-xs text-destructive">
            {t("Couldn't save. Try again.")}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {waiting(item) && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Move {name} up", { name })}
              data-move={-1}
              disabled={first}
              onClick={moving(-1)}
            >
              <ArrowUp />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("Move {name} down", { name })}
              data-move={1}
              disabled={last}
              onClick={moving(1)}
            >
              <ArrowDown />
            </Button>
          </>
        )}
        {(waiting(item) || status.kind === "transferring") && (
          <Button size="sm" data-hold onClick={holding(status.kind !== "paused")}>
            {status.kind === "paused" ? (
              <Play className="fill-current" />
            ) : (
              <Pause className="fill-current" />
            )}
            {status.kind === "paused" ? t("Resume download") : t("Pause download")}
          </Button>
        )}
        {status.kind === "complete" && (
          <Button
            variant="primary"
            size="sm"
            aria-label={
              numbered && label ? t("Watch {title} offline", { title: label }) : undefined
            }
            onClick={() => watchOffline(item)}
          >
            <Play className="fill-current" />
            {t("Watch offline")}
          </Button>
        )}
        {status.kind === "failed" && (
          <Button size="sm" disabled={retry.isPending} onClick={() => retry.mutate()}>
            {t("Retry")}
          </Button>
        )}
        {copy || status.kind === "failed" ? (
          <Button
            variant={confirming ? "destructive" : "ghost"}
            size="sm"
            disabled={remove.isPending}
            onBlur={() => setConfirming(false)}
            onClick={() => {
              // A copy goes only on a second press: it took a while to download.
              if (copy && !confirming) return setConfirming(true);
              remove.mutate();
            }}
          >
            {confirming ? t("Delete copy") : t("Delete")}
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t("Cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}
