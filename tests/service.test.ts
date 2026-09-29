import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { parseMarketplaceStorageState } from '../server/marketplace-sessions';
import { DeepSeekError } from '../server/ai';
import { listingDescriptionVerificationInputHash, listingRelevanceInputHash } from '../server/ai';
import { VisionError } from '../server/vision';
import { ScoutService, ServiceError, decryptSecret, encryptSecret, dueWatchSources, filterListings, findFuzzyRescueCandidates, marketStatusAfterMiss, nextWatchScanAt, nextWatchScanSchedule, normalizeSourceIntervals, validateDiscordWebhook, watchSourceIntervals, type ScoutServiceDependencies } from '../server/service';

// Pin the legacy DeepSeek path for pre-existing tests: live Jev is the
// production default whenever a key is available, but these tests assert
// legacy behavior. Live-path tests below opt in explicitly via liveJevEnv().
if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

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
    const latestPlan = context.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM connector_runs WHERE source = ? ORDER BY started_at DESC, id DESC LIMIT 1').all('OLX') as Array<{ detail: string }>;
    assert.ok(latestPlan.some((row) => row.detail.includes('connector_runs_source_latest')));
    const countPlan = context.db.prepare('EXPLAIN QUERY PLAN SELECT source, COUNT(*) AS count FROM connector_runs GROUP BY source').all() as Array<{ detail: string }>;
    assert.equal(countPlan.some((row) => row.detail.includes('USE TEMP B-TREE')), false);
    assert.equal(countPlan.some((row) => row.detail.includes('connector_runs_source_latest')), true);
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

test('resolves per-marketplace intervals with a safety floor and default fallback', () => {
  assert.deepEqual(watchSourceIntervals(['OLX', 'Vinted'], 15, { OLX: 30 }), { OLX: 30, Vinted: 15 });
  assert.deepEqual(watchSourceIntervals(['OLX', 'Vinted'], 15, { OLX: 3 }), { OLX: 5, Vinted: 15 });
  assert.deepEqual(watchSourceIntervals(['OLX'], 15, { Vinted: 60 }), { OLX: 15 });
  assert.deepEqual(normalizeSourceIntervals(['OLX'], { OLX: 30, Vinted: 60 }), { OLX: 30 });
  assert.deepEqual(normalizeSourceIntervals(['Vinted'], {}), {});
});

test('scans only the marketplaces whose interval has elapsed', () => {
  const now = Date.parse('2026-08-23T12:00:00.000Z');
  const next = {
    OLX: '2026-08-23T11:55:00.000Z',
    Vinted: '2026-08-23T12:30:00.000Z',
    'Allegro Lokalnie': undefined,
  };
  assert.deepEqual(dueWatchSources(['OLX', 'Vinted', 'Allegro Lokalnie'], next, now), ['OLX', 'Allegro Lokalnie']);
  assert.deepEqual(dueWatchSources(['OLX', 'Vinted'], next, now), ['OLX']);
});

test('advances each scanned marketplace on its own interval and keeps the earliest next scan', () => {
  const finished = new Date(2026, 7, 23, 12, 0, 0, 0).toISOString();
  const vintedNext = new Date(2026, 7, 23, 12, 30, 0, 0).toISOString();
  const { nextBySource, nextScanAt } = nextWatchScanSchedule({
    sources: ['OLX', 'Vinted'],
    intervals: { OLX: 10, Vinted: 60 },
    prior: { Vinted: vintedNext },
    scanned: ['OLX'],
    finishedAt: finished,
    nightIntervalMinutes: 30,
  });
  assert.equal((Date.parse(nextBySource.OLX) - Date.parse(finished)) / 60_000, 10);
  assert.equal(nextBySource.Vinted, vintedNext);
  assert.equal(nextScanAt, nextBySource.OLX);
});

test('honors connector backoff when advancing a scanned marketplace', () => {
  const finished = new Date(2026, 7, 23, 12, 0, 0, 0).toISOString();
  const backoff = new Date(2026, 7, 23, 12, 45, 0, 0).toISOString();
  const { nextBySource, nextScanAt } = nextWatchScanSchedule({
    sources: ['OLX'],
    intervals: { OLX: 5 },
    prior: {},
    scanned: ['OLX'],
    finishedAt: finished,
    nightIntervalMinutes: 30,
    backoff: { OLX: backoff },
  });
  assert.equal(nextBySource.OLX, backoff);
  assert.equal(nextScanAt, backoff);
});

test('surfaces stored per-marketplace intervals and drops stale sources', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, source_intervals_json, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('interval-watch', 'Interval watch', 'cpu', '["OLX","Vinted"]', '{"OLX":45,"Vinted":120}', now, now, now);
    const watch = context.service.getWatches().find((item) => item.id === 'interval-watch');
    assert.deepEqual(watch?.sourceIntervals, { OLX: 45, Vinted: 120 });
    context.db.prepare('UPDATE watches SET sources_json = ? WHERE id = ?').run('["OLX"]', 'interval-watch');
    const narrowed = context.service.getWatches().find((item) => item.id === 'interval-watch');
    assert.deepEqual(narrowed?.sourceIntervals, { OLX: 45 });
  } finally { context.close(); }
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

