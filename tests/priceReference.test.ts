import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { scoreDeal } from '../server/scoring';
import { ScoutService } from '../server/service';
import type { PriceReference } from '../src/types';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

/**
 * The rules Hatbot reads `best` by: null, or a named candidate with a positive
 * price, whole sample count and quartiles that bracket the typical price.
 */
function assertBestContract(best: PriceReference['best']) {
  if (best === null) return;
  assert.ok(best.kind === 'watch' || best.kind === 'research');
  assert.ok(typeof best.id === 'string' && best.name.length > 0);
  assert.ok(typeof best.typicalPrice === 'number' && best.typicalPrice > 0);
  assert.ok(best.variant === null || typeof best.variant === 'string');
  assert.ok(Number.isInteger(best.samples) && best.samples >= 4);
  assert.equal(typeof best.ready, 'boolean');
  assert.ok(best.basis.length > 0);
  assert.ok(best.updatedAt === null || !Number.isNaN(Date.parse(best.updatedAt)));
  if (best.p25 !== null) assert.ok(best.p25 <= best.typicalPrice);
  if (best.p75 !== null) assert.ok(best.p75 >= best.typicalPrice);
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-price-reference-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  const priceReference = service.priceReference.bind(service);
  service.priceReference = (input) => {
    const result = priceReference(input);
    assertBestContract(result.best);
    return result;
  };
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const iphoneVariants = [
  { id: 'mini', label: '13 mini', terms: '13, mini' },
  { id: 'base', label: '13', terms: '13' },
  { id: 'pro', label: '13 Pro', terms: '13, pro' },
];
const shape = [0.95, 0.97, 0.98, 0.99, 1, 1, 1, 1, 1.01, 1.02, 1.03, 1.05];
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function seedWatch(db: any, id: string, query: string, overrides: { archived?: boolean; sources?: string[] } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at, archived_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`).run(id, `${id} name`, query, JSON.stringify(overrides.sources ?? ['OLX']), now, now, now, overrides.archived ? now : null);
}

/** Observes each (title, price) once for the watch, `hours` ago. */
function observe(db: any, watchId: string, items: Array<[string, number]>, hours = 8) {
  const at = hoursAgo(hours);
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
  items.forEach(([title, price], index) => {
    const listingId = `${watchId}-${index}`;
    const { lastInsertRowid } = insertListing.run('OLX', listingId, title, price, `https://www.olx.pl/d/oferta/${listingId}`, at, at);
    insertObservation.run(lastInsertRowid, watchId, price, at);
  });
  db.prepare('UPDATE observations SET watch_listing_id = (SELECT wl.id FROM watch_listings wl WHERE wl.watch_id = observations.watch_id AND wl.listing_id = observations.listing_id) WHERE watch_id = ?').run(watchId);
}

function seedVariantWatch(db: any, service: ScoutService, watchId: string) {
  seedWatch(db, watchId, 'iphone 13');
  const items: Array<[string, number]> = [];
  for (const [title, center] of [['iPhone 13 mini', 1500], ['iPhone 13', 2000], ['iPhone 13 Pro', 2600]] as const) {
    for (const ratio of shape) items.push([`${title} 128GB`, center * ratio]);
  }
  observe(db, watchId, items);
  db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify(iphoneVariants), watchId);
  service.retagWatchVariants(watchId);
}

function seedResearch(service: ScoutService, db: any, id: string, query: string) {
  service.createMarketWatch({ id, name: `${id} series`, query, terms: '', excluded: '', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
  return (db.prepare('SELECT active_version_id FROM market_watches WHERE id = ?').get(id) as { active_version_id: string }).active_version_id;
}

function insertMarketListings(db: any, seriesId: string, versionId: string, prices: number[], status: 'active' | 'ended') {
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
  const insert = db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, ended_at, ended_reason)
    VALUES (?, ?, 'OLX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  prices.forEach((price, index) => {
    const listingId = `${seriesId}-${status}-${index}`;
    insert.run(seriesId, versionId, listingId, `Listing ${index}`, `https://www.olx.pl/d/oferta/${listingId}`, price, price, price, daysAgo(2), daysAgo(1), status,
      status === 'ended' ? 3 : 0, status === 'ended' ? daysAgo(1) : null, status === 'ended' ? 'Ad not found.' : null);
  });
}

