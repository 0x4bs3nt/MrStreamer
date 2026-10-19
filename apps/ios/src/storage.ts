import { type } from "arktype";
import { lazy, type Infer } from "@mrstreamer/contracts/lazy";
import type { Title } from "@mrstreamer/contracts/ondemand";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
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
    /**
     * The region or category group last chosen in Live, which Home's On now shows until channels
     * are watched. Live itself opens on every country.
     */
    region: "string | null",
    /**
     * The version picked for a title in its details, as the desktop keeps them: by subscription,
     * then `kind:tmdbId`, the id of that subscription's version. Read through `TitleVersions`,
     * so a shape this build doesn't know counts as no pick and never loses the rest of the file.
     */
    "titleVersions?": "unknown",
  }),
);
const TitleVersions = lazy(() => type({ "[string]": { "[string]": "string" } }));
type TitleVersions = Infer<typeof TitleVersions>;
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

/** The picks as saved, or none when they don't check out. */
function versionsOf(state: SavedState): TitleVersions {
  const parsed = TitleVersions()(state.titleVersions ?? {});
  return parsed instanceof type.errors ? {} : parsed;
}

/** What a title's pick is kept by: only titles with a TMDB id gather several versions. */
const pickKey = (title: Title) => (title.tmdbId ? `${title.kind}:${title.tmdbId}` : null);

/**
 * The version picked for `title` in its details, while a subscription that lists it still lists
 * that version; null otherwise, the pick staying saved for when it is listed again.
 */
export function pickedVersion(title: Title, state: SavedState): OwnedId | null {
  const key = pickKey(title);
  if (!key) return null;
  const picks = versionsOf(state);
  const found = title.versions.find(
    ({ subscriptionId, id }) => picks[subscriptionId]?.[key] === id,
  );
  return found ? ownedId(found) : null;
}

/**
 * Remembers `version` as `title`'s pick, or none for Automatic: kept under the version's own
 * subscription and out of every other, so a title has one pick at most. A title without a TMDB
 * id keeps none. A write that fails leaves the pick as it was; the choice still shows.
 */
export function pickVersion(title: Title, version: OwnedId | null): void {
  const key = pickKey(title);
  if (!key || (version && !title.versions.some((each) => sameOwned(each, version)))) return;
  try {
    writeState((state) => {
      const titleVersions: Record<string, Record<string, string>> = {};
      for (const [subscriptionId, picks] of Object.entries(versionsOf(state))) {
        const { [key]: _old, ...others } = picks;
        if (Object.keys(others).length > 0) titleVersions[subscriptionId] = others;
      }
      if (version) {
        titleVersions[version.subscriptionId] = {
          ...titleVersions[version.subscriptionId],
          [key]: version.id,
        };
      }
      return { ...state, titleVersions };
    });
  } catch {
    // Chosen for this screen only.
  }
}

/**
 * `state` without the picks of subscription `id`: its history erased with it. Picks in a shape
 * this build doesn't know stay as they are.
 */
export function withoutVersions(state: SavedState, id: string): SavedState {
  const picks = TitleVersions()(state.titleVersions ?? {});
  if (picks instanceof type.errors || !(id in picks)) return state;
  const { [id]: _gone, ...others } = picks;
  return { ...state, titleVersions: others };
}
