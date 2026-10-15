import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import { File, Paths } from "expo-file-system";
import { store, useStore } from "./store.ts";

// What the app keeps between launches, apart from secrets: one JSON file in the app's Documents
// folder, which iOS deletes with the app. Its absence therefore also says this is the first launch
// since installing, when the Keychain may still hold an earlier install's secrets (see secrets.ts).

const State = lazy(() =>
  type({
    subscription: type({ id: "string", server: "string", username: "string" }).or("null"),
    /** Channel ids, the latest first. */
    recent: "string[]",
    /** The region or category group Live last showed. */
    region: "string | null",
  }),
);
export type SavedState = Infer<typeof State>;
export type SavedSubscription = NonNullable<SavedState["subscription"]>;

const EMPTY: SavedState = { subscription: null, recent: [], region: null };
const RECENT = 12;

const file = () => new File(Paths.document, "state.json");

/** Whether nothing was saved since the app was installed. */
export function firstLaunch(): boolean {
  return !file().exists;
}

/** The file's state, read once, then kept as written. */
const cached = store<SavedState | null>(null);

/** The saved state; an unreadable or unknown file counts as none. */
export function readState(): SavedState {
  const known = cached.get();
  if (known) return known;
  const saved = file();
  let state = EMPTY;
  if (saved.exists) {
    try {
      const parsed = State()(JSON.parse(saved.textSync()));
      if (!(parsed instanceof type.errors)) state = parsed;
    } catch {
      // Unreadable: start again.
    }
  }
  cached.set(state);
  return state;
}

/** The saved state, once launch read it (see account.ts `restore`). */
export function useSavedState(): SavedState {
  return useStore(cached) ?? EMPTY;
}

export function writeState(change: (state: SavedState) => SavedState): SavedState {
  const next = change(readState());
  const saved = file();
  if (!saved.exists) saved.create();
  saved.writeSync(JSON.stringify(next));
  cached.set(next);
  return next;
}

/** Puts `channelId` first among the recently watched. */
export function rememberChannel(channelId: string): void {
  writeState((state) => ({
    ...state,
    recent: [channelId, ...state.recent.filter((id) => id !== channelId)].slice(0, RECENT),
  }));
}
