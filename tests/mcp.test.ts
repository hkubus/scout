import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import sharp from 'sharp';
import { openDatabase } from '../server/db';
import { FlipStore, sniffImageMime } from '../server/flips';
import { ScoutService } from '../server/service';
import { MCP_DASHBOARD_LISTINGS, SCOUT_MCP_FLIP_TOOL_NAMES, SCOUT_MCP_LISTING_TOOL_NAMES, SCOUT_MCP_SESSION_TOOL_NAMES, SCOUT_MCP_TOOL_NAMES, createScoutMcpServer } from '../server/mcp';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture(authEnabled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-mcp-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { authEnabled });
  const flips = new FlipStore(db);
  return { db, service, flips, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function connectedClient(service: ScoutService, flips: FlipStore | null = null, sessions = false) {
  const server = createScoutMcpServer(service, null, flips, sessions);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scout-mcp-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function toolText(result: { content: Array<{ type: string; text?: string }> }) {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  return String(result.content[0].text);
}

test('exposes the documented Scout tool surface', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [...SCOUT_MCP_TOOL_NAMES].sort());
      // Hatbot's contract: every read tool says so; only these write.
      const writers = new Set(['scout_queue_scan', 'scout_watch_create', 'scout_watch_update', 'scout_market_watch_create', 'scout_market_watch_update', 'scout_market_scan', 'scout_listing_action', 'scout_record_outcome', 'scout_verify_listing']);
      for (const tool of listed.tools) assert.equal(tool.annotations?.readOnlyHint, !writers.has(tool.name), tool.name);
      for (const tool of listed.tools) if (!writers.has(tool.name)) assert.equal(tool.annotations?.destructiveHint, undefined, tool.name);
      const deals = listed.tools.find((tool) => tool.name === 'scout_deals')!;
      assert.deepEqual(deals.annotations, { readOnlyHint: true, idempotentHint: true });
      // It stores the verdict scans reuse, so it is not read-only, but a
      // repeat call within six hours changes nothing.
      const verify = listed.tools.find((tool) => tool.name === 'scout_verify_listing')!;
      assert.deepEqual(verify.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true });
      assert.deepEqual(Object.keys(verify.inputSchema.properties ?? {}).sort(), ['key', 'watchId']);
      assert.deepEqual(verify.inputSchema.required, ['key']);
      assert.match(String(verify.description), /scout_deals.*scout_comparables.*qualifiesOnly/);
      const listingsSchema = listed.tools.find((tool) => tool.name === 'scout_listings')!.inputSchema.properties as Record<string, { enum?: string[] }>;
      assert.deepEqual(listingsSchema.sort.enum, ['newest', 'strongest', 'price', 'discount']);
      assert.deepEqual(listingsSchema.format.enum, ['full', 'compact']);
      assert.deepEqual(listingsSchema.minTier.enum, ['strong', 'very-strong', 'exceptional']);
      for (const key of ['minDiscount', 'variantKey', 'minPrice', 'maxPrice', 'verification']) assert.ok(listingsSchema[key], key);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_readiness and scout_dashboard report the empty database truthfully', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const readinessText = toolText(await client.callTool({ name: 'scout_readiness', arguments: {} }) as never);
      const readiness = JSON.parse(readinessText);
      assert.equal(readinessText, JSON.stringify(readiness), 'tool text is compact JSON');
      assert.equal(readiness.database.ok, true);
      assert.ok(readiness.status === 'ready' || readiness.status === 'not-ready');

      const dashboard = JSON.parse(toolText(await client.callTool({ name: 'scout_dashboard', arguments: {} }) as never));
      assert.deepEqual(dashboard.stats, { watching: 0, newToday: 0, strongDeals: 0 });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_dashboard returns the head of the feed and flags truncation', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('mcp-watch', 'MCP watch', 'cpu', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const insertRow = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    const insertListing = (...values: [string, string, string, number, string, string, string]) => {
      const { lastInsertRowid } = insertRow.run(...values);
      insertObservation.run(lastInsertRowid, 'mcp-watch', values[3], now);
    };
    const { server, client } = await connectedClient(context.service);
    try {
      const call = async () => JSON.parse(toolText(await client.callTool({ name: 'scout_dashboard', arguments: {} }) as never));
      for (let index = 0; index < MCP_DASHBOARD_LISTINGS; index += 1) insertListing('OLX', `mcp-${index}`, `Listing ${index}`, 100 + index, `https://www.olx.pl/d/oferta/mcp-${index}`, now, now);
      const full = context.service.dashboard();
      assert.equal(full.listings.length, MCP_DASHBOARD_LISTINGS);
      const exact = await call();
      assert.equal(exact.listingsTruncated, false);
      assert.deepEqual(exact, JSON.parse(JSON.stringify({ ...full, listingsTruncated: false })));

      for (let index = MCP_DASHBOARD_LISTINGS; index < MCP_DASHBOARD_LISTINGS + 7; index += 1) insertListing('OLX', `mcp-${index}`, `Listing ${index}`, 100 + index, `https://www.olx.pl/d/oferta/mcp-${index}`, now, now);
      const dashboard = context.service.dashboard();
      assert.equal(dashboard.listings.length, MCP_DASHBOARD_LISTINGS + 7);
      const truncated = await call();
      assert.equal(truncated.listingsTruncated, true);
      assert.deepEqual(truncated.listings, JSON.parse(JSON.stringify(dashboard.listings.slice(0, MCP_DASHBOARD_LISTINGS))));
      const { listings: _listings, listingsTruncated: _flag, ...rest } = truncated;
      const { listings: _all, ...expectedRest } = dashboard;
      assert.deepEqual(rest, JSON.parse(JSON.stringify(expectedRest)), 'stats, watches and connectors are unchanged');
      const listed = await client.listTools();
      assert.match(String(listed.tools.find((tool) => tool.name === 'scout_dashboard')?.description), /scout_listings/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_listings defaults to a compact page and scout_queue_scan surfaces service errors', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const listings = JSON.parse(toolText(await client.callTool({ name: 'scout_listings', arguments: {} }) as never));
      assert.deepEqual(listings.pagination, { page: 1, pageSize: 20, total: 0, hasNext: false });

      const queued = await client.callTool({ name: 'scout_queue_scan', arguments: {} }) as never as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(queued.isError, true);
      assert.match(String(queued.content[0].text), /no enabled watches/i);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_listings qualifiesOnly keeps the listings whose last score would alert', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('cpu-watch', 'CPU watch', 'cpu', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const link = context.db.prepare(`INSERT INTO watch_listings (watch_id, listing_id, typical_pln, typical_source, qualifies, first_seen_at, last_seen_at)
      VALUES ('cpu-watch', ?, 1000, 'own-history', ?, ?, ?)`);
    // Rows from before the score columns existed have NULL and do not qualify.
    for (const [id, price, qualifies] of [['deal', 700, 1], ['fair', 980, 0], ['unscored', 600, null]] as const) {
      const { lastInsertRowid } = insertListing.run('OLX', id, `CPU ${id}`, price, `https://www.olx.pl/d/oferta/${id}`, now, now);
      link.run(lastInsertRowid, qualifies, now, now);
    }
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_listings')!;
      assert.equal((tool.inputSchema.properties as Record<string, { type?: string }>).qualifiesOnly?.type, 'boolean');
      const ids = async (args: Record<string, unknown>) => (JSON.parse(toolText(await client.callTool({ name: 'scout_listings', arguments: args }) as never)).listings as Array<{ listingId: string }>).map((item) => item.listingId).sort();
      assert.deepEqual(await ids({}), ['deal', 'fair', 'unscored']);
      assert.deepEqual(await ids({ qualifiesOnly: false }), ['deal', 'fair', 'unscored']);
      assert.deepEqual(await ids({ qualifiesOnly: true }), ['deal']);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_deals answers Strong+ deals right now with no arguments, and scout_listings filters by tier and discount', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('deal-watch', 'Deal watch', 'iphone 13', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertLink = context.db.prepare(`INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at, typical_pln, deal_strength, deal_label, typical_source)
      VALUES ('deal-watch', ?, ?, ?, 1000, ?, ?, 'own-history')`);
    // [id, price, strength]: strength 5 at 30% beats strength 4 at 35%.
    const rows: Array<[string, number, number, string]> = [
      ['strong', 880, 3, 'Strong'], ['very', 650, 4, 'Very strong'], ['exceptional', 700, 5, 'Exceptional'],
      ['watch', 950, 2, 'Watch'], ['hidden', 500, 5, 'Exceptional'], ['strong-deeper', 860, 3, 'Strong'],
    ];
    for (const [id, price, strength, label] of rows) {
      const { lastInsertRowid } = insertListing.run('OLX', id, `iPhone 13 ${id}`, price, `https://www.olx.pl/d/oferta/${id}`, now, now);
      insertLink.run(lastInsertRowid, now, now, strength, label);
    }
    context.service.updateListingAction('OLX:hidden', { hidden: true });
    const { server, client } = await connectedClient(context.service);
    try {
      const call = async (name: string, args: Record<string, unknown>) => JSON.parse(toolText(await client.callTool({ name, arguments: args }) as never));
      const deals = await call('scout_deals', {});
      assert.equal(deals.schemaVersion, 1);
      assert.equal(deals.minTier, 'strong');
      assert.equal(deals.total, 4);
      assert.deepEqual(deals.deals.map((deal: { id: string }) => deal.id), ['OLX:exceptional', 'OLX:very', 'OLX:strong-deeper', 'OLX:strong']);
      assert.deepEqual(deals.deals.map((deal: { tier: string }) => deal.tier), ['exceptional', 'very-strong', 'strong', 'strong']);
      assert.deepEqual(deals.deals.map((deal: { discountPercent: number }) => deal.discountPercent), [30, 35, 14, 12]);
      assert.equal(deals.total, context.service.dashboard().stats.strongDeals);
      assert.deepEqual((await call('scout_deals', { minTier: 'very-strong', limit: 1 })).deals.map((deal: { id: string }) => deal.id), ['OLX:exceptional']);

      // The default scout_listings output is unchanged: full rows.
      const full = await call('scout_listings', {});
      assert.deepEqual(Object.keys(full), ['listings', 'pagination']);
      assert.equal(full.pagination.total, 5);
      assert.ok('dealStrength' in full.listings[0] && 'image' in full.listings[0]);
      const strong = await call('scout_listings', { minTier: 'strong', sort: 'discount', format: 'compact' });
      assert.deepEqual(strong.listings.map((row: { id: string }) => row.id), ['OLX:very', 'OLX:exceptional', 'OLX:strong-deeper', 'OLX:strong']);
      assert.deepEqual(Object.keys(strong.listings[0]), Object.keys(deals.deals[0]));
      assert.deepEqual((await call('scout_listings', { minDiscount: 30, format: 'compact' })).listings.map((row: { id: string }) => row.id).sort(), ['OLX:exceptional', 'OLX:very']);
      assert.deepEqual((await call('scout_listings', { maxPrice: 700, minPrice: 650 })).listings.map((row: { id: string }) => row.id).sort(), ['OLX:exceptional', 'OLX:very']);
      assert.equal((await call('scout_listings', { verification: 'none' })).pagination.total, 5);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_price_reference prices a matched watch and returns a null best when nothing matches', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('gpu-watch', 'GPU watch', 'rtx 3080', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const insertRow = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    [1900, 2000, 2100, 2200].forEach((price, index) => {
      const { lastInsertRowid } = insertRow.run('OLX', `gpu-${index}`, `RTX 3080 ${index}`, price, `https://www.olx.pl/d/oferta/gpu-${index}`, now, now);
      insertObservation.run(lastInsertRowid, 'gpu-watch', price, now);
    });
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_price_reference')!;
      assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true });

      const text = toolText(await client.callTool({ name: 'scout_price_reference', arguments: { query: 'RTX3080', sources: ['OLX'] } }) as never);
      const reference = JSON.parse(text);
      assert.equal(text, JSON.stringify(reference), 'tool text is compact JSON');
      assert.deepEqual([reference.best.id, reference.best.typicalPrice, reference.best.samples, reference.best.ready], ['gpu-watch', 2050, 4, false]);
      assert.equal(reference.matches[0].match, 'exact');

      const none = JSON.parse(toolText(await client.callTool({ name: 'scout_price_reference', arguments: { query: 'steam deck' } }) as never));
      assert.equal(none.best, null);
      assert.deepEqual(none.matches, []);

      const invalid = await client.callTool({ name: 'scout_price_reference', arguments: { query: '' } }) as never as { isError?: boolean };
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_comparables returns compact comparables and a tool error for an unknown listing', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('gpu-watch', 'GPU watch', 'rtx 3080', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const insertRow = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, condition, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
    [['subject', 2000], ['a', 1900], ['b', 2100], ['c', 2200]].forEach(([id, price]) => {
      const { lastInsertRowid } = insertRow.run('OLX', id, `RTX 3080 ${id}`, price, `https://www.olx.pl/d/oferta/${id}`, 'Używane', now, now);
      insertObservation.run(lastInsertRowid, 'gpu-watch', price, now);
    });
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_comparables')!;
      assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true });

      const text = toolText(await client.callTool({ name: 'scout_comparables', arguments: { listingKey: 'OLX:subject', limit: 2 } }) as never);
      const result = JSON.parse(text);
      assert.equal(text, JSON.stringify(result), 'tool text is compact JSON');
      assert.deepEqual(result.comparables.map((item: { key: string }) => item.key), ['OLX:a', 'OLX:b']);
      assert.deepEqual([result.count, result.median, result.vsMedian], [3, 2100, { pln: -100, percent: -4.8 }]);

      const missing = await client.callTool({ name: 'scout_comparables', arguments: { listingKey: 'OLX:nope' } }) as never as { isError?: boolean; content: Array<{ text?: string }> };
      assert.equal(missing.isError, true);
      assert.match(String(missing.content[0].text), /not in Scout's database/);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_listing_detail adds the negotiation block and a compact format', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
      VALUES ('gpu-watch', 'GPU watch', 'rtx 3080', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
    const { lastInsertRowid } = context.db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, price_negotiable, seller_id)
      VALUES ('OLX', '11', 'RTX 3080', 1800, 'https://www.olx.pl/d/oferta/rtx-CID99-ID11.html', ?, ?, 1, '1001')`).run(now, now);
    context.db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)').run(lastInsertRowid, 'gpu-watch', 1800, now);
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_listing_detail')!;
      assert.deepEqual(tool.annotations, { readOnlyHint: true, openWorldHint: true });

      const text = toolText(await client.callTool({ name: 'scout_listing_detail', arguments: { key: 'OLX:11', format: 'compact' } }) as never);
      const detail = JSON.parse(text);
      assert.equal(text, JSON.stringify(detail), 'tool text is compact JSON');
      assert.deepEqual(Object.keys(detail).sort(), ['listing', 'liveCheck', 'negotiation']);
      assert.deepEqual([detail.negotiation.priceNegotiable, detail.negotiation.seller.id, detail.negotiation.relists], [true, '1001', []]);

      const full = JSON.parse(toolText(await client.callTool({ name: 'scout_listing_detail', arguments: { key: 'OLX:11' } }) as never));
      assert.ok(Array.isArray(full.history) && full.negotiation && full.liveCheck === null);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_record_outcome takes Hatbot\'s call, is idempotent per negotiation, and errors in the tool shape', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_record_outcome')!;
      assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true });

      // What Hatbot's negotiate_close sends, plus its negotiation id.
      const call = { negotiationId: 'neg-1', listingKey: 'OLX:11', outcome: 'agreed', price: 1700, asking: 2000, currency: 'PLN' };
      const text = toolText(await client.callTool({ name: 'scout_record_outcome', arguments: call }) as never);
      const recorded = JSON.parse(text);
      assert.equal(text, JSON.stringify(recorded), 'tool text is compact JSON');
      assert.deepEqual([recorded.created, recorded.shareOfAsking, recorded.watchId, recorded.role], [true, 0.85, null, 'buy']);
      assert.equal(JSON.parse(toolText(await client.callTool({ name: 'scout_record_outcome', arguments: call }) as never)).created, false);
      assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM negotiation_outcomes').get() as { count: number }).count, 1);

      const failed = await client.callTool({ name: 'scout_record_outcome', arguments: { ...call, negotiationId: 'neg-2', price: null } }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.equal(failed.isError, true);
      assert.deepEqual(JSON.parse(toolText(failed)), { error: 'An agreed outcome needs its final price' });

      const reference = JSON.parse(toolText(await client.callTool({ name: 'scout_price_reference', arguments: { query: 'rtx 3080' } }) as never));
      assert.deepEqual(reference.outcomes.buy.marketplaces.OLX, { negotiations: 1, agreed: 1, shareOfAsking: 0.85 });

      // scout_analytics adds them only when asked, with the same share.
      const analytics = async (args: Record<string, unknown>) => JSON.parse(toolText(await client.callTool({ name: 'scout_analytics', arguments: args }) as never));
      assert.equal('negotiations' in await analytics({}), false);
      assert.deepEqual((await analytics({ negotiations: true })).negotiations, {
        minAgreed: 3,
        buy: { negotiations: 1, agreed: 1, shareOfAsking: 0.85, marketplaces: { OLX: { negotiations: 1, agreed: 1, shareOfAsking: 0.85 } }, watches: [] },
      });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_flips returns the ledger compactly and rejects an unknown status', async () => {
  const context = fixture();
  try {
    new FlipStore(context.db).create({ title: 'RTX 3070', buyChannel: 'OLX', boughtOn: '2026-10-01', buyPrice: 1000, buyCosts: 20 });
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_flips')!;
      assert.deepEqual(tool.annotations, { readOnlyHint: true, idempotentHint: true });
      const text = toolText(await client.callTool({ name: 'scout_flips', arguments: { status: 'open' } }) as never);
      const flips = JSON.parse(text);
      assert.equal(text, JSON.stringify(flips), 'tool text is compact JSON');
      assert.deepEqual([flips.open.count, flips.open.items[0].cost, flips.open.items[0].breakEven.Vinted, flips.sold], [1, 1020, 1020, undefined]);
      const failed = await client.callTool({ name: 'scout_flips', arguments: { status: 'archived' } }) as { isError?: boolean };
      assert.equal(failed.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_search sort: newest asks every marketplace for its newest listings, and the default keeps each one\'s own order', async () => {
  const context = fixture();
  try {
    const requested: URL[] = [];
    const service = context.service as any;
    service.fetchOlxApi = async (url: string) => { requested.push(new URL(url)); return { status: 200, json: { data: [], metadata: { visible_total_count: 0 } } }; };
    // Vinted tries its catalog page first, then the catalog API; Allegro
    // Lokalnie only has its search page. Every request is recorded and none
    // leaves the process.
    service.fetchVintedItemPage = async (url: string) => { requested.push(new URL(url)); return { status: 403, body: '' }; };
    service.fetchVintedApi = async (url: string) => { requested.push(new URL(url)); return { status: 200, json: { items: [], pagination: { current_page: 1, total_pages: 0, total_entries: 0, per_page: 20 }, code: 0 } }; };
    service.fetchPublicPage = async (url: string) => { requested.push(new URL(url)); throw new Error('offline'); };
    const { server, client } = await connectedClient(context.service);
    try {
      const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_search')!;
      const sort = (tool.inputSchema.properties as Record<string, { enum?: string[]; default?: string }>).sort;
      assert.deepEqual([sort.enum, sort.default], [['relevance', 'newest'], 'relevance']);

      const search = async (extra: Record<string, unknown>) => {
        requested.length = 0;
        const result = await client.callTool({ name: 'scout_search', arguments: { query: 'steam deck', sources: ['OLX', 'Allegro Lokalnie', 'Vinted'], aiRelevance: false, ...extra } }) as { isError?: boolean };
        assert.equal(result.isError, undefined);
        const on = (host: string) => requested.filter((url) => url.hostname.endsWith(host));
        assert.ok(on('olx.pl').length && on('allegrolokalnie.pl').length && on('vinted.pl').length, 'every marketplace was asked');
        return {
          olx: on('olx.pl').map((url) => url.searchParams.get('sort_by')),
          allegro: on('allegrolokalnie.pl').map((url) => url.searchParams.get('sort')),
          vinted: on('vinted.pl').map((url) => url.searchParams.get('order')),
        };
      };
      const newest = await search({ sort: 'newest' });
      assert.ok(newest.olx.every((value) => value === 'created_at:desc'), String(newest.olx));
      assert.ok(newest.allegro.every((value) => value === 'startingTime-desc'), String(newest.allegro));
      assert.ok(newest.vinted.every((value) => value === 'newest_first'), String(newest.vinted));

      for (const extra of [{}, { sort: 'relevance' }]) {
        const own = await search(extra);
        assert.ok([...own.olx, ...own.allegro, ...own.vinted].every((value) => value === null), JSON.stringify({ extra, own }));
      }

      requested.length = 0;
      const refused = await client.callTool({ name: 'scout_search', arguments: { query: 'steam deck', sources: ['OLX'], sort: 'price_asc' } }) as { isError?: boolean };
      assert.equal(refused.isError, true);
      assert.equal(requested.length, 0);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_inbox and scout_conversation are read-only and report a missing session in the tool error shape', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const tools = (await client.listTools()).tools.filter((entry) => entry.name === 'scout_inbox' || entry.name === 'scout_conversation');
      assert.deepEqual(tools.map((tool) => [tool.name, tool.annotations]), [['scout_inbox', { readOnlyHint: true, openWorldHint: true }], ['scout_conversation', { readOnlyHint: true, openWorldHint: true }]]);
      const inbox = await client.callTool({ name: 'scout_inbox', arguments: { marketplace: 'Vinted', limit: 5 } }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.equal(inbox.isError, true);
      assert.match(JSON.parse(toolText(inbox)).error, /^No Vinted session is stored/);
      const conversation = await client.callTool({ name: 'scout_conversation', arguments: { id: 'eBay:123' } }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.equal(conversation.isError, true);
      assert.deepEqual(JSON.parse(toolText(conversation)), { error: 'Invalid conversation id; expected <Marketplace>:<conversationId> from scout_inbox' });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_watch_create makes a watch Scout scans, and refuses a price range upside down', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const created = JSON.parse(toolText(await client.callTool({ name: 'scout_watch_create', arguments: {
        name: 'Steam Deck OLED', query: 'steam deck oled', sources: ['OLX', 'Vinted'], terms: 'oled', maxPrice: 2200, targetPrice: 1700,
        verificationChecks: [{ text: 'Not cracked', mode: 'require' }],
      } }) as never));
      const [watch] = context.service.getWatches();
      assert.equal(watch.id, created.watch.id);
      assert.equal(watch.enabled, true);
      assert.deepEqual(watch.sources, ['OLX', 'Vinted']);
      assert.equal(watch.maxPrice, 2200);
      assert.equal(watch.targetPrice, 1700);
      assert.equal(watch.interval, 5);

      const upsideDown = await client.callTool({ name: 'scout_watch_create', arguments: { name: 'x', query: 'x', sources: ['OLX'], minPrice: 500, maxPrice: 100 } }) as never as { isError?: boolean };
      assert.equal(upsideDown.isError, true);
      assert.equal(context.service.getWatches().length, 1);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args }) as never as { isError?: boolean; content: Array<{ type: string; text?: string }> };
  return { isError: Boolean(result.isError), body: JSON.parse(toolText(result)) };
};

test('scout_watch_update changes only what it is given, pauses and archives, and refuses a price range upside down', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      const { body: created } = await call(client, 'scout_watch_create', { name: 'Steam Deck', query: 'steam deck', sources: ['OLX'], maxPrice: 2200, verificationChecks: [{ text: 'Not cracked', mode: 'require' }] });
      const id = created.watch.id;
      const updated = await call(client, 'scout_watch_update', { id, targetPrice: 1500, enabled: false });
      assert.equal(updated.body.watch.targetPrice, 1500);
      assert.equal(updated.body.watch.enabled, false);
      assert.equal(updated.body.watch.maxPrice, 2200);
      assert.equal(updated.body.watch.verificationChecks.length, 1);

      assert.equal((await call(client, 'scout_watch_update', { id, minPrice: 3000 })).isError, true);
      assert.equal(context.service.watchById(id)!.minPrice, null);

      await call(client, 'scout_watch_update', { id, archived: true });
      assert.equal(context.service.getWatches().length, 0);
      assert.equal((await call(client, 'scout_watch_update', { id: 'missing', name: 'x' })).isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_market_watch_create makes a research watch, and scout_market_watch_update pauses it and refuses a price range upside down', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      // The first scan would load the marketplaces' pages.
      const queued = mock.method(context.service, 'queueMarketScan', () => ({ queued: true, message: 'Queued' }));
      const { body } = await call(client, 'scout_market_watch_create', { name: 'RTX 3080', query: 'rtx 3080', sources: ['OLX', 'Allegro Lokalnie'], maxPrice: 3000, intervalHours: 12 });
      assert.deepEqual(queued.mock.calls.map((c) => c.arguments), [[body.watch.id]]);
      queued.mock.restore();
      const [watch] = context.service.marketResearch().watches;
      assert.equal(watch.id, body.watch.id);
      assert.equal(watch.intervalHours, 12);
      assert.equal(watch.maxPrice, 3000);

      assert.equal((await call(client, 'scout_market_watch_update', { id: watch.id, minPrice: 4000 })).isError, true);
      const paused = await call(client, 'scout_market_watch_update', { id: watch.id, enabled: false });
      assert.equal(paused.body.watch.enabled, false);
      assert.equal(paused.body.watch.maxPrice, 3000);
      assert.equal((await call(client, 'scout_market_scan', { id: watch.id })).isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_listing_action keeps the note when only the decision changes', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service);
    try {
      await call(client, 'scout_listing_action', { key: 'OLX:123', note: 'Ask about the box' });
      const { body } = await call(client, 'scout_listing_action', { key: 'OLX:123', decision: 'watch' });
      assert.equal(body.action.decision, 'watch');
      assert.equal(body.action.note, 'Ask about the box');
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_flip_create and scout_flip_update record a buy and its sale', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const { body } = await call(client, 'scout_flip_create', { title: 'ThinkPad T480', buyChannel: 'OLX', boughtOn: '2026-10-01', buyPrice: 600, buyCosts: 20 });
      const sold = await call(client, 'scout_flip_update', { id: body.flip.id, soldOn: '2026-10-20', saleChannel: 'Vinted', salePrice: 900, saleFee: 0 });
      assert.equal(sold.body.flip.salePrice, 900);
      assert.equal(sold.body.flip.buyPrice, 600);
      assert.equal(context.flips.get(body.flip.id).soldOn, '2026-10-20');
      assert.equal((await call(client, 'scout_flip_update', { id: 9999, note: 'x' })).isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('the listing tools are offered alongside the others when flips are available', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), [...SCOUT_MCP_TOOL_NAMES, ...SCOUT_MCP_LISTING_TOOL_NAMES, ...SCOUT_MCP_FLIP_TOOL_NAMES].sort());
      const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
      for (const name of ['scout_flips_to_list', 'scout_flip', 'scout_flip_photo', 'scout_flips_to_take_down']) assert.equal(annotations[name]?.readOnlyHint, true, name);
      for (const name of ['scout_flip_listed', 'scout_flip_taken_down']) assert.deepEqual(annotations[name], { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, name);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_session_status reports each stored session without its cookies', async () => {
  const context = fixture();
  try {
    context.service.saveMarketplaceSession('OLX', 'Personal', { cookies: [{ name: 'session', value: 'private-token', domain: '.olx.pl', path: '/' }], origins: [] });
    const { server, client } = await connectedClient(context.service);
    try {
      const result = await client.callTool({ name: 'scout_session_status', arguments: {} }) as { content: Array<{ type: string; text?: string }> };
      const text = toolText(result);
      assert.doesNotMatch(text, /private-token|cookies/);
      assert.deepEqual(JSON.parse(text), { sessions: [{ marketplace: 'OLX', signedIn: null, checkedAt: null, detail: 'Not checked yet' }] });
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('scout_verify_listing reports refusals as tool errors', async () => {
  const context = fixture();
  const keyVariables = ['SCOUT_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'SCOUT_DEEPSEEK_API_KEY'] as const;
  const previous = keyVariables.map((name) => process.env[name]);
  for (const name of keyVariables) delete process.env[name];
  try {
    const now = new Date().toISOString();
    context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('OLX', '501', 'PS5 console', 1500, 'https://www.olx.pl/d/oferta/ps5-CID99-ID501.html', now, now);
    const { server, client } = await connectedClient(context.service);
    try {
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'scout_verify_listing', arguments: args }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
        assert.equal(result.isError, true);
        return JSON.parse(toolText(result));
      };
      assert.deepEqual(await call({ key: 'OLX:missing' }), { error: 'Listing detail is not available yet' });
      assert.deepEqual(await call({ key: 'OLX:501', watchId: 'missing' }), { error: 'Watch not found' });
      assert.deepEqual(await call({ key: 'OLX:501' }), { error: 'OpenRouter is not configured. Add an API key in Settings or set SCOUT_OPENROUTER_API_KEY.' });
      const stored = context.db.prepare("SELECT ai_description_verification_status AS status FROM listings WHERE listing_id = '501'").get() as { status: string | null };
      assert.equal(stored.status, null);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    keyVariables.forEach((name, index) => { if (previous[index] !== undefined) process.env[name] = previous[index]; });
    context.close();
  }
});

// Hatbot's MCP plugin (apps/brain/src/plugins/mcp/index.ts, moneyKind) makes
// a tool whose name or description reads as a payment or a purchase always
// ask the owner. A copy of its patterns, so the listing tools never trip them.
const PAYS = /\b(pay|pays|paid|paying|payments?|payouts?|checkout|check out|transfers?|transferring|refunds?|withdraw|withdrawals?|money|funds|charges?|spend|spends|spending|donate|donates|donating|donations?|tip|invoices?|wire|deposits?|swap|swaps|swapping|trade|trades|trading|(credit|debit|saved|gift|payment) cards?)\b/i;
const BUYS = /\b(buy|buys|buying|purchase|purchases|purchasing|orders?|ordering|bid|bids|bidding|subscribe|subscriptions?|book|books|booking|reserve|reserves|reserving|reservations?|sell|sells|selling|(make|makes|send|submit|accept)s? offers?)\b/i;
// Stricter than the plugin, which would let some of these through: the handoff keeps them out entirely.
const HANDOFF_WORDS = /\b(pay\w*|checkout|transfer\w*|refund\w*|money|funds|charg\w*|spend\w*|invoic\w*|deposit\w*|trad\w*|buy\w*|purchas\w*|order\w*|bid\w*|subscri\w*|book\w*|reserv\w*|sell\w*|sold|offer\w*)\b/i;

test('the listing tools use no money or selling words in their names and descriptions', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips, true);
    try {
      const { tools } = await client.listTools();
      assert.ok(SCOUT_MCP_SESSION_TOOL_NAMES.every((name) => tools.some((tool) => tool.name === name)));
      // scout_verify_listing too, so the plugin's money-word rule never makes it always ask.
      for (const tool of tools.filter((item) => ([...SCOUT_MCP_LISTING_TOOL_NAMES, ...SCOUT_MCP_SESSION_TOOL_NAMES, 'scout_verify_listing'] as readonly string[]).includes(item.name))) {
        const words = tool.name.replace(/[_.-]+/g, ' ');
        const parameters = Object.values((tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>).map((property) => property.description ?? '').join(' ');
        for (const text of [`${words} ${tool.description}`, parameters]) {
          assert.doesNotMatch(text, PAYS, tool.name);
          assert.doesNotMatch(text, BUYS, tool.name);
          assert.doesNotMatch(text, HANDOFF_WORDS, tool.name);
        }
      }
      assert.match('Sell it in the posting order', BUYS, 'the copied patterns still catch the words');
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('Hatbot reads a ready flip, its draft and photos, and records each channel', async () => {
  const context = fixture();
  try {
    const flip = context.flips.create({ title: 'RTX 3070', buyChannel: 'OLX', boughtOn: '2026-10-01', buyPrice: 900 });
    context.flips.setListing(flip.id, {
      title: 'RTX 3070 Gaming OC', description: 'Sprawna.', condition: 'like-new', prices: { OLX: 1199 }, basePrice: 1149,
      delivery: { shipping: true, pickup: false, parcelSize: 'medium' },
    });
    const photo = await context.flips.addPhoto(flip.id, await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#3a6' } }).png().toBuffer());
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const call = async (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }>;
      const json = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await call(name, args);
        assert.equal(result.isError, undefined, `${name}: ${result.content[0]?.text}`);
        return JSON.parse(toolText(result));
      };
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [] });
      const unready = await call('scout_flip', { id: flip.id });
      assert.equal(unready.isError, true);
      assert.match(String(unready.content[0].text), /not marked ready to list/);
      assert.equal((await call('scout_flip_photo', { id: photo.id })).isError, true, 'photos of a flip that is not ready stay private');

      const revision = context.flips.markReady(flip.id, ['OLX', 'Vinted']).listingRevisedAt;
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [{ id: flip.id, updatedAt: revision, channels: [{ channel: 'OLX', status: 'ready' }, { channel: 'Vinted', status: 'ready' }] }] });
      assert.deepEqual(await json('scout_flip', { id: flip.id }), {
        id: flip.id, updatedAt: revision, title: 'RTX 3070 Gaming OC', description: 'Sprawna.', condition: 'like-new', category: null,
        delivery: { shipping: true, pickup: false, parcelSize: 'medium' }, prices: { OLX: 1199, Vinted: 1149 }, currency: 'PLN',
        photos: [{ id: photo.id, mime: 'image/jpeg' }],
      });

      const sent = await json('scout_flip_photo', { id: photo.id });
      assert.deepEqual([sent.id, sent.mime], [photo.id, 'image/jpeg']);
      const bytes = Buffer.from(sent.base64, 'base64');
      assert.equal(sniffImageMime(bytes), 'image/jpeg');
      assert.deepEqual(await sharp(bytes).metadata().then(({ width, height }) => [width, height]), [2000, 1500]);

      const refused = await call('scout_flip_listed', { flipId: flip.id, channel: 'OLX', status: 'listed', url: 'https://www.vinted.pl/items/1' });
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0].text), /not an https:\/\/ address on olx\.pl/);
      assert.equal((await call('scout_flip_listed', { flipId: flip.id, channel: 'OLX', status: 'listed' })).isError, true, 'listed needs a URL');
      assert.equal((await call('scout_flip_listed', { flipId: flip.id, channel: 'Other', status: 'declined' })).isError, true);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepEqual(await json('scout_flip_listed', { flipId: flip.id, channel: 'OLX', status: 'listed', url: 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1.html' }), { ok: true });
      }
      assert.deepEqual(await json('scout_flip_listed', { flipId: flip.id, channel: 'Vinted', status: 'declined' }), { ok: true });
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [{ id: flip.id, updatedAt: revision, channels: [
        { channel: 'OLX', status: 'listed', url: 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1.html' },
        { channel: 'Vinted', status: 'declined' },
      ] }] }, 'recording outcomes never moves updatedAt');
      assert.deepEqual(context.flips.get(flip.id).listedOn, ['OLX']);

      context.flips.cancelReady(flip.id);
      assert.deepEqual(await json('scout_flips_to_list'), { flips: [] });

      assert.deepEqual(await json('scout_flips_to_take_down'), { flips: [] });
      assert.equal((await call('scout_flip_taken_down', { flipId: flip.id, channel: 'OLX' })).isError, true, 'no sale recorded');
      context.flips.update(flip.id, { soldOn: '2026-10-20', saleChannel: 'Other', salePrice: 1100 });
      assert.deepEqual(await json('scout_flips_to_take_down'), { flips: [{ id: flip.id, title: 'RTX 3070', soldOn: '2026-10-20', saleChannel: 'Other', channels: [{ channel: 'OLX', url: 'https://www.olx.pl/d/oferta/rtx-3070-CID99-ID1.html' }] }] });
      for (let attempt = 0; attempt < 2; attempt += 1) assert.deepEqual(await json('scout_flip_taken_down', { flipId: flip.id, channel: 'OLX' }), { ok: true });
      assert.deepEqual(await json('scout_flips_to_take_down'), { flips: [] });
      assert.deepEqual(context.flips.get(flip.id).delisted, ['OLX']);
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

const olxState = (value: string) => ({ cookies: [{ name: 'access_token', value, domain: '.olx.pl', path: '/', httpOnly: true, secure: true }], origins: [] });

test('connected apps get only the marketplace sessions the owner shared', async () => {
  const context = fixture(true);
  try {
    context.service.saveMarketplaceSession('OLX', 'Haggler', olxState('first'));
    context.service.saveMarketplaceSession('Vinted', '', { cookies: [{ name: 'v', value: 'x', domain: 'www.vinted.pl', path: '/' }], origins: [] });
    const { server, client } = await connectedClient(context.service, null, true);
    try {
      const list = async () => JSON.parse(toolText(await client.callTool({ name: 'scout_shared_sessions', arguments: {} }) as never)).sessions;
      assert.deepEqual(await list(), []);
      const refused = await client.callTool({ name: 'scout_shared_session', arguments: { marketplace: 'OLX' } }) as never as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      assert.equal(refused.isError, true);
      assert.doesNotMatch(toolText(refused), /first/);

      context.service.shareMarketplaceSession('OLX', true);
      const [shared] = await list();
      assert.deepEqual(Object.keys(shared).sort(), ['label', 'marketplace', 'revision']);
      assert.equal(shared.marketplace, 'OLX');
      const session = JSON.parse(toolText(await client.callTool({ name: 'scout_shared_session', arguments: { marketplace: 'OLX' } }) as never));
      assert.equal(session.revision, shared.revision);
      assert.equal(session.storageState.cookies[0].value, 'first');

      context.service.shareMarketplaceSession('OLX', false);
      context.service.shareMarketplaceSession('OLX', true);
      assert.equal((await list())[0].revision, shared.revision, 'the revision holds until the session is imported again');
      context.service.saveMarketplaceSession('OLX', 'Haggler', olxState('second'));
      assert.notEqual((await list())[0].revision, shared.revision);
      assert.equal(context.service.marketplaceSessions().find((item) => item.marketplace === 'OLX')?.sharedWithApps, true, 're-importing keeps the choice');
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('the session tools are only offered to connected apps', async () => {
  const context = fixture();
  try {
    const { server, client } = await connectedClient(context.service, context.flips);
    try {
      const { tools } = await client.listTools();
      assert.ok(!tools.some((tool) => (SCOUT_MCP_SESSION_TOOL_NAMES as readonly string[]).includes(tool.name)));
    } finally {
      await client.close();
      await server.close();
    }
  } finally { context.close(); }
});

test('without sign-in, nothing is shared: anyone on the network could connect an app', async () => {
  const context = fixture();
  try {
    context.service.saveMarketplaceSession('OLX', '', olxState('first'));
    assert.throws(() => context.service.shareMarketplaceSession('OLX', true), /sign-in/);
    context.db.prepare('UPDATE marketplace_sessions SET shared_with_apps = 1').run();
    assert.deepEqual(await context.service.sharedMarketplaceSessions(), []);
    await assert.rejects(context.service.sharedMarketplaceSession('OLX'), /isn't shared/);
  } finally { context.close(); }
});
