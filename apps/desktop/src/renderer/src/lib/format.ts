import type { Programme } from "@mrstreamer/contracts/guide";
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { ownedKey } from "@mrstreamer/contracts/subscription";
import { formatDate, t } from "@mrstreamer/core/i18n";
import { minutesLeft } from "@mrstreamer/core/viewing/continue";
import type { StreamInfo } from "../player/engine.ts";

/**
 * A channel's first category that `categories` has, which hold them by `ownedKey`: a channel's
 * categories are its own subscription's.
 */
function firstCategory(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): Category | undefined {
  const { subscriptionId } = channel;
  return channel.categoryIds
    .map((id) => categories.get(ownedKey({ subscriptionId, id })))
    .find(Boolean);
}

/** "818 · Vlaanderen": the channel number and its first category. */
export function channelLine(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  const category = firstCategory(channel, categories);
  return [channel.number, category?.title].filter((part) => part != null).join(" · ");
}

/** The first category's name, for a channel without a programme to show. */
export function categoryOf(
  channel: LiveChannel,
  categories: ReadonlyMap<string, Category>,
): string {
  return firstCategory(channel, categories)?.title ?? "";
}

/** A server's host, without its scheme: "tv.example.net:8080". */
export function hostOf(server: string): string {
  return URL.parse(server)?.host || server;
}

/** "1080p · 50 fps · Stereo" from whatever the engine knows. */
export function techLine(info: StreamInfo | null): string {
  if (!info) return "";
  const parts: string[] = [];
  if (info.height) parts.push(`${info.height}p`);
  if (info.fps) parts.push(`${Math.round(info.fps)} fps`);
  if (info.audioChannels) {
    parts.push(
      info.audioChannels === 1
        ? t("Mono")
        : info.audioChannels === 2
          ? t("Stereo")
          : t("{channels} ch", { channels: info.audioChannels }),
    );
  }
  return parts.join(" · ");
}

/** "21:00", or "Tomorrow 06:00" when it's after today. */
export function clockTime(at: number, now: number): string {
  const dayOf = (moment: number) => new Date(moment).setHours(0, 0, 0, 0);
  const time = formatDate(at, "time");
  return dayOf(at) > dayOf(now) ? t("Tomorrow {time}", { time }) : time;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How many days `at` is after today, by the calendar: -1 for any time yesterday. */
function daysFrom(now: number, at: number): number {
  const dayOf = (moment: number) => new Date(moment).setHours(0, 0, 0, 0);
  return Math.round((dayOf(at) - dayOf(now)) / DAY_MS);
}

/** "2 Oct" */
function shortDay(at: number): string {
  return formatDate(at, "day");
}

/** A time that has been: "14:02" earlier today, "yesterday 14:02", "2 Oct 14:02" before. */
export function pastTime(at: number, now: number): string {
  const days = daysFrom(now, at);
  const time = formatDate(at, "time");
  if (days >= 0) return time;
  return days === -1
    ? t("yesterday {time}", { time })
    : t("{day} {time}", { day: shortDay(at), time });
}

/** A time still to come: "today 23:00", "tomorrow 06:00", "Fri 23:00" this week, "12 Oct 23:00". */
export function comingTime(at: number, now: number): string {
  const days = daysFrom(now, at);
  const time = formatDate(at, "time");
  if (days <= 0) return t("today {time}", { time });
  if (days === 1) return t("tomorrow {time}", { time });
  return t("{day} {time}", { day: days < 7 ? formatDate(at, "weekday") : shortDay(at), time });
}

/** The midnight that ends the day of `at`. */
export function endOfDay(at: number): number {
  return new Date(at).setHours(24, 0, 0, 0);
}

/** "34 min left", "1 h 20 min left". */
export function timeLeft(programme: Pick<Programme, "start" | "stop">, now: number): string {
  return minutesLeft(Math.max(1, Math.ceil((programme.stop - now) / 60_000)));
}

/** How far a programme has run, from 0 to 1. */
export function progressOf(programme: Pick<Programme, "start" | "stop">, now: number): number {
  const length = programme.stop - programme.start;
  return length > 0 ? Math.min(1, Math.max(0, (now - programme.start) / length)) : 0;
}

export { minutesLeft };
