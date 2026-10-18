/** Lowercase, accent-free, with punctuation collapsed to single spaces: "UK: Één HD" becomes "uk een hd". */
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Punctuation between letters/digits may join a name; ordinary spaces never do. */
const JOINER = /(?<=[\p{L}\p{N}]\p{M}*)['’ʼ\p{Pd}](?=[\p{L}\p{N}])/gu;

/** The ordinary spelling and, when different, one joined apostrophe/hyphen alternative. */
export function searchSpellings(text: string): readonly string[] {
  const normal = normalize(text);
  if (!normal) return [];
  const compatible = text.normalize("NFKC");
  const withoutJoiners = compatible.replace(JOINER, "");
  if (withoutJoiners === compatible) return [normal];
  const joined = normalize(withoutJoiners);
  return normal === joined ? [normal] : [normal, joined];
}

/** A search's words, folded as `normalize` folds text: " Één, HD" becomes "een" and "hd". */
export function searchWords(query: string): string[] {
  return normalize(query).split(" ").filter(Boolean);
}

/**
 * Where a search's `words` show in `text`, as [start, end) pairs in order and apart, for marking
 * what matched. Empty unless every word shows, as a match needs them all.
 */
export function matchRanges(
  text: string,
  words: readonly string[],
): readonly (readonly [start: number, end: number])[] {
  if (words.length === 0) return [];
  // The text folded a character at a time, with where in `text` each folded character came from.
  let folded = "";
  const sources: (readonly [number, number])[] = [];
  for (const { 0: character, index } of text.matchAll(/\P{M}\p{M}*/gu)) {
    // What isn't a letter or a digit folds to nothing: it parts words, as a space does.
    const piece = normalize(character) || " ";
    folded += piece;
    for (let unit = 0; unit < piece.length; unit++) sources.push([index, index + character.length]);
  }
  // Keep original character ranges when a joined spelling spans an apostrophe or hyphen.
  const joiners = new Set([...text.matchAll(JOINER)].map((match) => match.index));
  let joined = "";
  const joinedSources: (readonly [number, number])[] = [];
  for (const [at, source] of sources.entries()) {
    if (joiners.has(source[0])) continue;
    joined += folded[at];
    joinedSources.push(source);
  }
  const spellings = [[folded, sources] as const];
  if (joined !== folded) spellings.push([joined, joinedSources]);
  const found: [number, number][] = [];
  for (const word of words) {
    let matched = false;
    for (const [spelling, positions] of spellings) {
      for (
        let at = spelling.indexOf(word);
        at !== -1;
        at = spelling.indexOf(word, at + word.length)
      ) {
        const start = positions[at]?.[0];
        const end = positions[at + word.length - 1]?.[1];
        if (start !== undefined && end !== undefined) {
          found.push([start, end]);
          matched = true;
        }
      }
    }
    if (!matched) return [];
  }
  // Words that overlap or touch read as one mark.
  const ranges: [number, number][] = [];
  for (const [start, end] of found.toSorted((a, b) => a[0] - b[0])) {
    const last = ranges.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }
  return ranges;
}
