import { Directory, File, Paths } from "expo-file-system";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { exposes, URL_LENGTH } from "./login-safety.ts";
import { fetchPicture } from "./picture-transfer.ts";
import { onSignedIn, retiredLogins, signedIn, type Source } from "./sources.ts";

// Channel logos and title pictures on disk, so they show again after a relaunch and offline.
// React Native's Image only ever gets a file here: its own loader would fetch through iOS's shared
// URL cache, which keeps answers on disk under their address, login and all.
//
// Each picture is fetched on the session that keeps no URL cache (picture-transfer.ts) into a file
// of a fresh random name; one too big, cut short or answered with an error leaves no file. Which
// folder it goes to depends on where its address could have come from:
// - Caches/artwork and its index, `index.json` (written beside itself, then moved over itself, a
//   moment after a change): an address that gives away no signed-in login (login-safety.ts
//   `exposes`), while every login this process signed in still is. The index is checked against
//   each login signed in later, and written again at once: a row that now gives one away goes
//   before its picture shows, and a write a login change overtakes isn't put in place.
// - Caches/artwork-session, which the index never names and each launch empties: an address that
//   gives a login away, which goes as soon as that login is replaced or removed, and, once any
//   login was replaced or removed in this process, every new picture. Lists of the earlier login
//   may still show then, and its password is no longer here to check them against; after a
//   relaunch, none of them can show (the lists saved on the phone are checked when written, and
//   deleted before a new password lands). A fetch of a login that went meanwhile is thrown away.
//
// The cache owns 160 MiB and 6,000 files, of at most 5 MiB each, counting every file it hasn't
// been able to delete yet and room for each fetch under way to land at its largest. A fetch starts
// only once that room is made, the least recently shown going first, but never one that shows
// now, and none while the disk refuses a deletion; one without room shows the fallback until it is
// shown again. One unseen for 60 days goes at the next launch, and one shown after 30 days
// is fetched again while the old file shows. Four fetches run at once, one per address, each for
// at most 15 seconds; a picture no one shows any more before its fetch starts isn't fetched. A
// failed fetch, or a fetched file that won't draw, shows the fallback, and the address is asked
// for again after five minutes or a relaunch. A download's own file (`file://`) shows as it is.

const MAX_BYTES = 160 * 1024 * 1024;
const MAX_FILES = 6000;
const MAX_FILE = 5 * 1024 * 1024;
const DAY = 86_400_000;
const REFRESH_MS = 30 * DAY;
const UNUSED_MS = 60 * DAY;
const TRANSFERS = 4;
const TIMEOUT_MS = 15_000;
/** How long an address that failed isn't asked for again. */
const FAILED_MS = 5 * 60_000;
/** How long after a change the index is written. */
const SAVE_MS = 5_000;
/** How stale a kept picture's last showing may be before showing it again rewrites the index. */
const TOUCH_MS = 60 * 60_000;
/** How many index rows are checked and written a task, and files deleted a task. */
const WRITE_SLICE = 500;
const DELETE_SLICE = 32;
const VERSION = 1;
/** A picture's file name, as `fresh` makes them. */
const NAME = /^[a-z0-9]+-[a-z0-9]+$/;
const INDEX = "index.json";
const PENDING_INDEX = "index.json.next";

type Waiting =
  { readonly kind: "none" } | { readonly kind: "pending" } | { readonly kind: "failed" };
type Kept = { readonly kind: "shown"; readonly uri: string };
type ArtworkState = Waiting | Kept;

/**
 * What a picture shows: nothing to show, its fetch still to finish, its fallback, or its file,
 * with what the Image calls when the file won't draw.
 */
export type Picture = Waiting | (Kept & { readonly broke: () => void });

const NONE = { kind: "none" } as const;
const PENDING = { kind: "pending" } as const;
const FAILED = { kind: "failed" } as const;

interface Entry {
  /** Its file's name, in Caches/artwork-session when `session`, else in Caches/artwork. */
  readonly name: string;
  readonly session: boolean;
  readonly bytes: number;
  readonly fetchedAt: number;
  usedAt: number;
  /** The sources whose login its address gives away. */
  readonly exposed: readonly Source[];
  /** Fetched by this process: a file that won't draw fails the address rather than refetching. */
  readonly fresh: boolean;
  /** What shows, once its file was found whole in this process. */
  shown: Kept | null;
  /** The `generation` its address was last found to give no signed-in login away in. */
  checked: number;
}

