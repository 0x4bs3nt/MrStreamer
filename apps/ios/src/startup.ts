import {
  channelsWorkedOut,
  currentRoster,
  onCatalogue,
  onReadingSaved,
  onRoster,
  readingSaved,
  restore,
} from "./account.ts";
import { store, useStore } from "./store.ts";
import { endLaunchBatch, onTitleLists, titlesWorkedOut } from "./titles.ts";

// Whether the app is still opening: from launch until what the phone saved shows, which the launch
// screen covers (`StartupScreen`). It opens once the saved subscriptions are read (account.ts
// `restore`), every saved list a launch reads has shown or turned out missing, unreadable or not
// the login's, and the channels and the movie and series collections are worked out of the lists
// that show. With none saved, or none whose password the Keychain gives back, that is at once.
// Only what is on the phone counts: no login check or provider's answer is waited for, and a
// list that wasn't saved loads after, as screens show it; one a provider answered while it opens is
// worked out with the rest. Once open it stays open. A read the disk never answers doesn't keep it
// opening past `LONGEST`: the lists read by then are worked out and show, and the late one joins
// them when it answers.

export type Startup =
  /** What the phone saved doesn't show yet. */
  | { readonly kind: "opening" }
  /** Screens show what the phone saved, or what loads without it. */
  | { readonly kind: "open" };

/** How long the saved lists may take to show before the app opens without the rest. */
const LONGEST = 8_000;

const startup = store<Startup>({ kind: "opening" });

export const useStartup = () => useStore(startup);
/** Whether the app has opened yet, for owners outside React. */
export const currentStartup = () => startup.get();
/** Calls `listener` once the app opens. */
export const onStartup = (listener: () => void) => startup.subscribe(listener);

let started: Promise<void> | null = null;
let restored = false;
const stops: Array<() => void> = [];

function open() {
  for (const stop of stops.splice(0)) stop();
  // Opened before a read answered: the titles read so far show without it, which joins them later.
  endLaunchBatch();
  startup.set({ kind: "open" });
}

function settle() {
  if (startup.get().kind === "open") return;
  const shows =
    restored &&
    currentRoster().kind === "ready" &&
    !readingSaved() &&
    channelsWorkedOut() &&
    titlesWorkedOut();
  if (shows) open();
}

/**
 * At launch, once: reads the saved subscriptions and signs them in again (`restore`), and opens
 * the app as soon as what they saved shows. Resolves once the subscriptions are read.
 */
export function startUp(): Promise<void> {
  started ??= (() => {
    const timer = setTimeout(open, LONGEST);
    stops.push(
      () => clearTimeout(timer),
      onRoster(settle),
      onReadingSaved(settle),
      onCatalogue(settle),
      onTitleLists(settle),
    );
    return restore().then(() => {
      restored = true;
      settle();
    });
  })();
  return started;
}
