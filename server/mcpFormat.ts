import type { Listing, ManualSearchResponse, SearchDeal, SearchFilters, SearchScoredAgainst } from '../src/types';
import { SearchConfigError, type Marketplace } from './marketplaces';

/**
 * Compact `scout_search` output for agents (`format: "compact"`). Hatbot and
 * other MCP clients read these keys, so none may be removed or retyped; add
 * keys instead, and bump `schemaVersion` only for a breaking change.
 */
export const COMPACT_SEARCH_SCHEMA_VERSION = 1;

/** relevant: the AI relevance check kept it; unknown: kept unjudged (budget, failure); not-checked: AI off or not configured. */
export type SearchRelevance = 'relevant' | 'unknown' | 'not-checked';
/** strict: every query term matched; relaxed: most terms matched; rescued: a Jev near-miss rescue. */
export type SearchMatch = 'strict' | 'relaxed' | 'rescued';
export type SearchErrorKind = 'timeout' | 'blocked' | 'http' | 'parse' | 'redirect' | 'session' | 'config' | 'unknown';

export interface ManualSearchListingDetail {
  listingId: string;
  relevance: SearchRelevance;
  match: SearchMatch;
  /** `query` today; typo variants would report `typo:<spelling>`. */
  matchedVia: string;
  flags: string[];
}

export interface ManualSearchSourceDetail {
  /** Listings the marketplace returned for the page. */
  fetched: number;
  /** Listings that passed the deterministic filters, plus rescued near-misses. */
  matched: number;
  aiExcluded: number;
  /** Kept without an AI verdict; includes `aiBudgetExhausted`. */
  aiUnknown: number;
  /** The part of `aiUnknown` left unchecked because the per-search AI budget ran out. */
  aiBudgetExhausted: number;
  returned: number;
  truncated: boolean;
  errorKind: SearchErrorKind | null;
}

/** Side tables `manualSearch` fills when given one; the REST response never carries them. */
export interface ManualSearchDetails {
  /** Keyed by listing id (`<Marketplace>:<listingId>`). */
  listings: Map<string, ManualSearchListingDetail>;
  sources: Map<Marketplace, ManualSearchSourceDetail>;
}

export type ManualSearchDetailedResponse = ManualSearchResponse & { details: ManualSearchDetails };

export interface CompactSearchListing {
  id: string;
  listingId: string;
  source: Marketplace;
  title: string;
  /** Asking price in PLN. */
  price: number;
  /** Delivery cost in PLN; no marketplace's is parsed yet, so always null. */
  shipping: number | null;
  shippingAvailable: boolean | null;
  url: string;
  image: string | null;
  sellerType: 'private' | 'business' | null;
  condition: string | null;
  location: string | null;
  negotiable: boolean | null;
  postedAt: string | null;
  refreshedAt: string | null;
  relevance: SearchRelevance;
  match: SearchMatch;
  matchedVia: string;
  flags: string[];
  jevCheck: 'passed' | 'unconfirmed' | 'unchecked' | null;
  jevCheckNote: string | null;
  /** With scoreAgainst: the result priced against the watch, as in the full format; null when not scored. */
  deal: SearchDeal | null;
}

export interface CompactSearchSource {
  source: Marketplace;
  /** Only ever `ok` or `error`; a new failure type is an `errorKind`, never a new status. */
  status: 'ok' | 'error';
  errorKind: SearchErrorKind | null;
  message: string;
  fetched: number;
  matched: number;
  returned: number;
  aiExcluded: number;
  aiUnknown: number;
  aiBudgetExhausted: number;
  truncated: boolean;
  pendingShipping: number;
  durationMs: number;
}

export interface CompactSearch {
  schemaVersion: typeof COMPACT_SEARCH_SCHEMA_VERSION;
  format: 'compact';
  query: string;
  page: number;
  listings: CompactSearchListing[];
  sources: CompactSearchSource[];
  /** With scoreAgainst: the watch the results were scored against; null when none was used. */
  scoredAgainst: SearchScoredAgainst | null;
}

