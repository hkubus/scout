import type { Listing } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age: "3 min", "5 h", "2 d", "4 mo", "1 y". */
export function formatAge(iso: string, now = Date.now()) {
  const elapsed = Math.max(0, now - Date.parse(iso));
  if (!Number.isFinite(elapsed)) return null;
  if (elapsed < HOUR) return `${Math.max(1, Math.floor(elapsed / MINUTE))} min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} h`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} d`;
  if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))} mo`;
  return `${Math.floor(elapsed / (365 * DAY))} y`;
}

export type ListingAge = {
  label: string;
  /** Full sentence for tooltips. */
  detail: string;
  freshness: "fresh" | "old" | "normal";
};

/**
 * OLX's "newest" order is really "most recently refreshed", so a listing at
 * the top of a scan can be months old. Shows when it was actually posted,
 * plus a bump when the seller refreshed it well after posting.
 */
export function listingAge(listing: Pick<Listing, "postedAt" | "refreshedAt">, now = Date.now()): ListingAge | null {
  if (!listing.postedAt) return null;
  const posted = formatAge(listing.postedAt, now);
  if (!posted) return null;
  const postedTime = Date.parse(listing.postedAt);
  const refreshedTime = listing.refreshedAt ? Date.parse(listing.refreshedAt) : NaN;
  const bumped = Number.isFinite(refreshedTime) && refreshedTime - postedTime > HOUR ? formatAge(listing.refreshedAt!, now) : null;
  const age = now - postedTime;
  return {
    label: bumped ? `Posted ${posted} ago · bumped ${bumped} ago` : `Posted ${posted} ago`,
    detail: `Posted ${new Date(postedTime).toLocaleString("pl-PL")}${bumped ? `, last refreshed ${new Date(refreshedTime).toLocaleString("pl-PL")}` : ""}`,
    freshness: age < DAY ? "fresh" : age > 30 * DAY ? "old" : "normal",
  };
}
