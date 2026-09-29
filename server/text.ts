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
