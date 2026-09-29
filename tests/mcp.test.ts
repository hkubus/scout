import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createScoutMcpServer } from '../server/mcp';

type Call = { url: string; method: string; body: unknown };

function fakeFetch(routes: Record<string, { status?: number; payload: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const route = routes[`${method} ${path}`];
    if (!route) throw new Error(`No fake route for ${method} ${path}`);
    return new Response(JSON.stringify(route.payload), { status: route.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

async function connect(options: Parameters<typeof createScoutMcpServer>[0]) {
  const { server } = createScoutMcpServer(options);
  const client = new Client({ name: 'scout-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

test('registers read tools and omits write tools by default', async () => {
  const { fetchImpl } = fakeFetch({});
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test' });
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('get_dashboard'));
  assert.ok(tools.includes('search_listings'));
  assert.ok(!tools.includes('create_watch'));
  assert.ok(!tools.includes('delete_watch'));
});

test('get_dashboard returns JSON text from the API', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'GET /api/dashboard': { payload: { counters: { deals: 3 } } } });
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test' });
  const result = await client.callTool({ name: 'get_dashboard', arguments: {} });
  const content = result.content as { type: string; text: string }[];
  assert.match(content[0].text, /"deals": 3/);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'http://scout.test/api/dashboard');
});

test('maps API errors to isError results without throwing', async () => {
  const { fetchImpl } = fakeFetch({ 'GET /api/listing-detail': { status: 404, payload: { error: 'Listing not found' } } });
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test' });
  const result = await client.callTool({ name: 'get_listing_detail', arguments: { key: 'olx-123' } });
  const content = result.content as { type: string; text: string }[];
  assert.equal(result.isError, true);
  assert.match(content[0].text, /Listing not found/);
});

test('enables write tools and forwards the request body when opted in', async () => {
  const { fetchImpl, calls } = fakeFetch({ 'POST /api/watches': { status: 201, payload: { watch: { id: 'watch-1' } } } });
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test', allowWrites: true });
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(tools.includes('create_watch'));
  const result = await client.callTool({ name: 'create_watch', arguments: { name: 'GPU', query: 'rtx 4090', sources: ['OLX'] } });
  assert.notEqual(result.isError, true);
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { name: 'GPU', query: 'rtx 4090', sources: ['OLX'] });
});

test('exposes dashboard and status resources', async () => {
  const { fetchImpl } = fakeFetch({
    'GET /api/ready': { payload: { status: 'ready' } },
    'GET /api/dashboard': { payload: { counters: {} } },
  });
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test' });
  const resources = (await client.listResources()).resources.map((resource) => resource.uri);
  assert.ok(resources.includes('scout://status'));
  const status = await client.readResource({ uri: 'scout://status' });
  const first = status.contents[0];
  assert.ok('text' in first);
  assert.match(first.text, /"status": "ready"/);
});

test('forwards model groups on create_watch and update_watch', async () => {
  const { fetchImpl, calls } = fakeFetch({
    'POST /api/watches': { status: 201, payload: { watch: { id: 'watch-1' } } },
    'PATCH /api/watches/watch-1': { payload: { ok: true } },
  });
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test', allowWrites: true });
  const groups = [{ name: '13 Pro', terms: '13, pro' }, { key: '13', name: '13', terms: '13', excluded: 'etui' }];
  const created = await client.callTool({ name: 'create_watch', arguments: { name: 'iPhone 13', query: 'iphone 13', sources: ['OLX'], groups } });
  assert.notEqual(created.isError, true);
  assert.deepEqual((calls[0].body as { groups: unknown }).groups, [{ name: '13 Pro', terms: '13, pro', excluded: '' }, { key: '13', name: '13', terms: '13', excluded: 'etui' }]);

  const updated = await client.callTool({ name: 'update_watch', arguments: { watchId: 'watch-1', groups: [] } });
  assert.notEqual(updated.isError, true);
  assert.equal(calls[1].method, 'PATCH');
  assert.deepEqual(calls[1].body, { groups: [] });
});

test('rejects malformed groups before calling the API', async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test', allowWrites: true });
  const tooMany = Array.from({ length: 21 }, (_, index) => ({ name: `g${index}`, terms: `t${index}` }));
  for (const groups of [[{ name: 'No terms', terms: '' }], tooMany]) {
    const outcome = await client.callTool({ name: 'update_watch', arguments: { watchId: 'watch-1', groups } }).catch((error: unknown) => ({ thrown: error }));
    assert.ok('thrown' in outcome || outcome.isError === true, 'invalid groups must not succeed');
  }
  assert.equal(calls.length, 0);
});

test('set_listing_group sends a PUT and is only registered with writes enabled', async () => {
  const readOnly = await connect({ fetchImpl: fakeFetch({}).fetchImpl, apiUrl: 'http://scout.test' });
  assert.ok(!(await readOnly.client.listTools()).tools.some((tool) => tool.name === 'set_listing_group'));

  const { fetchImpl, calls } = fakeFetch({ 'PUT /api/listing-group': { payload: { listing: { group: '13 Pro', groupSource: 'manual' } } } });
  const { client } = await connect({ fetchImpl, apiUrl: 'http://scout.test', allowWrites: true });
  const moved = await client.callTool({ name: 'set_listing_group', arguments: { key: 'OLX:123', watchId: 'watch-1', groupKey: '13-pro' } });
  assert.notEqual(moved.isError, true);
  assert.match((moved.content as { text: string }[])[0].text, /"groupSource": "manual"/);
  const reset = await client.callTool({ name: 'set_listing_group', arguments: { key: 'OLX:123', watchId: 'watch-1', groupKey: null } });
  assert.notEqual(reset.isError, true);
  assert.deepEqual(calls.map((call) => [call.method, call.url, call.body]), [
    ['PUT', 'http://scout.test/api/listing-group', { key: 'OLX:123', watchId: 'watch-1', groupKey: '13-pro' }],
    ['PUT', 'http://scout.test/api/listing-group', { key: 'OLX:123', watchId: 'watch-1', groupKey: null }],
  ]);
});
