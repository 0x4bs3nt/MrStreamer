import { AppFailure, type AppError } from "@mrstreamer/contracts/errors";
import type { LoginInput } from "@mrstreamer/contracts/ipc";
import type { AccountStatus } from "@mrstreamer/contracts/subscription";
import { streamsToPlay } from "@mrstreamer/core/catalogue/variants";
import type { LiveCatalogue, OnDemandCatalogue, Provider } from "@mrstreamer/core/provider";
import { parseLogin, xtreamProvider, type XtreamAccount } from "@mrstreamer/core/xtream";
import Constants from "expo-constants";
import { dropLists, pruneLists, readList, writeList, type Saved } from "./catalogue-cache.ts";
import { dropTitles, pruneDetails } from "./details-cache.ts";
import { appError, hostOf } from "./errors.ts";
import {
  combine,
  combineSteps,
  inTasks,
  partSteps,
  type Channel,
  type Labelled,
  type Library,
  type LiveSource,
  type Part,
} from "./library.ts";
import { play, playbackState, request, stop } from "./playback.ts";
import { keychainSecrets } from "./secrets.ts";
import { currentSource, dropSource, loginOf, setSource, sourceOf, type Source } from "./sources.ts";
import {
  firstLaunch,
  migrateRecentChannels,
  readState,
  rememberChannel,
  withoutVersions,
  writeState,
  type SavedState,
} from "./storage.ts";
import { store, useStore } from "./store.ts";
import {
  EMPTY_REGISTRY,
  migrated,
  newSubscriptionId,
  readRegistry,
  sameAccount,
  withoutPending,
  withoutSubscription,
  withPending,
  writeRegistry,
  type Registry,
  type SubscriptionEntry,
} from "./subscriptions.ts";
import { noteAction } from "./telemetry/index.ts";
import { eraseViewing, setViewingChannels, setViewingOwners } from "./viewing.ts";
import { eraseWatchlist, setWatchlistOwners } from "./watchlist.ts";

// The saved subscriptions, each signed in on its own, and their lists. Everything from all of them
// shows together: there is no subscription to switch to. Each has its own login, lists, loads and
// failures, so one that fails, reloads or is removed leaves the others as they are, and the one
// player plays from any of them.
//
// This module alone changes the registry (subscriptions.ts), the Keychain items of subscriptions
// and the roster screens read; one change at a time, so an add, an edit and a removal never
// interleave their writes. Logins stay in sources.ts, never in a store. Each subscription's
// channels load at once; its movie and series lists (titles.ts indexes them together) once its
// login has been checked. Its viewing record (viewing.ts) and watchlist (watchlist.ts) are kept
// under its id, which an account added again after a removal takes back.
//
// A list a provider gives is saved on the phone too (catalogue-cache.ts), and a launch shows it
// while each subscription signs in again. One saved less than 12 hours ago shows as loaded, and
// the provider isn't asked for it, though the login is still checked; an older one shows while
// its list loads again, and stays when that fails. Reload, Try again and an add always ask the
// provider. A new password, for an account added again or edited, or an account added again
// under a removed one's id, is given to the Keychain only once its saved lists are gone; when
// they can't be deleted, the change fails and the login stays as it was. A removal deletes them
// as it can, leaving the rest to the next launch or the next add. No list of an earlier login is
// saved after a deletion, and a write under way can't bring them back. When the change fails after
// that deletion, as when the Keychain refuses the password, the subscription signs in again with
// whichever password the Keychain holds then, or asks for one (`recoverLogin`). The details of titles
// opened from it (details-cache.ts, which titles.ts saves while `savable` holds) go with its lists.
// Which saved lists a launch is still reading is kept apart from the lists (`readingSaved`): a list
// stays idle while its copy is read, and after it when there is none, until its provider is asked.

/** A list one subscription loads; a failed or repeated load keeps the last one it had. */
export type Loadable<A> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly last: A | null }
  | {
      readonly kind: "ready";
      readonly value: A;
      /** Asked of the provider, or the copy saved on the phone at launch. */
      readonly from: "provider" | "cache";
      /** When the provider gave it, epoch milliseconds. */
      readonly fetchedAt: number;
      /** Milliseconds the provider took; null for a saved copy. */
      readonly took: number | null;
    }
  | {
      readonly kind: "failed";
      readonly error: AppError;
      readonly last: A | null;
      /** When it failed, epoch milliseconds. */
      readonly since: number;
    };

