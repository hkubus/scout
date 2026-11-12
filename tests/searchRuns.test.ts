import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { olxOffer, olxPage, searchFixture, searchInput } from './searchFixture';
import { searchErrorKind, toCompactSearch } from '../server/mcpFormat';

const vintedApi = JSON.parse(readFileSync(new URL('./fixtures-vinted-api.json', import.meta.url), 'utf8'));

// P0-3: manual searches queue for one of three slots instead of being
// refused, and identical searches share one run.

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Lets runs whose callers already left finish before the database closes. */
async function idle(service: unknown) {
  for (let index = 0; index < 500 && (service as any).searchRuns.load.running; index += 1) await flush();
}

function vintedFixture(service: unknown) {
  (service as any).fetchVintedApi = async () => ({ status: 200, json: structuredClone(vintedApi.search) });
  (service as any).fetchVintedItemPage = async () => ({ status: 403, body: '' });
  (service as any).fetchPublicPage = async (url: string) => { throw new Error(`unexpected public page fetch: ${url}`); };
}

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
    // Their callers wait longer than the fourth's, so their slots stay taken.
    const running = ['one one', 'two two', 'three three'].map((query) => context.service.manualSearch(searchInput(query, { aiRelevance: false, deadlineMs: 5000 })));
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
  vintedFixture(context.service);
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

test('three searches past 15 s each, then a fourth that waits for one and answers within its deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
  const context = searchFixture();
  const fetches: string[] = [];
  (context.service as any).fetchOlxApi = async (url: string) => {
    const query = String(new URL(url).searchParams.get('query'));
    fetches.push(query);
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    return olxPage([olxOffer(`ID-${query.replace(/\s+/g, '-')}`, `${query} oferta`, 100)]);
  };
  try {
    const queries = ['alpha one', 'bravo two', 'charlie three', 'delta four'];
    const searches = queries.map((query) => context.service.manualSearch(searchInput(query, { aiRelevance: false })));
    await flush();
    assert.deepEqual(fetches, queries.slice(0, 3));
    // Past the old 15 s wait cap: the fourth is still waiting, not refused.
    t.mock.timers.tick(16_000);
    await flush();
    assert.deepEqual((context.service as any).searchRuns.load, { running: 3, queued: 1 });
    // The first three finish at 20 s and the fourth starts.
    t.mock.timers.tick(4_000);
    for (let index = 0; index < 100 && fetches.length < 4; index += 1) await flush();
    assert.deepEqual(fetches, queries);
    // It finishes at 40 s, inside its 45 s deadline.
    t.mock.timers.tick(20_000);
    const results = await Promise.all(searches);
    assert.deepEqual(results.map((result) => result.sources[0].status), ['ok', 'ok', 'ok', 'ok']);
    assert.deepEqual(results.map((result) => result.listings[0]?.title), queries.map((query) => `${query} oferta`));
  } finally { context.close(); }
});

test('at the deadline a caller gets the marketplaces that finished, and a repeat joins the search still running', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context = searchFixture();
  const olx = gatedOlx(context.service);
  vintedFixture(context.service);
  try {
    const cut = context.service.manualSearchDetailed(searchInput('lego technic', { aiRelevance: false, sources: ['OLX', 'Vinted'], searchId: 'cut' }));
    const vintedDone = () => context.events.some((entry) => entry.event === 'search' && entry.payload.source === 'Vinted');
    // Vinted's own pacing waits on timers too, a few ms at a time.
    let elapsed = 0;
    for (; elapsed < 5_000 && !vintedDone(); elapsed += 10) {
      t.mock.timers.tick(10);
      await flush();
    }
    assert.ok(vintedDone());
    t.mock.timers.tick(45_000 - elapsed);
    const partial = await cut;
    assert.deepEqual(partial.sources.map((source) => [source.source, source.status]), [['OLX', 'error'], ['Vinted', 'ok']]);
    assert.match(partial.sources[0].message ?? '', /^Not finished within the 45 s deadline/);
    assert.ok(partial.listings.length > 0);
    assert.equal(partial.details.sources.get('OLX')?.errorKind, 'deadline');
    assert.equal(searchErrorKind(partial.sources[0].message), 'deadline');
    const compact = toCompactSearch({ query: 'lego technic' }, partial);
    assert.deepEqual(compact.sources.map((source) => source.errorKind), ['deadline', null]);
    // The stream tells the caller too, so the Search page stops waiting for OLX.
    const cutOlx = context.events.filter((entry) => entry.event === 'search' && entry.payload.searchId === 'cut' && entry.payload.source === 'OLX');
    assert.equal(cutOlx.length, 1);
    assert.equal(cutOlx[0].payload.status.status, 'error');

    // The search keeps running; the same call again joins it.
    const again = context.service.manualSearchDetailed(searchInput('lego technic', { aiRelevance: false, sources: ['OLX', 'Vinted'], searchId: 'again' }));
    await flush();
    olx.release('lego technic');
    const full = await again;
    assert.deepEqual(full.sources.map((source) => [source.source, source.status]), [['OLX', 'ok'], ['Vinted', 'ok']]);
    assert.equal(full.details.sources.get('OLX')?.errorKind, null);
    assert.equal(olx.fetches.length, 1);
  } finally { context.close(); }
});