test('prices a model variant from its own bucket, as a scan would score against it', () => {
  const context = fixture();
  try {
    seedVariantWatch(context.db, context.service, 'iphones');
    const pro = context.service.priceReference({ query: 'iPhone 13 Pro' });
    const proPrices = shape.map((ratio) => 2600 * ratio);
    assert.deepEqual(pro.best, {
      kind: 'watch', id: 'iphones', name: 'iphones name', variant: '13 Pro',
      typicalPrice: scoreDeal(proPrices, 1).typical, p25: 2567.5, p75: 2632.5,
      samples: 12, ready: true, basis: 'asking prices, own history', updatedAt: pro.matches[0].updatedAt,
    });
    assert.deepEqual([pro.matches[0].match, pro.matches[0].variantKey, pro.matches[0].typicalSource], ['variant', 'pro', 'own-history']);
    assert.equal(pro.matches[0].observationHours, 8);
    assert.ok(pro.matches[0].updatedAt);
    assert.deepEqual(pro.notes, ['Asking prices, not completed sales.']);

    assert.deepEqual([context.service.priceReference({ query: 'iphone 13 mini' }).best?.typicalPrice, context.service.priceReference({ query: 'iphone 13' }).best?.typicalPrice], [1500, 2000]);
    // Scans file a Pro Max under Pro, but "max" changes the model, so it is listed and never best.
    const proMax = context.service.priceReference({ query: 'iphone 13 pro max' });
    assert.equal(proMax.best, null);
    assert.deepEqual([proMax.matches[0].match, proMax.matches[0].variantKey, proMax.matches[0].unmatchedTokens], ['broader', 'pro', ['pro', 'max']]);
    // A query the groups cannot place lands in the mixed Other bucket: listed, never best.
    context.db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify(iphoneVariants.filter((group) => group.id !== 'base')), 'iphones');
    context.service.retagWatchVariants('iphones');
    const other = context.service.priceReference({ query: 'iphone 13' });
    assert.equal(other.best, null);
    assert.deepEqual([other.matches[0].match, other.matches[0].variantKey, other.matches[0].variant, other.matches[0].samples], ['exact', '__other__', 'Other / unclassified', 12]);
  } finally { context.close(); }
});

test('an ungrouped watch prices from 4 samples but stays unready below 30', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'gpu', 'rtx 3080');
    observe(context.db, 'gpu', Array.from({ length: 20 }, (_, index) => [`RTX 3080 ${index}`, 2000 + index * 10] as [string, number]));
    const result = context.service.priceReference({ query: 'rtx3080' });
    assert.equal(result.best?.typicalPrice, 2095);
    assert.equal(result.best?.samples, 20);
    assert.equal(result.best?.ready, false);
    assert.equal(result.matches[0].match, 'exact');

    seedWatch(context.db, 'thin', 'gtx 1660');
    observe(context.db, 'thin', [['GTX 1660', 500], ['GTX 1660', 520], ['GTX 1660', 540]]);
    const thin = context.service.priceReference({ query: 'gtx 1660' });
    assert.equal(thin.best, null);
    assert.deepEqual([thin.matches[0].typicalPrice, thin.matches[0].p25, thin.matches[0].samples], [null, null, 3]);
  } finally { context.close(); }
});

test('a broader watch is reported but never best when the query names another model', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'base', 'iphone 13');
    observe(context.db, 'base', shape.map((ratio, index) => [`iPhone 13 ${index}`, 2000 * ratio] as [string, number]));
    const pro = context.service.priceReference({ query: 'iphone 13 pro' });
    assert.equal(pro.best, null);
    assert.deepEqual([pro.matches[0].match, pro.matches[0].unmatchedTokens], ['broader', ['pro']]);
    // A descriptive leftover still prices the product.
    assert.equal(context.service.priceReference({ query: 'iphone 13 czarny' }).best?.typicalPrice, 2000);
  } finally { context.close(); }
});

