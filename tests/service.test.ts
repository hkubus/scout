import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { parseMarketplaceStorageState } from '../server/marketplace-sessions';
import { DeepSeekError } from '../server/ai';
import { ScoutService, ServiceError, decryptSecret, encryptSecret, filterListings, marketStatusAfterMiss, nextWatchScanAt, validateDiscordWebhook, type ScoutServiceDependencies } from '../server/service';

function fixture(dependencies: ScoutServiceDependencies = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-service-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, dependencies);
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seedWatch(db: any, id: string, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const values = {
    name: `${id} name`, query: 'cpu', sources: '["OLX"]', enabled: 1,
    nextScanAt: now, createdAt: now, updatedAt: now, ...overrides,
  };
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, values.name, values.query, values.sources, values.enabled, values.nextScanAt, values.createdAt, values.updatedAt);
  return now;
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

test('keeps dashboard database work bounded as watch count grows', () => {
  const context = fixture();
  try {
    for (let index = 0; index < 40; index += 1) seedWatch(context.db, `bounded-watch-${index}`);
    let prepareCalls = 0;
    const measuredDb = new Proxy(context.db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => { prepareCalls += 1; return target.prepare(sql); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new ScoutService(measuredDb, () => {});
    assert.equal(service.dashboard().watches.length, 40);
    assert.ok(prepareCalls <= 12, `expected bounded dashboard queries, received ${prepareCalls}`);
  } finally { context.close(); }
});

test('keeps market research aggregation bounded as watch count grows', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    const insert = context.db.prepare(`INSERT INTO market_watches (id, name, query, sources_json, interval_hours, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let index = 0; index < 40; index += 1) {
      insert.run(`market-bounded-${index}`, `Market ${index}`, 'cpu', '["OLX"]', 24, 1, now, now, now);
    }
    let prepareCalls = 0;
    const measuredDb = new Proxy(context.db, {
      get(target, property) {
        if (property === 'prepare') return (sql: string) => { prepareCalls += 1; return target.prepare(sql); };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const service = new ScoutService(measuredDb, () => {});
    assert.equal(service.marketResearch().watches.length, 40);
    assert.ok(prepareCalls <= 10, `expected bounded market research queries, received ${prepareCalls}`);
  } finally { context.close(); }
});

test('reports the latest connector state from batched health queries', () => {
  const context = fixture();
  try {
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    context.db.prepare('INSERT INTO connector_runs (source, status, message, started_at, finished_at) VALUES (?, ?, ?, ?, ?)').run('OLX', 'ok', 'First pass', older, older);
    context.db.prepare('INSERT INTO connector_runs (source, status, message, started_at, finished_at) VALUES (?, ?, ?, ?, ?)').run('OLX', 'error', 'Latest failure', newer, newer);
    const connector = context.service.getConnectors().find((item) => item.name === 'OLX');
    assert.deepEqual({ status: connector?.status, detail: connector?.detail, requests: connector?.requests }, { status: 'Degraded', detail: 'Latest failure', requests: 2 });
    assert.notEqual(connector?.lastSuccess, 'Never');
  } finally { context.close(); }
});

test('uses the recent-listing index for feed pagination order', () => {
  const context = fixture();
  try {
    const cutoff = new Date(Date.now() - 12 * 60 * 60_000).toISOString();
    const plan = context.db.prepare(`EXPLAIN QUERY PLAN
      SELECT wl.id FROM watch_listings wl
      WHERE wl.last_seen_at > ?
      ORDER BY wl.last_seen_at DESC, wl.id DESC
      LIMIT 500`).all(cutoff) as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes('watch_listings_recent')));
    assert.equal(plan.some((row) => row.detail.includes('USE TEMP B-TREE')), false);
  } finally { context.close(); }
});

test('uses one indexed scan for connector health aggregation', () => {
  const context = fixture();
  try {
    const plan = context.db.prepare(`EXPLAIN QUERY PLAN SELECT * FROM (
      SELECT connector_runs.*,
        COUNT(*) OVER (PARTITION BY source) AS source_count,
        MAX(CASE WHEN status = 'ok' THEN finished_at END) OVER (PARTITION BY source) AS last_success,
        ROW_NUMBER() OVER (PARTITION BY source ORDER BY started_at DESC, id DESC) AS source_rank
      FROM connector_runs
    ) WHERE source_rank = 1`).all() as Array<{ detail: string }>;
    assert.ok(plan.some((row) => row.detail.includes('connector_runs_source_latest')));
    assert.equal(plan.some((row) => row.detail.includes('USE TEMP B-TREE')), false);
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

test('stores the OpenRouter token encrypted and exposes only safe AI settings', () => {
  const context = fixture();
  try {
    const settings = context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    assert.equal(settings.ai.configured, true);
    assert.equal(settings.ai.model, 'deepseek/deepseek-v4-flash');
    assert.equal(settings.ai.source, 'settings');
    const stored = context.db.prepare("SELECT value FROM settings WHERE key = 'openrouter_api_key'").get() as { value: string };
    assert.equal(stored.value.includes('sk-deepseek-secret'), false);
    assert.equal(JSON.stringify(settings).includes('sk-deepseek-secret'), false);
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

test('queues ordinary deals for a durable daily digest while keeping exceptional alerts immediate', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; body: Record<string, any> }> = [];
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, any> });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    seedWatch(context.db, 'digest-watch');
    const settings = context.service.saveSettings({
      webhook: 'https://discord.com/api/webhooks/123/token',
      discordMinimumPriority: 'strong',
      dailyDigest: { enabled: true, time: '00:00', discord: true, ntfy: false },
    });
    assert.deepEqual(settings.dailyDigest, { enabled: true, time: '00:00', discord: true, ntfy: false, lastSentAt: null });
    assert.throws(() => context.service.saveSettings({ dailyDigest: { enabled: true, discord: false, ntfy: false } }), /Select Discord/);

    const notifyDeal = (context.service as any).notifyDeal.bind(context.service) as (...args: any[]) => Promise<void>;
    const base = { marketplace: 'OLX' as const, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/digest-deal', observedAt: new Date().toISOString() };
    await notifyDeal('digest-watch', { ...base, listingId: 'digest-deal', title: 'Digest CPU', price: 820 }, 1000, 18, 91);
    assert.equal(requests.length, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM daily_digest_candidates').get() as { count: number }).count, 1);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get() as { count: number }).count, 0);

    await (context.service as any).processDailyDigest();
    assert.equal(requests.length, 1);
    assert.match(String(requests[0].body.embeds?.[0]?.title), /Daily deal digest/);
    assert.equal(requests[0].body._scoutDigest, undefined);
    const delivery = context.db.prepare("SELECT status, channel FROM notification_deliveries WHERE listing_key LIKE 'digest:%'").get() as { status: string; channel: string };
    assert.deepEqual({ status: delivery.status, channel: delivery.channel }, { status: 'delivered', channel: 'Discord' });
    assert.ok(context.service.settings().dailyDigest.lastSentAt);
    assert.match(context.service.notifications()[0].reason, /1 deals · Discord/);

    await notifyDeal('digest-watch', { ...base, listingId: 'digest-deal', title: 'Digest CPU', price: 820 }, 1000, 18, 91);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM daily_digest_candidates').get() as { count: number }).count, 1);
    await notifyDeal('digest-watch', { ...base, listingId: 'digest-deal', title: 'Digest CPU', price: 760 }, 1000, 24, 93);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM daily_digest_candidates').get() as { count: number }).count, 2);

    await notifyDeal('digest-watch', { ...base, listingId: 'exceptional-deal', title: 'Exceptional CPU', price: 640 }, 1000, 36, 97);
    assert.equal(requests.length, 2);
    assert.equal((context.db.prepare("SELECT COUNT(*) AS count FROM daily_digest_candidates WHERE listing_id = 'exceptional-deal'").get() as { count: number }).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('retries a failed ntfy daily digest from its stored payload', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  const requests: Array<Record<string, any>> = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, any>);
    return requests.length === 1 ? new Response(null, { status: 500 }) : new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    seedWatch(context.db, 'ntfy-digest-watch');
    context.service.saveSettings({
      ntfy: { serverUrl: 'https://ntfy.sh', topic: 'scout-digest', minimumPriority: 'strong' },
      dailyDigest: { enabled: true, time: '00:00', discord: false, ntfy: true },
    });
    const listing = { marketplace: 'OLX' as const, listingId: 'ntfy-digest', title: 'Digest GPU', price: 800, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/ntfy-digest', observedAt: new Date().toISOString() };
    await (context.service as any).notifyDeal('ntfy-digest-watch', listing, 1000, 20, 92);
    await (context.service as any).processDailyDigest();
    const failed = context.db.prepare("SELECT status, attempt_count FROM notification_deliveries WHERE channel = 'ntfy'").get() as { status: string; attempt_count: number };
    assert.deepEqual({ status: failed.status, attemptCount: failed.attempt_count }, { status: 'failed', attemptCount: 1 });
    context.db.prepare("UPDATE notification_deliveries SET next_attempt_at = ? WHERE channel = 'ntfy'").run(new Date(Date.now() - 1000).toISOString());
    await (context.service as any).processNotificationRetries();
    const delivered = context.db.prepare("SELECT status, attempt_count FROM notification_deliveries WHERE channel = 'ntfy'").get() as { status: string; attempt_count: number };
    assert.deepEqual({ status: delivered.status, attemptCount: delivered.attempt_count }, { status: 'delivered', attemptCount: 2 });
    assert.equal(requests[1].topic, 'scout-digest');
    assert.match(String(requests[1].title), /daily digest/i);
    assert.equal(requests[1]._scoutDigest, undefined);
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

test('accepts Allegro account auth state while keeping unrelated session domains blocked', () => {
  const context = fixture();
  try {
    const state = {
      cookies: [
        { name: 'lokalnie-session', value: 'private-token', domain: '.allegrolokalnie.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
        { name: 'allegro-session', value: 'private-token', domain: '.allegro.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' },
      ],
      origins: [{ origin: 'https://allegro.pl', localStorage: [{ name: 'account', value: 'signed-in' }] }],
    };
    assert.deepEqual(parseMarketplaceStorageState(state, 'Allegro Lokalnie'), state);
    assert.throws(() => parseMarketplaceStorageState({ cookies: [{ name: 'session', value: 'x', domain: '.allegro.example', path: '/' }] }, 'Allegro Lokalnie'), /outside Allegro Lokalnie/);
    context.service.saveMarketplaceSession('Allegro Lokalnie', 'Personal', state);
    assert.equal(context.service.settings().marketplaceSessions.find((session) => session.marketplace === 'Allegro Lokalnie')?.connected, true);
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
    const firstSeen = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const lastSeen = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('triage-watch', 'Triage watch', 'headphones', '["OLX"]', 1, lastSeen, firstSeen, lastSeen);
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, price_negotiable, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'triage-listing', 'Headphones', 400, 1, 'https://www.olx.pl/d/oferta/triage-listing', firstSeen, lastSeen);
    context.db.prepare("UPDATE listings SET ai_normalization_json = '{}' WHERE listing_id = 'triage-listing'").run();
    const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get('triage-listing') as { id: number };
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'triage-watch', 450, firstSeen);
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'triage-watch', 400, lastSeen);

    const saved = context.service.updateListingAction('OLX:triage-listing', 'buy', 'Ask for a battery screenshot');
    assert.deepEqual(saved.decision, 'buy');
    assert.equal(saved.note, 'Ask for a battery screenshot');
    const feedListing = context.service.getListings()[0];
    assert.equal(feedListing.decision, 'buy');
    assert.equal(feedListing.priceNegotiable, true);
    assert.equal(Object.hasOwn(feedListing, 'aiNormalization'), false);
    const detail = context.service.listingDetail('OLX:triage-listing');
    assert.equal(Object.hasOwn(detail.listing, 'aiNormalization'), true);
    assert.deepEqual(detail.history.map((point) => point.price), [450, 400]);
    assert.equal(detail.action.decision, 'buy');
    assert.equal(detail.action.note, 'Ask for a battery screenshot');

    context.service.updateListingAction('OLX:triage-listing', null, '');
    assert.equal(context.service.listingDetail('OLX:triage-listing').action.decision, null);
    assert.equal(context.service.listingDetail('OLX:triage-listing').action.note, '');
  } finally { context.close(); }
});

test('normalizes and caches a stored listing through the configured DeepSeek client', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async (_input, init) => {
    requests += 1;
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-deepseek-secret');
    return Response.json({ choices: [{ message: { content: JSON.stringify({
      canonicalTitle: 'Sony WH-1000XM5',
      category: 'headphones',
      brand: 'Sony',
      model: 'WH-1000XM5',
      variant: 'black',
      attributes: [{ name: 'color', value: 'black' }],
      condition: 'like-new',
      conditionNotes: ['The title says “stan idealny”.'],
      flags: [],
      confidence: 0.91,
      evidence: ['Sony WH-1000XM5 czarne', 'stan idealny'],
    }) } }] });
  }) as typeof fetch;
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'ai-listing', 'Sony WH-1000XM5 czarne · stan idealny', 749, 'https://www.olx.pl/d/oferta/ai-listing', 'Like new', 'Warszawa', now, now);

    const detail = await context.service.normalizeListingByKey('OLX:ai-listing');
    assert.equal(detail.listing.aiNormalization?.canonicalTitle, 'Sony WH-1000XM5');
    assert.equal(detail.listing.aiNormalization?.attributes[0].value, 'black');
    assert.equal(requests, 1);

    const cached = await context.service.normalizeListingByKey('OLX:ai-listing');
    assert.equal(cached.listing.aiNormalization?.model, 'WH-1000XM5');
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('fetches and verifies descriptions for very strong and exceptional deals before alerting', async () => {
  let verificationRequests = 0;
  const context = fixture({
    classifyListingRelevance: async () => ({ relevant: true }),
    verifyListingDescription: async (listing) => {
      verificationRequests += 1;
      assert.match(listing.description ?? '', /fully working/i);
      return { decision: 'reject', confidence: 0.98, summary: 'The description discloses a material problem.', issues: ['The item is not safe to surface as an exceptional deal.'], evidence: ['The description says it is broken.'] };
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    const now = new Date().toISOString();
    const baselineAt = new Date(Date.now() - 8 * 60 * 60_000).toISOString();
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' }, webhook: 'https://discord.com/api/webhooks/123/token' });
    seedWatch(context.db, 'exceptional-watch');
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 30; index += 1) {
      insertListing.run('OLX', `baseline-${index}`, `CPU reference ${index}`, 1000, `https://www.olx.pl/d/oferta/baseline-${index}`, baselineAt, baselineAt);
      const listing = context.db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get('OLX', `baseline-${index}`) as { id: number };
      insertObservation.run(listing.id, 'exceptional-watch', 1000, baselineAt);
    }
    (context.service as any).fetchPublicPage = async (url: string) => url.includes('/exceptional-listing') || url.includes('/very-strong-listing')
      ? '<div data-testid="description">Fully working, but broken screen and sold for parts.</div>'
      : `<script type="application/ld+json">${JSON.stringify({ '@type': 'ItemList', itemListElement: [
        { '@type': 'Product', name: 'CPU very strong', sku: 'very-strong-listing', url: 'https://www.olx.pl/d/oferta/very-strong-listing', offers: { price: '750' } },
        { '@type': 'Product', name: 'CPU exceptional', sku: 'exceptional-listing', url: 'https://www.olx.pl/d/oferta/exceptional-listing', offers: { price: '650' } },
      ] })}</script>`;

    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('exceptional-watch');
    await (context.service as any).runWatch(row);

    assert.equal(verificationRequests, 2);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count, 0);
    const stored = (context.db.prepare('SELECT listing_id, ai_description_verification_status FROM listings WHERE listing_id IN (?, ?) ORDER BY listing_id').all('exceptional-listing', 'very-strong-listing') as Array<{ listing_id: string; ai_description_verification_status: string }>).map((row) => ({ ...row }));
    assert.deepEqual(stored, [
      { listing_id: 'exceptional-listing', ai_description_verification_status: 'reject' },
      { listing_id: 'very-strong-listing', ai_description_verification_status: 'reject' },
    ]);
    const snapshot = context.service.listingDetail('OLX:very-strong-listing', 'exceptional-watch').descriptionSnapshot;
    assert.equal(snapshot?.price, 750);
    assert.equal(snapshot?.description, 'Fully working, but broken screen and sold for parts.');
    assert.equal(snapshot?.verificationStatus, 'reject');
    assert.ok(snapshot?.capturedAt);
    await (context.service as any).runWatch(row);
    assert.equal(verificationRequests, 2);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_detail_snapshots').get() as { count: number }).count, 2);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('sends a high-priority alert when OpenRouter verification fails technically', async () => {
  let verificationRequests = 0;
  const context = fixture({
    verifyListingDescription: async () => {
      verificationRequests += 1;
      throw new DeepSeekError('OpenRouter returned verification that was not valid JSON', 502, 'format');
    },
  });
  const originalFetch = globalThis.fetch;
  let notificationRequests = 0;
  globalThis.fetch = (async () => {
    notificationRequests += 1;
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({
      ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' },
      webhook: 'https://discord.com/api/webhooks/123/token',
    });
    seedWatch(context.db, 'fallback-watch');
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'OLX', 'fallback-listing', 'CPU', 650, 'https://www.olx.pl/d/oferta/fallback-listing', now, now,
    );
    (context.service as any).fetchPublicPage = async () => '<div data-testid="description">Fully working and complete.</div>';
    const listing = { marketplace: 'OLX' as const, listingId: 'fallback-listing', title: 'CPU', price: 650, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/fallback-listing', observedAt: now };
    const candidate = { watchId: 'fallback-watch', listing, typical: 1000, discountPercent: 35, confidence: 96, requiresDescriptionVerification: true };

    const allowed = await (context.service as any).verifyHighPriorityDeal(candidate);
    assert.equal(allowed, true);
    assert.equal(verificationRequests, 1);
    assert.equal((context.db.prepare('SELECT ai_description_verification_status FROM listings WHERE listing_id = ?').get('fallback-listing') as { ai_description_verification_status: string }).ai_description_verification_status, 'fallback');

    await (context.service as any).notifyDeal('fallback-watch', listing, 1000, 35, 96);
    assert.equal(notificationRequests, 1);
    assert.equal((context.db.prepare('SELECT status FROM notification_deliveries').get() as { status: string }).status, 'delivered');

    const reusedFallback = await (context.service as any).verifyHighPriorityDeal(candidate);
    assert.equal(reusedFallback, true);
    assert.equal(verificationRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('filters and caches irrelevant listings per watch', async () => {
  let requests = 0;
  const context = fixture({
    classifyListingRelevance: async (listing) => {
      requests += 1;
      return { relevant: !listing.title.toLowerCase().includes('fan') };
    },
  });
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('relevance-watch', 'GPU watch', 'gpu', '["OLX"]', 1, now, now, now);
    const listings = [
      { marketplace: 'OLX' as const, listingId: 'gpu-card', title: 'RTX 4070 graphics card', price: 2000, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/gpu-card', observedAt: now },
      { marketplace: 'OLX' as const, listingId: 'gpu-fan', title: 'GPU fan replacement', price: 80, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/gpu-fan', observedAt: now },
    ];
    const filter = (context.service as any).filterListingsByAiRelevance.bind(context.service) as (items: typeof listings, search: { query: string; includedTerms: string; excludedTerms: string }, watchId: string, enabled: boolean) => Promise<{ listings: typeof listings; excluded: number }>;
    const first = await filter(listings, { query: 'gpu', includedTerms: '', excludedTerms: '' }, 'relevance-watch', true);
    assert.deepEqual(first.listings.map((listing) => listing.listingId), ['gpu-card']);
    assert.equal(first.excluded, 1);
    assert.equal(requests, 2);

    const cached = await filter(listings, { query: 'gpu', includedTerms: '', excludedTerms: '' }, 'relevance-watch', true);
    assert.deepEqual(cached.listings.map((listing) => listing.listingId), ['gpu-card']);
    assert.equal(requests, 2);
    assert.equal((context.db.prepare('SELECT relevant FROM listing_relevance WHERE watch_id = ? AND listing_id = ?').get('relevance-watch', 'gpu-fan') as { relevant: number }).relevant, 0);

    seedWatch(context.db, 'second-relevance-watch', { query: 'gpu' });
    const shared = await filter(listings, { query: ' GPU ', includedTerms: '', excludedTerms: '' }, 'second-relevance-watch', true);
    assert.deepEqual(shared.listings.map((listing) => listing.listingId), ['gpu-card']);
    assert.equal(requests, 2);
    assert.equal((context.db.prepare('SELECT relevant FROM listing_relevance WHERE watch_id = ? AND listing_id = ?').get('second-relevance-watch', 'gpu-fan') as { relevant: number }).relevant, 0);
  } finally { context.close(); }
});

test('applies the AI relevance gate to one-off marketplace search results', async () => {
  let requests = 0;
  const context = fixture({
    classifyListingRelevance: async (listing) => {
      requests += 1;
      return { relevant: !listing.title.toLowerCase().includes('fan') };
    },
  });
  try {
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    (context.service as any).fetchPublicPage = async () => `<!doctype html><script type="application/ld+json">${JSON.stringify({
      '@type': 'ItemList',
      itemListElement: [
        { '@type': 'Product', name: 'GPU graphics card RTX 4070', sku: 'GPU-1', url: 'https://www.olx.pl/d/oferta/gpu-1', offers: { '@type': 'Offer', price: '2000' } },
        { '@type': 'Product', name: 'GPU fan replacement', sku: 'GPU-2', url: 'https://www.olx.pl/d/oferta/gpu-2', offers: { '@type': 'Offer', price: '80' } },
      ],
    })}</script>`;
    const result = await context.service.manualSearch({ query: 'gpu', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title), ['GPU graphics card RTX 4070']);
    assert.equal(result.sources[0].message, '1 matches · 1 excluded by AI');
    assert.equal(requests, 2);
  } finally { context.close(); }
});

test('writes and sends one explicit OLX negotiation message through the configured integrations', async () => {
  let sentUrl = '';
  let sentMessage = '';
  const context = fixture({
    draftNegotiation: async (listing) => {
      assert.equal(listing.marketplace, 'OLX');
      assert.equal(listing.offerPrice, 1700);
      return { message: 'Dzień dobry, czy rozważy Pan/Pani 1700 zł za ten przedmiot?' };
    },
    sendOlxMessage: async (listingUrl, message) => {
      sentUrl = listingUrl;
      sentMessage = message;
    },
  });
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    context.service.saveMarketplaceSession('OLX', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.olx.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }] });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, price_negotiable, url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'negotiation-listing', 'Steam Deck OLED 512GB', 1899, 1, 'https://www.olx.pl/d/oferta/negotiation-listing', 'Like new', 'Warszawa', now, now);

    const result = await context.service.negotiateAndSendByKey('OLX:negotiation-listing', 1700);
    assert.equal(sentUrl, 'https://www.olx.pl/d/oferta/negotiation-listing');
    assert.equal(sentMessage, 'Dzień dobry, czy rozważy Pan/Pani 1700 zł za ten przedmiot?');
    assert.equal(result.message.status, 'sent');
    assert.equal(result.message.offerPrice, 1700);
    assert.equal(context.service.messages()[0].message, sentMessage);
  } finally { context.close(); }
});

test('writes and sends one explicit Allegro Lokalnie negotiation message through its session', async () => {
  let sentUrl = '';
  let sentMessage = '';
  const context = fixture({
    draftNegotiation: async (listing) => {
      assert.equal(listing.marketplace, 'Allegro Lokalnie');
      assert.equal(listing.offerPrice, 1700);
      return { message: 'Dzień dobry, czy rozważy Pan/Pani 1700 zł za ten przedmiot?' };
    },
    sendAllegroMessage: async (listingUrl, message) => {
      sentUrl = listingUrl;
      sentMessage = message;
    },
  });
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    context.service.saveMarketplaceSession('Allegro Lokalnie', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.allegrolokalnie.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }] });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, price_negotiable, url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('Allegro Lokalnie', 'negotiation-listing', 'Steam Deck OLED 512GB', 1899, 1, 'https://allegrolokalnie.pl/oferta/negotiation-listing', 'Like new', 'Warszawa', now, now);

    const result = await context.service.negotiateAndSendByKey('Allegro Lokalnie:negotiation-listing', 1700);
    assert.equal(sentUrl, 'https://allegrolokalnie.pl/oferta/negotiation-listing');
    assert.equal(sentMessage, 'Dzień dobry, czy rozważy Pan/Pani 1700 zł za ten przedmiot?');
    assert.equal(result.message.marketplace, 'Allegro Lokalnie');
    assert.equal(result.message.status, 'sent');
    assert.equal(context.service.messages()[0].marketplace, 'Allegro Lokalnie');
  } finally { context.close(); }
});

