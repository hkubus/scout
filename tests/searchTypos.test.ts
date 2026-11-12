import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTypoRows, rewriteTypoTerms } from '../server/service';
import { olxOffer, olxPage, searchFixture } from './searchFixture';

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
