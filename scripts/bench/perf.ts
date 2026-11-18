/**
 * Backend performance benchmark on real data: the repo's own ScoutService
 * against a scratch copy of an improvement export (or any Scout database).
 *
 *   SCOUT_BENCH_TMP=/disk/dir node --import tsx scripts/bench/perf.ts <export.sqlite> [--json=out.json]
 *     [--iterations=15]      warm runs per read (fewer for reads over 300 ms)
 *     [--only=a,b] [--skip=a,b]   case-name prefixes (dashboard, listings., analytics., watchAnalytics., …)
 *     [--no-rebase]          keep the export's timestamps (by default every *_at/*_until value is shifted
 *                            by now − exported_at, so the 12 h feed, 30/180-day windows and retention
 *                            see the data as it was at export time)
 *     [--with-images]        refill the photo blobs the export removed (zeroblob(byte_size)) so file-size
 *                            bound work (backup, debug snapshot, improvement export) sees the live size
 *     [--heavy]              also run GET /api/export (JSON stream), POST /api/backup, the debug snapshot and
 *                            the improvement export build (each blocks or loads the process; seconds)
 *     [--prune]              also run pruneRetention() as it will behave once the oldest data ages out
 *                            (destructive on the copy, so it runs last)
 *     [--prune-day=YYYY-MM-DD]  the day the --prune scenarios age out (default: the busiest observation day;
 *                            pin it when comparing an --apply that changes observation counts)
 *     [--apply=file.sql]     run this SQL on the copy before measuring (prototype an index or rewrite;
 *                            diff the two JSON reports with compare.ts)
 *     [--explain-ms=20]      EXPLAIN QUERY PLAN for statements slower than this (max per call)
 *     [--keep]               keep the scratch copy
 *
 * Safety: the input is copied (SCOUT_BENCH_TMP, default the OS temp dir: use
 * a disk path, the copy is 200+ MB), every non-loopback network call is
 * blocked (perf-netguard.ts), AI dependencies are stubs that only count, the
 * scheduler finds nothing due, webhooks/ntfy/AI keys/marketplace sessions are
 * removed from the copy. The copy is deleted on exit unless --keep.
 *
 * What is measured:
 * - openDatabase() on the copy (migration checksums, pragmas, scan recovery) and the ScoutService constructor;
 * - every service read behind the GET endpoints the web app, iOS app and MCP use: cold call, warm
 *   p50/p90/max, response JSON bytes and stringify time; reads are synchronous, so their time is
 *   event-loop time;
 * - scheduler idle tick; duplicate refresh; quick-flag backfill (no-op); retention prune (no-op today,
 *   and with --prune the day the oldest rows age out);
 * - the write path: the real runWatch() for the busiest enabled watch with an injected adapter that
 *   returns that watch's own latest listings (unchanged prices = the steady-state scan) plus new offers;
 * - per SQL statement: calls, total and max ms, rows; EXPLAIN QUERY PLAN flags for slow ones
 *   (full scans of big tables, temp b-trees, correlated subqueries); which indexes no plan used.
 *
 * Timings move 2-3x with host load, so compare a candidate on alternating runs
 * (base, candidate, base, candidate) rather than against one old baseline. Set
 * SQLITE_TMPDIR to a disk path too when using --heavy or --with-images: VACUUM
 * temp files otherwise land in /tmp.
 */

import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import { Bench, distribution, scalar, writableCopy, type Distribution } from './lib';
import { blockedAttempts, installNetGuard } from './perf-netguard';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bench = new Bench('perf');
const flags = bench.args.flags;
const flagList = (name: string) => (typeof flags.get(name) === 'string' ? String(flags.get(name)).split(',').map((item) => item.trim()).filter(Boolean) : []);
const only = flagList('only');
const skip = flagList('skip');
const selected = (name: string) => (!only.length || only.some((prefix) => name.startsWith(prefix))) && !skip.some((prefix) => name.startsWith(prefix));
const iterations = Math.max(1, Number(flags.get('iterations') ?? 15));
const explainMs = Number(flags.get('explain-ms') ?? 20);
const log = (message: string) => process.stderr.write(`[perf] ${message}\n`);
const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const exportedAt = bench.report.export.exportedAt;

// ------------------------------------------------------------------ environment
// Before any server module loads: no network, no browser, no provider keys.
process.env.SCOUT_SECRET = 'scout-bench-only-secret-0b7d1e9f3a5c7e9b1d3f5a7c9e1b3d5f';
process.env.SCOUT_SKIP_MIGRATION_BACKUP = 'true';
process.env.SCOUT_CHROMIUM_PATH = '/nonexistent/scout-bench-no-browser';
for (const key of ['OPENROUTER_API_KEY', 'SCOUT_OPENROUTER_API_KEY', 'SCOUT_DEEPSEEK_API_KEY', 'SCOUT_OPENROUTER_MODEL', 'SCOUT_JEV_MODE', 'SCOUT_JEV_MODEL', 'SCOUT_VISION_MODEL', 'SCOUT_BROWSER_WS', 'SCOUT_DB_PATH']) delete process.env[key];
installNetGuard();
syncBuiltinESMExports();
v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc') as () => void;
process.chdir(REPO);

const { openDatabase, backupDatabase } = await import('../../server/db');
const { ScoutService } = await import('../../server/service');
const { dealsForAgent } = await import('../../server/deals');
const { FlipStore } = await import('../../server/flips');
const { ScoutDebug } = await import('../../server/debug');
const { buildImprovementExport, improvementContext } = await import('../../server/improvementExport');

// --------------------------------------------------------------------- copy
const copy = writableCopy(bench.args.exportPath);
const keep = flags.has('keep');
const cleanup = () => { if (!keep) copy.dispose(); };
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { cleanup(); process.exit(130); });
log(`copy ${copy.path}`);

const saved = { info: console.info, log: console.log, warn: console.warn, error: console.error };
const quiet = () => { console.info = () => {}; console.log = () => {}; console.warn = () => {}; };
const loud = () => Object.assign(console, saved);

// ---------------------------------------------------------------- open timings
quiet();
const openSamples: number[] = [];
let db: any;
for (let index = 0; index < 3; index += 1) {
  const started = performance.now();
  db = openDatabase(copy.path);
  openSamples.push(performance.now() - started);
  if (index < 2) db.close();
}
loud();
bench.metric('startup.openDatabase.first_ms', 'openDatabase() on a fresh copy (first open)', round(openSamples[0]), 'ms', 'lower');
bench.metric('startup.openDatabase.warm_ms', 'openDatabase() reopen (OS cache warm)', round(Math.min(openSamples[1], openSamples[2])), 'ms', 'lower');

