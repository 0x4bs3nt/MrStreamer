// Compact menus filter this kind's grid or search. Provider hints stay separate from tracks
// read on this device; asking for choices never opens a file.
import { Menu } from "@base-ui/react/menu";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import type { TitleKind } from "@mrstreamer/contracts/ondemand";
import {
  QUALITY_HINTS,
  type QualityHint,
  type TitleFilters,
} from "@mrstreamer/contracts/title-filters";
import { TITLE_LANGUAGES } from "@mrstreamer/core/ondemand/languages";
import { formatLanguageName, t } from "@mrstreamer/core/i18n";
import { queries } from "../../lib/queries.ts";
import { appError, describeError } from "../../lib/errors.ts";

const QUALITIES: Record<QualityHint, string> = {
  "4k": "4K",
  "full-hd": "Full HD",
  hd: "HD",
  sd: "SD",
  unknown: "Unknown",
};
function hintName(code: string): string {
  if (code === "unknown") return t("Unknown");
  if (code === "multi") return "MULTI";
  return TITLE_LANGUAGES.find((language) => language.code === code)?.name ?? code;
}
function verifiedName(kind: "audio" | "subtitles", language: string): string {
  const name = language === "unknown" ? t("Unknown") : (formatLanguageName(language) ?? language);
  return kind === "audio"
    ? t("{language} sound", { language: name })
    : t("{language} subtitles", { language: name });
}
export interface TitleFilterControls {
  readonly filters: TitleFilters;
  readonly onFilters: (filters: TitleFilters) => void;
}

/** Keep control navigation out of the grid while leaving application shortcuts available. */
function stopGridKeys(event: KeyboardEvent) {
  if (
    [
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Enter",
      " ",
    ].includes(event.key)
  )
    event.stopPropagation();
}

