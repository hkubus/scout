import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { parseMarketplaceStorageState } from '../server/marketplace-sessions';
import { ScoutService, ServiceError, decryptSecret, encryptSecret, filterListings, marketStatusAfterMiss, nextWatchScanAt, validateDiscordWebhook } from '../server/service';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-service-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {});
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('starts with truthful empty dashboard data and unconfigured notifications', () => {
  const context = fixture();
  try {
    assert.deepEqual(context.service.dashboard().stats, { watching: 0, newToday: 0, strongDeals: 0 });
    assert.equal(context.service.dashboard().watches.length, 0);
    assert.equal(context.service.settings().webhookConfigured, false);
    assert.equal(context.service.notifications().length, 0);
  } finally { context.close(); }
});

test('slows normal watch polling overnight without skipping the morning boundary', () => {
  const minutesBetween = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 60_000;
  const beforeNight = new Date(2026, 7, 23, 21, 55, 0, 0).toISOString();
  const overnight = new Date(2026, 7, 23, 22, 0, 0, 0).toISOString();
  const beforeMorning = new Date(2026, 7, 24, 7, 50, 0, 0).toISOString();
  const morning = new Date(2026, 7, 24, 8, 0, 0, 0).toISOString();
  assert.equal(minutesBetween(beforeNight, nextWatchScanAt(beforeNight, 5, 30)), 5);
  assert.equal(minutesBetween(overnight, nextWatchScanAt(overnight, 5, 30)), 30);
  assert.equal(nextWatchScanAt(beforeMorning, 5, 30), morning);
  assert.equal(minutesBetween(morning, nextWatchScanAt(morning, 5, 30)), 5);
  assert.equal(minutesBetween(overnight, nextWatchScanAt(overnight, 60, 30)), 60);
});

test('encrypts Discord secrets and validates settings bounds', () => {
  const context = fixture();
  try {
    const webhook = 'https://discord.com/api/webhooks/123/token';
    assert.equal(decryptSecret(encryptSecret(webhook)), webhook);
    assert.equal(validateDiscordWebhook(webhook), webhook);
    assert.throws(() => validateDiscordWebhook('https://example.com/api/webhooks/123/token'), ServiceError);
    assert.throws(() => context.service.saveSettings({ interval: 3 }), /between 5 and 1440/);
    const settings = context.service.saveSettings({ interval: 15, nightInterval: 45 });
    assert.equal(settings.defaultInterval, 15);
    assert.equal(settings.nightInterval, 45);
  } finally { context.close(); }
});

