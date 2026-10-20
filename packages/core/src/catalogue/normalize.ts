// Turns a provider's raw catalogue into what the app shows: channel titles with their quality
// tags split off, and categories grouped by region. Providers write names in their own ways, so
// every rule is checked against the catalogue at hand instead of assuming one reseller's style:
//   - Region prefixes ("BE |", "UK:", "[DE]", "US -", "Belgium |", a flag) group categories only
//     when many categories carry one. A region with a single category groups nothing, so that
//     category stands alone when its name already says the region ("LU | LUXEMBOURG").
//   - A channel loses its prefix when it repeats its category's, or when prefixes are the
//     catalogue's style; flags always go. Unknown codes the catalogue does not use stay.
//   - A trailing "(…)" goes only when it repeats the category or its region, or held only tags.
//   - Names in capitals get title case; names with any lowercase keep the provider's casing.
//   - Nothing ends up worse than the raw name: when cleaning leaves too little, the name stays.
// Each stream keeps what tells it apart from another of the same title, its region, language and
// categories, so ./variants.ts can join the streams of one channel. Names don't depend on whose
// catalogue it is: the library says which subscription's the channels and categories are.
import type { Category, LiveChannel } from "@mrstreamer/contracts/library";
import { normalize as fold } from "../text.ts";
import type { LiveCatalogue, ProviderCategory, ProviderChannel } from "../provider.ts";
import { finish, pacer, type Steps } from "../steps.ts";
import { leadingFlag, regionForCode, regionForName } from "./regions.ts";

export interface NormalizedCatalogue {
  readonly categories: readonly Omit<Category, "channelCount" | "subscriptionId" | "members">[];
  readonly streams: readonly NormalizedStream[];
}

/** One stream of the provider's list, named as the app shows it. */
export interface NormalizedStream extends Omit<LiveChannel, "variants" | "subscriptionId"> {
  /** Conflicting or unknown category metadata cannot establish a channel identity. */
  readonly searchUncertain?: true;
  /** The provider's guide id. */
  readonly guideId: string | null;
  /** "Belgium": its own prefix's region, else its category's. Null when neither names one. */
  readonly region: string | null;
  /** The language after its own or its category's region, "FR" for "BE - FR |". */
  readonly language: string | null;
  /**
   * What its categories hold, by region and name without quality words: "Belgium|vlaanderen" for
   * "BE | VLAANDEREN HD". A category named only for a quality, "BE | 4K", holds no topic.
   */
  readonly topics: readonly string[];
}

/** Share of names that must carry a region prefix before prefixes count as the catalogue's style. */
const PREFIX_STYLE_SHARE = 0.3;

/** "BE |", "UK:", "[DE]", "|NL|", "(FR)", "US -", or "BE - FR |" with a language after the country. */
const CODE_PREFIX = /^[[(|┃│]?\s*([A-Z]{2,5})(?:\s*-\s*([A-Z]{2,3}))?(?:\s*[\])|:┃│»]|\s+-\s)\s*/;

