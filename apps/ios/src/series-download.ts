import { AppFailure } from "@mrstreamer/contracts/errors";
import type { SeriesDetails, TitleRef } from "@mrstreamer/contracts/ondemand";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { seriesEpisodeOrder } from "@mrstreamer/core/ondemand/details";
import { addDownload, downloadOf, replaceMissingDownload, retryDownload } from "./downloads.ts";
import { appError, describeError } from "./errors.ts";
import { currentSource, type Source } from "./sources.ts";
import { store, useStore } from "./store.ts";

// A season's or a whole series' remaining episodes, queued one after another in one version of
// the series. downloads.ts keeps the queue; this only asks it, one episode at a time, and keeps
// nothing on disk: the run under way, or how the last one went, lasts while the app runs.
//
// What a run may do is fixed before the viewer confirms (`planDownload`): the series version
// shown, its provider's login as it was, and its episodes by their exact files, in the order the
// series lists them (core's, specials and a playlist's own order included). An episode is queued
// only if it still has no download, retried only if it still failed, and its missing copy
// replaced only if the viewer asked and its file is still gone; any other is skipped. Before each
// one the run stops for good when the viewer cancelled it, left these details or chose another
// version (`stands`), or when that provider was removed or signed in anew. A request already
// made settles and counts. What was queued stays queued whatever comes after it. One run goes at
// a time.

export type EpisodeRef = Extract<TitleRef, { kind: "episode" }>;

/** A season of the series, or the whole of it. */
export type Scope =
  { readonly kind: "season"; readonly season: number } | { readonly kind: "series" };

/** A bulk download as the viewer is asked to confirm it. */
export interface Plan {
  readonly scope: Scope;
  readonly version: OwnedId;
  /** The login it was planned under: another, or none, ends it. */
  readonly source: Source;
  /** Every episode in scope, in the series' order. */
  readonly episodes: readonly EpisodeRef[];
  /** How many seasons they span. */
  readonly seasons: number;
  /** Saved, queued, waiting or downloading already. */
  readonly held: number;
  /** No download yet. */
  readonly add: readonly EpisodeRef[];
  readonly retry: readonly EpisodeRef[];
  /** Copies whose file is gone: replaced only when the viewer says so. */
  readonly missing: readonly EpisodeRef[];
}

/** What a run did. Queued is all it can say: each transfer shows in Downloads. */
export interface Result {
  readonly added: number;
  readonly retried: number;
  readonly replaced: number;
  /** Changed since the viewer confirmed, so left as they were. */
  readonly skipped: number;
  readonly failed: readonly { readonly ref: EpisodeRef; readonly error: string }[];
  /** Never asked for, as the run stopped first. */
  readonly cancelled: number;
  readonly stopped: null | "cancelled" | "left" | "login";
}

/** The run under way, or the last one. */
export interface Run {
  /** This run alone: what its Cancel remaining and Retry failed act on. */
  readonly id: number;
  readonly phase: "running" | "done";
  /** Episodes dealt with so far, of `total`. */
  readonly done: number;
  readonly total: number;
  readonly result: Result;
}

const runs = store<Run | null>(null);
/** The run under way or the last one, rendering again as it moves. */
export const useSeriesRun = () => useStore(runs);
/** The same, for owners outside React. */
export const seriesRun = () => runs.get();

/** The run under way, and whether the viewer cancelled it. */
let running: { readonly id: number; cancelled: boolean } | null = null;
let made = 0;
/** The episodes that failed in the last run, with the plan they came from. */
let lastFailed: {
  readonly id: number;
  readonly plan: Plan;
  readonly refs: readonly EpisodeRef[];
} | null = null;

const NONE: Result = {
  added: 0,
  retried: 0,
  replaced: 0,
  skipped: 0,
  failed: [],
  cancelled: 0,
  stopped: null,
};

/** Whether the login `plan` was made under is still the one signed in. */
function sameLogin(plan: Plan): boolean {
  const now = currentSource(plan.version.subscriptionId);
  return now !== undefined && now === plan.source;
}

/** How an episode stands in the queue now. */
function standing(ref: EpisodeRef): "none" | "held" | "failed" | "missing" {
  const status = downloadOf(ref)?.status.kind;
  if (status === undefined) return "none";
  if (status === "failed" || status === "missing") return status;
  return "held";
}

function sorted(base: Omit<Plan, "seasons" | "held" | "add" | "retry" | "missing">): Plan {
  const add: EpisodeRef[] = [];
  const retry: EpisodeRef[] = [];
  const missing: EpisodeRef[] = [];
  let held = 0;
  for (const ref of base.episodes) {
    const now = standing(ref);
    if (now === "none") add.push(ref);
    else if (now === "failed") retry.push(ref);
    else if (now === "missing") missing.push(ref);
    else held++;
  }
  const seasons = new Set(base.episodes.map((ref) => ref.season)).size;
  return { ...base, seasons, held, add, retry, missing };
}

/**
 * The episodes `scope` of `details`, the details of series version `version`, covers: only that
 * version's own, by their exact files, once each, in the series' order.
 */
