import { type } from "arktype";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { RawTitleRef, type TitleRef } from "@mrstreamer/contracts/ondemand";
import { t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { Directory, File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import {
  bindDownloadSource,
  connectDemoDownloads,
  currentRoster,
  downloadGeneration,
  launchSignIns,
  members,
  onRoster,
  savable,
  unbindDownloads,
} from "./account.ts";
import {
  refusalOf,
  transfers,
  type AuthorizationView,
  type LegacyReceipt,
  type OutcomeV2,
  type Progress,
  type ReceiptV2,
  type Snapshot,
} from "./download-task.ts";
import { appError, describeError, statusFailure } from "./errors.ts";
import { readJson, writeJson } from "./files.ts";
import {
  onAdmission,
  play,
  playbackReaders,
  playbackState,
  playingItem,
  progressSettled,
  request,
  stop,
  type Playing,
} from "./playback.ts";
import { fetchPicture } from "./picture-transfer.ts";
import { keychainSecrets } from "./secrets.ts";
import { currentSource, onSignedIn, sourceOf, type Source } from "./sources.ts";
import { store, useStore } from "./store.ts";
import {
  admitTitle,
  detailsOf,
  episodesOf,
  excludedTitle,
  listedIndex,
  titleFile,
  titleOf,
} from "./titles.ts";
import { recordProgress } from "./viewing.ts";

// Movies and episodes downloaded to this iPhone: the queue and the copies that play with no
// provider, as the desktop's downloads do. This module alone writes downloads.json and the
// folders in Documents/downloads, and alone decides what a transfer's end means for its download.
//
// A download names the exact provider file by its subscription and the provider's own ids, so
// two providers' titles of one id never meet. Its record holds what the copy shows and plays
// with: details, artwork kept in its folder, the file type, how far it got, how far it was
// watched and the provider-ordered immediate successor of a newly saved episode. No record
// holds an address, a header, a login or resume data.
//
// The native owner (`download-task.ts`) schedules the transfers, one at a time, and goes on to
// the next by itself while the app is in the background or suspended, and after iOS ends the
// app's process. This module hands it a bounded window of exact file authorizations: in the
// foreground, for queued downloads of a subscription whose login has its download binding
// (account.ts), each authorization is reserved, written on its record, then armed with the
// file's request, made from the login only then (`sources.ts`). Only an authorization's own
// receipt changes its record, and only once, by its sequence; the receipt is acknowledged once
// the record says what it means, so an ending is never lost nor taken twice. A paused one stays
// the same authorization, runnable again; a network break in front of the viewer fails, and
// Retry asks again, elsewhere it waits for the app to be open; a revoked login's are asked again
// under the new one.
//
// The first time the app is open in a process, everything the native side kept is taken in
// before it may start anything new: receipts, build 14's receipts and unfinished removals, and
// the subscriptions' bindings once launch's passwords were read. A queue whose native authority
// is damaged is started over once, keeping copies, records and logins. Nothing that asks a
// provider waits on downloads' records or storage: a stream takes its subscription's connection
// from the native owner directly (`onAdmission`), and fails rather than ask for a second one
// while a transfer's request hasn't ended.
//
// Removing a download writes its intent on its record first, then fences its authorization
// durably on the native side, then drops the record; its folder goes only once its task and any
// player reading the copy actually closed, else later. A subscription's removal ends its
// unfinished downloads; a copy that completed first stays, plays offline and keeps its progress.
// A copy is complete only once the native side moved every byte into place at the whole size the
// server announced. A file left beside an unfinished record is deleted before it is authorized
// again. Resume data an earlier build kept in `download:<id>` is handed to the native side at
// launch, then removed.

const FILE = "downloads.json";
/** Documents/downloads, which modules/downloads-folder keeps out of backups. */
const ROOT = "downloads";
/** How often transfer progress reaches the screens, at most. */
const PROGRESS_MS = 250;
/** How often a transfer's progress is written down. */
const SAVE_MS = 5000;
/** Unfinished authorizations the native queue may hold at once. */
const WINDOW = 32;
/** How long removing a copy waits for its task and readers to close before its folder waits. */
const CLOSE_MS = 10_000;
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
    /** A transfer under way is `queued` on disk: the native side has it, or it waits for one. */
    state: "'queued' | 'failed' | 'complete'",
    /** Recognised by the public catalogue policy, retained when offline or no longer listed. */
    "excluded?": "boolean",
    "failure?": Failure(),
    /** The whole file's bytes once the server said; once complete, the bytes on disk. */
    size: "number | null",
    /** Bytes received when it last paused or was written down. */
    received: "number",
    restarted: "boolean",
    /** Build 14's last attempt: only its build-14 receipt changes the record. */
    "attempt?": "string",
    addedAt: "number",
    completedAt: "number | null",
    /** How far the copy was watched here. */
    progress: type({ position: "number", duration: "number", at: "number" }).or("null"),
    /** Optional ordering added by this build; an unreadable edge never hides a playable copy. */
    "continuation?": "unknown",
    /** Its native authorization (`Transfer`), read on its own: a bad one holds back only it. */
    "transfer?": "unknown",
    /** Why it is being removed (`Removal`), read on its own: a bad one holds back only it. */
    "removal?": "unknown",
  }),
);
type Stored = Infer<typeof Stored>;
const Continuation = lazy(() => type({ version: "1", title: RawTitleRef() }));
/** The record's current authorization, and the last of its receipts' sequences taken in. */
const Transfer = lazy(() =>
  type({
    version: "2",
    authorization: "string",
    sourceGeneration: "string",
    appliedSequence: "number.integer >= 0",
  }),
);
type Transfer = Infer<typeof Transfer>;
/**
 * The record's removal, written before its authorization is fenced: excluded from the queue,
 * finished by the next reconciliation when it is interrupted, never asked for again.
 */
const Removal = lazy(() =>
  type({ version: "1", reason: "'user' | 'source-removed' | 'replace-missing' | 'demo-reset'" }),
);
type Reason = Infer<typeof Removal>["reason"];
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

/** A field read on its own: absent, as this build writes it, or present and unreadable. */
type Field<A> = A | undefined | "bad";

function fieldOf<A>(parse: (value: unknown) => A | type.errors, value: unknown): Field<A> {
  if (value === undefined) return undefined;
  const parsed = parse(value);
  return parsed instanceof type.errors ? "bad" : parsed;
}
const transferOf = (record: Stored): Field<Transfer> => fieldOf(Transfer(), record.transfer);
const removalOf = (record: Stored): Field<Infer<typeof Removal>> =>
  fieldOf(Removal(), record.removal);
/** Its authorization, when it reads. */
const boundOf = (record: Stored): Transfer | null => {
  const transfer = transferOf(record);
  return typeof transfer === "object" ? transfer : null;
};

/** A transfer the native side reports under way, as the screens show it. */
interface Live {
  received: number;
  size: number | null;
  restarted: boolean;
  rate: number | null;
  measured: { at: number; received: number };
  savedAt: number;
}

const EMPTY: DownloadList = { items: [], series: {}, bytes: 0, free: null, ended: 0 };
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
/** downloads.json read as this build writes it, or absent: what it names is all there is. */
let complete = false;
let started = false;
/** The app is in the foreground: only then are authorizations reserved. */
let foreground = false;
/**
 * Whether the native side's receipts are taken in. Until "ready", nothing is removed by the
 * queue's own reconciliation; "failed" is tried again in the foreground.
 */
