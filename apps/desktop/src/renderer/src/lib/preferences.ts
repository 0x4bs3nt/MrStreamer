import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { PreferenceSnapshot } from "@mrstreamer/contracts/ipc";
import type { Preferences } from "@mrstreamer/contracts/preferences";
import { call, listen } from "./ipc.ts";

const key = ["preferences"] as const;
let connected: QueryClient | undefined;
/** Synchronous cache observers can deliver another snapshot before the current call returns. */
const applying = new WeakSet<QueryClient>();
const consumers = new WeakMap<
  QueryClient,
  {
    apply: (preferences: Preferences) => void;
    hideAdults: () => void;
  }
>();

/** All IPC replies/events enter here. The query cache alone holds authoritative preferences. */
export function acceptPreferences(
  client: QueryClient,
  incoming: PreferenceSnapshot,
): PreferenceSnapshot {
  const previous = client.getQueryData<PreferenceSnapshot>(key);
  if (previous && previous.revision >= incoming.revision) return previous;
  const delivering = applying.has(client);
  applying.add(client);
  try {
    client.setQueryData(key, incoming);
    // The outer delivery drains the cache, including any newer snapshot an observer accepted.
    if (delivering) return client.getQueryData<PreferenceSnapshot>(key) ?? incoming;
    let applied = previous;
    while (true) {
      const latest = client.getQueryData<PreferenceSnapshot>(key) ?? incoming;
      if (applied && applied.revision >= latest.revision) return latest;
      consumers.get(client)?.apply(latest.preferences);
      applyChanges(client, applied, latest);
      applied = latest;
    }
  } finally {
    if (!delivering) applying.delete(client);
  }
}

function applyChanges(
  client: QueryClient,
  previous: PreferenceSnapshot | undefined,
  incoming: PreferenceSnapshot,
): void {
  if (previous) {
    const before = previous.preferences;
    const after = incoming.preferences;
    const adult = !!before.adultTitles !== !!after.adultTitles;
    const titles = before.titleLanguage !== after.titleLanguage || before.tmdbKey !== after.tmdbKey;
    if (adult) {
      if (!after.adultTitles) consumers.get(client)?.hideAdults();
      for (const group of ["library", "guide", "watchlist"]) {
        void client.resetQueries({ queryKey: [group] });
      }
    }
    if (adult || titles) {
      // Cancel old first reads too: invalidation alone may reuse them as the new answer.
      const groups = titles && !adult ? ["ondemand", "watchlist"] : ["ondemand"];
      for (const group of groups) {
        void client.cancelQueries({ queryKey: [group] });
        void client.invalidateQueries({ queryKey: [group] });
      }
    }
  }
}

/** React Query's own queryFn completion must also preserve a newer event already in its cache. */
function newest(previous: unknown, incoming: unknown): unknown {
  if (
    previous &&
    incoming &&
    typeof previous === "object" &&
    typeof incoming === "object" &&
    "revision" in previous &&
    "revision" in incoming &&
    typeof previous.revision === "number" &&
    typeof incoming.revision === "number" &&
    previous.revision >= incoming.revision
  )
    return previous;
  return incoming;
}

export const preferenceQuery = () =>
  queryOptions({
    queryKey: key,
    queryFn: async ({ client }) => {
      const snapshot = await call("preferences.get");
      return acceptPreferences(client, snapshot);
    },
    select: (snapshot) => snapshot.preferences,
    structuralSharing: newest,
    staleTime: Infinity,
  });

/** Reads the committed cache without starting another request. Pending editors keep only intent. */
export function currentPreferences(client = connected): Preferences | undefined {
  return client?.getQueryData<PreferenceSnapshot>(key)?.preferences;
}

/** Players can read/save outside React; composition attaches their renderer cache once. */
export async function readPreferences(client = connected): Promise<Preferences> {
  try {
    const snapshot = await call("preferences.get");
    return (client ? acceptPreferences(client, snapshot) : snapshot).preferences;
  } catch (error) {
    if (client) void client.invalidateQueries({ queryKey: key, refetchType: "none" });
    throw error;
  }
}

export async function updatePreferences(
  patch: Partial<Preferences>,
  client = connected,
): Promise<Preferences> {
  const snapshot = await call("preferences.update", patch);
  return (client ? acceptPreferences(client, snapshot) : snapshot).preferences;
}

/** Install once at renderer composition, never from a component or each player attachment. */
export function syncPreferences(
  client: QueryClient,
  apply: (preferences: Preferences) => void,
  hideAdults: () => void = () => {},
): () => void {
  connected = client;
  consumers.set(client, { apply, hideAdults });
  const current = client.getQueryData<PreferenceSnapshot>(key);
  if (current) apply(current.preferences);
  const changed = listen("preferences.changed", (snapshot) => acceptPreferences(client, snapshot));
  const stale = listen("preferences.stale", () => {
    void client.invalidateQueries({ queryKey: key });
  });
  return () => {
    changed();
    stale();
    consumers.delete(client);
    if (connected === client) connected = undefined;
  };
}
