import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService } from '../server/service';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-export-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seed(db: any, listings = 400, observationsPerListing = 6) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES ('export-watch', 'Łódź "aparaty" \\ test', 'fujifilm x100v', '["OLX"]', 1, ?, ?, ?)`).run(now, now, now);
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, typical_pln, url, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let index = 0; index < listings; index += 1) {
    const { lastInsertRowid } = insertListing.run('OLX', `export-${index}`, `Fujifilm X100V żółć 😀 "${index}"\n`, 3000 + index * 0.5, index % 3 ? null : 3500, `https://www.olx.pl/d/oferta/export-${index}`, now, now);
    for (let step = 0; step < observationsPerListing; step += 1) insertObservation.run(lastInsertRowid, 'export-watch', 3000 + step, new Date(Date.now() - step * 60_000).toISOString());
  }
  db.exec('COMMIT');
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('discord_webhook', 'secret-webhook', ?), ('default_interval', '7', ?)").run(now, now);
}

async function collect(chunks: AsyncIterable<string | Buffer>) {
  let text = '';
  let count = 0;
  for await (const chunk of chunks) { text += chunk.toString(); count += 1; }
  return { text, count };
}

test('the streamed export is byte-identical to JSON.stringify(exportData())', async () => {
  const context = fixture();
  try {
    seed(context.db);
    const { text, count } = await collect(context.service.exportChunks());
    assert.ok(count > 3, `export arrives in several chunks (got ${count})`);
    const parsed = JSON.parse(text);
    const expected = { ...context.service.exportData(), exportedAt: parsed.exportedAt };
    assert.deepEqual(parsed, JSON.parse(JSON.stringify(expected)));
    assert.equal(text, JSON.stringify(expected));
    assert.equal(parsed.observations.length, 2400);
    assert.deepEqual(parsed.settings.find((row: { key: string }) => row.key === 'discord_webhook'), { key: 'discord_webhook', configured: true, value: null });

    const streamed = await collect(context.service.exportStream());
    assert.equal(streamed.text, JSON.stringify({ ...context.service.exportData(), exportedAt: JSON.parse(streamed.text).exportedAt }));
  } finally { context.close(); }
});

test('an empty database streams the same JSON as exportData()', async () => {
  const context = fixture();
  try {
    const { text } = await collect(context.service.exportChunks());
    assert.equal(text, JSON.stringify({ ...context.service.exportData(), exportedAt: JSON.parse(text).exportedAt }));
  } finally { context.close(); }
});

test('the export reads one snapshot and releases it when the consumer stops early', async () => {
  const context = fixture();
  try {
    seed(context.db);
    context.db.exec('PRAGMA busy_timeout = 0');
    const chunks = context.service.exportChunks();
    const first = await chunks.next();
    assert.equal(first.done, false);
    // A write committed after the snapshot started is not part of the export.
    context.db.prepare("INSERT INTO listing_actions (marketplace, listing_id, decision, note, hidden, updated_at) VALUES ('OLX', 'late', NULL, '', 1, ?)").run(new Date().toISOString());
    // While the reader holds its snapshot a TRUNCATE checkpoint cannot finish.
    assert.equal((context.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy, 1);
    let text = String(first.value);
    for await (const chunk of { [Symbol.asyncIterator]: () => chunks }) text += chunk;
    assert.equal(JSON.parse(text).listingActions.length, 0);

    // Stopping mid-stream (client abort) rolls back and closes the reader.
    const aborted = context.service.exportChunks();
    await aborted.next();
    assert.equal((context.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy, 1);
    await aborted.return(undefined);
    assert.equal((context.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy, 0);
  } finally { context.close(); }
});

test('exportStream stops a stalled export after its time limit', async () => {
  const context = fixture();
  try {
    seed(context.db);
    context.db.exec('PRAGMA busy_timeout = 0');
    const stream = context.service.exportStream(50);
    const errored = new Promise<Error>((resolve) => stream.once('error', resolve));
    // Read one chunk and then stall, as a client that stopped reading would.
    await new Promise<void>((resolve) => stream.once('readable', () => { stream.read(); resolve(); }));
    const error = await errored;
    assert.match(error.message, /exceeded 50 ms/);
    if (!stream.closed) await once(stream, 'close');
    assert.equal((context.db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }).busy, 0);
  } finally { context.close(); }
});

test('falls back to exportData() when the database has no file to reopen', async () => {
  const context = fixture();
  try {
    seed(context.db, 5, 2);
    const db = new Proxy(context.db, {
      get(target, property, receiver) {
        if (property !== 'prepare') return Reflect.get(target, property, receiver);
        return (sql: string) => sql === 'PRAGMA database_list' ? { all: () => [{ seq: 0, name: 'main', file: '' }] } : target.prepare(sql);
      },
    });
    const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
    const { text, count } = await collect(service.exportChunks());
    assert.equal(count, 1);
    assert.equal(text, JSON.stringify({ ...service.exportData(), exportedAt: JSON.parse(text).exportedAt }));
  } finally { context.close(); }
});
