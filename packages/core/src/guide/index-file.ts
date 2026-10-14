// A guide document's programmes on disk: one SQLite file per downloaded document, written once
// by `buildGuideIndex` and only read after that. The app builds it in a worker thread, from the
// document as it was saved. The main process reads only what a view asks for, a channel at a
// time: a screen of channels now and next, a channel's schedule, a page of a grid. Searches,
// which may read many programmes of many channels, run in a worker of their own (`searchFirst`,
// `searchEach`). What stays in memory while a guide is in use is its channels, about 200 bytes
// each.
//
// Programmes are kept by guide channel and start (`programme`, its primary key), in time order
// and without overlaps, as `timeline` below lays them out. Titles are kept once each, folded for
// search, and the (title, start) index finds a search's programmes in time order without reading
// the others; programmes over six hours long have an index of their own.
//
// Ended programmes stay for the guide's archive window, so catch-up and a grid can show the
// past; the next download of the same source brings along the past its document no longer
// lists, on the channels it still has, and drops what fell out of the window.
//
// A file is never changed once written: it is replaced by another. So it is read without locks,
// by as many connections as like, the main process's and a search worker's.
import { rename, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { AppFailure } from "@mrstreamer/contracts/errors";
import {
  GUIDE_RANGE,
  GUIDE_SCHEDULE,
  type GuideFailure,
  type GuideSlot,
  type Listing,
  type Programme,
} from "@mrstreamer/contracts/guide";
import { normalize } from "../text.ts";
import { xmltvDocument } from "./document.ts";
import { GUIDE_KEPT, GUIDE_LIMITS, type GuideLimits } from "./limits.ts";
import { xmltvReader } from "./xmltv.ts";

/**
 * The layout of the files this release writes. A file of another is read as no guide. 2: rows
 * within `GUIDE_KEPT`.
 */
const VERSION = 2;
/** Programmes written per transaction while a document is read, or text of this many bytes. */
const BATCH = { programmes: 5_000, bytes: 8 * 1024 * 1024 };
/** How often the build says how far it got. */
const PROGRESS_MS = 200;
/** Titles the build remembers the key of, of this many bytes at most; past that it asks the file. */
const TITLE_CACHE = { titles: 100_000, bytes: 8 * 1024 * 1024 };
/** Opening an index on the main process lets other work in once it has run this long. */
const SLICE_MS = 8;
/** Title keys one step of a search compares with its words, matching or not. */
const TITLES_PER_PAGE = 10_000;
/** How far past `at` each stretch a search reads ends: six hours, a day, four days, then all. */
const STRETCHES = [6, 24, 96].map((hours) => hours * 60 * 60 * 1000);
/**
 * Programmes longer than this are indexed apart for searches: a search reads what began this long
 * before now for what is on now, and the few longer ones, a day's coverage or a four-day event,
 * on their own.
 */
const LONG_MS = 6 * 60 * 60 * 1000;

/** What `buildGuideIndex` reads and writes. Paths are absolute. */
export interface GuideBuild {
  /** The document as it was downloaded or kept: XMLTV, packed with gzip or not. */
  readonly document: string;
  /** Where the index goes. It is there, whole, once the build succeeds, and not before. */
  readonly target: string;
  /**
   * The index of the same source before this one, or null. The past it keeps that this document
   * no longer lists comes along, within the archive window.
   */
  readonly previous: string | null;
  /** Epoch milliseconds the document was downloaded at: what ends later is still to come. */
  readonly since: number;
  /** How long ended programmes are kept, in milliseconds. */
  readonly archive: number;
  /**
   * For a document from an address the viewer gave: it must be one whole `<tv>` from its
   * opening tag to its closing one, with a programme still to come. A provider's own guide is
   * taken as it is sent, as it always was.
   */
  readonly strict: boolean;
  /** What it is read under: `GUIDE_LIMITS`, unless a test reads under smaller ones. */
  readonly limits?: GuideLimits;
}

/** What a build wrote. */
export interface GuideIndexSummary {
  /** Channels the guide lists. */
  readonly channels: number;
  readonly programmes: number;
  /** When its last programme ends, or null without one. */
  readonly until: number | null;
}

/**
 * Indexes the document at `build.document` into `build.target`, telling `progress` how many
 * programmes it has read as it goes. Fails, writing nothing, when the document lists no
 * programmes, is past one of the limits, or, when strict, isn't a whole guide with something to
 * come. Takes as long as the document does to read: the app runs it in a worker thread.
 */
export async function buildGuideIndex(
  build: GuideBuild,
  progress: (programmes: number) => void,
): Promise<GuideIndexSummary> {
  const { since, strict, limits = GUIDE_LIMITS } = build;
  const cutoff = since - build.archive;
  const part = `${build.target}.part`;
  await rm(part, { force: true });
  const db = new DatabaseSync(part);
  try {
    db.exec(`
      pragma journal_mode = off;
      pragma synchronous = off;
      pragma main.locking_mode = exclusive;
      pragma cache_size = -16000;
      create table channel (
        key integer primary key,
        id text not null unique,
        name text not null,
        folded text not null,
        position integer not null default 0,
        until integer
      );
      create table title (key integer primary key, text text not null unique, folded text not null);
      create table programme (
        channel integer not null,
        start integer not null,
        stop integer,
        title integer not null,
        description text,
        primary key (channel, start)
      ) without rowid;
      create table meta (programmes integer not null, until integer);
    `);
    const channels = new Map<string, { key: number; name: string | null }>();
    const listed = (id: string, name: string | null) => {
      const known = channels.get(id);
      if (known) {
        // A name given later, or again, stands; programmes alone name a channel by its id.
        if (name !== null) known.name = copied(kept(name, GUIDE_KEPT.nameChars));
        return known.key;
      }
      if (channels.size === limits.channels)
        throw failure({ kind: "too-large", limit: "channels" });
      const entry = {
        key: channels.size + 1,
        name: name && copied(kept(name, GUIDE_KEPT.nameChars)),
      };
      channels.set(copied(id), entry);
      return entry.key;
    };

    const insertTitle = db.prepare("insert into title (text, folded) values (?, ?)");
    const findTitle = db.prepare("select key from title where text = ?");
    const titles = new Map<string, number>();
    /** About how many bytes the titles in `titles` take. */
    let cachedBytes = 0;
    /** Whether `titles` holds every title written so far: then one it lacks is new. */
    let whole = true;
    const titleKey = (text: string) => {
      const cached = titles.get(text);
      if (cached !== undefined) return cached;
      const found = whole ? undefined : findTitle.get(text)?.["key"];
      const key =
        typeof found === "number"
          ? found
          : Number(insertTitle.run(text, normalize(text)).lastInsertRowid);
      if (titles.size === TITLE_CACHE.titles || cachedBytes >= TITLE_CACHE.bytes) {
        titles.clear();
        cachedBytes = 0;
        whole = false;
      }
      titles.set(copied(text), key);
      cachedBytes += text.length * 2;
      return key;
    };
    // Duplicates of a start time count once: the first the document lists, also when it has no
    // end and a later one does, so it runs until the next start. Releases before 0.0.13 kept the
    // later one then, as they dropped an entry whose end the next start would make empty.
    const insertProgramme = db.prepare("insert or ignore into programme values (?, ?, ?, ?, ?)");
    // Each programme is written as it is read, so nothing of it stays in memory; a transaction
    // ends every so many programmes or bytes.
    let pending = { programmes: 0, bytes: 0 };
    let read = 0;
    let told = performance.now();
    const commit = () => {
      db.exec("commit");
      pending = { programmes: 0, bytes: 0 };
      if (performance.now() - told >= PROGRESS_MS) {
        told = performance.now();
        progress(read);
      }
      db.exec("begin");
    };
    const reader = xmltvReader(
      {
        channel({ id, name }) {
          if (id.length <= GUIDE_KEPT.idChars) listed(id, name);
        },
        programme(entry) {
          read++;
          if (entry.stop !== null && entry.stop <= cutoff) return;
          if (entry.channel.length > GUIDE_KEPT.idChars) return;
          const title = kept(entry.title, GUIDE_KEPT.titleChars);
          const description =
            entry.description && kept(entry.description, GUIDE_KEPT.descriptionChars);
          // Counted as it comes, so a guide past the limit stops here rather than at its end.
          const channel = listed(entry.channel, null);
          insertProgramme.run(channel, entry.start, entry.stop, titleKey(title), description);
          pending.programmes++;
          pending.bytes += 2 * (title.length + (description?.length ?? 0));
          if (pending.programmes >= BATCH.programmes || pending.bytes >= BATCH.bytes) commit();
        },
      },
      limits.elementBytes,
    );
    const file = createReadStream(build.document, { highWaterMark: 64 * 1024 });
    db.exec("begin");
    for await (const chunk of xmltvDocument(file, limits.bytes)) reader.push(chunk);
    db.exec("commit");
    progress(read);
    const ending = reader.end();
    if (strict && ending !== "whole") throw failure({ kind: ending });
    if (read === 0) throw failure({ kind: "empty" });

    timeline(db, cutoff);
    if (strict) {
      const last = db.prepare("select max(stop) as until from programme").get()?.["until"];
      if (typeof last !== "number" || last <= since) throw failure({ kind: "ended" });
    }
    const insertChannel = db.prepare(
      "insert into channel (key, id, name, folded) values (?, ?, ?, ?)",
    );
    db.exec("begin");
    for (const [id, { key, name }] of channels) {
      const shown = name ?? id;
      insertChannel.run(key, id, shown, `${normalize(shown)}\n${id.toLowerCase()}`);
    }
    db.exec("commit");
    if (build.previous) carry(db, build.previous, cutoff);
    finish(db);
    const summary = db.prepare("select programmes, until from meta").get();
    const result: GuideIndexSummary = {
      channels: Number(db.prepare("select count(*) as n from channel").get()?.["n"] ?? 0),
      programmes: Number(summary?.["programmes"] ?? 0),
      until: typeof summary?.["until"] === "number" ? summary["until"] : null,
    };
    db.close();
    await rename(part, build.target);
    return result;
  } catch (cause) {
    if (db.isOpen) db.close();
    await rm(part, { force: true });
    throw cause;
  }
}

/**
 * Lays each channel's programmes out in time order, without overlaps: a programme without an
 * end runs until the next one starts, one that starts before the previous one ends cuts it
 * short, and one without an end and nothing after it is dropped. Then drops what ended before
 * `cutoff`, and what is shorter than `GUIDE_KEPT.shortestMs`.
 */
function timeline(db: DatabaseSync, cutoff: number) {
  db.exec("begin");
  db.prepare(
    `
    update programme set stop = later.next
    from (
      select channel, start, lead(start) over (partition by channel order by start) as next
      from programme
    ) as later
    where programme.channel = later.channel and programme.start = later.start
      and later.next is not null and (programme.stop is null or programme.stop > later.next)
  `,
  ).run();
  db.prepare("delete from programme where stop is null or stop <= ? or stop - start < ?").run(
    cutoff,
    GUIDE_KEPT.shortestMs,
  );
  db.exec("commit");
}

/**
 * Brings along what the index before, at `previous`, keeps of the past that the new document no
 * longer lists: on each channel the document has programmes for, what starts before its first
 * one there, cut short where that one begins. A channel the document no longer has programmes
 * for goes, past and all: the guide no longer vouches for it, and so does what ends before
 * `cutoff` once cut short. An index of another layout brings nothing. The index before is read,
 * never written, and one that is gone fails the build rather than bringing nothing.
 */
function carry(db: DatabaseSync, previous: string, cutoff: number) {
  db.prepare("attach database ? as old").run(`${pathToFileURL(previous).href}?mode=ro`);
  try {
    if (db.prepare("pragma old.user_version").get()?.["user_version"] !== VERSION) return;
    db.exec(`
      begin;
      create temp table opening as
        select channel.key, channel.id, min(programme.start) as start
        from main.programme join main.channel on channel.key = programme.channel
        group by programme.channel;
    `);
    db.prepare(
      `
      insert or ignore into title (text, folded)
      select text, folded from old.title
      where key in (select distinct title from old.programme where stop > ?)
    `,
    ).run(cutoff);
    db.prepare(
      `
      insert or ignore into programme (channel, start, stop, title, description)
      select opening.key, programme.start, min(programme.stop, opening.start), title.key,
        programme.description
      from temp.opening as opening
      join old.channel as was on was.id = opening.id
      join old.programme as programme on programme.channel = was.key
      join old.title as named on named.key = programme.title
      join title on title.text = named.text
      where min(programme.stop, opening.start) > ? and programme.start < opening.start
        and min(programme.stop, opening.start) - programme.start >= ?
    `,
    ).run(cutoff, GUIDE_KEPT.shortestMs);
    db.exec("drop table temp.opening; commit;");
  } finally {
    db.exec("detach database old");
  }
}

/** Notes when each channel's last programme ends, orders the channels by name, and indexes. */
function finish(db: DatabaseSync) {
  db.exec(`
    begin;
    update channel set until = (select max(stop) from programme where programme.channel = channel.key);
    commit;
  `);
  // By name, whatever its case and accents, then by id, as JavaScript compares the folded text.
  const order = db
    .prepare("select key, folded from channel")
    .all()
    .map((row) => ({ key: Number(row["key"]), folded: String(row["folded"]) }))
    .sort((a, b) => (a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0));
  const place = db.prepare("update channel set position = ? where key = ?");
  db.exec("begin");
  for (const [position, { key }] of order.entries()) place.run(position, key);
  db.exec(`
    commit;
    create index programme_title on programme (title, start);
    create index programme_long on programme (stop) where stop - start > ${LONG_MS};
    create index channel_position on channel (position);
    insert into meta select count(*), max(stop) from programme;
    pragma user_version = ${VERSION};
  `);
}

/** `text`, cut to `chars` where a character ends. */
function kept(text: string, chars: number): string {
  if (text.length <= chars) return text;
  return text.slice(0, isHighSurrogate(text.charCodeAt(chars - 1)) ? chars - 1 : chars);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * A copy of `text` that holds nothing else, for what the build keeps for long: what the reader
 * hands on, and a cut of it, may be part of a whole element's text, which it would keep too.
 */
function copied(text: string): string {
  return structuredClone(text);
}

function failure(failure: GuideFailure): AppFailure {
  return new AppFailure({ kind: "guide", failure });
}

/** A channel as an index lists it. */
export interface IndexedChannel {
  /** What the file names it by. */
  readonly key: number;
  /** The id programmes name it by, exactly as the guide writes it. */
  readonly id: string;
  /** The name the guide gives it, or its id where it names none. */
  readonly name: string;
  /** Its name folded, then its id in lower case on a line of its own: what search compares. */
  readonly folded: string;
  /** When its last programme ends, or null when the guide has none for it. */
  readonly until: number | null;
}

/**
 * An index opened to read on the main process: its channels in memory, and bounded lookups of
 * one channel's programmes by its key. Searches run elsewhere (`searchFirst`, `searchEach`).
 * Whoever opened it closes it, once nothing reads it any more (files.ts).
 */
export interface GuideIndex {
  /** Every channel the guide lists, by its id, in name order. */
  readonly channels: ReadonlyMap<string, IndexedChannel>;
  /** When each channel's programmes end, in time order, those of channels without any left out. */
  readonly ends: Float64Array;
  /** The channel the file names by `key`. */
  channel(key: number): IndexedChannel | undefined;
  readonly programmes: number;
  /** When its last programme ends, or null without one. */
  readonly until: number | null;
  /** What `channel` shows at `at` and next, or null when it shows nothing from then on. */
  listing(channel: IndexedChannel, at: number): Listing | null;
  /**
   * The programmes on `channel` over [from, until), at the time `at`, as `GUIDE_SCHEDULE` bounds
   * them: at most `most` over the stretch, which holds a whole day; and, where the stretch has
   * fewer, at least `atLeast` still on or to come, read past `until`, and when `from` is before
   * `at`, at least `atLeast` that have ended, read before `from`.
   */
  schedule(channel: IndexedChannel, at: number, from: number, until: number): readonly Programme[];
  /**
   * The programmes on `channel` that overlap [from, to), in time order, without descriptions: a
   * minute long at least, so a stretch of `GUIDE_RANGE.hours` holds a few hundred.
   */
  range(channel: IndexedChannel, from: number, to: number): readonly Omit<GuideSlot, "guide">[];
  /** The programme on `channel` that starts at `start`, with its description, or null. */
  programme(channel: IndexedChannel, start: number): Programme | null;
  close(): void;
}

/**
 * Opens the index at `path` to read, or answers null when it isn't one this release can read.
 * Reads its channels a slice at a time.
 */
export async function openGuideIndex(path: string): Promise<GuideIndex | null> {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return null;
  }
  try {
    if (db.prepare("pragma user_version").get()?.["user_version"] !== VERSION) {
      db.close();
      return null;
    }
    const meta = db.prepare("select programmes, until from meta").get();
    const channels = new Map<string, IndexedChannel>();
    const byKey: IndexedChannel[] = [];
    const ends: number[] = [];
    let began = performance.now();
    let count = 0;
    for (const row of db
      .prepare("select key, id, name, folded, until from channel order by position")
      .iterate()) {
      const channel: IndexedChannel = {
        key: Number(row["key"]),
        id: String(row["id"]),
        name: String(row["name"]),
        folded: String(row["folded"]),
        until: typeof row["until"] === "number" ? row["until"] : null,
      };
      channels.set(channel.id, channel);
      byKey[channel.key] = channel;
      if (channel.until !== null) ends.push(channel.until);
      // Lets other work in between slices of a few milliseconds.
      if ((++count & 15) === 0 && performance.now() - began >= SLICE_MS) {
        await new Promise((resolve) => setImmediate(resolve));
        began = performance.now();
      }
    }
    return reader(db, {
      channels,
      ends: Float64Array.from(ends).sort(),
      byKey,
      programmes: Number(meta?.["programmes"] ?? 0),
      until: typeof meta?.["until"] === "number" ? meta["until"] : null,
    });
  } catch {
    db.close();
    return null;
  }
}

function reader(
  db: DatabaseSync,
  read: {
    channels: Map<string, IndexedChannel>;
    ends: Float64Array;
    byKey: readonly IndexedChannel[];
    programmes: number;
    until: number | null;
  },
): GuideIndex {
  // From the programme on at `at`, if any: the last to start by then, which may have ended.
  const columns = "programme.start, programme.stop, title.text as title";
  const from = `
    from programme join title on title.key = programme.title
    where programme.channel = :channel
      and programme.start >= ifnull(
        (select max(start) from programme where channel = :channel and start <= :at),
        -9007199254740991
      )`;
  const described = `select ${columns}, programme.description ${from}`;
  // Every read is bounded in SQL, before a row is made: the one that may have ended comes first.
  // A row is a few kilobytes at most and a minute of time at least (`GUIDE_KEPT`).
  const listing = db.prepare(`${described} order by programme.start limit 3`);
  const schedule = db.prepare(
    `${described} and programme.start < :until order by programme.start limit ${GUIDE_SCHEDULE.most + 1}`,
  );
  const selected = `
    select ${columns}, programme.description
    from programme join title on title.key = programme.title
    where programme.channel = :channel`;
  // What a schedule reads before `from` and past `until`, when its stretch holds too few.
  const scheduleBefore = db.prepare(`
    ${selected} and programme.start < :before and programme.stop <= :at
    order by programme.start desc limit ${GUIDE_SCHEDULE.atLeast}`);
  const scheduleAfter = db.prepare(`
    ${selected} and programme.start >= :after order by programme.start limit ${GUIDE_SCHEDULE.atLeast}`);
  // A minute a programme at least: the stretch holds no more than this, the first one also.
  const slots = (GUIDE_RANGE.hours * 60 * 60 * 1000) / GUIDE_KEPT.shortestMs + 2;
  const range = db.prepare(
    `select ${columns} ${from} and programme.start < :to order by programme.start limit ${slots}`,
  );
  const detail = db.prepare(`
    select ${columns}, programme.description
    from programme join title on title.key = programme.title
    where programme.channel = ? and programme.start = ?`);
  const unended = (rows: Record<string, unknown>[], at: number) =>
    rows.map(programmeOf).filter((programme) => programme.stop > at);
  return {
    channels: read.channels,
    ends: read.ends,
    channel: (key) => read.byKey[key],
    programmes: read.programmes,
    until: read.until,
    listing(channel, at) {
      const [first, second = null] = unended(listing.all({ channel: channel.key, at }), at);
      if (!first) return null;
      return first.start <= at ? { now: first, next: second } : { now: null, next: first };
    },
    schedule(channel, at, from, until) {
      const { atLeast, most } = GUIDE_SCHEDULE;
      const key = channel.key;
      const stretch = unended(schedule.all({ channel: key, at: from, until }), from).slice(0, most);
      const ended = stretch.filter((programme) => programme.stop <= at).length;
      const coming = stretch.length - ended;
      const before =
        from < at && ended < atLeast
          ? scheduleBefore
              .all({ channel: key, before: stretch[0]?.start ?? from, at })
              .slice(0, atLeast - ended)
              .map(programmeOf)
              .reverse()
          : [];
      const last = stretch.at(-1);
      const after =
        coming < atLeast
          ? scheduleAfter
              .all({ channel: key, after: last ? last.start + 1 : until })
              .slice(0, atLeast - coming)
              .map(programmeOf)
          : [];
      return [...before, ...stretch, ...after];
    },
    range: (channel, at, to) =>
      range
        .all({ channel: channel.key, at, to })
        .map(slotOf)
        .filter((slot) => slot.stop > at),
    programme(channel, start) {
      const row = detail.get(channel.key, start);
      return row ? programmeOf(row) : null;
    },
    close: () => {
      if (db.isOpen) db.close();
    },
  };
}

/** What a search asks of an index file: the programmes whose title has each of `words`. */
interface Search {
  /** The index file. */
  readonly path: string;
  readonly words: readonly string[];
  /** Programmes that ended by then aren't found. */
  readonly at: number;
  /** The channels searched, by the file's keys. */
  readonly channels: readonly number[];
}

/** A search for the first `limit` programmes it finds: on now first, then by start. */
export interface FirstSearch extends Search {
  readonly limit: number;
}

/** The programmes a `FirstSearch` found, best first, each with the channel it is on. */
export type FirstFound = readonly { readonly channel: number; readonly programme: Programme }[];

/** A search of each channel's programmes, as far as `until`. */
export interface EachSearch extends Search {
  readonly until: number;
}

/**
 * What an `EachSearch` found, per channel that has a match: whether the one on now matches, and
 * the first later one that does. A list of tens of thousands of channels may each have one, so
 * the matches come packed, in a few arrays and one string, which the main process takes in from
 * the worker at once without building anything per channel; `eachMatch` reads them in turn.
 */
export interface EachFound {
  /** Each match's channel, by the file's key. */
  readonly channels: Float64Array;
  /** 1 where the one on now matches. */
  readonly now: Uint8Array;
  /** When the first later match starts, or NaN where none does. */
  readonly later: Float64Array;
  /** The later matches' titles, one after another. */
  readonly titles: string;
  /** Where in `titles` each match's later title ends. */
  readonly titleEnds: Uint32Array;
}

/** One channel's match, as an `EachFound` holds it. */
export interface EachMatch {
  readonly channel: number;
  readonly now: boolean;
  readonly later: Pick<Programme, "start" | "title"> | null;
}

/** The matches `found` holds, one at a time. */
export function* eachMatch(found: EachFound): Generator<EachMatch> {
  for (let at = 0; at < found.channels.length; at++) {
    const start = found.later[at] ?? Number.NaN;
    yield {
      channel: found.channels[at] ?? 0,
      now: found.now[at] === 1,
      later: Number.isNaN(start)
        ? null
        : { start, title: found.titles.slice(found.titleEnds[at - 1] ?? 0, found.titleEnds[at]) },
    };
  }
}

/**
 * Searches of index files, run away from the main process. `signal` stops one: it settles once
 * nothing reads the file for it any more.
 */
export interface GuideSearching {
  first(search: FirstSearch, signal: AbortSignal): Promise<FirstFound>;
  each(search: EachSearch, signal: AbortSignal): Promise<EachFound>;
}

/**
 * The first `limit` programmes on `search.channels` whose title has each word and that haven't
 * ended at `at`: on now first, then by start. Reads the file at once, as long as that takes, so
 * the app runs it in a worker thread (guide/search-worker.ts).
 */
export function searchFirst(search: FirstSearch): FirstFound {
  const { at, limit } = search;
  const best: FoundProgramme[] = [];
  const rank = (found: FoundProgramme) => (found.start <= at ? 0 : 1);
  const before = (a: FoundProgramme, b: FoundProgramme) =>
    rank(a) - rank(b) || a.start - b.start || a.channel - b.channel;
  return reading(search.path, (db) => {
    matching(
      db,
      search,
      // Once `limit` are in, only one that starts by the last of them can take its place: earlier,
      // or as early on a channel the file keys first. Starts are whole milliseconds.
      () => (best.at(limit - 1)?.start ?? Number.POSITIVE_INFINITY) + 1,
      (found) => {
        let place = best.length;
        while (place > 0 && before(found, best[place - 1]!) < 0) place--;
        if (place >= limit) return;
        best.splice(place, 0, found);
        if (best.length > limit) best.pop();
      },
    );
    const described = db.prepare(
      "select description from programme where channel = ? and start = ?",
    );
    return best.map(({ channel, start, stop, title }) => {
      const description = described.get(channel, start)?.["description"];
      return {
        channel,
        programme: {
          start,
          stop,
          title,
          description: typeof description === "string" ? description : null,
        },
      };
    });
  });
}

/**
 * For each of `search.channels` with a match, whether the programme on now has each word in its
 * title, and the first later one starting before `until` that does. Reads the file at once.
 */
export function searchEach(search: EachSearch): EachFound {
  const { at, until } = search;
  const found = new Map<number, { now: boolean; later: FoundProgramme | null }>();
  return reading(search.path, (db) => {
    matching(
      db,
      search,
      () => until,
      (programme) => {
        const match = found.get(programme.channel) ?? { now: false, later: null };
        if (programme.start <= at) match.now = true;
        else if (!match.later || programme.start < match.later.start) match.later = programme;
        found.set(programme.channel, match);
      },
    );
    const packed = {
      channels: new Float64Array(found.size),
      now: new Uint8Array(found.size),
      later: new Float64Array(found.size),
      titleEnds: new Uint32Array(found.size),
    };
    const titles: string[] = [];
    let end = 0;
    let place = 0;
    for (const [channel, { now, later }] of found) {
      packed.channels[place] = channel;
      packed.now[place] = now ? 1 : 0;
      packed.later[place] = later?.start ?? Number.NaN;
      if (later) {
        titles.push(later.title);
        end += later.title.length;
      }
      packed.titleEnds[place++] = end;
    }
    return { ...packed, titles: titles.join("") };
  });
}

/** Runs `read` on the index file at `path`, opened read-only: one that is gone fails. */
function reading<A>(path: string, read: (db: DatabaseSync) => A): A {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** A programme a search found, with where it is kept. */
interface FoundProgramme {
  readonly channel: number;
  readonly start: number;
  readonly stop: number;
  readonly title: string;
}

/**
 * Hands `visit` the programmes on `search.channels` whose title has each of its words, that
 * haven't ended at `at` and start before `before()`, in no particular order. `before` is asked
 * again between steps, so a search that has found enough reads no further. Whatever it reads, it
 * reads in pages, so however many titles or programmes match, it holds only a page of them.
 */
function matching(
  db: DatabaseSync,
  { words, at, channels: keys }: Search,
  before: () => number,
  visit: (found: FoundProgramme) => void,
) {
  if (words.length === 0 || keys.length === 0) return;
  const channels = new Set(keys);
  const listing = Number(
    db.prepare("select count(*) as n from channel where until is not null").get()?.["n"] ?? 0,
  );
  // Few of the guide's channels: the file leaves out the others' before reading a row.
  const only = channels.size * 2 < listing ? JSON.stringify(keys) : null;
  const within = only === null ? "" : "and programme.channel in (select value from json_each(?))";
  const found = (row: Record<string, unknown>): FoundProgramme => ({
    channel: Number(row["channel"]),
    start: Number(row["start"]),
    stop: Number(row["stop"]),
    title: String(row["text"]),
  });
  const last = Number(db.prepare("select max(key) as last from title").get()?.["last"] ?? 0);
  // The titles that match, a page of title keys at a time.
  const titles = db.prepare(
    `select key from title where key > ? and key <= ? and ${words.map(() => "instr(folded, ?) > 0").join(" and ")}`,
  );
  // The programmes of a page of titles in a stretch of time.
  const rows = db.prepare(`
    select programme.channel, programme.start, programme.stop, title.text
    from programme indexed by programme_title join title on title.key = programme.title
    where programme.title in (select value from json_each(?))
      and programme.start >= ? and programme.start < ? and programme.stop > ?
      and programme.stop - programme.start <= ${LONG_MS} ${within}`);
  // In stretches of time, from what can still be on at `at`: a search that found enough in the
  // first reads no later one. A search bounded from the start reads its one stretch.
  const ahead = Number.isFinite(before()) ? [] : STRETCHES.map((each) => at + each);
  const edges = [at - LONG_MS, ...ahead];
  for (const [step, from] of edges.entries()) {
    if (from >= Math.min(edges[step + 1] ?? Number.MAX_SAFE_INTEGER, before())) break;
    for (let after = 0; after < last; after += TITLES_PER_PAGE) {
      const page: number[] = [];
      for (const row of titles.iterate(after, after + TITLES_PER_PAGE, ...words)) {
        page.push(Number(row["key"]));
      }
      if (page.length === 0) continue;
      // Asked again for each page: what was found meanwhile narrows the stretch.
      const to = Math.min(edges[step + 1] ?? Number.MAX_SAFE_INTEGER, before());
      if (from >= to) break;
      const args = [JSON.stringify(page), from, to, at, ...(only === null ? [] : [only])];
      for (const row of rows.iterate(...args)) {
        const programme = found(row);
        if (channels.has(programme.channel)) visit(programme);
      }
    }
  }
  // Then the long ones, which may have begun long before what is on now: few, so read whole,
  // their titles compared in the same statement.
  const long = db.prepare(`
    select programme.channel, programme.start, programme.stop, title.text
    from programme indexed by programme_long join title on title.key = programme.title
    where programme.stop - programme.start > ${LONG_MS} and programme.stop > ? and programme.start < ?
      and ${words.map(() => "instr(title.folded, ?) > 0").join(" and ")}`);
  for (const row of long.iterate(at, Math.min(before(), Number.MAX_SAFE_INTEGER), ...words)) {
    const programme = found(row);
    if (channels.has(programme.channel)) visit(programme);
  }
}

function slotOf(row: Record<string, unknown>): Omit<GuideSlot, "guide"> {
  return { start: Number(row["start"]), stop: Number(row["stop"]), title: String(row["title"]) };
}

function programmeOf(row: Record<string, unknown>): Programme {
  return {
    ...slotOf(row),
    description: typeof row["description"] === "string" ? row["description"] : null,
  };
}