// ------------------------------------------------------------- copy fix-ups
function rebase(): { shiftedSeconds: number; ms: number } {
  if (flags.has('no-rebase') || !exportedAt) return { shiftedSeconds: 0, ms: 0 };
  const deltaSeconds = (Date.now() - Date.parse(exportedAt)) / 1000;
  if (Math.abs(deltaSeconds) < 1) return { shiftedSeconds: 0, ms: 0 };
  const modifier = `${deltaSeconds >= 0 ? '+' : ''}${deltaSeconds.toFixed(3)} seconds`;
  const shiftIso = (value: string) => new Date(Date.parse(value) + deltaSeconds * 1000).toISOString();
  const dayShift = Math.round(deltaSeconds / 86_400);
  const started = performance.now();
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('migrations', 'export_info', 'export_logs', 'export_tables')").all() as Array<{ name: string }>).map((row) => row.name);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of tables) {
      for (const { name } of db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>) {
        if (/(_at|_until)$/.test(name)) {
          db.prepare(`UPDATE "${table}" SET "${name}" = strftime('%Y-%m-%dT%H:%M:%fZ', "${name}", ?) WHERE "${name}" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*' AND "${name}" < '9000'`).run(modifier);
        } else if (name === 'digest_date' && dayShift) {
          db.prepare(`UPDATE "${table}" SET "${name}" = date("${name}", ?) WHERE "${name}" IS NOT NULL`).run(`${dayShift >= 0 ? '+' : ''}${dayShift} days`);
        }
      }
    }
    for (const key of ['last_prune', 'daily_digest_last_sent_at', 'last_duplicate_refresh']) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value?: string } | undefined;
      if (row?.value && Number.isFinite(Date.parse(row.value))) db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(shiftIso(row.value), key);
    }
    for (const watch of db.prepare('SELECT id, source_next_scan_json FROM watches WHERE source_next_scan_json IS NOT NULL').all() as Array<{ id: string; source_next_scan_json: string }>) {
      try {
        const parsed = JSON.parse(watch.source_next_scan_json) as Record<string, string>;
        db.prepare('UPDATE watches SET source_next_scan_json = ? WHERE id = ?').run(JSON.stringify(Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, value < '9000' ? shiftIso(value) : value]))), watch.id);
      } catch { /* leave malformed values */ }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { shiftedSeconds: Math.round(deltaSeconds), ms: Math.round(performance.now() - started) };
}

const FAR_FUTURE = '9999-12-31T00:00:00.000Z';
function neutralize() {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('UPDATE watches SET next_scan_at = ?').run(FAR_FUTURE);
    db.prepare('UPDATE market_watches SET next_scan_at = ?').run(FAR_FUTURE);
    for (const watch of db.prepare('SELECT id, sources_json FROM watches').all() as Array<{ id: string; sources_json: string }>) {
      const sources = JSON.parse(watch.sources_json || '[]') as string[];
      db.prepare('UPDATE watches SET source_next_scan_json = ? WHERE id = ?').run(JSON.stringify(Object.fromEntries(sources.map((source) => [source, FAR_FUTURE]))), watch.id);
    }
    db.prepare("UPDATE notification_deliveries SET attempt_count = MAX(attempt_count, 5), next_attempt_at = NULL WHERE status <> 'delivered'").run();
    db.prepare("DELETE FROM settings WHERE key IN ('discord_webhook', 'ntfy_config', 'openrouter_api_key', 'deepseek_api_key', 'daily_digest_config')").run();
    db.prepare('DELETE FROM marketplace_sessions').run();
    // A live database has no export tables; the improvement export build refuses to overwrite them.
    for (const table of ['export_info', 'export_logs', 'export_tables']) db.exec(`DROP TABLE IF EXISTS ${table}`);
    const now = new Date().toISOString();
    for (const key of ['last_prune', 'last_duplicate_refresh']) db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, now, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

const rebased = rebase();
bench.param('rebase', rebased);
neutralize();
if (rebased.ms) {
  // The rebase rewrote every timestamp column, which leaves the indexes on them half-empty
  // and out of order; VACUUM restores the export's compact layout so sizes and scans match.
  const started = performance.now();
  db.exec('VACUUM');
  bench.param('vacuumAfterRebaseMs', Math.round(performance.now() - started));
}
if (flags.has('with-images')) {
  // After the VACUUM, so it does not rewrite half a gigabyte of zeros.
  const started = performance.now();
  db.exec('BEGIN IMMEDIATE');
  db.exec('UPDATE market_listing_snapshot_images SET data = zeroblob(byte_size) WHERE byte_size > 0');
  db.exec('UPDATE flip_photos SET data = zeroblob(byte_size) WHERE byte_size > 0');
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  bench.param('withImages', { ms: Math.round(performance.now() - started), fileBytes: statSync(copy.path).size });
}
const applyPath = flags.get('apply');
if (typeof applyPath === 'string') {
  const sql = readFileSync(resolve(applyPath), 'utf8');
  const changesBefore = Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n);
  const started = performance.now();
  db.exec(sql);
  const changes = Number((db.prepare('SELECT total_changes() AS n').get() as { n: number }).n) - changesBefore;
  bench.param('apply', { file: resolve(applyPath), ms: Math.round(performance.now() - started), changes });
  log(`applied ${applyPath} in ${Math.round(performance.now() - started)} ms`);
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
bench.param('copyBytes', statSync(copy.path).size);
try { bench.param('gitHead', execFileSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()); } catch { /* not a checkout */ }
bench.param('node', process.version);
bench.param('sqlite', (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v);

// ----------------------------------------------------- statement instrumentation
interface SqlStat { sql: string; calls: number; totalMs: number; maxMs: number; rows: number; params: unknown[] | null; cases: Set<string> }
const sqlStats = new Map<string, SqlStat>();
let currentCase = 'setup';
let prepareCount = 0;
const realPrepare = db.prepare.bind(db);
db.prepare = (sql: string) => {
  prepareCount += 1;
  const statement = realPrepare(sql);
  const record = (ms: number, rows: number, params: unknown[]) => {
    let stat = sqlStats.get(sql);
    if (!stat) { stat = { sql, calls: 0, totalMs: 0, maxMs: 0, rows: 0, params: null, cases: new Set() }; sqlStats.set(sql, stat); }
    stat.calls += 1;
    stat.totalMs += ms;
    if (ms >= stat.maxMs) { stat.maxMs = ms; stat.params = params; }
    stat.rows += rows;
    stat.cases.add(currentCase);
  };
  return new Proxy(statement, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'all' || prop === 'get' || prop === 'run') {
        return (...args: unknown[]) => {
          const started = performance.now();
          const result = value.apply(target, args);
          const rows = prop === 'all' ? (result as unknown[]).length : prop === 'get' ? (result ? 1 : 0) : Number((result as { changes?: number }).changes ?? 0);
          record(performance.now() - started, rows, args);
          return result;
        };
      }
      if (prop === 'iterate') {
        return (...args: unknown[]) => { record(0, 0, args); return value.apply(target, args); };
      }
      return value.bind(target);
    },
  });
};