function episodesIn(details: SeriesDetails, version: OwnedId, scope: Scope): EpisodeRef[] {
  const seen = new Set<string>();
  const episodes: EpisodeRef[] = [];
  for (const episode of seriesEpisodeOrder(details)) {
    if (episode.subscriptionId !== version.subscriptionId || episode.seriesId !== version.id) {
      continue;
    }
    if (scope.kind === "season" && episode.season !== scope.season) continue;
    if (seen.has(episode.id)) continue;
    seen.add(episode.id);
    episodes.push({
      kind: "episode",
      subscriptionId: episode.subscriptionId,
      id: episode.id,
      seriesId: episode.seriesId,
      season: episode.season,
      episode: episode.number,
    });
  }
  return episodes;
}

/** How many episodes `scope` covers, and how many of them are saved or queued already. */
export function countDownload(details: SeriesDetails, version: OwnedId, scope: Scope) {
  const episodes = episodesIn(details, version, scope);
  return {
    total: episodes.length,
    held: episodes.filter((ref) => standing(ref) === "held").length,
  };
}

/**
 * What downloading `scope` of `details`, the details of series version `version`, would do now.
 * Throws while its provider isn't signed in.
 */
export function planDownload(details: SeriesDetails, version: OwnedId, scope: Scope): Plan {
  const { subscriptionId } = version;
  const source = currentSource(subscriptionId);
  if (!source) throw new AppFailure({ kind: "needs-secret", subscriptionId });
  return sorted({ scope, version, source, episodes: episodesIn(details, version, scope) });
}

/** Lets taps and frames through between episodes. */
const yieldNow = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** How an episode stood when the viewer confirmed, which says what the run asks for it. */
type Was = "none" | "failed" | "missing";

/**
 * Starts `plan` as confirmed: its remaining episodes and failed ones, and its missing copies when
 * `replace`. Answers the run's id; null, doing nothing, while another run is under way, when
 * `stands` no longer holds or its provider's login changed since it was planned.
 */
export function startDownload(
  plan: Plan,
  { replace, stands }: { readonly replace: boolean; readonly stands: () => boolean },
): number | null {
  if (running || !stands() || !sameLogin(plan)) return null;
  const confirmed = new Map<EpisodeRef, Was>([
    ...plan.add.map((ref) => [ref, "none"] as const),
    ...plan.retry.map((ref) => [ref, "failed"] as const),
    ...(replace ? plan.missing.map((ref) => [ref, "missing"] as const) : []),
  ]);
  const steps = plan.episodes.flatMap((ref) => {
    const was = confirmed.get(ref);
    return was ? [{ ref, was }] : [];
  });
  const me = { id: ++made, cancelled: false };
  const total = steps.length;
  running = me;
  lastFailed = null;
  runs.set({ id: me.id, phase: "running", done: 0, total, result: NONE });
  void (async () => {
    const failed: { ref: EpisodeRef; error: string }[] = [];
    let result = NONE;
    let done = 0;
    for (const { ref, was } of steps) {
      await yieldNow();
      const stopped = me.cancelled
        ? "cancelled"
        : !stands()
          ? "left"
          : !sameLogin(plan)
            ? "login"
            : null;
      if (stopped) {
        result = { ...result, stopped, cancelled: total - done };
        break;
      }
      if (standing(ref) !== was) result = { ...result, skipped: result.skipped + 1 };
      else {
        try {
          await ask(was, ref);
          if (standing(ref) === "failed") throw new Error("It couldn't be queued again.");
          result =
            was === "none"
              ? { ...result, added: result.added + 1 }
              : was === "failed"
                ? { ...result, retried: result.retried + 1 }
                : { ...result, replaced: result.replaced + 1 };
        } catch (cause) {
          failed.push({ ref, error: describeError(appError(cause)) });
          result = { ...result, failed: [...failed] };
        }
      }
      done++;
      runs.set({ id: me.id, phase: "running", done, total, result });
    }
    running = null;
    if (failed.length > 0) lastFailed = { id: me.id, plan, refs: failed.map((each) => each.ref) };
    runs.set({ id: me.id, phase: "done", done, total, result });
  })();
  return me.id;
}

/** Asks the queue for one episode, by how it stood when confirmed. */
async function ask(was: Was, ref: EpisodeRef): Promise<unknown> {
  switch (was) {
    case "none":
      return addDownload(ref);
    case "missing":
      return replaceMissingDownload(ref);
    case "failed": {
      const download = downloadOf(ref);
      return download && retryDownload(download.id);
    }
  }
}

/** Stops run `id` before its next episode; one already asked for settles. */
export function cancelRemaining(id: number): void {
  if (running?.id === id) running.cancelled = true;
}

/**
 * The episodes that failed in run `id`, planned again as they stand now under the same login:
 * null when another run came since, none failed, or that login changed.
 */
export function planRetry(id: number): Plan | null {
  if (lastFailed?.id !== id || !sameLogin(lastFailed.plan)) return null;
  const { plan, refs } = lastFailed;
  return sorted({ scope: plan.scope, version: plan.version, source: plan.source, episodes: refs });
}
