import type { Listing, Marketplace } from "./types";

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

const SHORT_MARKETPLACE: Record<Marketplace, string> = { OLX: "OLX", "Allegro Lokalnie": "Allegro", Vinted: "Vinted" };

const zl = (value: number) => `${value.toLocaleString("pl-PL")} zł`;

export type CrossPostChip = {
  text: string;
  /** Full sentence for tooltips. */
  detail: string;
  /** Another marketplace has it for less. */
  cheaper: boolean;
};

/**
 * The feed chip for a listing's likely copies on other marketplaces: what the
 * cheapest saves ("Vinted −50 zł", "2× · Vinted −50 zł"), or that this one is
 * already the cheapest. Null when Scout knows no copy.
 */
export function crossPostChip(listing: Pick<Listing, "price" | "duplicateCount" | "duplicateCheapest">): CrossPostChip | null {
  const count = listing.duplicateCount ?? 0;
  const cheapest = listing.duplicateCheapest;
  if (count < 1 || !cheapest) return null;
  const caveat = "Matched by title, price, condition and place, not photos: check it is the same item.";
  const saving = Math.round(listing.price - cheapest.price);
  const copies = count === 1 ? "another listing" : `${count} other listings`;
  if (saving >= 1) {
    return {
      text: `${count > 1 ? `${count}× · ` : ""}${SHORT_MARKETPLACE[cheapest.marketplace]} −${zl(saving)}`,
      detail: `Possibly the same item as ${copies}; the cheapest is ${zl(cheapest.price)} on ${cheapest.marketplace}, ${zl(saving)} less. ${caveat}`,
      cheaper: true,
    };
  }
  return {
    text: count === 1 ? `Also on ${SHORT_MARKETPLACE[cheapest.marketplace]}` : `${count}× elsewhere`,
    detail: `Possibly the same item as ${copies} (${count === 1 ? `${zl(cheapest.price)} on ${cheapest.marketplace}` : `from ${zl(cheapest.price)}`}); this one is the cheapest. ${caveat}`,
    cheaper: false,
  };
}