test('bootstraps anonymous Vinted cookies once and re-bootstraps on a 401', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const cookieHeaders = new Headers();
  cookieHeaders.append('set-cookie', 'access_token_web=jwt-token; Path=/; Domain=.vinted.pl; HttpOnly');
  cookieHeaders.append('set-cookie', '__cf_bm=cf-cookie; Path=/; Domain=.vinted.pl');
  let bootstraps = 0;
  let apiCalls = 0;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === 'https://www.vinted.pl/') {
      bootstraps += 1;
      return new Response(null, { status: 200, headers: cookieHeaders });
    }
    if (url.startsWith('https://www.vinted.pl/api/v2/catalog/items')) {
      apiCalls += 1;
      if (apiCalls === 3) return new Response(JSON.stringify({ code: 100, message: 'invalid_authentication_token' }), { status: 401, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ items: [], pagination: { current_page: 1, total_pages: 0, total_entries: 0, per_page: 20 }, code: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
  try {
    const fetchVintedApi = (context.service as any).fetchVintedApi.bind(context.service) as (url: string) => Promise<{ status: number; json: unknown }>;
    const apiUrl = 'https://www.vinted.pl/api/v2/catalog/items?search_text=lego&per_page=20';
    assert.equal((await fetchVintedApi(apiUrl)).status, 200);
    assert.equal(bootstraps, 1);
    assert.equal(apiCalls, 1);
    assert.equal(requests[0].url, 'https://www.vinted.pl/');
    const cookie = (requests[1].init?.headers as Record<string, string>).cookie;
    assert.match(cookie, /access_token_web=jwt-token/);
    assert.match(cookie, /__cf_bm=cf-cookie/);
    assert.equal((requests[1].init?.headers as Record<string, string>)['user-agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36');

    assert.equal((await fetchVintedApi(apiUrl)).status, 200);
    assert.equal(bootstraps, 1);
    assert.equal(apiCalls, 2);

    assert.equal((await fetchVintedApi(apiUrl)).status, 200);
    assert.equal(bootstraps, 2);
    assert.equal(apiCalls, 4);
    assert.equal(requests[4].url, 'https://www.vinted.pl/');
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('fails Vinted cookie bootstrap closed when the homepage is fenced', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input) => {
    assert.equal(String(input), 'https://www.vinted.pl/');
    return new Response('<html><body>Cloudflare challenge</body></html>', { status: 403 });
  }) as typeof fetch;
  try {
    const fetchVintedApi = (context.service as any).fetchVintedApi.bind(context.service) as (url: string) => Promise<{ status: number; json: unknown }>;
    await assert.rejects(() => fetchVintedApi('https://www.vinted.pl/api/v2/catalog/items?search_text=lego'), /anonymous access token/);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
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

test('summarizes current Exceptional/Very strong/Strong findings per watch', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    const stale = new Date(Date.now() - 13 * 60 * 60_000).toISOString();
    seedWatch(context.db, 'deal-counts-watch');
    const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, typical_pln, shipping_available, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    const setDeal = context.db.prepare('UPDATE watch_listings SET deal_strength = ?, deal_label = ?, last_seen_at = ? WHERE watch_id = ? AND listing_id = ?');
    const deals: Array<[string, number, string, string]> = [
      ['deal-5', 5, 'Exceptional', now],
      ['deal-4', 4, 'Very strong', now],
      ['deal-3', 3, 'Strong', now],
      ['deal-2', 2, 'Watch', now],
      ['deal-stale', 5, 'Exceptional', stale],
      ['deal-hidden', 5, 'Exceptional', now],
    ];
    for (const [listingId, strength, label, seenAt] of deals) {
      insertListing.run('OLX', listingId, listingId, 100, 500, 1, `https://www.olx.pl/d/oferta/${listingId}`, now, now);
      const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get(listingId) as { id: number };
      insertObservation.run(listing.id, 'deal-counts-watch', 100, seenAt);
      setDeal.run(strength, label, seenAt, 'deal-counts-watch', listing.id);
    }
    context.db.prepare('INSERT INTO listing_actions (marketplace, listing_id, decision, note, hidden, updated_at) VALUES (?, ?, NULL, ?, 1, ?)').run('OLX', 'deal-hidden', '', now);
    const [watch] = context.service.getWatches();
    assert.deepEqual(watch.dealCounts, { exceptional: 1, veryStrong: 1, strong: 1 });
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
    const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get('triage-listing') as { id: number };
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'triage-watch', 450, firstSeen);
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(listing.id, 'triage-watch', 400, lastSeen);
    // The scan path refreshes the watch association through storeListing's
    // upsert (the observation-link trigger was dropped by migration 014);
    // this direct-insert fixture mirrors that for the latest observation.
    context.db.prepare('UPDATE watch_listings SET last_seen_at = ? WHERE watch_id = ? AND listing_id = ?').run(lastSeen, 'triage-watch', listing.id);

    const saved = context.service.updateListingAction('OLX:triage-listing', 'buy', 'Ask for a battery screenshot');
    assert.deepEqual(saved.decision, 'buy');
    assert.equal(saved.note, 'Ask for a battery screenshot');
    const feedListing = context.service.getListings()[0];
    assert.equal(feedListing.decision, 'buy');
    assert.equal(feedListing.priceNegotiable, true);
    const detail = context.service.listingDetail('OLX:triage-listing');
    assert.deepEqual(detail.history.map((point) => point.price), [450, 400]);
    assert.equal(detail.action.decision, 'buy');
    assert.equal(detail.action.note, 'Ask for a battery screenshot');

    context.service.updateListingAction('OLX:triage-listing', null, '');
    assert.equal(context.service.listingDetail('OLX:triage-listing').action.decision, null);
    assert.equal(context.service.listingDetail('OLX:triage-listing').action.note, '');
  } finally { context.close(); }
});

test('hides and unhides a listing without deleting its history', () => {
  const context = fixture();
  try {
    const firstSeen = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const lastSeen = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('hidden-watch', 'Hidden watch', 'brakes', '["OLX"]', 1, lastSeen, firstSeen, lastSeen);
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'hidden-listing', 'Cheap brake pads', 500, 'https://www.olx.pl/d/oferta/hidden-listing', firstSeen, lastSeen);
    const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get('hidden-listing') as { id: number };
    context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run('hidden-watch', listing.id, firstSeen, lastSeen);

    assert.equal(context.service.getListings()[0].hidden, false);
    assert.equal(context.service.dashboard().stats.newToday, 1);

    const hiddenAction = context.service.updateListingAction('OLX:hidden-listing', null, '', true);
    assert.equal(hiddenAction.hidden, true);
    assert.equal(context.service.listingAction('OLX:hidden-listing').hidden, true);
    assert.equal(context.service.getListings()[0].hidden, true);
    // Hidden listings are excluded from the dashboard counters.
    assert.equal(context.service.dashboard().stats.newToday, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_actions WHERE marketplace = ? AND listing_id = ?').get('OLX', 'hidden-listing') as { count: number }).count, 1);

    context.service.updateListingAction('OLX:hidden-listing', null, '', false);
    assert.equal(context.service.listingAction('OLX:hidden-listing').hidden, false);
    assert.equal(context.service.getListings()[0].hidden, false);
    // Unhiding with no decision or note removes the empty action row.
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_actions WHERE marketplace = ? AND listing_id = ?').get('OLX', 'hidden-listing') as { count: number }).count, 0);
  } finally { context.close(); }
});

test('filters and sorts the listings feed server-side across all rows', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare('INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('feed-watch', 'Feed watch', 'gpu', '["OLX"]', 1, now, now, now);
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, condition, location, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertLink = context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)');
    const add = (id: string, title: string, price: number, condition: string, location: string) => {
      insertListing.run('OLX', id, title, price, condition, location, `https://www.olx.pl/d/oferta/${id}`, now, now);
      const listing = context.db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get('OLX', id) as { id: number };
      insertLink.run('feed-watch', listing.id, now, now);
    };
    add('feed-cheap', 'GPU RTX 4070', 1500, 'Używane', 'Warszawa');
    add('feed-mid', 'GPU RTX 4070 Ti', 2500, 'Nowe', 'Kraków');
    add('feed-pricey', 'Karta graficzna RTX 4070', 3500, 'Używane', 'Warszawa');
    context.service.updateListingAction('OLX:feed-mid', 'buy', 'worth it');
    context.service.updateListingAction('OLX:feed-pricey', null, '', true);

    // `q` covers title, condition, and location, and the total follows the filter.
    assert.deepEqual(context.service.listingsPage({ q: 'kraków' }).listings.map((listing) => listing.id), ['OLX:feed-mid']);
    assert.deepEqual(context.service.listingsPage({ q: 'używane' }).listings.map((listing) => listing.id).sort(), ['OLX:feed-cheap', 'OLX:feed-pricey']);
    assert.equal(context.service.listingsPage({ q: 'używane' }).pagination.total, 2);
    // Internal callers keep every row; the endpoint opts into visible-only.
    assert.equal(context.service.listingsPage({}).listings.length, 3);
    assert.deepEqual(context.service.listingsPage({ visibility: 'visible' }).listings.map((listing) => listing.id).sort(), ['OLX:feed-cheap', 'OLX:feed-mid']);
    assert.deepEqual(context.service.listingsPage({ visibility: 'hidden' }).listings.map((listing) => listing.id), ['OLX:feed-pricey']);
    assert.deepEqual(context.service.listingsPage({ decision: 'buy' }).listings.map((listing) => listing.id), ['OLX:feed-mid']);
    // Sorting happens before the page window, so it covers every matching row.
    assert.deepEqual(context.service.listingsPage({ sort: 'price' }).listings.map((listing) => listing.id), ['OLX:feed-cheap', 'OLX:feed-mid', 'OLX:feed-pricey']);
    assert.deepEqual(context.service.listingsPage({ sort: 'price', page: 2, pageSize: 2 }).listings.map((listing) => listing.id), ['OLX:feed-pricey']);
  } finally { context.close(); }
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
      : '<html><body><h1>Steam Deck</h1></body></html>';
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'very-strong-listing', url: 'https://www.olx.pl/d/oferta/very-strong-listing', title: 'CPU very strong', created_time: baselineAt, params: [{ key: 'price', value: { value: 750, currency: 'PLN', negotiable: false } }] },
      { id: 'exceptional-listing', url: 'https://www.olx.pl/d/oferta/exceptional-listing', title: 'CPU exceptional', created_time: baselineAt, params: [{ key: 'price', value: { value: 650, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });

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

test('holds a high-priority alert when OpenRouter verification output is malformed', async () => {
  let verificationRequests = 0;
  const context = fixture({
    verifyListingDescription: async () => {
      verificationRequests += 1;
      throw new DeepSeekError('OpenRouter returned verification that was not valid JSON', 502, 'format');
    },
  });
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
    assert.equal(allowed, false);
    assert.equal(verificationRequests, 1);
    assert.equal((context.db.prepare('SELECT ai_description_verification_status FROM listings WHERE listing_id = ?').get('fallback-listing') as { ai_description_verification_status: string }).ai_description_verification_status, 'unknown');

    const reusedUnknown = await (context.service as any).verifyHighPriorityDeal(candidate);
    assert.equal(reusedUnknown, false);
    assert.equal(verificationRequests, 1);
  } finally {
    context.close();
  }
});

test('sends a high-priority alert when OpenRouter verification fails with a provider error', async () => {
  let verificationRequests = 0;
  const context = fixture({
    verifyListingDescription: async () => {
      verificationRequests += 1;
      throw new DeepSeekError('OpenRouter returned 502', 502, 'provider');
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

test('resets cached AI results', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    seedWatch(context.db, 'ai-reset-watch');
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      'OLX', 'ai-reset-listing', 'CPU', 650, 'https://www.olx.pl/d/oferta/ai-reset-listing', now, now,
    );
    const stored = context.db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get('OLX', 'ai-reset-listing') as { id: number };
    context.db.prepare(`INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, checked_at, relevance_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('ai-reset-watch', 'OLX', 'ai-reset-listing', 'hash-1', 'model-1', 1, 'relevant', now, 'relevant');
    context.db.prepare(`INSERT INTO jev_shadow_log (created_at, task, input_hash, jev_model) VALUES (?, ?, ?, ?)`).run(now, 'relevance', 'hash-1', 'model-1');
    context.db.prepare(`INSERT INTO listing_detail_snapshots (listing_id, marketplace, external_listing_id, title, price_pln, url, state_hash, verification_status, captured_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(stored.id, 'OLX', 'ai-reset-listing', 'CPU', 650, 'https://www.olx.pl/d/oferta/ai-reset-listing', 'state-1', 'pass', now);
    context.db.prepare(`UPDATE listings SET
      ai_description_verification_json = ?, ai_description_verification_status = ?, ai_description_verification_error = ?
      WHERE id = ?`).run('{}', 'fallback', 'boom', stored.id);

    const result = context.service.resetAiResults();
    assert.equal(result.ok, true);
    assert.deepEqual(result.cleared, { relevance: 1, shadowLog: 1, detailSnapshots: 1, verification: 1 });
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_relevance').get() as { count: number }).count, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM jev_shadow_log').get() as { count: number }).count, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_detail_snapshots').get() as { count: number }).count, 0);
    const cleared = context.db.prepare(`SELECT
      ai_description_verification_json, ai_description_verification_status, ai_description_verification_error
      FROM listings WHERE id = ?`).get(stored.id) as Record<string, unknown>;
    for (const column of ['ai_description_verification_json', 'ai_description_verification_status', 'ai_description_verification_error']) {
      assert.equal(cleared[column], null);
    }
  } finally {
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

test('applies the same AI relevance gate to one-off marketplace search', async () => {
  let requests = 0;
  const context = fixture({
    classifyListingRelevance: async (listing) => {
      requests += 1;
      return { relevant: !listing.title.toLowerCase().includes('fan') };
    },
  });
  try {
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'GPU-1', url: 'https://www.olx.pl/d/oferta/gpu-1', title: 'GPU graphics card RTX 4070', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 2000, currency: 'PLN', negotiable: false } }] },
      { id: 'GPU-2', url: 'https://www.olx.pl/d/oferta/gpu-2', title: 'GPU fan replacement', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 80, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });
    const result = await context.service.manualSearch({ query: 'gpu', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title), ['GPU graphics card RTX 4070']);
    assert.equal(result.sources[0].message, '1 matches · 1 excluded by AI');
    assert.equal(requests, 2);
    assert.equal((context.db.prepare("SELECT COUNT(*) AS count FROM listings WHERE listing_id = 'GPU-2'").get() as { count: number }).count, 0);
  } finally { context.close(); }
});

test('streams per-source manual search progress and honors the result page', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-service-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const emitted: Array<{ event: string; payload: any }> = [];
  const service = new ScoutService(db, (event, payload) => emitted.push({ event, payload }));
  const urls: string[] = [];
  (service as any).fetchOlxApi = async (url: string) => {
    urls.push(url);
    return { status: 200, json: { data: [
      { id: 'STREAM-1', url: 'https://www.olx.pl/d/oferta/stream-1', title: 'GPU RTX 4070', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 2000, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 1 } } };
  };
  try {
    const result = await service.manualSearch({ query: 'gpu', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '', page: 3, searchId: 'stream-1' });
    assert.equal(result.listings.length, 1);
    assert.match(urls[0], /offset=100/, 'the requested page maps to a marketplace offset');
    const progress = emitted.filter((entry) => entry.event === 'search');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].payload.searchId, 'stream-1');
    assert.equal(progress[0].payload.source, 'OLX');
    assert.equal(progress[0].payload.status.status, 'ok');
    assert.deepEqual(progress[0].payload.listings.map((listing: any) => listing.id), ['OLX:STREAM-1']);

    emitted.length = 0;
    await service.manualSearch({ query: 'gpu', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.equal(emitted.filter((entry) => entry.event === 'search').length, 0, 'no searchId means no streaming events');
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('keeps manual search results when AI relevance fails', async () => {
  const context = fixture({
    classifyListingRelevance: async () => { throw new Error('Marketplace timeout'); },
  });
  try {
    context.service.saveSettings({ ai: { apiKey: 'sk-deepseek-secret', model: 'deepseek-v4-flash' } });
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'GPU-1', url: 'https://www.olx.pl/d/oferta/gpu-1', title: 'GPU graphics card RTX 4070', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 2000, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 1 } } });
    const result = await context.service.manualSearch({ query: 'gpu', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title), ['GPU graphics card RTX 4070']);
    assert.equal(result.sources[0].message, '1 matches · 1 AI checks unknown');
  } finally { context.close(); }
});

test('partitions deterministic misses into term vs condition rescue candidates', () => {
  const base = (overrides: Record<string, any> = {}) => ({
    marketplace: 'OLX' as const, listingId: 'x', title: 'Ladowarka Dell 65W', price: 100, currency: 'PLN' as const,
    url: 'https://www.olx.pl/d/oferta/x', observedAt: new Date().toISOString(), condition: 'Nowe', location: 'Warszawa',
    shippingAvailable: null, priceNegotiable: null, ...overrides,
  });
  const listings = [
    base({ listingId: 'exact', title: 'Ladowarka Dell 65W' }),
    base({ listingId: 'inflect', title: 'Ladowarki do laptopa Dell' }),
    base({ listingId: 'cond', title: 'Ladowarka Dell 65W', condition: 'Uzywane' }),
    base({ listingId: 'both', title: 'Torba na laptopa', condition: 'Uzywane' }),
    base({ listingId: 'price', title: 'Ladowarki do laptopa Dell', price: 9999 }),
  ];
  const { termCandidates, conditionCandidates } = findFuzzyRescueCandidates(
    listings as any, 'ladowarka', '', '', { minPrice: null, maxPrice: 500, condition: 'New', location: '' },
  );
  assert.deepEqual(termCandidates.map((listing) => listing.listingId), ['inflect']);
  assert.deepEqual(conditionCandidates.map((listing) => listing.listingId), ['cond']);
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

test('treats every Vinted listing as shippable even with legacy stored flags', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare('INSERT INTO watches (id, name, query, sources_json, shipping_only, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('vinted-shipping-watch', 'Vinted shipping watch', 'cpu', '["Vinted"]', 1, 1, now, now, now);
    const insert = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, shipping_available, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('Vinted', 'vinted-flagged-pickup', 'Vinted CPU flagged pickup', 100, 0, 'https://www.vinted.pl/items/vinted-flagged-pickup', now, now);
    insert.run('Vinted', 'vinted-unknown', 'Vinted CPU unknown', 120, null, 'https://www.vinted.pl/items/vinted-unknown', now, now);
    insert.run('OLX', 'olx-pickup', 'OLX pickup CPU', 90, 0, 'https://www.olx.pl/d/oferta/olx-pickup', now, now);
    const observe = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (const row of context.db.prepare('SELECT id, price_pln FROM listings').all() as Array<{ id: number; price_pln: number }>) observe.run(row.id, 'vinted-shipping-watch', row.price_pln, now);
    assert.equal(context.service.getWatches()[0].samples, 2);
    const listings = context.service.getListings();
    assert.deepEqual(listings.map((listing) => listing.id).sort(), ['Vinted:vinted-flagged-pickup', 'Vinted:vinted-unknown']);
    // The UI must not report "Pickup only" for a Vinted row with a stale flag.
    assert.deepEqual(listings.map((listing) => listing.shippingAvailable), [true, true]);
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
    // Vinted's stale pickup flag must not exclude it from a shipping-only filter.
    { marketplace: 'Vinted' as const, listingId: 'vinted-ships', title: 'RTX 4070 12GB Founders Edition', price: 1800, currency: 'PLN' as const, url: 'https://www.vinted.pl/items/vinted-ships', condition: 'New', location: 'Warszawa', shippingAvailable: false, observedAt: new Date().toISOString() },
  ];
  assert.deepEqual(filterListings(listings, 'rtx 4070', '12gb', 'parts', { minPrice: 1000, maxPrice: 2000, condition: 'New', location: 'Warszawa', shippingOnly: true }).map((listing) => listing.listingId), ['match', 'vinted-ships']);
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
    const { saleBand, ...marketWatch } = research.watches[0];
    assert.deepEqual(marketWatch, {
      id: 'market-watch', name: 'GPU market', query: 'rtx 4070', terms: '12gb', excluded: 'parts', location: 'Warszawa', condition: 'New', sources: ['OLX', 'Vinted'], intervalHours: 24, minPrice: 1000, maxPrice: 2500, shippingOnly: true, typoVariants: false, enabled: true, nextScan: 'due now', lastScan: 'just now', totalListings: 3, activeListings: 1, endedListings: 2, estimatedMedianPrice: 2200,
    });
    // Both ended rows lack a verified ended reason, so the band stays open.
    assert.deepEqual({ ...saleBand, computedAt: null }, { p25: null, median: null, p75: null, sampleCount: 2, eligibleCount: 0, excludedStale: 0, windowDays: 90, computedAt: null });
    assert.ok(saleBand!.computedAt);
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

test('computes probable-sale bands from eligible ended research listings', () => {
  const context = fixture();
  try {
    context.service.createMarketWatch({ id: 'band-watch', name: 'Band', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
    const now = Date.now();
    const daysAgoIso = (days: number) => new Date(now - days * 24 * 60 * 60_000).toISOString();
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, ended_at, ended_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ended', 3, ?, ?)`);
    [100, 200, 300, 400, 500].forEach((price, index) => insert.run('band-watch', 'band-watch:v1', 'OLX', `band-${index}`, `CPU ${index}`, `https://www.olx.pl/d/oferta/band-${index}`, price, price, price, daysAgoIso(2), daysAgoIso(1), daysAgoIso(1), 'Ad not found.'));
    // Last seen far before disappearance: a stale asking price, not a probable sale.
    insert.run('band-watch', 'band-watch:v1', 'OLX', 'band-stale', 'CPU stale', 'https://www.olx.pl/d/oferta/band-stale', 900, 900, 900, daysAgoIso(45), daysAgoIso(40), daysAgoIso(1), 'Ad not found.');
    // Criteria-change rows are never probable sales.
    insert.run('band-watch', 'band-watch:v1', 'OLX', 'band-criteria', 'CPU criteria', 'https://www.olx.pl/d/oferta/band-criteria', 950, 950, 950, daysAgoIso(2), daysAgoIso(1), daysAgoIso(1), 'Research criteria changed');

    const research = context.service.marketResearch();
    const band = research.watches.find((watch) => watch.id === 'band-watch')!.saleBand!;
    assert.equal(band.sampleCount, 7);
    assert.equal(band.eligibleCount, 5);
    assert.equal(band.excludedStale, 1);
    assert.equal(band.windowDays, 90);
    assert.deepEqual({ p25: band.p25, median: band.median, p75: band.p75 }, { p25: 200, median: 300, p75: 400 });
    assert.equal(research.aggregates?.saleBand?.eligibleCount, 5);
    // The raw aggregate median keeps its old semantics: every ended asking price counts.
    assert.equal(research.aggregates?.overallMedianPrice, 400);
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
    assert.deepEqual((db.prepare('SELECT id FROM migrations ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id), ['001_init', '002_correctness', '003_auto_negotiation', '004_daily_digests', '005_ai_cache', '006_ai_cache_reuse', '007_exceptional_description_verification', '008_listing_detail_snapshots', '009_recovery_integrity', '010_listing_feed_index', '011_connector_health_index', '012_observations_watch_listing', '013_market_listing_snapshots', '014_typo_variants', '015_reference_series', '016_drop_observation_link_trigger', '017_reference_series_cleanup', '018_jev_shadow_log', '019_drop_ai_normalization', '019_watch_variants', '020_drop_messaging_negotiation', '021_listing_visibility', '022_jev_fuzzy_cache', '023_per_marketplace_intervals', '024_manual_relevance_cache', '025_variant_source']);
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
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'cpu-50', url: 'https://www.olx.pl/d/oferta/cpu-50', title: 'CPU 50', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 50, currency: 'PLN', negotiable: false } }] },
      { id: 'cpu-150', url: 'https://www.olx.pl/d/oferta/cpu-150', title: 'CPU 150', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 150, currency: 'PLN', negotiable: false } }] },
      { id: 'cpu-250', url: 'https://www.olx.pl/d/oferta/cpu-250', title: 'CPU 250', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 250, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 3 } } });
    const result = await context.service.manualSearch({ query: 'cpu', sources: ['OLX'], minPrice: 100, maxPrice: 200, terms: '', excluded: '', shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.price), [150]);
  } finally { context.close(); }
});

