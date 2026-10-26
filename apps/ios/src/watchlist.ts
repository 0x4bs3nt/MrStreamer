import { type } from "arktype";
import { lazy } from "@mrstreamer/contracts/lazy";
import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedId } from "@mrstreamer/contracts/subscription";
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
import type { Member } from "./account.ts";
import type { OnDemandCatalogue } from "@mrstreamer/core/provider";
import { excludedSaved } from "./content-policy.ts";
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
// Its screen lists every entry (`watchlistRows`): the title it is in the lists, which opens its
// details, or, while the lists hold none that is surely it, what was saved of it and why: a
// provider whose lists are still to come, failed or need its password may still list it, so only
// lists every provider of it gave in full say it is no longer listed. A title opens only through
// a provider that still signs in: one whose password the Keychain lost keeps its last lists in
// the index, but nothing of it opens. Nothing that plays is made of what was saved. An entry is
// taken out by the records it was shown with (`removeEntry`), found again in the watchlist as it
// stands then.
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
let alignmentPending = false;
let members: () => readonly Member[] = () => [];

/** The catalogue owner supplies current raw memberships without a dependency on account.ts. */
export function serveWatchlist(read: () => readonly Member[]): void {
  members = read;
}
/**
 * The highest `sequence` this run read or gave, whatever was removed, erased or refused since. A
 * record's id is its time and sequence, so a new record never takes the id of one this run gave
 * before, even when the clock repeats: an action left open on a removed record can't name it.
 */
let given = 0;

const highest = (accounts: Accounts["accounts"]) =>
  Math.max(0, ...Object.values(accounts).flatMap((list) => list.map((entry) => entry.sequence)));

function catalogueOf(member: Member | undefined): OnDemandCatalogue | null {
  if (!member) return null;
  return member.titles.kind === "ready"
    ? member.titles.value
    : "last" in member.titles
      ? member.titles.last
      : null;
}

function load() {
  if (loaded) return;
  loaded = true;
  const current = Watchlists()(readJson(FILE));
  const legacy = current instanceof type.errors ? Legacy()(readJson(LEGACY)) : null;
  if (!(current instanceof type.errors)) saved.set({ accounts: current.accounts });
  else if (legacy && !(legacy instanceof type.errors)) {
    saved.set({ accounts: { [legacy.subscriptionId]: legacy.entries } });
  }
  given = highest(saved.get().accounts);
}

function write(accounts: Accounts["accounts"]) {
  writeJson(FILE, { version: 1, accounts });
  alignmentPending = false;
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
  if (title.adult) return;
  const { accounts } = saved.get();
  const ids = owners.get();
  if (savedEntry(entries(accounts, ids), title)) return;
  const savedAt = Date.now();
  let sequence = Math.max(given, highest(accounts));
  const next = { ...accounts };
  for (const subscriptionId of ids) {
    const facts = factsOf(title, subscriptionId);
    if (facts.versionIds.length === 0) continue;
    if (
      excludedSaved(
        catalogueOf(members().find((member) => member.entry.id === subscriptionId)),
        facts,
      )
    )
      continue;
    sequence += 1;
    next[subscriptionId] = [
      ...(accounts[subscriptionId] ?? []),
      { ...facts, id: `${savedAt.toString(36)}-${sequence}`, savedAt, sequence },
    ];
  }
  // Given, even if the file refuses them.
  given = sequence;
  write(next);
}

/** Takes a title's entry out, with what every subscription saved of it. */
export function removeTitle(title: Title) {
  const entry = savedEntry(currentWatchlist(), title);
  if (entry) removeEntry(entry);
}

/** One saved record, by its subscription and its own id: what an action on an entry holds. */
export type SavedRef = Pick<SavedMember, "subscriptionId" | "id">;

/**
 * Takes out the entry that holds one of `refs`, as the watchlist stands now, with what every
 * saved subscription saved of it: records the entry gained since go too. Nothing goes when no
 * entry holds them any more, as once it was removed, or saved again as new records, whose ids
 * differ (`given`). What a removed subscription kept stays for when it is added again. Throws
 * when the file won't take the change, and the watchlist stays as it was.
 */
export function removeEntry(refs: readonly SavedRef[]) {
  const { accounts } = saved.get();
  const entry = entries(accounts, owners.get()).find((members) =>
    members.some((member) =>
      refs.some((ref) => ref.subscriptionId === member.subscriptionId && ref.id === member.id),
    ),
  );
  if (!entry) return;
  const next = { ...accounts };
  for (const member of entry) {
    next[member.subscriptionId] = (next[member.subscriptionId] ?? []).filter(
      (each) => each.id !== member.id,
    );
  }
  write(next);
}

/** Why the lists that show hold no title that is surely an entry. */
export type Unlisted = "loading" | "failed" | "needs-secret" | "not-listed";

/** An entry as the Watchlist screen shows it. */
export type WatchlistRow = {
  readonly entry: WatchlistEntry;
  /** The record it was saved with first: the same while it stays saved. */
  readonly key: string;
  readonly kind: TitleKind;
  /** As the title shows now, else as it was saved. */
  readonly name: string;
  readonly year: number | null;
} & (
  | { readonly title: Title; readonly unlisted: null }
  | { readonly title: null; readonly unlisted: Unlisted }
);

