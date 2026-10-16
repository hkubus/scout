/**
 * Pure helpers for the negotiation tools (scout_comparables,
 * scout_listing_detail's negotiation block).
 */
import { listingConditionFromLabel } from '../src/profit';
import { normalizeFilterText } from './text';

export type ConditionClass = 'new' | 'used' | 'damaged';

/**
 * Coarse class of a marketplace condition label, via Scout's own label
 * mapping. OLX says only Nowe/Używane/Uszkodzone, so finer grades (Vinted's
 * "Bardzo dobry" against "Dobry") can't be compared across marketplaces.
 * Null when there is no label or it can't be read.
 */
export function conditionClass(label: string | null | undefined): ConditionClass | null {
  const condition = listingConditionFromLabel(label);
  if (condition === null) return null;
  if (condition === 'damaged') return 'damaged';
  return condition === 'new' || condition === 'new-with-tags' ? 'new' : 'used';
}

/** Whole days since the marketplace's posting time, else since Scout first saw it. */
export function daysListed(postedAt: string | null | undefined, firstSeenAt: string | null | undefined, now = Date.now()) {
  const posted = postedAt ? Date.parse(postedAt) : Number.NaN;
  const since = Number.isFinite(posted) ? posted : firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
  return Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / 86_400_000)) : null;
}

export interface PriceDrops {
  count: number;
  /** Sum of every cut in PLN; rises in between are not netted off. */
  total: number;
  lastAt: string | null;
  /** The first price Scout recorded. */
  firstPrice: number | null;
}

/** Price cuts in a listing's observed history, oldest first; repeated prices are one point. */
export function priceDrops(points: Array<{ price: number; observedAt: string }>): PriceDrops {
  const sorted = points.filter((point) => Number.isFinite(point.price) && point.price > 0)
    .slice().sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  let count = 0;
  let total = 0;
  let lastAt: string | null = null;
  for (let index = 1; index < sorted.length; index += 1) {
    const cut = sorted[index - 1].price - sorted[index].price;
    if (cut >= 0.01) {
      count += 1;
      total += cut;
      lastAt = sorted[index].observedAt;
    }
  }
  return { count, total: Math.round(total * 100) / 100, lastAt, firstPrice: sorted[0]?.price ?? null };
}

/** Jaccard overlap of two titles' normalized words. */
export function titleSimilarity(left: string, right: string) {
  const words = (value: string) => new Set(normalizeFilterText(value).split(' ').filter(Boolean));
  const a = words(left);
  const b = words(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}
