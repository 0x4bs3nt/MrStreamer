// The watchlist on disk, in the SQLite database it shares with the viewing record (database.ts):
// one row per saved movie or series and account, and one per version of it, which names the
// provider's row it was saved from. They are tables of their own. Nothing here is an event, and
// nothing the viewing record rebuilds from its events touches them, so playing, finishing or
// leaving Continue watching changes no entry.
//
// Like the viewing record, everything is kept per account by the provider's own ids, and nothing
// here names a subscription: the service says whose an account's rows are. A film several
// subscriptions list is saved once in each account that listed it then, and those rows are one
// entry by the TMDB id they share. A change to an entry writes every account's row of it in one
// transaction, so it is stored for all of them or for none.
//
// Which rows are a title, `sameTitle` says, and which are one entry, `sameEntry` (see
// @mrstreamer/core/ondemand/watchlist). The indexes only find the rows to ask them about.
//
// An entry is named by the row it was saved with first. A row an account gets of an entry later
// takes the entry's time, so the entry keeps its place when the first account goes. What tells
// the two rows apart then is the order they were written in, which is the order of their rowids:
// SQLite gives a new row a higher one than any row the table holds, and a row keeps its own
// while it is updated in place. So a row is updated, never replaced, and whatever rebuilds the
// table has to copy the rows in that order.
//
// A row holds a name, a year, a kind and whether it is for adults, to show when the provider
// lists it no more, and nothing else of the title: no address, no artwork, no details.
//
// Builds from before the watchlist share the file and never look at these tables: what they
// rebuild and what they erase is the viewing record's alone.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { TITLE_KINDS } from "@mrstreamer/contracts/ondemand";
import type { Failed } from "@mrstreamer/core/failure";
import {
  sameEntry,
  sameTitle,
  savedFirst,
  settled,
  type SavedTitle,
  type TitleFacts,
} from "@mrstreamer/core/ondemand/watchlist";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";
import { lazy } from "@mrstreamer/contracts/lazy";

/** The tables that hold an account's entries, each with an `account` column: erasing takes both. */
export const WATCHLIST_TABLES = ["watchlist", "watchlist_versions"] as const;

// One entry per TMDB id and kind in an account, of the titles the lists gather by that id: rows
// for adults stand on their own, and two of them can carry one id. A provider's id can be held
// by two entries: when the provider gave a saved title's id to another title, and the viewer
// saved that one too, each stays its own.
const SCHEMA = `
  create table if not exists watchlist (
    account text not null,
    id text not null,
    kind text not null,
    tmdb_id text,
    name text not null,
    year integer,
    adult integer not null,
    saved_at integer not null,
    primary key (account, id)
  );
  create unique index if not exists watchlist_by_tmdb
    on watchlist (account, kind, tmdb_id) where tmdb_id is not null and adult = 0;
  create table if not exists watchlist_versions (
    account text not null,
    entry_id text not null,
    kind text not null,
    version_id text not null,
    primary key (account, entry_id, version_id)
  );
  create index if not exists watchlist_versions_by_id
    on watchlist_versions (account, kind, version_id);
`;

const EntryRow = lazy(() =>
  type({
    rowid: "number",
    id: "string",
    kind: type.enumerated(...TITLE_KINDS),
    tmdb_id: "string | null",
    name: "string",
    year: "number | null",
    adult: "number",
    saved_at: "number",
  }),
);
const VersionRow = lazy(() => type({ entry_id: "string", version_id: "string" }));

/** What an account saved of a title: a row of its own, under its own id. */
export interface Membership extends SavedTitle {
  readonly account: string;
}

/**
 * A title as the lists of one account's subscription describe it now. It has no versions where
 * that subscription lists none of a title another one does.
 */
export interface ListedTitle {
  readonly account: string;
  readonly facts: TitleFacts;
}

