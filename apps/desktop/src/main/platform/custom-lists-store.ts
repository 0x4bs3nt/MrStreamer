// The viewer's channel lists on disk, in the SQLite database the viewing record keeps
// (database.ts): a row per list, and a row per channel of a list, kept under the account of the
// subscription it is from by every stream id the channel was seen with, as the viewing record
// keeps favourites. The service says whose an account is and which channel a stored one is now
// (services/custom-lists.ts); nothing here names a subscription. Every change is one transaction.
//
// A list is the viewer's, not an account's: removing a subscription, or erasing what its account
// kept, leaves the list, possibly empty. Its channels of an account are that account's, and Also
// delete erases them with the rest of the account (viewing-store.ts deletes them with its events).
// A list's id comes from the window, so a create sent again answers the list it made. Every id a
// list was made under is kept, so one sent again after its list was deleted makes nothing.
//
// Builds from before custom lists share the file and never look at these tables, and their erase
// of an account deletes its events and not its channels here. So each account's channels are bound
// to an event of its own in the viewing record, its list anchor, of a type every build's record
// skips. The transaction that gives an account its first channel writes it, and only an erase
// deletes it, in this build and in those before. No other event is ever given its sequence. Each
// start, before anything reads them, deletes the channels whose anchor went: what an older build
// erased never shows again, whatever it recorded for the account afterwards.
import { randomUUID } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { lazy } from "@mrstreamer/contracts/lazy";
import { Failed } from "@mrstreamer/core/failure";
import { normalize } from "@mrstreamer/core/text";
import { EVENT_VERSION } from "@mrstreamer/core/viewing/record";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";

/** The table that holds an account's channels of every list, with an `account` column. */
export const CUSTOM_LIST_MEMBERS_TABLE = "custom_list_members";

/** The type of an account's list anchor among the viewing record's events. */
const ANCHOR = "list-anchor";

// `folded` is the name as lists are told apart, so two can't differ by case or accents alone.
// `streams` is a JSON array of every stream id the channel was seen with. `anchor` is the sequence
// of the account's list anchor in `events`.
const SCHEMA = `
  create table if not exists custom_lists (
    id text primary key,
    name text not null,
    folded text not null unique,
    position integer not null,
    revision integer not null
  );
  create table if not exists custom_list_members (
    list text not null,
    member text not null,
    account text not null,
    position integer not null,
    streams text not null,
    name text not null,
    adult integer not null,
    anchor integer not null,
    primary key (list, member)
  );
  create index if not exists custom_list_members_by_account on custom_list_members (account);
  create table if not exists custom_list_receipts (id text primary key);
`;

/** The channels of an account an erase took the list anchor of, as a `from` clause. */
const ERASED = `from custom_list_members as kept where not exists (
  select 1 from events
  where events.sequence = kept.anchor and events.account = kept.account and events.type = '${ANCHOR}'
)`;

/**
 * Makes the lists' tables, and deletes, for good, the channels of accounts that were erased: by
 * this build as it erases, or by an older one since this one last started. Before the viewing
 * record's events exist, on a new profile, there are none of either.
 */
export function prepareCustomLists(db: DatabaseSync): void {
  db.exec(SCHEMA);
  const record = db.prepare("select 1 from sqlite_master where type = 'table' and name = 'events'");
  if (!record.get() || !db.prepare(`select 1 ${ERASED} limit 1`).get()) return;
  // As an erase deletes: SQLite zeroes what it deletes, and the checkpoint moves it out of the
  // write-ahead log.
  db.exec("pragma secure_delete = on");
  try {
    transaction(db, () => db.prepare(`delete ${ERASED}`).run());
  } finally {
    db.exec("pragma secure_delete = off");
  }
  db.exec("pragma wal_checkpoint(truncate)");
}

/** A channel of a list as stored: one account's, by every stream id it was seen with. */
export interface StoredMember {
  readonly member: string;
  readonly account: string;
  /** Every stream id it was seen with, the one it was found by when last listed first. */
  readonly streams: readonly string[];
  /** What it was called when last listed, and whether it was for adults then. */
  readonly name: string;
  readonly adult: boolean;
}

export interface StoredList {
  readonly id: string;
  readonly name: string;
  readonly revision: number;
  /** In the list's order. */
  readonly members: readonly StoredMember[];
}

