import test from 'node:test';
import assert from 'node:assert/strict';
import { toCompactSearch } from '../server/mcpFormat';
import { filterTypoRows, rewriteTypoTerms } from '../server/service';
import { liveJevEnv, olxOffer, olxPage, searchFixture, searchInput } from './searchFixture';

// P1-1: rows a typo-variant page returns are held to the misspelling that
// found them, not dropped by a plain substring match on the original query.

const titleCase = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

test('rewrites the corrected word inside typed terms only', () => {
  const variant = { query: 'iphon 13', from: 'iphone', to: 'iphon' };
  assert.equal(rewriteTypoTerms('iPhone 13, 128gb', variant), 'iphon 13, 128gb');
  assert.equal(rewriteTypoTerms('iphones', variant), 'iphones');
  assert.equal(rewriteTypoTerms('', variant), '');
});

test('keeps a typo row by its own spelling and every other row by the original query', () => {
  const row = (id: string, title: string) => ({ marketplace: 'OLX', listingId: id, title, price: 100, url: `https://olx.pl/${id}`, condition: '' }) as any;
  const variant = { query: 'iphon 13', from: 'iphone', to: 'iphon' };
  const main = [row('1', 'iPhone 13'), row('2', 'Iphon 13 mini')];
  const typo = [row('3', 'Iphon 13 128GB'), row('4', 'Etui Samsung'), row('5', 'iPhone 13 Pro')];
  const variantOf = (listing: { listingId: string }) => (['3', '4', '5'].includes(listing.listingId) ? variant : undefined);
  const kept = filterTypoRows([...main, ...typo], variantOf, 'iphone 13', '', '', {});
  // A main-page row is never judged by a misspelling it was not found by.
  assert.deepEqual(kept.map((listing) => listing.listingId), ['1', '3', '5']);
  assert.deepEqual(filterTypoRows(typo, variantOf, 'iphone 13', 'iphone, 13', 'mini', {}).map((listing) => listing.listingId), ['3', '5']);
  assert.deepEqual(filterTypoRows(typo, variantOf, 'iphone 13', '', '128gb', {}).map((listing) => listing.listingId), ['5']);
});

test('a typo-variant watch stores the misspelled listing a variant page found', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = async (url: string) => {
    const query = String(new URL(url).searchParams.get('query'));
    queries.push(query);
    if (query === 'iphone 13') return olxPage([olxOffer('MAIN-1', 'iPhone 13 128GB', 2000)]);
    return olxPage([
      olxOffer(`TYPO-${query.replace(/\s+/g, '-')}`, `${titleCase(query)} 128GB`, 1500),
      olxOffer(`OTHER-${query.replace(/\s+/g, '-')}`, 'Etui Samsung Galaxy', 20),
      olxOffer('MAIN-1', 'iPhone 13 128GB', 2000),
    ]);
  };
  try {
    const now = new Date().toISOString();
    const insert = context.db.prepare(`INSERT INTO watches (id, name, query, included_terms, sources_json, enabled, next_scan_at, created_at, updated_at, ai_relevance, typo_variants)
      VALUES (?, ?, 'iphone 13', ?, '["OLX"]', 1, ?, ?, ?, 0, 1)`);
    insert.run('typo-query', 'Typo query', '', now, now, now);
    insert.run('typo-terms', 'Typo terms', 'iphone, 13', now, now, now);
    const stored = async (id: string) => {
      await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get(id), { forceAll: true });
      return (context.db.prepare('SELECT l.title FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE wl.watch_id = ? ORDER BY l.title').all(id) as Array<{ title: string }>).map((entry) => entry.title);
    };
    for (const id of ['typo-query', 'typo-terms']) {
      const before = queries.length;
      const titles = await stored(id);
      const variants = queries.slice(before).filter((query) => query !== 'iphone 13');
      assert.equal(variants.length, 2, id);
      assert.deepEqual(titles, ['iPhone 13 128GB', ...variants.map((query) => `${titleCase(query)} 128GB`)].sort(), id);
    }
  } finally { context.close(); }
});

// Manual search with typoVariants.

function typoStub(pages: Record<string, unknown[] | Error>, queries: string[]) {
  return async (url: string) => {
    const query = String(new URL(url).searchParams.get('query'));
    queries.push(query);
    const page = pages[query] ?? [];
    if (page instanceof Error) throw page;
    return olxPage(page);
  };
}

const iphonePages = () => ({
  'iphone 13': [olxOffer('A-1', 'iPhone 13 128GB', 2000)],
  'iphon 13': [olxOffer('A-1', 'iPhone 13 128GB', 2000), olxOffer('B-1', 'Iphon 13 128GB 100% Baterii', 800), olxOffer('B-2', 'Etui Samsung', 20)],
});

