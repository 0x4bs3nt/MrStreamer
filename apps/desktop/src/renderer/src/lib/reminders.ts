// Programme reminders as the window reads and changes them. The main process keeps them, tells
// when they told or changed (`reminders.changed`), and decides which notices show; the list is
// read again then, and when the preferences change, which say whether reminders of channels for
// adults show. A programme finds its reminder by its channel, by any of its streams, and its start.
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import { useRef } from "react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import type { Reminder, ReminderList } from "@mrstreamer/contracts/reminders";
import { ownedId } from "@mrstreamer/contracts/subscription";
import { t } from "@mrstreamer/core/i18n";
import { appError, describeError } from "./errors.ts";
import { call, listen } from "./ipc.ts";

export const remindersQuery = () =>
  queryOptions({
    queryKey: ["reminders"],
    queryFn: () => call("reminders.list"),
    staleTime: Infinity,
  });

/**
 * Reads the list again once the main process says it changed, or the preferences did. A read
 * still under way asked before the change, so it is dropped first.
 */
export function syncReminders(client: QueryClient): () => void {
  const { queryKey } = remindersQuery();
  const read = () =>
    void client.cancelQueries({ queryKey }).then(() => client.invalidateQueries({ queryKey }));
  const stopChanges = listen("reminders.changed", read);
  const stopPreferences = listen("preferences.changed", read);
  return () => {
    stopChanges();
    stopPreferences();
  };
}

export function useReminders() {
  return useQuery(remindersQuery());
}

const indexes = new WeakMap<ReminderList, Map<string, Reminder>>();

/** The reminder in `list` of `channel`'s programme at `start`, by any of the channel's streams. */
export function reminderAt(
  list: ReminderList | undefined,
  channel: Pick<LiveChannel, "subscriptionId" | "id" | "variants">,
  start: number,
): Reminder | undefined {
  if (!list) return undefined;
  let index = indexes.get(list);
  if (!index) {
    index = new Map();
    for (const reminder of list.reminders)
      for (const stream of reminder.streams)
        index.set(`${reminder.channel.subscriptionId}\n${stream}\n${reminder.start}`, reminder);
    indexes.set(list, index);
  }
  const of = (id: string) => index.get(`${channel.subscriptionId}\n${id}\n${start}`);
  return of(channel.id) ?? channel.variants.map((variant) => of(variant.id)).find(Boolean);
}

/** A programme's Remind me: whether one is set, and the press that sets or cancels it. */
export interface ReminderToggle {
  /** The list was read, or couldn't be, so the press does what the button says. */
  readonly ready: boolean;
  readonly set: boolean;
  readonly busy: boolean;
  /** Why the last press changed nothing; pressing again tries the same once more. */
  readonly failure: string | null;
  toggle(): void;
}

/**
 * Remind me for `channel`'s programme at `start`. Give each programme its own, by key: what is
 * under way, and a failure, belong to the programme it was pressed for. A press counts as done
 * once the list says so, so the button never shows the state before.
 */
export function useReminderToggle(channel: LiveChannel, start: number): ReminderToggle {
  const client = useQueryClient();
  const list = useReminders();
  const reminder = reminderAt(list.data, channel, start);
  const underWay = useRef(false);
  const change = useMutation({
    mutationFn: async (current: Reminder | undefined) => {
      if (current) await call("reminders.cancel", { id: current.id });
      else await call("reminders.set", { channel: ownedId(channel), start });
      await client.invalidateQueries({ queryKey: remindersQuery().queryKey });
    },
    onSettled: () => {
      underWay.current = false;
    },
  });
  const error = change.isError ? appError(change.error) : null;
  return {
    ready: !list.isPending,
    set: reminder !== undefined,
    busy: change.isPending,
    failure:
      error === null
        ? null
        : error.kind === "reminder"
          ? describeError(error)
          : change.variables
            ? t("Couldn't remove. Try again.")
            : t("Couldn't save. Try again."),
    toggle: () => {
      if (underWay.current || change.isPending || list.isPending) return;
      underWay.current = true;
      change.mutate(reminder);
    },
  };
}
