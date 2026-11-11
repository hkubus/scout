import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../server/db';
import { createScoutMcpServer } from '../server/mcp';
import { ScoutService } from '../server/service';
import type { Listing, ManualSearchResponse, SearchFilters } from '../src/types';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-search-score-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const iphoneVariants = [
  { id: 'mini', label: '13 mini', terms: '13, mini' },
  { id: 'base', label: '13', terms: '13' },
  { id: 'pro', label: '13 Pro', terms: '13, pro' },
];
const shape = [0.95, 0.97, 0.98, 0.99, 1, 1, 1, 1, 1.01, 1.02, 1.03, 1.05];
const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function seedWatch(db: any, id: string, query: string, overrides: { sources?: string[]; excluded?: string } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, excluded_terms, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run(id, `${id} name`, query, overrides.excluded ?? '', JSON.stringify(overrides.sources ?? ['OLX']), now, now, now);
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

/** A ready three-model watch: 12 samples per variant, 8 hours old. */
function seedVariantWatch(db: any, service: ScoutService, watchId: string) {
  seedWatch(db, watchId, 'iphone 13', { excluded: 'etui' });
  const items: Array<[string, number]> = [];
  for (const [title, center] of [['iPhone 13 mini', 1500], ['iPhone 13', 2000], ['iPhone 13 Pro', 2600]] as const) {
    for (const ratio of shape) items.push([`${title} 128GB`, center * ratio]);
  }
  observe(db, watchId, items);
  db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify(iphoneVariants), watchId);
  service.retagWatchVariants(watchId);
}

/** Serves these OLX results to every search and counts the fetches. */
function stubOlx(service: ScoutService, offers: Array<[string, string, number]>) {
  const calls = { count: 0 };
  (service as any).fetchOlxApi = async () => {
    calls.count += 1;
    return { status: 200, json: { data: offers.map(([id, title, price]) => ({
      id, url: `https://www.olx.pl/d/oferta/${id.toLowerCase()}`, title, created_time: new Date().toISOString(),
      params: [{ key: 'price', value: { value: price, currency: 'PLN', negotiable: false } }],
    })), metadata: { visible_total_count: offers.length } } };
  };
  return calls;
}

