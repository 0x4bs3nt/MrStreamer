// Last-read track languages, per exact provider file. Listing hints never enter this store.
// Addresses, headers and secrets stay with playback; random session ids guard invalidation.
import type { DatabaseSync } from "node:sqlite";
import type { TitleRef } from "@mrstreamer/contracts/ondemand";
import type { Failed } from "@mrstreamer/core/failure";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, unavailable } from "./database.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

export const VERIFIED_FILES_TABLE = "verified_files";

/** Also made by the viewing store so account erasure works when that store runs alone. */
export function prepareVerifiedFiles(db: DatabaseSync): void {
  db.exec(`create table if not exists verified_files (
    account text not null,
    kind text not null,
    id text not null,
    source_stamp text not null,
    facts text not null,
    primary key (account, kind, id)
  )`);
}

const Facts = lazy(() =>
  type({
    kind: "'movie' | 'episode'",
    id: "string",
    "seriesId?": "string",
    fileKey: "string",
    listingKey: "string",
    audio: "(string | null)[]",
    subtitles: "(string | null)[]",
  }),
);

/** Tracks from one successful playback probe, never combined with another version's tracks. */
export type VerifiedFile = Infer<typeof Facts>;

export class VerifiedFiles extends Context.Service<
  VerifiedFiles,
  {
    readonly read: (
      account: string,
      sourceStamp: string,
    ) => Effect.Effect<readonly VerifiedFile[], Failed>;
    readonly remember: (
      account: string,
      sourceStamp: string,
      facts: VerifiedFile,
    ) => Effect.Effect<void, Failed>;
    /** An old session cannot invalidate a newer file's facts. */
    readonly forget: (
      account: string,
      title: TitleRef,
      fileKey: string,
    ) => Effect.Effect<void, Failed>;
  }
>()("mrstreamer/VerifiedFiles") {}

export const verifiedFilesLayer = Layer.effect(
  VerifiedFiles,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(opened.failure);
    return yield* attempt(() => {
      const { db } = opened;
      prepareVerifiedFiles(db);
      const read = db.prepare(
        "select facts from verified_files where account = ? and source_stamp = ?",
      );
      const write = db.prepare(`insert into verified_files (account, kind, id, source_stamp, facts)
        values (?, ?, ?, ?, ?) on conflict (account, kind, id) do update set
        source_stamp = excluded.source_stamp, facts = excluded.facts`);
      const remove = db.prepare(
        "delete from verified_files where account = ? and kind = ? and id = ? and json_extract(facts, '$.fileKey') = ?",
      );
      return {
        read: (account: string, sourceStamp: string) =>
          attempt(() =>
            read.all(account, sourceStamp).flatMap((row) => {
              try {
                const facts = Facts()(JSON.parse(String(row.facts)));
                return facts instanceof type.errors ? [] : [facts];
              } catch {
                return [];
              }
            }),
          ),
        remember: (account: string, sourceStamp: string, facts: VerifiedFile) =>
          attempt(() => {
            write.run(
              account,
              facts.kind,
              facts.id,
              sourceStamp,
              JSON.stringify(Facts().assert(facts)),
            );
          }),
        forget: (account: string, title: TitleRef, fileKey: string) =>
          attempt(() => {
            remove.run(account, title.kind, title.id, fileKey);
          }),
      };
    }).pipe(Effect.catch(() => Effect.succeed(closed("The file track record can't be opened."))));
  }),
);

function closed(detail: string): VerifiedFiles["Service"] {
  const fail = unavailable(detail);
  return { read: () => fail, remember: () => fail, forget: () => fail };
}
