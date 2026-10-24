import { Search } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A pill search field: the magnifier, the input, then `end`, such as a clear button. `className`
 * sizes and places the pill; every other prop is the input's.
 */
export function SearchField({
  className,
  end,
  ...props
}: ComponentProps<"input"> & { end?: ReactNode }) {
  return (
    <label
      className={cn(
        "group flex h-9 items-center gap-2 rounded-full bg-white/8 px-3.5 focus-within:bg-white/12 focus-within:ring-2 focus-within:ring-ring",
        className,
      )}
    >
      <Search className="size-4 flex-none text-muted-foreground" />
      <input
        spellCheck={false}
        className="min-w-0 flex-1 truncate bg-transparent text-[0.875rem] text-foreground outline-none placeholder:text-muted-foreground"
        {...props}
      />
      {end}
    </label>
  );
}
