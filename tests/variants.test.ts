import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService } from '../server/service';
import { OTHER_VARIANT_KEY, assignVariant, finalizeVariantSuggestions, parseVariantGroups, suggestVariantGroupsFromTitles, variantLabelFor } from '../server/variants';

const gtxGroups = [
  { id: 'gtx-1660', label: 'GTX 1660', terms: '1660' },
  { id: 'gtx-1660-super', label: 'GTX 1660 Super', terms: '1660 super' },
  { id: 'gtx-1660-ti', label: 'GTX 1660 Ti', terms: '1660 ti' },
];

test('assigns the most specific model regardless of declared order', () => {
  assert.equal(assignVariant('Karta graficzna GTX 1660 Super 6GB', gtxGroups), 'gtx-1660-super');
  assert.equal(assignVariant('GeForce GTX 1660 Ti OC 6GB', gtxGroups), 'gtx-1660-ti');
  assert.equal(assignVariant('GTX 1660 6GB sprawna', gtxGroups), 'gtx-1660');
  assert.equal(assignVariant('RTX 3060 12GB', gtxGroups), OTHER_VARIANT_KEY);
  assert.equal(assignVariant('GTX 1660', []), OTHER_VARIANT_KEY);
});

test('normalizes case, punctuation, and diacritics before matching', () => {
  assert.equal(assignVariant('GEFORCE gtx-1660-super, 6 GB!!!', gtxGroups), 'gtx-1660-super');
  assert.equal(assignVariant('Karta graficzna 1660 TI', gtxGroups), 'gtx-1660-ti');
  const polish = [{ id: 'lodowka', label: 'Lodówka', terms: 'lodówka' }];
  assert.equal(assignVariant('LODOWKA Samsung', polish), 'lodowka');
});

test('multiple required terms must all be present and exclude terms veto a match', () => {
  const groups = [{ id: 'ti', label: 'Ti', terms: '1660, ti' }];
  assert.equal(assignVariant('GTX 1660 Ti', groups), 'ti');
  assert.equal(assignVariant('GTX 1660', groups), OTHER_VARIANT_KEY);
  const vetoed = [{ id: 'base', label: '1660', terms: '1660', exclude: 'super, ti' }];
  assert.equal(assignVariant('GTX 1660 Super', vetoed), OTHER_VARIANT_KEY);
  assert.equal(assignVariant('GTX 1660', vetoed), 'base');
});

test('ties fall back to declared order', () => {
  const groups = [
    { id: 'first', label: 'First', terms: 'ti' },
    { id: 'second', label: 'Second', terms: 'super' },
  ];
  assert.equal(assignVariant('1660 super ti', groups), 'first');
});

test('parseVariantGroups drops invalid entries, dedupes ids, generates ids, and caps the list', () => {
  const parsed = parseVariantGroups(JSON.stringify([
    { label: 'GTX 1660 Super', terms: '1660 super' },
    { id: 'gtx-1660-ti', label: 'GTX 1660 Ti', terms: '1660 ti', exclude: 'broken' },
    { id: 'gtx-1660-ti', label: 'Duplicate', terms: 'nope' },
    { id: 'bad', label: '', terms: 'x' },
    { id: 'bad2', label: 'No terms', terms: '' },
    'not-an-object',
  ]));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].id, 'gtx-1660-super');
  assert.equal(parsed[1].id, 'gtx-1660-ti');
  assert.equal(parsed[1].exclude, 'broken');
  assert.equal(parseVariantGroups(null).length, 0);
  assert.equal(parseVariantGroups('{not json').length, 0);
  const many = parseVariantGroups(Array.from({ length: 30 }, (_, index) => ({ id: `v${index}`, label: `V${index}`, terms: `term ${index}` })));
  assert.equal(many.length, 12);
});