test('stores ntfy credentials encrypted and routes channel priorities independently', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), init });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const notifyDeal = (context.service as any).notifyDeal.bind(context.service) as (listing: any, typical: number, discountPercent: number, confidence: number) => Promise<void>;
  try {
    const settings = context.service.saveSettings({
      webhook: 'https://discord.com/api/webhooks/123/token',
      discordMinimumPriority: 'very-strong',
      ntfy: { serverUrl: 'https://ntfy.sh', topic: 'scout-deals', token: 'tk_secret', minimumPriority: 'exceptional' },
    });
    assert.equal(settings.discordMinimumPriority, 'very-strong');
    assert.equal(settings.ntfy.configured, true);
    assert.equal(settings.ntfy.minimumPriority, 'exceptional');
    const stored = context.db.prepare("SELECT value FROM settings WHERE key = 'ntfy_config'").get() as { value: string };
    assert.equal(stored.value.includes('scout-deals'), false);
    assert.equal(stored.value.includes('tk_secret'), false);

    const base = { marketplace: 'OLX' as const, price: 900, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/priority', observedAt: new Date().toISOString() };
    await notifyDeal({ ...base, listingId: 'very-strong', title: 'Very strong deal' }, 1200, 25, 92);
    assert.deepEqual((context.db.prepare('SELECT channel, status FROM notification_deliveries WHERE listing_key = ? ORDER BY channel').all('olx:very-strong') as Array<{ channel: string; status: string }>).map((row) => ({ channel: row.channel, status: row.status })), [{ channel: 'Discord', status: 'delivered' }]);
    await notifyDeal({ ...base, listingId: 'exceptional', title: 'Exceptional deal' }, 1400, 35, 96);
    assert.deepEqual((context.db.prepare('SELECT channel, status FROM notification_deliveries WHERE listing_key = ? ORDER BY channel').all('olx:exceptional') as Array<{ channel: string; status: string }>).map((row) => ({ channel: row.channel, status: row.status })), [{ channel: 'Discord', status: 'delivered' }, { channel: 'ntfy', status: 'delivered' }]);
    assert.equal(requests.filter((request) => request.url === 'https://ntfy.sh/').length, 1);
    assert.equal(new Headers(requests.find((request) => request.url === 'https://ntfy.sh/')?.init?.headers).get('authorization'), 'Bearer tk_secret');
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('stores marketplace sessions encrypted and rejects cross-marketplace state', () => {
  const context = fixture();
  const state = {
    cookies: [{ name: 'session', value: 'private-token', domain: '.olx.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }],
    origins: [{ origin: 'https://www.olx.pl', localStorage: [{ name: 'account', value: 'signed-in' }] }],
  };
  try {
    assert.deepEqual(parseMarketplaceStorageState(state, 'OLX'), state);
    assert.throws(() => parseMarketplaceStorageState({ cookies: [{ name: 'session', value: 'x', domain: '.vinted.pl', path: '/' }] }, 'OLX'), /outside OLX/);
    assert.throws(() => parseMarketplaceStorageState({ cookies: [{ name: 'session', value: 'x', domain: '.olx.pl', path: '/' }], origins: [{ origin: 'http://www.olx.pl' }] }, 'OLX'), /approved OLX HTTPS origin/);
    const settings = context.service.saveMarketplaceSession('OLX', 'Personal', state);
    const saved = settings.marketplaceSessions.find((session) => session.marketplace === 'OLX')!;
    assert.equal(saved.connected, true);
    assert.equal(saved.label, 'Personal');
    const stored = context.db.prepare('SELECT storage_state_encrypted FROM marketplace_sessions WHERE marketplace = ?').get('OLX') as { storage_state_encrypted: string };
    assert.notEqual(stored.storage_state_encrypted, JSON.stringify(state));
    assert.deepEqual(parseMarketplaceStorageState(decryptSecret(stored.storage_state_encrypted), 'OLX'), state);
    context.service.deleteMarketplaceSession('OLX');
    assert.equal(context.service.settings().marketplaceSessions.find((session) => session.marketplace === 'OLX')?.connected, false);
  } finally { context.close(); }
});

test('deletes watches and prunes expired observations without seeded data', () => {
  const context = fixture();
  try {
    const old = '2025-01-01T00:00:00.000Z';
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('expired-watch', 'Expired', 'expired', '[]', 0, now, now, now);
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'expired-listing', 'Expired listing', 10, 'https://www.olx.pl/d/oferta/expired-listing', old, old);
    const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get('expired-listing') as { id: number };
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'expired-watch', 10, old);
    context.service.queueDue();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM observations').get() as { count: number }).count, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listings').get() as { count: number }).count, 0);
    context.service.deleteWatch('expired-watch');
    assert.throws(() => context.service.deleteWatch('expired-watch'), /not found/);
  } finally { context.close(); }
});

test('keeps provisional baselines and deal labels hidden during cold start', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('cold-watch', 'Cold watch', 'cpu', '["OLX"]', 1, now, now, now);
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, typical_pln, shipping_available, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'cold-listing', 'Cheap CPU', 100, 500, 1, 'https://www.olx.pl/d/oferta/cold-listing', now, now);
    const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get('cold-listing') as { id: number };
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'cold-watch', 100, now);
    const dashboard = context.service.dashboard();
    assert.equal(dashboard.listings[0].typical, null);
    assert.equal(dashboard.listings[0].dealLabel, 'Watch');
    assert.equal(dashboard.stats.strongDeals, 0);
  } finally { context.close(); }
});

