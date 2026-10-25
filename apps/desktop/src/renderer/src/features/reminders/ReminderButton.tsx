// Remind me, in a future programme's details: the guide grid's, a list's schedule line and a
// programme in Search. It reads Reminder set once one is, and a second press cancels it. A press
// that couldn't be saved leaves the button as it was and says so beside it; pressing again tries
// the same once more. Give each programme its own, by key, so nothing of one carries to another.
import { Bell, Check } from "lucide-react";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { useReminderToggle } from "../../lib/reminders.ts";
import { cn } from "../../lib/utils.ts";

export function ReminderButton({
  channel,
  start,
  className,
}: {
  channel: LiveChannel;
  start: number;
  className?: string;
}) {
  const reminder = useReminderToggle(channel, start);
  return (
    <span className={cn("flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <Button
        variant="secondary"
        size="sm"
        aria-pressed={reminder.set}
        aria-busy={reminder.busy || undefined}
        disabled={!reminder.ready}
        // Enter and Space are the button's, not the list's or the grid's around it.
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
          reminder.toggle();
        }}
        className="aria-pressed:ring-1 aria-pressed:ring-white/35 aria-pressed:ring-inset"
      >
        {reminder.set ? <Check /> : <Bell />}
        {reminder.set ? t("Reminder set") : t("Remind me")}
      </Button>
      {reminder.failure && (
        <span role="alert" className="text-[0.8125rem] text-destructive">
          {reminder.failure}
        </span>
      )}
    </span>
  );
}
