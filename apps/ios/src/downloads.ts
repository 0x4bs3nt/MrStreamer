import { type } from "arktype";
import type { Download, DownloadList } from "@mrstreamer/contracts/downloads";
import { AppFailure } from "@mrstreamer/contracts/errors";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { RawTitleRef, type TitleRef } from "@mrstreamer/contracts/ondemand";
import type { StreamFailure } from "@mrstreamer/contracts/playback";
import { t } from "@mrstreamer/core/i18n";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { Directory, File, Paths } from "expo-file-system";
import { AppState } from "react-native";
import { currentRoster, members, onRoster } from "./account.ts";
import { transfer, type Transfer, type TransferEnd } from "./download-task.ts";
import { appError, describeError, withoutLogin } from "./errors.ts";
import { readJson, writeJson } from "./files.ts";
import { onReclaim, play, playbackState, playingItem, stop, type Playing } from "./playback.ts";
import { keychainSecrets } from "./secrets.ts";
import { currentSource, loginOf, sourceOf } from "./sources.ts";
import { store, useStore } from "./store.ts";
import { detailsOf, episodesOf, titleFile, titleLists, titleOf } from "./titles.ts";
import { recordProgress } from "./viewing.ts";

// Movies and episodes downloaded to this iPhone: the queue, its one transfer at a time, and the
// copies that play with no provider, as the desktop's downloads do. This module alone writes
// downloads.json, the folders in Documents/downloads and the Keychain items `download:<id>`.
//
// A download names the exact provider file by its subscription and the provider's own ids, so
// two providers' titles of one id never meet. Its record holds what the copy shows and plays
// with: details, artwork kept in its folder, the file type, how far it got and how far it was
// watched. No record holds an address, a header, a login or resume data. The file's address is
// made from the subscription's login only as a transfer starts (`sources.ts`).
//
// One download transfers at a time, by `download-task.ts` (expo-file-system's native task, in a
// foreground URLSession). A stream of the same subscription takes the connection back first: the
// transfer pauses, and its request has ended before the stream's goes out (`onReclaim`). When it
// doesn't end in time, the stream fails rather than ask the provider for a second connection. It
// waits until nothing of that subscription streams; another subscription's stream, or a copy, lets
// it go on. A provider can take a moment to free the connection of a request that ended, so the
// next request of that subscription, a stream's, the queue's next download or a transfer's fresh
// start after its resumed request broke, waits until `RELEASE_MS` after this app's last one
// ended. Sending the app to the background pauses a transfer too: iOS suspends the app soon
// after, and a foreground session doesn't run while it is suspended. A pause keeps URLSession's
// resume data in the Keychain, since it names the address with the login; a transfer goes on
// from it only when it was made for the very address the subscription gives now, and when it
// can't, it starts again and says so (`restarted`). Should the app be killed before the pause is
// written, the next launch starts that download again: nothing promises the pause comes first.
//
// A copy is complete only once the native task said it moved every byte into place and the size
// matches what the server announced. A launch trusts nothing else: a file left beside an unfinished
// record is deleted and asked for again. Removing a subscription ends its unfinished downloads,
// with their files and resume data; its copies stay and play, keeping their own progress.

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
    /** A transfer under way is `queued` on disk: a launch starts it again. */
    state: "'queued' | 'failed' | 'complete'",
    "failure?": Failure(),
    /** The whole file's bytes once the server said; once complete, the bytes on disk. */
    size: "number | null",
    /** Bytes received when it last paused or was written down. */
    received: "number",
    restarted: "boolean",
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
    /** Ids whose Keychain item still has to go: launch removes them. */
    forgetting: "string[]",
  }),
);

interface Doc {
  readonly items: readonly Stored[];
  readonly forgetting: readonly string[];
  /** Entries this build can't read, kept as they are with their folders. */
  readonly unreadable: readonly object[];
}

/** What a resume secret holds: the address the resume data was made for, and the data. */
const Resume = lazy(() => type({ url: "string", resumeData: "string" }));

/** The transfer under way. */
interface Active {
  readonly id: string;
  readonly subscriptionId: string;
  /** Null until the native task is made. */
  transfer: Transfer | null;
  /** Why this side asked it to stop, which decides what its end means. */
  stopping: "pause" | "cancel" | null;
  /** The bytes the disk lacks for the rest, when that stopped it. */
  short: number | null;
  received: number;
  size: number | null;
  /**
   * The whole file's size as a request from the start announced it, which a complete copy has
   * to match; null when unknown. A resumed request's announcement isn't taken: what URLSession
   * reports for it isn't the whole file's on every server.
   */
  expected: number | null;
  rate: number | null;
  restarted: boolean;
  /** Settles once it asks the provider nothing more: its last request ended, or it stopped. */
  closed: Promise<void>;
  /** Settles once how it ended is written down. */
  over: Promise<void>;
}

