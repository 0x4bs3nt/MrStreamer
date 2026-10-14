// Keeps each subscription's programme guide on disk, in its folder.
//
// A guide is an index of its programmes (guide-index.<id>.sqlite, written by
// @mrstreamer/core/guide/index-file), named by one small record: the own guide's, the
// provider's or the one its playlist names, by guide.json with the account and time it belongs
// to; an XMLTV address of the viewer's own by guide-source.json, sealed, with the channels mapped
// by hand. A switch is one write of that small file: cut short, it leaves the one before whole.
// The service decides when a file goes (core/guide/files.ts); its sweep, at the first start of a
// guide each run, takes the indexes and downloads (guide-download.<id>.part) it doesn't know.
//
// Releases before 0.0.13 kept the documents themselves: guide.xml, named by a guide.json without
// an index, and guide-external.<id>.xml, named by guide-source.json. They are read as such and
// indexed once by the service, which then drops them. Those releases read guide.json as theirs,
// and find no guide.xml beside it once it was indexed, so they download the own guide again; one
// guide-source.json naming an index they don't read, which they leave as it is.
import { randomUUID } from "node:crypto";
import { access, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { failedWith } from "@mrstreamer/core/failure";
import { GuideStore, type GuideConfig, type GuideDocument } from "@mrstreamer/core/guide/service";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { readJsonFile, removeFile } from "./json-file.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** An index's name. */
const INDEX = new RegExp(`^guide-index\\.${ID}\\.sqlite$`);
/** An external guide's document as releases before 0.0.13 kept it. */
const EXTERNAL_XMLTV = new RegExp(`^guide-external\\.${ID}\\.xml$`);
/** The own guide's document as releases before 0.0.13 kept it. */
const OWN_XMLTV = "guide.xml";
/** What work cut short leaves behind: a download, or an index half written. */
const LEFT_OVER = new RegExp(`^guide-(download\\.${ID}\\.part|index\\.${ID}\\.sqlite\\.part)$`);

const GuideMeta = type({ key: "string", fetchedAt: "number", "index?": INDEX });

/** Why a guide's download failed, of the kinds a download ends with. */
const DownloadError = type({ kind: "'unreachable'", server: "string", detail: "string" })
  .or({ kind: "'provider-error'", status: "number" })
  .or({ kind: "'unexpected'", detail: "string" })
  .or({
    kind: "'guide'",
    failure: type({ kind: "'not-xmltv' | 'incomplete' | 'empty' | 'ended'" })
      .or({ kind: "'redirect'", reason: "'unencrypted' | 'too-many'" })
      .or({ kind: "'too-large'", limit: "'bytes' | 'element' | 'channels'" }),
  });
const DownloadFailure = type({ at: "number", error: DownloadError });

// guide-source.json. A later release adds fields rather than another version, as for the other
// files: this one keeps a sealed address, which a file it can't read would lose.
const GuideSourceFile = type({
  version: "1",
  /** Which account this was set for. */
  key: "string",
  external: type({
    origin: "string",
    identity: "string",
    sealedAddress: "string",
    since: "number",
    document: { file: type(INDEX).or(EXTERNAL_XMLTV), fetchedAt: "number" },
    /** Read on its own: one this release can't read costs the address nothing. */
    "failure?": "unknown",
  }).or("null"),
  mappings: { "[string]": { guideId: "string", name: "string" } },
});

const metaPath = (store: string) => join(store, "guide.json");
const sourcePath = (store: string) => join(store, "guide-source.json");

/** A document as the service reads it, by its file's name. */
const documentOf = (file: string, fetchedAt: number): GuideDocument => ({
  file,
  fetchedAt,
  kind: INDEX.test(file) ? "index" : "xmltv",
});

/**
 * Writes `text` to `path` whole or not at all, in a folder that is there: unlike `writeJsonFile`
 * it makes none, so nothing is written for a subscription whose folder went with it.
 */
async function replaceFile(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text);
    await rename(temp, path);
  } catch (cause) {
    await rm(temp, { force: true });
    throw cause;
  }
}

