// What Hatbot (and any other MCP agent) may rely on from scout_search. The
// compact format's keys are a contract: add keys, never remove or retype one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../server/db';
import { SearchConfigError } from '../server/marketplaces';
import { createScoutMcpServer } from '../server/mcp';
import { searchErrorKind } from '../server/mcpFormat';
import { ScoutService, type ScoutServiceDependencies } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const olxApi = JSON.parse(readFileSync(new URL('./fixtures-olx-api.json', import.meta.url), 'utf8'));
const vintedApi = JSON.parse(readFileSync(new URL('./fixtures-vinted-api.json', import.meta.url), 'utf8'));

const MARKETPLACES = ['OLX', 'Allegro Lokalnie', 'Vinted'];

const COMPACT_LISTING_KEYS = [
  'id', 'listingId', 'source', 'title', 'price', 'shipping', 'shippingAvailable', 'url', 'image', 'sellerType',
  'condition', 'location', 'negotiable', 'postedAt', 'refreshedAt', 'relevance', 'match', 'matchedVia', 'flags',
  'jevCheck', 'jevCheckNote', 'deal', 'duplicateCount', 'duplicateCheapest',
];
const COMPACT_SOURCE_KEYS = [
  'source', 'status', 'errorKind', 'message', 'fetched', 'matched', 'returned', 'aiExcluded', 'aiUnknown',
  'aiBudgetExhausted', 'truncated', 'pendingShipping', 'durationMs', 'backoffUntil', 'variants',
];

function fixture(dependencies: ScoutServiceDependencies = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-hat-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [], ...dependencies });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

async function withClient<T>(service: ScoutService, run: (search: (args: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>) => Promise<T>) {
  const server = createScoutMcpServer(service, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scout-hat-contract-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await run(async (args) => {
      const result = await client.callTool({ name: 'scout_search', arguments: args }) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
      // The whole text content is one JSON document.
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, 'text');
      return { text: String(result.content[0].text), isError: Boolean(result.isError) };
    });
  } finally {
    await client.close();
    await server.close();
  }
}

/** Hatbot's invariants, checked on every compact payload a test produces. */
function assertHatContract(payload: any) {
  assert.equal(payload.error, undefined, 'no top-level error on success');
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.format, 'compact');
  for (const listing of payload.listings) {
    assert.deepEqual(Object.keys(listing), COMPACT_LISTING_KEYS);
    assert.match(listing.id, /^(OLX|Allegro Lokalnie|Vinted):.+/);
    assert.equal(listing.id, `${listing.source}:${listing.listingId}`);
    assert.ok(typeof listing.title === 'string' && listing.title.length > 0);
    assert.ok(typeof listing.price === 'number' && listing.price > 0);
    assert.ok(MARKETPLACES.includes(listing.source));
    assert.ok(listing.shipping === null || (typeof listing.shipping === 'number' && listing.shipping >= 0));
    assert.ok([null, 'private', 'business'].includes(listing.sellerType));
    assert.ok(listing.shippingAvailable === null || typeof listing.shippingAvailable === 'boolean');
    assert.ok(listing.negotiable === null || typeof listing.negotiable === 'boolean');
    assert.ok(['relevant', 'unknown', 'not-checked'].includes(listing.relevance));
    assert.ok(['strict', 'relaxed', 'rescued'].includes(listing.match));
    assert.ok(Array.isArray(listing.flags));
  }
  const prices = payload.listings.map((listing: any) => listing.price);
  assert.deepEqual(prices, [...prices].sort((a: number, b: number) => a - b), 'cheapest first');
  for (const source of payload.sources) {
    assert.deepEqual(Object.keys(source), COMPACT_SOURCE_KEYS);
    assert.ok(['ok', 'error'].includes(source.status));
    assert.equal(source.errorKind === null, source.status === 'ok');
  }
}

const olxOk = async () => ({ status: 200, json: structuredClone(olxApi.search) });

