// Programme reminders. The viewer sets one on a programme still to come, from its details in the
// guide grid, a list's schedule or Search, and the app tells when it starts, while it runs: a
// notice in the window and one from the system. It never wakes or starts the computer for one,
// and never tunes: the window's Watch plays the channel the way every channel plays.
//
// This service is the one owner of reminders. It keeps them in reminders.json
// (../platform/reminders-file.ts), checks them against the provider's lists, the guide and the
// clock (@mrstreamer/core/reminders/rules), shows and closes their system notices, and says which
// of them the window shows its own notice for. Every change takes one turn at a time: a reminder
// set or cancelled, a check, a subscription that went, a notice clicked or dismissed. What is
// kept changes on disk first: a write that fails changes nothing and tells nothing, and the same
// call can be made again. Told is written before anything shows, so a crash loses a notice rather
// than showing one twice. Reminders of a subscription that isn't saved, as one a release before
// removed, are dropped as the file is read, before any shows.
//
// A loop checks them: at the next start, or the end of a programme that told, at most a minute
// apart, so a clock that was set, or slept, catches up; once the guide has changed and settled;
// once a catalogue has changed; and when the app asks, as the computer wakes or is unlocked. A
// reminder of a channel for adults, also one the provider files for adults after it told, shows
// only while Settings shows titles for adults, and never keeps a system notice. A system
// notice carries the programme's title and its channel, nothing else; what a locked screen shows
// of it is the system's setting.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Reminder, ReminderList } from "@mrstreamer/contracts/reminders";
import type { OwnedId } from "@mrstreamer/contracts/subscription";
import { Failed } from "@mrstreamer/core/failure";
import { Guide } from "@mrstreamer/core/guide/service";
import { t } from "@mrstreamer/core/i18n";
import {
  atTime,
  expired,
  lateMinutes,
  nextAt,
  relisted,
  sameReminder,
  seen,
  statusOf,
  visible,
  type FoundChannel,
  type KeptReminder,
} from "@mrstreamer/core/reminders/rules";
import { runtime as duration } from "@mrstreamer/core/viewing/continue";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { readReminders, writeReminders, type RemindersFile } from "../platform/reminders-file.ts";
import { Library } from "./library.ts";
import { Settings } from "./preferences.ts";
import { Subscriptions } from "./subscription.ts";

/**
 * The longest one check waits for the next while any reminder is kept: a clock that was set, or
 * slept, catches up within it. With none kept, nothing comes due until one is set.
 */
const RESCAN_MS = 60_000;
/** How long the guide stays still before its change is checked: a download tells each step. */
const GUIDE_SETTLE = "2 seconds";

