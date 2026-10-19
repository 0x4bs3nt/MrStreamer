import { lazy } from "@mrstreamer/contracts/lazy";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import type { EpisodeAbout, TitleAbout } from "@mrstreamer/core/metadata/tmdb";
import type { ProviderDetails } from "@mrstreamer/core/provider";
import { type } from "arktype";
import { Directory, File, Paths } from "expo-file-system";
import { holds, safeUrl, URL_LENGTH } from "./login-safety.ts";

// Title and season details the app has opened, kept in Caches/details so a launch shows them
// before, or instead of, asking again: each provider's facts of a title, under its subscription,
// and TMDB's about of a title and of a season, shared by every subscription as tmdb.json is.
// titles.ts alone reads and writes them and decides when one shows; account.ts deletes a
// subscription's with its saved lists (catalogue-cache.ts). They are display data only: where a
// title streams from is always asked of the provider under the current login, never read here.
//
// As with the saved lists, iOS may empty Caches: a record that is missing, unreadable, too old or
// doubtful is simply not there, and is deleted. Reading, saving and tidying never throw; deleting
// a subscription's records answers whether they are gone, as a new password waits on it.
// What is written is a copy of the fields the app reads. An artwork address that could carry the
// login is written as none; provider facts with the password in any other text aren't written.
// A subscription's records are read, written and deleted one operation at a time, so a deletion
// waits for a write under way and a write never recreates what was deleted after it. A write goes
// to a file beside the record, then takes its place, while `stands` holds before, during and
// after; a read answers nothing once it fails.

/** A record and when its answer came, epoch milliseconds. */
export interface Saved<A> {
  readonly at: number;
  readonly value: A;
}

/** A provider's facts of a title, with when its subscription's movie and series lists came. */
export interface SavedTitle extends Saved<ProviderDetails> {
  readonly listedAt: number | null;
}

const VERSION = 1;
/** A record larger than this isn't written or read. */
const RECORD_BYTES = 8 * 1024 * 1024;
/** What every record together may take, and how many there may be; the oldest go past either. */
const TOTAL_BYTES = 64 * 1024 * 1024;
const RECORDS = 2048;
/** The most records one write deletes to make room; one that still doesn't fit isn't written. */
const PRUNE_BATCH = 64;
/** A record older than this, or from further ahead than the clock may drift, isn't shown. */
const MAX_AGE = 182 * 24 * 60 * 60 * 1000;
const MAX_AHEAD = 10 * 60 * 1000;

const folder = () => new Directory(Paths.cache, "details");
const providers = () => new Directory(folder(), "providers");
const tmdbFolder = () => new Directory(folder(), "tmdb");
/** A name part: letters, digits and "-" as they are, every other UTF-16 unit as "_" and hex. */
const encoded = (text: string) =>
  text.replace(/[^A-Za-z0-9-]/g, (unit) => `_${unit.charCodeAt(0).toString(16).padStart(4, "0")}`);
const subscriptionFolder = (id: string) => new Directory(providers(), encoded(id));

