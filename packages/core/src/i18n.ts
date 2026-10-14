// The app's own text in the interface language, and how numbers, dates and lists are written in
// it. Every message is keyed by its English text (`i18n/en.ts`), so `t("Settings")` reads as the
// English it shows and a key that isn't in the catalogue fails to compile. Each process (the
// window, the main process, the catalogue worker) has one language at a time, set by
// `setLanguage`, and makes its text in it.
//
// A message's {placeholders} are its parameters: `t("{known} of {wanted} titles", { known,
// wanted })`. Numbers in them are written as counts in the language, so a year or an HTTP status
// goes in as a string. A message with plural forms takes `count` and picks its form by the
// language's plural rules.
import {
  isLocale,
  LOCALES,
  SOURCE_LOCALE,
  type InterfaceLanguage,
  type Locale,
} from "@mrstreamer/contracts/language";
import { de } from "./i18n/de.ts";
import { en } from "./i18n/en.ts";
import { es } from "./i18n/es.ts";
import { fr } from "./i18n/fr.ts";
import { nl } from "./i18n/nl.ts";

/** A message's forms by `Intl.PluralRules` category. Every language has `other`. */
export interface Plural {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type MessageKey = keyof typeof en;

/** Another language's text for every English message: a string, or forms where English has them. */
export type Translation = {
  readonly [K in MessageKey]: (typeof en)[K] extends string ? string : Plural;
};

/** The placeholders of a message: "known" | "wanted" for "{known} of {wanted} titles". */
export type Placeholder<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholder<Rest>
  : never;

type Params<K extends MessageKey> = (typeof en)[K] extends string
  ? { readonly [P in Placeholder<K>]: string | number }
  : { readonly [P in Placeholder<K> | "count"]: P extends "count" ? number : string | number };

/** The parameters `t` takes for `key`: none for a message without placeholders or forms. */
export type MessageArgs<K extends MessageKey> = (typeof en)[K] extends string
  ? [Placeholder<K>] extends [never]
    ? []
    : [params: Params<K>]
  : [params: Params<K>];

/** A message without plural forms. */
export type TextKey = { [K in MessageKey]: (typeof en)[K] extends string ? K : never }[MessageKey];

/** A message that takes no parameters, as a label kept in a list for `t` to show later. */
export type PlainKey = { [K in MessageKey]: MessageArgs<K> extends [] ? K : never }[MessageKey];

const catalogues: { readonly [L in Locale]: Translation } = {
  "en-US": en,
  "nl-NL": nl,
  "fr-FR": fr,
  "de-DE": de,
  "es-ES": es,
};

/** A process's language: its text, and the tag its dates and numbers are written in. */
export type ActiveLanguage = Pick<InterfaceLanguage, "locale" | "formats">;

let active: ActiveLanguage = { locale: SOURCE_LOCALE, formats: SOURCE_LOCALE };
const listeners = new Set<() => void>();

/** Makes `locale` this process's language, with dates and numbers in `formats`. */
export function setLanguage({ locale, formats }: ActiveLanguage): void {
  const tag = validTag(formats) ?? locale;
  if (active.locale === locale && active.formats === tag) return;
  active = { locale, formats: tag };
  for (const listener of listeners) listener();
}

/** This process's language. The same object until the language changes. */
export function currentLanguage(): ActiveLanguage {
  return active;
}

/** Calls `listener` after the language changes. Returns the unsubscribe function. */
export function onLanguageChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** `key` in this process's language, English where the language has no text for it. */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string {
  return translate(active.locale, key, ...args);
}

/**
 * `key` in `locale`, whatever this process's language is, its counts written as `locale` writes
 * them: in the process's own variant (en-GB for English) when `locale` is its language.
 */
export function translate<K extends MessageKey>(
  locale: Locale,
  key: K,
  ...[params]: MessageArgs<K>
): string {
  const message: string | Plural | undefined = catalogues[locale]?.[key] ?? en[key];
  const values: Readonly<Record<string, string | number>> = params ?? {};
  const tag = locale === active.locale ? active.formats : locale;
  const text =
    message === undefined
      ? key
      : typeof message === "string"
        ? message
        : pluralForm(locale, message, Number(values["count"] ?? 0));
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) return whole;
    return typeof value === "number" ? numbers("count", {}, tag).format(value) : value;
  });
}

/** Text, or the name of the placeholder that stands in it. */
export type MessagePart<K extends MessageKey> = string | { readonly placeholder: Placeholder<K> };

/**
 * `key`'s message in this process's language, split at its placeholders, for a caller that puts
 * its own things there, such as links: "Where titles stream comes from {justWatch}." is the text
 * and then `{ placeholder: "justWatch" }`.
 */
export function messageParts<K extends TextKey>(key: K): readonly MessagePart<K>[] {
  const message: string | Plural = catalogues[active.locale][key] ?? en[key];
  const text = typeof message === "string" ? message : message.other;
  return text.split(/\{(\w+)\}/).flatMap((part, at): MessagePart<K>[] => {
    if (at % 2 === 0) return part ? [part] : [];
    return isPlaceholder(key, part) ? [{ placeholder: part }] : [`{${part}}`];
  });
}

function isPlaceholder<K extends MessageKey>(key: K, name: string): name is Placeholder<K> {
  return key.includes(`{${name}}`);
}

function pluralForm(locale: Locale, forms: Plural, count: number): string {
  const category = rules(locale).select(count);
  return forms[category] ?? forms.other;
}