test('marks a baseline ready after 30 comparable listings and six hours', () => {
  const context = fixture();
  try {
    const firstObserved = new Date(Date.now() - 8 * 3_600_000).toISOString();
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('ready-watch', 'Ready watch', 'cpu', '["OLX"]', 1, now, now, now);
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 30; index += 1) {
      insertListing.run('OLX', `ready-listing-${index}`, `CPU ${index}`, 1000 + index, `https://www.olx.pl/d/oferta/ready-listing-${index}`, firstObserved, firstObserved);
      const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get(`ready-listing-${index}`) as { id: number };
      insertObservation.run(listing.id, 'ready-watch', 1000 + index, firstObserved);
    }
    const [watch] = context.service.getWatches();
    assert.equal(watch.samples, 30);
    assert.ok(watch.observationHours >= 6);
    assert.equal(watch.readiness, 100);
    assert.equal(watch.status, 'Ready');
  } finally { context.close(); }
});

test('aggregates watch analytics by daily listing snapshots', () => {
  const context = fixture();
  try {
    const dayOne = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    dayOne.setUTCHours(12, 0, 0, 0);
    const dayTwo = new Date(Date.now() - 24 * 60 * 60_000);
    dayTwo.setUTCHours(12, 0, 0, 0);
    const first = dayOne.toISOString();
    const second = dayTwo.toISOString();
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('analytics-watch', 'Analytics watch', 'deck', '["OLX","Vinted"]', 1, now, now, now);
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, typical_pln, shipping_available, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insertListing.run('OLX', 'analytics-one', 'Deck one', 1200, 1500, 1, 'https://www.olx.pl/d/oferta/analytics-one', first, second);
    insertListing.run('OLX', 'analytics-two', 'Deck two', 1800, 2000, 1, 'https://www.olx.pl/d/oferta/analytics-two', first, second);
    insertListing.run('Vinted', 'analytics-three', 'Deck three', 1600, 1800, 1, 'https://www.vinted.pl/items/analytics-three', second, second);
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    const listingOne = context.db.prepare("SELECT id FROM listings WHERE listing_id = 'analytics-one'").get() as { id: number };
    const listingTwo = context.db.prepare("SELECT id FROM listings WHERE listing_id = 'analytics-two'").get() as { id: number };
    const listingThree = context.db.prepare("SELECT id FROM listings WHERE listing_id = 'analytics-three'").get() as { id: number };
    insertObservation.run(listingOne.id, 'analytics-watch', 1000, first);
    insertObservation.run(listingOne.id, 'analytics-watch', 950, new Date(dayOne.getTime() + 60 * 60_000).toISOString());
    insertObservation.run(listingTwo.id, 'analytics-watch', 1500, first);
    insertObservation.run(listingOne.id, 'analytics-watch', 1200, second);
    insertObservation.run(listingTwo.id, 'analytics-watch', 1800, second);
    insertObservation.run(listingThree.id, 'analytics-watch', 1600, second);

    const analytics = context.service.watchAnalytics('analytics-watch', 30);
    assert.equal(analytics.totalObservations, 6);
    assert.deepEqual(analytics.points.map((point) => point.listingCount), [2, 3]);
    assert.deepEqual(analytics.points.map((point) => point.medianPrice), [1225, 1600]);
    assert.equal(analytics.current.lowerPrice, 1400);
    assert.equal(analytics.current.upperPrice, 1700);
    assert.equal(analytics.current.strongDealCount, 1);
    assert.equal(analytics.current.strongDealRate, 1 / 3 * 100);
    assert.equal(analytics.sources.find((source) => source.source === 'OLX')?.listingCount, 2);
    assert.equal(analytics.sources.find((source) => source.source === 'Vinted')?.medianPrice, 1600);
    assert.ok((analytics.medianChangePercent ?? 0) > 30);
  } finally { context.close(); }
});