/** A channel as its subscription lists it now, under the account that subscription is. */
export interface ListedChannel {
  readonly account: string;
  /** Its stream ids, the one it is to be found by first. */
  readonly streams: readonly string[];
  readonly name: string;
  readonly adult: boolean;
  /**
   * Whether that subscription is saved still, with the login it had: asked first in the
   * transaction of a change that names the channel, so a removal that erases the account can't
   * come between the answer and the change. A no fails with `no-subscription`, writing nothing.
   */
  readonly stands: () => boolean;
}

/** What a stored channel is to hold as it is listed now: its streams, name and adult mark. */
export type ListedNow = Omit<ListedChannel, "account" | "stands">;

/** Where the viewer's channel lists are kept. */
export class CustomListStore extends Context.Service<
  CustomListStore,
  {
    /** Every list, in the viewer's order, each with its channels in theirs. */
    readonly lists: Effect.Effect<readonly StoredList[], Failed>;
    /**
     * In one transaction: makes a list called `name` after the others, holding `first` when
     * given, under `id`. A list made under `id` before stays as it is, and one deleted since
     * fails with `no-list`. Fails with `list-name-taken` when another list is called the same,
     * apart from case and accents, and with `no-subscription` once `first` stands no more.
     */
    readonly create: (input: {
      readonly id: string;
      readonly name: string;
      readonly first: ListedChannel | null;
      readonly at: number;
    }) => Effect.Effect<void, Failed>;
    /** Calls a list `name`, with the same failures as `create`. Its channels stay as they are. */
    readonly rename: (id: string, name: string) => Effect.Effect<void, Failed>;
    /**
     * Puts the lists in `order`, by their ids. Fails with `list-changed`, changing nothing,
     * unless it names every list there is, each once.
     */
    readonly order: (order: readonly string[]) => Effect.Effect<void, Failed>;
    /** Deletes a list with every channel it holds, of whichever account. None of that id is fine. */
    readonly remove: (id: string) => Effect.Effect<void, Failed>;
    /**
     * In one transaction: adds `channel` at the end of list `list` unless one of its account's
     * channels there is it, as `same` says of each; without `member`, takes every such one out.
     * Answers whether that changed the list. Fails with `no-subscription` once `channel` stands
     * no more, and with `no-list` without the list.
     */
    readonly setMember: (input: {
      readonly list: string;
      readonly channel: ListedChannel;
      readonly member: boolean;
      readonly same: (stored: StoredMember) => boolean;
      readonly at: number;
    }) => Effect.Effect<boolean, Failed>;
    /** Takes one channel out of a list, by its member id. Answers whether it was there. */
    readonly removeMember: (list: string, member: string) => Effect.Effect<boolean, Failed>;
    /**
     * In one transaction: gives the channels `order` names, by member id, the places those of
     * them had, in that order, and leaves every other where it is. `shown` says which of the
     * list's channels the viewer sees, as the order was made, by member id. Fails with
     * `list-changed`, changing nothing, once the list's revision is another than `revision`, or
     * when `order` names a channel twice or one not shown. Answers whether the order changed.
     */
    readonly arrange: (input: {
      readonly list: string;
      readonly revision: number;
      readonly order: readonly string[];
      readonly shown: (members: readonly StoredMember[]) => ReadonlySet<string>;
    }) => Effect.Effect<boolean, Failed>;
    /**
     * In one transaction: gives each channel of `account` in every list what `now` says it holds
     * now, or leaves it as it is where `now` answers null. Channels that hold that already aren't
     * written, and neither the lists' order nor their revisions change.
     */
    readonly align: (
      account: string,
      now: (stored: StoredMember) => ListedNow | null,
    ) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/CustomListStore") {}

const ListRow = lazy(() => type({ id: "string", name: "string", revision: "number" }));
const MemberRow = lazy(() =>
  type({
    list: "string",
    member: "string",
    account: "string",
    streams: type("string.json.parse").pipe(type("string[]")),
    name: "string",
    adult: "number",
  }),
);

/** The custom list store, on the database the runtime keeps open. */
export const customListStoreLayer: Layer.Layer<CustomListStore, never, Database> = Layer.effect(
  CustomListStore,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(opened.failure);
    const { db } = opened;
    return yield* Effect.try(() => {
      prepareCustomLists(db);
      return storeOn(db);
    }).pipe(
      Effect.catchTag("UnknownError", (failure) =>
        Effect.logWarning("[lists] the channel lists can't be read", failure.cause).pipe(
          Effect.as(closed(String(failure.cause))),
        ),
      ),
    );
  }),
);

/** The name lists are told apart by: without case or accents, or as it is when that is nothing. */
function foldedOf(name: string): string {
  return normalize(name) || name;
}

