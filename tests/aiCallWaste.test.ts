import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { PLAIN_VARIANT_RULE_MODEL } from '../server/aiRules';
import { DEFAULT_JEV_MODEL } from '../server/jev';
import { ScoutService, findFuzzyRescueCandidates, type ScoutServiceDependencies } from '../server/service';
import type { VariantGroup } from '../server/variants';

// AI calls Scout makes without need (the 2026-11 improvement export). Every
// model call is a stub that counts; nothing reaches the network.
if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const templateDirectory = mkdtempSync(join(tmpdir(), 'scout-ai-waste-template-'));
after(() => rmSync(templateDirectory, { recursive: true, force: true }));
let template: string | undefined;
function migratedDatabase(path: string) {
  if (!template) {
    template = join(templateDirectory, 'scout.sqlite');
    openDatabase(template).close();
  }
  copyFileSync(template, path);
  return openDatabase(path);
}

const KEY_VARIABLES = ['SCOUT_JEV_MODE', 'SCOUT_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'SCOUT_DEEPSEEK_API_KEY'] as const;
/** Live Jev mode with a test key, restored afterwards. */
function liveJevEnv() {
  const previous = Object.fromEntries(KEY_VARIABLES.map((name) => [name, process.env[name]]));
  for (const name of KEY_VARIABLES) delete process.env[name];
  process.env.SCOUT_JEV_MODE = 'live';
  process.env.SCOUT_OPENROUTER_API_KEY = 'sk-or-v1-test';
  return () => {
    for (const name of KEY_VARIABLES) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  };
}

function fixture(dependencies: ScoutServiceDependencies = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-ai-waste-'));
  const db = migratedDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, {
    suggestVariantGroups: async () => [],
    classifyListingRelevance: async () => { throw new Error('DeepSeek must not be called in live mode'); },
    verifyListingDescription: async () => { throw new Error('DeepSeek must not be called in live mode'); },
    ...dependencies,
  });
  return { db, service: service as any, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seedWatch(db: any, id: string, query: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, ?, '["OLX"]', 1, ?, ?, ?)`).run(id, `${id} name`, query, now, now, now);
}

function listing(listingId: string, title: string, overrides: Record<string, any> = {}) {
  return {
    marketplace: 'OLX', listingId, title, price: 900, currency: 'PLN',
    url: `https://www.olx.pl/d/oferta/${listingId}`, imageUrl: `https://img.example/${listingId}.jpg`,
    condition: 'Używane', location: 'Warszawa', shippingAvailable: null, priceNegotiable: null,
    observedAt: new Date().toISOString(), ...overrides,
  };
}

const relevanceRows = (db: any, watchId: string) => (db.prepare('SELECT listing_id, model, relevance_status, reason FROM listing_relevance WHERE watch_id = ? ORDER BY listing_id').all(watchId) as Array<Record<string, unknown>>)
  .map((row) => ({ ...row }));

const IPHONE_12: VariantGroup[] = [
  { id: 'iphone-12', label: 'iPhone 12', terms: 'iphone 12' },
  { id: 'iphone-12-mini', label: 'iPhone 12 mini', terms: 'iphone 12 mini' },
  { id: 'iphone-12-pro', label: 'iPhone 12 Pro', terms: 'iphone 12 pro' },
  { id: 'iphone-12-pro-max', label: 'iPhone 12 Pro Max', terms: 'iphone 12 pro max' },
];

