// The pieces Settings is built from: titled lists of rows, each with its name on the left and
// its control or value on the right, like the system's own settings.
import type { FormEvent, ReactNode, Ref } from "react";
import type { SettingsControl } from "./catalogue.ts";
import { cn } from "../../lib/utils.ts";

/** A titled list of rows. */
export function Section({
  title,
  ref,
  children,
}: {
  title: string;
  ref?: Ref<HTMLElement>;
  children: ReactNode;
}) {
  return (
    <section ref={ref} className="mb-10">
      <h2 className="mb-1 text-[0.9375rem] font-semibold">{title}</h2>
      <div className="text-[0.9375rem]">{children}</div>
    </section>
  );
}

/**
 * One setting: its name, a few words beside it, and its control on the right. A `wrap` note goes
 * on a line of its own under the name, and wraps there rather than be cut off.
 */
export function Row({
  id,
  label,
  note,
  wrap = false,
  children,
}: {
  id?: SettingsControl;
  label: ReactNode;
  note?: ReactNode;
  wrap?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-setting={id}
      className="flex min-h-13 flex-wrap items-center gap-x-6 gap-y-2 border-b border-white/8 py-2"
    >
      <div className="min-w-32 flex-1 break-words">
        {label}
        {note &&
          (wrap ? (
            <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">{note}</div>
          ) : (
            <span className="text-muted-foreground"> · {note}</span>
          ))}
      </div>
      {children && <div className="flex max-w-full flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** A form in a list of rows, under the row it belongs to. */
export function RowForm({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      className="mb-2 ml-5 max-w-[26rem] border-b border-white/8 pt-2 pb-6"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** A choice from a short list, on the right of its row. */
export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  wide = false,
  disabled = false,
  busy = false,
}: {
  label: string;
  disabled?: boolean;
  busy?: boolean;
  value: T;
  /** Each choice, with the language its label is in when that isn't the interface's. */
  options: readonly { readonly value: T; readonly label: string; readonly lang?: string }[];
  onChange: (value: T) => void;
  /** Room for a longer choice, such as System default with the language it follows. */
  wide?: boolean;
}) {
  return (
    <select
      aria-label={label}
      disabled={disabled}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      value={value}
      onChange={(event) => {
        const picked = options.find((option) => option.value === event.target.value);
        if (picked) onChange(picked.value);
      }}
      className={cn(
        "h-9 max-w-full truncate rounded-none bg-white/6 px-3 ring-1 ring-input outline-none focus:ring-2 focus:ring-ring",
        wide ? "w-64" : "w-56",
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} lang={option.lang}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
