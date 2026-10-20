/** Waits before reconnect attempts; the number of waits is the attempt limit. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000] as const;
/** Thirty seconds of actual playback earns fresh reconnects, excluding pause and buffering. */
export const STABLE_PLAYBACK_MS = 30_000;