/** How a transfer ended, as this module writes it down. */
type Ending =
  | Exclude<TransferEnd, { readonly kind: "paused" }>
  /** Paused, with the address its resume data was made for. */
  | { readonly kind: "paused"; readonly resumeData: string | null; readonly url: string }
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
let started = false;
let active: Active | null = null;
/** The app is in the background: nothing transfers until it is back. */
let away = false;
/** Copies whose file was gone when last looked. */
const missing = new Set<string>();
/** Unfinished downloads that ended with their subscription since launch. */
let ended = 0;
let made = 0;
/** When this app's last request of each subscription ended, a download's or a stream's. */
const released = new Map<string, number>();
/** The subscription whose stream had the connection when playback last changed. */
let streaming: string | null = null;
/** Wakes the queue once a subscription's connection had time to be freed. */
let later: ReturnType<typeof setTimeout> | null = null;

const folderOf = (id: string) => new Directory(Paths.document, ROOT, id);
/** A file type safe to name a file with; anything else is kept as "bin", as on the desktop. */
const extensionOf = (container: string) =>
  /^[a-z0-9]{1,8}$/i.test(container) ? container.toLowerCase() : "bin";
const mediaOf = (record: Stored) =>
  new File(folderOf(record.id), `media.${extensionOf(record.container)}`);
const artworkOf = (id: string, artwork: "poster" | "wide") => new File(folderOf(id), artwork);
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

/** Removes a download's resume secret, keeping its id listed for the next launch until it goes. */
async function forget(id: string) {
  try {
    await keychainSecrets.remove(secretOf(id));
    if (doc.forgetting.includes(id)) {
      commit({ ...doc, forgetting: doc.forgetting.filter((each) => each !== id) });
    }
  } catch {
    // Listed in `forgetting`: the next launch removes it.
  }
}

async function readResume(id: string): Promise<Infer<typeof Resume> | null> {
  const saved = await keychainSecrets.read(secretOf(id)).catch(() => null);
  if (!saved) return null;
  try {
    const parsed = Resume()(JSON.parse(saved));
    return parsed instanceof type.errors ? null : parsed;
  } catch {
    return null;
  }
}

function freeBytes(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return Number.isFinite(free) ? free : null;
  } catch {
    return null;
  }
}

/** The subscription whose stream has the provider's connection, if one does. */
function borrowed(): string | null {
  const { phase } = playbackState.get();
  return phase.kind === "loading" || phase.kind === "playing" || phase.kind === "paused"
    ? phase.item.subscriptionId
    : null;
}

function viewOf(record: Stored, names: ReadonlyMap<string, string>, busy: string | null): Download {
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
            : busy === record.subscriptionId
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
  if (why === "cancel") transferring.transfer?.cancel();
  else transferring.transfer?.pause();
}

/** Milliseconds until a request of `subscriptionId` may go out, after the last of ours ended. */
function freeing(subscriptionId: string): number {
  const at = released.get(subscriptionId);
  return at === undefined ? 0 : Math.max(0, at + RELEASE_MS - Date.now());
}

