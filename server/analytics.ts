/**
 * Pure aggregation for the cross-watch Analytics page. The service feeds in
 * daily-deduped observations (one latest row per day, watch, and listing) and
 * summarizeAnalytics reduces them into charts and leaderboards in one pass.
 * All "discount" figures compare an asking price to its learned baseline —
 * they are deal heuristics, never confirmed sale prices.
 */

import { dealStrength, median, percentile } from './scoring';
import type {
  AnalyticsDiscountBucket,
  AnalyticsMarketplaceDeals,
  AnalyticsOverview,
  AnalyticsTrendPoint,
  AnalyticsWatchLeaderboardRow,
  Marketplace,
} from '../src/types';

/**
 * One daily-deduped observation in the column order of the service's
 * analytics SQL, read positionally (StatementSync#setReturnArrays). Values are
 * raw SQLite values; the tables are not STRICT, so they are converted here.
 */
export type AnalyticsRow = readonly [
  day: unknown,
  listingId: unknown,
  watchId: unknown,
  watchName: unknown,
  marketplace: unknown,
  price: unknown,
  typical: unknown,
  observedAt: unknown,
  firstSeenAt: unknown,
];

const DAY = 0;
const LISTING_ID = 1;
const WATCH_ID = 2;
const WATCH_NAME = 3;
const MARKETPLACE = 4;
const PRICE = 5;
const TYPICAL = 6;
const OBSERVED_AT = 7;
const FIRST_SEEN_AT = 8;

export interface AnalyticsSummary {
  overview: Omit<AnalyticsOverview, 'scanRuns' | 'scanSuccessRate'>;
  trend: AnalyticsTrendPoint[];
  discountDistribution: AnalyticsDiscountBucket[];
  watchLeaderboard: AnalyticsWatchLeaderboardRow[];
  marketplaceDeals: AnalyticsMarketplaceDeals[];
}

const DISCOUNT_BUCKETS = [
  { label: '<10%', min: -Infinity, max: 10 },
  { label: '10–20%', min: 10, max: 20 },
  { label: '20–30%', min: 20, max: 30 },
  { label: '30–50%', min: 30, max: 50 },
  { label: '≥50%', min: 50, max: Infinity },
];

const priceOf = (row: AnalyticsRow) => Number(row[PRICE]);
const typicalOf = (row: AnalyticsRow) => (row[TYPICAL] === null || row[TYPICAL] === undefined ? null : Number(row[TYPICAL]));

/** Strong or better on the feed's deal-strength scale, so every "strong" count means the same thing. */
function isStrongDeal(price: number, typical: number | null): boolean {
  return (dealStrength(price, typical) ?? 0) >= 3;
}

function discountPercent(price: number, typical: number | null): number | null {
  return typical !== null && Number.isFinite(typical) && typical > 0
    ? ((typical - price) / typical) * 100
    : null;
}

/**
 * Builds every deal section from the grouped rows, read once in SQL order.
 * A row replaces the kept one only when its observedAt is strictly later, so
 * the first row wins ties. The pass keeps, per listing, the latest row across
 * watches and the earliest first-seen time (overview, and the marketplace
 * split, since a listing belongs to one marketplace); per day, the latest row
 * per listing (trend and distribution); and per watch, the latest row per
 * listing (leaderboard).
 */
