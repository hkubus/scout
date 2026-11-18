import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../server/db';
import { REDACTED } from '../server/debug';
import { buildImprovementExport, IMPROVEMENT_EXPORT_FORMAT, IMPROVEMENT_TABLES, improvementContext, improvementExportStream } from '../server/improvementExport';
import { encryptSecret, ScoutService, ServiceError } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const WEBHOOK = encryptSecret('https://discord.com/api/webhooks/1/secret-webhook');
const API_KEY = encryptSecret('sk-or-v1-encrypted-key');
const SESSION = encryptSecret('{"cookies":[{"name":"sid","value":"session-cookie"}]}');
// Values that must never appear anywhere in the exported file's bytes.
const SECRETS = [WEBHOOK, API_KEY, SESSION, 'sk-or-v1-plain-legacy', 'auth-token-hash', '203.0.113.9', 'oauth-code-hash', 'app-token-hash', 'Konto kubus@example.com', 'PHOTO-BYTES-MARKER', 'SNAPSHOT-IMAGE-MARKER', 'FUTURE-TABLE-MARKER'];
const PRIVATE_MARKERS = ['FLIP-NOTE-MARKER', 'OUTCOME-NOTE-MARKER'];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-improvement-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, {});
  return { db, service, directory, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seed(db: any) {
  const now = new Date().toISOString();
  const run = (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params);
  run("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discord_webhook', ?, ?), ('openrouter_api_key', ?, ?), ('legacy_api_key', 'sk-or-v1-plain-legacy', ?), ('deepseek_model', 'deepseek/deepseek-v4-flash', ?)", WEBHOOK, now, API_KEY, now, now, now);
  run("INSERT INTO marketplace_sessions (marketplace, label, storage_state_encrypted, created_at, updated_at, signed_in, check_detail) VALUES ('OLX', 'Konto kubus@example.com', ?, ?, ?, 1, 'Signed in')", SESSION, now, now);
  run("INSERT INTO auth_sessions (token_hash, credential_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES ('auth-token-hash', 'password', ?, ?, ?, '203.0.113.9', 'Firefox')", now, now, now);
  run("INSERT INTO oauth_clients (id, name, redirect_uris_json, created_at) VALUES ('client-1', 'Hatbot', '[]', ?)", now);
  run("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at) VALUES ('oauth-code-hash', 'client-1', 'https://example.com/cb', 'challenge', ?)", now);
  run("INSERT INTO connected_app_tokens (token_hash, client_id, client_name, created_at) VALUES ('app-token-hash', 'client-1', 'Hatbot', ?)", now);

  run("INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES ('watch-1', 'RTX 3070', 'rtx 3070', '[\"OLX\"]', 1, ?, ?, ?)", now, now, now);
  const listing = run("INSERT INTO listings (marketplace, listing_id, title, price_pln, typical_pln, url, first_seen_at, last_seen_at) VALUES ('OLX', 'olx-1', 'RTX 3070 Gaming', 1100, 1400, 'https://www.olx.pl/d/oferta/olx-1', ?, ?)", now, now).lastInsertRowid;
  run("INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, 'watch-1', 1100, ?)", listing, now);
  run("INSERT INTO listing_actions (marketplace, listing_id, decision, note, hidden, updated_at) VALUES ('OLX', 'olx-1', 'buy', 'cheap, check fans', 0, ?)", now);

  const flip = run("INSERT INTO flips (title, buy_channel, bought_on, buy_price_pln, note, created_at, updated_at) VALUES ('RTX 3070', 'OLX', '2026-11-01', 1100, 'FLIP-NOTE-MARKER', ?, ?)", now, now).lastInsertRowid;
  run("INSERT INTO flip_photos (flip_id, position, mime, data, byte_size, created_at) VALUES (?, 0, 'image/jpeg', ?, 18, ?)", flip, Buffer.from('PHOTO-BYTES-MARKER'), now);
  run("INSERT INTO negotiation_outcomes (negotiation_id, marketplace, listing_id, role, outcome, asking_price_pln, final_price_pln, decided_on, note, created_at, updated_at) VALUES ('n-1', 'OLX', 'olx-1', 'buy', 'agreed', 1200, 1100, '2026-11-01', 'OUTCOME-NOTE-MARKER', ?, ?)", now, now);

  // Only the image's bytes matter here, so skip the research watch it belongs to.
  db.exec('PRAGMA foreign_keys = OFF');
  run("INSERT INTO market_listing_snapshot_images (snapshot_id, position, source_url, mime_type, byte_size, data) VALUES (999, 0, 'https://cdn.example/1.jpg', 'image/jpeg', 21, ?)", Buffer.from('SNAPSHOT-IMAGE-MARKER'));
  db.exec('PRAGMA foreign_keys = ON');

  // A table a future migration adds without classifying it for the export.
  db.exec("CREATE TABLE future_table (value TEXT); INSERT INTO future_table VALUES ('FUTURE-TABLE-MARKER');");
}

const context = (service: ScoutService) => {
  const live = improvementContext(service);
  return { ...live, logs: [...live.logs, { id: 1, at: new Date().toISOString(), level: 'error', scope: 'watch', message: `OLX scan failed with ${WEBHOOK}` }] };
};

const leftovers = (directory: string) => readdirSync(directory).filter((name) => name.includes('.improvement-'));

test('every table Scout creates is classified for the improvement export', () => {
  const { db, close } = fixture();
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((row) => row.name);
    const unclassified = tables.filter((name) => !IMPROVEMENT_TABLES[name]);
    assert.deepEqual(unclassified, [], 'decide in IMPROVEMENT_TABLES whether each new table may leave the server');
  } finally { close(); }
});