/** "Belgium |", "BELGIQUE:". Only counts when the words are a country name. */
const NAME_PREFIX = /^(\p{L}[\p{L} .'&-]{2,30}?)\s*[|:┃│»]\s*/u;

/** Quality and format markers, as whole words anywhere in a channel name. */
const QUALITY =
  /(?<![\p{L}\p{N}])(8K|4K|UHD|FHD|HD\+?|SD|HEVC|H\.?265|HDR|RAW|50\s?FPS|60\s?FPS|\d{3,4}p)(?![\p{L}\p{N}])/giu;

/** Where a quality tag was, while a channel's title is cleaned. */
const TAG = "";

/** Brands and formats that keep their capitals when a name is recased. */
// prettier-ignore
const ACRONYMS = new Set([
  "AAC", "BEIN", "CCTV", "CGTN", "CNBC", "DAZN", "DMAX", "ESPN", "EWTN", "FIFA", "HGTV", "KIKA",
  "MPEG", "NASA", "RTBF", "UAE", "UEFA", "USA",
]);

/** Short words that read as words, not acronyms, when a name is recased. */
// prettier-ignore
const WORDS = new Set([
  "AL", "ALL", "AND", "BIG", "BOX", "DA", "DAS", "DE", "DEL", "DEN", "DER", "DES", "DI", "DIE",
  "DOS", "DU", "EL", "EN", "ET", "FOR", "FUN", "HET", "HIT", "HOT", "IL", "LA", "LAS", "LE", "LES",
  "LOS", "MAX", "MIT", "MIX", "MY", "NEW", "OF", "ON", "POP", "RED", "SIX", "SKY", "SUN", "TEN",
  "THE", "TO", "TOP", "TRE", "TWO", "UND", "VAN", "VON",
]);

interface ParsedName {
  /** The name with compatibility characters made plain ("ᴴᴰ" is "HD"). */
  readonly text: string;
  /** What follows the region prefix; the whole text when there is none. */
  readonly rest: string;
  /** "Belgium" for "BE |", "🇧🇪" or "Belgium:". An unknown code stays as written: "VIP". */
  readonly region: string | null;
  /** Whether the region is one the region tables know, rather than an unknown code. */
  readonly known: boolean;
  readonly flag: boolean;
  /** A language after the country: "BE - FR |" gives "FR". */
  readonly language: string | null;
}

interface ShownCategory extends Omit<Category, "channelCount" | "subscriptionId" | "members"> {
  /** The region of the category's prefix, grouped or not, for matching its channels' prefixes. */
  readonly region: string | null;
  readonly language: string | null;
  /** See `NormalizedStream.topics`; null for a category named only for a quality. */
  readonly topic: string | null;
}

export function normalizeCatalogue(catalogue: LiveCatalogue): NormalizedCatalogue {
  return finish(normalizeSteps(catalogue));
}

/** Category content without its region prefix or quality markers, shared with discovery labels. */
export function categorySubject(raw: string): string {
  return subjectOf(parse(raw));
}

function subjectOf(name: ParsedName): string {
  return fold((name.region === null ? name.text : name.rest).replace(QUALITY, " "));
}

/** `normalizeCatalogue`, pausing between slices of its channels (../steps.ts). */
export function* normalizeSteps(catalogue: LiveCatalogue): Steps<NormalizedCatalogue> {
  const due = pacer();
  const named: { category: ProviderCategory; name: ParsedName }[] = [];
  for (const category of catalogue.categories) {
    if (due()) yield;
    named.push({ category, name: parse(category.name) });
  }
  const prefixed = named.filter(({ name }) => name.region !== null).length;
  const prefixStyle = prefixed >= Math.max(2, named.length * PREFIX_STYLE_SHARE);
  const regionUse = countBy(named.map(({ name }) => name.region));

  const show = ({ category, name }: (typeof named)[number]): ShownCategory => {
    const subject = subjectOf(name);
    const base = {
      id: category.id,
      name: category.name,
      region: name.region,
      language: name.language,
      topic: subject ? `${name.region ?? ""}|${subject}` : null,
    };
    const whole = { ...base, group: null, title: recase(name.text) };
    if (!prefixStyle || name.region === null) return whole;
    const title = recase(name.rest || name.text) + (name.language ? ` (${name.language})` : "");
    if ((regionUse.get(name.region) ?? 0) >= 2) return { ...base, group: name.region, title };
    // A region with one category groups nothing. The category stands alone when its name says
    // the region, and keeps its whole name when the prefix is not a region anyone knows.
    if (namesRegion(name.rest, name.region)) return { ...base, group: null, title };
    return name.known ? { ...base, group: name.region, title } : whole;
  };
  const shown: ShownCategory[] = [];
  for (const each of named) {
    if (due()) yield;
    shown.push(show(each));
  }
  const categoryById = new Map(shown.map((category) => [category.id, category]));
  const categoryRegions = new Set(shown.map((category) => category.region));

  const kept: { channel: ProviderChannel; name: ParsedName }[] = [];
  for (const channel of catalogue.channels) {
    if (due()) yield;
    if (!isSeparator(channel.name)) kept.push({ channel, name: parse(channel.name) });
  }
  const recognised = (name: ParsedName) =>
    name.region !== null && (name.known || categoryRegions.has(name.region));
  const prefixedChannels = kept.filter(({ name }) => recognised(name)).length;
  const channelPrefixStyle = prefixedChannels >= kept.length * PREFIX_STYLE_SHARE;

  const streams: NormalizedStream[] = [];
  for (const { channel, name } of kept) {
    if (due()) yield;
    const own = channel.categoryIds.flatMap((id) => categoryById.get(id) ?? []);
    const strip =
      name.region !== null &&
      (name.flag ||
        own.some((category) => category.region === name.region) ||
        (channelPrefixStyle && recognised(name)));
    const repeatsCategory = (inner: string) => {
      const folded = fold(inner);
      const region = regionForCode(inner) ?? regionForName(inner);
      return own.some(
        (category) =>
          fold(category.title) === folded || (region !== null && region === category.region),
      );
    };
    const placed = own.find((category) => category.region !== null);
    const regions = new Set(own.flatMap((category) => category.region ?? []));
    const languages = new Set(own.flatMap((category) => category.language ?? []));
    const uncertain =
      channel.categoryIds.some((id) => !categoryById.has(id)) ||
      regions.size > 1 ||
      languages.size > 1 ||
      (name.region !== null && !name.known) ||
      own.some((category) => category.region !== null && !regionForName(category.region)) ||
      (name.region !== null && regions.size > 0 && !regions.has(name.region)) ||
      (name.language !== null && languages.size > 0 && !languages.has(name.language));
    streams.push({
      id: channel.id,
      name: channel.name,
      number: channel.number,
      logoUrl: channel.logoUrl,
      categoryIds: channel.categoryIds,
      guideId: channel.guideId,
      catchupDays: channel.catchupDays,
      ...channelTitle(strip ? name.rest : name.text, name.text, repeatsCategory),
      region: recognised(name) ? name.region : (placed?.region ?? null),
      language: name.language ?? placed?.language ?? null,
      topics: own.flatMap((category) => category.topic ?? []),
      ...(uncertain ? { searchUncertain: true } : {}),
    });
  }

  return {
    categories: shown.map(
      ({ region: _region, language: _language, topic: _topic, ...category }) => category,
    ),
    streams,
  };
}

/** Decorative entries between channel groups: "##### UK SPORTS #####", "━━━ NL ━━━", "== NL ==". */
function isSeparator(raw: string): boolean {
  const text = raw.trim();
  return (
    /^([^\p{L}\p{N}\s])\1{2,}/u.test(text) ||
    /([^\p{L}\p{N}\s!?.+)\]])\1{2,}$/u.test(text) ||
    /^([^\p{L}\p{N}\s])\1\s.*\s\1\1$/u.test(text)
  );
}

