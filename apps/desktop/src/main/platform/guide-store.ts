// Keeps the programme guides on disk: each subscription's own in its folder, and the global
// XMLTV sources the viewer adds in Settings > Guides in a folder of their own.
//
// A guide is an index of its programmes (guide-index.<id>.sqlite, written by
// @mrstreamer/core/guide/index-file), named by one small record: a subscription's own guide,
// its provider's or the one its playlist names, by guide.json with the account and time it
// belongs to, and the channels it mapped by hand by guide-source.json; the sources, in their
// order, each with its address sealed, by sources.json in theirs. A switch is one write of that
// small file: cut short, it leaves the one before whole. The service decides when a file goes
// (core/guide/files.ts); its sweep, once a run has read every record, takes the indexes and
// downloads (guide-download.<id>.part) it doesn't know.
//
// Releases before 0.0.13 kept the documents themselves: guide.xml, named by a guide.json without
// an index, and guide-external.<id>.xml, named by guide-source.json, which then held an XMLTV
// address of the viewer's own in place of the subscription's guide. They are read as such: the
// service copies such an address's file to the sources and names it there, and the address here
// names that source; the address and its file stay until the source's first download after.
// Those releases read guide.json as theirs, and find no guide.xml beside it once it was indexed,
// so they download the own guide again; a guide-source.json with an address gives them that
// address back, and one without their own guide, with the mappings they find in it.
//
// A record that is there but can't be read fails to read, rather than read as none: what it names
// must not be swept away as if nothing did.
import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { failedWith } from "@mrstreamer/core/failure";
import {
  GuideStore,
  type Copied,
  type GuideDocument,
  type StoredConfig,
  type StoredSource,
} from "@mrstreamer/core/guide/service";
import { type } from "arktype";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { removeFile } from "./json-file.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** An index's name. */
const INDEX = new RegExp(`^guide-index\\.${ID}\\.sqlite$`);
/** An external guide's document as releases before 0.0.13 kept it. */
const EXTERNAL_XMLTV = new RegExp(`^guide-external\\.${ID}\\.xml$`);
/** The own guide's document as releases before 0.0.13 kept it. */
const OWN_XMLTV = "guide.xml";
/** What work cut short leaves behind: a download, or an index or a copy half written. */
const LEFT_OVER = new RegExp(
  `^guide-(download\\.${ID}\\.part|index\\.${ID}\\.sqlite\\.part|external\\.${ID}\\.xml\\.part)$`,
);

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

/** A document as a record keeps it: the file, and when it was downloaded. */
const KeptDocument = type({ file: type(INDEX).or(EXTERNAL_XMLTV), fetchedAt: "number" });

// guide-source.json. A later release adds fields rather than another version, as for the other
// files: one kept a sealed address, which a file it can't read would lose. This release keeps an
// address here only until it is safely among the sources, and the mappings, each naming its guide;
// one without was made by a release before, against the guide in use then.
const GuideSourceFile = type({
  version: "1",
  /** Which account this was set for. */
  key: "string",
  external: type({
    origin: "string",
    identity: "string",
    sealedAddress: "string",
    "since?": "number",
    document: KeptDocument,
    /** Read on its own: one this release can't read costs the address nothing. */
    "failure?": "unknown",
    /** The source it moved to: it stays here until that source's first download after. */
    "source?": "string",
  }).or("null"),
  mappings: { "[string]": { guideId: "string", name: "string", "source?": "string" } },
});

// sources.json, in the sources' folder: the global sources in their order.
const SourcesFile = type({
  version: "1",
  sources: type({
    id: "string",
    origin: "string",
    identity: "string",
    sealedAddress: "string",
    document: KeptDocument.or("null"),
    "failure?": "unknown",
    /** The download a release before kept that it was copied from, until one of its own. */
    "movedFrom?": { file: "string", fetchedAt: "number", bytes: "number" },
  }).array(),
});

const metaPath = (store: string) => join(store, "guide.json");
const sourcePath = (store: string) => join(store, "guide-source.json");
const sourcesPath = (store: string) => join(store, "sources.json");

/** A failure as a record keeps it, or null for one this release can't read. */
const failureOf = (kept: unknown) => {
  const failure = DownloadFailure(kept);
  return failure instanceof type.errors ? null : failure;
};

/** A document as the service reads it, by its file's name. */
const documentOf = (file: string, fetchedAt: number): GuideDocument => ({
  file,
  fetchedAt,
  kind: INDEX.test(file) ? "index" : "xmltv",
});

/**
 * Reads a record of the guide's: null where there is none, and a failure where one is there but
 * can't be read or isn't one, as after a disk error or a write of another program.
 */
async function readRecord<T>(
  path: string,
  schema: (data: unknown) => T | type.errors,
): Promise<T | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (isMissing(cause)) return null;
    throw cause;
  }
  const parsed = schema(JSON.parse(text));
  if (parsed instanceof type.errors) throw new Error(`${path}: ${parsed.summary}`);
  return parsed;
}

