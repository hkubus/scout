import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../server/db';
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