export function summarizeAnalytics(rows: readonly AnalyticsRow[], cutoff: string): AnalyticsSummary {
  const listings = new Map<number, { latest: AnalyticsRow; latestAt: string; firstSeenAt: string }>();
  const days = new Map<string, Map<number, AnalyticsRow>>();
  const watches = new Map<string, { watchName: string; latest: Map<number, AnalyticsRow>; lastSeenAt: string | null }>();
  for (const row of rows) {
    const listingId = Number(row[LISTING_ID]);
    const observedAt = String(row[OBSERVED_AT]);
    const firstSeenAt = String(row[FIRST_SEEN_AT]);
    const listing = listings.get(listingId);
    if (!listing) listings.set(listingId, { latest: row, latestAt: observedAt, firstSeenAt });
    else {
      if (observedAt > listing.latestAt) { listing.latest = row; listing.latestAt = observedAt; }
      if (!listing.firstSeenAt || firstSeenAt < listing.firstSeenAt) listing.firstSeenAt = firstSeenAt;
    }

    const day = String(row[DAY]);
    let daily = days.get(day);
    if (!daily) days.set(day, (daily = new Map()));
    const sameDay = daily.get(listingId);
    if (!sameDay || observedAt > String(sameDay[OBSERVED_AT])) daily.set(listingId, row);

    const watchId = String(row[WATCH_ID]);
    let watch = watches.get(watchId);
    if (!watch) watches.set(watchId, (watch = { watchName: String(row[WATCH_NAME]), latest: new Map(), lastSeenAt: null }));
    const sameWatch = watch.latest.get(listingId);
    if (!sameWatch || observedAt > String(sameWatch[OBSERVED_AT])) watch.latest.set(listingId, row);
    if (watch.lastSeenAt === null || observedAt > watch.lastSeenAt) watch.lastSeenAt = observedAt;
  }

  const discounts: number[] = [];
  let strongDeals = 0;
  let newListings = 0;
  const markets = new Map<Marketplace, { listings: number; strongDeals: number; discounts: number[] }>();
  for (const listing of listings.values()) {
    if (listing.firstSeenAt >= cutoff) newListings += 1;
    const price = priceOf(listing.latest);
    const typical = typicalOf(listing.latest);
    const strong = isStrongDeal(price, typical);
    const discount = discountPercent(price, typical);
    if (strong) strongDeals += 1;
    if (discount !== null) discounts.push(discount);
    const marketplace = listing.latest[MARKETPLACE] as Marketplace;
    let market = markets.get(marketplace);
    if (!market) markets.set(marketplace, (market = { listings: 0, strongDeals: 0, discounts: [] }));
    market.listings += 1;
    if (strong) market.strongDeals += 1;
    if (discount !== null) market.discounts.push(discount);
  }

  const buckets = DISCOUNT_BUCKETS.map((bucket) => ({ label: bucket.label, count: 0 }));
  const trend = Array.from(days.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([date, latest]) => {
    const prices: number[] = [];
    let strongDealCount = 0;
    for (const row of latest.values()) {
      const price = priceOf(row);
      const typical = typicalOf(row);
      prices.push(price);
      if (isStrongDeal(price, typical)) strongDealCount += 1;
      const discount = discountPercent(price, typical);
      if (discount === null) continue;
      const index = DISCOUNT_BUCKETS.findIndex((bucket) => discount >= bucket.min && discount < bucket.max);
      if (index !== -1) buckets[index].count += 1;
    }
    return {
      date,
      medianPrice: median(prices),
      lowerPrice: percentile(prices, 0.25),
      upperPrice: percentile(prices, 0.75),
      listingCount: latest.size,
      strongDealCount,
    };
  });

  const watchLeaderboard = Array.from(watches.entries()).map(([watchId, watch]) => {
    const watchDiscounts: number[] = [];
    let watchStrongDeals = 0;
    for (const row of watch.latest.values()) {
      const price = priceOf(row);
      const typical = typicalOf(row);
      if (isStrongDeal(price, typical)) watchStrongDeals += 1;
      const discount = discountPercent(price, typical);
      if (discount !== null) watchDiscounts.push(discount);
    }
    return {
      watchId,
      watchName: watch.watchName,
      listings: watch.latest.size,
      strongDeals: watchStrongDeals,
      medianDiscountPercent: median(watchDiscounts),
      lastSeenAt: watch.lastSeenAt,
    };
  }).sort((left, right) => right.strongDeals - left.strongDeals || right.listings - left.listings || left.watchName.localeCompare(right.watchName));

  const marketplaceDeals = Array.from(markets.entries()).map(([marketplace, market]) => ({
    marketplace,
    listings: market.listings,
    strongDeals: market.strongDeals,
    medianDiscountPercent: median(market.discounts),
  })).sort((left, right) => right.listings - left.listings || left.marketplace.localeCompare(right.marketplace));

  return {
    overview: {
      trackedListings: listings.size,
      newListings,
      strongDeals,
      medianDiscountPercent: median(discounts),
    },
    trend,
    discountDistribution: buckets,
    watchLeaderboard,
    marketplaceDeals,
  };
}