/** A system notification: the programme's title, and its channel with when it started. */
interface Notice {
  /** The reminder's id: one notice per reminder. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
}

/** What the system says of a notice it was asked to show. */
interface NoticeEvents {
  /** It shows it. */
  shown(): void;
  /** The viewer clicked it, which brought the window forward. */
  clicked(): void;
  /** It couldn't show it. */
  failed(): void;
}

/** The system's notifications, as the app shows them. */
export interface Notifier {
  /** False where the system shows no notifications from the app. */
  readonly supported: boolean;
  /** Shows `notice`, in place of one shown for the same reminder. */
  show(notice: Notice, events: NoticeEvents): void;
  /** Takes down the notice of reminder `id`; none changes nothing. */
  close(id: string): void;
}

export interface RemindersDeps {
  readonly dataDir: string;
  /** The system's notifications. Without them, reminders tell in the window only. */
  readonly notifier: Notifier | null;
}

export class Reminders extends Context.Service<
  Reminders,
  {
    /**
     * Every reminder of a saved subscription the window may show, in start order, with how each
     * stands. Fails with `reminder` while reminders.json can't be read or a newer release wrote
     * it; each call reads it again.
     */
    readonly list: Effect.Effect<ReminderList, Failed>;
    /**
     * Sets a reminder for the programme the guide lists on `channel` at `start`, a time still to
     * come, and answers it as stored. One already set for that channel at that start answers as
     * it is. Fails with `reminder`: `started`, or `not-in-guide` while the guide lists nothing
     * then on that channel or the channel doesn't show; and as `list` does.
     */
    set(channel: OwnedId, start: number): Effect.Effect<Reminder, Failed>;
    /** Takes a reminder out and closes its notices. One that is gone changes nothing. */
    cancel(id: string): Effect.Effect<void, Failed>;
    /** Takes the window's notice of a reminder down for this run. */
    dismiss(id: string): Effect.Effect<void>;
    /** Checks every reminder now, as when the computer wakes or the clock may have moved. */
    readonly check: Effect.Effect<void>;
    /**
     * A subscription went: its reminders go too, with their notices, whether or not the file
     * could be written. What a failed write leaves on disk goes as the next start reads it.
     */
    subscriptionGone(subscriptionId: string): Effect.Effect<void>;
    /** Emits after every change of what `list` answers, but for the clock's passing alone. */
    readonly changes: Stream.Stream<void>;
  }
>()("mrstreamer/Reminders") {
  static readonly layer = (deps: RemindersDeps) => Layer.effect(Reminders, make(deps));
}

/** What the system said of a notice, handled in its turn. */
type NoticeEvent = { readonly kind: keyof NoticeEvents; readonly id: string };

function make(deps: RemindersDeps) {
  return Effect.gen(function* () {
    const subscriptions = yield* Subscriptions;
    const library = yield* Library;
    const guide = yield* Guide;
    const settings = yield* Settings;
    const { notifier } = deps;
    const path = join(deps.dataDir, "reminders.json");
    const turn = (yield* Semaphore.make(1)).withPermits(1);
    const updates = yield* PubSub.unbounded<void>();
    const wakes = yield* Queue.sliding<void>(1);
    const events = yield* Queue.unbounded<NoticeEvent>();

    /** reminders.json as last read or written; refused while it can't be used. */
    let store: { readonly kind: "unread" } | Awaited<ReturnType<typeof readReminders>> = {
      kind: "unread",
    };
    /** Whether the file's refusal was logged, once a run. */
    let warned = false;
    /** The reminders that told this run, and whether the window shows its notice of each. */
    const banners = new Map<string, boolean>();
    /** The reminders whose system notice is up. */
    const notices = new Set<string>();
    /** The system said it couldn't show the last notice. */
    let failedNotice = false;
    /** Something `list` answers changed in this turn. */
    let dirty = false;

    const publish = Effect.suspend(() => {
      if (!dirty) return Effect.void;
      dirty = false;
      return Effect.asVoid(PubSub.publish(updates, undefined));
    });
    const wake = Effect.asVoid(Queue.offer(wakes, undefined));

    const savedIds = Effect.map(
      subscriptions.saved,
      (saved) => new Set(saved.map((each) => each.id)),
    );
    const adultsShown = Effect.map(settings.get, (preferences) => preferences.adultTitles ?? false);

    /** Writes `file` whole, or fails changing nothing. Once begun, it finishes. */
    const save = (file: RemindersFile) =>
      Effect.tryPromise({
        try: () => writeReminders(path, file),
        catch: () =>
          new Failed({ error: { kind: "unexpected", detail: "Couldn't save the reminders." } }),
      }).pipe(Effect.uninterruptible);

    /**
     * What reminders.json holds, read once it can be, or null while it can't be used. Reminders
     * of subscriptions that aren't saved, and those past keeping, go as it is read: from memory at
     * once, and from the file with them. A file that couldn't be used before, and can now, wakes
     * the loop, which waits for a wake once its check found nothing to schedule. The first read
     * needs none: the loop's first check comes after it, or makes it. Only runs in a turn.
     */
    const loaded = Effect.gen(function* () {
      if (store.kind === "read") return store.file;
      const recovered = store.kind === "refused";
      const read = yield* Effect.promise(() => readReminders(path));
      if (read.kind === "refused") {
        if (!warned) yield* Effect.logWarning(`[reminders] reminders.json is ${read.reason}`);
        warned = true;
        store = read;
        return null;
      }
      const saved = yield* savedIds;
      const now = yield* Clock.currentTimeMillis;
      const file: RemindersFile = {
        reminders: read.file.reminders.filter(
          (each) => saved.has(each.subscriptionId) && !expired(each, now),
        ),
        unread: new Map([...read.file.unread].filter(([id]) => saved.has(id))),
      };
      store = { kind: "read", file };
      if (
        file.reminders.length !== read.file.reminders.length ||
        file.unread.size !== read.file.unread.size
      )
        yield* save(file).pipe(
          Effect.catchTag("Failed", () =>
            Effect.logWarning("[reminders] couldn't drop reminders that went"),
          ),
        );
      if (recovered) yield* wake;
      return file;
    });

    /** `loaded`, or the reason it can't be used as the failure. */
    const usable = Effect.flatMap(loaded, (file) =>
      file
        ? Effect.succeed(file)
        : Effect.fail(
            new Failed({
              error: {
                kind: "reminder",
                reason: store.kind === "refused" ? store.reason : "unreadable",
              },
            }),
          ),
    );

    const commit = (file: RemindersFile) => {
      store = { kind: "read", file };
      dirty = true;
    };

    /** Takes a reminder's system notice down. */
    const closeNotice = (id: string) => {
      if (!notices.delete(id)) return;
      notifier?.close(id);
      dirty = true;
    };

    /** Takes a reminder's notices down: the system's, and the window's. */
    const quiet = (id: string) => {
      if (banners.delete(id)) dirty = true;
      closeNotice(id);
    };

    /** Tells of `reminder`, told at `now`: in the window, and from the system unless for adults. */
    const tell = (reminder: KeptReminder, now: number) => {
      banners.set(reminder.id, true);
      dirty = true;
      if (reminder.adult || !notifier?.supported) return;
      const late = lateMinutes(reminder.start, now);
      const channel = reminder.channelName;
      const { id } = reminder;
      notices.add(id);
      try {
        notifier.show(
          {
            id,
            title: reminder.title,
            body:
              late === 0
                ? t("{channel} · now", { channel })
                : t("{channel} · started {time} ago", { channel, time: duration(late * 60) }),
          },
          {
            shown: () => Queue.offerUnsafe(events, { kind: "shown", id }),
            clicked: () => Queue.offerUnsafe(events, { kind: "clicked", id }),
            failed: () => Queue.offerUnsafe(events, { kind: "failed", id }),
          },
        );
      } catch {
        // As the system saying it couldn't: the window's notice shows regardless.
        notices.delete(id);
        failedNotice = true;
      }
    };

    const shownAs = (reminder: KeptReminder, now: number): Reminder => ({
      id: reminder.id,
      channel: { subscriptionId: reminder.subscriptionId, id: reminder.channel },
      streams: reminder.streams,
      channelName: reminder.channelName,
      start: reminder.start,
      stop: reminder.stop,
      title: reminder.title,
      status: statusOf(reminder),
      banner:
        reminder.state.kind === "told" && now < reminder.stop && banners.get(reminder.id) === true,
    });

    /** A channel of the lists as a reminder knows it. */
    const foundAs = (channel: LiveChannel): FoundChannel => ({
      id: channel.id,
      streams: [...new Set([channel.id, ...channel.variants.map((variant) => variant.id)])],
      name: channel.title,
      adult: channel.adult === true,
    });

    /** Whether a subscription has a catalogue at all, so a channel not in it is no longer listed. */
    const catalogued = (subscriptionId: string) =>
      Effect.map(library.status, (statuses) =>
        statuses.some((each) => each.subscriptionId === subscriptionId && each.fetchedAt !== null),
      );

    /**
     * `reminder`'s channel as the lists show it now, found by any of its streams, or undefined
     * where they show none. `finders` keeps each subscription's lookup for one check.
     */
    const channelNow = (
      reminder: KeptReminder,
      finders: Map<string, (channelId: string) => LiveChannel | undefined>,
    ) =>
      Effect.gen(function* () {
        const { subscriptionId } = reminder;
        let find = finders.get(subscriptionId);
        if (!find) {
          find = yield* library.lookup(subscriptionId);
          finders.set(subscriptionId, find);
        }
        const listed = reminder.streams.map(find).find((each) => each !== undefined);
        return listed && foundAs(listed);
      });

    /**
     * `reminder`, still to tell, as the guide stands now on `channel`, its channel as the lists
     * show it now. One for adults while they are hidden learns nothing of its programme.
     */
    const reread = (reminder: KeptReminder, channel: FoundChannel | undefined, adults: boolean) =>
      Effect.gen(function* () {
        const { subscriptionId } = reminder;
        if (!channel)
          return seen(reminder, (yield* catalogued(subscriptionId)) ? null : undefined, undefined);
        if (!visible(channel, adults)) return seen(reminder, channel, undefined);
        const answer = yield* guide.startingAt({ subscriptionId, id: channel.id }, reminder.start);
        return seen(
          reminder,
          channel,
          answer.kind === "found" ? answer.programme : answer.kind === "none" ? null : undefined,
        );
      });

    /**
     * Brings every reminder up to date at the time now, writes what changed, then tells those
     * that came due and takes down notices whose programme ended or whose channel may no longer
     * show them. A write that fails tells nothing: the next check tries again. Answers when the
     * next check is due, or null while no reminder is kept and none needs one. Only runs in a
     * turn.
     */
    const checkNow = Effect.gen(function* () {
      const file = yield* loaded;
      if (!file) return null;
      const now = yield* Clock.currentTimeMillis;
      const saved = yield* savedIds;
      const adults = yield* adultsShown;
      // What went, and what is past keeping, goes whether or not the file can be written.
      const kept = file.reminders.filter(
        (each) => saved.has(each.subscriptionId) && !expired(each, now),
      );
      const unread = new Map([...file.unread].filter(([id]) => saved.has(id)));
      const finders = new Map<string, (channelId: string) => LiveChannel | undefined>();
      // Every reminder kept follows its channel, told or not; only those still to tell follow
      // the guide and the clock, so one that told never tells again.
      const known: KeptReminder[] = [];
      const next: KeptReminder[] = [];
      const due: KeptReminder[] = [];
      for (const each of kept) {
        const channel = yield* channelNow(each, finders);
        const listed = channel ? relisted(each, channel) : each;
        known.push(listed);
        const current =
          each.state.kind === "pending" || each.state.kind === "gone"
            ? yield* reread(listed, channel, adults)
            : listed;
        const { reminder, tells } = atTime(current, now, visible(current, adults));
        next.push(reminder);
        if (tells) due.push(reminder);
      }
      const differs = (reminders: readonly KeptReminder[]) =>
        reminders.length !== file.reminders.length ||
        unread.size !== file.unread.size ||
        reminders.some((each, at) => !isDeepStrictEqual(each, file.reminders[at]));
      if (differs(next)) {
        const changed = { reminders: next, unread };
        const written = yield* Effect.result(save(changed));
        if (written._tag === "Success") {
          commit(changed);
          for (const reminder of due) tell(reminder, now);
        } else {
          // What went goes, and what the lists say of each channel holds, written or not: one
          // filed for adults hides now. How each stands waits for a write.
          if (differs(known)) commit({ reminders: known, unread });
          yield* Effect.logWarning("[reminders] couldn't save a check; it is tried again");
        }
      }
      const current = store.kind === "read" ? store.file.reminders : [];
      const byId = new Map(current.map((each) => [each.id, each]));
      // A notice goes with its programme and its subscription. A channel for adults keeps no
      // system notice, even while adults show, and the window's goes while they're hidden.
      for (const id of notices) {
        const reminder = byId.get(id);
        if (!reminder || now >= reminder.stop || reminder.adult) closeNotice(id);
      }
      for (const id of banners.keys()) {
        const reminder = byId.get(id);
        if (!reminder || now >= reminder.stop || !visible(reminder, adults)) quiet(id);
      }
      return current.length === 0
        ? null
        : Math.min(nextAt(current, now) ?? Infinity, now + RESCAN_MS);
    });

    /**
     * A notice clicked: the window is forward, and shows its notice again while it holds, by its
     * channel as the lists show it now, which a check may not have caught up with yet.
     */
    const reopen = (id: string) =>
      Effect.gen(function* () {
        if (notices.delete(id)) notifier?.close(id);
        if (store.kind !== "read") return;
        const kept = store.file.reminders.find((each) => each.id === id);
        if (kept?.state.kind !== "told") return;
        const channel = yield* channelNow(kept, new Map());
        const reminder = channel ? relisted(kept, channel) : kept;
        const now = yield* Clock.currentTimeMillis;
        if (
          now < reminder.stop &&
          (yield* savedIds).has(reminder.subscriptionId) &&
          visible(reminder, yield* adultsShown)
        ) {
          banners.set(id, true);
          dirty = true;
        }
      });

    // Every notice there is goes as the app quits: none can bring a window back with nothing
    // behind it. Added before the loops below, so it runs once they have stopped.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const id of notices) notifier?.close(id);
        notices.clear();
      }),
    );

