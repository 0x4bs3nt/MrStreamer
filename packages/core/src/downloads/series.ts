// How the downloaded episodes of a series stand on this computer: which copies are one series, in
// what order they go, which episodes between them are missing, and which copy plays after another.
// The Downloads page and the offline player both go by these, as plain functions of the list main
// keeps (DownloadList): nothing here asks a provider, TMDB or the viewing record.
//
// Copies are one series by the key main gives each (`Download.series`): one series version of one
// account, as its episode's details said when it was queued. A copy queued before that was kept,
// or by an earlier build, has none: it stands alone and nothing follows it. Nothing is guessed from
// names.
//
// A series goes by what it listed when its latest download was queued (`DownloadList.series`).
// What follows a copy is the very next episode there, in the provider's order: numbered seasons,
// then specials, which lead only to specials, as online (`nextEpisode` in ../ondemand/details.ts);
// or a mapped playlist's source order, where specials go on like any other episode. When that
// episode's copy isn't complete on this computer, nothing plays: no later copy is skipped to.
import type { Download, DownloadList, DownloadSeries } from "@mrstreamer/contracts/downloads";

/** An episode at its place in a series: its season and its number there. */
export interface Place {
  readonly season: number;
  readonly episode: number;
}

/** What comes after a copy of an episode: the next episode its series lists, and how it stands. */
export type NextCopy =
  /** Its copy is complete, with its file on this computer as main last looked. */
  | ({ readonly kind: "copy"; readonly copy: Download } & Place)
  /** Its download is queued, waiting, paused, transferring or failed. */
  | ({ readonly kind: "unfinished"; readonly copy: Download } & Place)
  /** No copy of it is on this computer: never downloaded, deleted, or its file gone. */
  | ({ readonly kind: "missing" } & Place)
  /** The series listed none after it. */
  | { readonly kind: "end" };

/** The copies on this computer as the Downloads page shows them, in the list's order. */
export type ShelfItem = { readonly kind: "copy"; readonly copy: Download } | ShelfSeries;

/** The copies of one series, season by season, placed where it lists their episodes. */
export interface ShelfSeries {
  readonly kind: "series";
  readonly key: string;
  /** Every copy of it, in the list's order: the newest first. */
  readonly copies: readonly Download[];
  readonly seasons: readonly ShelfSeason[];
}

/**
 * A season's run of copies and the episodes between them. A mapped playlist that interleaves its
 * seasons has a run for each stretch of one season.
 */
export interface ShelfSeason {
  /**
   * Tells the run from the series' other runs, unchanged as copies before it or in it come and
   * go: the stretch of the listing it shows, by that stretch's season and first episode. Copies of
   * episodes the listing no longer holds go in the run before them when it is of their season,
   * else in a run of their own, named after their season.
   */
  readonly key: string;
  readonly number: number;
  readonly entries: readonly ShelfEntry[];
}

export type ShelfEntry =
  | { readonly kind: "copy"; readonly copy: Download }
  /** Episodes the series lists between copies, in its order, of which none is on this computer. */
  | { readonly kind: "gap"; readonly episodes: readonly number[] };

/**
 * What comes after the copy `id` of `list`: undefined for a movie, a copy without a series, and an
 * episode its series' listing doesn't hold. The next episode's complete copy wins over an
 * unfinished download of it, as when the provider lists two files of one episode.
 */
export function nextCopy(list: DownloadList, id: string): NextCopy | undefined {
  const current = list.items.find((item) => item.id === id);
  const place = current && placeOf(current);
  const series = current?.series ? list.series[current.series] : undefined;
  if (!current || !place || !series) return undefined;
  const chain = chainsOf(series).find((each) => each.some((step) => same(step, place)));
  if (!chain) return undefined;
  const next = chain[chain.findIndex((step) => same(step, place)) + 1];
  if (!next) return { kind: "end" };
  const after: Place = { season: next.season, episode: next.episode };
  const copies = list.items.filter((item) => {
    const at = item.series === current.series ? placeOf(item) : null;
    return at !== null && same(at, after);
  });
  const complete = copies.find((item) => item.status.kind === "complete");
  if (complete) return { kind: "copy", copy: complete, ...after };
  const unfinished = copies.find((item) => !onComputer(item));
  if (unfinished) return { kind: "unfinished", copy: unfinished, ...after };
  return { kind: "missing", ...after };
}

