import test from 'node:test';
import assert from 'node:assert/strict';
import { liveJevEnv, olxOffer, olxPage, searchFixture, searchInput } from './searchFixture';

// P0-1: the relaxed fallback, the AI opt-out covering the near-miss rescue,
// and Polish/English condition synonyms on manual search.

const relevant = async () => ({ relevant: true, p: 0.9, unsure: false });

test('falls back to most query words when no listing matches them all, and says so', async () => {
  const restore = liveJevEnv();
  const termCalls: string[] = [];
  const context = searchFixture({
    classifyListingRelevanceWithJev: relevant,
    classifyTermMatchWithJev: async (input: any) => { termCalls.push(input.title); return { decision: 'reject', confidence: 0.9, unsure: false }; },
    classifyConditionMatchWithJev: async () => { throw new Error('no condition filter'); },
  });
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([
      olxOffer('R-1', 'iPhone 13 Pro Max 256 GB', 3000),
      olxOffer('R-2', 'Etui iPhone 13', 40),
      olxOffer('R-3', 'Samsung Galaxy S21', 1200),
    ]);
    const result = await context.service.manualSearchDetailed(searchInput('iphone 13 pro max 512gb czarny'));
    assert.deepEqual(result.listings.map((listing) => listing.title), ['iPhone 13 Pro Max 256 GB']);
    assert.match(result.sources[0].message, /1 matches · matched most query words/);
    assert.equal(result.details.listings.get('OLX:R-1')?.match, 'relaxed');
    // The relaxed row was already kept, so the rescue never asked Jev about it.
    assert.equal(termCalls.includes('iPhone 13 Pro Max 256 GB'), false);
  } finally {
    restore();
    context.close();
  }
});

test('returns only strict matches when some listing has every query word', async () => {
  const context = searchFixture();
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([
      olxOffer('S-1', 'iPhone 13 Pro 128GB', 2000),
      olxOffer('S-2', 'iPhone 13 mini', 1500),
    ]);
    const result = await context.service.manualSearch(searchInput('iphone 13 pro'));
    assert.deepEqual(result.listings.map((listing) => listing.title), ['iPhone 13 Pro 128GB']);
    assert.doesNotMatch(result.sources[0].message, /most query words/);
  } finally { context.close(); }
});

test('never relaxes typed included terms', async () => {
  const context = searchFixture();
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([olxOffer('T-1', 'iPhone 13 Pro 128GB', 2000)]);
    const result = await context.service.manualSearch(searchInput('iphone', { terms: '13, pro, max' }));
    assert.equal(result.listings.length, 0);
    assert.equal(result.sources[0].message, 'No matching listings');
  } finally { context.close(); }
});

test('aiRelevance false skips the near-miss rescue as well as the relevance check', async () => {
  const restore = liveJevEnv();
  const calls = { term: 0, condition: 0, relevance: 0 };
  const context = searchFixture({
    classifyListingRelevanceWithJev: async () => { calls.relevance += 1; return { relevant: true, p: 0.9, unsure: false }; },
    classifyTermMatchWithJev: async () => { calls.term += 1; return { decision: 'pass', confidence: 0.9, unsure: false }; },
    classifyConditionMatchWithJev: async () => { calls.condition += 1; return { decision: 'match', confidence: 0.9, unsure: false }; },
  });
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([
      olxOffer('O-1', 'Ladowarka Dell 65W', 100, 'Nowe'),
      olxOffer('O-2', 'Ladowarki do laptopa Dell', 120, 'Nowe'),
      olxOffer('O-3', 'Ladowarka HP 90W', 90),
    ]);
    const off = await context.service.manualSearch(searchInput('ladowarka', { condition: 'New', aiRelevance: false }));
    assert.deepEqual(calls, { term: 0, condition: 0, relevance: 0 });
    assert.deepEqual(off.listings.map((listing) => listing.title), ['Ladowarka Dell 65W']);
    const on = await context.service.manualSearch(searchInput('ladowarka', { condition: 'New' }));
    assert.ok(calls.term + calls.condition >= 1);
    assert.ok(on.listings.length > off.listings.length);
  } finally {
    restore();
    context.close();
  }
});

