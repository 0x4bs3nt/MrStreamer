// TMDB's metadata for the catalogue: fetched in the background, newest titles first, kept in a
// file the app names and refreshed before TMDB's six months run out. Each title's name is asked
// for in the viewer's language and kept per language, so switching back asks nothing. Without a
// key, or with one TMDB refuses, the catalogue works as before, with the provider's names and
// without genres or services. The desktop runs it in its catalogue worker, iOS on its JS thread;
// each says how its file is read and written.
import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { normalize } from "../text.ts";
import {
  TmdbError,
  type StreamingService,
  type TitleMetadata,
  type Tmdb,
  type TmdbKind,
} from "./tmdb.ts";

/** Fetched again after this long, and no longer used after six months, TMDB's limit. */
const KEEP_MS = 150 * 24 * 60 * 60_000;
const EXPIRE_MS = 182 * 24 * 60 * 60_000;
/** Which titles each streaming service carries changes often; fetched again after a week. */
const SERVICES_KEEP_MS = 7 * 24 * 60 * 60_000;
/** Requests in flight at once, and at most this many a second: TMDB allows about 50. */
const PARALLEL = 8;
const PER_SECOND = 40;
/** How often the store is written while fetching. */
const SAVE_EVERY_MS = 30_000;
/** Streaming services followed per region and kind, most prominent first. */
const SERVICES = 12;
/** Pages read per service and kind, 20 titles each: its most popular 5,000. */
const SERVICE_PAGES = 250;
/** Requests in a row TMDB didn't answer before a run stops: offline, or TMDB down. */
const GIVE_UP_AFTER = 3 * PARALLEL;
/**
 * How far apart the UI is told of metadata. Every notice of new content has each open list read
 * again from the whole library, a second of the worker's time for a large one, so these start
 * CONTENT_FIRST_MS apart and double with each one sent during a run, up to CONTENT_LAST_MS. A
 * notice of progress only computes the status and reads no list again, so it keeps
 * PROGRESS_EVERY_MS.
 */
const PROGRESS_EVERY_MS = 3000;
const CONTENT_FIRST_MS = 3000;
const CONTENT_LAST_MS = 30_000;

const Entry = lazy(() =>
  type({
    at: "number",
    "missing?": "true",
    "genres?": "number[]",
    "language?": "string | null",
    "popularity?": "number",
    "rating?": "number",
    "votes?": "number",
    "collection?": type({ id: "number", name: "string" }).or("null"),
    "backdrop?": "string | null",
    /** The name by ISO 639-1 language; null where TMDB has no translation. */
    "names?": type({ "[string]": "string | null" }),
    "original?": "string | null",
  }),
);
type Entry = Infer<typeof Entry>;
const ServiceList = lazy(() =>
  type({ id: "number", name: "string", priority: "number", ids: "string[]" }),
);
const MetadataFile = lazy(() =>
  type({
    version: "1",
    entries: type({ "[string]": Entry() }),
    "services?": type({
      region: "string",
      at: "number",
      movie: ServiceList().array(),
      tv: ServiceList().array(),
    }).or("null"),
  }),
);
export type MetadataFile = Infer<typeof MetadataFile>;

/** A title the catalogue lists, as the store needs it. */
export interface Wanted {
  readonly kind: TmdbKind;
  readonly tmdbId: string;
  /** Newer titles are fetched first. */
  readonly addedAt: number;
}

/** A streaming service and the TMDB ids of what it streams in the region. */
export interface ServiceTitles extends StreamingService {
  readonly ids: ReadonlySet<string>;
}

export interface MetadataStatus {
  /** Titles TMDB answered for, and titles the catalogue lists with a TMDB id. */
  readonly known: number;
  readonly wanted: number;
  /** TMDB refused the key: nothing more is fetched until it changes. */
  readonly refused: boolean;
  /** Fetching now; false once a run ends, whether or not every title got an answer. */
  readonly fetching: boolean;
}

export interface MetadataDeps {
  /**
   * The kept file as it was last written, unchecked, or null when there is none. A file that
   * doesn't match is like none: everything is fetched again.
   */
  readonly read: () => Promise<unknown>;
  /** Replaces the kept file, whole; a write that fails is tried again with the next. */
  readonly write: (file: MetadataFile) => Promise<void>;
  /** Null without a key: the store answers from disk and fetches nothing. */
  readonly client: Tmdb | null;
  /** ISO 3166-1 country for streaming services: "NL". */
  readonly region: string;
  /**
   * Called when the status moved or more metadata arrived, no more often than the store allows.
   * `content` says that what lists show changed, so they are read again; without it only the
   * status did.
   */
  readonly onChange: (change: { readonly content: boolean }) => void;
  readonly now?: () => number;
}

