import type { UsageObservers } from "../analytics/observers.ts";
// The viewing record on disk, in the SQLite database it shares with the watchlist (database.ts):
// the events in order, the state they add up to per account, one row per movie or episode played,
// one per episode marked by hand and one per marked series, with the episodes it listed and what
// its latest mark replaced, the ids of commands already done and a few markers. Every command is
// one transaction. When the rules change (STATE_VERSION), the state is rebuilt from the events at
// start. If the database can't open, the record reports failures and the rest of the app carries
// on.
//
// What an event does to the title rows and the marks is one function, core's `project`, run on
// the tables as a change commits and on a rebuild's memory, so a record rebuilt from its events
// reads as the one they were committed to.
//
// Everything in it is kept per account, by the provider's own ids: the service says which
// subscription an account's channels and titles belong to, and nothing here names one.
//
// Several accounts read as one give their favourites in the order starred and their channels by
// when they were watched, whichever account each is of. Nothing stored says so beyond the events:
// their sequence runs through every account, so the event that gave an entry its place tells
// where it stands among the others'. That is worked out from an account's channel events once
// per run, and kept current as changes commit; a single account's lists never need it.
//
// Older builds read this file too, as when someone goes back to an earlier nightly: they skip
// event types they don't know, leave the titles table alone, and insert events without a payload.
// Builds with movies and series before `removed_at`, Stable 0.0.3 among them, write title rows
// without it, and read `hidden` as this one writes it. Builds from before marks write title rows
// without `since`, which then read as a play begun when the row was saved, and never look at the
// tables that hold the marks: a mark is no title row, so none of them takes it for a play. When
// such a build erases an account it leaves that account's marks, which this one deletes at its
// next start: none are kept without the events that made them.
import type { DatabaseSync } from "node:sqlite";
import { RawTitleRef, titleKey } from "@mrstreamer/contracts/ondemand";
import { CONTINUE_OFFERED } from "@mrstreamer/contracts/viewing";
import {
  goesOn,
  leading,
  noMarks,
  standing,
  type SeriesMarks,
} from "@mrstreamer/core/viewing/marks";
import {
  apply,
  emptyState,
  EVENT_VERSION,
  isMarkEvent,
  isTitleEvent,
  STATE_VERSION,
  type AccountEvent,
  type ChannelEvent,
  type MarkEvent,
  type StoredChannel,
  type TitleEvent,
  type ViewingEvent,
  type ViewingState,
} from "@mrstreamer/core/viewing/record";
import { Failed } from "@mrstreamer/core/failure";
import {
  ViewingStore,
  type RawTitleFilter,
  type StoredLook,
  type StoredViewing,
} from "@mrstreamer/core/viewing/service";
import {
  STARTED_SECONDS,
  continueWatching,
  type RawProgress,
  type TitleRow,
} from "@mrstreamer/core/viewing/titles";
import {
  merged,
  place,
  project,
  remembered,
  type ChangedMarks,
  type Placed,
  type Projected,
} from "@mrstreamer/core/viewing/project";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";
import { prepareVerifiedFiles, VERIFIED_FILES_TABLE } from "./verified-files.ts";
import { prepareDetailCache, DETAIL_CACHE_TABLE } from "./detail-cache.ts";
import {
  prepareSavedSubtitles,
  SAVED_SUBTITLES_TABLE,
  SUBTITLE_PROOFS_TABLE,
  SUBTITLE_RESULTS_TABLE,
} from "./saved-subtitles.ts";
import { WATCHLIST_TABLES } from "./watchlist-store.ts";
import { lazy } from "@mrstreamer/contracts/lazy";

