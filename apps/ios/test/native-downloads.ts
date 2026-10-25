import { appendFileSync, existsSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthorizationView, OutcomeV2, ReceiptV2 } from "../src/download-task.ts";
import { native } from "./native-files.ts";

// A stand-in for modules/background-downloads, the app's native scheduler of one background
// URLSession, for tests run on Linux. Importing it installs it where Expo installs native
// modules, as the app finds them. It keeps the contract over real requests and real files:
//
// - One pump claims the slot before anything else, for the oldest runnable authorization whose
//   source is enabled under its generation, has its anchor and request item, isn't held by a
//   stream lease and isn't fenced; the task occupies the slot through its earliest-begin wait, a
//   second after its source's last request ended (or launch, or an unknown request's end), until
//   it ended and its receipt is written. Then the next goes, whether the app's JavaScript runs or
//   not: the background handoff.
// - Every ending is a receipt under the next sequence, kept until acknowledged. A pause keeps the
//   same authorization runnable; a removal ends it cancelled; a revoke ends its source's with a
//   refresh; a resume the server refuses starts once more from nothing, with no receipt, after
//   its resume data is deleted. At most 32 unfinished authorizations and 128 with receipts.
// - A removal or revoke is fenced by its ledger write, or when the ledger refuses (`faults`), by
//   deleting its request items; neither waits for its task to end.
// - A stream's lease pauses its source's task, cancels it after five seconds, and is refused
//   after five more; then the provider's second of grace passes. Memory only.
// - The first foreground reconcile of a process installs the barrier; until it is finished, no
//   new task is admitted.
//
// The app's process ends with `die`: what it held in memory goes, its tasks go on as a background
// session's do and still end in receipts. A user's force quit (`forceQuit`) ends them with no
// resume data. What only iOS can show (URLSession's own resume data, the system's wakes and
// handler, earliestBeginDate scheduling, locked files, the Keychain itself) is not proved here.

interface Grant {
  readonly id: string;
  readonly ext: string;
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly order: number;
  state: AuthorizationView["state"];
  restarted: boolean;
  fresh: 0 | 1;
  lastSequence: number;
  attempt: string | null;
}

