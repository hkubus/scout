import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDatabase } from '../server/db';
import { REDACTED, ScoutDebug } from '../server/debug';
import { SCOUT_MCP_DEBUG_TOOL_NAMES, SCOUT_MCP_TOOL_NAMES, createScoutMcpServer } from '../server/mcp';
import { encryptSecret, ScoutService, ServiceError } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

function fixture(queryTimeoutMs?: number) {
  const directory = mkdtempSync(join(tmpdir(), 'scout-debug-'));
  const path = join(directory, 'scout.sqlite');
  const db = openDatabase(path);
  const service = new ScoutService(db, () => {}, {});
  const debug = new ScoutDebug(db, service, path, queryTimeoutMs);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('discord_webhook', encryptSecret('https://discord.com/api/webhooks/1/secret'), now);
  return { db, debug, service, directory, close: () => { debug.close(); db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('schema lists every table with columns, row counts, and migrations', () => {
  const context = fixture();
  try {
    const schema = context.debug.schema();
    const settings = schema.tables.find((table) => table.name === 'settings');
    assert.ok(settings);
    assert.ok(settings.rowCount >= 3);
    assert.ok(settings.columns.some((column) => column.name === 'key' && column.primaryKey === 1));
    assert.ok(schema.tables.some((table) => table.name === 'listings'));
    assert.ok(schema.migrations.some((migration) => migration.id === '001_init'));
    assert.ok(Number(schema.database.bytes) > 0);
  } finally { context.close(); }
});

test('table rows and queries redact encrypted secrets', async () => {
  const context = fixture();
  try {
    const rows = context.debug.tableRows('settings', { orderBy: 'key', direction: 'asc' });
    assert.equal(rows.rows.find((row) => row.key === 'discord_webhook')?.value, REDACTED);
    assert.equal(rows.rows.find((row) => row.key === 'default_interval')?.value, '5');

    const result = await context.debug.query("SELECT key, value FROM settings WHERE key = ?", ['discord_webhook']);
    assert.deepEqual(result.columns, ['key', 'value']);
    assert.deepEqual(result.rows, [{ key: 'discord_webhook', value: REDACTED }]);
    assert.equal(result.truncated, false);

    // Wrapping the ciphertext in an expression must not slip past redaction.
    const wrapped = await context.debug.query("SELECT 'x ' || value || ' y' AS v FROM settings WHERE key = 'discord_webhook'");
    assert.equal(wrapped.rows[0].v, `x ${REDACTED} y`);
    context.db.prepare('INSERT INTO marketplace_sessions (marketplace, storage_state_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?)').run('OLX', encryptSecret('{"cookies":[]}'), 'now', 'now');
    const session = await context.debug.query("SELECT hex(storage_state_encrypted) AS h FROM marketplace_sessions");
    assert.equal(session.rows[0].h, '');

    assert.throws(() => context.debug.tableRows('nope'), (error: unknown) => error instanceof ServiceError && error.status === 404);
    assert.throws(() => context.debug.tableRows('settings', { orderBy: 'missing' }), ServiceError);
  } finally { context.close(); }
});

test('query caps rows and refuses to write', async () => {
  const context = fixture();
  try {
    const capped = await context.debug.query('WITH RECURSIVE n(i) AS (VALUES (1) UNION ALL SELECT i + 1 FROM n WHERE i < 50) SELECT i FROM n', [], 10);
    assert.equal(capped.rowCount, 10);
    assert.equal(capped.truncated, true);

    assert.equal((await context.debug.query('-- comment\n/* block */ SELECT 1 AS one')).rows[0].one, 1);
    await assert.rejects(() => context.debug.query("DELETE FROM settings"), /Only SELECT/);
    await assert.rejects(() => context.debug.query("ATTACH DATABASE 'x.sqlite' AS x"), /Only SELECT/);
    await assert.rejects(() => context.debug.query("VACUUM INTO 'x.sqlite'"), /Only SELECT/);
    // A write disguised behind a CTE still hits the read-only connection.
    await assert.rejects(() => context.debug.query("WITH x AS (SELECT 1) DELETE FROM settings"), /SQL error/);
    assert.ok(Number((context.db.prepare('SELECT COUNT(*) AS count FROM settings').get() as { count: number }).count) >= 3);
    await assert.rejects(() => context.debug.query('SELECT * FROM missing_table'), /SQL error/);
  } finally { context.close(); }
});

test('a runaway query is stopped at the deadline without blocking the event loop', async () => {
  const context = fixture(500);
  try {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 20);
    const started = Date.now();
    await assert.rejects(
      () => context.debug.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c'),
      (error: unknown) => error instanceof ServiceError && /time limit/.test(error.message),
    );
    clearInterval(timer);
    assert.ok(Date.now() - started < 5_000);
    assert.ok(ticks >= 5, `event loop stalled (${ticks} ticks)`);
    assert.equal((await context.debug.query('SELECT 1 AS one')).rows[0].one, 1);
  } finally { context.close(); }
});

test('snapshot copies the database with credentials blanked and cleans up', () => {
  const context = fixture();
  try {
    context.db.prepare('INSERT INTO marketplace_sessions (marketplace, storage_state_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?)').run('OLX', encryptSecret('{"cookies":[]}'), 'now', 'now');
    const snapshot = context.debug.snapshot();
    const copy = new DatabaseSync(snapshot.path, { readOnly: true });
    try {
      assert.equal((copy.prepare("SELECT value FROM settings WHERE key = 'discord_webhook'").get() as { value: string }).value, REDACTED);
      assert.equal((copy.prepare("SELECT value FROM settings WHERE key = 'default_interval'").get() as { value: string }).value, '5');
      assert.equal((copy.prepare('SELECT storage_state_encrypted AS state FROM marketplace_sessions').get() as { state: string }).state, REDACTED);
    } finally { copy.close(); }
    snapshot.cleanup();
    assert.deepEqual(readdirSync(context.directory).filter((file) => file.includes('.debug-')), []);
  } finally { context.close(); }
});

test('debug MCP tools are registered only when a debug instance is provided', async () => {
  const context = fixture();
  try {
    for (const withDebug of [false, true]) {
      const server = createScoutMcpServer(context.service, withDebug ? context.debug : null);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'scout-debug-test', version: '1.0.0' });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
        const expected = withDebug ? [...SCOUT_MCP_TOOL_NAMES, ...SCOUT_MCP_DEBUG_TOOL_NAMES] : [...SCOUT_MCP_TOOL_NAMES];
        assert.deepEqual(names, expected.sort());
        if (withDebug) {
          const result = await client.callTool({ name: 'scout_debug_query', arguments: { sql: 'SELECT COUNT(*) AS count FROM watches' } }) as { content: Array<{ text?: string }> };
          assert.deepEqual(JSON.parse(String(result.content[0].text)).rows, [{ count: 0 }]);
        }
      } finally {
        await client.close();
        await server.close();
      }
    }
  } finally { context.close(); }
});