const SCHEMA = `
  create table if not exists events (
    sequence integer primary key autoincrement,
    account text not null,
    type text not null,
    version integer not null,
    channel_id text not null,
    at integer not null,
    command_id text not null
  );
  create table if not exists receipts (command_id text primary key);
  create table if not exists state (
    account text primary key,
    favourites text not null,
    recent text not null,
    sequence integer not null
  );
  create table if not exists meta (key text primary key, value text not null);
  create table if not exists titles (
    account text not null,
    key text not null,
    title text not null,
    series_id text,
    position real not null,
    duration real not null,
    finished integer not null,
    at integer not null,
    hidden integer not null,
    removed_at integer,
    primary key (account, key)
  );
  create index if not exists titles_by_time on titles (account, at);
  create index if not exists titles_by_series on titles (account, series_id);
  create table if not exists marked_episodes (
    account text not null,
    series text not null,
    season integer not null,
    episode integer not null,
    mark text not null,
    primary key (account, series, season, episode)
  );
  create table if not exists marked_series (
    account text not null,
    series text not null,
    versions text not null,
    listing text not null,
    hidden integer not null,
    left_at integer,
    changed integer not null,
    undo text,
    at integer not null,
    primary key (account, series)
  );
`;

/** The tables that hold an account's marks, each with an `account` column: erasing takes both. */
const MARK_TABLES = ["marked_episodes", "marked_series"] as const;

/** How many of an account's most recent titles Continue watching looks at. */
const CONTINUE_WINDOW = 2000;

const Ids = lazy(() => type("string.json.parse").pipe(type("string[]")));
const EventRow = lazy(() =>
  type({
    sequence: "number",
    account: "string",
    type: "string",
    version: "number",
    channel_id: "string",
    at: "number",
    "payload?": "string | null",
  }),
);
const ChannelEventType = lazy(() => type("'favourite-added' | 'favourite-removed' | 'watched'"));
const TitlePayload = lazy(() =>
  type("string.json.parse").pipe(
    type({
      title: RawTitleRef(),
      "position?": "number >= 0",
      "duration?": "number > 0",
      "since?": "number",
    }),
  ),
);
const Listing = lazy(() =>
  type({
    number: "number.integer >= 0",
    episodes: "(number.integer >= 0)[]",
    "files?": "string[]",
  }).array(),
);
const EpisodeTitle = lazy(() =>
  type({
    kind: "'episode'",
    id: "string > 0",
    seriesId: "string > 0",
    season: "number.integer >= 0",
    episode: "number.integer >= 0",
  }),
);
const MarkPayload = lazy(() =>
  type("string.json.parse").pipe(
    type({
      series: "string > 0",
      "title?": EpisodeTitle(),
      "watched?": "boolean",
      "versions?": "string[]",
      "listing?": Listing(),
      "revision?": "number",
    }),
  ),
);
/** A mark as its row and an Undo keep it, whole. */
const Mark = lazy(() =>
  type({
    series: "string",
    title: EpisodeTitle(),
    season: "number",
    episode: "number",
    watched: "boolean",
    at: "number",
    revision: "number",
  }),
);
const MarkRow = lazy(() => type({ mark: type("string.json.parse").pipe(Mark()) }));
const ListedRow = lazy(() =>
  type({
    series: "string",
    versions: type("string.json.parse").pipe(type("string[]")),
  }),
);
/** What a marked series keeps beside its episodes' marks. */
const SeriesRow = lazy(() =>
  type({
    series: "string",
    versions: type("string.json.parse").pipe(type("string[]")),
    listing: type("string.json.parse").pipe(Listing()),
    hidden: "number",
    left_at: "number | null",
    changed: "number",
    undo: type("null").or(
      type("string.json.parse").pipe(
        type({ revision: "number", prior: Mark().or("null"), hidden: "boolean" }),
      ),
    ),
  }),
);
const StateRow = lazy(() => type({ favourites: "string", recent: "string", sequence: "number" }));
const PlacedRow = lazy(() =>
  type({ type: ChannelEventType(), channel_id: "string", sequence: "number" }),
);

/** One account's lists, titles and marks as stored, and how far its record has come. */
interface AccountRecord {
  readonly state: ViewingState;
  readonly continueWatching: readonly RawProgress[];
  readonly recentTitles: readonly RawProgress[];
  /** Each marked series' latest mark and where the series goes on, most recent first. */
  readonly marked: readonly Omit<StoredViewing["marked"][number], "account">[];
  readonly sequence: number;
}

