import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { conditionClass, daysListed } from '../server/negotiation';
import { ScoutService } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-comparables-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const iphoneVariants = [
  { id: 'mini', label: '13 mini', terms: '13, mini' },
  { id: 'base', label: '13', terms: '13' },
  { id: 'pro', label: '13 Pro', terms: '13, pro' },
];
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function seedWatch(db: any, id: string, query: string, overrides: { sources?: string[]; groups?: unknown[]; intervalMinutes?: number } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, interval_minutes, variant_groups_json, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(id, `${id} name`, query, JSON.stringify(overrides.sources ?? ['OLX', 'Vinted']), overrides.intervalMinutes ?? 15,
    JSON.stringify(overrides.groups ?? []), now, now, now);
}

type Seed = { id: string; title: string; price: number; marketplace?: string; condition?: string | null; location?: string; shipping?: number | null; postedAt?: string | null; firstSeenHours?: number; seenHours?: number };

/** Stores a listing; with a watch id, also observes it for that watch `seenHours` ago. */
function seedListing(db: any, watchId: string | null, seed: Seed) {
  const seenAt = hoursAgo(seed.seenHours ?? 1);
  const firstSeen = hoursAgo(seed.firstSeenHours ?? 48);
  const marketplace = seed.marketplace ?? 'OLX';
  const { lastInsertRowid } = db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, condition, location, shipping_available, posted_at, first_seen_at, last_seen_at, availability_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`).run(marketplace, seed.id, seed.title, seed.price, `https://example.test/${seed.id}`, seed.condition === undefined ? 'Używane' : seed.condition,
    seed.location ?? 'Kraków', seed.shipping === undefined ? 1 : seed.shipping, seed.postedAt ?? null, firstSeen, seenAt);
  if (watchId) db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(lastInsertRowid, watchId, seed.price, seenAt);
  return lastInsertRowid;
}

test('condition classes and days listed', () => {
  assert.deepEqual(['Używane', 'Bardzo dobry', 'Dobry', 'Nowe', 'Nowy z metką', 'Uszkodzone', 'Zadowalający', '', null].map(conditionClass),
    ['used', 'used', 'used', 'new', 'new', 'damaged', 'damaged', null, null]);
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.equal(daysListed('2026-10-01T12:00:00Z', '2026-10-10T00:00:00Z', now), 15);
  assert.equal(daysListed(null, '2026-10-10T00:00:00Z', now), 6);
  assert.equal(daysListed(null, null, now), null);
});

test('lists active same-variant, same-condition listings cheapest first, with the median', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'iphones', 'iphone 13', { groups: iphoneVariants });
    seedListing(context.db, 'iphones', { id: 'subject', title: 'iPhone 13 Pro 128GB', price: 2300 });
    seedListing(context.db, 'iphones', { id: 'p1', title: 'iPhone 13 Pro 256GB', price: 2400, postedAt: hoursAgo(24 * 30), location: 'Gdańsk', shipping: 0 });
    seedListing(context.db, 'iphones', { id: 'p2', title: 'iPhone 13 Pro grafitowy', price: 2100, firstSeenHours: 24 * 3 + 1 });
    seedListing(context.db, 'iphones', { id: 'p3', title: 'iPhone 13 Pro', price: 2600, marketplace: 'Vinted', condition: 'Bardzo dobry', shipping: null });
    seedListing(context.db, 'iphones', { id: 'p4', title: 'iPhone 13 Pro bateria 90%', price: 2500 });
    // Each of these is excluded by one rule.
    seedListing(context.db, 'iphones', { id: 'new', title: 'iPhone 13 Pro nowy', price: 3200, condition: 'Nowe' });
    seedListing(context.db, 'iphones', { id: 'base', title: 'iPhone 13 128GB', price: 1900 });
    seedListing(context.db, 'iphones', { id: 'stale', title: 'iPhone 13 Pro', price: 1500, seenHours: 20 });
    seedListing(context.db, 'iphones', { id: 'hidden', title: 'iPhone 13 Pro', price: 1600 });
    seedListing(context.db, 'iphones', { id: 'irrelevant', title: 'iPhone 13 Pro etui', price: 50 });
    seedListing(context.db, 'iphones', { id: 'rejected', title: 'iPhone 13 Pro blokada', price: 1200 });
    seedListing(context.db, 'iphones', { id: 'ended', title: 'iPhone 13 Pro', price: 1300 });
    seedListing(context.db, 'iphones', { id: 'unknown-condition', title: 'iPhone 13 Pro', price: 1400, condition: null });
    context.service.retagWatchVariants('iphones');
    context.db.prepare("INSERT INTO listing_actions (marketplace, listing_id, decision, note, hidden, updated_at) VALUES ('OLX', 'hidden', NULL, '', 1, ?)").run(hoursAgo(0));
    context.db.prepare("INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, checked_at, relevance_status) VALUES ('iphones', 'OLX', 'irrelevant', 'hash', 'model', 0, 'case', ?, 'irrelevant')").run(hoursAgo(0));
    context.db.prepare("UPDATE listings SET ai_description_verification_status = 'reject' WHERE listing_id = 'rejected'").run();
    context.db.prepare("UPDATE listings SET availability_status = 'terminal' WHERE listing_id = 'ended'").run();

    const result = context.service.comparables({ listingKey: 'OLX:subject' });
    assert.deepEqual(result.listing, { key: 'OLX:subject', price: 2300, condition: 'Używane', daysListed: 2 });
    assert.deepEqual(result.watch, { id: 'iphones', name: 'iphones name', variant: '13 Pro', via: 'association' });
    assert.equal(result.condition, 'used');
    assert.deepEqual(result.comparables.map((item) => item.key), ['OLX:p2', 'OLX:p1', 'OLX:p4', 'Vinted:p3']);
    assert.deepEqual(result.comparables[0], { key: 'OLX:p2', title: 'iPhone 13 Pro grafitowy', price: 2100, condition: 'Używane', location: 'Kraków', shipping: true, daysListed: 3, url: 'https://example.test/p2' });
    assert.deepEqual([result.comparables[1].daysListed, result.comparables[1].shipping, result.comparables[3].shipping], [30, false, true]);
    assert.deepEqual([result.count, result.median, result.vsMedian], [4, 2450, { pln: -150, percent: -6.1 }]);
    assert.deepEqual(result.notes, ['Asking prices, not completed sales.']);

    const capped = context.service.comparables({ listingKey: 'OLX:subject', limit: 2 });
    assert.deepEqual([capped.comparables.length, capped.count, capped.median], [2, 4, 2450]);
  } finally { context.close(); }
});

