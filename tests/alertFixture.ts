import { after } from 'node:test';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService, type ScoutServiceDependencies } from '../server/service';

// Shared by the alert test files: a migrated database per test, a watch,
// an OLX listing, and stubbed Discord/ntfy responses.

const templateDirectory = mkdtempSync(join(tmpdir(), 'scout-alert-template-'));
after(() => rmSync(templateDirectory, { recursive: true, force: true }));
let template: string | undefined;

export function alertFixture(dependencies: ScoutServiceDependencies = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-alert-'));
  if (!template) {
    template = join(templateDirectory, 'scout.sqlite');
    openDatabase(template).close();
  }
  copyFileSync(template, join(directory, 'scout.sqlite'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [], ...dependencies });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

export function seedWatch(db: any, id: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, 'cpu', '["OLX"]', 1, ?, ?, ?)`).run(id, `${id} name`, now, now, now);
}

export function listing(listingId: string, price = 800) {
  return { marketplace: 'OLX' as const, listingId, title: `CPU ${listingId}`, price, currency: 'PLN' as const, url: `https://www.olx.pl/d/oferta/${listingId}`, observedAt: new Date().toISOString() };
}

/** Stubs fetch for the alert channels; `reply` picks each response. */
export function stubChannels(reply: (url: string, call: number) => number) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; body: any }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(null, { status: reply(url, calls.length) });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

export const deliveries = (db: any) => db.prepare('SELECT listing_key, channel, status, attempt_count, next_attempt_at, message FROM notification_deliveries ORDER BY id').all() as Array<{ listing_key: string; channel: string; status: string; attempt_count: number; next_attempt_at: string | null; message: string | null }>;