/** A saved subscription as the screens see it: no login. */
export interface Member {
  readonly entry: SubscriptionEntry;
  /** What lists call it: its name, else its server's host, numbered where two read the same. */
  readonly label: string;
  /** What the provider said at the last sign-in, null while it is asked, or why it couldn't say. */
  readonly account: AccountStatus | AppError | null;
  /** The Keychain no longer gives its password back: it asks for it again. */
  readonly needsSecret: boolean;
  readonly live: Loadable<LiveCatalogue>;
  readonly titles: Loadable<OnDemandCatalogue>;
}

/** Ready with none: Connect shows. */
export type Roster =
  { readonly kind: "restoring" } | { readonly kind: "ready"; readonly members: readonly Member[] };

/** Every subscription's channels together. */
export type Catalogue =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly library: Library;
      /** Subscriptions whose channels didn't load; what they had before still shows. */
      readonly failing: readonly Member[];
    }
  /** No channels to show: the first subscription's failure. */
  | { readonly kind: "failed"; readonly error: AppError; readonly member: Member };

const roster = store<Roster>({ kind: "restoring" });
const catalogue = store<Catalogue>({ kind: "loading" });
/**
 * The saved lists a launch is still reading, by `kind|id`, each with the login it reads them for.
 * One goes once its read has shown its list or found none, once its login is replaced, and at once
 * when its subscription is removed: a read the disk never answers holds nothing else up.
 */
const reading = store<ReadonlyMap<string, Source>>(new Map());

export const useRoster = () => useStore(roster);
export const useCatalogue = () => useStore(catalogue);
/** Every subscription's channels as they stand, for owners outside React. */
export const currentCatalogue = () => catalogue.get();
/** Calls `listener` whenever every subscription's channels change. */
export const onCatalogue = (listener: () => void) => catalogue.subscribe(listener);
/** Whether a launch still reads a saved list from the phone: of `kind` and `id`, when given. */
export const readingSaved = (kind?: Kind, id?: string) =>
  [...reading.get().keys()].some((key) => {
    const at = key.indexOf("|");
    return (!kind || key.slice(0, at) === kind) && (!id || key.slice(at + 1) === id);
  });
/** Calls `listener` whenever a saved list's read at launch starts or ends. */
export const onReadingSaved = (listener: () => void) => reading.subscribe(listener);
/** The saved subscriptions as they stand, for owners outside React. */
export const members = (): readonly Member[] => {
  const now = roster.get();
  return now.kind === "ready" ? now.members : [];
};
/** The roster as it stands: whether launch has read the registry yet, for owners outside React. */
export const currentRoster = () => roster.get();
/** Calls `listener` whenever a subscription or its lists change. */
export const onRoster = (listener: () => void) => roster.subscribe(listener);

const USER_AGENT = `MrStreamer/${Constants.expoConfig?.version ?? "0.0.0"} (iOS)`;

/**
 * Asks iOS's URL cache to store none of the provider's answers. It would otherwise keep each on
 * disk under its address, which carries the login, and could answer a later sign-in or reload
 * with an earlier failure, as a panel that lets its answers be cached would have it. Answers
 * earlier betas let it store are dropped at launch by `modules/forget-cached-logins`.
 */
const uncached: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("Cache-Control", "no-store");
  return fetch(input, { ...init, headers });
};

const providerFor = (account: XtreamAccount): Provider =>
  xtreamProvider(account, { userAgent: USER_AGENT, live: "hls", fetch: uncached, inTasks });

/** The registry as last written. */
let registry: Registry = EMPTY_REGISTRY;
/** Loads under way, by `kind|id`. */
const loads = new Map<string, AbortController>();
let revisions = 0;
/** By id: the revision when its saved lists were last deleted; no list of an older login is saved. */
const dropped = new Map<string, number>();
/** A saved list younger than this shows as loaded at launch, and isn't asked for again. */
const FRESH_FOR = 12 * 60 * 60 * 1000;

/** The last change to the registry or the Keychain, settled or not; a failed one counts as done. */
let changing: Promise<unknown> = Promise.resolve();

/** Runs `change` once every change begun before it has finished. */
function serially<A>(change: () => Promise<A>): Promise<A> {
  const run = changing.then(change);
  changing = run.catch(() => undefined);
  return run;
}

/**
 * Resolves once every change to the subscriptions begun before has finished, failed or not: what
 * a read whose login stopped standing (`savable`) during a new password waits for, to see which
 * login stands after it.
 */
export const accountChanges = (): Promise<void> => changing.then(() => undefined);

function commit(next: Registry) {
  writeRegistry(next);
  registry = next;
}

/** Names by id: a subscription's own, else its host; two that read the same are numbered. */
function labelsOf(entries: readonly SubscriptionEntry[]): ReadonlyMap<string, string> {
  const seen = new Map<string, number>();
  return new Map(
    entries.map((entry) => {
      const label = entry.name ?? hostOf(entry.server);
      const count = (seen.get(label) ?? 0) + 1;
      seen.set(label, count);
      return [entry.id, count === 1 ? label : `${label} ${count}`];
    }),
  );
}

