/**
 * Probable-sale price bands for research listings.
 *
 * Scout never claims confirmed or completed-sale prices. Listings verified as
 * no longer available contribute their last asking price as a *probable sale*
 * estimate. Asking prices that went stale long before the listing disappeared
 * are excluded, because they describe an earlier market, not the exit price.
 */

import type { SaleBand } from '../src/types';

/** A price last seen more than this long before disappearance is a stale asking price. */
export const STALE_LIMIT_DAYS = 30;
/** Below this many eligible samples the band stays open (quartiles are noise). */
export const MIN_BAND_SAMPLES = 4;
const CRITERIA_CHANGE_REASON = 'Research criteria changed';

export interface MarketBandSample {
  price: number;
  lastSeenAt: string;
  endedAt: string;
  endedReason: string | null;
}

function percentile(values: number[], fraction: number): number {
  const sorted = values.slice().sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/**
 * Linear-interpolation percentiles (numpy-default semantics) over eligible
 * samples. Samples outside the ended-at window only affect sampleCount;
 * superseded rows never reach this function (callers filter status = 'ended').
 */
export function computeSaleBand(samples: MarketBandSample[], windowDays: number, now: string): SaleBand {
  const nowMs = Date.parse(now);
  const windowCutoffMs = nowMs - windowDays * 24 * 60 * 60_000;
  const staleCutoffMs = STALE_LIMIT_DAYS * 24 * 60 * 60_000;
  const inWindow = samples.filter((sample) => Date.parse(sample.endedAt) >= windowCutoffMs);
  const validReason = inWindow.filter((sample) => Boolean(sample.endedReason) && sample.endedReason !== CRITERIA_CHANGE_REASON);
  const eligible = validReason.filter((sample) => Number.isFinite(sample.price) && sample.price > 0
    && Date.parse(sample.lastSeenAt) >= Date.parse(sample.endedAt) - staleCutoffMs);
  const prices = eligible.map((sample) => sample.price);
  const quartiles = eligible.length >= MIN_BAND_SAMPLES
    ? { p25: percentile(prices, 0.25), median: percentile(prices, 0.5), p75: percentile(prices, 0.75) }
    : { p25: null, median: null, p75: null };
  return {
    ...quartiles,
    sampleCount: inWindow.length,
    eligibleCount: eligible.length,
    excludedStale: validReason.length - eligible.length,
    windowDays,
    computedAt: new Date(nowMs).toISOString(),
  };
}