test('does not fetch listing details for shipping when manual search does not require it', async () => {
  const context = fixture();
  const fetchedUrls: string[] = [];
  try {
    (context.service as any).fetchVintedApi = async (url: string) => {
      fetchedUrls.push(url);
      return { status: 200, json: { items: [
        { id: 123, title: 'CPU', price: { amount: '150', currency_code: 'PLN' }, url: 'https://www.vinted.pl/items/123-cpu', status: 'Bardzo dobry' },
      ], pagination: { current_page: 1, total_pages: 1, total_entries: 1, per_page: 20 }, code: 0 } };
    };
    // SSR catalog page is primary; force the opportunistic JSON path here to
    // keep this shipping-logic test hermetic (no live network).
    (context.service as any).fetchVintedItemPage = async () => ({ status: 403, body: '' });
    (context.service as any).fetchPublicPage = async (url: string) => {
      throw new Error(`unexpected public page fetch: ${url}`);
    };
    const result = await context.service.manualSearch({ query: 'cpu', sources: ['Vinted'], minPrice: null, maxPrice: null, terms: '', excluded: '', shippingOnly: false, condition: 'Any', location: '' });
    assert.equal(result.sources[0].status, 'ok');
    assert.equal(fetchedUrls.length, 1);
    assert.match(fetchedUrls[0], /api\/v2\/catalog\/items/);
    assert.equal(result.listings[0].id, 'Vinted:123');
    assert.equal(result.sources[0].pendingShipping, 0);
  } finally { context.close(); }
});

test('assumes Vinted shipping for a shipping-only search without a detail fetch', async () => {
  const context = fixture();
  const publicFetches: string[] = [];
  try {
    (context.service as any).fetchVintedApi = async () => ({ status: 200, json: { items: [
      { id: 123, title: 'CPU', price: { amount: '150', currency_code: 'PLN' }, url: 'https://www.vinted.pl/items/123-cpu', status: 'Bardzo dobry' },
    ], pagination: { current_page: 1, total_pages: 1, total_entries: 1, per_page: 20 }, code: 0 } });
    // The catalog page is primary; force the JSON path and make any shipping
    // detail fetch fail loudly so this test proves none happens.
    (context.service as any).fetchVintedItemPage = async () => ({ status: 403, body: '' });
    (context.service as any).fetchPublicPage = async (url: string) => {
      publicFetches.push(url);
      throw new Error(`unexpected public page fetch: ${url}`);
    };
    const result = await context.service.manualSearch({ query: 'cpu', sources: ['Vinted'], minPrice: null, maxPrice: null, terms: '', excluded: '', shippingOnly: true, condition: 'Any', location: '' });
    assert.equal(result.sources[0].status, 'ok');
    assert.equal(result.listings[0].id, 'Vinted:123');
    assert.equal(result.listings[0].shippingAvailable, true);
    assert.equal(result.sources[0].pendingShipping, 0);
    assert.deepEqual(publicFetches, []);
  } finally { context.close(); }
});

test('records failed scans and does not persist partial normal-watch data', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'failed-scan');
    (context.service as any).fetchOlxApi = async () => ({ status: 403, json: null });
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
    context.service.createMarketWatch({ id: 'availability-watch', name: 'Availability', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
    const now = new Date().toISOString();
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, last_verified_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'live', ?)`);
    insert.run('availability-watch', 'availability-watch:v1', 'OLX', '1001', 'Terminal CPU', 'https://www.olx.pl/d/oferta/terminal-listing-ID1001.html', 100, 100, 100, now, now, now);
    insert.run('availability-watch', 'availability-watch:v1', 'OLX', '1002', 'Transient CPU', 'https://www.olx.pl/d/oferta/transient-listing-ID1002.html', 100, 100, 100, now, now, now);
    insert.run('availability-watch', 'availability-watch:v1', 'OLX', '1003', 'Live CPU', 'https://www.olx.pl/d/oferta/live-listing-ID1003.html', 100, 100, 100, now, now, now);
    context.db.prepare("UPDATE market_listings SET missing_scans = 2 WHERE listing_id = '1002'").run();
    let mode: 'terminal' | 'live' | 'failure' = 'terminal';
    (context.service as any).fetchOlxApi = async (url: string) => {
      if (mode === 'failure') throw new Error('Marketplace timeout');
      if (url.includes('/api/v1/offers/?')) return { status: 200, json: { data: [], metadata: { visible_total_count: 0 } } };
      if (url.endsWith('/api/v1/offers/1001/')) return { status: 404, json: { error: { status: 404, title: 'Not Found', detail: 'Ad not found.' } } };
      if (url.endsWith('/api/v1/offers/1002/')) return { status: 503, json: null };
      if (url.endsWith('/api/v1/offers/1003/')) return { status: 200, json: { data: { id: 1003, url: 'https://www.olx.pl/d/oferta/live-listing-ID1003.html', title: 'Live CPU', status: 'active', created_time: now, params: [{ key: 'price', value: { value: 100, currency: 'PLN', negotiable: false } }] } } };
      return { status: 404, json: null };
    };
    const row = context.db.prepare('SELECT * FROM market_watches WHERE id = ?').get('availability-watch');
    for (let scan = 0; scan < 3; scan += 1) await (context.service as any).runMarketWatch(row);
    const terminal = context.db.prepare("SELECT status, missing_scans, availability_status, ended_reason FROM market_listings WHERE listing_id = '1001'").get() as { status: string; missing_scans: number; availability_status: string; ended_reason: string };
    assert.deepEqual({ status: terminal.status, missing_scans: terminal.missing_scans, availability_status: terminal.availability_status }, { status: 'ended', missing_scans: 3, availability_status: 'terminal' });
    assert.equal(terminal.ended_reason, 'Ad not found.');

    mode = 'failure';
    await (context.service as any).runMarketWatch(row);
    const transient = context.db.prepare("SELECT status, missing_scans FROM market_listings WHERE listing_id = '1002'").get() as { status: string; missing_scans: number };
    assert.equal(transient.status, 'active');
    assert.equal(transient.missing_scans, 2);
    mode = 'live';
    await (context.service as any).runMarketWatch(row);
    const live = context.db.prepare("SELECT status, missing_scans, availability_status FROM market_listings WHERE listing_id = '1003'").get() as { status: string; missing_scans: number; availability_status: string };
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
    context.service.createMarketWatch({ id: 'version-watch', name: 'Versioned', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
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

    context.service.createMarketWatch({ id: 'median-watch', name: 'Median', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ended', 3)`);
    for (let price = 1; price <= 401; price += 1) insert.run('median-watch', 'median-watch:v1', 'OLX', `median-${price}`, 'CPU', `https://www.olx.pl/d/oferta/median-${price}`, price, price, price, now, now);
    const research = context.service.marketResearch({ page: 2, pageSize: 100, watchId: 'median-watch' });
    assert.equal(research.aggregates?.overallMedianPrice, 201);
    assert.deepEqual(research.pagination, { page: 2, pageSize: 100, total: 401, hasNext: true });
    assert.equal(research.listings.length, 100);
  } finally { context.close(); }
});

