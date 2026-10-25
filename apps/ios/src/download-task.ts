import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";

// The app's own native owner of downloads' transfers, modules/background-downloads, for
// downloads.ts and account.ts. It runs one background URLSession and is its only scheduler: it
// chooses what transfers next, one task at a time, while the app is open or not, and hands the
// next task to iOS before a background wake is answered. The bytes go from URLSession to the file
// without passing through JavaScript.
//
// A download's record (downloads.ts) reserves an authorization for its exact file, writes it on
// itself, then arms it with the file's request; the native side moves only an armed
// authorization's file into `Documents/downloads/<id>/media.<ext>`, and writes down how each
// ended as a receipt, kept until acknowledged after the record says what it means. Each
// subscription's authority is a generation the account owner enables and revokes (account.ts),
// fenced durably before a login changes: a revoked generation's requests are never dispatched or
// published again. A stream takes its subscription's connection with a process-memory lease
// (`acquirePlayback`) and gives it back once its readers closed (`releasePlayback`).
//
// Requests, headers and resume data stay native, in the Keychain; nothing here holds an address
// once given, and no receipt or answer holds one, nor the system's words. What the native side
// answers is parsed here before anything acts on it; events are hints for the screens, what
// `reconcile` answers is what counts.

const Count = lazy(() => type("number.integer >= 0"));
const Size = lazy(() => type("number.integer >= 0 | null"));

const OutcomeV2 = lazy(() =>
  type({ kind: "'complete'", size: Count(), expected: Size() })
    .or({ kind: "'paused'", resumable: "boolean" })
    .or({ kind: "'cancelled'" })
    .or({ kind: "'refused'", status: "number.integer" })
    .or({ kind: "'folder'" })
    .or({ kind: "'disk-full'", needed: "number | null" })
    .or({ kind: "'network'", code: "number.integer", resumable: "boolean" })
    .or({ kind: "'refresh'", reason: "'source' | 'secret-missing' | 'resume-unusable'" }),
);
/** How an authorization's request ended. */
export type OutcomeV2 = Infer<typeof OutcomeV2>;

const ReceiptV2 = lazy(() =>
  type({
    version: "2",
    receipt: "string",
    authorization: "string",
    attempt: "string | null",
    /** The download it was for. */
    id: "string",
    sequence: Count(),
    received: Size(),
    expected: Size(),
    restarted: "boolean",
    outcome: OutcomeV2(),
  }),
);
/** One authorization's ending, until it is acknowledged. */
export type ReceiptV2 = Infer<typeof ReceiptV2>;

const LegacyOutcome = lazy(() =>
  type({ kind: "'complete'", size: "number", expected: "number | null" })
    .or({ kind: "'paused'", resumable: "boolean" })
    .or({ kind: "'cancelled' | 'folder'" })
    .or({ kind: "'refused'", status: "number" })
    .or({ kind: "'network'", code: "number", resumable: "boolean" }),
);
const LegacyReceipt = lazy(() =>
  type({ receipt: "string", attempt: "string", id: "string", outcome: LegacyOutcome() }),
);
/** A build-14 attempt's ending, taken in with build 14's meanings. */
export type LegacyReceipt = Infer<typeof LegacyReceipt>;

const AuthorizationView = lazy(() =>
  type({
    authorization: "string",
    id: "string",
    sourceId: "string",
    sourceGeneration: "string",
    state: "'reserved' | 'queued' | 'active' | 'paused' | 'terminal'",
    sequence: Count(),
    attempt: "string | null",
    received: Size(),
    expected: Size(),
    restarted: "boolean",
    resumed: "boolean",
  }),
);
export type AuthorizationView = Infer<typeof AuthorizationView>;

/** Receipts that read, and how many didn't: one bad entry hides no other. */
function readable<T>(parse: (value: unknown) => T | type.errors, values: unknown): T[] {
  return (Array.isArray(values) ? values : []).flatMap((value) => {
    const parsed = parse(value);
    return parsed instanceof type.errors ? [] : [parsed];
  });
}

