// Downloaded cues and timing belong to an exact listed file, never a movie name or TMDB id.
//
// Each result also notes which bytes it was saved for, when the playback that saved it could prove
// them (`FileProof`): a downloaded copy takes a result along only for the very bytes it holds
// (`duplicate`). The proof is written with the result, in one transaction, by whatever writes its
// cues or timing; a write without proof leaves it with none, so no earlier file's proof stays on
// cues chosen or timed for bytes nobody proved.
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_SUBTITLE_TIMING,
  SavedSubtitle,
  type DownloadedSubtitle,
  type SubtitleTiming,
} from "@mrstreamer/contracts/online-subtitles";
import type { Failed } from "@mrstreamer/core/failure";
import { type } from "arktype";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { attempt, Database, transaction, unavailable } from "./database.ts";
import type { FileProof } from "../playback/source-identity.ts";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

/** Main-only identity resolved from the current playback session and provider catalogue. */
export interface SubtitleFile {
  readonly account: string;
  readonly sourceStamp: string;
  readonly listingKey: string;
  readonly kind: "movie" | "episode";
  readonly id: string;
}

/**
 * A downloaded copy's own identity for saved subtitles: what was saved for the provider's file it
 * was made from is carried over to it (`duplicate`), and from then on it outlasts that account's
 * login, expiry and erasure, until the copy is deleted.
 */
export function subtitlesOfCopy(
  copyId: string,
  title: { readonly kind: "movie" | "episode"; readonly id: string },
): SubtitleFile {
  return {
    account: `copy:${copyId}`,
    sourceStamp: "copy",
    listingKey: copyId,
    kind: title.kind,
    id: title.id,
  };
}

const Stored = lazy(() => SavedSubtitle().merge({ "resultKey?": "string <= 64" }));
type Stored = Infer<typeof Stored>;
export const SAVED_SUBTITLES_TABLE = "saved_subtitles";
export const SUBTITLE_RESULTS_TABLE = "saved_subtitle_results";
/** Which bytes each result was saved for, by `FileProof`; a copy takes it only for those. */
export const SUBTITLE_PROOFS_TABLE = "saved_subtitle_proofs";
/** The proof key of a selected row without a result key, as a file track's timing. */
const NO_RESULT = "";

const Proof = lazy(() =>
  type({
    size: "number.integer >= 0",
    marks: type({ resource: "string", mark: "string" }).array(),
  }),
);

/** Also prepared by account erasure when no playback service has run. */
export function prepareSavedSubtitles(db: DatabaseSync): void {
  db.exec(`create table if not exists saved_subtitles (
    account text not null,
    kind text not null,
    id text not null,
    source_stamp text not null,
    listing_key text not null,
    saved text not null,
    primary key (account, kind, id)
  )`);
  db.exec(`create table if not exists saved_subtitle_results (
    account text not null, kind text not null, id text not null,
    source_stamp text not null, listing_key text not null, result_key text not null,
    saved text not null, primary key (account, kind, id, source_stamp, listing_key, result_key)
  )`);
  db.exec(`create table if not exists saved_subtitle_proofs (
    account text not null, kind text not null, id text not null,
    source_stamp text not null, listing_key text not null, result_key text not null,
    proof text not null, primary key (account, kind, id, source_stamp, listing_key, result_key)
  )`);
}

export class SavedSubtitles extends Context.Service<
  SavedSubtitles,
  {
    read(file: SubtitleFile): Effect.Effect<SavedSubtitle | null, Failed>;
    result(file: SubtitleFile, key: string): Effect.Effect<SavedSubtitle | null, Failed>;
    /**
     * Makes `subtitle` the file's selected result, saved for the bytes `proof` says playback
     * read; without a proof, for none.
     */
    remember(
      file: SubtitleFile,
      subtitle: DownloadedSubtitle,
      key?: string,
      timing?: SubtitleTiming,
      proof?: FileProof | null,
    ): Effect.Effect<void, Failed>;
    /** Times the selected result, or a file track, for the bytes `proof` says; or for none. */
    timing(
      file: SubtitleFile,
      timing: SubtitleTiming,
      selection?: string,
      proof?: FileProof | null,
    ): Effect.Effect<void, Failed>;
    /**
     * Makes a saved result the file's selected and shown one: the selected row when `selection`
     * names it, else the cached result of that key with its own timing. Fails when neither holds it.
     */
    show(file: SubtitleFile, selection?: string): Effect.Effect<void, Failed>;
    /** Keeps the selected result, its key and timing, but not shown when the file opens again. */
    hide(file: SubtitleFile): Effect.Effect<void, Failed>;
    /** Forgets a removed file or one playback has observed being replaced. */
    forget(file: SubtitleFile): Effect.Effect<void, Failed>;
    /**
     * Keeps for `to`, a downloaded copy, what is saved for `from`, the provider's file it was
     * made from: its selected result, whether it shows, its timing and the cached results, in
     * place of whatever `to` had. Each only when `read`, what the download's own answers said of
     * its bytes, is of the bytes that result was saved for: the same size and, from one same
     * address, the same strong mark. Answers whether anything was kept.
     */
    duplicate(
      from: SubtitleFile,
      to: SubtitleFile,
      read: { readonly resource: string; readonly mark: string; readonly size: number },
    ): Effect.Effect<boolean, Failed>;
  }
