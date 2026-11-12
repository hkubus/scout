// GET /api/listings?excludeFlags= against a real Scout: server/index.ts's
// query parsing, the auth hook, and the quick-flag backfill it starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/db';

async function freePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** Listings saved before quick flags existed: no flags_json, so the startup backfill stores them. */
function seed(databasePath: string) {
  const db = openDatabase(databasePath);
  const now = new Date().toISOString();
  // Disabled, so the scheduler never fetches a marketplace.
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES ('route-watch', 'Route watch', 'iphone 13', '["OLX"]', 0, ?, ?, ?)`).run(now, now, now);
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, condition, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertLink = db.prepare('INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)');
  const rows: Array<[string, string, number, string | null]> = [
    ['clean', 'iPhone 13 128GB', 1000, null],
    ['parts', 'iPhone 13 na części', 400, null],
    ['locked', 'iPhone 13 blokada iCloud', 500, null],
    ['damaged', 'iPhone 13 zbity ekran', 600, 'Uszkodzone'],
    ['case', 'Etui iPhone 13', 50, null],
  ];
  for (const [id, title, price, condition] of rows) {
    const { lastInsertRowid } = insertListing.run('OLX', id, title, price, condition, `https://www.olx.pl/d/oferta/${id}`, now, now);
    insertLink.run('route-watch', lastInsertRowid, now, now);
  }
  db.close();
}

async function startScout(token: string) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-listings-route-'));
  const dist = join(directory, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Scout</title>');
  const databasePath = join(directory, 'scout.sqlite');
  seed(databasePath);
  const port = await freePort();
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SCOUT_')));
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    env: {
      ...inherited, PORT: String(port), SCOUT_HOST: '127.0.0.1', SCOUT_DB_PATH: databasePath, SCOUT_DIST_PATH: dist,
      SCOUT_SECRET: randomBytes(32).toString('hex'), SCOUT_API_TOKENS: token, SCOUT_SKIP_MIGRATION_BACKUP: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Scout did not start:\n${output}`)), 90_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('Server listening')) { clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Scout exited (${code}):\n${output}`)); });
  });
  return {
    origin: `http://127.0.0.1:${port}`,
    output: () => output,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('GET /api/listings takes excludeFlags over stored flags, after the startup backfill stores them', async () => {
  const token = randomBytes(24).toString('hex');
  const scout = await startScout(token);
  try {
    const get = (query: string, authorized = true) => fetch(`${scout.origin}/api/listings?sort=price&${query}`, { headers: authorized ? { authorization: `Bearer ${token}` } : {} });
    const page = async (query: string) => {
      const response = await get(query);
      assert.equal(response.status, 200, query);
      const body = await response.json() as { listings: Array<{ listingId: string; flags?: Array<{ flag: string }> }>; pagination: { total: number } };
      return { ids: body.listings.map((listing) => listing.listingId), total: body.pagination.total, flags: Object.fromEntries(body.listings.map((listing) => [listing.listingId, (listing.flags ?? []).map((flag) => flag.flag)])) };
    };

    // The backfill runs right after startup; wait for it rather than for a fixed time.
    let kept = await page('excludeFlags=for_parts,locked,damaged');
    for (let attempt = 0; kept.total !== 2 && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      kept = await page('excludeFlags=for_parts,locked,damaged');
    }
    assert.deepEqual(kept, { ids: ['case', 'clean'], total: 2, flags: { case: ['accessory'], clean: [] } }, scout.output());
    assert.match(scout.output(), /stored quick flags on 5 listings/);

    const all = await page('');
    assert.equal(all.total, 5);
    assert.deepEqual(all.flags, { case: ['accessory'], parts: ['for_parts'], locked: ['locked'], damaged: ['damaged'], clean: [] });
    // Names are trimmed and deduplicated; the total follows the filter across pages.
    assert.deepEqual(await page('excludeFlags=%20for_parts%2Cfor_parts%2C&pageSize=1'), { ids: ['case'], total: 4, flags: { case: ['accessory'] } });

    // accessory depends on the query and is never stored, so the feed refuses it.
    for (const query of ['excludeFlags=accessory', 'excludeFlags=bogus', 'excludeFlags=for_parts,verification_reject']) {
      const response = await get(query);
      assert.equal(response.status, 400, query);
      assert.deepEqual(await response.json(), { error: 'Invalid listing filters' });
    }
    assert.equal((await get('excludeFlags=for_parts', false)).status, 401);
  } finally {
    await scout.stop();
  }
});
