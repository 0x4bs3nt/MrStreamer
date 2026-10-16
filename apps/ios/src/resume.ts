import type { Title, TitleKind } from "@mrstreamer/contracts/ondemand";
import { ownedKey, type OwnedId } from "@mrstreamer/contracts/subscription";
import { CONTINUE_LIMIT } from "@mrstreamer/contracts/viewing";
import {
  continueEntries,
  resumePoint,
  type ContinueEntry,
} from "@mrstreamer/core/viewing/continue";
import { continuation } from "@mrstreamer/core/viewing/episodes";
import { router } from "expo-router";
import { useMemo } from "react";
import { playEpisode, playMovie } from "./play-title.ts";
import { request } from "./playback.ts";
import { detailsOf, titleOf, useMetadataVersion, useTitleLists } from "./titles.ts";
import { seriesViewing, useViewing } from "./viewing.ts";

// Continue watching as Home and For you show it, by core's `continueEntries`, and resuming an
// entry as the desktop does: a movie where it stopped, a series where its episodes say it goes on.

/** The details page of a title's version, in the Movies or Series tab, named by its `ownedKey`. */
export function detailsHref(kind: TitleKind, version: OwnedId) {
  const key = encodeURIComponent(ownedKey(version));
  return kind === "movie" ? (`/films/title/${key}` as const) : (`/series/title/${key}` as const);
}

/** The version a details page names, or null for a key that names none. */
export function versionOf(key: string): OwnedId | null {
  // A subscription's id holds no colon; a provider's id may.
  const at = key.indexOf(":");
  return at > 0 ? { subscriptionId: key.slice(0, at), id: key.slice(at + 1) } : null;
}

/** Opens a title's details in its tab, Movies or Series. */
export function openDetails(title: Pick<Title, "kind" | "subscriptionId" | "id">) {
  router.push(detailsHref(title.kind, title));
}

/** Continue watching, the latest first, of both kinds or one. */
export function useContinueWatching(kind?: TitleKind): readonly ContinueEntry[] {
  const viewing = useViewing();
  const lists = useTitleLists();
  const version = useMetadataVersion();
  return useMemo(() => {
    // Read again when TMDB's metadata renames titles.
    if (!viewing || lists.kind !== "ready" || version < 0) return [];
    const entries = continueEntries(
      viewing,
      (of, owned) => titleOf(lists.index, of, owned),
      CONTINUE_LIMIT,
    );
    return kind ? entries.filter((entry) => entry.title.kind === kind) : entries;
  }, [viewing, lists, version, kind]);
}

/**
 * Plays an entry: a movie at once, where it stopped; a series once its details and how its
 * episodes stand say where it goes on. A series with nothing to go on with, or whose details
 * can't be read, opens its details instead. Anything the viewer does meanwhile, playing,
 * stopping, removing a subscription or going to another screen, cancels the series' resume.
 */
export function resume({ title, version, progress }: ContinueEntry) {
  const opened = { ...title, ...version };
  const versions = () => openDetails(opened);
  if (progress) {
    playMovie(opened, version, resumePoint(progress), versions);
    return;
  }
  const asked = request();
  void Promise.all([detailsOf(opened), seriesViewing(version)]).then(
    ([found, standing]) => {
      if (!asked.stands()) return;
      const goesOn =
        found.kind === "series" ? continuation(found, standing.progress, standing.marks) : null;
      if (found.kind !== "series" || !goesOn || goesOn.replay) return versions();
      playEpisode(found, goesOn.episode, resumePoint(goesOn.resume), versions);
    },
    () => asked.stands() && versions(),
  );
}
