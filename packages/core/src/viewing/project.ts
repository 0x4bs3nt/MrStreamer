// What the viewing record's events add up to, as one set of functions any store runs: a title or
// mark event on an account's rows and marks (`project`), and where channels stand among several
// accounts' (`place`, `merged`). The desktop's SQLite store runs them on its tables as a change
// commits and on a rebuild's memory, and the in-memory store (./memory-store.ts) on plain data, so
// every store reads as the events committed to it say.
import { titleKey, type RawTitleRef } from "@mrstreamer/contracts/ondemand";
import { left, marked, noMarks, type SeriesMarks } from "./marks.ts";
import {
  isMarkEvent,
  type ChannelEvent,
  type MarkEvent,
  type StoredChannel,
  type TitleEvent,
} from "./record.ts";
import { accepted, progressed, removalScope, removedKeys, type TitleRow } from "./titles.ts";

/**
 * One account's title rows and marks, as `project` reads and changes them: in the tables as a
 * change commits, in memory while a rebuild folds the events.
 */
export interface Projected {
  readonly row: (key: string) => TitleRow | undefined;
  /** Every episode's row of a series version. */
  readonly rowsOf: (seriesId: string) => readonly TitleRow[];
  /** When the movie, or the episode's series version, last left Continue watching. */
  readonly removedAt: (title: RawTitleRef) => number | null;
  readonly saveRow: (row: TitleRow) => void;
  /** Takes the rows `keys` out of Continue watching, with the movie or series version of `title`. */
  readonly remove: (title: RawTitleRef, keys: readonly string[], at: number) => void;
  /** What is kept under a series' key. */
  readonly series: (key: string) => SeriesMarks;
  /** The marked series that listed this version when last marked, each by its key. */
  readonly covering: (seriesId: string) => readonly (readonly [key: string, SeriesMarks])[];
  /** Stores what is kept under `key`, with the marks of `changed`. */
  readonly saveSeries: (key: string, state: SeriesMarks, changed: ChangedMarks) => void;
}

/** Which marks of a series a change touched: every one, none, or one episode's. */
export type ChangedMarks = "all" | "none" | { readonly season: number; readonly episode: number };

/** The latest of some times, or null when none is given. */
export function latest(times: readonly (number | null)[]): number | null {
  const known = times.filter((time) => time !== null);
  return known.length > 0 ? Math.max(...known) : null;
}

/**
 * What a title or mark event, saved at `at` as the record's event numbered `sequence`, does to an
 * account's rows and marks. A checkpoint that doesn't count (`accepted`) changes nothing. A
 * series version that leaves Continue watching takes the marked series that list it out too.
 */
export function project(
  view: Projected,
  event: TitleEvent | MarkEvent,
  at: number,
  sequence: number,
): void {
  if (isMarkEvent(event)) {
    const state = marked(view.series(event.series), event, at, sequence);
    // A mark and its Undo change one episode's mark, and what a series lists changes none.
    return view.saveSeries(event.series, state, "title" in event ? event.title : "none");
  }
  const { title } = event;
  const covering = title.kind === "episode" ? view.covering(title.seriesId) : [];
  if (event.type === "title-progress") {
    const markedAt = latest(
      covering.flatMap(([, { marks }]) =>
        marks.flatMap((mark) =>
          title.kind === "episode" && mark.season === title.season && mark.episode === title.episode
            ? [mark.at]
            : [],
        ),
      ),
    );
    if (!accepted(view.row(titleKey(title)), { since: event.since, at }, markedAt)) return;
    const removedAt = latest([view.removedAt(title), ...covering.map(([, each]) => each.leftAt)]);
    return view.saveRow(progressed(event, at, removedAt));
  }
  const rows = title.kind === "episode" ? view.rowsOf(title.seriesId) : [];
  view.remove(title, removedKeys(title, rows), at);
  for (const [key, state] of covering) view.saveSeries(key, left(state, at), "none");
}

/**
 * Where an account's stored channels stand among every account's: for each, the sequence of the
 * event that gave it its place, the star that made it a favourite or the watch that was its last.
 */
export interface Placed {
  readonly favourites: Map<string, number>;
  readonly recent: Map<string, number>;
}

/** Notes what a channel event does to where its channel stands, as `apply` does to the lists. */
export function place(
  placed: Placed,
  type: ChannelEvent["type"],
  id: string,
  sequence: number,
): void {
  if (type === "watched") placed.recent.set(id, sequence);
  else if (type === "favourite-removed") placed.favourites.delete(id);
  // A favourite starred again while it is one stays where it stands.
  else if (!placed.favourites.has(id)) placed.favourites.set(id, sequence);
}

/**
 * Lists of several accounts as one, by where each entry stands: ascending for the order starred,
 * descending for the most recent first. Each account's own order holds whatever the events say,
 * so an entry none of them places stays beside its neighbour.
 */
export function merged(
  lists: readonly {
    readonly account: string;
    readonly ids: readonly string[];
    readonly placed: ReadonlyMap<string, number>;
  }[],
  direction: 1 | -1,
): StoredChannel[] {
  const entries: { channel: StoredChannel; at: number; rank: number }[] = [];
  for (const [rank, { account, ids, placed }] of lists.entries()) {
    let at = direction === 1 ? 0 : Infinity;
    for (const id of ids) {
      const found = placed.get(id);
      if (found !== undefined) at = direction === 1 ? Math.max(at, found) : Math.min(at, found);
      entries.push({ channel: { account, id }, at, rank });
    }
  }
  return entries
    .sort((a, b) => direction * (a.at - b.at) || a.rank - b.rank)
    .map(({ channel }) => channel);
}

/** An account's title rows, removals and marks held in memory: what `remembered` projects onto. */
export interface Remembered {
  /** By `titleKey`. */
  readonly rows: Map<string, TitleRow>;
  /** When each movie and series version last left Continue watching, by `removalScope`. */
  readonly removals: Map<string, number>;
  /** By the key each series' marks are kept under. */
  readonly series: Map<string, SeriesMarks>;
}

/**
 * An account's rows and marks held in memory, as a rebuild folds its events into them or the
 * in-memory store keeps them. `removals` holds when each movie and series version last left
 * Continue watching, as far as the desktop's tables would: they keep a removal on the rows it
 * took out, so one that found no row leaves nothing behind there, and none here.
 */
export function remembered(
  held: Remembered = { rows: new Map(), removals: new Map(), series: new Map() },
): Remembered & { readonly view: Projected } {
  const { rows, removals, series } = held;
  const view: Projected = {
    row: (key) => rows.get(key),
    rowsOf: (seriesId) =>
      [...rows.values()].filter(
        ({ title }) => title.kind === "episode" && title.seriesId === seriesId,
      ),
    removedAt: (title) => removals.get(removalScope(title)) ?? null,
    // Moved to the end, so the rows read in the order they were last written.
    saveRow: (row) => {
      const key = titleKey(row.title);
      rows.delete(key);
      rows.set(key, row);
    },
    remove: (title, keys, at) => {
      for (const key of keys) {
        const row = rows.get(key);
        if (!row) continue;
        rows.set(key, { ...row, hidden: true, removedAt: at });
        removals.set(removalScope(title), at);
      }
    },
    series: (key) => series.get(key) ?? noMarks,
    covering: (seriesId) => [...series].filter(([, each]) => each.versions.includes(seriesId)),
    saveSeries: (key, state) => void series.set(key, state),
  };
  return { view, rows, removals, series };
}
