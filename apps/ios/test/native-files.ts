import {
  appendFileSync,
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
import { basename, dirname, join } from "node:path";

// A stand-in for the parts of expo-file-system the iOS app uses, over a real folder on this
// machine, for tests run on Linux in place of the native module. Files and folders behave as
// their Expo classes say. `DownloadTask` follows Expo 58's JavaScript contract (idle, active,
// paused, completed, cancelled, error; a pause resolves null; `savable` and `fromSavable`) over
// the semantics of URLSession's download task as Expo drives it: the body goes to a part file and
// is moved to the destination only once it is whole and the status was 2xx; a status outside 2xx
// rejects with Expo's words; a pause gives resume data only when the server named the file (ETag
// or Last-Modified) and takes byte ranges, and resuming sends `Range` with `If-Range`, so a
// changed file comes whole from the start. A released task's native calls throw, as a released
// shared object's do. It is a model of that behaviour, not URLSession: the real task, how long it
// takes to end, its suspension in the background and its resume data are only proved on iOS.

interface Native {
  readonly root: string;
  /** What `Paths.availableDiskSpace` answers. */
  free: number;
  /** Each request a download task made: its address, and the range it asked for. */
  readonly requests: { readonly url: string; readonly range: string | null }[];
  /** Download task requests not yet ended. */
  open: number;
  /** How long URLSession takes to end a request it is asked to pause, in milliseconds. */
  pauseMs: number;
  /**
   * While a list, a request asked to pause or cancel goes on, its ending kept here until the test
   * runs it: a URLSession that hasn't ended the request yet. Null: requests end as asked.
   */
  held: (() => void)[] | null;
  /** Ends every task's request, as the end of the app's process ends a foreground session's. */
  kill(): void;
  readonly live: Set<AbortController>;
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
  live: new Set(),
  kill() {
    for (const controller of this.live) controller.abort();
    this.live.clear();
  },
});
const { root } = native;

type Part = string | File | Directory;

