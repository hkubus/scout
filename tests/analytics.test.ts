import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dealOverview,
  discountDistribution,
  marketplaceDeals,
  trendPoints,
  watchLeaderboard,
  type AnalyticsObservation,
} from '../server/analytics';

function observation(overrides: Partial<AnalyticsObservation> = {}): AnalyticsObservation {
  return {
    day: '2026-09-01',
    listingId: 1,
    watchId: 'w1',
    watchName: 'Watch 1',
    marketplace: 'OLX',
    price: 100,
    typical: 200,
    observedAt: '2026-09-01T10:00:00.000Z',
    firstSeenAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

test('overview counts each listing once and derives discounts from the baseline', () => {
  const overview = dealOverview([
    observation({ listingId: 1, typical: 100, price: 50 }),
    observation({ listingId: 1, watchId: 'w2', watchName: 'Watch 2', typical: 100, price: 40 }),
    observation({ listingId: 2, typical: 100, price: 90 }),
    observation({ listingId: 3, typical: null, price: 10, firstSeenAt: '2026-09-10T00:00:00.000Z' }),
  ], '2026-09-05T00:00:00.000Z');

  assert.equal(overview.trackedListings, 3);
  assert.equal(overview.newListings, 1);
  // Listing 1 latest observation is 40% below baseline (strong), listing 3 has no baseline.
  assert.equal(overview.strongDeals, 1);
});

test('trend keeps one latest observation per listing per day across watches', () => {
  const points = trendPoints([
    observation({ day: '2026-09-01', listingId: 1, observedAt: '2026-09-01T08:00:00.000Z', price: 100 }),
    observation({ day: '2026-09-01', listingId: 1, watchId: 'w2', observedAt: '2026-09-01T20:00:00.000Z', price: 80 }),
    observation({ day: '2026-09-02', listingId: 1, observedAt: '2026-09-02T09:00:00.000Z', price: 120 }),
    observation({ day: '2026-09-02', listingId: 2, observedAt: '2026-09-02T09:00:00.000Z', price: 180 }),
  ]);

  assert.deepEqual(points.map((point) => point.date), ['2026-09-01', '2026-09-02']);
  assert.equal(points[0].medianPrice, 80);
  assert.equal(points[0].listingCount, 1);
  assert.equal(points[1].medianPrice, 150);
  assert.equal(points[1].listingCount, 2);
});

test('distribution buckets discounted observations and ignores missing baselines', () => {
  const buckets = discountDistribution([
    observation({ listingId: 1, typical: 100, price: 95 }),   // 5%  -> <10%
    observation({ listingId: 2, typical: 100, price: 75 }),   // 25% -> 20–30%
    observation({ listingId: 3, typical: 100, price: 45 }),   // 55% -> ≥50%
    observation({ listingId: 4, typical: null, price: 10 }),  // skipped
  ]);
  assert.deepEqual(buckets.map((bucket) => bucket.count), [1, 0, 1, 0, 1]);
});

test('leaderboard and marketplace rows rank by strong deals and listings', () => {
  const rows = [
    observation({ listingId: 1, watchId: 'w1', watchName: 'Watch 1', marketplace: 'OLX', typical: 100, price: 50 }),
    observation({ listingId: 2, watchId: 'w1', watchName: 'Watch 1', marketplace: 'OLX', typical: 100, price: 90 }),
    observation({ listingId: 3, watchId: 'w2', watchName: 'Watch 2', marketplace: 'Vinted', typical: 100, price: 40 }),
  ];
  const leaderboard = watchLeaderboard(rows);
  assert.deepEqual(leaderboard.map((row) => row.watchId), ['w1', 'w2']);
  assert.equal(leaderboard[0].strongDeals, 1);
  assert.equal(leaderboard[0].listings, 2);
  assert.equal(leaderboard[1].strongDeals, 1);

  const markets = marketplaceDeals(rows);
  const olx = markets.find((row) => row.marketplace === 'OLX');
  assert.equal(olx?.listings, 2);
  assert.equal(olx?.strongDeals, 1);
});