test('toggling typo variants on a research watch starts a new immutable series', () => {
  const context = fixture();
  try {
    context.service.createMarketWatch({ id: 'typo-watch', name: 'Typo watch', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0)`).run('typo-watch', 'typo-watch:v1', 'OLX', 'typo-series-listing', 'CPU', 'https://www.olx.pl/d/oferta/typo-series-listing', 100, 100, 100, now, now);

    context.service.updateMarketWatch('typo-watch', { typoVariants: true });
    const versions = context.db.prepare('SELECT id, typo_variants, closed_at FROM market_watch_versions WHERE market_watch_id = ? ORDER BY created_at').all('typo-watch') as Array<{ id: string; typo_variants: number; closed_at: string | null }>;
    assert.equal(versions.length, 2);
    assert.equal(versions[0].typo_variants, 0);
    assert.equal(versions[1].typo_variants, 1);
    assert.ok(versions[0].closed_at);
    assert.equal((context.db.prepare("SELECT status FROM market_listings WHERE listing_id = 'typo-series-listing'").get() as { status: string }).status, 'superseded');
    const watch = context.service.marketResearch().watches.find((item) => item.id === 'typo-watch')!;
    assert.equal(watch.typoVariants, true);
    assert.equal(watch.totalListings, 0);

    // Pausing or renaming must not churn the series.
    context.service.updateMarketWatch('typo-watch', { enabled: false });
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM market_watch_versions WHERE market_watch_id = ?').get('typo-watch') as { count: number }).count, 2);
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

test('seeds fresh listings from a reference series band for display only', async () => {
  const context = fixture();
  try {
    context.service.createMarketWatch({ id: 'ref-series', name: 'Reference series', query: 'cpu', terms: '', excluded: '', location: 'Polska', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
    const now = Date.now();
    const daysAgoIso = (days: number) => new Date(now - days * 24 * 60 * 60_000).toISOString();
    const insertEnded = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, ended_at, ended_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ended', 3, ?, ?)`);
    [100, 200, 300, 400, 500].forEach((price, index) => insertEnded.run('ref-series', 'ref-series:v1', 'OLX', `ref-${index}`, `CPU ${index}`, `https://www.olx.pl/d/oferta/ref-${index}`, price, price, price, daysAgoIso(2), daysAgoIso(1), daysAgoIso(1), 'Ad not found.'));

    seedWatch(context.db, 'ref-watch');
    context.db.prepare('UPDATE watches SET reference_market_watch_id = ? WHERE id = ?').run('ref-series', 'ref-watch');
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'ref-listing', url: 'https://www.olx.pl/d/oferta/ref-listing', title: 'CPU deal', created_time: new Date(now).toISOString(), params: [{ key: 'price', value: { value: 240, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 1 } } });
    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('ref-watch');
    await (context.service as any).runWatch(row);

    const association = context.db.prepare('SELECT typical_pln, typical_source, deal_label FROM watch_listings WHERE watch_id = ?').get('ref-watch') as { typical_pln: number; typical_source: string; deal_label: string };
    assert.deepEqual({ ...association, typical_pln: 300 }, { typical_pln: 300, typical_source: 'reference-band', deal_label: 'Very strong' });
    const feed = context.service.getListings();
    assert.equal(feed[0].typical, 300);
    assert.equal(feed[0].typicalSource, 'reference-band');
    // The readiness gate stays closed: no alerts fired while learning.
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM notification_deliveries').get() as { count: number }).count, 0);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM notifications').get() as { count: number }).count, 0);

    // Once the watch has 30+ own samples, own history wins and the band is ignored.
    seedWatch(context.db, 'own-history-watch', { query: 'cpu' });
    context.db.prepare('UPDATE watches SET reference_market_watch_id = ? WHERE id = ?').run('ref-series', 'own-history-watch');
    const firstObserved = daysAgoIso(0.4); // ~9.6h: satisfies the 6h readiness window
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 30; index += 1) {
      insertListing.run('OLX', `own-baseline-${index}`, `Baseline CPU ${index}`, 1000, `https://www.olx.pl/d/oferta/own-baseline-${index}`, firstObserved, firstObserved);
      const listingId = (context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get(`own-baseline-${index}`) as { id: number }).id;
      insertObservation.run(listingId, 'own-history-watch', 1000, firstObserved);
    }
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'own-listing', url: 'https://www.olx.pl/d/oferta/own-listing', title: 'Own CPU', created_time: new Date(now).toISOString(), params: [{ key: 'price', value: { value: 900, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 1 } } });
    const ownRow = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('own-history-watch');
    await (context.service as any).runWatch(ownRow);
    const ownAssociation = context.db.prepare("SELECT typical_pln, typical_source FROM watch_listings WHERE watch_id = 'own-history-watch' AND typical_source IS NOT NULL").get() as { typical_pln: number; typical_source: string } | undefined;
    assert.deepEqual({ ...ownAssociation, typical_pln: 1000 }, { typical_pln: 1000, typical_source: 'own-history' });
  } finally { context.close(); }
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
    assert.equal(after.migrations.count, 26);
  } finally { context.close(); }
});

