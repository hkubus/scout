import { normalizeFilterText, splitTerms } from './text';

/**
 * One model bucket inside a watch. A watch searches broadly (e.g. "1660") and
 * these groups split the matches into separately scored products (1660,
 * 1660 Super, 1660 Ti), each with its own learned baseline, readiness, and
 * alerts.
 */
export interface VariantGroup {
  /** Stable identity; renaming the label must not reset the learned baseline. */
  id: string;
  label: string;
  /** Comma-separated terms; every term must be present in the normalized title. */
  terms: string;
  /** Optional comma-separated terms that veto a match. */
  exclude?: string;
}

/** Bucket for listings no group matches. Also the legacy key when groups are empty. */
export const OTHER_VARIANT_KEY = '__other__';
export const OTHER_VARIANT_LABEL = 'Other / unclassified';
export const MAX_VARIANT_GROUPS = 12;

const VARIANT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function safeJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function slugify(value: string) {
  const slug = normalizeFilterText(value).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'variant';
}

/**
 * Validate and normalize a stored or submitted group list. Invalid entries are
 * dropped rather than throwing: a watch must keep working even if one group is
 * malformed. Duplicate ids are ignored and the list is capped.
 */
export function parseVariantGroups(raw: unknown): VariantGroup[] {
  const entries = typeof raw === 'string' ? safeJson(raw) : raw;
  if (!Array.isArray(entries)) return [];
  const groups: VariantGroup[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    const terms = typeof record.terms === 'string' ? record.terms.trim() : '';
    if (!label || !terms) continue;
    const rawId = typeof record.id === 'string' ? record.id.trim() : '';
    let id = VARIANT_ID_PATTERN.test(rawId) ? rawId : slugify(label);
    if (seen.has(id)) continue;
    const exclude = typeof record.exclude === 'string' ? record.exclude.trim() : '';
    seen.add(id);
    groups.push({ id, label: label.slice(0, 80), terms, ...(exclude ? { exclude } : {}) });
    if (groups.length >= MAX_VARIANT_GROUPS) break;
  }
  return groups;
}

/**
 * "Specificity" is the number of normalized words across the required terms,
 * not the number of comma-separated terms: "1660 super" is a single substring
 * term but describes a strictly narrower model than "1660".
 */
function termWeight(terms: string) {
  return splitTerms(terms).reduce((total, term) => total + term.split(' ').filter(Boolean).length, 0);
}

function mostSpecificFirst(groups: VariantGroup[]) {
  return groups
    .map((group, index) => ({ group, index, weight: termWeight(group.terms) }))
    .sort((a, b) => b.weight - a.weight || a.index - b.index)
    .map((entry) => entry.group);
}

/**
 * Assign a listing title to a group id. Most-specific-first (more required
 * terms wins, declared order breaks ties) so "1660 super" beats "1660"
 * without the user having to order the groups. Unmatched titles fall into
 * {@link OTHER_VARIANT_KEY}.
 */
export function assignVariant(title: string, groups: VariantGroup[]): string {
  if (!groups.length) return OTHER_VARIANT_KEY;
  const normalized = normalizeFilterText(title);
  for (const group of mostSpecificFirst(groups)) {
    const required = splitTerms(group.terms);
    if (!required.length) continue;
    const excluded = splitTerms(group.exclude ?? '');
    if (required.every((term) => normalized.includes(term)) && !excluded.some((term) => normalized.includes(term))) {
      return group.id;
    }
  }
  return OTHER_VARIANT_KEY;
}

/** Human label for an assigned key; falls back to the unclassified label. */
export function variantLabelFor(key: string, groups: VariantGroup[]): string {
  return groups.find((group) => group.id === key)?.label ?? OTHER_VARIANT_LABEL;
}
