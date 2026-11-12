import type { DealLabel, Listing, ListingDecision, ListingDescriptionVerificationStatus, Marketplace, SellerType } from '../src/types';
import type { ScoutService } from './service';
import { MATCH_VISIBILITY_MS } from './service';

/**
 * Deal tiers by name: deal strength 3, 4 and 5. Strong+ is strength 3 and
 * up, the same rule as the dashboard's strong-deals count and the Deals
 * filters (minStrength).
 */
export const DEAL_TIERS = ['strong', 'very-strong', 'exceptional'] as const;
export type DealTier = typeof DEAL_TIERS[number];
export const DEAL_TIER_STRENGTH: Record<DealTier, number> = { strong: 3, 'very-strong': 4, exceptional: 5 };

/** AI description check statuses a feed can be filtered by; `none` means never checked. */
export const LISTING_VERIFICATION_FILTERS = ['pass', 'reject', 'unknown', 'pending', 'not-configured', 'fallback', 'none'] as const;
export type ListingVerificationFilter = typeof LISTING_VERIFICATION_FILTERS[number];

export const DEALS_DEFAULT_LIMIT = 20;
export const DEALS_MAX_LIMIT = 50;

export function dealTierOf(strength: number): DealTier | null {
  return strength >= 5 ? 'exceptional' : strength === 4 ? 'very-strong' : strength === 3 ? 'strong' : null;
}

/** One feed row in the compact form scout_deals and scout_listings' format compact return. */
export interface CompactListing {
  /** `<Marketplace>:<listingId>`. */
  id: string;
  listingId: string;
  source: Marketplace;
  title: string;
  price: number;
  typical: number | null;
  /** Percent below typical, one decimal; negative when above it. */
  discountPercent: number | null;
  tier: DealTier | null;
  dealLabel: DealLabel;
  typicalSource: 'own-history' | 'reference-band' | null;
  /** Whole złoty from reselling at typical on this marketplace after its fee preset, less the price; an estimate. */
  estimatedNet: number | null;
  watchId: string | null;
  watch: string;
  variantKey: string | null;
  variant: string | null;
  url: string;
  /** The listing's photo, for a chart or card; null when it has none. */
  image: string | null;
  condition: string | null;
  location: string | null;
  shippingAvailable: boolean | null;
  negotiable: boolean | null;
  sellerType: SellerType | null;
  postedAt: string | null;
  /** When a watch scan last saw it; typical and tier are as of then. */
  seenAt: string;
  decision: ListingDecision | null;
  verification: ListingDescriptionVerificationStatus | null;
  /** Only on rows you hid. */
  hidden?: true;
}

export function compactListing(listing: Listing): CompactListing {
  const typical = listing.typical !== null && listing.typical > 0 ? listing.typical : null;
  return {
    id: listing.id,
    listingId: listing.listingId ?? listing.id.slice(listing.marketplace.length + 1),
    source: listing.marketplace,
    title: listing.title,
    price: listing.price,
    typical,
    discountPercent: typical === null ? null : Math.round(((typical - listing.price) / typical) * 1000) / 10,
    tier: dealTierOf(listing.dealStrength),
    dealLabel: listing.dealLabel,
    typicalSource: listing.typicalSource ?? null,
    estimatedNet: listing.estimatedNet ?? null,
    watchId: listing.watchId ?? null,
    watch: listing.watch,
    variantKey: listing.variantKey ?? null,
    variant: listing.variantLabel ?? null,
    url: listing.url,
    image: listing.image || null,
    condition: listing.condition ?? null,
    location: listing.location ?? null,
    shippingAvailable: listing.shippingAvailable ?? null,
    negotiable: listing.priceNegotiable ?? null,
    sellerType: listing.sellerType ?? null,
    postedAt: listing.postedAt ?? null,
    seenAt: listing.observedAt,
    decision: listing.decision ?? null,
    verification: listing.aiDescriptionVerificationStatus ?? null,
    ...(listing.hidden ? { hidden: true as const } : {}),
  };
}

export interface DealsInput {
  minTier?: DealTier;
  marketplace?: Marketplace;
  watchId?: string;
  variantKey?: string;
  maxPrice?: number;
  includeRejected?: boolean;
  limit?: number;
}

/**
 * "Strong+ deals right now": the visible feed at the tier and up, without
 * rows you passed or the description check rejected, best first in the Top
 * deals order (strength, then discount, then newest). Database only.
 */
export function dealsForAgent(service: Pick<ScoutService, 'listingsPage'>, input: DealsInput = {}) {
  const minTier = input.minTier ?? 'strong';
  const limit = Math.max(1, Math.min(DEALS_MAX_LIMIT, Math.floor(input.limit ?? DEALS_DEFAULT_LIMIT)));
  const page = service.listingsPage({
    marketplace: input.marketplace,
    watchId: input.watchId,
    variantKey: input.variantKey,
    maxPrice: input.maxPrice,
    minStrength: DEAL_TIER_STRENGTH[minTier],
    excludeRejected: !input.includeRejected,
    excludePassed: true,
    visibility: 'visible',
    sort: 'deal',
    page: 1,
    pageSize: limit,
  });
  return {
    schemaVersion: 1,
    minTier,
    freshHours: MATCH_VISIBILITY_MS / 3_600_000,
    total: page.pagination.total,
    deals: page.listings.map(compactListing),
    notes: [
      'Asking prices, not completed sales; typical and tier are as of each listing\'s last scan (seenAt).',
      'Strong+ is deal strength 3 and up: percent below typical × √(typical / 400 zł) of at least 12 (Very strong 20, Exceptional 30), and at least 8% (13%, 20%) below typical. Scout alerts from 18% below a ready baseline.',
    ],
  };
}