test('variantLabelFor explains the unclassified bucket', () => {
  assert.equal(variantLabelFor('gtx-1660-ti', gtxGroups), 'GTX 1660 Ti');
  assert.equal(variantLabelFor(OTHER_VARIANT_KEY, gtxGroups), 'Other / unclassified');
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-variants-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {});
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('re-tags saved listings and reports a separate baseline and progress per model', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, variant_groups_json, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('w1', 'GTX 1660', 'gtx 1660', '["OLX"]', JSON.stringify(gtxGroups), now, now, now);
    const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertAssociation = context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, watch_listing_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)');
    const rows = [
      { title: 'Karta graficzna GTX 1660 Super 6GB', price: 820 },
      { title: 'GeForce GTX 1660 Ti OC 6GB', price: 960 },
      { title: 'GTX 1660 6GB sprawna', price: 600 },
      { title: 'RTX 3060 12GB', price: 1100 },
    ];
    rows.forEach((row, index) => {
      const listing = insertListing.run('OLX', `listing-${index}`, row.title, row.price, `https://www.olx.pl/d/oferta/${index}`, now, now);
      const listingId = Number(listing.lastInsertRowid);
      const association = insertAssociation.run('w1', listingId, now, now);
      insertObservation.run(listingId, 'w1', Number(association.lastInsertRowid), row.price, now);
    });

    context.service.retagWatchVariants('w1');
    const assignments = context.db.prepare('SELECT l.listing_id AS listing_id, wl.variant_key AS variant_key FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id ORDER BY l.listing_id').all() as Array<{ listing_id: string; variant_key: string | null }>;
    assert.deepEqual(assignments.map((row) => row.variant_key), ['gtx-1660-super', 'gtx-1660-ti', 'gtx-1660', OTHER_VARIANT_KEY]);

    // Per-model typicals are written independently; the blended watch median
    // (820/960/600/1100 -> 890) would mislabel every model.
    const setTypical = context.db.prepare('UPDATE watch_listings SET typical_pln = ?, typical_source = ? WHERE variant_key = ?');
    setTypical.run(820, 'own-history', 'gtx-1660-super');
    setTypical.run(960, 'own-history', 'gtx-1660-ti');
    setTypical.run(600, 'own-history', 'gtx-1660');
    setTypical.run(1100, 'own-history', OTHER_VARIANT_KEY);

    const watch = context.service.getWatches().find((item) => item.id === 'w1')!;
    const byKey = new Map(watch.variants.map((variant) => [variant.key, variant]));
    assert.equal(byKey.get('gtx-1660-super')?.label, 'GTX 1660 Super');
    assert.equal(byKey.get('gtx-1660-super')?.samples, 1);
    assert.equal(byKey.get('gtx-1660-super')?.typical, 820);
    assert.equal(byKey.get('gtx-1660-ti')?.typical, 960);
    assert.equal(byKey.get('gtx-1660')?.typical, 600);
    assert.equal(byKey.get(OTHER_VARIANT_KEY)?.label, 'Other / unclassified');
    assert.equal(byKey.get(OTHER_VARIANT_KEY)?.typical, 1100);
    assert.equal(watch.samples, 4);

    const listings = context.service.getListings();
    const labels = new Map(listings.map((listing) => [listing.title, listing.variantLabel]));
    assert.equal(labels.get('GTX 1660 6GB sprawna'), 'GTX 1660');
    assert.equal(labels.get('RTX 3060 12GB'), 'Other / unclassified');
  } finally { context.close(); }
});

test('clearing groups re-tags every association back to the watch-wide baseline', () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, variant_groups_json, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('w2', 'GTX 1660', 'gtx 1660', '["OLX"]', JSON.stringify(gtxGroups), now, now, now);
    const listing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('OLX', 'l-one', 'GTX 1660 Ti', 900, 'https://www.olx.pl/d/oferta/1', now, now);
    context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)').run('w2', Number(listing.lastInsertRowid), now, now);
    context.service.retagWatchVariants('w2');
    assert.equal((context.db.prepare('SELECT variant_key FROM watch_listings WHERE watch_id = ?').get('w2') as any).variant_key, 'gtx-1660-ti');
    context.db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run('[]', 'w2');
    context.service.retagWatchVariants('w2');
    assert.equal((context.db.prepare('SELECT variant_key FROM watch_listings WHERE watch_id = ?').get('w2') as any).variant_key, null);
    assert.deepEqual(context.service.getWatches().find((item) => item.id === 'w2')?.variants, []);
  } finally { context.close(); }
});


