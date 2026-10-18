// Name search keeps independent spellings for ranking, but allows query words to span names
// for recall (for example a film's Dutch name and a French version's language tag).
import { searchSpellings, searchWords } from "../text.ts";

type Name = readonly string[];

export interface SearchNames {
  readonly displayed: Name;
  readonly originals: readonly Name[];
  readonly aliases: readonly Name[];
}

export interface NameQuery {
  readonly spellings: readonly string[];
  readonly unrepeated: readonly string[];
  readonly words: readonly string[];
}

/** Prepare immutable catalogue names once; metadata can supply separate names at search time. */
export function indexNames(
  displayed: string,
  originals: readonly string[] = [],
  aliases: readonly string[] = [],
): SearchNames {
  return {
    displayed: searchSpellings(displayed),
    originals: originals.map(searchSpellings),
    aliases: aliases.map(searchSpellings),
  };
}

export function nameQuery(text: string): NameQuery {
  const spellings = searchSpellings(text);
  const words = searchWords(text);
  return {
    spellings,
    words: [...new Set(words)],
    // Repeated terms still ask for the same words. Keep the literal phrase first, so a title
    // such as The The keeps its exact match ahead of the single-word fallback.
    unrepeated:
      words.length === new Set(words).size
        ? []
        : spellings.map((phrase) => [...new Set(phrase.split(" "))].join(" ")),
  };
}

/**
 * Exact, name prefix, word starts, then substrings; displayed wins within each tier, followed
 * by originals/provider names and aliases. A metadata name replaces only the displayed-name
 * preference: the provider's displayed name remains searchable. Undefined means no match.
 */
export function scoreNames(
  query: NameQuery,
  names: SearchNames,
  metadata?: SearchNames,
): number | undefined {
  if (query.words.length === 0) return undefined;
  const preferred = metadata?.displayed.length ? metadata.displayed : names.displayed;
  const best = Math.min(
    scoreName(query, preferred, 0),
    preferred !== names.displayed ? scoreName(query, names.displayed, 1) : Infinity,
    scoreGroup(query, names.originals, 1),
    scoreGroup(query, metadata?.originals, 1),
    scoreGroup(query, names.aliases, 2),
    scoreGroup(query, metadata?.aliases, 2),
  );
  if (best !== Infinity) return best;
  // A match spanning names has recall but cannot outrank a match contained in one name.
  return query.words.every(
    (word) => holdsWord(names, word) || (metadata && holdsWord(metadata, word)),
  )
    ? 30
    : undefined;
}

function holdsWord(names: SearchNames, word: string): boolean {
  return (
    names.displayed.some((form) => form.includes(word)) ||
    names.originals.some((name) => name.some((form) => form.includes(word))) ||
    names.aliases.some((name) => name.some((form) => form.includes(word)))
  );
}

function scoreGroup(
  query: NameQuery,
  names: readonly Name[] | undefined,
  preference: number,
): number {
  let best = Infinity;
  for (const name of names ?? []) best = Math.min(best, scoreName(query, name, preference));
  return best;
}

function scoreName(query: NameQuery, name: Name, preference: number): number {
  let best = Infinity;
  for (const form of name) {
    if (!query.words.every((word) => form.includes(word))) continue;
    const quality = query.spellings.includes(form)
      ? 0
      : query.unrepeated.includes(form)
        ? 1
        : query.spellings.some((phrase) => form.startsWith(phrase)) ||
            query.unrepeated.some((phrase) => form.startsWith(phrase))
          ? 2
          : query.words.every((word) => ` ${form}`.includes(` ${word}`))
            ? 3
            : 4;
    // Normalized spellings win an otherwise equal punctuation alternative.
    const alternative = form !== name[0] || (quality === 0 && form !== query.spellings[0]) ? 1 : 0;
    best = Math.min(best, quality * 6 + preference * 2 + alternative);
  }
  return best;
}

/**
 * Only a mixed query has a year qualifier. The last four-digit term qualifies the remaining
 * title terms; callers also try the literal query so numeric names such as Wonder Woman 1984
 * remain searchable even when their release year differs. Unknown years get literal recall only.
 */
export function yearQuery(
  text: string,
): { readonly year: number; readonly query: NameQuery } | null {
  const compatible = text.normalize("NFKC");
  if (searchWords(compatible).length < 2) return null;
  const term = [...compatible.matchAll(/(?<![\p{L}\p{N}])[12]\d{3}(?![\p{L}\p{N}])/gu)].at(-1);
  if (!term) return null;
  return {
    year: Number(term[0]),
    query: nameQuery(
      `${compatible.slice(0, term.index)} ${compatible.slice(term.index + term[0].length)}`,
    ),
  };
}
