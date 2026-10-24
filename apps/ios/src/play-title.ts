import type {
  Episode,
  SeriesDetails,
  Title,
  TitleKind,
  TitleRef,
} from "@mrstreamer/contracts/ondemand";
import { ownedId, ownedKey, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { TitleProgress } from "@mrstreamer/contracts/viewing";
import { episodeLabel } from "@mrstreamer/core/ondemand/names";
import { nextEpisode } from "@mrstreamer/core/ondemand/details";
import { resumePoint } from "@mrstreamer/core/viewing/continue";
import {
  continuation,
  episodeStates,
  finishes,
  nextUnwatched,
  type Continuation,
} from "@mrstreamer/core/viewing/episodes";
import { isFinished } from "@mrstreamer/core/viewing/titles";
import { play, progressSettled, request, type Playing, type Request } from "./playback.ts";
import { loginOf } from "./sources.ts";
import { store, useStore } from "./store.ts";
import { titleFile } from "./titles.ts";
import { finishSeries, progressOf, recordProgress, seriesViewing } from "./viewing.ts";

// Playing a movie or an episode in the one player, as the desktop's title player decides it:
// from where it stopped, saving how far it got in the viewing record against when this play
// began, the next episode not yet watched, and a series finished once its last episode ends with
// none left. Any file is tried, whatever its name or type says. Resuming reads where a title got
// to once every save asked before ended, so a position Close or Stop just saved counts.
//
// What didn't play is noted by the version the viewer chooses between, a movie's or a series',
// for its details and version menu, until that version plays. For a series it says an episode of
// the version didn't play, not that the version can't play: its other episodes may well.

/** What failed in a version: its file, or an episode's file of a series version. */
export type Failure = "file" | "episode";

/**
 * Versions that failed to play since launch, and what of them failed, by kind and version: a
 * movie and a series can have the same id in one subscription.
 */
const failed = store<ReadonlyMap<string, Failure>>(new Map());
const failureKey = (kind: TitleKind, version: OwnedId) => `${kind}|${ownedKey(version)}`;

/** What failed of a movie's or series' version since launch, if anything. */
export function useFailure(kind: TitleKind, version: OwnedId): Failure | undefined {
  return useStore(failed).get(failureKey(kind, version));
}
/** The same, as it stands now, for a menu opened later than the screen last drew. */
export function failureOf(kind: TitleKind, version: OwnedId): Failure | undefined {
  return failed.get().get(failureKey(kind, version));
}

/** Notes whether `version` played: a failure until it plays, cleared once it does. */
function outcomeOf(kind: TitleKind, version: OwnedId, failure: Failure) {
  const key = failureKey(kind, version);
  return (played: boolean) =>
    failed.set((current) => {
      if (played ? !current.has(key) : current.get(key) === failure) return current;
      const next = new Map(current);
      if (played) next.delete(key);
      else next.set(key, failure);
      return next;
    });
}

/** Shows the title's version choice, after one failed. */
export type ShowVersions = () => void;

const sourceOf = (ref: TitleRef) => async (signal: AbortSignal) => {
  const file = await titleFile(ref, signal);
  return {
    url: file.url,
    container: file.container,
    ...(file.headers ? { headers: file.headers } : {}),
  };
};

/** Plays a movie's `version` in Watch, from `from` seconds. */
export function playMovie(title: Title, version: OwnedId, from: number, versions: ShowVersions) {
  const ref: TitleRef = { kind: "movie", ...ownedId(version) };
  const since = Date.now();
  const key = ownedKey(version);
  const item: Playing = {
    id: key,
    subscriptionId: version.subscriptionId,
    title: title.title,
    place: title.year ? String(title.year) : "",
    live: false,
    next: false,
    versions: title.versions.length > 1,
  };
  void play(item, sourceOf(ref), {
    watch: true,
    login: loginOf(version.subscriptionId),
    from,
    progress: (position, duration) => recordProgress(ref, position, duration, since),
    outcome: outcomeOf("movie", version, "file"),
    versions,
  });
}

/** Plays an episode of `details`, a series version, in Watch, from `from` seconds. */
export function playEpisode(
  details: SeriesDetails,
  episode: Episode,
  from: number,
  versions: ShowVersions,
) {
  const ref: TitleRef = {
    kind: "episode",
    subscriptionId: episode.subscriptionId,
    id: episode.id,
    seriesId: episode.seriesId,
    season: episode.season,
    episode: episode.number,
  };
  const series = { subscriptionId: episode.subscriptionId, id: episode.seriesId };
  const since = Date.now();
  const key = ownedKey(episode);
  const at = { id: episode.id, season: episode.season, episode: episode.number };
  /** The episode after this one in the series' order; null at the last. */
  const after = nextEpisode(details, at) ?? null;
  let finishing = false;
  const standing = () => seriesViewing(series);
  const item: Playing = {
    id: key,
    subscriptionId: episode.subscriptionId,
    title: details.title.title,
    place: `${episodeLabel(episode.season, episode.number)} · ${episode.title}`,
    live: false,
    next: after !== null,
    versions: details.title.versions.length > 1,
  };
  void play(item, sourceOf(ref), {
    watch: true,
    login: loginOf(episode.subscriptionId),
    from,
    progress: (position, duration) => {
      const saved = recordProgress(ref, position, duration, since);
      if (after !== null || finishing || !isFinished(position, duration)) return saved;
      // In the credits of an episode with none after it: once the progress is saved, the series
      // is finished if the record says no numbered episode is left to watch.
      finishing = true;
      void saved
        .then(standing)
        .then(({ progress, marks }) =>
          finishes(details, { ...ref, id: episode.id, since }, progress, marks)
            ? finishSeries(details.title.versions.map(ownedId), since)
            : (finishing = false),
        )
        .catch(() => (finishing = false));
      return saved;
    },
    outcome: outcomeOf("series", series, "episode"),
    // The next one not yet watched, as the record stands once this one's progress is saved, else
    // the next in order, unless the viewer did something else while the record answered. A
    // refused save was told (`onProgressRefused`), and an unreadable record can't say which
    // episode goes on or from where: either way this one stays, for Next to be pressed again.
    next: (saved) => {
      const asked = request();
      void saved
        .then(async ({ saved: kept }) => {
          if (!kept || !asked.stands()) return;
          const { progress, marks } = await standing();
          if (!asked.stands()) return;
          const upcoming = nextUnwatched(details, at, progress, marks) ?? after;
          if (!upcoming) return;
          const found = progress.find(
            ({ title }) => title.kind === "episode" && title.id === upcoming.id,
          );
          playEpisode(details, upcoming, resumePoint(found), versions);
        })
        .catch(() => undefined);
    },
    versions,
  });
}

/**
 * Plays from where `read` says a title got to, read once every save of progress asked before
 * ended (`progressSettled`); from `shown`, what the screen showed, when the record can't be read.
 * Playing, Stop, removing a subscription, another screen, Close, setting Watch aside or Picture
 * in Picture changes cancel it (`request`), as does `owner`, the caller's own word, no longer
 * standing: details showing another version, or gone.
 */
function resumeWith<P>(
  read: () => Promise<P>,
  shown: P,
  start: (found: P) => void,
  owner: Request | undefined,
) {
  const asked = request();
  const stands = () => asked.stands() && (owner?.stands() ?? true);
  void (async () => {
    await progressSettled();
    if (!stands()) return;
    const found = await read().catch(() => shown);
    if (stands()) start(found);
  })();
}

/** Resumes a movie's `version` where it stopped; a finished one plays from its start. */
export function resumeMovie(
  title: Title,
  version: OwnedId,
  shown: TitleProgress | undefined,
  versions: ShowVersions,
  owner?: Request,
) {
  resumeWith(
    async () =>
      (await progressOf({ movies: [version] })).find(
        (played) => played.title.kind === "movie" && sameOwned(played.title, version),
      ),
    shown,
    (found) => playMovie(title, version, resumePoint(found), versions),
    owner,
  );
}

/** Resumes an episode of `details` where it stopped; one watched or not begun plays from its start. */
export function resumeEpisode(
  details: SeriesDetails,
  episode: Episode,
  shown: TitleProgress | undefined,
  versions: ShowVersions,
  owner?: Request,
) {
  resumeWith(
    async () => {
      const { progress, marks } = await seriesViewing({
        subscriptionId: episode.subscriptionId,
        id: episode.seriesId,
      });
      const state = episodeStates(progress, marks)(episode);
      return state.kind === "partial" ? state.progress : undefined;
    },
    shown,
    (found) => playEpisode(details, episode, resumePoint(found), versions),
    owner,
  );
}

/** Plays a series `version` where its episodes say it goes on; `shown` when they say none. */
export function resumeSeries(
  details: SeriesDetails,
  version: OwnedId,
  shown: Continuation<Episode, TitleProgress>,
  versions: ShowVersions,
  owner?: Request,
) {
  resumeWith(
    async () => {
      const { progress, marks } = await seriesViewing(version);
      return continuation(details, progress, marks) ?? shown;
    },
    shown,
    (goesOn) => playEpisode(details, goesOn.episode, resumePoint(goesOn.resume), versions),
    owner,
  );
}