test('a learning watch falls back to its reference series band, flagged and unready', () => {
  const context = fixture();
  try {
    const version = seedResearch(context.service, context.db, 'ref-series', 'ryzen 5600');
    insertMarketListings(context.db, 'ref-series', version, [100, 200, 300, 400, 500], 'ended');
    seedWatch(context.db, 'cpu', 'ryzen 5600');
    context.db.prepare('UPDATE watches SET reference_market_watch_id = ? WHERE id = ?').run('ref-series', 'cpu');
    const result = context.service.priceReference({ query: 'ryzen 5600', include: ['watch'] });
    assert.deepEqual(result.best && { typicalPrice: result.best.typicalPrice, samples: result.best.samples, ready: result.best.ready, basis: result.best.basis },
      { typicalPrice: 300, samples: 5, ready: false, basis: 'probable-sale band, reference series' });
    assert.equal(result.matches[0].typicalSource, 'reference-band');
    assert.ok(result.notes.some((note) => note.startsWith('Probable-sale bands')));
  } finally { context.close(); }
});

test('research series price from their sale band, else their active asking prices', () => {
  const context = fixture();
  try {
    const banded = seedResearch(context.service, context.db, 'banded', 'steam deck');
    insertMarketListings(context.db, 'banded', banded, [1000, 1100, 1200, 1300, 1400], 'ended');
    const band = context.service.priceReference({ query: 'steam deck' });
    assert.deepEqual(band.best && [band.best.kind, band.best.typicalPrice, band.best.ready, band.best.basis], ['research', 1200, false, 'probable-sale band']);
    assert.equal(band.matches[0].typicalSource, 'probable-sale-band');

    const asking = seedResearch(context.service, context.db, 'asking', 'switch oled');
    insertMarketListings(context.db, 'asking', asking, [900, 950, 1000, 1050], 'active');
    const active = context.service.priceReference({ query: 'switch oled' });
    assert.deepEqual(active.best && [active.best.typicalPrice, active.best.samples, active.best.ready, active.best.basis], [975, 4, false, 'asking prices of active research listings']);
    assert.equal(active.matches[0].typicalSource, 'research-asking');
    assert.equal(context.service.priceReference({ query: 'switch oled', include: ['watch'] }).matches.length, 0);
  } finally { context.close(); }
});

test('ignores archived watches and says when nothing matches', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'old', 'iphone 13', { archived: true });
    observe(context.db, 'old', shape.map((ratio, index) => [`iPhone 13 ${index}`, 2000 * ratio] as [string, number]));
    const result = context.service.priceReference({ query: 'iphone 13' });
    assert.deepEqual(result, { query: 'iphone 13', best: null, matches: [], notes: ['Asking prices, not completed sales.', 'No watch or research series matches this query.'] });
  } finally { context.close(); }
});

test('prefers watches on the requested marketplaces and echoes the request', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'olx', 'ps5', { sources: ['OLX'] });
    observe(context.db, 'olx', [1, 2, 3, 4].map((step) => [`PS5 ${step}`, 1500 + step] as [string, number]));
    seedWatch(context.db, 'vinted', 'ps5', { sources: ['Vinted'] });
    observe(context.db, 'vinted', [1, 2, 3, 4].map((step) => [`PS5 ${step}`, 1800 + step] as [string, number]));
    const result = context.service.priceReference({ query: 'ps5', sources: ['Vinted'], maxPrice: 3000, limit: 1 });
    assert.equal(result.best?.id, 'vinted');
    assert.equal(result.matches.length, 1);
    assert.deepEqual(result.matches[0].filters, { minPrice: null, maxPrice: null, shippingOnly: false, sources: ['Vinted'], requested: { sources: ['Vinted'], minPrice: null, maxPrice: 3000 } });
  } finally { context.close(); }
});
