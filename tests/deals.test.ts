import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { DEAL_TIERS, compactListing, dealsForAgent } from '../server/deals';
import { ScoutService } from '../server/service';
import { FLAGS_VERSION, flagsJson, storedListingFlags } from '../server/flags';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-deals-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

interface Row {
  id: string;
  watch: string;
  price: number;
  typical?: number | null;
  strength?: number | null;
  source?: 'own-history' | 'reference-band' | null;
  marketplace?: 'OLX' | 'Vinted';
  variant?: string | null;
  verification?: string | null;
  hidden?: boolean;
  decision?: 'buy' | 'watch' | 'pass';
  irrelevant?: boolean;
  seenHoursAgo?: number;
}

/**
 * `deal-ready` has a ready baseline (30 associations observed 10 h ago, all
 * outside the 12 h feed window); `deal-learning` has none, so a legacy
 * typical (no typical_source) is only displayed on the ready watch.
 */
function seed(db: any, rows: Row[]) {
  const now = new Date().toISOString();
  const insertWatch = db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, '["OLX","Vinted"]', 1, ?, ?, ?)`);
  insertWatch.run('deal-ready', 'Ready watch', 'iphone 13', now, now, now);
  insertWatch.run('deal-learning', 'Learning watch', 'iphone 13', now, now, now);
  db.prepare('UPDATE watches SET variant_groups_json = ? WHERE id = ?').run(JSON.stringify([{ id: 'pro', label: '13 Pro', terms: 'pro' }]), 'deal-learning');
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at, ai_description_verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertLink = db.prepare(`INSERT INTO watch_listings (watch_id, listing_id, variant_key, first_seen_at, last_seen_at, typical_pln, deal_strength, deal_label, typical_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`);
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, watch_listing_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)');
  const listingRowId = (marketplace: string, id: string) => (db.prepare('SELECT id FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, id) as { id: number }).id;
  for (let index = 0; index < 30; index += 1) {
    const id = `filler-${index}`;
    insertListing.run('OLX', id, `iPhone 13 filler ${index}`, 1000, `https://www.olx.pl/d/oferta/${id}`, hoursAgo(48), hoursAgo(48), null);
    const link = insertLink.get('deal-ready', listingRowId('OLX', id), null, hoursAgo(48), hoursAgo(48), null, null, null, null) as { id: number };
    insertObservation.run(listingRowId('OLX', id), 'deal-ready', link.id, 1000, hoursAgo(10));
  }
  const labels: Record<number, string> = { 5: 'Exceptional', 4: 'Very strong', 3: 'Strong', 2: 'Watch', 1: 'Watch' };
  for (const row of rows) {
    const marketplace = row.marketplace ?? 'OLX';
    const seen = hoursAgo(row.seenHoursAgo ?? 1);
    insertListing.run(marketplace, row.id, `iPhone 13 ${row.id}`, row.price, `https://example.test/${row.id}`, seen, seen, row.verification ?? null);
    const strength = row.strength ?? null;
    insertLink.get(row.watch, listingRowId(marketplace, row.id), row.variant ?? null, seen, seen, row.typical ?? null, strength, strength === null ? null : labels[strength], row.source ?? null);
    if (row.hidden || row.decision) {
      db.prepare('INSERT INTO listing_actions (marketplace, listing_id, decision, note, hidden, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(marketplace, row.id, row.decision ?? null, '', row.hidden ? 1 : 0, now);
    }
    if (row.irrelevant) {
      db.prepare(`INSERT INTO listing_relevance (watch_id, marketplace, listing_id, input_hash, model, relevant, reason, checked_at, relevance_status) VALUES (?, ?, ?, 'hash', 'model', 0, 'no', ?, 'irrelevant')`).run(row.watch, marketplace, row.id, now);
    }
  }
}