/** The files of a folder that are a guide's indexes, downloads or older documents, by name. */
async function guideFilesIn(store: string): Promise<string[]> {
  const names = await readdir(store).catch(() => []);
  return names.filter(
    (name) => INDEX.test(name) || EXTERNAL_XMLTV.test(name) || LEFT_OVER.test(name),
  );
}

/** The guide store: a subscription's `store` is the folder its guide is kept in. */
export const guideStoreLayer: Layer.Layer<GuideStore> = Layer.succeed(GuideStore, {
  own: ({ store, key }) =>
    Effect.promise(async () => {
      const meta = await readJsonFile(metaPath(store), GuideMeta);
      if (meta?.key !== key) return null;
      if (meta.index) return documentOf(meta.index, meta.fetchedAt);
      // What a release before kept, while it is still there.
      const kept = await access(join(store, OWN_XMLTV)).then(
        () => true,
        () => false,
      );
      return kept ? documentOf(OWN_XMLTV, meta.fetchedAt) : null;
    }),
  setOwn: ({ store, key }, document) =>
    Effect.tryPromise({
      try: async () => {
        if (!document) return removeFile(metaPath(store));
        const index = document.kind === "index" ? { index: document.file } : {};
        const meta: typeof GuideMeta.infer = { key, fetchedAt: document.fetchedAt, ...index };
        await replaceFile(metaPath(store), JSON.stringify(meta));
      },
      catch: failedWith,
    }),
  config: ({ store, key }) =>
    Effect.promise(async (): Promise<GuideConfig | null> => {
      const file = await readJsonFile(sourcePath(store), GuideSourceFile);
      // Another account's, as after an older release connected one in this folder.
      if (file?.key !== key) return null;
      const { external, mappings } = file;
      if (!external) return { external: null, mappings };
      const failure = DownloadFailure(external.failure);
      return {
        external: {
          ...external,
          document: documentOf(external.document.file, external.document.fetchedAt),
          failure: failure instanceof type.errors ? null : failure,
        },
        mappings,
      };
    }),
  setConfig: ({ store, key }, config) =>
    Effect.tryPromise({
      try: async () => {
        const nothing = config.external === null && Object.keys(config.mappings).length === 0;
        if (nothing) return removeFile(sourcePath(store));
        const external = config.external && {
          ...config.external,
          document: {
            file: config.external.document.file,
            fetchedAt: config.external.document.fetchedAt,
          },
        };
        const file: typeof GuideSourceFile.infer = {
          version: 1,
          key,
          external,
          mappings: config.mappings,
        };
        await replaceFile(sourcePath(store), JSON.stringify(file));
      },
      catch: failedWith,
    }),
  download: ({ store }, name) =>
    Effect.tryPromise({
      try: async () => {
        const path = join(store, name);
        // Fails where the folder went: nothing is kept for a subscription that did.
        const file = await open(path, "wx");
        let closed = false;
        const close = async () => {
          if (closed) return;
          closed = true;
          await file.close();
        };
        return {
          file: name,
          write: async (bytes: Uint8Array) => {
            await file.write(bytes);
          },
          close,
          discard: async () => {
            await close().catch(() => {});
            await rm(path, { force: true });
          },
        };
      },
      catch: failedWith,
    }),
  newDownload: () => `guide-download.${randomUUID()}.part`,
  newIndex: () => `guide-index.${randomUUID()}.sqlite`,
  path: ({ store }, file) => join(store, file),
  discard: ({ store }, file) =>
    Effect.promise(() =>
      removeFile(join(store, file)).catch((cause: unknown) =>
        console.warn("[guide] a file left for the next sweep", cause),
      ),
    ),
  sweep: ({ store }, known) =>
    Effect.promise(async () => {
      for (const name of await guideFilesIn(store)) {
        // Asked just before it goes: work that began meanwhile claims its files first.
        if (known(name)) continue;
        await removeFile(join(store, name)).catch((cause: unknown) =>
          console.warn("[guide] a file left for the next sweep", cause),
        );
      }
    }),
  erase: ({ store }) =>
    Effect.promise(async () => {
      await Promise.all(
        ["guide.json", OWN_XMLTV, "guide-source.json", ...(await guideFilesIn(store))].map((name) =>
          removeFile(join(store, name)),
        ),
      );
    }),
});
