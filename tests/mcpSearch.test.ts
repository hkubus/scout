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