const TitleRowShape = lazy(() =>
  type({
    title: type("string.json.parse").pipe(RawTitleRef()),
    position: "number",
    duration: "number",
    finished: "number",
    at: "number",
    hidden: "number",
    "removed_at?": "number | null",
    "since?": "number | null",
  }),
);

/** The viewing store, on the database the runtime keeps open. */
export const viewingStoreLayer = observedViewingStoreLayer();

export function observedViewingStoreLayer(
  usage?: UsageObservers,
): Layer.Layer<ViewingStore, never, Database> {
  return Layer.effect(
    ViewingStore,
    Effect.gen(function* () {
      const opened = yield* Database;
      if ("failure" in opened) return closed(opened.failure);
      const { db } = opened;
      return yield* Effect.try(() => {
        prepare(db);
        return storeOn(db, usage);
      }).pipe(
        Effect.catchTag("UnknownError", (failure) =>
          Effect.logWarning("[viewing] the record can't be read", failure.cause).pipe(
            Effect.as(closed(String(failure.cause))),
          ),
        ),
      );
    }),
  );
}

/** Makes the record's tables, brings older ones up to date, and rebuilds the state when due. */
function prepare(db: DatabaseSync): void {
  db.exec(SCHEMA);
  prepareVerifiedFiles(db);
  prepareDetailCache(db);
  prepareSavedSubtitles(db);
  // Records from before movies and series lack the payload column, and later ones the time a
  // title left Continue watching. Checked and added under the write lock, since two copies of the
  // app can start at once.
  transaction(db, () => {
    const has = (table: string, name: string) =>
      db
        .prepare(`pragma table_info(${table})`)
        .all()
        .some((column) => column["name"] === name);
    if (!has("events", "payload")) db.exec("alter table events add column payload text");
    if (!has("titles", "removed_at")) db.exec("alter table titles add column removed_at integer");
    if (!has("titles", "since")) db.exec("alter table titles add column since integer");
  });
  // A build from before marks that erased an account deleted its events and left its marks.
  // The same confirmed erasure also clears display details written by a newer build.
  const erased = db
    .prepare(
      "select distinct account from marked_series as kept where not exists (select 1 from events where events.account = kept.account)",
    )
    .all();
  for (const { account } of erased) {
    if (typeof account === "string")
      deleteForGood(db, [...MARK_TABLES, DETAIL_CACHE_TABLE], account);
  }
  const stored = db.prepare("select value from meta where key = 'state-version'").get();
  if (stored?.["value"] !== String(STATE_VERSION)) rebuild(db);
}

/**
 * Deletes what `tables` hold of `account` so that none of it lingers in the file: SQLite zeroes
 * what it deletes, and the checkpoint moves it out of the write-ahead log.
 */
function deleteForGood(db: DatabaseSync, tables: readonly string[], account: string): void {
  db.exec("pragma secure_delete = on");
  try {
    transaction(db, () => {
      for (const table of tables) {
        // Shared descriptions still retain an opened-title history through their ids/timestamps.
        const shared = table === DETAIL_CACHE_TABLE ? " or account = ''" : "";
        db.prepare(`delete from ${table} where account = ?${shared}`).run(account);
      }
    });
  } finally {
    db.exec("pragma secure_delete = off");
  }
  db.exec("pragma wal_checkpoint(truncate)");
}

