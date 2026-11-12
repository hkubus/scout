import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createScoutMcpServer } from '../server/mcp';
import type { ScoutService } from '../server/service';
import { olxOffer, olxPage, searchFixture } from './searchFixture';

// scout_search over MCP: input checks and the search inputs these branches add.

async function connectedClient(service: ScoutService) {
  const server = createScoutMcpServer(service, null, null, false);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scout-mcp-search-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

function toolText(result: unknown) {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  assert.equal(content.length, 1);
  return String(content[0].text);
}

test('scout_search refuses an inverted price range and searches a repeated source once', async () => {
  const context = searchFixture();
  let fetches = 0;
  (context.service as any).fetchOlxApi = async () => { fetches += 1; return olxPage([olxOffer('D-1', 'Steam Deck OLED', 2000)]); };
  const { client, close } = await connectedClient(context.service);
  try {
    const inverted = await client.callTool({ name: 'scout_search', arguments: { query: 'steam deck', sources: ['OLX'], minPrice: 500, maxPrice: 100 } }) as { isError?: boolean };
    assert.equal(inverted.isError, true);
    assert.match(toolText(inverted), /Minimum price cannot exceed maximum price/);
    assert.equal(fetches, 0);

    const repeated = JSON.parse(toolText(await client.callTool({ name: 'scout_search', arguments: { query: 'steam deck', sources: ['OLX', 'OLX'], aiRelevance: false } })));
    assert.equal(fetches, 1);
    assert.deepEqual(repeated.sources.map((source: { source: string }) => source.source), ['OLX']);
    assert.equal(repeated.listings.length, 1);
  } finally {
    await close();
    context.close();
  }
});

test('scout_search describes the conditions it understands', async () => {
  const context = searchFixture();
  const { client, close } = await connectedClient(context.service);
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_search')!;
    const condition = (tool.inputSchema.properties as Record<string, { description?: string }>).condition;
    assert.match(String(condition.description), /Used \(leaves out damaged listings\)/);
  } finally {
    await close();
    context.close();
  }
});

test('scout_search reports a backed-off marketplace as a source error, not a failed call', async () => {
  const context = searchFixture();
  let fetches = 0;
  (context.service as any).fetchOlxApi = async () => { fetches += 1; return olxPage([olxOffer('P-1', 'Steam Deck', 1500)]); };
  const until = new Date(Date.now() + 60_000).toISOString();
  context.db.prepare("INSERT INTO connector_runs (source, status, message, started_at, finished_at, backoff_until) VALUES ('OLX', 'error', 'x', ?, ?, ?)").run(new Date().toISOString(), new Date().toISOString(), until);
  const { client, close } = await connectedClient(context.service);
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_search')!;
    assert.deepEqual((tool.inputSchema.properties as Record<string, unknown>).ignoreBackoff, { type: 'boolean', default: false, description: (tool.inputSchema.properties as any).ignoreBackoff.description });
    const compact = await client.callTool({ name: 'scout_search', arguments: { query: 'steam deck', sources: ['OLX'], format: 'compact' } }) as { isError?: boolean };
    assert.equal(compact.isError, undefined);
    const payload = JSON.parse(toolText(compact));
    assert.equal(payload.error, undefined);
    assert.deepEqual([payload.sources[0].status, payload.sources[0].errorKind, payload.sources[0].backoffUntil], ['error', 'backoff', until]);
    assert.equal(fetches, 0);
    const anyway = JSON.parse(toolText(await client.callTool({ name: 'scout_search', arguments: { query: 'steam deck', sources: ['OLX'], ignoreBackoff: true, aiRelevance: false } })));
    assert.equal(anyway.sources[0].status, 'ok');
    assert.equal(fetches, 1);
  } finally {
    await close();
    context.close();
  }
});

test('scout_search advertises typoVariants off by default, with its cost', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = async (url: string) => {
    const query = String(new URL(url).searchParams.get('query'));
    queries.push(query);
    return olxPage(query === 'iphon 13' ? [olxOffer('V-2', 'Iphon 13', 900)] : query === 'iphone 13' ? [olxOffer('V-1', 'iPhone 13', 1500)] : []);
  };
  const { client, close } = await connectedClient(context.service);
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_search')!;
    const schema = (tool.inputSchema.properties as Record<string, any>).typoVariants;
    assert.deepEqual({ ...schema, description: '' }, { type: 'boolean', default: false, description: '' });
    assert.match(schema.description, /2 extra page fetches per marketplace/);
    assert.match(schema.description, /never "relevant"/);
    const compact = JSON.parse(toolText(await client.callTool({ name: 'scout_search', arguments: { query: 'iphone 13', sources: ['OLX'], typoVariants: true, aiRelevance: false, format: 'compact' } })));
    assert.deepEqual(compact.typoVariants, ['iphon 13', 'iphoen 13']);
    assert.deepEqual(compact.listings.map((listing: { matchedVia: string }) => listing.matchedVia), ['typo:iphon 13', 'query']);
    assert.equal(queries.length, 3);
  } finally {
    await close();
    context.close();
  }
});

test('scout_search takes a deadline (the wait for a slot included) and a cache bypass', async () => {
  const context = searchFixture();
  const { client, close } = await connectedClient(context.service);
  try {
    const tool = (await client.listTools()).tools.find((entry) => entry.name === 'scout_search')!;
    const schema = (tool.inputSchema.properties as Record<string, any>).deadlineMs;
    assert.deepEqual({ type: schema.type, minimum: schema.minimum, maximum: schema.maximum }, { type: 'integer', minimum: 5000, maximum: 120000 });
    assert.match(schema.description, /errorKind "deadline"/);
    assert.equal((tool.inputSchema.required as string[]).includes('deadlineMs'), false);
    const refused = await client.callTool({ name: 'scout_search', arguments: { query: 'x', sources: ['OLX'], deadlineMs: 1000 } });
    assert.equal(refused.isError, true);
    const refresh = (tool.inputSchema.properties as Record<string, any>).refresh;
    assert.deepEqual({ ...refresh, description: '' }, { type: 'boolean', default: false, description: '' });
    assert.match(refresh.description, /fromCache/);
  } finally {
    await close();
    context.close();
  }
});