/**
 * The interface language for what the viewer `saved` and the system's languages, best first.
 * System default (nothing saved, or "system") is the first system language the app speaks,
 * matched by its language alone (nl-BE is Dutch), else English. A saved value this release
 * doesn't know, as a later release may write, shows English.
 */
export function resolveLanguage(
  saved: string | undefined,
  systemTags: readonly string[],
): InterfaceLanguage {
  const tags = systemTags.flatMap((tag) => validTag(tag) ?? []);
  const system = tags.flatMap((tag) => LOCALES.find((each) => sameLanguage(each, tag)) ?? [])[0];
  const choice = saved === undefined || saved === "system" ? "system" : saved;
  const locale =
    choice === "system" ? (system ?? SOURCE_LOCALE) : isLocale(choice) ? choice : SOURCE_LOCALE;
  return {
    choice: choice === "system" || isLocale(choice) ? choice : locale,
    system: system ?? SOURCE_LOCALE,
    locale,
    formats: tags.find((tag) => sameLanguage(locale, tag)) ?? locale,
  };
}

/** A system language as a canonical BCP 47 tag: "de_AT.UTF-8" is "de-AT". Null for "C". */
function validTag(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag.replace(/[.@].*$/, "").replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

function sameLanguage(a: string, b: string): boolean {
  return new Intl.Locale(a).language === new Intl.Locale(b).language;
}

// Formatting. Intl objects are made once per language and kind, and only here.

const pluralRules = new Map<string, Intl.PluralRules>();
const numberFormats = new Map<string, Intl.NumberFormat>();
const dateFormats = new Map<string, Intl.DateTimeFormat>();
const listFormats = new Map<string, Intl.ListFormat>();
const languageNames = new Map<string, Intl.DisplayNames>();

function made<A>(kept: Map<string, A>, key: string, make: () => A): A {
  let value = kept.get(key);
  if (value === undefined) {
    value = make();
    kept.set(key, value);
  }
  return value;
}

function rules(locale: Locale): Intl.PluralRules {
  return made(pluralRules, locale, () => new Intl.PluralRules(locale));
}

function numbers(
  kind: string,
  options: Intl.NumberFormatOptions,
  tag = active.formats,
): Intl.NumberFormat {
  return made(numberFormats, `${kind} ${tag}`, () => new Intl.NumberFormat(tag, options));
}

/** A count: "1,234" in English, "1.234" in German. */
export function formatNumber(value: number): string {
  return numbers("count", {}).format(value);
}

/** A number with exactly `digits` decimals, as a rating or a subtitle delay: "7.5", "7,5". */
export function formatDecimal(value: number, digits: number): string {
  return numbers(`decimal ${digits}`, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** A part of a whole, from 0 to 1: "62%", "62 %". */
export function formatPercent(fraction: number): string {
  return numbers("percent", { style: "percent", maximumFractionDigits: 0 }).format(fraction);
}

/** A size on disk: "812 MB", "4.1 GB", in decimal units as file managers show them. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) {
    return numbers("gigabytes", {
      style: "unit",
      unit: "gigabyte",
      maximumFractionDigits: 1,
    }).format(bytes / 1e9);
  }
  if (bytes >= 1e6) {
    return numbers("megabytes", {
      style: "unit",
      unit: "megabyte",
      maximumFractionDigits: 0,
    }).format(bytes / 1e6);
  }
  return numbers("kilobytes", { style: "unit", unit: "kilobyte", maximumFractionDigits: 0 }).format(
    Math.max(bytes, 0) / 1e3,
  );
}

/** Megabytes in binary units, as the limits of what is read are set: "64 MB". */
export function formatMebibytes(bytes: number): string {
  return numbers("mebibytes", { style: "unit", unit: "megabyte" }).format(bytes / (1024 * 1024));
}

const DATE_STYLES = {
  /** "21:00", "09:00 PM" */
  time: { hour: "2-digit", minute: "2-digit" },
  /** "Fri" */
  weekday: { weekday: "short" },
  /** "2 Oct", "Oct 2" */
  day: { day: "numeric", month: "short" },
  /** "Fri 2 Oct", "Fri, Oct 2" */
  weekdayDay: { weekday: "short", day: "numeric", month: "short" },
  /** "2 Oct 2026", "Oct 2, 2026" */
  date: { day: "numeric", month: "short", year: "numeric" },
  /** As the language writes a medium date: "2 Oct 2026", "2 oct. 2026" */
  medium: { dateStyle: "medium" },
  /** A calendar day with no time of its own, as TMDB gives air dates, read as UTC. */
  calendarDay: { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

export type DateStyle = keyof typeof DATE_STYLES;

/** A moment in the interface language, in one of the app's few date styles. */
export function formatDate(at: number | Date, style: DateStyle): string {
  const tag = active.formats;
  return made(
    dateFormats,
    `${style} ${tag}`,
    () => new Intl.DateTimeFormat(tag, DATE_STYLES[style]),
  ).format(at);
}

/** A language by its name in the interface language: "Dutch", "néerlandais". Null when unknown. */
export function formatLanguageName(code: string): string | null {
  const tag = active.locale;
  const names = made(languageNames, tag, () => new Intl.DisplayNames(tag, { type: "language" }));
  try {
    const name = names.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/** "A, B and C", "A, B et C". */
export function formatList(items: readonly string[]): string {
  const tag = active.formats;
  return made(listFormats, tag, () => new Intl.ListFormat(tag, { type: "conjunction" })).format(
    items,
  );
}