function parse(raw: string): ParsedName {
  // Superscript digits mark backup streams ("FHD²") and circled letters are markers ("ⓧ"), so
  // both go. Other compatibility forms become plain letters: "ᴴᴰ" is "HD", "ＢＢＣ" is "BBC".
  const text = raw
    .replace(/[⁰¹²³⁴-⁹\u2460-\u24ff]/g, "")
    .normalize("NFKC")
    .trim();
  const none: ParsedName = {
    text,
    rest: text,
    region: null,
    known: false,
    flag: false,
    language: null,
  };

  const flag = leadingFlag(text);
  if (flag)
    return { ...none, rest: flag.rest.trim(), region: flag.region, known: true, flag: true };

  const coded = CODE_PREFIX.exec(text);
  if (coded?.[1]) {
    const region = regionForCode(coded[1]);
    return {
      ...none,
      rest: text.slice(coded[0].length).trim(),
      region: region ?? coded[1],
      known: region !== null,
      language: coded[2] ?? null,
    };
  }

  const spelled = NAME_PREFIX.exec(text);
  const region = spelled?.[1] ? regionForName(spelled[1]) : null;
  if (!spelled || !region) return none;
  return { ...none, rest: text.slice(spelled[0].length).trim(), region, known: true };
}

/** Whether a name already says its region: "LUXEMBOURG" for Luxembourg, "UKRAIN" for Ukraine. */
function namesRegion(name: string, region: string): boolean {
  if (regionForName(name) !== null) return true;
  const start = fold(name).slice(0, 3);
  return /^\p{L}{3}$/u.test(start) && fold(region).startsWith(start);
}