/** Where the accounts' saved titles are kept. */
export class WatchlistStore extends Context.Service<
  WatchlistStore,
  {
    /** Everything `accounts` saved. */
    readonly entries: (accounts: readonly string[]) => Effect.Effect<readonly Membership[], Failed>;
    /**
     * What is saved first of the title `listed` describes, in whichever of its accounts, or null
     * when none of them saved it.
     */
    readonly find: (listed: readonly ListedTitle[]) => Effect.Effect<Membership | null, Failed>;
    /**
     * In one transaction: saves the title `listed` describes for every account whose
     * subscription lists a version of it, unless that account saved it already. Then the row it
     * has stays, with its own id and time, and takes the title's name and versions as they are
     * now. A new row gets the time the title was saved first in any of the accounts, else `at`,
     * and stands behind the rows there already: the entry keeps its id and its place. An account
     * that lists none of it gets no row. Answers what is saved first of the title after, or null
     * when no account lists it.
     */
    readonly save: (input: {
      readonly listed: readonly ListedTitle[];
      readonly at: number;
    }) => Effect.Effect<Membership | null, Failed>;
    /**
     * In one transaction: takes the entry that `account`'s row `id` is of out of `accounts`,
     * with every row they hold of it and its versions, also rows of titles no provider lists
     * any more. A row that is no other's entry goes alone. None of that id changes nothing.
     */
    readonly remove: (input: {
      readonly accounts: readonly string[];
      readonly account: string;
      readonly id: string;
    }) => Effect.Effect<void, Failed>;
    /**
     * In one transaction: gives each row of `account` that is one of `titles`, as its lists
     * describe them now, the title's name, year and versions, and its TMDB id once the lists have
     * one. Rows that turn out to be one title become the one saved first. A title nothing is
     * saved as changes nothing, so a row removed meanwhile stays removed.
     */
    readonly adopt: (account: string, titles: readonly TitleFacts[]) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/WatchlistStore") {}

/** The watchlist store, on the database the runtime keeps open. */
export const watchlistStoreLayer: Layer.Layer<WatchlistStore, never, Database> = Layer.effect(
  WatchlistStore,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(opened.failure);
    const { db } = opened;
    return yield* Effect.try(() => {
      db.exec(SCHEMA);
      return storeOn(db);
    }).pipe(
      Effect.catchTag("UnknownError", (failure) =>
        Effect.logWarning("[watchlist] the saved titles can't be read", failure.cause).pipe(
          Effect.as(closed(String(failure.cause))),
        ),
      ),
    );
  }),
);