const pathOf = (parts: readonly Part[]) =>
  join(
    ...parts.map((part) => (typeof part === "string" ? part.replace(/^file:\/\//, "") : part.path)),
  );

export class File {
  readonly path: string;
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
    return this.exists ? statSync(this.path).size : 0;
  }
  create() {
    if (!this.exists) writeFileSync(this.path, "");
  }
  textSync() {
    return readFileSync(this.path, "utf8");
  }
  async text() {
    return this.textSync();
  }
  writeSync(text: string) {
    writeFileSync(this.path, text);
  }
  async write(text: string) {
    writeFileSync(this.path, text);
  }
  moveSync(to: File) {
    renameSync(this.path, to.path);
  }
  delete() {
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

type State = "idle" | "active" | "paused" | "completed" | "cancelled" | "error";

interface Options {
  readonly headers?: Record<string, string>;
  readonly sessionType?: "foreground" | "background";
  readonly onProgress?: (progress: { bytesWritten: number; totalBytes: number }) => void;
  readonly signal?: AbortSignal;
}

/** What URLSession keeps to go on: the request after redirects, the file's mark and the part. */
interface Resume {
  readonly url: string;
  readonly validator: string;
  readonly written: number;
  readonly part: string;
}

let parts = 0;

export class DownloadTask {
  private _state: State = "idle";
  private _resumeData: string | undefined;
  private _controller: AbortController | null = null;
  private _pausing = false;
  private _released = false;

  private readonly _url: string;
  private readonly _destination: File;
  private readonly _options: Options;

  constructor(url: string, destination: File, options: Options = {}) {
    this._url = url;
    this._destination = destination;
    this._options = options;
  }

  static fromSavable(
    state: { url: string; fileUri: string; resumeData?: string; headers?: Record<string, string> },
    options?: Options,
  ) {
    if (!state.resumeData)
      throw new Error("Cannot restore task: DownloadPauseState has no resumeData");
    const task = new DownloadTask(state.url, new File(state.fileUri), {
      ...options,
      headers: { ...state.headers, ...options?.headers },
    });
    task._resumeData = state.resumeData;
    task._state = "paused";
    return task;
  }

  get state() {
    return this._state;
  }

  downloadAsync() {
    if (this._state !== "idle")
      throw new Error(`Cannot call downloadAsync() in state "${this._state}"`);
    return this._run(null);
  }

  resumeAsync() {
    if (this._state !== "paused")
      throw new Error(`Cannot call resumeAsync() in state "${this._state}"`);
    if (!this._resumeData) throw new Error("No resume data available.");
    return this._run(this._resumeData);
  }

  pause() {
    if (this._state !== "active") throw new Error(`Cannot call pause() in state "${this._state}"`);
    this._native();
    this._pausing = true;
    const controller = this._controller;
    end(() => setTimeout(() => controller?.abort(), native.pauseMs));
  }

  /** As Expo's: a paused task's cancel still calls native code. */
  cancel() {
    if (["completed", "cancelled", "error"].includes(this._state)) return;
    this._native();
    this._state = "cancelled";
    const controller = this._controller;
    end(() => controller?.abort());
  }

  savable() {
    if (this._state !== "paused")
      throw new Error(`Cannot call savable() in state "${this._state}"`);
    return {
      url: this._url,
      fileUri: this._destination.uri,
      isDirectory: false,
      ...(this._options.headers ? { headers: this._options.headers } : {}),
      resumeData: this._resumeData,
    };
  }

  release() {
    this._released = true;
  }

  /** A call into the native task, which a released handle no longer has. */
  private _native() {
    if (this._released) {
      throw new Error(
        "Unable to find the native shared object associated with given JavaScript object",
      );
    }
  }

  private async _run(resumeData: string | null): Promise<File | null> {
    this._native();
    this._state = "active";
    this._pausing = false;
    const controller = new AbortController();
    this._controller = controller;
    native.live.add(controller);
    const { signal } = this._options;
    if (signal?.aborted) throw abortError();
    const onAbort = () => this.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    const resume: Resume | null = resumeData
      ? (JSON.parse(Buffer.from(resumeData, "base64").toString()) as Resume)
      : null;
    const part = resume?.part ?? join(root, `part-${++parts}`);
    let written = 0;
    let validator: string | null = null;
    let ranges = false;
    let url = this._url;
    let requested = false;
    try {
      if (resume && !existsSync(resume.part)) {
        throw new Error("Unable to download a file: The file couldn't be opened.");
      }
      const headers: Record<string, string> = { ...this._options.headers };
      if (resume) {
        url = resume.url;
        headers["Range"] = `bytes=${resume.written}-`;
        headers["If-Range"] = resume.validator;
      }
      native.requests.push({ url, range: headers["Range"] ?? null });
      native.open++;
      requested = true;
      const response = await fetch(url, { headers, signal: controller.signal });
      url = response.url;
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Unable to download a file: server returned HTTP ${response.status}`);
      }
      validator = response.headers.get("etag") ?? response.headers.get("last-modified");
      ranges = response.headers.get("accept-ranges") === "bytes";
      const length = Number(response.headers.get("content-length") ?? NaN);
      if (response.status === 206 && resume) {
        written = resume.written;
      } else {
        writeFileSync(part, "");
      }
      const total = Number.isFinite(length) ? written + length : -1;
      for await (const piece of response.body ?? []) {
        appendFileSync(part, piece);
        written += piece.length;
        this._options.onProgress?.({ bytesWritten: written, totalBytes: total });
      }
      if (total >= 0 && written !== total) {
        throw new Error("Unable to download a file: The network connection was lost.");
      }
      mkdirSync(dirname(this._destination.path), { recursive: true });
      rmSync(this._destination.path, { force: true });
      renameSync(part, this._destination.path);
      this._state = "completed";
      this._resumeData = undefined;
      const size = this._destination.size;
      this._options.onProgress?.({ bytesWritten: size, totalBytes: size });
      return new File(this._destination.path);
    } catch (cause) {
      if (this._pausing && this._state === "active") {
        const keep = validator !== null && ranges && written > 0;
        this._resumeData =
          validator !== null && keep
            ? Buffer.from(
                JSON.stringify({ url, validator, written, part } satisfies Resume),
              ).toString("base64")
            : undefined;
        if (!keep) rmSync(part, { force: true });
        this._state = "paused";
        return null;
      }
      rmSync(part, { force: true });
      if (this.state === "cancelled") {
        throw signal?.aborted ? abortError() : new Error("Download was cancelled");
      }
      this._state = "error";
      throw cause instanceof Error && cause.message.startsWith("Unable")
        ? cause
        : new Error("Unable to download a file: The network connection was lost.");
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this._controller = null;
      native.live.delete(controller);
      if (requested) native.open--;
    }
  }
}

/** Ends a request now, or once the test lets held endings go. */
function end(ending: () => void) {
  if (native.held) native.held.push(ending);
  else ending();
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