test('relevance: a title that plainly names a watch variant skips the AI and replaces its exclusion', async () => {
  const restore = liveJevEnv();
  const titles: string[] = [];
  // The AI reads "mini" as another model than the "iPhone 12" query, as it did on the export.
  const context = fixture({
    classifyListingRelevanceWithJev: async (ctx: any) => {
      titles.push(ctx.title);
      return /mini|gratisy/i.test(ctx.title) ? { relevant: false, p: 0.03, unsure: false } : { relevant: true, p: 0.9, unsure: false };
    },
  });
  try {
    seedWatch(context.db, 'iphone', 'iPhone 12');
    const search = { query: 'iPhone 12', includedTerms: '', excludedTerms: '' };
    const mini = listing('mini', 'iPhone 12 mini 64GB');
    const extras = listing('extras', 'iPhone 12 Pro Max + gratisy');
    // Without the groups (manual search, or a watch before this change) the AI decides.
    const before = await context.service.filterListingsByAiRelevance([mini, extras], search, 'iphone', true);
    assert.equal(before.excluded, 2);
    assert.deepEqual(titles, ['iPhone 12 mini 64GB', 'iPhone 12 Pro Max + gratisy']);

    // With the groups, the stored AI exclusion of the same input is replaced.
    const withGroups = { ...search, variantGroups: IPHONE_12 };
    const after = await context.service.filterListingsByAiRelevance([mini, extras], withGroups, 'iphone', true);
    assert.deepEqual(after.listings.map((item: any) => item.listingId), ['mini']);
    assert.equal(after.excluded, 1);
    assert.equal(titles.length, 2, 'the plain title made no AI call; the other reused its cached verdict');
    assert.deepEqual(relevanceRows(context.db, 'iphone'), [
      { listing_id: 'extras', model: DEFAULT_JEV_MODEL, relevance_status: 'irrelevant', reason: 'Jev classified listing as irrelevant (p=0.03)' },
      { listing_id: 'mini', model: PLAIN_VARIANT_RULE_MODEL, relevance_status: 'relevant', reason: 'Title plainly names the "iPhone 12 mini" variant' },
    ]);

    // Repeat scans write nothing and call nothing, even below the deal gate.
    const changes = () => Number((context.db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
    const written = changes();
    const repeat = await context.service.filterListingsByAiRelevance([mini], withGroups, 'iphone', true, () => false);
    assert.equal(repeat.listings.length, 1);
    assert.equal(repeat.skipped, 0);
    assert.equal(changes(), written);
    assert.equal(titles.length, 2);

    // An AI "relevant" row for the same input is kept as it is.
    const plain = listing('plain', 'iPhone 12 128GB Black');
    await context.service.filterListingsByAiRelevance([plain], search, 'iphone', true);
    const aiRow = relevanceRows(context.db, 'iphone').find((row) => row.listing_id === 'plain');
    await context.service.filterListingsByAiRelevance([plain], withGroups, 'iphone', true);
    assert.deepEqual(relevanceRows(context.db, 'iphone').find((row) => row.listing_id === 'plain'), aiRow);
    assert.equal(titles.length, 3);

    // Analytics' AI pass rate counts AI verdicts only (extras and plain).
    assert.equal(context.service.analytics({ days: 30 }).aiQuality.relevanceJudged, 2);
  } finally {
    restore();
    context.close();
  }
});

test('term-match rescue: near-misses without the query model number make no call and use no budget', async () => {
  const restore = liveJevEnv();
  const titles: string[] = [];
  let fail = false;
  const context = fixture({
    classifyTermMatchWithJev: async (input: any) => {
      titles.push(input.title);
      if (fail) throw new Error('fetch failed');
      return { decision: 'pass', confidence: 0.9, unsure: false };
    },
  });
  try {
    // Twelve other models first: before, they took the whole budget of 10.
    const others = Array.from({ length: 12 }, (_, index) => listing(`other-${index}`, `GTX 1660 Super 6GB nr ${index}`));
    const twins = [listing('twin-1', 'Karta Gigabyte 2060 6GB'), listing('twin-2', 'Karta Gigabyte 2060 6GB')];
    const msi = listing('msi', 'Karta MSI 2060 Ventus');
    const candidates = findFuzzyRescueCandidates([...others, ...twins, msi] as any, 'rtx 2060', '', '', {});
    assert.equal(candidates.termCandidates.length, 15);
    const search = { query: 'rtx 2060', includedTerms: '', excludedTerms: '', condition: 'Any' };
    const live = context.service.jevLiveConfig();
    const result = await context.service.rescueFuzzyMisses(candidates, search, live);
    assert.deepEqual(titles, ['Karta Gigabyte 2060 6GB', 'Karta MSI 2060 Ventus'], 'one call per distinct title, none for other models');
    assert.deepEqual(result.rescued.map((item: any) => item.listingId), ['twin-1', 'twin-2', 'msi']);

    // A failed call is not repeated on the next scan, only after the backoff.
    fail = true;
    const retitled = listing('new', 'Karta Palit 2060 Dual');
    const pool = findFuzzyRescueCandidates([retitled] as any, 'rtx 2060', '', '', {});
    assert.equal((await context.service.rescueFuzzyMisses(pool, search, live)).rescued.length, 0);
    assert.equal(titles.length, 3);
    assert.equal((await context.service.rescueFuzzyMisses(pool, search, live)).rescued.length, 0);
    assert.equal(titles.length, 3, 'no hot retry while the error is fresh');
    context.db.prepare("UPDATE jev_fuzzy_cache SET checked_at = ? WHERE decision = 'error'").run(new Date(Date.now() - 2 * 60 * 60_000).toISOString());
    fail = false;
    assert.equal((await context.service.rescueFuzzyMisses(pool, search, live)).rescued.length, 1);
    assert.equal(titles.length, 4);
    assert.equal((context.db.prepare("SELECT COUNT(*) AS n FROM jev_fuzzy_cache WHERE decision = 'error'").get() as { n: number }).n, 0);
  } finally {
    restore();
    context.close();
  }
});

/** A stored listing and the candidate a scan builds for it. */
function dealCandidate(listingId: string, db?: any) {
  if (db) {
    const now = new Date().toISOString();
    db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('OLX', listingId, 'PS5 console', 1500, `https://www.olx.pl/d/oferta/${listingId}`, now, now);
  }
  return {
    watchId: 'deal-watch', listing: listing(listingId, 'PS5 console', { price: 1500 }),
    typical: 2000, discountPercent: 25, confidence: 0.9, requiresDescriptionVerification: true,
  };
}
const detailPage = (description: string) => `<meta property="og:description" content="${description}"><meta property="og:image" content="https://ireland.apollo.olxcdn.com/v1/files/abc-PL/image;s=644x461">`;

test('verification: an unsure reject stands without vision; an unsure pass or unknown still escalates', async () => {
  const restore = liveJevEnv();
  const vision: string[] = [];
  const context = fixture({
    verifyListingDescriptionWithJev: async (ctx: any) => /cracked/i.test(ctx.description) ? { decision: 'reject', confidence: 0.45, unsure: true, issues: ['cracked screen'] }
      : /maybe/.test(ctx.description) ? { decision: 'pass', confidence: 0.55, unsure: true }
        : { decision: 'unknown', confidence: 0.3, unsure: true },
    verifyListingDescriptionWithVision: async (input: any) => { vision.push(input.description); return { decision: 'pass', confidence: 0.8, issues: [], imagesSeen: 1 }; },
    classifyNegotiabilityWithJev: async () => ({ decision: 'fixed', confidence: 0.9, unsure: false }),
  });
  try {
    let page = detailPage('Cracked screen, otherwise works.');
    context.service.fetchPublicPage = async () => page;
    assert.equal(await context.service.verifyHighPriorityDealOnce(dealCandidate('cracked', context.db)), false);
    assert.deepEqual(vision, []);
    const stored = context.db.prepare("SELECT ai_description_verification_status AS status, ai_description_verification_json AS json FROM listings WHERE listing_id = 'cracked'").get() as { status: string; json: string };
    assert.equal(stored.status, 'reject');
    assert.equal(JSON.parse(stored.json).summary, 'Jev leaned reject (confidence 0.45); vision skipped.');
    assert.deepEqual(JSON.parse(stored.json).issues, ['cracked screen']);
    const log = context.db.prepare("SELECT jev_unsure, vision_verdict, vision_error FROM jev_shadow_log WHERE task = 'verification'").all() as Array<Record<string, unknown>>;
    assert.deepEqual(log.map((row) => ({ ...row })), [{ jev_unsure: 1, vision_verdict: null, vision_error: null }]);

    page = detailPage('maybe works');
    assert.equal(await context.service.verifyHighPriorityDealOnce(dealCandidate('maybe')), true);
    page = detailPage('no idea');
    assert.equal(await context.service.verifyHighPriorityDealOnce(dealCandidate('unsure')), true);
    assert.deepEqual(vision, ['maybe works', 'no idea']);
  } finally {
    restore();
    context.close();
  }
});

test('verification: a listing without a description is judged from its photos, without Jev; with no photos either it stays unknown', async () => {
  const restore = liveJevEnv();
  const jev: Array<string | null> = [];
  const vision: Array<string | null> = [];
  let visionDecision: 'pass' | 'reject' = 'reject';
  const context = fixture({
    verifyListingDescriptionWithJev: async (ctx: any) => { jev.push(ctx.description); return { decision: 'pass', confidence: 0.9, unsure: false }; },
    verifyListingDescriptionWithVision: async (input: any) => {
      vision.push(input.description);
      return { decision: visionDecision, confidence: 0.85, issues: visionDecision === 'reject' ? ['no display output in the photos'] : [], imagesSeen: 1 };
    },
    classifyNegotiabilityWithJev: async () => ({ decision: 'fixed', confidence: 0.9, unsure: false }),
  });
  const status = (listingId: string) => (context.db.prepare('SELECT ai_description_verification_status AS status FROM listings WHERE listing_id = ?').get(listingId) as { status: string }).status;
  // Only a photo: what a Vinted page with nothing but the marketing blurb leaves.
  context.service.fetchPublicPage = async () => '<meta property="og:image" content="https://ireland.apollo.olxcdn.com/v1/files/abc-PL/image;s=644x461">';
  try {
    assert.equal(await context.service.verifyHighPriorityDealOnce(dealCandidate('photos-reject', context.db)), false);
    assert.equal(status('photos-reject'), 'reject');
    // A photo verdict stays with its listing: the same text on another listing is looked at again.
    visionDecision = 'pass';
    assert.equal(await context.service.verifyHighPriorityDealOnce(dealCandidate('photos-pass', context.db)), true);
    assert.equal(status('photos-pass'), 'pass');
    assert.deepEqual(jev, []);
    assert.deepEqual(vision, [null, null]);

    context.service.fetchPublicPage = async () => '<html></html>';
    assert.equal(await context.service.verifyHighPriorityDealOnce(dealCandidate('bare', context.db)), false);
    assert.equal(status('bare'), 'unknown');
    assert.equal(vision.length, 2);
  } finally {
    restore();
    context.close();
  }
});

test('relevance: watch scans and manual searches reuse each other\'s verdicts by input hash and model', async () => {
  const restore = liveJevEnv();
  const titles: string[] = [];
  const context = fixture({
    classifyListingRelevanceWithJev: async (ctx: any) => { titles.push(ctx.title); return { relevant: !/box/.test(ctx.title), p: 0.9, unsure: false }; },
  });
  try {
    seedWatch(context.db, 'ps5', 'PS5');
    const search = { query: 'PS5', includedTerms: '', excludedTerms: '' };
    // Manual search first: two listings with the same input share one call.
    const manual = await context.service.filterListingsByAiRelevance([listing('a', 'PS5 console'), listing('b', 'PS5 console'), listing('c', 'PS5 empty box')], search, undefined, true);
    assert.deepEqual(titles, ['PS5 console', 'PS5 empty box']);
    assert.equal(manual.excluded, 1);

    // The watch scan reuses the manual verdicts, keeping their reasons.
    const watch = await context.service.filterListingsByAiRelevance([listing('d', 'PS5 console'), listing('e', 'PS5 empty box')], search, 'ps5', true);
    assert.equal(titles.length, 2);
    assert.deepEqual(watch.listings.map((item: any) => item.listingId), ['d']);
    assert.deepEqual(relevanceRows(context.db, 'ps5').map((row) => [row.listing_id, row.relevance_status, row.reason]), [
      ['d', 'relevant', 'Jev classified listing as relevant (p=0.90)'],
      ['e', 'irrelevant', 'Jev classified listing as irrelevant (p=0.90)'],
    ]);

    // A watch verdict serves a later manual search of the same input.
    await context.service.filterListingsByAiRelevance([listing('f', 'PS5 Slim 1TB')], search, 'ps5', true);
    assert.equal(titles.length, 3);
    assert.equal((context.db.prepare('SELECT COUNT(*) AS n FROM manual_relevance_cache').get() as { n: number }).n, 2, 'the watch verdict is not copied to the manual cache');
    const again = await context.service.filterListingsByAiRelevance([listing('g', 'PS5 Slim 1TB')], search, undefined, true);
    assert.equal(again.listings.length, 1);
    assert.equal(titles.length, 3);

    // The cross-listing lookup is scoped to the model: a new Jev model judges afresh.
    process.env.SCOUT_JEV_MODEL = '~typesafe/jev-next';
    await context.service.filterListingsByAiRelevance([listing('h', 'PS5 console')], search, undefined, true);
    assert.equal(titles.length, 4);
  } finally {
    delete process.env.SCOUT_JEV_MODEL;
    restore();
    context.close();
  }
});

test('negotiability: an unsure answer is remembered for the same text, then asked again after 14 days', async () => {
  const restore = liveJevEnv();
  let calls = 0;
  let answer: { decision: 'negotiable' | 'fixed' | 'unknown'; confidence: number; unsure: boolean } = { decision: 'unknown', confidence: 0.4, unsure: true };
  const context = fixture({ classifyNegotiabilityWithJev: async () => { calls += 1; return answer; } });
  try {
    const live = context.service.jevLiveConfig();
    const description = 'Konsola sprawna, odbiór osobisty.';
    assert.equal(await context.service.upgradeNegotiabilityFromDescription(dealCandidate('n-1', context.db), description, live), false);
    assert.equal(calls, 1);
    // Another listing (or a re-check) with the same text makes no call.
    assert.equal(await context.service.upgradeNegotiabilityFromDescription(dealCandidate('n-2', context.db), description, live), false);
    assert.equal(calls, 1);
    // New text is a new question.
    assert.equal(await context.service.upgradeNegotiabilityFromDescription(dealCandidate('n-3', context.db), `${description} Cena do negocjacji.`, live), false);
    assert.equal(calls, 2);
    // After the window the same text is asked again, and a confident answer is stored on the listing.
    context.db.prepare("UPDATE jev_fuzzy_cache SET checked_at = ? WHERE task = 'negotiability'").run(new Date(Date.now() - 15 * 86_400_000).toISOString());
    answer = { decision: 'negotiable', confidence: 0.9, unsure: false };
    assert.equal(await context.service.upgradeNegotiabilityFromDescription(dealCandidate('n-2'), description, live), true);
    assert.equal(calls, 3);
    assert.equal((context.db.prepare("SELECT price_negotiable AS n FROM listings WHERE listing_id = 'n-2'").get() as { n: number }).n, 1);
  } finally {
    restore();
    context.close();
  }
});

test('verification: a verdict comes back after a fetch error, a missing description or a text flap without an AI call', async () => {
  const restore = liveJevEnv();
  const jev: string[] = [];
  const vision: string[] = [];
  const context = fixture({
    verifyListingDescriptionWithJev: async (ctx: any) => {
      jev.push(ctx.description);
      return /maybe/.test(ctx.description) ? { decision: 'pass', confidence: 0.55, unsure: true } : { decision: 'pass', confidence: 0.9, unsure: false };
    },
    verifyListingDescriptionWithVision: async (input: any) => { vision.push(input.description); return { decision: 'pass', confidence: 0.8, issues: [], imagesSeen: 1 }; },
    classifyNegotiabilityWithJev: async () => ({ decision: 'fixed', confidence: 0.9, unsure: false }),
  });
  let page: string | null = detailPage('Works great, no scratches.');
  context.service.fetchPublicPage = async () => {
    if (page === null) throw new Error('HTTP 503');
    return page;
  };
  const verify = (listingId: string, seed = false) => context.service.verifyHighPriorityDealOnce(dealCandidate(listingId, seed ? context.db : undefined));
  const slot = (listingId: string) => (context.db.prepare('SELECT ai_description_verification_status AS status FROM listings WHERE listing_id = ?').get(listingId) as { status: string }).status;
  try {
    assert.equal(await verify('v-1', true), true);
    assert.equal(jev.length, 1);

    // A failed fetch overwrites the listing's slot; the next good fetch of the same text reuses the verdict.
    page = null;
    assert.equal(await verify('v-1'), false);
    assert.equal(slot('v-1'), 'unknown');
    page = detailPage('Works great, no scratches.');
    assert.equal(await verify('v-1'), true);
    assert.equal(slot('v-1'), 'pass');
    assert.equal(jev.length, 1);

    // So does a page that briefly shows no description.
    page = '<html></html>';
    assert.equal(await verify('v-1'), false);
    page = detailPage('Works great, no scratches.');
    assert.equal(await verify('v-1'), true);
    assert.equal(jev.length, 1);

    // A -> B -> A: B is new text, the way back to A is not.
    page = detailPage('Works great, small scratch on the side.');
    assert.equal(await verify('v-1'), true);
    assert.equal(jev.length, 2);
    page = detailPage('Works great, no scratches.');
    assert.equal(await verify('v-1'), true);
    assert.equal(jev.length, 2);

    // A text-only verdict serves another listing with the same input.
    assert.equal(await verify('v-2', true), true);
    assert.equal(jev.length, 2);

    // A vision verdict rests on one listing's photos: only that listing reuses it.
    page = detailPage('maybe works');
    assert.equal(await verify('m-1', true), true);
    assert.equal(await verify('m-2', true), true);
    assert.deepEqual(vision, ['maybe works', 'maybe works']);
    page = null;
    await verify('m-1');
    page = detailPage('maybe works');
    assert.equal(await verify('m-1'), true);
    assert.equal(vision.length, 2);
    assert.equal(jev.length, 4);

    // After 7 days the same input is judged again.
    context.db.prepare('UPDATE description_verification_cache SET checked_at = ?').run(new Date(Date.now() - 8 * 86_400_000).toISOString());
    page = null;
    await verify('v-1');
    page = detailPage('Works great, no scratches.');
    assert.equal(await verify('v-1'), true);
    assert.equal(jev.length, 5);

    // Every logged call carries its wall time.
    const durations = context.db.prepare('SELECT task, duration_ms FROM jev_shadow_log').all() as Array<{ task: string; duration_ms: number | null }>;
    assert.ok(durations.length >= 5);
    assert.ok(durations.every((row) => typeof row.duration_ms === 'number' && row.duration_ms >= 0), JSON.stringify(durations));

    context.service.resetAiResults();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS n FROM description_verification_cache').get() as { n: number }).n, 0);
  } finally {
    restore();
    context.close();
  }
});

test('manual-search checks: every Jev call is logged with its duration, failures included', async () => {
  const restore = liveJevEnv();
  let fail = false;
  const context = fixture({
    classifyChecksWithJev: async (ctx: any) => {
      if (fail) throw new Error('provider down');
      return ctx.checks.map((check: any) => ({ text: check.text, mode: check.mode, answer: 'yes', confidence: 0.9, outcome: 'satisfied' }));
    },
  });
  try {
    const checks = [{ mode: 'require', text: 'original box' }];
    context.service.detailHtml = async () => detailPage('Original box included.');
    const first = await context.service.applySearchChecks([listing('c-1', 'PS5 console')], checks);
    assert.equal(first.failed, 0);
    fail = true;
    const second = await context.service.applySearchChecks([listing('c-2', 'PS5 console')], checks);
    assert.equal(second.failed, 1);
    const log = context.db.prepare("SELECT jev_error IS NOT NULL AS failed, duration_ms FROM jev_shadow_log WHERE task = 'checks' ORDER BY id").all() as Array<{ failed: number; duration_ms: number | null }>;
    assert.deepEqual(log.map((row) => row.failed), [0, 1]);
    assert.ok(log.every((row) => typeof row.duration_ms === 'number'));
  } finally {
    restore();
    context.close();
  }
});