const ROWS: Row[] = [
  { id: 'exc', watch: 'deal-ready', price: 600, typical: 1000, strength: 5, source: 'own-history', verification: 'pass' },
  { id: 'very', watch: 'deal-ready', price: 780, typical: 1000, strength: 4, source: 'own-history', verification: 'reject', marketplace: 'Vinted' },
  { id: 'strong', watch: 'deal-ready', price: 850, typical: 1000, strength: 3, source: 'reference-band', verification: 'unknown' },
  { id: 'watchrow', watch: 'deal-ready', price: 950, typical: 1000, strength: 2, source: 'own-history' },
  { id: 'above', watch: 'deal-ready', price: 1100, typical: 1000, strength: 1, source: 'own-history' },
  // Written before typical_source existed: shown because deal-ready is ready.
  { id: 'legacy-ready', watch: 'deal-ready', price: 700, typical: 1000, strength: 5, source: null, seenHoursAgo: 2 },
  { id: 'passed', watch: 'deal-ready', price: 800, typical: 1000, strength: 4, source: 'own-history', decision: 'pass' },
  { id: 'kept', watch: 'deal-ready', price: 880, typical: 1000, strength: 3, source: 'own-history', decision: 'buy', marketplace: 'Vinted' },
  { id: 'hidden-exc', watch: 'deal-ready', price: 500, typical: 1000, strength: 5, source: 'own-history', hidden: true },
  { id: 'ai-exc', watch: 'deal-ready', price: 510, typical: 1000, strength: 5, source: 'own-history', irrelevant: true },
  { id: 'stale-exc', watch: 'deal-ready', price: 520, typical: 1000, strength: 5, source: 'own-history', seenHoursAgo: 20 },
  // Not shown: deal-learning is not ready and the row has no typical_source.
  { id: 'legacy-learning', watch: 'deal-learning', price: 500, typical: 1000, strength: 5, source: null },
  { id: 'pro-1', watch: 'deal-learning', price: 2000, typical: 2600, strength: 4, source: 'own-history', variant: 'pro' },
  { id: 'other-1', watch: 'deal-learning', price: 900, typical: 1000, strength: 3, source: 'reference-band', variant: '__other__', verification: 'pending' },
];

test('filters the feed by tier, discount, variant, price and verification, and sorts by discount', () => {
  const context = fixture();
  try {
    seed(context.db, ROWS);
    const watches = context.service.getWatches();
    assert.equal(watches.find((watch) => watch.id === 'deal-ready')?.readiness, 100);
    assert.ok((watches.find((watch) => watch.id === 'deal-learning')?.readiness ?? 0) < 100);
    type Options = Parameters<typeof context.service.listingsPage>[0];
    const ids = (options: Options) => context.service.listingsPage({ visibility: 'visible', pageSize: 100, ...options }).listings.map((listing) => listing.listingId);
    const sorted = (options: Options) => ids(options).sort();

    // Hidden, AI-irrelevant and stale rows never show; the rest do.
    const visible = ['above', 'exc', 'kept', 'legacy-learning', 'legacy-ready', 'other-1', 'passed', 'pro-1', 'strong', 'very', 'watchrow'];
    assert.deepEqual(sorted({}), visible);

    // minDiscount reads the typical the row displays: the learning watch's
    // legacy row has none, the ready watch's does.
    assert.deepEqual(sorted({ minDiscount: 20 }), ['exc', 'legacy-ready', 'passed', 'pro-1', 'very']);
    assert.equal(context.service.listingsPage({ visibility: 'visible', minDiscount: 20 }).pagination.total, 5);
    assert.deepEqual(sorted({ minDiscount: 0 }), visible.filter((id) => id !== 'above' && id !== 'legacy-learning'));
    assert.deepEqual(sorted({ minDiscount: 23.1 }), ['exc', 'legacy-ready']);
    assert.deepEqual(sorted({ minDiscount: 23 }), ['exc', 'legacy-ready', 'pro-1']);
    assert.deepEqual(sorted({ minDiscount: 20, marketplace: 'Vinted' }), ['very']);

    // Discount order runs across pages, rows without a typical last, and the
    // total follows the filters.
    const discountOrder = ['exc', 'legacy-ready', 'pro-1', 'very', 'passed', 'strong', 'kept', 'other-1', 'watchrow', 'above', 'legacy-learning'];
    assert.deepEqual(ids({ sort: 'discount' }), discountOrder);
    const pages = [1, 2, 3, 4].map((page) => context.service.listingsPage({ visibility: 'visible', sort: 'discount', page, pageSize: 3 }));
    assert.deepEqual(pages.flatMap((page) => page.listings.map((listing) => listing.listingId)), discountOrder);
    assert.deepEqual(pages.map((page) => page.pagination.total), [11, 11, 11, 11]);
    assert.deepEqual(pages.map((page) => page.pagination.hasNext), [true, true, true, false]);
    assert.deepEqual(ids({ sort: 'discount', minStrength: 4 }), ['exc', 'legacy-ready', 'pro-1', 'very', 'passed', 'legacy-learning']);

    // The deal order: strength, then untriaged before Buy/Maybe/Pass, then
    // discount, then newest. `kept` (Buy, 12% off) follows `other-1` (10%).
    assert.deepEqual(ids({ sort: 'deal', minStrength: 3 }), ['exc', 'legacy-ready', 'legacy-learning', 'pro-1', 'very', 'passed', 'strong', 'other-1', 'kept']);

    assert.deepEqual(sorted({ variantKey: 'pro' }), ['pro-1']);
    assert.deepEqual(sorted({ variantKey: '__other__' }), ['other-1']);
    assert.deepEqual(sorted({ variantKey: 'missing' }), []);

    assert.deepEqual(sorted({ minPrice: 800, maxPrice: 950 }), ['kept', 'other-1', 'passed', 'strong', 'watchrow']);
    assert.deepEqual(sorted({ minPrice: 1100 }), ['above', 'pro-1']);
    assert.deepEqual(sorted({ maxPrice: 600 }), ['exc', 'legacy-learning']);

    assert.deepEqual(sorted({ verification: 'pass' }), ['exc']);
    assert.deepEqual(sorted({ verification: 'reject' }), ['very']);
    assert.deepEqual(sorted({ verification: 'unknown' }), ['strong']);
    assert.deepEqual(sorted({ verification: 'pending' }), ['other-1']);
    assert.deepEqual(sorted({ verification: 'none' }), ['above', 'kept', 'legacy-learning', 'legacy-ready', 'passed', 'pro-1', 'watchrow']);
    assert.deepEqual(sorted({ excludeRejected: true }), visible.filter((id) => id !== 'very'));
    assert.deepEqual(sorted({ excludePassed: true }), visible.filter((id) => id !== 'passed'));

    // Hidden rows only come back when asked for; AI-irrelevant ones never do.
    assert.deepEqual(ids({ visibility: 'hidden', minDiscount: 30 }), ['hidden-exc']);
    assert.deepEqual(sorted({ visibility: 'all', minDiscount: 40 }), ['exc', 'hidden-exc']);

    // Feed rows now carry the description check where there is one.
    const exc = context.service.listingsPage({ visibility: 'visible', verification: 'pass' }).listings[0];
    assert.equal(exc.aiDescriptionVerificationStatus, 'pass');
  } finally { context.close(); }
});