/** What the watchlist's titles are looked up in. */
export interface WatchlistSources {
  /** The lists that show, null while none do. */
  readonly index: IndexedCatalogue | null;
  /** Whether every saved subscription's lists that show are in `index` (`titlesWorkedOut`). */
  readonly complete: boolean;
  /** The saved subscriptions, with how each one's lists stand. */
  readonly members: readonly Member[];
  /** A title as it shows, with TMDB's name once known (`named`). */
  readonly named: (title: Title) => Title;
}

/** Newest saved first, or by name. */
export type WatchlistOrder = "newest" | "name";

const byName = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Every entry of `list` as its screen shows it, in `order`: by name, those of one name keep the
 * newest first.
 */
export function watchlistRows(
  list: readonly WatchlistEntry[],
  sources: WatchlistSources,
  order: WatchlistOrder,
): readonly WatchlistRow[] {
  const catalogues = new Map(
    sources.members.map((member) => [member.entry.id, catalogueOf(member)]),
  );
  const newest = latestFirst(
    list.flatMap((entry) => {
      const permitted = entry.filter(
        (saved) => !excludedSaved(catalogues.get(saved.subscriptionId) ?? null, saved),
      );
      return permitted.length ? [permitted] : [];
    }),
  );
  const { index } = sources;
  const signedIn = new Set(
    sources.members.flatMap((member) => (member.needsSecret ? [] : [member.entry.id])),
  );
  const looked = index
    ? watchlistTitles(index, newest)
    : newest.map((entry) => ({ entry, title: null }));
  const rows = looked.flatMap(({ entry, title: found }): WatchlistRow[] => {
    const [first] = entry;
    if (!first) return [];
    const shared = { entry, key: `${first.subscriptionId}:${first.id}`, kind: first.kind };
    // The version the title shows first, else another of a provider that still signs in, as
    // details show a title with a version (`automaticVersion` keeps one opened that isn't first).
    const version =
      found &&
      (signedIn.has(found.subscriptionId)
        ? found
        : found.versions.find((each) => signedIn.has(each.subscriptionId)));
    if (found && version) {
      const title = sources.named({ ...found, ...ownedId(version) });
      return [{ ...shared, name: title.title, year: title.year, title, unlisted: null }];
    }
    const unlisted = unlistedBy(entry, sources);
    return [{ ...shared, name: first.name, year: first.year, title: null, unlisted }];
  });
  return order === "name" ? rows.toSorted((a, b) => byName.compare(a.name, b.name)) : rows;
}

/**
 * Why no title in the lists is surely `entry`, from how the lists of the subscriptions that may
 * list it stand: those that saved it, and every one for a title the lists know by its TMDB id.
 * Any still to come say loading, then a lost password, then a failure; only lists all of them gave
 * and that show in full say it is no longer listed.
 */
function unlistedBy(entry: WatchlistEntry, { members, complete }: WatchlistSources): Unlisted {
  const [first] = entry;
  const anyone = Boolean(first?.tmdbId) && !first?.adult;
  const relevant = members.filter(
    (member) => anyone || entry.some((saved) => saved.subscriptionId === member.entry.id),
  );
  const standing = relevant.map((member): Unlisted => {
    if (member.needsSecret) return "needs-secret";
    if (member.titles.kind === "failed") return "failed";
    if (member.titles.kind === "ready") return complete ? "not-listed" : "loading";
    return "loading";
  });
  return (
    (["loading", "needs-secret", "failed"] as const).find((each) => standing.includes(each)) ??
    (relevant.length > 0 ? "not-listed" : "loading")
  );
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
export function alignWatchlist(
  index: IndexedCatalogue | null,
  listed: readonly {
    readonly subscriptionId: string;
    readonly catalogue: OnDemandCatalogue;
  }[] = [],
) {
  const { accounts } = saved.get();
  let next: Record<string, readonly SavedTitle[]> | null = null;
  for (const subscriptionId of owners.get()) {
    const before = accounts[subscriptionId] ?? [];
    const catalogue =
      listed.find((each) => each.subscriptionId === subscriptionId)?.catalogue ?? null;
    // Remember a recognised exclusion even if the provider later removes that row entirely.
    // The record and personal media stay intact. A permitted title can settle it again below.
    const classified = before.map((entry) =>
      !entry.adult && excludedSaved(catalogue, entry) ? { ...entry, adult: true } : entry,
    );
    const after = index ? aligned(index, subscriptionId, classified) : classified;
    if (after.length !== before.length || after.some((entry, at) => entry !== before[at])) {
      (next ??= { ...accounts })[subscriptionId] = after;
    }
  }
  if (!next && !alignmentPending) return;
  const alignedAccounts = next ?? accounts;
  // Classification takes effect even when storage refuses it. Retry the same in-memory facts
  // on the next catalogue/status change without interrupting other catalogue listeners.
  saved.set({ accounts: alignedAccounts });
  try {
    write(alignedAccounts);
  } catch {
    alignmentPending = true;
  }
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