function storeOn(db: DatabaseSync): CustomListStore["Service"] {
  const statements = {
    lists: db.prepare("select id, name, revision from custom_lists order by position, rowid"),
    list: db.prepare("select id, name, revision from custom_lists where id = ?"),
    members: db.prepare(
      "select * from custom_list_members where list = ? order by position, rowid",
    ),
    allMembers: db.prepare("select * from custom_list_members order by list, position, rowid"),
    accountMembers: db.prepare("select * from custom_list_members where account = ?"),
    named: db.prepare("select id from custom_lists where folded = ?"),
    made: db.prepare("select 1 from custom_list_receipts where id = ?"),
    receipt: db.prepare("insert into custom_list_receipts (id) values (?)"),
    last: db.prepare("select coalesce(max(position), -1) as position from custom_lists"),
    insertList: db.prepare(
      "insert into custom_lists (id, name, folded, position, revision) values (?, ?, ?, ?, 0)",
    ),
    renameList: db.prepare("update custom_lists set name = ?, folded = ? where id = ?"),
    placeList: db.prepare("update custom_lists set position = ? where id = ?"),
    revise: db.prepare("update custom_lists set revision = revision + 1 where id = ?"),
    dropList: db.prepare("delete from custom_lists where id = ?"),
    dropMembers: db.prepare("delete from custom_list_members where list = ?"),
    lastMember: db.prepare(
      "select coalesce(max(position), -1) as position from custom_list_members where list = ?",
    ),
    insertMember: db.prepare(
      `insert into custom_list_members (list, member, account, position, streams, name, adult, anchor)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    dropMember: db.prepare("delete from custom_list_members where list = ? and member = ?"),
    placeMember: db.prepare(
      "update custom_list_members set position = ? where list = ? and member = ?",
    ),
    alignMember: db.prepare(
      "update custom_list_members set streams = ?, name = ?, adult = ? where list = ? and member = ?",
    ),
  };
  // These read and write the viewing record's events, which an older profile may lack until the
  // record is prepared: made the first time an account gets a channel.
  let anchors: { readonly kept: StatementSync; readonly write: StatementSync } | null = null;

  /**
   * The sequence of `account`'s list anchor, written now when none of its channels has one that
   * stands. Only runs in a transaction.
   */
  const anchorOf = (account: string, at: number): number => {
    anchors ??= {
      kept: db.prepare(
        `select kept.anchor from custom_list_members as kept join events
         on events.sequence = kept.anchor and events.account = kept.account and events.type = '${ANCHOR}'
         where kept.account = ? limit 1`,
      ),
      write: db.prepare(
        "insert into events (account, type, version, channel_id, at, command_id) values (?, ?, ?, '', ?, ?)",
      ),
    };
    const kept = anchors.kept.get(account)?.["anchor"];
    if (typeof kept === "number") return kept;
    return Number(
      anchors.write.run(account, ANCHOR, EVENT_VERSION, at, randomUUID()).lastInsertRowid,
    );
  };

  const membersOf = (rows: readonly unknown[]): (StoredMember & { readonly list: string })[] =>
    rows.flatMap((raw) => {
      const row = MemberRow()(raw);
      if (row instanceof type.errors) return [];
      const { list, member, account, streams, name, adult } = row;
      return [{ list, member, account, streams, name, adult: adult === 1 }];
    });

  const listOf = (id: string) => {
    const row = ListRow()(statements.list.get(id));
    return row instanceof type.errors ? null : row;
  };

  /** The list `id`, or `no-list`. Only runs in a transaction. */
  const existing = (id: string) => listOf(id) ?? fail("no-list");

  /** Fails with `list-name-taken` when a list other than `id` is called `name`, as told apart. */
  const unclaimed = (id: string, name: string): string => {
    const folded = foldedOf(name);
    const holder = statements.named.get(folded)?.["id"];
    if (holder !== undefined && holder !== id) fail("list-name-taken");
    return folded;
  };

  /** Adds `channel` at the end of list `list`. Only runs in a transaction. */
  const append = (list: string, channel: ListedChannel, at: number): void => {
    const last = Number(statements.lastMember.get(list)?.["position"] ?? -1);
    statements.insertMember.run(
      list,
      randomUUID(),
      channel.account,
      last + 1,
      JSON.stringify(channel.streams),
      channel.name,
      channel.adult ? 1 : 0,
      anchorOf(channel.account, at),
    );
  };

  return {
    lists: attempt(() => {
      const members = Map.groupBy(membersOf(statements.allMembers.all()), (each) => each.list);
      return statements.lists.all().flatMap((raw) => {
        const row = ListRow()(raw);
        if (row instanceof type.errors) return [];
        const own = members.get(row.id) ?? [];
        return [{ ...row, members: own.map(({ list: _list, ...member }) => member) }];
      });
    }),

    create: ({ id, name, first, at }) =>
      attempt(() =>
        transaction(db, () => {
          if (first && !first.stands()) fail("no-subscription");
          if (statements.made.get(id)) {
            existing(id);
            return;
          }
          const folded = unclaimed(id, name);
          const last = Number(statements.last.get()?.["position"] ?? -1);
          statements.insertList.run(id, name, folded, last + 1);
          statements.receipt.run(id);
          if (first) append(id, first, at);
        }),
      ),

    rename: (id, name) =>
      attempt(() =>
        transaction(db, () => {
          existing(id);
          statements.renameList.run(name, unclaimed(id, name), id);
        }),
      ),

    order: (order) =>
      attempt(() =>
        transaction(db, () => {
          const ids = statements.lists.all().map((row) => String(row["id"]));
          const asked = new Set(order);
          if (asked.size !== order.length || ids.length !== order.length) fail("list-changed");
          if (ids.some((id) => !asked.has(id))) fail("list-changed");
          for (const [position, id] of order.entries()) statements.placeList.run(position, id);
        }),
      ),

    remove: (id) =>
      attempt(() =>
        transaction(db, () => {
          statements.dropMembers.run(id);
          statements.dropList.run(id);
        }),
      ),

    setMember: ({ list, channel, member, same, at }) =>
      attempt(() =>
        transaction(db, () => {
          if (!channel.stands()) fail("no-subscription");
          existing(list);
          const found = membersOf(statements.members.all(list)).filter(
            (stored) => stored.account === channel.account && same(stored),
          );
          if (member && found.length > 0) return false;
          if (!member && found.length === 0) return false;
          if (member) append(list, channel, at);
          for (const stored of found) statements.dropMember.run(list, stored.member);
          statements.revise.run(list);
          return true;
        }),
      ),

    removeMember: (list, member) =>
      attempt(() =>
        transaction(db, () => {
          existing(list);
          if (statements.dropMember.run(list, member).changes === 0) return false;
          statements.revise.run(list);
          return true;
        }),
      ),

    arrange: ({ list, revision, order, shown }) =>
      attempt(() =>
        transaction(db, () => {
          if (existing(list).revision !== revision) fail("list-changed");
          const members = membersOf(statements.members.all(list));
          const visible = shown(members);
          const moved = new Set(order);
          if (moved.size !== order.length || order.some((each) => !visible.has(each))) {
            fail("list-changed");
          }
          // The channels arranged take one another's places; every other keeps its own.
          let next = 0;
          const placed = members.map((each) =>
            moved.has(each.member) ? (order[next++] ?? each.member) : each.member,
          );
          if (placed.every((each, at) => each === members[at]?.member)) return false;
          for (const [position, member] of placed.entries()) {
            statements.placeMember.run(position, list, member);
          }
          statements.revise.run(list);
          return true;
        }),
      ),

    align: (account, now) =>
      attempt(() =>
        transaction(db, () => {
          for (const stored of membersOf(statements.accountMembers.all(account))) {
            const listed = now(stored);
            if (
              !listed ||
              (listed.name === stored.name &&
                listed.adult === stored.adult &&
                listed.streams.length === stored.streams.length &&
                listed.streams.every((id, at) => id === stored.streams[at]))
            ) {
              continue;
            }
            statements.alignMember.run(
              JSON.stringify(listed.streams),
              listed.name,
              listed.adult ? 1 : 0,
              stored.list,
              stored.member,
            );
          }
        }),
      ),
  };
}

/** Throws a failure the UI knows, which ends the transaction it is in with nothing written. */
function fail(kind: "no-list" | "list-name-taken" | "list-changed" | "no-subscription"): never {
  throw new Failed({ error: { kind } });
}

/** A store for when the database can't open: every call reports why. */
function closed(detail: string): CustomListStore["Service"] {
  const failure = unavailable(detail);
  return {
    lists: failure,
    create: () => failure,
    rename: () => failure,
    order: () => failure,
    remove: () => failure,
    setMember: () => failure,
    removeMember: () => failure,
    arrange: () => failure,
    align: () => failure,
  };
}
