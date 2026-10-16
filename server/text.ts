/**
 * Shared text normalization for deterministic matching. Kept in one module so
 * the watch include/exclude filters and the model-variant grouping cannot
 * drift apart: both compare normalized, accent-stripped, punctuation-collapsed
 * text.
 */
export function normalizeFilterText(value: string) {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Split a comma-separated term list into normalized, non-empty terms. */
export function splitTerms(raw: string) {
  return raw.split(',').map(normalizeFilterText).filter(Boolean);
}

/** Query filler that carries no product signal on its own (Polish + English). */
export const QUERY_STOPWORDS = new Set([
  'do', 'na', 'w', 'we', 'z', 'ze', 'i', 'oraz', 'dla', 'od', 'po', 'za', 'o', 'a', 'u',
  'the', 'for', 'with', 'and', 'to', 'of', 'in', 'on', 'at', 'by',
]);

/**
 * Implicit query tokens. Single-character digits are kept (so "iphone 5" still
 * constrains the model) while single letters and stopwords are dropped — but
 * only while at least one meaningful token survives, so a query that is all
 * stopwords still filters on what the user typed.
 */
export function queryTokens(query: string) {
  const tokens = normalizeFilterText(query).split(/\s+/).filter(Boolean);
  const meaningful = tokens.filter((term) => (term.length > 1 || /\d/.test(term)) && !QUERY_STOPWORDS.has(term));
  return meaningful.length ? meaningful : tokens;
}

export function parseIncludedExcluded(query: string, includedRaw: string, excludedRaw: string) {
  const explicitTerms = Boolean(includedRaw.trim());
  const included = explicitTerms
    ? includedRaw.split(',').map(normalizeFilterText).filter(Boolean)
    : queryTokens(query);
  const excluded = excludedRaw.split(',').map(normalizeFilterText).filter(Boolean);
  return { included, excluded, explicitTerms };
}

/**
 * One term against one normalized title. Plain substring matching is preserved,
 * but alphanumeric model tokens ("128gb", "rtx3080", "s23ultra") also match the
 * title with its spaces removed, so "128 GB" and "128gb" describe the same
 * offer. The digit requirement keeps the glued form from colliding across word
 * boundaries on ordinary words ("onpro" inside "iphone13pro"). Pure numeric
 * terms must land on a whole token so "5" cannot match "15".
 */
export function termMatches(titleSpaced: string, titleGlued: string, term: string) {
  if (!term) return false;
  // Pure numeric terms must land on a digit run boundaried by letters or the
  // token start, so "5" cannot match "15" but does match "5g" and "rtx3080".
  if (/^\d+$/.test(term)) {
    return titleSpaced.split(' ').some((token) => token.split(/[a-z]+/).includes(term));
  }
  if (titleSpaced.includes(term)) return true;
  const compact = term.replace(/ /g, '');
  return /\d/.test(compact) && compact.length >= 3 && titleGlued.includes(compact);
}
