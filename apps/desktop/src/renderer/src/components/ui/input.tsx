import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A text field. `compact` is the row size, for Settings and inline forms beside small buttons;
 * the default, larger size belongs to the login form on Connect and Add subscription.
 */
export function Input({
  className,
  compact = false,
  ...props
}: ComponentProps<"input"> & { compact?: boolean }) {
  return (
    <input
      data-slot="input"
      spellCheck={false}
      className={cn(
        "w-full bg-white/6 text-foreground ring-1 ring-input outline-none transition-[box-shadow,background-color] placeholder:text-muted-foreground/70 focus:bg-white/8 focus:ring-2 focus:ring-ring",
        compact ? "h-8 rounded-lg px-3 text-sm" : "h-12 rounded-xl px-4 text-base",
        className,
      )}
      {...props}
    />
  );
}
