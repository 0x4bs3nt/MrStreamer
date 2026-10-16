import type { Title } from "@mrstreamer/contracts/ondemand";
import type { IndexedCatalogue } from "@mrstreamer/core/ondemand/catalogue";
import {
  factsOf,
  sameTitle,
  savedFirst,
  settled,
  titleOf,
  type SavedTitle,
} from "@mrstreamer/core/ondemand/watchlist";
import { readJson, removeJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";

// The watchlist: movies and whole series saved to watch later, apart from how far anything got.
// What the subscription saved is kept by its provider's ids in watchlist.json, and which title an
// entry is now goes by core's rules (`sameTitle`, `titleOf`): by TMDB id where the lists gather
// versions by one, else by the provider's ids. Each time the lists are read, saved titles take
// their name and versions as the lists have them now (`settled`). Disconnect forgets it.

const FILE = "watchlist.json";

interface Saved {
  readonly version: 1;
  readonly subscriptionId: string;
  readonly entries: readonly SavedTitle[];
}

const saved = store<Saved | null>(null);

function load(subscriptionId: string) {
  const read = readJson(FILE) as Saved | null;
  saved.set(
    read?.version === 1 && read.subscriptionId === subscriptionId
      ? read
      : { version: 1, subscriptionId, entries: [] },
  );
}

function write(next: Saved) {
  writeJson(FILE, next);
  saved.set(next);
}

/** Reads what the signed-in subscription saved. */
export function connectWatchlist(subscriptionId: string) {
  load(subscriptionId);
}

export function disconnectWatchlist() {
  saved.set(null);
  removeJson(FILE);
}

/** The saved entries, the latest first. */
export function useWatchlist(): readonly SavedTitle[] {
  const current = useStore(saved);
  return current ? current.entries.toSorted((a, b) => savedFirst(b, a)) : [];
}

/** The entry `title` is saved as, if any. */
export function savedEntry(entries: readonly SavedTitle[], title: Title): SavedTitle | undefined {
  const current = saved.get();
  if (!current) return undefined;
  const facts = factsOf(title, current.subscriptionId);
  return entries.find((entry) => sameTitle(entry, facts));
}

/** Saves a movie or whole series; one saved already keeps its entry and time. */
export function saveTitle(title: Title) {
  const current = saved.get();
  if (!current || savedEntry(current.entries, title)) return;
  const sequence = Math.max(0, ...current.entries.map((entry) => entry.sequence)) + 1;
  write({
    ...current,
    entries: [
      ...current.entries,
      {
        ...factsOf(title, current.subscriptionId),
        id: `${Date.now().toString(36)}-${sequence}`,
        savedAt: Date.now(),
        sequence,
      },
    ],
  });
}

/** Takes a title's entry out. */
export function removeTitle(title: Title) {
  const current = saved.get();
  const entry = current && savedEntry(current.entries, title);
  if (!current || !entry) return;
  write({ ...current, entries: current.entries.filter((each) => each.id !== entry.id) });
}

/** The title each entry is in the lists now, or null when they hold none that is surely it. */
export function watchlistTitles(
  index: IndexedCatalogue,
  entries: readonly SavedTitle[],
): readonly { readonly entry: SavedTitle; readonly title: Title | null }[] {
  const current = saved.get();
  if (!current) return [];
  const { subscriptionId } = current;
  return entries.map((entry) => ({ entry, title: titleOf(index, { ...entry, subscriptionId }) }));
}

/**
 * Brings what was saved in line with lists just read: each entry takes its title's name, year,
 * versions and TMDB id, and entries that turn out to be one title become the one saved first.
 */
export function alignWatchlist(index: IndexedCatalogue) {
  const current = saved.get();
  if (!current || current.entries.length === 0) return;
  const { subscriptionId } = current;
  let entries = current.entries;
  for (const entry of current.entries) {
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
  if (
    JSON.stringify(entries.toSorted(savedFirst)) !==
    JSON.stringify(current.entries.toSorted(savedFirst))
  ) {
    write({ ...current, entries });
  }
}
