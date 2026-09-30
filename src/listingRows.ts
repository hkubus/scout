import type { Listing } from "./types";

/** The row identity ListingTable keys by (one listing can appear once per watch). */
export const listingRowKey = (listing: Listing) => listing.associationId ?? listing.id;

/**
 * Flat field-by-field comparison. List payloads carry only primitives per row;
 * a nested value (e.g. a verification object) compares by reference, so a
 * fresh one counts as a change and the row simply re-renders.
 */
export function sameListingFields(a: Listing, b: Listing) {
  if (a === b) return true;
  const aKeys = Object.keys(a) as Array<keyof Listing>;
  if (aKeys.length !== Object.keys(b).length) return false;
  for (const key of aKeys) {
    if (a[key] !== b[key] || !(key in b)) return false;
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