test('enforces a total-cost ceiling before sending an OLX offer', async () => {
  let sendCount = 0;
  const context = fixture({
    draftNegotiation: async () => ({ message: 'Dzień dobry, czy rozważy Pan/Pani 900 zł?' }),
    sendOlxMessage: async () => { sendCount += 1; },
  });
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    context.service.saveMarketplaceSession('OLX', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.olx.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }] });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, price_negotiable, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'budget-listing', 'Steam Deck OLED 512GB', 1000, 1, 'https://www.olx.pl/d/oferta/budget-listing', now, now);

    await assert.rejects(
      () => context.service.negotiateAndSendByKey('OLX:budget-listing', 900, { maxTotalCost: 920, shippingCost: 50 }),
      /cannot exceed your 870 zł total-cost ceiling/,
    );
    assert.equal(sendCount, 0);
  } finally { context.close(); }
});

test('runs one bounded automatic OLX negotiation per qualifying listing', async () => {
  let sendCount = 0;
  const context = fixture({
    draftNegotiation: async (listing) => {
      assert.equal(listing.offerPrice, 1670);
      return { message: 'Dzień dobry, czy rozważy Pan/Pani 1670 zł za ten przedmiot?' };
    },
    sendOlxMessage: async () => { sendCount += 1; },
  });
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({
      ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' },
      autoNegotiation: { enabled: true, maxTotalCost: 1800, shippingCost: 50, dailyLimit: 2 },
    });
    context.service.saveMarketplaceSession('OLX', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.olx.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }] });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, price_negotiable, url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'automatic-listing', 'Steam Deck OLED 512GB', 1899, 1, 'https://www.olx.pl/d/oferta/automatic-listing', 'Like new', 'Warszawa', now, now);
    const candidate = {
      watchId: 'automatic-watch',
      listing: { marketplace: 'OLX' as const, listingId: 'automatic-listing', title: 'Steam Deck OLED 512GB', price: 1899, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/automatic-listing', observedAt: now, priceNegotiable: true },
      typical: 2500,
      discountPercent: 24,
      confidence: 95,
    };

    await (context.service as any).automaticallyNegotiate(candidate);
    await (context.service as any).automaticallyNegotiate(candidate);

    assert.equal(sendCount, 1);
    assert.equal((context.db.prepare('SELECT status, offer_price_pln FROM automatic_negotiations WHERE marketplace = ? AND listing_id = ?').get('OLX', 'automatic-listing') as { status: string; offer_price_pln: number }).status, 'sent');
    assert.equal((context.db.prepare('SELECT offer_price_pln FROM automatic_negotiations WHERE marketplace = ? AND listing_id = ?').get('OLX', 'automatic-listing') as { offer_price_pln: number }).offer_price_pln, 1670);
    assert.equal(context.service.messages()[0].source, 'automatic');
    assert.equal(context.service.settings().autoNegotiation.attemptedToday, 1);
    assert.equal(context.service.settings().autoNegotiation.sentToday, 1);
  } finally { context.close(); }
});

