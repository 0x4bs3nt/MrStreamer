// Continue watching and resuming as the screens show them, from the viewing record and the
// lists: one entry per film or series, the line under it, how far it got and where it starts
// again. Shared by the desktop's renderer and iOS, so both offer the same titles and words.
import { seriesOf, type Title } from "@mrstreamer/contracts/ondemand";
import { ownedId, sameOwned, type OwnedId } from "@mrstreamer/contracts/subscription";
import type { MarkedSeries, TitleProgress, Viewing } from "@mrstreamer/contracts/viewing";
import { t } from "../i18n.ts";
import { episodeLabel } from "../ondemand/names.ts";
import { seriesIdentity } from "./marks.ts";

/** "34 min left", "1 h left", "1 h 20 min left". */
export function minutesLeft(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("{minutes} min left", { minutes });
  return rest
    ? t("{hours} h {minutes} min left", { hours, minutes: rest })
    : t("{hours} h left", { hours });
}

/** "1 h 39 min", "45 min". */
export function runtime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return t("{minutes} min", { minutes });
  return rest ? t("{hours} h {minutes} min", { hours, minutes: rest }) : t("{hours} h", { hours });
}

/** "38 min left", or null when there's nothing to say. */
export function timeLeftOf(
  progress: Pick<TitleProgress, "position" | "duration" | "finished"> | undefined,
): string | null {
  if (!progress || progress.finished) return null;
  return minutesLeft(Math.max(1, Math.round((progress.duration - progress.position) / 60)));
}

/** "1:02:13" or "24:51": a position on a scrubber. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** Where a title starts: where it stopped, a few seconds back, or the beginning. */
export function resumePoint(progress: TitleProgress | undefined): number {
  if (!progress || progress.finished) return 0;
  return Math.max(0, progress.position - 5);
}

/**
 * The version that plays unless the viewer picked one: the one the title was opened on, when the
 * opener `asked` for it, as a 4K tile opens its 4K version, or when it is another than the one the
 * title shows first; else the one a movie stopped in partway, or a series was watched in last;
 * else the one that suits best.
 */
export function automaticVersion(
  title: Title,
  progress: readonly TitleProgress[],
  opened: OwnedId,
  asked = false,
): OwnedId {
  if (
    (asked || !sameOwned(opened, title)) &&
    title.versions.some((version) => sameOwned(version, opened))
  ) {
    return ownedId(opened);
  }
  const latest = progress.toSorted((a, b) => b.at - a.at)[0];
  if (latest?.title.kind === "episode") return seriesOf(latest.title);
  return ownedId(latest && !latest.finished && latest.position > 0 ? latest.title : title);
}

/** One Continue watching entry, ready to show and play. */
export interface ContinueEntry {
  readonly key: string;
  /** The movie, or the series. */
  readonly title: Title;
  /** The version that goes on: the movie played, or the series version played or marked in last. */
  readonly version: OwnedId;
  /**
   * How far a movie got. Null for a series, which goes on by its episodes once its details are
   * read (`continuation`).
   */
  readonly progress: TitleProgress | null;
  /** "38 min left", "S2 E3 · 12 min left", "Next episode", "S2 E5". */
  readonly line: string;
  /** How far, from 0 to 1; null for an episode that plays from its beginning. */
  readonly done: number | null;
  readonly artworkUrl: string | null;
}

/**
 * Continue watching from the viewing record, at most `limit`, with what each tile shows. The
 * titles come from the lists, so showing the row asks the provider nothing; titles the provider
 * no longer lists, and titles for adults, are left out. A finished episode offers the next one.
 *
 * A series an episode of which the viewer marked goes on where the record says it does, in the
 * subscription it was marked in: worked out there from how its episodes stand, so the tile needs
 * no details. A play of the series there begun after the mark takes over from it. One begun
 * before it doesn't, however late it saves how far it got, though what it watches moves the
 * series on: so a series with no numbered episode left to watch stays out while a play from
 * before the mark goes on. Marks the record keeps under what the lists no longer take the series
 * for are left out.
 */
export function continueEntries(
  viewing: Pick<Viewing, "continueWatching" | "marked">,
  titleOf: (kind: Title["kind"], version: OwnedId) => Title | undefined,
  limit: number,
): ContinueEntry[] {
  const items = viewing.continueWatching;
  const marks = viewing.marked;
  /** The version each entry played: the movie, or the episode's series. */
  const played = ({ title }: TitleProgress): OwnedId =>
    title.kind === "movie" ? ownedId(title) : seriesOf(title);
  /** A series' latest mark in each subscription, by the series and that subscription. */
  const marked = new Map<string, { readonly title: Title; readonly mark: MarkedSeries }>();
  for (const mark of marks) {
    const title = titleOf("series", mark.series);
    if (!title || title.adult) continue;
    // Marks kept under what the lists no longer take the series for say nothing of it now.
    if (!seriesIdentity(mark.series, title).keys.includes(mark.kept)) continue;
    const key = `${title.key}|${mark.series.subscriptionId}`;
    if ((marked.get(key)?.mark.at ?? -Infinity) < mark.at) marked.set(key, { title, mark });
  }
  /** Marks a play of their series, in their subscription, began after. */
  const replaced = new Set<string>();
  const shown = items.flatMap((progress): (ContinueEntry & { readonly at: number })[] => {
    const ref = progress.title;
    const version = played(progress);
    const title = titleOf(ref.kind === "movie" ? "movie" : "series", version);
    if (!title || title.adult) return [];
    // One entry per film or series, whichever of its versions was played, of whichever
    // subscription: the one played last stands for the rest, and is the one that resumes.
    const { key } = title;
    const artworkUrl = title.backdropUrl ?? title.posterUrl;
    const { at } = progress;
    if (ref.kind === "movie") {
      return [
        {
          key,
          title,
          version,
          progress,
          line: timeLeftOf(progress) ?? "",
          done: progress.position / progress.duration,
          artworkUrl,
          at,
        },
      ];
    }
    const own = `${key}|${ref.subscriptionId}`;
    const exactFiles = title.versions.find((each) => sameOwned(each, version))?.episodeFiles;
    const obsolete = exactFiles !== undefined && !exactFiles.includes(ref.id);
    const mark = marked.get(own)?.mark;
    if (mark) {
      if (progress.since <= mark.at) return [];
      replaced.add(own);
    }
    return [
      {
        key,
        title,
        version,
        progress: null,
        line:
          progress.finished || obsolete
            ? t("Next episode")
            : `${episodeLabel(ref.season, ref.episode)} · ${timeLeftOf(progress) ?? ""}`,
        done: progress.finished || obsolete ? null : progress.position / progress.duration,
        artworkUrl,
        at,
      },
    ];
  });
  for (const [own, { title, mark }] of marked) {
    const { next } = mark;
    if (!next || replaced.has(own)) continue;
    const left = next.resume && timeLeftOf({ ...next.resume, finished: false });
    shown.push({
      key: title.key,
      title,
      version: mark.series,
      progress: null,
      line: [episodeLabel(next.season, next.episode), left].filter(Boolean).join(" · "),
      done: next.resume ? next.resume.position / next.resume.duration : null,
      artworkUrl: title.backdropUrl ?? title.posterUrl,
      at: mark.at,
    });
  }
  // Most recent first, so the version played or marked last stands for the rest.
  const entries = new Map<string, ContinueEntry>();
  for (const { at: _at, ...entry } of shown.toSorted((a, b) => b.at - a.at)) {
    if (!entries.has(entry.key)) entries.set(entry.key, entry);
  }
  return [...entries.values()].slice(0, limit);
}
