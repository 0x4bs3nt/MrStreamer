import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import type { ReactElement, ReactNode } from "react";

export const TooltipProvider = TooltipPrimitive.Provider;

/**
 * Wraps a control with a short label that appears on hover or keyboard focus. `disabled` keeps the
 * label away while the control says it itself, with the control left as it is. With `open` the
 * caller decides when it shows, hearing what hover and focus ask through `onOpenChange`.
 */
export function Tooltip({
  label,
  children,
  side = "top",
  disabled = false,
  open,
  onOpenChange,
  disableHoverablePopup,
}: {
  label: ReactNode;
  children: ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: TooltipPrimitive.Root.Props["onOpenChange"];
  disableHoverablePopup?: boolean;
}) {
  return (
    <TooltipPrimitive.Root
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      disableHoverablePopup={disableHoverablePopup}
    >
      <TooltipPrimitive.Trigger render={children} />
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Positioner side={side} sideOffset={8} className="z-[140]">
          <TooltipPrimitive.Popup className="rounded-lg bg-popover px-2.5 py-1.5 text-xs text-foreground shadow-lg ring-1 ring-white/10 transition-[opacity,scale] duration-100 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
            {label}
          </TooltipPrimitive.Popup>
        </TooltipPrimitive.Positioner>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}
