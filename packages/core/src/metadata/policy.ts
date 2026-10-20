// Shared TMDB lifetimes. Callers keep their own timestamp checks and cutoff comparisons.
/** Renew metadata before TMDB's six-month retention limit. */
export const TMDB_REFRESH_MS = 150 * 24 * 60 * 60_000;
/** Stop using retained TMDB metadata at six months. */
export const TMDB_EXPIRE_MS = 182 * 24 * 60 * 60_000;