/** An event as stored, or null when this version can't read it: newer, or of an unknown type. */
function eventOf(
  raw: unknown,
): { account: string; sequence: number; at: number; event: ViewingEvent } | null {
  const row = EventRow()(raw);
  if (row instanceof type.errors || row.version > EVENT_VERSION) return null;
  const base = { account: row.account, sequence: row.sequence, at: row.at };
  const channelType = ChannelEventType()(row.type);
  if (!(channelType instanceof type.errors)) {
    return { ...base, event: { type: channelType, channelId: row.channel_id } };
  }
  if (
    row.type === "episode-marked" ||
    row.type === "episode-mark-undone" ||
    row.type === "series-listed"
  ) {
    const said = row.payload ? MarkPayload()(row.payload) : null;
    if (!said || said instanceof type.errors) return null;
    const { series, title, watched, versions, listing, revision } = said;
    if (row.type === "series-listed") {
      return versions && listing
        ? { ...base, event: { type: row.type, series, versions, listing } }
        : null;
    }
    if (!title) return null;
    if (row.type === "episode-mark-undone") {
      return revision === undefined
        ? null
        : { ...base, event: { type: row.type, series, title, revision } };
    }
    return watched === undefined || !versions || !listing
      ? null
      : { ...base, event: { type: row.type, series, title, watched, versions, listing } };
  }
  const payload = row.payload ? TitlePayload()(row.payload) : null;
  if (!payload || payload instanceof type.errors) return null;
  if (row.type === "title-removed" || row.type === "series-finished") {
    return { ...base, event: { type: row.type, title: payload.title } };
  }
  if (row.type === "title-progress" && payload.position !== undefined && payload.duration) {
    return {
      ...base,
      event: {
        type: "title-progress",
        title: payload.title,
        position: payload.position,
        duration: payload.duration,
        since: payload.since ?? row.at,
      },
    };
  }
  return null;
}

/** Folds every event into the state, the title rows and the marks again, per account, in order. */
function rebuild(db: DatabaseSync): void {
  transaction(db, () => {
    const records = new Map<string, { channelEvents: ChannelEvent[]; sequence: number }>();
    const views = new Map<string, ReturnType<typeof remembered>>();
    for (const raw of db.prepare("select * from events order by sequence").all()) {
      const read = eventOf(raw);
      if (!read) continue;
      const { account, sequence, at, event } = read;
      let record = records.get(account);
      if (!record) records.set(account, (record = { channelEvents: [], sequence: 0 }));
      record.sequence = sequence;
      if (!isMarkEvent(event) && !isTitleEvent(event)) {
        record.channelEvents.push(event);
        continue;
      }
      let memory = views.get(account);
      if (!memory) views.set(account, (memory = remembered()));
      project(memory.view, event, at, sequence);
    }
    db.exec(
      "delete from state; delete from titles; delete from marked_episodes; delete from marked_series;",
    );
    for (const [account, { channelEvents, sequence }] of records) {
      save(db, account, apply(emptyState, channelEvents), sequence);
    }
    for (const [account, { rows, series }] of views) {
      for (const row of rows.values()) saveTitle(db, account, row);
      for (const [key, state] of series) saveSeries(db, account, key, state, "all");
    }
    db.prepare("insert or replace into meta (key, value) values ('state-version', ?)").run(
      String(STATE_VERSION),
    );
  });
}