test('returns listing price history and persists Buy/Watch/Pass triage actions', () => {
  const context = fixture();
  try {
    const firstSeen = '2026-08-21T10:00:00.000Z';
    const lastSeen = '2026-08-22T10:00:00.000Z';
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('triage-watch', 'Triage watch', 'headphones', '["OLX"]', 1, lastSeen, firstSeen, lastSeen);
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'triage-listing', 'Headphones', 400, 'https://www.olx.pl/d/oferta/triage-listing', firstSeen, lastSeen);
    const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get('triage-listing') as { id: number };
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'triage-watch', 450, firstSeen);
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'triage-watch', 400, lastSeen);

    const saved = context.service.updateListingAction('OLX:triage-listing', 'buy', 'Ask for a battery screenshot');
    assert.deepEqual(saved.decision, 'buy');
    assert.equal(saved.note, 'Ask for a battery screenshot');
    assert.equal(context.service.getListings()[0].decision, 'buy');
    const detail = context.service.listingDetail('OLX:triage-listing');
    assert.deepEqual(detail.history.map((point) => point.price), [450, 400]);
    assert.equal(detail.action.decision, 'buy');
    assert.equal(detail.action.note, 'Ask for a battery screenshot');

    context.service.updateListingAction('OLX:triage-listing', null, '');
    assert.equal(context.service.listingDetail('OLX:triage-listing').action.decision, null);
    assert.equal(context.service.listingDetail('OLX:triage-listing').action.note, '');
  } finally { context.close(); }
});

test('shipping-only watches hide pickup-only history and count only shippable samples', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, shipping_only, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('shipping-watch', 'Shipping watch', 'cpu', '["OLX"]', 1, 1, now, now, now);
    const insert = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, shipping_available, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('OLX', 'shipping-yes', 'CPU with delivery', 100, 1, 'https://www.olx.pl/d/oferta/shipping-yes', now, now);
    insert.run('OLX', 'shipping-no', 'Pickup CPU', 90, 0, 'https://www.olx.pl/d/oferta/shipping-no', now, now);
    const observe = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (const row of context.db.prepare('SELECT id, price_pln FROM listings').all() as Array<{ id: number; price_pln: number }>) observe.run(row.id, 'shipping-watch', row.price_pln, now);
    assert.equal(context.service.getWatches()[0].samples, 1);
    assert.deepEqual(context.service.getListings().map((listing) => listing.id), ['OLX:shipping-yes']);
  } finally { context.close(); }
});

test('price-filtered watches scope history and baseline samples to their range', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, min_price_pln, max_price_pln, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('priced-watch', 'Priced watch', 'cpu', '["OLX"]', 100, 300, 1, now, now, now);
    const insert = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, shipping_available, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('OLX', 'below-range', 'CPU too cheap', 50, 1, 'https://www.olx.pl/d/oferta/below', now, now);
    insert.run('OLX', 'in-range', 'CPU in range', 180, 1, 'https://www.olx.pl/d/oferta/in', now, now);
    insert.run('OLX', 'above-range', 'CPU too expensive', 450, 1, 'https://www.olx.pl/d/oferta/above', now, now);
    const observe = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (const row of context.db.prepare('SELECT id, price_pln FROM listings').all() as Array<{ id: number; price_pln: number }>) observe.run(row.id, 'priced-watch', row.price_pln, now);
    assert.equal(context.service.getWatches()[0].samples, 1);
    assert.deepEqual(context.service.getListings().map((listing) => listing.id), ['OLX:in-range']);
  } finally { context.close(); }
});