test('runs one bounded automatic Allegro Lokalnie negotiation per qualifying listing', async () => {
  let sendCount = 0;
  const context = fixture({
    draftNegotiation: async (listing) => {
      assert.equal(listing.marketplace, 'Allegro Lokalnie');
      assert.equal(listing.offerPrice, 1670);
      return { message: 'Dzień dobry, czy rozważy Pan/Pani 1670 zł za ten przedmiot?' };
    },
    sendAllegroMessage: async () => { sendCount += 1; },
  });
  try {
    const now = new Date().toISOString();
    context.service.saveSettings({
      ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' },
      autoNegotiation: { enabled: true, maxTotalCost: 1800, shippingCost: 50, dailyLimit: 2 },
    });
    context.service.saveMarketplaceSession('Allegro Lokalnie', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.allegrolokalnie.pl', path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }] });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, price_negotiable, url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('Allegro Lokalnie', 'automatic-listing', 'Steam Deck OLED 512GB', 1899, 1, 'https://allegrolokalnie.pl/oferta/automatic-listing', 'Like new', 'Warszawa', now, now);
    const candidate = {
      watchId: 'automatic-watch',
      listing: { marketplace: 'Allegro Lokalnie' as const, listingId: 'automatic-listing', title: 'Steam Deck OLED 512GB', price: 1899, currency: 'PLN' as const, url: 'https://allegrolokalnie.pl/oferta/automatic-listing', observedAt: now, priceNegotiable: true },
      typical: 2500,
      discountPercent: 24,
      confidence: 95,
    };

    await (context.service as any).automaticallyNegotiate(candidate);
    await (context.service as any).automaticallyNegotiate(candidate);

    assert.equal(sendCount, 1);
    assert.equal((context.db.prepare('SELECT status, offer_price_pln FROM automatic_negotiations WHERE marketplace = ? AND listing_id = ?').get('Allegro Lokalnie', 'automatic-listing') as { status: string; offer_price_pln: number }).status, 'sent');
    assert.equal((context.db.prepare('SELECT offer_price_pln FROM automatic_negotiations WHERE marketplace = ? AND listing_id = ?').get('Allegro Lokalnie', 'automatic-listing') as { status: string; offer_price_pln: number }).offer_price_pln, 1670);
    assert.equal(context.service.messages()[0].marketplace, 'Allegro Lokalnie');
    assert.equal(context.service.messages()[0].source, 'automatic');
    assert.equal(context.service.settings().autoNegotiation.attemptedToday, 1);
    assert.equal(context.service.settings().autoNegotiation.sentToday, 1);
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

test('applies numbered migrations idempotently and resumes interrupted scans truthfully', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-migrations-'));
  const databasePath = join(directory, 'scout.sqlite');
  let db = openDatabase(databasePath);
  try {
    assert.deepEqual((db.prepare('SELECT id FROM migrations ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id), ['001_init', '002_correctness', '003_auto_negotiation', '004_daily_digests', '005_ai_cache', '006_ai_cache_reuse', '007_exceptional_description_verification', '008_listing_detail_snapshots', '009_recovery_integrity', '010_listing_feed_index', '011_connector_health_index']);
    assert.equal((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys, 1);
    db.prepare('INSERT INTO scans (watch_id, watch_kind, marketplace, status, started_at) VALUES (?, ?, ?, ?, ?)').run('restart-watch', 'watch', 'OLX', 'running', new Date().toISOString());
    db.close();

    db = openDatabase(databasePath);
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM migrations WHERE id = '002_correctness'").get() as { count: number }).count, 1);
    assert.equal((db.prepare('SELECT status FROM scans WHERE watch_id = ?').get('restart-watch') as { status: string }).status, 'interrupted');
  } finally {
    try { db.close(); } catch { /* already closed after a failed assertion */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

test('keeps shared listings associated with each watch and archives without deleting history', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    seedWatch(context.db, 'watch-a');
    seedWatch(context.db, 'watch-b');
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, typical_pln, url, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'shared-listing', 'Shared CPU', 900, 9999, 'https://www.olx.pl/d/oferta/shared-listing', now, now);
    const listing = context.db.prepare("SELECT id FROM listings WHERE listing_id = 'shared-listing'").get() as { id: number };
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'watch-a', 900, now);
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'watch-b', 850, now);
    const associations = context.db.prepare('SELECT id, watch_id FROM watch_listings WHERE listing_id = ? ORDER BY watch_id').all(listing.id) as Array<{ id: number; watch_id: string }>;
    assert.deepEqual(associations.map((row) => row.watch_id), ['watch-a', 'watch-b']);
    context.db.prepare('UPDATE watch_listings SET typical_pln = CASE watch_id WHEN ? THEN ? ELSE ? END WHERE listing_id = ?').run('watch-a', 1200, 1000, listing.id);

    const visible = context.service.getListings().filter((row) => row.listingId === 'shared-listing');
    assert.equal(visible.length, 2);
    assert.deepEqual(new Set(visible.map((row) => row.associationId)).size, 2);
    assert.deepEqual(new Set(visible.map((row) => row.watchId)), new Set(['watch-a', 'watch-b']));
    assert.deepEqual(context.service.listingDetail('OLX:shared-listing', 'watch-a').history.map((point) => point.price), [900]);
    assert.deepEqual(context.service.listingDetail('OLX:shared-listing', 'watch-b').history.map((point) => point.price), [850]);

    context.service.archiveWatch('watch-a', true);
    assert.deepEqual(context.service.getWatches().map((watch) => watch.id), ['watch-b']);
    assert.equal(context.service.allWatches().find((watch) => watch.id === 'watch-a')?.status, 'Archived');
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE watch_id = ?').get('watch-a') as { count: number }).count, 1);
    context.service.archiveWatch('watch-a', false);
    assert.equal(context.service.getWatches().some((watch) => watch.id === 'watch-a'), true);
    context.service.deleteWatch('watch-a');
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE watch_id = ?').get('watch-a') as { count: number }).count, 0);
  } finally { context.close(); }
});

test('hides matches after 12 hours while retaining their history', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    const fresh = new Date(Date.now() - 11 * 60 * 60_000).toISOString();
    const stale = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    seedWatch(context.db, 'freshness-watch');
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    insertListing.run('OLX', 'fresh-listing', 'Fresh CPU', 900, 'https://www.olx.pl/d/oferta/fresh-listing', fresh, fresh);
    insertListing.run('OLX', 'stale-listing', 'Stale CPU', 800, 'https://www.olx.pl/d/oferta/stale-listing', stale, stale);
    const freshId = (context.db.prepare("SELECT id FROM listings WHERE listing_id = 'fresh-listing'").get() as { id: number }).id;
    const staleId = (context.db.prepare("SELECT id FROM listings WHERE listing_id = 'stale-listing'").get() as { id: number }).id;
    insertObservation.run(freshId, 'freshness-watch', 900, fresh);
    insertObservation.run(staleId, 'freshness-watch', 800, stale);

    assert.deepEqual(context.service.getListings().map((listing) => listing.listingId), ['fresh-listing']);
    assert.deepEqual(context.service.dashboard().listings.map((listing) => listing.listingId), ['fresh-listing']);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM watch_listings WHERE watch_id = ?').get('freshness-watch') as { count: number }).count, 2);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE watch_id = ?').get('freshness-watch') as { count: number }).count, 2);
    assert.ok(Date.parse(now) > Date.parse(fresh));
  } finally { context.close(); }
});

test('keeps AI failures visible as unknown instead of silently excluding listings', async () => {
  let requests = 0;
  const context = fixture({
    classifyListingRelevance: async () => {
      requests += 1;
      throw new Error('DeepSeek timeout');
    },
  });
  try {
    seedWatch(context.db, 'unknown-watch');
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    const listing = { marketplace: 'OLX' as const, listingId: 'unknown-listing', title: 'CPU', price: 500, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/unknown-listing', observedAt: new Date().toISOString() };
    const filter = (context.service as any).filterListingsByAiRelevance.bind(context.service) as (items: typeof listing[], search: any, watchId: string, enabled: boolean) => Promise<any>;
    const result = await filter([listing], { query: 'cpu', includedTerms: '', excludedTerms: '' }, 'unknown-watch', true);
    assert.deepEqual(result.listings.map((item: typeof listing) => item.listingId), ['unknown-listing']);
    assert.equal(result.excluded, 0);
    assert.equal(result.unknown, 1);
    const stored = context.db.prepare('SELECT relevant, relevance_status, error FROM listing_relevance WHERE watch_id = ?').get('unknown-watch') as { relevant: number; relevance_status: string; error: string };
    assert.deepEqual({ relevant: stored.relevant, relevance_status: stored.relevance_status }, { relevant: 1, relevance_status: 'unknown' });
    assert.match(stored.error, /timeout/);
    await filter([listing], { query: 'cpu', includedTerms: '', excludedTerms: '' }, 'unknown-watch', true);
    assert.equal(requests, 2);
  } finally { context.close(); }
});

test('applies manual price filters after marketplace parsing rather than trusting URL parameters', async () => {
  const context = fixture();
  try {
    (context.service as any).fetchPublicPage = async () => `<script type="application/ld+json">${JSON.stringify({
      '@type': 'ItemList', itemListElement: [
        { '@type': 'Product', name: 'CPU 50', sku: 'cpu-50', url: 'https://www.olx.pl/d/oferta/cpu-50', offers: { price: '50' } },
        { '@type': 'Product', name: 'CPU 150', sku: 'cpu-150', url: 'https://www.olx.pl/d/oferta/cpu-150', offers: { price: '150' } },
        { '@type': 'Product', name: 'CPU 250', sku: 'cpu-250', url: 'https://www.olx.pl/d/oferta/cpu-250', offers: { price: '250' } },
      ],
    })}</script>`;
    const result = await context.service.manualSearch({ query: 'cpu', sources: ['OLX'], minPrice: 100, maxPrice: 200, terms: '', excluded: '', shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.price), [150]);
  } finally { context.close(); }
});

test('does not fetch listing details for shipping when manual search does not require it', async () => {
  const context = fixture();
  const fetchedUrls: string[] = [];
  try {
    (context.service as any).fetchPublicPage = async (url: string) => {
      fetchedUrls.push(url);
      return `<script type="application/ld+json">${JSON.stringify({
        '@type': 'Product', name: 'CPU', sku: 'cpu-vinted', url: 'https://www.vinted.pl/items/123', offers: { price: '150' },
      })}</script>`;
    };
    const result = await context.service.manualSearch({ query: 'cpu', sources: ['Vinted'], minPrice: null, maxPrice: null, terms: '', excluded: '', shippingOnly: false, condition: 'Any', location: '' });
    assert.equal(fetchedUrls.length, 1);
    assert.equal(result.sources[0].pendingShipping, 0);
  } finally { context.close(); }
});

test('records failed scans and does not persist partial normal-watch data', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'failed-scan');
    (context.service as any).fetchPublicPage = async () => '<html><body><p>Unsupported marketplace markup</p></body></html>';
    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('failed-scan');
    await (context.service as any).runWatch(row);
    assert.equal((context.db.prepare("SELECT status FROM scans WHERE watch_id = ?").get('failed-scan') as { status: string }).status, 'failed');
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM observations WHERE watch_id = ?').get('failed-scan') as { count: number }).count, 0);
    assert.equal((context.db.prepare("SELECT status FROM connector_runs WHERE source = 'OLX' ORDER BY id DESC LIMIT 1").get() as { status: string }).status, 'error');
  } finally { context.close(); }
});

