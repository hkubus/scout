import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../server/db';
import { FlipStore } from '../server/flips';
import { ScoutService } from '../server/service';
import { MCP_DASHBOARD_LISTINGS, SCOUT_MCP_TOOL_NAMES, createScoutMcpServer } from '../server/mcp';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-mcp-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, {});
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function connectedClient(service: ScoutService) {
  const server = createScoutMcpServer(service);
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
      const writers = new Set(['scout_queue_scan', 'scout_record_outcome']);
      for (const tool of listed.tools) assert.equal(tool.annotations?.readOnlyHint, !writers.has(tool.name), tool.name);
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