const IDLE = { kind: "idle" } as const;

/** The roster in the registry's order, each member keeping its standing and lists. */
function syncRoster() {
  const labels = labelsOf(registry.subscriptions);
  const known = new Map(members().map((member) => [member.entry.id, member]));
  const next = registry.subscriptions.map((entry): Member => {
    const label = labels.get(entry.id) ?? entry.server;
    const member = known.get(entry.id);
    if (!member) {
      return { entry, label, account: null, needsSecret: false, live: IDLE, titles: IDLE };
    }
    return member.entry === entry && member.label === label ? member : { ...member, entry, label };
  });
  roster.set({ kind: "ready", members: next });
  const ids = next.map((member) => member.entry.id);
  // After the roster, so what waits on a removed subscription's read sees it gone with it.
  for (const key of reading.get().keys()) {
    const id = key.slice(key.indexOf("|") + 1);
    if (!ids.includes(id)) stopReading(id);
  }
  setViewingOwners(ids);
  setWatchlistOwners(ids);
}

/**
 * Ends the reads at launch of `id`'s saved lists: with `kind` and `source`, that one alone, while
 * it is still read for that login.
 */
function stopReading(id: string, kind?: Kind, source?: Source) {
  const now = reading.get();
  const keys = (kind ? [kind] : (["live", "titles"] as const))
    .map((each) => `${each}|${id}`)
    .filter((key) => now.has(key) && (!source || now.get(key) === source));
  if (keys.length === 0) return;
  const next = new Map(now);
  for (const key of keys) next.delete(key);
  reading.set(next);
}

function setMember(id: string, change: (member: Member) => Member) {
  roster.set((current) =>
    current.kind === "ready"
      ? {
          ...current,
          members: current.members.map((member) =>
            member.entry.id === id ? change(member) : member,
          ),
        }
      : current,
  );
}

const lastOf = <A>(loadable: Loadable<A>): A | null =>
  loadable.kind === "ready" ? loadable.value : loadable.kind === "idle" ? null : loadable.last;

/** Shown lists: the last that loaded, while a new load runs or after it failed. */
export const shownOf = lastOf;

type Kind = Saved["kind"];

/**
 * Whether lists or details of `source` may still be saved or shown as `id`'s: its login, saved
 * and not replaced. A login counts as replaced once its saved lists start to be deleted for a new
 * password, though `source` stays the current one until the new password signs in.
 */
export const savable = (id: string, source: Source) =>
  currentSource(id) === source &&
  source.revision > (dropped.get(id) ?? 0) &&
  registry.subscriptions.some((entry) => entry.id === id);

/** Saves a list `source` gave, in a later task: a write that fails leaves the list as it shows. */
function save(id: string, source: Source, saved: Saved) {
  setTimeout(() => void writeList(id, saved, source.login, () => savable(id, source)), 0);
}

/**
 * Deletes `id`'s saved lists and details once what reads or writes them has finished; from now on
 * none of a login signed in before is saved again. Answers whether they are all gone.
 */
async function dropSaved(id: string): Promise<boolean> {
  dropped.set(id, revisions);
  const gone = await Promise.all([dropLists(id), dropTitles(id)]);
  return gone.every(Boolean);
}

/**
 * Deletes `id`'s saved lists and details before a new password or account takes its id, or throws
 * when some are left, which the next launch would show for the new login. The login then stays as
 * it was, and its lists may be saved again.
 */
async function clearSaved(id: string): Promise<void> {
  const before = dropped.get(id);
  if (await dropSaved(id)) return;
  if (before === undefined) dropped.delete(id);
  else dropped.set(id, before);
  throw new AppFailure({
    kind: "unexpected",
    detail: "The lists this iPhone saved couldn't be deleted. Try again.",
  });
}

/**
 * After a change that cleared `id`'s saved lists for a new password failed before that password
 * signed in, `before` is no longer savable, though it may still be the login: signs the
 * subscription in again with the password the Keychain holds now, whichever that is, under a new
 * revision, so it answers again while nothing saved of `before` comes back. With no password to
 * read back, it asks for one (`needsSecret`): loads begun for `before` stop, and a list still
 * loading fails for want of the password, what it showed last staying. Nothing when the new
 * password already signed in.
 */