test('verifies missing research listings before ending them and leaves transient failures as unknown', async () => {
  const context = fixture();
  try {
    context.service.createMarketWatch({ id: 'availability-watch', name: 'Availability', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false });
    const now = new Date().toISOString();
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'live', ?)`);
    insert.run('availability-watch', 'availability-watch:v1', 'OLX', 'terminal-listing', 'Terminal CPU', 'https://www.olx.pl/d/oferta/terminal-listing', 100, 100, 100, now, now, now);
    insert.run('availability-watch', 'availability-watch:v1', 'OLX', 'transient-listing', 'Transient CPU', 'https://www.olx.pl/d/oferta/transient-listing', 100, 100, 100, now, now, now);
    insert.run('availability-watch', 'availability-watch:v1', 'OLX', 'live-listing', 'Live CPU', 'https://www.olx.pl/d/oferta/live-listing', 100, 100, 100, now, now, now);
    context.db.prepare("UPDATE market_listings SET missing_scans = 2 WHERE listing_id = 'transient-listing'").run();
    let mode: 'terminal' | 'live' | 'failure' = 'terminal';
    (context.service as any).fetchPublicPage = async (url: string) => {
      if (mode === 'failure') throw new Error('Marketplace timeout');
      if (url.includes('/oferta/terminal-listing')) return '<html><body><h1>Ogłoszenie jest niedostępne</h1><p>Ta oferta została usunięta z serwisu.</p></body></html>';
      if (url.includes('/oferta/live-listing')) return '<html><body><div data-testid="ad-card-title">CPU</div><button>Wyślij wiadomość</button></body></html>';
      return '<html><body><div data-testid="no-results">No results</div></body></html>';
    };
    const row = context.db.prepare('SELECT * FROM market_watches WHERE id = ?').get('availability-watch');
    for (let scan = 0; scan < 3; scan += 1) await (context.service as any).runMarketWatch(row);
    const terminal = context.db.prepare("SELECT status, missing_scans, availability_status, ended_reason FROM market_listings WHERE listing_id = 'terminal-listing'").get() as { status: string; missing_scans: number; availability_status: string; ended_reason: string };
    assert.deepEqual({ status: terminal.status, missing_scans: terminal.missing_scans, availability_status: terminal.availability_status }, { status: 'ended', missing_scans: 3, availability_status: 'terminal' });
    assert.match(terminal.ended_reason, /unavailable|HTTP/i);

    mode = 'failure';
    await (context.service as any).runMarketWatch(row);
    const transient = context.db.prepare("SELECT status, missing_scans FROM market_listings WHERE listing_id = 'transient-listing'").get() as { status: string; missing_scans: number };
    assert.equal(transient.status, 'active');
    assert.equal(transient.missing_scans, 2);
    mode = 'live';
    await (context.service as any).runMarketWatch(row);
    const live = context.db.prepare("SELECT status, missing_scans, availability_status FROM market_listings WHERE listing_id = 'live-listing'").get() as { status: string; missing_scans: number; availability_status: string };
    assert.equal(live.status, 'active');
    assert.equal(live.missing_scans, 0);
    assert.equal(live.availability_status, 'live');
    assert.equal((context.db.prepare("SELECT COUNT(*) AS count FROM scans WHERE watch_id = ? AND status = 'completed'").get('availability-watch') as { count: number }).count, 4);
    assert.equal((context.db.prepare("SELECT COUNT(*) AS count FROM scans WHERE watch_id = ? AND status = 'failed'").get('availability-watch') as { count: number }).count, 1);
  } finally { context.close(); }
});

test('creates immutable research series and computes aggregates across the full result set', () => {
  const context = fixture();
  try {
    context.service.createMarketWatch({ id: 'version-watch', name: 'Versioned', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false });
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`).run('version-watch', 'version-watch:v1', 'OLX', 'old-series', 'Old CPU', 'https://www.olx.pl/d/oferta/old-series', 100, 100, 100, now, now);
    context.service.updateMarketWatch('version-watch', { query: 'new cpu' });
    const versions = context.db.prepare('SELECT id, closed_at FROM market_watch_versions WHERE market_watch_id = ? ORDER BY created_at').all('version-watch') as Array<{ id: string; closed_at: string | null }>;
    assert.equal(versions.length, 2);
    assert.equal(versions[0].id, 'version-watch:v1');
    assert.ok(versions[0].closed_at);
    assert.equal((context.db.prepare("SELECT status FROM market_listings WHERE listing_id = 'old-series'").get() as { status: string }).status, 'superseded');
    assert.equal(context.service.marketResearch().watches.find((watch) => watch.id === 'version-watch')?.totalListings, 0);
    assert.equal(context.service.marketResearch({ status: 'superseded' }).listings[0].status, 'superseded');

    context.service.createMarketWatch({ id: 'median-watch', name: 'Median', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false });
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ended', 3)`);
    for (let price = 1; price <= 401; price += 1) insert.run('median-watch', 'median-watch:v1', 'OLX', `median-${price}`, 'CPU', `https://www.olx.pl/d/oferta/median-${price}`, price, price, price, now, now);
    const research = context.service.marketResearch({ page: 2, pageSize: 100, watchId: 'median-watch' });
    assert.equal(research.aggregates?.overallMedianPrice, 201);
    assert.deepEqual(research.pagination, { page: 2, pageSize: 100, total: 401, hasNext: true });
    assert.equal(research.listings.length, 100);
  } finally { context.close(); }
});