// ----------------------------------------------------------------- service
const aiCalls: Record<string, number> = {};
const countAi = (name: string) => async () => { aiCalls[name] = (aiCalls[name] ?? 0) + 1; throw new Error(`bench: ${name} disabled`); };
function createService() {
  const service: any = new ScoutService(db, () => {}, {
    classifyListingRelevance: countAi('relevance') as any,
    verifyListingDescription: countAi('verification') as any,
    classifyListingRelevanceWithJev: countAi('jev.relevance') as any,
    verifyListingDescriptionWithJev: countAi('jev.verification') as any,
    classifyTermMatchWithJev: countAi('jev.termMatch') as any,
    classifyNegotiabilityWithJev: countAi('jev.negotiability') as any,
    classifyConditionMatchWithJev: countAi('jev.condition') as any,
    classifyWatchVariantWithJev: countAi('jev.variant') as any,
    classifyChecksWithJev: countAi('jev.checks') as any,
    suggestVariantGroups: async () => [],
    writeResaleListing: countAi('resale') as any,
    classifyListingRelevanceWithVision: countAi('vision.relevance') as any,
    verifyListingDescriptionWithVision: countAi('vision.verification') as any,
    readPurchaseScreenshot: countAi('vision.screenshot') as any,
    fetchListingDetailHtml: countAi('net.detailHtml') as any,
    inboxFetch: countAi('net.inbox') as any,
  });
  for (const name of ['requestOlxApi', 'requestVintedApi', 'requestVintedItemPage', 'requestAllegroLokalnieApi', 'bootstrapVintedCookies', 'renderInBrowser', 'fetchSnapshotImage', 'requestPublicPage']) {
    service[name] = countAi(`net.${name}`);
  }
  return service;
}
quiet();
const constructStarted = performance.now();
const service = createService();
bench.metric('startup.service_ctor_ms', 'new ScoutService()', round(performance.now() - constructStarted), 'ms', 'lower');
loud();
// A long-running server has a full 500-entry log buffer.
quiet();
console.error = () => {};
for (let index = 0; index < 500; index += 1) service.log(index % 17 ? 'info' : 'error', 'watch', `gtx 1660 · OLX: query-search → olx-api · fetched=${40 + (index % 9)} · ${index}`);
loud();

// ------------------------------------------------------------------ targets
const one = <T>(sql: string, ...params: unknown[]) => realPrepare(sql).get(...params) as T | undefined;
const enabledWatches = realPrepare("SELECT w.id, w.name, (SELECT COUNT(*) FROM watch_listings wl WHERE wl.watch_id = w.id) AS n FROM watches w WHERE w.enabled = 1 AND w.archived_at IS NULL ORDER BY n DESC").all() as Array<{ id: string; name: string; n: number }>;
const allWatchIds = realPrepare('SELECT id, name, enabled FROM watches WHERE archived_at IS NULL ORDER BY id').all() as Array<{ id: string; name: string; enabled: number }>;
const busiestWatch = enabledWatches[0];
const busyListing = one<{ watch_id: string; marketplace: string; listing_id: string; n: number }>(`SELECT o.watch_id, l.marketplace, l.listing_id, COUNT(*) AS n FROM observations o JOIN listings l ON l.id = o.listing_id
  WHERE o.watch_id = ? GROUP BY o.listing_id ORDER BY n DESC LIMIT 1`, busiestWatch.id);
const busyKey = busyListing ? `${busyListing.marketplace}:${busyListing.listing_id}` : 'OLX:0';
const marketWatch = one<{ id: string }>("SELECT market_watch_id AS id FROM market_listings GROUP BY market_watch_id ORDER BY COUNT(*) DESC LIMIT 1");
const marketListing = one<{ id: number }>('SELECT market_listing_id AS id FROM market_price_observations GROUP BY market_listing_id ORDER BY COUNT(*) DESC LIMIT 1');
const snapshotListing = one<{ id: number }>('SELECT s.market_listing_id AS id FROM market_listing_snapshots s JOIN market_listing_snapshot_images i ON i.snapshot_id = s.id GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1');
const searchTerm = (busiestWatch.name.match(/\d{3,5}/)?.[0] ?? busiestWatch.name).toLowerCase();
bench.param('targets', { busiestWatch, busyKey, busyObservations: busyListing?.n ?? 0, marketWatch: marketWatch?.id, marketListing: marketListing?.id, snapshotListing: snapshotListing?.id, searchTerm });