const Finite = lazy(() =>
  type("number").narrow((value, ctx) => Number.isFinite(value) || ctx.mustBe("a finite number")),
);
const MaybeFinite = lazy(() => Finite().or("null"));
const Url = lazy(() => type(`string <= ${URL_LENGTH}`).or("null"));
const Person = lazy(() =>
  type({ "+": "reject", name: "string", character: "string | null", profile: "string | null" }),
);
const Provider = lazy(() =>
  type({
    "+": "reject",
    originalName: "string | null",
    plot: "string | null",
    genres: "string[]",
    cast: "string[]",
    directors: "string[]",
    releaseDate: "string | null",
    duration: MaybeFinite(),
    posterUrl: Url(),
    backdropUrl: Url(),
    seasons: type({
      "+": "reject",
      number: Finite(),
      name: "string | null",
      posterUrl: Url(),
    }).array(),
    episodes: type({
      "+": "reject",
      id: "string",
      season: Finite(),
      number: Finite(),
      name: "string",
      plot: "string | null",
      duration: MaybeFinite(),
      stillUrl: Url(),
      airDate: "string | null",
      addedAt: MaybeFinite(),
      container: "string",
    }).array(),
    "episodeOrder?": "'source'",
    container: "string | null",
  }),
);
const About = lazy(() =>
  type({
    "+": "reject",
    original: "string | null",
    language: "string | null",
    overview: "string | null",
    poster: "string | null",
    backdrop: "string | null",
    genres: Finite().array(),
    runtime: MaybeFinite(),
    cast: Person().array(),
    directors: "string[]",
  }),
);
const Episode = lazy(() =>
  type({
    "+": "reject",
    number: Finite(),
    name: "string | null",
    overview: "string | null",
    still: "string | null",
    airDate: "string | null",
    runtime: MaybeFinite(),
    rating: MaybeFinite(),
    cast: Person().array(),
    directors: "string[]",
  }),
);
const Records = {
  title: lazy(() =>
    type({
      "+": "reject",
      version: `${VERSION}`,
      subscriptionId: "string",
      kind: "'movie' | 'series'",
      id: "string",
      at: Finite(),
      listedAt: MaybeFinite(),
      value: Provider(),
    }),
  ),
  about: lazy(() =>
    type({ "+": "reject", version: `${VERSION}`, at: Finite(), value: About().or("null") }),
  ),
  season: lazy(() =>
    type({
      "+": "reject",
      version: `${VERSION}`,
      at: Finite(),
      value: Episode().array().or("null"),
    }),
  ),
};

/** The last operation of each queue still under way: a subscription's, or a TMDB file's. */
const queues = new Map<string, Promise<unknown>>();

/**
 * Runs `operation` once the queue's earlier ones have finished; answers `fallback` when it fails.
 * A queue is forgotten once its last operation settles, keeping none of what it answered.
 */
function queued<A>(queue: string, fallback: A, operation: () => Promise<A>) {
  const run = (queues.get(queue) ?? Promise.resolve()).then(operation).catch(() => fallback);
  queues.set(queue, run);
  void run.then(() => {
    if (queues.get(queue) === run) queues.delete(queue);
  });
  return run;
}

/**
 * The records on disk, by address, with their bytes and when each was written: counted from the
 * disk on the first write of a run, then kept as writes and deletions go. With what writes under
 * way have reserved, these are what a write is admitted against (`admit`).
 */
let index: Map<string, { readonly bytes: number; readonly at: number }> | null = null;
/** The bytes every record in `index` takes together. */
let stored = 0;
/** Bytes and records reserved by writes under way, one record each; and the records they write. */
let reserved = { bytes: 0, records: 0 };
const writing = new Set<string>();

/** Whether a write under way owns `uri`: its record, or the file beside it it writes first. */
const owned = (uri: string) => writing.has(uri.replace(/\.next$/, ""));

/** Forgets the record at `uri`, gone from the disk. */
function forget(uri: string) {
  const known = index?.get(uri);
  if (!known || !index) return;
  index.delete(uri);
  stored -= known.bytes;
}

/** Deletes the file if it is there, whatever stops it; answers whether it is gone. */
function discard(file: File): boolean {
  try {
    if (file.exists) file.delete();
    forget(file.uri);
    return true;
  } catch {
    // Left for a later write, or the next launch, to try again.
    return false;
  }
}

/**
 * The record in `file` as `check` takes it, or null when there is none or it doesn't check out,
 * which deletes it. Null too, leaving it, once `stands` fails while it is read.
 */
