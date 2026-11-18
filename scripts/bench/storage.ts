/**
 * Storage benchmark: where the bytes of a Scout database go, how fast each
 * table grows, which rows are redundant, and what the database settles at
 * under the 180-day retention.
 *
 *   node --import tsx scripts/bench/storage.ts <scout-improvement-*.sqlite> [--json=out.json] [--now=ISO]
 *        [--compact]   also prototype the observation compaction on a scratch copy
 *                      (delete the rows today's dedup would not have written, VACUUM,
 *                      report the measured file size); set SCOUT_BENCH_TMP to a disk dir
 *
 * Read-only on the input. Works on a plain Scout database too (the image and
 * source-size figures then come from the database itself).
 *
 * Sections:
 * - file: page size/count, freelist, file bytes; for an export, the live
 *   database's size and the snapshot/flip photo bytes the export removed;
 * - objects: dbstat bytes per table and index, index overhead per table;
 * - columns: bytes per TEXT/BLOB column of the big tables (what makes rows fat);
 * - growth: rows per ISO week and rows/day over the last 7 and 30 days per table;
 * - observations: rows the current per-day/price-run dedup (storeListing in
 *   server/service.ts) would not have written, by month, and rows per watch-day;
 * - scans vs connector_runs: one row each per marketplace scan;
 * - projection: steady-state rows/bytes at the last 30 days' rates under the
 *   180-day retention, and tables pruneRetention() never trims.
 */

import { statSync } from 'node:fs';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { Bench, all, exportInfo, one, ratio, scalar, tableExists, writableCopy, type Db } from './lib';

