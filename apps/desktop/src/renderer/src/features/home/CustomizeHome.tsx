import { useRef } from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { ArrowDown, ArrowUp } from "lucide-react";
import { t, type PlainKey } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { appError, describeError } from "../../lib/errors.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { homeRows, type HomeRowId, type HomeRow } from "./rows.ts";

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

/** Inline native controls retain focus as a row moves, and include rows with no current content. */
export function CustomizeHome({ onDone }: { onDone: () => void }) {
  const preferences = useQuery(queries.preferences());
  const client = useQueryClient();
  const rows = homeRows(preferences.data?.homeRows);
  const writing = useRef(false);
  const save = useMutation({
    mutationKey: HOME_ROW_WRITE,
    mutationFn: (homeRows: NonNullable<Preferences["homeRows"]>) =>
      call("preferences.update", { homeRows }),
    onSuccess: (saved) => client.setQueryData(queries.preferences().queryKey, saved),
    onSettled: () => {
      writing.current = false;
    },
  });
  // Closing Customize or leaving Home does not release an outstanding preference write.
  const latest = useMutationState({
    filters: { mutationKey: HOME_ROW_WRITE, exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  }).at(-1);
  const busy = save.isPending || latest?.status === "pending";
  const persist = (change: ((rows: HomeRow[]) => HomeRow[]) | null) => {
    // The ref covers repeated presses; rendered pending state covers the completion/render gap.
    if (writing.current || busy || client.isMutating({ mutationKey: HOME_ROW_WRITE, exact: true }))
      return;
    const saved = client.getQueryData(queries.preferences().queryKey);
    if (!saved) return;
    const settledRows = homeRows(saved.homeRows);
    const changed = change === null ? homeRows(undefined) : change(settledRows);
    if (changed === settledRows) return;
    const next =
      change === null
        ? changed
        : [
            ...changed,
            ...(saved.homeRows ?? []).filter(
              (row) => !settledRows.some((known) => known.id === row.id),
            ),
          ];
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
    <section aria-label={t("Customize Home")} className="mb-7 max-w-2xl">
      <h2 className="mb-2 text-xl font-semibold">{t("Customize Home")}</h2>
      <ul>
        {rows.map((row, index) => {
          const label = t(LABELS[row.id]);
          return (
            <li key={row.id} className="flex items-center gap-3 border-b border-white/15 py-2">
              <label className="flex flex-1 items-center gap-3">
                <input
                  type="checkbox"
                  checked={row.visible}
                  disabled={!preferences.data || busy}
                  onChange={(event) =>
                    persist((rows) =>
                      rows.map((each) =>
                        each.id === row.id ? { ...each, visible: event.target.checked } : each,
                      ),
                    )
                  }
                />
                {label}
              </label>
              <Button
                className="rounded-none text-white hover:bg-transparent aria-disabled:opacity-40"
                variant="ghost"
                size="icon-sm"
                aria-label={t("Move {name} up", { name: label })}
                aria-disabled={index === 0 || !preferences.data || busy}
                onClick={() => move(row.id, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                className="rounded-none text-white hover:bg-transparent aria-disabled:opacity-40"
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
      </ul>
      {latest?.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(appError(latest.error))}
        </p>
      )}
      <div className="mt-3 flex gap-3">
        <Button
          className="rounded-none text-white hover:bg-transparent aria-disabled:opacity-40"
          variant="ghost"
          disabled={!preferences.data || busy}
          onClick={() => persist(null)}
        >
          {t("Reset to defaults")}
        </Button>
        <Button
          className="rounded-none text-white hover:bg-transparent aria-disabled:opacity-40"
          variant="ghost"
          onClick={onDone}
        >
          {t("Done")}
        </Button>
      </div>
    </section>
  );
}