test('typoVariants finds the misspelled listing and says which spelling did', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = typoStub(iphonePages(), queries);
  try {
    const result = await context.service.manualSearchDetailed(searchInput('iphone 13', { typoVariants: true, aiRelevance: false }));
    assert.deepEqual(queries, ['iphone 13', 'iphon 13', 'iphoen 13']);
    assert.deepEqual(result.typoVariants, ['iphon 13', 'iphoen 13']);
    assert.deepEqual(result.listings.map((listing) => [listing.title, listing.matchedVia]), [
      ['Iphon 13 128GB 100% Baterii', 'typo:iphon 13'],
      ['iPhone 13 128GB', 'query'],
    ]);
    const [source] = result.sources;
    assert.equal(source.status, 'ok');
    assert.equal(source.message, '2 matches · 1 via typo variants');
    assert.deepEqual(source.variants, [
      { query: 'iphon 13', status: 'ok', fetched: 3, matched: 1 },
      { query: 'iphoen 13', status: 'ok', fetched: 0, matched: 0 },
    ]);
    assert.deepEqual(result.details.listings.get('OLX:B-1'), { listingId: 'B-1', relevance: 'not-checked', match: 'strict', matchedVia: 'typo:iphon 13', flags: [] });
    assert.equal(result.details.sources.get('OLX')?.fetched, 3);

    const compact = toCompactSearch({ query: 'iphone 13' }, result);
    assert.deepEqual(compact.typoVariants, ['iphon 13', 'iphoen 13']);
    assert.deepEqual(compact.sources[0].variants?.[0], { query: 'iphon 13', status: 'ok', fetched: 3, matched: 1, message: null });
    assert.equal(compact.listings[0].matchedVia, 'typo:iphon 13');
  } finally { context.close(); }
});

test('without typoVariants the search and its response are unchanged', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = typoStub(iphonePages(), queries);
  try {
    const result = await context.service.manualSearch(searchInput('iphone 13', { aiRelevance: false }));
    assert.deepEqual(queries, ['iphone 13']);
    assert.deepEqual(Object.keys(result), ['listings', 'sources']);
    assert.deepEqual(Object.keys(result.sources[0]), ['source', 'status', 'count', 'pendingShipping', 'durationMs', 'message']);
    assert.equal('matchedVia' in result.listings[0], false);
    const compact = toCompactSearch({ query: 'iphone 13' }, await context.service.manualSearchDetailed(searchInput('iphone 13', { aiRelevance: false })));
    assert.equal(compact.typoVariants, null);
    assert.equal(compact.sources[0].variants, null);
  } finally { context.close(); }
});

test('typoVariants searches page 1 only, and nothing when no word qualifies', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = typoStub(iphonePages(), queries);
  try {
    const second = await context.service.manualSearch(searchInput('iphone 13', { typoVariants: true, aiRelevance: false, page: 2 }));
    assert.deepEqual(queries, ['iphone 13']);
    assert.deepEqual(second.typoVariants, []);
    assert.deepEqual(second.sources[0].variants, []);
    const digits = await context.service.manualSearch(searchInput('rtx 4070', { typoVariants: true, aiRelevance: false }));
    assert.deepEqual(queries, ['iphone 13', 'rtx 4070']);
    assert.deepEqual(digits.typoVariants, []);
  } finally { context.close(); }
});

test('a failing misspelled search never fails the marketplace, and a failing main page asks for none', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = typoStub({ ...iphonePages(), 'iphoen 13': new Error('OLX API returned HTTP 503') }, queries);
  try {
    const result = await context.service.manualSearch(searchInput('iphone 13', { typoVariants: true, aiRelevance: false }));
    const [source] = result.sources;
    assert.equal(source.status, 'ok');
    assert.equal(result.listings.length, 2);
    assert.equal(source.variants?.[1].status, 'error');
    assert.match(String(source.variants?.[1].message), /HTTP 503/);

    queries.length = 0;
    (context.service as any).fetchOlxApi = typoStub({ 'iphone 13': new Error('OLX API returned HTTP 403') }, queries);
    const blocked = await context.service.manualSearch(searchInput('iphone 13', { typoVariants: true, aiRelevance: false }));
    assert.equal(blocked.sources[0].status, 'error');
    assert.equal(blocked.sources[0].variants, undefined);
    assert.deepEqual(queries, ['iphone 13']);
  } finally { context.close(); }
});

