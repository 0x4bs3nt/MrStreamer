import { AppFailure } from "@mrstreamer/contracts/errors";
import type { Provider } from "@mrstreamer/core/provider";

// What signs in to each saved subscription: its provider adapter, which holds the login, and the
// login's parts, which stream addresses carry and failures must not show. Kept here, apart from
// every store, so no screen, snapshot or failure holds a password. Only account.ts sets and drops
// them; titles.ts, play-title.ts and live playback ask for the one a request names.

export interface Source {
  /** Rises with every new login of any subscription: an answer for an older one is dropped. */
  readonly revision: number;
  readonly provider: Provider;
  readonly login: readonly string[];
}

const sources = new Map<string, Source>();

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

export function setSource(subscriptionId: string, source: Source): void {
  sources.set(subscriptionId, source);
}

export function dropSource(subscriptionId: string): void {
  sources.delete(subscriptionId);
}
