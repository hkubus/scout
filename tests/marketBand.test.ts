import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_BAND_SAMPLES, STALE_LIMIT_DAYS, computeSaleBand } from '../server/marketBand';

const NOW = '2026-09-01T12:00:00.000Z';
const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 24 * 60 * 60_000).toISOString();

function sample(price: number, overrides: Partial<{ lastSeenAt: string; endedAt: string; endedReason: string | null }> = {}) {
  return {
    price,
    lastSeenAt: overrides.lastSeenAt ?? daysAgo(1),
    endedAt: overrides.endedAt ?? daysAgo(1),
    endedReason: overrides.endedReason !== undefined ? overrides.endedReason : 'Ad not found.',
  };
}

test('returns an open band for empty or insufficient input', () => {
  const empty = computeSaleBand([], 90, NOW);
  assert.deepEqual(empty, { p25: null, median: null, p75: null, sampleCount: 0, eligibleCount: 0, excludedStale: 0, windowDays: 90, computedAt: NOW });

  const three = computeSaleBand([sample(100), sample(200), sample(300)], 90, NOW);
  assert.deepEqual({ p25: three.p25, median: three.median, p75: three.p75 }, { p25: null, median: null, p75: null });
  assert.equal(three.eligibleCount, 3);
  assert.equal(three.sampleCount, 3);
});

test('computes hand-checked linear-interpolation percentiles', () => {
  // Odd count: percentiles land on samples.
  const odd = computeSaleBand([sample(1000), sample(200), sample(300), sample(400), sample(100)], 90, NOW);
  assert.equal(odd.eligibleCount, 5);
  assert.deepEqual({ p25: odd.p25, median: odd.median, p75: odd.p75 }, { p25: 200, median: 300, p75: 400 });

  // Even count: interpolation between neighbours.
  const even = computeSaleBand([sample(100), sample(200), sample(300), sample(400)], 90, NOW);
  assert.deepEqual({ p25: even.p25, median: even.median, p75: even.p75 }, { p25: 175, median: 250, p75: 325 });

  // Ties collapse to the tied price.
  const ties = computeSaleBand([sample(100), sample(100), sample(100), sample(100)], 90, NOW);
  assert.deepEqual({ p25: ties.p25, median: ties.median, p75: ties.p75 }, { p25: 100, median: 100, p75: 100 });
});

test('excludes stale asking prices and criteria-change rows from eligibility', () => {
  const staleLimit = STALE_LIMIT_DAYS;
  const band = computeSaleBand([
    sample(100),
    sample(200),
    sample(300),
    sample(400),
    // Last seen far before disappearance: a stale asking price, not a sale.
    sample(500, { lastSeenAt: daysAgo(staleLimit + 5), endedAt: daysAgo(1) }),
    // Superseded-style reason and missing reason never count as sales.
    sample(600, { endedReason: 'Research criteria changed' }),
    sample(700, { endedReason: null }),
  ], 90, NOW);
  assert.equal(band.sampleCount, 7);
  assert.equal(band.eligibleCount, 4);
  assert.equal(band.excludedStale, 1);
  assert.deepEqual({ p25: band.p25, median: band.median, p75: band.p75 }, { p25: 175, median: 250, p75: 325 });
});

test('drops samples whose disappearance falls outside the window', () => {
  const band = computeSaleBand([
    sample(100),
    sample(200),
    sample(300),
    sample(400),
    sample(500, { endedAt: daysAgo(181), lastSeenAt: daysAgo(181) }),
  ], 90, NOW);
  assert.equal(band.sampleCount, 4);
  assert.equal(band.eligibleCount, 4);
  assert.equal(MIN_BAND_SAMPLES, 4);
  assert.deepEqual({ p25: band.p25, median: band.median, p75: band.p75 }, { p25: 175, median: 250, p75: 325 });
});
