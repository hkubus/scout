import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toCompactSearch } from '../server/mcpFormat';
import { olxOffer, olxPage, searchFixture, searchInput } from './searchFixture';

// P2-6: manual search skips a marketplace whose connector is backed off,
// reads the backoff only, and searches it anyway with ignoreBackoff.

const vintedApi = JSON.parse(readFileSync(new URL('./fixtures-vinted-api.json', import.meta.url), 'utf8'));

function seedRun(db: any, source: string, status: string, startedAt: string, backoffUntil: string | null = null) {
  db.prepare('INSERT INTO connector_runs (source, status, message, started_at, finished_at, backoff_until) VALUES (?, ?, ?, ?, ?, ?)')
    .run(source, status, status, startedAt, startedAt, backoffUntil);
}

const count = (db: any, table: string) => (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;

test('skips a backed-off marketplace without a request, and reports when the pause ends', async () => {
  const context = searchFixture();
  let fetches = 0;
  (context.service as any).fetchOlxApi = async () => { fetches += 1; return olxPage([olxOffer('B-1', 'Steam Deck', 1500)]); };
  try {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    seedRun(context.db, 'OLX', 'error', new Date().toISOString(), until);
    const runs = count(context.db, 'connector_runs');
    const scans = count(context.db, 'scans');
    const result = await context.service.manualSearchDetailed(searchInput('steam deck', { searchId: 'paused-1' }));
    assert.equal(fetches, 0);
    assert.equal(result.listings.length, 0);
    const [status] = result.sources;
    assert.deepEqual({ ...status, message: '' }, { source: 'OLX', status: 'error', count: 0, pendingShipping: 0, durationMs: 0, message: '', backoffUntil: until });
    assert.ok(status.message.includes(until));
    assert.equal(result.details.sources.get('OLX')?.errorKind, 'backoff');
    // The web placeholder resolves through the progress stream as usual.
    const progress = context.events.filter((entry) => entry.event === 'search');
    assert.equal(progress.length, 1);
    assert.equal(progress[0].payload.searchId, 'paused-1');
    assert.equal(progress[0].payload.status.backoffUntil, until);
    // Read-only: no connector run and no scan row.
    assert.equal(count(context.db, 'connector_runs'), runs);
    assert.equal(count(context.db, 'scans'), scans);

    const compact = toCompactSearch({ query: 'steam deck' }, result);
    assert.equal(compact.sources[0].errorKind, 'backoff');
    assert.equal(compact.sources[0].backoffUntil, until);
  } finally { context.close(); }
});

test('ignoreBackoff searches the paused marketplace and leaves the pause in place', async () => {
  const context = searchFixture();
  let fetches = 0;
  (context.service as any).fetchOlxApi = async () => { fetches += 1; return olxPage([olxOffer('B-2', 'Steam Deck', 1500)]); };
  try {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    seedRun(context.db, 'OLX', 'error', new Date().toISOString(), until);
    const result = await context.service.manualSearch(searchInput('steam deck', { ignoreBackoff: true }));
    assert.equal(fetches, 1);
    assert.equal(result.sources[0].status, 'ok');
    assert.equal(result.listings.length, 1);
    assert.equal((context.service as any).activeConnectorBackoff('OLX'), until);
  } finally { context.close(); }
});

test('searches a marketplace whose pause has ended, even after a skipped run', async () => {
  const context = searchFixture();
  let fetches = 0;
  (context.service as any).fetchOlxApi = async () => { fetches += 1; return olxPage([olxOffer('B-3', 'Steam Deck', 1500)]); };
  try {
    seedRun(context.db, 'OLX', 'error', new Date(Date.now() - 20 * 60_000).toISOString(), new Date(Date.now() - 60_000).toISOString());
    seedRun(context.db, 'OLX', 'skipped', new Date(Date.now() - 30_000).toISOString());
    const result = await context.service.manualSearch(searchInput('steam deck'));
    assert.equal(fetches, 1);
    assert.equal(result.sources[0].status, 'ok');
  } finally { context.close(); }
});

test('only the paused marketplace is skipped, and ok statuses keep their keys', async () => {
  const context = searchFixture();
  (context.service as any).fetchOlxApi = async () => { throw new Error('OLX must not be fetched while paused'); };
  (context.service as any).fetchVintedApi = async () => ({ status: 200, json: structuredClone(vintedApi.search) });
  (context.service as any).fetchVintedItemPage = async () => ({ status: 403, body: '' });
  (context.service as any).fetchPublicPage = async (url: string) => { throw new Error(`unexpected public page fetch: ${url}`); };
  try {
    seedRun(context.db, 'OLX', 'error', new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());
    const result = await context.service.manualSearch(searchInput('lego', { sources: ['OLX', 'Vinted'], aiRelevance: false }));
    const [olx, vinted] = result.sources;
    assert.equal(olx.status, 'error');
    assert.ok(olx.backoffUntil);
    assert.equal(vinted.status, 'ok', vinted.message);
    assert.deepEqual(Object.keys(vinted), ['source', 'status', 'count', 'pendingShipping', 'durationMs', 'message']);
    assert.ok(result.listings.length > 0);
    assert.ok(result.listings.every((listing) => listing.marketplace === 'Vinted'));
  } finally { context.close(); }
});
