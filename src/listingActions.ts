import type { Listing, ListingDecision } from "./types";

/** Payload of the server's `listing-action` event (a triage save in any tab or client). */
export type ListingActionEvent = { key: string; decision: ListingDecision | null; hidden: boolean };

export const listingActionKey = (listing: Listing) => listing.marketplaceListingKey ?? listing.id;

export function isListingActionEvent(payload: unknown): payload is ListingActionEvent {
  const event = payload as Partial<ListingActionEvent> | null;
  return Boolean(event && typeof event.key === "string" && typeof event.hidden === "boolean");
}

/**
 * Apply a triage event to loaded rows (one listing can appear once per watch).
 * Returns the same array when nothing changed, so React state updates bail out.
 * The note is not in the event; it arrives with the next reconcile.
 */
export function patchListingRows(rows: Listing[], event: ListingActionEvent): Listing[] {
  let changed = false;
  const next = rows.map((listing) => {
    if (listingActionKey(listing) !== event.key) return listing;
    if ((listing.decision ?? null) === event.decision && Boolean(listing.hidden) === event.hidden) return listing;
    changed = true;
    return { ...listing, decision: event.decision, hidden: event.hidden };
  });
  return changed ? next : rows;
}

/** "none" keeps untriaged rows only. */
export type DecisionFilter = ListingDecision | "All" | "none";

/** The Listings page's server-side decision and visibility filters, applied to one row. */
export function matchesTriageFilters(listing: Listing, decision: DecisionFilter, visibility: "visible" | "hidden" | "all") {
  if (visibility === "visible" && listing.hidden) return false;
  if (visibility === "hidden" && !listing.hidden) return false;
  if (decision === "none") return !listing.decision;
  return decision === "All" || listing.decision === decision;
}

/**
 * Patch a fetched page and drop rows that no longer match its filters, so a
 * hidden listing leaves the "Visible" page at once. Returns the removed count
 * for the page's total; later pages are reconciled by the next refetch.
 */
export function applyListingActionToPage(rows: Listing[], event: ListingActionEvent, decision: DecisionFilter, visibility: "visible" | "hidden" | "all") {
  const patched = patchListingRows(rows, event);
  if (patched === rows) return { rows, removed: 0 };
  const kept = patched.filter((listing) => listingActionKey(listing) !== event.key || matchesTriageFilters(listing, decision, visibility));
  return { rows: kept, removed: patched.length - kept.length };
}