// -------------------------------------------------------------------- reads
interface ReadCase { name: string; endpoint: string; run: () => unknown }
const listingBody = (page: { listings: unknown; pagination: unknown }) => ({ listings: page.listings, pagination: page.pagination });
const flipStore = new FlipStore(db);
const reads: ReadCase[] = [
  { name: 'dashboard.web', endpoint: 'GET /api/dashboard?listings=none (web app)', run: () => service.dashboard({ listings: 'none' }) },
  { name: 'dashboard.full', endpoint: 'GET /api/dashboard (iOS app, 500-row feed)', run: () => service.dashboard() },
  { name: 'dashboard.widget', endpoint: 'GET /api/dashboard?top=10 (iOS widget)', run: () => service.dashboard({ top: 10 }) },
  { name: 'watches.active', endpoint: 'GET /api/watches', run: () => ({ watches: service.getWatches() }) },
  { name: 'watches.all', endpoint: 'GET /api/watches?includeArchived=true', run: () => ({ watches: service.allWatches() }) },
  { name: 'listings.topDeals', endpoint: 'GET /api/listings (Overview Top deals: sort=deal minStrength=3 pageSize=25)', run: () => listingBody(service.listingsPage({ sort: 'deal', minStrength: 3, visibility: 'visible', aiFiltered: 'exclude', excludePassed: true, pageSize: 25 })) },
  { name: 'listings.newest', endpoint: 'GET /api/listings?pageSize=50&sort=newest (Listings page)', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'newest', visibility: 'visible', aiFiltered: 'exclude' })) },
  { name: 'listings.strongest', endpoint: 'GET /api/listings?pageSize=50&sort=strongest', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'strongest', visibility: 'visible', aiFiltered: 'exclude' })) },
  { name: 'listings.price', endpoint: 'GET /api/listings?pageSize=50&sort=price', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'price', visibility: 'visible', aiFiltered: 'exclude' })) },
  { name: 'listings.watch', endpoint: 'GET /api/listings?watchId=<busiest>&pageSize=50', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'newest', visibility: 'visible', aiFiltered: 'exclude', watchId: busiestWatch.id })) },
  { name: 'listings.search', endpoint: `GET /api/listings?q=${searchTerm}&pageSize=50`, run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'newest', visibility: 'visible', aiFiltered: 'exclude', q: searchTerm })) },
  { name: 'listings.hidden', endpoint: 'GET /api/listings?visibility=hidden (no 12 h window)', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'newest', visibility: 'hidden', aiFiltered: 'exclude' })) },
  { name: 'listings.decision', endpoint: 'GET /api/listings?decision=pass (no 12 h window)', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'newest', visibility: 'all', decision: 'pass', aiFiltered: 'include' })) },
  { name: 'listings.aiOnly', endpoint: 'GET /api/listings?aiFiltered=only', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'newest', visibility: 'visible', aiFiltered: 'only' })) },
  { name: 'listings.page500', endpoint: 'GET /api/listings?pageSize=500 (the full feed the iOS dashboard embeds)', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 500, sort: 'newest', visibility: 'visible', aiFiltered: 'exclude' })) },
  { name: 'listings.qualifiesFlags', endpoint: 'GET /api/listings?qualifiesOnly=true&excludeFlags=for_parts,damaged,wanted_ad', run: () => listingBody(service.listingsPage({ page: 1, pageSize: 50, sort: 'deal', visibility: 'visible', aiFiltered: 'exclude', qualifiesOnly: true, excludeFlags: ['for_parts', 'damaged', 'wanted_ad'] })) },
  { name: 'deals.agent', endpoint: 'MCP scout_deals (default)', run: () => dealsForAgent(service, {}) },
  { name: 'listingDetail.watch', endpoint: 'GET /api/listing-detail?key=<busiest>&watchId=<watch>', run: () => service.listingDetail(busyKey, busiestWatch.id) },
  { name: 'listingDetail.nowatch', endpoint: 'GET /api/listing-detail?key=<busiest>', run: () => service.listingDetail(busyKey) },
  { name: 'listingAction', endpoint: 'GET /api/listing-actions?key=<busiest>', run: () => service.listingAction(busyKey) },
  { name: 'analytics.30d', endpoint: 'GET /api/analytics?days=30', run: () => service.analytics({ days: 30, negotiations: true }) },
  { name: 'analytics.180d', endpoint: 'GET /api/analytics?days=180', run: () => service.analytics({ days: 180, negotiations: true }) },
  { name: 'analytics.watch-30d', endpoint: 'GET /api/analytics?days=30&watchId=<busiest>', run: () => service.analytics({ days: 30, watchId: busiestWatch.id, negotiations: true }) },
  { name: 'analytics.olx-180d', endpoint: 'GET /api/analytics?days=180&marketplace=OLX', run: () => service.analytics({ days: 180, marketplace: 'OLX', negotiations: true }) },
  ...allWatchIds.flatMap((watch) => [30, 180].map((days): ReadCase => ({
    name: `watchAnalytics.${watch.name.replace(/\s+/g, '_')}.${days}d`,
    endpoint: `GET /api/watches/${watch.id}/analytics?days=${days}${watch.enabled ? '' : ' (disabled watch)'}`,
    run: () => service.watchAnalytics(watch.id, days, { negotiations: true }),
  }))),
  { name: 'comparables', endpoint: 'MCP scout_comparables(<busiest>)', run: () => service.comparables({ listingKey: busyKey, watchId: busiestWatch.id }) },
  { name: 'marketResearch.default', endpoint: 'GET /api/market-watches?page=1&pageSize=100', run: () => service.marketResearch({ page: 1, pageSize: 100 }) },
  { name: 'marketResearch.summary', endpoint: 'GET /api/market-watches?pageSize=1 (iOS)', run: () => service.marketResearch({ page: 1, pageSize: 1 }) },
  { name: 'marketResearch.watch', endpoint: 'GET /api/market-watches?watchId=<busiest>&pageSize=100', run: () => service.marketResearch({ page: 1, pageSize: 100, watchId: marketWatch?.id }) },
  { name: 'marketResearch.ended', endpoint: 'GET /api/market-watches?status=ended&pageSize=100', run: () => service.marketResearch({ page: 1, pageSize: 100, status: 'ended' }) },
  { name: 'marketWatchTrend.90d', endpoint: 'GET /api/market-watches/:id/trend?days=90', run: () => service.marketWatchTrend(marketWatch?.id, 90) },
  { name: 'marketWatchTrend.180d', endpoint: 'GET /api/market-watches/:id/trend?days=180', run: () => service.marketWatchTrend(marketWatch?.id, 180) },
  { name: 'marketListingHistory', endpoint: 'GET /api/market-listings/:id/history', run: () => ({ points: service.marketListingHistory(Number(marketListing?.id ?? 1)) }) },
  { name: 'marketListingSnapshot', endpoint: 'GET /api/market-listings/:id/snapshot', run: () => ({ snapshot: service.marketListingSnapshot(Number(snapshotListing?.id ?? 1)) }) },
  { name: 'connectors', endpoint: 'GET /api/connectors', run: () => ({ connectors: service.getConnectors() }) },
  { name: 'readiness', endpoint: 'GET /api/ready (every probe)', run: () => service.readiness() },
  { name: 'settings', endpoint: 'GET /api/settings', run: () => service.settings() },
  { name: 'marketplaceSessions', endpoint: 'GET /api/marketplace-sessions', run: () => ({ sessions: service.marketplaceSessions() }) },
  { name: 'notificationsPage', endpoint: 'GET /api/notifications?page=1&pageSize=100', run: () => service.notificationsPage({ page: 1, pageSize: 100 }) },
  { name: 'connectorRunsPage', endpoint: 'GET /api/connector-runs?page=1&pageSize=100', run: () => service.connectorRunsPage({ page: 1, pageSize: 100 }) },
  { name: 'logs', endpoint: 'GET /api/logs (500 entries)', run: () => ({ logs: service.logs() }) },
  { name: 'flips', endpoint: 'GET /api/flips', run: () => flipStore.list() },
  { name: 'flipsForAgent', endpoint: 'MCP scout_flips', run: () => service.flipsForAgent({ status: 'all' }) },
  { name: 'improvementContext', endpoint: 'improvement export context (settings + readiness + connectors + logs)', run: () => improvementContext(service) },
];