function storeOn(db: DatabaseSync, usage?: UsageObservers): ViewingStore["Service"] {
  const statements = {
    state: db.prepare("select * from state where account = ?"),
    event: db.prepare(
      "insert into events (account, type, version, channel_id, at, command_id, payload) values (?, ?, ?, ?, ?, ?, ?)",
    ),
    done: db.prepare("select 1 from receipts where command_id = ?"),
    receipt: db.prepare("insert into receipts (command_id) values (?)"),
    imported: db.prepare("select 1 from meta where key = 'imported'"),
    markImported: db.prepare("insert into meta (key, value) values ('imported', ?)"),
    recentTitles: db.prepare("select * from titles where account = ? order by at desc limit ?"),
    seriesTitles: db.prepare("select * from titles where account = ? and series_id = ?"),
    title: db.prepare("select * from titles where account = ? and key = ?"),
    hide: db.prepare("update titles set hidden = 1, removed_at = ? where account = ? and key = ?"),
    // The movie's row, or every row of the episode's series.
    removedAt: db.prepare(
      "select max(removed_at) as removed_at from titles where account = ? and (key = ? or series_id = ?)",
    ),
    // An account's channel events, as far as this version reads them, in order.
    placed: db.prepare(
      "select type, channel_id, sequence from events where account = ? and version <= ? and type in ('favourite-added', 'favourite-removed', 'watched') order by sequence",
    ),
    marks: db.prepare("select mark from marked_episodes where account = ? and series = ?"),
    series: db.prepare("select * from marked_series where account = ? and series = ?"),
    // What each marked series listed when it was last marked: a few short rows per account.
    listed: db.prepare("select series, versions from marked_series where account = ?"),
    // The marked series that didn't leave Continue watching since, by when each was last marked.
    shown: db.prepare(
      "select series from marked_series where account = ? and hidden = 0 and at > 0 order by at desc limit ?",
    ),
  };
  /** Where each account's channels stand, by account, once worked out in this run. */
  const places = new Map<string, Placed>();

  /** Where `account`'s channels stand: from its events the first time, then as kept since. */
  const placedOf = (account: string): Placed => {
    let placed = places.get(account);
    if (placed) return placed;
    placed = { favourites: new Map(), recent: new Map() };
    for (const raw of statements.placed.all(account, EVENT_VERSION)) {
      const row = PlacedRow()(raw);
      if (!(row instanceof type.errors)) place(placed, row.type, row.channel_id, row.sequence);
    }
    places.set(account, placed);
    return placed;
  };

  const titleRows = (rows: readonly unknown[]): TitleRow[] =>
    rows.flatMap((raw) => {
      const row = TitleRowShape()(raw);
      if (row instanceof type.errors) return [];
      return [
        {
          title: row.title,
          position: row.position,
          duration: row.duration,
          finished: row.finished === 1,
          at: row.at,
          hidden: row.hidden === 1,
          removedAt: row.removed_at ?? null,
          // A build from before marks wrote the row: a play begun when it was saved.
          since: row.since ?? row.at,
        },
      ];
    });

  const progressOf = (rows: readonly unknown[]): RawProgress[] =>
    titleRows(rows).map(({ hidden: _hidden, removedAt: _removedAt, ...progress }) => progress);

  const titlesOf = (account: string, filter: RawTitleFilter): RawProgress[] =>
    progressOf([
      ...(filter.seriesIds ?? []).flatMap((id) => statements.seriesTitles.all(account, id)),
      ...(filter.movieIds ?? []).flatMap((id) => {
        const row = statements.title.get(account, `movie:${id}`);
        return row ? [row] : [];
      }),
    ]);

  /** What `account` keeps under a series' key, or null when nothing was ever marked under it. */
  const seriesOf = (account: string, key: string): SeriesMarks | null => {
    const row = SeriesRow()(statements.series.get(account, key));
    if (row instanceof type.errors) return null;
    return {
      marks: statements.marks.all(account, key).flatMap((raw) => {
        const mark = MarkRow()(raw);
        return mark instanceof type.errors ? [] : [mark.mark];
      }),
      versions: row.versions,
      listing: row.listing,
      hidden: row.hidden === 1,
      leftAt: row.left_at,
      undo: row.undo,
      changed: row.changed,
    };
  };

  /** What `account` keeps under each of `keys` that anything was marked under. */
  const marksOf = (account: string, keys: readonly string[]): SeriesMarks[] =>
    keys.flatMap((key) => seriesOf(account, key) ?? []);

  /** The keys of the series of `account` that listed one of these versions when last marked. */
  const seriesIn = (account: string, seriesIds: readonly string[]): string[] =>
    statements.listed.all(account).flatMap((raw) => {
      const row = ListedRow()(raw);
      if (row instanceof type.errors) return [];
      return row.versions.some((id) => seriesIds.includes(id)) ? [row.series] : [];
    });

  const look: StoredLook = {
    titles: titlesOf,
    marks: marksOf,
    marksIn: (account, seriesIds) =>
      marksOf(account, seriesIn(account, seriesIds)).flatMap(({ marks }) => marks),
  };

  /** `account`'s rows and marks in the tables, as a change that commits reads and changes them. */
  const stored = (account: string): Projected => ({
    row: (key) => titleRows([statements.title.get(account, key)])[0],
    rowsOf: (seriesId) => titleRows(statements.seriesTitles.all(account, seriesId)),
    // The movie's row, or every row of the episode's series version.
    removedAt: (title) => {
      const seriesId = title.kind === "episode" ? title.seriesId : null;
      const removed = statements.removedAt.get(account, titleKey(title), seriesId);
      return typeof removed?.["removed_at"] === "number" ? removed["removed_at"] : null;
    },
    saveRow: (row) => saveTitle(db, account, row),
    remove: (_title, keys, at) => {
      for (const key of keys) statements.hide.run(at, account, key);
    },
    series: (key) => seriesOf(account, key) ?? noMarks,
    covering: (seriesId) =>
      seriesIn(account, [seriesId]).flatMap((key) => {
        const state = seriesOf(account, key);
        return state ? [[key, state] as const] : [];
      }),
    saveSeries: (key, state, changed) => saveSeries(db, account, key, state, changed),
  });

  /**
   * Where a marked series goes on as `account`'s record stands: from how far the versions it
   * listed got, the marks kept under its key and under each of those versions' ids, and the
   * episodes it listed when it was last marked.
   */
  const nextOf = (account: string, key: string, state: SeriesMarks) => {
    const keys = [...new Set([key, ...state.versions.map((id) => `id:${id}`)])];
    return goesOn(
      state.listing,
      titlesOf(account, { seriesIds: state.versions }),
      standing(marksOf(account, keys)),
    );
  };

  /** Each marked series of `account` that shows, most recently marked first. */
  const markedOf = (account: string): AccountRecord["marked"] =>
    statements.shown.all(account, CONTINUE_OFFERED).flatMap((row) => {
      const key = row["series"];
      const state = typeof key === "string" ? seriesOf(account, key) : null;
      const mark = state && leading(state);
      return typeof key === "string" && state && mark
        ? [{ mark, next: nextOf(account, key, state) }]
        : [];
    });

  /** An account's lists as stored, and how far its record has come. */
  const listsOf = (account: string): Pick<AccountRecord, "state" | "sequence"> => {
    const row = StateRow()(statements.state.get(account));
    if (row instanceof type.errors) return { state: emptyState, sequence: 0 };
    const favourites = Ids()(row.favourites);
    const recent = Ids()(row.recent);
    return {
      state: {
        favourites: favourites instanceof type.errors ? [] : favourites,
        recent: recent instanceof type.errors ? [] : recent,
      },
      sequence: row.sequence,
    };
  };

  const readOne = (account: string): AccountRecord => {
    const rows = titleRows(statements.recentTitles.all(account, CONTINUE_WINDOW));
    return {
      ...listsOf(account),
      continueWatching: continueWatching(rows),
      recentTitles: rows
        .filter((row) => !row.hidden && (row.finished || row.position >= STARTED_SECONDS))
        .slice(0, 32)
        .map(({ hidden: _hidden, removedAt: _removedAt, ...progress }) => progress),
      marked: markedOf(account),
    };
  };

  /** The records of `accounts` as one. One account's is its lists as they are stored. */
  const read = (accounts: readonly string[]): StoredViewing => {
    const records = accounts.map((account) => ({ account, ...readOne(account) }));
    const several = records.length > 1;
    const list = (of: "favourites" | "recent"): StoredChannel[] =>
      several
        ? merged(
            records.map(({ account, state }) => ({
              account,
              ids: state[of],
              placed: placedOf(account)[of],
            })),
            of === "favourites" ? 1 : -1,
          )
        : records.flatMap(({ account, state }) => state[of].map((id) => ({ account, id })));
    const continuing = records.flatMap(({ account, continueWatching }) =>
      continueWatching.map((progress) => ({ account, progress })),
    );
    const marks = records.flatMap(({ account, marked }) =>
      marked.map((each) => ({ account, ...each })),
    );
    return {
      favourites: list("favourites"),
      recent: list("recent"),
      continueWatching: several
        ? continuing.sort((a, b) => b.progress.at - a.progress.at).slice(0, CONTINUE_OFFERED)
        : continuing,
      marked: several
        ? marks.sort((a, b) => b.mark.at - a.mark.at).slice(0, CONTINUE_OFFERED)
        : marks,
      recentTitles: records
        .flatMap(({ account, recentTitles }) =>
          recentTitles.map((progress) => ({ account, progress })),
        )
        .sort((a, b) => b.progress.at - a.progress.at)
        .slice(0, 32),
      sequence: Math.max(0, ...records.map((record) => record.sequence)),
    };
  };

  /**
   * Appends `events`, each to its account's record and in the order given, and stores the state
   * each account's add up to. Answers the channel events written, with their sequences.
   */
  const append = (
    commandId: string,
    at: number,
    events: readonly AccountEvent[],
  ): { account: string; event: ChannelEvent; sequence: number }[] => {
    const written: { account: string; event: ChannelEvent; sequence: number }[] = [];
    /** How far each account's record came, by account, in the order first written to. */
    const last = new Map<string, number>();
    for (const { account, event } of events) {
      const channel = !isTitleEvent(event) && !isMarkEvent(event);
      const result = statements.event.run(
        account,
        event.type,
        EVENT_VERSION,
        channel ? event.channelId : "",
        at,
        commandId,
        channel ? null : payloadOf(event),
      );
      const sequence = Number(result.lastInsertRowid);
      last.set(account, sequence);
      if (channel) written.push({ account, event, sequence });
      else project(stored(account), event, at, sequence);
    }
    for (const [account, sequence] of last) {
      const own = written.flatMap((each) => (each.account === account ? [each.event] : []));
      save(db, account, apply(listsOf(account).state, own), sequence);
    }
    return written;
  };

  /**
   * Runs a write in one transaction, then notes where the channels it wrote stand. Only once it
   * has committed: one rolled back wrote nothing, and leaves what was worked out as it is.
   */
  const written = (write: () => ReturnType<typeof append>): void => {
    for (const { account, event, sequence } of transaction(db, write)) {
      const placed = places.get(account);
      // An account not worked out yet reads these with the rest of its events.
      if (placed) place(placed, event.type, event.channelId, sequence);
    }
  };

  return {
    read: (accounts) => attempt(() => read(accounts)),
    titles: (account, filter) => attempt(() => titlesOf(account, filter)),
    marks: (account, keys) => attempt(() => look.marks(account, keys)),
    marksIn: (account, seriesIds) => attempt(() => look.marksIn(account, seriesIds)),
    commit: ({ accounts, commandId, at, decide }) =>
      attempt(() => {
        let favouriteAdded = false;
        const added = usage?.action("favourite_added");
        written(() => {
          if (statements.done.get(commandId)) return [];
          const events = decide(read(accounts), look);
          // Thrown, so the transaction ends with nothing written.
          if (events instanceof Failed) throw events;
          // Reordering writes remove/add pairs. Only a net addition is a viewer action.
          const removed = new Map<string, Set<string>>();
          for (const { account, event } of events) {
            if (event.type !== "favourite-removed") continue;
            const channels = removed.get(account) ?? new Set<string>();
            channels.add(event.channelId);
            removed.set(account, channels);
          }
          favouriteAdded = events.some(
            ({ account, event }) =>
              event.type === "favourite-added" && !removed.get(account)?.has(event.channelId),
          );
          statements.receipt.run(commandId);
          return append(commandId, at, events);
        });
        if (favouriteAdded) added?.();
        return read(accounts);
      }),
    importOnce: ({ account, at, events }) =>
      attempt(() => {
        let imported = false;
        written(() => {
          if (statements.imported.get()) return [];
          imported = true;
          statements.markImported.run(String(at));
          return account
            ? append(
                "import",
                at,
                events.map((event) => ({ account, event })),
              )
            : [];
        });
        return imported;
      }),
    // The events go too, so no rebuild, here or in an older build, brings anything back, and so
    // does what the account saved to its watchlist, which the same file keeps. The account's key
    // and titles don't linger in the file either.
    erase: (account) =>
      attempt(() => {
        places.delete(account);
        deleteForGood(
          db,
          [
            "events",
            "state",
            "titles",
            ...MARK_TABLES,
            ...WATCHLIST_TABLES,
            VERIFIED_FILES_TABLE,
            DETAIL_CACHE_TABLE,
            SAVED_SUBTITLES_TABLE,
            SUBTITLE_RESULTS_TABLE,
            SUBTITLE_PROOFS_TABLE,
          ],
          account,
        );
      }),
  };
}

