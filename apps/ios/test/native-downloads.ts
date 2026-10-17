import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Outcome, Progress, Receipt, Running, StartRequest } from "../src/download-task.ts";
import { native } from "./native-files.ts";

// A stand-in for modules/background-downloads, the app's native owner of a background URLSession,
// for tests run on Linux: `requireNativeModule("BackgroundDownloads")` answers it, as `expo` does
// on iOS. It keeps its contract over real requests and real files: an attempt is authorized
// before its request goes out, a duplicate start answers as the first did, and another is refused
// while one may still have a request open; a pause or a cancel answers once the request ended;
// every ending is a receipt, kept until acknowledged, and only an authorized attempt that wasn't
// revoked moves its file into `Documents/downloads/<id>/media.<ext>`, and only into a folder that
// is there. Resume data stays here, by download, for the address it was made for: a pause keeps
// it, as does a request that broke, when the server named the file and takes ranges.
//
// Requests go on when the app's process ends (`die`): a relaunch hears nothing of them until it
// reconciles. A user's force quit (`forceQuit`) ends them with no resume data, as iOS does. What
// only iOS can show (URLSession's own resume data, a suspended app's wakes, the system's handler,
// locked files) is not proved here.

/** URLSession's resume data, as this stand-in makes it: the request after redirects and the part. */
interface ResumeData {
  readonly url: string;
  readonly validator: string;
  readonly written: number;
  readonly part: string;
}

interface Attempt {
  readonly id: string;
  readonly ext: string;
  readonly resumed: boolean;
  revoked: boolean;
  task: Task;
}

interface Task {
  readonly controller: AbortController;
  /** Settles once its request ended and its ending is written down. */
  readonly ended: Promise<void>;
  pausing: boolean;
  /** Ended by iOS, as a user's force quit does. */
  quit: boolean;
}

interface State {
  readonly attempts: Map<string, Attempt>;
  readonly receipts: Receipt[];
  /** Resume data by download, with the address it was made for. */
  readonly secrets: Map<string, { readonly url: string; readonly data: string }>;
  /** Requests no attempt accounts for, as a task with no readable description is. */
  readonly strays: Set<AbortController>;
  /** When the last of those requests ended. */
  strayEndedAt: number;
  readonly listeners: Map<string, Set<(body: never) => void>>;
  /** While true, `reconcile` and `start` are refused, as before the first unlock. */
  unavailable: boolean;
  receiptsMade: number;
}

/** What a test controls and reads of the stand-in; one for the test process, across launches. */
export const background: State & {
  /** The app's process ends: its listeners go, its requests go on. */
  die(): void;
  /** A user's force quit: iOS ends every request, giving no resume data. */
  forceQuit(): Promise<void>;
  /** Pauses every request, keeping resume data, as a stream's reclaim does. */
  pauseAll(): Promise<void>;
  /** The connection of the request under way breaks, as a provider or a network does. */
  breakConnection(): Promise<void>;
  /** A request the session has that no attempt accounts for, holding a provider's connection. */
  stray(url: string): void;
  /** Starts over, for a fresh install. */
  reset(): void;
} = ((globalThis as { mrstreamerBackground?: typeof background }).mrstreamerBackground ??= {
  attempts: new Map(),
  receipts: [],
  secrets: new Map(),
  strays: new Set(),
  strayEndedAt: 0,
  listeners: new Map(),
  unavailable: false,
  receiptsMade: 0,
  die() {
    this.listeners.clear();
  },
  async forceQuit() {
    // The process is gone first: the next launch hears how its requests ended.
    this.listeners.clear();
    const ending = [...this.attempts.values()].map((attempt) => {
      attempt.task.quit = true;
      attempt.task.controller.abort();
      return attempt.task.ended;
    });
    for (const stray of this.strays) stray.abort();
    await Promise.all(ending);
    while (this.strays.size > 0) await new Promise((done) => setTimeout(done, 5));
  },
  async pauseAll() {
    const ending = [...this.attempts.values()].map((attempt) => {
      attempt.task.pausing = true;
      attempt.task.controller.abort();
      return attempt.task.ended;
    });
    await Promise.all(ending);
  },
  async breakConnection() {
    const ending = [...this.attempts.values()].map((attempt) => {
      attempt.task.controller.abort();
      return attempt.task.ended;
    });
    await Promise.all(ending);
  },
  stray(url) {
    const controller = new AbortController();
    this.strays.add(controller);
    native.open++;
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        for await (const _ of response.body ?? []);
      })
      .catch(() => undefined)
      .finally(() => {
        native.open--;
        this.strays.delete(controller);
        this.strayEndedAt = Date.now();
      });
  },
  reset() {
    this.attempts.clear();
    this.receipts.length = 0;
    this.secrets.clear();
    this.listeners.clear();
    this.unavailable = false;
  },
});