test('compact scout_search: stable keys, the documented values and one line of JSON', async () => {
  const context = fixture();
  (context.service as any).fetchOlxApi = olxOk;
  try {
    await withClient(context.service, async (search) => {
      const { text, isError } = await search({ query: '13 128gb', sources: ['OLX'], aiRelevance: false, format: 'compact' });
      assert.equal(isError, false);
      assert.ok(!text.includes('\n'), 'compact output has no newline');
      const payload = JSON.parse(text);
      assertHatContract(payload);
      assert.deepEqual(Object.keys(payload), ['schemaVersion', 'format', 'query', 'page', 'listings', 'sources', 'scoredAgainst', 'typoVariants']);
      assert.equal(payload.query, '13 128gb');
      assert.equal(payload.page, 1);
      // The fixture's second offer is free and never parsed.
      assert.equal(payload.listings.length, 1);
      const [listing] = payload.listings;
      assert.match(listing.image, /^https:\/\/ireland\.apollo\.olxcdn\.com/);
      assert.deepEqual({ ...listing, image: '<checked>' }, {
        id: 'OLX:1092728340', listingId: '1092728340', source: 'OLX', title: 'Iphon 13 128GB 100% Baterii Black',
        price: 800, shipping: null, shippingAvailable: true,
        url: 'https://www.olx.pl/d/oferta/iphon-13-128gb-100-baterii-black-CID99-ID1bVYyE.html', image: '<checked>',
        sellerType: null, condition: 'Używane', location: 'Małopolskie, Łapanów', negotiable: false,
        postedAt: '2026-08-20T17:40:08.000Z', refreshedAt: '2026-08-31T14:51:09.000Z',
        relevance: 'not-checked', match: 'strict', matchedVia: 'query', flags: [], jevCheck: null, jevCheckNote: null, deal: null,
        duplicateCount: 0, duplicateCheapest: null,
      });
      const [source] = payload.sources;
      assert.equal(typeof source.durationMs, 'number');
      assert.deepEqual({ ...source, durationMs: 0 }, {
        source: 'OLX', status: 'ok', errorKind: null, message: '1 matches', fetched: 1, matched: 1, returned: 1,
        aiExcluded: 0, aiUnknown: 0, aiBudgetExhausted: 0, truncated: false, pendingShipping: 0, durationMs: 0, backoffUntil: null, variants: null,
      });

      // An OLX search narrowed to an owner type returns only that type.
      const business = JSON.parse((await search({ query: '13 128gb', sources: ['OLX'], aiRelevance: false, ownerType: 'business', format: 'compact' })).text);
      assertHatContract(business);
      assert.equal(business.listings[0].sellerType, 'business');
    });
  } finally { context.close(); }
});

test('scout_search without format keeps today\'s full shape', async () => {
  const context = fixture();
  (context.service as any).fetchOlxApi = olxOk;
  try {
    await withClient(context.service, async (search) => {
      const payload = JSON.parse((await search({ query: '13 128gb', sources: ['OLX'], aiRelevance: false })).text);
      assert.deepEqual(Object.keys(payload), ['listings', 'sources']);
      assert.deepEqual(Object.keys(payload.listings[0]), [
        'id', 'title', 'subtitle', 'marketplace', 'price', 'typical', 'belowTypical', 'observed', 'observedAt',
        'dealStrength', 'dealLabel', 'image', 'url', 'watch', 'condition', 'location', 'shippingAvailable',
        'priceNegotiable', 'postedAt', 'refreshedAt', 'promoted', 'sellerType',
      ]);
      assert.deepEqual(Object.keys(payload.sources[0]), ['source', 'status', 'count', 'pendingShipping', 'durationMs', 'message']);
      assert.equal(payload.listings[0].id, 'OLX:1092728340');
      assert.equal(payload.listings[0].observed, 'just now');
      assert.equal(payload.listings[0].typical, null);
      // format: "full" is the same as leaving it out.
      const full = JSON.parse((await search({ query: '13 128gb', sources: ['OLX'], aiRelevance: false, format: 'full' })).text);
      assert.deepEqual(Object.keys(full.listings[0]), Object.keys(payload.listings[0]));
      assert.deepEqual(Object.keys(full.sources[0]), Object.keys(payload.sources[0]));
    });
  } finally { context.close(); }
});

test('scout_search advertises the format enum Hatbot detects', async () => {
  const context = fixture();
  const server = createScoutMcpServer(context.service, null);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'scout-hat-contract-test', version: '1.0.0' });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === 'scout_search');
    const format = (tool?.inputSchema.properties as Record<string, any>).format;
    assert.deepEqual(format.enum, ['full', 'compact']);
    assert.equal(format.default, 'full');
    assert.equal(tool?.annotations?.readOnlyHint, true);
    assert.equal(tool?.annotations?.destructiveHint, undefined);
  } finally {
    await client.close();
    await server.close();
    context.close();
  }
});