/**
 * The copies on this computer, complete or with their file gone, as the Downloads page shows them:
 * a copy without a series alone, and so the only copy of a series; two or more copies of a series
 * together, where the first of them is in the list. A series shows its copies in its listing's
 * order, with the episodes it lists between them that have no copy. Copies of episodes it no
 * longer lists come after, by season and number.
 */
export function copyShelf(list: DownloadList): readonly ShelfItem[] {
  const shelf: ShelfItem[] = [];
  const groups = new Map<string, Download[]>();
  for (const item of list.items) {
    if (!onComputer(item)) continue;
    if (!item.series || !placeOf(item)) {
      shelf.push({ kind: "copy", copy: item });
      continue;
    }
    const group = groups.get(item.series);
    if (group) group.push(item);
    else {
      const copies = [item];
      groups.set(item.series, copies);
      shelf.push({ kind: "series", key: item.series, copies, seasons: [] });
    }
  }
  return shelf.map((item) =>
    item.kind === "copy"
      ? item
      : item.copies.length === 1
        ? { kind: "copy", copy: item.copies[0]! }
        : { ...item, seasons: seasonsOf(item.copies, list.series[item.key]) },
  );
}

function placeOf(item: Download): Place | null {
  return item.title.kind === "episode"
    ? { season: item.title.season, episode: item.title.episode }
    : null;
}

const same = (a: Place, b: Place) => a.season === b.season && a.episode === b.episode;
const keyOf = (place: Place) => `${place.season}:${place.episode}`;

/** A copy, complete or with its file gone, rather than something still in the queue. */
function onComputer(item: Download): boolean {
  return item.status.kind === "complete" || item.status.kind === "missing";
}

/**
 * The orders episodes follow one another in: the series' whole listing in source order, else its
 * numbered episodes, then its specials apart.
 */
function chainsOf(series: DownloadSeries): readonly (readonly (Place & { run: string })[])[] {
  // Each place knows the stretch of the listing it is in, which names the run it shows in.
  const all = series.seasons.flatMap(({ number, episodes }) =>
    episodes.map((episode) => ({ season: number, episode, run: `${number}:${episodes[0]}` })),
  );
  return series.sourceOrder
    ? [all]
    : [all.filter((place) => place.season !== 0), all.filter((place) => place.season === 0)];
}

/**
 * The seasons of a series' `copies`, in the order `series` lists them. In each chain, every episode
 * between its first and its last copy shows: a copy, or a gap where it has none.
 */
function seasonsOf(
  copies: readonly Download[],
  series: DownloadSeries | undefined,
): readonly ShelfSeason[] {
  const seasons: { key: string; number: number; entries: ShelfEntry[] }[] = [];
  // Stretches next to each other are of other seasons (seriesEpisodeSeasons): each makes one run.
  const add = (key: string, season: number, entry: ShelfEntry) => {
    const last = seasons.at(-1);
    const run = last?.number === season ? last : { key, number: season, entries: [] };
    if (run !== last) seasons.push(run);
    const before = run.entries.at(-1);
    if (entry.kind === "gap" && before?.kind === "gap") {
      run.entries[run.entries.length - 1] = {
        kind: "gap",
        episodes: [...before.episodes, ...entry.episodes],
      };
    } else run.entries.push(entry);
  };
  const byPlace = new Map<string, Download[]>();
  for (const copy of copies) {
    const key = keyOf(placeOf(copy)!);
    byPlace.set(key, [...(byPlace.get(key) ?? []), copy]);
  }
  const at = (step: Place) => byPlace.get(keyOf(step)) ?? [];
  const placed = new Set<Download>();
  for (const chain of series ? chainsOf(series) : []) {
    const first = chain.findIndex((step) => at(step).length > 0);
    const last = chain.findLastIndex((step) => at(step).length > 0);
    for (const step of first < 0 ? [] : chain.slice(first, last + 1)) {
      const here = at(step);
      for (const copy of here) {
        add(step.run, step.season, { kind: "copy", copy });
        placed.add(copy);
      }
      if (here.length === 0) add(step.run, step.season, { kind: "gap", episodes: [step.episode] });
    }
  }
  const rest = copies
    .filter((copy) => !placed.has(copy))
    .toSorted((a, b) => order(placeOf(a)!, placeOf(b)!));
  for (const copy of rest) {
    const { season } = placeOf(copy)!;
    add(`unlisted:${season}`, season, { kind: "copy", copy });
  }
  return seasons;
}

/** By season, specials after the numbered ones, then by number. */
function order(a: Place, b: Place): number {
  const season = (place: Place) => (place.season === 0 ? Infinity : place.season);
  return season(a) - season(b) || a.episode - b.episode;
}
