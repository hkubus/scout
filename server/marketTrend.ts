/**
 * Daily trend buckets for research watches: one latest observation per
 * listing per day, so a 24-hour research cadence and any manual rescans
 * never distort the median. Mirrors the shape of deal-watch analytics so
 * the same chart component can render both.
 */

import { median, pruneBefore } from './scoring';
import type { MarketWatchTrendPoint } from '../src/types';

export interface MarketTrendObservation {
  marketListingId: number;
  price: number;
  observedAt: string;
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

export function bucketDailyObservations(observations: MarketTrendObservation[], days: number, now: string): MarketWatchTrendPoint[] {
  const windowed = pruneBefore(observations, Date.parse(now), Math.max(1, Math.floor(days)));
  const daily = new Map<string, Map<number, MarketTrendObservation>>();
  for (const observation of windowed) {
    const date = observation.observedAt.slice(0, 10);
    const day = daily.get(date) ?? new Map<number, MarketTrendObservation>();
    const previousForDay = day.get(observation.marketListingId);
    if (!previousForDay || observation.observedAt > previousForDay.observedAt) day.set(observation.marketListingId, observation);
    daily.set(date, day);
  }
  return Array.from(daily.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([date, rowsForDay]) => {
    const prices = Array.from(rowsForDay.values()).map((row) => row.price);
    return {
      date,
      medianPrice: median(prices),
      lowerPrice: percentile(prices, 0.25),
      upperPrice: percentile(prices, 0.75),
      listingCount: rowsForDay.size,
    };
  });
}
