/**
 * Pure helpers for the negotiation tools (scout_comparables,
 * scout_listing_detail's negotiation block).
 */
import { listingConditionFromLabel } from '../src/profit';

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