test('records watch scan paths in the in-memory log buffer and emits them over SSE', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-service-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const service = new ScoutService(db, (event, payload) => { emitted.push({ event, payload }); });
  try {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO watches (id, name, query, sources_json, exact_urls_json, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('log-watch', 'Log watch', 'cpu', '["OLX"]', '["https://www.olx.pl/elektronika/"]', 1, now, now, now);
    assert.equal(service.queueScan('log-watch').queued, true);
    const deadline = Date.now() + 2_000;
    while (!service.logs().length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const logs = service.logs();
    assert.ok(logs.length, 'expected the failed scan to be logged');
    assert.equal(logs[0].level, 'error');
    assert.equal(logs[0].scope, 'watch');
    assert.match(logs[0].message, /Log watch · OLX: failed via unstarted path — OLX search URL could not be translated to the offers API/);
    assert.match(logs[0].at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(logs[0].id >= (logs.at(-1) as { id: number }).id, 'expected newest-first ordering');
    assert.ok(emitted.some((entry) => entry.event === 'log'), 'expected the log entry to be emitted');
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('preserves research listings with description and images for post-sale review', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  try {
    context.db.prepare(`INSERT INTO market_watches (id, name, query, sources_json, interval_hours, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('market-snap', 'Snap watch', 'gpu', '["OLX"]', 24, 1, now, now, now);
    context.db.prepare(`INSERT INTO market_listings (market_watch_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, snapshot_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'live', 'pending')`).run('market-snap', 'OLX', 'offer-1', 'RTX 4070', 'https://www.olx.pl/d/oferta/rtx-4070-IDabc123.html', 2000, 2000, 2000, now, now);
    const listingRow = context.db.prepare('SELECT id FROM market_listings WHERE listing_id = ?').get('offer-1') as { id: number };
    assert.equal(context.service.marketListingSnapshot(listingRow.id), null);

    const detailHtml = `<html><head><meta property="og:image" content="https://cdn.example/photo-1.jpg"></head><body>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'RTX 4070', description: 'Karta bez uszkodzeń. W zestawie pudełko.', offers: { price: '2000' } })}</script>
      </body></html>`;
    const imageRequests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://www.olx.pl/d/oferta/rtx-4070-IDabc123.html') return new Response(detailHtml, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://cdn.example/photo-1.jpg') {
        imageRequests.push(url);
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;

    const snapshot = await context.service.captureMarketListingSnapshotNow(listingRow.id);
    assert.ok(snapshot);
    assert.equal(snapshot!.title, 'RTX 4070');
    assert.equal(snapshot!.description, 'Karta bez uszkodzeń. W zestawie pudełko.');
    assert.equal(snapshot!.price, 2000);
    assert.equal(snapshot!.images.length, 1);
    const image = context.service.marketSnapshotImage(snapshot!.images[0].id);
    assert.ok(image);
    assert.equal(image!.mime, 'image/jpeg');
    assert.deepEqual([...image!.data], [1, 2, 3, 4]);

    const stored = context.db.prepare('SELECT snapshot_status, snapshot_attempts FROM market_listings WHERE id = ?').get(listingRow.id) as { snapshot_status: string; snapshot_attempts: number };
    assert.equal(stored.snapshot_status, 'saved');
    assert.equal(stored.snapshot_attempts, 0);

    // Re-capturing an unchanged listing deduplicates into one stored snapshot.
    const imageRequestsBefore = imageRequests.length;
    await context.service.captureMarketListingSnapshotNow(listingRow.id);
    const snapshotCount = context.db.prepare('SELECT COUNT(*) AS count FROM market_listing_snapshots').get() as { count: number };
    assert.equal(snapshotCount.count, 1);
    const imageCount = context.db.prepare('SELECT COUNT(*) AS count FROM market_listing_snapshot_images').get() as { count: number };
    assert.equal(imageCount.count, 1);
    assert.equal(imageRequests.length, imageRequestsBefore + 1);

    await assert.rejects(() => context.service.captureMarketListingSnapshotNow(99_999), (error: unknown) => error instanceof ServiceError && error.status === 404);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('records failed preservation attempts and stops retrying after the cap', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  const now = new Date().toISOString();
  try {
    context.db.prepare(`INSERT INTO market_watches (id, name, query, sources_json, interval_hours, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('market-snap', 'Snap watch', 'gpu', '["OLX"]', 24, 1, now, now, now);
    context.db.prepare(`INSERT INTO market_listings (market_watch_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, snapshot_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 'live', 'pending')`).run('market-snap', 'OLX', 'offer-gone', 'Sold GPU', 'https://www.olx.pl/d/oferta/sold-gpu-IDgone123.html', 1500, 1500, 1500, now, now);
    const listingRow = context.db.prepare('SELECT id FROM market_listings WHERE listing_id = ?').get('offer-gone') as { id: number };

    globalThis.fetch = (async () => new Response('<html>page body</html>', { status: 404 })) as typeof fetch;
    await assert.rejects(
      () => context.service.captureMarketListingSnapshotNow(listingRow.id),
      (error: unknown) => error instanceof ServiceError && error.status === 502 && /could not preserve listing/.test(error.message),
    );

    const stored = context.db.prepare('SELECT snapshot_status, snapshot_attempts FROM market_listings WHERE id = ?').get(listingRow.id) as { snapshot_status: string; snapshot_attempts: number };
    assert.equal(stored.snapshot_status, 'failed');
    assert.equal(stored.snapshot_attempts, 0, 'manual attempts do not consume the automatic retry budget');

    // The automatic queue stops after the attempt cap is reached.
    context.db.prepare('UPDATE market_listings SET snapshot_attempts = 3 WHERE id = ?').run(listingRow.id);
    const queueRow = { ...listingRow, marketplace: 'OLX', title: 'Sold GPU', url: 'https://www.olx.pl/d/oferta/sold-gpu-IDgone123.html', last_price_pln: 1500, condition: null, location: null, listing_id: 'offer-gone', snapshot_status: 'pending', snapshot_attempts: 3 } as Record<string, any>;
    const outcome = await (context.service as any).captureMarketListingSnapshot(queueRow, 'auto');
    assert.equal(outcome.ok, false);
    const attempts = context.db.prepare('SELECT snapshot_attempts FROM market_listings WHERE id = ?').get(listingRow.id) as { snapshot_attempts: number };
    assert.equal(attempts.snapshot_attempts, 4);
    assert.equal(context.service.marketListingSnapshot(listingRow.id), null);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

test('keeps Jev shadow logging inert unless shadow mode is explicitly enabled', () => {
  const context = fixture();
  const previousMode = process.env.SCOUT_JEV_MODE;
  const previousKeys = [process.env.SCOUT_OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY, process.env.SCOUT_DEEPSEEK_API_KEY];
  try {
    delete process.env.SCOUT_JEV_MODE;
    delete process.env.SCOUT_OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.SCOUT_DEEPSEEK_API_KEY;
    assert.equal((context.service as any).jevShadowConfig(), null);
    process.env.SCOUT_JEV_MODE = 'live';
    assert.equal((context.service as any).jevShadowConfig(), null);
    process.env.SCOUT_JEV_MODE = 'shadow';
    assert.equal((context.service as any).jevShadowConfig(), null);
    // A missing table (migration not yet applied) must never break callers.
    context.db.exec('DROP TABLE jev_shadow_log');
    assert.doesNotThrow(() => (context.service as any).logJevShadow({
      task: 'relevance', inputHash: 'abc', jevModel: '~typesafe/jev-latest',
    }));
  } finally {
    if (previousMode === undefined) delete process.env.SCOUT_JEV_MODE;
    else process.env.SCOUT_JEV_MODE = previousMode;
    if (previousKeys[0] !== undefined) process.env.SCOUT_OPENROUTER_API_KEY = previousKeys[0];
    if (previousKeys[1] !== undefined) process.env.OPENROUTER_API_KEY = previousKeys[1];
    if (previousKeys[2] !== undefined) process.env.SCOUT_DEEPSEEK_API_KEY = previousKeys[2];
    context.close();
  }
});

function liveJevEnv() {
  const previous = {
    mode: process.env.SCOUT_JEV_MODE,
    key: process.env.SCOUT_OPENROUTER_API_KEY,
    legacy: process.env.OPENROUTER_API_KEY,
    deep: process.env.SCOUT_DEEPSEEK_API_KEY,
  };
  process.env.SCOUT_JEV_MODE = 'live';
  process.env.SCOUT_OPENROUTER_API_KEY = 'sk-or-v1-test';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SCOUT_DEEPSEEK_API_KEY;
  return () => {
    if (previous.mode === undefined) delete process.env.SCOUT_JEV_MODE;
    else process.env.SCOUT_JEV_MODE = previous.mode;
    if (previous.key === undefined) delete process.env.SCOUT_OPENROUTER_API_KEY;
    else process.env.SCOUT_OPENROUTER_API_KEY = previous.key;
    if (previous.legacy !== undefined) process.env.OPENROUTER_API_KEY = previous.legacy;
    if (previous.deep !== undefined) process.env.SCOUT_DEEPSEEK_API_KEY = previous.deep;
  };
}

function liveListing(overrides: Record<string, any> = {}) {
  return {
    marketplace: 'OLX',
    listingId: 'live-1',
    title: 'PS5 console',
    price: 2000,
    currency: 'PLN',
    url: 'https://www.olx.pl/d/oferta/live-1',
    imageUrl: 'https://img.example/thumb.jpg',
    condition: 'like-new',
    location: 'Warszawa',
    shippingAvailable: null,
    priceNegotiable: null,
    observedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('decides relevance live with Jev and never calls DeepSeek', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevance: async () => { throw new Error('DeepSeek must not be called in live mode'); },
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.92, unsure: false }),
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not be called for sure judgments'); },
  });
  try {
    const result = await (context.service as any).filterListingsByAiRelevance(
      [liveListing()], { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(result.listings.length, 1);
    assert.equal(result.excluded, 0);
    assert.equal(result.unknown, 0);
  } finally {
    restore();
    context.close();
  }
});

test('reuses manual-search relevance decisions instead of re-spending Jev', async () => {
  const restore = liveJevEnv();
  let jevCalls = 0;
  const context = fixture({
    classifyListingRelevance: async () => { throw new Error('DeepSeek must not be called in live mode'); },
    classifyListingRelevanceWithJev: async (ctx: any) => { jevCalls += 1; return { relevant: !ctx.title.includes('parts'), p: 0.92, unsure: false }; },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not be called for sure judgments'); },
  });
  try {
    const keep = liveListing({ listingId: 'manual-cache-1', title: 'PlayStation 5', url: 'https://www.olx.pl/d/oferta/manual-cache-1' });
    const drop = liveListing({ listingId: 'manual-cache-2', title: 'PS5 parts only', url: 'https://www.olx.pl/d/oferta/manual-cache-2' });
    const search = { query: 'PS5', includedTerms: '', excludedTerms: '' };
    const first = await (context.service as any).filterListingsByAiRelevance([keep, drop], search, undefined, true);
    assert.equal(jevCalls, 2);
    assert.deepEqual(first.listings.map((item: any) => item.listingId), ['manual-cache-1']);
    assert.equal(first.excluded, 1);

    const repeat = await (context.service as any).filterListingsByAiRelevance([keep, drop], search, undefined, true);
    assert.equal(jevCalls, 2, 'a repeated manual search must reuse cached decisions');
    assert.deepEqual(repeat.listings.map((item: any) => item.listingId), ['manual-cache-1']);
    assert.equal(repeat.excluded, 1);

    // A different phrase is a different judgment and must not reuse the cache.
    await (context.service as any).filterListingsByAiRelevance([keep], { query: 'Xbox', includedTerms: '', excludedTerms: '' }, undefined, true);
    assert.equal(jevCalls, 3);
  } finally {
    restore();
    context.close();
  }
});

test('skips the AI relevance call for listings below the deal-strength gate', async () => {
  const restore = liveJevEnv();
  let jevCalls = 0;
  const context = fixture({
    classifyListingRelevance: async () => { throw new Error('DeepSeek must not be called in live mode'); },
    classifyListingRelevanceWithJev: async () => { jevCalls += 1; return { relevant: true, p: 0.92, unsure: false }; },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not be called'); },
  });
  try {
    const strong = liveListing({ listingId: 'strong-1', url: 'https://www.olx.pl/d/oferta/strong-1' });
    const weak = liveListing({ listingId: 'weak-1', url: 'https://www.olx.pl/d/oferta/weak-1' });
    const result = await (context.service as any).filterListingsByAiRelevance(
      [strong, weak], { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
      (listing: any) => listing.listingId === 'strong-1',
    );
    assert.equal(jevCalls, 1);
    assert.equal(result.listings.length, 2);
    assert.equal(result.excluded, 0);
    assert.equal(result.unknown, 0);
    assert.equal(result.skipped, 1);
  } finally {
    restore();
    context.close();
  }
});

test('spends relevance AI only on very strong or qualifying watch-scan listings', async () => {
  const restore = liveJevEnv();
  const checked: string[] = [];
  const context = fixture({
    classifyListingRelevanceWithJev: async (ctx: any) => {
      checked.push(ctx.title);
      return { relevant: true, p: 0.95, unsure: false };
    },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not be called'); },
  });
  try {
    seedWatch(context.db, 'gate-watch');
    const baselineAt = new Date(Date.now() - 8 * 60 * 60_000).toISOString();
    const insertListing = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    for (let index = 0; index < 30; index += 1) {
      insertListing.run('OLX', `gate-baseline-${index}`, `Baseline CPU ${index}`, 1000, `https://www.olx.pl/d/oferta/gate-baseline-${index}`, baselineAt, baselineAt);
      const listing = context.db.prepare('SELECT id FROM listings WHERE listing_id = ?').get(`gate-baseline-${index}`) as { id: number };
      insertObservation.run(listing.id, 'gate-watch', 1000, baselineAt);
    }
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'gate-strong', url: 'https://www.olx.pl/d/oferta/gate-strong', title: 'CPU very strong', created_time: baselineAt, params: [{ key: 'price', value: { value: 700, currency: 'PLN', negotiable: false } }] },
      { id: 'gate-weak', url: 'https://www.olx.pl/d/oferta/gate-weak', title: 'CPU weak', created_time: baselineAt, params: [{ key: 'price', value: { value: 950, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });

    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('gate-watch');
    await (context.service as any).runWatch(row);

    assert.deepEqual(checked, ['CPU very strong']);
    const stored = (context.db.prepare("SELECT l.listing_id, wl.deal_strength FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id IN ('gate-strong', 'gate-weak') ORDER BY l.listing_id").all() as Array<{ listing_id: string; deal_strength: number }>).map((row) => ({ ...row }));
    assert.deepEqual(stored, [
      { listing_id: 'gate-strong', deal_strength: 5 },
      { listing_id: 'gate-weak', deal_strength: 2 },
    ]);
  } finally {
    restore();
    context.close();
  }
});

test('follows the Jev lean on unsure relevance without detail fetch or vision', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevanceWithJev: async (ctx: any) => ctx.title.includes('box')
      ? { relevant: false, p: 0.45, unsure: true }
      : { relevant: true, p: 0.55, unsure: true },
    fetchListingDetailHtml: async () => { throw new Error('Detail fetch must not run for filter-only relevance'); },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not run for filter-only relevance'); },
  });
  try {
    const result = await (context.service as any).filterListingsByAiRelevance(
      [
        liveListing(),
        liveListing({ listingId: 'live-2', url: 'https://www.olx.pl/d/oferta/live-2', title: 'empty box' }),
      ],
      { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(result.listings.length, 1);
    assert.equal(result.excluded, 1);
    assert.equal(result.unknown, 0);
  } finally {
    restore();
    context.close();
  }
});

test('leans on unsure Jev relevance and keeps unknown on Jev failure without vision', async () => {
  const restore = liveJevEnv();
  const unsure = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.5, unsure: true }),
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not run for filter-only relevance'); },
  });
  const failed = fixture({
    classifyListingRelevanceWithJev: async () => { throw new Error('Decisions 520'); },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not run for filter-only relevance'); },
  });
  try {
    const leaned = await (unsure.service as any).filterListingsByAiRelevance(
      [liveListing()], { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(leaned.listings.length, 1);
    assert.equal(leaned.excluded, 0);
    assert.equal(leaned.unknown, 0);
    const unknown = await (failed.service as any).filterListingsByAiRelevance(
      [liveListing()], { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(unknown.listings.length, 1);
    assert.equal(unknown.unknown, 1);
  } finally {
    restore();
    unsure.close();
    failed.close();
  }
});

test('verifies high-priority deals live with Jev and vision escalation', async () => {
  const restore = liveJevEnv();
  const detailHtml = [
    '<meta property="og:description" content="Fully working console, complete set, no defects.">',
    '<meta property="og:image" content="https://ireland.apollo.olxcdn.com/v1/files/def-PL/image;s=644x461">',
  ].join('');
  const candidate = {
    watchId: 'live-watch',
    listing: liveListing(),
    typical: 2500,
    discountPercent: 25,
    confidence: 0.9,
    requiresDescriptionVerification: true,
  };
  const visionCalls: Array<{ imageUrls: unknown }> = [];
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.9, unsure: false }),
    verifyListingDescriptionWithJev: async (ctx: any) => ctx.description?.includes('suspicious')
      ? { decision: 'reject', confidence: 0.4, unsure: true }
      : { decision: 'pass', confidence: 0.85, unsure: false },
    verifyListingDescriptionWithVision: async (input: any) => {
      visionCalls.push({ imageUrls: input.imageUrls });
      return { decision: 'pass', confidence: 0.78, issues: [], imagesSeen: input.imageUrls.length };
    },
  });
  (context.service as any).fetchPublicPage = async () => detailHtml;
  const failing = fixture({
    verifyListingDescriptionWithJev: async () => { throw new Error('Decisions 520'); },
    verifyListingDescriptionWithVision: async () => { throw new VisionError('Vision 502', 502); },
  });
  (failing.service as any).fetchPublicPage = async () => detailHtml;
  try {
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), true);
    assert.equal(visionCalls.length, 0);
    const suspicious = { ...candidate, listing: liveListing({ listingId: 'live-2', url: 'https://www.olx.pl/d/oferta/live-2' }) };
    (context.service as any).fetchPublicPage = async () => detailHtml.replace('Fully working', 'suspicious wiring, Fully working');
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(suspicious), true);
    assert.equal(visionCalls.length, 1);
    assert.equal((visionCalls[0].imageUrls as string[]).length, 1);
    // Vision outage keeps today's fail-open alert behavior.
    assert.equal(await (failing.service as any).verifyHighPriorityDealOnce(candidate), true);
  } finally {
    restore();
    context.close();
    failing.close();
  }
});

