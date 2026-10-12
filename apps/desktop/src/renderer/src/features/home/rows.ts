import type { Preferences } from "@mrstreamer/contracts/preferences";

const HOME_ROWS = [
  "continue",
  "recommendations",
  "watchlist",
  "favourites",
  "recent",
  "new-movies",
  "new-series",
  "category",
] as const;
export type HomeRowId = (typeof HOME_ROWS)[number];
export type HomeRow = { id: HomeRowId; visible: boolean };

/** Unknown saved IDs stay on disk; newly introduced rows append in default order. */
export function homeRows(saved: Preferences["homeRows"]): HomeRow[] {
  const seen = new Set<string>();
  const result: HomeRow[] = [];
  for (const row of saved ?? []) {
    const id = HOME_ROWS.find((id) => id === row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, visible: row.visible });
  }
  return [
    ...result,
    ...HOME_ROWS.filter((id) => !seen.has(id)).map((id) => ({ id, visible: true })),
  ];
}
