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
