import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { percentile, scoreDeal } from '../server/scoring';
import { ScoutService } from '../server/service';
import { OTHER_VARIANT_KEY } from '../server/variants';
import type { Watch } from '../src/types';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-watch-typical-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
const round = (value: number | null) => (value === null ? null : Math.round(value * 100) / 100);
const figures = (watch: Watch | undefined) => watch && { typical: watch.typical, typicalSource: watch.typicalSource, p25: watch.p25, p75: watch.p75, robustScale: watch.robustScale };

function seedWatch(db: any, id: string, query = 'steam deck') {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, '["OLX"]', 1, ?, ?, ?)`).run(id, `${id} name`, query, now, now, now);
}

/** One OLX listing per price, each observed once by the watch `hours` ago. */
function observe(db: any, watchId: string, prices: number[], hours = 9, prefix = watchId) {
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
  return prices.map((price, index) => {
    const at = hoursAgo(hours + index / 1000);
    const listingId = `${prefix}-${index}`;
    const { lastInsertRowid } = insertListing.run('OLX', listingId, `Steam Deck ${index}`, price, `https://www.olx.pl/d/oferta/${listingId}`, at, at);
    insertObservation.run(lastInsertRowid, watchId, price, at);
    return Number(lastInsertRowid);
  });
}

function olxResult(id: string, price: number) {
  return async () => ({ status: 200, json: { data: [
    { id, url: `https://www.olx.pl/d/oferta/${id}`, title: 'Steam Deck deal', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: price, currency: 'PLN', negotiable: false } }] },
  ], metadata: { visible_total_count: 1 } } });
}

test('an ungrouped watch reports the typical its scan scored against, with the spread behind it', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'deck');
    const own = Array.from({ length: 34 }, (_, index) => 1000 + ((index * 37) % 9) * 45 - ((index * 11) % 5) * 30);
    observe(context.db, 'deck', own);
    (context.service as any).fetchOlxApi = olxResult('deck-deal', 780);
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('deck'));

    const stored = context.db.prepare("SELECT typical_pln FROM watch_listings WHERE watch_id = 'deck' AND typical_pln IS NOT NULL ORDER BY last_seen_at DESC LIMIT 1").get() as { typical_pln: number };
    const watch = context.service.getWatches().find((item) => item.id === 'deck');
    assert.equal(watch?.typical, stored.typical_pln);
    assert.equal(watch?.typicalSource, 'own-history');

    // The scan's own listing joins the baseline, exactly as the next scan scores.
    const baseline = [...own, 780];
    const score = scoreDeal(baseline, 780, { typicalOverride: stored.typical_pln });
    assert.ok(score.deviation !== null && score.deviation > 0);
    assert.equal(watch?.robustScale, round((stored.typical_pln - 780) / score.deviation!));
    assert.equal(watch?.p25, round(percentile(baseline, 0.25)));
    assert.equal(watch?.p75, round(percentile(baseline, 0.75)));
    assert.ok(watch!.p25! <= watch!.typical! && watch!.typical! <= watch!.p75!);
    assert.deepEqual(figures(context.service.watchById('deck')), figures(watch));
    // The feed's internal lookup skips the figures; the rows are unchanged.
    assert.equal(context.service.listingsPage({}).listings.find((listing) => listing.listingId === 'deck-deal')?.typical, stored.typical_pln);
  } finally { context.close(); }
});