async function load<R extends { readonly at: number }>(
  file: File,
  check: (json: unknown) => R | null,
  stands: () => boolean,
): Promise<R | null> {
  if (!stands() || !file.exists) return null;
  try {
    if (file.size > RECORD_BYTES) throw new RangeError("Too large");
    const json: unknown = JSON.parse(await file.text());
    if (!stands()) return null;
    const record = check(json);
    const age = record ? Date.now() - record.at : NaN;
    if (!record || !(age <= MAX_AGE && age >= -MAX_AHEAD)) throw new TypeError();
    return record;
  } catch {
    discard(file);
    return null;
  }
}

/**
 * Deletes `file`, a write left halfway; when the disk keeps it, it stays charged as a record is,
 * until a later deletion, or a write that takes its place, frees it.
 */
function abandon(file: File, all: Map<string, { readonly bytes: number; readonly at: number }>) {
  if (discard(file) || !file.exists) return;
  const bytes = file.size;
  if (all === index) forget(file.uri);
  all.set(file.uri, { bytes, at: file.modificationTime ?? Date.now() });
  if (all === index) stored += bytes;
}

/**
 * The records on disk, counted once per run: each one's size and time read once, here, never
 * while they are sorted. A write left halfway that no write under way owns is deleted, or
 * counted as a record when the disk keeps it (`abandon`).
 */
function indexed() {
  if (index) return index;
  const found = new Map<string, { readonly bytes: number; readonly at: number }>();
  const folders = providers().exists
    ? providers()
        .list()
        .filter((entry) => entry instanceof Directory)
    : [];
  for (const at of [...folders, tmdbFolder()]) {
    if (!at.exists) continue;
    for (const file of at.list()) {
      if (!(file instanceof File)) continue;
      if (file.name.endsWith(".json")) {
        found.set(file.uri, { bytes: file.size, at: file.modificationTime ?? 0 });
      } else if (!owned(file.uri)) {
        abandon(file, found);
      }
    }
  }
  index = found;
  stored = [...found.values()].reduce((sum, each) => sum + each.bytes, 0);
  return found;
}

/** A write's share of the budget, held from its admission until it is in place or given up. */
interface Reservation {
  readonly uri: string;
  readonly bytes: number;
}

/**
 * Admits `bytes` as the record at `file`, against what is stored and what writes under way have
 * reserved. The record it replaces counts until the new one takes its place, and the file beside
 * it, which the write fills first, takes a record of its own until then: a replacement too, as
 * that file stays a record when it can't be moved or deleted (`abandon`). When they don't fit,
 * deletes up to a batch of the least recently written records, but none a write under way owns,
 * counting only those the disk actually deleted. Null when they still don't fit.
 */
function admit(file: File, bytes: number): Reservation | null {
  const all = indexed();
  const fits = () =>
    stored + reserved.bytes + bytes <= TOTAL_BYTES && all.size + reserved.records + 1 <= RECORDS;
  if (!fits()) {
    const oldest = [...all]
      .filter(([uri]) => uri !== file.uri && !owned(uri))
      .toSorted(([, a], [, b]) => a.at - b.at)
      .slice(0, PRUNE_BATCH);
    for (const [uri] of oldest) {
      if (fits()) break;
      discard(new File(uri));
    }
    if (!fits()) return null;
  }
  reserved = { bytes: reserved.bytes + bytes, records: reserved.records + 1 };
  writing.add(file.uri);
  return { uri: file.uri, bytes };
}

/** Gives a reservation back: its write is in place (`placed`, its bytes now stored) or given up. */
function release(reservation: Reservation, placed: boolean) {
  reserved = {
    bytes: reserved.bytes - reservation.bytes,
    records: reserved.records - 1,
  };
  writing.delete(reservation.uri);
  if (!placed || !index) return;
  // The record takes the place of what it replaced, and of the file beside it it was written to.
  forget(reservation.uri);
  forget(`${reservation.uri}.next`);
  index.set(reservation.uri, { bytes: reservation.bytes, at: Date.now() });
  stored += reservation.bytes;
}

/**
 * Writes `text` as `name` in `at`, while `stands` holds: before, while it waits on the disk, and
 * once it is in place, which goes again when it no longer holds. Its UTF-8 bytes are admitted
 * against the budget first (`admit`), and are what is written.
 */
