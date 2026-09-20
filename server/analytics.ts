/**
 * Pure aggregation for the cross-watch Analytics page. The service feeds in
 * daily-deduped observations (one latest row per day, watch, and listing) and
 * these helpers reduce them into charts and leaderboards. All "discount"
 * figures compare an asking price to its learned baseline — they are deal
 * heuristics, never confirmed sale prices.
 */

import { median } from './scoring';
import type {
  AnalyticsDiscountBucket,
  AnalyticsMarketplaceDeals,
  AnalyticsOverview,
  AnalyticsTrendPoint,
  AnalyticsWatchLeaderboardRow,
  Marketplace,
} from '../src/types';

export interface AnalyticsObservation {
  day: string;
  listingId: number;
  watchId: string;
  watchName: string;
  marketplace: Marketplace;
  price: number;
  typical: number | null;
  observedAt: string;
  firstSeenAt: string;
}

export const STRONG_DEAL_DISCOUNT_PERCENT = 18;

export function discountPercentFor(row: Pick<AnalyticsObservation, 'price' | 'typical'>): number | null {
  return row.typical !== null && Number.isFinite(row.typical) && row.typical > 0
    ? ((row.typical - row.price) / row.typical) * 100
    : null;
}

function percentile(values: number[], fraction: number): number | null {
  const sorted = values.filter(Number.isFinite).slice().sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function discounts(rows: AnalyticsObservation[]): number[] {
  return rows.map((row) => discountPercentFor(row)).filter((value): value is number => value !== null);
}

/** Latest observation per listing across watches, so a deal is counted once. */
function latestPerListing(observations: AnalyticsObservation[]): AnalyticsObservation[] {
  const latest = new Map<number, AnalyticsObservation>();
  for (const observation of observations) {
    const previous = latest.get(observation.listingId);
    if (!previous || observation.observedAt > previous.observedAt) latest.set(observation.listingId, observation);
  }
  return Array.from(latest.values());
}

export function dealOverview(observations: AnalyticsObservation[], cutoff: string): Omit<AnalyticsOverview, 'scanRuns' | 'scanSuccessRate'> {
  const firstSeen = new Map<number, string>();
  for (const observation of observations) {
    const existing = firstSeen.get(observation.listingId);
    if (!existing || observation.firstSeenAt < existing) firstSeen.set(observation.listingId, observation.firstSeenAt);
  }
  const values = discounts(latestPerListing(observations));
  return {
    trackedListings: firstSeen.size,
    newListings: Array.from(firstSeen.values()).filter((value) => value >= cutoff).length,
    strongDeals: values.filter((value) => value >= STRONG_DEAL_DISCOUNT_PERCENT).length,
    medianDiscountPercent: median(values),
  };
}

export function trendPoints(observations: AnalyticsObservation[]): AnalyticsTrendPoint[] {
  const daily = new Map<string, Map<number, AnalyticsObservation>>();
  for (const observation of observations) {
    const day = daily.get(observation.day) ?? new Map<number, AnalyticsObservation>();
    const previous = day.get(observation.listingId);
    if (!previous || observation.observedAt > previous.observedAt) day.set(observation.listingId, observation);
    daily.set(observation.day, day);
  }
  return Array.from(daily.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([date, rows]) => {
    const list = Array.from(rows.values());
    const prices = list.map((row) => row.price);
    const strongDealCount = list.filter((row) => {
      const discount = discountPercentFor(row);
      return discount !== null && discount >= STRONG_DEAL_DISCOUNT_PERCENT;
    }).length;
    return {
      date,
      medianPrice: median(prices),
      lowerPrice: percentile(prices, 0.25),
      upperPrice: percentile(prices, 0.75),
      listingCount: list.length,
      strongDealCount,
    };
  });
}

export function discountDistribution(observations: AnalyticsObservation[]): AnalyticsDiscountBucket[] {
  const bounds = [
    { label: '<10%', min: -Infinity, max: 10 },
    { label: '10–20%', min: 10, max: 20 },
    { label: '20–30%', min: 20, max: 30 },
    { label: '30–50%', min: 30, max: 50 },
    { label: '≥50%', min: 50, max: Infinity },
  ];
  const buckets = bounds.map((bound) => ({ label: bound.label, count: 0 }));
  const daily = new Map<string, Map<number, AnalyticsObservation>>();
  for (const observation of observations) {
    const day = daily.get(observation.day) ?? new Map<number, AnalyticsObservation>();
    const previous = day.get(observation.listingId);
    if (!previous || observation.observedAt > previous.observedAt) day.set(observation.listingId, observation);
    daily.set(observation.day, day);
  }
  for (const rows of daily.values()) {
    for (const row of rows.values()) {
      const discount = discountPercentFor(row);
      if (discount === null) continue;
      const index = bounds.findIndex((bound) => discount >= bound.min && discount < bound.max);
      if (index !== -1) buckets[index].count += 1;
    }
  }
  return buckets;
}

export function watchLeaderboard(observations: AnalyticsObservation[]): AnalyticsWatchLeaderboardRow[] {
  const byWatch = new Map<string, { watchName: string; listings: Set<number>; latest: Map<number, AnalyticsObservation> }>();
  for (const observation of observations) {
    const entry = byWatch.get(observation.watchId) ?? { watchName: observation.watchName, listings: new Set<number>(), latest: new Map<number, AnalyticsObservation>() };
    entry.listings.add(observation.listingId);
    const previous = entry.latest.get(observation.listingId);
    if (!previous || observation.observedAt > previous.observedAt) entry.latest.set(observation.listingId, observation);
    byWatch.set(observation.watchId, entry);
  }
  return Array.from(byWatch.entries()).map(([watchId, entry]) => {
    const values = discounts(Array.from(entry.latest.values()));
    const lastSeenAt = Array.from(entry.latest.values()).reduce<string | null>(
      (latest, observation) => (latest === null || observation.observedAt > latest ? observation.observedAt : latest),
      null,
    );
    return {
      watchId,
      watchName: entry.watchName,
      listings: entry.listings.size,
      strongDeals: values.filter((value) => value >= STRONG_DEAL_DISCOUNT_PERCENT).length,
      medianDiscountPercent: median(values),
      lastSeenAt,
    };
  }).sort((left, right) => right.strongDeals - left.strongDeals || right.listings - left.listings || left.watchName.localeCompare(right.watchName));
}

export function marketplaceDeals(observations: AnalyticsObservation[]): AnalyticsMarketplaceDeals[] {
  const byMarketplace = new Map<Marketplace, Map<number, AnalyticsObservation>>();
  for (const observation of observations) {
    const listings = byMarketplace.get(observation.marketplace) ?? new Map<number, AnalyticsObservation>();
    const previous = listings.get(observation.listingId);
    if (!previous || observation.observedAt > previous.observedAt) listings.set(observation.listingId, observation);
    byMarketplace.set(observation.marketplace, listings);
  }
  return Array.from(byMarketplace.entries()).map(([marketplace, listings]) => {
    const rows = Array.from(listings.values());
    const values = discounts(rows);
    return {
      marketplace,
      listings: rows.length,
      strongDeals: values.filter((value) => value >= STRONG_DEAL_DISCOUNT_PERCENT).length,
      medianDiscountPercent: median(values),
    };
  }).sort((left, right) => right.listings - left.listings || left.marketplace.localeCompare(right.marketplace));
}