const Envelope = lazy(() =>
  type({
    version: "2",
    queueEpoch: "string",
    sequence: Count(),
    foregroundToken: "string | null",
    blocked: "'none' | 'locked' | 'storage' | 'corrupt' | 'capacity' | 'recovering'",
    sources: "string[]",
    authorizations: "unknown[]",
    receipts: "unknown[]",
    legacy: { receipts: "unknown[]" },
  }),
);

/** The native queue at one moment. */
export interface Snapshot {
  readonly queueEpoch: string;
  /** This process's first-foreground barrier, once installed. */
  readonly foregroundToken: string | null;
  /**
   * What holds the queue back: `corrupt` is damaged native authority, the only state a reset
   * repairs; `locked`, `storage`, `capacity` and `recovering` pass on their own.
   */
  readonly blocked: "none" | "locked" | "storage" | "corrupt" | "capacity" | "recovering";
  /** Source ids the queue names, for the scope of a reset. */
  readonly sources: readonly string[];
  readonly authorizations: readonly AuthorizationView[];
  readonly receipts: readonly ReceiptV2[];
  readonly legacy: readonly LegacyReceipt[];
}

const Observation = lazy(() =>
  type({
    state: "'enabled' | 'revoked' | 'missing' | 'fenced' | 'blocked'",
    generation: "string | null",
    expected: { queueEpoch: "string", expected: "string" },
  }),
);
/**
 * How a source's download authority stands: enabled under a generation, or not; `expected` is
 * what the next enable or revoke must name.
 */
export type Observation = Infer<typeof Observation>;

/** What a removal or revoke established: `durable` names the fence actually made. */
export interface Fence {
  readonly durable: "ledger" | "secrets" | "already-terminal";
  readonly receipts: readonly ReceiptV2[];
  readonly legacy: readonly LegacyReceipt[];
}

/** Bytes on disk so far for an authorization, and the whole file's size, null until known. */
export interface Progress {
  readonly authorization: string;
  readonly id: string;
  readonly received: number;
  readonly expected: number | null;
  readonly restarted: boolean;
  readonly resumed: boolean;
}

const ProgressEvent = lazy(() =>
  type({
    version: "2",
    authorization: "string",
    id: "string",
    received: Count(),
    expected: Size(),
    restarted: "boolean",
    resumed: "boolean",
  }),
);

/** How a reset ended when it did. */
export interface Reset {
  readonly queueEpoch: string;
  readonly receipts: readonly ReceiptV2[];
  readonly legacy: readonly LegacyReceipt[];
  /** Whether some fact of the damaged queue couldn't be read, so may be lost. */
  readonly unreadableFacts: boolean;
}

/** Why the native side refused a command, as its rejection's `code` says. */
export type Refusal =
  | "invalid"
  | "busy"
  | "unavailable"
  | "corrupt"
  | "keychain"
  | "folder"
  | "obsolete"
  | "capacity"
  | "unknown-closure";

interface Subscription {
  remove(): void;
}

interface Native {
  sourceState(sourceId: string): Promise<unknown>;
  enableSource(command: SourceCommand): Promise<{ generation: string }>;
  revokeSource(command: SourceCommand): Promise<unknown>;
  reserve(request: {
    id: string;
    ext: string;
    sourceId: string;
    sourceGeneration: string;
  }): Promise<{ authorization: string }>;
  authorize(request: {
    authorization: string;
    url: string;
    headers: Record<string, string>;
  }): Promise<void>;
  cancelAuthorization(authorization: string, reason: "remove" | "abandon"): Promise<unknown>;
  drainDownload(id: string): Promise<void>;
  acquirePlayback(request: { sourceId: string; lease: string }): Promise<unknown>;
  releasePlayback(lease: string): Promise<void>;
  reconcile(context: "first-foreground" | "background" | "ordinary"): Promise<unknown>;
  finishForegroundReconcile(token: string): Promise<void>;
  resetQueue(scope: { queueEpoch: string; knownSourceIds: string[] }): Promise<unknown>;
  acknowledge(receipts: readonly string[]): Promise<void>;
  forgetResume(id: string): Promise<void>;
  importResume(id: string, url: string, data: string): Promise<void>;
  addListener(event: "progress" | "receipt", listener: (body: unknown) => void): Subscription;
}