test('the private flip ledger is hidden from tables, read-only SQL and snapshots', async () => {
  const context = fixture();
  try {
    context.db.prepare("INSERT INTO flips (title, buy_channel, bought_on, buy_price_pln, created_at, updated_at) VALUES ('RTX 3070', 'OLX', '2026-09-01', 1200, 'now', 'now')").run();
    assert.equal(context.debug.schema().tables.some((table: { name: string }) => table.name === 'flips'), false);
    assert.throws(() => context.debug.tableRows('flips'), (error: unknown) => error instanceof ServiceError && error.status === 404);
    assert.equal(context.debug.schema().tables.some((table: { name: string }) => table.name === 'flip_photos'), false);
    for (const sql of ['SELECT * FROM flips', 'select title from "FLIPS"', 'WITH x AS (SELECT buy_price_pln FROM flips) SELECT * FROM x', 'SELECT data FROM flip_photos']) {
      await assert.rejects(context.debug.query(sql), (error: unknown) => error instanceof ServiceError && error.status === 403, sql);
    }
    const snapshot = context.debug.snapshot();
    const copy = new DatabaseSync(snapshot.path, { readOnly: true });
    try {
      assert.equal((copy.prepare('SELECT COUNT(*) AS count FROM flips').get() as { count: number }).count, 0);
    } finally { copy.close(); }
    snapshot.cleanup();
    assert.equal((context.db.prepare('SELECT COUNT(*) AS count FROM flips').get() as { count: number }).count, 1, 'the live ledger is untouched');
  } finally { context.close(); }
});
