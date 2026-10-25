// Downloads as the window reads and changes them. The main process keeps the queue and the
// copies and says when they change (`downloads.changed`), so the list is never asked for again
// while the window is open. A download names the exact version it was made of: details find
// theirs by the subscription that lists it now and the provider's ids.
import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { Download, DownloadFailure, DownloadList } from "@mrstreamer/contracts/downloads";
import type { RawTitleRef } from "@mrstreamer/contracts/ondemand";
import { formatBytes, formatPercent, t } from "@mrstreamer/core/i18n";
import { useUi } from "../app/ui-store.ts";
import { copyNow, titlePlayer } from "../player/title-player.ts";
import { describeError } from "./errors.ts";
import { call, listen } from "./ipc.ts";
import { minutesLeft } from "./format.ts";

export const downloadsQuery = () =>
  queryOptions({
    queryKey: ["downloads"],
    queryFn: () => call("downloads.list"),
    staleTime: Infinity,
  });

/** Keeps the list current: every change, and a transfer's progress, arrives as an event. */
export function syncDownloads(client: QueryClient): () => void {
  return listen("downloads.changed", (list) => {
    // A read still under way holds an older list than this: it must not land after it.
    void client.cancelQueries({ queryKey: downloadsQuery().queryKey, exact: true });
    client.setQueryData(downloadsQuery().queryKey, list);
  });
}

export function useDownloads() {
  return useQuery(downloadsQuery());
}

type FileIndex = Map<string, Map<RawTitleRef["kind"], Map<string, Download>>>;
const filesBySnapshot = new WeakMap<DownloadList, FileIndex>();

/** Exact files in this immutable full snapshot. Detached copies have no current subscription. */
export function downloadOf(
  list: DownloadList | undefined,
  title: Pick<RawTitleRef, "kind" | "id"> & { readonly subscriptionId: string },
): Download | null {
  if (!list) return null;
  let index = filesBySnapshot.get(list);
  if (!index) {
    index = new Map();
    for (const file of list.items) {
      if (!file.subscription) continue;
      let subscription = index.get(file.subscription.id);
      if (!subscription) index.set(file.subscription.id, (subscription = new Map()));
      let kind = subscription.get(file.title.kind);
      if (!kind) subscription.set(file.title.kind, (kind = new Map()));
      // Keep the same first match as the list's previous find, even for duplicate records.
      if (!kind.has(file.title.id)) kind.set(file.title.id, file);
    }
    filesBySnapshot.set(list, index);
  }
  return index.get(title.subscriptionId)?.get(title.kind)?.get(title.id) ?? null;
}

/**
 * The download of an exact movie or episode version of `subscriptionId`, or null: one made of it
 * while another subscription of that account was saved counts too, as the list names it by the
 * subscription it is of now.
 */
export function useDownloadOf(
  subscriptionId: string,
  title: Pick<RawTitleRef, "kind" | "id">,
): Download | null {
  const { kind, id } = title;
  const select = useCallback(
    (list: DownloadList) => downloadOf(list, { subscriptionId, kind, id }),
    [subscriptionId, kind, id],
  );
  return useQuery({ ...downloadsQuery(), select }).data ?? null;
}

/**
 * Plays a copy over everything, from where it was left, or from its start once it was watched.
 * The player takes where from main as the copy opens: this list may not have the last save yet.
 */
export function watchOffline(download: Download): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(copyNow(download), 0);
}

/** Why a download stopped, in one sentence, with what to do about it. */
export function describeFailure(failure: DownloadFailure): string {
  switch (failure.kind) {
    case "disk-full":
      return failure.needed === null
        ? t("Disk full. Free some space, then retry.")
        : t("Disk full. Free {size}, then retry.", { size: formatBytes(failure.needed) });
    case "folder":
      return t("The downloads folder can't be written. Retry, or check the disk.");
    case "stream":
      return describeError({ kind: "stream", failure: failure.failure });
    case "app":
      return describeError(failure.error);
  }
}

/** How a download stands, as its row says it under the title. */
export function statusLine(download: Download): string {
  const { status } = download;
  switch (status.kind) {
    case "queued":
      return t("Queued");
    case "waiting":
      return download.subscription
        ? t("Waiting while {subscription} plays", { subscription: download.subscription.name })
        : t("Waiting for playback");
    case "paused":
      if (status.received === 0) return t("Paused");
      return [
        t("Paused"),
        status.size
          ? t("{received} of {size}", {
              received: formatBytes(status.received),
              size: formatBytes(status.size),
            })
          : formatBytes(status.received),
      ].join(" · ");
    case "transferring": {
      if (status.size === null || status.size === 0) {
        return status.received > 0 ? formatBytes(status.received) : t("Starting");
      }
      const left =
        status.rate && status.rate > 0 ? (status.size - status.received) / status.rate : null;
      return [
        formatPercent(Math.floor((status.received / status.size) * 100) / 100),
        t("{received} of {size}", {
          received: formatBytes(status.received),
          size: formatBytes(status.size),
        }),
        left !== null ? minutesLeft(Math.max(1, Math.round(left / 60))) : null,
        status.restarted ? t("started again, the file changed") : null,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "failed":
      return describeFailure(status.failure);
    case "complete":
      return "";
    case "missing":
      return t("The file is no longer on this computer.");
  }
}

/** How far a transfer is, or got before it was paused, from 0 to 1, when its size is known. */
export function transferred(download: Download): number | null {
  const { status } = download;
  return (status.kind === "transferring" || status.kind === "paused") && status.size
    ? status.received / status.size
    : null;
}