async function recoverLogin(id: string, before: Source | undefined): Promise<void> {
  if (currentSource(id) !== before) return;
  const password = await keychainSecrets.read(id).catch(() => null);
  const entry = registry.subscriptions.find((each) => each.id === id);
  if (!entry || currentSource(id) !== before) return;
  if (password) return signIn(entry, password, "again");
  dropSource(id);
  stopReading(id);
  for (const kind of ["live", "titles"] as const) loads.get(`${kind}|${id}`)?.abort();
  const error: AppError = { kind: "needs-secret", subscriptionId: id };
  const settled = <A>(now: Loadable<A>): Loadable<A> =>
    now.kind === "loading" ? { kind: "failed", error, last: now.last, since: Date.now() } : now;
  setMember(id, (member) => ({
    ...member,
    needsSecret: true,
    live: settled(member.live),
    titles: settled(member.titles),
  }));
}

/**
 * At launch: shows `kind`'s saved list while it is still idle for `source`, as loaded when it is
 * fresh, else as the last one while it loads again. Answers whether to ask the provider for it.
 * The read ends (`readingSaved`) once the list shows, or once there is none to show.
 */
async function fromSaved(id: string, kind: Kind, source: Source): Promise<boolean> {
  const saved = await readList(id, kind, () => savable(id, source));
  try {
    const member = members().find((each) => each.entry.id === id);
    if (currentSource(id) !== source || member?.[kind].kind !== "idle") return false;
    if (!saved) return true;
    const fresh = Date.now() - saved.fetchedAt < FRESH_FOR;
    const shown = <A>(value: A): Loadable<A> =>
      fresh
        ? { kind: "ready", value, from: "cache", fetchedAt: saved.fetchedAt, took: null }
        : { kind: "loading", last: value };
    setMember(id, (now) =>
      saved.kind === "live"
        ? { ...now, live: shown(saved.catalogue) }
        : { ...now, titles: shown(saved.catalogue) },
    );
    return !fresh;
  } finally {
    // After the list shows, so what waits for every read sees it in the roster.
    stopReading(id, kind, source);
  }
}

/**
 * Loads one of a subscription's lists, dropping a load of it still under way. An answer for a
 * login replaced or removed since is dropped; a failure keeps what loaded before. `landed` has
 * the answer, the login that gave it and when.
 */
function follow<A>(
  id: string,
  kind: Kind,
  read: (provider: Provider, signal: AbortSignal) => Promise<A>,
  set: (change: (now: Loadable<A>) => Loadable<A>) => void,
  landed: (value: A, source: Source, fetchedAt: number) => void,
) {
  const source = currentSource(id);
  if (!source) return;
  const key = `${kind}|${id}`;
  loads.get(key)?.abort();
  const controller = new AbortController();
  loads.set(key, controller);
  set((now) => ({ kind: "loading", last: lastOf(now) }));
  const started = Date.now();
  const stands = () => !controller.signal.aborted && currentSource(id) === source;
  read(source.provider, controller.signal).then(
    (value) => {
      if (!stands()) return;
      const fetchedAt = Date.now();
      set(() => ({ kind: "ready", value, from: "provider", fetchedAt, took: fetchedAt - started }));
      landed(value, source, fetchedAt);
    },
    (cause: unknown) => {
      if (!stands()) return;
      const error = appError(cause);
      set((now) => ({ kind: "failed", error, last: lastOf(now), since: Date.now() }));
    },
  );
}

/** Reads a subscription's channel list again. */
export function reloadChannels(id: string) {
  follow(
    id,
    "live",
    (provider, signal) => provider.liveCatalogue(signal),
    (change) => setMember(id, (member) => ({ ...member, live: change(member.live) })),
    (catalogue, source, fetchedAt) => {
      noteAction("playlist_refreshed");
      save(id, source, { kind: "live", catalogue, fetchedAt });
    },
  );
}

/** Reads a subscription's movie and series lists again. */
export function reloadTitles(id: string) {
  follow(
    id,
    "titles",
    (provider, signal) => provider.onDemandCatalogue(signal),
    (change) => setMember(id, (member) => ({ ...member, titles: change(member.titles) })),
    (catalogue, source, fetchedAt) => save(id, source, { kind: "titles", catalogue, fetchedAt }),
  );
}

/** Reads every subscription's channel list again. */
export function reloadAllChannels() {
  for (const member of members()) reloadChannels(member.entry.id);
}

/** Tries the channels of every subscription whose channels didn't load again. */
export function retryChannels() {
  for (const member of members()) {
    if (member.live.kind === "failed") reloadChannels(member.entry.id);
  }
}

/** Tries the movie and series lists of every subscription whose lists didn't load again. */
export function retryTitles() {
  for (const member of members()) {
    if (member.titles.kind === "failed") reloadTitles(member.entry.id);
  }
}

/**
 * Checks the login again, then loads the movie and series lists unless `load` answers no. They
 * wait until the check answers, fails or runs out of time, so on a slow link they don't hold its
 * answer back.
 */