test('scores a new listing against its own model baseline during a scan', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  try {
    const now = new Date().toISOString();
    const baselineAt = new Date(Date.now() - 8 * 3_600_000).toISOString();
    context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, variant_groups_json, ai_relevance, enabled, next_scan_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`).run('variant-scan', 'GTX 1660', 'gtx 1660', '["OLX"]', JSON.stringify(gtxGroups), now, now, now);
    const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insertAssociation = context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)');
    const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, watch_listing_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)');
    for (let index = 0; index < 30; index += 1) {
      const superListing = insertListing.run('OLX', `seed-super-${index}`, `GTX 1660 Super ${index}`, 1000, `https://www.olx.pl/d/oferta/seed-super-${index}`, baselineAt, baselineAt);
      const superId = Number(superListing.lastInsertRowid);
      const superAssociation = insertAssociation.run('variant-scan', superId, baselineAt, baselineAt);
      insertObservation.run(superId, 'variant-scan', Number(superAssociation.lastInsertRowid), 1000, baselineAt);

      const baseListing = insertListing.run('OLX', `seed-base-${index}`, `GTX 1660 ${index}`, 600, `https://www.olx.pl/d/oferta/seed-base-${index}`, baselineAt, baselineAt);
      const baseId = Number(baseListing.lastInsertRowid);
      const baseAssociation = insertAssociation.run('variant-scan', baseId, baselineAt, baselineAt);
      insertObservation.run(baseId, 'variant-scan', Number(baseAssociation.lastInsertRowid), 600, baselineAt);
    }
    context.service.retagWatchVariants('variant-scan');

    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [
      { id: 'new-super', url: 'https://www.olx.pl/d/oferta/new-super', title: 'GTX 1660 Super 6GB', created_time: now, params: [{ key: 'price', value: { value: 820, currency: 'PLN', negotiable: false } }] },
    ], metadata: { visible_total_count: 1 } } });

    const row = context.db.prepare('SELECT * FROM watches WHERE id = ?').get('variant-scan');
    await (context.service as any).runWatch(row);

    const stored = context.db.prepare(`SELECT wl.variant_key AS variant_key, wl.typical_pln AS typical_pln, wl.deal_strength AS deal_strength
      FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id = ?`).get('new-super') as { variant_key: string; typical_pln: number; deal_strength: number };
    // 820 zł is 18% (180 zł) below the 1660 Super baseline (1000) but above the
    // blended watch median (800), so grouping is what makes this a Very strong deal.
    assert.equal(stored.variant_key, 'gtx-1660-super');
    assert.equal(stored.typical_pln, 1000);
    assert.equal(stored.deal_strength, 4);

    const watch = context.service.getWatches().find((item) => item.id === 'variant-scan')!;
    assert.equal(watch.variants.find((variant) => variant.key === 'gtx-1660-super')?.samples, 31);
    assert.equal(watch.variants.find((variant) => variant.key === 'gtx-1660')?.samples, 30);
    assert.equal(watch.variants.find((variant) => variant.key === 'gtx-1660-super')?.typical, 1000);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});

function gpuSamples() {
  const samples: Array<{ title: string; price: number }> = [];
  for (let index = 0; index < 12; index += 1) samples.push({ title: `Karta graficzna GTX 1660 Super 6GB stan idealny ${index}`, price: 780 + index * 5 });
  for (let index = 0; index < 10; index += 1) samples.push({ title: `MSI GeForce GTX 1660 Ti Gaming X ${index}`, price: 920 + index * 5 });
  for (let index = 0; index < 14; index += 1) samples.push({ title: `GTX 1660 6GB sprzedam ${index}`, price: 560 + index * 5 });
  return samples;
}

test('title analysis proposes the model suffixes that are priced apart, plus the plain model', () => {
  const samples = gpuSamples();
  const candidates = suggestVariantGroupsFromTitles(samples, { query: 'GTX 1660' });
  const groups = finalizeVariantSuggestions(candidates, samples);
  assert.deepEqual(groups.map((group) => group.terms).sort(), ['1660', '1660 super', '1660 ti']);
  assert.deepEqual(groups.map((group) => group.label).sort(), ['GTX 1660', 'GTX 1660 Super', 'GTX 1660 Ti']);
  assert.equal(assignVariant('GTX 1660 Super OC', groups), groups.find((group) => group.terms === '1660 super')!.id);
  assert.equal(assignVariant('GTX 1660 6GB', groups), groups.find((group) => group.terms === '1660')!.id);
});

test('title analysis ignores filler words and finds nothing in a single-product watch', () => {
  const samples = Array.from({ length: 40 }, (_, index) => ({
    title: index % 2 ? `LEGO 10316 Rivendell nowy ${index}` : `LEGO 10316 Rivendell zestaw komplet ${index}`,
    price: 1800 + (index % 7) * 20,
  }));
  const candidates = suggestVariantGroupsFromTitles(samples, { query: 'lego 10316 rivendell' });
  assert.deepEqual(finalizeVariantSuggestions(candidates, samples), []);
});

