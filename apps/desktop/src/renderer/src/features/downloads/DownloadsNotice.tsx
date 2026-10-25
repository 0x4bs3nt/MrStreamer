// Downloads in the top bar, as quiet as the update notice: the arrow and how far the one transfer
// is, else that the next download waits for playback or is queued, else that the viewer paused
// what is left, else that one stopped, until Retry or Delete on the Downloads page. The bar reads what it says from the list main keeps
// current (`useDownloadsStatus`), so nothing is asked while a transfer runs, and renders again only
// when what it says changes. Pressing it opens Downloads, leaving a title that plays as its Back
// does. Enter and Space on it press it, as on any button: the players' keys leave both to it
// (`pressesDownloads`).
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine } from "lucide-react";
import type { DownloadList } from "@mrstreamer/contracts/downloads";
import { formatBytes, formatPercent, t } from "@mrstreamer/core/i18n";
import { leaveTitle, openView, useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { downloadsQuery } from "../../lib/downloads.ts";
import { cn } from "../../lib/utils.ts";

/** What the notice says, in no language yet: the window can change its language meanwhile. */
type Progress =
  /** Floored, so a transfer never reads 100% before it is complete. */
  | { readonly kind: "percent"; readonly percent: number }
  /** The provider didn't say the size: bytes so far, none at the start. */
  | { readonly kind: "received"; readonly bytes: number }
  | { readonly kind: "waiting" | "queued" | "paused" | "stopped" };

/**
 * The download the bar speaks for: the transfer, else the first that waits, else the first queued,
 * else a paused one. A failure speaks only when nothing else is left, and only while Retry can
 * still reach its subscription. Copies, complete or with their file gone, say nothing.
 */
function progressOf({ items }: DownloadList): Progress | null {
  for (const { status } of items) {
    if (status.kind !== "transferring") continue;
    return status.size
      ? { kind: "percent", percent: Math.floor((status.received / status.size) * 100) }
      : { kind: "received", bytes: status.received };
  }
  for (const kind of ["waiting", "queued", "paused"] as const) {
    if (items.some((item) => item.status.kind === kind)) return { kind };
  }
  return items.some((item) => item.status.kind === "failed" && item.subscription)
    ? { kind: "stopped" }
    : null;
}

function words(progress: Progress): string {
  switch (progress.kind) {
    case "percent":
      return formatPercent(progress.percent / 100);
    case "received":
      return progress.bytes > 0 ? formatBytes(progress.bytes) : t("Starting");
    case "waiting":
      return t("Waiting");
    case "queued":
      return t("Queued");
    case "paused":
      return t("Paused");
    case "stopped":
      return t("Download stopped");
  }
}

/** What the notice says, in the window's language; `quiet` unless it tells of a transfer or a failure. */
export type DownloadsStatus = { readonly text: string; readonly quiet: boolean };

/** What the notice says now, or null while there is nothing to say. */
export function useDownloadsStatus(): DownloadsStatus | null {
  // Only what the notice says: a progress event that changes nothing else renders nothing.
  const progress = useQuery({ ...downloadsQuery(), select: progressOf }).data;
  if (!progress) return null;
  return {
    text: words(progress),
    quiet: progress.kind === "waiting" || progress.kind === "queued" || progress.kind === "paused",
  };
}

/** Opens Downloads over whatever is on screen; a title playing gives way first, saving its place. */
export function openDownloads(): void {
  if (useUi.getState().playingTitle) leaveTitle();
  openView("downloads");
}

/** Whether `event` is Enter or Space on the notice, which it takes itself to open Downloads. */
export function pressesDownloads(event: KeyboardEvent): boolean {
  return (
    (event.key === "Enter" || event.key === " ") &&
    event.target instanceof Element &&
    event.target.closest("[data-downloads-notice]") !== null
  );
}

/**
 * The notice beside Search, saying `status`. As `page`, it is Downloads' own button where the bar
 * folds the page's name away: shown always, marked while Downloads is on screen, with the notice's
 * words when there are any. Otherwise it shows only while there is something to say. `compact`
 * leaves the arrow alone where the bar has no room for the words, which then show on hover and
 * focus. It stays the same button either way, so one in focus stays in focus as the words go.
 */
export function DownloadsNotice({
  status,
  page = false,
  current = false,
  compact = false,
}: {
  status: DownloadsStatus | null;
  page?: boolean;
  current?: boolean;
  compact?: boolean;
}) {
  if (!status && !page) return null;
  return (
    <Tooltip label={status?.text ?? t("Downloads")} side="bottom" disabled={!compact}>
      <Button
        variant={current ? "secondary" : "ghost"}
        size={status && !compact ? "sm" : "icon-sm"}
        aria-label={status ? t("Downloads, {status}", { status: status.text }) : t("Downloads")}
        aria-current={current ? "page" : undefined}
        data-downloads-notice
        className={cn(
          status && "tabular-nums",
          status && (status.quiet ? "text-muted-foreground" : "text-white"),
        )}
        onClick={openDownloads}
      >
        <ArrowDownToLine />
        {!compact && status?.text}
      </Button>
    </Tooltip>
  );
}