const search = (service: ScoutService, query: string, extra: Partial<SearchFilters> = {}) =>
  service.manualSearch({ query, sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', aiRelevance: false, ...extra });

const byTitle = (result: ManualSearchResponse) => new Map(result.listings.map((listing) => [listing.title, listing]));

/** What the watch's scan computes for this price in this bucket. */
function scanScore(context: ReturnType<typeof fixture>, watchId: string, price: number, key: string) {
  const service = context.service as any;
  const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId) as Record<string, any>;
  const referenceMedian = row.reference_market_watch_id ? service.referenceBandMedian(String(row.reference_market_watch_id)) : null;
  return service.variantDealScore(row, price, service.watchBaselines(row), key, referenceMedian) as {
    score: { typical: number | null; discountPercent: number | null; deviation: number | null; qualifies: boolean; isReady: boolean };
    useReference: boolean;
    dealStrength: number | null;
  };
}

function assertScanScore(context: ReturnType<typeof fixture>, watchId: string, listing: Listing, key: string) {
  const deal = listing.deal!;
  const { score, dealStrength } = scanScore(context, watchId, listing.price, key);
  assert.ok(score.typical !== null && score.discountPercent !== null && score.deviation !== null, listing.title);
  assert.equal(deal.typical, Math.round(score.typical * 100) / 100, listing.title);
  assert.equal(deal.discountPercent, Math.round(score.discountPercent * 10) / 10, listing.title);
  assert.equal(deal.deviation, Math.round(score.deviation * 100) / 100, listing.title);
  assert.equal(deal.qualifies, score.qualifies, listing.title);
  assert.equal(deal.tier, dealStrength ?? 1, listing.title);
}

const offers: Array<[string, string, number]> = [
  ['S-PRO', 'iPhone 13 Pro 256GB', 1900],
  ['S-BASE', 'iPhone 13 128GB czarny', 2100],
  ['S-MINI', 'iPhone 13 mini 128GB', 1400],
  ['S-CASE', 'Etui iPhone 13 silikon', 30],
];

test('scoreAgainst auto scores each result exactly as the watch scan would, in its own variant', async () => {
  const context = fixture();
  try {
    seedVariantWatch(context.db, context.service, 'iphone-watch');
    stubOlx(context.service, offers);
    const result = await search(context.service, 'iphone 13', { scoreAgainst: 'auto' });
    assert.deepEqual(result.scoredAgainst, { watchId: 'iphone-watch', name: 'iphone-watch name', match: 'exact', notes: ['Asking prices, not completed sales.'] });
    const listings = byTitle(result);
    assert.equal(listings.size, 4);

    const pro = listings.get('iPhone 13 Pro 256GB')!;
    assert.deepEqual(pro.deal, { typical: 2600, discountPercent: 26.9, deviation: pro.deal!.deviation, tier: 5, label: 'Exceptional', qualifies: true, basis: 'own-history', variantKey: 'pro', variantLabel: '13 Pro' });
    assertScanScore(context, 'iphone-watch', pro, 'pro');
    const base = listings.get('iPhone 13 128GB czarny')!;
    assert.deepEqual([base.deal?.variantKey, base.deal?.typical, base.deal?.discountPercent, base.deal?.tier, base.deal?.label, base.deal?.qualifies], ['base', 2000, -5, 1, 'Watch', false]);
    assertScanScore(context, 'iphone-watch', base, 'base');
    const mini = listings.get('iPhone 13 mini 128GB')!;
    assert.equal(mini.deal?.variantKey, 'mini');
    assert.equal(mini.deal?.typical, 1500);
    assertScanScore(context, 'iphone-watch', mini, 'mini');
    // The watch excludes cases, so a 30 zł case is not priced as a phone.
    assert.equal(listings.get('Etui iPhone 13 silikon')!.deal, null);

    // Naming the watch gives the same scores.
    const named = await search(context.service, 'iphone 13', { scoreAgainst: 'iphone-watch' });
    assert.equal(named.scoredAgainst?.match, 'exact');
    assert.deepEqual(named.listings.map((listing) => listing.deal), result.listings.map((listing) => listing.deal));
  } finally { context.close(); }
});

test('scoreAgainst writes nothing to any watch and leaves the default output unchanged', async () => {
  const context = fixture();
  try {
    seedVariantWatch(context.db, context.service, 'iphone-watch');
    stubOlx(context.service, offers);
    const counts = () => Object.fromEntries(['observations', 'watch_listings', 'scans', 'listing_relevance', 'notifications', 'daily_digest_candidates']
      .map((table) => [table, (context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count]));
    const watchBefore = context.db.prepare('SELECT * FROM watches').all();
    const before = counts();
    const plain = await search(context.service, 'iphone 13');
    const scored = await search(context.service, 'iphone 13', { scoreAgainst: 'auto' });
    assert.deepEqual(counts(), before);
    assert.deepEqual(context.db.prepare('SELECT * FROM watches').all(), watchBefore);

    // Without the input, the response has exactly today's keys.
    assert.deepEqual(Object.keys(plain).sort(), ['listings', 'sources']);
    assert.ok(plain.listings.every((listing) => !('deal' in listing)));
    assert.deepEqual(Object.keys(scored).sort(), ['listings', 'scoredAgainst', 'sources']);
    for (const listing of scored.listings) {
      const { deal, ...rest } = listing;
      assert.ok(deal !== undefined);
      const original = plain.listings.find((item) => item.id === listing.id)!;
      // The stub stamps each fetch's offers with the current time.
      const stable = (item: Omit<Listing, 'deal'>) => ({ ...item, observedAt: '', postedAt: '' });
      assert.deepEqual(stable(rest), stable(original), 'scoring only adds deal');
    }
  } finally { context.close(); }
});

test('a learning watch prices from its reference series, or reports learning without a typical', async () => {
  const context = fixture();
  try {
    const version = (() => {
      context.service.createMarketWatch({ id: 'ref-series', name: 'ref series', query: 'ryzen 5600', terms: '', excluded: '', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: false });
      return (context.db.prepare('SELECT active_version_id FROM market_watches WHERE id = ?').get('ref-series') as { active_version_id: string }).active_version_id;
    })();
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
    const insert = context.db.prepare(`INSERT INTO market_listings (market_watch_id, version_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, ended_at, ended_reason)
      VALUES ('ref-series', ?, 'OLX', ?, 'Ryzen 5 5600', ?, ?, ?, ?, ?, ?, 'ended', 3, ?, 'Ad not found.')`);
    [100, 200, 300, 400, 500].forEach((price, index) => insert.run(version, `ended-${index}`, `https://www.olx.pl/d/oferta/ended-${index}`, price, price, price, daysAgo(2), daysAgo(1), daysAgo(1)));
    seedWatch(context.db, 'cpu', 'ryzen 5600');
    context.db.prepare('UPDATE watches SET reference_market_watch_id = ? WHERE id = ?').run('ref-series', 'cpu');
    stubOlx(context.service, [['S-CPU', 'Ryzen 5 5600 box', 240]]);
    const banded = await search(context.service, 'ryzen 5600', { scoreAgainst: 'cpu' });
    const deal = banded.listings[0].deal!;
    assert.deepEqual(deal, { typical: 300, discountPercent: 20, deviation: deal.deviation, tier: 3, label: 'Strong', qualifies: false, basis: 'reference-band', variantKey: null, variantLabel: null });
    assert.equal(scanScore(context, 'cpu', 240, '__other__').useReference, true);
    assertScanScore(context, 'cpu', banded.listings[0], '__other__');

    // 20 samples is below the 30-sample floor, and there is no reference.
    seedWatch(context.db, 'gpu', 'rtx 3080');
    observe(context.db, 'gpu', Array.from({ length: 20 }, (_, index): [string, number] => [`RTX 3080 ${index}`, 2000 + index * 10]));
    stubOlx(context.service, [['S-GPU', 'RTX 3080 Gaming', 1500]]);
    const learning = await search(context.service, 'rtx 3080', { scoreAgainst: 'gpu' });
    assert.deepEqual(learning.listings[0].deal, { typical: null, discountPercent: null, deviation: null, tier: null, label: null, qualifies: false, basis: 'learning', variantKey: null, variantLabel: null });
    assert.equal(scanScore(context, 'gpu', 1500, '__other__').score.isReady, false);
  } finally { context.close(); }
});

test('auto picks the watch on the searched marketplaces with the most history, and skips other products', async () => {
  const context = fixture();
  try {
    const prices = (count: number) => Array.from({ length: count }, (_, index): [string, number] => [`RTX 3080 ${index}`, 2000 + index]);
    seedWatch(context.db, 'a-olx-short', 'rtx 3080');
    observe(context.db, 'a-olx-short', prices(5));
    seedWatch(context.db, 'b-olx-long', 'rtx 3080');
    observe(context.db, 'b-olx-long', prices(40));
    seedWatch(context.db, 'c-vinted', 'rtx 3080', { sources: ['Vinted'] });
    observe(context.db, 'c-vinted', prices(60));
    seedWatch(context.db, 'd-ti', 'rtx 3080 ti');
    observe(context.db, 'd-ti', prices(80));
    seedWatch(context.db, 'e-rtx', 'rtx');
    observe(context.db, 'e-rtx', prices(90));
    stubOlx(context.service, [['S-GPU', 'RTX 3080 Gaming', 1500]]);
    const result = await search(context.service, 'rtx 3080', { scoreAgainst: 'auto' });
    assert.equal(result.scoredAgainst?.watchId, 'b-olx-long');

    // A narrower watch is never picked automatically, but can be named, with a note.
    const named = await search(context.service, 'rtx 3080', { scoreAgainst: 'd-ti' });
    assert.equal(named.scoredAgainst?.match, 'narrower');
    assert.equal(named.listings[0].deal, null, 'the ti watch would not keep a plain 3080');
    assert.equal(named.scoredAgainst?.notes.length, 2);

    // A query no watch names scores nothing.
    stubOlx(context.service, [['S-DECK', 'Steam Deck 512GB', 1500]]);
    const none = await search(context.service, 'steam deck', { scoreAgainst: 'auto' });
    assert.equal(none.scoredAgainst, null);
    assert.ok(none.listings.every((listing) => !('deal' in listing)));
  } finally { context.close(); }
});

test('an unknown or archived watch fails before any marketplace fetch', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'old', 'rtx 3080');
    context.db.prepare('UPDATE watches SET archived_at = ? WHERE id = ?').run(new Date().toISOString(), 'old');
    const calls = stubOlx(context.service, [['S-GPU', 'RTX 3080 Gaming', 1500]]);
    await assert.rejects(search(context.service, 'rtx 3080', { scoreAgainst: 'missing' }), /Watch not found/);
    await assert.rejects(search(context.service, 'rtx 3080', { scoreAgainst: 'old' }), /Watch not found/);
    assert.equal(calls.count, 0);
    // The busy counter was not left raised by the failures.
    assert.equal((context.service as any).activeManualSearches, 0);
    // Archived watches are not auto candidates either.
    assert.equal((await search(context.service, 'rtx 3080', { scoreAgainst: 'auto' })).scoredAgainst, null);
  } finally { context.close(); }
});

