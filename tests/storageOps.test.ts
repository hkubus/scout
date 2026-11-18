import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import sharp from 'sharp';
import { backupDatabase, openDatabase } from '../server/db';
import { APP_LOG_MAX_PER_MINUTE, APP_LOG_MAX_ROWS, AppLog } from '../server/appLog';
import { ScoutDebug } from '../server/debug';
import { buildImprovementExport, improvementContext } from '../server/improvementExport';
import { SNAPSHOT_IMAGE_MAX_EDGE, SNAPSHOT_IMAGE_SHRINK_BYTES, shrinkSnapshotImage } from '../server/snapshotImages';
import { ScoutService } from '../server/service';

if (process.env.SCOUT_JEV_MODE === undefined) process.env.SCOUT_JEV_MODE = 'legacy';

const templateDirectory = mkdtempSync(join(tmpdir(), 'scout-storage-template-'));
after(() => rmSync(templateDirectory, { recursive: true, force: true }));
let template: string | undefined;

function fixture() {
  if (!template) {
    template = join(templateDirectory, 'scout.sqlite');
    openDatabase(template).close();
  }
  const directory = mkdtempSync(join(tmpdir(), 'scout-storage-'));
  const path = join(directory, 'scout.sqlite');
  copyFileSync(template, path);
  const db = openDatabase(path);
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, path, directory, close: () => { try { db.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); } };
}

const quietConsole = <T>(run: () => T): T => {
  const { error, info } = console;
  console.error = () => {};
  console.info = () => {};
  try { return run(); } finally { console.error = error; console.info = info; }
};

// ------------------------------------------------------------ observations

test('compaction keeps the first and last row of each same-day, same-price run of one watch and listing', async () => {
  const context = fixture();
  try {
    const now = new Date().toISOString();
    for (const id of ['w', 'w2']) context.db.prepare("INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, 'gpu', '[\"OLX\"]', 1, ?, ?, ?)").run(id, id, now, now, now);
    const listing = (key: string) => Number((context.db.prepare("INSERT INTO listings (marketplace, listing_id, title, price_pln, url, shipping_available, first_seen_at, last_seen_at) VALUES ('OLX', ?, 'GPU', 100, ?, 1, ?, ?) RETURNING id").get(key, `https://www.olx.pl/d/oferta/${key}`, now, now) as { id: number }).id);
    const a = listing('a');
    const b = listing('b');
    const insert = context.db.prepare('INSERT INTO observations (id, listing_id, watch_id, price_pln, observed_at) VALUES (?, ?, ?, ?, ?)');
    const day = (time: string, next = false) => `2026-11-0${next ? 2 : 1}T${time}:00.000Z`;
    // Listing a in watch w, interleaved by id with listing b and with watch w2.
    insert.run(1, a, 'w', 100, day('08:00'));
    insert.run(3, a, 'w', 100, day('09:00')); // inside the run
    insert.run(5, a, 'w', 100, day('10:00')); // inside the run
    insert.run(7, a, 'w', 100, day('11:00')); // last of the run
    insert.run(9, a, 'w', 90, day('12:00')); // price change
    insert.run(11, a, 'w', 100, day('13:00')); // back again: a new run
    insert.run(13, a, 'w', 100, day('23:59')); // last row of the day
    insert.run(15, a, 'w', 100, day('00:01', true)); // new day
    insert.run(17, a, 'w', 100, day('05:00', true));
    insert.run(19, a, 'w', 100, day('10:30')); // a later id inside the first run by time
    for (const id of [2, 4, 6, 8]) insert.run(id, b, 'w', 50, day(`0${id}:00`)); // 4 and 6 inside
    insert.run(10, a, 'w2', 100, day('09:30')); // another watch: its own history
    insert.run(12, a, 'w2', 100, day('10:15'));
    assert.equal(await context.service.compactObservations({ pauseMs: 0 }), 5);
    const left = (context.db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>).map((row) => Number(row.id));
    assert.deepEqual(left, [1, 2, 7, 8, 9, 10, 11, 12, 13, 15, 17]);
  } finally { context.close(); }
});