interface SourceCommand {
  readonly sourceId: string;
  readonly queueEpoch: string;
  readonly expected: string;
}

const REFUSALS: Readonly<Record<string, Refusal>> = {
  ERR_DOWNLOADS_INVALID: "invalid",
  ERR_DOWNLOADS_BUSY: "busy",
  ERR_DOWNLOADS_UNAVAILABLE: "unavailable",
  ERR_DOWNLOADS_CORRUPT: "corrupt",
  ERR_DOWNLOADS_KEYCHAIN: "keychain",
  ERR_DOWNLOADS_FOLDER: "folder",
  ERR_DOWNLOADS_OBSOLETE: "obsolete",
  ERR_DOWNLOADS_CAPACITY: "capacity",
  ERR_DOWNLOADS_UNKNOWN_CLOSURE: "unknown-closure",
};

/** What a rejection of the native side says, or null when it isn't one of its refusals. */
export function refusalOf(cause: unknown): Refusal | null {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  return REFUSALS[code] ?? null;
}

/** A refusal of this side's own, as the native side words them. */
const refused = (refusal: Refusal) =>
  Object.assign(new Error("The downloads refused the command."), {
    code: Object.keys(REFUSALS).find((code) => REFUSALS[code] === refusal),
  });

let found: Native | null = null;
/**
 * The native module, found where Expo installs every module before the app's JavaScript runs, as
 * `requireNativeModule` finds it first; null in a build without it, which holds no download
 * authority. Looked up on first use, so the tests, which run in Node without Expo, load the
 * account owner without it.
 */
function lookup(): Native | null {
  const host: { expo?: { modules?: { BackgroundDownloads?: Native } } } = globalThis;
  found ??= host.expo?.modules?.BackgroundDownloads ?? null;
  return found;
}

function native(): Native {
  const module = lookup();
  if (!module) throw refused("unavailable");
  return module;
}

/**
 * Settles within `ms` however the bridge behaves: a late answer is dropped. The native side
 * refuses on its own deadline first; this one only keeps an account change from waiting forever.
 */
