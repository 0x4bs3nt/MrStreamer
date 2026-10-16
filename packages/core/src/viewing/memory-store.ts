// The viewing record's store held in memory as plain data, for an app without SQLite: iOS keeps
// its snapshot in one file, written whole after every change. It runs the same projection as the
// desktop's tables (./project.ts) and reads the same way, so the record service (./service.ts)
// answers alike over either.
//
// It keeps the state the events add up to, not the events: a phone records a checkpoint a minute
// while a title plays, and a file of every one would grow without end. So nothing here is rebuilt
// when the rules change (STATE_VERSION); the rows and marks stay as they were committed. Command
// ids are kept for the latest commands only, enough for a command sent again to change nothing.
import { CONTINUE_OFFERED } from "@mrstreamer/contracts/viewing";
import * as Effect from "effect/Effect";
import { Failed, failedWith } from "../failure.ts";
import { goesOn, leading, standing, type SeriesMarks } from "./marks.ts";
import { merged, place, project, remembered, type Placed, type Remembered } from "./project.ts";
import {
  apply,
  emptyState,
  isMarkEvent,
  isTitleEvent,
  type AccountEvent,
  type ChannelEvent,
  type StoredChannel,
  type ViewingState,
} from "./record.ts";
import type { RawTitleFilter, StoredLook, StoredViewing, ViewingStore } from "./service.ts";
import { STARTED_SECONDS, continueWatching, type RawProgress, type TitleRow } from "./titles.ts";

/** One account's record as the snapshot keeps it. */
export interface AccountSnapshot {
  readonly state: ViewingState;
  readonly sequence: number;
  /** The sequence of the event that gave each favourite and recent channel its place. */
  readonly placed: {
    readonly favourites: Readonly<Record<string, number>>;
    readonly recent: Readonly<Record<string, number>>;
  };
  readonly rows: readonly TitleRow[];
  readonly removals: Readonly<Record<string, number>>;
  readonly series: Readonly<Record<string, SeriesMarks>>;
}

/** Everything the store holds, as JSON. */
export interface ViewingSnapshot {
  readonly version: 1;
  /** The last event's number, across every account. */
  readonly sequence: number;
  /** The latest commands done, oldest first. */
  readonly receipts: readonly string[];
  readonly imported: boolean;
  readonly accounts: Readonly<Record<string, AccountSnapshot>>;
}

/** Commands remembered as done. */
const RECEIPTS = 500;
/** Title rows read for Continue watching, most recent first, as the desktop's store reads them. */
const CONTINUE_WINDOW = 2000;

interface Account extends Remembered {
  state: ViewingState;
  sequence: number;
  readonly placed: Placed;
}

const fresh = (): Account => ({
  ...remembered(),
  state: emptyState,
  sequence: 0,
  placed: { favourites: new Map(), recent: new Map() },
});

function accountOf(saved: AccountSnapshot): Account {
  return {
    rows: new Map(saved.rows.map((row) => [titleKeyOf(row), row])),
    removals: new Map(Object.entries(saved.removals)),
    series: new Map(Object.entries(saved.series)),
    state: saved.state,
    sequence: saved.sequence,
    placed: {
      favourites: new Map(Object.entries(saved.placed.favourites)),
      recent: new Map(Object.entries(saved.placed.recent)),
    },
  };
}

const titleKeyOf = (row: TitleRow) => `${row.title.kind}:${row.title.id}`;

/**
 * A viewing store over `snapshot`, or an empty one, that hands `save` the whole snapshot after
 * every change. A change `save` throws for is undone and fails, as a transaction would.
 */