/** A scrollable choice menu, shared by sort and filters. Native menu keys stay out of the grid. */
export function TitleChoiceMenu<V extends string>({
  label,
  description,
  choices,
  value,
  onChange,
  disabled = false,
  clearable = false,
  showLabel = true,
}: {
  label: string;
  description?: string;
  choices: readonly { readonly value: V; readonly label: string }[];
  value: V | undefined;
  onChange: (value: V | undefined) => void;
  disabled?: boolean;
  clearable?: boolean;
  showLabel?: boolean;
}) {
  const selected = choices.find((choice) => choice.value === value);
  return (
    <div role="group" aria-label={label} onKeyDown={stopGridKeys}>
      <Menu.Root>
        <Menu.Trigger
          disabled={disabled}
          aria-label={[label, selected?.label].filter(Boolean).join(": ")}
          className="flex h-8 max-w-full items-center gap-2 rounded px-2 text-white/70 outline-none hover:bg-white/8 hover:text-white focus-visible:ring-1 focus-visible:ring-white disabled:opacity-40"
        >
          {showLabel && <span className="flex-none">{label}</span>}
          {selected && <span className="truncate font-semibold text-white">{selected.label}</span>}
          {!showLabel && !selected && <span>{label}</span>}
          <ChevronDown aria-hidden className="size-3.5 flex-none" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="start" sideOffset={8} className="z-[60]">
            <Menu.Popup
              aria-label={label}
              className="max-h-[min(60vh,var(--available-height))] w-[min(18rem,calc(100vw-2rem))] overflow-y-auto bg-black p-2 text-[0.8125rem] text-white ring-1 ring-white/20 outline-none"
              onKeyDown={(event) => {
                if (event.key === "Escape") event.stopPropagation();
                else stopGridKeys(event);
              }}
            >
              <Menu.RadioGroup
                value={value ?? ""}
                onValueChange={(next: string) =>
                  onChange(choices.find((choice) => choice.value === next)?.value)
                }
              >
                {(clearable ? [{ value: "", label: t("Any") }, ...choices] : choices).map(
                  (choice) => (
                    <Menu.RadioItem
                      key={choice.value}
                      value={choice.value}
                      closeOnClick
                      className="flex items-center gap-2 px-2 py-2 text-white/70 outline-none data-checked:font-semibold data-checked:text-white data-highlighted:bg-white/10"
                    >
                      <span className="grid size-4 flex-none">
                        <Menu.RadioItemIndicator>
                          <Check className="size-4" />
                        </Menu.RadioItemIndicator>
                      </span>
                      {choice.label}
                    </Menu.RadioItem>
                  ),
                )}
              </Menu.RadioGroup>
              {description && (
                <p className="mt-2 border-t border-white/15 px-2 pt-3 pb-1 text-xs text-white/60">
                  {description}
                </p>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

export function TitleFilterBar({
  kind,
  filters,
  onFilters,
  total,
  unfiltered,
  sortControl,
  hideCount = false,
}: TitleFilterControls & {
  kind: TitleKind;
  total: number | null;
  unfiltered: number | null;
  sortControl?: ReactNode;
  hideCount?: boolean;
}) {
  const available = useQuery(queries.titleFilterOptions(kind));
  const options = available.data;
  const languages = new Set(options?.languages ?? []);
  if (filters.language) languages.add(filters.language);
  const ordered = [...TITLE_LANGUAGES.map((language) => language.code), "multi", "unknown"].filter(
    (code) => languages.has(code),
  );
  const verified = [...(options?.verified ?? [])];
  if (
    filters.verified &&
    !verified.some(
      (entry) =>
        entry.kind === filters.verified?.kind && entry.language === filters.verified.language,
    )
  )
    verified.push(filters.verified);
  function change<K extends keyof TitleFilters>(key: K, value: TitleFilters[K]) {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    onFilters(next);
  }
  return (
    <div className="mb-4 flex-none pr-8 text-[0.8125rem] text-white" onKeyDown={stopGridKeys}>
      {!hideCount && total !== null && unfiltered !== null && (
        <p className="mb-2 text-white/60 tabular-nums" aria-live="polite">
          {t("{shown} of {total}", { shown: total, total: unfiltered })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2">
        {sortControl && (
          <>
            <div>{sortControl}</div>
            <span aria-hidden className="mx-2 h-4 border-l border-white/20" />
          </>
        )}
        <TitleChoiceMenu
          label={t("Quality")}
          description={t("Hints from the provider's names, not verified picture quality.")}
          choices={QUALITY_HINTS.filter(
            (value) => options?.qualities.includes(value) || filters.quality === value,
          ).map((value) => ({
            value,
            label: value === "unknown" ? t("Unknown") : QUALITIES[value],
          }))}
          value={filters.quality}
          onChange={(value) => change("quality", value)}
          clearable
          disabled={!options}
        />
        <TitleChoiceMenu
          label={t("Language")}
          description={t("Hints from the provider's names, not verified sound or subtitles.")}
          choices={ordered.map((value) => ({ value, label: hintName(value) }))}
          value={filters.language}
          onChange={(value) => change("language", value)}
          clearable
          disabled={!options}
        />
        <TitleChoiceMenu
          label={t("Verified")}
          description={t(
            "Tracks read from {count} current files on this device. Filtering opens no files.",
            { count: options?.files ?? 0 },
          )}
          choices={verified.map((entry) => ({
            value: `${entry.kind}:${entry.language}`,
            label: verifiedName(entry.kind, entry.language),
          }))}
          value={
            filters.verified ? `${filters.verified.kind}:${filters.verified.language}` : undefined
          }
          onChange={(value) =>
            change(
              "verified",
              verified.find((entry) => `${entry.kind}:${entry.language}` === value),
            )
          }
          clearable
          disabled={!options}
        />
        {Object.keys(filters).length > 0 && (
          <button
            onClick={() => onFilters({})}
            className="ml-2 rounded px-2 py-1 underline underline-offset-4 focus-visible:outline-white"
          >
            {t("Reset")}
          </button>
        )}
      </div>
      {available.error && (
        <p className="mt-2 text-destructive">
          {describeError(appError(available.error))}{" "}
          <button
            className="text-white underline underline-offset-4"
            onClick={() => void available.refetch()}
          >
            {t("Try again")}
          </button>
        </p>
      )}
    </div>
  );
}

/** Empty matches explain the extra limit of local observations without triggering a probe. */
export function FilterEmpty({ filters }: { filters: TitleFilters }) {
  return (
    <p className="pr-8 text-[0.9375rem] text-white">
      {t("No titles match these filters.")}
      {filters.verified &&
        ` ${t("Verified tracks come from files played on this device. Filtering opens no files.")}`}
    </p>
  );
}