function payloadOf(event: TitleEvent | MarkEvent): string {
  switch (event.type) {
    case "title-progress":
      return JSON.stringify({
        title: event.title,
        position: event.position,
        duration: event.duration,
        since: event.since,
      });
    case "episode-marked":
      return JSON.stringify({
        series: event.series,
        title: event.title,
        watched: event.watched,
        versions: event.versions,
        listing: event.listing,
      });
    case "episode-mark-undone":
      return JSON.stringify({
        series: event.series,
        title: event.title,
        revision: event.revision,
      });
    case "series-listed":
      return JSON.stringify({
        series: event.series,
        versions: event.versions,
        listing: event.listing,
      });
    default:
      return JSON.stringify({ title: event.title });
  }
}

function save(db: DatabaseSync, account: string, state: ViewingState, sequence: number): void {
  db.prepare(
    "insert or replace into state (account, favourites, recent, sequence) values (?, ?, ?, ?)",
  ).run(account, JSON.stringify(state.favourites), JSON.stringify(state.recent), sequence);
}

/**
 * Stores what `account` keeps under a series' key, in place of what it kept, with the marks of
 * `changed`: a mark or its Undo changes one episode's, and only a rebuild writes them all.
 */
function saveSeries(
  db: DatabaseSync,
  account: string,
  key: string,
  state: SeriesMarks,
  changed: ChangedMarks,
): void {
  db.prepare(
    "insert or replace into marked_series (account, series, versions, listing, hidden, left_at, changed, undo, at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    account,
    key,
    JSON.stringify(state.versions),
    JSON.stringify(state.listing),
    state.hidden ? 1 : 0,
    state.leftAt,
    state.changed,
    state.undo && JSON.stringify(state.undo),
    // When it was last marked, which the series that show are read in the order of.
    leading(state)?.at ?? 0,
  );
  if (changed === "none") return;
  if (changed === "all") {
    db.prepare("delete from marked_episodes where account = ? and series = ?").run(account, key);
  } else {
    db.prepare(
      "delete from marked_episodes where account = ? and series = ? and season = ? and episode = ?",
    ).run(account, key, changed.season, changed.episode);
  }
  const insert = db.prepare(
    "insert into marked_episodes (account, series, season, episode, mark) values (?, ?, ?, ?, ?)",
  );
  for (const mark of state.marks) {
    if (changed !== "all" && (mark.season !== changed.season || mark.episode !== changed.episode)) {
      continue;
    }
    insert.run(account, key, mark.season, mark.episode, JSON.stringify(mark));
  }
}

function saveTitle(db: DatabaseSync, account: string, row: TitleRow): void {
  db.prepare(
    "insert or replace into titles (account, key, title, series_id, position, duration, finished, at, hidden, removed_at, since) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    account,
    titleKey(row.title),
    JSON.stringify(row.title),
    row.title.kind === "episode" ? row.title.seriesId : null,
    row.position,
    row.duration,
    row.finished ? 1 : 0,
    row.at,
    row.hidden ? 1 : 0,
    row.removedAt,
    row.since,
  );
}

/** A store for when the database can't open: every call reports why. */
function closed(detail: string): ViewingStore["Service"] {
  const fail = unavailable(detail);
  return {
    read: () => fail,
    titles: () => fail,
    marks: () => fail,
    marksIn: () => fail,
    commit: () => fail,
    importOnce: () => fail,
    erase: () => fail,
  };
}