test('Strong+ matches the dashboard count, and scout_deals answers it best first', () => {
  const context = fixture();
  try {
    seed(context.db, ROWS);
    // The dashboard's strong-deals counter is the visible Strong+ feed.
    const strongPlus = context.service.listingsPage({ visibility: 'visible', minStrength: 3, pageSize: 100 });
    assert.equal(strongPlus.pagination.total, context.service.dashboard().stats.strongDeals);
    assert.equal(strongPlus.pagination.total, 9);

    // No arguments: Strong+, without passed or description-rejected rows, in
    // the Top deals order.
    const deals = dealsForAgent(context.service);
    assert.equal(deals.schemaVersion, 1);
    assert.equal(deals.minTier, 'strong');
    assert.equal(deals.freshHours, 12);
    assert.deepEqual(deals.deals.map((deal) => deal.listingId), ['exc', 'legacy-ready', 'legacy-learning', 'pro-1', 'strong', 'other-1', 'kept']);
    assert.equal(deals.total, 7);
    assert.match(deals.notes.join(' '), /Asking prices/);

    const byTier = Object.fromEntries(DEAL_TIERS.map((minTier) => [minTier, dealsForAgent(context.service, { minTier }).deals.map((deal) => deal.listingId)]));
    assert.deepEqual(byTier, {
      strong: ['exc', 'legacy-ready', 'legacy-learning', 'pro-1', 'strong', 'other-1', 'kept'],
      'very-strong': ['exc', 'legacy-ready', 'legacy-learning', 'pro-1'],
      exceptional: ['exc', 'legacy-ready', 'legacy-learning'],
    });
    assert.deepEqual(dealsForAgent(context.service, { includeRejected: true }).deals.map((deal) => deal.listingId), ['exc', 'legacy-ready', 'legacy-learning', 'pro-1', 'very', 'strong', 'other-1', 'kept']);
    assert.deepEqual(dealsForAgent(context.service, { marketplace: 'Vinted', includeRejected: true }).deals.map((deal) => deal.listingId), ['very', 'kept']);
    assert.deepEqual(dealsForAgent(context.service, { watchId: 'deal-learning' }).deals.map((deal) => deal.listingId), ['legacy-learning', 'pro-1', 'other-1']);
    assert.deepEqual(dealsForAgent(context.service, { variantKey: 'pro' }).deals.map((deal) => deal.listingId), ['pro-1']);
    assert.deepEqual(dealsForAgent(context.service, { maxPrice: 700 }).deals.map((deal) => deal.listingId), ['exc', 'legacy-ready', 'legacy-learning']);
    const limited = dealsForAgent(context.service, { limit: 2 });
    assert.deepEqual(limited.deals.map((deal) => deal.listingId), ['exc', 'legacy-ready']);
    assert.equal(limited.total, 7);
    assert.equal(dealsForAgent(context.service, { limit: 500 }).deals.length, 7);

    const [first] = deals.deals;
    assert.deepEqual(first, {
      id: 'OLX:exc', listingId: 'exc', source: 'OLX', title: 'iPhone 13 exc', price: 600, typical: 1000, discountPercent: 40,
      // OLX's default fee preset is 0%, so reselling at typical nets 1000 - 600.
      tier: 'exceptional', dealLabel: 'Exceptional', typicalSource: 'own-history', estimatedNet: 400,
      watchId: 'deal-ready', watch: 'Ready watch', variantKey: null, variant: null, url: 'https://example.test/exc', image: null,
      condition: null, location: null, shippingAvailable: null, negotiable: null, sellerType: null, postedAt: null,
      seenAt: first.seenAt, decision: null, verification: 'pass',
    });
    const legacy = deals.deals.find((deal) => deal.listingId === 'legacy-learning')!;
    assert.equal(legacy.typical, null);
    assert.equal(legacy.discountPercent, null);
    assert.equal(legacy.tier, 'exceptional');
    const pro = deals.deals.find((deal) => deal.listingId === 'pro-1')!;
    assert.deepEqual([pro.variantKey, pro.variant, pro.discountPercent, pro.tier], ['pro', '13 Pro', 23.1, 'very-strong']);
    assert.equal(deals.deals.find((deal) => deal.listingId === 'kept')?.decision, 'buy');
  } finally { context.close(); }
});

