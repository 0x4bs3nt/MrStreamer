// The quiet notice in the top bar: an update waiting, downloading or ready. It fades with the
// other controls while watching. Clicking it opens a panel with the next step: Download, then
// Restart once it's ready. "Not now" hides the notice for that version; Settings still offers it.
import { RotateCw } from "lucide-react";
import { Tooltip } from "../../components/ui/tooltip.tsx";
import { Popover } from "@base-ui/react/popover";
import type { UpdateStatus } from "@mrstreamer/contracts/updates";
import { formatPercent, t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { Button } from "../../components/ui/button.tsx";
import { noteItems } from "./notes.ts";
import { useUpdates } from "./use-updates.ts";

/** How many lines of the notes the panel shows before pointing to Settings. */
const NOTE_LINES = 4;

/** Whether the top bar shows the notice at all. */
function noticed(status: UpdateStatus): boolean {
  const { update, dismissed } = status;
  switch (update.kind) {
    case "downloading":
    case "ready":
      return true;
    case "available":
      return dismissed !== update.version;
    case "failed":
      return update.step !== "check" && dismissed !== update.version;
    default:
      return false;
  }
}

/** The visible notice's words, also used by the window bar when retrying its full labels. */
export function updateNoticeLabel(
  status: UpdateStatus | undefined,
  open: boolean,
): string | undefined {
  if (!status || (!noticed(status) && !open)) return undefined;
  const { update } = status;
  return update.kind === "downloading"
    ? `${t("Updating")} · ${formatPercent(update.percent / 100)}`
    : update.kind === "ready"
      ? t("Restart to update")
      : update.kind === "failed"
        ? t("Update stopped")
        : t("Update");
}

/** The same popover trigger retains focus when the bar folds its words into a tooltip. */
export function UpdateNotice({ compact = false }: { compact?: boolean }) {
  const { status } = useUpdates();
  const open = useUi((state) => state.updateDialog === "panel");
  const label = updateNoticeLabel(status, open);
  if (!status || !label) return null;
  const { update } = status;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => useUi.setState({ updateDialog: next ? "panel" : null })}
    >
      <Tooltip label={label} side="bottom" disabled={!compact}>
        <Popover.Trigger
          render={
            <Button
              variant="ghost"
              size={compact ? "icon-sm" : "sm"}
              className="text-white"
              aria-label={label}
              data-update-notice
            >
              {compact && <RotateCw />}
              {update.kind === "available" && (
                <span
                  aria-hidden
                  className={
                    compact
                      ? "absolute top-1 right-1 size-1.5 rounded-full bg-white"
                      : "size-1.5 rounded-full bg-white"
                  }
                />
              )}
              {!compact && label}
            </Button>
          }
        />
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Popover.Popup className="no-drag w-[22rem] rounded-2xl bg-popover p-5 text-[0.9375rem] shadow-2xl ring-1 ring-white/12 outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            <UpdatePanel status={status} />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function UpdatePanel({ status }: { status: UpdateStatus }) {
  const { download, cancel, restart, dismiss } = useUpdates();
  const { update, offer, channel } = status;
  const version = "version" in update ? update.version : (offer?.version ?? "");
  const notes = noteItems(offer?.notes ?? null);
  const close = () => useUi.setState({ updateDialog: null });
  const later = () => {
    if (version) dismiss(version);
    close();
  };
  return (
    <>
      <div className="text-lg font-semibold tracking-tight">Mr. Streamer {version}</div>
      <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">
        {channel === "nightly" ? t("Nightly") : t("Stable")}
      </div>
      {notes.length > 0 && (
        <ul className="mt-3 list-disc space-y-1 pl-5 text-[0.875rem] text-foreground/85">
          {notes.slice(0, NOTE_LINES).map((item) => (
            <li key={item.text}>{item.text}</li>
          ))}
        </ul>
      )}
      {update.kind === "downloading" && (
        <div className="mt-4">
          <div className="h-1 overflow-hidden rounded-full bg-white/12">
            <div className="h-full bg-white" style={{ width: `${update.percent}%` }} />
          </div>
          <div className="mt-1.5 text-[0.8125rem] text-muted-foreground">
            {t("Downloading")} · {formatPercent(update.percent / 100)}
          </div>
        </div>
      )}
      {update.kind === "failed" && update.step !== "check" && (
        <p className="mt-3 text-sm text-destructive">{update.detail}</p>
      )}
      <div className="mt-5 flex items-center gap-2">
        {update.kind === "available" && (
          <>
            <Button variant="primary" size="sm" onClick={download}>
              {t("Download")}
            </Button>
            <Button variant="ghost" size="sm" onClick={later}>
              {t("Not now")}
            </Button>
          </>
        )}
        {update.kind === "downloading" && (
          <Button variant="secondary" size="sm" onClick={cancel}>
            {t("Cancel")}
          </Button>
        )}
        {update.kind === "ready" && (
          <>
            <Button variant="primary" size="sm" onClick={restart}>
              {t("Restart")}
            </Button>
            <Button variant="ghost" size="sm" onClick={close}>
              {t("Later")}
            </Button>
          </>
        )}
        {update.kind === "failed" && update.step !== "check" && (
          <Button variant="primary" size="sm" onClick={download}>
            {t("Try again")}
          </Button>
        )}
        <button
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => useUi.setState({ settings: "general", updateDialog: null })}
          className="ml-auto text-[0.8125rem] text-muted-foreground hover:text-white"
        >
          {t("Release notes")} ›
        </button>
      </div>
      {update.kind === "ready" && (
        <p className="mt-3 text-[0.8125rem] text-muted-foreground">
          {t("Playback stops for a moment while Mr. Streamer restarts.")}
        </p>
      )}
    </>
  );
}