test('title analysis keeps a two-word refinement only when it is priced apart from its prefix', () => {
  const samples: Array<{ title: string; price: number }> = [];
  for (let index = 0; index < 10; index += 1) samples.push({ title: `iPhone 13 128GB ${index}`, price: 1700 + index * 10 });
  for (let index = 0; index < 10; index += 1) samples.push({ title: `iPhone 13 Pro 128GB ${index}`, price: 2400 + index * 10 });
  for (let index = 0; index < 10; index += 1) samples.push({ title: `iPhone 13 Pro Max 256GB ${index}`, price: 3000 + index * 10 });
  const groups = finalizeVariantSuggestions(suggestVariantGroupsFromTitles(samples, { query: 'iPhone 13' }), samples);
  const byTerms = new Map(groups.map((group) => [group.terms, group]));
  assert.ok(byTerms.has('13 pro'));
  assert.ok(byTerms.has('13 pro max'));
  assert.equal(assignVariant('iPhone 13 Pro Max 512GB', groups), byTerms.get('13 pro max')!.id);
  assert.equal(assignVariant('iPhone 13 Pro 256GB', groups), byTerms.get('13 pro')!.id);
});

test('finalizing drops groups too few titles support, keeps existing ids, and rejects a non-split', () => {
  const samples = gpuSamples();
  const existing = [{ id: 'my-super', label: 'Super (mine)', terms: '1660 super' }];
  const groups = finalizeVariantSuggestions([
    { label: 'GTX 1660 Super', terms: '1660 Super' },
    { label: 'GTX 1660 Ti', terms: '1660 ti' },
    { label: 'RTX 3060', terms: '3060' },
  ], samples, existing);
  assert.deepEqual(groups.map((group) => group.id), ['my-super', 'gtx-1660-ti']);
  assert.equal(groups[0].label, 'GTX 1660 Super');
  // One group that swallows every title is not a split.
  assert.deepEqual(finalizeVariantSuggestions([{ label: 'GTX 1660', terms: '1660' }], samples), []);
});

function seedAutoWatch(context: ReturnType<typeof fixture>, id: string, samples: Array<{ title: string; price: number }>, overrides: { auto?: number; groups?: string } = {}) {
  const now = new Date().toISOString();
  context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, variant_groups_json, variant_groups_auto, ai_relevance, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)`).run(id, 'GTX 1660', 'gtx 1660', '["OLX"]', overrides.groups ?? '[]', overrides.auto ?? 1, now, now, now);
  const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertAssociation = context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)');
  samples.forEach((sample, index) => {
    const listing = insertListing.run('OLX', `${id}-${index}`, sample.title, sample.price, `https://www.olx.pl/d/oferta/${id}-${index}`, now, now);
    insertAssociation.run(id, Number(listing.lastInsertRowid), now, now);
  });
}

test('a pending watch gets groups generated from its listings after a scan, then keeps them', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
  const previousKey = process.env.SCOUT_OPENROUTER_API_KEY;
  delete process.env.SCOUT_OPENROUTER_API_KEY;
  try {
    seedAutoWatch(context, 'auto', gpuSamples());
    assert.equal(context.service.getWatches()[0].variantGroupsAuto, true);
    (context.service as any).fetchOlxApi = async () => ({ status: 200, json: { data: [], metadata: { visible_total_count: 0 } } });
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('auto'));

    const watch = context.service.getWatches()[0];
    assert.equal(watch.variantGroupsAuto, false);
    assert.deepEqual(watch.variantGroups.map((group) => group.terms).sort(), ['1660', '1660 super', '1660 ti']);
    const keys = context.db.prepare("SELECT COUNT(*) AS count FROM watch_listings WHERE watch_id = 'auto' AND variant_key IS NOT NULL").get() as { count: number };
    assert.equal(keys.count, 36);

    // Once generated, later scans leave the (possibly user-edited) groups alone.
    context.db.prepare("UPDATE watches SET variant_groups_json = ? WHERE id = 'auto'").run(JSON.stringify([{ id: 'mine', label: 'Mine', terms: '1660 ti' }]));
    await (context.service as any).runWatch(context.db.prepare('SELECT * FROM watches WHERE id = ?').get('auto'));
    assert.deepEqual(context.service.getWatches()[0].variantGroups.map((group) => group.id), ['mine']);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey !== undefined) process.env.SCOUT_OPENROUTER_API_KEY = previousKey;
    context.close();
  }
});