test('evaluates same-title live listings separately per URL with one Jev call each', async () => {
  const restore = liveJevEnv();
  let calls = 0;
  const context = fixture({
    classifyListingRelevanceWithJev: async () => {
      calls += 1;
      return calls === 1
        ? { relevant: true, p: 0.9, unsure: false }
        : { relevant: false, p: 0.1, unsure: false };
    },
    fetchListingDetailHtml: async () => { throw new Error('Detail fetch must not run for filter-only relevance'); },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not run for filter-only relevance'); },
  });
  try {
    const result = await (context.service as any).filterListingsByAiRelevance(
      [
        liveListing({ listingId: 'dup-a', url: 'https://www.olx.pl/d/oferta/dup-a', imageUrl: 'https://img.example/good.jpg' }),
        liveListing({ listingId: 'dup-b', url: 'https://www.olx.pl/d/oferta/dup-b', imageUrl: 'https://img.example/bad.jpg' }),
      ],
      { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(calls, 2);
    assert.equal(result.listings.length, 1);
    assert.equal(result.listings[0].listingId, 'dup-a');
    assert.equal(result.excluded, 1);
  } finally {
    restore();
    context.close();
  }
});

test('live mode ignores cross-listing cache rows scoped by input hash', async () => {
  const restore = liveJevEnv();
  const now = new Date().toISOString();
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: false, p: 0.1, unsure: false }),
  });
  try {
    seedWatch(context.db, 'other-watch');
    const hash = listingRelevanceInputHash({
      marketplace: 'OLX', title: 'PS5 console', condition: 'like-new', location: 'Warszawa',
      query: 'PS5', includedTerms: '', excludedTerms: '',
    });
    context.db.prepare(`INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, error, checked_at, relevance_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('other-watch', 'OLX', 'other-1', hash, '~typesafe/jev-latest', 1, 'stale cross-listing row', null, now, 'relevant');
    const result = await (context.service as any).filterListingsByAiRelevance(
      [liveListing()], { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(result.listings.length, 0);
    assert.equal(result.excluded, 1);
  } finally {
    restore();
    context.close();
  }
});

test('live verification ignores cross-listing verification rows', async () => {
  const restore = liveJevEnv();
  const now = new Date().toISOString();
  const context = fixture({
    verifyListingDescriptionWithJev: async () => ({ decision: 'reject', confidence: 0.9, unsure: false }),
  });
  (context.service as any).fetchPublicPage = async () => '<meta property="og:description" content="Cracked case, sold for parts.">';
  try {
    const hash = listingDescriptionVerificationInputHash({
      marketplace: 'OLX', title: 'PS5 console', condition: 'like-new', description: 'Cracked case, sold for parts.',
    });
    context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at,
      ai_description_verification_json, ai_description_verification_input_hash, ai_description_verification_model, ai_description_verification_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('OLX', 'other-9', 'PS5 console', 2000, 'https://www.olx.pl/d/oferta/other-9', now, now,
      JSON.stringify({ decision: 'pass', confidence: 1, summary: 'stale cross-listing row', issues: [], evidence: [] }),
      hash, '~typesafe/jev-latest', now);
    const candidate = {
      watchId: 'live-watch',
      listing: liveListing(),
      typical: 2500,
      discountPercent: 25,
      confidence: 0.9,
      requiresDescriptionVerification: true,
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), false);
  } finally {
    restore();
    context.close();
  }
});

test('SCOUT_JEV_MODE=legacy opts out to the DeepSeek path', async () => {
  const restore = liveJevEnv();
  process.env.SCOUT_JEV_MODE = 'legacy';
  let deepseekCalls = 0;
  const context = fixture({
    classifyListingRelevance: async () => {
      deepseekCalls += 1;
      return { relevant: true };
    },
    classifyListingRelevanceWithJev: async () => { throw new Error('Jev must not be called in legacy mode'); },
  });
  try {
    const result = await (context.service as any).filterListingsByAiRelevance(
      [liveListing()], { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(result.listings.length, 1);
    assert.equal(deepseekCalls, 1);
    // Unset mode with a key available defaults to live.
    delete process.env.SCOUT_JEV_MODE;
    assert.notEqual((context.service as any).jevLiveConfig(), null);
    // Unrecognized values (including typos of either mode) fail safe to legacy.
    process.env.SCOUT_JEV_MODE = 'legasy';
    assert.equal((context.service as any).jevLiveConfig(), null);
    process.env.SCOUT_JEV_MODE = 'liev';
    assert.equal((context.service as any).jevLiveConfig(), null);
  } finally {
    restore();
    context.close();
  }
});

test('rescues term near-misses in manual search on confident Jev pass', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.9, unsure: false }),
    classifyTermMatchWithJev: async () => ({ decision: 'pass', confidence: 0.85, unsure: false }),
    classifyConditionMatchWithJev: async () => { throw new Error('condition must not be called without candidates'); },
    classifyListingRelevanceWithVision: async () => { throw new Error('vision must not be called'); },
  });
  try {
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'LAD-1', url: 'https://www.olx.pl/d/oferta/lad-1', title: 'Ladowarka Dell 65W', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 100, currency: 'PLN', negotiable: false } }] },
      { id: 'LAD-2', url: 'https://www.olx.pl/d/oferta/lad-2', title: 'Ladowarki do laptopa Dell', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 120, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });
    const result = await context.service.manualSearch({ query: 'ladowarka', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title).sort(), ['Ladowarka Dell 65W', 'Ladowarki do laptopa Dell']);
    assert.equal(result.sources[0].count, 2);
  } finally {
    restore();
    context.close();
  }
});

test('keeps deterministic drops when fuzzy rescue is unsure', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.9, unsure: false }),
    classifyTermMatchWithJev: async () => ({ decision: 'pass', confidence: 0.5, unsure: true }),
    classifyConditionMatchWithJev: async () => ({ decision: 'unknown', confidence: 0.4, unsure: true }),
  });
  try {
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'LAD-1', url: 'https://www.olx.pl/d/oferta/lad-1', title: 'Ladowarka Dell 65W', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 100, currency: 'PLN', negotiable: false } }] },
      { id: 'LAD-2', url: 'https://www.olx.pl/d/oferta/lad-2', title: 'Ladowarki do laptopa Dell', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 120, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });
    const result = await context.service.manualSearch({ query: 'ladowarka', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title), ['Ladowarka Dell 65W']);
  } finally {
    restore();
    context.close();
  }
});

test('upgrades unknown negotiability from description without overriding fixed', async () => {
  const restore = liveJevEnv();
  const now = new Date().toISOString();
  const context = fixture({
    verifyListingDescriptionWithJev: async () => ({ decision: 'pass', confidence: 0.85, unsure: false }),
    classifyNegotiabilityWithJev: async () => ({ decision: 'negotiable', confidence: 0.9, unsure: false }),
  });
  (context.service as any).fetchPublicPage = async () => '<meta property="og:description" content="Fully working console. Cena do uzgodnienia, zapraszam.">';
  try {
    context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, price_negotiable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'OLX', 'live-1', 'PS5 console', 2000, 'https://www.olx.pl/d/oferta/live-1', now, now, null);
    context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, price_negotiable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'OLX', 'live-fixed', 'PS5 console fixed', 2000, 'https://www.olx.pl/d/oferta/live-fixed', now, now, 0);
    const candidate: any = {
      watchId: 'live-watch', listing: liveListing(), typical: 2500,
      discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), true);
    assert.equal(candidate.listing.priceNegotiable, true);
    assert.equal((context.db.prepare('SELECT price_negotiable FROM listings WHERE listing_id = ?').get('live-1') as { price_negotiable: number }).price_negotiable, 1);

    const fixed: any = {
      watchId: 'live-watch',
      listing: liveListing({ listingId: 'live-fixed', url: 'https://www.olx.pl/d/oferta/live-fixed', title: 'PS5 console fixed', priceNegotiable: false }),
      typical: 2500, discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(fixed), true);
    assert.equal((context.db.prepare('SELECT price_negotiable FROM listings WHERE listing_id = ?').get('live-fixed') as { price_negotiable: number }).price_negotiable, 0);
  } finally {
    restore();
    context.close();
  }
});

test('rescues condition misses in manual search on confident Jev match', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.9, unsure: false }),
    classifyTermMatchWithJev: async () => { throw new Error('term must not be called without candidates'); },
    classifyConditionMatchWithJev: async () => ({ decision: 'match', confidence: 0.85, unsure: false }),
  });
  try {
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'IPH-1', url: 'https://www.olx.pl/d/oferta/iph-1', title: 'iPhone 13', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 2000, currency: 'PLN', negotiable: false } }, { key: 'state', value: { label: 'Nowe' } }] },
      { id: 'IPH-2', url: 'https://www.olx.pl/d/oferta/iph-2', title: 'iPhone 13 sealed, brand new', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 2100, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });
    const result = await context.service.manualSearch({ query: 'iphone', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'New', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title).sort(), ['iPhone 13', 'iPhone 13 sealed, brand new']);
  } finally {
    restore();
    context.close();
  }
});

test('keeps deterministic set when fuzzy rescue throws', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.9, unsure: false }),
    classifyTermMatchWithJev: async () => { throw new Error('Decisions 520'); },
    classifyConditionMatchWithJev: async () => { throw new Error('Decisions 520'); },
  });
  try {
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'LAD-1', url: 'https://www.olx.pl/d/oferta/lad-1', title: 'Ladowarka Dell 65W', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 100, currency: 'PLN', negotiable: false } }] },
      { id: 'LAD-2', url: 'https://www.olx.pl/d/oferta/lad-2', title: 'Ladowarki do laptopa Dell', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 120, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 2 } } });
    const result = await context.service.manualSearch({ query: 'ladowarka', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.deepEqual(result.listings.map((listing) => listing.title), ['Ladowarka Dell 65W']);
  } finally {
    restore();
    context.close();
  }
});

test('caps fuzzy rescue at ten Jev calls per search', async () => {
  const restore = liveJevEnv();
  let calls = 0;
  const context = fixture({
    classifyTermMatchWithJev: async () => { calls += 1; return { decision: 'pass', confidence: 0.9, unsure: false }; },
    classifyConditionMatchWithJev: async () => { calls += 1; return { decision: 'match', confidence: 0.9, unsure: false }; },
  });
  try {
    const now = new Date().toISOString();
    const listings = Array.from({ length: 12 }, (_, index) => ({
      marketplace: 'OLX', listingId: `miss-${index}`, title: `Ladowarki model ${index} Dell`, price: 100,
      currency: 'PLN', url: `https://www.olx.pl/d/oferta/miss-${index}`, observedAt: now, condition: 'Nowe', location: 'Warszawa',
      shippingAvailable: null, priceNegotiable: null,
    }));
    const candidates = findFuzzyRescueCandidates(listings as any, 'ladowarka', '', '', {});
    assert.equal(candidates.termCandidates.length, 12);
    const result = await (context.service as any).rescueFuzzyMisses(candidates, {
      query: 'ladowarka', includedTerms: '', excludedTerms: '', condition: 'Any',
    }, (context.service as any).jevLiveConfig());
    assert.equal(calls, 10);
    assert.equal(result.rescued.length, 10);
  } finally {
    restore();
    context.close();
  }
});