test('Overview\'s Top deals request is listingsPage in the deal order, the order Overview used to sort itself', async () => {
  // The URL the web client builds for Overview, read as GET /api/listings reads it.
  const requested: string[] = [];
  const globals = globalThis as Record<string, unknown>;
  const saved = { window: globals.window, fetch: globals.fetch };
  Object.assign(globals, {
    window: globalThis,
    fetch: async (url: string) => {
      requested.push(url);
      return new Response(JSON.stringify({ listings: [], pagination: { page: 1, pageSize: 25, total: 0, hasNext: false } }), { status: 200 });
    },
  });
  const context = fixture();
  try {
    const { api, topDealsQuery, TOP_DEALS } = await import('../src/api');
    seed(context.db, ROWS);
    // Overview's own ranking before it asked the server, kept as the reference:
    // Strong+, not hidden, passed or AI-filtered; strength, untriaged first,
    // deepest discount, newest first seen.
    const feed = context.service.listingsPage({ visibility: 'all', aiFiltered: 'include', pageSize: 500 }).listings;
    const overviewOrder = (marketplace?: string) => feed
      .filter((listing) => !listing.hidden && !listing.aiFiltered && listing.decision !== 'pass' && listing.dealStrength >= 3 && (!marketplace || listing.marketplace === marketplace))
      .sort((a, b) => (b.dealStrength - a.dealStrength)
        || ((a.decision ? 1 : 0) - (b.decision ? 1 : 0))
        || ((a.belowTypical ?? 0) - (b.belowTypical ?? 0))
        || ((Date.parse(b.firstSeenAt ?? b.observedAt) || 0) - (Date.parse(a.firstSeenAt ?? a.observedAt) || 0)))
      .map((listing) => listing.listingId);

    for (const marketplace of [undefined, 'OLX', 'Vinted'] as const) {
      requested.length = 0;
      await api.listings(topDealsQuery(marketplace));
      assert.equal(requested.length, 1);
      const url = new URL(requested[0], 'http://scout.test');
      assert.equal(url.pathname, '/api/listings');
      assert.deepEqual(Object.fromEntries(url.searchParams), {
        pageSize: String(TOP_DEALS + 5), sort: 'deal', visibility: 'visible', minStrength: '3', aiFiltered: 'exclude', excludePassed: 'true',
        ...(marketplace ? { marketplace } : {}),
      });
      // The route passes each filter through to listingsPage, coerced.
      const page = context.service.listingsPage({ sort: 'deal', minStrength: 3, visibility: 'visible', aiFiltered: 'exclude', excludePassed: true, pageSize: TOP_DEALS + 5, ...(marketplace ? { marketplace } : {}) });
      assert.deepEqual(page.listings.map((listing) => listing.listingId), overviewOrder(marketplace), marketplace ?? 'All');
      assert.equal(page.pagination.total, overviewOrder(marketplace).length);
    }
    assert.deepEqual(overviewOrder(), ['exc', 'legacy-ready', 'legacy-learning', 'pro-1', 'very', 'strong', 'other-1', 'kept']);
  } finally {
    context.close();
    Object.assign(globals, saved);
  }
});