test('auto generation waits for enough listings and skips watches that opted out', async () => {
  const context = fixture();
  try {
    seedAutoWatch(context, 'small', gpuSamples().slice(0, 20));
    seedAutoWatch(context, 'optout', gpuSamples(), { auto: 0 });
    await (context.service as any).autoGenerateVariantGroups('small');
    await (context.service as any).autoGenerateVariantGroups('optout');
    const watches = new Map(context.service.getWatches().map((watch) => [watch.id, watch]));
    assert.deepEqual(watches.get('small')?.variantGroups, []);
    assert.equal(watches.get('small')?.variantGroupsAuto, true);
    assert.deepEqual(watches.get('optout')?.variantGroups, []);
    assert.equal(watches.get('optout')?.variantGroupsAuto, false);
  } finally { context.close(); }
});

test('AI proposals are validated against the titles and fall back to title analysis on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-variants-ai-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const previousKey = process.env.SCOUT_OPENROUTER_API_KEY;
  process.env.SCOUT_OPENROUTER_API_KEY = 'test-key';
  let fail = false;
  const service = new ScoutService(db, () => {}, {
    suggestVariantGroups: async () => {
      if (fail) throw new Error('provider down');
      return [{ label: '1660 Ti', terms: '1660 ti' }, { label: '1660 Super', terms: '1660 super' }, { label: 'Made up', terms: 'nonexistent' }];
    },
  });
  try {
    seedAutoWatch({ db, service, close: () => {} }, 'ai', gpuSamples());
    const fromAi = await service.suggestWatchVariantGroups('ai');
    assert.equal(fromAi.method, 'ai');
    assert.deepEqual(fromAi.groups.map((group) => group.terms), ['1660 ti', '1660 super']);
    fail = true;
    const fallback = await service.suggestWatchVariantGroups('ai');
    assert.equal(fallback.method, 'titles');
    assert.equal(fallback.groups.length, 3);
    // Suggestions are only proposals: nothing is stored.
    assert.deepEqual(service.getWatches()[0].variantGroups, []);
  } finally {
    if (previousKey === undefined) delete process.env.SCOUT_OPENROUTER_API_KEY;
    else process.env.SCOUT_OPENROUTER_API_KEY = previousKey;
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('glued model names land in their own variant, and a number used as a quantity does not', () => {
  assert.equal(assignVariant('Zotac GTX 1660Ti 6GB GDDR6', gtxGroups), 'gtx-1660-ti');
  assert.equal(assignVariant('Karta graficzna GTX1660SUPER', gtxGroups), 'gtx-1660-super');
  assert.equal(assignVariant('GTX1660 6GB', gtxGroups), 'gtx-1660');
  const phones = [
    { id: 'iphone-12', label: 'iPhone 12', terms: 'iphone, 12' },
    { id: 'iphone-12-mini', label: 'iPhone 12 mini', terms: 'iphone, 12, mini' },
  ];
  assert.equal(assignVariant('iPhone 12mini white', phones), 'iphone-12-mini');
  assert.equal(assignVariant('iPhone 13 mini, gwarancja 12 miesięcy', phones), OTHER_VARIANT_KEY);
  assert.equal(assignVariant('iPhone 17 Pro Max 12 GB / 256 GB', phones), OTHER_VARIANT_KEY);
});

function seedVariantWatch(context: ReturnType<typeof fixture>, rows: Array<{ title: string; price: number; key?: string; source?: string; typical?: number }>, watch: Record<string, unknown> = {}) {
  const now = new Date(Date.now() - 8 * 3_600_000).toISOString();
  context.db.prepare(`INSERT INTO watches (id, name, query, sources_json, variant_groups_json, min_price_pln, max_price_pln, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`).run('w', 'GTX 1660', 'gtx 1660', '["OLX"]', JSON.stringify(watch.groups ?? gtxGroups), (watch.minPrice ?? null) as number | null, (watch.maxPrice ?? null) as number | null, now, now, now);
  const insertListing = context.db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insertAssociation = context.db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at, variant_key, variant_source, typical_pln, deal_strength, deal_label, typical_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertObservation = context.db.prepare('INSERT INTO observations (listing_id, watch_id, watch_listing_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)');
  rows.forEach((row, index) => {
    const listingId = Number(insertListing.run('OLX', `l-${index}`, row.title, row.price, `https://www.olx.pl/d/oferta/${index}`, now, now).lastInsertRowid);
    const typical = row.typical ?? null;
    const association = insertAssociation.run('w', listingId, now, now, row.key ?? null, row.source ?? null, typical, typical === null ? null : 5, typical === null ? null : 'Exceptional', typical === null ? null : 'own-history');
    insertObservation.run(listingId, 'w', Number(association.lastInsertRowid), row.price, now);
  });
}

function storedVariants(context: ReturnType<typeof fixture>) {
  return context.db.prepare(`SELECT l.title AS title, wl.variant_key AS key, wl.variant_source AS source, wl.typical_pln AS typical, wl.deal_strength AS strength
    FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id ORDER BY l.listing_id`).all() as Array<{ title: string; key: string | null; source: string | null; typical: number | null; strength: number | null }>;
}

test('re-tags saved listings once when the variant rules change, keeping manual picks', () => {
  const context = fixture();
  try {
    seedVariantWatch(context, [
      { title: 'GTX 1660Ti OC', price: 700, key: 'gtx-1660', source: 'rule', typical: 900 },
      { title: 'GTX 1660Super', price: 650, key: 'gtx-1660', source: 'manual' },
      { title: 'Karta graficzna Gigabyte', price: 640, key: 'gtx-1660-ti', source: 'jev' },
      { title: 'GTX1660TI 6GB', price: 720, key: 'gtx-1660', source: 'jev' },
      { title: 'RTX 3060 12GB', price: 1100, key: 'gtx-1660', source: 'rule' },
      { title: 'GTX 1660 6GB', price: 500, key: 'gtx-1660', source: 'rule' },
    ]);
    assert.equal(context.service.retagVariantRules(), 3);
    assert.deepEqual(storedVariants(context).map((row) => [row.title, row.key, row.source]), [
      ['GTX 1660Ti OC', 'gtx-1660-ti', 'rule'],
      ['GTX 1660Super', 'gtx-1660', 'manual'],
      ['Karta graficzna Gigabyte', 'gtx-1660-ti', 'jev'],
      ['GTX1660TI 6GB', 'gtx-1660-ti', 'rule'],
      ['RTX 3060 12GB', OTHER_VARIANT_KEY, 'rule'],
      ['GTX 1660 6GB', 'gtx-1660', 'rule'],
    ]);
    // The moved listing is re-scored against its new bucket, which is not ready yet: the stale 900 zł typical goes.
    assert.equal(storedVariants(context)[0].typical, null);
    assert.equal(storedVariants(context)[0].strength, null);
    // Once per rules version.
    context.db.prepare("UPDATE watch_listings SET variant_key = 'gtx-1660', variant_source = 'rule'").run();
    assert.equal(context.service.retagVariantRules(), 0);
    assert.equal(storedVariants(context)[0].key, 'gtx-1660');
  } finally { context.close(); }
});

test('changing a watch\'s price bounds re-scores its saved listings', () => {
  const context = fixture();
  try {
    const rows = Array.from({ length: 30 }, (_, index) => ({ title: `GTX 1660 ${index}`, price: 600, key: 'gtx-1660', source: 'rule' }));
    seedVariantWatch(context, [...rows, { title: 'Komputer GTX 1660', price: 2400, key: 'gtx-1660', source: 'rule', typical: 600 }, { title: 'GTX 1660 tanio', price: 420, key: 'gtx-1660', source: 'rule', typical: 2000 }]);
    context.service.updateWatch('w', { maxPrice: 1500 });
    const stored = new Map(storedVariants(context).map((row) => [row.title, row]));
    // Outside the new bounds: a scan would no longer keep it, so it loses its score.
    assert.equal(stored.get('Komputer GTX 1660')?.typical, null);
    assert.equal(stored.get('Komputer GTX 1660')?.strength, null);
    // Inside: priced against today's 600 zł baseline instead of the stale 2,000 zł.
    assert.equal(stored.get('GTX 1660 tanio')?.typical, 600);
    assert.equal(stored.get('GTX 1660 0')?.typical, 600);
  } finally { context.close(); }
});
