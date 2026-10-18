// The time programme progress is drawn at. One timer for the whole window, ticking every 30
// seconds: progress bars move a pixel at a time, so nothing needs animating in between.
import { useSyncExternalStore } from "react";
import { usePresentationVisible } from "./presentation.ts";

const TICK_MS = 30_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
const refresh = () => {
  now = Date.now();
  for (const changed of listeners) changed();
};
const subscribe = (changed: () => void) => {
  listeners.add(changed);
  // Returning to a retained page uses the wall clock immediately, before the next tick.
  refresh();
  timer ??= setInterval(refresh, TICK_MS);
  return () => {
    listeners.delete(changed);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
};
const ignore = () => () => {};
const snapshot = () => now;

/** The current time in epoch milliseconds, updated every 30 seconds. */
export function useNow(): number {
  const visible = usePresentationVisible();
  return useSyncExternalStore(visible ? subscribe : ignore, snapshot);
}
