import { after } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService, type ScoutServiceDependencies } from '../server/service';

// Shared by the manual-search test files: a migrated database per test, the
// live-Jev environment switch, and OLX offers-API rows.

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const templateDirectory = mkdtempSync(join(tmpdir(), 'scout-search-template-'));
after(() => rmSync(templateDirectory, { recursive: true, force: true }));
let template: string | undefined;

export function searchFixture(dependencies: ScoutServiceDependencies = {}) {
  if (!template) {
    template = join(templateDirectory, 'scout.sqlite');
    openDatabase(template).close();
  }
  const directory = mkdtempSync(join(tmpdir(), 'scout-search-'));
  const path = join(directory, 'scout.sqlite');
  copyFileSync(template, path);
  const db = openDatabase(path);
  const events: Array<{ event: string; payload: any }> = [];
  const service = new ScoutService(db, (event, payload) => { events.push({ event, payload }); }, { suggestVariantGroups: async () => [], ...dependencies });
  return { db, service, events, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

/** Live Jev with a fake key; returns the restore function. */
export function liveJevEnv() {
  const previous = {
    mode: process.env.SCOUT_JEV_MODE,
    key: process.env.SCOUT_OPENROUTER_API_KEY,
    legacy: process.env.OPENROUTER_API_KEY,
    deep: process.env.SCOUT_DEEPSEEK_API_KEY,
  };
  process.env.SCOUT_JEV_MODE = 'live';
  process.env.SCOUT_OPENROUTER_API_KEY = 'sk-or-v1-test';
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.SCOUT_DEEPSEEK_API_KEY;
  return () => {
    if (previous.mode === undefined) delete process.env.SCOUT_JEV_MODE;
    else process.env.SCOUT_JEV_MODE = previous.mode;
    if (previous.key === undefined) delete process.env.SCOUT_OPENROUTER_API_KEY;
    else process.env.SCOUT_OPENROUTER_API_KEY = previous.key;
    if (previous.legacy !== undefined) process.env.OPENROUTER_API_KEY = previous.legacy;
    if (previous.deep !== undefined) process.env.SCOUT_DEEPSEEK_API_KEY = previous.deep;
  };
}

/** One OLX offers-API row; `state` is the condition label OLX shows. */
export function olxOffer(id: string, title: string, price: number, state?: string) {
  return {
    id, url: `https://www.olx.pl/d/oferta/${id.toLowerCase()}`, title, created_time: new Date().toISOString(),
    params: [{ key: 'price', value: { value: price, currency: 'PLN', negotiable: false } }, ...(state ? [{ key: 'state', value: { label: state } }] : [])],
  };
}

export function olxPage(offers: unknown[]) {
  return { status: 200, json: { data: offers, metadata: { visible_total_count: offers.length } } };
}

/** The plain manual-search input every test starts from. */
export function searchInput(query: string, overrides: Record<string, unknown> = {}) {
  return { query, sources: ['OLX' as const], terms: '', excluded: '', minPrice: null, maxPrice: null, shippingOnly: false, condition: 'Any', ...overrides };
}