const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Starts the first download the queue can have now, unless one transfers. */
function wake() {
  if (!started || active || away) return;
  const busy = borrowed();
  const ready = doc.items.filter(
    (record) =>
      record.state === "queued" &&
      record.subscriptionId !== busy &&
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

function begin(record: Stored) {
  const transferring: Active = {
    id: record.id,
    subscriptionId: record.subscriptionId,
    transfer: null,
    stopping: null,
    short: null,
    received: record.received,
    size: record.size,
    expected: null,
    rate: null,
    restarted: record.restarted,
    closed: Promise.resolve(),
    over: Promise.resolve(),
  };
  active = transferring;
  tell();
  const ran = run(record, transferring).catch((cause: unknown): Ending => {
    const error = appError(cause);
    return {
      kind: "failed",
      failure: {
        kind: "app",
        error: { kind: "unexpected", detail: describeError(error) },
      },
    };
  });
  transferring.closed = ran.then(() => undefined);
  transferring.over = ran
    .then((ending) => settle(record.id, transferring, ending))
    .catch((cause: unknown) => {
      // Its end couldn't be written down. Failed as far as this run knows, so the queue doesn't
      // take it again and again; the file says what it was, for the next launch.
      doc = {
        ...doc,
        items: doc.items.map((each) =>
          each.id === record.id && each.state === "queued"
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

/** Asks the provider for `record`'s file and has the native task write it into its folder. */
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
  let saved = await readResume(record.id);
  // Made for another address (another login, server or file type): it can't be trusted.
  if (saved && saved.url !== file.url) {
    saved = null;
    await forget(record.id);
  }
  const free = freeBytes();
  if (record.size !== null && free !== null) {
    const needed = record.size - (saved ? record.received : 0);
    if (free < needed) return { kind: "failed", failure: { kind: "disk-full", needed } };
  }
  if (transferring.stopping) return { kind: "stopped" };
  const login = loginOf(record.subscriptionId);
  const attempt = (resumeData: string | null): Promise<TransferEnd> => {
    const from = resumeData ? record.received : 0;
    if (!resumeData && record.received > 0) transferring.restarted = true;
    transferring.received = from;
    tell();
    let first = true;
    let savedAt = Date.now();
    let measured = { at: Date.now(), received: from };
    const native = transfer({
      url: file.url,
      ...(file.headers ? { headers: file.headers } : {}),
      destination: media,
      resumeData,
      progress: (written, total) => {
        if (active !== transferring) return;
        // A server that sent the whole file again, as a changed file does, starts from zero.
        const whole = !resumeData || written < from;
        if (first && resumeData && written < from) transferring.restarted = true;
        if (first && whole) transferring.expected = total;
        if (first && total !== null) {
          const room = freeBytes();
          if (room !== null && room < total - written) {
            transferring.short = total - written;
            halt(transferring, "cancel");
          }
        }
        first = false;
        const now = Date.now();
        if (now - measured.at >= 1000) {
          const rate = ((written - measured.received) * 1000) / (now - measured.at);
          transferring.rate = rate >= 0 ? rate : null;
          measured = { at: now, received: written };
        }
        transferring.received = written;
        transferring.size = total;
        tellSoon();
        if (now - savedAt >= SAVE_MS) {
          savedAt = now;
          try {
            update(record.id, (latest) => ({
              ...latest,
              received: written,
              size: total,
              restarted: transferring.restarted,
            }));
          } catch {
            // Written down when it pauses or ends.
          }
        }
      },
    });
    transferring.transfer = native;
    // The provider may still be freeing the connection of the request that just ended.
    return native.ended.finally(() => released.set(record.subscriptionId, Date.now()));
  };
  const ending = await attempt(saved?.resumeData ?? null);
  // Resume data URLSession wouldn't go on from, or a server that no longer takes it: once more
  // from the start, before anything counts as failed.
  const untrusted =
    saved !== null &&
    !transferring.stopping &&
    (ending.kind === "refused" || ending.kind === "network" || ending.kind === "folder");
  if (!untrusted) return withUrl(ending, file.url, login);
  await forget(record.id);
  await after(freeing(record.subscriptionId));
  if (transferring.stopping || currentSource(record.subscriptionId) !== source) {
    return { kind: "stopped" };
  }
  return withUrl(await attempt(null), file.url, login);
}

/** A pause's resume data with the address it was made for; failures without the login. */
function withUrl(ending: TransferEnd, url: string, login: readonly string[]): Ending {
  switch (ending.kind) {
    case "paused":
      return { kind: "paused", resumeData: ending.resumeData, url };
    case "folder":
    case "network":
      return { ...ending, detail: withoutLogin(ending.detail, login) };
    default:
      return ending;
  }
}

/** Writes down how a transfer ended: a copy, a failure, or where it paused. */
async function settle(id: string, transferring: Active, ending: Ending) {
  const record = find(id);
  // Removed meanwhile: the removal deletes its files and secret.
  if (!record) return;
  const { received, size, restarted, expected } = transferring;
  const where = { ...record, received, size, restarted };
  const fail = (failure: StoredFailure) =>
    update(id, () => ({ ...where, state: "failed", failure }), true);
  /** Queued to start again from the start: nothing it got can be gone on from. */
  const requeue = () => update(id, () => ({ ...withoutFailure(where), state: "queued" }), true);
  switch (ending.kind) {
    case "complete": {
      const media = mediaOf(record);
      const bytes = media.exists ? (media.size ?? 0) : 0;
      // Only what URLSession moved into place, at the size the server announced, is a copy.
      if (bytes <= 0 || (expected !== null && bytes !== expected)) {
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
    case "paused": {
      if (ending.resumeData) {
        const kept = await keychainSecrets
          .write(secretOf(id), JSON.stringify({ url: ending.url, resumeData: ending.resumeData }))
          .then(
            () => true,
            () => false,
          );
        // Removed while the Keychain wrote it: it goes again.
        if (!find(id)) {
          await forget(id);
          return;
        }
        if (kept) {
          update(id, () => ({ ...withoutFailure(where), state: "queued" }));
          return;
        }
      }
      requeue();
      break;
    }
    case "cancelled":
      if (transferring.short !== null) fail({ kind: "disk-full", needed: transferring.short });
      else requeue();
      break;
    case "stopped":
      return;
    case "failed":
      fail(ending.failure);
      break;
    case "refused":
      fail({ kind: "stream", failure: refusal(ending.status) });
      break;
    case "folder":
      fail({ kind: "folder", detail: ending.detail });
      break;
    case "network":
      // Broken off by a pause this side asked for, or by iOS suspending the app: it goes on from
      // the start later, rather than failing.
      if (transferring.stopping || away) requeue();
      else fail({ kind: "stream", failure: { kind: "network", detail: ending.detail } });
      break;
  }
  // Shown before the Keychain answers: until then a screen would still offer the transfer's
  // Cancel, and act on it, for what is now a copy or a failure.
  tell();
  await forget(id);
}

function withoutFailure(record: Stored): Stored {
  const { failure: _failure, ...rest } = record;
  return rest;
}

/** The desktop's reading of an HTTP status for a stream. */
function refusal(status: number): StreamFailure {
  if ([401, 403, 429, 458, 509].includes(status)) return { kind: "refused", status };
  if (status === 404 || status === 410) return { kind: "unavailable", status };
  return { kind: "provider-error", status };
}

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Takes a download's record out at once, so nothing writes it back, with its secret listed to go.
 * Throws, changing nothing, when Documents won't take it.
 */
function drop(id: string) {
  commit({
    ...doc,
    items: doc.items.filter((each) => each.id !== id),
    forgetting: [...doc.forgetting.filter((each) => each !== id), id],
  });
  missing.delete(id);
}

/** After `drop`: its transfer stops, a copy that plays stops, and its secret and folder go. */
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
function reconcile() {
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

/**
 * Gives a subscription's connection back to its stream: the transfer pauses, or is cancelled, and
 * the provider gets `RELEASE_MS` to free it. Rejects, so the stream fails without asking the
 * provider, when the transfer's request still hasn't ended; the stream's Try again asks again.
 */
async function reclaim(subscriptionId: string): Promise<void> {
  const transferring = active;
  if (transferring?.subscriptionId === subscriptionId) {
    halt(transferring, "pause");
    const closed = (ms: number) =>
      Promise.race([transferring.closed.then(() => true), after(ms).then(() => false)]);
    // Without a native task yet, a halted transfer asks the provider nothing.
    if (transferring.transfer && !(await closed(RECLAIM_MS))) {
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

/** Reads downloads.json; deletes what an earlier run left: secrets, files and folders. */
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
  for (const id of doc.forgetting) void forget(id);
  if (!valid) return;
  // Folders no entry names, left by a removal that couldn't finish; an entry this build can't
  // read keeps its own.
  const named = new Set([
    ...items.map((record) => record.id),
    ...unreadable.flatMap((item) => ("id" in item && typeof item.id === "string" ? [item.id] : [])),
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

/**
 * At launch: reads the downloads, then follows the subscriptions, the player and the app's
 * state, starting the queue when it can. Calling it again does nothing.
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
  away = AppState.currentState === "background";
  AppState.addEventListener("change", (state) => {
    const now = state === "background";
    if (now === away) return;
    away = now;
    if (away && active) halt(active, "pause");
    if (!away) {
      look();
      tell();
      wake();
    }
  });
  playbackState.subscribe(() => {
    const busy = borrowed();
    if (streaming !== null && streaming !== busy) released.set(streaming, Date.now());
    streaming = busy;
    if (active && active.subscriptionId === busy) halt(active, "pause");
    tell();
    wake();
  });
  onRoster(() => {
    reconcile();
    tell();
    wake();
  });
  reconcile();
  tell();
  wake();
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
      return { url: media.uri, hls: false };
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