const bench = new Bench('storage');
const { db } = bench;
const MB = 1024 * 1024;
const round = (value: number | null, digits = 2) => (value === null || !Number.isFinite(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);
const mb = (bytes: number | null) => round(bytes === null ? null : bytes / MB, 2);

// ------------------------------------------------------------------ file
const pageSize = scalar(db, 'PRAGMA page_size') ?? 4096;
const pageCount = scalar(db, 'PRAGMA page_count') ?? 0;
const freelist = scalar(db, 'PRAGMA freelist_count') ?? 0;
const fileBytes = statSync(bench.args.exportPath).size;
bench.metric('file.bytes', 'database file', fileBytes, 'bytes', 'lower');
bench.metric('file.freelist_bytes', 'free pages inside the file', freelist * pageSize, 'bytes', 'lower');
bench.metric('file.pages', 'pages', pageCount, 'count', 'info', `page size ${pageSize}`);

const isExport = tableExists(db, 'export_info');
const sourceBytes = Number(exportInfo(db, 'source_database_bytes') ?? NaN);
const imageTable = tableExists(db, 'market_listing_snapshot_images');
const snapshotImageBytes = imageTable ? scalar(db, 'SELECT COALESCE(SUM(byte_size), 0) FROM market_listing_snapshot_images') ?? 0 : 0;
const flipPhotoBytes = tableExists(db, 'flip_photos') ? scalar(db, 'SELECT COALESCE(SUM(byte_size), 0) FROM flip_photos') ?? 0 : 0;
if (isExport && Number.isFinite(sourceBytes)) {
  bench.metric('source.bytes', 'live database file at export time', sourceBytes, 'bytes', 'lower');
  bench.metric('source.snapshot_image_bytes', 'research snapshot photo bytes (byte_size; removed from the export)', snapshotImageBytes, 'bytes', 'lower');
  bench.metric('source.flip_photo_bytes', 'flip photo bytes (removed from the export)', flipPhotoBytes, 'bytes', 'info');
  const unexplained = sourceBytes - fileBytes - snapshotImageBytes - flipPhotoBytes;
  bench.metric('source.unexplained_bytes', 'live file minus export minus photos (free pages, emptied credential tables, page slack)', unexplained, 'bytes', 'lower');
  bench.metric('source.photo_share', 'share of the live file that is photos', ratio(snapshotImageBytes + flipPhotoBytes, sourceBytes), 'ratio', 'lower');
}
if (imageTable) {
  const images = all<Record<string, unknown>>(db, `SELECT s.marketplace, i.mime_type AS mime, COUNT(*) AS images, ROUND(SUM(i.byte_size) / 1048576.0, 1) AS mb,
      ROUND(AVG(i.byte_size) / 1024.0, 1) AS avg_kb, ROUND(MAX(i.byte_size) / 1024.0, 1) AS max_kb,
      SUM(CASE WHEN i.source_url LIKE '%/original/%' THEN 1 ELSE 0 END) AS original_size_urls
    FROM market_listing_snapshot_images i JOIN market_listing_snapshots s ON s.id = i.snapshot_id
    GROUP BY s.marketplace, i.mime_type ORDER BY SUM(i.byte_size) DESC`);
  bench.table('snapshot images by marketplace and type', images);
  const allegro = one<{ n: number; bytes: number }>(db, `SELECT COUNT(*) AS n, COALESCE(SUM(i.byte_size), 0) AS bytes FROM market_listing_snapshot_images i
    JOIN market_listing_snapshots s ON s.id = i.snapshot_id WHERE s.marketplace = 'Allegro Lokalnie'`);
  bench.metric('images.allegro.bytes', 'Allegro Lokalnie snapshot photo bytes (stored at /original/ size)', allegro?.bytes ?? 0, 'bytes', 'lower');
  bench.metric('images.allegro.avg_bytes', 'Allegro Lokalnie bytes per photo', allegro?.n ? allegro.bytes / allegro.n : null, 'bytes', 'lower');
  const others = one<{ n: number; bytes: number }>(db, `SELECT COUNT(*) AS n, COALESCE(SUM(i.byte_size), 0) AS bytes FROM market_listing_snapshot_images i
    JOIN market_listing_snapshots s ON s.id = i.snapshot_id WHERE s.marketplace <> 'Allegro Lokalnie' AND i.mime_type = 'image/webp'`);
  bench.metric('images.webp_other.avg_bytes', 'OLX/Vinted WebP bytes per photo (what a resized photo costs)', others?.n ? others.bytes / others.n : null, 'bytes', 'info');
  bench.metric('images.tiny', 'snapshot photos under 5 KB (thumbnails/avatars, not listing photos)', scalar(db, 'SELECT COUNT(*) FROM market_listing_snapshot_images WHERE byte_size < 5120'), 'count', 'lower');
  bench.metric('images.per_snapshot', 'photos per research snapshot', scalar(db, 'SELECT AVG(n) FROM (SELECT COUNT(*) AS n FROM market_listing_snapshot_images GROUP BY snapshot_id)'), 'count', 'info');
  bench.table('snapshot photo bytes by month captured', all(db, `SELECT substr(s.captured_at, 1, 7) AS month, COUNT(DISTINCT s.id) AS snapshots, COUNT(i.id) AS images,
      ROUND(COALESCE(SUM(i.byte_size), 0) / 1048576.0, 1) AS mb FROM market_listing_snapshots s LEFT JOIN market_listing_snapshot_images i ON i.snapshot_id = s.id GROUP BY 1 ORDER BY 1`));
}

// ---------------------------------------------------------------- objects
interface ObjectRow { name: string; tbl: string; type: string; bytes: number; payload: number; unused: number; pages: number }
const objects = all<ObjectRow>(db, `SELECT d.name AS name, COALESCE(m.tbl_name, d.name) AS tbl, COALESCE(m.type, 'table') AS type,
    SUM(d.pgsize) AS bytes, SUM(d.payload) AS payload, SUM(d.unused) AS unused, COUNT(*) AS pages
  FROM dbstat d LEFT JOIN sqlite_master m ON m.name = d.name GROUP BY d.name ORDER BY bytes DESC`);
const byTable = new Map<string, { table: number; indexes: number; indexNames: string[] }>();
for (const row of objects) {
  const entry = byTable.get(row.tbl) ?? { table: 0, indexes: 0, indexNames: [] };
  if (row.type === 'index') { entry.indexes += row.bytes; entry.indexNames.push(row.name); } else entry.table += row.bytes;
  byTable.set(row.tbl, entry);
}
const rowCounts = new Map<string, number>();
for (const name of byTable.keys()) {
  if (!tableExists(db, name)) continue;
  rowCounts.set(name, scalar(db, `SELECT COUNT(*) FROM "${name.replace(/"/g, '""')}"`) ?? 0);
}
const totalIndex = [...byTable.values()].reduce((sum, entry) => sum + entry.indexes, 0);
const totalTable = [...byTable.values()].reduce((sum, entry) => sum + entry.table, 0);
bench.metric('objects.table_bytes', 'table b-tree bytes', totalTable, 'bytes', 'lower');
bench.metric('objects.index_bytes', 'index bytes', totalIndex, 'bytes', 'lower');
bench.metric('objects.index_ratio', 'index bytes per table byte', ratio(totalIndex, totalTable), 'ratio', 'lower');
const tableRows = [...byTable.entries()]
  .map(([name, entry]) => ({
    table: name,
    rows: rowCounts.get(name) ?? null,
    table_mb: mb(entry.table),
    index_mb: mb(entry.indexes),
    total_mb: mb(entry.table + entry.indexes),
    index_ratio: round(ratio(entry.indexes, entry.table)),
    bytes_per_row: rowCounts.get(name) ? Math.round((entry.table + entry.indexes) / (rowCounts.get(name) ?? 1)) : null,
    indexes: entry.indexNames.length,
  }))
  .sort((a, b) => (b.total_mb ?? 0) - (a.total_mb ?? 0));
bench.table('tables (dbstat; total = table + its indexes)', tableRows);
for (const row of tableRows.slice(0, 12)) {
  bench.metric(`objects.${row.table}.bytes`, `${row.table} table+index bytes`, Math.round((row.total_mb ?? 0) * MB), 'bytes', 'lower');
}
bench.table('indexes (dbstat)', objects.filter((row) => row.type === 'index').map((row) => ({ index: row.name, table: row.tbl, mb: mb(row.bytes), fill: round(ratio(row.payload, row.bytes)), pages: row.pages })));

// ---------------------------------------------------------------- columns
const COLUMN_TABLES = ['observations', 'scans', 'connector_runs', 'listings', 'watch_listings', 'jev_shadow_log', 'manual_relevance_cache', 'jev_fuzzy_cache',
  'listing_relevance', 'market_listings', 'market_price_observations', 'notifications', 'notification_deliveries', 'listing_detail_snapshots', 'market_listing_snapshots'];
const columnRows: Array<Record<string, unknown>> = [];
for (const table of COLUMN_TABLES) {
  if (!tableExists(db, table)) continue;
  const columns = all<{ name: string; type: string }>(db, `SELECT name, type FROM pragma_table_info('${table}')`).filter((column) => /TEXT|BLOB|^$/i.test(column.type));
  if (!columns.length) continue;
  const sums = one<Record<string, number>>(db, `SELECT ${columns.map((column, index) => `COALESCE(SUM(length(CAST("${column.name}" AS BLOB))), 0) AS c${index}`).join(', ')} FROM "${table}"`) ?? {};
  columns.forEach((column, index) => {
    const bytes = Number(sums[`c${index}`] ?? 0);
    if (bytes >= 256 * 1024) columnRows.push({ table, column: column.name, mb: mb(bytes), avg_bytes: rowCounts.get(table) ? Math.round(bytes / (rowCounts.get(table) ?? 1)) : null });
  });
}
columnRows.sort((a, b) => Number(b.mb) - Number(a.mb));
bench.table('fat TEXT/BLOB columns (≥ 256 KB, raw value bytes before page overhead)', columnRows);

// ----------------------------------------------------------------- growth
/** [table, timestamp column, pruned by pruneRetention() at 180 days?] */
const GROWTH: Array<[string, string, 'pruned' | 'cascade' | 'never']> = [
  ['observations', 'observed_at', 'pruned'],
  ['scans', 'started_at', 'pruned'],
  ['connector_runs', 'started_at', 'pruned'],
  ['listings', 'first_seen_at', 'cascade'],
  ['watch_listings', 'first_seen_at', 'cascade'],
  ['listing_relevance', 'checked_at', 'pruned'],
  ['manual_relevance_cache', 'checked_at', 'pruned'],
  ['jev_shadow_log', 'created_at', 'never'],
  ['jev_fuzzy_cache', 'checked_at', 'never'],
  ['listing_detail_snapshots', 'captured_at', 'pruned'],
  ['notifications', 'created_at', 'pruned'],
  ['notification_deliveries', 'created_at', 'pruned'],
  ['market_listings', 'first_seen_at', 'cascade'],
  ['market_price_observations', 'observed_at', 'pruned'],
  ['market_listing_snapshots', 'captured_at', 'cascade'],
  ['listing_duplicate_pairs', 'created_at', 'cascade'],
];
const weekly = new Map<string, Record<string, unknown>>();
const growthRows: Array<Record<string, unknown>> = [];
const since30 = bench.daysAgo(30);
const since7 = bench.daysAgo(7);
for (const [table, column, retention] of GROWTH) {
  if (!tableExists(db, table)) continue;
  for (const row of all<{ week: string; n: number }>(db, `SELECT strftime('%Y-W%W', "${column}") AS week, COUNT(*) AS n FROM "${table}" WHERE "${column}" IS NOT NULL GROUP BY 1 ORDER BY 1`)) {
    const entry = weekly.get(row.week) ?? { week: row.week };
    entry[table] = row.n;
    weekly.set(row.week, entry);
  }
  const last30 = (scalar(db, `SELECT COUNT(*) FROM "${table}" WHERE "${column}" >= ? AND "${column}" <= ?`, since30, bench.now) ?? 0) / 30;
  const last7 = (scalar(db, `SELECT COUNT(*) FROM "${table}" WHERE "${column}" >= ? AND "${column}" <= ?`, since7, bench.now) ?? 0) / 7;
  const sizes = byTable.get(table);
  const rows = rowCounts.get(table) ?? 0;
  const bytesPerRow = rows && sizes ? (sizes.table + sizes.indexes) / rows : null;
  growthRows.push({ table, retention, rows, per_day_30d: round(last30, 1), per_day_7d: round(last7, 1), bytes_per_row: bytesPerRow === null ? null : Math.round(bytesPerRow), mb_per_day_30d: mb(bytesPerRow === null ? null : bytesPerRow * last30) });
  bench.metric(`growth.${table}.rows_per_day_30d`, `${table} rows/day (last 30 d)`, round(last30, 1), 'rows/day', 'lower');
}
bench.table('growth: rows/day and bytes/day per table', growthRows);
bench.table('rows per week (by each table\'s own timestamp)', [...weekly.values()].sort((a, b) => String(a.week).localeCompare(String(b.week))));

// ------------------------------------------------------------ observations
// Today's storeListing dedup (server/service.ts, "An unchanged price does not
// add a row per scan"): per watch+listing, a run of one price within one UTC
// day keeps its first row and one trailing row. Older rows were written once
// per scan. Walk the rows in index order and count what the rule would drop.
if (tableExists(db, 'observations')) {
  const statement = db.prepare('SELECT watch_id, listing_id, price_pln, observed_at, id FROM observations INDEXED BY observations_watch_listing ORDER BY watch_id, listing_id, observed_at, id');
  if (typeof (statement as { setReturnArrays?: (on: boolean) => void }).setReturnArrays === 'function') (statement as { setReturnArrays: (on: boolean) => void }).setReturnArrays(true);
  const started = performance.now();
  let total = 0;
  let redundant = 0;
  let runs = 0;
  let previousKey = '';
  let previousPrice: number | null = null;
  let previousDay = '';
  let runLength = 0;
  const byMonth = new Map<string, { rows: number; redundant: number }>();
  const redundantIds: number[] = [];
  const wantIds = bench.args.flags.has('compact');
  let runIds: number[] = [];
  const closeRun = () => {
    if (runLength > 2) {
      redundant += runLength - 2;
      // Keep the first and the last row of the run.
      if (wantIds) for (const id of runIds.slice(1, -1)) redundantIds.push(id);
    }
    runLength = 0;
    runIds = [];
  };
  for (const raw of statement.iterate() as Iterable<unknown>) {
    const row = raw as [string, number, number, string, number] | Record<string, unknown>;
    const [watchId, listingId, price, observedAt, id] = Array.isArray(row)
      ? row
      : [row.watch_id, row.listing_id, row.price_pln, row.observed_at, row.id] as [string, number, number, string, number];
    total += 1;
    const key = `${watchId}\u0000${listingId}`;
    const day = String(observedAt).slice(0, 10);
    const month = day.slice(0, 7);
    const monthEntry = byMonth.get(month) ?? { rows: 0, redundant: 0 };
    monthEntry.rows += 1;
    byMonth.set(month, monthEntry);
    if (key !== previousKey || Number(price) !== previousPrice || day !== previousDay) {
      // Attribute the closing run's redundant rows to its own month.
      if (runLength > 2) {
        const entry = byMonth.get(previousDay.slice(0, 7));
        if (entry) entry.redundant += runLength - 2;
      }
      closeRun();
      runs += 1;
    }
    runLength += 1;
    if (wantIds) runIds.push(Number(id));
    previousKey = key;
    previousPrice = Number(price);
    previousDay = day;
  }
  if (runLength > 2) {
    const entry = byMonth.get(previousDay.slice(0, 7));
    if (entry) entry.redundant += runLength - 2;
  }
  closeRun();
  const walkMs = performance.now() - started;
  const sizes = byTable.get('observations');
  const bytesPerRow = sizes && total ? (sizes.table + sizes.indexes) / total : null;
  bench.metric('observations.rows', 'observation rows', total, 'count', 'info');
  bench.metric('observations.redundant_rows', 'rows today\'s dedup would not write (middle rows of a same-day same-price run)', redundant, 'count', 'lower');
  bench.metric('observations.redundant_ratio', 'share of observation rows that are redundant', ratio(redundant, total), 'ratio', 'lower');
  bench.metric('observations.redundant_bytes_est', 'table+index bytes held by redundant rows (rows × bytes/row)', bytesPerRow === null ? null : Math.round(redundant * bytesPerRow), 'bytes', 'lower');
  bench.metric('observations.runs', 'price runs (watch+listing+day+price)', runs, 'count', 'info');
  bench.param('observationWalkMs', Math.round(walkMs));
  bench.table('observations by month: rows and rows the current dedup would drop', [...byMonth.entries()].sort().map(([month, entry]) => ({ month, rows: entry.rows, redundant: entry.redundant, redundant_share: round(ratio(entry.redundant, entry.rows), 3) })));

  // Rows per watch-day over the last 30 days (after dedup).
  const perWatchDay = all<Record<string, unknown>>(db, `SELECT w.name AS watch, COUNT(*) AS rows_30d, COUNT(DISTINCT substr(o.observed_at, 1, 10)) AS days,
      ROUND(COUNT(*) * 1.0 / MAX(1, COUNT(DISTINCT substr(o.observed_at, 1, 10))), 1) AS rows_per_day,
      (SELECT COUNT(*) FROM scans s WHERE s.watch_id = o.watch_id AND s.started_at >= ?) AS scans_30d
    FROM observations o JOIN watches w ON w.id = o.watch_id WHERE o.observed_at >= ? GROUP BY o.watch_id ORDER BY rows_30d DESC`, since30, since30);
  bench.table('observations per watch-day (last 30 d)', perWatchDay);

  if (wantIds) {
    // Prototype: delete the redundant rows on a copy and VACUUM it.
    const copy = writableCopy(bench.args.exportPath);
    try {
      const scratch = new DatabaseSync(copy.path) as Db;
      const t0 = performance.now();
      scratch.exec('BEGIN');
      const del = scratch.prepare('DELETE FROM observations WHERE id = ?');
      for (const id of redundantIds) del.run(id);
      scratch.exec('COMMIT');
      const deleteMs = performance.now() - t0;
      const t1 = performance.now();
      scratch.exec('VACUUM');
      const vacuumMs = performance.now() - t1;
      const obsBytes = Number((scratch.prepare("SELECT SUM(pgsize) AS b FROM dbstat WHERE name IN (SELECT name FROM sqlite_master WHERE tbl_name = 'observations')").get() as { b: number }).b);
      scratch.close();
      const after = statSync(copy.path).size;
      bench.metric('compact.observations_bytes_after', 'observations table+index bytes after compaction (measured)', obsBytes, 'bytes', 'lower');
      bench.metric('compact.file_bytes_after', 'file bytes after compaction + VACUUM (measured on a copy)', after, 'bytes', 'lower');
      bench.metric('compact.saved_bytes', 'bytes saved by compacting pre-dedup observations', fileBytes - after, 'bytes', 'higher');
      bench.param('compactDeleteMs', Math.round(deleteMs));
      bench.param('compactVacuumMs', Math.round(vacuumMs));
    } finally {
      copy.dispose();
    }
  }
}

// --------------------------------------------------- scans vs connector_runs
if (tableExists(db, 'scans') && tableExists(db, 'connector_runs')) {
  const scanRows = rowCounts.get('scans') ?? 0;
  const runRows = rowCounts.get('connector_runs') ?? 0;
  // A watch scan writes one connector_runs row (recordRun) and one scans row (createScan)
  // with the same start time; count how many runs pair up with a scan.
  const paired = scalar(db, `SELECT COUNT(*) FROM connector_runs r WHERE EXISTS (SELECT 1 FROM scans s INDEXED BY scans_started_at WHERE s.started_at = r.started_at AND s.marketplace = r.source)`) ?? 0;
  bench.metric('runs.paired_with_scan', 'connector_runs rows that duplicate a scans row (same source + start)', paired, 'count', 'lower');
  bench.metric('runs.paired_ratio', 'share of connector_runs rows paired with a scan', ratio(paired, runRows), 'ratio', 'info');
  bench.metric('scans.rows_per_day_30d', 'scan rows/day (30 d)', (scalar(db, 'SELECT COUNT(*) FROM scans WHERE started_at >= ?', since30) ?? 0) / 30, 'rows/day', 'lower');
  bench.metric('scans.zero_observation_share_7d', 'completed watch scans in the last 7 d that stored no observation row', ratio(
    scalar(db, `SELECT COUNT(*) FROM scans s WHERE s.watch_kind = 'watch' AND s.status = 'completed' AND s.started_at >= ? AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.scan_id = s.id)`, since7) ?? 0,
    scalar(db, "SELECT COUNT(*) FROM scans WHERE watch_kind = 'watch' AND status = 'completed' AND started_at >= ?", since7) ?? 0,
  ), 'ratio', 'info', 'scan_id moves to the latest scan on a same-day run, so older scans look empty; context only');
  bench.table('scans and connector_runs by status (all rows)', [
    ...all<Record<string, unknown>>(db, "SELECT 'scans' AS tbl, status, COUNT(*) AS n FROM scans GROUP BY status"),
    ...all<Record<string, unknown>>(db, "SELECT 'connector_runs' AS tbl, status, COUNT(*) AS n FROM connector_runs GROUP BY status"),
  ]);
  bench.param('scanRows', scanRows);
}

// ------------------------------------------------------------- projection
// Steady state under pruneRetention(): pruned tables hold 180 days of rows at
// the recent rate; cascade tables shrink only when their parent goes; never
// tables grow forever.
let projected = 0;
let current = 0;
const projectionRows: Array<Record<string, unknown>> = [];
for (const row of growthRows) {
  const table = String(row.table);
  const bytesPerRow = Number(row.bytes_per_row ?? 0);
  const perDay = Number(row.per_day_30d ?? 0);
  const rows = Number(row.rows ?? 0);
  const steadyRows = row.retention === 'pruned' ? perDay * 180 : null;
  const yearRows = row.retention === 'pruned' ? steadyRows : rows + perDay * 365;
  const steadyBytes = (steadyRows ?? yearRows ?? 0) * bytesPerRow;
  projected += steadyBytes;
  current += rows * bytesPerRow;
  projectionRows.push({ table, retention: row.retention, rows_now: rows, rows_steady_or_1y: Math.round(steadyRows ?? yearRows ?? 0), mb_now: mb(rows * bytesPerRow), mb_steady_or_1y: mb(steadyBytes) });
}
bench.table('projection: pruned tables at 180 d × last-30-d rate; cascade/never tables after one more year at that rate', projectionRows);
bench.metric('projection.tracked_tables_bytes_now', 'bytes in the tracked tables now', Math.round(current), 'bytes', 'info');
bench.metric('projection.tracked_tables_bytes_steady', 'bytes in the tracked tables at steady state (see table)', Math.round(projected), 'bytes', 'lower');
const preDedupObs = scalar(db, "SELECT COUNT(*) FROM observations WHERE observed_at < '2026-09-30'") ?? 0;
bench.metric('projection.pre_dedup_observations', 'observation rows written before the 2026-09-29 dedup (039f835), pruned only from 2027-02', preDedupObs, 'count', 'lower');
const oldestObservation = one<{ at: string | null }>(db, 'SELECT MIN(observed_at) AS at FROM observations')?.at ?? null;
if (oldestObservation) bench.note(`oldest observation ${oldestObservation}; pruneRetention() deletes nothing until ${new Date(Date.parse(oldestObservation) + 180 * 86_400_000).toISOString().slice(0, 10)}`);
bench.note('pruneRetention() never trims jev_shadow_log or jev_fuzzy_cache; listings/watch_listings/market rows go only with their parent (see projection table)');

bench.finish();