interface Request {
  readonly sourceId: string;
  readonly sourceGeneration: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** URLSession's resume data, as this stand-in makes it: the request after redirects and the part. */
interface ResumeData {
  readonly url: string;
  readonly validator: string;
  readonly written: number;
  readonly part: string;
}

interface Resume extends Request {
  readonly authorization: string;
  readonly data: string;
}

interface Task {
  readonly authorization: string;
  readonly attempt: string;
  readonly sourceId: string;
  readonly controller: AbortController;
  /** Settles once its request ended and its receipt, if any, is written. */
  readonly ended: Promise<void>;
  readonly settle: () => void;
  /** Its earliest-begin wait, until the request goes out. */
  waiting: ReturnType<typeof setTimeout> | null;
  stop: null | "pause" | "disk";
  /** Ended by iOS, as a user's force quit does. */
  quit: boolean;
  received: number;
  expected: number | null;
  resumed: boolean;
  restarted: boolean;
}

interface Lease {
  readonly sourceId: string;
  state: "acquiring" | "granted" | "refused";
}

const refused = (code: string, message = "The downloads refused the command.") =>
  Object.assign(new Error(message), { code });

const fresh = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 12)}`;

function initial() {
  return {
    // Durable: the queue file.
    install: fresh("q"),
    sequence: 0,
    nextOrder: 0,
    sources: new Map<string, { generation: string; state: "enabled" | "revoked" }>(),
    grants: new Map<string, Grant>(),
    receipts: [] as ReceiptV2[],
    /** Build 14's receipts copied into the queue, taken in with build 14's meanings. */
    legacyReceipts: [] as {
      receipt: string;
      attempt: string;
      id: string;
      outcome: { kind: "complete"; size: number; expected: number | null } | { kind: "cancelled" };
    }[],
    // Durable: the Keychain.
    anchors: new Map<string, { epoch: string; generation: string }>(),
    requests: new Map<string, Request>(),
    /** Resume data by download, with the request it was made for and its owner. */
    resume: new Map<string, Resume>(),
    /** Build 14's resume data by download, with the address it was made for. */
    legacy: new Map<string, { url: string; data: string }>(),
    // The session: the one task, and requests no authorization accounts for.
    task: null as Task | null,
    strays: new Set<AbortController>(),
    /** When the last of those requests ended. */
    strayEndedAt: 0,
    // Process memory, gone with the app's process.
    listeners: new Map<string, Set<(body: never) => void>>(),
    barrier: { kind: "none" } as
      { kind: "none" } | { kind: "installed"; token: string } | { kind: "finished"; token: string },
    leases: new Map<string, Lease>(),
    retired: new Set<string>(),
    removed: new Set<string>(),
    /** Sources whose request items went for want of a ledger write. */
    fenced: new Set<string>(),
    closes: new Map<string, number>(),
    unknownClose: 0,
    launchedAt: Date.now(),
    /** The slot claimed by an admission whose task isn't made yet. */
    admitting: null as string | null,
    /** Launch recovery still to run: strays are cancelled first. */
    recovering: false,
    /** Force quit: nothing runs until the app is opened again. */
    down: false,
    /** While true, the queue can't be read, as before the first unlock. */
    unavailable: false,
    /** While true, the queue's authority is damaged. */
    corrupt: false,
    /** Injected refusals: ledger writes, and Keychain deletions. */
    faults: { ledger: false, keychainDelete: false },
    /** What the native side did, in order: `start:<id>`, `end:<id>`, `receipt:<id>:<kind>`. */
    events: [] as string[],

    /** The app's process ends: its memory goes, its tasks go on as a background session's do. */
    die() {
      background.listeners.clear();
      background.barrier = { kind: "none" };
      background.leases.clear();
      background.retired.clear();
      background.removed.clear();
      background.fenced.clear();
      background.closes.clear();
      background.launchedAt = Date.now();
      background.recovering = true;
      background.admitting = null;
    },
    /** A user's force quit: iOS ends every request, giving no resume data, and nothing runs. */
    async forceQuit() {
      background.die();
      background.down = true;
      const task = background.task;
      if (task) {
        task.quit = true;
        if (task.waiting) {
          clearTimeout(task.waiting);
          task.waiting = null;
          settleUnstarted(task);
        } else task.controller.abort();
        await task.ended;
      }
      for (const stray of background.strays) stray.abort();
      while (background.strays.size > 0) await new Promise((done) => setTimeout(done, 5));
    },
    /** Pauses the task under way, keeping resume data, as a stream's lease does. */
    async pauseAll() {
      const task = background.task;
      if (!task) return;
      task.stop = "pause";
      if (task.waiting) {
        clearTimeout(task.waiting);
        task.waiting = null;
        settleUnstarted(task);
      } else task.controller.abort();
      await task.ended;
    },
    /** The connection of the request under way breaks, as a provider or a network does. */
    async breakConnection() {
      const task = background.task;
      if (!task) return;
      task.controller.abort();
      await task.ended;
    },
    /** A request the session has that no authorization accounts for, holding a connection. */
    stray(url: string) {
      const controller = new AbortController();
      background.strays.add(controller);
      native.open++;
      void fetch(url, { signal: controller.signal })
        .then(async (response) => {
          for await (const _ of response.body ?? []);
        })
        .catch(() => undefined)
        .finally(() => {
          native.open--;
          background.strays.delete(controller);
          background.strayEndedAt = Date.now();
          background.unknownClose = Date.now();
          pump();
        });
    },
    /** Starts over, for a fresh install. */
    reset() {
      Object.assign(background, {
        install: fresh("q"),
        sequence: 0,
        nextOrder: 0,
        unavailable: false,
        corrupt: false,
        down: false,
        faults: { ledger: false, keychainDelete: false },
      });
      for (const each of [
        background.sources,
        background.grants,
        background.anchors,
        background.requests,
        background.resume,
        background.legacy,
      ]) {
        each.clear();
      }
      background.receipts.length = 0;
      background.legacyReceipts.length = 0;
      background.events.length = 0;
      background.die();
      background.recovering = false;
    },
    /** Unfinished authorizations of download `id`. */
    open(id: string): Grant[] {
      return [...background.grants.values()].filter(
        (grant) => grant.id === id && grant.state !== "terminal",
      );
    },
  };
}
type Background = ReturnType<typeof initial>;

/** What a test controls and reads of the stand-in; one for the test process, across launches. */
export const background: Background = ((
  globalThis as { mrstreamerBackground?: Background }
).mrstreamerBackground ??= initial());

function emit(event: "progress" | "receipt", body: object) {
  for (const listener of background.listeners.get(event) ?? []) listener(body as never);
}

/** Ends a request now, or once the test lets held endings go. */
function end(ending: () => void) {
  if (native.held) native.held.push(ending);
  else ending();
}

/** A ledger write: refused while a test says so. */
function write(): boolean {
  return !background.faults.ledger && !background.corrupt && !background.unavailable;
}

function record(id: string, grant: Grant, outcome: OutcomeV2, task: Task | null): ReceiptV2 {
  background.sequence++;
  grant.lastSequence = background.sequence;
  const receipt: ReceiptV2 = {
    version: 2,
    receipt: fresh("r"),
    authorization: id,
    attempt: task?.attempt ?? grant.attempt,
    id: grant.id,
    sequence: background.sequence,
    received: task?.received ?? null,
    expected: task?.expected ?? null,
    restarted: grant.restarted,
    outcome,
  };
  background.receipts.push(receipt);
  background.events.push(`receipt:${grant.id}:${outcome.kind}`);
  emit("receipt", receipt);
  return receipt;
}

const load = () => {
  const grants = [...background.grants.values()];
  return {
    open: grants.filter((grant) => grant.state !== "terminal").length,
    receipts: background.receipts.length,
  };
};

/** Whether `id`'s authority still stands: enabled ledger generation, anchor and request item. */
function authorized(id: string, grant: Grant): "valid" | "source" | "request" | "gone" {
  if (grant.state === "terminal" || background.removed.has(id)) return "gone";
  if (background.fenced.has(grant.sourceId)) return "gone";
  const source = background.sources.get(grant.sourceId);
  if (source?.state !== "enabled" || source.generation !== grant.sourceGeneration) return "gone";
  const anchor = background.anchors.get(grant.sourceId);
  if (anchor?.epoch !== background.install || anchor.generation !== grant.sourceGeneration) {
    return "source";
  }
  const request = background.requests.get(id);
  if (request?.sourceGeneration !== grant.sourceGeneration) return "request";
  return "valid";
}

const held = (sourceId: string) =>
  [...background.leases.values()].some((lease) => lease.sourceId === sourceId);

/** When a request of `sourceId` may go out: a second after the last one of ours ended. */
function earliest(sourceId: string) {
  return (
    Math.max(background.closes.get(sourceId) ?? background.launchedAt, background.unknownClose) +
    1000
  );
}

/** Launch recovery, run before anything else after `die`: every stray is cancelled and waited for. */
function recover() {
  background.down = false;
  if (!background.recovering) return;
  background.recovering = false;
  for (const stray of background.strays) stray.abort();
  // An attempt no task runs any more: cleared, and its authorization queued again.
  for (const [id, grant] of background.grants) {
    if (grant.state === "active" && background.task?.authorization !== id) {
      grant.attempt = null;
      grant.state = "queued";
    }
  }
}

/** The one pump: claims the slot for the oldest runnable authorization, before anything else. */
function pump() {
  const b = background;
  if (b.down) return;
  recover();
  if (b.task || b.admitting || b.strays.size > 0 || b.corrupt || b.unavailable) return;
  if (b.barrier.kind === "installed") return;
  const { open, receipts } = load();
  if (open + receipts >= 128) return;
  const next = [...b.grants]
    .filter(
      ([id, grant]) =>
        (grant.state === "queued" || grant.state === "paused") &&
        b.sources.get(grant.sourceId)?.state === "enabled" &&
        b.sources.get(grant.sourceId)?.generation === grant.sourceGeneration &&
        !b.removed.has(id) &&
        !b.fenced.has(grant.sourceId) &&
        !held(grant.sourceId),
    )
    .toSorted(([, a], [, z]) => a.order - z.order)[0];
  if (!next) return;
  const [id, grant] = next;
  b.admitting = id;
  queueMicrotask(() => admit(id, grant));
}

function admit(id: string, grant: Grant) {
  const b = background;
  if (b.admitting !== id) return;
  const verdict = authorized(id, grant);
  if (verdict !== "valid") {
    b.admitting = null;
    if (verdict === "request") {
      grant.state = "terminal";
      record(id, grant, { kind: "refresh", reason: "secret-missing" }, null);
    } else if (verdict === "source") b.fenced.add(grant.sourceId);
    return pump();
  }
  const request = b.requests.get(id)!;
  const kept = b.resume.get(grant.id);
  const legacy = b.legacy.get(grant.id);
  const resumeData =
    kept &&
    kept.sourceGeneration === grant.sourceGeneration &&
    kept.url === request.url &&
    JSON.stringify(kept.headers) === JSON.stringify(request.headers)
      ? kept.data
      : legacy?.url === request.url
        ? legacy.data
        : null;
  if (resumeData) {
    b.resume.set(grant.id, { ...request, authorization: id, data: resumeData });
    b.legacy.delete(grant.id);
  }
  const attempt = fresh("a");
  grant.state = "active";
  grant.attempt = attempt;
  const ended = Promise.withResolvers<void>();
  const task: Task = {
    authorization: id,
    attempt,
    sourceId: grant.sourceId,
    controller: new AbortController(),
    ended: ended.promise,
    settle: ended.resolve,
    waiting: null,
    stop: null,
    quit: false,
    received: 0,
    expected: null,
    resumed: resumeData !== null,
    restarted: grant.restarted,
  };
  b.admitting = null;
  b.task = task;
  b.events.push(`start:${grant.id}`);
  // A lower bound, as earliestBeginDate is: never a moment before it, whatever the timer does.
  const begin = earliest(grant.sourceId);
  const go = () => {
    const wait = begin - Date.now();
    if (wait > 0) {
      task.waiting = setTimeout(go, wait);
      return;
    }
    task.waiting = null;
    transfer(id, grant, task, request, resumeData ? decode(resumeData) : null);
  };
  task.waiting = setTimeout(go, Math.max(0, begin - Date.now()));
}

const encode = (resume: ResumeData) => Buffer.from(JSON.stringify(resume)).toString("base64");
const decode = (data: string) => JSON.parse(Buffer.from(data, "base64").toString()) as ResumeData;
let parts = 0;
const folderOf = (id: string) => join(native.root, "documents", "downloads", id);

/** A task stopped before its request went out: nothing loaded, its resume data as it was. */
function settleUnstarted(task: Task) {
  const grant = background.grants.get(task.authorization) ?? null;
  const kept =
    grant !== null && background.resume.get(grant.id)?.authorization === task.authorization;
  finish(
    task,
    grant,
    task.quit
      ? { kind: "network", code: -999, resumable: false }
      : task.stop === "pause"
        ? { kind: "paused", resumable: kept }
        : null,
  );
}

/** The slot's task ended: its receipt, unless a removal, revoke or reset already ended it. */
function finish(task: Task, grant: Grant | null, outcome: OutcomeV2 | null) {
  const b = background;
  const id = task.authorization;
  if (!write()) {
    // Its terminal write refused: the authorization stays active with its attempt, for launch
    // recovery to clear and queue again with no receipt.
  } else if (grant && grant.state === "active" && grant.attempt === task.attempt && outcome) {
    grant.attempt = null;
    grant.restarted ||= task.restarted;
    const refusedResume =
      task.resumed &&
      grant.fresh === 1 &&
      ((outcome.kind === "refused" && (outcome.status === 412 || outcome.status === 416)) ||
        (outcome.kind === "network" && outcome.code === -3001));
    if (refusedResume) {
      // Its refused resume data goes first, then the same authorization starts from nothing.
      if (b.resume.get(grant.id)?.authorization === id) b.resume.delete(grant.id);
      grant.restarted = true;
      grant.fresh = 0;
      grant.state = "queued";
    } else {
      grant.state = outcome.kind === "paused" ? "paused" : "terminal";
      record(id, grant, outcome, task);
      if (grant.state === "terminal") {
        b.requests.delete(id);
        if (outcome.kind === "complete" && b.resume.get(grant.id)?.authorization === id) {
          b.resume.delete(grant.id);
        }
      }
    }
  } else if (grant?.attempt === task.attempt) grant.attempt = null;
  b.closes.set(task.sourceId, Date.now());
  if (b.task === task) b.task = null;
  b.events.push(`end:${grant?.id ?? "?"}`);
  task.settle();
  pump();
}

/** The task's request, over HTTP, into a part file; its end is the authorization's receipt. */
function transfer(
  id: string,
  grant: Grant,
  task: Task,
  request: Request,
  resume: ResumeData | null,
) {
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
    let outcome: OutcomeV2 | null;
    try {
      if (resume && !existsSync(resume.part)) {
        throw Object.assign(new Error("The file couldn't be opened."), { code: -3001 });
      }
      const response = await fetch(url, { headers, signal: task.controller.signal });
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
        else {
          writeFileSync(part, "");
          // The server sent the whole file again, as a changed one does: it starts from zero.
          if (resume) task.restarted = true;
        }
        task.expected = whole;
        let checked = false;
        for await (const piece of response.body ?? []) {
          if (!checked && whole !== null) {
            checked = true;
            if (native.free < whole - written) {
              task.stop = "disk";
              task.controller.abort();
              throw new Error("The disk is full.");
            }
          }
          appendFileSync(part, piece);
          written += piece.length;
          task.received = written;
          emit("progress", {
            version: 2,
            authorization: id,
            attempt: task.attempt,
            id: grant.id,
            received: written,
            expected: whole,
            restarted: task.restarted,
            resumed: task.resumed,
          });
        }
        if (whole !== null && written !== whole) throw new Error("The connection was lost.");
        const folder = folderOf(grant.id);
        const media = join(folder, `media.${grant.ext}`);
        if (authorized(id, grant) !== "valid") {
          rmSync(part, { force: true });
          outcome = { kind: "refresh", reason: "secret-missing" };
        } else if (!existsSync(folder) || !statSync(folder).isDirectory() || existsSync(media)) {
          outcome = { kind: "folder" };
        } else {
          const size = statSync(part).size;
          renameSync(part, media);
          outcome = { kind: "complete", size, expected: whole };
        }
      }
    } catch (cause) {
      const kept =
        validator !== null && ranges && written > 0 && !task.quit && task.stop !== "disk";
      if (kept && authorized(id, grant) === "valid") {
        background.resume.set(grant.id, {
          ...request,
          authorization: id,
          data: encode({ url, validator: validator!, written, part }),
        });
      } else {
        rmSync(part, { force: true });
      }
      const code = (cause as { code?: unknown }).code === -3001 ? -3001 : task.quit ? -999 : -1005;
      outcome =
        task.stop === "disk"
          ? { kind: "disk-full", needed: task.expected === null ? null : task.expected - written }
          : task.stop === "pause"
            ? { kind: "paused", resumable: kept }
            : { kind: "network", code, resumable: kept };
    }
    native.open--;
    finish(task, background.grants.get(id) ?? null, outcome);
  })();
}

/** Stops the slot's task of `sourceId`, or every task: a pause or a cancel, honoring held endings. */
function stopTask(task: Task, why: "pause" | "cancel") {
  if (why === "pause") task.stop ??= "pause";
  if (task.waiting) {
    // Still waiting for its earliest begin: no request went out.
    clearTimeout(task.waiting);
    task.waiting = null;
    end(() => settleUnstarted(task));
    return;
  }
  end(() =>
    why === "pause"
      ? setTimeout(() => task.controller.abort(), native.pauseMs)
      : task.controller.abort(),
  );
}

async function within(promise: Promise<void>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ended = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((done) => (timer = setTimeout(() => done(false), ms))),
  ]);
  clearTimeout(timer);
  return ended;
}

function observe(sourceId: string) {
  const b = background;
  const epoch = b.corrupt || b.unavailable ? "q-process" : b.install;
  if (b.corrupt || b.unavailable) {
    const token = `o-blocked-${sourceId}`;
    return {
      state: "blocked",
      generation: token,
      expected: { queueEpoch: epoch, expected: token },
    };
  }
  const source = b.sources.get(sourceId);
  const anchor = b.anchors.get(sourceId);
  const anchored = anchor?.epoch === b.install && anchor.generation === source?.generation;
  const token = `o-fenced-${source?.generation ?? "none"}-${anchor?.generation ?? "none"}-${b.fenced.has(sourceId)}`;
  if (!source) {
    return !anchor && !b.fenced.has(sourceId)
      ? { state: "missing", generation: null, expected: { queueEpoch: epoch, expected: "missing" } }
      : { state: "fenced", generation: token, expected: { queueEpoch: epoch, expected: token } };
  }
  if (source.state === "revoked") {
    return {
      state: "revoked",
      generation: source.generation,
      expected: { queueEpoch: epoch, expected: source.generation },
    };
  }
  return anchored && !b.fenced.has(sourceId)
    ? {
        state: "enabled",
        generation: source.generation,
        expected: { queueEpoch: epoch, expected: source.generation },
      }
    : { state: "fenced", generation: token, expected: { queueEpoch: epoch, expected: token } };
}

/** Ends `sourceId`'s unfinished authorizations of another generation than `keeping`. */
function endSource(sourceId: string, keeping: string | null) {
  for (const [id, grant] of background.grants) {
    if (grant.sourceId !== sourceId || grant.state === "terminal") continue;
    if (grant.sourceGeneration === keeping) continue;
    if (grant.state === "reserved") {
      background.grants.delete(id);
      continue;
    }
    grant.attempt = null;
    grant.state = "terminal";
    record(id, grant, { kind: "refresh", reason: "source" }, null);
  }
}

function fenceOf(durable: string, authorization?: string) {
  return {
    durable,
    receipts: background.receipts.filter(
      (each) => authorization === undefined || each.authorization === authorization,
    ),
    legacy: [...background.legacyReceipts],
  };
}

function snapshot() {
  const b = background;
  const blocked = b.unavailable ? "locked" : b.corrupt ? "corrupt" : "none";
  const token = b.barrier.kind === "none" ? null : b.barrier.token;
  return {
    version: 2,
    queueEpoch: b.corrupt || b.unavailable ? "q-process" : b.install,
    sequence: b.sequence,
    foregroundToken: token,
    blocked,
    sources: [...b.sources.keys()],
    authorizations: b.unavailable
      ? []
      : [...b.grants].map(([authorization, grant]) => ({
          authorization,
          id: grant.id,
          sourceId: grant.sourceId,
          sourceGeneration: grant.sourceGeneration,
          state: grant.state,
          sequence: grant.lastSequence,
          attempt: grant.attempt,
          received: b.task?.authorization === authorization ? b.task.received : null,
          expected: b.task?.authorization === authorization ? b.task.expected : null,
          restarted: grant.restarted,
          resumed: b.task?.authorization === authorization ? b.task.resumed : false,
        })),
    receipts: b.unavailable ? [] : [...b.receipts],
    legacy: { receipts: b.unavailable ? [] : [...b.legacyReceipts] },
  };
}

const gate = () => {
  if (background.unavailable) throw refused("ERR_DOWNLOADS_UNAVAILABLE");
  if (background.corrupt) throw refused("ERR_DOWNLOADS_CORRUPT");
};

const module = {
  async sourceState(sourceId: string) {
    recover();
    return observe(sourceId);
  },

  async enableSource(command: { sourceId: string; queueEpoch: string; expected: string }) {
    gate();
    const seen = observe(command.sourceId);
    if (seen.state === "blocked") throw refused("ERR_DOWNLOADS_KEYCHAIN");
    if (
      command.queueEpoch !== seen.expected.queueEpoch ||
      command.expected !== seen.expected.expected
    ) {
      throw refused("ERR_DOWNLOADS_OBSOLETE");
    }
    if (seen.state === "enabled") return { generation: seen.generation };
    const generation = fresh("g");
    background.anchors.set(command.sourceId, { epoch: background.install, generation });
    if (!write()) throw refused("ERR_DOWNLOADS_UNAVAILABLE");
    background.sources.set(command.sourceId, { generation, state: "enabled" });
    endSource(command.sourceId, generation);
    background.fenced.delete(command.sourceId);
    pump();
    return { generation };
  },

  async revokeSource(command: { sourceId: string; queueEpoch: string; expected: string }) {
    recover();
    const seen = observe(command.sourceId);
    if (
      command.queueEpoch !== seen.expected.queueEpoch ||
      command.expected !== seen.expected.expected
    ) {
      throw refused("ERR_DOWNLOADS_OBSOLETE");
    }
    const source = command.sourceId;
    const cancel = () => {
      const task = background.task;
      if (task?.sourceId === source) stopTask(task, "cancel");
    };
    if (seen.state === "revoked") return { ...fenceOf("already-terminal"), source: seen };
    if (write()) {
      background.sources.set(source, { generation: fresh("g"), state: "revoked" });
      endSource(source, null);
      cancel();
      for (const [id, grant] of background.grants) {
        if (grant.sourceId === source && grant.state === "terminal") background.requests.delete(id);
      }
      background.anchors.delete(source);
      return { ...fenceOf("ledger"), source: observe(source) };
    }
    if (background.faults.keychainDelete) throw refused("ERR_DOWNLOADS_KEYCHAIN");
    background.anchors.delete(source);
    for (const [id, request] of background.requests) {
      if (request.sourceId === source) background.requests.delete(id);
    }
    for (const [download, resume] of background.resume) {
      if (resume.sourceId === source) background.resume.delete(download);
    }
    background.fenced.add(source);
    cancel();
    return { ...fenceOf("secrets"), source: observe(source) };
  },

  async reserve(request: { id: string; ext: string; sourceId: string; sourceGeneration: string }) {
    gate();
    const source = background.sources.get(request.sourceId);
    if (
      source?.state !== "enabled" ||
      source.generation !== request.sourceGeneration ||
      background.fenced.has(request.sourceId)
    ) {
      throw refused("ERR_DOWNLOADS_OBSOLETE");
    }
    const { open, receipts } = load();
    if (open >= 32 || open + receipts + 1 > 128) throw refused("ERR_DOWNLOADS_CAPACITY");
    if (!write()) throw refused("ERR_DOWNLOADS_UNAVAILABLE");
    const authorization = fresh("z");
    background.grants.set(authorization, {
      id: request.id,
      ext: request.ext,
      sourceId: request.sourceId,
      sourceGeneration: request.sourceGeneration,
      order: background.nextOrder++,
      state: "reserved",
      restarted: false,
      fresh: 1,
      lastSequence: background.sequence,
      attempt: null,
    });
    return { authorization };
  },

  async authorize(request: {
    authorization: string;
    url: string;
    headers: Record<string, string>;
  }) {
    gate();
    const grant = background.grants.get(request.authorization);
    if (!grant || grant.state === "terminal") throw refused("ERR_DOWNLOADS_OBSOLETE");
    if (grant.state !== "reserved") return;
    if (!existsSync(folderOf(grant.id))) throw refused("ERR_DOWNLOADS_FOLDER");
    const anchor = background.anchors.get(grant.sourceId);
    if (anchor?.generation !== grant.sourceGeneration) throw refused("ERR_DOWNLOADS_OBSOLETE");
    background.requests.set(request.authorization, {
      sourceId: grant.sourceId,
      sourceGeneration: grant.sourceGeneration,
      url: request.url,
      headers: { ...request.headers },
    });
    if (!write()) throw refused("ERR_DOWNLOADS_UNAVAILABLE");
    grant.state = "queued";
    pump();
  },

  async cancelAuthorization(authorization: string, reason: "remove" | "abandon") {
    gate();
    const grant = background.grants.get(authorization);
    if (!grant) return fenceOf("already-terminal", authorization);
    if (reason === "abandon") {
      if (grant.state !== "reserved") throw refused("ERR_DOWNLOADS_INVALID");
      background.grants.delete(authorization);
      return { durable: "ledger" };
    }
    if (grant.state === "terminal") return fenceOf("already-terminal", authorization);
    background.removed.add(authorization);
    if (background.admitting === authorization) background.admitting = null;
    const task = background.task?.authorization === authorization ? background.task : null;
    if (write()) {
      grant.state = "terminal";
      grant.attempt = null;
      record(authorization, grant, { kind: "cancelled" }, task);
      background.requests.delete(authorization);
      if (background.resume.get(grant.id)?.authorization === authorization) {
        background.resume.delete(grant.id);
      }
      if (task) stopTask(task, "cancel");
      return fenceOf("ledger", authorization);
    }
    if (background.faults.keychainDelete) throw refused("ERR_DOWNLOADS_KEYCHAIN");
    background.requests.delete(authorization);
    if (background.resume.get(grant.id)?.authorization === authorization) {
      background.resume.delete(grant.id);
    }
    if (task) stopTask(task, "cancel");
    return { durable: "secrets", receipts: [], legacy: [] };
  },

  async drainDownload(id: string) {
    const task = background.task;
    if (task && background.grants.get(task.authorization)?.id === id) {
      if (!(await within(task.ended, 10_000))) throw refused("ERR_DOWNLOADS_BUSY");
    }
  },

  async acquirePlayback(request: { sourceId: string; lease: string }) {
    const { sourceId, lease } = request;
    if (background.retired.has(lease)) throw refused("ERR_DOWNLOADS_OBSOLETE");
    const known = background.leases.get(lease);
    if (known && known.sourceId !== sourceId) throw refused("ERR_DOWNLOADS_INVALID");
    if (known?.state === "granted") return { lease, providerDisconnect: "unobservable" };
    background.leases.set(lease, { sourceId, state: "acquiring" });
    if (
      background.admitting &&
      background.grants.get(background.admitting)?.sourceId === sourceId
    ) {
      background.admitting = null;
    }
    for (const stray of background.strays) stray.abort();
    const task = background.task?.sourceId === sourceId ? background.task : null;
    if (task) {
      stopTask(task, "pause");
      if (!(await within(task.ended, 5_000))) {
        stopTask(task, "cancel");
        if (!(await within(task.ended, 5_000))) {
          const now = background.leases.get(lease);
          if (now) now.state = "refused";
          throw refused("ERR_DOWNLOADS_UNKNOWN_CLOSURE", "A download's request may still be open.");
        }
      }
    }
    while (background.strays.size > 0) await new Promise((done) => setTimeout(done, 5));
    const begin = earliest(sourceId);
    while (Date.now() < begin) {
      await new Promise((done) => setTimeout(done, begin - Date.now()));
    }
    const now = background.leases.get(lease);
    if (!now || background.retired.has(lease)) throw refused("ERR_DOWNLOADS_OBSOLETE");
    now.state = "granted";
    return { lease, providerDisconnect: "unobservable" };
  },

  async releasePlayback(lease: string) {
    background.retired.add(lease);
    const known = background.leases.get(lease);
    background.leases.delete(lease);
    if (known?.state === "granted") background.closes.set(known.sourceId, Date.now());
    pump();
  },

  async reconcile(context: "first-foreground" | "background" | "ordinary") {
    recover();
    if (context === "first-foreground" && background.barrier.kind === "none") {
      background.barrier = { kind: "installed", token: fresh("f") };
    }
    while (background.strays.size > 0) await new Promise((done) => setTimeout(done, 5));
    pump();
    return snapshot();
  },

  async finishForegroundReconcile(token: string) {
    const { barrier } = background;
    if (barrier.kind === "installed" && barrier.token === token) {
      background.barrier = { kind: "finished", token };
      pump();
      return;
    }
    if (barrier.kind === "finished" && barrier.token === token) return;
    throw refused("ERR_DOWNLOADS_OBSOLETE");
  },

  async resetQueue(scope: { queueEpoch: string; knownSourceIds: string[] }) {
    const b = background;
    b.events.push("reset-attempt");
    if (scope.queueEpoch !== (b.corrupt || b.unavailable ? "q-process" : b.install)) {
      throw refused("ERR_DOWNLOADS_OBSOLETE");
    }
    const task = b.task;
    if (task) {
      stopTask(task, "cancel");
      if (!(await within(task.ended, 10_000))) throw refused("ERR_DOWNLOADS_UNKNOWN_CLOSURE");
    }
    if (b.faults.keychainDelete) throw refused("ERR_DOWNLOADS_KEYCHAIN");
    for (const source of scope.knownSourceIds) {
      b.anchors.delete(source);
      for (const [id, request] of b.requests)
        if (request.sourceId === source) b.requests.delete(id);
      for (const [id, resume] of b.resume) if (resume.sourceId === source) b.resume.delete(id);
    }
    b.legacy.clear();
    b.install = fresh("q");
    b.grants.clear();
    b.sources.clear();
    for (const source of scope.knownSourceIds) {
      b.sources.set(source, { generation: fresh("g"), state: "revoked" });
    }
    b.corrupt = false;
    b.removed.clear();
    b.fenced.clear();
    b.events.push("reset");
    return {
      kind: "reset",
      queueEpoch: b.install,
      preservedReceipts: [...b.receipts],
      legacy: [...b.legacyReceipts],
      unreadableFacts: false,
      legacyCleanup: "complete",
      cleanupScope: "known-sources-only",
    };
  },

  async acknowledge(receipts: readonly string[]) {
    if (background.corrupt) throw refused("ERR_DOWNLOADS_CORRUPT");
    const gone = new Set(receipts);
    const kept = background.receipts.filter((each) => !gone.has(each.receipt));
    background.receipts.splice(0, background.receipts.length, ...kept);
    const legacy = background.legacyReceipts.filter((each) => !gone.has(each.receipt));
    background.legacyReceipts.splice(0, background.legacyReceipts.length, ...legacy);
    const owed = new Set(kept.map((each) => each.authorization));
    for (const [id, grant] of background.grants) {
      if (grant.state === "terminal" && !owed.has(id) && background.task?.authorization !== id) {
        background.grants.delete(id);
      }
    }
    pump();
  },

  async forgetResume(id: string) {
    background.legacy.delete(id);
    const task = background.task;
    if (task && background.grants.get(task.authorization)?.id === id) return;
    background.resume.delete(id);
  },

  async importResume(id: string, url: string, data: string) {
    if (!background.legacy.has(id)) background.legacy.set(id, { url, data });
  },

  addListener(event: string, listener: (body: never) => void) {
    const listeners = background.listeners.get(event) ?? new Set();
    listeners.add(listener);
    background.listeners.set(event, listeners);
    return { remove: () => listeners.delete(listener) };
  },
};

const host: { expo?: { modules?: Record<string, unknown> } } = globalThis;
host.expo ??= {};
host.expo.modules ??= {};
host.expo.modules["BackgroundDownloads"] = module;