let phase: "starting" | "ready" | "failed" = "starting";
let firstReady = () => {};
const ready = new Promise<void>((resolve) => (firstReady = resolve));
/** This process's first foreground reconciliation: until done, no authorization is reserved. */
let barrier: "pending" | "running" | "done" = "pending";
/** Whether this process already tried to start a damaged native queue over: once at most. */
let repairTried = false;
/** Copies whose file was gone when last looked. */
const missing = new Set<string>();
/** Unfinished downloads that ended with their subscription since launch. */
let ended = 0;
let made = 0;
/** Transfers under way, by authorization, as their progress and the native queue tell them. */
const live = new Map<string, Live>();
/** The native queue's authorizations, as last told. */
let known = new Map<string, AuthorizationView>();
/** Receipts heard before the downloads were ready, by receipt. */
const early = new Map<string, ReceiptV2>();
/** Receipts being taken in, by receipt: an event and a reconcile may bring the same one. */
const taking = new Set<string>();
/** A receipt the native side kept for a download, of this build or build 14. */
type Fact = ReceiptV2 | LegacyReceipt;
/**
 * Receipts the native side kept that couldn't be written down yet, by download, then by receipt
 * with its outcome's kind: nothing asks for such a download again, nor deletes its file, until
 * each is. Only an owed completion holds an automatic removal back.
 */
const owed = new Map<string, Map<string, Fact["outcome"]["kind"]>>();
/** Downloads whose earlier build's resume data couldn't be read: they wait for the next launch. */
const held = new Set<string>();
/** Removals under way, by download: one at a time for a record. */
const removing = new Map<string, Promise<Removed>>();
/** Folders of dropped records still waiting for their task or readers to close. */
const closingFolders = new Set<string>();
/** Bindings asked of the account owner and not yet settled, by exact login. */
let binding = new WeakMap<Source, Promise<void>>();
/** The queue's refill under way, and whether another was asked meanwhile. */
let filling: Promise<void> | null = null;
let refillAgain = false;

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
/** A record nothing is removing, whose optional fields read: the queue may act on it. */
const standing = (record: Stored) =>
  removalOf(record) === undefined && transferOf(record) !== "bad";

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

/** The record without its authorization, build 14's attempt or failure. */
function unbound(record: Stored): Stored {
  const { transfer: _transfer, attempt: _attempt, failure: _failure, ...rest } = record;
  return rest;
}

function withoutFailure(record: Stored): Stored {
  const { failure: _failure, ...rest } = record;
  return rest;
}

function withoutRemoval(record: Stored): Stored {
  const { removal: _removal, ...rest } = record;
  return rest;
}

/** Whether download `id` is owed a completion other than `fact` not written down yet. */
function owesCompletion(id: string, fact?: ReceiptV2): boolean {
  return [...(owed.get(id) ?? [])].some(
    ([receipt, kind]) => kind === "complete" && receipt !== fact?.receipt,
  );
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
 * which another subscription's play doesn't hide. Only what the screens say: the native owner
 * holds the connection itself.
 */
function borrowed(): ReadonlySet<string> {
  const { phase, closing } = playbackState.get();
  const busy = new Set(closing);
  if (phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused") {
    if (phase.item.subscriptionId !== null) busy.add(phase.item.subscriptionId);
  }
  return busy;
}

/** The transfer under way of `record`, if the native side says it is. */
function transferring(record: Stored): Live | null {
  const bound = boundOf(record);
  if (!bound) return null;
  const heard = live.get(bound.authorization);
  if (heard) return heard;
  const view = known.get(bound.authorization);
  if (view?.state !== "active") return null;
  return {
    received: view.received ?? record.received,
    size: view.expected ?? record.size,
    restarted: record.restarted || view.restarted,
    rate: null,
    measured: { at: Date.now(), received: view.received ?? record.received },
    savedAt: Date.now(),
  };
}

function viewOf(
  record: Stored,
  names: ReadonlyMap<string, string>,
  busy: ReadonlySet<string>,
): Download {
  const name = names.get(record.subscriptionId);
  const moving = record.state === "queued" ? transferring(record) : null;
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
    size: moving ? moving.size : record.size,
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
          : moving
            ? {
                kind: "transferring",
                received: moving.received,
                size: moving.size,
                rate: moving.rate,
                restarted: moving.restarted,
              }
            : busy.has(record.subscriptionId)
              ? { kind: "waiting" }
              : { kind: "queued" },
    progress: record.progress && {
      position: record.progress.position,
      duration: record.progress.duration,
    },
    // This app keeps no episode's series yet: each copy stands alone.
    series: null,
  };
}