const refused = (code: string, message: string) => Object.assign(new Error(message), { code });

function emit(event: "progress", body: Progress): void;
function emit(event: "receipt", body: Receipt): void;
function emit(event: string, body: Progress | Receipt) {
  for (const listener of background.listeners.get(event) ?? []) listener(body as never);
}

/** Ends a request now, or once the test lets held endings go. */
function end(ending: () => void) {
  if (native.held) native.held.push(ending);
  else ending();
}

function close(key: string, outcome: Outcome) {
  const attempt = background.attempts.get(key);
  if (!attempt) return;
  background.attempts.delete(key);
  if (outcome.kind === "complete" || outcome.kind === "cancelled") {
    background.secrets.delete(attempt.id);
  }
  const receipt: Receipt = {
    receipt: `r-${++background.receiptsMade}`,
    attempt: key,
    id: attempt.id,
    outcome,
  };
  background.receipts.push(receipt);
  emit("receipt", receipt);
}

const folderOf = (id: string) => join(native.root, "documents", "downloads", id);
const encode = (resume: ResumeData) => Buffer.from(JSON.stringify(resume)).toString("base64");
const decode = (data: string) => JSON.parse(Buffer.from(data, "base64").toString()) as ResumeData;
let parts = 0;

/** The request of an attempt, over HTTP, into a part file; its ending is the attempt's receipt. */
function transfer(key: string, request: StartRequest, resume: ResumeData | null): Task {
  const controller = new AbortController();
  let settle = () => {};
  const task: Task = {
    controller,
    ended: new Promise<void>((done) => (settle = done)),
    pausing: false,
    quit: false,
  };
  void (async () => {
    const part = resume?.part ?? join(native.root, `background-part-${++parts}`);
    let written = 0;
    let validator: string | null = null;
    let ranges = false;
    let url = request.url;
    const headers: Record<string, string> = { ...request.headers };
    if (resume) {
      url = resume.url;
      headers["Range"] = `bytes=${resume.written}-`;
      headers["If-Range"] = resume.validator;
    }
    native.requests.push({ url, range: headers["Range"] ?? null, at: Date.now() });
    native.open++;
    let outcome: Outcome;
    try {
      if (resume && !existsSync(resume.part)) throw new Error("The file couldn't be opened.");
      const response = await fetch(url, { headers, signal: controller.signal });
      url = response.url;
      if (!response.ok) {
        await response.body?.cancel();
        outcome = { kind: "refused", status: response.status };
      } else {
        validator = response.headers.get("etag") ?? response.headers.get("last-modified");
        ranges = response.headers.get("accept-ranges") === "bytes";
        const length = Number(response.headers.get("content-length") ?? NaN);
        const range = /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
        const whole =
          response.status === 206
            ? range
              ? Number(range[1])
              : null
            : Number.isFinite(length)
              ? length
              : null;
        if (response.status === 206 && resume) written = resume.written;
        else writeFileSync(part, "");
        for await (const piece of response.body ?? []) {
          appendFileSync(part, piece);
          written += piece.length;
          emit("progress", { attempt: key, received: written, expected: whole });
        }
        if (whole !== null && written !== whole) throw new Error("The connection was lost.");
        const attempt = background.attempts.get(key);
        const folder = folderOf(request.id);
        if (!attempt || attempt.revoked) {
          outcome = { kind: "cancelled" };
        } else if (!existsSync(folder) || !statSync(folder).isDirectory()) {
          outcome = { kind: "folder" };
        } else {
          const size = statSync(part).size;
          renameSync(part, join(folder, `media.${request.ext}`));
          outcome = { kind: "complete", size, expected: whole };
        }
      }
    } catch {
      const attempt = background.attempts.get(key);
      const kept = validator !== null && ranges && written > 0 && !task.quit;
      if (kept && attempt && !attempt.revoked) {
        background.secrets.set(request.id, {
          url: request.url,
          data: encode({ url, validator: validator!, written, part }),
        });
      } else {
        rmSync(part, { force: true });
      }
      outcome =
        !attempt || attempt.revoked
          ? { kind: "cancelled" }
          : task.pausing
            ? { kind: "paused", resumable: kept }
            : { kind: "network", code: task.quit ? -999 : -1005, resumable: kept };
    }
    native.open--;
    close(key, outcome);
    settle();
  })();
  return task;
}