async function store(at: Directory, name: string, text: string, stands: () => boolean) {
  if (!stands() || text.length > RECORD_BYTES) return;
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > RECORD_BYTES) return;
  at.create({ intermediates: true, idempotent: true });
  const file = new File(at, name);
  const reservation = admit(file, bytes.length);
  if (!reservation) return;
  const pending = new File(at, `${name}.next`);
  let placed = false;
  try {
    pending.create({ overwrite: true });
    await pending.write(bytes);
    if (!stands()) return;
    await pending.move(file, { overwrite: true });
    placed = true;
  } catch {
    // Not written: what is left of it goes below.
  } finally {
    release(reservation, placed);
    if (!placed && index) abandon(new File(at, `${name}.next`), index);
  }
  if (!stands()) discard(file);
}

const titleName = (kind: TitleKind, titleId: string) => `${kind}.${encoded(titleId)}.json`;
const aboutName = (kind: TitleKind, tmdbId: string, language: string) =>
  `about.${kind}.${encoded(tmdbId)}.${encoded(language)}.json`;
const seasonName = (tmdbId: string, season: number, language: string) =>
  `season.${encoded(tmdbId)}.${season}.${encoded(language)}.json`;
const always = () => true;

/** `id`'s saved facts of a title, or null. Null too once `stands` fails while it is read. */
export function readTitle(
  id: string,
  kind: TitleKind,
  titleId: string,
  stands: () => boolean,
): Promise<SavedTitle | null> {
  return queued(`provider|${id}`, null, () =>
    load(
      new File(subscriptionFolder(id), titleName(kind, titleId)),
      (json) => {
        const record = Records.title()(json);
        if (record instanceof type.errors) return null;
        const same = record.subscriptionId === id && record.kind === kind && record.id === titleId;
        return same ? { at: record.at, listedAt: record.listedAt, value: record.value } : null;
      },
      stands,
    ),
  );
}

/**
 * Saves a provider's facts of a title as `id`'s while `stands` holds. `login` is what signs the
 * subscription in, kept out of the record. Never rejects.
 */
export function writeTitle(
  id: string,
  kind: TitleKind,
  titleId: string,
  saved: SavedTitle,
  login: readonly string[],
  stands: () => boolean,
): Promise<void> {
  return queued(`provider|${id}`, undefined, async () => {
    const [username = "", password = ""] = login;
    const value = providerCopy(saved.value, (url) => safeUrl(url, username, password));
    if (password !== "" && holds(value, password)) return;
    const text = JSON.stringify({
      version: VERSION,
      subscriptionId: id,
      kind,
      id: titleId,
      at: saved.at,
      listedAt: saved.listedAt,
      value,
    });
    await store(subscriptionFolder(id), titleName(kind, titleId), text, stands);
  });
}

/** TMDB's about of a title in `language`, as last answered, or null. Null as its value: missing. */
export function readAbout(kind: TitleKind, tmdbId: string, language: string) {
  const name = aboutName(kind, tmdbId, language);
  return queued(name, null, () =>
    load(
      new File(tmdbFolder(), name),
      (json): Saved<TitleAbout | null> | null => {
        const record = Records.about()(json);
        return record instanceof type.errors ? null : { at: record.at, value: record.value };
      },
      always,
    ),
  );
}

export function writeAbout(
  kind: TitleKind,
  tmdbId: string,
  language: string,
  saved: Saved<TitleAbout | null>,
): Promise<void> {
  const name = aboutName(kind, tmdbId, language);
  const value = saved.value && aboutCopy(saved.value);
  return queued(name, undefined, () =>
    store(tmdbFolder(), name, JSON.stringify({ version: VERSION, at: saved.at, value }), always),
  );
}

