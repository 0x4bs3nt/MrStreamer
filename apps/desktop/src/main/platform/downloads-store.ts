// The downloads on disk, in the SQLite database the viewing record and the watchlist share
// (database.ts): one row per download in a table of its own, which builds before downloads never
// read or erase. A row is the download's whole record as one document: the exact provider file it
// was made from, what was kept of its details, how far its transfer got and how far the copy was
// watched here. Its bytes and artwork are files in the app's downloads folder (services/downloads.ts).
// Erasing an account's viewing data leaves these rows: a copy is the viewer's until they delete it.
// A row this build can't read, as one a later build wrote, is left as it is, and so are its files.
import type { DatabaseSync } from "node:sqlite";
import type { DownloadFailure } from "@mrstreamer/contracts/downloads";
import { RawTitleRef } from "@mrstreamer/contracts/ondemand";
import type { Failed } from "@mrstreamer/core/failure";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { t } from "@mrstreamer/core/i18n";
import { attempt, Database, unavailable } from "./database.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

/** What was kept of a title's details for its copy, shown without asking anyone. */
const About = lazy(() =>
  type({
    name: "string",
    episodeName: "string | null",
    year: "number | null",
    duration: "number | null",
    originalLanguage: "string | null",
    /** The content type of each kept picture, or null without one. */
    poster: "string | null",
    wide: "string | null",
  }),
);
export type About = Infer<typeof About>;

/**
 * Which file the partial bytes are of, as the provider's answers said: the address they came
 * from after redirects, by its fingerprint (`resourceKey`), its strong mark, and the whole file's
 * size. A transfer goes on from them only for an answer that says the same.
 */
const PartIdentity = lazy(() =>
  type({ resource: "string", mark: "string", size: "number.integer >= 0" }),
);
export type PartIdentity = Infer<typeof PartIdentity>;

const Stored = lazy(() =>
  type({
    id: "string",
    /**
     * The account the file is of: what a removed subscription's unfinished downloads are found
     * by.
     */
    account: "string",
    /** The subscription it was asked of; another one of the same account asks after a re-add. */
    subscriptionId: "string",
    title: RawTitleRef(),
    /** The listing the file was resolved from, and the login it was read under. */
    listingKey: "string",
    sourceStamp: "string",
    container: "string",
    about: About(),
    state: "'queued' | 'failed' | 'complete'",
    /** Why it failed, as `DownloadFailure` says; only while failed. */
    "failure?": "object",
    /** The whole file's size, once known. */
    size: "number.integer >= 0 | null",
    /** Bytes in the partial file, or of the copy once complete. */
    received: "number.integer >= 0",
    identity: PartIdentity().or("null"),
    /** Its transfer started again from the start, as when the file changed. */
    restarted: "boolean",
    addedAt: "number",
    completedAt: "number | null",
    progress: type({ position: "number >= 0", duration: "number > 0", at: "number" }).or("null"),
  }),
);
type Stored = Infer<typeof Stored>;

/** A download's record as the service keeps it. */
export type StoredDownload = Omit<Stored, "failure"> & { readonly failure?: DownloadFailure };

const FAILURES: ReadonlySet<string> = new Set(["disk-full", "folder", "stream", "app"]);

/** Every row of the downloads table: the records read, and the ids of those that couldn't be. */
export interface Inventory {
  readonly records: readonly StoredDownload[];
  readonly unreadable: ReadonlySet<string>;
}

export class DownloadStore extends Context.Service<
  DownloadStore,
  {
    /**
     * Every download this build can read, in the order they were added, and the ids of rows it
     * can't: what is kept for those isn't another download's to clean up.
     */
    readonly list: Effect.Effect<Inventory, Failed>;
    /** Stores a download's record, new or changed. */
    put(download: StoredDownload): Effect.Effect<void, Failed>;
    remove(id: string): Effect.Effect<void, Failed>;
  }
>()("mrstreamer/DownloadStore") {}

function prepareDownloads(db: DatabaseSync): void {
  db.exec(`create table if not exists downloads (
    id text primary key,
    added_at integer not null,
    record text not null
  )`);
}

export const downloadStoreLayer = Layer.effect(
  DownloadStore,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(() => opened.failure);
    return yield* attempt(() => {
      const { db } = opened;
      prepareDownloads(db);
      const all = db.prepare("select id, record from downloads order by added_at, rowid");
      const write = db.prepare(`insert into downloads (id, added_at, record) values (?, ?, ?)
        on conflict (id) do update set record = excluded.record`);
      const remove = db.prepare("delete from downloads where id = ?");
      return {
        list: attempt((): Inventory => {
          const records: StoredDownload[] = [];
          const unreadable = new Set<string>();
          for (const row of all.all()) {
            const parsed = readRecord(row.record);
            if (parsed !== null && parsed.id === row.id) records.push(parsed);
            else unreadable.add(String(row.id));
          }
          return { records, unreadable };
        }),
        put: (download: StoredDownload) =>
          attempt(() => {
            write.run(download.id, download.addedAt, JSON.stringify(Stored().assert(download)));
          }),
        remove: (id: string) =>
          attempt(() => {
            remove.run(id);
          }),
      };
    }).pipe(Effect.catch(() => Effect.succeed(closed(() => t("Downloads can't be opened.")))));
  }),
);

/** A row's record as this build knows them, or null. */
function readRecord(record: unknown): StoredDownload | null {
  try {
    const parsed = Stored()(JSON.parse(String(record)));
    if (parsed instanceof type.errors) return null;
    const { failure, ...rest } = parsed;
    return { ...rest, ...(failure ? { failure: failureOf(failure) } : {}) };
  } catch {
    return null;
  }
}

/** A stored failure as this build knows them; one it doesn't is an unexpected one. */
function failureOf(stored: object): DownloadFailure {
  return "kind" in stored && typeof stored.kind === "string" && FAILURES.has(stored.kind)
    ? (stored as DownloadFailure)
    : { kind: "app", error: { kind: "unexpected", detail: t("This download stopped.") } };
}

/**
 * A store whose every call fails with `detail`, made when it fails so it says so in the interface
 * language of the moment.
 */
function closed(detail: () => string): DownloadStore["Service"] {
  const fail = Effect.suspend(() => unavailable(detail()));
  return { list: fail, put: () => fail, remove: () => fail };
}
