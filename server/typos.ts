/**
 * Deterministic typo variants for marketplace queries.
 *
 * Mispriced listings often misspell the product name ("Playstasion",
 * "iphone"). Each scan that enables typo variants searches a rotating subset
 * of these variants so the single-page-per-search budget is never exceeded.
 * Polish diacritics are preserved verbatim — a mutated "ś" is still "ś".
 */

const MIN_TOKEN_LENGTH = 6;

function isVowel(character: string) {
  return 'aeiouyąęó'.includes(character.toLowerCase());
}

function transpositions(token: string): string[] {
  const variants: string[] = [];
  for (let index = 0; index < token.length - 1; index += 1) {
    if (token[index] === token[index + 1]) continue;
    variants.push(token.slice(0, index) + token[index + 1] + token[index] + token.slice(index + 2));
  }
  return variants;
}

function vowelDeletions(token: string): string[] {
  const variants: string[] = [];
  for (let index = 0; index < token.length; index += 1) {
    if (!isVowel(token[index])) continue;
    variants.push(token.slice(0, index) + token.slice(index + 1));
  }
  return variants;
}

function doubledLetterRemovals(token: string): string[] {
  const variants: string[] = [];
  for (let index = 0; index < token.length - 1; index += 1) {
    if (token[index] !== token[index + 1]) continue;
    variants.push(token.slice(0, index) + token.slice(index + 1));
  }
  return variants;
}

/** One misspelled query, and the query words it changed (`from`) into which (`to`). */
export interface TypoVariant {
  query: string;
  from: string;
  to: string;
}

/**
 * Up to `max` unique, deterministic misspellings of the query, each with the
 * token it changed. Tokens shorter than six characters are left alone (their
 * mutations are noise, not typos). One token is mutated per variant; every
 * other token stays verbatim.
 */
export function typoVariantPairs(query: string, opts: { max?: number } = {}): TypoVariant[] {
  const max = Math.max(0, Math.floor(opts.max ?? 3));
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const variants: TypoVariant[] = [];
  const push = (candidate: string, from: string, to: string) => {
    if (variants.length >= max) return;
    if (candidate === query || variants.some((variant) => variant.query === candidate)) return;
    variants.push({ query: candidate, from, to });
  };
  for (let index = 0; index < tokens.length && variants.length < max; index += 1) {
    const token = tokens[index];
    if (token.length < MIN_TOKEN_LENGTH) continue;
    const candidates = [
      ...transpositions(token),
      ...vowelDeletions(token),
      ...doubledLetterRemovals(token),
    ];
    for (const candidate of candidates) {
      push([...tokens.slice(0, index), candidate, ...tokens.slice(index + 1)].join(' '), token, candidate);
      if (variants.length >= max) break;
    }
  }
  return variants;
}

/** The misspelled queries alone; see typoVariantPairs. */
export function typoVariants(query: string, opts: { max?: number } = {}): string[] {
  return typoVariantPairs(query, opts).map((variant) => variant.query);
}

/**
 * Deterministic rotation so consecutive scans fetch different slices of the
 * variant set: scan ordinal N starts at variant N modulo length and wraps.
 * Over enough scans every variant is fetched; no scan ever fetches more
 * than `max` of them.
 */
export function pickVariantBatch<T>(variants: T[], scanOrdinal: number, max: number): T[] {
  if (!variants.length || max <= 0) return [];
  const start = ((Math.floor(scanOrdinal) % variants.length) + variants.length) % variants.length;
  const count = Math.min(max, variants.length);
  return Array.from({ length: count }, (_, offset) => variants[(start + offset) % variants.length]);
}