test('the improvement export copies the data, redacts credentials and describes itself', async () => {
  const { db, service, directory, close } = fixture();
  try {
    seed(db);
    const file = await buildImprovementExport(db, { includePrivate: true, context: context(service) });
    try {
      assert.match(file.filename, /^scout-improvement-\d{4}-\d{2}-\d{2}T[\d-]+Z\.sqlite$/);
      const bytes = readFileSync(file.path);
      assert.equal(file.bytes, bytes.byteLength);
      for (const secret of SECRETS) assert.equal(bytes.includes(secret), false, `${secret} must not be in the file`);
      for (const marker of PRIVATE_MARKERS) assert.equal(bytes.includes(marker), true, `${marker} is exported when private records are included`);

      const out = new DatabaseSync(file.path, { readOnly: true });
      try {
        const all = (sql: string) => out.prepare(sql).all() as Array<Record<string, any>>;
        const count = (table: string) => Number((out.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
        assert.deepEqual(all("SELECT title, price_pln, typical_pln FROM listings").map((row) => ({ ...row })), [{ title: 'RTX 3070 Gaming', price_pln: 1100, typical_pln: 1400 }]);
        assert.equal(count('observations'), 1);
        assert.equal(all('SELECT decision, note FROM listing_actions')[0].note, 'cheap, check fans');
        assert.equal(count('flips'), 1);
        assert.equal(count('negotiation_outcomes'), 1);

        const settings = new Map(all('SELECT key, value FROM settings').map((row) => [row.key, row.value]));
        assert.equal(settings.get('discord_webhook'), REDACTED);
        assert.equal(settings.get('openrouter_api_key'), REDACTED);
        assert.equal(settings.get('legacy_api_key'), REDACTED);
        assert.equal(settings.get('deepseek_model'), 'deepseek/deepseek-v4-flash');
        assert.equal(settings.get('default_interval'), '5');

        assert.deepEqual({ ...all('SELECT label, storage_state_encrypted, signed_in, check_detail FROM marketplace_sessions')[0] }, { label: '', storage_state_encrypted: REDACTED, signed_in: 1, check_detail: 'Signed in' });
        for (const table of ['auth_sessions', 'oauth_clients', 'oauth_codes', 'connected_app_tokens', 'future_table']) assert.equal(count(table), 0, table);
        // Photos keep their records but not their bytes.
        assert.deepEqual({ ...all('SELECT byte_size, length(data) AS stored FROM flip_photos')[0] }, { byte_size: 18, stored: 0 });
        assert.deepEqual({ ...all('SELECT byte_size, length(data) AS stored FROM market_listing_snapshot_images')[0] }, { byte_size: 21, stored: 0 });

        const info = new Map(all('SELECT key, value FROM export_info').map((row) => [row.key, row.value]));
        assert.equal(info.get('format'), IMPROVEMENT_EXPORT_FORMAT);
        assert.equal(info.get('includes_private'), 'true');
        assert.match(String(info.get('note')), /asking prices/);
        assert.equal(JSON.parse(String(info.get('readiness'))).database.ok, true);
        assert.ok(Array.isArray(JSON.parse(String(info.get('connectors')))));
        assert.equal(typeof JSON.parse(String(info.get('runtime'))).node, 'string');
        const recordedSettings = JSON.parse(String(info.get('settings')));
        assert.equal(recordedSettings.ai.model, 'deepseek/deepseek-v4-flash');
        assert.equal(recordedSettings.marketplaceSessions.find((session: { marketplace: string }) => session.marketplace === 'OLX').label, undefined);

        assert.deepEqual(all('SELECT scope, message FROM export_logs').map((row) => ({ ...row })), [{ scope: 'watch', message: `OLX scan failed with ${REDACTED}` }]);

        const guide = new Map(all('SELECT name, rows, contents, handling FROM export_tables').map((row) => [row.name, row]));
        const tables = all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'export_%'").map((row) => row.name);
        assert.deepEqual([...guide.keys()].sort(), tables.sort(), 'the guide lists every table');
        for (const name of tables) assert.equal(guide.get(name)?.rows, count(name), name);
        assert.equal(guide.get('listings')?.handling, 'copied');
        assert.equal(guide.get('flip_photos')?.handling, 'copied; image bytes removed');
        assert.equal(guide.get('auth_sessions')?.handling, 'emptied: credentials or sign-in records');
        assert.equal(guide.get('future_table')?.handling, 'emptied: not yet classified for this export');
        assert.equal(guide.get('future_table')?.contents, null);
        assert.match(String(guide.get('listing_actions')?.contents), /triage/);
      } finally { out.close(); }
    } finally { file.cleanup(); }
    assert.deepEqual(leftovers(directory), []);
    // The live database is untouched.
    assert.equal((db.prepare("SELECT value FROM settings WHERE key = 'discord_webhook'").get() as { value: string }).value, WEBHOOK);
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').get() as { count: number }).count, 1);
  } finally { close(); }
});

test('leaving private records out empties the flip ledger and negotiation outcomes', async () => {
  const { db, service, close } = fixture();
  try {
    seed(db);
    const file = await buildImprovementExport(db, { includePrivate: false, context: context(service) });
    try {
      const bytes = readFileSync(file.path);
      for (const marker of [...SECRETS, ...PRIVATE_MARKERS]) assert.equal(bytes.includes(marker), false, `${marker} must not be in the file`);
      const out = new DatabaseSync(file.path, { readOnly: true });
      try {
        const handling = new Map((out.prepare('SELECT name, rows, handling FROM export_tables').all() as Array<{ name: string; rows: number; handling: string }>).map((row) => [row.name, row]));
        for (const table of ['flips', 'flip_photos', 'negotiation_outcomes']) assert.deepEqual({ ...handling.get(table) }, { name: table, rows: 0, handling: 'emptied: private records left out' });
        assert.equal(handling.get('listing_actions')?.rows, 1);
        assert.equal((out.prepare("SELECT value FROM export_info WHERE key = 'includes_private'").get() as { value: string }).value, 'false');
      } finally { out.close(); }
    } finally { file.cleanup(); }
  } finally { close(); }
});

test('one improvement export at a time, until its file is cleaned up', async () => {
  const { db, service, directory, close } = fixture();
  try {
    const first = await buildImprovementExport(db, { includePrivate: true, context: context(service) });
    await assert.rejects(buildImprovementExport(db, { includePrivate: true, context: context(service) }), (error: unknown) => error instanceof ServiceError && error.status === 409);
    first.cleanup();
    first.cleanup();
    const second = await buildImprovementExport(db, { includePrivate: true, context: context(service) });
    second.cleanup();
    assert.deepEqual(leftovers(directory), []);
  } finally { close(); }
});

test('the download stream deletes the file when it ends or stalls, freeing the next export', async () => {
  const { db, service, directory, close } = fixture();
  try {
    const file = await buildImprovementExport(db, { includePrivate: true, context: context(service) });
    let read = 0;
    for await (const chunk of improvementExportStream(file)) read += (chunk as Buffer).byteLength;
    assert.equal(read, file.bytes);
    assert.deepEqual(leftovers(directory), []);

    // Nobody reads this one: it is stopped after maxOpenMs.
    const stalled = await buildImprovementExport(db, { includePrivate: true, context: context(service) });
    const stream = improvementExportStream(stalled, 50);
    let failure: Error | undefined;
    stream.on('error', (error) => { failure = error; });
    await new Promise<void>((resolve) => stream.once('close', () => resolve()));
    assert.match(String(failure?.message), /exceeded 50 ms/);
    assert.deepEqual(leftovers(directory), []);
    (await buildImprovementExport(db, { includePrivate: true, context: context(service) })).cleanup();
  } finally { close(); }
});

test('a cancelled or failed build leaves no file behind and frees the next export', async () => {
  const { db, service, directory, close } = fixture();
  try {
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(buildImprovementExport(db, { includePrivate: true, context: context(service), signal: cancelled.signal }), /cancelled/);
    assert.deepEqual(leftovers(directory), []);

    const stopping = new AbortController();
    const pending = buildImprovementExport(db, { includePrivate: true, context: context(service), signal: stopping.signal });
    setImmediate(() => stopping.abort());
    await assert.rejects(pending, /cancelled/);
    assert.deepEqual(leftovers(directory), []);

    const file = await buildImprovementExport(db, { includePrivate: true, context: context(service) });
    file.cleanup();
  } finally { close(); }
});

test('an in-memory database cannot be exported', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    await assert.rejects(buildImprovementExport(db, { includePrivate: true, context: { info: {}, logs: [] } }), (error: unknown) => error instanceof ServiceError && error.status === 409);
  } finally { db.close(); }
});
