import { distributionLabel } from "../updates/distribution.ts";
import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatNumber, t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { call } from "../../lib/ipc.ts";

/** A local preview under About. Save uses its id, so the file exactly matches the shown text. */
export function DiagnosticsExport() {
  const opener = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [showText, setShowText] = useState(false);
  const preview = useMutation({ mutationFn: () => call("diagnostics.preview") });
  const save = useMutation({ mutationFn: (id: string) => call("diagnostics.save", { id }) });
  const report = preview.data;
  useEffect(() => {
    if (report) heading.current?.focus();
  }, [report]);
  const close = () => {
    preview.reset();
    save.reset();
    setShowText(false);
    opener.current?.focus();
  };
  return (
    <>
      <Button
        ref={opener}
        variant="secondary"
        disabled={preview.isPending}
        onClick={() => (report ? heading.current?.focus() : preview.mutate())}
      >
        {preview.isPending ? t("Reading diagnostics…") : t("Diagnostics…")}
      </Button>
      {report && (
        <section
          aria-label={t("Diagnostics export")}
          className="order-last mt-4 basis-full space-y-3 text-sm"
        >
          <h2 ref={heading} tabIndex={-1} className="font-semibold outline-none">
            {t("Diagnostics export")}
          </h2>
          <dl className="grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2">
            <dt className="text-muted-foreground">{t("Build")}</dt>
            <dd>
              {[
                report.version,
                report.channel === "nightly" ? t("Nightly") : t("Stable"),
                report.commit.slice(0, 7),
                report.platform,
                distributionLabel(report.distribution),
              ].join(" · ")}
            </dd>
            <dt className="text-muted-foreground">{t("Operations")}</dt>
            <dd>
              {t("{count} recent entries", { count: report.entries })} ·{" "}
              {t("{count} failures", { count: report.failures })}
            </dd>
            <dt className="text-muted-foreground">{t("Playback")}</dt>
            <dd>
              {report.acceleratedVideoDecodeDisabled
                ? t("Accelerated video decoding disabled")
                : t("Accelerated video decoding allowed")}
            </dd>
            <dt className="text-muted-foreground">{t("Updates")}</dt>
            <dd>{report.checked === "none" ? t("No check recorded") : report.checked}</dd>
            <dt className="text-muted-foreground">{t("Subscriptions")}</dt>
            <dd>
              {formatNumber(report.subscriptions.xtream)} Xtream ·{" "}
              {formatNumber(report.subscriptions.m3u)} M3U
            </dd>
            <dt className="text-muted-foreground">{t("Not in it")}</dt>
            <dd>{t("Addresses, logins, channel and title names, filesystem paths")}</dd>
          </dl>
          <p>{t("Nothing is sent by Mr. Streamer.")}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={save.isPending}
              onClick={() => save.mutate(report.id)}
            >
              {t("Save…")}
            </Button>
            <Button
              variant="ghost"
              aria-expanded={showText}
              onClick={() => setShowText((shown) => !shown)}
            >
              {showText ? t("Hide the text") : t("Show the text")}
            </Button>
            <Button variant="ghost" disabled={save.isPending} onClick={close}>
              {t("Cancel")}
            </Button>
          </div>
          {showText && (
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
              {report.text}
            </pre>
          )}
          {save.isSuccess && save.data && <p role="status">{t("Diagnostics saved.")}</p>}
        </section>
      )}
      {(preview.isError || save.isError) && (
        <p role="alert" className="order-last basis-full text-sm">
          {save.isError
            ? t("Diagnostics could not be saved. Try again.")
            : t("Diagnostics could not be read.")}
        </p>
      )}
    </>
  );
}