export function memoryViewingStore(deps: {
  readonly snapshot: ViewingSnapshot | null;
  readonly save: (snapshot: ViewingSnapshot) => void;
}): ViewingStore["Service"] {
  let saved: ViewingSnapshot = deps.snapshot ?? {
    version: 1,
    sequence: 0,
    receipts: [],
    imported: false,
    accounts: {},
  };
  let accounts = new Map<string, Account>();
  let receipts = new Set<string>();
  let sequence = 0;
  let imported = false;
  const load = (from: ViewingSnapshot) => {
    accounts = new Map(Object.entries(from.accounts).map(([key, each]) => [key, accountOf(each)]));
    receipts = new Set(from.receipts);
    sequence = from.sequence;
    imported = from.imported;
  };
  load(saved);

  const snapshot = (): ViewingSnapshot => ({
    version: 1,
    sequence,
    receipts: [...receipts].slice(-RECEIPTS),
    imported,
    accounts: Object.fromEntries(
      [...accounts].map(([key, each]) => [
        key,
        {
          state: each.state,
          sequence: each.sequence,
          placed: {
            favourites: Object.fromEntries(each.placed.favourites),
            recent: Object.fromEntries(each.placed.recent),
          },
          rows: [...each.rows.values()],
          removals: Object.fromEntries(each.removals),
          series: Object.fromEntries(each.series),
        },
      ]),
    ),
  });

  /** Runs `change` as one transaction: kept and saved whole, or undone whole. */
  const transaction = <A>(change: () => A): A => {
    try {
      const result = change();
      const next = snapshot();
      deps.save(next);
      saved = next;
      receipts = new Set(next.receipts);
      return result;
    } catch (cause) {
      load(saved);
      throw cause;
    }
  };

  const strip = ({ hidden: _hidden, removedAt: _removedAt, ...progress }: TitleRow): RawProgress =>
    progress;

  const titlesOf = (account: string, filter: RawTitleFilter): RawProgress[] => {
    const held = accounts.get(account);
    if (!held) return [];
    const series = new Set(filter.seriesIds ?? []);
    return [
      ...[...held.rows.values()].filter(
        ({ title }) => title.kind === "episode" && series.has(title.seriesId),
      ),
      ...(filter.movieIds ?? []).flatMap((id) => held.rows.get(`movie:${id}`) ?? []),
    ].map(strip);
  };

  const marksOf = (account: string, keys: readonly string[]): SeriesMarks[] => {
    const held = accounts.get(account);
    return held ? keys.flatMap((key) => held.series.get(key) ?? []) : [];
  };

  const look: StoredLook = {
    titles: titlesOf,
    marks: marksOf,
    marksIn: (account, seriesIds) => {
      const held = accounts.get(account);
      if (!held) return [];
      const keys = [...held.series]
        .filter(([, state]) => state.versions.some((id) => seriesIds.includes(id)))
        .map(([key]) => key);
      return marksOf(account, keys).flatMap(({ marks }) => marks);
    },
  };

  const readOne = (account: string) => {
    const held = accounts.get(account) ?? fresh();
    // The latest first; of two saved at the same moment, the one written last.
    const rows = [...held.rows.values()]
      .toReversed()
      .sort((a, b) => b.at - a.at)
      .slice(0, CONTINUE_WINDOW);
    const marked = [...held.series]
      .flatMap(([key, state]) => {
        const mark = leading(state);
        return !state.hidden && mark && mark.at > 0 ? [{ key, state, mark }] : [];
      })
      .sort((a, b) => b.mark.at - a.mark.at)
      .slice(0, CONTINUE_OFFERED)
      .map(({ key, state, mark }) => {
        const keys = [...new Set([key, ...state.versions.map((id) => `id:${id}`)])];
        const next = goesOn(
          state.listing,
          titlesOf(account, { seriesIds: state.versions }),
          standing(marksOf(account, keys)),
        );
        return { mark, next };
      });
    return {
      account,
      held,
      continueWatching: continueWatching(rows),
      recentTitles: rows
        .filter((row) => !row.hidden && (row.finished || row.position >= STARTED_SECONDS))
        .slice(0, 32)
        .map(strip),
      marked,
    };
  };

  const read = (wanted: readonly string[]): StoredViewing => {
    const records = wanted.map(readOne);
    const several = records.length > 1;
    const list = (of: "favourites" | "recent"): StoredChannel[] =>
      several
        ? merged(
            records.map(({ account, held }) => ({
              account,
              ids: held.state[of],
              placed: held.placed[of],
            })),
            of === "favourites" ? 1 : -1,
          )
        : records.flatMap(({ account, held }) => held.state[of].map((id) => ({ account, id })));
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
      sequence: Math.max(0, ...records.map(({ held }) => held.sequence)),
    };
  };

  /** Appends `events`, each to its account's record in the order given, as the tables would. */
  const append = (at: number, events: readonly AccountEvent[]) => {
    const channels = new Map<string, ChannelEvent[]>();
    for (const { account, event } of events) {
      let held = accounts.get(account);
      if (!held) accounts.set(account, (held = fresh()));
      held.sequence = ++sequence;
      if (!isTitleEvent(event) && !isMarkEvent(event)) {
        place(held.placed, event.type, event.channelId, sequence);
        channels.set(account, [...(channels.get(account) ?? []), event]);
      } else {
        project(remembered(held).view, event, at, sequence);
      }
    }
    for (const [account, own] of channels) {
      const held = accounts.get(account);
      if (held) held.state = apply(held.state, own);
    }
  };

  const attempt = <A>(run: () => A): Effect.Effect<A, Failed> =>
    Effect.try({
      try: run,
      catch: (cause) => (cause instanceof Failed ? cause : failedWith(cause)),
    });

  return {
    read: (wanted) => attempt(() => read(wanted)),
    titles: (account, filter) => attempt(() => titlesOf(account, filter)),
    marks: (account, keys) => attempt(() => marksOf(account, keys)),
    marksIn: (account, seriesIds) => attempt(() => look.marksIn(account, seriesIds)),
    commit: ({ accounts: wanted, commandId, at, decide }) =>
      attempt(() => {
        if (receipts.has(commandId)) return read(wanted);
        const events = decide(read(wanted), look);
        // Thrown, so the transaction stores nothing, the command's id neither.
        if (events instanceof Failed) throw events;
        transaction(() => {
          receipts.add(commandId);
          append(at, events);
        });
        return read(wanted);
      }),
    importOnce: ({ account, at, events }) =>
      attempt(() => {
        if (imported) return false;
        transaction(() => {
          imported = true;
          if (account)
            append(
              at,
              events.map((event) => ({ account, event })),
            );
        });
        return true;
      }),
    erase: (account) =>
      attempt(() => {
        transaction(() => accounts.delete(account));
      }),
  };
}
