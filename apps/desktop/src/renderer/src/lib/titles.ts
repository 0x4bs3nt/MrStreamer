// Movies and episodes as the views talk about them: how long, how far, what's next, which version
// plays, and playing one. The player itself is in ../player/title-player.ts. A version is named
// with its subscription throughout, and so is what plays. A title can gather versions of several
// subscriptions: one of them plays, and how far it got is that version's subscription's alone.
import {
  isCancelledError,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { seriesOf, type Title } from "@mrstreamer/contracts/ondemand";
import type { SubscriptionPreferences } from "@mrstreamer/contracts/preferences";
import { ownedId, ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { CONTINUE_LIMIT, type TitleProgress } from "@mrstreamer/contracts/viewing";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import {
  continueEntries,
  resumePoint,
  type ContinueEntry,
} from "@mrstreamer/core/viewing/continue";
import { seriesIdentity } from "@mrstreamer/core/viewing/marks";
import { openDetails, useUi } from "../app/ui-store.ts";
import {
  episodeNow,
  titlePlayer,
  type NowPlaying,
  type ProviderNow,
} from "../player/title-player.ts";
import { call } from "./ipc.ts";
import { queries, updateSubscriptionPreferences } from "./queries.ts";

export {
  automaticVersion,
  clock,
  resumePoint,
  runtime,
  timeLeftOf,
  type ContinueEntry,
} from "@mrstreamer/core/viewing/continue";

/**
 * What the player shows for a movie, which plays the version `title` names; episodes have
 * `episodeNow` in the player.
 */
export function movieNow(title: Title, backdropUrl: string | null): ProviderNow {
  return {
    kind: "provider",
    title: { kind: "movie", ...ownedId(title) },
    name: title.title,
    detail: title.year ? String(title.year) : null,
    artworkUrl: backdropUrl ?? title.posterUrl,
    originalLanguage: title.originalLanguage,
  };
}

/** What the viewer left each saved subscription at, by its id: where picks are kept. */
export type Picks = ReadonlyMap<string, SubscriptionPreferences>;

/**
 * The version the viewer picked for `title`, while its provider still lists it; null plays the
 * one that suits best. A pick is kept by the subscription of the version picked, by kind and TMDB
 * id: only titles with an id gather several versions.
 */
export function pickedVersion(title: Title, picks: Picks | undefined): OwnedId | null {
  if (!title.tmdbId || !picks) return null;
  const key = `${title.kind}:${title.tmdbId}`;
  const picked = title.versions.find(
    ({ subscriptionId, id }) => picks.get(subscriptionId)?.titleVersions?.[key] === id,
  );
  return picked ? ownedId(picked) : null;
}

/** The picks the page holds for the subscriptions that list `title`, without asking for any. */
function heldPicks(client: QueryClient, title: Title): Picks {
  const held = new Map<string, SubscriptionPreferences>();
  for (const { subscriptionId } of title.versions) {
    const left = client.getQueryData(queries.subscriptionPreferences(subscriptionId).queryKey);
    if (left) held.set(subscriptionId, left);
  }
  return held;
}

/**
 * Remembers the version to play for `title`, or forgets the pick for null. The pick goes among
 * those of the version's own subscription, and out of every other that lists the title, so one
 * version is picked at most.
 */
export function usePickVersion(): (title: Title, version: OwnedId | null) => void {
  const client = useQueryClient();
  return (title, version) => {
    if (!title.tmdbId) return;
    const key = `${title.kind}:${title.tmdbId}`;
    for (const subscriptionId of new Set(title.versions.map((each) => each.subscriptionId))) {
      const picks = queries.subscriptionPreferences(subscriptionId);
      // The picks as saved, so one never replaces the others.
      void client
        .ensureQueryData(picks)
        .then(async (previous) => {
          const { [key]: old, ...others } = previous.titleVersions ?? {};
          const mine = version?.subscriptionId === subscriptionId ? version.id : undefined;
          if (old === mine) return;
          const titleVersions = mine === undefined ? others : { ...others, [key]: mine };
          client.setQueryData(picks.queryKey, { ...previous, titleVersions });
          await updateSubscriptionPreferences(client, subscriptionId, { titleVersions });
        })
        .catch(() => client.invalidateQueries({ queryKey: picks.queryKey }));
    }
  };
}

/** Plays a title over everything, from `from` seconds. */
export function playTitle(now: NowPlaying, from: number): void {
  useUi.setState({ playingTitle: true, searchOpen: false, settings: null });
  void titlePlayer.open(now, from);
}

/**
 * Takes a movie or series out of Continue watching, every version of it played, and keeps how far
 * it got for a later Resume. The lists update once the main process has it; `error` says why the
 * last removal failed.
 */
export function useRemoveFromContinue() {
  return useMutation({
    mutationFn: (title: Title) => {
      const versions = title.versions.map(ownedId);
      return call("viewing.removeFromContinue", {
        commandId: crypto.randomUUID(),
        titles: title.kind === "movie" ? { movies: versions } : { series: versions },
      });
    },
  });
}

/**
 * Whether Continue watching holds a version of `title`, which Remove would take out: one played,
 * or a series an episode of which was marked, while its marks hold for the series the lists show.
 */
export function useInContinueWatching(title: Title): boolean {
  const viewing = useQuery(queries.viewing());
  const versions = new Set(title.versions.map(ownedKey));
  const played = (viewing.data?.continueWatching ?? []).some(({ title: played }) =>
    played.kind === "movie"
      ? title.kind === "movie" && versions.has(ownedKey(played))
      : title.kind === "series" && versions.has(ownedKey(seriesOf(played))),
  );
  const marked = (viewing.data?.marked ?? []).some(
    ({ series, kept, next }) =>
      title.kind === "series" &&
      next !== null &&
      versions.has(ownedKey(series)) &&
      seriesIdentity(series, title).keys.includes(kept),
  );
  return played || marked;
}

/**
 * Continue watching from the viewing record, at most `limit`: core's `continueEntries`, with the
 * titles from the lists, so showing the row asks the provider nothing.
 */
export function useContinueWatching(limit = CONTINUE_LIMIT): {
  readonly entries: readonly ContinueEntry[];
  readonly loading: boolean;
  readonly error: Error | null;
} {
  const viewing = useQuery(queries.viewing());
  // All the record offers: the limit applies to what is left to show.
  const items = viewing.data?.continueWatching ?? [];
  const marks = viewing.data?.marked ?? [];
  /** The version each entry played: the movie, or the episode's series. */
  const played = ({ title }: TitleProgress): OwnedId =>
    title.kind === "movie" ? ownedId(title) : seriesOf(title);
  const versions = (kind: "movie" | "episode") =>
    items.flatMap((item) => (item.title.kind === kind ? [played(item)] : []));
  const movies = useQuery(queries.titles("movie", versions("movie")));
  const series = useQuery(
    queries.titles("series", [...versions("episode"), ...marks.map((mark) => mark.series)]),
  );
  const byVersion = new Map(
    [...(movies.data ?? []), ...(series.data ?? [])].flatMap((title) =>
      title.versions.map((version) => [`${title.kind}:${ownedKey(version)}`, title] as const),
    ),
  );
  const loading =
    viewing.isPending ||
    (movies.isPending && movies.fetchStatus !== "idle") ||
    (series.isPending && series.fetchStatus !== "idle");
  const entries = continueEntries(
    { continueWatching: items, marked: marks },
    (kind, version) => byVersion.get(`${kind}:${ownedKey(version)}`),
    limit,
  );
  return { entries, loading, error: viewing.error };
}

/** Rises with every resume, so only the latest acts once its details arrive. */
let resuming = 0;

/**
 * Whether the viewer is where a resume started: the same account, page and overlays. A resume
 * that waited for a series' details gives way to anything done since, a new account above all.
 */
function stillThere(from: ReturnType<typeof useUi.getState>): boolean {
  const now = useUi.getState();
  return (
    now.account === from.account &&
    now.view === from.view &&
    now.watching === from.watching &&
    now.playingTitle === from.playingTitle &&
    now.details === from.details &&
    now.savedEntry === from.savedEntry &&
    now.settings === from.settings &&
    now.searchOpen === from.searchOpen
  );
}

/**
 * Plays a Continue watching entry: a movie at once, where it stopped; a series once its details
 * and how its episodes stand arrive, since only they say where it goes on, by the rules its
 * details go by (`continuation`). A series with nothing left to go on with opens its details
 * instead. Both resume in the subscription the entry was played or marked in: a version picked
 * since plays instead when it is that subscription's too, and never another's, whose file and
 * episodes are its own. A series that answers after the viewer moved on, or after the account
 * changed, does nothing.
 */
export function useResume(): (entry: ContinueEntry) => void {
  const client = useQueryClient();
  return ({ title, version, progress }) => {
    // A version picked since in the same subscription plays instead, from the same point.
    const pick = pickedVersion(title, heldPicks(client, title));
    const picked = pick?.subscriptionId === version.subscriptionId ? pick : null;
    if (progress) {
      playTitle(
        movieNow({ ...title, ...(picked ?? version) }, title.backdropUrl),
        resumePoint(progress),
      );
      return;
    }
    const series = picked ?? version;
    const mine = ++resuming;
    const from = useUi.getState();
    const wanted = () => mine === resuming && stillThere(from);
    const open = () => openDetails({ kind: "series", ...series });
    void Promise.all([
      client.fetchQuery(queries.details("series", series)),
      client.fetchQuery(queries.episodes(series)),
    ]).then(
      ([found, standing]) => {
        if (!wanted()) return;
        const goesOn =
          found.kind === "series" ? continuation(found, standing.progress, standing.marks) : null;
        if (found.kind !== "series" || !goesOn || goesOn.replay) return open();
        playTitle(episodeNow(found, goesOn.episode), resumePoint(goesOn.resume));
      },
      (error: unknown) => {
        // Cancelled when the account changed, or the details failed: open them only if still wanted.
        if (!isCancelledError(error) && wanted()) open();
      },
    );
  };
}
