// What a key just changed, when nothing else on screen shows it: "Speed 1.25×", "Subtitles 0.3 s
// later". It shows for a moment where a typed channel number does. A standing note shows in the
// same place for as long as it holds, such as "Subtitles loading": what a key changed shows over
// it for its moment, and then the note is back. A note that says something failed, such as
// "Subtitles unavailable", closes with its cross (CloseMessage.tsx).
import { useEffect, useRef } from "react";
import { t } from "@mrstreamer/core/i18n";
import { cn } from "../../lib/utils.ts";
import { usePlayer } from "../../player/player.ts";
import { CloseMessage, useClosed } from "./CloseMessage.tsx";
import { flash, useFlash } from "./flash-state.ts";
export { flash, flashNote } from "./flash-state.ts";

const SHOWN_MS = 1500;

export function Flash() {
  const text = useFlash((state) => state.text);
  const at = useFlash((state) => state.at);
  const note = useFlash((state) => state.note);
  const closed = useClosed(note);
  useEffect(() => {
    if (!text) return;
    const timer = setTimeout(() => useFlash.setState({ text: null }), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [text, at]);
  // A note from one view doesn't show up in the next.
  useEffect(() => () => useFlash.setState({ text: null }), []);
  const standing = note && !closed ? note : null;
  const shown = text ?? standing?.text;
  if (!shown) return null;
  const closable = !text && standing?.failed;
  return (
    <div
      className={cn(
        "pointer-events-none fixed top-12 right-12 z-40 rounded-3xl bg-black/80 px-6 py-4 text-2xl font-semibold tracking-tight tabular-nums ring-1 ring-white/10",
        closable && "pr-14",
      )}
    >
      <div role="status">{shown}</div>
      {closable && <CloseMessage failure={standing} className="top-3 right-3" />}
    </div>
  );
}

/** Watch owns the late hint. Proof observed before this view mounted stays silent. */
export function LiveSubtitleHint() {
  const available = usePlayer((state) => state.subtitleAvailability);
  const seen = useRef(available);
  useEffect(() => {
    const previous = seen.current;
    seen.current = available;
    if (available === previous) return;
    if (!available) {
      if (useFlash.getState().text === t("Subtitles available · C")) {
        useFlash.setState({ text: null });
      }
    } else if (!available.selected && available.played > 10_000) {
      flash(t("Subtitles available · C"));
    }
  }, [available]);
  return null;
}