test('reuses cached fuzzy rescue verdicts and gates weak listings', async () => {
  const restore = liveJevEnv();
  let calls = 0;
  const context = fixture({
    classifyTermMatchWithJev: async () => { calls += 1; return { decision: 'pass', confidence: 0.9, unsure: false }; },
    classifyConditionMatchWithJev: async () => { calls += 1; return { decision: 'match', confidence: 0.9, unsure: false }; },
  });
  try {
    const now = new Date().toISOString();
    const listings = Array.from({ length: 2 }, (_, index) => ({
      marketplace: 'OLX', listingId: `cache-miss-${index}`, title: `Ladowarki model ${index} Dell`, price: 100,
      currency: 'PLN', url: `https://www.olx.pl/d/oferta/cache-miss-${index}`, observedAt: now, condition: 'Nowe', location: 'Warszawa',
      shippingAvailable: null, priceNegotiable: null,
    }));
    const search = { query: 'ladowarka', includedTerms: '', excludedTerms: '', condition: 'Any' };
    const live = (context.service as any).jevLiveConfig();
    const first = await (context.service as any).rescueFuzzyMisses(
      findFuzzyRescueCandidates(listings as any, 'ladowarka', '', '', {}), search, live);
    assert.equal(calls, 2);
    assert.equal(first.rescued.length, 2);
    const second = await (context.service as any).rescueFuzzyMisses(
      findFuzzyRescueCandidates(listings as any, 'ladowarka', '', '', {}), search, live);
    assert.equal(calls, 2);
    assert.equal(second.rescued.length, 2);
    const gated = await (context.service as any).rescueFuzzyMisses(
      findFuzzyRescueCandidates(listings as any, 'ladowarka', '', '', {}), search, live, () => false);
    assert.equal(gated.rescued.length, 0);
    assert.equal(calls, 2);
  } finally {
    restore();
    context.close();
  }
});

test('caches confident fixed negotiability and skips upgrade on cached verification', async () => {
  const restore = liveJevEnv();
  const now = new Date().toISOString();
  let jevCalls = 0;
  const context = fixture({
    verifyListingDescriptionWithJev: async () => ({ decision: 'pass', confidence: 0.85, unsure: false }),
    classifyNegotiabilityWithJev: async () => { jevCalls += 1; return { decision: 'fixed', confidence: 0.9, unsure: false }; },
  });
  (context.service as any).fetchPublicPage = async () => '<meta property="og:description" content="Fully working console. Fixed price, no negotiation.">';
  try {
    context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, price_negotiable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'OLX', 'fixed-1', 'PS5 console', 2000, 'https://www.olx.pl/d/oferta/fixed-1', now, now, null);
    const candidate: any = {
      watchId: 'live-watch', listing: liveListing({ listingId: 'fixed-1', url: 'https://www.olx.pl/d/oferta/fixed-1' }),
      typical: 2500, discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), true);
    assert.equal(jevCalls, 1);
    assert.equal((context.db.prepare('SELECT price_negotiable FROM listings WHERE listing_id = ?').get('fixed-1') as { price_negotiable: number }).price_negotiable, 0);
    assert.equal(candidate.listing.priceNegotiable, null);
    const repeat: any = {
      watchId: 'live-watch', listing: liveListing({ listingId: 'fixed-1', url: 'https://www.olx.pl/d/oferta/fixed-1' }),
      typical: 2500, discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(repeat), true);
    assert.equal(jevCalls, 1);
  } finally {
    restore();
    context.close();
  }
});

test('lets a manual search opt out of the AI relevance gate', async () => {
  const restore = liveJevEnv();
  let relevanceCalls = 0;
  const context = fixture({
    classifyListingRelevanceWithJev: async () => { relevanceCalls += 1; return { relevant: false, p: 0.1, unsure: false }; },
    classifyListingRelevance: async () => { throw new Error('DeepSeek must not be called in live mode'); },
  });
  try {
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'OPT-1', url: 'https://www.olx.pl/d/oferta/opt-1', title: 'Ladowarka Dell 65W', created_time: new Date().toISOString(), params: [{ key: 'price', value: { value: 100, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 1 } } });
    const skipped = await context.service.manualSearch({ query: 'ladowarka', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '', aiRelevance: false });
    assert.equal(relevanceCalls, 0);
    assert.deepEqual(skipped.listings.map((listing) => listing.title), ['Ladowarka Dell 65W']);
    // Omitted means default-on, matching the watch-scan default.
    const filtered = await context.service.manualSearch({ query: 'ladowarka', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', location: '' });
    assert.equal(relevanceCalls, 1);
    assert.equal(filtered.listings.length, 0);
  } finally {
    restore();
    context.close();
  }
});

test('runs live relevance checks with bounded concurrency', async () => {
  const restore = liveJevEnv();
  const previousConcurrency = process.env.SCOUT_JEV_CONCURRENCY;
  process.env.SCOUT_JEV_CONCURRENCY = '3';
  let inFlight = 0;
  let maxInFlight = 0;
  const context = fixture({
    classifyListingRelevanceWithJev: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { relevant: true, p: 0.9, unsure: false };
    },
  });
  try {
    const listings = Array.from({ length: 9 }, (_, index) => liveListing({
      listingId: `concurrent-${index}`,
      url: `https://www.olx.pl/d/oferta/concurrent-${index}`,
      title: `PS5 console ${index}`,
    }));
    const result = await (context.service as any).filterListingsByAiRelevance(
      listings, { query: 'PS5', includedTerms: '', excludedTerms: '' }, undefined, true,
    );
    assert.equal(result.listings.length, 9);
    assert.equal(maxInFlight, 3);
  } finally {
    if (previousConcurrency === undefined) delete process.env.SCOUT_JEV_CONCURRENCY;
    else process.env.SCOUT_JEV_CONCURRENCY = previousConcurrency;
    restore();
    context.close();
  }
});

test('runs fuzzy rescue checks with bounded concurrency', async () => {
  const restore = liveJevEnv();
  const previousConcurrency = process.env.SCOUT_JEV_CONCURRENCY;
  process.env.SCOUT_JEV_CONCURRENCY = '4';
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
  };
  const context = fixture({
    classifyTermMatchWithJev: async () => { await track(); return { decision: 'pass' as const, confidence: 0.9, unsure: false }; },
    classifyConditionMatchWithJev: async () => { await track(); return { decision: 'match' as const, confidence: 0.9, unsure: false }; },
  });
  try {
    const now = new Date().toISOString();
    const listings = Array.from({ length: 8 }, (_, index) => ({
      marketplace: 'OLX', listingId: `pool-${index}`, title: `Ladowarki model ${index} Dell`, price: 100,
      currency: 'PLN', url: `https://www.olx.pl/d/oferta/pool-${index}`, observedAt: now, condition: 'Nowe', location: 'Warszawa',
      shippingAvailable: null, priceNegotiable: null,
    }));
    const candidates = findFuzzyRescueCandidates(listings as any, 'ladowarka', '', '', {});
    const result = await (context.service as any).rescueFuzzyMisses(candidates, {
      query: 'ladowarka', includedTerms: '', excludedTerms: '', condition: 'Any',
    }, (context.service as any).jevLiveConfig());
    assert.equal(result.rescued.length, 8);
    assert.equal(result.rescuedByTerm, 8);
    assert.equal(maxInFlight, 4);
  } finally {
    if (previousConcurrency === undefined) delete process.env.SCOUT_JEV_CONCURRENCY;
    else process.env.SCOUT_JEV_CONCURRENCY = previousConcurrency;
    restore();
    context.close();
  }
});

test('skips negotiability upgrade for Vinted listings', async () => {
  const restore = liveJevEnv();
  const now = new Date().toISOString();
  let jevCalls = 0;
  const context = fixture({
    verifyListingDescriptionWithJev: async () => ({ decision: 'pass', confidence: 0.85, unsure: false }),
    classifyNegotiabilityWithJev: async () => { jevCalls += 1; return { decision: 'negotiable', confidence: 0.9, unsure: false }; },
  });
  (context.service as any).fetchPublicPage = async () => '<meta property="og:description" content="Fully working console. Cena do uzgodnienia.">';
  try {
    context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, price_negotiable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'Vinted', 'vinted-1', 'PS5 console', 2000, 'https://www.vinted.pl/items/vinted-1', now, now, null);
    const candidate: any = {
      watchId: 'live-watch',
      listing: { ...liveListing(), marketplace: 'Vinted', listingId: 'vinted-1', url: 'https://www.vinted.pl/items/vinted-1' },
      typical: 2500, discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), true);
    assert.equal(jevCalls, 0);
    assert.equal(candidate.listing.priceNegotiable, null);
  } finally {
    restore();
    context.close();
  }
});

test('passes the watch query into description verification', async () => {
  const restore = liveJevEnv();
  const seen: Array<Record<string, any>> = [];
  const visionInputs: Array<Record<string, any>> = [];
  const context = fixture({
    verifyListingDescriptionWithJev: async (ctx: any) => {
      seen.push({ ...ctx });
      if (ctx.query === 'unsure-query') return { decision: 'unknown', confidence: 0.9, unsure: true };
      return { decision: 'pass', confidence: 0.9, unsure: false };
    },
    verifyListingDescriptionWithVision: async (input: any) => {
      visionInputs.push({ ...input });
      return { decision: 'pass', confidence: 0.78, issues: [], imagesSeen: 0 };
    },
  });
  (context.service as any).fetchPublicPage = async () => '<meta property="og:description" content="Fully working console.">';
  try {
    const candidate = {
      watchId: 'live-watch',
      listing: liveListing(),
      typical: 2500,
      discountPercent: 25,
      confidence: 0.9,
      requiresDescriptionVerification: true,
      query: 'PS5',
      includedTerms: '',
      excludedTerms: 'pad',
    };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].query, 'PS5');
    assert.equal(seen[0].excludedTerms, 'pad');
    // An unsure Jev judgment escalates to vision with the query attached.
    const unsure = { ...candidate, listing: liveListing({ listingId: 'live-2', url: 'https://www.olx.pl/d/oferta/live-2' }), query: 'unsure-query' };
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(unsure), true);
    assert.equal(visionInputs.length, 1);
    assert.equal(visionInputs[0].query, 'unsure-query');
  } finally {
    restore();
    context.close();
  }
});

