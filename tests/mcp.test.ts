import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../server/db';
import { ScoutService } from '../server/service';
import { SCOUT_MCP_TOOL_NAMES, createScoutMcpServer } from '../server/mcp';

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
      const readiness = JSON.parse(toolText(await client.callTool({ name: 'scout_readiness', arguments: {} }) as never));
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