function check(id: string, source: Source, load: Promise<boolean> = Promise.resolve(true)) {
  void source.provider
    .authenticate()
    .then(
      (account) => account,
      (cause: unknown) => appError(cause),
    )
    .then(async (account) => {
      if (currentSource(id) !== source) return;
      setMember(id, (member) => ({ ...member, account }));
      if ((await load) && currentSource(id) === source) reloadTitles(id);
    });
}

/**
 * Signs a saved subscription in with `password` and loads its lists: channels at once, movies
 * and series once the login is known to be good (`checked`). At launch, with `checked` null, the
 * login is checked again, and each list shows its saved copy, which may stand for the provider's.
 * "again", after a change that failed (`recoverLogin`): the login is checked again and both lists
 * asked of the provider, as Retry does, those last loaded showing meanwhile; loads begun for the
 * login before are dropped, and its copies are gone.
 */
function signIn(
  entry: SubscriptionEntry,
  password: string,
  checked: AccountStatus | null | "again",
) {
  const { id } = entry;
  const source: Source = {
    revision: ++revisions,
    provider: providerFor({ server: entry.server, username: entry.username, password }),
    login: [entry.username, password],
  };
  setSource(id, source);
  // A read at launch for the login before ends: this one's lists come from its provider.
  stopReading(id);
  setMember(id, (member) => ({
    ...member,
    needsSecret: false,
    account: checked === "again" ? null : checked,
  }));
  if (checked === "again") {
    reloadChannels(id);
    check(id, source);
    return;
  }
  if (checked) {
    reloadChannels(id);
    reloadTitles(id);
    return;
  }
  reading.set((now) => new Map([...now, [`live|${id}`, source], [`titles|${id}`, source]]));
  void fromSaved(id, "live", source).then((load) => {
    if (load && currentSource(id) === source) reloadChannels(id);
  });
  check(id, source, fromSaved(id, "titles", source));
}

/** Checks a subscription's login and reads all its lists again: its Retry. */
export function retry(id: string) {
  const source = currentSource(id);
  if (!source) return;
  setMember(id, (member) => ({ ...member, account: null }));
  reloadChannels(id);
  check(id, source);
}

/** Removes the Keychain item an add or a removal left, unless its subscription is saved. */
async function settleSecret(id: string) {
  if (!registry.subscriptions.some((entry) => entry.id === id)) {
    await keychainSecrets.remove(id);
  }
  commit({ ...registry, pendingSecrets: withoutPending(registry.pendingSecrets, id) });
}

/**
 * At launch: the saved subscriptions, each signed in again with its password from the Keychain.
 * A first launch since installing first removes what an earlier install left in the Keychain.
 * The first launch since private beta 2 makes the registry from its state.json, keeping its
 * subscription's id; a launch after that finds the registry and migrates nothing again.
 */
export function restore(): Promise<void> {
  return serially(async () => {
    const saved = readRegistry();
    if (!saved && firstLaunch()) {
      await keychainSecrets.clear().catch(() => undefined);
      writeState((state) => state);
    }
    registry = saved ?? migrated(readState());
    // A write that fails leaves the old files as they were, and the next launch tries again.
    try {
      if (!saved) writeRegistry(registry);
      migrateRecentChannels();
    } catch {
      // Shown from memory for now.
    }
    for (const id of registry.pendingSecrets) await settleSecret(id).catch(() => undefined);
    for (const id of registry.erasing) await eraseHistory(id).catch(() => undefined);
    const passwords = await Promise.all(
      registry.subscriptions.map((entry) => keychainSecrets.read(entry.id).catch(() => null)),
    );
    syncRoster();
    const ids = registry.subscriptions.map((entry) => entry.id);
    pruneLists(ids);
    pruneDetails(ids);
    registry.subscriptions.forEach((entry, at) => {
      const password = passwords[at];
      if (password) signIn(entry, password, null);
      else setMember(entry.id, (member) => ({ ...member, needsSecret: true }));
    });
  });
}

/** A name as typed: none when empty, unchanged when not given. */
const nameOf = (name: string | undefined) =>
  name === undefined ? undefined : name.trim() === "" ? null : name.trim();

const authenticate = (account: XtreamAccount, signal?: AbortSignal) =>
  providerFor(account).authenticate(
    AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
  );

/**
 * Adds a subscription with what the viewer typed, once its provider accepted the login; nothing
 * is saved when it doesn't, and the promise rejects with why. The same account added again updates
 * the one saved: its password and, when given, its name. An account removed with its history kept
 * takes its id back, and its history with it. Answers the subscription's id, or null when aborted.
 *
 * A new subscription is saved when the registry lists it: aborting `signal` before then, its
 * password's write included, leaves everything as it was. For an account already saved, the
 * change is made once its password starts to be written, as `update` makes one. Lists saved for
 * the id that the phone won't delete leave everything as it was too, and the promise rejects.
 */