test('market research filters match terms, price, condition, location, and shipping', () => {
  const listings = [
    { marketplace: 'OLX' as const, listingId: 'match', title: 'RTX 4070 12GB Founders Edition', price: 1800, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/match', condition: 'New', location: 'Warszawa', shippingAvailable: true, observedAt: new Date().toISOString() },
    { marketplace: 'OLX' as const, listingId: 'too-cheap', title: 'RTX 4070 12GB Founders Edition', price: 500, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/too-cheap', condition: 'New', location: 'Warszawa', shippingAvailable: true, observedAt: new Date().toISOString() },
    { marketplace: 'OLX' as const, listingId: 'pickup', title: 'RTX 4070 12GB Founders Edition', price: 1800, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/pickup', condition: 'New', location: 'Warszawa', shippingAvailable: false, observedAt: new Date().toISOString() },
    { marketplace: 'OLX' as const, listingId: 'wrong-city', title: 'RTX 4070 12GB Founders Edition', price: 1800, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/wrong-city', condition: 'New', location: 'Kraków', shippingAvailable: true, observedAt: new Date().toISOString() },
    { marketplace: 'OLX' as const, listingId: 'excluded', title: 'RTX 4070 12GB parts only', price: 1800, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/excluded', condition: 'New', location: 'Warszawa', shippingAvailable: true, observedAt: new Date().toISOString() },
  ];
  assert.deepEqual(filterListings(listings, 'rtx 4070', '12gb', 'parts', { minPrice: 1000, maxPrice: 2000, condition: 'New', location: 'Warszawa', shippingOnly: true }).map((listing) => listing.listingId), ['match']);
});

test('keeps market research separate and reports ended-listing price estimates', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO market_watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, interval_hours, min_price_pln, max_price_pln, shipping_only, enabled, next_scan_at, last_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('market-watch', 'GPU market', 'rtx 4070', '12gb', 'parts', 'Warszawa', 'New', '["OLX","Vinted"]', 24, 1000, 2500, 1, 1, now, now, now, now);
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insert.run('market-watch', 'OLX', 'active', 'Active GPU', 'https://www.olx.pl/d/oferta/active', 2100, 1950, 1950, now, now, 'active', 0, null);
    insert.run('market-watch', 'OLX', 'ended-1', 'Ended GPU one', 'https://www.olx.pl/d/oferta/ended-1', 2200, 2000, 2000, now, now, 'ended', 3, now);
    insert.run('market-watch', 'Vinted', 'ended-2', 'Ended GPU two', 'https://www.vinted.pl/items/ended-2', 2600, 2400, 2300, now, now, 'ended', 3, now);
    const listing = context.db.prepare("SELECT id FROM market_listings WHERE listing_id = 'ended-1'").get() as { id: number };
    context.db.prepare('INSERT INTO market_price_observations (market_listing_id, price_pln, observed_at) VALUES (?, ?, ?)').run(listing.id, 2000, now);
    const research = context.service.marketResearch();
    assert.deepEqual(research.watches[0], {
      id: 'market-watch', name: 'GPU market', query: 'rtx 4070', terms: '12gb', excluded: 'parts', location: 'Warszawa', condition: 'New', sources: ['OLX', 'Vinted'], intervalHours: 24, minPrice: 1000, maxPrice: 2500, shippingOnly: true, enabled: true, nextScan: 'due now', lastScan: 'just now', totalListings: 3, activeListings: 1, endedListings: 2, estimatedMedianPrice: 2200,
    });
    assert.equal(research.watches[0].totalListings, 3);
    assert.equal(research.watches[0].activeListings, 1);
    assert.equal(research.watches[0].endedListings, 2);
    assert.equal(research.watches[0].estimatedMedianPrice, 2200);
    assert.equal(research.listings.find((item) => item.listingId === 'ended-1')?.observations, 1);
    context.service.deleteMarketWatch('market-watch');
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM market_listings').get() as { count: number }).count, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM market_price_observations').get() as { count: number }).count, 0);
  } finally { context.close(); }
});

test('only infers an ended market listing after three missed successful scans', () => {
  assert.deepEqual(marketStatusAfterMiss(0), { missingScans: 1, status: 'active' });
  assert.deepEqual(marketStatusAfterMiss(1), { missingScans: 2, status: 'active' });
  assert.deepEqual(marketStatusAfterMiss(2), { missingScans: 3, status: 'ended' });
});
