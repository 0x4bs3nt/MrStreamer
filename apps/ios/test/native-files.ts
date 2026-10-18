import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// A stand-in for the parts of expo-file-system the iOS app uses, over a real folder on this
// machine, for tests run on Linux in place of the native module. Files and folders behave as
// their Expo classes say. Media transfers are the app's own native module's, modelled in
// `native-downloads.ts`, which shares the controls below.

/** What a file's asynchronous operation does, as `gate` is told. */
type FileOperation = "text" | "write" | "move";

interface Native {
  readonly root: string;
  /** What `Paths.availableDiskSpace` answers. */
  free: number;
  /** Each request a media transfer made: its address, the range it asked for, and when. */
  readonly requests: { readonly url: string; readonly range: string | null; readonly at: number }[];
  /** Media transfer requests not yet ended. */
  open: number;
  /** How long URLSession takes to end a request it is asked to pause, in milliseconds. */
  pauseMs: number;
  /**
   * While a list, a request asked to pause or cancel goes on, its ending kept here until the test
   * runs it: a URLSession that hasn't ended the request yet. Null: requests end as asked.
   */
  held: (() => void)[] | null;
  /**
   * Asked as a file's asynchronous read, write or move starts, with the file's path: a promise
   * it answers holds the operation until it settles, as a busy disk would, and one that never
   * settles stands for the app stopping there. Null: each goes ahead at once.
   */
  gate: ((operation: FileOperation, path: string) => Promise<void> | undefined) | null;
  /** Answers true for a file whose deletion the disk refuses. Null: every deletion goes ahead. */
  undeletable: ((path: string) => boolean) | null;
  /**
   * The size a file reports in place of its own, when this answers one: a large file without its
   * bytes. Null: every file reports its own.
   */
  sizeOf: ((path: string) => number | undefined) | null;
}

/**
 * What a test controls and reads of the stand-in. One for the test process: a relaunch imports
 * the app's modules, this one with them, again, and finds the same folder.
 */
export const native: Native = ((
  globalThis as { mrstreamerNativeFiles?: Native }
).mrstreamerNativeFiles ??= {
  root: mkdtempSync(join(tmpdir(), "mrstreamer-ios-files-")),
  free: 64 * 1024 * 1024 * 1024,
  requests: [],
  open: 0,
  pauseMs: 0,
  held: null,
  gate: null,
  undeletable: null,
  sizeOf: null,
});
const { root } = native;

type Part = string | File | Directory;

const pathOf = (parts: readonly Part[]) =>
  join(
    ...parts.map((part) => (typeof part === "string" ? part.replace(/^file:\/\//, "") : part.path)),
  );

/** Waits for `native.gate` to let the operation through. */
const through = async (operation: FileOperation, path: string) => {
  await native.gate?.(operation, path);
};

export class File {
  /** Where it is: a move takes it along, as Expo's does. */
  path: string;
  constructor(...parts: Part[]) {
    this.path = pathOf(parts);
  }
  get uri() {
    return `file://${this.path}`;
  }
  get name() {
    return basename(this.path);
  }
  get exists() {
    return existsSync(this.path) && statSync(this.path).isFile();
  }
  get size() {
    if (!this.exists) return 0;
    return native.sizeOf?.(this.path) ?? statSync(this.path).size;
  }
  get modificationTime() {
    return this.exists ? statSync(this.path).mtimeMs : null;
  }
  create() {
    if (!this.exists) writeFileSync(this.path, "");
  }
  textSync() {
    return readFileSync(this.path, "utf8");
  }
  async text() {
    await through("text", this.path);
    return this.textSync();
  }
  writeSync(text: string) {
    writeFileSync(this.path, text);
  }
  async write(text: string) {
    await through("write", this.path);
    writeFileSync(this.path, text);
  }
  moveSync(to: File) {
    renameSync(this.path, to.path);
  }
  /** As on iOS: with `overwrite`, the file there is deleted, then this one moved in its place. */
  async move(to: File, options?: { readonly overwrite?: boolean }) {
    await through("move", this.path);
    if (to.exists) {
      if (!options?.overwrite) throw new Error(`A file is already at ${to.path}`);
      rmSync(to.path);
    }
    renameSync(this.path, to.path);
    this.path = to.path;
  }
  delete() {
    if (native.undeletable?.(this.path)) throw new Error("Operation not permitted");
    rmSync(this.path);
  }
  static async downloadFileAsync(
    url: string,
    destination: File,
    options?: { readonly signal?: AbortSignal },
  ): Promise<File> {
    const response = await fetch(url, options?.signal ? { signal: options.signal } : {});
    if (!response.ok) {
      throw new Error(`Unable to download a file: server returned HTTP ${response.status}`);
    }
    writeFileSync(destination.path, Buffer.from(await response.arrayBuffer()));
    return destination;
  }
}

export class Directory {
  readonly path: string;
  constructor(...parts: Part[]) {
    this.path = pathOf(parts);
  }
  get uri() {
    return `file://${this.path}/`;
  }
  get name() {
    return basename(this.path);
  }
  get exists() {
    return existsSync(this.path) && statSync(this.path).isDirectory();
  }
  create(options?: { readonly intermediates?: boolean; readonly idempotent?: boolean }) {
    if (this.exists && options?.idempotent) return;
    mkdirSync(this.path, { recursive: options?.intermediates ?? false });
  }
  delete() {
    rmSync(this.path, { recursive: true });
  }
  list(): (File | Directory)[] {
    return readdirSync(this.path, { withFileTypes: true }).map((entry) =>
      entry.isDirectory() ? new Directory(this.path, entry.name) : new File(this.path, entry.name),
    );
  }
}

const documents = new Directory(root, "documents");
const cache = new Directory(root, "cache");
documents.create({ idempotent: true });
cache.create({ idempotent: true });

export const Paths = {
  document: documents,
  cache,
  get availableDiskSpace() {
    return native.free;
  },
};
