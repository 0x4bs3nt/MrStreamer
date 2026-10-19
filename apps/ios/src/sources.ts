import { AppFailure } from "@mrstreamer/contracts/errors";
import type { Provider } from "@mrstreamer/core/provider";

// What signs in to each saved subscription: its provider adapter, which holds the login, and the
// login's parts, which stream addresses carry and failures must not show. Kept here, apart from
// every store, so no screen, snapshot or failure holds a password. Only account.ts sets and drops
// them; titles.ts, play-title.ts and live playback ask for the one a request names, and
// artwork-cache.ts checks picture addresses against all of them.

export interface Source {
  /** Rises with every new login of any subscription: an answer for an older one is dropped. */
  readonly revision: number;
  readonly provider: Provider;
  readonly login: readonly string[];
}

const sources = new Map<string, Source>();
/** Told after every login set or dropped. */
const changes = new Set<() => void>();
/** How many logins were replaced or dropped in this process. */
let retired = 0;

/** The signed-in source of `subscriptionId`, or a typed failure when it has none. */
export function sourceOf(subscriptionId: string): Source {
  const found = sources.get(subscriptionId);
  if (!found) throw new AppFailure({ kind: "needs-secret", subscriptionId });
  return found;
}

/** The source, if signed in: for checks that a load still answers the login it was made for. */
export const currentSource = (subscriptionId: string): Source | undefined =>
  sources.get(subscriptionId);

/** What stream addresses of `subscriptionId` carry, to keep out of failures. */
export const loginOf = (subscriptionId: string): readonly string[] =>
  sources.get(subscriptionId)?.login ?? [];

/**
 * Every signed-in source, for artwork-cache.ts to tell whether an address carries a login, and
 * whether the login it carried is still current.
 */
export const signedIn = (): readonly Source[] => [...sources.values()];

/**
 * How many logins were replaced or dropped in this process: while none was, every login that gave
 * the lists shown is still signed in.
 */
export const retiredLogins = (): number => retired;

/** Calls `listener` after each login set or dropped; answers how to stop. */
export function onSignedIn(listener: () => void): () => void {
  changes.add(listener);
  return () => void changes.delete(listener);
}

export function setSource(subscriptionId: string, source: Source): void {
  if (sources.has(subscriptionId)) retired++;
  sources.set(subscriptionId, source);
  for (const listener of changes) listener();
}

export function dropSource(subscriptionId: string): void {
  if (!sources.delete(subscriptionId)) return;
  retired++;
  for (const listener of changes) listener();
}