test('places a listing with no watch by its title, the way a scan would', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'iphones', 'iphone 13', { groups: iphoneVariants });
    seedWatch(context.db, 'phones', 'iphone');
    for (const [id, price] of [['p1', 2400], ['p2', 2500], ['m1', 1500]] as const) {
      seedListing(context.db, 'iphones', { id, title: id.startsWith('m') ? 'iPhone 13 mini' : 'iPhone 13 Pro', price });
    }
    context.service.retagWatchVariants('iphones');
    seedListing(context.db, null, { id: 'manual', title: 'Apple iPhone 13 Pro 128GB', price: 2200 });

    const result = context.service.comparables({ listingKey: 'OLX:manual' });
    assert.deepEqual(result.watch, { id: 'iphones', name: 'iphones name', variant: '13 Pro', via: 'title-match' });
    assert.deepEqual(result.comparables.map((item) => item.key), ['OLX:p1', 'OLX:p2']);
    assert.deepEqual([result.count, result.median, result.vsMedian], [2, null, null]);

    // The broader watch, when asked for by id, takes everything it tracks.
    const phones = context.service.comparables({ listingKey: 'OLX:manual', watchId: 'phones' });
    assert.deepEqual([phones.watch?.id, phones.watch?.variant, phones.count], ['phones', null, 0]);
  } finally { context.close(); }
});

test('a slow watch keeps listings it saw within two of its scan intervals', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'daily', 'ps5', { sources: ['OLX'], intervalMinutes: 1440 });
    seedListing(context.db, 'daily', { id: 'subject', title: 'PS5', price: 1800 });
    seedListing(context.db, 'daily', { id: 'seen-30h', title: 'PS5 digital', price: 1700, seenHours: 30 });
    seedListing(context.db, 'daily', { id: 'seen-60h', title: 'PS5', price: 1600, seenHours: 60 });
    assert.deepEqual(context.service.comparables({ listingKey: 'OLX:subject' }).comparables.map((item) => item.key), ['OLX:seen-30h']);
  } finally { context.close(); }
});

test('unknown condition widens the set; untracked items and bad keys are explained', () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'gpus', 'rtx 3080');
    seedListing(context.db, 'gpus', { id: 'subject', title: 'RTX 3080', price: 2000, condition: null });
    seedListing(context.db, 'gpus', { id: 'used', title: 'RTX 3080', price: 2100 });
    seedListing(context.db, 'gpus', { id: 'broken', title: 'RTX 3080', price: 800, condition: 'Uszkodzone' });
    const unknown = context.service.comparables({ listingKey: 'OLX:subject' });
    assert.equal(unknown.condition, null);
    assert.deepEqual(unknown.comparables.map((item) => item.key), ['OLX:broken', 'OLX:used']);
    assert.ok(unknown.notes.some((note) => note.includes('condition is unknown')));

    seedListing(context.db, null, { id: 'lonely', title: 'Steam Deck', price: 1500 });
    const lonely = context.service.comparables({ listingKey: 'OLX:lonely' });
    assert.deepEqual([lonely.watch, lonely.count, lonely.comparables], [null, 0, []]);
    assert.ok(lonely.notes.some((note) => note.startsWith('No watch tracks')));

    assert.throws(() => context.service.comparables({ listingKey: 'OLX:missing' }), /not in Scout's database/);
    assert.throws(() => context.service.comparables({ listingKey: 'Allegro:1' }), /Invalid listing key/);
    assert.throws(() => context.service.comparables({ listingKey: 'OLX:subject', watchId: 'nope' }), /Watch not found/);
  } finally { context.close(); }
});