>()("mrstreamer/SavedSubtitles") {}

export const savedSubtitlesLayer = Layer.effect(
  SavedSubtitles,
  Effect.gen(function* () {
    const opened = yield* Database;
    if ("failure" in opened) return closed(opened.failure);
    return yield* attempt(() => {
      const { db } = opened;
      prepareSavedSubtitles(db);
      const select = db.prepare(`select saved from saved_subtitles
        where account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`);
      const write = db.prepare(`insert into saved_subtitles
        (account, kind, id, source_stamp, listing_key, saved) values (?, ?, ?, ?, ?, ?)
        on conflict (account, kind, id) do update set source_stamp = excluded.source_stamp,
        listing_key = excluded.listing_key, saved = excluded.saved`);
      const remove = db.prepare(`delete from saved_subtitles
        where account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?`);
      const cached = db.prepare(`select saved from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);
      const rememberResult = db.prepare(`insert into saved_subtitle_results
        (account, kind, id, source_stamp, listing_key, result_key, saved) values (?, ?, ?, ?, ?, ?, ?)
        on conflict (account, kind, id, source_stamp, listing_key, result_key)
        do update set saved = excluded.saved`);
      const pruneResults = db.prepare(`delete from saved_subtitle_results where rowid in (
        select rowid from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ?
        order by rowid desc limit -1 offset 8)`);
      const touchResult = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);
      const removeResults = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and (
          (source_stamp = ? and listing_key = ?) or not exists (
            select 1 from saved_subtitles where account = ? and kind = ? and id = ?
          )
        )`);
      const selectProof = db.prepare(`select proof from saved_subtitle_proofs where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);
      const writeProof = db.prepare(`insert into saved_subtitle_proofs
        (account, kind, id, source_stamp, listing_key, result_key, proof) values (?, ?, ?, ?, ?, ?, ?)
        on conflict (account, kind, id, source_stamp, listing_key, result_key)
        do update set proof = excluded.proof`);
      const removeProof = db.prepare(`delete from saved_subtitle_proofs where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? and result_key = ?`);
      const removeProofs = db.prepare(
        `delete from saved_subtitle_proofs where account = ? and kind = ? and id = ?`,
      );
      const removeObsoleteProofs = db.prepare(`delete from saved_subtitle_proofs where
        account = ? and kind = ? and id = ? and (source_stamp != ? or listing_key != ?)`);
      const proofOf = (file: SubtitleFile, key: string) => {
        const row = selectProof.get(...identity(file), key);
        if (!row) return null;
        try {
          const parsed = Proof()(JSON.parse(String(row.proof)));
          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };
      const selectResults = db.prepare(`select result_key, saved from saved_subtitle_results where
        account = ? and kind = ? and id = ? and source_stamp = ? and listing_key = ? order by rowid`);
      const removeAll = db.prepare(
        `delete from saved_subtitles where account = ? and kind = ? and id = ?`,
      );
      const removeAllResults = db.prepare(
        `delete from saved_subtitle_results where account = ? and kind = ? and id = ?`,
      );
      const removeObsoleteResults = db.prepare(`delete from saved_subtitle_results where
        account = ? and kind = ? and id = ? and (source_stamp != ? or listing_key != ?)`);
      const identity = (file: SubtitleFile) =>
        [file.account, file.kind, file.id, file.sourceStamp, file.listingKey] as const;
      const read = (file: SubtitleFile): Stored | null => {
        const row = select.get(...identity(file));
        if (!row) return null;
        try {
          const parsed = Stored()(JSON.parse(String(row.saved)));
          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };
      /** A result as the cache keeps it: cues, timing and key. Whether it shows is the selection's. */
      const result = (saved: Stored): SavedSubtitle => ({
        timing: saved.timing,
        subtitle: saved.subtitle,
        ...(saved.resultKey ? { selection: saved.resultKey } : {}),
      });
      const visible = (saved: Stored | null): SavedSubtitle | null =>
        saved ? { ...result(saved), ...(saved.shown === false ? { shown: false } : {}) } : null;
      const cachedResult = (file: SubtitleFile, key: string): SavedSubtitle | null => {
        const row = cached.get(...identity(file), key);
        if (!row) return null;
        try {
          const parsed = SavedSubtitle()(JSON.parse(String(row.saved)));
          return parsed instanceof type.errors ? null : parsed;
        } catch {
          return null;
        }
      };
      /**
       * Saves the file's selected row. `proved` says which bytes its cues and timing are of now,
       * by its result key; without it, what is proven of it stays as it was.
       */
      const save = (
        file: SubtitleFile,
        saved: Stored,
        proved?: { readonly proof: FileProof | null },
      ) => {
        const checked = Stored().assert(saved);
        const proof = proved?.proof ? JSON.stringify(Proof().assert(proved.proof)) : null;
        const key = checked.resultKey ?? NO_RESULT;
        transaction(db, () => {
          removeObsoleteResults.run(...identity(file));
          removeObsoleteProofs.run(...identity(file));
          if (proved) {
            removeProof.run(...identity(file), key);
            if (proof !== null) writeProof.run(...identity(file), key, proof);
          }
          write.run(...identity(file), JSON.stringify(checked));
          if (checked.resultKey) {
            touchResult.run(...identity(file), checked.resultKey);
            rememberResult.run(
              ...identity(file),
              checked.resultKey,
              JSON.stringify(result(checked)),
            );
            pruneResults.run(...identity(file));
          }
        });
      };
      return {
        read: (file: SubtitleFile) => attempt(() => visible(read(file))),
        result: (file: SubtitleFile, key: string) => attempt(() => cachedResult(file, key)),
        remember: (
          file: SubtitleFile,
          subtitle: DownloadedSubtitle,
          key?: string,
          timing?: SubtitleTiming,
          proof: FileProof | null = null,
        ) =>
          attempt(() => {
            const previous = read(file);
            save(
              file,
              {
                timing:
                  timing ??
                  ((key === undefined && previous?.subtitle === null) ||
                  (key !== undefined && key === previous?.resultKey)
                    ? previous.timing
                    : DEFAULT_SUBTITLE_TIMING),
                subtitle,
                ...(key ? { resultKey: key } : {}),
              },
              { proof },
            );
          }),
        timing: (
          file: SubtitleFile,
          timing: SubtitleTiming,
          selection?: string,
          proof: FileProof | null = null,
        ) =>
          attempt(() => {
            const previous = read(file);
            if (selection !== undefined && previous?.resultKey !== selection)
              throw new Error("The selected subtitle changed before its timing was saved.");
            save(file, { ...previous, timing, subtitle: previous?.subtitle ?? null }, { proof });
          }),
        show: (file: SubtitleFile, selection?: string) =>
          attempt(() => {
            const previous = read(file);
            if (previous?.subtitle && previous.resultKey === selection) {
              // Only `false` is stored: a row without the mark shows.
              const { shown, ...row } = previous;
              if (shown === false) save(file, row);
              return;
            }
            const held = selection ? cachedResult(file, selection) : null;
            if (!selection || !held?.subtitle)
              throw new Error("That subtitle is no longer saved for this file.");
            save(file, { timing: held.timing, subtitle: held.subtitle, resultKey: selection });
          }),
        hide: (file: SubtitleFile) =>
          attempt(() => {
            const previous = read(file);
            if (previous?.subtitle && previous.shown !== false)
              save(file, { ...previous, shown: false });
          }),
        duplicate: (
          from: SubtitleFile,
          to: SubtitleFile,
          bytes: { readonly resource: string; readonly mark: string; readonly size: number },
        ) =>
          attempt(() => {
            /** Whether the result of `key` was saved for the very bytes the copy holds. */
            const proven = (key: string) => {
              const proof = proofOf(from, key);
              return (
                proof !== null &&
                proof.size === bytes.size &&
                proof.marks.some(
                  (each) => each.resource === bytes.resource && each.mark === bytes.mark,
                )
              );
            };
            const row = select.get(...identity(from));
            const selected =
              row && proven(read(from)?.resultKey ?? NO_RESULT) ? String(row.saved) : null;
            const results = selectResults
              .all(...identity(from))
              .filter((each) => proven(String(each.result_key)));
            transaction(db, () => {
              removeAll.run(to.account, to.kind, to.id);
              removeAllResults.run(to.account, to.kind, to.id);
              if (selected !== null) write.run(...identity(to), selected);
              for (const each of results) {
                rememberResult.run(...identity(to), String(each.result_key), String(each.saved));
              }
            });
            return selected !== null || results.length > 0;
          }),
        forget: (file: SubtitleFile) =>
          attempt(() => {
            transaction(db, () => {
              remove.run(...identity(file));
              // With no replacement selected, Forget also clears caches from older identities.
              removeResults.run(...identity(file), file.account, file.kind, file.id);
              removeProofs.run(file.account, file.kind, file.id);
            });
          }),
      };
    }).pipe(Effect.catch(() => Effect.succeed(closed("Saved subtitles can't be opened."))));
  }),
);

function closed(detail: string): SavedSubtitles["Service"] {
  const fail = unavailable(detail);
  return {
    read: () => fail,
    result: () => fail,
    remember: () => fail,
    timing: () => fail,
    show: () => fail,
    hide: () => fail,
    forget: () => fail,
    duplicate: () => fail,
  };
}