test('a failing source is status "error" with an errorKind, and the call itself succeeds', async () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['blocked', async () => ({ status: 403, json: null })],
    ['http', async () => ({ status: 500, json: null })],
    ['timeout', async () => { throw new Error('OLX offers API request timed out'); }],
    ['parse', async () => ({ status: 200, json: { metadata: {} } })],
  ];
  for (const [kind, fetchOlxApi] of cases) {
    const context = fixture();
    (context.service as any).fetchOlxApi = fetchOlxApi;
    try {
      await withClient(context.service, async (search) => {
        const { text, isError } = await search({ query: 'iphone 13', sources: ['OLX'], aiRelevance: false, format: 'compact' });
        assert.equal(isError, false, kind);
        const payload = JSON.parse(text);
        assertHatContract(payload);
        assert.deepEqual(payload.listings, []);
        assert.equal(payload.sources[0].status, 'error', kind);
        assert.equal(payload.sources[0].errorKind, kind, payload.sources[0].message);
        assert.ok(payload.sources[0].message.length > 0);
      });
    } finally { context.close(); }
  }
});

test('searchErrorKind classifies today\'s connector errors', () => {
  const kinds: Array<[unknown, string]> = [
    [new Error('OLX offers API request closed before completing'), 'timeout'],
    [new Error('The operation was aborted due to timeout'), 'timeout'],
    [new Error('Vinted catalog API returned HTTP 429'), 'blocked'],
    [new Error('Public page returned 401'), 'blocked'],
    [new Error('Chromium page returned 403 for Vinted (anonymous browser blocked; import a session in Settings or retry from a residential IP)'), 'blocked'],
    [new Error('Public page returned 502'), 'http'],
    [new Error('Marketplace redirected off the approved domain'), 'redirect'],
    [new Error('Unexpected redirect (302)'), 'redirect'],
    [new Error('Public page has no supported listing or empty-state markup'), 'parse'],
    [new Error('Vinted catalog page returned no usable markup'), 'parse'],
    [new Error('Vinted did not issue an anonymous access token (HTTP 200)'), 'session'],
    [new SearchConfigError('OLX did not recognise the search path "x"'), 'config'],
    [new Error('Something else'), 'unknown'],
    ['not an error', 'unknown'],
  ];
  for (const [error, kind] of kinds) assert.equal(searchErrorKind(error), kind, String(error));
});

