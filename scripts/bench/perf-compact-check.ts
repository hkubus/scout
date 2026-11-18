/**
 * Checks that an --apply SQL file for perf.ts (perf-compact-observations.sql by
 * default) leaves every read the app shows unchanged: the clock is frozen at
 * the export's exported_at, each read is captured before and after the SQL on
 * one scratch copy, and the JSON is diffed. Prints the paths that differ.
 *
 *   SCOUT_BENCH_TMP=/disk/dir node --import tsx scripts/bench/perf-compact-check.ts <export.sqlite> [--apply=file.sql] [--json=out.json]
 *
 * No network: perf-netguard blocks it and the service gets counting stubs.
 */

import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bench, writableCopy } from './lib';
import { installNetGuard } from './perf-netguard';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bench = new Bench('perf-compact-check');
process.env.SCOUT_SECRET = 'scout-bench-only-secret-0b7d1e9f3a5c7e9b1d3f5a7c9e1b3d5f';
process.env.SCOUT_SKIP_MIGRATION_BACKUP = 'true';
process.env.SCOUT_CHROMIUM_PATH = '/nonexistent/scout-bench-no-browser';
for (const key of ['OPENROUTER_API_KEY', 'SCOUT_OPENROUTER_API_KEY', 'SCOUT_DEEPSEEK_API_KEY', 'SCOUT_BROWSER_WS', 'SCOUT_DB_PATH']) delete process.env[key];
installNetGuard();
syncBuiltinESMExports();
process.chdir(REPO);

// Freeze the clock at export time so both captures see the same windows.
const frozen = Date.parse(bench.now);
const RealDate = Date;
class FrozenDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(frozen);
    else super(...(args as [string]));
  }
  static override now() { return frozen; }
}
globalThis.Date = FrozenDate as DateConstructor;

const { openDatabase } = await import('../../server/db');
const { ScoutService } = await import('../../server/service');
const { dealsForAgent } = await import('../../server/deals');

const sqlPath = resolve(String(bench.args.flags.get('apply') ?? resolve(REPO, 'scripts/bench/perf-compact-observations.sql')));
const copy = writableCopy(bench.args.exportPath);
process.on('exit', () => copy.dispose());
const quiet = { info: console.info, log: console.log, warn: console.warn };
console.info = () => {};
console.warn = () => {};
const db: any = openDatabase(copy.path);
const disabled = async () => { throw new Error('bench: disabled'); };
const service: any = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [], classifyListingRelevance: disabled as any, verifyListingDescription: disabled as any, fetchListingDetailHtml: disabled as any, inboxFetch: disabled as any });

const watches = db.prepare('SELECT id FROM watches ORDER BY id').all() as Array<{ id: string }>;
const busy = db.prepare('SELECT l.marketplace || \':\' || l.listing_id AS key, o.watch_id FROM observations o JOIN listings l ON l.id = o.listing_id GROUP BY o.watch_id, o.listing_id ORDER BY COUNT(*) DESC LIMIT 5').all() as Array<{ key: string; watch_id: string }>;
const reads: Record<string, () => unknown> = {
  dashboard: () => service.dashboard(),
  watches: () => service.allWatches(),
  topDeals: () => service.listingsPage({ sort: 'deal', minStrength: 3, visibility: 'visible', aiFiltered: 'exclude', excludePassed: true, pageSize: 25 }),
  listingsAll: () => service.listingsPage({ page: 1, pageSize: 500, sort: 'newest', visibility: 'all', aiFiltered: 'include' }),
  deals: () => dealsForAgent(service, {}),
  ...Object.fromEntries([7, 30, 90, 180].map((days) => [`analytics.${days}d`, () => service.analytics({ days, negotiations: true })])),
  ...Object.fromEntries(watches.flatMap((watch) => [30, 180].map((days) => [`watchAnalytics.${watch.id}.${days}d`, () => service.watchAnalytics(watch.id, days, { negotiations: true })]))),
  ...Object.fromEntries(busy.map((item, index) => [`listingDetail.${index}`, () => service.listingDetail(item.key, item.watch_id)])),
  ...Object.fromEntries(busy.map((item, index) => [`comparables.${index}`, () => service.comparables({ listingKey: item.key, watchId: item.watch_id })])),
};
// watchBaselines feeds scoring on every scan.
for (const watch of watches) reads[`baselines.${watch.id}`] = () => {
  const baselines = service.watchBaselines(db.prepare('SELECT * FROM watches WHERE id = ?').get(watch.id));
  return JSON.parse(JSON.stringify(baselines, (_key, value) => (value instanceof Map ? Object.fromEntries(value) : value)));
};

const capture = () => Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, JSON.parse(JSON.stringify(read()))]));
const before = capture();
const observationsBefore = Number(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n);
db.exec(readFileSync(sqlPath, 'utf8'));
const observationsAfter = Number(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n);
const after = capture();
Object.assign(console, quiet);

function diff(a: unknown, b: unknown, path: string, out: Array<{ path: string; before: unknown; after: unknown }>) {
  if (out.length > 400) return;
  if (Object.is(a, b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    for (const key of new Set([...Object.keys(a as object), ...Object.keys(b as object)])) diff((a as any)[key], (b as any)[key], `${path}.${key}`, out);
    return;
  }
  out.push({ path, before: a, after: b });
}

const rows: Array<Record<string, unknown>> = [];
let differing = 0;
for (const name of Object.keys(reads)) {
  const changes: Array<{ path: string; before: unknown; after: unknown }> = [];
  diff(before[name], after[name], name, changes);
  if (changes.length) differing += 1;
  rows.push({ read: name, differences: changes.length, first: changes.slice(0, 3).map((change) => `${change.path}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`).join(' | ').slice(0, 400) });
}
bench.param('apply', sqlPath);
bench.metric('check.observations_deleted', 'observation rows the SQL removed', observationsBefore - observationsAfter, 'rows', 'info');
bench.metric('check.reads', 'reads compared', rows.length, 'count', 'info');
bench.metric('check.reads_differing', 'reads whose JSON changed', differing, 'count', 'lower');
bench.table('reads before → after the SQL (clock frozen at exported_at)', rows.filter((row) => Number(row.differences) > 0).concat(rows.filter((row) => !Number(row.differences)).slice(0, 5)));
db.close();
bench.finish();
process.exit(0);
