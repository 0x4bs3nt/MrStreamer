import { type } from "arktype";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { RawTitleRef, type TitleRef } from "@mrstreamer/contracts/ondemand";
import { t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { Directory, File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { currentRoster, members, onRoster } from "./account.ts";
import {
  transfers,
  type Outcome,
  type Progress,
  type Receipt,
  type Running,
  type StartRequest,
} from "./download-task.ts";
import { appError, describeError, statusFailure } from "./errors.ts";
import { readJson, writeJson } from "./files.ts";
import { onReclaim, play, playbackState, playingItem, stop, type Playing } from "./playback.ts";
import { keychainSecrets } from "./secrets.ts";
import { currentSource, sourceOf } from "./sources.ts";
import { store, useStore } from "./store.ts";
import { detailsOf, episodesOf, titleFile, titleLists, titleOf } from "./titles.ts";
import { recordProgress } from "./viewing.ts";

// Movies and episodes downloaded to this iPhone: the queue, its one transfer at a time, and the
// copies that play with no provider, as the desktop's downloads do. This module alone writes
// downloads.json and the folders in Documents/downloads, and alone decides what a transfer's end
// means for its download.
//
// A download names the exact provider file by its subscription and the provider's own ids, so
// two providers' titles of one id never meet. Its record holds what the copy shows and plays
// with: details, artwork kept in its folder, the file type, how far it got and how far it was
// watched. No record holds an address, a header, a login or resume data. The file's address is
// made from the subscription's login only as a transfer starts (`sources.ts`).
//
// One download transfers at a time, by `download-task.ts`: the app's native owner of a background
// URLSession. A transfer under way goes on while the app is in the background or suspended, and
// after iOS ends the app's process. The queue starts the next only while the app is in the
// foreground (AppState "active"); a transfer that ends in the background waits there for the app
// to open again. This is not the desktop's queue, which goes on through the whole list.
//
// Each request is an attempt, written down on its record before it starts; only that attempt's
// ending (a receipt) changes the record, and the receipt is acknowledged once the record says
// what it means, so an ending is never lost nor taken twice. At launch, nothing asks a provider
// for a file or a stream, and nothing is cleaned up, until the subscriptions are read and every
// request the native side has is accounted for: the one under way of a queued download goes on as
// its transfer, any other is cancelled and has ended, and every receipt is taken in.
//
// A stream of the same subscription takes the connection back first: the transfer pauses, and its
// request has ended before the stream's goes out (`onReclaim`). When it doesn't end in time, the
// stream fails rather than ask the provider for a second connection. It waits until nothing of
// that subscription streams; another subscription's stream, or a copy, lets it go on. A provider
// can take a moment to free the connection of a request that ended, so the next request of that
// subscription, a stream's, the queue's next download or a transfer's fresh start after its
// resumed request was refused, waits until `RELEASE_MS` after this app's last one ended; after
// requests that ended while nobody watched, every subscription waits that long from launch.
//
// Resume data stays with the native side, in the Keychain: a pause keeps it, as does a request
// that broke when URLSession gives any, so the transfer goes on from there; when it can't, it
// starts again and says so (`restarted`). A request that breaks while the app is open fails, and
// its Retry goes on from there. Resume data an earlier build kept in `download:<id>` is handed to
// the native side at launch, then removed.
//
// A copy is complete only once the native side moved every byte into place and the size matches
// what the server announced, of the whole file. A file left beside an unfinished record is
// deleted before its download starts again. Removing a subscription ends its unfinished
// downloads, with their files and resume data; its copies stay and play, keeping their own
// progress.

const FILE = "downloads.json";
/** Documents/downloads, which modules/downloads-folder keeps out of backups. */
const ROOT = "downloads";
/** How often transfer progress reaches the screens, at most. */
const PROGRESS_MS = 250;
/** How often a transfer's progress is written down. */
const SAVE_MS = 5000;
/**
 * How long a stream waits for a download to pause before it is cancelled instead, and then for
 * the cancel, before the stream fails.
 */
const RECLAIM_MS = 5000;
/**
 * How long after this app's request of a subscription ended its next one waits, while the
 * provider frees the connection. The desktop's fake panel takes 300 ms; real ones aren't measured.
 */
const RELEASE_MS = 1000;
const ARTWORK_MS = 20_000;
/** A download's id: also its folder's name. */
const ID = /^d-[a-z0-9-]+$/;
/** NSURLErrorDomain codes that mean the iPhone has no connection at all. */
const OFFLINE = new Set([-1009, -1018, -1020]);

const About = lazy(() =>
  type({
    /** The movie's or the series' name. */
    name: "string",
    episodeName: "string | null",
    year: "number | null",
    /** Seconds, as the details said. */
    duration: "number | null",
    originalLanguage: "string | null",
  }),
);

const Failure = lazy(() =>
  type({ kind: "'disk-full'", needed: "number | null" })
    .or({ kind: "'folder'", detail: "string" })
    .or({
      kind: "'stream'",
      failure: type({ kind: "'refused' | 'unavailable' | 'provider-error'", status: "number" }).or({
        kind: "'network' | 'unsupported'",
        detail: "string",
      }),
    })
    .or({ kind: "'app'", error: { kind: "'unexpected'", detail: "string" } }),
);

const Stored = lazy(() =>
  type({
    id: ID,
    /** The subscription it came from, kept after it was removed: a copy's history stays its. */
    subscriptionId: "string > 0",
    title: RawTitleRef(),
    /** The provider's file type, from when it was queued: the copy's file is named by it. */
    container: "string",
    about: About(),
    /** Pictures kept in its folder. */
    artwork: { poster: "boolean", wide: "boolean" },
    /** A transfer under way is `queued` on disk: a launch finds it again, or starts it again. */
    state: "'queued' | 'failed' | 'complete'",
    "failure?": Failure(),
    /** The whole file's bytes once the server said; once complete, the bytes on disk. */
    size: "number | null",
    /** Bytes received when it last paused or was written down. */
    received: "number",
    restarted: "boolean",
    /** The last transfer attempt it authorized: only that attempt's ending changes it. */
    "attempt?": "string",
    addedAt: "number",
    completedAt: "number | null",
    /** How far the copy was watched here. */
    progress: type({ position: "number", duration: "number", at: "number" }).or("null"),
  }),
);
type Stored = Infer<typeof Stored>;
/** Why a download stopped, of the kinds this module writes down. */
type StoredFailure = NonNullable<Stored["failure"]>;

const Document = lazy(() =>
  type({
    version: "1",
    items: "object[]",
    /** Ids whose resume data still has to go: launch removes it. */
    forgetting: "string[]",
  }),
);

interface Doc {
  readonly items: readonly Stored[];
  readonly forgetting: readonly string[];
  /** Entries this build can't read, kept as they are with their folders. */
  readonly unreadable: readonly object[];
}

/** What an earlier build kept in `download:<id>`: the address its resume data was made for. */
const Legacy = lazy(() => type({ url: "string", resumeData: "string" }));

/** The transfer under way. */
interface Active {
  readonly id: string;
  readonly subscriptionId: string;
  /** Its native attempt once authorized: that attempt's receipt alone ends it. */
  attempt: string | null;
  /** Why this side asked it to stop, which decides what its end means. */
  stopping: "pause" | "cancel" | null;
  /** The bytes the disk lacks for the rest, when that stopped it. */
  short: number | null;
  received: number;
  size: number | null;
  /** Bytes the record had as the attempt started, and whether it goes on from them. */
  from: number;
  resumed: boolean;
  /** No progress of the attempt heard yet. */
  fresh: boolean;
  rate: number | null;
  measured: { at: number; received: number };
  savedAt: number;
  restarted: boolean;
  /** Settles once it asks the provider nothing more: its last request ended, or it stopped. */
  closed: Promise<void>;
  /** Settles once how it ended is written down. */
  over: Promise<void>;
}

/** How a transfer ended, as this module takes it in. */
type Ending =
  /** Its attempt's request ended, as the receipt says. */
  | { readonly kind: "ended"; readonly receipt: Receipt }
  /** It never asked the provider: stopped first, or its subscription isn't signed in. */
  | { readonly kind: "stopped" }
  | { readonly kind: "failed"; readonly failure: StoredFailure };

const EMPTY: DownloadList = { items: [], bytes: 0, free: null, ended: 0 };
const list = store<DownloadList>(EMPTY);

/** Every download, queue first in the order added, then the copies, newest first. */
export const useDownloads = () => useStore(list);
/** The list as it stands, for owners outside React. */
export const downloadList = () => list.get();
/** Calls `listener` whenever the list changes. */
export const onDownloads = (listener: () => void) => list.subscribe(listener);

let doc: Doc = { items: [], forgetting: [], unreadable: [] };
/** downloads.json read as this build writes it: only then are folders it doesn't name removed. */
let trusted = false;
let started = false;
let active: Active | null = null;
/** The app is in the foreground: only then does the queue start a transfer. */
let foreground = false;
/**
 * Whether the native side's requests and endings are taken in. Until "ready", nothing asks a
 * provider for a file or a stream, and nothing is removed; "failed" is tried again in the
 * foreground.
 */
let phase: "starting" | "ready" | "failed" = "starting";
let readiness: Promise<void> = Promise.resolve();
/** Copies whose file was gone when last looked. */
const missing = new Set<string>();
/** Unfinished downloads that ended with their subscription since launch. */
let ended = 0;
let made = 0;
let attempts = 0;
/** When this app's last request of each subscription ended, a download's or a stream's. */
const released = new Map<string, number>();
/** When requests that ended while nobody watched were found: every subscription waits after it. */
let releasedAll = -Infinity;
/** The subscriptions whose connections playback held when it last changed. */
let streaming: ReadonlySet<string> = new Set();
/** Wakes the queue once a subscription's connection had time to be freed. */
let later: ReturnType<typeof setTimeout> | null = null;
/** Who waits for each attempt's receipt. */
const awaited = new Map<string, (receipt: Receipt) => void>();
/** Receipts heard before the downloads were ready, by receipt. */
const early = new Map<string, Receipt>();
/** Receipts being taken in, by receipt: an event and a reconcile may bring the same one. */
const taking = new Set<string>();
/** Downloads whose earlier build's resume data couldn't be read: they wait for the next launch. */
const held = new Set<string>();

const folderOf = (id: string) => new Directory(Paths.document, ROOT, id);
/** A file type safe to name a file with; anything else is kept as "bin", as on the desktop. */
const extensionOf = (container: string) =>
  /^[a-z0-9]{1,8}$/i.test(container) ? container.toLowerCase() : "bin";
const mediaOf = (record: Stored) =>
  new File(folderOf(record.id), `media.${extensionOf(record.container)}`);
const artworkOf = (id: string, artwork: "poster" | "wide") => new File(folderOf(id), artwork);
/** An earlier build's Keychain item of a download's resume data. */
const secretOf = (id: string) => `download:${id}`;
/** What the player names a copy by. */
const copyKey = (id: string) => `copy:${id}`;

const find = (id: string) => doc.items.find((record) => record.id === id);
const sameTitle = (record: Stored, ref: TitleRef) =>
  record.subscriptionId === ref.subscriptionId &&
  record.title.kind === ref.kind &&
  record.title.id === ref.id;

/** Writes `next` whole, then keeps it. Throws, keeping the last, when Documents won't take it. */
function commit(next: Doc) {
  writeJson(FILE, {
    version: 1,
    items: [...next.items, ...next.unreadable],
    forgetting: next.forgetting,
  });
  doc = next;
}

/** Changes a download's record as it is now; one removed meanwhile stays removed. */
function update(id: string, change: (record: Stored) => Stored, forget = false) {
  const record = find(id);
  if (!record) return;
  commit({
    ...doc,
    items: doc.items.map((each) => (each === record ? change(record) : each)),
    forgetting: forget ? [...doc.forgetting.filter((each) => each !== id), id] : doc.forgetting,
  });
}

/**
 * Removes a download's resume data, the native side's and an earlier build's, keeping its id
 * listed for the next launch until both are gone.
 */
async function forget(id: string) {
  try {
    await transfers.forgetResume(id);
    await keychainSecrets.remove(secretOf(id));
    if (doc.forgetting.includes(id)) {
      commit({ ...doc, forgetting: doc.forgetting.filter((each) => each !== id) });
    }
  } catch {
    // Listed in `forgetting`: the next launch removes it.
  }
}

/** An earlier build's resume data of a download; rejects when the Keychain won't answer. */
async function readLegacy(id: string): Promise<Infer<typeof Legacy> | null> {
  const saved = await keychainSecrets.read(secretOf(id));
  if (!saved) return null;
  try {
    const parsed = Legacy()(JSON.parse(saved));
    if (!(parsed instanceof type.errors)) return parsed;
  } catch {
    // Not resume data: as good as none.
  }
  await keychainSecrets.remove(secretOf(id));
  return null;
}

function freeBytes(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/**
 * The subscriptions whose provider connection playback holds: the one whose stream plays or is
 * opening, and any whose format session let go of its stream but hasn't closed its request yet,
 * which another subscription's play doesn't hide.
 */
function borrowed(): ReadonlySet<string> {
  const { phase, closing } = playbackState.get();
  const busy = new Set(closing);
  if (phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused") {
    if (phase.item.subscriptionId !== null) busy.add(phase.item.subscriptionId);
  }
  return busy;
}

function viewOf(
  record: Stored,
  names: ReadonlyMap<string, string>,
  busy: ReadonlySet<string>,
): Download {
  const name = names.get(record.subscriptionId);
  const transferring = active?.id === record.id ? active : null;
  return {
    id: record.id,
    title: record.title,
    subscription: name === undefined ? null : { id: record.subscriptionId, name },
    name: record.about.name,
    episodeName: record.about.episodeName,
    year: record.about.year,
    duration: record.about.duration,
    originalLanguage: record.about.originalLanguage,
    posterUrl: record.artwork.poster ? artworkOf(record.id, "poster").uri : null,
    wideUrl: record.artwork.wide ? artworkOf(record.id, "wide").uri : null,
    size: transferring ? transferring.size : record.size,
    status:
      record.state === "complete"
        ? { kind: missing.has(record.id) ? "missing" : "complete" }
        : record.state === "failed"
          ? {
              kind: "failed",
              failure: record.failure ?? {
                kind: "app",
                error: { kind: "unexpected", detail: "This download stopped." },
              },
            }
          : transferring
            ? {
                kind: "transferring",
                received: transferring.received,
                size: transferring.size,
                rate: transferring.rate,
                restarted: transferring.restarted,
              }
            : busy.has(record.subscriptionId)
              ? { kind: "waiting" }
              : { kind: "queued" },
    progress: record.progress && {
      position: record.progress.position,
      duration: record.progress.duration,
    },
  };
}

function view(): DownloadList {
  const names = new Map(members().map((member) => [member.entry.id, member.label]));
  const busy = borrowed();
  const queue = doc.items.filter((record) => record.state !== "complete");
  const copies = doc.items
    .filter((record) => record.state === "complete")
    .toSorted((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return {
    items: [...queue, ...copies].map((record) => viewOf(record, names, busy)),
    bytes: doc.items.reduce(
      (sum, record) =>
        sum +
        (active?.id === record.id
          ? active.received
          : record.state === "complete"
            ? (record.size ?? 0)
            : 0),
      0,
    ),
    free: freeBytes(),
    ended,
  };
}

let telling: ReturnType<typeof setTimeout> | null = null;
/** Tells the screens now. */
function tell() {
  if (telling) clearTimeout(telling);
  telling = null;
  list.set(view());
}
/** Tells the screens of progress, a few times a second at most. */
function tellSoon() {
  telling ??= setTimeout(tell, PROGRESS_MS);
}

/** Looks for copies whose file is gone. */
function look() {
  missing.clear();
  for (const record of doc.items) {
    if (record.state === "complete" && !mediaOf(record).exists) missing.add(record.id);
  }
}

/** Asks the transfer to stop; a cancel overrides a pause asked before it. */
function halt(transferring: Active, why: "pause" | "cancel") {
  if (transferring.stopping === "cancel" || transferring.stopping === why) return;
  transferring.stopping = why;
  const { attempt } = transferring;
  if (!attempt) return;
  const asked = why === "cancel" ? transfers.cancel(attempt) : transfers.pause(attempt);
  // Its receipt says how it ended.
  void asked.catch(() => undefined);
}

/** Milliseconds until a request of `subscriptionId` may go out, after the last of ours ended. */
function freeing(subscriptionId: string): number {
  const at = Math.max(released.get(subscriptionId) ?? -Infinity, releasedAll);
  return Number.isFinite(at) ? Math.max(0, at + RELEASE_MS - Date.now()) : 0;
}

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts the first download the queue can have now, unless one transfers. */
function wake() {
  if (phase !== "ready" || active || !foreground) return;
  const busy = borrowed();
  const ready = doc.items.filter(
    (record) =>
      record.state === "queued" &&
      !busy.has(record.subscriptionId) &&
      !held.has(record.id) &&
      currentSource(record.subscriptionId) !== undefined,
  );
  const next = ready.find((record) => freeing(record.subscriptionId) === 0);
  if (next) return begin(next);
  // Only subscriptions whose connection is still being freed: the queue looks again then.
  const wait = Math.min(...ready.map((record) => freeing(record.subscriptionId)));
  if (!Number.isFinite(wait)) return;
  if (later) clearTimeout(later);
  later = setTimeout(() => {
    later = null;
    wake();
  }, wait);
}

function activeOf(record: Stored, attempt: string | null): Active {
  return {
    id: record.id,
    subscriptionId: record.subscriptionId,
    attempt,
    stopping: null,
    short: null,
    received: record.received,
    size: record.size,
    from: record.received,
    resumed: record.received > 0,
    fresh: true,
    rate: null,
    measured: { at: Date.now(), received: record.received },
    savedAt: Date.now(),
    restarted: record.restarted,
    closed: Promise.resolve(),
    over: Promise.resolve(),
  };
}

function begin(record: Stored) {
  const transferring = activeOf(record, null);
  active = transferring;
  tell();
  follow(transferring, run(record, transferring));
}

/** Takes a request found under way at launch as the transfer of its queued download. */
function adopt(record: Stored, running: Running) {
  const transferring = activeOf(record, running.attempt);
  if (running.received !== null) transferring.received = running.received;
  if (running.expected !== null) transferring.size = running.expected;
  active = transferring;
  follow(
    transferring,
    receiptOf(running.attempt, record.subscriptionId).then((receipt) => ({
      kind: "ended",
      receipt,
    })),
  );
}

/** Writes down how `work` ends, then lets the queue go on. */
function follow(transferring: Active, work: Promise<Ending>) {
  const ran = work.catch((cause: unknown): Ending => {
    const error = appError(cause);
    return {
      kind: "failed",
      failure: { kind: "app", error: { kind: "unexpected", detail: describeError(error) } },
    };
  });
  transferring.closed = ran.then(() => undefined);
  transferring.over = ran
    .then((ending) => settle(transferring, ending))
    .catch((cause: unknown) => {
      // Its end couldn't be written down. Failed as far as this run knows, so the queue doesn't
      // take it again and again; the file, and an unacknowledged receipt, say what it was for the
      // next launch.
      doc = {
        ...doc,
        items: doc.items.map((each) =>
          each.id === transferring.id && each.state === "queued"
            ? { ...each, state: "failed", failure: { kind: "folder", detail: messageOf(cause) } }
            : each,
        ),
      };
    })
    .finally(() => {
      if (active === transferring) active = null;
      tell();
      wake();
    });
}

/** The receipt of `attempt`, once its request ended. */
function receiptOf(attempt: string, subscriptionId: string): Promise<Receipt> {
  return new Promise<Receipt>((resolve) => awaited.set(attempt, resolve)).then((receipt) => {
    // The provider may still be freeing the connection of the request that just ended.
    released.set(subscriptionId, Date.now());
    return receipt;
  });
}

/** Resume data the provider or URLSession wouldn't go on from. */
const unusable = (outcome: Outcome) =>
  outcome.kind === "refused" || (outcome.kind === "network" && !outcome.resumable);

/** Asks the provider for `record`'s file and has the native side write it into its folder. */
async function run(record: Stored, transferring: Active): Promise<Ending> {
  const source = currentSource(record.subscriptionId);
  if (!source || transferring.stopping) return { kind: "stopped" };
  const { title } = record;
  const file = await source.provider.titleFile(
    title.kind,
    title.id,
    record.container,
    AbortSignal.timeout(20_000),
  );
  if (transferring.stopping) return { kind: "stopped" };
  const media = mediaOf(record);
  try {
    folderOf(record.id).create({ intermediates: true, idempotent: true });
    // Left by an attempt never written down as complete: there is no proof it is whole.
    if (media.exists) media.delete();
  } catch (cause) {
    return { kind: "failed", failure: { kind: "folder", detail: messageOf(cause) } };
  }
  const free = freeBytes();
  if (record.size !== null && free !== null) {
    const needed = record.size - record.received;
    if (free < needed) return { kind: "failed", failure: { kind: "disk-full", needed } };
  }
  if (transferring.stopping) return { kind: "stopped" };
  const request = {
    id: record.id,
    ext: extensionOf(record.container),
    url: file.url,
    headers: { ...file.headers },
  };
  const first = await attempt(record, transferring, request);
  if (first.kind !== "ended" || !transferring.resumed || transferring.stopping) return first;
  if (!unusable(first.receipt.outcome)) return first;
  // Once more from the start, before anything counts as failed. Its record is as it was, so the
  // receipt is acknowledged as it stands.
  await transfers.forgetResume(record.id);
  await transfers.acknowledge([first.receipt.receipt]);
  await after(freeing(record.subscriptionId));
  if (transferring.stopping || currentSource(record.subscriptionId) !== source) {
    return { kind: "stopped" };
  }
  return attempt(record, transferring, request);
}

/** Authorizes one attempt, written down on the record first, and waits for its receipt. */
async function attempt(
  record: Stored,
  transferring: Active,
  request: Omit<StartRequest, "attempt">,
): Promise<Ending> {
  const token = `a-${Date.now().toString(36)}-${(++attempts).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  update(record.id, (latest) => ({ ...latest, attempt: token }));
  transferring.attempt = token;
  transferring.fresh = true;
  const receipt = receiptOf(token, record.subscriptionId);
  let resumed: boolean;
  try {
    resumed = await transfers.start({ ...request, attempt: token });
  } catch (cause) {
    awaited.delete(token);
    transferring.attempt = null;
    const error = appError(cause);
    return {
      kind: "failed",
      failure: { kind: "app", error: { kind: "unexpected", detail: describeError(error) } },
    };
  }
  transferring.resumed = resumed;
  transferring.from = resumed ? record.received : 0;
  if (!resumed && record.received > 0) transferring.restarted = true;
  transferring.received = transferring.from;
  transferring.measured = { at: Date.now(), received: transferring.from };
  transferring.savedAt = Date.now();
  tell();
  return { kind: "ended", receipt: await receipt };
}

/** Hears a transfer's progress: on screen a few times a second, on disk every few seconds. */
function moved({ attempt, received: written, expected: total }: Progress) {
  const transferring = active;
  if (!transferring || transferring.attempt !== attempt) return;
  if (transferring.fresh) {
    transferring.fresh = false;
    // A server that sent the whole file again, as a changed file does, starts from zero.
    if (transferring.resumed && written < transferring.from) transferring.restarted = true;
    if (total !== null) {
      const room = freeBytes();
      if (room !== null && room < total - written) {
        transferring.short = total - written;
        halt(transferring, "cancel");
      }
    }
  }
  const now = Date.now();
  const { measured } = transferring;
  if (now - measured.at >= 1000) {
    const rate = ((written - measured.received) * 1000) / (now - measured.at);
    transferring.rate = rate >= 0 ? rate : null;
    transferring.measured = { at: now, received: written };
  }
  transferring.received = written;
  transferring.size = total;
  tellSoon();
  if (now - transferring.savedAt >= SAVE_MS) {
    transferring.savedAt = now;
    try {
      update(transferring.id, (latest) => ({
        ...latest,
        received: written,
        size: total,
        restarted: transferring.restarted,
      }));
    } catch {
      // Written down when it ends.
    }
  }
}

/** Hears a receipt: the transfer waiting for it takes it, or it is taken in on its own. */
function heard(receipt: Receipt) {
  const waiting = awaited.get(receipt.attempt);
  if (waiting) {
    awaited.delete(receipt.attempt);
    waiting(receipt);
  } else if (phase === "ready") {
    void take(receipt, null)
      .catch(() => undefined)
      .finally(() => {
        tell();
        wake();
      });
  } else {
    early.set(receipt.receipt, receipt);
  }
}

/** Writes down how a transfer ended. */
async function settle(transferring: Active, ending: Ending) {
  switch (ending.kind) {
    case "stopped":
      return;
    case "failed":
      update(transferring.id, (latest) =>
        latest.state === "queued"
          ? {
              ...latest,
              received: transferring.received,
              size: transferring.size,
              restarted: transferring.restarted,
              state: "failed",
              failure: ending.failure,
            }
          : latest,
      );
      return;
    case "ended":
      return take(ending.receipt, transferring);
  }
}

/**
 * Takes a receipt in, then acknowledges it: written down first, so a receipt lost meanwhile is
 * found again and taken in once. Only the attempt a queued download authorized last changes it;
 * an older attempt's, or one of a download removed, finished or failed since, changes nothing.
 */
async function take(receipt: Receipt, transferring: Active | null): Promise<void> {
  if (taking.has(receipt.receipt)) return;
  taking.add(receipt.receipt);
  try {
    const record = find(receipt.id);
    if (record?.state === "queued" && record.attempt === receipt.attempt) {
      await apply(record, receipt.outcome, transferring);
    }
    await transfers.acknowledge([receipt.receipt]);
  } finally {
    taking.delete(receipt.receipt);
  }
}

/** Writes down what an attempt's end means for its download: a copy, a failure, or queued. */
async function apply(record: Stored, outcome: Outcome, transferring: Active | null) {
  const { id } = record;
  const where = transferring
    ? {
        ...record,
        received: transferring.received,
        size: transferring.size,
        restarted: transferring.restarted,
      }
    : record;
  const fail = (failure: StoredFailure) =>
    update(id, () => ({ ...where, state: "failed", failure }));
  const requeue = () => update(id, () => ({ ...withoutFailure(where), state: "queued" }));
  switch (outcome.kind) {
    case "complete": {
      const media = mediaOf(record);
      const bytes = media.exists ? (media.size ?? 0) : 0;
      // Only what the native side moved into place, at the whole size announced, is a copy.
      if (
        bytes <= 0 ||
        bytes !== outcome.size ||
        (outcome.expected !== null && bytes !== outcome.expected)
      ) {
        if (media.exists) media.delete();
        fail({
          kind: "stream",
          failure: { kind: "network", detail: "The file arrived incomplete." },
        });
        break;
      }
      missing.delete(id);
      update(
        id,
        () => ({
          ...withoutFailure(where),
          state: "complete",
          size: bytes,
          received: bytes,
          completedAt: Date.now(),
        }),
        true,
      );
      break;
    }
    case "paused":
      requeue();
      break;
    case "cancelled":
      if (transferring?.short != null) fail({ kind: "disk-full", needed: transferring.short });
      else requeue();
      break;
    case "refused":
      fail({ kind: "stream", failure: statusFailure(outcome.status) });
      break;
    case "folder":
      fail({ kind: "folder", detail: "The file couldn't be moved into its folder." });
      break;
    case "network":
      // Broken off while nobody watched (in the background, or with the app's process ended) or
      // while this side stopped it: it goes on once the app is open, from where it broke when
      // URLSession kept that. In front of the viewer, it fails, and its Retry goes on.
      if (!transferring || transferring.stopping || !foreground) requeue();
      else {
        const detail = OFFLINE.has(outcome.code)
          ? t("You seem to be offline.")
          : t("The connection to the provider failed.");
        fail({ kind: "stream", failure: { kind: "network", detail } });
      }
      break;
  }
  // Shown before the Keychain answers: until then a screen would still offer the transfer's
  // Cancel, and act on it, for what is now a copy or a failure.
  tell();
  if (outcome.kind === "complete") await forget(id);
}

function withoutFailure(record: Stored): Stored {
  const { failure: _failure, ...rest } = record;
  return rest;
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Takes a download's record out at once, so nothing writes it back, with its resume data listed
 * to go. Throws, changing nothing, when Documents won't take it.
 */
function drop(id: string) {
  commit({
    ...doc,
    items: doc.items.filter((each) => each.id !== id),
    forgetting: [...doc.forgetting.filter((each) => each !== id), id],
  });
  missing.delete(id);
}

/** After `drop`: its transfer stops, a copy that plays stops, and its resume data and folder go. */
async function clear(id: string) {
  const transferring = active?.id === id ? active : null;
  if (transferring) {
    halt(transferring, "cancel");
    await transferring.over;
  }
  if (playingItem(playbackState.get().phase)?.id === copyKey(id)) stop();
  await forget(id);
  try {
    const folder = folderOf(id);
    if (folder.exists) folder.delete();
  } catch {
    // A folder no record names goes at the next launch.
  }
}

/** Ends the unfinished downloads of subscriptions no longer saved; copies stay. */
function endRemoved() {
  const roster = currentRoster();
  if (roster.kind !== "ready") return;
  const saved = new Set(roster.members.map((member) => member.entry.id));
  const gone = doc.items.filter(
    (record) => record.state !== "complete" && !saved.has(record.subscriptionId),
  );
  for (const record of gone) {
    try {
      drop(record.id);
    } catch {
      continue;
    }
    ended++;
    void clear(record.id);
  }
}

/** Waits for the downloads to be ready; rejects, asking nothing, when they couldn't be. */
async function whenReady(): Promise<void> {
  startDownloads();
  await readiness;
  if (phase !== "ready") {
    throw new AppFailure({
      kind: "stream",
      failure: {
        kind: "network",
        detail: t("A download still holds the provider's connection."),
      },
    });
  }
}

/**
 * Gives a subscription's connection back to its stream: the transfer pauses, or is cancelled, and
 * the provider gets `RELEASE_MS` to free it. Rejects, so the stream fails without asking the
 * provider, when the transfer's request still hasn't ended, or the downloads aren't ready; the
 * stream's Try again asks again.
 */
async function reclaim(subscriptionId: string): Promise<void> {
  await whenReady();
  const transferring = active;
  if (transferring?.subscriptionId === subscriptionId) {
    halt(transferring, "pause");
    const closed = (ms: number) =>
      Promise.race([transferring.closed.then(() => true), after(ms).then(() => false)]);
    // Without a native attempt yet, a halted transfer asks the provider nothing.
    if (transferring.attempt && !(await closed(RECLAIM_MS))) {
      halt(transferring, "cancel");
      if (!(await closed(RECLAIM_MS))) {
        throw new AppFailure({
          kind: "stream",
          failure: {
            kind: "network",
            detail: t("A download still holds the provider's connection."),
          },
        });
      }
    }
  }
  const wait = freeing(subscriptionId);
  if (wait > 0) await after(wait);
}

/** Reads downloads.json; deletes what an earlier run listed to go. */
function load() {
  const read = readJson(FILE);
  const parsed = read === null ? null : Document()(read);
  const valid = parsed !== null && !(parsed instanceof type.errors);
  const items: Stored[] = [];
  const unreadable: object[] = [];
  for (const item of valid ? parsed.items : []) {
    const record = Stored()(item);
    if (record instanceof type.errors) unreadable.push(item);
    else items.push(record);
  }
  doc = { items, forgetting: valid ? parsed.forgetting : [], unreadable };
  trusted = valid;
  for (const id of doc.forgetting) void forget(id);
}

/** Deletes folders no entry names, left by a removal that couldn't finish. */
function sweep() {
  if (!trusted) return;
  // An entry this build can't read keeps its own.
  const named = new Set([
    ...doc.items.map((record) => record.id),
    ...doc.unreadable.flatMap((item) =>
      "id" in item && typeof item.id === "string" ? [item.id] : [],
    ),
  ]);
  try {
    const root = new Directory(Paths.document, ROOT);
    if (!root.exists) return;
    for (const entry of root.list()) {
      if (entry instanceof Directory && ID.test(entry.name) && !named.has(entry.name)) {
        entry.delete();
      }
    }
  } catch {
    // Tried again at the next launch.
  }
}

/** Settles once the subscriptions are read, so none restoring counts as removed. */
function rosterRead(): Promise<void> {
  return new Promise((resolve) => {
    if (currentRoster().kind === "ready") return resolve();
    const off = onRoster(() => {
      if (currentRoster().kind !== "ready") return;
      off();
      resolve();
    });
  });
}

/**
 * Hands resume data an earlier build kept in its own Keychain items to the native side, then
 * removes them. One the Keychain won't read now waits for the next launch rather than start
 * again without it.
 */
async function migrate() {
  for (const record of doc.items) {
    if (record.state === "complete" || doc.forgetting.includes(record.id)) continue;
    try {
      const saved = await readLegacy(record.id);
      if (!saved) continue;
      await transfers.importResume(record.id, saved.url, saved.resumeData);
    } catch {
      held.add(record.id);
      continue;
    }
    await keychainSecrets.remove(secretOf(record.id)).catch(() => undefined);
  }
}

/** Takes in, oldest first, every receipt heard before the downloads were ready. */
async function drain() {
  for (const [key, receipt] of early) {
    early.delete(key);
    await take(receipt, null);
  }
}

/**
 * Accounts for every request and ending the native side has before anything else acts on
 * downloads: the request of a queued download's last attempt goes on as its transfer; any other
 * is cancelled and has ended; every receipt is taken in. Then resume data an earlier build kept
 * moves, folders no record names go, and removed subscriptions' downloads end.
 */
async function prepare() {
  await rosterRead();
  const { running, receipts, closed } = await transfers.reconcile();
  for (const receipt of receipts) early.set(receipt.receipt, receipt);
  // Requests that ended unheard, or that no attempt accounted for and were just ended.
  let unwatched = receipts.length > 0 || closed > 0;
  for (const each of running) {
    if (active?.attempt === each.attempt) continue;
    const record = find(each.id);
    if (!active && record?.state === "queued" && record.attempt === each.attempt) {
      adopt(record, each);
    } else {
      await transfers.cancel(each.attempt);
      unwatched = true;
    }
  }
  // When those requests ended isn't known: the providers get their time from now.
  if (unwatched) releasedAll = Date.now();
  await drain();
  await migrate();
  sweep();
  endRemoved();
}

/** Prepares the downloads, then lets the queue go. */
function prepareThenWake(): Promise<void> {
  phase = "starting";
  return prepare()
    .then(drain)
    .then(
      () => {
        phase = "ready";
      },
      () => {
        phase = "failed";
      },
    )
    .finally(() => {
      tell();
      wake();
    });
}

/**
 * At launch: reads the downloads, accounts for the native side's requests and endings, then
 * follows the subscriptions, the player and the app's state, starting the queue when it can.
 * Calling it again does nothing.
 */
export function startDownloads(): void {
  if (started) return;
  started = true;
  try {
    load();
  } catch {
    // Shown empty; nothing is cleaned up.
  }
  look();
  onReclaim(reclaim);
  transfers.addListener("receipt", heard);
  transfers.addListener("progress", moved);
  foreground = AppState.currentState === "active";
  AppState.addEventListener("change", (state) => {
    const now = state === "active";
    if (now === foreground) return;
    foreground = now;
    // A transfer under way goes on in the background; the queue starts no other there.
    if (!foreground) return;
    look();
    tell();
    if (phase === "failed") readiness = prepareThenWake();
    else wake();
  });
  playbackState.subscribe(() => {
    const busy = borrowed();
    // The provider gets its moment to free the connection from when playback let go of it.
    for (const id of streaming) if (!busy.has(id)) released.set(id, Date.now());
    streaming = busy;
    if (active && busy.has(active.subscriptionId)) halt(active, "pause");
    tell();
    wake();
  });
  onRoster(() => {
    if (phase === "ready") endRemoved();
    tell();
    wake();
  });
  tell();
  readiness = prepareThenWake();
}

/** The download of exactly this movie or episode of this subscription, if there is one. */
export function downloadOf(ref: TitleRef): Download | undefined {
  const record = doc.items.find((each) => sameTitle(each, ref));
  return record && list.get().items.find((item) => item.id === record.id);
}

/** The same, rendering again as it changes. */
export function useDownloadOf(ref: TitleRef): Download | undefined {
  useStore(list);
  return downloadOf(ref);
}

/** Queues a failed download again, by the file type its provider lists now when it can say. */
async function again(record: Stored): Promise<void> {
  const ref: TitleRef = { ...record.title, subscriptionId: record.subscriptionId };
  const container = await titleFile(ref, AbortSignal.timeout(20_000)).then(
    (file) => file.container,
    () => record.container,
  );
  const latest = find(record.id);
  if (latest?.state !== "failed") return;
  update(record.id, () => ({ ...withoutFailure(latest), container, state: "queued" }));
  tell();
  wake();
}

/**
 * Queues a movie or an episode, the exact version given, keeping its details and artwork for the
 * copy. One already queued or downloaded, or added while this looked it up, answers as it is; a
 * failed one is queued again. Rejects while its subscription isn't signed in, when its provider
 * doesn't list it, or when the subscription was removed or signed in anew meanwhile.
 */
export async function addDownload(ref: TitleRef): Promise<Download> {
  startDownloads();
  const answer = async (known: Stored) => {
    if (known.state === "failed") await again(known);
    tell();
    const shown = list.get().items.find((item) => item.id === known.id);
    if (!shown) throw new AppFailure({ kind: "title-not-found", titleId: ref.id });
    return shown;
  };
  const known = doc.items.find((each) => sameTitle(each, ref));
  if (known) return answer(known);
  const source = sourceOf(ref.subscriptionId);
  const file = await titleFile(ref, AbortSignal.timeout(20_000));
  const kept = await aboutOf(ref);
  if (currentSource(ref.subscriptionId) !== source) {
    throw new AppFailure({ kind: "no-subscription" });
  }
  const added = doc.items.find((each) => sameTitle(each, ref));
  if (added) return answer(added);
  const { subscriptionId, ...title } = ref;
  const record: Stored = {
    id: newId(),
    subscriptionId,
    title,
    container: file.container,
    about: kept.about,
    artwork: { poster: false, wide: false },
    state: "queued",
    size: null,
    received: 0,
    restarted: false,
    addedAt: Date.now(),
    completedAt: null,
    progress: null,
  };
  commit({ ...doc, items: [...doc.items, record] });
  void keepArtwork(record.id, kept.artwork);
  tell();
  wake();
  return viewOf(record, new Map(members().map((m) => [m.entry.id, m.label])), borrowed());
}

function newId(): string {
  let id: string;
  do id = `d-${Date.now().toString(36)}-${(++made).toString(36)}`;
  while (find(id) || doc.unreadable.some((item) => "id" in item && item.id === id));
  return id;
}

/**
 * Cancels an unfinished download or deletes a copy, with its files and resume data. A transfer
 * stops, and its request ends, before its files go. Rejects, changing nothing, when the record
 * can't be written.
 */
export async function removeDownload(id: string): Promise<void> {
  const record = find(id);
  if (!record) return;
  // A copy has no request open; an unfinished download's may only be known once ready.
  if (record.state !== "complete") await whenReady();
  if (!find(id)) return;
  drop(id);
  await clear(id);
  tell();
  wake();
}

/** Queues a failed download again. */
export async function retryDownload(id: string): Promise<void> {
  const record = find(id);
  if (record?.state === "failed") await again(record);
}

/**
 * Plays a copy in Watch from where it was left, from the phone: no provider, login or network.
 * Its progress stays with the copy, and goes to its subscription's viewing record too while that
 * subscription is saved. A copy whose file is gone fails in Watch as unavailable.
 */
export function playDownload(id: string): void {
  const record = find(id);
  if (record?.state !== "complete") return;
  const media = mediaOf(record);
  const { about, title, progress } = record;
  const since = Date.now();
  const item: Playing = {
    id: copyKey(id),
    subscriptionId: null,
    title: about.name,
    place:
      title.kind === "episode"
        ? [episodeLabel(title.season, title.episode), about.episodeName].filter(Boolean).join(" · ")
        : about.year
          ? String(about.year)
          : "",
    live: false,
    next: false,
    versions: false,
  };
  const from =
    progress && !isFinished(progress.position, progress.duration)
      ? Math.max(0, progress.position - 5)
      : 0;
  void play(
    item,
    async () => {
      if (!media.exists) {
        missing.add(id);
        tell();
        throw new AppFailure({ kind: "stream", failure: { kind: "unavailable", status: 404 } });
      }
      return { url: media.uri, container: record.container };
    },
    {
      watch: true,
      login: [],
      from,
      progress: (position, duration) => keepProgress(id, position, duration, since),
    },
  );
}

function keepProgress(id: string, position: number, duration: number, since: number) {
  const record = find(id);
  if (!record) return;
  try {
    update(id, (latest) => ({
      ...latest,
      progress: { position: Math.min(position, duration), duration, at: Date.now() },
    }));
    tell();
  } catch {
    // Kept at the next save.
  }
  const { subscriptionId } = record;
  if (members().some((member) => member.entry.id === subscriptionId)) {
    void recordProgress({ ...record.title, subscriptionId }, position, duration, since).catch(
      () => undefined,
    );
  }
}

/** What a download keeps of its title's details, and where its pictures are online. */
async function aboutOf(ref: TitleRef) {
  const lists = titleLists();
  if (lists.kind !== "ready") throw new AppFailure({ kind: "no-subscription" });
  const missingTitle = new AppFailure({ kind: "title-not-found", titleId: ref.id });
  if (ref.kind === "movie") {
    const title = titleOf(lists.index, "movie", ref);
    if (!title) throw missingTitle;
    const details = await detailsOf({ ...title, subscriptionId: ref.subscriptionId, id: ref.id });
    return {
      about: {
        name: title.title,
        episodeName: null,
        year: title.year,
        duration: details.duration,
        originalLanguage: title.originalLanguage,
      },
      artwork: {
        poster: details.title.posterUrl ?? title.posterUrl,
        wide: details.backdropUrl ?? title.backdropUrl,
      },
    };
  }
  const version = { subscriptionId: ref.subscriptionId, id: ref.seriesId };
  const series = titleOf(lists.index, "series", version);
  if (!series) throw missingTitle;
  const details = await detailsOf({ ...series, ...version });
  const seasons = details.kind === "series" ? details.seasons : [];
  const season = seasons.find((each) => each.number === ref.season);
  const told = season ? await episodesOf(series, season).catch(() => season.episodes) : [];
  const episode =
    told.find((each) => each.id === ref.id) ??
    seasons.flatMap((each) => each.episodes).find((each) => each.id === ref.id);
  return {
    about: {
      name: series.title,
      episodeName: episode?.title ?? null,
      year: series.year,
      duration: episode?.duration ?? details.duration,
      originalLanguage: series.originalLanguage,
    },
    artwork: {
      poster: details.title.posterUrl ?? series.posterUrl,
      wide: episode?.stillUrl ?? details.backdropUrl ?? series.backdropUrl,
    },
  };
}

/** Fetches a download's pictures into its folder, natively, so the copy shows them offline. */
async function keepArtwork(
  id: string,
  urls: { readonly poster: string | null; readonly wide: string | null },
) {
  for (const artwork of ["poster", "wide"] as const) {
    const url = urls[artwork];
    if (!url || !/^https?:\/\//.test(url) || !find(id)) continue;
    try {
      folderOf(id).create({ intermediates: true, idempotent: true });
      await File.downloadFileAsync(url, artworkOf(id, artwork), {
        idempotent: true,
        signal: AbortSignal.timeout(ARTWORK_MS),
      });
      update(id, (latest) => ({ ...latest, artwork: { ...latest.artwork, [artwork]: true } }));
      tell();
    } catch {
      // Without it, the copy shows its name.
    }
  }
}
