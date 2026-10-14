// Catch-up: programmes a provider keeps for some days after they aired, to play from their start.
// The provider says per stream how many days it keeps (Xtream's `tv_archive_duration`, a
// playlist's `catchup-days`). A stretch of the past plays from the archive when it has started and
// starts within those days; the streams of a channel that keep it are the ones tried.
import { AppFailure } from "@mrstreamer/contracts/errors";
import type { ChannelVariant, LiveChannel } from "@mrstreamer/contracts/library";
import type { ArchiveWindow } from "@mrstreamer/contracts/playback";

export const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a stream that keeps `days` of catch-up holds what started at `start`, at `now`: it has
 * started, and no longer ago than those days. Nothing for a stream that keeps none.
 */
export function archiveHolds(days: number | null | undefined, start: number, now: number): boolean {
  return !!days && start < now && start >= now - days * DAY_MS;
}

/**
 * The streams of `channel` whose archive holds `window` at `now`, in the channel's order. Fails
 * with `catch-up` when none does: `none` for a channel without catch-up, `outside` for a window
 * that starts before the days it keeps or hasn't started.
 */
export function archiveVariants(
  channel: Pick<LiveChannel, "variants" | "catchupDays">,
  window: ArchiveWindow,
  now: number,
): readonly ChannelVariant[] {
  if (window.end <= window.start) {
    throw new AppFailure({
      kind: "invalid-input",
      detail: "The archive window ends at its start.",
    });
  }
  if (channel.catchupDays === null) throw new AppFailure({ kind: "catch-up", reason: "none" });
  const kept = channel.variants.filter((variant) =>
    archiveHolds(variant.catchupDays, window.start, now),
  );
  if (kept.length > 0) return kept;
  throw new AppFailure({ kind: "catch-up", reason: "outside", days: channel.catchupDays });
}

/** A moment as a wall clock shows it: each part zero-padded, "2026", "10", "13", "14", "05", "00". */
export interface WallClock {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
  readonly second: string;
}

/**
 * `time` on the wall clock of `timeZone`, an IANA name such as "Europe/Amsterdam" as Xtream panels
 * report theirs. UTC without one, or for a name this system doesn't know.
 */
export function wallClock(time: number, timeZone: string | null): WallClock {
  let format: Intl.DateTimeFormat;
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  };
  try {
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone: timeZone ?? "UTC" });
  } catch {
    format = new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" });
  }
  const parts = Object.fromEntries(
    format.formatToParts(time).map((part) => [part.type, part.value]),
  );
  return {
    year: parts["year"] ?? "",
    month: parts["month"] ?? "",
    day: parts["day"] ?? "",
    hour: parts["hour"] ?? "",
    minute: parts["minute"] ?? "",
    second: parts["second"] ?? "",
  };
}
