import { useRef, useState } from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { t, type PlainKey } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { updatePreferences } from "../../lib/preferences.ts";
import { cn } from "../../lib/utils.ts";
import { queries } from "../../lib/queries.ts";
import { homeRows, type HomeRowId, type HomeRow } from "./rows.ts";
import { focusSettingControl } from "../settings/SaveFeedback.tsx";

const LABELS = {
  continue: "Continue watching",
  recommendations: "Recommendations",
  watchlist: "Watchlist",
  favourites: "Favourites",
  recent: "Recently watched",
  "new-movies": "New movies",
  "new-series": "New series",
  category: "Current category",
} as const satisfies Record<HomeRowId, PlainKey>;

const HOME_ROW_WRITE = ["preferences", "home-rows"] as const;

/** Settings row controls retain focus as a row moves, including rows with no current content. */
export function CustomizeHome() {
  const preferences = useQuery(queries.preferences());
  const client = useQueryClient();
  const [pendingHomeRows, setPendingHomeRows] = useState<Preferences["homeRows"]>();
  const rows = homeRows(pendingHomeRows ?? preferences.data?.homeRows);
  const writing = useRef(false);
  const save = useMutation({
    mutationKey: HOME_ROW_WRITE,
    mutationFn: (homeRows: NonNullable<Preferences["homeRows"]>) =>
      updatePreferences({ homeRows }, client),
    onSettled: () => {
      writing.current = false;
      setPendingHomeRows(undefined);
    },
  });
  // Switching Settings tabs or closing Settings does not release an outstanding preference write.
  const latest = useMutationState({
    filters: { mutationKey: HOME_ROW_WRITE, exact: true },
    select: (mutation) => ({
      status: mutation.state.status,
      error: mutation.state.error,
      // HOME_ROW_WRITE belongs to the save above, whose variables are always these rows.
      rows: mutation.state.variables as NonNullable<Preferences["homeRows"]> | undefined,
    }),
  }).at(-1);
  const busy = save.isPending || latest?.status === "pending";
  const persist = (change: ((rows: HomeRow[]) => HomeRow[]) | null) => {
    // The ref covers repeated presses; rendered pending state covers the completion/render gap.
    if (writing.current || busy || client.isMutating({ mutationKey: HOME_ROW_WRITE, exact: true }))
      return;
    const saved = client.getQueryData(queries.preferences().queryKey)?.preferences;
    if (!saved) return;
    const settledRows = homeRows(saved.homeRows);
    const changed = change === null ? homeRows(undefined) : change(settledRows);
    if (changed === settledRows) return;
    const next = [
      ...changed,
      ...(saved.homeRows ?? []).filter((row) => !settledRows.some((known) => known.id === row.id)),
    ];
    setPendingHomeRows(next);
    writing.current = true;
    save.mutate(next);
  };
  const move = (id: HomeRowId, step: number) =>
    persist((rows) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index + step < 0 || index + step >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[index + step]] = [next[index + step]!, next[index]!];
      return next;
    });
  return (
    <section aria-label={t("Customize Home")} aria-busy={busy} className="mb-10">
      <h2 className="mb-1 text-[0.9375rem] font-semibold">{t("Rows")}</h2>
      <ol>
        {rows.map((row, index) => {
          const label = t(LABELS[row.id]);
          return (
            <li
              key={row.id}
              data-setting={`home-${row.id}`}
              className={cn(
                "flex min-h-13 items-center gap-3 border-b border-white/8 py-2 text-[0.9375rem]",
                busy && "opacity-60",
              )}
            >
              <span
                aria-hidden
                className="w-4 flex-none text-right text-[0.8125rem] tabular-nums text-muted-foreground"
              >
                {index + 1}
              </span>
              <label className="flex min-w-0 flex-1 items-center gap-3">
                <span className="relative flex size-4 flex-none">
                  <input
                    type="checkbox"
                    className="peer size-4 appearance-none rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none checked:bg-white checked:shadow-none focus-visible:ring-2 focus-visible:ring-ring"
                    checked={row.visible}
                    disabled={!preferences.data}
                    aria-disabled={busy}
                    onChange={(event) =>
                      persist((rows) =>
                        rows.map((each) =>
                          each.id === row.id ? { ...each, visible: event.target.checked } : each,
                        ),
                      )
                    }
                  />
                  <Check
                    aria-hidden
                    className="pointer-events-none absolute inset-0 m-auto hidden size-3 text-black peer-checked:block"
                    strokeWidth={3}
                  />
                </span>
                <span className={cn("truncate", !row.visible && "text-muted-foreground")}>
                  {label}
                </span>
              </label>
              <Button
                className="aria-disabled:opacity-40"
                variant="ghost"
                size="icon-sm"
                aria-label={t("Move {name} up", { name: label })}
                aria-disabled={index === 0 || !preferences.data || busy}
                onClick={() => move(row.id, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                className="aria-disabled:opacity-40"
                variant="ghost"
                size="icon-sm"
                aria-label={t("Move {name} down", { name: label })}
                aria-disabled={index === rows.length - 1 || !preferences.data || busy}
                onClick={() => move(row.id, 1)}
              >
                <ArrowDown />
              </Button>
            </li>
          );
        })}
      </ol>
      {latest?.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(appError(latest.error))}
          <Button
            variant="ghost"
            size="sm"
            aria-disabled={busy || !latest.rows}
            onClick={(event) => {
              if (
                !latest.rows ||
                busy ||
                writing.current ||
                client.isMutating({ mutationKey: HOME_ROW_WRITE, exact: true })
              )
                return;
              focusSettingControl(event.currentTarget);
              writing.current = true;
              save.mutate(latest.rows);
            }}
          >
            {t("Try again")}
          </Button>
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <Button
          data-setting="home-reset"
          className="pl-0 aria-disabled:opacity-40"
          variant="ghost"
          disabled={!preferences.data}
          aria-disabled={busy}
          onClick={() => persist(null)}
        >
          {t("Reset to defaults")}
        </Button>
        {busy && (
          <span role="status" className="text-sm text-muted-foreground">
            {t("Saving…")}
          </span>
        )}
      </div>
    </section>
  );
}
