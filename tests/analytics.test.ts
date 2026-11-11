import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAnalytics, type AnalyticsRow } from '../server/analytics';
import { legacyAnalyticsSections, type AnalyticsObservation } from './legacyAnalytics';

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

const toRow = (value: AnalyticsObservation): AnalyticsRow => [value.day, value.listingId, value.watchId, value.watchName, value.marketplace, value.price, value.typical, value.observedAt, value.firstSeenAt];
const summarize = (values: AnalyticsObservation[], cutoff = '2026-09-05T00:00:00.000Z') => summarizeAnalytics(values.map(toRow), cutoff);

test('overview counts each listing once and derives discounts from the baseline', () => {
  const { overview } = summarize([
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
  const points = summarize([
    observation({ day: '2026-09-01', listingId: 1, observedAt: '2026-09-01T08:00:00.000Z', price: 100 }),
    observation({ day: '2026-09-01', listingId: 1, watchId: 'w2', observedAt: '2026-09-01T20:00:00.000Z', price: 80 }),
    observation({ day: '2026-09-02', listingId: 1, observedAt: '2026-09-02T09:00:00.000Z', price: 120 }),
    observation({ day: '2026-09-02', listingId: 2, observedAt: '2026-09-02T09:00:00.000Z', price: 180 }),
  ]).trend;

  assert.deepEqual(points.map((point) => point.date), ['2026-09-01', '2026-09-02']);
  assert.equal(points[0].medianPrice, 80);
  assert.equal(points[0].listingCount, 1);
  assert.equal(points[1].medianPrice, 150);
  assert.equal(points[1].listingCount, 2);
});

test('distribution buckets discounted observations and ignores missing baselines', () => {
  const buckets = summarize([
    observation({ listingId: 1, typical: 100, price: 95 }),   // 5%  -> <10%
    observation({ listingId: 2, typical: 100, price: 75 }),   // 25% -> 20–30%
    observation({ listingId: 3, typical: 100, price: 45 }),   // 55% -> ≥50%
    observation({ listingId: 4, typical: null, price: 10 }),  // skipped
  ]).discountDistribution;
  assert.deepEqual(buckets.map((bucket) => bucket.count), [1, 0, 1, 0, 1]);
});

test('leaderboard and marketplace rows rank by strong deals and listings', () => {
  const rows = [
    observation({ listingId: 1, watchId: 'w1', watchName: 'Watch 1', marketplace: 'OLX', typical: 100, price: 50 }),
    observation({ listingId: 2, watchId: 'w1', watchName: 'Watch 1', marketplace: 'OLX', typical: 100, price: 90 }),
    observation({ listingId: 3, watchId: 'w2', watchName: 'Watch 2', marketplace: 'Vinted', typical: 100, price: 40 }),
  ];
  const { watchLeaderboard: leaderboard, marketplaceDeals: markets } = summarize(rows);
  assert.deepEqual(leaderboard.map((row) => row.watchId), ['w1', 'w2']);
  assert.equal(leaderboard[0].strongDeals, 1);
  assert.equal(leaderboard[0].listings, 2);
  assert.equal(leaderboard[1].strongDeals, 1);

  const olx = markets.find((row) => row.marketplace === 'OLX');
  assert.equal(olx?.listings, 2);
  assert.equal(olx?.strongDeals, 1);
});

/** Deterministic PRNG so a failing case can be replayed from its seed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('the single pass gives the per-section helpers\' JSON for random rows, ties and odd values included', () => {
  const marketplaces = ['OLX', 'Vinted', 'Allegro Lokalnie'];
  for (let seed = 1; seed <= 300; seed += 1) {
    const random = mulberry32(seed);
    const pick = <T>(values: T[]) => values[Math.floor(random() * values.length)];
    const watchCount = 1 + Math.floor(random() * 5);
    // Duplicate names exercise the leaderboard's stable sort.
    const watches = Array.from({ length: watchCount }, (_, index) => ({ id: `w${index}`, name: pick(['Alpha', 'Beta', 'Gamma']) }));
    const listingCount = 1 + Math.floor(random() * 40);
    const listings = Array.from({ length: listingCount }, (_, index) => ({
      id: 1000 + index,
      marketplace: pick(marketplaces),
      firstSeenAt: random() < 0.02 ? '' : `2026-09-${String(1 + Math.floor(random() * 20)).padStart(2, '0')}T00:00:00.000Z`,
    }));
    // Few distinct timestamps, so rows of one listing often tie across watches.
    const instants = Array.from({ length: 2 + Math.floor(random() * 8) }, () => `2026-09-${String(1 + Math.floor(random() * 6)).padStart(2, '0')}T${String(Math.floor(random() * 24)).padStart(2, '0')}:00:00.000Z`);
    const seen = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    for (let index = Math.floor(random() * 120); index > 0; index -= 1) {
      const watch = pick(watches);
      const listing = pick(listings);
      const observedAt = pick(instants);
      const day = observedAt.slice(0, 10);
      const key = `${day}|${watch.id}|${listing.id}`;
      if (seen.has(key)) continue; // the SQL groups by day, watch and listing
      seen.add(key);
      const price = pick([50, 99.5, 100, 180, 240, 400, 1200, 3999.99, 0, Number.NaN]);
      const typical = pick([null, null, 0, -5, 100, 200, 250, 480, 1500, 4000, price]);
      rows.push({ day, listing_id: listing.id, watch_id: watch.id, watch_name: watch.name, marketplace: listing.marketplace, price_pln: price, typical_pln: typical, observed_at: observedAt, first_seen_at: listing.firstSeenAt });
    }
    const cutoff = '2026-09-10T00:00:00.000Z';
    const expected = legacyAnalyticsSections(rows, cutoff);
    const actual = summarizeAnalytics(rows.map((row) => Object.values(row) as unknown as AnalyticsRow), cutoff);
    assert.deepStrictEqual(actual, expected, `seed ${seed}`);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `seed ${seed}`);
  }
});
