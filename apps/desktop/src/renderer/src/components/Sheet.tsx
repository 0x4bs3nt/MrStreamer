import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { t } from "@mrstreamer/core/i18n";
import { cn } from "../lib/utils.ts";

/**
 * A sheet over the page it was opened from, which stays in view behind it: a title's details, or
 * what was kept of a saved one, or a Settings playlist/guide mapping. It rises from the foot of the window to under the top bar, or
 * only as far as its content needs when `short`. `overSettings` puts it above the Settings page
 * it was opened from. Its content names it with a `Dialog.Title`. Escape, Close and a click
 * outside call `onClose`. The keyboard starts on the content's first control, or on
 * `initialFocus`.
 */
export function Sheet({
  onClose,
  short = false,
  overSettings = false,
  initialFocus,
  children,
}: {
  onClose: () => void;
  short?: boolean;
  overSettings?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  children: ReactNode;
}) {
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
          className={cn(
            "fixed inset-x-[max(1.5rem,calc((100vw-68rem)/2))] bottom-[var(--receiver-bar,0px)] z-20 flex flex-col overflow-hidden rounded-t-3xl bg-black shadow-2xl ring-1 ring-white/10 outline-none transition-[opacity,translate] duration-200 data-ending-style:translate-y-4 data-ending-style:opacity-0 data-starting-style:translate-y-4 data-starting-style:opacity-0",
            short ? "max-h-[calc(100%-3.75rem-var(--receiver-bar,0px))]" : "top-[3.75rem]",
            overSettings && "z-50",
          )}
        >
          {/* The outer frame clips the scrollbar as well as the content at its rounded edge. */}
          <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {children}
            {/* After the content, so focus starts on its main action rather than on Close. */}
            <Dialog.Close
              aria-label={t("Close")}
              className="absolute top-4 right-4 z-10 grid size-9 place-items-center rounded-full bg-black/60 text-white ring-1 ring-white/20 hover:bg-black/80"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
