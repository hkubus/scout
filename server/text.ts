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
 * stopwords still filters on what the user typed. A number and the unit after
 * it stay one token ("128 gb").
 */
export function queryTokens(query: string) {
  const tokens = joinQuantities(normalizeFilterText(query).split(/\s+/).filter(Boolean));
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
 * Units that make a number a quantity rather than a model: memory and storage,
 * months of warranty ("12m", "12mc", "12 msc", "12 miesięcy"), days ("14 dni
 * na zwrot"), years, instalments, pieces, camera megapixels and money. Glued
 * straight after the digits ("12gb", "12zł", which normalizes to "12z").
 * Watts, hertz, sizes and mAh are left out on purpose: they are how power
 * supplies, monitors and power banks are named ("zasilacz 650" must still
 * match "650W").
 */
const GLUED_UNIT = /^(?:[kmgt]b[a-z]*|m|mi|mc|mcy|msc|mies[a-z]*|mth|months?|z|zl|pln|mpx?|szt|lat|rat|dni)$/;
/**
 * The same units as the next word ("12 GB", "12 miesięcy"). Polish
 * prepositions are left out, so "z" (złoty, but also "with") never turns
 * "iPhone 12 z etui" into a quantity.
 */
const SPACED_UNIT = /^(?:[kmgt]b|m|mi|mc|mcy|msc|mies[a-z]*|mth|months?|zl|pln|mpx?|szt|lat|lata|rat|raty|dni)$/;

/**
 * Query words where a number is followed by its unit ("128 gb") become one
 * term, so a typed quantity matches "128 GB" and "128gb" rather than being
 * read as model number 128.
 */
function joinQuantities(tokens: string[]) {
  const joined: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const next = tokens[index + 1];
    if (next !== undefined && /^\d+$/.test(tokens[index]) && SPACED_UNIT.test(next)) {
      joined.push(`${tokens[index]} ${next}`);
      index += 1;
    } else {
      joined.push(tokens[index]);
    }
  }
  return joined;
}

/**
 * A pure number names a model ("12" in "iPhone 12", "1660"), so it must land
 * on a digit run boundaried by letters or the token start ("5" matches "5g"
 * and "rtx3080" but not "15"), and that run must not be a quantity: "12"
 * does not match "12gb", "12 GB", "12m" or "12 miesięcy gwarancji", while
 * model suffixes ("1660ti", "2060s", "12400f", "12mini") still match.
 */
function numberMatches(tokens: string[], term: string) {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.includes(term)) continue;
    for (const run of token.matchAll(/(\d+)([a-z]*)/g)) {
      if (run[1] !== term) continue;
      const suffix = run[2];
      if (suffix ? !GLUED_UNIT.test(suffix) : !SPACED_UNIT.test(tokens[index + 1] ?? '')) return true;
    }
  }
  return false;
}

/**
 * One term against one normalized title. Plain substring matching is preserved,
 * but alphanumeric model tokens ("128gb", "rtx3080", "s23ultra") also match the
 * title with its spaces removed, so "128 GB" and "128gb" describe the same
 * offer. The digit requirement keeps the glued form from colliding across word
 * boundaries on ordinary words ("onpro" inside "iphone13pro"). Pure numeric
 * terms are model numbers (see numberMatches); write a quantity with its unit
 * ("128gb") to match it.
 */
export function termMatches(titleSpaced: string, titleGlued: string, term: string) {
  if (!term) return false;
  if (/^\d+$/.test(term)) return numberMatches(titleSpaced.split(' '), term);
  if (titleSpaced.includes(term)) return true;
  const compact = term.replace(/ /g, '');
  return /\d/.test(compact) && compact.length >= 3 && titleGlued.includes(compact);
}
