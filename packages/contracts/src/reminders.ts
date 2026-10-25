// Programme reminders as the window sees them. A reminder is one channel's programme at one start
// time, for one saved subscription, kept on this computer: the app tells while it runs, never
// wakes or starts the computer for it, and never tunes by itself. Times are epoch milliseconds,
// as the guide's.
import type { OwnedId } from "./subscription.ts";

/**
 * Where a reminder stands:
 *   - `upcoming`: the guide lists the programme it was set for at its start.
 *   - `changed`: another programme starts at that time now, `title`; it tells with that one.
 *     `was` is the title it was set for.
 *   - `gone`: no programme starts then on that channel now, or the provider no longer lists the
 *     channel. It doesn't tell while gone.
 *   - `told`: it told at `at`.
 *   - `missed`: its programme ended before the app could tell, as while the computer slept.
 */
export type ReminderStatus =
  | { readonly kind: "upcoming" }
  | { readonly kind: "changed"; readonly was: string }
  | { readonly kind: "gone" }
  | { readonly kind: "told"; readonly at: number }
  | { readonly kind: "missed" };

export interface Reminder {
  /** Names it for `reminders.cancel` and `reminders.dismiss`. */
  readonly id: string;
  /** Its channel, by the id the provider's lists gave it when last found. */
  readonly channel: OwnedId;
  /** Every stream id its channel had when set or last found: a channel with any of them is its. */
  readonly streams: readonly string[];
  readonly channelName: string;
  readonly start: number;
  readonly stop: number;
  /** The programme's title as the guide lists it at `start` now, or last did. */
  readonly title: string;
  readonly status: ReminderStatus;
  /** It told while the app ran, and the viewer hasn't dismissed it while it's on: the window shows its notice. */
  readonly banner: boolean;
}

export interface ReminderList {
  /** In start order. None for a channel for adults while Settings hides them. */
  readonly reminders: readonly Reminder[];
  /**
   * What the system did with this run's notifications: `failed` when it said it couldn't show
   * the last one, `unsupported` where it shows none from the app, null otherwise, also before
   * any. The window's own notice shows either way. No platform says whether the viewer turned
   * notifications off, so nothing here claims that.
   */
  readonly notifications: "failed" | "unsupported" | null;
}
