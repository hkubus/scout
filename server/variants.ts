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

/**
 * Listings a watch needs before Scout proposes groups on its own. Below this a
 * split would leave each model with too few prices to be worth separating.
 */
export const AUTO_VARIANT_MIN_LISTINGS = 25;
/** Upper bound on generated groups; leaves room for the user to add their own. */
export const AUTO_VARIANT_MAX_GROUPS = 8;

/** One saved listing offered to the suggester: its title and current asking price. */
export interface VariantSample {
  title: string;
  price: number;
}

/** A proposed group before ids are assigned and coverage is checked. */
export interface VariantCandidate {
  label: string;
  terms: string;
}

/** Fewest listings a suggested bucket (named or Other) must hold to count as a split. */
export function minVariantListings(total: number) {
  return Math.max(3, Math.ceil(total * 0.04));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sameTerms(a: string, b: string) {
  return splitTerms(a).sort().join(',') === splitTerms(b).sort().join(',');
}

/**
 * Turn proposed groups into stored ones and keep only those the saved listings
 * actually support. Ids come from `existing` when a proposal has the same
 * terms (so re-suggesting keeps learned baselines), otherwise from the label.
 * Groups that end up holding fewer than {@link minVariantListings} titles are
 * dropped one at a time, smallest first, because removing one can move its
 * titles into another. The result is empty unless at least two buckets
 * (named groups or Other) each hold enough listings to be a real split.
 */
export function finalizeVariantSuggestions(candidates: VariantCandidate[], samples: VariantSample[], existing: VariantGroup[] = []): VariantGroup[] {
  const usedIds = new Set<string>();
  let groups: VariantGroup[] = [];
  for (const candidate of candidates) {
    const label = candidate.label.trim().slice(0, 80);
    const terms = splitTerms(candidate.terms).join(', ');
    if (!label || !terms || groups.some((group) => sameTerms(group.terms, terms))) continue;
    const reused = existing.find((group) => sameTerms(group.terms, terms));
    let id = reused?.id ?? slugify(label).slice(0, 60);
    for (let suffix = 2; usedIds.has(id); suffix += 1) id = `${slugify(label).slice(0, 56)}-${suffix}`;
    usedIds.add(id);
    groups.push({ id, label, terms });
    if (groups.length >= AUTO_VARIANT_MAX_GROUPS) break;
  }
  const minimum = minVariantListings(samples.length);
  for (;;) {
    const counts = new Map<string, number>();
    for (const sample of samples) {
      const key = assignVariant(sample.title, groups);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const weakest = groups
      .map((group) => ({ group, count: counts.get(group.id) ?? 0 }))
      .filter((entry) => entry.count < minimum)
      .sort((a, b) => a.count - b.count)[0];
    if (weakest) {
      groups = groups.filter((group) => group !== weakest.group);
      continue;
    }
    const buckets = [...counts.values()].filter((count) => count >= minimum).length;
    return groups.length && buckets >= 2 ? groups : [];
  }
}

/**
 * Words that follow a model name in marketplace titles without naming a
 * different product: sale wording, condition, and filler in Polish and
 * English. Price separation already rejects most of them; this list stops the
 * common ones from ever becoming candidates.
 */
const NOISE_WORDS = new Set([
  'a', 'an', 'and', 'the', 'with', 'for', 'of', 'in', 'on', 'or', 'to', 'new', 'used', 'sale', 'sell', 'selling', 'mint', 'like', 'original', 'boxed', 'box', 'free', 'shipping', 'bundle', 'set',
  'i', 'w', 'z', 'na', 'do', 'dla', 'od', 'po', 'bez', 'oraz', 'lub', 'jak', 'nowy', 'nowa', 'nowe', 'uzywany', 'uzywana', 'uzywane', 'stan', 'idealny', 'idealna', 'idealnym', 'bdb', 'db', 'igla', 'sprawny', 'sprawna', 'sprawne',
  'sprzedam', 'sprzedaz', 'okazja', 'tanio', 'pilne', 'pilnie', 'zamienie', 'zamiana', 'gwarancja', 'gwarancji', 'faktura', 'fv', 'paragon', 'komplet', 'kompletny', 'zestaw', 'pudelko', 'pudelku', 'karton', 'wysylka', 'oryginalny', 'oryginalna', 'oryginal', 'polecam', 'super', 'extra',
]);

/**
 * Model suffixes that also appear in {@link NOISE_WORDS} as sale filler but
 * are genuine product names right after a model number ("1660 super").
 */
const MODEL_SUFFIXES = new Set(['super']);

function isNoiseWord(token: string, afterAnchor: boolean) {
  if (afterAnchor && MODEL_SUFFIXES.has(token)) return false;
  return NOISE_WORDS.has(token) || (token.length < 2 && !/\d/.test(token));
}

function prettyWord(word: string) {
  if (/\d/.test(word)) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Deterministic suggester used when no AI provider is configured (and as the
 * fallback when it fails). It looks at the word(s) right after the watch's own
 * query terms ("gtx 1660 → super", "iphone 13 → pro max") and keeps those that
 * are common enough to matter, not so common they describe everything, almost
 * always found in that position, and whose listings are priced differently
 * from the rest — the signal that they are a different model rather than
 * sale wording or a spec. A two-word phrase only
 * survives next to its one-word prefix when it is priced differently from
 * that prefix too ("pro max" vs "pro"). When enough titles match none of the
 * suffixes, the plain model becomes its own group so it gets a named
 * baseline instead of sharing Other.
 */
export function suggestVariantGroupsFromTitles(samples: VariantSample[], context: { query: string; terms?: string }): VariantCandidate[] {
  const anchors = new Set(normalizeFilterText(`${context.query} ${(context.terms ?? '').replace(/,/g, ' ')}`).split(' ').filter(Boolean));
  const docs = samples
    .filter((sample) => Number.isFinite(sample.price) && sample.price > 0)
    .map((sample) => ({ tokens: normalizeFilterText(sample.title).split(' ').filter(Boolean), price: sample.price }));
  if (!anchors.size || docs.length < 2) return [];
  const minimum = minVariantListings(docs.length);

  const phraseDocs = new Map<string, Set<number>>();
  const phraseAnchors = new Map<string, Map<string, number>>();
  docs.forEach((doc, index) => {
    doc.tokens.forEach((token, position) => {
      if (!anchors.has(token)) return;
      const next = doc.tokens[position + 1];
      if (!next || anchors.has(next) || isNoiseWord(next, true)) return;
      const phrases = [next];
      const after = doc.tokens[position + 2];
      if (after && !anchors.has(after) && !isNoiseWord(after, false)) phrases.push(`${next} ${after}`);
      for (const phrase of phrases) {
        const set = phraseDocs.get(phrase) ?? new Set<number>();
        set.add(index);
        phraseDocs.set(phrase, set);
        const anchorCounts = phraseAnchors.get(phrase) ?? new Map<string, number>();
        anchorCounts.set(token, (anchorCounts.get(token) ?? 0) + 1);
        phraseAnchors.set(phrase, anchorCounts);
      }
    });
  });

  const priceSeparation = (inside: Set<number>, outside: number[]) => {
    const insideMedian = median([...inside].map((index) => docs[index].price));
    const outsideMedian = median(outside.map((index) => docs[index].price));
    if (insideMedian === null || outsideMedian === null || outsideMedian <= 0) return 0;
    return Math.abs(insideMedian / outsideMedian - 1);
  };
  // A model suffix sits right after the model name; specs such as "6gb" float
  // around the title, so most of their occurrences are elsewhere.
  const titlesContaining = (phrase: string) => docs.filter((doc) => ` ${doc.tokens.join(' ')} `.includes(` ${phrase} `)).length;
  const allIndexes = docs.map((_, index) => index);
  const candidates = [...phraseDocs.entries()]
    .filter(([, set]) => set.size >= minimum && set.size <= docs.length * 0.7)
    .filter(([phrase, set]) => set.size >= titlesContaining(phrase) * 0.75)
    .filter(([, set]) => priceSeparation(set, allIndexes.filter((index) => !set.has(index))) >= 0.1)
    .sort((a, b) => b[1].size - a[1].size || a[0].split(' ').length - b[0].split(' ').length || a[0].localeCompare(b[0]));

  const selected: Array<{ phrase: string; docs: Set<number> }> = [];
  for (const [phrase, set] of candidates) {
    if (selected.length >= AUTO_VARIANT_MAX_GROUPS - 1) break;
    const parent = selected.find((entry) => [...set].filter((index) => entry.docs.has(index)).length >= set.size * 0.8);
    if (parent) {
      // A refinement ("pro max" inside "pro") earns its own group only when it
      // is priced apart from the rest of its parent; anything else overlapping
      // an already chosen suffix is a restatement of it.
      const refines = phrase.startsWith(`${parent.phrase} `);
      const rest = [...parent.docs].filter((index) => !set.has(index));
      if (!refines || rest.length < minimum || priceSeparation(set, rest) < 0.1) continue;
    }
    selected.push({ phrase, docs: set });
  }
  if (!selected.length) return [];

  // Labels use the spelling sellers use most ("GTX", "Ti"), falling back to
  // capitalizing the normalized word.
  const spellings = new Map<string, Map<string, number>>();
  for (const sample of samples) {
    for (const word of sample.title.split(/[^\p{L}\p{N}]+/u)) {
      const normalized = normalizeFilterText(word);
      if (!normalized || normalized.includes(' ')) continue;
      const forms = spellings.get(normalized) ?? new Map<string, number>();
      forms.set(word, (forms.get(word) ?? 0) + 1);
      spellings.set(normalized, forms);
    }
  }
  const spell = (word: string) => {
    const forms = [...(spellings.get(word) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1]);
    return forms[0]?.[0] ?? prettyWord(word);
  };
  const queryWords = normalizeFilterText(context.query).split(' ').filter(Boolean);
  const labelPrefix = (anchor: string) => {
    const position = queryWords.lastIndexOf(anchor);
    return (position >= 0 ? queryWords.slice(0, position + 1) : [anchor]).map(spell).join(' ');
  };
  const suffixAnchors = new Map<string, number>();
  const result: VariantCandidate[] = selected.map(({ phrase, docs: set }) => {
    const anchor = [...(phraseAnchors.get(phrase) ?? new Map<string, number>()).entries()].sort((a, b) => b[1] - a[1])[0][0];
    suffixAnchors.set(anchor, (suffixAnchors.get(anchor) ?? 0) + set.size);
    return { label: `${labelPrefix(anchor)} ${phrase.split(' ').map(spell).join(' ')}`.slice(0, 80), terms: `${anchor} ${phrase}` };
  });

  // The plain model: the query word the suffixes hang off ("1660", not
  // "gtx"), provided nearly every title carries it and enough titles carry
  // none of the chosen suffixes. Declared last so a suffix group wins ties
  // even if the user later shortens its terms.
  const covered = new Set(selected.flatMap((entry) => [...entry.docs]));
  const plain = docs.length - covered.size;
  if (plain >= Math.max(minimum, docs.length * 0.15)) {
    const base = [...anchors]
      .map((anchor) => ({ anchor, count: docs.filter((doc) => doc.tokens.includes(anchor)).length, suffixes: suffixAnchors.get(anchor) ?? 0 }))
      .filter((entry) => entry.count >= docs.length * 0.9)
      .sort((a, b) => b.suffixes - a.suffixes || b.count - a.count)[0];
    if (base) result.push({ label: labelPrefix(base.anchor).slice(0, 80), terms: base.anchor });
  }
  return result;
}