export async function add(input: LoginInput, signal?: AbortSignal): Promise<string | null> {
  const { account } = parseLogin(input);
  if (account.kind !== "xtream") {
    throw new AppFailure({
      kind: "invalid-input",
      detail: "M3U playlists aren't on iPhone yet. Enter an Xtream server, username and password.",
    });
  }
  const status = await authenticate(account, signal);
  return serially(async () => {
    if (signal?.aborted) return null;
    const name = nameOf(input.name);
    const known = registry.subscriptions.find((entry) => sameAccount(entry, account));
    if (known) {
      const before = currentSource(known.id);
      await clearSaved(known.id);
      try {
        await keychainSecrets.write(known.id, account.password);
        const entry = name === undefined || name === known.name ? known : { ...known, name };
        if (entry !== known) {
          commit({
            ...registry,
            subscriptions: registry.subscriptions.map((each) => (each === known ? entry : each)),
          });
        }
        // The roster follows the registry, whatever an earlier change left of it.
        syncRoster();
        signIn(entry, account.password, status);
        return entry.id;
      } catch (cause) {
        // Best effort: the change still fails with its own error.
        await recoverLogin(known.id, before).catch(() => undefined);
        throw cause;
      }
    }
    const retired = registry.retired.find((each) => sameAccount(each, account));
    const id = retired?.id ?? newSubscriptionId(registry, Date.now());
    // Should the app stop before the registry lists it, the next launch removes its password.
    commit({ ...registry, pendingSecrets: withPending(registry.pendingSecrets, id) });
    const entry: SubscriptionEntry = {
      id,
      kind: "xtream",
      server: account.server,
      username: account.username,
      name: name ?? null,
    };
    const first = registry.subscriptions.length === 0;
    try {
      // A retired id's lists went with its removal, unless the disk refused it then.
      await clearSaved(id);
      await keychainSecrets.write(id, account.password);
      // Left while the password was written: it goes again, and nothing is saved.
      if (signal?.aborted) {
        await settleSecret(id).catch(() => undefined);
        return null;
      }
      commit({
        ...registry,
        subscriptions: [...registry.subscriptions, entry],
        retired: registry.retired.filter((each) => each.id !== id),
        pendingSecrets: withoutPending(registry.pendingSecrets, id),
      });
    } catch (cause) {
      await settleSecret(id).catch(() => undefined);
      throw cause;
    }
    // Saved: from here on it shows and signs in, whatever fails after.
    syncRoster();
    signIn(entry, account.password, status);
    noteAction("playlist_added");
    // An older build shows the subscription it knew; with none left, it shows this one. Only an
    // older build reads it: when it can't be written, that build shows Connect instead.
    if (first) {
      try {
        writeState((state) => ({
          ...state,
          subscription: state.subscription ?? {
            id,
            server: entry.server,
            username: entry.username,
          },
        }));
      } catch {
        // This build has the subscription saved.
      }
    }
    return id;
  });
}

/**
 * Changes a saved subscription's name, and its password when `password` is given: the provider
 * checks the new one first, and nothing changes when it refuses. Aborting `signal` while the
 * provider checks it, or while another change runs, leaves it as it was. The change is made from
 * the moment it starts being saved, as the Keychain may hold the new password from then: aborting
 * after that changes nothing, and the change completes. A new password waits for the lists saved
 * for the old one to be deleted; when the phone won't delete them, nothing changes and the promise
 * rejects.
 */
export async function update(
  id: string,
  change: { readonly name?: string; readonly password?: string },
  signal?: AbortSignal,
): Promise<void> {
  const entry = registry.subscriptions.find((each) => each.id === id);
  if (!entry) throw new AppFailure({ kind: "no-subscription" });
  const { password } = change;
  const status = password
    ? await authenticate({ server: entry.server, username: entry.username, password }, signal)
    : null;
  await serially(async () => {
    if (signal?.aborted) return;
    const now = registry.subscriptions.find((each) => each.id === id);
    if (!now) throw new AppFailure({ kind: "no-subscription" });
    const before = currentSource(id);
    if (password) await clearSaved(id);
    try {
      if (password) await keychainSecrets.write(id, password);
      const name = nameOf(change.name);
      const next = name === undefined || name === now.name ? now : { ...now, name };
      if (next !== now) {
        commit({
          ...registry,
          subscriptions: registry.subscriptions.map((each) => (each === now ? next : each)),
        });
        syncRoster();
      }
      if (password && status) signIn(next, password, status);
    } catch (cause) {
      if (password) await recoverLogin(id, before).catch(() => undefined);
      throw cause;
    }
  });
}