test('the spread uses the same listings and prices a scan scores against', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'deck');
    context.db.prepare('UPDATE watches SET min_price_pln = 500, max_price_pln = 3000 WHERE id = ?').run('deck');
    // Newest first: 100 listings AI relevance rejected, 400 that count, then
    // 10 old outliers that only the newest-400 cap keeps out. Each excluded
    // group would move the quartiles and the scale if it leaked in.
    const prices = Array.from({ length: 510 }, (_, index) => (index < 100 ? 2800 : index >= 500 ? 2900 : 900 + (index % 40) * 10));
    const ids = observe(context.db, 'deck', prices);
    const reject = context.db.prepare(`INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, relevance_status, checked_at)
      VALUES ('deck', 'OLX', ?, 'x', 'test', 0, '', 'irrelevant', ?)`);
    for (let index = 0; index < 100; index += 1) reject.run(`deck-${index}`, hoursAgo(1));
    // A newer out-of-range price leaves a listing on its last in-range price.
    const outOfRange = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (let index = 100; index < 150; index += 1) outOfRange.run(ids[index], 'deck', 9000, hoursAgo(1));
    context.db.prepare("UPDATE watch_listings SET typical_pln = 1100, typical_source = 'own-history' WHERE watch_id = 'deck'").run();

    const watch = context.service.getWatches().find((item) => item.id === 'deck')!;
    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('deck');
    const bucket = (context.service as any).watchBaselines(row).buckets.get(OTHER_VARIANT_KEY);
    assert.deepEqual(bucket.prices, prices.slice(100, 500));
    const scale = (1100 - 1000) / scoreDeal(bucket.prices, 1000, { typicalOverride: 1100 }).deviation!;
    assert.deepEqual(figures(watch), {
      typical: 1100, typicalSource: 'own-history',
      p25: round(percentile(bucket.prices, 0.25)), p75: round(percentile(bucket.prices, 0.75)), robustScale: round(scale),
    });
  } finally { context.close(); }
});

test('a reference-band typical takes its middle half from the research band', async () => {
  const context = fixture();
  try {
    context.service.createMarketWatch({ id: 'ref-series', name: 'Reference series', query: 'steam deck', terms: '', excluded: '', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
    const version = (context.db.prepare('SELECT active_version_id FROM market_watches WHERE id = ?').get('ref-series') as { active_version_id: string }).active_version_id;
    const insertEnded = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, ended_at, ended_reason)
      VALUES ('ref-series', ?, 'OLX', ?, ?, ?, ?, ?, ?, ?, ?, 'ended', 3, ?, 'Ad not found.')`);
    [100, 200, 300, 400, 500].forEach((price, index) => insertEnded.run(version, `ref-${index}`, `Deck ${index}`, `https://www.olx.pl/d/oferta/ref-${index}`, price, price, price, hoursAgo(48), hoursAgo(24), hoursAgo(24)));
    seedWatch(context.db, 'learning');
    context.db.prepare('UPDATE watches SET reference_market_watch_id = ? WHERE id = ?').run('ref-series', 'learning');
    (context.service as any).fetchOlxApi = olxResult('learning-deal', 240);
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('learning'));

    // robustScale still comes from own prices, as scoring computes it: |240 - 300| × 1.4826.
    assert.deepEqual(figures(context.service.watchById('learning')), { typical: 300, typicalSource: 'reference-band', p25: 200, p75: 400, robustScale: round(60 * 1.4826) });
    assert.equal(context.service.watchById('learning')?.status, 'Learning');
  } finally { context.close(); }
});

test('grouped and unscored watches leave the watch-wide figures null', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'grouped', 'iphone 13');
    observe(context.db, 'grouped', [2000, 2100, 2200, 2300]);
    context.db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'pro', label: '13 Pro', terms: 'pro' }]), 'grouped');
    context.service.retagWatchVariants('grouped');
    context.db.prepare("UPDATE watch_listings SET typical_pln = 2150, typical_source = 'own-history' WHERE watch_id = 'grouped'").run();
    seedWatch(context.db, 'fresh');
    observe(context.db, 'fresh', [500, 600, 700]);

    const empty = { typical: null, typicalSource: null, p25: null, p75: null, robustScale: null };
    const watches = context.service.getWatches();
    const grouped = watches.find((item) => item.id === 'grouped');
    assert.deepEqual(figures(grouped), empty);
    assert.equal(grouped?.variants.find((variant) => variant.key === OTHER_VARIANT_KEY)?.typical, 2150);
    assert.deepEqual(figures(watches.find((item) => item.id === 'fresh')), empty);

    // Too few prices for a middle half; the scale still floors at 3.5% of the typical.
    context.db.prepare("UPDATE watch_listings SET typical_pln = 600, typical_source = 'own-history' WHERE watch_id = 'fresh'").run();
    assert.deepEqual(figures(context.service.watchById('fresh')), { typical: 600, typicalSource: 'own-history', p25: null, p75: null, robustScale: round(Math.max(100 * 1.4826, 600 * 0.035)) });
  } finally { context.close(); }
});
