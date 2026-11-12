import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { olxOffer, olxPage, searchFixture, searchInput } from './searchFixture';

const vintedApi = JSON.parse(readFileSync(new URL('./fixtures-vinted-api.json', import.meta.url), 'utf8'));

// P0-3: manual searches queue for one of three slots instead of being
// refused, and identical searches share one run.

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** An OLX stub whose pages wait until released, per query. */
function gatedOlx(service: unknown) {
  const fetches: string[] = [];
  const gates = new Map<string, Array<() => void>>();
  let inFlight = 0;
  let peak = 0;
  (service as any).fetchOlxApi = async (url: string) => {
    const query = String(new URL(url).searchParams.get('query'));
    fetches.push(query);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise<void>((resolve) => { const waiting = gates.get(query) ?? []; waiting.push(resolve); gates.set(query, waiting); });
    inFlight -= 1;
    return olxPage([olxOffer(`ID-${query.replace(/\s+/g, '-')}`, `${query} oferta`, 100)]);
  };
  return {
    fetches,
    get peak() { return peak; },
    waiting: (query: string) => gates.get(query)?.length ?? 0,
    release(query: string) {
      for (const resolve of gates.get(query) ?? []) resolve();
      gates.delete(query);
    },
  };
}

test('a fourth search waits for a slot instead of failing', async () => {
  const context = searchFixture();
  const olx = gatedOlx(context.service);
  try {
    const queries = ['alpha one', 'bravo two', 'charlie three', 'delta four'];
    const searches = queries.map((query) => context.service.manualSearch(searchInput(query, { aiRelevance: false })));
    await flush();
    assert.deepEqual(olx.fetches, queries.slice(0, 3));
    assert.deepEqual((context.service as any).searchRuns.load, { running: 3, queued: 1 });
    olx.release('bravo two');
    await flush();
    await flush();
    assert.deepEqual(olx.fetches, [...queries.slice(0, 3), 'delta four']);
    for (const query of queries) olx.release(query);
    const results = await Promise.all(searches);
    assert.deepEqual(results.map((result) => result.listings[0]?.title), queries.map((query) => `${query} oferta`));
    assert.equal(olx.peak, 3);
    assert.deepEqual((context.service as any).searchRuns.load, { running: 0, queued: 0 });
  } finally { context.close(); }
});

test('a search still queued at its deadline gets the busy error, and frees its place', async () => {
  const context = searchFixture({ manualSearch: { deadlineMs: 40 } });
  const olx = gatedOlx(context.service);
  try {
    const running = ['one one', 'two two', 'three three'].map((query) => context.service.manualSearch(searchInput(query, { aiRelevance: false })));
    await flush();
    await assert.rejects(context.service.manualSearch(searchInput('four four', { aiRelevance: false })), (error: any) => error.status === 429 && /already running/.test(error.message));
    assert.deepEqual((context.service as any).searchRuns.load, { running: 3, queued: 0 });
    for (const query of ['one one', 'two two', 'three three']) olx.release(query);
    await Promise.allSettled(running);
    assert.equal(olx.fetches.includes('four four'), false);
  } finally { context.close(); }
});

test('identical searches share one run, and each caller sees its own progress', async () => {
  const context = searchFixture();
  const olx = gatedOlx(context.service);
  try {
    const first = context.service.manualSearch(searchInput('steam deck', { aiRelevance: false, searchId: 'first' }));
    await flush();
    // Same search spelled differently: extra spaces, defaults written out, a repeated source.
    const second = context.service.manualSearchDetailed(searchInput('  steam   deck ', { aiRelevance: false, searchId: 'second', sources: ['OLX', 'OLX'], page: 1, sort: 'relevance', ignoreBackoff: false }));
    await flush();
    assert.equal(olx.waiting('steam deck'), 1);
    olx.release('steam deck');
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(olx.fetches, ['steam deck']);
    assert.deepEqual(a.listings, b.listings);
    assert.equal(b.details.sources.get('OLX')?.returned, 1);
    const ids = context.events.filter((entry) => entry.event === 'search').map((entry) => entry.payload.searchId).sort();
    assert.deepEqual(ids, ['first', 'second']);

    // A different search is a different run.
    const other = context.service.manualSearch(searchInput('steam deck', { aiRelevance: false, minPrice: 50 }));
    await flush();
    olx.release('steam deck');
    await other;
    assert.equal(olx.fetches.length, 2);
  } finally { context.close(); }
});

test('a joiner gets the marketplaces that already finished at once', async () => {
  const context = searchFixture();
  const olx = gatedOlx(context.service);
  (context.service as any).fetchVintedApi = async () => ({ status: 200, json: structuredClone(vintedApi.search) });
  (context.service as any).fetchVintedItemPage = async () => ({ status: 403, body: '' });
  (context.service as any).fetchPublicPage = async (url: string) => { throw new Error(`unexpected public page fetch: ${url}`); };
  try {
    const first = context.service.manualSearch(searchInput('kindle', { aiRelevance: false, sources: ['OLX', 'Vinted'], searchId: 'early' }));
    // Vinted finishes; OLX is still waiting.
    const vintedDone = () => context.events.some((entry) => entry.event === 'search' && entry.payload.source === 'Vinted');
    for (let index = 0; index < 500 && !vintedDone(); index += 1) await flush();
    assert.ok(vintedDone());
    const late = context.service.manualSearch(searchInput('kindle', { aiRelevance: false, sources: ['OLX', 'Vinted'], searchId: 'late' }));
    await flush();
    const lateEvents = context.events.filter((entry) => entry.event === 'search' && entry.payload.searchId === 'late');
    assert.deepEqual(lateEvents.map((entry) => entry.payload.source), ['Vinted']);
    olx.release('kindle');
    await Promise.all([first, late]);
    assert.equal(olx.fetches.length, 1);
    assert.deepEqual(context.events.filter((entry) => entry.event === 'search' && entry.payload.searchId === 'late').map((entry) => entry.payload.source), ['Vinted', 'OLX']);
  } finally { context.close(); }
});