/** TMDB's episodes of a season in `language`, as last answered, or null. Null as its value: missing. */
export function readSeason(tmdbId: string, season: number, language: string) {
  const name = seasonName(tmdbId, season, language);
  return queued(name, null, () =>
    load(
      new File(tmdbFolder(), name),
      (json): Saved<readonly EpisodeAbout[] | null> | null => {
        const record = Records.season()(json);
        return record instanceof type.errors ? null : { at: record.at, value: record.value };
      },
      always,
    ),
  );
}

export function writeSeason(
  tmdbId: string,
  season: number,
  language: string,
  saved: Saved<readonly EpisodeAbout[] | null>,
): Promise<void> {
  const name = seasonName(tmdbId, season, language);
  const value = saved.value && saved.value.map(episodeCopy);
  return queued(name, undefined, () =>
    store(tmdbFolder(), name, JSON.stringify({ version: VERSION, at: saved.at, value }), always),
  );
}

/**
 * Deletes `id`'s records once whatever reads or writes them has finished. Answers whether none is
 * left, a write left halfway included: false when the disk refuses a deletion. Never rejects.
 */
export function dropTitles(id: string): Promise<boolean> {
  return queued(`provider|${id}`, false, async () => {
    const at = subscriptionFolder(id);
    if (!at.exists) return true;
    const files = at.list().filter((entry) => entry instanceof File);
    // Every deletion is tried, whatever one refuses; the folder goes at the next launch's tidying.
    return files.map(discard).every(Boolean);
  });
}

/**
 * At launch, before any record is read: deletes the records of every subscription but `ids`, the
 * saved ones. Writes left halfway and the budget are seen to at the first write (`indexed`), so
 * launch reads no record's size or time.
 */
export function pruneDetails(ids: readonly string[]): void {
  index = null;
  try {
    if (!providers().exists) return;
    const kept = new Set(ids.map(encoded));
    for (const entry of providers().list()) {
      if (!kept.has(entry.name)) entry.delete();
    }
  } catch {
    // Tried again at the next launch.
  }
}

type Art = (url: string | null) => string | null;

const providerCopy = (details: ProviderDetails, art: Art) =>
  ({
    originalName: details.originalName,
    plot: details.plot,
    genres: [...details.genres],
    cast: [...details.cast],
    directors: [...details.directors],
    releaseDate: details.releaseDate,
    duration: details.duration,
    posterUrl: art(details.posterUrl),
    backdropUrl: art(details.backdropUrl),
    seasons: details.seasons.map((season) => ({
      number: season.number,
      name: season.name,
      posterUrl: art(season.posterUrl),
    })),
    episodes: details.episodes.map((episode) => ({
      id: episode.id,
      season: episode.season,
      number: episode.number,
      name: episode.name,
      plot: episode.plot,
      duration: episode.duration,
      stillUrl: art(episode.stillUrl),
      airDate: episode.airDate,
      addedAt: episode.addedAt,
      container: episode.container,
    })),
    ...(details.episodeOrder === undefined ? {} : { episodeOrder: details.episodeOrder }),
    container: details.container,
  }) satisfies ProviderDetails;

const personCopy = ({ name, character, profile }: TitleAbout["cast"][number]) => ({
  name,
  character,
  profile,
});

const aboutCopy = (about: TitleAbout) =>
  ({
    original: about.original,
    language: about.language,
    overview: about.overview,
    poster: about.poster,
    backdrop: about.backdrop,
    genres: [...about.genres],
    runtime: about.runtime,
    cast: about.cast.map(personCopy),
    directors: [...about.directors],
  }) satisfies TitleAbout;

const episodeCopy = (episode: EpisodeAbout) =>
  ({
    number: episode.number,
    name: episode.name,
    overview: episode.overview,
    still: episode.still,
    airDate: episode.airDate,
    runtime: episode.runtime,
    rating: episode.rating,
    cast: episode.cast.map(personCopy),
    directors: [...episode.directors],
  }) satisfies EpisodeAbout;
