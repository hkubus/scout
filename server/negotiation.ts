/**
 * Pure helpers for the negotiation tools (scout_comparables,
 * scout_listing_detail's negotiation block, recorded outcomes).
 */
import { listingConditionFromLabel } from '../src/profit';
import type { Marketplace, NegotiationRole, OutcomeShare, PriceReferenceOutcomes, RoleOutcomes } from '../src/types';
import { percentile } from './scoring';
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

/** A final price as a share of the asking price, to 2 decimals. */
export function shareOfAsking(price: number | null, asking: number) {
  return price !== null && price > 0 && asking > 0 ? Math.round((price / asking) * 100) / 100 : null;
}

/**
 * Agreed negotiations a group needs before Scout's screens show its share of
 * asking. The share itself is computed the same way everywhere (as
 * scout_price_reference reports it); below this the screens show the counts.
 */
export const MIN_OUTCOME_AGREED = 3;

/** How a set of recorded negotiations went: how many, how many agreed, and the median share of asking paid. */
export function outcomeShare(rows: Array<{ outcome: string; asking: number; price: number | null }>): OutcomeShare {
  const shares = rows.filter((row) => row.outcome === 'agreed').map((row) => shareOfAsking(row.price, row.asking)).filter((share): share is number => share !== null);
  const median = percentile(shares, 0.5);
  return { negotiations: rows.length, agreed: shares.length, shareOfAsking: median === null ? null : Math.round(median * 100) / 100 };
}

export interface OutcomeRow {
  marketplace: string;
  watchId: string | null;
  role: string;
  outcome: string;
  asking: number;
  price: number | null;
}

/**
 * Recorded negotiations by role: overall, per marketplace (in `order`), and
 * per watch in the order given. Outcomes filed under no listed watch count
 * only in the role and marketplace figures; a role with none is left out.
 */
export function groupOutcomes(rows: OutcomeRow[], watches: Array<{ id: string; name: string }>, order: readonly Marketplace[]): PriceReferenceOutcomes {
  const byMarketplace = (items: OutcomeRow[]) => Object.fromEntries(order
    .filter((source) => items.some((item) => item.marketplace === source))
    .map((source) => [source, outcomeShare(items.filter((item) => item.marketplace === source))])) as RoleOutcomes['marketplaces'];
  const result: PriceReferenceOutcomes = {};
  for (const role of ['buy', 'sell'] as const satisfies readonly NegotiationRole[]) {
    const own = rows.filter((row) => row.role === role);
    if (!own.length) continue;
    result[role] = {
      ...outcomeShare(own),
      marketplaces: byMarketplace(own),
      watches: watches.flatMap((watch) => {
        const items = own.filter((item) => item.watchId === watch.id);
        return items.length ? [{ id: watch.id, name: watch.name, ...outcomeShare(items), marketplaces: byMarketplace(items) }] : [];
      }),
    };
  }
  return result;
}
