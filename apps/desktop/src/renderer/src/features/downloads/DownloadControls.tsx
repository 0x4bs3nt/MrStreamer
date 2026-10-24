// Download in a title's details: beside a movie's Play and Watchlist, and as an icon on each
// episode's row. One control says how the download of that exact version stands and does the one
// thing that fits: Download, Cancel while it is queued or transfers, Retry after it failed, and
// Watch offline once it is on this computer, with Delete in the menu beside it. There is no
// automatic download of future episodes.
import { Menu } from "@base-ui/react/menu";
import type { ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowDownToLine,
  Check,
  ChevronDown,
  Play,
  RotateCw,
  Square,
  TriangleAlert,
  X,
} from "lucide-react";
import type { Download, DownloadFailure } from "@mrstreamer/contracts/downloads";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import { formatBytes, formatPercent, t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { Progress } from "../../components/Progress.tsx";
import { Button } from "../../components/ui/button.tsx";
import { menuItem, menuSurface } from "../../components/ui/menu.ts";
import { describeFailure, transferred, useDownloadOf, watchOffline } from "../../lib/downloads.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { cn } from "../../lib/utils.ts";

/** What happens to a version's download from its details, and why the last of it failed. */
function useDownload(title: TitleRef) {
  const download = useDownloadOf(title.subscriptionId, title);
  const add = useMutation({ mutationFn: () => call("downloads.add", { title }) });
  const remove = useMutation({
    mutationFn: (id: string) => call("downloads.remove", { id }),
  });
  const retry = useMutation({ mutationFn: (id: string) => call("downloads.retry", { id }) });
  const error = add.error ?? remove.error ?? retry.error;
  return {
    download,
    busy: add.isPending || remove.isPending || retry.isPending,
    add: () => add.mutate(),
    remove: (id: string) => remove.mutate(id),
    retry: (id: string) => retry.mutate(id),
    error: error ? describeError(appError(error)) : null,
  };
}

/** A failure in a word or two, for a button; the Downloads page says it whole. */
function shortly(failure: DownloadFailure): string {
  switch (failure.kind) {
    case "disk-full":
      return t("Disk full");
    case "folder":
      return t("Can't write");
    case "stream":
      return failure.failure.kind === "refused" ? t("Refused") : t("Stopped");
    case "app":
      return t("Stopped");
  }
}

/** A movie's Download, beside Play and Watchlist. */
export function MovieDownload({ title }: { title: TitleRef }) {
  const { download, busy, add, remove, retry, error } = useDownload(title);
  return (
    <>
      <DownloadPill faces={<MovieFaces />}>
        <span className="flex min-w-0 [&>button]:w-full [&>button]:px-4">
          <MovieState download={download} busy={busy} add={add} remove={remove} retry={retry} />
        </span>
      </DownloadPill>
      {error && <p className="order-last basis-full text-sm text-destructive">{error}</p>}
    </>
  );
}

/** The widest translated face reserves space, so changing state never moves Save. */
export function DownloadPill({ faces, children }: { faces: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-grid min-w-[200px] max-w-full flex-none grid-cols-[minmax(0,1fr)] [&>*]:[grid-area:1/1]">
      <span aria-hidden className="invisible grid min-w-0 overflow-hidden [&>*]:[grid-area:1/1]">
        {faces}
      </span>
      {children}
    </span>
  );
}

/** These spans use the real control styles and never receive input or accessibility focus. */
function MovieFaces() {
  return (
    <>
      <Button render={<span />} size="lg" className="px-4">
        <ArrowDownToLine />
        {t("Download")}
      </Button>
      {(["Queued", "Waiting for playback"] as const).map((label) => (
        <Button key={label} render={<span />} size="lg" className="px-4">
          {t(label)} · {t("Cancel")}
        </Button>
      ))}
      <Button render={<span />} size="lg" className="px-4 tabular-nums">
        <Progress value={1} className="w-12" />
        {formatPercent(1)}
      </Button>
      <Button render={<span />} size="lg" className="px-4">
        {t("Downloading")}
      </Button>
      {(["Disk full", "Can't write", "Refused", "Stopped"] as const).map((label) => (
        <Button key={label} render={<span />} size="lg" variant="destructive" className="px-4">
          <RotateCw />
          {t(label)} · {t("Retry")}
        </Button>
      ))}
      <Button render={<span />} size="lg" variant="destructive" className="px-4">
        {t("File missing")} · {t("Delete")}
      </Button>
      <span className="flex">
        <Button render={<span />} size="lg" className="rounded-r-none px-3">
          <Play className="fill-current" />
          {t("Watch offline")}
        </Button>
        <Button
          render={<span />}
          size="lg"
          className="rounded-l-none border-l border-black/40 px-3"
        >
          <ChevronDown />
        </Button>
      </span>
    </>
  );
}

function MovieState({
  download,
  busy,
  add,
  remove,
  retry,
}: {
  download: Download | null;
  busy: boolean;
  add: () => void;
  remove: (id: string) => void;
  retry: (id: string) => void;
}) {
  if (!download) {
    return (
      <Button variant="secondary" size="lg" disabled={busy} onClick={add}>
        <ArrowDownToLine />
        <span className="min-w-0 truncate">{t("Download")}</span>
      </Button>
    );
  }
  const { status, id } = download;
  switch (status.kind) {
    case "queued":
    case "waiting":
      return (
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          aria-label={
            status.kind === "queued"
              ? t("Queued, cancel download")
              : t("Waiting for playback, cancel download")
          }
          onClick={() => remove(id)}
        >
          <span className="min-w-0 truncate">
            {status.kind === "queued" ? t("Queued") : t("Waiting for playback")} · {t("Cancel")}
          </span>
        </Button>
      );
    case "transferring": {
      const done = transferred(download);
      const percent = done === null ? null : formatPercent(Math.floor(done * 100) / 100);
      return (
        <Button
          variant="secondary"
          size="lg"
          disabled={busy}
          aria-label={
            percent === null
              ? t("Downloading, cancel download")
              : t("Downloading {percent}, cancel download", { percent })
          }
          onClick={() => remove(id)}
          className="tabular-nums"
        >
          {done !== null && <Progress value={done} className="w-12" />}
          <span className="min-w-0 truncate">{percent ?? t("Downloading")}</span>
        </Button>
      );
    }
    case "failed":
      return (
        <Button
          variant="destructive"
          size="lg"
          disabled={busy}
          aria-label={t("{reason} Retry download", { reason: describeFailure(status.failure) })}
          onClick={() => retry(id)}
        >
          <RotateCw />
          <span className="min-w-0 truncate">
            {shortly(status.failure)} · {t("Retry")}
          </span>
        </Button>
      );
    case "missing":
      return (
        <Button variant="destructive" size="lg" disabled={busy} onClick={() => remove(id)}>
          <span className="min-w-0 truncate">
            {t("File missing")} · {t("Delete")}
          </span>
        </Button>
      );
    case "complete":
      return (
        <span className="flex w-full">
          <Button
            variant="secondary"
            size="lg"
            onClick={() => watchOffline(download)}
            className="min-w-0 flex-1 rounded-r-none px-3"
          >
            <Play className="fill-current" />
            <span className="min-w-0 truncate">{t("Watch offline")}</span>
          </Button>
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button
                  variant="secondary"
                  size="lg"
                  aria-label={t("Download options")}
                  className="rounded-l-none border-l border-black/40 px-3"
                />
              }
            >
              <ChevronDown />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
                <Menu.Popup className={cn(menuSurface, "text-[0.875rem] text-white")}>
                  <Menu.Item
                    closeOnClick
                    onClick={() => remove(id)}
                    className={cn(menuItem, "px-2 py-2")}
                  >
                    {t("Delete download")}
                  </Menu.Item>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </span>
      );
  }
}