/**
 * A machine-readable kind for a source's search error, from its message.
 * Regex classification of today's throw sites; the first match wins, so
 * `blocked` beats `http` for 401/403/429 and `session` for the Chromium fence
 * message that suggests importing one, and `session` beats `http` for
 * Vinted's cookie bootstrap.
 */
export function searchErrorKind(error: unknown): SearchErrorKind {
  if (error instanceof SearchConfigError) return 'config';
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (/timed out|timeout|closed before completing/i.test(message)) return 'timeout';
  if (/\b(?:HTTP|returned)\s+(?:401|403|429)\b|\bblocked\b|captcha|challenge/i.test(message)) return 'blocked';
  if (/redirect/i.test(message)) return 'redirect';
  if (/session|access token|cookie/i.test(message)) return 'session';
  if (/\b(?:HTTP|returned)\s+\d{3}\b/i.test(message)) return 'http';
  if (/no usable markup|no supported listing|did not contain|not a valid PLN amount/i.test(message)) return 'parse';
  return 'unknown';
}

const EMPTY_SOURCE: ManualSearchSourceDetail = { fetched: 0, matched: 0, aiExcluded: 0, aiUnknown: 0, aiBudgetExhausted: 0, returned: 0, truncated: false, errorKind: null };

function compactListing(listing: Listing, detail: ManualSearchListingDetail | undefined, ownerType: SearchFilters['ownerType']): CompactSearchListing {
  const listingId = detail?.listingId ?? listing.listingId ?? listing.id.slice(listing.id.indexOf(':') + 1);
  return {
    id: listing.id,
    listingId,
    source: listing.marketplace,
    title: listing.title,
    price: listing.price,
    shipping: null,
    shippingAvailable: listing.shippingAvailable ?? null,
    url: listing.url,
    image: listing.image || null,
    // OLX filters owner_type server-side, so its rows are that type even
    // when the offer itself carries no business flag.
    sellerType: listing.sellerType ?? (listing.marketplace === 'OLX' && ownerType ? ownerType : null),
    condition: listing.condition || null,
    location: listing.location || null,
    negotiable: listing.priceNegotiable ?? null,
    postedAt: listing.postedAt ?? null,
    refreshedAt: listing.refreshedAt ?? null,
    relevance: detail?.relevance ?? 'not-checked',
    match: detail?.match ?? 'strict',
    matchedVia: detail?.matchedVia ?? 'query',
    flags: detail?.flags ?? [],
    jevCheck: listing.jevCheck ?? null,
    jevCheckNote: listing.jevCheckNote ?? null,
    deal: listing.deal ?? null,
  };
}

/** The compact `scout_search` payload: every key present, `null` when unknown, listings cheapest first. */
export function toCompactSearch(input: Pick<SearchFilters, 'query' | 'page' | 'ownerType'>, result: ManualSearchDetailedResponse): CompactSearch {
  return {
    schemaVersion: COMPACT_SEARCH_SCHEMA_VERSION,
    format: 'compact',
    query: input.query,
    page: Math.min(Math.max(Math.floor(input.page ?? 1), 1), 10),
    listings: result.listings.map((listing) => compactListing(listing, result.details.listings.get(listing.id), input.ownerType)),
    sources: result.sources.map((status) => {
      const detail = result.details.sources.get(status.source) ?? EMPTY_SOURCE;
      const failed = status.status === 'error';
      return {
        source: status.source,
        status: failed ? 'error' : 'ok',
        errorKind: failed ? detail.errorKind ?? searchErrorKind(status.message) : null,
        message: status.message,
        fetched: detail.fetched,
        matched: detail.matched,
        returned: detail.returned,
        aiExcluded: detail.aiExcluded,
        aiUnknown: detail.aiUnknown,
        aiBudgetExhausted: detail.aiBudgetExhausted,
        truncated: detail.truncated,
        pendingShipping: status.pendingShipping,
        durationMs: status.durationMs,
      };
    }),
    scoredAgainst: result.scoredAgainst ?? null,
  };
}