/**
 * Removes a subscription: what plays from it stops, and its login and lists go. What plays from
 * another, or a downloaded copy, plays on. Its favourites, watchlist, history and progress stay
 * for when the account is added again, unless `keepHistory` is false. Removing the last returns to
 * Connect.
 *
 * The registry is written first, with the history to delete when it goes too; a refused write
 * rejects with nothing changed, and the subscription stays in the roster. From then on the
 * removal stands, whatever fails after. A history not all deleted rejects the promise, and each
 * launch deletes the rest until it is gone. A password the Keychain didn't remove is removed at
 * the next launch.
 */
export function remove(id: string, { keepHistory }: { keepHistory: boolean }): Promise<void> {
  return serially(async () => {
    const entry = registry.subscriptions.find((each) => each.id === id);
    if (!entry) return;
    commit(withoutSubscription(registry, entry, keepHistory));
    for (const kind of ["live", "titles"] as const) loads.get(`${kind}|${id}`)?.abort();
    dropSource(id);
    // After any write of them under way. What the disk refuses goes at the next launch, or before
    // the account added again takes the id back.
    void dropSaved(id);
    // A request waiting to play, such as a series' resume, lapses; with none left, so does Watch,
    // unless it shows a downloaded copy, which needs no subscription.
    const { phase } = playbackState.get();
    const from = phase.kind === "idle" ? undefined : phase.item.subscriptionId;
    if (from === id || (registry.subscriptions.length === 0 && from !== null)) stop();
    else request();
    // The roster without it ends its unfinished downloads (downloads.ts); finished copies stay.
    syncRoster();
    noteAction("playlist_removed");
    await keychainSecrets
      .remove(id)
      .then(() =>
        commit({ ...registry, pendingSecrets: withoutPending(registry.pendingSecrets, id) }),
      )
      .catch(() => undefined);
    if (!keepHistory) return eraseHistory(id);
    try {
      writeState((state) => forgotten(state, id, false));
    } catch {
      // Only an older build reads which subscription it was.
    }
  });
}

/**
 * state.json without `id`: no longer an older build's subscription; with `erase`, its channels
 * and version picks gone with it.
 */
function forgotten(state: SavedState, id: string, erase: boolean): SavedState {
  const original = state.subscription?.id === id;
  return {
    ...(erase ? withoutVersions(state, id) : state),
    subscription: original ? null : state.subscription,
    ...(erase
      ? {
          recent: original ? [] : state.recent,
          recentChannels: (state.recentChannels ?? []).filter((key) => !key.startsWith(`${id}:`)),
        }
      : {}),
  };
}

/**
 * Deletes the history of a subscription removed with it: its recent channels, watchlist and
 * viewing record, each whatever another fails, then drops it from the registry's `erasing`.
 * Rejects when one isn't deleted, leaving it there for the next launch to try again.
 */
async function eraseHistory(id: string): Promise<void> {
  const erased = await Promise.allSettled([
    Promise.resolve().then(() => writeState((state) => forgotten(state, id, true))),
    Promise.resolve().then(() => eraseWatchlist(id)),
    eraseViewing(id),
  ]);
  const failed = erased.find((each) => each.status === "rejected");
  if (failed) throw failed.reason;
  commit({ ...registry, erasing: withoutPending(registry.erasing, id) });
}

/** The last channel chosen to watch while a channel played: another one changes the channel. */
let chosen: string | null = null;

/**
 * Plays a channel's first stream in Auto's order (the desktop's `streamsToPlay`, at its default
 * quality), from its own subscription, in Watch or in Home's preview. Trying the next stream when
 * one fails comes later.
 */
export function playChannel(channel: Channel, place: string, options: { watch: boolean }) {
  const [variant] = streamsToPlay(channel, {});
  if (!variant) return;
  const { subscriptionId } = channel;
  const open = async (signal: AbortSignal) => {
    const stream = await sourceOf(subscriptionId).provider.liveStream(variant.id, signal);
    return {
      url: stream.url,
      container: stream.format === "hls" ? "m3u8" : "ts",
      ...(stream.headers ? { headers: stream.headers } : {}),
    };
  };
  if (options.watch) {
    const { phase } = playbackState.get();
    const watching = phase.kind !== "idle" && phase.item.live;
    if (watching && chosen !== null && chosen !== channel.key) noteAction("channel_changed");
    chosen = channel.key;
  }
  rememberChannel(channel.key);
  void play(
    {
      id: channel.key,
      subscriptionId,
      title: channel.title,
      place,
      live: true,
      next: false,
      versions: false,
    },
    open,
    { ...options, login: loginOf(subscriptionId) },
  );
}