/** Splits quality tags off a channel name and drops a trailing "(…)" that repeats its category. */
function channelTitle(
  name: string,
  fallback: string,
  repeatsCategory: (inner: string) => boolean,
): { title: string; tags: string[] } {
  const tags: string[] = [];
  const title = name
    .replace(QUALITY, (tag: string) => {
      const normalized = tag
        .replace(/[\s.]/g, "")
        .toUpperCase()
        .replace(/(\d)P$/, "$1p");
      if (!tags.includes(normalized)) tags.push(normalized);
      return TAG;
    })
    // Joiners between removed tags, or a tag and an end ("FHD + HEVC"). One beside the name is
    // the name's: "Canal+ HD", "Bloomberg TV + (2160p)".
    .replace(/(?<=^|)\s*[+&/]\s*(?=|$)/g, " ")
    .replaceAll(TAG, " ")
    .replace(/[([]\s*[)\]]/g, " ")
    .replace(/\s*[([]([^()[\]]*)[)\]]\s*$/, (match, inner: string) =>
      repeatsCategory(inner) ? "" : match,
    )
    // Separators and decoration at either end.
    .replace(/^[\s|:\-–.·•●★✦►]+|[\s|:\-–.·•●★✦►]+$/g, "")
    .replace(/\s{2,}/g, " ");
  // Never worse than the provider's own name: a title with no letters or digits left is not one.
  if (!/[\p{L}\p{N}]/u.test(title)) return { title: recase(fallback), tags: [] };
  return { title: recase(title), tags };
}

/**
 * Title case for names that arrive in capitals; names with any lowercase stay as the provider
 * wrote them. Short words stay capitals because they are usually acronyms (VTM, NPO, HBO), unless
 * they read as words: a few common ones, and those with two vowels (ONE, UNE, RAI). Words without
 * vowels stay capitals at any length (MSNBC).
 */
export function recase(text: string): string {
  if (!/\p{Lu}/u.test(text) || /\p{Ll}/u.test(text)) return text;
  return text.replace(/\p{L}[\p{L}']*/gu, (word, offset: number) => {
    // "13TH" reads "13th".
    if (/^(ST|ND|RD|TH)$/.test(word) && /\d/.test(text.charAt(offset - 1))) {
      return word.toLowerCase();
    }
    const vowels = word.normalize("NFD").match(/[AEIOUY]/g)?.length ?? 0;
    // Alone in brackets a short word is a code: "(DE)" is Germany, not the article.
    const bracketed = text.charAt(offset - 1) === "(" && text.charAt(offset + word.length) === ")";
    const acronym =
      ACRONYMS.has(word) ||
      vowels === 0 ||
      (word.length <= 3 && vowels < 2 && (bracketed || !WORDS.has(word)));
    // Lowercasing the Turkish "İ" leaves a combining dot on the "i".
    const rest = word
      .slice(1)
      .toLowerCase()
      .replace(/i\u0307/g, "i");
    return acronym ? word : word.charAt(0) + rest;
  });
}

function countBy(values: readonly (string | null)[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}
