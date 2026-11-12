/**
 * Deterministic typo variants for marketplace queries.
 *
 * Mispriced listings often misspell the product name ("Iphon 13",
 * "Plystation"). Each scan that enables typo variants searches a rotating
 * subset of these variants so the single-page-per-search budget is never
 * exceeded, and a manual search can ask for the first few. Polish diacritics
 * are preserved verbatim — a mutated "ś" is still "ś".
 */

const LEGACY_MIN_TOKEN_LENGTH = 6;

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

/** Letter-only tokens this long or longer get misspelled; digits and punctuation never do. */
const MIN_LETTERS = 5;
/** Two adjacent words are also tried joined ("play station" → "playstation") when one is short and the join is this long. */
const MIN_JOINED_LENGTH = 7;
const LETTERS_ONLY = /^\p{L}+$/u;

function sameLetter(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * One token's misspellings, most realistic first: the final letter dropped,
 * a doubled letter dropped, an interior pair transposed (from the end), an
 * interior vowel dropped, then the rest (the first pair transposed, an
 * interior consonant dropped). Characters, not UTF-16 units, so "ż" stays whole.
 */
function tokenTypos(token: string): string[] {
  const letters = Array.from(token);
  const length = letters.length;
  const without = (index: number) => [...letters.slice(0, index), ...letters.slice(index + 1)].join('');
  const swapped = (index: number) => [...letters.slice(0, index), letters[index + 1], letters[index], ...letters.slice(index + 2)].join('');
  const candidates: string[] = [without(length - 1)];
  for (let index = 0; index < length - 1; index += 1) {
    if (sameLetter(letters[index], letters[index + 1])) candidates.push(without(index));
  }
  for (let index = length - 2; index >= 1; index -= 1) {
    if (!sameLetter(letters[index], letters[index + 1])) candidates.push(swapped(index));
  }
  for (let index = 1; index < length - 1; index += 1) {
    if (isVowel(letters[index])) candidates.push(without(index));
  }
  if (!sameLetter(letters[0], letters[1])) candidates.push(swapped(0));
  for (let index = 1; index < length - 1; index += 1) {
    if (!isVowel(letters[index])) candidates.push(without(index));
  }
  return [...new Set(candidates)].filter((candidate) => candidate !== token);
}

/**
 * Up to `max` unique, deterministic misspellings of the query, each with the
 * words it changed. Only letter-only tokens of five or more letters are
 * misspelled (so "rtx 4070" and "ps5" have none), one per variant, every
 * other token verbatim; Polish diacritics are kept. The picks go round-robin
 * across the eligible tokens, each token's most realistic typo first, so two
 * picks never both mangle one word; joined forms of two adjacent words come
 * after the first round.
 */
export function typoVariantPairs(query: string, opts: { max?: number } = {}): TypoVariant[] {
  const max = Math.max(0, Math.floor(opts.max ?? 3));
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const original = tokens.join(' ');
  const variants: TypoVariant[] = [];
  const push = (candidateTokens: string[], from: string, to: string) => {
    const candidate = candidateTokens.join(' ');
    if (variants.length >= max || candidate === original || variants.some((variant) => variant.query === candidate)) return;
    variants.push({ query: candidate, from, to });
  };
  const eligible = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => LETTERS_ONLY.test(token) && Array.from(token).length >= MIN_LETTERS)
    .map(({ token, index }) => ({ token, index, typos: tokenTypos(token) }));
  const joined: Array<{ index: number; from: string; to: string }> = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const [left, right] = [tokens[index], tokens[index + 1]];
    if (!LETTERS_ONLY.test(left) || !LETTERS_ONLY.test(right)) continue;
    const short = Math.min(Array.from(left).length, Array.from(right).length) < MIN_LETTERS;
    if (short && Array.from(left + right).length >= MIN_JOINED_LENGTH) joined.push({ index, from: `${left} ${right}`, to: left + right });
  }
  const rounds = Math.max(0, ...eligible.map(({ typos }) => typos.length));
  for (let round = 0; round < rounds && variants.length < max; round += 1) {
    for (const { token, index, typos } of eligible) {
      if (round < typos.length) push([...tokens.slice(0, index), typos[round], ...tokens.slice(index + 1)], token, typos[round]);
    }
    if (round === 0) {
      for (const join of joined) push([...tokens.slice(0, join.index), join.to, ...tokens.slice(join.index + 2)], join.from, join.to);
    }
  }
  if (!rounds) {
    for (const join of joined) push([...tokens.slice(0, join.index), join.to, ...tokens.slice(join.index + 2)], join.from, join.to);
  }
  return variants;
}

/** The misspelled queries alone; see typoVariantPairs. */
export function typoVariants(query: string, opts: { max?: number } = {}): string[] {
  return typoVariantPairs(query, opts).map((variant) => variant.query);
}

/**
 * The generator research criteria versions saved before November 2026 use
 * (`typo_variants = 1`): tokens of six or more characters, transpositions
 * from the first letter, then vowel and doubled-letter drops. Kept verbatim,
 * since a version's spellings are part of its comparable series.
 */
export function legacyTypoVariants(query: string, opts: { max?: number } = {}): string[] {
  const max = Math.max(0, Math.floor(opts.max ?? 3));
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  const variants: string[] = [];
  const push = (candidate: string) => {
    if (variants.length >= max) return;
    if (candidate === query || variants.includes(candidate)) return;
    variants.push(candidate);
  };
  for (let index = 0; index < tokens.length && variants.length < max; index += 1) {
    const token = tokens[index];
    if (token.length < LEGACY_MIN_TOKEN_LENGTH) continue;
    const candidates = [
      ...transpositions(token),
      ...vowelDeletions(token),
      ...doubledLetterRemovals(token),
    ];
    for (const candidate of candidates) {
      push([...tokens.slice(0, index), candidate, ...tokens.slice(index + 1)].join(' '));
      if (variants.length >= max) break;
    }
  }
  return variants;
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
