import type { DuplicateSummary, Listing } from "./types";

/** The row identity ListingTable keys by (one listing can appear once per watch). */
export const listingRowKey = (listing: Listing) => listing.associationId ?? listing.id;

type StrongestFields = Pick<Listing, "dealStrength" | "belowTypical" | "observedAt">;

/**
 * The "strongest" order: deal strength, then the deepest discount below
 * typical (rows at or above typical, or without one, count as none), then the
 * newest. GET /api/listings?sort=strongest sorts the same way in SQL, and the
 * iOS ScoutKit's `WidgetSnapshot.strongestFirst` mirrors it.
 */
export function compareStrongest(a: StrongestFields, b: StrongestFields) {
  if (a.dealStrength !== b.dealStrength) return b.dealStrength - a.dealStrength;
  const aBelow = a.belowTypical ?? 0;
  const bBelow = b.belowTypical ?? 0;
  if (aBelow !== bBelow) return aBelow - bBelow;
  return a.observedAt === b.observedAt ? 0 : a.observedAt > b.observedAt ? -1 : 1;
}

/** The cheapest cross-posted copy is a small flat object, so it compares by its fields. */
const sameDuplicateSummary = (a: DuplicateSummary | undefined, b: DuplicateSummary | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.key === b.key && a.marketplace === b.marketplace && a.price === b.price && a.url === b.url && a.observedAt === b.observedAt);

/**
 * Flat field-by-field comparison. List payloads carry only primitives per row,
 * apart from the cheapest-copy summary; another nested value (e.g. a
 * verification object) compares by reference, so a fresh one counts as a
 * change and the row simply re-renders.
 */
export function sameListingFields(a: Listing, b: Listing) {
  if (a === b) return true;
  const aKeys = Object.keys(a) as Array<keyof Listing>;
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (!(key in b)) return false;
    if (key === "duplicateCheapest" ? !sameDuplicateSummary(a.duplicateCheapest, b.duplicateCheapest) : a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * Keep the previous object for every refetched row whose fields did not
 * change, so memoized rows skip and derived lists keep their identity.
 * Returns `previous` itself when every row, and the order, is unchanged.
 */
export function reuseUnchangedListings(previous: Listing[], next: Listing[]): Listing[] {
  if (!previous.length) return next;
  const byKey = new Map<string, Listing>();
  for (const listing of previous) byKey.set(listingRowKey(listing), listing);
  let identical = previous.length === next.length;
  const merged = next.map((listing, index) => {
    const prior = byKey.get(listingRowKey(listing));
    const kept = prior && sameListingFields(prior, listing) ? prior : listing;
    if (kept !== previous[index]) identical = false;
    return kept;
  });
  return identical ? previous : merged;
}

export type PageState = { key: string; page: number };

/**
 * The page to show for the current filters. Any filter change restarts from
 * page 1, and the returned state replaces the stored one, so going back to
 * earlier filters does not bring back the page they were on.
 */
export function pageForFilters(state: PageState, filtersKey: string): PageState {
  return state.key === filtersKey ? state : { key: filtersKey, page: 1 };
}
