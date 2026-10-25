// Whole-series queueing uses the details' selected provider version and the exact file each
// episode row plays. The main process owns persistence, deduplication and transfer scheduling.
import { Menu } from "@base-ui/react/menu";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import type { SeriesDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { TitleProgress, EpisodeMark } from "@mrstreamer/contracts/viewing";
import { episodeFileVersion, seriesEpisodeOrder } from "@mrstreamer/core/ondemand/details";
import { episodeStates } from "@mrstreamer/core/viewing/episodes";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { t } from "@mrstreamer/core/i18n";
import { openView } from "../../app/ui-store.ts";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { downloadOf, downloadsQuery, transferred } from "../../lib/downloads.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";
import { episodeRef } from "../../player/title-player.ts";
import { DownloadPill } from "./DownloadControls.tsx";

/** In the queue, paused or not: already queued for the series' counts, and what Cancel the rest ends. */
const queued = (download: Download) =>
  ["queued", "waiting", "paused", "transferring"].includes(download.status.kind);
type Result = {
  readonly revision: number;
  readonly added: number;
  readonly attempted: number;
  readonly complete: number;
  readonly queued: number;
  readonly failures: readonly {
    readonly title: Extract<TitleRef, { kind: "episode" }>;
    readonly reason: string;
  }[];
};

/** Mount with the selected series' identity as key, so switching it stops further additions. */
export function SeriesDownload({
  details,
  progress,
  marks,
  version,
  disabled = false,
}: {
  details: SeriesDetails;
  progress: readonly TitleProgress[];
  marks: readonly EpisodeMark[];
  version: string;
  disabled?: boolean;
}) {
  const client = useQueryClient();
  const titles = useMemo(() => {
    const stateOf = episodeStates(progress, marks);
    return seriesEpisodeOrder(details).map((episode) => {
      const state = stateOf(episode);
      return episodeRef(
        episodeFileVersion(episode, state.kind === "partial" ? state.progress.title.id : undefined),
      );
    });
  }, [details, progress, marks]);
  const select = useCallback(
    (list: DownloadList) => titles.map((title) => downloadOf(list, title)),
    [titles],
  );
  const list = useQuery({ ...downloadsQuery(), select });
  const files = list.data ?? [];
  const complete = files.filter((file) => file?.status.kind === "complete").length;
  const active = files.filter((file) => file && queued(file)).length;
  const failed = files.filter((file) => file?.status.kind === "failed").length;
  const eligible = titles.filter(
    (_, index) =>
      !files[index] ||
      files[index]?.status.kind === "failed" ||
      files[index]?.status.kind === "missing",
  );
  const [busy, setBusy] = useState(false);
  const [queueResult, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selection = useMemo(() => JSON.stringify(titles), [titles]);
  const life = useRef({ mounted: true, busy: false, selection, disabled, revision: 0 });
  if (life.current.selection !== selection || life.current.disabled !== disabled) {
    life.current.revision++;
    life.current.selection = selection;
    life.current.disabled = disabled;
  }
  // Feedback and Retry describe only the files selected when that operation started.
  const result = queueResult?.revision === life.current.revision ? queueResult : null;
  useEffect(() => {
    life.current.mounted = true;
    return () => {
      life.current.mounted = false;
    };
  }, []);

  async function queue(selected: readonly Extract<TitleRef, { kind: "episode" }>[]) {
    if (life.current.busy || disabled || !list.data) return;
    life.current.busy = true;
    setBusy(true);
    setError(null);
    const selectedScope = life.current.revision;
    let added = 0;
    let skippedComplete = 0;
    let skippedQueued = 0;
    let attempted = 0;
    const failures: Result["failures"][number][] = [];
    // Read at confirmation and again between calls. Download events can change the queue while
    // a previous file is being resolved. A submitted call may finish after this view unmounts.
    for (const title of selected) {
      if (!life.current.mounted || life.current.disabled || life.current.revision !== selectedScope)
        break;
      const current = downloadOf(client.getQueryData(downloadsQuery().queryKey), title);
      if (current?.status.kind === "complete") {
        skippedComplete++;
        continue;
      }
      if (current && queued(current)) {
        skippedQueued++;
        continue;
      }
      attempted++;
      try {
        if (current?.status.kind === "failed") await call("downloads.retry", { id: current.id });
        else {
          // A missing copy has to be deleted before the existing Add can replace its record.
          if (current?.status.kind === "missing")
            await call("downloads.remove", { id: current.id });
          if (
            !life.current.mounted ||
            life.current.disabled ||
            life.current.revision !== selectedScope
          )
            break;
          await call("downloads.add", { title });
        }
        added++;
      } catch (cause) {
        failures.push({ title, reason: describeError(appError(cause)) });
      }
      if (life.current.mounted && life.current.revision === selectedScope)
        setResult({
          revision: selectedScope,
          added,
          attempted,
          complete: skippedComplete,
          queued: skippedQueued,
          failures: [...failures],
        });
    }
    life.current.busy = false;
    if (life.current.mounted) {
      if (life.current.revision === selectedScope)
        setResult({
          revision: selectedScope,
          added,
          attempted,
          complete: skippedComplete,
          queued: skippedQueued,
          failures,
        });
      setBusy(false);
      // Also reconcile a successful answer if an event was missed while the list first loaded.
      void client.invalidateQueries({ queryKey: downloadsQuery().queryKey });
    }
  }
  async function cancel() {
    if (life.current.busy) return;
    life.current.busy = true;
    setBusy(true);
    setError(null);
    const errors: string[] = [];
    for (const title of titles) {
      if (!life.current.mounted) break;
      const current = downloadOf(client.getQueryData(downloadsQuery().queryKey), title);
      if (!current || !queued(current)) continue;
      try {
        await call("downloads.remove", { id: current.id });
      } catch (cause) {
        errors.push(describeError(appError(cause)));
      }
    }
    life.current.busy = false;
    if (life.current.mounted) {
      setBusy(false);
      setError(errors.join(" ") || null);
    }
  }
  const label =
    active > 0 || failed > 0
      ? failed > 0
        ? t("{done} of {total} · {count} failed", {
            done: complete,
            total: titles.length,
            count: failed,
          })
        : t("{done} of {count}", { done: complete, count: titles.length })
      : complete === titles.length && titles.length > 0
        ? t("Downloaded")
        : complete > 0 && eligible.length > 0
          ? t("Download {count} new", { count: eligible.length })
          : t("Download");
  const done =
    titles.length > 0
      ? (complete + files.reduce((sum, file) => sum + (file ? (transferred(file) ?? 0) : 0), 0)) /
        titles.length
      : 0;
  const scope = details.seasons.map((season) => season.name).join(", ");
  const itemClass = cn(menuItem, "px-2 py-2 data-disabled:opacity-40");
  return (
    <>
      <Menu.Root>
        <DownloadPill faces={<SeriesFaces count={titles.length} />}>
          <Menu.Trigger
            render={
              <Button
                variant={failed > 0 ? "destructive" : "secondary"}
                size="lg"
                disabled={disabled}
                className="w-full min-w-0 px-4"
                aria-label={`${t("Download options")}: ${label}`}
                title={label}
              />
            }
          >
            {complete === titles.length && titles.length > 0 ? (
              <Check />
            ) : active > 0 ? (
              <Progress value={done} className="w-8 flex-none" />
            ) : (
              <ArrowDownToLine />
            )}
            <span className="min-w-0 truncate tabular-nums">{label}</span>
            <ChevronDown className="flex-none" />
          </Menu.Trigger>
        </DownloadPill>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Menu.Popup
              className={cn(
                menuSurface,
                "max-h-[min(60vh,var(--available-height))] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto text-sm text-white",
              )}
            >
              <div className="px-2 pt-1 pb-3">
                <p className="font-semibold">{scope}</p>
                <p className="mt-1 text-xs text-white/60">{version}</p>
              </div>
              <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 px-2 pb-3 text-[0.8125rem] tabular-nums">
                <dt>{t("To download")}</dt>
                <dd>{eligible.length}</dd>
                <dt className="text-white/60">{t("Already downloaded")}</dt>
                <dd className="text-white/60">{complete}</dd>
                <dt className="text-white/60">{t("Already queued")}</dt>
                <dd className="text-white/60">{active}</dd>
              </dl>
              {list.error && (
                <p role="alert" className="px-2 pb-2 text-destructive">
                  {describeError(appError(list.error))}
                </p>
              )}
              <Menu.Item
                nativeButton
                render={<Button variant="primary" className="w-full" />}
                disabled={busy || !list.data || eligible.length === 0}
                closeOnClick
                onClick={() => void queue(titles)}
              >
                {t("Download {count} episodes", { count: eligible.length })}
              </Menu.Item>
              {(failed > 0 || !!result?.failures.length) && (
                <Menu.Item
                  disabled={busy || !list.data}
                  closeOnClick
                  className={itemClass}
                  onClick={() => {
                    const current = client.getQueryData(downloadsQuery().queryKey);
                    void queue(
                      titles.filter(
                        (title) =>
                          downloadOf(current, title)?.status.kind === "failed" ||
                          result?.failures.some((failure) => failure.title.id === title.id),
                      ),
                    );
                  }}
                >
                  {t("Retry failed")}
                </Menu.Item>
              )}
              {active > 0 && (
                <Menu.Item
                  disabled={busy}
                  closeOnClick
                  className={itemClass}
                  onClick={() => void cancel()}
                >
                  {t("Cancel the rest")}
                </Menu.Item>
              )}
              <Menu.Separator className="my-2 border-t border-white/15" />
              <Menu.Item closeOnClick className={itemClass} onClick={() => openView("downloads")}>
                {t("Open Downloads")}
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {result && (
        <p role="status" className="order-last basis-full text-[0.8125rem] text-white/70">
          {result.failures.length > 0
            ? t("Queued {added} of {attempted}. {count} couldn't be added: {episodes}.", {
                added: result.added,
                attempted: result.attempted,
                count: result.failures.length,
                episodes: result.failures
                  .map(({ title }) => episodeLabel(title.season, title.episode))
                  .join(", "),
              })
            : t(
                "Queued {count} episodes. {complete} already downloaded, {queued} already queued.",
                { count: result.added, complete: result.complete, queued: result.queued },
              )}
          {result.failures.length > 0 && (
            <button
              disabled={busy}
              title={result.failures.map(({ reason }) => reason).join(" ")}
              className="ml-2 underline underline-offset-4"
              onClick={() => void queue(result.failures.map(({ title }) => title))}
            >
              {t("Retry")}
            </button>
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="order-last basis-full text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** All figures fit the selected version's episode count; state changes keep the same width. */
function SeriesFaces({ count }: { count: number }) {
  return (
    <>
      {[
        {
          label: t("{done} of {total} · {count} failed", { done: count, total: count, count }),
          mark: <Progress value={1} className="w-8 flex-none" />,
        },
        {
          label: t("{done} of {count}", { done: count, count }),
          mark: <Progress value={1} className="w-8 flex-none" />,
        },
        { label: t("Downloaded"), mark: <Check /> },
        { label: t("Download {count} new", { count }), mark: <ArrowDownToLine /> },
        { label: t("Download"), mark: <ArrowDownToLine /> },
      ].map(({ label, mark }) => (
        <Button key={label} render={<span />} size="lg" className="px-4 tabular-nums">
          {mark}
          <span>{label}</span>
          <ChevronDown className="flex-none" />
        </Button>
      ))}
    </>
  );
}
