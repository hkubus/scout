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

/**
 * Said wherever two asking prices are compared and either listing is on
 * Vinted: its buyer pays a buyer-protection fee and shipping on top, so a
 * lower Vinted asking price can still cost more overall.
 */
export const VINTED_FEES_NOTE = "Asking prices only: Vinted's buyer-protection fee and shipping aren't included.";

/** VINTED_FEES_NOTE when any of the compared listings is on Vinted, else null. */
export function vintedFeesNote(...marketplaces: string[]) {
  return marketplaces.includes("Vinted") ? VINTED_FEES_NOTE : null;
}

/** A copy's asking price against this listing's: "asks 30 zł less", "asks 30 zł more" or "same asking price". */
export function askingPriceComparison(copyPrice: number, price: number) {
  const difference = Math.round(copyPrice - price);
  if (difference === 0) return "same asking price";
  return `asks ${zl(Math.abs(difference))} ${difference < 0 ? "less" : "more"}`;
}

export type CrossPostChip = {
  text: string;
  /** Full sentence for tooltips. */
  detail: string;
  /** Another marketplace asks less for it. */
  cheaper: boolean;
};

/**
 * The feed chip for a listing's likely copies on other marketplaces, from
 * the copies seen in the last 3 days: how much less the cheapest asks
 * ("Vinted asks 50 zł less", "2× · Vinted asks 50 zł less"), or that this one
 * already asks the least. Fees are not modelled, so the tooltip says when
 * Vinted's are left out. Null when Scout knows no copy.
 */
export function crossPostChip(listing: Pick<Listing, "marketplace" | "price" | "duplicateCount" | "duplicateCheapest">, now = Date.now()): CrossPostChip | null {
  const count = listing.duplicateCount ?? 0;
  const cheapest = listing.duplicateCheapest;
  if (count < 1 || !cheapest) return null;
  const caveats = [vintedFeesNote(listing.marketplace, cheapest.marketplace), "Matched by title, price, condition and place, not photos: check it is the same item."].filter(Boolean).join(" ");
  const seen = formatAge(cheapest.observedAt, now);
  const where = `${cheapest.marketplace}${seen ? ` (seen ${seen} ago)` : ""}`;
  const saving = Math.round(listing.price - cheapest.price);
  const copies = count === 1 ? "another listing" : `${count} other listings`;
  if (saving >= 1) {
    return {
      text: `${count > 1 ? `${count}× · ` : ""}${SHORT_MARKETPLACE[cheapest.marketplace]} asks ${zl(saving)} less`,
      detail: `Possibly the same item as ${copies}; the lowest asking price is ${zl(cheapest.price)} on ${where}, ${zl(saving)} less. ${caveats}`,
      cheaper: true,
    };
  }
  return {
    text: count === 1 ? `Also on ${SHORT_MARKETPLACE[cheapest.marketplace]}` : `${count}× elsewhere`,
    detail: `Possibly the same item as ${copies} (${count === 1 ? `${zl(cheapest.price)} on ${where}` : `from ${zl(cheapest.price)}`}); this one asks the least. ${caveats}`,
    cheaper: false,
  };
}
