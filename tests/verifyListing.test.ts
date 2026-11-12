import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { listingDescriptionVerificationInputHash } from '../server/ai';
import { dealsForAgent } from '../server/deals';
import { ScoutService, ServiceError } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const KEY_VARIABLES = ['SCOUT_JEV_MODE', 'SCOUT_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'SCOUT_DEEPSEEK_API_KEY'] as const;

/** Live Jev mode with a test key (or none), restored afterwards. */
function aiEnv(apiKey: string | null = 'sk-or-v1-test') {
  const previous = Object.fromEntries(KEY_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of KEY_VARIABLES) delete process.env[name];
  process.env.SCOUT_JEV_MODE = 'live';
  if (apiKey) process.env.SCOUT_OPENROUTER_API_KEY = apiKey;
  return () => {
    for (const name of KEY_VARIABLES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

type Judgment = { decision: 'pass' | 'reject' | 'unknown'; confidence: number; unsure: boolean; issues?: string[] };

/**
 * Every AI call and marketplace request is a stub: Jev, vision and the
 * negotiability read answer from `state`, pages and the OLX API serve from
 * `state`, and legacy DeepSeek fails the test.
 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-verify-listing-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const calls = { jev: [] as Array<Record<string, any>>, vision: [] as Array<Record<string, any>>, negotiability: 0, pages: [] as string[], olx: [] as string[] };
  const state = {
    jev: async (_context: Record<string, any>): Promise<Judgment> => ({ decision: 'pass', confidence: 0.9, unsure: false }),
    vision: async (_input: Record<string, any>): Promise<{ decision: 'pass' | 'reject' | 'unknown'; confidence: number; issues: string[]; imagesSeen: number }> => ({ decision: 'pass', confidence: 0.8, issues: [], imagesSeen: 0 }),
    page: (_url: string): string => '<meta property="og:description" content="Fully working console, controller included.">',
    olx: (url: string): { status: number; json: unknown } => { throw new Error(`Unexpected OLX request ${url}`); },
  };
  const service = new ScoutService(db, () => {}, {
    suggestVariantGroups: async () => [],
    verifyListingDescription: async () => { throw new Error('Legacy DeepSeek must not be called in live mode'); },
    verifyListingDescriptionWithJev: async (context: any) => { calls.jev.push({ ...context }); return state.jev(context) as any; },
    verifyListingDescriptionWithVision: async (input: any) => { calls.vision.push({ ...input }); return state.vision(input) as any; },
    classifyNegotiabilityWithJev: async () => { calls.negotiability += 1; return { decision: 'unknown', confidence: null, unsure: true }; },
  });
  (service as any).fetchPublicPage = async (url: string) => { calls.pages.push(url); return state.page(url); };
  (service as any).fetchOlxApi = async (url: string) => { calls.olx.push(url); return state.olx(url); };
  return { db, service, calls, state, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seedWatch(db: any, id: string, options: { query?: string; included?: string; excluded?: string; checks?: Array<{ text: string; mode: 'require' | 'exclude' }> } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, included_terms, excluded_terms, verification_checks_json, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '["OLX","Allegro Lokalnie"]', 1, ?, ?, ?)`).run(
    id, `${id} name`, options.query ?? 'ps5', options.included ?? '', options.excluded ?? '', JSON.stringify(options.checks ?? []), now, now, now,
  );
}

/** A stored listing; with `watchId` also linked to that watch, as a scan leaves it. */
function seedListing(db: any, marketplace: string, listingId: string, options: { title?: string; price?: number; condition?: string | null; watchId?: string; link?: Record<string, unknown> } = {}) {
  const now = new Date().toISOString();
  const url = marketplace === 'OLX' ? `https://www.olx.pl/d/oferta/ps5-CID99-ID${listingId}.html` : `https://allegrolokalnie.pl/oferta/ps5-${listingId}`;
  const { lastInsertRowid } = db.prepare(`INSERT INTO listings (marketplace, listing_id, title, price_pln, url, condition, location, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, 'Warszawa', ?, ?)`).run(marketplace, listingId, options.title ?? 'PS5 console', options.price ?? 1500, url, options.condition === undefined ? 'Używane' : options.condition, now, now);
  if (options.watchId) {
    const link = { typical_pln: null, deal_strength: null, deal_label: null, typical_source: null, qualifies: null, ...options.link };
    db.prepare(`INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at, typical_pln, deal_strength, deal_label, typical_source, qualifies)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(options.watchId, lastInsertRowid, now, now, link.typical_pln, link.deal_strength, link.deal_label, link.typical_source, link.qualifies);
  }
  return { id: Number(lastInsertRowid), url };
}

/** The candidate a scan of `watchId` builds for a stored listing (storeListing). */
function scanCandidate(db: any, marketplace: string, listingId: string, watchId: string) {
  const row = db.prepare('SELECT * FROM listings WHERE marketplace = ? AND listing_id = ?').get(marketplace, listingId) as Record<string, any>;
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(watchId) as Record<string, any>;
  return {
    watchId,
    listing: {
      marketplace, listingId, title: row.title, price: row.price_pln, currency: 'PLN', url: row.url,
      condition: row.condition ?? undefined, location: row.location ?? undefined, shippingAvailable: null, priceNegotiable: null, observedAt: row.last_seen_at,
    },
    typical: 2000, discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
    query: String(watch.query ?? ''), includedTerms: String(watch.included_terms ?? ''), excludedTerms: String(watch.excluded_terms ?? ''),
    verificationChecks: watch.verification_checks_json ? JSON.parse(watch.verification_checks_json) : [],
  };
}

function olxOffer(id: string, title: string, price: number, description: string) {
  return {
    id: Number(id), url: `https://www.olx.pl/d/oferta/item-CID99-ID${id}.html`, title, status: 'active', description,
    created_time: new Date().toISOString(),
    params: [{ key: 'price', value: { value: price, currency: 'PLN', negotiable: false } }],
    photos: [{ link: `https://ireland.apollo.olxcdn.com/v1/files/${id}-photo/image;s={width}x{height}` }],
  };
}

/** Serves offers to OLX searches and each offer to its offers-API detail read. */
function serveOlx(state: ReturnType<typeof fixture>['state'], offers: Array<ReturnType<typeof olxOffer>>) {
  state.olx = (url: string) => {
    const detail = url.match(/\/api\/v1\/offers\/(\d+)\/$/);
    if (detail) {
      const offer = offers.find((item) => String(item.id) === detail[1]);
      return offer ? { status: 200, json: { data: offer } } : { status: 404, json: { error: { detail: 'Not found' } } };
    }
    return { status: 200, json: { data: offers, metadata: { visible_total_count: offers.length } } };
  };
}

const storedVerdict = (db: any, marketplace: string, listingId: string) => db.prepare(`SELECT ai_description_verification_status AS status,
  ai_description_verification_input_hash AS inputHash, ai_description_verification_error AS error
  FROM listings WHERE marketplace = ? AND listing_id = ?`).get(marketplace, listingId) as { status: string | null; inputHash: string | null; error: string | null };

const checks = [{ text: 'includes controller', mode: 'require' as const }, { text: 'console banned', mode: 'exclude' as const }];

test('checks a watch listing in its watch context and shares the verdict with that watch scan both ways', async () => {
  const restore = aiEnv();
  const context = fixture();
  try {
    seedWatch(context.db, 'ps5', { query: 'ps5', excluded: 'pad', checks });
    seedListing(context.db, 'Allegro Lokalnie', 'al-1', { watchId: 'ps5' });

    const result = await context.service.verifyListingForAgent('Allegro Lokalnie:al-1');
    assert.deepEqual(result.watch, { id: 'ps5', name: 'ps5 name' });
    assert.equal(result.status, 'pass');
    assert.equal(result.verification?.decision, 'pass');
    assert.deepEqual(result.checks, checks);
    assert.equal(result.error, null);
    assert.equal(result.reused, false);
    assert.ok(result.model && result.verifiedAt);
    // One page request, one Jev call and, with negotiability unknown, the
    // negotiability read: no vision call for a confident answer.
    assert.equal(context.calls.pages.length, 1);
    assert.equal(context.calls.jev.length, 1);
    assert.equal(context.calls.vision.length, 0);
    assert.equal(context.calls.negotiability, 1);
    const [jev] = context.calls.jev;
    assert.deepEqual([jev.query, jev.includedTerms, jev.excludedTerms, jev.checks], ['ps5', null, 'pad', checks]);

    // The stored hash is the scan's, so the watch's next scan reuses it.
    const expected = listingDescriptionVerificationInputHash({
      marketplace: 'Allegro Lokalnie', title: 'PS5 console', condition: 'Używane', description: 'Fully working console, controller included.',
      query: 'ps5', includedTerms: null, excludedTerms: 'pad', checks,
    });
    assert.equal(storedVerdict(context.db, 'Allegro Lokalnie', 'al-1').inputHash, expected);
    const candidate = scanCandidate(context.db, 'Allegro Lokalnie', 'al-1', 'ps5');
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(candidate), true);
    assert.equal(context.calls.jev.length, 1, 'the scan reuses the tool verdict');
    assert.equal((context.service as any).hasFreshDescriptionVerification(candidate), true);

    // A second call within six hours makes no request and no AI call.
    const pages = context.calls.pages.length;
    const again = await context.service.verifyListingForAgent('Allegro Lokalnie:al-1', { watchId: 'ps5' });
    assert.equal(again.reused, true);
    assert.equal(again.status, 'pass');
    assert.equal(again.verifiedAt, result.verifiedAt);
    assert.equal(context.calls.pages.length, pages);
    assert.equal(context.calls.jev.length, 1);
  } finally {
    restore();
    context.close();
  }
});

test('reuses a scan verdict, and checks again once the listing or the watch checks change', async () => {
  const restore = aiEnv();
  const context = fixture();
  try {
    seedWatch(context.db, 'ps5', { query: 'ps5' });
    seedListing(context.db, 'Allegro Lokalnie', 'al-2', { watchId: 'ps5' });
    assert.equal(await (context.service as any).verifyHighPriorityDealOnce(scanCandidate(context.db, 'Allegro Lokalnie', 'al-2', 'ps5')), true);
    assert.equal(context.calls.jev.length, 1);

    const reused = await context.service.verifyListingForAgent('Allegro Lokalnie:al-2');
    assert.equal(reused.reused, true);
    assert.equal(context.calls.pages.length, 1, 'no request for the scan verdict');
    assert.equal(context.calls.jev.length, 1);

    // New watch checks change the input, so the tool checks again.
    context.db.prepare('UPDATE watches SET verification_checks_json = ? WHERE id = ?').run(JSON.stringify(checks), 'ps5');
    const rechecked = await context.service.verifyListingForAgent('Allegro Lokalnie:al-2');
    assert.equal(rechecked.reused, false);
    assert.equal(context.calls.jev.length, 2);
    assert.deepEqual(context.calls.jev[1].checks, checks);

    // So does a new price: the snapshot no longer matches the listing.
    context.db.prepare("UPDATE listings SET price_pln = 1400 WHERE listing_id = 'al-2'").run();
    const repriced = await context.service.verifyListingForAgent('Allegro Lokalnie:al-2');
    assert.equal(context.calls.pages.length, 3);
    // Same description and context: the stored verdict is reused without AI.
    assert.equal(repriced.reused, true);
    assert.equal(context.calls.jev.length, 2);
  } finally {
    restore();
    context.close();
  }
});

test('an unsure Jev answer escalates to vision with the watch context', async () => {
  const restore = aiEnv();
  const context = fixture();
  try {
    seedWatch(context.db, 'ps5', { query: 'ps5', checks });
    seedListing(context.db, 'Allegro Lokalnie', 'al-3', { watchId: 'ps5' });
    context.state.jev = async () => ({ decision: 'unknown', confidence: 0.6, unsure: true });
    context.state.vision = async () => ({ decision: 'reject', confidence: 0.85, issues: ['Visible crack on the case'], imagesSeen: 0 });
    const result = await context.service.verifyListingForAgent('Allegro Lokalnie:al-3');
    assert.equal(context.calls.jev.length, 1);
    assert.equal(context.calls.vision.length, 1);
    assert.equal(context.calls.vision[0].query, 'ps5');
    assert.deepEqual(context.calls.vision[0].checks, checks);
    assert.equal(result.status, 'reject');
    assert.deepEqual(result.verification?.issues, ['Visible crack on the case']);
    assert.equal(result.reused, false);
  } finally {
    restore();
    context.close();
  }
});

test('a listing no watch has seen gets the generic check from the OLX offers API description', async () => {
  const restore = aiEnv();
  const context = fixture();
  try {
    seedListing(context.db, 'OLX', '7001', { title: 'PS5 slim' });
    serveOlx(context.state, [olxOffer('7001', 'PS5 slim', 1500, 'Sprawna konsola, pad w zestawie.')]);
    const result = await context.service.verifyListingForAgent('OLX:7001');
    assert.equal(result.watch, null);
    assert.deepEqual(result.checks, []);
    assert.equal(result.status, 'pass');
    // The description a scan would read: from the offers API, not the page.
    assert.equal(context.calls.olx.length, 1);
    assert.equal(context.calls.pages.length, 0);
    const [jev] = context.calls.jev;
    assert.equal(jev.description, 'Sprawna konsola, pad w zestawie.');
    assert.deepEqual([jev.query, jev.includedTerms, jev.excludedTerms, jev.checks], [null, null, null, null]);
    assert.equal(storedVerdict(context.db, 'OLX', '7001').inputHash, listingDescriptionVerificationInputHash({
      marketplace: 'OLX', title: 'PS5 slim', condition: 'Używane', description: 'Sprawna konsola, pad w zestawie.', query: null, includedTerms: null, excludedTerms: null,
    }));

    // When the offers API fails, the check reads the offer page instead.
    seedListing(context.db, 'OLX', '7002');
    const fallback = await context.service.verifyListingForAgent('OLX:7002');
    assert.equal(fallback.status, 'pass');
    assert.equal(context.calls.olx.length, 2);
    assert.equal(context.calls.pages.length, 1);
    assert.equal(context.calls.jev[1].description, 'Fully working console, controller included.');
  } finally {
    restore();
    context.close();
  }
});

test('scout_search scoreAgainst then a check in that watch context, for a listing the watch never saw', async () => {
  // The search runs without a key, so it is deterministic and calls no AI.
  const searchEnv = aiEnv(null);
  const context = fixture();
  let restore = searchEnv;
  try {
    seedWatch(context.db, 'iphone-watch', { query: 'iphone 13', excluded: 'etui', checks });
    serveOlx(context.state, [olxOffer('9001', 'iPhone 13 Pro 256GB', 1900, 'Bateria 88%, bez rys.')]);
    const search = await context.service.manualSearch({
      query: 'iphone 13', sources: ['OLX'], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', aiRelevance: false,
      scoreAgainst: 'iphone-watch',
    });
    assert.equal(search.scoredAgainst?.watchId, 'iphone-watch');
    assert.deepEqual(search.listings.map((listing) => listing.marketplaceListingKey ?? listing.id), ['OLX:9001']);
    const linked = () => context.db.prepare("SELECT COUNT(*) AS count FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE l.listing_id = '9001'").get() as { count: number };
    assert.equal(linked().count, 0, 'search results are stored without a watch link');

    searchEnv();
    restore = aiEnv();
    const result = await context.service.verifyListingForAgent('OLX:9001', { watchId: 'iphone-watch' });
    assert.deepEqual(result.watch, { id: 'iphone-watch', name: 'iphone-watch name' });
    assert.deepEqual(result.checks, checks);
    assert.equal(result.status, 'pass');
    const [jev] = context.calls.jev;
    assert.deepEqual([jev.query, jev.excludedTerms, jev.checks, jev.description], ['iphone 13', 'etui', checks, 'Bateria 88%, bez rys.']);
    assert.equal(linked().count, 0, 'the check links nothing');

    // Without watchId it has no watch, so it runs the generic check. The
    // listing keeps one verdict: the latest.
    const generic = await context.service.verifyListingForAgent('OLX:9001');
    assert.equal(generic.watch, null);
    assert.equal(generic.reused, false);
    assert.equal(context.calls.jev.length, 2);
    assert.equal(context.calls.jev[1].query, null);
    // An archived watch still exists, so it can still be checked against.
    context.db.prepare("UPDATE watches SET archived_at = ? WHERE id = 'iphone-watch'").run(new Date().toISOString());
    assert.deepEqual((await context.service.verifyListingForAgent('OLX:9001', { watchId: 'iphone-watch' })).watch?.id, 'iphone-watch');
  } finally {
    restore();
    context.close();
  }
});

test('a stored reject leaves the listing out of scout_deals and qualifiesOnly results', async () => {
  const restore = aiEnv();
  const context = fixture();
  try {
    seedWatch(context.db, 'ps5', { query: 'ps5' });
    // A Very strong deal that would alert: what scout_deals and qualifiesOnly list.
    seedListing(context.db, 'OLX', '8001', { price: 700, watchId: 'ps5', link: { typical_pln: 1000, deal_strength: 4, deal_label: 'Very strong', typical_source: 'own-history', qualifies: 1 } });
    serveOlx(context.state, [olxOffer('8001', 'PS5 console', 700, 'Konsola zbanowana, sprzedaję na części.')]);
    const dealIds = (includeRejected = false) => dealsForAgent(context.service, { includeRejected }).deals.map((deal) => deal.id);
    const qualifying = () => context.service.listingsPage({ visibility: 'visible', qualifiesOnly: true }).listings.map((listing) => listing.listingId);
    assert.deepEqual(dealIds(), ['OLX:8001']);
    assert.deepEqual(qualifying(), ['8001']);

    context.state.jev = async () => ({ decision: 'reject', confidence: 0.97, unsure: false, issues: ['Excluded: console banned'] });
    const result = await context.service.verifyListingForAgent('OLX:8001');
    assert.equal(result.status, 'reject');
    assert.deepEqual(dealIds(), []);
    assert.deepEqual(dealIds(true), ['OLX:8001']);
    assert.deepEqual(qualifying(), []);
  } finally {
    restore();
    context.close();
  }
});

test('refuses an unknown listing, an unknown watch and a missing OpenRouter key, writing nothing', async () => {
  const context = fixture();
  const restore = aiEnv(null);
  try {
    seedWatch(context.db, 'ps5');
    seedListing(context.db, 'Allegro Lokalnie', 'al-4', { watchId: 'ps5' });
    const refusal = async (call: Promise<unknown>) => {
      try { await call; } catch (error) { assert.ok(error instanceof ServiceError); return { message: error.message, status: error.status }; }
      assert.fail('expected a refusal');
    };
    assert.deepEqual(await refusal(context.service.verifyListingForAgent('Allegro Lokalnie:missing')), { message: 'Listing detail is not available yet', status: 404 });
    assert.deepEqual(await refusal(context.service.verifyListingForAgent('nope')), { message: 'Invalid listing key', status: 400 });
    assert.deepEqual(await refusal(context.service.verifyListingForAgent('Allegro Lokalnie:al-4', { watchId: 'missing' })), { message: 'Watch not found', status: 404 });
    const noKey = await refusal(context.service.verifyListingForAgent('Allegro Lokalnie:al-4'));
    assert.equal(noKey.status, 409);
    assert.match(noKey.message, /OpenRouter is not configured/);
    // Unlike a scan, which records not-configured, nothing is written.
    assert.deepEqual({ ...storedVerdict(context.db, 'Allegro Lokalnie', 'al-4') }, { status: null, inputHash: null, error: null });
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM listing_detail_snapshots').get() as { count: number }).count, 0);
    assert.equal(context.calls.pages.length + context.calls.jev.length, 0);
  } finally {
    restore();
    context.close();
  }
});

test('joins a scan check in the same context and waits out one in another watch context', async () => {
  const restore = aiEnv();
  const context = fixture();
  try {
    seedWatch(context.db, 'ps5', { query: 'ps5' });
    seedWatch(context.db, 'consoles', { query: 'konsola' });
    seedListing(context.db, 'Allegro Lokalnie', 'al-5', { watchId: 'ps5' });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    context.state.jev = async () => { await gate; return { decision: 'pass', confidence: 0.9, unsure: false }; };

    // Same context: the scan and the tool make one run.
    const scan = (context.service as any).verifyHighPriorityDeal(scanCandidate(context.db, 'Allegro Lokalnie', 'al-5', 'ps5'));
    const tool = context.service.verifyListingForAgent('Allegro Lokalnie:al-5');
    release();
    assert.equal(await scan, true);
    const joined = await tool;
    assert.equal(context.calls.jev.length, 1);
    assert.equal(context.calls.pages.length, 1);
    assert.equal(joined.reused, false);
    assert.equal(joined.status, 'pass');

    // Another watch's context: the tool waits for the scan, then runs its
    // own check, and answers for its own watch.
    seedListing(context.db, 'Allegro Lokalnie', 'al-6', { watchId: 'ps5' });
    let releaseOther!: () => void;
    const otherGate = new Promise<void>((resolve) => { releaseOther = resolve; });
    context.state.jev = async (jevContext) => {
      if (jevContext.query === 'konsola') await otherGate;
      return { decision: jevContext.query === 'konsola' ? 'reject' : 'pass', confidence: 0.9, unsure: false };
    };
    const otherScan = (context.service as any).verifyHighPriorityDeal(scanCandidate(context.db, 'Allegro Lokalnie', 'al-6', 'consoles'));
    const ownCheck = context.service.verifyListingForAgent('Allegro Lokalnie:al-6', { watchId: 'ps5' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(context.calls.jev.slice(1).map((call) => call.query), ['konsola']);
    releaseOther();
    assert.equal(await otherScan, false);
    const own = await ownCheck;
    assert.deepEqual(context.calls.jev.slice(1).map((call) => call.query), ['konsola', 'ps5']);
    assert.equal(own.watch?.id, 'ps5');
    assert.equal(own.status, 'pass');
  } finally {
    restore();
    context.close();
  }
});
