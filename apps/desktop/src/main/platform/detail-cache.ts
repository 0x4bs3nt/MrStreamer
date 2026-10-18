// Opened title details are disposable display data. Provider records belong to a saved source;
// TMDB descriptions are shared by id/language. File authorization stays with OnDemand's current
// catalogue and exact-file checks, never with this store.
import type { DatabaseSync } from "node:sqlite";
import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import type { EpisodeAbout, TitleAbout } from "@mrstreamer/core/metadata/tmdb";
import type { ProviderDetails } from "@mrstreamer/core/provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction } from "./database.ts";

export const DETAIL_CACHE_TABLE = "title_detail_cache";
/** Live payload only. SQLite free pages and WAL are measured separately. */
const PAYLOAD_BYTES = 64 * 1024 * 1024;
/** A single enormous series remains usable without being persisted. */
const RECORD_BYTES = 8 * 1024 * 1024;
/** Bounds bookkeeping even when most records are tiny missing answers. */
const RECORDS = 2048;
/** A write never scans or prunes an unbounded number of old entries. */
const PRUNE_BATCH = 64;

export interface ProviderDetailKey {
  readonly kind: "provider";
  readonly account: string;
  readonly subscriptionId: string;
  readonly sourceStamp: string;
  readonly importRevision?: string;
  readonly titleKind: TitleKind;
  readonly id: string;
}

export type DetailKey =
  | ProviderDetailKey
  | {
      readonly kind: "about";
      readonly titleKind: TitleKind;
      readonly id: string;
      readonly language: string;
    }
  | {
      readonly kind: "season";
      readonly id: string;
      readonly number: number;
      readonly language: string;
    };

export type DetailRecord =
  | {
      readonly kind: "provider";
      readonly at: number;
      readonly catalogueStamp: string;
      readonly value: ProviderDetails;
    }
  | { readonly kind: "about"; readonly at: number; readonly value: TitleAbout | null }
  | {
      readonly kind: "season";
      readonly at: number;
      readonly value: readonly EpisodeAbout[] | null;
    };

// Declare stripping on each object to avoid rebuilding the full schema on first use.
const Person = lazy(() =>
  type({ "+": "delete", name: "string", character: "string | null", profile: "string | null" }),
);
const About = lazy(() =>
  type({
    "+": "delete",
    original: "string | null",
    language: "string | null",
    overview: "string | null",
    poster: "string | null",
    backdrop: "string | null",
    genres: "number[]",
    runtime: "number | null",
    cast: Person().array(),
    directors: "string[]",
  }),
);
const Episode = lazy(() =>
  type({
    "+": "delete",
    number: "number",
    name: "string | null",
    overview: "string | null",
    still: "string | null",
    airDate: "string | null",
    runtime: "number | null",
    rating: "number | null",
    cast: Person().array(),
    directors: "string[]",
  }),
);
const Provider = lazy(() =>
  type({
    "+": "delete",
    originalName: "string | null",
    plot: "string | null",
    genres: "string[]",
    cast: "string[]",
    directors: "string[]",
    releaseDate: "string | null",
    duration: "number | null",
    posterUrl: "string | null",
    backdropUrl: "string | null",
    seasons: type({
      "+": "delete",
      number: "number",
      name: "string | null",
      posterUrl: "string | null",
    }).array(),
    episodes: type({
      "+": "delete",
      id: "string",
      season: "number",
      number: "number",
      name: "string",
      plot: "string | null",
      duration: "number | null",
      stillUrl: "string | null",
      airDate: "string | null",
      addedAt: "number | null",
      container: "string",
    }).array(),
    "episodeOrder?": "'source'",
    container: "string | null",
  }),
);
// Each namespace initializes only the schema needed for the requested record.
const Records = {
  provider: lazy(() =>
    type({
      "+": "delete",
      schema: "1",
      kind: "'provider'",
      at: "number",
      catalogueStamp: "string",
      value: Provider(),
    }),
  ),
  about: lazy(() =>
    type({ "+": "delete", schema: "1", kind: "'about'", at: "number", value: About().or("null") }),
  ),
  season: lazy(() =>
    type({
      "+": "delete",
      schema: "1",
      kind: "'season'",
      at: "number",
      value: Episode().array().or("null"),
    }),
  ),
};

/** Also prepared by viewing erasure when the rest of the runtime has not opened the cache. */
export function prepareDetailCache(db: DatabaseSync): void {
  db.exec(`create table if not exists ${DETAIL_CACHE_TABLE} (
    key text primary key,
    account text not null,
    owner text not null,
    used_at integer not null,
    bytes integer not null,
    payload text not null
  ); create index if not exists title_detail_cache_used on ${DETAIL_CACHE_TABLE}(used_at)`);
}