test('compact rows give a signed discount and mark hidden rows', () => {
  const context = fixture();
  try {
    seed(context.db, ROWS);
    context.db.prepare("UPDATE listings SET image_url = 'https://example.test/very.jpg' WHERE listing_id = 'very'").run();
    const rows = context.service.listingsPage({ visibility: 'all', pageSize: 100 }).listings.map(compactListing);
    const byId = new Map(rows.map((row) => [row.listingId, row]));
    assert.equal(byId.get('above')?.discountPercent, -10);
    assert.equal(byId.get('above')?.tier, null);
    assert.equal(byId.get('watchrow')?.tier, null);
    assert.equal(byId.get('hidden-exc')?.hidden, true);
    assert.equal('hidden' in byId.get('exc')!, false);
    assert.equal(byId.get('very')?.source, 'Vinted');
    assert.equal(byId.get('very')?.shippingAvailable, true);
    // The photo, for a chart or card; null without one, never "".
    assert.equal(byId.get('very')?.image, 'https://example.test/very.jpg');
    assert.equal(byId.get('exc')?.image, null);
  } finally { context.close(); }
});

test('scout_deals leaves out stored quick flags on request; rows not yet stored are flagged but kept', async () => {
  const context = fixture();
  try {
    seed(context.db, ROWS);
    const setTitle = (id: string, title: string, stored: boolean) => context.db.prepare('UPDATE listings SET title = ?, flags_json = ?, flags_version = ? WHERE listing_id = ?')
      .run(title, stored ? flagsJson(storedListingFlags({ title })) : null, stored ? FLAGS_VERSION : null, id);
    setTitle('legacy-ready', 'iPhone 13 na części', true);
    setTitle('strong', 'Etui iPhone 13', true);
    // Saved before migration 040 and not yet reached by the backfill.
    setTitle('kept', 'Zamienię iPhone 13 na Pixel 8', false);

    const all = dealsForAgent(context.service);
    const flags = Object.fromEntries(all.deals.map((deal) => [deal.listingId, deal.flags]));
    assert.deepEqual(flags, {
      exc: undefined, 'legacy-ready': ['for_parts'], 'legacy-learning': undefined, 'pro-1': undefined,
      strong: ['accessory'], kept: ['swap'], 'other-1': undefined,
    });
    assert.equal('flags' in all.deals.find((deal) => deal.listingId === 'exc')!, false, 'unflagged rows omit the key');

    const narrowed = dealsForAgent(context.service, { excludeFlags: ['for_parts', 'swap'] });
    assert.deepEqual(narrowed.deals.map((deal) => deal.listingId), ['exc', 'legacy-learning', 'pro-1', 'strong', 'kept', 'other-1']);
    assert.equal(narrowed.total, 6);

    await context.service.backfillListingFlags();
    const stored = dealsForAgent(context.service, { excludeFlags: ['for_parts', 'swap'] });
    assert.deepEqual(stored.deals.map((deal) => deal.listingId), ['exc', 'legacy-learning', 'pro-1', 'strong', 'other-1']);
    assert.equal(stored.total, 5);
  } finally { context.close(); }
});
