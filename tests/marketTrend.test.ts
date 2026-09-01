import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketDailyObservations, type MarketTrendObservation } from '../server/marketTrend';

const NOW = '2026-09-01T12:00:00.000Z';
const at = (day: number, hour = 12) => new Date(Date.parse(NOW) - day * 24 * 60 * 60_000 - 12 * 3_600_000 + hour * 3_600_000).toISOString();

function observation(marketListingId: number, price: number, observedAt: string): MarketTrendObservation {
  return { marketListingId, price, observedAt };
}

test('buckets observations per day, keeping the latest observation per listing', () => {
  const points = bucketDailyObservations([
    observation(1, 1000, at(2, 8)),
    observation(1, 900, at(2, 20)),
    observation(2, 1500, at(2, 9)),
    observation(1, 1200, at(1, 10)),
    observation(2, 1800, at(1, 11)),
  ], 90, NOW);
  assert.deepEqual(points.map((point) => point.date), [at(2).slice(0, 10), at(1).slice(0, 10)]);
  assert.deepEqual(points.map((point) => point.listingCount), [2, 2]);
  // Day one keeps the later (900) observation for listing 1: median 1200.
  // Percentiles interpolate linearly between the two values.
  assert.equal(points[0].medianPrice, (900 + 1500) / 2);
  assert.equal(points[0].lowerPrice, 900 + 0.25 * (1500 - 900));
  assert.equal(points[0].upperPrice, 900 + 0.75 * (1500 - 900));
  assert.equal(points[1].medianPrice, 1500);
});

test('drops observations outside the window and skips days without data', () => {
  const points = bucketDailyObservations([
    observation(1, 100, at(40)),
    observation(2, 200, at(10)),
    observation(3, 300, at(5)),
  ], 30, NOW);
  assert.deepEqual(points.map((point) => point.date), [at(10).slice(0, 10), at(5).slice(0, 10)]);
  assert.deepEqual(points.map((point) => point.medianPrice), [200, 300]);
});

test('handles a single observation and empty input', () => {
  const single = bucketDailyObservations([observation(7, 250, at(0))], 7, NOW);
  assert.deepEqual(single, [{ date: at(0).slice(0, 10), medianPrice: 250, lowerPrice: 250, upperPrice: 250, listingCount: 1 }]);
  assert.deepEqual(bucketDailyObservations([], 90, NOW), []);
});