export class DetailCache extends Context.Service<
  DetailCache,
  {
    /** Unknown/corrupt records and storage failures are cache misses. */
    read(key: DetailKey): Effect.Effect<DetailRecord | null>;
    /** A failed or oversized write leaves normal fetching available. */
    remember(key: DetailKey, record: DetailRecord): Effect.Effect<void>;
    forget(subscriptionId: string): Effect.Effect<void>;
  }
>()("mrstreamer/DetailCache") {}

export const detailCacheLayer = Layer.effect(
  DetailCache,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return emptyCache;
    return yield* attempt(() => make(opened.db)).pipe(
      Effect.catch(() => Effect.succeed(emptyCache)),
    );
  }),
);

function make(db: DatabaseSync): DetailCache["Service"] {
  prepareDetailCache(db);
  const read = db.prepare(`select payload from ${DETAIL_CACHE_TABLE} where key = ?`);
  const touch = db.prepare(`update ${DETAIL_CACHE_TABLE} set used_at = ? where key = ?`);
  const write = db.prepare(`insert into ${DETAIL_CACHE_TABLE}
    (key, account, owner, used_at, bytes, payload) values (?, ?, ?, ?, ?, ?)
    on conflict(key) do update set used_at = excluded.used_at,
      bytes = excluded.bytes, payload = excluded.payload`);
  const remove = db.prepare(`delete from ${DETAIL_CACHE_TABLE} where key = ?`);
  const forget = db.prepare(`delete from ${DETAIL_CACHE_TABLE} where owner = ?`);
  const bytes = db.prepare(
    `select coalesce(sum(bytes), 0) as bytes, count(*) as count from ${DETAIL_CACHE_TABLE}`,
  );
  const size = db.prepare(`select bytes from ${DETAIL_CACHE_TABLE} where key = ?`);
  const oldest = db.prepare(
    `select key, bytes from ${DETAIL_CACHE_TABLE} where key != ? order by used_at limit ?`,
  );
  return {
    read: (key) =>
      attempt(() => {
        const id = keyOf(key);
        const row = read.get(id);
        const discard = () => {
          try {
            remove.run(id);
          } catch {}
          return null;
        };
        if (
          !row ||
          typeof row.payload !== "string" ||
          Buffer.byteLength(row.payload) > RECORD_BYTES
        )
          return row ? discard() : null;
        let payload: unknown;
        try {
          payload = JSON.parse(row.payload);
        } catch {
          return discard();
        }
        const record = Records[key.kind]()(payload);
        if (record instanceof type.errors || record.kind !== key.kind) return discard();
        // A read-only disk must still be able to supply its last good cached details.
        try {
          touch.run(Date.now(), id);
        } catch {}
        return record;
      }).pipe(Effect.orElseSucceed(() => null)),
    remember: (key, record) =>
      attempt(() => {
        if (record.kind !== key.kind) return;
        // Validate and remove undeclared fields at every depth. Only parsed display data reaches disk.
        const parsed = Records[key.kind]()({ schema: 1, ...record });
        if (parsed instanceof type.errors) return;
        const payload = JSON.stringify(parsed);
        const needed = Buffer.byteLength(payload);
        if (needed > RECORD_BYTES) return;
        const id = keyOf(key);
        transaction(db, () => {
          const existing = size.get(id);
          const usage = bytes.get();
          let total = Number(usage?.bytes ?? 0) - Number(existing?.bytes ?? 0) + needed;
          let count = Number(usage?.count ?? 0) + (existing ? 0 : 1);
          const evict: string[] = [];
          if (total > PAYLOAD_BYTES || count > RECORDS) {
            for (const row of oldest.all(id, PRUNE_BATCH)) {
              evict.push(String(row.key));
              total -= Number(row.bytes);
              count--;
              if (total <= PAYLOAD_BYTES && count <= RECORDS) break;
            }
          }
          // Every bounded pass frees space, even when this write still cannot fit.
          for (const old of evict) remove.run(old);
          if (total > PAYLOAD_BYTES || count > RECORDS) return;
          write.run(
            id,
            key.kind === "provider" ? key.account : "",
            key.kind === "provider" ? key.subscriptionId : "",
            Date.now(),
            needed,
            payload,
          );
        });
      }).pipe(Effect.ignore),
    forget: (subscriptionId) =>
      attempt(() => {
        forget.run(subscriptionId);
      }).pipe(Effect.ignore),
  };
}

function keyOf(key: DetailKey): string {
  switch (key.kind) {
    case "provider":
      return JSON.stringify([
        key.kind,
        key.account,
        key.subscriptionId,
        key.sourceStamp,
        key.importRevision ?? null,
        key.titleKind,
        key.id,
      ]);
    case "about":
      return JSON.stringify([key.kind, key.titleKind, key.id, key.language]);
    case "season":
      return JSON.stringify([key.kind, key.id, key.number, key.language]);
  }
}

const emptyCache: DetailCache["Service"] = {
  read: () => Effect.succeed(null),
  remember: () => Effect.void,
  forget: () => Effect.void,
};