function storeOn(db: DatabaseSync): WatchlistStore["Service"] {
  const statements = {
    entries: db.prepare("select rowid, * from watchlist where account = ?"),
    // In the order they were written, which is the order the lists showed them in.
    versions: db.prepare(
      "select entry_id, version_id from watchlist_versions where account = ? order by rowid",
    ),
    versionsOf: db.prepare(
      "select entry_id, version_id from watchlist_versions where account = ? and entry_id = ? order by rowid",
    ),
    entry: db.prepare("select rowid, * from watchlist where account = ? and id = ?"),
    byTmdb: db.prepare("select id from watchlist where account = ? and kind = ? and tmdb_id = ?"),
    byVersion: db.prepare(
      "select entry_id as id from watchlist_versions where account = ? and kind = ? and version_id = ?",
    ),
    // An entry there already keeps the time it was saved, and its place among the rows.
    write: db.prepare(
      `insert into watchlist (account, id, kind, tmdb_id, name, year, adult, saved_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (account, id) do update set
         kind = excluded.kind, tmdb_id = excluded.tmdb_id, name = excluded.name,
         year = excluded.year, adult = excluded.adult`,
    ),
    // Never in place of another entry's: that entry holds the provider's id for its own title.
    writeVersion: db.prepare(
      "insert into watchlist_versions (account, entry_id, kind, version_id) values (?, ?, ?, ?)",
    ),
    drop: db.prepare("delete from watchlist where account = ? and id = ?"),
    dropVersions: db.prepare("delete from watchlist_versions where account = ? and entry_id = ?"),
  };

  /** Rows as stored, each with the versions `versions` holds of it. */
  const read = (rows: readonly unknown[], versions: readonly unknown[]): SavedTitle[] => {
    const byEntry = Map.groupBy(
      versions.flatMap((raw) => {
        const row = VersionRow()(raw);
        return row instanceof type.errors ? [] : [row];
      }),
      (row) => row.entry_id,
    );
    return rows.flatMap((raw) => {
      const row = EntryRow()(raw);
      if (row instanceof type.errors) return [];
      return [
        {
          id: row.id,
          kind: row.kind,
          tmdbId: row.tmdb_id,
          versionIds: (byEntry.get(row.id) ?? []).map((version) => version.version_id),
          name: row.name,
          year: row.year,
          adult: row.adult === 1,
          savedAt: row.saved_at,
          sequence: row.rowid,
        },
      ];
    });
  };

  /** The row `id` of `account`, or none. */
  const row = (account: string, id: string): SavedTitle[] =>
    read(statements.entry.all(account, id), statements.versionsOf.all(account, id));

  /** The rows of `account` that hold `title`'s TMDB id: those to ask whether they are it. */
  const sharing = (account: string, { kind, tmdbId }: TitleFacts): string[] =>
    tmdbId ? statements.byTmdb.all(account, kind, tmdbId).map((found) => String(found["id"])) : [];

  /**
   * The rows of `account` that are the title its lists describe as `facts`: found by its TMDB id
   * or by one of its versions, then checked.
   */
  const matching = (account: string, facts: TitleFacts): SavedTitle[] => {
    const found = facts.versionIds.flatMap((id) =>
      statements.byVersion.all(account, facts.kind, id).map((each) => String(each["id"])),
    );
    return [...new Set([...sharing(account, facts), ...found])]
      .flatMap((id) => row(account, id))
      .filter((saved) => sameTitle(saved, facts));
  };

  /** What the accounts of `listed` saved of the title it describes, the one saved first in front. */
  const saved = (listed: readonly ListedTitle[]): Membership[] =>
    listed
      .flatMap(({ account, facts }) =>
        matching(account, facts).map((found) => ({ ...found, account })),
      )
      .toSorted(savedFirst);

  const drop = (account: string, id: string): void => {
    statements.dropVersions.run(account, id);
    statements.drop.run(account, id);
  };

  /** Writes a row, or the facts of one there already. A new one stands behind every other. */
  const write = (account: string, entry: Omit<SavedTitle, "sequence">): void => {
    statements.write.run(
      account,
      entry.id,
      entry.kind,
      entry.tmdbId,
      entry.name,
      entry.year,
      entry.adult ? 1 : 0,
      entry.savedAt,
    );
    statements.dropVersions.run(account, entry.id);
    for (const versionId of entry.versionIds) {
      statements.writeVersion.run(account, entry.id, entry.kind, versionId);
    }
  };

  /**
   * Brings what `account` saved of the title `facts` describe in line with it, and answers the
   * row that is left, or null when nothing is saved of it. Only runs in a transaction.
   */
  const take = (account: string, facts: TitleFacts): SavedTitle | null => {
    const matches = matching(account, facts);
    const made = settled(matches, facts);
    if (!made) return null;
    const { kept, dropped } = made;
    // Most rows are as the lists describe them: those are left as they are.
    const stored = matches.find((entry) => entry.id === kept.id);
    if (dropped.length === 0 && stored && sameFacts(stored, kept)) return kept;
    // First, so the row kept can take a TMDB id one of them held.
    for (const id of dropped) drop(account, id);
    write(account, kept);
    return kept;
  };

  return {
    entries: (accounts) =>
      attempt(() =>
        accounts.flatMap((account) =>
          read(statements.entries.all(account), statements.versions.all(account)).map((entry) => ({
            ...entry,
            account,
          })),
        ),
      ),
    find: (listed) => attempt(() => saved(listed)[0] ?? null),
    save: ({ listed, at }) =>
      attempt(() =>
        transaction(db, () => {
          // The entry keeps the place it has, whichever account's row gave it that, and the
          // id: a row written now stands behind that one, with the same time.
          const savedAt = saved(listed)[0]?.savedAt ?? at;
          for (const { account, facts } of listed) {
            if (facts.versionIds.length === 0 || take(account, facts)) continue;
            write(account, { ...facts, id: randomUUID(), savedAt });
          }
          return saved(listed)[0] ?? null;
        }),
      ),
    remove: ({ accounts, account, id }) =>
      attempt(() =>
        transaction(db, () => {
          const [named] = row(account, id);
          if (!named) return;
          drop(account, id);
          // What the other accounts saved of the same film is the same entry, and goes with it.
          for (const other of accounts) {
            for (const found of sharing(other, named).flatMap((each) => row(other, each))) {
              if (sameEntry(found, named)) drop(other, found.id);
            }
          }
        }),
      ),
    adopt: (account, titles) =>
      attempt(() =>
        transaction(db, () => {
          for (const facts of titles) take(account, facts);
        }),
      ),
  };
}

/** Whether a row holds what `facts` say of its title, versions in their order included. */
function sameFacts(entry: SavedTitle, facts: TitleFacts): boolean {
  return (
    entry.tmdbId === facts.tmdbId &&
    entry.name === facts.name &&
    entry.year === facts.year &&
    entry.adult === facts.adult &&
    entry.versionIds.length === facts.versionIds.length &&
    entry.versionIds.every((id, at) => id === facts.versionIds[at])
  );
}

/** A store for when the database can't open: every call reports why. */
function closed(detail: string): WatchlistStore["Service"] {
  const fail = unavailable(detail);
  return {
    entries: () => fail,
    find: () => fail,
    save: () => fail,
    remove: () => fail,
    adopt: () => fail,
  };
}
