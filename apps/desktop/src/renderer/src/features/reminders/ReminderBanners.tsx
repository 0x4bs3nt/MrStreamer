// The window's notice of a reminder that told, on every page, under the top bar: "Starts now", or
// how long ago it started when it told late, the programme and its channel, with Watch and
// Dismiss. It shows whatever the system did with its own notice, so it is what remains when
// notifications are off, and stays until dismissed or the programme ends. The main process says
// which show; a click on the system's notice shows one again. Watch plays the channel live the way
// every channel plays; nothing tunes by itself. None shows over the mini player.
import { useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import type { Reminder } from "@mrstreamer/contracts/reminders";
import { t } from "@mrstreamer/core/i18n";
import { runtime } from "@mrstreamer/core/viewing/continue";
import { useMiniPlayer } from "../../app/mini-player.ts";
import { Button } from "../../components/ui/button.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { useNow } from "../../lib/clock.ts";
import { call } from "../../lib/ipc.ts";
import { queries } from "../../lib/queries.ts";
import { useReminders } from "../../lib/reminders.ts";
import { cn } from "../../lib/utils.ts";
import { WINDOW_BAR } from "../../../../shared/window-bar.ts";
import { watchLive } from "../live/GuidePage.tsx";

export function ReminderBanners() {
  const reminders = useReminders().data?.reminders;
  const now = useNow();
  const mini = useMiniPlayer((state) => state.on);
  const shown = (reminders ?? []).filter((each) => each.banner && now < each.stop);
  if (mini || shown.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed right-6 z-[45] flex w-[22rem] max-w-[calc(100vw-3rem)] flex-col gap-2"
      style={{ top: WINDOW_BAR.height + 8 }}
    >
      {shown.map((reminder) => (
        <Banner key={reminder.id} reminder={reminder} now={now} />
      ))}
    </div>
  );
}

function Banner({ reminder, now }: { reminder: Reminder; now: number }) {
  // The channel as the lists have it now, to play: one they no longer show can't be watched.
  const channel = useQuery(queries.channel(reminder.channel));
  const dismiss = () => void call("reminders.dismiss", { id: reminder.id }).catch(() => {});
  const minutes = Math.floor((now - reminder.start) / 60_000);
  return (
    <section
      aria-label={reminder.title}
      className={cn(menuSurface, "pointer-events-auto p-4 text-[0.9375rem]")}
    >
      <div role="status">
        <div className="text-[0.8125rem] text-muted-foreground">
          {minutes < 1 ? t("Starts now") : t("Started {time} ago", { time: runtime(minutes * 60) })}
        </div>
        <div className="mt-0.5 truncate font-semibold">{reminder.title}</div>
        <div className="truncate text-sm text-muted-foreground">
          {channel.isError
            ? `${reminder.channelName} · ${t("Not available now")}`
            : reminder.channelName}
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={!channel.data}
          onClick={() => {
            if (!channel.data) return;
            watchLive(channel.data);
            dismiss();
          }}
        >
          <Play className="fill-current" />
          {t("Watch")}
        </Button>
        <Button variant="secondary" size="sm" onClick={dismiss}>
          {t("Dismiss")}
        </Button>
      </div>
    </section>
  );
}
