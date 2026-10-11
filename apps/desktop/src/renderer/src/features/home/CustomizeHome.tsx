import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** Inline native controls retain focus as a row moves, and include rows with no current content. */
export function CustomizeHome({ onDone }: { onDone: () => void }) {
  const preferences = useQuery(queries.preferences());
  const client = useQueryClient();
  const rows = homeRows(preferences.data?.homeRows);
  const writing = useRef(false);
  const save = useMutation({
    mutationFn: (next: HomeRow[] | null) =>
      call("preferences.update", {
        homeRows:
          next === null
            ? homeRows(undefined)
            : [
                ...next,
                ...(preferences.data?.homeRows ?? []).filter(
                  (row) => !rows.some((known) => known.id === row.id),
                ),
              ],
      }),
    onSuccess: (saved) => client.setQueryData(queries.preferences().queryKey, saved),
    onSettled: () => {
      writing.current = false;
    },
  });
  const persist = (next: HomeRow[] | null) => {
    if (writing.current || !preferences.data) return;
    writing.current = true;
    save.mutate(next);
  };
  const move = (index: number, step: number) => {
    if (index + step < 0 || index + step >= rows.length) return;
    const next = [...rows];
    [next[index], next[index + step]] = [next[index + step]!, next[index]!];
    persist(next);
  };
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
                  disabled={!preferences.data || save.isPending}
                  onChange={(event) =>
                    persist(
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
                aria-disabled={index === 0 || !preferences.data || save.isPending}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </Button>
              <Button
                className="rounded-none text-white hover:bg-transparent aria-disabled:opacity-40"
                variant="ghost"
                size="icon-sm"
                aria-label={t("Move {name} down", { name: label })}
                aria-disabled={index === rows.length - 1 || !preferences.data || save.isPending}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </Button>
            </li>
          );
        })}
      </ul>
      {save.error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {describeError(appError(save.error))}
        </p>
      )}
      <div className="mt-3 flex gap-3">
        <Button
          className="rounded-none text-white hover:bg-transparent aria-disabled:opacity-40"
          variant="ghost"
          disabled={!preferences.data || save.isPending}
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
