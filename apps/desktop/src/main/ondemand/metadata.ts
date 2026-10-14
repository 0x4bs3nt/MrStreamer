// TMDB's metadata for the catalogue, in the catalogue worker: fetched in the background, newest
// titles first, kept in metadata.json.gz and refreshed before TMDB's six months run out. Each
// title's name is asked for in the viewer's language and kept per language, so switching back
// asks nothing. Without a key, or with one TMDB refuses, the catalogue works as before, with the
// provider's names and without genres or services.
import { isDeepStrictEqual } from "node:util";
import { type } from "arktype";
import {
  TmdbError,
  type StreamingService,
  type TitleMetadata,
  type Tmdb,
  type TmdbKind,
} from "@mrstreamer/core/metadata/tmdb";
import { normalize } from "@mrstreamer/core/text";
import { readJsonFile, writeJsonFile } from "../platform/json-file.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

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
type MetadataFile = Infer<typeof MetadataFile>;

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
  readonly path: string;
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
  const loading = readJsonFile(deps.path, MetadataFile()).then(
    (found) => {
      if (!found) return;
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
      if (!dirty) return;
      dirty = false;
      lastSave = now();
      for (const [key, entry] of Object.entries(file.entries)) {
        if (!fresh(entry.at, EXPIRE_MS)) delete file.entries[key];
      }
      if (file.services && !fresh(file.services.at, EXPIRE_MS)) file.services = null;
      await writeJsonFile(deps.path, file).catch(() => {
        dirty = true;
      });
    });
    return saving;
  }

  /**
   * Runs `task` for each item, PARALLEL at a time, at most PER_SECOND starts a second, until
   * `stop` says to.
   */
  async function paced<T>(
    items: readonly T[],
    stop: () => boolean,
    task: (item: T) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    let slot = now();
    const lane = async () => {
      while (next < items.length && !refused && !unreachable() && !stop()) {
        const item = items[next++] as T;
        const wait = Math.max(0, slot - now(), pausedUntil - now());
        slot = Math.max(slot, now()) + 1000 / PER_SECOND;
        if (wait > 0) await new Promise((done) => setTimeout(done, wait));
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
  async function ask<A>(call: () => Promise<A>): Promise<A | "missing" | null> {
    for (let tries = 0; tries < 3; tries++) {
      try {
        const answer = await call();
        unanswered = 0;
        return answer;
      } catch (cause) {
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
        if (tries < 2) await new Promise((done) => setTimeout(done, wait));
      }
    }
    unanswered++;
    return null;
  }

  /** Fetches what `list` lacks or holds too old, until `replaced` says a newer list came. */
  async function fetchTitles(
    client: Tmdb,
    list: readonly Wanted[],
    asked: string,
    replaced: () => boolean,
  ): Promise<void> {
    const due = list
      .filter((title) => {
        const entry = file.entries[keyOf(title.kind, title.tmdbId)];
        if (!entry || !fresh(entry.at, KEEP_MS)) return true;
        return !entry.missing && entry.names?.[asked] === undefined;
      })
      .toSorted((a, b) => b.addedAt - a.addedAt);
    await paced(due, replaced, async (title) => {
      const key = keyOf(title.kind, title.tmdbId);
      const found = await ask(() => client.details(title.kind, title.tmdbId, asked));
      if (found === null) return;
      /** What the entry's arrival changes: only its time, only the status, or what lists show. */
      const arrived = (entry: Entry): "content" | "status" | "same" => {
        const kept = file.entries[key];
        // Lists saw the kept entry only while it hadn't expired.
        const shown = current(title.kind, title.tmdbId);
        const counted = answered(title.kind, title.tmdbId);
        file.entries[key] = entry;
        // A wrong "same" would leave lists stale, so anything but equal is content, and an entry
        // that had expired is always content: lists built before and after it differ.
        if (shown && isDeepStrictEqual({ ...shown, at: 0 }, { ...entry, at: 0 })) {
          return counted ? "same" : "status";
        }
        return entry.missing && (!kept || kept.missing) ? "status" : "content";
      };
      if (found === "missing") {
        changed(arrived({ at: now(), missing: true }));
        return;
      }
      const { name, original, ...metadata } = found;
      const names = { ...file.entries[key]?.names, [asked]: name };
      // Without a translation, the English name stands in, unless the title is English anyway.
      if (name === null && asked !== "en" && found.language !== "en" && names.en === undefined) {
        const english = await ask(() => client.details(title.kind, title.tmdbId, "en"));
        if (english !== null && english !== "missing") names.en = english.name;
      }
      const change = arrived({
        at: now(),
        ...metadata,
        genres: [...metadata.genres],
        names,
        original,
      });
      searchNames.delete(key);
      changed(change);
    });
  }

  async function fetchServices(client: Tmdb, replaced: () => boolean): Promise<void> {
    if (file.services?.region === deps.region && fresh(file.services.at, SERVICES_KEEP_MS)) {
      return;
    }
    const lists: Record<TmdbKind, (StreamingService & { ids: string[] })[]> = { movie: [], tv: [] };
    for (const kind of ["movie", "tv"] as const) {
      const services = await ask(() => client.services(kind, deps.region));
      if (!services || services === "missing") return;
      for (const service of services.slice(0, SERVICES)) {
        const ids: string[] = [];
        for (let page = 1, pages = 1; page <= Math.min(pages, SERVICE_PAGES); page++) {
          if (replaced() || unreachable()) return;
          const found = await ask(() => client.onService(kind, service.id, deps.region, page));
          // A page TMDB won't give ends this service's list, not the others'.
          if (!found || found === "missing") break;
          ids.push(...found.ids);
          pages = found.pages;
          await new Promise((done) => setTimeout(done, 1000 / PER_SECOND));
        }
        lists[kind].push({ ...service, ids });
      }
    }
    file.services = { region: deps.region, at: now(), ...lists };
    changed("content", true);
  }

  async function run(client: Tmdb): Promise<void> {
    await loading;
    unanswered = 0;
    // A new list or language is told of quickly again, however long the last run went on.
    contentGap = CONTENT_FIRST_MS;
    // A newer list, as after a refresh or for another account, takes over at once, ahead of
    // the services, a crawl of minutes.
    const list = wanted;
    const asked = language;
    const replaced = () => wanted !== list || language !== asked;
    await fetchTitles(client, list, asked, replaced);
    // The services take minutes to crawl; the titles' names needn't wait for them.
    if (untold) changed("status", true);
    if (!refused && !replaced()) await fetchServices(client, replaced);
    changed("status", true);
    await save();
  }

  return {
    /**
     * The titles the catalogue lists; fetches what is missing or old, in the background. A list
     * given while fetching is fetched next.
     */
    want(titles: readonly Wanted[], viewerLanguage: string = language): void {
      language = viewerLanguage;
      wanted = titles;
      const client = deps.client;
      // Nothing listed, as once the account goes, starts nothing; a run in progress stops.
      if (!client || refused || running || titles.length === 0) return;
      running = (async () => {
        // Again for a list or a language that came while fetching.
        let doneList: readonly Wanted[] | null = null;
        let doneLanguage: string | null = null;
        while ((doneList !== wanted || doneLanguage !== language) && wanted.length > 0) {
          if (refused) break;
          doneList = wanted;
          doneLanguage = language;
          await run(client);
        }
      })().finally(() => {
        running = null;
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

    /** Every name TMDB gave a title, folded for search, or "" before it said. */
    searchName(kind: TmdbKind, tmdbId: string): string {
      const key = keyOf(kind, tmdbId);
      let found = searchNames.get(key);
      if (found === undefined) {
        const entry = current(kind, tmdbId);
        const names = Object.values(entry?.names ?? {}).filter((name) => name !== null);
        found = normalize([...names, entry?.original ?? ""].join(" "));
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

    /** Writes what changed, after any write in progress, for stopping. */
    flush: () => save(),
  };
}
