import type { Listing, MarketTrackedListing, Marketplace, MarketWatchInput, OlxCategory, SellerType } from "./types";

export type WatchPreset = {
  query: string;
  terms: string;
  excluded: string;
  sources: Marketplace[];
  condition: string;
  minPrice: number | null;
  maxPrice: number | null;
  shippingOnly: boolean;
  /** Carry the search's AI-relevance choice into the new watch. */
  aiRelevance?: boolean;
  /** Carry the search's OLX category scope into the new watch. */
  olxCategory?: OlxCategory | null;
  /** Carry the search's seller filter into the new watch. */
  sellerType?: SellerType | null;
};

/** Polish cities commonly appended to marketplace titles; stripped from prefilled queries. */
const TITLE_LOCATION_TOKENS = new Set([
  "białystok", "bialystok", "bydgoszcz", "bytom", "częstochowa", "czestochowa",
  "elbląg", "elblag", "gdańsk", "gdansk", "gdynia", "gliwice", "katowice", "kielce",
  "koszalin", "kraków", "krakow", "legnica", "lublin", "łódź", "lodz", "olsztyn",
  "opole", "płock", "plock", "poznań", "poznan", "radom", "rzeszów", "rzeszow",
  "sosnowiec", "szczecin", "słupsk", "slupsk", "sopot", "tarnów", "tarnow",
  "toruń", "torun", "warszawa", "wrocław", "wroclaw", "zabrze", "zielona góra", "zielona gora",
]);

const TITLE_STOPWORDS = new Set(["sprzedam", "okazja", "promocja", "tanio", "tania", "tani", "cena"]);

const PRICE_TOKEN = /\b\d{1,3}(?:[ \u00a0]\d{3})*(?:[.,]\d{1,2})?\s*(?:zł|zl|pln)\b\.?/gi;

function roundTo5(value: number) {
  return Math.round(value / 5) * 5;
}

function priceBand(price: number): { minPrice: number | null; maxPrice: number | null } {
  return {
    minPrice: Math.max(0, roundTo5(price * 0.75)),
    maxPrice: roundTo5(price * 1.25),
  };
}

/**
 * Deterministic, side-effect-free query guess from a marketplace title:
 * drops price-looking tokens, Polish sale stopwords, and trailing city names,
 * then collapses whitespace. Used only to prefill dialogs the user still edits.
 */
export function titleQueryFromText(title: string): string {
  return title
    .replace(PRICE_TOKEN, " ")
    .split(/[\s·•|,;]+/)
    .map((token) => token.trim())
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .filter((token) => {
      const lowered = token.toLowerCase().replace(/[.]+$/, "");
      return !TITLE_STOPWORDS.has(lowered) && !TITLE_LOCATION_TOKENS.has(lowered);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Prefill for a deal watch, built only from already-stored listing data. */
export function watchPresetFromListing(listing: Listing): WatchPreset {
  const price = Number.isFinite(listing.price) && listing.price > 0 ? listing.price : null;
  return {
    query: titleQueryFromText(listing.title),
    terms: "",
    excluded: "",
    sources: [listing.marketplace],
    condition: "Any",
    minPrice: price === null ? null : priceBand(price).minPrice,
    maxPrice: price === null ? null : priceBand(price).maxPrice,
    shippingOnly: listing.shippingAvailable === true,
  };
}

/** Same prefill shape for a research watch, anchored on the listing's last asking price. */
export function marketWatchInputFromListing(listing: MarketTrackedListing): MarketWatchInput {
  const price = Number.isFinite(listing.lastPrice) && listing.lastPrice > 0 ? listing.lastPrice : null;
  const query = titleQueryFromText(listing.title);
  const band = price === null ? { minPrice: null, maxPrice: null } : priceBand(price);
  return {
    name: query ? `${query} market` : listing.title.slice(0, 80),
    query,
    terms: "",
    excluded: "",
    condition: "Any",
    sources: [listing.marketplace],
    intervalHours: 24,
    minPrice: band.minPrice,
    maxPrice: band.maxPrice,
    shippingOnly: false,
    typoVariants: false,
  };
}
