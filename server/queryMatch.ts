/**
 * Free-text product query → the watches and research series that track it.
 *
 * The query is treated like a listing title and run through the same term
 * rules a scan uses (`parseIncludedExcluded` + `termMatches`), so "rtx3080"
 * and "rtx 3080" match both ways and "iphone 5" never matches "iphone 15".
 * Pure: the caller loads candidates and computes prices.
 */
import { normalizeFilterText, parseIncludedExcluded, queryTokens, splitTerms, termMatches } from './text';
import { OTHER_VARIANT_KEY, assignVariant, type VariantGroup } from './variants';

export interface MatchCandidate {
  kind: 'watch' | 'research';
  id: string;
  name: string;
  query: string;
  includedTerms: string;
  excludedTerms: string;
  groups: VariantGroup[];
}

/**
 * - `exact`: every candidate term is in the query and every query token is in the candidate.
 * - `variant`: as exact, once the matched model variant's own terms are counted.
 * - `broader`: the candidate's terms are all in the query, but the query says more.
 * - `narrower`: the query's tokens are all in the candidate, but the candidate says more.
 */
export type MatchKind = 'exact' | 'variant' | 'broader' | 'narrower';

export interface QueryMatch {
  candidate: MatchCandidate;
  match: MatchKind;
  /** The variant bucket the query falls in on a grouped watch (Other when none); null when the candidate has no groups. */
  variantKey: string | null;
  matchedTokens: string[];
  unmatchedTokens: string[];
  /** A leftover query token names a model (a digit, or a word such as "pro" or "ti"), so the candidate likely prices another product. */
  modelTokenUnmatched: boolean;
}

/** Words that change the model rather than describe the item. */
const MODEL_WORDS = new Set(['ti', 'super', 'pro', 'max', 'plus', 'ultra', 'mini', 'lite', 'xt', 'xtx', 'xl', 'air', 'oled', 'digital']);

export function isModelToken(token: string) {
  return /\d/.test(token) || MODEL_WORDS.has(token);
}

export interface MatchOptions {
  /** Comma-separated extra terms the product must have, counted like query tokens. */
  terms?: string;
  /** Comma-separated terms that rule out a candidate whose query or terms contain them. */
  excluded?: string;
}

function spaced(value: string) {
  const text = normalizeFilterText(value);
  return { text, glued: text.replace(/ /g, '') };
}

export function matchQuery(query: string, candidates: MatchCandidate[], options: MatchOptions = {}): QueryMatch[] {
  const extraTerms = splitTerms(options.terms ?? '');
  const title = spaced([query, ...extraTerms].join(' '));
  const tokens = [...new Set([...queryTokens(query), ...extraTerms])];
  const vetoes = splitTerms(options.excluded ?? '');
  const matches: QueryMatch[] = [];
  for (const candidate of candidates) {
    const { included, excluded } = parseIncludedExcluded(candidate.query, candidate.includedTerms, candidate.excludedTerms);
    if (excluded.some((term) => termMatches(title.text, title.glued, term))) continue;
    const own = spaced(`${candidate.query} ${included.join(' ')}`);
    if (vetoes.some((term) => termMatches(own.text, own.glued, term))) continue;
    const required = included.every((term) => termMatches(title.text, title.glued, term));
    const matched = tokens.filter((token) => termMatches(own.text, own.glued, token));
    const unmatched = tokens.filter((token) => !matched.includes(token));
    const variantKey = candidate.groups.length ? assignVariant(title.text, candidate.groups) : null;
    const result = (match: MatchKind, matchedTokens = matched, unmatchedTokens = unmatched): QueryMatch => ({
      candidate, match, variantKey, matchedTokens, unmatchedTokens,
      modelTokenUnmatched: unmatchedTokens.some(isModelToken),
    });
    if (required && !unmatched.length) {
      matches.push(result('exact'));
      continue;
    }
    if (required) {
      const group = variantKey && variantKey !== OTHER_VARIANT_KEY ? candidate.groups.find((entry) => entry.id === variantKey) : undefined;
      const groupTerms = group ? spaced(splitTerms(group.terms).join(' ')) : null;
      if (groupTerms && unmatched.every((token) => termMatches(groupTerms.text, groupTerms.glued, token))) {
        matches.push(result('variant', tokens, []));
      } else {
        matches.push(result('broader'));
      }
      continue;
    }
    if (!unmatched.length) matches.push(result('narrower'));
  }
  return matches;
}

/** 0 for exact and variant, 1 for broader without a model token, 2 for the rest. */
export function matchQuality(match: Pick<QueryMatch, 'match' | 'modelTokenUnmatched'>) {
  if (match.match === 'exact' || match.match === 'variant') return 0;
  if (match.match === 'broader' && !match.modelTokenUnmatched) return 1;
  return 2;
}