/** Whether `path` is there: false only where the system says it isn't, a failure otherwise. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

const isMissing = (cause: unknown) =>
  cause instanceof Error && "code" in cause && cause.code === "ENOENT";

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
    Effect.tryPromise({
      try: async () => {
        const meta = await readRecord(metaPath(store), GuideMeta);
        if (meta?.key !== key) return null;
        if (meta.index) return documentOf(meta.index, meta.fetchedAt);
        // What a release before kept, while it is still there.
        const kept = await exists(join(store, OWN_XMLTV));
        return kept ? documentOf(OWN_XMLTV, meta.fetchedAt) : null;
      },
      catch: failedWith,
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
    Effect.tryPromise({
      try: async (): Promise<StoredConfig | null> => {
        const file = await readRecord(sourcePath(store), GuideSourceFile);
        // Another account's, as after an older release connected one in this folder.
        if (file?.key !== key) return null;
        const mappings = Object.fromEntries(
          Object.entries(file.mappings).map(([channelId, { guideId, name, source }]) => [
            channelId,
            { guideId, name, source: source ?? null },
          ]),
        );
        const { external } = file;
        return {
          external: external && {
            origin: external.origin,
            identity: external.identity,
            sealedAddress: external.sealedAddress,
            document: documentOf(external.document.file, external.document.fetchedAt),
            failure: failureOf(external.failure),
            source: external.source ?? null,
            since: external.since ?? null,
          },
          mappings,
        };
      },
      catch: failedWith,
    }),
  setConfig: ({ store, key }, { external, mappings }) =>
    Effect.tryPromise({
      try: async () => {
        if (!external && Object.keys(mappings).length === 0) return removeFile(sourcePath(store));
        const file: typeof GuideSourceFile.infer = {
          version: 1,
          key,
          external: external && {
            origin: external.origin,
            identity: external.identity,
            sealedAddress: external.sealedAddress,
            document: { file: external.document.file, fetchedAt: external.document.fetchedAt },
            ...(external.failure ? { failure: external.failure } : {}),
            ...(external.source ? { source: external.source } : {}),
            // 0.0.12 needs it to read the address at all.
            ...(external.since !== null ? { since: external.since } : {}),
          },
          mappings: Object.fromEntries(
            Object.entries(mappings).map(([channelId, { guideId, name, source }]) => [
              channelId,
              source === null ? { guideId, name } : { guideId, name, source },
            ]),
          ),
        };
        await replaceFile(sourcePath(store), JSON.stringify(file));
      },
      catch: failedWith,
    }),
  sources: ({ store }) =>
    Effect.tryPromise({
      try: async (): Promise<readonly StoredSource[]> => {
        const file = await readRecord(sourcesPath(store), SourcesFile);
        return (file?.sources ?? []).map(({ document, failure, movedFrom, ...source }) => ({
          ...source,
          document: document && documentOf(document.file, document.fetchedAt),
          failure: failureOf(failure),
          movedFrom: movedFrom ?? null,
        }));
      },
      catch: failedWith,
    }),
  setSources: ({ store }, sources) =>
    Effect.tryPromise({
      try: async () => {
        await mkdir(store, { recursive: true });
        const file: typeof SourcesFile.infer = {
          version: 1,
          sources: sources.map(({ document, failure, movedFrom, ...source }) => ({
            ...source,
            document: document && { file: document.file, fetchedAt: document.fetchedAt },
            ...(failure ? { failure } : {}),
            ...(movedFrom ? { movedFrom } : {}),
          })),
        };
        await replaceFile(sourcesPath(store), JSON.stringify(file));
      },
      catch: failedWith,
    }),
  bytesOf: ({ store }, file) =>
    Effect.tryPromise({
      try: async () => {
        try {
          return (await stat(join(store, file))).size;
        } catch (cause) {
          if (isMissing(cause)) return null;
          throw cause;
        }
      },
      catch: failedWith,
    }),
  copy: (from, to, file) =>
    Effect.promise(async (): Promise<Copied> => {
      const source = join(from.store, file);
      const target = join(to.store, file);
      try {
        // Missing only where the system says so: a file it can't look at may well be there.
        if (!(await exists(source))) return "missing";
        await mkdir(to.store, { recursive: true });
        // One left by a copy cut short, which nothing names.
        await rm(target, { force: true });
      } catch {
        return "failed";
      }
      // A link costs no space and is whole at once; across disks, or where links aren't
      // allowed, a copy is written under another name and takes this one once whole.
      if (
        await link(source, target).then(
          () => true,
          () => false,
        )
      )
        return "copied";
      const part = `${target}.part`;
      try {
        await copyFile(source, part);
        await rename(part, target);
        return "copied";
      } catch {
        await rm(part, { force: true }).catch(() => {});
        return "failed";
      }
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