/** One address shown somewhere, while anything shows it. */
interface Slot {
  state: ArtworkState;
  readonly listeners: Set<() => void>;
  /** The sources whose login its address gave away when its fetch started. */
  exposed: readonly Source[] | null;
  /** Shows the fallback until it is shown again: its login went, or its picture didn't fit. */
  blocked: boolean;
}

const kept = () => new Directory(Paths.cache, "artwork");
const session = () => new Directory(Paths.cache, "artwork-session");

let phase: "idle" | "loading" | "ready" = "idle";
/** Every picture on disk by its address, least recently shown first. */
const entries = new Map<string, Entry>();
/** The bytes of `entries`. */
let total = 0;
/** Files of either folder not deleted yet, by address, with their bytes: they count too. */
const stuck = new Map<string, number>();
let stuckBytes = 0;
const slots = new Map<string, Slot>();
/** Addresses to fetch, in the order asked. */
const queue = new Set<string>();
/** Addresses being fetched, with the file each goes to. */
const running = new Map<string, string>();
/** When each address last failed. */
const failures = new Map<string, number>();
/** Rises with each login set or dropped: an address checked in an earlier one is checked again. */
let generation = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saving = Promise.resolve();
let made = 0;

/** A file name no picture had: the time, a counter and a few random letters. */
const fresh = () =>
  `${Date.now().toString(36)}-${(made++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const fileOf = ({ name, session: inSession }: Entry) =>
  new File(inSession ? session() : kept(), name);

/** Whether the cache may ask for `url`: a plain http(s) address of at most 2048 characters. */
function fetchable(url: string): boolean {
  if (url.length > URL_LENGTH) return false;
  const parsed = URL.parse(url);
  return (
    parsed !== null &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.username === "" &&
    parsed.password === ""
  );
}

/** The signed-in sources whose login `url` gives away. */
const exposersOf = (url: string): readonly Source[] =>
  signedIn().filter(({ login: [username = "", password = ""] }) =>
    exposes(url, { username, password }),
  );

function failedLately(url: string): boolean {
  const at = failures.get(url);
  if (at === undefined) return false;
  if (Date.now() - at < FAILED_MS) return true;
  failures.delete(url);
  return false;
}

function fail(url: string) {
  failures.set(url, Date.now());
  // Oldest first: past a few thousand, the oldest are asked for again sooner.
  for (const old of failures.keys()) {
    if (failures.size <= MAX_FILES) break;
    failures.delete(old);
  }
}

/** Whether the file is gone, deleting it now if it is there. */
function deleted(file: File): boolean {
  try {
    if (file.exists) file.delete();
    return true;
  } catch {
    return false;
  }
}

/**
 * Deletes a file; one the disk won't let go of counts against the budget until it does. Answers
 * whether it went.
 */
function release(file: File): boolean {
  if (stuck.has(file.uri)) return false;
  if (deleted(file)) return true;
  const bytes = file.size;
  stuck.set(file.uri, bytes);
  stuckBytes += bytes;
  return false;
}

/** Tries again to delete files that wouldn't go; answers whether all went. */
function unstick(): boolean {
  for (const [uri, bytes] of stuck) {
    if (!deleted(new File(uri))) continue;
    stuck.delete(uri);
    stuckBytes -= bytes;
  }
  return stuck.size === 0;
}

/**
 * The entry of `url` whose file is whole and whose address gives no signed-in login away, checked
 * once a process and once a login change; one that fails either is forgotten.
 */
function usable(url: string): Entry | undefined {
  const entry = entries.get(url);
  if (!entry) return undefined;
  if (!entry.shown) {
    const file = fileOf(entry);
    if (!file.exists || file.size !== entry.bytes) {
      forget(url, entry);
      return undefined;
    }
    entry.shown = { kind: "shown", uri: file.uri };
  }
  if (!entry.session && entry.checked !== generation) {
    if (exposersOf(url).length > 0) {
      forget(url, entry);
      return undefined;
    }
    entry.checked = generation;
  }
  return entry;
}

/** What `url` shows, with nothing fetched or changed but an entry that fails `usable` forgotten. */
function judge(url: string): ArtworkState {
  if (slots.get(url)?.blocked || !fetchable(url)) return FAILED;
  const shown = phase === "ready" ? usable(url)?.shown : null;
  if (shown) return shown;
  return failedLately(url) ? FAILED : PENDING;
}

function update(slot: Slot, state: ArtworkState) {
  if (slot.state === state) return;
  slot.state = state;
  for (const listener of slot.listeners) listener();
}

/** Answers whether its file went, so the room it took is free. */
function forget(url: string, entry: Entry): boolean {
  entries.delete(url);
  total -= entry.bytes;
  if (!entry.session) save();
  return release(fileOf(entry));
}

/** Moves the entry last in line; the index learns of it with the next write, or within an hour. */
function touch(url: string, entry: Entry) {
  const now = Date.now();
  if (!entry.session && now - entry.usedAt > TOUCH_MS) save();
  entry.usedAt = now;
  entries.delete(url);
  entries.set(url, entry);
}

/**
 * Makes room for `bytes` more in `files` new files, beside room for each fetch under way to land
 * at its largest, least recently shown first, never one that shows now. While the disk refuses a
 * deletion it makes none: nothing more is forgotten. Answers whether it fits.
 */
function evict(bytes = 0, files = 0): boolean {
  const over = () =>
    total + stuckBytes + running.size * MAX_FILE + bytes > MAX_BYTES ||
    entries.size + stuck.size + running.size + files > MAX_FILES;
  if (!over()) return true;
  if (!unstick()) return false;
  for (const [url, entry] of entries) {
    if (!over()) break;
    if (!slots.has(url) && !forget(url, entry)) break;
  }
  return !over();
}

/** Shows what `url` has now, and queues its fetch when it has nothing, or a picture to refresh. */
function want(url: string, slot: Slot) {
  update(slot, judge(url));
  if (phase !== "ready" || slot.state === FAILED || running.has(url)) return;
  const entry = entries.get(url);
  if (entry && (entry.session || Date.now() - entry.fetchedAt < REFRESH_MS)) return;
  if (entry && failedLately(url)) return;
  queue.add(url);
  pump();
}

/**
 * Starts what is queued, each only once there is room for it to land at its largest; one there
 * is no room for shows the fallback until it is shown again, or keeps its old file.
 */
function pump() {
  for (const url of queue) {
    if (running.size >= TRANSFERS) return;
    queue.delete(url);
    const slot = slots.get(url);
    if (!slot || running.has(url)) continue;
    if (evict(MAX_FILE, 1)) {
      void fetchArt(url, slot);
    } else if (!entries.has(url)) {
      slot.blocked = true;
      update(slot, FAILED);
    }
  }
}

/** What a fetch was started as: whose login its address gave away, and whether the index may keep it. */
interface Started {
  readonly exposed: readonly Source[];
  readonly durable: boolean;
  readonly generation: number;
}

async function fetchArt(url: string, slot: Slot) {
  const exposed = exposersOf(url);
  slot.exposed = exposed;
  const started = { exposed, durable: exposed.length === 0 && retiredLogins() === 0, generation };
  const folder = started.durable ? kept() : session();
  const file = new File(folder, fresh());
  running.set(url, file.name);
  let bytes: number | null = null;
  try {
    folder.create({ intermediates: true, idempotent: true });
    bytes = await fetchPicture(url, file, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_FILE });
  } catch {
    // Failed: nothing kept.
  }
  running.delete(url);
  settle(url, started, file, bytes);
  pump();
}

/**
 * Keeps a finished fetch once it fits, unless the login its address gave away went meanwhile, or
 * an address the index would keep now gives away a login signed in since.
 */
function settle(url: string, started: Started, file: File, bytes: number | null) {
  const current = signedIn();
  const gone = started.exposed.some((source) => !current.includes(source));
  const exposesNow =
    started.durable && started.generation !== generation && exposersOf(url).length > 0;
  const slot = slots.get(url);
  if (gone || exposesNow || bytes === null) {
    release(file);
    if (bytes === null && !gone) fail(url);
    if (slot) {
      if (gone) slot.blocked = true;
      slot.exposed = null;
      want(url, slot);
    }
    return;
  }
  const previous = entries.get(url);
  if (previous) forget(url, previous);
  if (!evict(bytes, 1)) {
    release(file);
    if (slot) {
      slot.blocked = true;
      update(slot, FAILED);
    }
    return;
  }
  const now = Date.now();
  entries.set(url, {
    name: file.name,
    session: !started.durable,
    bytes,
    fetchedAt: now,
    usedAt: now,
    exposed: started.exposed,
    fresh: true,
    shown: { kind: "shown", uri: file.uri },
    checked: started.generation,
  });
  total += bytes;
  failures.delete(url);
  if (started.durable) save();
  if (slot) update(slot, judge(url));
}

/** Writes the index a moment after a change, or at once, one write at a time. */
function save(delay = SAVE_MS) {
  if (saveTimer !== null) {
    if (delay >= SAVE_MS) return;
    clearTimeout(saveTimer);
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saving = saving.then(write);
  }, delay);
}

/**
 * Writes the index's rows, a slice a task, each checked against the logins signed in; one that
 * gives one away is forgotten instead. A login change meanwhile leaves it to the next write.
 */
async function write() {
  const at = generation;
  const all = [...entries];
  const rows: Row[] = [];
  for (let from = 0; from < all.length; from += WRITE_SLICE) {
    if (from > 0) await new Promise((resolve) => setTimeout(resolve, 0));
    if (generation !== at) return;
    for (const [url, entry] of all.slice(from, from + WRITE_SLICE)) {
      if (entry.session || entries.get(url) !== entry) continue;
      if (entry.checked !== at) {
        if (exposersOf(url).length > 0) {
          forget(url, entry);
          continue;
        }
        entry.checked = at;
      }
      rows.push([url, entry.name, entry.bytes, entry.fetchedAt, entry.usedAt]);
    }
  }
  try {
    kept().create({ intermediates: true, idempotent: true });
    const pending = new File(kept(), PENDING_INDEX);
    pending.create({ overwrite: true });
    await pending.write(JSON.stringify({ version: VERSION, entries: rows }));
    // A login signed in while it was written may make a row give it away: it isn't put in place,
    // and the write the change asked for checks every row again.
    if (generation !== at) {
      deleted(pending);
      return;
    }
    await pending.move(new File(kept(), INDEX), { overwrite: true });
  } catch {
    // The next change writes it again; a launch without it starts over.
  }
}

type Row = readonly [url: string, name: string, bytes: number, fetchedAt: number, usedAt: number];

const isRow = (row: unknown): row is Row =>
  Array.isArray(row) &&
  row.length === 5 &&
  typeof row[0] === "string" &&
  row[0].length <= URL_LENGTH &&
  /^https?:\/\//.test(row[0]) &&
  typeof row[1] === "string" &&
  NAME.test(row[1]) &&
  Number.isInteger(row[2]) &&
  row[2] > 0 &&
  row[2] <= MAX_FILE &&
  Number.isFinite(row[3]) &&
  Number.isFinite(row[4]);

/** The index's rows that check out, least recently shown first; none when it won't read. */
async function readIndex(): Promise<readonly Row[]> {
  for (const name of [INDEX, PENDING_INDEX]) {
    try {
      const file = new File(kept(), name);
      if (!file.exists) continue;
      const value: unknown = JSON.parse(await file.text());
      if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === VERSION &&
        "entries" in value &&
        Array.isArray(value.entries)
      ) {
        return value.entries.filter(isRow);
      }
    } catch {
      // Unreadable: try the other, then start again.
    }
  }
  return [];
}

async function load() {
  const rows = await readIndex();
  const now = Date.now();
  for (const [url, name, bytes, fetchedAt, usedAt] of rows) {
    // Unseen too long: left out, and its file to `adopt`.
    if (now - usedAt > UNUSED_MS) continue;
    const previous = entries.get(url);
    if (previous) total -= previous.bytes;
    entries.delete(url);
    entries.set(url, {
      name,
      session: false,
      bytes,
      fetchedAt,
      usedAt,
      exposed: [],
      fresh: false,
      shown: null,
      checked: -1,
    });
    total += bytes;
  }
  // The index is checked against the logins signed in now, and written again without what gives
  // one away.
  if (rows.length > 0) save(0);
}

/**
 * Counts every file the index doesn't name, an earlier launch's session pictures among them,
 * against the budget, then deletes them a few a task; one that won't go is tried again whenever
 * the cache is full.
 */
function adopt() {
  const known = new Set([INDEX, PENDING_INDEX, ...running.values()]);
  for (const entry of entries.values()) known.add(entry.name);
  const orphans: File[] = [];
  for (const folder of [kept(), session()]) {
    try {
      if (!folder.exists) continue;
      for (const each of folder.list()) {
        if (!(each instanceof File) || known.has(each.name) || stuck.has(each.uri)) continue;
        const bytes = each.size;
        stuck.set(each.uri, bytes);
        stuckBytes += bytes;
        orphans.push(each);
      }
    } catch {
      // Not listed: what it holds stays until a later launch.
    }
  }
  const step = () => {
    for (const file of orphans.splice(0, DELETE_SLICE)) {
      const bytes = stuck.get(file.uri);
      if (bytes === undefined || !deleted(file)) continue;
      stuck.delete(file.uri);
      stuckBytes -= bytes;
    }
    if (orphans.length > 0) setTimeout(step, 0);
  };
  step();
}

/**
 * A login set or dropped: pictures whose address gave away one that went go now, an address
 * shown that gave one away shows the fallback, and kept addresses are checked again.
 */
function loginsChanged() {
  generation++;
  const current = signedIn();
  const went = (exposed: readonly Source[] | null) =>
    exposed?.some((source) => !current.includes(source)) ?? false;
  for (const [url, entry] of entries) {
    if (entry.session && went(entry.exposed)) forget(url, entry);
  }
  for (const [url, slot] of slots) {
    if (went(slot.exposed)) {
      slot.blocked = true;
      slot.exposed = null;
      queue.delete(url);
    }
    want(url, slot);
  }
  // The index on disk may hold an address that gives the new login away: written again at once.
  save(0);
}

/** Once a process: reads the index, takes stock of the folders, and starts what waited. */
function start() {
  if (phase !== "idle") return;
  phase = "loading";
  onSignedIn(loginsChanged);
  const ready = () => {
    phase = "ready";
    adopt();
    for (const [url, slot] of slots) want(url, slot);
  };
  void load().then(ready, ready);
}

function watch(url: string, listener: () => void): () => void {
  start();
  let slot = slots.get(url);
  if (!slot) {
    slot = { state: PENDING, listeners: new Set(), exposed: null, blocked: false };
    slots.set(url, slot);
    slot.state = judge(url);
  }
  const own = slot;
  own.listeners.add(listener);
  const entry = phase === "ready" ? entries.get(url) : undefined;
  if (entry) touch(url, entry);
  want(url, own);
  return () => {
    own.listeners.delete(listener);
    if (own.listeners.size > 0 || slots.get(url) !== own) return;
    slots.delete(url);
    queue.delete(url);
    // What showed may now make room.
    if (phase === "ready") evict();
  };
}

const stateOf = (url: string): ArtworkState => slots.get(url)?.state ?? judge(url);

/** The file of `url`, `uri`, won't draw: it goes, and the address is fetched again or fails. */
function wontDraw(url: string, uri: string) {
  const entry = entries.get(url);
  if (!entry || entry.shown?.uri !== uri) return;
  forget(url, entry);
  if (entry.fresh) fail(url);
  const slot = slots.get(url);
  if (slot) want(url, slot);
}

/**
 * The picture at `url` as a file to show: from the cache, once fetched, or as it is for a
 * download's own `file://`. Null shows nothing.
 */
export function useArtwork(url: string | null): Picture {
  const remote = url !== null && !url.startsWith("file://") ? url : null;
  const subscribe = useCallback(
    (listener: () => void) => (remote === null ? () => undefined : watch(remote, listener)),
    [remote],
  );
  const state = useSyncExternalStore(subscribe, () => (remote === null ? NONE : stateOf(remote)));
  // The file that wouldn't draw here: a download's own stays failed, the cache's is replaced.
  const [broken, setBroken] = useState<string | null>(null);
  return useMemo((): Picture => {
    const picture = (uri: string): Picture =>
      uri === broken
        ? FAILED
        : {
            kind: "shown",
            uri,
            broke: () => {
              setBroken(uri);
              if (remote !== null) wontDraw(remote, uri);
            },
          };
    if (remote === null) return url === null ? NONE : picture(url);
    return state.kind === "shown" ? picture(state.uri) : state;
  }, [url, remote, state, broken]);
}