const readRows: Array<Record<string, unknown>> = [];
for (const read of reads) {
  if (!selected(read.name)) continue;
  currentCase = read.name;
  gc();
  quiet();
  let result: unknown;
  let coldMs: number;
  const preparesBefore = prepareCount;
  try {
    const started = performance.now();
    result = read.run();
    coldMs = performance.now() - started;
  } catch (error) {
    loud();
    log(`${read.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  const coldPrepares = prepareCount - preparesBefore;
  const runs = coldMs > 1000 ? 3 : coldMs > 300 ? 5 : iterations;
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    result = read.run();
    samples.push(performance.now() - started);
  }
  const stringifyStarted = performance.now();
  const body = JSON.stringify(result);
  const stringifyMs = performance.now() - stringifyStarted;
  loud();
  const warm = distribution(samples);
  const bytes = Buffer.byteLength(body);
  readRows.push({ case: read.name, cold_ms: round(coldMs), p50_ms: round(warm.p50 ?? 0), p90_ms: round(warm.p90 ?? 0), max_ms: round(warm.max ?? 0), n: warm.n, kb: round(bytes / 1024, 1), stringify_ms: round(stringifyMs), prepares_cold: coldPrepares, endpoint: read.endpoint });
  bench.metric(`read.${read.name}.p50_ms`, `${read.endpoint} p50`, round(warm.p50 ?? 0, 3), 'ms', 'lower');
  bench.metric(`read.${read.name}.p90_ms`, `${read.endpoint} p90`, round(warm.p90 ?? 0, 3), 'ms', 'lower');
  bench.metric(`read.${read.name}.bytes`, `${read.endpoint} JSON bytes`, bytes, 'bytes', 'lower');
  log(`${read.name}: p50 ${round(warm.p50 ?? 0)} ms, cold ${round(coldMs)} ms, ${round(bytes / 1024, 1)} KB`);
}
bench.table('reads (warm p50/p90/max over n runs; cold = first call on a fresh statement cache)', readRows.sort((a, b) => Number(b.p50_ms) - Number(a.p50_ms)));

// ---------------------------------------------------------- scheduler + upkeep
const nextTick = () => new Promise<void>((done) => setImmediate(done));
if (selected('tick')) {
  currentCase = 'tick.idle';
  quiet();
  const sync: number[] = [];
  const total: number[] = [];
  for (let index = 0; index < 31; index += 1) {
    const started = performance.now();
    service.schedulerTick();
    const syncMs = performance.now() - started;
    await nextTick();
    await nextTick();
    if (index) { sync.push(syncMs); total.push(performance.now() - started); }
  }
  loud();
  bench.distributionMetrics('tick.idle.sync_ms', 'scheduler tick, nothing due (sync part)', distribution(sync), 'ms', 'lower', ['p50', 'p90']);
  bench.distributionMetrics('tick.idle.total_ms', 'scheduler tick incl. async continuations', distribution(total), 'ms', 'lower', ['p50']);
}

if (selected('duplicates')) {
  currentCase = 'duplicates.refresh';
  quiet();
  const samples: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const started = performance.now();
    service.refreshDuplicatePairs();
    samples.push(performance.now() - started);
  }
  loud();
  bench.metric('upkeep.duplicates.first_ms', 'refreshDuplicatePairs() first run (every DUPLICATE_REFRESH_MS on a scheduler tick)', round(samples[0]), 'ms', 'lower');
  bench.metric('upkeep.duplicates.p50_ms', 'refreshDuplicatePairs() repeat', round(distribution(samples.slice(1)).p50 ?? 0), 'ms', 'lower');
  bench.metric('upkeep.duplicates.pairs', 'duplicate pairs stored', scalar(db, 'SELECT COUNT(*) FROM listing_duplicate_pairs'), 'count', 'info');
}

if (selected('flags')) {
  currentCase = 'flags.backfill';
  quiet();
  const started = performance.now();
  const updated = await service.backfillListingFlags();
  loud();
  bench.metric('upkeep.flagBackfill.ms', 'backfillListingFlags() at startup (nothing to do when versions match)', round(performance.now() - started), 'ms', 'lower', `${updated} rows updated`);
}

function pruneOnce(label: string, fakeNow: number | null) {
  currentCase = label;
  db.prepare("DELETE FROM settings WHERE key = 'last_prune'").run();
  const counts = () => Object.fromEntries(['observations', 'scans', 'connector_runs', 'listings', 'watch_listings', 'listing_relevance', 'manual_relevance_cache', 'market_price_observations'].map((table) => [table, Number((realPrepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
  const before = counts();
  const realNow = Date.now;
  // The live scheduler refreshes duplicate pairs hourly, so no pair outlives its 14-day window;
  // jumping the clock 180 days without that refresh would trip listing_duplicate_pairs' foreign key.
  if (fakeNow !== null) { quiet(); service.refreshDuplicatePairs(fakeNow); loud(); }
  if (fakeNow !== null) Date.now = () => fakeNow;
  const started = performance.now();
  try { service.pruneRetention(); } finally { Date.now = realNow; }
  const ms = performance.now() - started;
  const after = counts();
  const deleted = Object.fromEntries(Object.keys(before).map((key) => [key, before[key] - after[key]]).filter(([, value]) => value));
  return { ms, deleted };
}

if (selected('prune')) {
  const noop = pruneOnce('prune.noop', null);
  bench.metric('upkeep.prune.noop_ms', 'pruneRetention() when nothing is older than 180 d (runs once a day)', round(noop.ms), 'ms', 'lower', JSON.stringify(noop.deleted));
}

// ---------------------------------------------------------------- write path
interface Phase { ms: number; calls: number }
function instrumentPhases(target: any) {
  const totals: Record<string, Phase> = {};
  const add = (name: string, ms: number) => { const entry = totals[name] ?? (totals[name] = { ms: 0, calls: 0 }); entry.ms += ms; entry.calls += 1; };
  const sync = ['referenceBandMedian', 'watchBaselines', 'scanVariantResolver', 'storeListing', 'transaction', 'createScan', 'completeScan', 'recordRun', 'finishRun', 'activeConnectorBackoff', 'scanNotifyContext', 'scanOrdinal'];
  const asyncPhases = ['fetchSearchPages', 'enrichShipping', 'fuzzyRescueForSearch', 'assignVariantsWithJev', 'filterListingsByAiRelevance', 'processDealCandidates', 'verifyHighPriorityDeal', 'notifyDeal', 'autoGenerateVariantGroups'];
  for (const name of sync) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = (...args: unknown[]) => { const started = performance.now(); try { return original.apply(target, args); } finally { add(name, performance.now() - started); } };
  }
  for (const name of asyncPhases) {
    const original = target[name];
    if (typeof original !== 'function') continue;
    target[name] = async (...args: unknown[]) => { const started = performance.now(); try { return await original.apply(target, args); } finally { add(name, performance.now() - started); } };
  }
  return () => { const snapshot = { ...totals }; for (const key of Object.keys(totals)) delete totals[key]; return snapshot; };
}

const WRITE_TABLES = ['observations', 'listings', 'watch_listings', 'scans', 'connector_runs', 'notifications', 'notification_deliveries', 'listing_relevance', 'jev_shadow_log', 'daily_digest_candidates', 'listing_detail_snapshots'];
const tableCounts = () => Object.fromEntries(WRITE_TABLES.map((table) => [table, Number((realPrepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n)]));
const totalChanges = () => Number((realPrepare('SELECT total_changes() AS n').get() as { n: number }).n);

async function scanCase(name: string, watchId: string, source: string, newOffers: number, iterationsForScan: number) {
  const writer = createService();
  const takePhases = instrumentPhases(writer);
  const row = realPrepare('SELECT * FROM watches WHERE id = ?').get(watchId) as Record<string, any>;
  const existing = realPrepare(`SELECT l.marketplace, l.listing_id, l.title, l.price_pln, l.url, l.image_url, l.condition, l.location, l.shipping_available, l.price_negotiable, l.posted_at, l.seller_type
    FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id WHERE wl.watch_id = ? AND l.marketplace = ? ORDER BY wl.last_seen_at DESC, wl.id DESC LIMIT 40`).all(watchId, source) as Array<Record<string, any>>;
  if (!existing.length) { log(`${name}: no listings for ${watchId} on ${source}`); return; }
  const typical = Number((realPrepare('SELECT AVG(typical_pln) AS t FROM watch_listings WHERE watch_id = ? AND typical_pln > 0').get(watchId) as { t: number | null }).t ?? existing[0].price_pln);
  const results: Array<{ ms: number; changes: number; rows: Record<string, number>; phases: Record<string, Phase>; prepares: number }> = [];
  for (let iteration = 0; iteration <= iterationsForScan; iteration += 1) {
    const observedAt = new Date().toISOString();
    const listings: any[] = existing.map((item) => ({
      marketplace: item.marketplace, listingId: String(item.listing_id), title: String(item.title), price: Number(item.price_pln), currency: 'PLN', url: String(item.url),
      imageUrl: item.image_url ?? undefined, condition: item.condition ?? undefined, location: item.location ?? undefined,
      shippingAvailable: item.shipping_available === null ? null : Boolean(item.shipping_available), priceNegotiable: item.price_negotiable === null ? null : Boolean(item.price_negotiable),
      postedAt: item.posted_at ?? undefined, sellerType: item.seller_type ?? undefined, observedAt,
    }));
    for (let index = 0; index < newOffers; index += 1) {
      const template = existing[index % existing.length];
      const id = `9${Date.now() % 1_000_000_000}${iteration}${index}`;
      listings.unshift({ ...listings[index % existing.length], listingId: id, url: String(template.url).replace(/[^/]+$/, `bench-${id}`), price: Math.max(10, Math.round(typical * (index === 0 ? 0.62 : 0.97))), observedAt });
    }
    writer.createConnectorAdapter = (marketplace: string, onPath?: (path: string) => void) => {
      onPath?.('bench-fixture');
      return {
        marketplace,
        fetchPublicSearch: async () => Object.assign(listings.map((listing) => ({ ...listing })), { pageStatus: 'results', empty: false }),
        fetchDetail: async () => ({ availability: { status: 'live' } }),
        verifyAvailability: async () => ({ status: 'live' }),
      };
    };
    const before = tableCounts();
    const changesBefore = totalChanges();
    takePhases();
    const preparesBefore = prepareCount;
    currentCase = name;
    quiet();
    const started = performance.now();
    await writer.runWatch({ ...row, sources_json: JSON.stringify([source]) }, { forceAll: true });
    const ms = performance.now() - started;
    loud();
    const phases = takePhases();
    const after = tableCounts();
    results.push({ ms, changes: totalChanges() - changesBefore, rows: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]).filter(([, value]) => value)), phases, prepares: prepareCount - preparesBefore });
  }
  const [first, ...steady] = results;
  const dist = distribution(steady.map((item) => item.ms));
  const last = steady[steady.length - 1] ?? first;
  bench.metric(`scan.${name}.p50_ms`, `runWatch ${source} ${existing.length} known + ${newOffers} new listings p50`, round(dist.p50 ?? 0), 'ms', 'lower');
  bench.metric(`scan.${name}.first_ms`, `runWatch ${source} first run (cold statements)`, round(first.ms), 'ms', 'lower');
  bench.metric(`scan.${name}.changes`, 'rows changed per steady scan (total_changes)', last.changes, 'rows', 'lower');
  const phaseRows = Object.keys(last.phases).map((key) => ({ phase: key, p50_ms: round(distribution(steady.map((item) => item.phases[key]?.ms ?? 0)).p50 ?? 0), calls: last.phases[key].calls })).sort((a, b) => b.p50_ms - a.p50_ms);
  bench.table(`scan ${name}: phases (nested: transaction ⊇ storeListing)`, phaseRows);
  bench.table(`scan ${name}: rows written per steady scan`, [last.rows as Record<string, unknown>]);
  log(`${name}: p50 ${round(dist.p50 ?? 0)} ms, first ${round(first.ms)} ms, changes ${last.changes}`);
}

if (selected('scan')) {
  const sources = ['OLX', 'Vinted', 'Allegro Lokalnie'];
  for (const source of sources) {
    await scanCase(`steady.${source.split(' ')[0].toLowerCase()}`, busiestWatch.id, source, 0, 5);
  }
  await scanCase('new2.olx', busiestWatch.id, 'OLX', 2, 5);
}

// -------------------------------------------------------------------- heavy
async function measureHeavy(name: string, label: string, run: () => unknown) {
  currentCase = name;
  gc();
  const heapBefore = process.memoryUsage().heapUsed;
  const rssBefore = process.resourceUsage().maxRSS;
  // How late a 20 ms timer fires while the operation runs: the event-loop
  // block a request would see (all of it while the work is synchronous).
  let maxLag = 0;
  let expected = performance.now() + 20;
  const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - expected); expected = now + 20; }, 20);
  quiet();
  const started = performance.now();
  const result = await run();
  const ms = performance.now() - started;
  // A synchronous run never let the timer fire: its whole duration was the block.
  const lag = Math.max(maxLag, performance.now() - expected);
  loud();
  clearInterval(timer);
  const heapAfter = process.memoryUsage().heapUsed;
  bench.metric(`heavy.${name}.ms`, `${label} (total)`, round(ms), 'ms', 'lower');
  bench.metric(`heavy.${name}.max_timer_lag_ms`, `${label}: worst main-thread timer lag`, round(lag), 'ms', 'lower');
  bench.metric(`heavy.${name}.heap_mb`, `${label} heap growth`, round((heapAfter - heapBefore) / 1048576, 1), 'MB', 'lower');
  bench.metric(`heavy.${name}.maxrss_growth_mb`, `${label} peak RSS growth`, round((process.resourceUsage().maxRSS - rssBefore) / 1024, 1), 'MB', 'lower');
  log(`${name}: ${round(ms)} ms, timer lag ${round(lag)} ms`);
  return result;
}

if (flags.has('heavy')) {
  // GET /api/export: JSON streamed from exportChunks(); count bytes, keep nothing.
  if (selected('heavy.exportJson')) {
    currentCase = 'heavy.exportJson';
    gc();
    const rssBefore = process.resourceUsage().maxRSS;
    let bytes = 0;
    let longestChunkMs = 0;
    quiet();
    const started = performance.now();
    let last = started;
    for await (const chunk of service.exportChunks() as AsyncGenerator<string>) {
      bytes += Buffer.byteLength(chunk);
      const now = performance.now();
      longestChunkMs = Math.max(longestChunkMs, now - last);
      last = now;
    }
    loud();
    bench.metric('heavy.exportJson.ms', 'GET /api/export JSON stream, total', round(performance.now() - started), 'ms', 'lower');
    bench.metric('heavy.exportJson.longest_block_ms', 'GET /api/export longest synchronous chunk (event-loop block)', round(longestChunkMs), 'ms', 'lower');
    bench.metric('heavy.exportJson.bytes', 'GET /api/export body bytes', bytes, 'bytes', 'lower');
    bench.metric('heavy.exportJson.maxrss_growth_mb', 'GET /api/export peak RSS growth', round((process.resourceUsage().maxRSS - rssBefore) / 1024, 1), 'MB', 'lower');
  }
  if (selected('heavy.backup')) {
    const path = await measureHeavy('backup', 'POST /api/backup VACUUM INTO', () => backupDatabase(db, copy.path, 1)) as string;
    bench.metric('heavy.backup.bytes', 'backup file bytes', statSync(path).size, 'bytes', 'lower');
    for (const suffix of ['', '-journal']) { try { (await import('node:fs')).rmSync(path + suffix, { force: true }); } catch { /* gone */ } }
  }
  if (selected('heavy.debugSnapshot')) {
    const debug = new ScoutDebug(db, service, copy.path);
    const snapshot = await measureHeavy('debugSnapshot', 'GET /api/debug/snapshot VACUUM INTO + redaction', () => debug.snapshot()) as { bytes: number; cleanup: () => void };
    bench.metric('heavy.debugSnapshot.bytes', 'debug snapshot bytes', snapshot.bytes, 'bytes', 'lower');
    snapshot.cleanup();
    debug.close();
  }
  if (selected('heavy.improvementExport')) {
    currentCase = 'heavy.improvementExport';
    // Built in a child process; measure wall time and how late the main thread's timers fire meanwhile.
    let maxLag = 0;
    let expected = performance.now() + 20;
    const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - expected); expected = now + 20; }, 20);
    const contextStarted = performance.now();
    quiet();
    const context = improvementContext(service);
    const contextMs = performance.now() - contextStarted;
    const started = performance.now();
    const file = await buildImprovementExport(db, { includePrivate: true, context }) as { path: string; bytes?: number; cleanup: () => void };
    const ms = performance.now() - started;
    loud();
    clearInterval(timer);
    bench.metric('heavy.improvementExport.ms', 'GET /api/export/improvement build (child process)', round(ms), 'ms', 'lower');
    bench.metric('heavy.improvementExport.context_ms', 'improvement export context on the main thread', round(contextMs), 'ms', 'lower');
    bench.metric('heavy.improvementExport.max_timer_lag_ms', 'worst main-thread timer lag during the build', round(maxLag), 'ms', 'lower');
    bench.metric('heavy.improvementExport.bytes', 'improvement export file bytes', statSync(file.path).size, 'bytes', 'lower');
    file.cleanup();
  }
}

// ---------------------------------------------------------------------- prune
if (flags.has('prune') && selected('prune')) {
  const oldest = Date.parse(String((realPrepare('SELECT MIN(observed_at) AS at FROM observations').get() as { at: string }).at));
  // --prune-day pins the scenario day so an --apply that changes observation counts is compared on the same day.
  const busiestDay = typeof flags.get('prune-day') === 'string'
    ? String(flags.get('prune-day'))
    : String((realPrepare("SELECT substr(observed_at, 1, 10) AS d FROM observations GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1").get() as { d: string }).d);
  bench.param('pruneDay', busiestDay);
  const DAY = 86_400_000;
  // 1) the first prune once the oldest day ages out; 2) catch up to the busiest day; 3) that day alone (the daily steady state of the per-scan era).
  const first = pruneOnce('prune.firstDay', oldest + 181 * DAY);
  bench.metric('upkeep.prune.first_day_ms', 'pruneRetention() the day the oldest day ages out', round(first.ms), 'ms', 'lower', JSON.stringify(first.deleted));
  const catchup = pruneOnce('prune.catchup', Date.parse(`${busiestDay}T00:00:00Z`) + 180 * DAY);
  bench.metric('upkeep.prune.catchup_ms', `pruneRetention() catching up to ${busiestDay}`, round(catchup.ms), 'ms', 'lower', JSON.stringify(catchup.deleted));
  const daily = pruneOnce('prune.busiestDay', Date.parse(`${busiestDay}T00:00:00Z`) + 181 * DAY);
  bench.metric('upkeep.prune.busiest_day_ms', `pruneRetention() deleting the busiest day (${busiestDay})`, round(daily.ms), 'ms', 'lower', JSON.stringify(daily.deleted));
}

// ---------------------------------------------------------- statements + plans
const BIG_TABLES = new Set(['observations', 'scans', 'connector_runs', 'listings', 'watch_listings', 'listing_relevance', 'manual_relevance_cache', 'jev_shadow_log', 'jev_fuzzy_cache', 'market_listings', 'market_price_observations', 'market_listing_snapshot_images']);
const usedIndexes = new Map<string, Set<string>>();
const statementRows: Array<Record<string, unknown>> = [];
for (const stat of sqlStats.values()) {
  if (/^\s*(PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|VACUUM|EXPLAIN)/i.test(stat.sql)) continue;
  let plan: Array<{ detail: string }> = [];
  try { plan = realPrepare(`EXPLAIN QUERY PLAN ${stat.sql}`).all(...((stat.params ?? []) as unknown[])) as Array<{ detail: string }>; } catch { /* named params or DDL */ }
  const flagsFound = new Set<string>();
  for (const step of plan) {
    const detail = String(step.detail);
    const index = detail.match(/USING (?:COVERING )?INDEX (\S+)/);
    if (index) { const users = usedIndexes.get(index[1]) ?? new Set<string>(); for (const name of stat.cases) users.add(name); usedIndexes.set(index[1], users); }
    const scan = detail.match(/^SCAN (\S+)(?: AS \S+)?(.*)$/);
    if (scan && BIG_TABLES.has(scan[1])) flagsFound.add(scan[2].includes('INDEX') ? `FULL_INDEX_SCAN ${scan[1]}` : `FULL_SCAN ${scan[1]}`);
    if (/TEMP B-TREE/.test(detail)) flagsFound.add('TEMP_BTREE');
    if (/CORRELATED/.test(detail)) flagsFound.add('CORRELATED');
    if (/AUTOMATIC/.test(detail)) flagsFound.add('AUTO_INDEX');
  }
  const avg = stat.totalMs / Math.max(1, stat.calls);
  if (stat.maxMs >= explainMs || stat.totalMs >= 200) {
    statementRows.push({
      max_ms: round(stat.maxMs), total_ms: round(stat.totalMs), calls: stat.calls, avg_ms: round(avg), rows: stat.rows,
      flags: [...flagsFound].join(' '), cases: [...stat.cases].slice(0, 4).join(','),
      sql: stat.sql.replace(/\s+/g, ' ').slice(0, 220),
      plan: plan.map((step) => step.detail).join(' | ').slice(0, 400),
    });
  }
}
statementRows.sort((a, b) => Number(b.max_ms) - Number(a.max_ms));
bench.table(`statements slower than ${explainMs} ms per call or 200 ms in total, with plan flags`, statementRows);
bench.metric('sql.distinct_statements', 'distinct SQL statements run', sqlStats.size, 'count', 'info');
bench.metric('sql.slow_statements', `statements with a call over ${explainMs} ms`, statementRows.filter((row) => Number(row.max_ms) >= explainMs).length, 'count', 'lower');
const allIndexes = (realPrepare("SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'").all() as Array<{ name: string; tbl_name: string }>);
const indexBytes = new Map((realPrepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name").all() as Array<{ name: string; bytes: number }>).map((row) => [row.name, Number(row.bytes)]));
const unused = allIndexes.filter((index) => !usedIndexes.has(index.name)).map((index) => ({ index: index.name, table: index.tbl_name, mb: round((indexBytes.get(index.name) ?? 0) / 1048576, 2) })).sort((a, b) => b.mb - a.mb);
const bigIndexUse = allIndexes.filter((index) => BIG_TABLES.has(index.tbl_name)).map((index) => ({ index: index.name, table: index.tbl_name, mb: round((indexBytes.get(index.name) ?? 0) / 1048576, 2), used_by: [...(usedIndexes.get(index.name) ?? [])].slice(0, 6).join(',') })).sort((a, b) => b.mb - a.mb);
bench.table('indexes on the big tables and the measured cases whose plans used them', bigIndexUse);
bench.table('indexes no measured plan used (FK child lookups and DELETE paths not run here can still need them)', unused);
bench.metric('sql.unused_index_bytes', 'bytes of indexes no measured plan used', unused.reduce((sum, row) => sum + row.mb * 1048576, 0), 'bytes', 'info');

const usage = process.resourceUsage();
bench.metric('process.maxrss_mb', 'peak RSS of the benchmark process', round(usage.maxRSS / 1024, 1), 'MB', 'info');
bench.metric('safety.blocked_network', 'blocked network attempts (should be 0 except stubbed paths)', blockedAttempts.length, 'count', 'info');
bench.param('aiCalls', aiCalls);
if (blockedAttempts.length) bench.note(`blocked network attempts: ${JSON.stringify(blockedAttempts.slice(0, 10))}`);
bench.note('Reads are synchronous node:sqlite calls: their time is time the event loop (SSE, other requests, scheduler) waits.');
bench.note('Copy is a VACUUMed export: no fragmentation and no photo bytes unless --with-images; the live file may be slower on cold cache.');
db.close();
bench.finish();
process.exit(0);

export type { Distribution };
