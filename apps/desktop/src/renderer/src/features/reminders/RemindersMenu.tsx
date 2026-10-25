// The bell in Live TV's header, with how many reminders are still to come, and the list it opens:
// each reminder's programme, when and where, how it stands when the guide changed, and a cross
// that takes it out. Reminders that told, were missed or went stay listed until the end of the
// day their programme ends, dimmed once it has started. The list says when the system didn't show
// a notice, or shows none from the app; the window's own notice shows either way.
import { Popover } from "@base-ui/react/popover";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Bell, X } from "lucide-react";
import { useEffectEvent, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Reminder } from "@mrstreamer/contracts/reminders";
import { t } from "@mrstreamer/core/i18n";
import { Button } from "../../components/ui/button.tsx";
import { menuSurface } from "../../components/ui/menu.ts";
import { useNow } from "../../lib/clock.ts";
import { appError, describeError } from "../../lib/errors.ts";
import { dayTime } from "../../lib/format.ts";
import { call } from "../../lib/ipc.ts";
import { remindersQuery, useReminders } from "../../lib/reminders.ts";
import { cn } from "../../lib/utils.ts";

export function RemindersMenu() {
  const reminders = useReminders();
  const now = useNow();
  const [open, setOpen] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const shown = reminders.data?.reminders ?? [];
  const coming = shown.filter((each) => each.start > now).length;
  const label = coming > 0 ? t("Reminders, {count} to come", { count: coming }) : t("Reminders");
  const footer =
    reminders.data?.notifications === "failed"
      ? t(
          "The system didn't show the last reminder. Reminders still show here while the app is open.",
        )
      : reminders.data?.notifications === "unsupported"
        ? t(
            "This system doesn't show notifications from Mr. Streamer. Reminders still show here while the app is open.",
          )
        : null;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button variant="ghost" size="icon" aria-label={label} title={t("Reminders")}>
            <Bell />
            {coming > 0 && (
              <span
                aria-hidden
                className="absolute top-1 right-1 grid h-4 min-w-4 place-items-center rounded-full bg-white px-1 text-[0.625rem] leading-none font-semibold text-black tabular-nums"
              >
                {coming}
              </span>
            )}
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={8} className="z-[60]">
          <Popover.Popup
            ref={popup}
            tabIndex={-1}
            aria-label={t("Reminders")}
            className={cn(
              menuSurface,
              "w-[24rem] max-w-[calc(100vw-2rem)] p-3 text-[0.9375rem] transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0",
            )}
          >
            <h2 className="px-3 pt-1 pb-2 text-sm font-semibold">{t("Reminders")}</h2>
            {reminders.isError ? (
              <div role="alert" className="flex items-center gap-3 px-3 pb-2 text-sm">
                <span className="min-w-0 flex-1">{describeError(appError(reminders.error))}</span>
                <Button size="sm" variant="secondary" onClick={() => void reminders.refetch()}>
                  {t("Retry")}
                </Button>
              </div>
            ) : (
              <ReminderRows
                reminders={shown}
                empty={reminders.isSuccess && shown.length === 0}
                now={now}
                popup={popup}
              />
            )}
            {footer && (
              <p className="mx-1 mt-2 border-t border-white/10 px-2 pt-3 pb-1 text-[0.8125rem]">
                {footer}
              </p>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * The reminders listed, or what the list says without any. A row goes once its reminder left the
 * list, by whichever read says so first: the one main's changed event starts, which can come back
 * before the cancel's answer, or the one after that answer. A row that has the keys as it goes
 * hands them on then, once, to a row the list keeps: the next one's cross, else the one before,
 * else the popup. So they never fall out of it, and never pass through a row going in the same
 * change, which the popup would take for the keys leaving it. As the popup closes, the page
 * changes or the list can't be read, React takes the list down before its rows, and none does.
 */
function ReminderRows({
  reminders,
  empty,
  now,
  popup,
}: {
  reminders: readonly Reminder[];
  empty: boolean;
  now: number;
  popup: RefObject<HTMLDivElement | null>;
}) {
  const client = useQueryClient();
  const leaving = useRef(false);
  useLayoutEffect(() => {
    leaving.current = false;
    return () => {
      leaving.current = true;
    };
  }, []);
  const handOn = (row: HTMLElement) => {
    if (leaving.current || !row.contains(document.activeElement)) return;
    // A going row never gets the render that drops it, so which rows stay comes from the cache,
    // which holds that list before React takes any row out.
    const kept = new Set(
      client.getQueryData(remindersQuery().queryKey)?.reminders.map(({ id }) => id),
    );
    const keptCross = (sibling: Element | null, onward: (each: Element) => Element | null) => {
      for (let each = sibling; each; each = onward(each))
        if (kept.has(each.getAttribute("data-reminder") ?? ""))
          return each.querySelector<HTMLButtonElement>("button[data-remove]");
      return null;
    };
    (
      keptCross(row.nextElementSibling, (each) => each.nextElementSibling) ??
      keptCross(row.previousElementSibling, (each) => each.previousElementSibling) ??
      popup.current
    )?.focus();
  };
  if (empty)
    return (
      <div className="px-3 pb-2">
        <p>{t("No reminders yet.")}</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Set one on a programme still to come. Mr. Streamer reminds you while it's open.")}
        </p>
      </div>
    );
  return (
    <ul className="max-h-[22rem] overflow-y-auto">
      {reminders.map((reminder) => (
        <ReminderRow key={reminder.id} reminder={reminder} now={now} onGoing={handOn} />
      ))}
    </ul>
  );
}

/** What a reminder's line says after its time and channel: how it stands, where that matters. */
function standing(reminder: Reminder, now: number): string | null {
  switch (reminder.status.kind) {
    case "upcoming":
      return null;
    case "changed":
      return t("was {title}", { title: reminder.status.was });
    case "gone":
      return t("Not in the guide now");
    case "missed":
      return t("Missed");
    case "told":
      return now < reminder.stop ? t("On now") : null;
  }
}

function ReminderRow({
  reminder,
  now,
  onGoing,
}: {
  reminder: Reminder;
  now: number;
  /** The row is going, still on the page. */
  onGoing: (row: HTMLElement) => void;
}) {
  const client = useQueryClient();
  const row = useRef<HTMLLIElement>(null);
  const going = useEffectEvent(onGoing);
  // React runs this cleanup as it takes the row out, before the row leaves the page.
  useLayoutEffect(() => {
    const element = row.current;
    return () => {
      if (element) going(element);
    };
  }, []);
  // The answer moves no keys: the row's going does, whenever that is.
  const removal = useMutation({
    mutationFn: async () => {
      await call("reminders.cancel", { id: reminder.id });
      await client.invalidateQueries({ queryKey: remindersQuery().queryKey });
    },
  });
  const dim = reminder.status.kind === "gone" || reminder.start <= now;
  const error = removal.isError ? appError(removal.error) : null;
  return (
    <li
      ref={row}
      data-reminder={reminder.id}
      className="flex items-start gap-2 rounded-lg py-2 pr-1 pl-3"
    >
      <div className="min-w-0 flex-1">
        <div className={cn("truncate", dim && "text-muted-foreground")}>{reminder.title}</div>
        <div className="truncate text-[0.8125rem] text-muted-foreground">
          {[dayTime(reminder.start, now), reminder.channelName, standing(reminder, now)]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {error && (
          <div role="alert" className="mt-0.5 text-[0.8125rem] text-destructive">
            {error.kind === "reminder" ? describeError(error) : t("Couldn't remove. Try again.")}
          </div>
        )}
      </div>
      <button
        data-remove
        aria-label={t("Remove the reminder for {title}", { title: reminder.title })}
        title={t("Remove the reminder for {title}", { title: reminder.title })}
        aria-busy={removal.isPending || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          if (!removal.isPending) removal.mutate();
        }}
        className="grid size-8 flex-none place-items-center rounded-full text-muted-foreground outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>
    </li>
  );
}