test('typed terms hold a typo row to its own spelling', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = typoStub(iphonePages(), queries);
  try {
    const result = await context.service.manualSearch(searchInput('iphone 13', { terms: 'iphone', typoVariants: true, aiRelevance: false }));
    assert.deepEqual(result.listings.map((listing) => listing.listingId ?? listing.id).sort(), ['OLX:A-1', 'OLX:B-1']);
    const excluded = await context.service.manualSearch(searchInput('iphone 13', { excluded: 'baterii', typoVariants: true, aiRelevance: false }));
    assert.deepEqual(excluded.listings.map((listing) => listing.id), ['OLX:A-1']);
  } finally { context.close(); }
});

test('typo rows past the AI budget come back unjudged, never relevant', async () => {
  const restore = liveJevEnv();
  let calls = 0;
  const context = searchFixture({
    classifyListingRelevanceWithJev: async () => { calls += 1; return { relevant: true, p: 0.9, unsure: false } as any; },
  });
  const queries: string[] = [];
  const main = Array.from({ length: 40 }, (_, index) => olxOffer(`M-${index}`, `iPhone 13 nr ${index}`, 1000 + index));
  (context.service as any).fetchOlxApi = typoStub({ 'iphone 13': main, 'iphon 13': [olxOffer('T-1', 'Iphon 13 tanio', 500)] }, queries);
  try {
    const result = await context.service.manualSearchDetailed(searchInput('iphone 13', { typoVariants: true }));
    assert.equal(calls, 40);
    const typo = result.details.listings.get('OLX:T-1');
    assert.equal(typo?.matchedVia, 'typo:iphon 13');
    assert.equal(typo?.relevance, 'unknown');
    assert.equal(result.details.sources.get('OLX')?.aiBudgetExhausted, 1);
    assert.equal(result.details.listings.get('OLX:M-0')?.relevance, 'relevant');
  } finally {
    restore();
    context.close();
  }
});

// Research watches: a version saved before the rewrite keeps its spellings
// and filter; one saved since uses the current ones.

test('a research version keeps the typo spellings it was saved with', async () => {
  const context = searchFixture();
  const queries: string[] = [];
  (context.service as any).fetchOlxApi = async (url: string) => {
    const query = String(new URL(url).searchParams.get('query'));
    queries.push(query);
    if (query === 'iphone 13') return olxPage([olxOffer('R-MAIN', 'iPhone 13 128GB', 2000)]);
    return olxPage([olxOffer(`R-${query.replace(/\s+/g, '-')}`, `${titleCase(query)} 128GB`, 1500)]);
  };
  const scan = async (id: string) => {
    queries.length = 0;
    await (context.service as any).runMarketWatch(context.db.prepare('SELECT * FROM market_watches WHERE id = ?').get(id));
    const titles = (context.db.prepare('SELECT title FROM market_listings WHERE market_watch_id = ? ORDER BY title').all(id) as Array<{ title: string }>).map((row) => row.title);
    return { titles, variants: queries.filter((query) => query !== 'iphone 13') };
  };
  try {
    for (const id of ['legacy-series', 'current-series']) {
      context.service.createMarketWatch({ id, name: id, query: 'iphone 13', terms: '', excluded: '', condition: 'Any', sources: ['OLX'], intervalHours: 24, minPrice: null, maxPrice: null, shippingOnly: false, typoVariants: true });
    }
    context.db.prepare("UPDATE market_watch_versions SET typo_variants = 1 WHERE market_watch_id = 'legacy-series'").run();

    const legacy = await scan('legacy-series');
    assert.equal(legacy.variants.length, 2);
    for (const variant of legacy.variants) assert.ok(['pihone 13', 'ihpone 13', 'ipohne 13'].includes(variant), variant);
    // As before: a typo-only row is held to the original query, so none is kept.
    assert.deepEqual(legacy.titles, ['iPhone 13 128GB']);
    // Saving the same setting again leaves the version alone.
    context.service.updateMarketWatch('legacy-series', { name: 'Legacy renamed', typoVariants: true });
    assert.equal((context.db.prepare("SELECT COUNT(*) AS count FROM market_watch_versions WHERE market_watch_id = 'legacy-series'").get() as { count: number }).count, 1);

    const current = await scan('current-series');
    assert.equal(current.variants.length, 2);
    for (const variant of current.variants) assert.ok(['iphon 13', 'iphoen 13', 'iphnoe 13'].includes(variant), variant);
    assert.deepEqual(current.titles, ['iPhone 13 128GB', ...current.variants.map((query) => `${titleCase(query)} 128GB`)].sort());
  } finally { context.close(); }
});
