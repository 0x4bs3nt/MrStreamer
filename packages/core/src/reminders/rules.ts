// The rules of a programme reminder, without files, clocks or Electron: what the provider's lists
// and the guide say of it now, when it tells, when it is missed, how long it is kept, and how the
// window sees it. The main process's Reminders service keeps reminders and asks these.
//
// A reminder is one channel's programme at one start time: the channel by any of its streams, the
// start in epoch milliseconds, so neither a time zone nor daylight saving moves it. Its title is
// only shown and compared, never used to find it: another programme at that start makes it
// changed, none makes it gone, and a programme of that title elsewhere is never followed.
import type { Programme } from "@mrstreamer/contracts/guide";
import type { ReminderStatus } from "@mrstreamer/contracts/reminders";

/** A reminder as the main process keeps it. */
export interface KeptReminder {
  readonly id: string;
  readonly subscriptionId: string;
  /** Its channel's id when last found: the lowest of the channel's streams' then. */
  readonly channel: string;
  /** Every stream id seen for the channel, those it had when last found first. */
  readonly streams: readonly string[];
  readonly channelName: string;
  /** Whether its channel was for adults when last found. */
  readonly adult: boolean;
  readonly start: number;
  readonly stop: number;
  /** The title it was set for. */
  readonly set: string;
  /** The title the guide lists at `start`, as last read. */
  readonly title: string;
  readonly state: KeptState;
}

/**
 * `pending` until its start, upcoming or changed by its title; `gone` while the guide lists
 * nothing at its start; `told` once it told; `missed` when its programme ended first.
 */
export type KeptState =
  | { readonly kind: "pending" }
  | { readonly kind: "gone" }
  | { readonly kind: "told"; readonly at: number }
  | { readonly kind: "missed" };

/** A reminder's channel as the provider's lists show it now. */
export interface FoundChannel {
  readonly id: string;
  /** Its streams' ids, its own first. */
  readonly streams: readonly string[];
  readonly name: string;
  readonly adult: boolean;
}

/** Whether `a` and `b` remind of one programme: of one subscription, a channel, at one start. */
export function sameReminder(
  a: Pick<KeptReminder, "subscriptionId" | "streams" | "start">,
  b: Pick<KeptReminder, "subscriptionId" | "streams" | "start">,
): boolean {
  return (
    a.subscriptionId === b.subscriptionId &&
    a.start === b.start &&
    a.streams.some((stream) => b.streams.includes(stream))
  );
}

/**
 * `reminder` with its channel as the lists show it now: its id, every stream seen for it, its
 * name, and whether it is for adults. Its programme and how it stands stay, also once it told or
 * was missed, so a channel the provider files for adults later hides that reminder too.
 */
export function relisted(reminder: KeptReminder, channel: FoundChannel): KeptReminder {
  return {
    ...reminder,
    channel: channel.id,
    streams: [...new Set([...channel.streams, ...reminder.streams])],
    channelName: channel.name,
    adult: channel.adult,
  };
}

/**
 * `reminder` as the lists and the guide stand now. `channel` is its channel as the lists show it,
 * null when they list none of its streams, undefined when that can't be told, as before a
 * catalogue is read. `programme` is what the guide lists on that channel at its start, null for
 * nothing, undefined when that can't be told, as before a guide is read: that changes nothing. A
 * reminder that told or was missed stays as it is: only `relisted` follows its channel.
 */
export function seen(
  reminder: KeptReminder,
  channel: FoundChannel | null | undefined,
  programme: Pick<Programme, "title" | "stop"> | null | undefined,
): KeptReminder {
  if (reminder.state.kind === "told" || reminder.state.kind === "missed") return reminder;
  const found = channel ? relisted(reminder, channel) : reminder;
  if (channel === null || programme === null) return { ...found, state: { kind: "gone" } };
  if (programme === undefined) return found;
  return { ...found, title: programme.title, stop: programme.stop, state: { kind: "pending" } };
}

/**
 * What `reminder` comes to at `now`, once its start has come: told while its programme is on and
 * `visible` lets it, missed once the programme has ended or while it may not show. One that went
 * stays gone, and tells nothing. `tells` is true for the one moment it tells.
 */
export function atTime(
  reminder: KeptReminder,
  now: number,
  visible: boolean,
): { readonly reminder: KeptReminder; readonly tells: boolean } {
  if (reminder.state.kind !== "pending" || now < reminder.start) return { reminder, tells: false };
  if (visible && now < reminder.stop)
    return { reminder: { ...reminder, state: { kind: "told", at: now } }, tells: true };
  return { reminder: { ...reminder, state: { kind: "missed" } }, tells: false };
}

/**
 * Whether `reminder` shows while `adults`, Settings' choice of titles for adults, is as it is: one
 * of a channel for adults shows, and tells, only while they show.
 */
export function visible(reminder: Pick<KeptReminder, "adult">, adults: boolean): boolean {
  return adults || !reminder.adult;
}

/**
 * When a reminder that told, was missed or went is no longer kept: the midnight that ends the day
 * its programme ends on, by this computer's clock and time zone. Until its start, it is kept.
 */
export function keptUntil(reminder: Pick<KeptReminder, "stop">): number {
  return new Date(reminder.stop).setHours(24, 0, 0, 0);
}

/** Whether `reminder` is past keeping at `now`. */
export function expired(reminder: KeptReminder, now: number): boolean {
  return reminder.state.kind !== "pending" && now >= keptUntil(reminder);
}

/** How late a reminder told at `at` was: whole minutes after its start, 0 when on time. */
export function lateMinutes(start: number, at: number): number {
  return Math.max(0, Math.floor((at - start) / 60_000));
}

/**
 * The next moment after `now` when something of `reminders` comes due: a start to tell at, the
 * end of a programme that told, whose notice goes then, or the midnight one stops being kept.
 * Null when nothing is to come.
 */
export function nextAt(reminders: readonly KeptReminder[], now: number): number | null {
  let next: number | null = null;
  const consider = (at: number) => {
    if (at > now && (next === null || at < next)) next = at;
  };
  for (const reminder of reminders) {
    if (reminder.state.kind === "pending") consider(reminder.start);
    else {
      if (reminder.state.kind === "told") consider(reminder.stop);
      consider(keptUntil(reminder));
    }
  }
  return next;
}

/** How the window sees where `reminder` stands. */
export function statusOf(reminder: KeptReminder): ReminderStatus {
  switch (reminder.state.kind) {
    case "pending":
      return reminder.title === reminder.set
        ? { kind: "upcoming" }
        : { kind: "changed", was: reminder.set };
    case "gone":
      return { kind: "gone" };
    case "told":
      return { kind: "told", at: reminder.state.at };
    case "missed":
      return { kind: "missed" };
  }
}