    // One check after another: at the next due moment, at most a minute apart while any reminder
    // is kept, or at a wake.
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        for (;;) {
          const next = yield* turn(Effect.tap(checkNow, () => publish)).pipe(
            Effect.catchDefect((defect) =>
              Effect.as(Effect.logWarning("[reminders] checking failed", defect), null),
            ),
          );
          const now = yield* Clock.currentTimeMillis;
          yield* next === null
            ? Queue.take(wakes)
            : Effect.raceFirst(Effect.sleep(Math.max(0, next - now)), Queue.take(wakes));
        }
      }),
    );
    // A guide that changed may list another programme at a reminder's start, or none, and a
    // catalogue that changed may list a reminder's channel anew, or file it for adults.
    yield* Effect.forkScoped(
      Stream.runForEach(guide.changes.pipe(Stream.debounce(GUIDE_SETTLE)), () => wake),
    );
    yield* Effect.forkScoped(Stream.runForEach(library.changes, () => wake));
    // What the system says of its notices.
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.flatMap(Queue.take(events), (event) =>
          turn(
            Effect.gen(function* () {
              if (event.kind === "clicked") yield* reopen(event.id);
              else if (event.kind === "failed") {
                notices.delete(event.id);
                dirty ||= !failedNotice;
                failedNotice = true;
              } else {
                dirty ||= failedNotice;
                failedNotice = false;
              }
              yield* publish;
            }),
          ),
        ),
      ),
    );

    return {
      list: turn(
        Effect.gen(function* () {
          const file = yield* usable;
          const now = yield* Clock.currentTimeMillis;
          const saved = yield* savedIds;
          const adults = yield* adultsShown;
          // Hiding adults takes their notices down for good: showing them again brings none back.
          // They never had a system notice, and the window no longer lists them.
          for (const reminder of file.reminders)
            if (!visible(reminder, adults)) banners.delete(reminder.id);
          return {
            reminders: file.reminders
              .filter(
                (each) =>
                  saved.has(each.subscriptionId) && visible(each, adults) && !expired(each, now),
              )
              .toSorted((a, b) => a.start - b.start || a.channelName.localeCompare(b.channelName))
              .map((each) => shownAs(each, now)),
            notifications: !notifier?.supported ? "unsupported" : failedNotice ? "failed" : null,
          } satisfies ReminderList;
        }),
      ),

      set: (channel: OwnedId, start: number) =>
        turn(
          Effect.gen(function* () {
            const file = yield* usable;
            const { subscriptionId } = channel;
            if (!(yield* savedIds).has(subscriptionId))
              return yield* new Failed({ error: { kind: "no-subscription" } });
            const listed = (yield* library.lookup(subscriptionId))(channel.id);
            if (!listed)
              return yield* new Failed({
                error: { kind: "channel-not-found", channelId: channel.id },
              });
            const found = foundAs(listed);
            const now = yield* Clock.currentTimeMillis;
            const refused = (reason: "started" | "not-in-guide") =>
              new Failed({ error: { kind: "reminder", reason } });
            if (start <= now) return yield* refused("started");
            if (!visible(found, yield* adultsShown)) return yield* refused("not-in-guide");
            const answer = yield* guide.startingAt({ subscriptionId, id: found.id }, start);
            if (answer.kind !== "found") return yield* refused("not-in-guide");
            const { programme } = answer;
            const before = file.reminders.find((each) =>
              sameReminder(each, { subscriptionId, streams: found.streams, start }),
            );
            const reminder: KeptReminder = before
              ? seen(before, found, programme)
              : {
                  id: randomUUID(),
                  subscriptionId,
                  channel: found.id,
                  streams: found.streams,
                  channelName: found.name,
                  adult: found.adult,
                  start,
                  stop: programme.stop,
                  set: programme.title,
                  title: programme.title,
                  state: { kind: "pending" },
                };
            if (!isDeepStrictEqual(reminder, before)) {
              const next = {
                ...file,
                reminders: before
                  ? file.reminders.map((each) => (each === before ? reminder : each))
                  : [...file.reminders, reminder],
              };
              yield* save(next);
              commit(next);
              yield* publish;
              yield* wake;
            }
            return shownAs(reminder, now);
          }),
        ),

      cancel: (id: string) =>
        turn(
          Effect.gen(function* () {
            const file = yield* usable;
            if (!file.reminders.some((each) => each.id === id)) return;
            const next = { ...file, reminders: file.reminders.filter((each) => each.id !== id) };
            yield* save(next);
            commit(next);
            quiet(id);
            yield* publish;
          }),
        ),

      dismiss: (id: string) =>
        turn(
          Effect.gen(function* () {
            if (banners.get(id) !== true) return;
            banners.set(id, false);
            dirty = true;
            yield* publish;
          }),
        ),

      check: Effect.andThen(
        turn(Effect.tap(checkNow, () => publish)),
        // The loop's next wait counts from here.
        wake,
      ),

      subscriptionGone: (subscriptionId: string) =>
        turn(
          Effect.gen(function* () {
            if (store.kind !== "read") return;
            const { file } = store;
            const going = file.reminders.filter((each) => each.subscriptionId === subscriptionId);
            if (going.length === 0 && !file.unread.has(subscriptionId)) return;
            const next = {
              reminders: file.reminders.filter((each) => each.subscriptionId !== subscriptionId),
              unread: new Map([...file.unread].filter(([id]) => id !== subscriptionId)),
            };
            commit(next);
            for (const reminder of going) quiet(reminder.id);
            yield* save(next).pipe(
              Effect.catchTag("Failed", () =>
                Effect.logWarning("[reminders] couldn't save a subscription's going"),
              ),
            );
            yield* publish;
          }),
        ),

      changes: Stream.fromPubSub(updates),
    };
  });
}