// Every subscription's channels together. Each subscription's part (library.ts) is kept, with the
// catalogue it came from, while that catalogue shows: another's arrival, a new label, a failure or
// a removal joins the kept parts at once. A catalogue that lands is worked out in short tasks,
// one at a time, while the channels shown before stay; a first one counts as loading. Work for a
// catalogue the roster no longer shows, reloaded, replaced or removed meanwhile, is dropped.

/** Parts by subscription id: only those whose channels show. */
const parts = new Map<string, { readonly catalogue: LiveCatalogue; readonly part: Part }>();
/** The parts last joined and the library they make. */
let joined: { readonly parts: readonly Labelled[]; readonly library: Library } | null = null;
/** Whether `work` is running. */
let working = false;

/** Each subscription whose channels show, with the last of them that loaded. */
const liveSources = (all = members()): LiveSource[] =>
  all.flatMap((member) => {
    const listed = lastOf(member.live);
    return listed
      ? [{ subscriptionId: member.entry.id, label: member.label, catalogue: listed }]
      : [];
  });

/** Whether the roster still shows `source`'s catalogue for its subscription. */
const shows = (source: LiveSource) =>
  liveSources().some(
    (each) => each.subscriptionId === source.subscriptionId && each.catalogue === source.catalogue,
  );

/** `sources` as parts to join: each one's kept part, or `fresh` for the one it was worked out for. */
const labelled = (sources: readonly LiveSource[], fresh?: Part): Labelled[] =>
  sources.flatMap(({ subscriptionId, label }) => {
    const part = fresh?.subscriptionId === subscriptionId ? fresh : parts.get(subscriptionId)?.part;
    return part ? [{ label, part }] : [];
  });

function libraryOf(shown: readonly Labelled[]): Library {
  const same =
    joined !== null &&
    joined.parts.length === shown.length &&
    joined.parts.every(
      (each, at) => each.part === shown[at]?.part && each.label === shown[at]?.label,
    );
  if (joined && same) return joined.library;
  const library = combine(shown);
  joined = { parts: shown, library };
  return library;
}

/** Whether the channels that show are worked out of every subscription's list that shows. */
export const channelsWorkedOut = () =>
  liveSources().every((source) => parts.get(source.subscriptionId)?.catalogue === source.catalogue);

/** Shows the channels from the parts there are, and works out those still to come. */
function publish() {
  const all = members();
  const sources = liveSources(all);
  for (const id of parts.keys()) {
    if (!sources.some((source) => source.subscriptionId === id)) parts.delete(id);
  }
  const pending = sources.some(
    (source) => parts.get(source.subscriptionId)?.catalogue !== source.catalogue,
  );
  const shown = labelled(sources);
  if (shown.length === 0) joined = null;
  const failing = all.filter((member) => member.live.kind === "failed" || member.needsSecret);
  const loading = pending || all.some((member) => member.live.kind === "loading");
  const [first] = failing;
  const library = shown.length > 0 ? libraryOf(shown) : null;
  catalogue.set(
    library
      ? { kind: "ready", library, failing }
      : loading || !first
        ? { kind: "loading" }
        : {
            kind: "failed",
            member: first,
            error:
              first.live.kind === "failed"
                ? first.live.error
                : { kind: "needs-secret", subscriptionId: first.entry.id },
          },
  );
  // The favourites show by the channels that show: the same library, kept while a list reloads
  // or fails, and none while no subscription's channels show.
  setViewingChannels(library?.byKey ?? NO_CHANNELS);
  if (pending) void work();
}

const NO_CHANNELS: ReadonlyMap<string, Channel> = new Map();

/** Works out each catalogue that has no part yet, one after another, then shows it joined. */
async function work() {
  if (working) return;
  working = true;
  try {
    for (;;) {
      const source = liveSources().find(
        (each) => parts.get(each.subscriptionId)?.catalogue !== each.catalogue,
      );
      if (!source) return;
      const wanted = () => shows(source);
      const part = await inTasks(partSteps(source), wanted);
      if (!part) continue;
      const shown = labelled(liveSources(), part);
      const library = await inTasks(combineSteps(shown), wanted);
      // Checked again: an answer may have changed the roster since the last slice.
      if (!library || !wanted()) continue;
      parts.set(source.subscriptionId, { catalogue: source.catalogue, part });
      // Shown as joined unless the roster changed meanwhile; `libraryOf` joins it again then.
      joined = { parts: shown, library };
      publish();
    }
  } finally {
    working = false;
  }
}

roster.subscribe(publish);