const iphoneVariants = [
  { id: 'mini', label: '13 mini', terms: '13, mini' },
  { id: 'base', label: '13', terms: '13' },
  { id: 'pro', label: '13 Pro', terms: '13, pro' },
];

/**
 * A watch with 8h of history: 12 listings each of iPhone 13 mini (median
 * 1500), 13 (2000), and 13 Pro (2600). Variants are stored and retagged.
 */
function seedVariantWatch(db: any, service: ScoutService, watchId: string, query = 'iphone 13') {
  seedWatch(db, watchId, { query });
  const firstObserved = new Date(Date.now() - 8 * 3_600_000).toISOString();
  const insertListing = db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
  const shape = [0.95, 0.97, 0.98, 0.99, 1, 1, 1, 1, 1.01, 1.02, 1.03, 1.05];
  for (const [title, center] of [['iPhone 13 mini', 1500], ['iPhone 13', 2000], ['iPhone 13 Pro', 2600]] as const) {
    shape.forEach((ratio, index) => {
      const listingId = `${title}-${index}`.replace(/\s+/g, '-');
      insertListing.run('OLX', listingId, `${title} 128GB`, center * ratio, `https://www.olx.pl/d/oferta/${listingId}`, firstObserved, firstObserved);
      const stored = db.prepare('SELECT id FROM listings WHERE listing_id = ?').get(listingId) as { id: number };
      insertObservation.run(stored.id, watchId, center * ratio, firstObserved);
    });
  }
  db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify(iphoneVariants), watchId);
  // Directly inserted observations predate the association link; point them at it.
  db.prepare('UPDATE observations SET watch_listing_id = (SELECT wl.id FROM watch_listings wl WHERE wl.watch_id = observations.watch_id AND wl.listing_id = observations.listing_id) WHERE watch_id = ?').run(watchId);
  service.retagWatchVariants(watchId);
}

function olxListings(listings: Array<{ id: string; title: string; price: number }>) {
  return async () => ({ status: 200, json: { data: listings.map((listing) => ({
    id: listing.id, url: `https://www.olx.pl/d/oferta/${listing.id}`, title: listing.title, created_time: new Date().toISOString(),
    params: [{ key: 'price', value: { value: listing.price, currency: 'PLN', negotiable: false } }],
  })), metadata: { visible_total_count: listings.length } } });
}

test('named variants become ready at 10 own samples with the spread pooled across variants', async () => {
  const context = fixture();
  try {
    seedVariantWatch(context.db, context.service, 'pooled-watch');
    const watch = context.service.getWatches().find((item) => item.id === 'pooled-watch')!;
    assert.deepEqual(watch.variants.map((variant) => [variant.key, variant.samples, variant.targetSamples, variant.readiness]), [
      ['mini', 12, 10, 100], ['base', 12, 10, 100], ['pro', 12, 10, 100],
    ]);

    const captured: Array<{ listing: { listingId: string }; typical: number; discountPercent: number }> = [];
    (context.service as any).processDealCandidates = async (candidates: typeof captured) => { captured.push(...candidates); };
    // 19% below the Pro median: a Strong deal that must clear the z-score on
    // the pooled within-variant spread.
    (context.service as any).fetchOlxApi = olxListings([{ id: 'strong-pro', title: 'iPhone 13 Pro 128GB', price: 2106 }]);
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('pooled-watch'));
    assert.deepEqual(captured.map((candidate) => [candidate.listing.listingId, candidate.typical, Math.round(candidate.discountPercent)]), [['strong-pro', 2600, 19]]);
    const stored = context.db.prepare("SELECT wl.variant_key, wl.variant_source, wl.deal_label FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id = 'strong-pro'").get() as Record<string, unknown>;
    assert.deepEqual({ ...stored }, { variant_key: 'pro', variant_source: 'rule', deal_label: 'Strong' });
  } finally { context.close(); }
});

test('asks Jev to place Other listings that could be deals, before the relevance pass, and reuses the pick', async () => {
  const restore = liveJevEnv();
  const asked: string[] = [];
  const relevanceChecked: string[] = [];
  const context = fixture({
    classifyWatchVariantWithJev: async (ctx: any) => {
      asked.push(ctx.title);
      return { variantId: 'pro', decision: 'variant', confidence: 0.9, unsure: false };
    },
    classifyListingRelevanceWithJev: async (ctx: any) => {
      relevanceChecked.push(ctx.title);
      return { relevant: true, p: 0.95, unsure: false };
    },
    classifyListingRelevanceWithVision: async () => { throw new Error('Vision must not be called'); },
  });
  try {
    // A broad "iphone" query lets titles without "13" through the watch filter.
    seedVariantWatch(context.db, context.service, 'jev-variant-watch', 'iphone');
    const captured: Array<{ listing: { listingId: string }; typical: number }> = [];
    (context.service as any).processDealCandidates = async (candidates: typeof captured) => { captured.push(...candidates); };
    // "trzynastka" defeats the term rules; the 3300 zł listing cannot be a
    // deal in any variant, so it is never sent to Jev.
    const fetchSlang = olxListings([
      { id: 'slang-pro', title: 'iPhone trzynastka Pro 128GB', price: 1950 },
      { id: 'slang-max', title: 'iPhone trzynastka Pro Max 256GB', price: 3300 },
    ]);
    let fetches = 0;
    (context.service as any).fetchOlxApi = async () => { fetches += 1; return fetchSlang(); };
    const row = () => context.db.prepare('SELECT * FROM watches WHERE id = ?').get('jev-variant-watch');
    await (context.service as any).runWatch(row());

    assert.deepEqual(asked, ['iPhone trzynastka Pro 128GB']);
    assert.ok(relevanceChecked.includes('iPhone trzynastka Pro 128GB'), 'the Jev-placed deal still gets its relevance check');
    const stored = (context.db.prepare(`SELECT l.listing_id, wl.variant_key, wl.variant_source, wl.typical_pln FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id
      WHERE l.listing_id IN ('slang-pro', 'slang-max') ORDER BY l.listing_id`).all() as Array<Record<string, unknown>>).map((item) => ({ ...item }));
    assert.deepEqual(stored, [
      { listing_id: 'slang-max', variant_key: '__other__', variant_source: 'rule', typical_pln: null },
      { listing_id: 'slang-pro', variant_key: 'pro', variant_source: 'jev', typical_pln: 2600 },
    ]);
    assert.deepEqual(captured.map((candidate) => [candidate.listing.listingId, candidate.typical]), [['slang-pro', 2600]]);
    assert.equal((context.db.prepare("SELECT COUNT(*) AS count FROM jev_shadow_log WHERE task = 'variant'").get() as { count: number }).count, 1);

    // The stored pick is reused on the next scan without another Jev call.
    await (context.service as any).runWatch(row(), { forceAll: true });
    assert.equal(fetches, 2, 'the second scan ran');
    assert.equal(asked.length, 1);
    const kept = context.db.prepare("SELECT wl.variant_key, wl.variant_source FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id = 'slang-pro'").get() as Record<string, unknown>;
    assert.deepEqual({ ...kept }, { variant_key: 'pro', variant_source: 'jev' });

    // Editing variants re-derives Jev picks (they were made against the old definitions).
    context.service.retagWatchVariants('jev-variant-watch');
    const dropped = context.db.prepare("SELECT wl.variant_key, wl.variant_source FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id = 'slang-pro'").get() as Record<string, unknown>;
    assert.deepEqual({ ...dropped }, { variant_key: '__other__', variant_source: 'rule' });
  } finally {
    restore();
    context.close();
  }
});

test('keeps unsure or failed Jev variant answers in Other, caching answers but retrying failures', async () => {
  const restore = liveJevEnv();
  let calls = 0;
  const context = fixture({
    classifyWatchVariantWithJev: async (ctx: any) => {
      calls += 1;
      if (ctx.title.includes('broken')) throw new Error('provider down');
      return ctx.title.includes('maybe')
        ? { variantId: 'pro', decision: 'variant', confidence: 0.5, unsure: true }
        : { variantId: null, decision: 'none', confidence: 0.9, unsure: false };
    },
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.95, unsure: false }),
  });
  try {
    seedVariantWatch(context.db, context.service, 'unsure-variant-watch', 'iphone');
    (context.service as any).processDealCandidates = async () => {};
    (context.service as any).fetchOlxApi = olxListings([
      { id: 'maybe', title: 'iPhone trzynastka maybe', price: 1500 },
      { id: 'other', title: 'iPhone XR other', price: 1500 },
      { id: 'broken', title: 'iPhone trzynastka broken', price: 1500 },
    ]);
    const row = () => context.db.prepare('SELECT * FROM watches WHERE id = ?').get('unsure-variant-watch');
    await (context.service as any).runWatch(row());
    assert.equal(calls, 3);
    const placed = context.db.prepare("SELECT COUNT(*) AS count FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id IN ('maybe', 'other', 'broken') AND wl.variant_key <> '__other__'").get() as { count: number };
    assert.equal(placed.count, 0);
    await (context.service as any).runWatch(row(), { forceAll: true });
    assert.equal(calls, 4, 'only the failed call is retried');
  } finally {
    restore();
    context.close();
  }
});

test('moves a listing to a variant manually, re-scores it, and keeps the pick across scans and edits', async () => {
  const context = fixture();
  try {
    seedVariantWatch(context.db, context.service, 'manual-variant-watch');
    const key = 'OLX:iPhone-13-0';

    const moved = context.service.setListingVariant('manual-variant-watch', key, 'pro');
    assert.deepEqual([moved.listing.variantKey, moved.listing.variantLabel, moved.listing.variantSource], ['pro', '13 Pro', 'manual']);
    assert.equal(moved.listing.typical, 2600);
    assert.equal(moved.listing.dealLabel, 'Very strong');
    assert.deepEqual(moved.variantGroups?.map((group) => group.id), ['mini', 'base', 'pro']);

    // A scan that sees the listing again, and a variant edit, both keep the manual pick.
    (context.service as any).processDealCandidates = async () => {};
    const fetchSame = olxListings([{ id: 'iPhone-13-0', title: 'iPhone 13 128GB', price: 1900 }]);
    let fetches = 0;
    (context.service as any).fetchOlxApi = async () => { fetches += 1; return fetchSame(); };
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('manual-variant-watch'), { forceAll: true });
    assert.equal(fetches, 1, 'the scan ran');
    context.service.retagWatchVariants('manual-variant-watch');
    const afterScan = context.service.listingDetail(key, 'manual-variant-watch').listing;
    assert.deepEqual([afterScan.variantKey, afterScan.variantSource], ['pro', 'manual']);

    // Back to automatic: the rules put it in the base variant again.
    const automatic = context.service.setListingVariant('manual-variant-watch', key, null);
    assert.deepEqual([automatic.listing.variantKey, automatic.listing.variantSource, automatic.listing.typical], ['base', 'rule', 2000]);

    // A manual pick whose variant is removed falls back to the rules.
    context.service.setListingVariant('manual-variant-watch', key, 'pro');
    context.db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify(iphoneVariants.filter((group) => group.id !== 'pro')), 'manual-variant-watch');
    context.service.retagWatchVariants('manual-variant-watch');
    const removed = context.service.listingDetail(key, 'manual-variant-watch').listing;
    assert.deepEqual([removed.variantKey, removed.variantSource], ['base', 'rule']);

    assert.throws(() => context.service.setListingVariant('manual-variant-watch', key, 'pro'), /Unknown variant/);
    assert.throws(() => context.service.setListingVariant('manual-variant-watch', 'OLX:not-here', 'base'), /not part of this watch/);
    seedWatch(context.db, 'plain-watch');
    assert.throws(() => context.service.setListingVariant('plain-watch', key, 'base'), /no model variants/);
  } finally { context.close(); }
});
