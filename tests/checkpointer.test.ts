import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { endianness, tmpdir } from 'node:os';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, startWalCheckpointer } from '../server/db';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const pragma = (db: any, name: string) => Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0];
// WAL progress read from the -shm wal-index without taking part in it (a
// probe checkpoint would backfill the WAL itself): mxFrame is a u32 at byte 16
// of the index header and nBackfill a u32 at byte 96 (checkpoint info), both
// in native byte order.
const walIndex = (file: string) => {
  const shm = readFileSync(`${file}-shm`);
  const read = (offset: number) => (endianness() === 'LE' ? shm.readUInt32LE(offset) : shm.readUInt32BE(offset));
  return { frames: read(16), backfilled: read(96) };
};

test('the worker checkpointer backfills the WAL off the main connection and lets it reset', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scout-checkpoint-'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const errors: string[] = [];
  let checkpointer: ReturnType<typeof startWalCheckpointer> = null;
  try {
    checkpointer = startWalCheckpointer(db, { intervalMs: 20, onError: (message) => errors.push(message) });
    assert.ok(checkpointer);
    assert.equal(pragma(db, 'wal_autocheckpoint'), 10_000);
    assert.equal(pragma(db, 'journal_size_limit'), 67_108_864);
    db.exec('CREATE TABLE checkpoint_probe (id INTEGER PRIMARY KEY, body TEXT)');
    const insert = db.prepare('INSERT INTO checkpoint_probe (body) VALUES (?)');
    // Many small commits while the worker checkpoints concurrently: no SQLITE_BUSY.
    for (let round = 0; round < 20; round += 1) {
      for (let index = 0; index < 100; index += 1) insert.run('x'.repeat(2_000));
      await sleep(5);
    }
    // Once idle, the worker backfills every frame. The main connection never
    // checkpoints here (its auto-checkpoint is 10,000 frames), so the backfill
    // is the worker's. Poll for it rather than sleeping a fixed time, which
    // was flaky on a loaded host.
    const file = join(directory, 'scout.sqlite');
    const deadline = Date.now() + 10_000;
    let index = walIndex(file);
    while ((index.frames < 4_000 || index.backfilled < index.frames) && Date.now() < deadline) {
      await sleep(20);
      index = walIndex(file);
    }
    assert.ok(index.frames >= 4_000, `WAL held the writes (${index.frames} frames)`);
    assert.equal(index.backfilled, index.frames, 'the worker backfilled the whole WAL');
    // Stop the worker before the next write and the probe: its 20 ms
    // background checkpoint would otherwise race them (the probe reported
    // busy, or the write could not restart the WAL). Stopping does not
    // checkpoint.
    await checkpointer.stop();
    await checkpointer.stop();
    assert.equal(pragma(db, 'wal_autocheckpoint'), 1_000);
    // With every frame backfilled, the next write restarts the WAL from the
    // beginning instead of appending to 4000+ frames.
    insert.run('after idle');
    const probe = new DatabaseSync(file);
    try {
      const state = probe.prepare('PRAGMA wal_checkpoint(PASSIVE)').get() as { busy: number; log: number };
      assert.equal(state.busy, 0);
      assert.ok(state.log < 50, `WAL restarted after the worker backfilled it (log ${state.log})`);
    } finally { probe.close(); }
    assert.equal((db.prepare('SELECT COUNT(*) AS count FROM checkpoint_probe').get() as { count: number }).count, 2_001);
    assert.deepEqual(errors, []);
  } finally {
    // A failed assertion must not leave the worker thread keeping the test
    // process alive; stop() is idempotent.
    await checkpointer?.stop();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the checkpointer is not started for a database without a WAL file', () => {
  const db = new DatabaseSync(':memory:');
  try {
    assert.equal(startWalCheckpointer(db), null);
  } finally { db.close(); }
});