test('a watch with AI relevance off makes no rescue calls', async () => {
  const restore = liveJevEnv();
  let rescueCalls = 0;
  const context = searchFixture({
    classifyListingRelevanceWithJev: relevant,
    classifyTermMatchWithJev: async () => { rescueCalls += 1; return { decision: 'pass', confidence: 0.9, unsure: false }; },
    classifyConditionMatchWithJev: async () => { rescueCalls += 1; return { decision: 'match', confidence: 0.9, unsure: false }; },
  });
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([
      olxOffer('W-1', 'Ladowarka Dell 65W', 100),
      olxOffer('W-2', 'Ladowarki do laptopa Dell', 120),
    ]);
    const now = new Date().toISOString();
    // A target price over every row makes each one strong enough for the rescue gate.
    const insert = context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at, ai_relevance, target_price_pln)
      VALUES (?, ?, 'ladowarka', '["OLX"]', 1, ?, ?, ?, ?, 1000)`);
    insert.run('rescue-off', 'Rescue off', now, now, now, 0);
    insert.run('rescue-on', 'Rescue on', now, now, now, 1);
    const run = (id: string) => (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get(id), { forceAll: true });
    await run('rescue-off');
    assert.equal(rescueCalls, 0);
    await run('rescue-on');
    assert.ok(rescueCalls >= 1);
  } finally {
    restore();
    context.close();
  }
});

test('reads Polish conditions: używany keeps used, drops damaged, and narrows the OLX query', async () => {
  const restore = liveJevEnv();
  const urls: string[] = [];
  const conditionCalls: string[] = [];
  const context = searchFixture({
    classifyListingRelevanceWithJev: relevant,
    classifyConditionMatchWithJev: async (input: any) => { conditionCalls.push(input.title); return { decision: 'mismatch', confidence: 0.9, unsure: false }; },
  });
  try {
    (context.service as any).fetchOlxApi = async (url: string) => {
      urls.push(url);
      return olxPage([
        olxOffer('C-1', 'iPhone 13 używany', 1800, 'Używane'),
        olxOffer('C-2', 'iPhone 13 zbita szybka', 600, 'Uszkodzone'),
        olxOffer('C-3', 'iPhone 13 nowy', 2600, 'Nowe'),
      ]);
    };
    const used = await context.service.manualSearch(searchInput('iphone 13', { condition: 'używany' }));
    assert.deepEqual(used.listings.map((listing) => listing.title), ['iPhone 13 używany']);
    assert.match(urls[0], /filter_enum_state%5B0%5D=used/);
    // The damaged row is a hard drop, never a condition rescue candidate.
    assert.equal(conditionCalls.includes('iPhone 13 zbita szybka'), false);

    const fresh = await context.service.manualSearch(searchInput('iphone 13', { condition: 'nowy' }));
    assert.deepEqual(fresh.listings.map((listing) => listing.title), ['iPhone 13 nowy']);
    assert.match(urls[1], /filter_enum_state%5B0%5D=new/);

    const damaged = await context.service.manualSearch(searchInput('iphone 13', { condition: 'uszkodzony', aiRelevance: false }));
    assert.deepEqual(damaged.listings.map((listing) => listing.title), ['iPhone 13 zbita szybka']);
    assert.doesNotMatch(urls[2], /filter_enum_state/);
  } finally {
    restore();
    context.close();
  }
});

test('an unrecognised condition searches any condition and says so', async () => {
  const context = searchFixture();
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([
      olxOffer('M-1', 'iPhone 13 używany', 1800, 'Używane'),
      olxOffer('M-2', 'iPhone 13 zbita szybka', 600, 'Uszkodzone'),
    ]);
    const result = await context.service.manualSearch(searchInput('iphone 13', { condition: 'mint' }));
    assert.equal(result.listings.length, 2);
    assert.match(result.sources[0].message, /2 matches · condition "mint" not recognised, showing any condition$/);
  } finally { context.close(); }
});

test('a used watch still keeps damaged listings; excluding them is manual-search only', async () => {
  const context = searchFixture();
  try {
    (context.service as any).fetchOlxApi = async () => olxPage([
      olxOffer('U-1', 'Ladowarka Dell', 100, 'Używane'),
      olxOffer('U-2', 'Ladowarka Dell uszkodzona', 20, 'Uszkodzone'),
    ]);
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at, condition)
      VALUES ('used-watch', 'Used watch', 'ladowarka', '["OLX"]', 1, ?, ?, ?, 'Used')`).run(now, now, now);
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('used-watch'), { forceAll: true });
    const stored = context.db.prepare("SELECT l.listing_id FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE wl.watch_id = 'used-watch' ORDER BY l.listing_id").all() as Array<{ listing_id: string }>;
    assert.deepEqual(stored.map((row) => row.listing_id), ['U-1', 'U-2']);
  } finally { context.close(); }
});
