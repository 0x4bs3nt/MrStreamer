import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode, Ref, RefObject } from "react";
import { t } from "@mrstreamer/core/i18n";
import { cn } from "../lib/utils.ts";

/**
 * A sheet over the page it was opened from, which stays in view behind it: a title's details, or
 * what was kept of a saved one, or a Settings playlist/guide mapping. It rises from the foot of the window to under the top bar, or
 * only as far as its content needs when `short`. `overSettings` puts it above the Settings page
 * it was opened from. The page's top bar stays behind the backdrop, unless a `bar` takes its
 * place above it, as details' does for their Back. Its content names it with a `Dialog.Title`.
 * Escape, Close and a click outside call `onClose`. The keyboard starts on the content's first
 * control, or on `initialFocus`. `scroller` is the part that scrolls.
 */
export function Sheet({
  onClose,
  short = false,
  overSettings = false,
  initialFocus,
  scroller,
  bar,
  children,
}: {
  onClose: () => void;
  short?: boolean;
  overSettings?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  scroller?: Ref<HTMLDivElement>;
  bar?: ReactNode;
  children: ReactNode;
}) {
  const sheet = cn(
    "inset-x-[max(1.5rem,calc((100vw-68rem)/2))] bottom-[var(--receiver-bar,0px)] flex flex-col overflow-hidden rounded-t-3xl bg-black shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,translate] duration-200",
    short ? "max-h-[calc(100%-3.75rem-var(--receiver-bar,0px))]" : "top-[3.75rem]",
    bar
      ? "pointer-events-auto absolute group-data-ending-style:translate-y-4 group-data-ending-style:opacity-0 group-data-starting-style:translate-y-4 group-data-starting-style:opacity-0"
      : cn(
          "fixed z-20 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0",
          overSettings && "z-50",
        ),
  );
  const content = (
    // The outer frame clips the scrollbar as well as the content at its rounded edge.
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {children}
      {/* After the content, so focus starts on its main action rather than on Close. */}
      <Dialog.Close
        aria-label={t("Close")}
        className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/20 hover:bg-black/80"
      >
        <X className="size-4" />
      </Dialog.Close>
    </div>
  );
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-20 bg-black/65 transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0",
            overSettings && "z-50",
          )}
        />
        <Dialog.Popup
          {...(initialFocus ? { initialFocus } : {})}
          className={
            bar
              ? // A frame the size of the window, holding the bar and the sheet: a click beside
                // the sheet goes through to the backdrop and closes it, and the bar stays put as
                // the sheet rises.
                cn(
                  "group pointer-events-none fixed inset-0 z-20 outline-none",
                  overSettings && "z-50",
                )
              : sheet
          }
        >
          {bar ? (
            <>
              <div className={sheet}>{content}</div>
              {/* After the sheet, so focus starts there too; drawn at the top of the window. */}
              <div className="pointer-events-auto absolute inset-x-0 top-0">{bar}</div>
            </>
          ) : (
            content
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