function view(): DownloadList {
  const names = new Map(members().map((member) => [member.entry.id, member.label]));
  const busy = borrowed();
  const visible = doc.items.filter((record) => !excludedDownload(record));
  const queue = visible.filter((record) => record.state !== "complete");
  const copies = visible
    .filter((record) => record.state === "complete")
    .toSorted((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  return {
    items: [...queue, ...copies].map((record) => viewOf(record, names, busy)),
    series: {},
    bytes: doc.items.reduce((sum, record) => {
      const moving = record.state === "queued" ? transferring(record) : null;
      return (
        sum + (moving ? moving.received : record.state === "complete" ? (record.size ?? 0) : 0)
      );
    }, 0),
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

/** Hears a transfer's progress: on screen a few times a second, on disk every few seconds. */
function moved(progress: Progress) {
  const record = find(progress.id);
  const bound = record && boundOf(record);
  if (!record || bound?.authorization !== progress.authorization || record.state !== "queued") {
    return;
  }
  const now = Date.now();
  const first = !live.has(progress.authorization);
  const seen = live.get(progress.authorization) ?? {
    received: progress.received,
    size: progress.expected,
    restarted: record.restarted,
    rate: null,
    measured: { at: now, received: progress.received },
    savedAt: now,
  };
  // Only first progress behind the saved bytes establishes a fresh start here; a process
  // relaunch can hear the same native transfer again. Native restart evidence always stands.
  seen.restarted ||=
    progress.restarted || (first && !progress.resumed && progress.received < record.received);
  if (now - seen.measured.at >= 1000) {
    const rate = ((progress.received - seen.measured.received) * 1000) / (now - seen.measured.at);
    seen.rate = rate >= 0 ? rate : null;
    seen.measured = { at: now, received: progress.received };
  }
  seen.received = progress.received;
  seen.size = progress.expected;
  live.set(progress.authorization, seen);
  // Its start is told at once: a short transfer may end before the next tick.
  if (first) tell();
  else tellSoon();
  if (now - seen.savedAt >= SAVE_MS) {
    seen.savedAt = now;
    try {
      update(record.id, (latest) => ({
        ...latest,
        received: progress.received,
        size: progress.expected,
        restarted: seen.restarted,
      }));
    } catch {
      // Written down when it ends.
    }
  }
}

/** Hears a receipt: taken in at once once the downloads are ready, else when they are. */
function heard(receipt: ReceiptV2) {
  if (phase !== "ready") {
    early.set(receipt.receipt, receipt);
    return;
  }
  void take(receipt, true)
    .catch(() => undefined)
    .finally(() => {
      tell();
      refill();
    });
}

/**
 * Takes a receipt in, then acknowledges it: written down first, so a receipt lost meanwhile is
 * found again and taken in once. Only the authorization a record has now changes it, and only by
 * a receipt newer than the last taken in; an older one, or one of a download removed since,
 * changes nothing. `live`: heard as it happened, not found later.
 */
async function take(receipt: ReceiptV2, heardLive: boolean): Promise<void> {
  if (taking.has(receipt.receipt)) return;
  taking.add(receipt.receipt);
  try {
    await written(receipt, reduce(receipt, heardLive));
    await transfers.acknowledge([receipt.receipt]).catch(() => undefined);
  } finally {
    taking.delete(receipt.receipt);
  }
}

/** Settles as `work` does, keeping `fact` owed to its download while what it writes is refused. */
async function written(fact: Fact, work: Promise<void>) {
  let refused = false;
  try {
    await work;
  } catch (cause) {
    refused = true;
    throw cause;
  } finally {
    // Read as it stands now: another receipt of the same download may have settled meanwhile.
    const pending = owed.get(fact.id) ?? new Map<string, Fact["outcome"]["kind"]>();
    if (refused) pending.set(fact.receipt, fact.outcome.kind);
    else pending.delete(fact.receipt);
    if (pending.size > 0) owed.set(fact.id, pending);
    else owed.delete(fact.id);
  }
}

async function reduce(receipt: ReceiptV2, heardLive: boolean) {
  if (receipt.outcome.kind === "paused") {
    const view = known.get(receipt.authorization);
    if (view) known.set(receipt.authorization, { ...view, state: "paused" });
  } else known.delete(receipt.authorization);
  const transfer = live.get(receipt.authorization);
  live.delete(receipt.authorization);
  const record = find(receipt.id);
  const bound = record && boundOf(record);
  if (!record || bound?.authorization !== receipt.authorization) return;
  if (receipt.sequence <= bound.appliedSequence) return;
  // A removal under way, or one this receipt says was asked, is finished by its own path before
  // the receipt is acknowledged: a refused write leaves both for the next reconciliation.
  const removal = removalOf(record);
  if (
    receipt.outcome.kind === "cancelled" &&
    typeof removal !== "object" &&
    (restricting.has(record.id) || excludedDownload(record))
  ) {
    update(record.id, () => fenced(record));
    return;
  }
  if (receipt.outcome.kind === "cancelled" || typeof removal === "object") {
    await removeRecord(record.id, typeof removal === "object" ? removal.reason : "user", receipt);
    return;
  }
  const where = {
    ...record,
    received: receipt.received ?? transfer?.received ?? record.received,
    size: receipt.expected ?? transfer?.size ?? record.size,
    restarted: record.restarted || receipt.restarted || transfer?.restarted === true,
  };
  await apply(where, receipt.outcome, heardLive && foreground, {
    ...bound,
    appliedSequence: receipt.sequence,
  });
}

/**
 * Writes down what an authorization's end means for its download: a copy, a failure, queued
 * under it still (paused), or queued for a new one. `inFront`: it ended in front of the viewer.
 */
async function apply(record: Stored, outcome: OutcomeV2, inFront: boolean, bound: Transfer | null) {
  const { id } = record;
  const fail = (failure: StoredFailure) =>
    update(id, () => ({ ...unbound(record), state: "failed", failure }));
  const requeue = () => update(id, () => ({ ...unbound(record), state: "queued" }));
  switch (outcome.kind) {
    case "complete":
      if (!completeCopy(record, outcome)) return tell();
      break;
    case "paused":
      // The same authorization goes on once its subscription's stream let go.
      update(id, () => ({ ...withoutFailure(record), ...(bound ? { transfer: bound } : {}) }));
      break;
    case "cancelled":
      requeue();
      break;
    case "refused":
      fail({ kind: "stream", failure: statusFailure(outcome.status) });
      break;
    case "folder":
      fail({ kind: "folder", detail: "The file couldn't be moved into its folder." });
      break;
    case "disk-full":
      fail({ kind: "disk-full", needed: outcome.needed });
      break;
    case "network":
      // Broken off while nobody watched (in the background, or with the app's process ended):
      // it goes on once the app is open, from where it broke when URLSession kept that. In front
      // of the viewer, it fails, and its Retry goes on.
      if (!inFront) requeue();
      else {
        const detail = OFFLINE.has(outcome.code)
          ? t("You seem to be offline.")
          : t("The connection to the provider failed.");
        fail({ kind: "stream", failure: { kind: "network", detail } });
      }
      break;
    case "refresh":
      if (outcome.reason === "resume-unusable") {
        // The server refused its resume data and the phone couldn't let go of it: only the
        // viewer's Retry asks again, never the queue on its own.
        fail({
          kind: "stream",
          failure: {
            kind: "network",
            detail: "The download couldn't go on from where it stopped.",
          },
        });
      } else {
        // The login it was authorized under is gone: asked again under the one signed in now.
        requeue();
      }
      break;
  }
  // Shown before the Keychain answers: until then a screen would still offer the transfer's
  // Cancel, and act on it, for what is now a copy or a failure.
  tell();
  if (outcome.kind === "complete") await forget(id);
}

/**
 * Writes a copy complete when the native side moved every byte into place at the whole size the
 * server announced; else its file goes and it fails. Answers whether it is a copy.
 */
function completeCopy(
  record: Stored,
  outcome: { readonly size: number; readonly expected: number | null },
) {
  const media = mediaOf(record);
  const bytes = media.exists ? (media.size ?? 0) : 0;
  if (
    bytes <= 0 ||
    bytes !== outcome.size ||
    (outcome.expected !== null && bytes !== outcome.expected)
  ) {
    if (media.exists) media.delete();
    update(record.id, () => ({
      ...unbound(record),
      state: "failed",
      failure: {
        kind: "stream",
        failure: { kind: "network", detail: "The file arrived incomplete." },
      },
    }));
    return false;
  }
  missing.delete(record.id);
  update(
    record.id,
    () => ({
      ...unbound(record),
      state: "complete",
      size: bytes,
      received: bytes,
      completedAt: Date.now(),
    }),
    true,
  );
  return true;
}

/**
 * Takes in a build-14 receipt with build 14's meanings: only a queued record's last attempt;
 * a pause or a cancel queues it again.
 */
async function takeLegacy(receipt: LegacyReceipt) {
  if (taking.has(receipt.receipt)) return;
  taking.add(receipt.receipt);
  try {
    const record = find(receipt.id);
    const { outcome } = receipt;
    const removal = record ? removalOf(record) : undefined;
    // A completion wins an automatic removal still waiting for it; an explicit one wins it.
    const automatic =
      typeof removal === "object" &&
      removal.reason === "source-removed" &&
      outcome.kind === "complete";
    const applies =
      record?.state === "queued" &&
      record.attempt === receipt.attempt &&
      transferOf(record) !== "bad" &&
      (removal === undefined || automatic);
    // A refused write keeps the copy's file and its receipt for the next try; a receipt that
    // doesn't apply is owed nothing more.
    await written(
      receipt,
      applies && record
        ? apply(
            automatic ? withoutRemoval(record) : record,
            outcome.kind === "complete"
              ? { kind: "complete", size: outcome.size, expected: outcome.expected }
              : outcome.kind === "refused"
                ? { kind: "refused", status: outcome.status }
                : outcome.kind === "folder"
                  ? { kind: "folder" }
                  : { kind: "cancelled" },
            false,
            null,
          )
        : Promise.resolve(),
    );
    await transfers.acknowledge([receipt.receipt]).catch(() => undefined);
  } finally {
    taking.delete(receipt.receipt);
  }
}

/** Takes in every receipt the native side kept, in order, build 14's first. */
async function applyFacts(facts: {
  readonly receipts: readonly ReceiptV2[];
  readonly legacy: readonly LegacyReceipt[];
}) {
  for (const receipt of facts.legacy) await takeLegacy(receipt).catch(() => undefined);
  const ordered = [...facts.receipts].toSorted((a, b) => a.sequence - b.sequence);
  for (const receipt of ordered) await take(receipt, false).catch(() => undefined);
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// Removal: intent, fence, drop, then folder after actual closure.

/** How removing one download ended. */
type Removed =
  /**
   * Its record is gone, under a durable native fence. `saved` settles once the copy's final save
   * of progress ended, if it played; `cleanup` once its folder went after its task and every
   * reader actually closed, or `deferred` while one hasn't: the folder then goes later, never
   * while a reader may still have it.
   */
  | {
      readonly kind: "removed";
      readonly saved: Promise<void>;
      readonly cleanup: Promise<"closed" | "deferred">;
    }
  /** A copy that completed before its subscription's removal stays. */
  | { readonly kind: "kept" }
  /** Nothing to remove. */
  | { readonly kind: "gone" };

/** An intent's strength: an explicit removal replaces an automatic one, never the reverse. */
const explicit = (reason: Reason) => reason !== "source-removed";

/**
 * Removes download `id` for `reason`, one removal of a record at a time: its intent is written
 * first, its authorization fenced on the native side, then its record dropped. A complete copy
 * stays for a subscription's removal. Rejects, its intent kept for the next reconciliation, when
 * a write or the fence is refused. `fact` is the receipt that brought it here, if any.
 */
function removeRecord(id: string, reason: Reason, fact?: ReceiptV2): Promise<Removed> {
  const before = removing.get(id);
  const run = (before ?? Promise.resolve()).then(
    () => removeNow(id, reason, fact),
    () => removeNow(id, reason, fact),
  );
  const mine = run.finally(() => {
    if (removing.get(id) === mine) removing.delete(id);
  });
  removing.set(id, mine);
  return mine;
}

async function removeNow(id: string, asked: Reason, fact?: ReceiptV2): Promise<Removed> {
  const record = find(id);
  if (!record) return { kind: "gone" };
  const transfer = transferOf(record);
  if (transfer === "bad" && record.state !== "complete") {
    throw new AppFailure({
      kind: "unexpected",
      detail: "This download's record is damaged, so it can't be removed safely yet.",
    });
  }
  const now = removalOf(record);
  const reason =
    typeof now === "object" && !explicit(asked) && explicit(now.reason) ? now.reason : asked;
  if (typeof now !== "object" || now.reason !== reason) {
    update(id, (latest) => ({ ...latest, removal: { version: 1, reason } }));
    tell();
  }
  let complete = record.state === "complete";
  if (typeof transfer === "object") {
    const fence = await transfers.cancelAuthorization(transfer.authorization, "remove");
    // A completion committed before the fence wins an automatic removal.
    const done = [...fence.receipts, ...(fact ? [fact] : [])].find(
      (each) =>
        each.authorization === transfer.authorization &&
        each.outcome.kind === "complete" &&
        each.sequence > transfer.appliedSequence,
    );
    const latest = find(id);
    if (done?.outcome.kind === "complete" && latest && reason === "source-removed") {
      const { removal: _removal, ...kept } = latest;
      complete = completeCopy(kept, done.outcome);
    }
  }
  // Decided on the record as it stands now, after the fence's answer.
  const latest = find(id);
  if (!latest) return { kind: "gone" };
  if (reason === "source-removed" && (complete || latest.state === "complete")) {
    if (latest.removal !== undefined) update(id, withoutRemoval);
    tell();
    return { kind: "kept" };
  }
  if (reason === "source-removed" && owesCompletion(id, fact)) {
    // A completion kept for it that couldn't be written down yet wins an automatic removal: the
    // removal waits, its intent kept, until that receipt is written. Any other owed receipt is
    // taken in after the drop, finding no record.
    throw new AppFailure({
      kind: "unexpected",
      detail: "This download's last result isn't written down yet.",
    });
  }
  drop(id);
  if (reason === "source-removed" && latest.state !== "complete") ended++;
  // Captured before Stop: every reader of the copy, the one playing, failed or still closing.
  const readers = playbackReaders(copyKey(id));
  const { phase } = playbackState.get();
  // Failed too, so its Try again can't open the copy again. Stop queues its last save at once;
  // its own promise also waits for reader closure, which `cleanup` follows instead.
  if (phase.kind !== "idle" && phase.item.id === copyKey(id)) void stop();
  const saved = progressSettled();
  tell();
  return { kind: "removed", saved, cleanup: clearFolder(id, readers) };
}

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

/**
 * After `drop`: once the native side has no task or publication of it and every reader captured
 * has actually closed, its resume data and folder go. A closure that doesn't come in time leaves
 * the folder for when it does, or for the next launch; one that fails or stays unknown never
 * deletes it in this process.
 */
async function clearFolder(id: string, readers: readonly Promise<void>[]) {
  closingFolders.add(id);
  const closed = Promise.all([transfers.drainDownload(id), ...readers]);
  const deadline = new Promise<"deferred">((resolve) =>
    setTimeout(() => resolve("deferred"), CLOSE_MS),
  );
  const settled = await Promise.race([closed.then(() => "closed" as const), deadline]).catch(
    () => "deferred" as const,
  );
  if (settled === "deferred") {
    void closed.then(
      () => deleteFolder(id),
      () => undefined,
    );
    return "deferred";
  }
  await deleteFolder(id);
  return "closed";
}

async function deleteFolder(id: string) {
  if (find(id)) return;
  await forget(id);
  try {
    const folder = folderOf(id);
    if (folder.exists) folder.delete();
    closingFolders.delete(id);
  } catch {
    // A folder no record names goes at the next launch.
  }
}

/** Ends the unfinished downloads of subscriptions no longer saved; copies stay. */
function endRemoved() {
  const roster = currentRoster();
  if (roster.kind !== "ready") return;
  const saved = new Set(roster.members.map((member) => member.entry.id));
  for (const record of doc.items) {
    if (record.state !== "complete" && !saved.has(record.subscriptionId)) {
      void removeRecord(record.id, "source-removed")
        .catch(() => undefined)
        .finally(tell);
    }
  }
}

const restricting = new Set<string>();
const exclusions = new Map<string, boolean>();

/** A retained classification also fences a copy while its provider lists are unavailable. */
function excludedDownload(record: Stored): boolean {
  return (
    excludedTitle({ ...record.title, subscriptionId: record.subscriptionId }) ??
    exclusions.get(record.id) ??
    record.excluded ??
    false
  );
}

/** An unfinished recognised request, failed without its binding and kept on the list. */
const fenced = (record: Stored): Stored => ({
  ...unbound(record),
  state: "failed",
  failure: {
    kind: "app",
    error: {
      kind: "unexpected",
      detail: describeError({ kind: "title-not-found", titleId: record.title.id }),
    },
  },
});

/** Retains recognised records and copies, fencing only their unfinished requests. */
async function endRestricted() {
  for (const record of doc.items) {
    if (!standing(record) || restricting.has(record.id)) continue;
    const excluded = excludedDownload(record);
    exclusions.set(record.id, excluded);
    restricting.add(record.id);
    try {
      try {
        if (Boolean(record.excluded) !== excluded)
          update(record.id, (latest) => ({ ...latest, excluded }));
      } catch {
        // A refused classification write cannot keep an active native request authorised.
      }
      if (
        owed.has(record.id) ||
        !excluded ||
        record.state === "complete" ||
        (record.state === "failed" && !boundOf(record))
      )
        continue;
      const bound = boundOf(record);
      if (bound) {
        const fence = await transfers.cancelAuthorization(bound.authorization, "remove");
        for (const receipt of fence.receipts) {
          if (
            receipt.authorization === bound.authorization &&
            receipt.outcome.kind === "complete"
          ) {
            await take(receipt, false);
          }
        }
      }
      const latest = find(record.id);
      if (latest && latest.state !== "complete" && standing(latest) && !owed.has(record.id))
        update(record.id, () => fenced(latest));
    } catch {
      // A refused native fence keeps its binding for reconciliation and the next attempt.
    } finally {
      restricting.delete(record.id);
    }
  }
}

/** Finishes every removal an earlier run wrote down and couldn't finish. */
async function finishRemovals() {
  for (const record of doc.items) {
    const removal = removalOf(record);
    if (typeof removal === "object") {
      await removeRecord(record.id, removal.reason).catch(() => undefined);
    }
  }
}

// Launch and the first foreground.

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
  complete =
    valid ||
    (read === null &&
      !new File(Paths.document, FILE).exists &&
      !new File(Paths.document, `${FILE}.next`).exists);
  for (const id of doc.forgetting) void forget(id);
}

/** Deletes folders no entry names, left by a removal that couldn't finish. */
function sweep() {
  if (!trusted) return;
  // An entry this build can't read keeps its own; a folder a reader may still have stays.
  const named = new Set([
    ...doc.items.map((record) => record.id),
    ...doc.unreadable.flatMap((item) =>
      "id" in item && typeof item.id === "string" ? [item.id] : [],
    ),
    ...closingFolders,
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
  const heardEarly = [...early.values()];
  early.clear();
  await applyFacts({ receipts: heardEarly, legacy: [] });
}

/**
 * Takes in everything the native side kept before anything else acts on downloads: build 14's
 * receipts, then every receipt in order. Then resume data an earlier build kept moves, folders no
 * record names go, unfinished removals finish and removed subscriptions' downloads end.
 */
async function prepare() {
  await rosterRead();
  const snapshot = await transfers.reconcile(foreground ? "ordinary" : "background");
  known = new Map(snapshot.authorizations.map((each) => [each.authorization, each]));
  await applyFacts(snapshot);
  await drain();
  await migrate();
  sweep();
  void finishRemovals();
  endRemoved();
}

/** Prepares the downloads, then, in the foreground, reconciles the first foreground. */
function prepareThenGo(): Promise<void> {
  phase = "starting";
  return prepare()
    .then(drain)
    .then(
      () => {
        phase = "ready";
        firstReady();
      },
      () => {
        phase = "failed";
      },
    )
    .finally(() => {
      tell();
      if (foreground) void firstForeground();
    });
}

/** Source ids a reset may start over: the saved subscriptions', the records' and the queue's. */
function knownSourceIds(snapshot: Snapshot): string[] {
  const ids = new Set([
    ...members().map((member) => member.entry.id),
    ...doc.items.map((record) => record.subscriptionId),
    ...snapshot.sources,
  ]);
  return [...ids].filter((id) => id.length > 0 && id.length <= 128);
}

/**
 * Asks the account owner to bind each signed-in login to its download generation, once launch's
 * passwords were read; a binding already asked for that exact login is waited for, not asked
 * again. Each one settled tells the screens and refills the queue.
 */
async function bindLogins(): Promise<void> {
  await launchSignIns();
  await Promise.all(
    members().flatMap((member) => {
      const id = member.entry.id;
      const source = currentSource(id);
      if (!source || downloadGeneration(source) !== null) return [];
      const asked = binding.get(source);
      if (asked) return [asked];
      const work = bindDownloadSource(id, source).finally(() => {
        if (binding.get(source) === work) binding.delete(source);
        tell();
        refill();
      });
      binding.set(source, work);
      return [work];
    }),
  );
}

/**
 * The first foreground reconciliation of this process: under the native barrier, every receipt
 * is taken in; a queue whose authority is damaged is started over once, its records' old
 * authorizations and the logins' bindings let go of and bound again; unfinished removals finish;
 * then the barrier ends and the queue is refilled. Refused or interrupted, it stays blocked, and
 * is tried again at the next foreground; later foregrounds only refill.
 */
async function firstForeground(): Promise<void> {
  if (barrier === "done") {
    void bindLogins();
    refill();
    return;
  }
  if (barrier === "running" || phase !== "ready") return;
  barrier = "running";
  try {
    let snapshot = await transfers.reconcile("first-foreground");
    known = new Map(snapshot.authorizations.map((each) => [each.authorization, each]));
    await applyFacts(snapshot);
    let bound = false;
    if (snapshot.blocked === "corrupt" && !repairTried) {
      repairTried = true;
      const reset = await transfers.resetQueue({
        queueEpoch: snapshot.queueEpoch,
        knownSourceIds: knownSourceIds(snapshot),
      });
      await applyFacts(reset);
      // Every unfinished record's authorization was the old queue's: each is asked again.
      for (const record of doc.items) {
        if (record.state !== "complete" && record.transfer !== undefined) {
          update(record.id, (latest) => ({
            ...unbound(latest),
            ...(latest.failure ? { failure: latest.failure } : {}),
          }));
        }
      }
      unbindDownloads();
      binding = new WeakMap();
      await bindLogins();
      bound = true;
      snapshot = await transfers.reconcile("first-foreground");
      known = new Map(snapshot.authorizations.map((each) => [each.authorization, each]));
      await applyFacts(snapshot);
    }
    const token = snapshot.foregroundToken;
    if (token === null || ["corrupt", "locked", "recovering"].includes(snapshot.blocked)) {
      barrier = "pending";
      return;
    }
    await finishRemovals();
    if (!bound) await bindLogins();
    await transfers.finishForegroundReconcile(token);
    barrier = "done";
  } catch {
    barrier = "pending";
    return;
  } finally {
    tell();
  }
  refill();
}

// The queue's window of authorizations.

/** Fills the native queue's window in the foreground, one refill at a time. */
function refill() {
  if (!foreground || barrier !== "done" || phase !== "ready") return;
  if (filling) {
    refillAgain = true;
    return;
  }
  filling = fill()
    .catch(() => undefined)
    .finally(() => {
      filling = null;
      tell();
      if (refillAgain) {
        refillAgain = false;
        refill();
      }
    });
}

async function fill() {
  await endRestricted();
  const snapshot = await transfers.reconcile("ordinary");
  known = new Map(snapshot.authorizations.map((each) => [each.authorization, each]));
  await applyFacts(snapshot);
  const names = new Set(doc.items.flatMap((record) => boundOf(record)?.authorization ?? []));
  for (const view of snapshot.authorizations) {
    // Reserved, then never written on a record: its record went or this app stopped between.
    if (view.state === "reserved" && !names.has(view.authorization)) {
      await transfers.cancelAuthorization(view.authorization, "abandon").catch(() => undefined);
    }
  }
  const pending = new Set(snapshot.receipts.map((receipt) => receipt.authorization));
  for (const record of doc.items) {
    const bound = boundOf(record);
    // An authorization the queue no longer has, with nothing owed for it: asked anew.
    if (
      bound &&
      record.state === "queued" &&
      standing(record) &&
      !known.has(bound.authorization) &&
      !pending.has(bound.authorization)
    ) {
      update(record.id, (latest) => ({ ...unbound(latest), state: "queued" }));
    }
  }
  let open = snapshot.authorizations.filter((view) => view.state !== "terminal").length;
  for (const record of doc.items) {
    if (open >= WINDOW || !foreground) break;
    if (await authorize(record)) open++;
  }
}

/**
 * Reserves, writes down, then arms one exact file request for a queued record whose login is
 * bound: only while its record, login and binding still stand once each answer came. A file left
 * beside it from an attempt never written down as complete goes first.
 */
async function authorize(record: Stored): Promise<boolean> {
  if (
    record.state !== "queued" ||
    excludedDownload(record) ||
    !standing(record) ||
    record.transfer !== undefined ||
    held.has(record.id) ||
    owed.has(record.id)
  ) {
    return false;
  }
  const source = currentSource(record.subscriptionId);
  const generation = source ? downloadGeneration(source) : null;
  if (!source || generation === null) return false;
  const stands = () => {
    const latest = find(record.id);
    return (
      latest?.state === "queued" &&
      latest.transfer === undefined &&
      standing(latest) &&
      currentSource(record.subscriptionId) === source &&
      downloadGeneration(source) === generation
    );
  };
  const free = freeBytes();
  const needed = record.size === null ? null : record.size - record.received;
  if (needed !== null && free !== null && free < needed) {
    update(record.id, (latest) => ({
      ...latest,
      state: "failed",
      failure: { kind: "disk-full", needed },
    }));
    return false;
  }
  const ref = { ...record.title, subscriptionId: record.subscriptionId };
  const file = await (async () => {
    await listedIndex(ref.subscriptionId, AbortSignal.timeout(20_000));
    admitTitle(ref);
    const asked = await source.provider.titleFile(
      record.title.kind,
      record.title.id,
      record.container,
      AbortSignal.timeout(20_000),
    );
    admitTitle(ref);
    return asked;
  })().catch((cause: unknown) => {
    if (stands()) {
      const detail = describeError(appError(cause));
      update(record.id, (latest) => ({
        ...latest,
        state: "failed",
        failure: { kind: "app", error: { kind: "unexpected", detail } },
      }));
    }
    return null;
  });
  if (!file || !stands()) return false;
  let authorization: string;
  try {
    authorization = await transfers.reserve({
      id: record.id,
      ext: extensionOf(record.container),
      sourceId: record.subscriptionId,
      sourceGeneration: generation,
    });
  } catch (cause) {
    // A generation the queue no longer enables: bound again, then refilled.
    if (refusalOf(cause) === "obsolete") {
      unbindDownloads(source);
      void bindLogins();
    }
    return false;
  }
  const abandon = () =>
    transfers.cancelAuthorization(authorization, "abandon").then(
      () => false,
      () => false,
    );
  if (!stands()) return abandon();
  if (excludedDownload(record)) {
    await abandon();
    update(record.id, (latest) => fenced(latest));
    return false;
  }
  try {
    const folder = folderOf(record.id);
    folder.create({ intermediates: true, idempotent: true });
    // Left by an attempt never written down as complete: there is no proof it is whole.
    const media = mediaOf(record);
    if (media.exists) media.delete();
    update(record.id, (latest) => {
      const { attempt: _attempt, ...rest } = latest;
      return {
        ...rest,
        transfer: { version: 2, authorization, sourceGeneration: generation, appliedSequence: 0 },
      };
    });
  } catch (cause) {
    await abandon();
    update(record.id, (latest) => ({
      ...latest,
      state: "failed",
      failure: { kind: "folder", detail: messageOf(cause) },
    }));
    return false;
  }
  tell();
  try {
    admitTitle(ref);
    await transfers.authorize(authorization, { url: file.url, headers: { ...file.headers } });
  } catch {
    // Never armed: retired, and the record asked again at the next refill.
    await abandon();
    if (boundOf(find(record.id) ?? record)?.authorization === authorization) {
      update(record.id, (latest) => ({ ...unbound(latest), state: "queued" }));
    }
    return false;
  }
  return true;
}

/**
 * At launch: reads the downloads, takes in what the native side kept, then follows the
 * subscriptions, the player and the app's state, refilling the queue in the foreground. Calling
 * it again does nothing.
 */
export function startDownloads(): void {
  if (started) return;
  started = true;
  try {
    load();
  } catch {
    // Shown empty; nothing is cleaned up.
  }
  connectDemoDownloads({ erase: eraseDownloads, ready });
  look();
  onAdmission({
    acquire: async (subscriptionId, lease) => {
      if (!transfers.available()) return;
      try {
        await transfers.acquirePlayback(subscriptionId, lease);
      } catch {
        throw new AppFailure({
          kind: "stream",
          failure: {
            kind: "network",
            detail: t("A download still holds the provider's connection."),
          },
        });
      }
    },
    release: (lease) => {
      if (transfers.available()) void transfers.releasePlayback(lease).catch(() => undefined);
    },
  });
  transfers.onReceipt(heard);
  transfers.onProgress(moved);
  foreground = AppState.currentState === "active";
  AppState.addEventListener("change", (state) => {
    const now = state === "active";
    if (now === foreground) return;
    foreground = now;
    // A transfer under way goes on in the background, and the native side starts the next.
    if (!foreground) return;
    look();
    tell();
    if (phase === "failed") void prepareThenGo();
    else void firstForeground();
  });
  playbackState.subscribe(tell);
  onRoster(() => {
    if (phase === "ready") {
      endRemoved();
      void endRestricted()
        .catch(() => undefined)
        .finally(tell);
    }
    tell();
    refill();
  });
  // A login set or dropped is bound once launch's passwords were read, before or after the first
  // foreground; a refused binding is asked again only at the next sign-in or foreground.
  onSignedIn(() => void bindLogins());
  tell();
  void prepareThenGo();
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

/** Whether a caller still wants what it asked: by default, always. */
type Stands = () => boolean;
const always: Stands = () => true;

/**
 * How a retry ended: queued again; `unchanged` as that download is gone or no longer failed; or
 * `stopped`, nothing written, as `stands` ended.
 */
export type Retried = "queued" | "unchanged" | "stopped";

/**
 * Queues a failed download again, by the file type its provider lists now when it can say: only
 * that record, while it is still failed and `stands` still holds once the lookup answered.
 */
async function again(record: Stored, stands: Stands = always): Promise<Retried> {
  const ref: TitleRef = { ...record.title, subscriptionId: record.subscriptionId };
  if (excludedDownload(record)) throw new AppFailure({ kind: "title-not-found", titleId: ref.id });
  const container = await titleFile(ref, AbortSignal.timeout(20_000)).then(
    (file) => file.container,
    () => record.container,
  );
  // Lookup failure may retain its known container, but never grants catalogue admission.
  admitTitle(ref);
  const latest = find(record.id);
  if (latest?.state !== "failed" || !standing(latest)) return "unchanged";
  if (!stands()) return "stopped";
  update(record.id, () => ({ ...unbound(latest), container, state: "queued" }));
  tell();
  refill();
  return "queued";
}

/**
 * Queues a movie or an episode, the exact version given, keeping its details and artwork for the
 * copy. One already queued or downloaded, or added while this looked it up, answers as it is; a
 * failed one is queued again. Rejects while its subscription isn't signed in, when its provider
 * doesn't list it, or when the subscription was removed or signed in anew meanwhile; while the
 * lists are made again with its subscription's in them, as after another's removal, it waits.
 * Final admission also refuses once Demo starts erasing, even while its old Source stays current.
 */
export async function addDownload(ref: TitleRef): Promise<Download> {
  startDownloads();
  admitTitle(ref);
  const answer = async (known: Stored) => {
    if (known.state === "failed") await again(known);
    tell();
    const shown = list.get().items.find((item) => item.id === known.id);
    if (!shown) throw new AppFailure({ kind: "title-not-found", titleId: ref.id });
    return shown;
  };
  const known = doc.items.find((each) => sameTitle(each, ref));
  if (known && excludedDownload(known))
    throw new AppFailure({ kind: "title-not-found", titleId: ref.id });
  if (known) return answer(known);
  const source = sourceOf(ref.subscriptionId);
  const file = await titleFile(ref, AbortSignal.timeout(20_000));
  const kept = await aboutOf(ref, AbortSignal.timeout(20_000));
  admitTitle(ref);
  if (!savable(ref.subscriptionId, source)) {
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
    ...(kept.continuation ? { continuation: kept.continuation } : {}),
  };
  commit({ ...doc, items: [...doc.items, record] });
  void keepArtwork(record.id, kept.artwork);
  tell();
  refill();
  return viewOf(record, new Map(members().map((m) => [m.entry.id, m.label])), borrowed());
}

function newId(): string {
  let id: string;
  do id = `d-${Date.now().toString(36)}-${(++made).toString(36)}`;
  while (
    find(id) ||
    doc.forgetting.includes(id) ||
    closingFolders.has(id) ||
    doc.unreadable.some((item) => "id" in item && item.id === id)
  );
  return id;
}

/**
 * Cancels an unfinished download or deletes a copy, with its files and resume data: its
 * authorization is fenced on the native side before its record goes, and its folder goes once
 * its task and any player reading the copy actually closed, waited for a while. Rejects, its
 * removal kept for the next launch to finish, when the record can't be written or the fence
 * can't be made.
 */
export async function removeDownload(id: string): Promise<void> {
  const removed = await removeRecord(id, "user");
  tell();
  if (removed.kind === "removed") await removed.cleanup;
  refill();
}

/** What removing a subscription's downloads for its reset established. */
export interface Erased {
  /**
   * Whether every download of the subscription was known: downloads.json read as this build
   * writes it, or absent, with no entry this build can't read that may be the subscription's.
   */
  readonly trusted: boolean;
  /** Records gone, each under a durable native fence. */
  readonly removed: number;
  /** Records left with their removal written down, as a fence or a write was refused. */
  readonly kept: number;
  /** Settles once the removed copies' final saves of progress ended. */
  readonly saved: Promise<void>;
  /**
   * Settles once every folder went after its task and readers actually closed, or `deferred`
   * while one hasn't; such a folder goes later, never while a reader may still have it.
   */
  readonly cleanup: Promise<"closed" | "deferred">;
}

/**
 * Removes every download of `subscriptionId`, copies too, for its reset: each record's intent is
 * written, its authorization fenced, then its record dropped, and Watch showing one of its
 * copies, failed or not, stops.
 * Resolves once each record is gone or its intent written down; never waits for a task, a reader,
 * the downloads' readiness or a binding, so an account change may await it. A record left keeps
 * its intent: the next reconciliation finishes it, and never asks for it again.
 */
export async function eraseDownloads(
  subscriptionId: string,
  reason: "demo-reset",
): Promise<Erased> {
  const ids = doc.items
    .filter((record) => record.subscriptionId === subscriptionId)
    .map((r) => r.id);
  const unknown = doc.unreadable.some(
    (item) =>
      !("subscriptionId" in item) ||
      typeof item.subscriptionId !== "string" ||
      item.subscriptionId === subscriptionId,
  );
  const settled = await Promise.allSettled(ids.map((id) => removeRecord(id, reason)));
  const removed = settled.flatMap((each) =>
    each.status === "fulfilled" && each.value.kind === "removed" ? [each.value] : [],
  );
  tell();
  return {
    trusted: complete && !unknown,
    removed: removed.length,
    kept: settled.filter((each) => each.status === "rejected").length,
    saved: Promise.all(removed.map((each) => each.saved)).then(() => undefined),
    cleanup: Promise.all(removed.map((each) => each.cleanup)).then((all) =>
      all.includes("deferred") ? "deferred" : "closed",
    ),
  };
}

/**
 * How replacing a missing copy ended: queued anew; its file was there after all (`kept`); no
 * missing copy of it, or it was queued again meanwhile by someone else (`unchanged`); or removed,
 * then not queued again as `stands` ended (`stopped`).
 */
export type Replaced =
  | { readonly kind: "replaced"; readonly download: Download }
  | { readonly kind: "kept" | "unchanged" | "stopped" };

/**
 * Downloads a movie or an episode anew whose copy's file is gone: its record goes, with the
 * copy's own progress, then it is queued as `addDownload` queues it, only while `stands` still
 * holds once the removal and the old copy's readers ended. A removal that ended stays. A copy
 * whose file is there after all stays as it is. Rejects, changing nothing, while that copy is
 * what Watch opens or plays: the player may still read the file, so the viewer stops it first.
 */
export async function replaceMissingDownload(
  ref: TitleRef,
  stands: Stands = always,
): Promise<Replaced> {
  const record = doc.items.find((each) => sameTitle(each, ref));
  if (record?.state !== "complete") return { kind: "unchanged" };
  if (mediaOf(record).exists) {
    missing.delete(record.id);
    tell();
    return { kind: "kept" };
  }
  if (playingItem(playbackState.get().phase)?.id === copyKey(record.id)) {
    throw new AppFailure({ kind: "unexpected", detail: "Stop playing this copy first." });
  }
  // Checked and removed in one go: nothing plays it in between.
  const removed = await removeRecord(record.id, "replace-missing");
  tell();
  const closed = removed.kind === "removed" ? await removed.cleanup : "closed";
  if (!stands()) return { kind: "stopped" };
  if (closed === "deferred") {
    throw new AppFailure({
      kind: "unexpected",
      detail: "The old copy is still closing. Try again.",
    });
  }
  if (doc.items.some((each) => sameTitle(each, ref))) return { kind: "unchanged" };
  // Asked at once: the login `addDownload` takes as it starts is the one `stands` just checked.
  return { kind: "replaced", download: await addDownload(ref) };
}

/**
 * Queues a failed download again, unless it is gone, being removed or no longer failed by the
 * time its file type is looked up, or `stands` no longer holds then.
 */
export async function retryDownload(id: string, stands: Stands = always): Promise<Retried> {
  const record = find(id);
  return record?.state === "failed" && standing(record) ? again(record, stands) : "unchanged";
}

/** A complete copy that isn't being removed: the only kind that plays. */
const playable = (record: Stored | undefined): record is Stored =>
  record?.state === "complete" && !excludedDownload(record) && removalOf(record) === undefined;

/**
 * Plays a copy in Watch from where it was left, from the phone: no provider, login or network.
 * Where it was left is read once every save of progress asked before ended, so a position Close
 * or Stop just saved counts; anything the viewer asks meanwhile, the copy going or its removal
 * being written down, cancels it. Its progress stays with the copy, and goes to its
 * subscription's viewing record too while that subscription is saved (`keepProgress`). A copy
 * whose file is gone fails in Watch as unavailable. Manual Next follows only its saved immediate
 * successor when that exact local copy is complete.
 */
export function playDownload(id: string): void {
  const asked = request();
  void progressSettled().then(() => {
    const record = find(id);
    if (asked.stands() && playable(record)) playCopy(id, record);
  });
}

/** Only the saved immediate successor, never the next copy that happens to be downloaded. */
function nextCopy(record: Stored): Stored | undefined {
  if (record.title.kind !== "episode" || record.continuation === undefined) return;
  const edge = Continuation()(record.continuation);
  if (edge instanceof type.errors || edge.title.kind !== "episode") return;
  if (edge.title.seriesId !== record.title.seriesId || edge.title.id === record.title.id) return;
  const ref: TitleRef = { ...edge.title, subscriptionId: record.subscriptionId };
  const copy = doc.items.find((each) => sameTitle(each, ref));
  if (
    playable(copy) &&
    copy.title.kind === "episode" &&
    copy.title.seriesId === record.title.seriesId &&
    copy.title.season === edge.title.season &&
    copy.title.episode === edge.title.episode
  ) {
    try {
      if (mediaOf(copy).exists) return copy;
    } catch {
      // An unreadable successor cannot prevent this copy from playing.
    }
  }
}

/** Plays copy `id` as its record stands now. */
function playCopy(id: string, record: Stored) {
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
    next: nextCopy(record) !== undefined,
    versions: false,
  };
  const from =
    progress && !isFinished(progress.position, progress.duration)
      ? Math.max(0, progress.position - 5)
      : 0;
  void play(
    item,
    {
      kind: "file",
      originalLanguage: record.about.originalLanguage,
      open: async () => {
        // A removal written down meanwhile, or done, closes the copy to new readers.
        if (!playable(find(id)) || !media.exists) {
          if (playable(find(id))) missing.add(id);
          tell();
          throw new AppFailure({ kind: "stream", failure: { kind: "unavailable", status: 404 } });
        }
        return {
          url: media.uri,
          container: record.container,
          admit: () => {
            if (!playable(find(id)))
              throw new AppFailure({ kind: "title-not-found", titleId: record.title.id });
          },
        };
      },
    },
    {
      watch: true,
      login: [],
      from,
      progress: (position, duration) => keepProgress(id, position, duration, since),
      next: (saved) => {
        const asked = request();
        void saved.then(async (result) => {
          if (!result.saved) return;
          await progressSettled();
          if (!asked.stands()) return;
          const current = find(id);
          const next = current && nextCopy(current);
          if (next) playCopy(next.id, next);
        });
      },
    },
  );
}

/**
 * Saves how far a copy played in its record, and in its subscription's viewing record while that
 * subscription is saved. Once both ended, rejects when either refused it; the one that refused
 * keeps what it held before, the other has the new position. A copy removed meanwhile saves
 * nothing.
 */
async function keepProgress(id: string, position: number, duration: number, since: number) {
  const record = find(id);
  if (!record) return;
  const copy = (async () => {
    update(id, (latest) => ({
      ...latest,
      progress: { position: Math.min(position, duration), duration, at: Date.now() },
    }));
    tell();
  })();
  const { subscriptionId } = record;
  const viewed = members().some((member) => member.entry.id === subscriptionId)
    ? recordProgress({ ...record.title, subscriptionId }, position, duration, since)
    : undefined;
  const refused = (await Promise.allSettled([copy, viewed])).find(
    (ended): ended is PromiseRejectedResult => ended.status === "rejected",
  );
  if (refused) throw refused.reason;
}

/**
 * What a download keeps of its title's details, and where its pictures are online, from the lists
 * once they show (`listedIndex`, given up with `signal`).
 */
async function aboutOf(ref: TitleRef, signal: AbortSignal) {
  const index = await listedIndex(ref.subscriptionId, signal);
  const missingTitle = new AppFailure({ kind: "title-not-found", titleId: ref.id });
  if (ref.kind === "movie") {
    const title = titleOf(index, "movie", ref);
    if (!title) throw missingTitle;
    const details = await detailsOf({ ...title, subscriptionId: ref.subscriptionId, id: ref.id });
    return {
      continuation: undefined,
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
  const series = titleOf(index, "series", version);
  if (!series) throw missingTitle;
  const details = await detailsOf({ ...series, ...version });
  const seasons = details.kind === "series" ? details.seasons : [];
  const season = seasons.find((each) => each.number === ref.season);
  const told = season ? await episodesOf(series, season).catch(() => season.episodes) : [];
  const episode =
    told.find((each) => each.id === ref.id) ??
    seasons.flatMap((each) => each.episodes).find((each) => each.id === ref.id);
  const after = details.kind === "series" ? nextEpisode(details, ref) : null;
  return {
    continuation: after
      ? ({
          version: 1,
          title: {
            kind: "episode",
            id: after.id,
            seriesId: ref.seriesId,
            season: after.season,
            episode: after.number,
          },
        } satisfies Infer<typeof Continuation>)
      : undefined,
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

/**
 * Fetches a download's pictures into its folder, on the picture session that keeps no URL cache
 * (picture-transfer.ts), so the copy shows them offline. They stay the download's own.
 */
async function keepArtwork(
  id: string,
  urls: { readonly poster: string | null; readonly wide: string | null },
) {
  for (const artwork of ["poster", "wide"] as const) {
    const url = urls[artwork];
    if (!url || !/^https?:\/\//.test(url) || !find(id)) continue;
    try {
      folderOf(id).create({ intermediates: true, idempotent: true });
      await fetchPicture(url, artworkOf(id, artwork), { timeoutMs: ARTWORK_MS });
      update(id, (latest) => ({ ...latest, artwork: { ...latest.artwork, [artwork]: true } }));
      tell();
    } catch {
      // Without it, the copy shows its name.
    }
  }
}