// Hatbot's MCP plugin makes a tool whose name or description reads as a
// payment or a purchase ask the owner every time (see tests/mcp.test.ts), and
// hat's deal hunts run scout_search unattended.
const PAYS = /\b(pay|pays|paid|paying|payments?|payouts?|checkout|check out|transfers?|transferring|refunds?|withdraw|withdrawals?|money|funds|charges?|spend|spends|spending|donate|donates|donating|donations?|tip|invoices?|wire|deposits?|swap|swaps|swapping|trade|trades|trading|(credit|debit|saved|gift|payment) cards?)\b/i;
const BUYS = /\b(buy|buys|buying|purchase|purchases|purchasing|orders?|ordering|bid|bids|bidding|subscribe|subscriptions?|book|books|booking|reserve|reserves|reserving|reservations?|sell|sells|selling|(make|makes|send|submit|accept)s? offers?)\b/i;

test('scout_search takes scoreAgainst over MCP and stays read-only and free of money words', async () => {
  const context = fixture();
  const server = createScoutMcpServer(context.service);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scout-search-score-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tool = (await client.listTools()).tools.find((item) => item.name === 'scout_search')!;
    assert.equal(tool.annotations?.readOnlyHint, true);
    assert.equal(tool.annotations?.destructiveHint, undefined);
    const properties = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
    assert.equal(properties.scoreAgainst?.type, 'string');
    assert.ok(!(tool.inputSchema.required ?? []).includes('scoreAgainst'));
    const parameters = Object.values(properties).map((property) => property.description ?? '').join(' ');
    for (const text of [`scout search ${tool.description}`, parameters]) {
      assert.doesNotMatch(text, PAYS);
      assert.doesNotMatch(text, BUYS);
    }

    seedVariantWatch(context.db, context.service, 'iphone-watch');
    stubOlx(context.service, offers);
    const call = (args: Record<string, unknown>) => client.callTool({ name: 'scout_search', arguments: { query: 'iphone 13', sources: ['OLX'], aiRelevance: false, ...args } }) as Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
    const payload = JSON.parse((await call({ scoreAgainst: 'auto' })).content[0].text) as ManualSearchResponse;
    assert.equal(payload.scoredAgainst?.watchId, 'iphone-watch');
    assert.equal(payload.listings.find((listing) => listing.id === 'OLX:S-PRO')?.deal?.tier, 5);
    assert.equal(payload.listings.find((listing) => listing.id === 'OLX:S-CASE')?.deal, null);
    const plain = JSON.parse((await call({})).content[0].text) as ManualSearchResponse;
    assert.ok(!('scoredAgainst' in plain) && plain.listings.every((listing) => !('deal' in listing)));
    const missing = await call({ scoreAgainst: 'missing' });
    assert.equal(missing.isError, true);
    assert.deepEqual(JSON.parse(missing.content[0].text), { error: 'Watch not found' });
  } finally {
    await client.close();
    await server.close();
    context.close();
  }
});
