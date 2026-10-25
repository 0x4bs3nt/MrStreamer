import * as Effect from "effect/Effect";
import type { HandlersFor } from "../ipc.ts";
import type { Reminders } from "../services/reminders.ts";

export function reminderHandlers({
  reminders,
}: {
  readonly reminders: Pick<Reminders["Service"], "list" | "set" | "cancel" | "dismiss">;
}): HandlersFor<"reminders"> {
  return {
    "reminders.list": () => reminders.list,
    "reminders.set": ({ channel, start }) => reminders.set(channel, start),
    "reminders.cancel": ({ id }) => Effect.as(reminders.cancel(id), null),
    "reminders.dismiss": ({ id }) => Effect.as(reminders.dismiss(id), null),
  };
}