/** Every episode action keeps the same icon target; its state is written in the facts line. */
export function EpisodeDownload({ title }: { title: Extract<TitleRef, { kind: "episode" }> }) {
  const { download, busy, add, remove, retry, error } = useDownload(title);
  const label = episodeLabel(title.season, title.episode);
  const shared = {
    variant: "ghost",
    size: "icon-sm",
    disabled: busy,
    title: error ?? undefined,
  } as const;
  if (!download) {
    return (
      <Button
        {...shared}
        size="icon-sm"
        aria-label={t("Download {title}", { title: label })}
        onClick={add}
      >
        <ArrowDownToLine />
      </Button>
    );
  }
  const { status, id } = download;
  switch (status.kind) {
    case "complete":
      return (
        <Button
          {...shared}
          aria-label={t("Watch {title} offline", { title: label })}
          onClick={() => watchOffline(download)}
        >
          <Check />
        </Button>
      );
    case "queued":
    case "waiting":
      return (
        <Button
          {...shared}
          aria-label={t("Cancel download of {title}", { title: label })}
          onClick={() => remove(id)}
        >
          <X />
        </Button>
      );
    case "transferring": {
      return (
        <Button
          {...shared}
          aria-label={t("Cancel download of {title}", { title: label })}
          onClick={() => remove(id)}
          className="tabular-nums"
        >
          <Square />
        </Button>
      );
    }
    case "failed":
      return (
        <Button
          {...shared}
          aria-label={t("{reason} Retry download of {title}", {
            reason: describeFailure(status.failure),
            title: label,
          })}
          onClick={() => retry(id)}
          className="text-destructive"
        >
          <RotateCw />
        </Button>
      );
    case "missing":
      return (
        <Button
          {...shared}
          aria-label={t("Download of {title} missing, delete it", { title: label })}
          onClick={() => remove(id)}
          className="text-destructive"
        >
          <TriangleAlert />
        </Button>
      );
  }
}

/** The existing download states as short words, beside an episode's date and duration. */
export function EpisodeDownloadStatus({ download }: { download: Download | null }) {
  if (!download) return null;
  const { status } = download;
  const label =
    status.kind === "complete"
      ? t("Downloaded")
      : status.kind === "queued"
        ? t("Queued")
        : status.kind === "waiting"
          ? t("Waiting")
          : status.kind === "failed"
            ? shortly(status.failure)
            : status.kind === "missing"
              ? t("Missing")
              : transferred(download) === null
                ? [t("Downloading"), status.received > 0 ? formatBytes(status.received) : null]
                    .filter(Boolean)
                    .join(" ")
                : t("Downloading {percent}", {
                    percent: formatPercent(Math.floor(transferred(download)! * 100) / 100),
                  });
  return (
    <span
      className={
        status.kind === "failed" || status.kind === "missing"
          ? "max-w-[60%] flex-none truncate text-destructive"
          : "max-w-[60%] flex-none truncate text-white tabular-nums"
      }
      title={status.kind === "failed" ? describeFailure(status.failure) : label}
    >
      {label}
    </span>
  );
}
