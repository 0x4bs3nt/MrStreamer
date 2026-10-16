import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import type { Title } from "@mrstreamer/contracts/ondemand";
import type { IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import {
  entriesOf,
  factsOf,
  sameTitle,
  savedFirst,
  settled,
  titleOf,
  type SavedMember,
  type SavedTitle,
} from "@mrstreamer/core/ondemand/watchlist";
import { useMemo } from "react";
import { readJson, removeJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";

// The watchlist: movies and whole series saved to watch later, apart from how far anything got.
// Each saved subscription keeps its own record of what it saved, by its provider's ids, in
// watchlists.json; the watchlist shows them as one by core's rules (`entriesOf`): a movie two
// subscriptions list under one TMDB id is one entry, saved for both. Which title an entry is now
// goes by `titleOf`, and each time the lists are read, saved titles take their name and versions
// as the lists have them now (`settled`). A removed subscription's record stays for when its
// account is added again, unless its history went with it.
//
// Private beta 2 kept its one subscription's record in watchlist.json. Until the first change
// writes watchlists.json, that record is read from there; the old file stays as it was for an
// older build.

const FILE = "watchlists.json";
const LEGACY = "watchlist.json";

const Saved = lazy(() =>
  type({
    kind: "'movie' | 'series'",
    tmdbId: "string | null",
    versionIds: "string[]",
    name: "string",
    year: "number | null",
    adult: "boolean",
    id: "string",
    savedAt: "number",
    sequence: "number",
  }),
);
const Watchlists = lazy(() =>
  type({ version: "1", accounts: type.Record("string", Saved().array()) }),
);
const Legacy = lazy(() =>
  type({ version: "1", subscriptionId: "string", entries: Saved().array() }),
);

interface Accounts {
  readonly accounts: Readonly<Record<string, readonly SavedTitle[]>>;
}

/** One saved movie or series: what each subscription saved of it, the one saved first in front. */
export type WatchlistEntry = readonly SavedMember[];

const saved = store<Accounts>({ accounts: {} });
/** The saved subscriptions in their order: only their records show. */
const owners = store<readonly string[]>([]);
let loaded = false;

function load() {
  if (loaded) return;
  loaded = true;
  const current = Watchlists()(readJson(FILE));
  if (!(current instanceof type.errors)) return saved.set({ accounts: current.accounts });
  const legacy = Legacy()(readJson(LEGACY));
  if (!(legacy instanceof type.errors)) {
    saved.set({ accounts: { [legacy.subscriptionId]: legacy.entries } });
  }
}

function write(accounts: Accounts["accounts"]) {
  writeJson(FILE, { version: 1, accounts });
  saved.set({ accounts });
}

/** The saved subscriptions, whose records the watchlist shows; set by account.ts. */
export function setWatchlistOwners(ids: readonly string[]) {
  load();
  const current = owners.get();
  if (ids.length !== current.length || ids.some((id, at) => id !== current[at])) owners.set(ids);
}

/** Deletes what a removed subscription saved, when its history goes with it. */
export function eraseWatchlist(subscriptionId: string) {
  load();
  write(
    Object.fromEntries(
      Object.entries(saved.get().accounts).filter(([owner]) => owner !== subscriptionId),
    ),
  );
  // The old file must not bring it back to an older build either.
  const legacy = Legacy()(readJson(LEGACY));
  if (!(legacy instanceof type.errors) && legacy.subscriptionId === subscriptionId) {
    removeJson(LEGACY);
  }
}

function entries(accounts: Accounts["accounts"], ids: readonly string[]): WatchlistEntry[] {
  return entriesOf(
    ids.flatMap((subscriptionId) =>
      (accounts[subscriptionId] ?? []).map((entry) => ({ ...entry, subscriptionId })),
    ),
  );
}

const latestFirst = (list: readonly WatchlistEntry[]) =>
  list.toSorted(([a], [b]) => (a && b ? savedFirst(b, a) : 0));

/** The saved entries, the latest first. */
export function useWatchlist(): readonly WatchlistEntry[] {
  const { accounts } = useStore(saved);
  const ids = useStore(owners);
  return useMemo(() => latestFirst(entries(accounts, ids)), [accounts, ids]);
}

/** The same, as it stands, for owners outside React. */
export const currentWatchlist = (): readonly WatchlistEntry[] =>
  latestFirst(entries(saved.get().accounts, owners.get()));

/** The entry `title` is saved as, if any: a record of a subscription that lists it. */
export function savedEntry(
  list: readonly WatchlistEntry[],
  title: Title,
): WatchlistEntry | undefined {
  return list.find((entry) =>
    entry.some((member) => sameTitle(member, factsOf(title, member.subscriptionId))),
  );
}

/**
 * Saves a movie or whole series for every saved subscription that lists a version of it; one
 * saved already keeps its entry and time.
 */
export function saveTitle(title: Title) {
  const { accounts } = saved.get();
  const ids = owners.get();
  if (savedEntry(entries(accounts, ids), title)) return;
  const savedAt = Date.now();
  let sequence = Math.max(
    0,
    ...Object.values(accounts).flatMap((list) => list.map((entry) => entry.sequence)),
  );
  const next = { ...accounts };
  for (const subscriptionId of ids) {
    const facts = factsOf(title, subscriptionId);
    if (facts.versionIds.length === 0) continue;
    sequence += 1;
    next[subscriptionId] = [
      ...(accounts[subscriptionId] ?? []),
      { ...facts, id: `${savedAt.toString(36)}-${sequence}`, savedAt, sequence },
    ];
  }
  write(next);
}

/** Takes a title's entry out, with what every subscription saved of it. */
export function removeTitle(title: Title) {
  const { accounts } = saved.get();
  const entry = savedEntry(entries(accounts, owners.get()), title);
  if (!entry) return;
  const next = { ...accounts };
  for (const member of entry) {
    next[member.subscriptionId] = (next[member.subscriptionId] ?? []).filter(
      (each) => each.id !== member.id,
    );
  }
  write(next);
}

/** The title each entry is in the lists now, or null when they hold none that is surely it. */
export function watchlistTitles(
  index: IndexedCatalogue,
  list: readonly WatchlistEntry[],
): readonly { readonly entry: WatchlistEntry; readonly title: Title | null }[] {
  return list.map((entry) => ({
    entry,
    title: entry.reduce<Title | null>((found, member) => found ?? titleOf(index, member), null),
  }));
}

/**
 * Brings what each subscription saved in line with lists just read: each entry takes its title's
 * name, year, versions and TMDB id, and entries that turn out to be one title become the one
 * saved first.
 */
export function alignWatchlist(index: IndexedCatalogue) {
  const { accounts } = saved.get();
  let next: Record<string, readonly SavedTitle[]> | null = null;
  for (const subscriptionId of owners.get()) {
    const before = accounts[subscriptionId] ?? [];
    const after = aligned(index, subscriptionId, before);
    if (after !== before) (next ??= { ...accounts })[subscriptionId] = after;
  }
  if (next) write(next);
}

/** One subscription's records in line with the lists; the same array when nothing changes. */
function aligned(
  index: IndexedCatalogue,
  subscriptionId: string,
  records: readonly SavedTitle[],
): readonly SavedTitle[] {
  let entries = records;
  for (const entry of records) {
    if (!entries.some((each) => each.id === entry.id)) continue;
    const title = titleOf(index, { ...entry, subscriptionId });
    if (!title) continue;
    const facts = factsOf(title, subscriptionId);
    const result = settled(
      entries.filter((each) => sameTitle(each, facts)),
      facts,
    );
    if (!result) continue;
    entries = [
      ...entries.filter((each) => each.id !== result.kept.id && !result.dropped.includes(each.id)),
      result.kept,
    ];
  }
  return JSON.stringify(entries.toSorted(savedFirst)) ===
    JSON.stringify(records.toSorted(savedFirst))
    ? records
    : entries;
}
