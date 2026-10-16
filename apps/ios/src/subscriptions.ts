import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { readJson, writeJson } from "./files.ts";
import type { SavedState } from "./storage.ts";

// The saved subscriptions, in the order they were added, in subscriptions.json in Documents.
// account.ts alone reads and writes it, one change at a time. Passwords stay in the Keychain under
// each subscription's id; the file holds no secret.
//
// Private beta 2 (0.1.0) kept its one subscription in state.json. The first launch since then
// makes this file from it, keeping its id, so its Keychain item, viewing record, watchlist and
// recent channels go on matching without being rewritten. state.json keeps that subscription as
// it was, for an older build to show, until it is removed.

const Account = lazy(() =>
  type({ id: "string", kind: "'xtream'", server: "string", username: "string" }),
);

const Registry = lazy(() =>
  type({
    version: "1",
    /** In the order they were added: lists show their content in this order. */
    subscriptions: Account().and({ name: "string | null" }).array(),
    /**
     * Accounts removed with their history kept, the latest first. Adding one again takes its id
     * back, so its favourites, watchlist, history and progress return.
     */
    retired: Account().array(),
    /**
     * Ids whose Keychain item an add or a removal was writing or removing when the app last
     * stopped. Launch removes the item of any that isn't saved; nothing else in the Keychain is
     * touched.
     */
    pendingSecrets: "string[]",
    /**
     * Ids removed with their history whose history isn't all deleted yet: launch deletes it again
     * until it is. No subscription is given one of these ids meanwhile.
     */
    erasing: ["string[]", "=", () => []],
  }),
);

export type Registry = Infer<typeof Registry>;
export type SubscriptionEntry = Registry["subscriptions"][number];
type RetiredAccount = Registry["retired"][number];

const FILE = "subscriptions.json";
/** Removed accounts remembered for their history; older ones are forgotten. */
export const RETIRED_LIMIT = 16;

export const EMPTY_REGISTRY: Registry = {
  version: 1,
  subscriptions: [],
  retired: [],
  pendingSecrets: [],
  erasing: [],
};

/** The saved registry; null when there is none yet, or it doesn't read as one. */
export function readRegistry(): Registry | null {
  const read = readJson(FILE);
  if (read === null) return null;
  const parsed = Registry()(read);
  return parsed instanceof type.errors ? null : parsed;
}

/** Replaces the file whole. Throws when Documents won't take it. */
export function writeRegistry(registry: Registry): void {
  writeJson(FILE, registry);
}

/** One account per server and username: adding it again updates the one saved. */
export function sameAccount(
  a: Pick<RetiredAccount, "kind" | "server" | "username">,
  b: Pick<RetiredAccount, "kind" | "server" | "username">,
): boolean {
  return a.kind === b.kind && a.server === b.server && a.username === b.username;
}

/** The registry beta 2's state.json describes: its one subscription, under its own id. */
export function migrated(state: SavedState): Registry {
  const { subscription } = state;
  return subscription
    ? {
        ...EMPTY_REGISTRY,
        subscriptions: [{ ...subscription, kind: "xtream", name: null }],
      }
    : EMPTY_REGISTRY;
}

/** The registry without `entry`, its account kept in `retired` unless its history goes too. */
export function withoutSubscription(
  registry: Registry,
  entry: SubscriptionEntry,
  keepHistory: boolean,
): Registry {
  const account = {
    id: entry.id,
    kind: entry.kind,
    server: entry.server,
    username: entry.username,
  };
  const others = registry.retired.filter(
    (each) => each.id !== entry.id && !sameAccount(each, entry),
  );
  return {
    ...registry,
    subscriptions: registry.subscriptions.filter((each) => each.id !== entry.id),
    retired: keepHistory ? [account, ...others].slice(0, RETIRED_LIMIT) : others,
    pendingSecrets: withPending(registry.pendingSecrets, entry.id),
    erasing: keepHistory ? registry.erasing : withPending(registry.erasing, entry.id),
  };
}

export const withPending = (pending: readonly string[], id: string): string[] => [
  ...pending.filter((each) => each !== id),
  id,
];

export const withoutPending = (pending: readonly string[], id: string): string[] =>
  pending.filter((each) => each !== id);

/**
 * A new subscription id: no colon (`ownedKey`), and none saved, retired or with a history still
 * being deleted has it.
 */
export function newSubscriptionId(registry: Registry, now: number): string {
  const taken = new Set([
    ...[...registry.subscriptions, ...registry.retired].map((each) => each.id),
    ...registry.erasing,
  ]);
  const base = `xtream-${now.toString(36)}`;
  let id = base;
  for (let next = 2; taken.has(id); next++) id = `${base}-${next}`;
  return id;
}