function bounded<A>(work: Promise<A>, ms = 6_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(refused("busy")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function parsed<T>(parse: (value: unknown) => T | type.errors, value: unknown): T {
  const result = parse(value);
  if (result instanceof type.errors) throw refused("corrupt");
  return result;
}

function fenceOf(value: unknown): Fence {
  const body = typeof value === "object" && value !== null ? value : {};
  const durable = "durable" in body ? body.durable : null;
  if (durable !== "ledger" && durable !== "secrets" && durable !== "already-terminal") {
    throw refused("corrupt");
  }
  return {
    durable,
    receipts: readable(ReceiptV2(), "receipts" in body ? body.receipts : []),
    legacy: readable(LegacyReceipt(), "legacy" in body ? body.legacy : []),
  };
}

export const transfers = {
  /** Whether this build has the native owner at all. */
  available: (): boolean => lookup() !== null,
  /** How `sourceId`'s authority stands; refused within five seconds. */
  sourceState: async (sourceId: string): Promise<Observation> =>
    parsed(Observation(), await bounded(native().sourceState(sourceId))),
  /** Enables `sourceId` under a fresh generation, while it stands as `observed`. */
  enableSource: async (sourceId: string, observed: Observation): Promise<string> => {
    const { generation } = await bounded(native().enableSource({ sourceId, ...observed.expected }));
    if (typeof generation !== "string") throw refused("corrupt");
    return generation;
  },
  /** Revokes `sourceId` durably, while it stands as `observed`; never waits for a task. */
  revokeSource: async (sourceId: string, observed: Observation): Promise<Fence> =>
    fenceOf(await bounded(native().revokeSource({ sourceId, ...observed.expected }))),
  /** Reserves an authorization for download `id`'s exact file, under `sourceGeneration`. */
  reserve: async (request: {
    readonly id: string;
    readonly ext: string;
    readonly sourceId: string;
    readonly sourceGeneration: string;
  }): Promise<string> => {
    const { authorization } = await native().reserve({ ...request });
    if (typeof authorization !== "string") throw refused("corrupt");
    return authorization;
  },
  /** Arms a reserved authorization with the file's request, login included. */
  authorize: async (
    authorization: string,
    file: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
  ): Promise<void> =>
    native().authorize({ authorization, url: file.url, headers: { ...file.headers } }),
  /**
   * Removes an authorization for good, answering once its fence is durable, never once its task
   * closed; or, with `abandon`, retires a reservation never armed.
   */
  cancelAuthorization: async (
    authorization: string,
    reason: "remove" | "abandon" = "remove",
  ): Promise<Fence> => {
    const answer = await bounded(native().cancelAuthorization(authorization, reason));
    return reason === "abandon" ? { durable: "ledger", receipts: [], legacy: [] } : fenceOf(answer);
  },
  /** Resolves once no task or publication of download `id` is left; refuses after ten seconds. */
  drainDownload: async (id: string): Promise<void> => bounded(native().drainDownload(id), 12_000),
  /**
   * Takes `sourceId`'s connection for stream `lease`: resolves once its download requests ended
   * and the provider had its grace. Process memory only.
   */
  acquirePlayback: async (sourceId: string, lease: string): Promise<void> => {
    await native().acquirePlayback({ sourceId, lease });
  },
  /** Gives stream `lease`'s connection back. Again, or before it was granted, is harmless. */
  releasePlayback: async (lease: string): Promise<void> => native().releasePlayback(lease),
  /** The queue at one moment; the first foreground reconcile installs the barrier first. */
  reconcile: async (context: "first-foreground" | "background" | "ordinary"): Promise<Snapshot> => {
    const body = parsed(Envelope(), await native().reconcile(context));
    return {
      queueEpoch: body.queueEpoch,
      foregroundToken: body.foregroundToken,
      blocked: body.blocked,
      sources: body.sources,
      authorizations: readable(AuthorizationView(), body.authorizations),
      receipts: readable(ReceiptV2(), body.receipts),
      legacy: readable(LegacyReceipt(), body.legacy.receipts),
    };
  },
  finishForegroundReconcile: async (token: string): Promise<void> =>
    native().finishForegroundReconcile(token),
  /** Starts a damaged queue over, in the foreground, scoped to `knownSourceIds`. */
  resetQueue: async (scope: {
    readonly queueEpoch: string;
    readonly knownSourceIds: readonly string[];
  }): Promise<Reset> => {
    // The native side refuses within fifteen seconds; this keeps a lost answer from holding the
    // first foreground forever.
    const body = await bounded(
      native().resetQueue({ ...scope, knownSourceIds: [...scope.knownSourceIds] }),
      20_000,
    );
    const answer = typeof body === "object" && body !== null ? body : {};
    const epoch = "queueEpoch" in answer ? answer.queueEpoch : null;
    if (!("kind" in answer) || answer.kind !== "reset" || typeof epoch !== "string") {
      throw refused("corrupt");
    }
    return {
      queueEpoch: epoch,
      receipts: readable(
        ReceiptV2(),
        "preservedReceipts" in answer ? answer.preservedReceipts : [],
      ),
      legacy: readable(LegacyReceipt(), "legacy" in answer ? answer.legacy : []),
      unreadableFacts: "unreadableFacts" in answer && answer.unreadableFacts === true,
    };
  },
  /** Forgets receipts written down; other receipts stay. */
  acknowledge: async (receipts: readonly string[]): Promise<void> => native().acknowledge(receipts),
  /** Removes a download's resume data. */
  forgetResume: async (id: string): Promise<void> => native().forgetResume(id),
  /** Takes resume data an earlier build kept, unless the download has newer. */
  importResume: async (id: string, url: string, data: string): Promise<void> =>
    native().importResume(id, url, data),
  onProgress(listener: (progress: Progress) => void): Subscription {
    return native().addListener("progress", (body) => {
      const progress = ProgressEvent()(body);
      if (!(progress instanceof type.errors)) listener(progress);
    });
  },
  onReceipt(listener: (receipt: ReceiptV2) => void): Subscription {
    return native().addListener("receipt", (body) => {
      const receipt = ReceiptV2()(body);
      if (!(receipt instanceof type.errors)) listener(receipt);
    });
  },
};