/** A per-scan history (one row every 30 minutes) for several listings and two watches, across two days, with price changes. */
function seedPerScanHistory(db: any) {
  const now = new Date().toISOString();
  for (const id of ['watch-a', 'watch-b']) {
    db.prepare('INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, id, 'gpu', '["OLX"]', now, now, now);
  }
  const insertListing = db.prepare('INSERT INTO listings (marketplace, listing_id, title, price_pln, url, shipping_available, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?) RETURNING id');
  const insertObservation = db.prepare('INSERT INTO observations (listing_id, watch_id, price_pln, observed_at, scan_id, baseline_pln, discount_percent, deal_strength, deal_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const start = Date.parse(new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString().slice(0, 10) + 'T06:00:00.000Z');
  let scan = 0;
  for (let listing = 0; listing < 6; listing += 1) {
    const id = Number((insertListing.get('OLX', `per-scan-${listing}`, `GPU ${listing}`, 1000, `https://www.olx.pl/d/oferta/per-scan-${listing}`, now, now) as { id: number }).id);
    for (const watch of listing % 2 ? ['watch-a', 'watch-b'] : ['watch-a']) {
      for (let step = 0; step < 80; step += 1) {
        // Price drops at step 20 and comes back at step 50; listing 3 never changes.
        const price = listing === 3 ? 900 : step >= 20 && step < 50 ? 950 - listing * 10 : 1000 - listing * 10;
        insertObservation.run(id, watch, price, new Date(start + step * 30 * 60_000).toISOString(), ++scan, 1100, 10, 2, 'Deal');
      }
    }
  }
}

function prototypeCompaction(db: any) {
  // scripts/bench/perf-compact-observations.sql, without its closing VACUUM.
  const sql = readFileSync(join(import.meta.dirname, '../scripts/bench/perf-compact-observations.sql'), 'utf8').replace(/VACUUM;\s*$/, '');
  db.exec(sql);
}

test('compacting observations removes exactly the prototype rows and leaves analytics unchanged', async () => {
  const context = fixture();
  const reference = fixture();
  try {
    seedPerScanHistory(context.db);
    seedPerScanHistory(reference.db);
    const before = Number((context.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n);
    const analyticsBefore = ['watch-a', 'watch-b'].map((id) => context.service.watchAnalytics(id, 30));
    const detailBefore = context.service.listingDetail('OLX:per-scan-3', 'watch-a');

    const removed = await context.service.compactObservations({ pauseMs: 0 });
    prototypeCompaction(reference.db);
    const ids = (db: any) => (db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>).map((row) => Number(row.id));
    assert.deepEqual(ids(context.db), ids(reference.db), 'the same rows as the SQL prototype');
    assert.equal(removed, before - ids(context.db).length);
    assert.ok(removed > before * 0.8, `most per-scan rows are redundant (${removed} of ${before})`);

    // Daily analytics, bounds and the daily-price count read the same inputs.
    assert.deepEqual(['watch-a', 'watch-b'].map((id) => context.service.watchAnalytics(id, 30)), analyticsBefore);
    const detailAfter = context.service.listingDetail('OLX:per-scan-3', 'watch-a');
    assert.equal(detailAfter.listing.price, detailBefore.listing.price);
    assert.equal(detailAfter.history.at(-1)?.observedAt, detailBefore.history.at(-1)?.observedAt);

    // A finished pass is recorded and never runs again.
    assert.ok(context.db.prepare("SELECT value FROM settings WHERE key = 'observation_compaction_done_at'").get());
    assert.equal(context.db.prepare("SELECT value FROM settings WHERE key = 'observation_compaction_cursor'").get(), undefined);
    context.db.prepare("INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) SELECT listing_id, watch_id, price_pln, observed_at FROM observations LIMIT 3").run();
    assert.equal(await context.service.compactObservations({ pauseMs: 0 }), 0);
  } finally {
    context.close();
    reference.close();
  }
});

test('an interrupted observation compaction resumes where it stopped', async () => {
  const context = fixture();
  const reference = fixture();
  try {
    seedPerScanHistory(context.db);
    seedPerScanHistory(reference.db);
    prototypeCompaction(reference.db);
    // One 500-id span per slice, stopped after the first slice.
    let slices = 0;
    const first = await context.service.compactObservations({ sliceMs: 0, pauseMs: 0, shouldStop: () => slices++ >= 1 });
    const cursor = context.db.prepare("SELECT value FROM settings WHERE key = 'observation_compaction_cursor'").get() as { value: string } | undefined;
    assert.ok(cursor && Number(cursor.value) > 0, 'the position is saved');
    assert.equal(context.db.prepare("SELECT value FROM settings WHERE key = 'observation_compaction_done_at'").get(), undefined);
    assert.ok(first > 0);

    // A new process picks it up from the saved position.
    const restarted = new ScoutService(context.db, () => {}, { suggestVariantGroups: async () => [] });
    const rest = await restarted.compactObservations({ pauseMs: 0 });
    assert.ok(rest > 0);
    const ids = (db: any) => (db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>).map((row) => Number(row.id));
    assert.deepEqual(ids(context.db), ids(reference.db));
  } finally {
    context.close();
    reference.close();
  }
});

test('a long history is compacted across slices, and stopping inside one loses nothing', async () => {
  const context = fixture();
  const reference = fixture();
  try {
    for (const db of [context.db, reference.db]) {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at) VALUES ('long', 'long', 'gpu', '[\"OLX\"]', 1, ?, ?, ?)").run(now, now, now);
      const listing = Number((db.prepare("INSERT INTO listings (marketplace, listing_id, title, price_pln, url, shipping_available, first_seen_at, last_seen_at) VALUES ('OLX', 'long-1', 'GPU', 500, 'https://www.olx.pl/d/oferta/long-1', 1, ?, ?) RETURNING id").get(now, now) as { id: number }).id);
      const insert = db.prepare("INSERT INTO observations (listing_id, watch_id, price_pln, observed_at) VALUES (?, 'long', 500, ?)");
      // 650 rows a minute apart on one day: 648 redundant, over more than one 500-id span.
      for (let step = 0; step < 650; step += 1) insert.run(listing, new Date(Date.parse('2026-11-10T00:30:00.000Z') + step * 60_000).toISOString());
    }
    prototypeCompaction(reference.db);
    let slices = 0;
    const first = await context.service.compactObservations({ sliceMs: 0, pauseMs: 0, shouldStop: () => slices++ >= 1 });
    assert.equal(first, 499, 'one slice: ids 1-500, the first of which starts the run');
    assert.equal((context.db.prepare("SELECT value FROM settings WHERE key = 'observation_compaction_cursor'").get() as { value: string }).value, '500');
    const restarted = new ScoutService(context.db, () => {}, { suggestVariantGroups: async () => [] });
    assert.equal(await restarted.compactObservations({ sliceMs: 0, pauseMs: 0 }), 149);
    const ids = (db: any) => (db.prepare('SELECT id FROM observations ORDER BY id').all() as Array<{ id: number }>).map((row) => Number(row.id));
    assert.deepEqual(ids(context.db), ids(reference.db));
    assert.deepEqual(ids(context.db), [1, 650]);
  } finally {
    context.close();
    reference.close();
  }
});

test('a compacted history leaves the prototype nothing to remove', async () => {
  const context = fixture();
  try {
    seedPerScanHistory(context.db);
    await context.service.compactObservations({ pauseMs: 0 });
    const count = () => Number((context.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n);
    const before = count();
    prototypeCompaction(context.db);
    assert.equal(count(), before);
  } finally { context.close(); }
});

// ---------------------------------------------------------- connector runs

test('a restart closes connector runs left running without touching backoff', () => {
  const context = fixture();
  let db = context.db;
  try {
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const insert = db.prepare('INSERT INTO connector_runs (source, status, message, started_at, finished_at, backoff_until) VALUES (?, ?, ?, ?, ?, ?)');
    const backoff = new Date(Date.now() + 60 * 60_000).toISOString();
    insert.run('OLX', 'error', 'blocked', minutesAgo(5), minutesAgo(5), backoff);
    insert.run('OLX', 'running', 'Scanning GPU', minutesAgo(2), null, null);
    insert.run('Vinted', 'ok', 'done', minutesAgo(5), minutesAgo(5), null);
    insert.run('Vinted', 'running', 'Scanning GPU', minutesAgo(2), null, null);
    db.close();

    db = openDatabase(context.path);
    const rows = db.prepare('SELECT source, status, message, finished_at FROM connector_runs ORDER BY id').all() as Array<Record<string, any>>;
    assert.deepEqual(rows.map((row) => row.status), ['error', 'interrupted', 'ok', 'interrupted']);
    assert.match(String(rows[1].message), /^Scanning GPU \(interrupted: Scout restarted/);
    assert.ok(rows[1].finished_at && rows[3].finished_at);
    const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
    // The backoff from the last error still stands.
    assert.equal((service as any).activeConnectorBackoff('OLX'), backoff);
    // An interrupted run is neither a failure nor a success: after an ok run a
    // first failure starts no backoff, and after an error a second one does.
    assert.equal((service as any).connectorBackoffAfterFailure('Vinted', -1), null);
    assert.ok((service as any).connectorBackoffAfterFailure('OLX', -1));
    // The connector list no longer reports a run that will never finish.
    const olx = service.getConnectors().find((connector) => connector.name === 'OLX')!;
    assert.equal(olx.status, 'Idle');
    assert.match(olx.detail, /interrupted/);
  } finally {
    db.close();
    rmSync(context.directory, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- retention

test('retention prunes the Jev shadow log after 180 days and fuzzy verdicts after 90', () => {
  const context = fixture();
  try {
    const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
    const shadow = context.db.prepare("INSERT INTO jev_shadow_log (created_at, task, input_hash, jev_model) VALUES (?, 'relevance', ?, 'jev')");
    shadow.run(daysAgo(181), 'old');
    shadow.run(daysAgo(179), 'kept');
    const fuzzy = context.db.prepare("INSERT INTO jev_fuzzy_cache (input_hash, model, task, decision, rescued, checked_at) VALUES (?, 'jev', 'term-match', 'yes', 1, ?)");
    fuzzy.run('old', daysAgo(91));
    fuzzy.run('kept', daysAgo(89));
    const appLog = context.db.prepare("INSERT INTO app_log (at, level, scope, message) VALUES (?, 'error', 'watch', ?)");
    appLog.run(daysAgo(31), 'old');
    appLog.run(daysAgo(29), 'kept');
    (context.service as any).pruneRetention();
    const left = (table: string, column: string) => (context.db.prepare(`SELECT ${column} AS value FROM ${table} ORDER BY 1`).all() as Array<{ value: string }>).map((row) => row.value);
    assert.deepEqual(left('jev_shadow_log', 'input_hash'), ['kept']);
    assert.deepEqual(left('jev_fuzzy_cache', 'input_hash'), ['kept']);
    assert.deepEqual(left('app_log', 'message'), ['kept']);
  } finally { context.close(); }
});

// ---------------------------------------------------------------- app log

test('warnings and errors are stored and outlive a restart; info lines are not', async () => {
  const context = fixture();
  try {
    quietConsole(() => {
      (context.service as any).log('info', 'watch', 'GPU · OLX: query-search → fetched=12');
      (context.service as any).log('error', 'watch', 'GPU · OLX: failed via api — HTTP 403');
    });
    const stored = context.db.prepare('SELECT level, scope, message, repeats FROM app_log').all() as Array<Record<string, unknown>>;
    assert.deepEqual(stored.map((row) => ({ ...row })), [{ level: 'error', scope: 'watch', message: 'GPU · OLX: failed via api — HTTP 403', repeats: 0 }]);
    // The live process: the buffer holds both, and the stored copy is not repeated.
    assert.deepEqual(context.service.logHistory().map((entry) => [entry.level, entry.source]), [['error', 'memory'], ['info', 'memory']]);

    // After a restart the buffer is empty and the error is still there.
    const restarted = new ScoutService(context.db, () => {}, { suggestVariantGroups: async () => [] });
    assert.deepEqual(restarted.logs(), []);
    const history = restarted.logHistory();
    assert.deepEqual(history.map((entry) => [entry.level, entry.message, entry.source]), [['error', 'GPU · OLX: failed via api — HTTP 403', 'stored']]);

    // The debug runtime and the improvement export read the same history.
    const debug = new ScoutDebug(context.db, restarted, context.path);
    try {
      assert.equal((debug.runtime().logs as Array<{ source: string }>)[0].source, 'stored');
    } finally { debug.close(); }
    const file = await buildImprovementExport(context.db, { includePrivate: false, context: improvementContext(restarted) });
    try {
      const out = new DatabaseSync(file.path, { readOnly: true });
      try {
        assert.deepEqual((out.prepare('SELECT id, level, message, source, repeats FROM export_logs').all() as Array<Record<string, unknown>>).map((row) => ({ ...row })), [{ id: 1, level: 'error', message: 'GPU · OLX: failed via api — HTTP 403', source: 'stored', repeats: 0 }]);
        assert.equal((out.prepare('SELECT COUNT(*) AS n FROM app_log').get() as { n: number }).n, 1);
        assert.equal((out.prepare("SELECT handling FROM export_tables WHERE name = 'app_log'").get() as { handling: string }).handling, 'copied; encrypted values redacted');
      } finally { out.close(); }
    } finally { file.cleanup(); }
  } finally { context.close(); }
});

test('the stored log folds repeats, caps its write rate and bounds its size', () => {
  const context = fixture();
  const db = context.db;
  try {
    let now = Date.parse('2026-11-18T10:00:00.000Z');
    const log = new AppLog(db, () => now);
    let id = 0;
    const line = (message: string, level: 'info' | 'error' = 'error') => log.record({ id: ++id, at: new Date(now).toISOString(), level, scope: 'watch', message });
    const rows = () => db.prepare('SELECT message, repeats FROM app_log ORDER BY id').all() as Array<{ message: string; repeats: number }>;

    // An identical line within a minute is one row with a repeat count.
    for (let index = 0; index < 50; index += 1) { line('OLX: HTTP 429'); now += 1_000; }
    assert.deepEqual(rows().map((row) => ({ ...row })), [{ message: 'OLX: HTTP 429', repeats: 0 }]);
    now += 60_000;
    line('OLX: HTTP 429');
    assert.deepEqual(rows().map((row) => ({ ...row })), [{ message: 'OLX: HTTP 429', repeats: 49 }, { message: 'OLX: HTTP 429', repeats: 0 }]);

    // A storm of distinct lines stores at most APP_LOG_MAX_PER_MINUTE a minute and says how many it left out.
    db.exec('DELETE FROM app_log');
    now += 120_000;
    for (let index = 0; index < 500; index += 1) line(`failure ${index}`);
    assert.equal(rows().length, APP_LOG_MAX_PER_MINUTE);
    now += 60_000;
    line('after the storm');
    const messages = rows().map((row) => row.message);
    assert.match(messages.at(-2)!, new RegExp(`^${500 - APP_LOG_MAX_PER_MINUTE} more warning and error lines were not stored`));
    assert.equal(messages.at(-1), 'after the storm');

    // Never more than APP_LOG_MAX_ROWS rows (checked every 100 stored rows).
    db.exec('DELETE FROM app_log');
    db.exec('BEGIN');
    for (let index = 0; index < APP_LOG_MAX_ROWS + 450; index += 1) { now += 61_000; line(`line ${index}`); }
    db.exec('COMMIT');
    const count = Number((db.prepare('SELECT COUNT(*) AS n FROM app_log').get() as { n: number }).n);
    assert.ok(count <= APP_LOG_MAX_ROWS + 100 && count >= APP_LOG_MAX_ROWS, `${count} rows`);
    assert.equal((db.prepare('SELECT message FROM app_log ORDER BY id DESC LIMIT 1').get() as { message: string }).message, `line ${APP_LOG_MAX_ROWS + 449}`);

    // Info lines are never stored, and a closed database never makes logging throw.
    line('progress', 'info');
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM app_log WHERE message = 'progress'").get() as { n: number }).n, 0);
    db.close();
    assert.doesNotThrow(() => line('after close'));
  } finally { context.close(); }
});

// ----------------------------------------------------------------- backup

test('a backup is written by a child process while the event loop keeps running', async () => {
  const context = fixture();
  try {
    seedPerScanHistory(context.db);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const path = await backupDatabase(context.db, context.path, 2).finally(() => clearInterval(timer));
    assert.ok(ticks >= 1, 'the event loop kept running');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n, (context.db.prepare('SELECT COUNT(*) AS n FROM observations').get() as { n: number }).n);
    } finally { copy.close(); }
    await backupDatabase(context.db, context.path, 2);
    await backupDatabase(context.db, context.path, 2);
    assert.equal(readdirSync(context.directory).filter((file) => file.endsWith('.backup.sqlite')).length, 2, 'only the newest copies are kept');
  } finally { context.close(); }
});

test('a backup falls back to the main connection when no child process can start', async () => {
  const context = fixture();
  const execPath = process.execPath;
  try {
    process.execPath = join(context.directory, 'no-such-node');
    const path = await backupDatabase(context.db, context.path, 5);
    process.execPath = execPath;
    const copy = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    } finally { copy.close(); }
  } finally {
    process.execPath = execPath;
    context.close();
  }
});

// ----------------------------------------------------------------- photos

/** A photo-like JPEG: smooth gradients plus noise, so it compresses like a camera picture. */
async function photo(width: number, height: number) {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const noise = (seed >> 16) % 48;
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 255 / width + noise) & 255;
      pixels[offset + 1] = (y * 255 / height + noise) & 255;
      pixels[offset + 2] = ((x + y) * 128 / (width + height) + noise) & 255;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg({ quality: 95 }).toBuffer();
}

test('oversized listing photos are stored as WebP at most 1600 px; small ones are left alone', async () => {
  const large = await photo(3000, 2000);
  assert.ok(large.byteLength > SNAPSHOT_IMAGE_SHRINK_BYTES, `test photo is ${large.byteLength} bytes`);
  const shrunk = await shrinkSnapshotImage(large, 'image/jpeg');
  assert.ok(shrunk);
  assert.equal(shrunk!.mime, 'image/webp');
  assert.ok(shrunk!.data.byteLength < large.byteLength / 2, `${large.byteLength} → ${shrunk!.data.byteLength}`);
  const metadata = await sharp(shrunk!.data).metadata();
  assert.equal(metadata.format, 'webp');
  assert.equal(Math.max(metadata.width ?? 0, metadata.height ?? 0), SNAPSHOT_IMAGE_MAX_EDGE);

  const small = await photo(400, 300);
  assert.ok(small.byteLength <= SNAPSHOT_IMAGE_SHRINK_BYTES);
  assert.equal(await shrinkSnapshotImage(small, 'image/jpeg'), null);
  assert.equal(await shrinkSnapshotImage(large, 'image/gif'), null, 'GIFs may be animated');
  assert.equal(await shrinkSnapshotImage(Buffer.alloc(SNAPSHOT_IMAGE_SHRINK_BYTES + 1, 7), 'image/jpeg'), null, 'unreadable bytes are kept');
});

test('photos stored at full size are re-encoded in the background, once', async () => {
  const context = fixture();
  try {
    const large = await photo(2400, 1800);
    const small = await photo(400, 300);
    const now = new Date().toISOString();
    context.db.prepare("INSERT INTO market_watches (id, name, query, sources_json, interval_hours, enabled, next_scan_at, created_at, updated_at) VALUES ('mw', 'Lego', 'lego', '[\"Allegro Lokalnie\"]', 24, 1, ?, ?, ?)").run(now, now, now);
    const listing = Number(context.db.prepare("INSERT INTO market_listings (market_watch_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans) VALUES ('mw', 'Allegro Lokalnie', 'al-1', 'Lego', 'https://allegrolokalnie.pl/oferta/al-1', 100, 100, 100, ?, ?, 'active', 0)").run(now, now).lastInsertRowid);
    const snapshot = Number(context.db.prepare("INSERT INTO market_listing_snapshots (market_listing_id, marketplace, external_listing_id, title, price_pln, url, state_hash, image_count, source, captured_at) VALUES (?, 'Allegro Lokalnie', 'al-1', 'Lego', 100, 'https://allegrolokalnie.pl/oferta/al-1', 'h', 3, 'auto', ?)").run(listing, now).lastInsertRowid);
    const insert = context.db.prepare('INSERT INTO market_listing_snapshot_images (snapshot_id, position, source_url, mime_type, byte_size, data) VALUES (?, ?, ?, ?, ?, ?)');
    insert.run(snapshot, 0, 'https://a.allegroimg.com/original/1', 'image/jpeg', large.byteLength, large);
    insert.run(snapshot, 1, 'https://a.allegroimg.com/original/2', 'image/jpeg', small.byteLength, small);
    insert.run(snapshot, 2, 'https://a.allegroimg.com/original/3', 'image/gif', large.byteLength, large);

    const result = await context.service.shrinkStoredSnapshotImages({ pauseMs: 0 });
    assert.equal(result.images, 1);
    assert.equal(result.bytesBefore, large.byteLength);
    const rows = context.db.prepare('SELECT position, mime_type, byte_size, length(data) AS stored FROM market_listing_snapshot_images ORDER BY position').all() as Array<Record<string, any>>;
    assert.equal(rows[0].mime_type, 'image/webp');
    assert.equal(rows[0].byte_size, rows[0].stored);
    assert.equal(rows[0].byte_size, result.bytesAfter);
    assert.deepEqual([rows[1].mime_type, rows[1].byte_size], ['image/jpeg', small.byteLength]);
    assert.deepEqual([rows[2].mime_type, rows[2].byte_size], ['image/gif', large.byteLength]);
    // The served image and the snapshot metadata follow the stored copy.
    const imageId = Number((context.db.prepare('SELECT id FROM market_listing_snapshot_images WHERE position = 0').get() as { id: number }).id);
    assert.equal(context.service.marketSnapshotImage(imageId)?.mime, 'image/webp');
    assert.equal(context.service.marketListingSnapshot(listing)?.images[0].byteSize, rows[0].byte_size);

    // Recorded as done: a full-size photo inserted later is not visited again.
    insert.run(snapshot, 3, 'https://a.allegroimg.com/original/4', 'image/jpeg', large.byteLength, large);
    assert.equal((await context.service.shrinkStoredSnapshotImages({ pauseMs: 0 })).images, 0);
  } finally { context.close(); }
});

test('a captured research listing stores oversized photos re-encoded', async () => {
  const context = fixture();
  const originalFetch = globalThis.fetch;
  try {
    const large = await photo(2400, 1800);
    const now = new Date().toISOString();
    context.db.prepare("INSERT INTO market_watches (id, name, query, sources_json, interval_hours, enabled, next_scan_at, created_at, updated_at) VALUES ('mw', 'Lego', 'lego', '[\"OLX\"]', 24, 1, ?, ?, ?)").run(now, now, now);
    const listing = Number(context.db.prepare("INSERT INTO market_listings (market_watch_id, marketplace, listing_id, title, url, first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at, status, missing_scans, availability_status, snapshot_status) VALUES ('mw', 'OLX', 'big-1', 'Lego', 'https://www.olx.pl/d/oferta/lego-IDbig1.html', 100, 100, 100, ?, ?, 'active', 0, 'live', 'pending')").run(now, now).lastInsertRowid);
    const page = `<html><head><meta property="og:image" content="https://ireland.apollo.olxcdn.com/v1/files/big-PL/image"></head><body>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'Lego', description: 'Komplet.', offers: { price: '100' } })}</script></body></html>`;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://www.olx.pl/d/oferta/lego-IDbig1.html') return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
      if (url === 'https://ireland.apollo.olxcdn.com/v1/files/big-PL/image') return new Response(new Uint8Array(large), { status: 200, headers: { 'content-type': 'image/jpeg' } });
      throw new Error(`Unexpected fetch: ${url}`);
    }) as typeof fetch;
    const snapshot = await context.service.captureMarketListingSnapshotNow(listing);
    assert.equal(snapshot?.images.length, 1);
    const image = context.service.marketSnapshotImage(snapshot!.images[0].id);
    assert.equal(image?.mime, 'image/webp');
    assert.ok(image!.data.byteLength < large.byteLength / 2);
    assert.equal(snapshot!.images[0].byteSize, image!.data.byteLength);
  } finally {
    globalThis.fetch = originalFetch;
    context.close();
  }
});