test('retries failed notifications without duplicating alerts and keeps state per watch', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async () => {
    attempts += 1;
    return attempts === 1 ? new Response(null, { status: 500 }) : new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    seedWatch(context.db, 'notification-watch');
    context.service.saveSettings({ webhook: 'https://discord.com/api/webhooks/123/token' });
    const listing = { marketplace: 'OLX' as const, listingId: 'retry-listing', title: 'CPU deal', price: 800, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/retry-listing', observedAt: new Date().toISOString() };
    const notifyDeal = (context.service as any).notifyDeal.bind(context.service) as (...args: any[]) => Promise<void>;
    await notifyDeal('notification-watch', listing, 1000, 20, 90);
    await notifyDeal('notification-watch', listing, 1000, 20, 90);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get() as { count: number }).count, 1);
    context.db.prepare('UPDATE notification_deliveries SET next_attempt_at = ?').run(new Date(Date.now() - 1000).toISOString());
    await (context.service as any).processNotificationRetries();
    const delivery = context.db.prepare('SELECT status, attempt_count, message FROM notification_deliveries').get() as { status: string; attempt_count: number; message: string };
    assert.deepEqual({ status: delivery.status, attempt_count: delivery.attempt_count }, { status: 'delivered', attempt_count: 2 });
    assert.match(delivery.message, /Discord returned 500/);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM watch_listing_alert_state WHERE watch_id = ?').get('notification-watch') as { count: number }).count, 1);
    assert.equal((context.db.prepare("SELECT status FROM notifications").get() as { status: string }).status, 'delivered');

    const staleListing = { marketplace: 'OLX' as const, listingId: 'stale-listing', title: 'Stale CPU deal', price: 700, currency: 'PLN' as const, url: 'https://www.olx.pl/d/oferta/stale-listing', observedAt: new Date().toISOString() };
    const staleEventKey = 'notification-watch|OLX|stale-listing|alert:1';
    const staleDeliveryKey = `${staleEventKey}|channel:Discord`;
    const staleAt = new Date(Date.now() - 16 * 60_000).toISOString();
    context.db.prepare('INSERT INTO notifications (listing_key, payload_json, status, created_at) VALUES (?, ?, ?, ?)').run(staleEventKey, JSON.stringify({ _scout: { watchId: 'notification-watch', listing: staleListing, typical: 1000, discountPercent: 30, confidence: 90, priority: 'exceptional', sequence: 1 } }), 'pending', staleAt);
    context.db.prepare('INSERT INTO notification_deliveries (listing_key, channel, status, attempt_count, updated_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(staleDeliveryKey, 'Discord', 'pending', 1, staleAt, staleAt);
    await (context.service as any).processNotificationRetries();
    const staleDelivery = context.db.prepare('SELECT status, attempt_count FROM notification_deliveries WHERE listing_key = ?').get(staleDeliveryKey) as { status: string; attempt_count: number };
    assert.equal(staleDelivery.status, 'delivered');
    assert.equal(staleDelivery.attempt_count, 2);
    await notifyDeal('notification-watch', listing, 1000, 20, 90);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get() as { count: number }).count, 2);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('reports database and scheduler readiness separately from the lightweight health check', () => {
  const context = fixture();
  try {
    const before = context.service.readiness();
    assert.equal(before.database.ok, true);
    assert.equal(before.status, 'not-ready');
    context.service.schedulerTick();
    const after = context.service.readiness();
    assert.equal(after.status, 'ready');
    assert.equal(after.scheduler.healthy, true);
    assert.equal(after.migrations.count, 11);
  } finally { context.close(); }
});