test('searches whose callers all passed their deadline give their slot to a waiting search', async () => {
  const context = searchFixture({ manualSearch: { deadlineMs: 40 } });
  const olx = gatedOlx(context.service);
  try {
    const first = ['one one', 'two two', 'three three'];
    const expired = await Promise.all(first.map((query) => context.service.manualSearch(searchInput(query, { aiRelevance: false }))));
    assert.deepEqual(expired.map((result) => result.sources[0].status), ['error', 'error', 'error']);
    // Still running, for a repeat to join.
    assert.deepEqual((context.service as any).searchRuns.load, { running: 3, queued: 0 });
    const fourth = context.service.manualSearch(searchInput('four four', { aiRelevance: false, deadlineMs: 5000 }));
    await flush();
    assert.ok(olx.fetches.includes('four four'));
    assert.deepEqual((context.service as any).searchRuns.load, { running: 3, queued: 0 });
    olx.release('four four');
    assert.equal((await fourth).listings[0]?.title, 'four four oferta');
    for (const query of first) olx.release(query);
    await idle(context.service);
  } finally { context.close(); }
});

test('a search whose caller goes away stops, frees its slot and drops its waiting marketplace requests', async () => {
  const context = searchFixture();
  const service = context.service as any;
  const requested: string[] = [];
  const answers: Array<() => void> = [];
  service.requestOlxApi = async (url: string) => {
    requested.push(String(new URL(url).searchParams.get('query')));
    await new Promise<void>((resolve) => { answers.push(resolve); });
    return olxPage([]);
  };
  // Both OLX request slots are taken, so the search's request waits.
  const blockers: Array<() => void> = [];
  const blocking = [1, 2].map(() => service.marketplaceRequest('OLX', () => new Promise<void>((resolve) => { blockers.push(resolve); })));
  try {
    const gone = new AbortController();
    const search = context.service.manualSearch(searchInput('walkman', { aiRelevance: false }), undefined, { signal: gone.signal });
    await flush();
    assert.deepEqual(service.searchRuns.load, { running: 1, queued: 0 });
    gone.abort();
    await assert.rejects(search, (error: any) => error.status === 499);
    assert.deepEqual(service.searchRuns.load, { running: 0, queued: 0 });
    for (const release of blockers) release();
    await Promise.all(blocking);
    await idle(service);
    await flush();
    assert.deepEqual(requested, []);

    // With another caller still waiting, one leaving changes nothing for it.
    const leaving = new AbortController();
    const left = context.service.manualSearch(searchInput('discman', { aiRelevance: false }), undefined, { signal: leaving.signal });
    const stays = context.service.manualSearch(searchInput('discman', { aiRelevance: false }));
    await flush();
    leaving.abort();
    await assert.rejects(left, (error: any) => error.status === 499);
    for (const answer of answers) answer();
    assert.equal((await stays).sources[0].status, 'ok');
    assert.deepEqual(requested, ['discman']);
  } finally { context.close(); }
});