function liveJevEnv() {
  const previous = { mode: process.env.SCOUT_JEV_MODE, key: process.env.SCOUT_OPENROUTER_API_KEY, legacy: process.env.OPENROUTER_API_KEY, deep: process.env.SCOUT_DEEPSEEK_API_KEY };
  process.env.SCOUT_JEV_MODE = 'live';
  process.env.SCOUT_OPENROUTER_API_KEY = 'sk-or-v1-test';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SCOUT_DEEPSEEK_API_KEY;
  return () => {
    for (const [name, value] of [['SCOUT_JEV_MODE', previous.mode], ['SCOUT_OPENROUTER_API_KEY', previous.key], ['OPENROUTER_API_KEY', previous.legacy], ['SCOUT_DEEPSEEK_API_KEY', previous.deep]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

const offer = (id: string, title: string, price: number) => ({
  id, url: `https://www.olx.pl/d/oferta/${id}`, title, created_time: '2026-11-01T10:00:00+01:00',
  params: [{ key: 'price', value: { value: price, currency: 'PLN', negotiable: false } }],
});

test('past the AI budget rows come back as relevance "unknown" and the source counts them', async () => {
  const restore = liveJevEnv();
  let relevanceCalls = 0;
  const context = fixture({
    classifyListingRelevanceWithJev: async () => { relevanceCalls += 1; return { relevant: true, p: 0.9, unsure: false }; },
    classifyTermMatchWithJev: async () => { throw new Error('no near-misses here'); },
    classifyConditionMatchWithJev: async () => { throw new Error('no near-misses here'); },
    classifyListingRelevanceWithVision: async () => { throw new Error('vision must not be called'); },
  });
  (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: Array.from({ length: 45 }, (_, index) => offer(`GPU-${index}`, `GPU karta ${index}`, 100 + index)), metadata: { visible_total_count: 45 } } });
  try {
    const result = await context.service.manualSearchDetailed({ query: 'gpu', sources: ['OLX'] });
    assert.equal(relevanceCalls, 40);
    const relevance = result.listings.map((listing) => result.details.listings.get(listing.id)?.relevance);
    assert.equal(relevance.filter((value) => value === 'relevant').length, 40);
    assert.equal(relevance.filter((value) => value === 'unknown').length, 5);
    assert.deepEqual(result.details.sources.get('OLX'), {
      fetched: 45, matched: 45, aiExcluded: 0, aiUnknown: 5, aiBudgetExhausted: 5, returned: 45, truncated: false, errorKind: null,
    });
  } finally {
    restore();
    context.close();
  }
});

test('a relevance check that throws keeps the rows as "unknown"; with it off they are "not-checked"', async () => {
  const context = fixture();
  (context.service as any).fetchOlxApi = olxOk;
  (context.service as any).filterListingsByAiRelevance = async () => { throw new Error('relevance cache unavailable'); };
  try {
    const relevance = async (aiRelevance: boolean) => {
      const result = await context.service.manualSearchDetailed({ query: '13 128gb', sources: ['OLX'], aiRelevance });
      assert.ok(result.listings.length > 0);
      return [...new Set(result.listings.map((listing) => result.details.listings.get(listing.id)?.relevance))];
    };
    assert.deepEqual(await relevance(true), ['unknown']);
    assert.deepEqual(await relevance(false), ['not-checked']);
  } finally { context.close(); }
});

test('compact rows say which matched strictly and which a Jev near-miss rescue brought back', async () => {
  const restore = liveJevEnv();
  const context = fixture({
    classifyListingRelevanceWithJev: async () => ({ relevant: true, p: 0.9, unsure: false }),
    classifyTermMatchWithJev: async () => ({ decision: 'pass', confidence: 0.85, unsure: false }),
    classifyConditionMatchWithJev: async () => { throw new Error('condition must not be called without candidates'); },
    classifyListingRelevanceWithVision: async () => { throw new Error('vision must not be called'); },
  });
  (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
    offer('LAD-1', 'Ladowarka Dell 65W', 100),
    offer('LAD-2', 'Ladowarki do laptopa Dell', 120),
  ], metadata: { visible_total_count: 2 } } });
  try {
    await withClient(context.service, async (search) => {
      const payload = JSON.parse((await search({ query: 'ladowarka', sources: ['OLX'], format: 'compact' })).text);
      assertHatContract(payload);
      assert.deepEqual(payload.listings.map((listing: any) => [listing.id, listing.match, listing.relevance]), [
        ['OLX:LAD-1', 'strict', 'relevant'],
        ['OLX:LAD-2', 'rescued', 'relevant'],
      ]);
      assert.equal(payload.sources[0].fetched, 2);
      assert.equal(payload.sources[0].matched, 2);
    });
  } finally {
    restore();
    context.close();
  }
});

test('compact OLX rows carry postedAt; Vinted search cards have none, so it is null', async () => {
  const context = fixture();
  (context.service as any).fetchOlxApi = olxOk;
  (context.service as any).fetchVintedApi = async () => ({ status: 200, json: structuredClone(vintedApi.search) });
  // Force Vinted's JSON path so the test stays off the network.
  (context.service as any).fetchVintedItemPage = async () => ({ status: 403, body: '' });
  (context.service as any).fetchPublicPage = async (url: string) => { throw new Error(`unexpected public page fetch: ${url}`); };
  try {
    const result = await context.service.manualSearchDetailed({ query: 'lego', sources: ['Vinted'], aiRelevance: false });
    assert.equal(result.sources[0].status, 'ok', result.sources[0].message);
    assert.ok(result.listings.length > 0);
    await withClient(context.service, async (search) => {
      const vinted = JSON.parse((await search({ query: 'lego', sources: ['Vinted'], aiRelevance: false, format: 'compact' })).text);
      assertHatContract(vinted);
      assert.ok(vinted.listings.length > 0);
      for (const listing of vinted.listings) {
        assert.equal(listing.postedAt, null);
        assert.equal(listing.source, 'Vinted');
      }
      const olx = JSON.parse((await search({ query: '13 128gb', sources: ['OLX'], aiRelevance: false, format: 'compact' })).text);
      assert.equal(olx.listings[0].postedAt, '2026-08-20T17:40:08.000Z');
    });
  } finally { context.close(); }
});