const module = {
  async reconcile(): Promise<{ running: Running[]; receipts: Receipt[]; closed: number }> {
    if (background.unavailable) {
      throw refused("ERR_DOWNLOADS_UNAVAILABLE", "The downloads can't be read.");
    }
    const strays = [...background.strays];
    for (const stray of strays) stray.abort();
    while (background.strays.size > 0) await new Promise((done) => setTimeout(done, 5));
    for (const attempt of background.attempts.values()) {
      if (attempt.revoked) await attempt.task.ended;
    }
    return {
      running: [...background.attempts].map(([attempt, { id }]) => ({
        attempt,
        id,
        received: null,
        expected: null,
      })),
      receipts: [...background.receipts],
      closed: strays.length,
    };
  },

  async start(request: StartRequest): Promise<boolean> {
    if (background.unavailable) {
      throw refused("ERR_DOWNLOADS_UNAVAILABLE", "The downloads can't be read.");
    }
    const known = background.attempts.get(request.attempt);
    if (known) return known.resumed;
    if (background.attempts.size > 0) {
      throw refused("ERR_DOWNLOADS_BUSY", "Another download's request is still open.");
    }
    if (!existsSync(folderOf(request.id))) {
      throw refused("ERR_DOWNLOADS_FOLDER", "The download's folder is gone.");
    }
    const secret = background.secrets.get(request.id);
    const resume = secret && secret.url === request.url ? decode(secret.data) : null;
    if (secret && !resume) background.secrets.delete(request.id);
    const attempt: Attempt = {
      id: request.id,
      ext: request.ext,
      resumed: resume !== null,
      revoked: false,
      task: undefined as unknown as Task,
    };
    background.attempts.set(request.attempt, attempt);
    attempt.task = transfer(request.attempt, request, resume);
    return resume !== null;
  },

  async pause(key: string): Promise<void> {
    const attempt = background.attempts.get(key);
    if (!attempt || attempt.revoked) return;
    const { task } = attempt;
    task.pausing = true;
    end(() => setTimeout(() => task.controller.abort(), native.pauseMs));
    await task.ended;
  },

  async cancel(key: string): Promise<void> {
    const attempt = background.attempts.get(key);
    if (!attempt) return;
    attempt.revoked = true;
    background.secrets.delete(attempt.id);
    const { task } = attempt;
    end(() => task.controller.abort());
    await task.ended;
  },

  async acknowledge(receipts: readonly string[]): Promise<void> {
    const kept = background.receipts.filter((each) => !receipts.includes(each.receipt));
    background.receipts.splice(0, background.receipts.length, ...kept);
  },

  async forgetResume(id: string): Promise<void> {
    background.secrets.delete(id);
  },

  async importResume(id: string, url: string, data: string): Promise<void> {
    if (!background.secrets.has(id)) background.secrets.set(id, { url, data });
  },

  addListener(event: string, listener: (body: never) => void) {
    const listeners = background.listeners.get(event) ?? new Set();
    listeners.add(listener);
    background.listeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  },
};

export function requireNativeModule(name: string) {
  if (name !== "BackgroundDownloads") throw new Error(`No native module ${name}`);
  return module;
}

mkdirSync(join(native.root, "documents"), { recursive: true });
