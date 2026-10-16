import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { File, Paths } from "expo-file-system";
import { readJson, writeJson } from "./files.ts";
import { store, useStore } from "./store.ts";

// What the app keeps between launches, apart from secrets and the saved subscriptions
// (subscriptions.ts): one JSON file in the app's Documents folder, which iOS deletes with the app.
// Its absence, with no subscriptions.json either, therefore also says this is the first launch
// since installing, when the Keychain may still hold an earlier install's secrets (see secrets.ts).

const State = lazy(() =>
  type({
    /**
     * The subscription private beta 2 knew, the first added: kept for an older build to show,
     * cleared when it is removed. subscriptions.json lists every one.
     */
    subscription: type({ id: "string", server: "string", username: "string" }).or("null"),
    /** Beta 2's recent channels, by its subscription's channel ids: read once into the next. */
    recent: "string[]",
    /** Channels watched lately, by `ownedKey`, the latest first. */
    "recentChannels?": "string[]",
    /** The region or category group Live last showed. */
    region: "string | null",
  }),
);
export type SavedState = Infer<typeof State>;
export type SavedSubscription = NonNullable<SavedState["subscription"]>;

const EMPTY: SavedState = { subscription: null, recent: [], region: null };
const RECENT = 12;

const FILE = "state.json";

/** Whether nothing was saved since the app was installed. */
export function firstLaunch(): boolean {
  return !new File(Paths.document, FILE).exists;
}

/** The file's state, read once, then kept as written. */
const cached = store<SavedState | null>(null);

/** The saved state; an unreadable or unknown file counts as none. */
export function readState(): SavedState {
  const known = cached.get();
  if (known) return known;
  const parsed = State()(readJson(FILE));
  const state = parsed instanceof type.errors ? EMPTY : parsed;
  cached.set(state);
  return state;
}

/** The saved state, once launch read it (see account.ts `restore`). */
export function useSavedState(): SavedState {
  return useStore(cached) ?? EMPTY;
}

export function writeState(change: (state: SavedState) => SavedState): SavedState {
  const next = change(readState());
  writeJson(FILE, next);
  cached.set(next);
  return next;
}

/** Puts the channel `key` (`ownedKey`) first among the recently watched. */
export function rememberChannel(key: string): void {
  writeState((state) => ({
    ...state,
    recentChannels: [key, ...(state.recentChannels ?? []).filter((each) => each !== key)].slice(
      0,
      RECENT,
    ),
  }));
}

/**
 * Beta 2's recent channels as the channels of its subscription, once: a launch after that finds
 * `recentChannels` and changes nothing. `recent` stays as it was, for an older build.
 */
export function migrateRecentChannels(): void {
  const { subscription, recent, recentChannels } = readState();
  if (recentChannels) return;
  writeState((state) => ({
    ...state,
    recentChannels: subscription ? recent.map((id) => `${subscription.id}:${id}`) : [],
  }));
}