export function metadataStore(deps: MetadataDeps) {
  const now = deps.now ?? Date.now;
  let file: MetadataFile = { version: 1, entries: {}, services: null };
  // A file that can't be read is like none: everything is fetched again.
  const loading = deps.read().then(
    (read) => {
      const found = read === null ? null : MetadataFile()(read);
      if (!found || found instanceof type.errors) return;
      file = found;
      // A title searched before this was given no names: they are worked out again.
      searchNames.clear();
      // Lists built before this show the provider's names and no genres, and nothing later
      // would say so when the cache needs no fetching: that is content, told once.
      if (shows(found)) {
        untold = true;
        notify(true);
      }
      // What is past TMDB's limit goes, key or no key.
      if (Object.values(file.entries).some((entry) => !fresh(entry.at, EXPIRE_MS))) {
        dirty = true;
        void save();
      }
    },
    () => {},
  );
  let wanted: readonly Wanted[] = [];
  /** The viewer's language, which names are asked for in. */
  let language = "en";
  /** Each entry's names, folded for search, worked out when first searched. */
  const searchNames = new Map<string, string>();
  let refused = false;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let closing: Promise<void> | null = null;
  let closed = false;
  let dirty = false;
  let saving: Promise<void> = Promise.resolve();
  let lastSave = now();
  /** When the UI was last told anything, and when it was last told of content. */
  let lastNotice = 0;
  let lastContent = 0;
  /** How long the next notice of content waits after the last one. */
  let contentGap = CONTENT_FIRST_MS;
  /** Content that arrived and the UI hasn't been told of yet. */
  let untold = false;
  /** When TMDB asked to wait until, for every request. */
  let pausedUntil = 0;
  /** Reserved title starts survive replacement, so churn cannot reset the request rate. */
  let slot = now();
  /** Requests in a row that got no answer; the next run tries again. */
  let unanswered = 0;
  const unreachable = () => unanswered >= GIVE_UP_AFTER;

  const keyOf = (kind: TmdbKind, id: string) => `${kind}:${id}`;
  const fresh = (at: number, keep: number) => now() - at < keep;
  const servicesShown = (kept: MetadataFile["services"] | undefined) =>
    kept?.region === deps.region && fresh(kept.at, EXPIRE_MS);
  /** Whether lists show anything of `kept`: a title TMDB knows or the region's services. */
  const shows = (kept: MetadataFile) =>
    servicesShown(kept.services) ||
    Object.values(kept.entries).some((entry) => !entry.missing && fresh(entry.at, EXPIRE_MS));
  const current = (kind: TmdbKind, id: string) => {
    const entry = file.entries[keyOf(kind, id)];
    return entry && fresh(entry.at, EXPIRE_MS) ? entry : undefined;
  };
  /** Whether TMDB answered for the title, its name in the viewer's language included. */
  const answered = (kind: TmdbKind, id: string) => {
    const entry = current(kind, id);
    return entry !== undefined && (entry.missing === true || entry.names?.[language] !== undefined);
  };

  /**
   * Records a change and tells the UI when its turn comes. `content` is what lists show, `status`
   * is only the status, and `same` is a refetched entry that changed in nothing: saved, and told
   * to nobody unless content is waiting. Every arrival checks whether content not yet told is
   * due, so a title that changed is not held back by the unchanged answers after it. A forced
   * notice is not held to any spacing and carries any content not yet told. While TMDB has
   * everyone paused (a busy answer) no answer arrives, and waiting content waits for the next
   * one: bounded by the pause, and a run that gives up ends with a forced notice.
   */
  function changed(change: "content" | "status" | "same", force = false): void {
    dirty = true;
    if (change === "content") untold = true;
    const at = now();
    const content = untold && (force || at - lastContent > contentGap);
    if (content || force || (change !== "same" && at - lastNotice > PROGRESS_EVERY_MS)) {
      notify(content);
    }
  }

  function notify(content: boolean): void {
    lastNotice = now();
    if (content) {
      lastContent = lastNotice;
      contentGap = Math.min(contentGap * 2, CONTENT_LAST_MS);
      untold = false;
    }
    deps.onChange({ content });
  }

  /** Writes what changed, one write at a time, leaving out what is past TMDB's limit. */
  function save(): Promise<void> {
    saving = saving.then(async () => {
      await loading;
      if (!dirty) return;
      dirty = false;
      lastSave = now();
      for (const [key, entry] of Object.entries(file.entries)) {
        if (!fresh(entry.at, EXPIRE_MS)) delete file.entries[key];
      }
      if (file.services && !fresh(file.services.at, EXPIRE_MS)) file.services = null;
      await deps.write(file).catch(() => {
        dirty = true;
      });
    });
    return saving;
  }

  /**
   * Runs `task` for each item, PARALLEL at a time, at most PER_SECOND starts a second, until
   * the run is cancelled.
   */
  async function paced<T>(
    items: readonly T[],
    signal: AbortSignal,
    task: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const lane = async () => {
      while (next < items.length && !refused && !unreachable() && !signal.aborted) {
        const item = items[next++] as T;
        const wait = Math.max(0, slot - now(), pausedUntil - now());
        slot = Math.max(slot, now()) + 1000 / PER_SECOND;
        if (wait > 0 && !(await delay(wait, signal))) return;
        if (signal.aborted || refused) return;
        await task(item);
        if (now() - lastSave > SAVE_EVERY_MS) await save();
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, lane));
  }

  /**
   * Calls TMDB, waiting when it asks to and trying again after a failure; null when it can't
   * answer now.
   */
  async function ask<A>(
    signal: AbortSignal,
    call: () => Promise<A>,
  ): Promise<A | "missing" | null> {
    for (let tries = 0; tries < 3 && !signal.aborted && !refused; tries++) {
      try {
        const answer = await call();
        if (signal.aborted) return null;
        unanswered = 0;
        return answer;
      } catch (cause) {
        // A cancelled request may still settle as an HTTP failure or a late answer.
        if (signal.aborted) return null;
        if (!(cause instanceof TmdbError)) return null;
        const failure = cause.failure;
        if (failure.kind === "missing") {
          unanswered = 0;
          return "missing";
        }
        if (failure.kind === "refused") {
          refused = true;
          changed("status", true);
          return null;
        }
        const wait = failure.kind === "busy" ? failure.retryAfter * 1000 : 1000 * 2 ** tries;
        // Every request waits when TMDB asks to, not only this one.
        if (failure.kind === "busy") pausedUntil = Math.max(pausedUntil, now() + wait);
        if (tries < 2 && !(await delay(wait, signal))) return null;
      }
    }
    if (!signal.aborted && !refused) unanswered++;
    return null;
  }

  /** Fetches what `list` lacks or holds too old, while this run owns its answers. */
  async function fetchTitles(
    client: Tmdb,
    list: readonly Wanted[],
    asked: string,
    signal: AbortSignal,
  ): Promise<void> {
    const needsEnglish = (entry: Entry) =>
      asked !== "en" &&
      entry.language !== "en" &&
      entry.names?.[asked] === null &&
      entry.names.en === undefined;
    const due = list
      .filter((title) => {
        const entry = file.entries[keyOf(title.kind, title.tmdbId)];
        if (!entry || !fresh(entry.at, KEEP_MS)) return true;
        return !entry.missing && (entry.names?.[asked] === undefined || needsEnglish(entry));
      })
      .toSorted((a, b) => b.addedAt - a.addedAt);
    await paced(due, signal, async (title) => {
      const key = keyOf(title.kind, title.tmdbId);
      /** What the entry's arrival changes: only its time, only the status, or what lists show. */
      const arrived = (entry: Entry): "content" | "status" | "same" => {
        const kept = file.entries[key];
        // Lists saw the kept entry only while it hadn't expired.
        const shown = current(title.kind, title.tmdbId);
        const counted = answered(title.kind, title.tmdbId);
        file.entries[key] = entry;
        searchNames.delete(key);
        // A wrong "same" would leave lists stale, so anything but equal is content, and an entry
        // that had expired is always content: lists built before and after it differ.
        if (shown && sameValue({ ...shown, at: 0 }, { ...entry, at: 0 })) {
          return counted ? "same" : "status";
        }
        return entry.missing && (!kept || kept.missing) ? "status" : "content";
      };
      let entry = file.entries[key];
      if (!entry || !fresh(entry.at, KEEP_MS) || entry.names?.[asked] === undefined) {
        const found = await ask(signal, () =>
          client.details(title.kind, title.tmdbId, asked, signal),
        );
        if (found === null || signal.aborted) return;
        if (found === "missing") {
          changed(arrived({ at: now(), missing: true }));
          return;
        }
        const { name, original, ...metadata } = found;
        // Keep a completed translation even when replacement cancels its optional fallback.
        entry = {
          at: now(),
          ...metadata,
          genres: [...metadata.genres],
          names: { ...entry?.names, [asked]: name },
          original,
        };
        changed(arrived(entry));
      }
      // Resume an interrupted English lookup without refetching the completed primary answer.
      if (needsEnglish(entry)) {
        const english = await ask(signal, () =>
          client.details(title.kind, title.tmdbId, "en", signal),
        );
        if (english !== null && !signal.aborted) {
          changed(
            arrived({
              ...entry,
              names: { ...entry.names, en: english === "missing" ? null : english.name },
            }),
          );
        }
      }
    });
  }

  async function fetchServices(client: Tmdb, signal: AbortSignal): Promise<void> {
    if (file.services?.region === deps.region && fresh(file.services.at, SERVICES_KEEP_MS)) {
      return;
    }
    const lists: Record<TmdbKind, (StreamingService & { ids: string[] })[]> = { movie: [], tv: [] };
    for (const kind of ["movie", "tv"] as const) {
      const services = await ask(signal, () => client.services(kind, deps.region, signal));
      if (!services || services === "missing" || signal.aborted) return;
      for (const service of services.slice(0, SERVICES)) {
        const ids: string[] = [];
        for (let page = 1, pages = 1; page <= Math.min(pages, SERVICE_PAGES); page++) {
          if (signal.aborted || refused || unreachable()) return;
          const found = await ask(signal, () =>
            client.onService(kind, service.id, deps.region, page, signal),
          );
          // An exhausted transient failure abandons this crawl: partial membership must not
          // replace a complete snapshot or receive another week of freshness. A missing page
          // is terminal for this service only, as before.
          if (!found || signal.aborted) return;
          if (found === "missing") break;
          ids.push(...found.ids);
          pages = found.pages;
          if (!(await delay(1000 / PER_SECOND, signal))) return;
        }
        lists[kind].push({ ...service, ids });
      }
    }
    // Even the final request can settle after a new wanted list or language takes over.
    if (signal.aborted || refused) return;
    file.services = { region: deps.region, at: now(), ...lists };
    changed("content", true);
  }

  async function run(
    client: Tmdb,
    list: readonly Wanted[],
    asked: string,
    signal: AbortSignal,
  ): Promise<void> {
    await loading;
    if (signal.aborted) return;
    unanswered = 0;
    // A new list or language is told of quickly again, however long the last run went on.
    contentGap = CONTENT_FIRST_MS;
    // A changed list or language takes over at once, ahead of
    // the services, a crawl of minutes.
    await fetchTitles(client, list, asked, signal);
    // The services take minutes to crawl; the titles' names needn't wait for them.
    if (untold) changed("status", true);
    if (!refused && !signal.aborted && !unreachable()) await fetchServices(client, signal);
    changed("status", true);
    await save();
  }

  return {
    /**
     * The raw expiry of a title, or the region's services without an id. A derived snapshot
     * compares this with its own start time, so a cutoff crossed while building isn't lost.
     * Infinity means this dependency is absent.
     */
    expiresAt(kind: TmdbKind, tmdbId?: string): number {
      const at =
        tmdbId === undefined
          ? file.services?.region === deps.region
            ? file.services.at
            : undefined
          : file.entries[keyOf(kind, tmdbId)]?.at;
      return at === undefined ? Infinity : at + EXPIRE_MS;
    },

    /**
     * Fetches what the listed titles lack or hold too old. Equal titles in the same order and
     * language keep running requests intact and recheck missing answers afterwards; an idle
     * run can restart after an offline failure.
     * Changed demand or language cancels the old run and is fetched next. Cached answers remain
     * reusable across temporary wants and source changes until TMDB's hard expiry.
     */
    want(titles: readonly Wanted[], viewerLanguage: string = language): void {
      if (closed) return;
      if (running && language === viewerLanguage && sameWanted(wanted, titles)) {
        wanted = titles;
        return;
      }
      if (wanted !== titles || language !== viewerLanguage) controller?.abort();
      language = viewerLanguage;
      wanted = titles;
      const client = deps.client;
      // Nothing listed, as once the account goes, starts nothing; a run in progress stops.
      if (!client || refused || running || titles.length === 0) return;
      running = (async () => {
        // Again for a list or a language that came while fetching.
        let doneList: readonly Wanted[] | null = null;
        let doneLanguage: string | null = null;
        while (
          !closed &&
          wanted.length > 0 &&
          (doneList !== wanted || doneLanguage !== language || controller?.signal.aborted)
        ) {
          if (refused) break;
          doneList = wanted;
          doneLanguage = language;
          controller = new AbortController();
          await run(client, doneList, doneLanguage, controller.signal);
        }
      })().finally(() => {
        running = null;
        controller = null;
        // The run ended, and with it the fetching the status reported.
        notify(untold);
      });
    },

    /** What TMDB knows about a title, from the store; null before it arrived or once too old. */
    get(kind: TmdbKind, tmdbId: string): TitleMetadata | null {
      const entry = current(kind, tmdbId);
      if (!entry || entry.missing) return null;
      return {
        genres: entry.genres ?? [],
        language: entry.language ?? null,
        popularity: entry.popularity ?? 0,
        rating: entry.rating ?? 0,
        votes: entry.votes ?? 0,
        collection: entry.collection ?? null,
        backdrop: entry.backdrop ?? null,
      };
    },

    /**
     * A title's name for a viewer of `viewerLanguage`, and its original name when that differs:
     * the translation, else the name in the language it was made in when that is the viewer's,
     * else the English name. Null when TMDB hasn't said, so the provider's name stands.
     */
    name(
      kind: TmdbKind,
      tmdbId: string,
      viewerLanguage: string,
    ): { readonly name: string; readonly original: string | null } | null {
      const entry = current(kind, tmdbId);
      if (!entry || entry.missing) return null;
      const original = entry.original ?? null;
      const madeIn = entry.language ?? null;
      const name =
        entry.names?.[viewerLanguage] ??
        (madeIn === viewerLanguage ? original : null) ??
        entry.names?.["en"] ??
        (madeIn === "en" ? original : null) ??
        original;
      if (!name) return null;
      return { name, original: original && original !== name ? original : null };
    },

    /** Raw, independent translations and original name for relevance and punctuation recall. */
    searchAliases(kind: TmdbKind, tmdbId: string): readonly string[] {
      const entry = current(kind, tmdbId);
      if (!entry || entry.missing) return [];
      return [...Object.values(entry.names ?? {}), entry.original].filter(
        (name): name is string => typeof name === "string" && name !== "",
      );
    },

    /** Every name TMDB gave a title, folded for search, or "" before it said. */
    searchName(kind: TmdbKind, tmdbId: string): string {
      const key = keyOf(kind, tmdbId);
      // Check time before the memo: a warm alias must expire just like get/name, key or no key.
      const entry = current(kind, tmdbId);
      if (!entry || entry.missing) return "";
      let found = searchNames.get(key);
      if (found === undefined) {
        const names = Object.values(entry.names ?? {}).filter((name) => name !== null);
        found = normalize([...names, entry.original ?? ""].join(" "));
        searchNames.set(key, found);
      }
      return found;
    },

    /** The streaming services of the region, each with what it streams. */
    services(kind: TmdbKind): readonly ServiceTitles[] {
      if (!file.services || !servicesShown(file.services)) return [];
      return file.services[kind].map(({ ids, ...service }) => ({ ...service, ids: new Set(ids) }));
    },

    status(): MetadataStatus {
      // Titles TMDB answered for, including ids it doesn't know.
      const known = wanted.filter((title) => answered(title.kind, title.tmdbId)).length;
      return { known, wanted: wanted.length, refused, fetching: running !== null };
    },

    /** Writes completed answers after loading and any write in progress; fetching may continue. */
    flush: async () => {
      await loading;
      await save();
    },

    /** Stops owned requests and waits for their closure and completed answers to be written. */
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      controller?.abort();
      closing = (async () => {
        await loading;
        await running;
        await save();
      })();
      return closing;
    },
  };
}

/** Equal ordered demand keeps an active run, including requests whose answers have not arrived. */
function sameWanted(a: readonly Wanted[], b: readonly Wanted[]): boolean {
  return (
    a.length === b.length &&
    a.every((title, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        title.kind === other.kind &&
        title.tmdbId === other.tmdbId &&
        title.addedAt === other.addedAt
      );
    })
  );
}

/** A run's pacing and retry waits end immediately on cancellation, releasing their timers. */
function delay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve(!signal.aborted);
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Whether two JSON values are equal, whatever order their keys are in. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a).filter((key) => (a as Record<string, unknown>)[key] !== undefined);
  const bKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) =>
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}
