import { Check } from "lucide-react";
import type { ComponentProps } from "react";

/**
 * A native checkbox drawn like Settings' toggles: a rounded box that fills white with a black
 * tick. It stays an `<input type="checkbox">`, so labels, forms and keys work as they always do.
 */
export function NativeCheckbox(props: Omit<ComponentProps<"input">, "type" | "className">) {
  return (
    <span className="relative flex size-4 flex-none">
      <input
        type="checkbox"
        className="peer size-4 appearance-none rounded-[0.25rem] shadow-[inset_0_0_0_1.5px_rgb(255_255_255/45%)] outline-none checked:bg-white checked:shadow-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        {...props}
      />
      <Check
        aria-hidden
        className="pointer-events-none absolute inset-0 m-auto hidden size-3 text-black peer-checked:block"
        strokeWidth={3}
      />
    </span>
  );
}
