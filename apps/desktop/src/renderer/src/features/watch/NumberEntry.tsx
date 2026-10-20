// Typing a channel number jumps to it, as on a TV remote: the digits show at once and the
// channel tunes after a short pause, or straight away on Enter.
import { useEffect } from "react";
import { create } from "zustand";
import type { LiveChannel } from "@mrstreamer/contracts/library";
import { t } from "@mrstreamer/core/i18n";
import { useUi } from "../../app/ui-store.ts";
import { useListChannels } from "../live/lists.ts";

/** How long the entry waits for another digit before it tunes. */
const COMMIT_MS = 1200;
const MAX_DIGITS = 5;

const useDigits = create<{ digits: string; committing: boolean }>(() => ({
  digits: "",
  committing: false,
}));

export const numberEntry = {
  type(digit: string): void {
    useDigits.setState((state) => ({
      digits: (state.digits + digit).slice(-MAX_DIGITS),
      committing: false,
    }));
  },
  /** Tunes the typed number now. Returns false when nothing was typed. */
  commit(): boolean {
    if (!useDigits.getState().digits) return false;
    useDigits.setState({ committing: true });
    return true;
  },
  cancel(): void {
    useDigits.setState({ digits: "", committing: false });
  },
  active(): boolean {
    return useDigits.getState().digits.length > 0;
  },
};

/** Shows the typed number and hands over the channel it names, once typing stops. */
export function NumberEntry({ onChannel }: { onChannel: (channel: LiveChannel) => void }) {
  const digits = useDigits((state) => state.digits);
  const committing = useDigits((state) => state.committing);
  const all = useListChannels({ kind: "all" });
  const match = digits
    ? all.channels?.find((channel) => channel.number === Number(digits))
    : undefined;

  // Digits typed in one view don't carry into the next.
  useEffect(() => () => numberEntry.cancel(), []);

  useEffect(() => {
    if (!digits) return;
    const timer = setTimeout(() => numberEntry.commit(), COMMIT_MS);
    return () => clearTimeout(timer);
  }, [digits]);

  // A number typed before Settings, search or a title opened over this view doesn't act behind it.
  const covered = useUi(
    (state) =>
      state.settings !== null || state.searchOpen || state.details !== null || state.playingTitle,
  );
  useEffect(() => {
    if (covered) numberEntry.cancel();
  }, [covered]);

  useEffect(() => {
    if (!committing || !all.channels) return;
    if (match) onChannel(match);
    numberEntry.cancel();
  }, [committing, match, all.channels, onChannel]);

  if (!digits) return null;
  return (
    <div className="pointer-events-none fixed top-12 right-12 z-40 min-w-[9rem] rounded-3xl bg-black/80 px-6 py-4 text-right ring-1 ring-white/10">
      <div className="text-5xl font-semibold tracking-tight tabular-nums">{digits}</div>
      <div className="mt-1 max-w-[16rem] truncate text-sm text-muted-foreground">
        {match ? match.title : all.channels ? t("No channel") : ""}
      </div>
    </div>
  );
}
