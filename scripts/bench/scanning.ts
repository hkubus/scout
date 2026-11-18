/**
 * Scanning benchmark: how reliably and how quickly Scout's watches find
 * listings, and what each marketplace request buys.
 *
 *   node --import tsx scripts/bench/scanning.ts <export.sqlite> [--json=out.json] [--now=ISO] [--recent-days=14]
 *
 * Sections (metric id prefixes):
 *   scan.*      outcomes per marketplace (completed / failed / skipped / interrupted), error clusters, restarts
 *   connector.* failure streaks, backoff time, orphaned runs
 *   cadence.*   configured vs actual interval per watch and marketplace, schedule slip, run duration
 *   coverage.*  hours with no scans at all
 *   duration.*  scan time per marketplace
 *   detect.*    OLX posting → first sighting (the only marketplace with a posting time)
 *   yield.*     new listings / deals per request, page saturation
 *   arrival.*   when new listings appear (hour of day), and what the night interval costs
 *   life.*      how long listings stay visible in a watch's results
 *   session.*   scans while a stored marketplace session was in use vs not
 *
 * "recent" is the --recent-days window before the reference time (default 14
 * days); "all" is the whole export. Compare recent-window metrics across
 * exports; all-time metrics mostly describe history.
 */

import { Bench, distribution, all, type Distribution } from './lib';
import {
  LocalClock, MARKETPLACES, errorCluster, exportTimeZone, isoWeek, loadScans, loadWatches, mpKey,
  nightIntervalSetting, pct, round, sourceInterval, storedCountFromMessage, upperBound, type ScanRow,
} from './scan-lib';

const bench = new Bench('scanning');
const { db } = bench;
const recentDays = Number(bench.args.flags.get('recent-days') ?? 14);
const nowMs = Date.parse(bench.now);
const recentStartMs = nowMs - recentDays * 86_400_000;
const tz = exportTimeZone(db);
const clock = new LocalClock(tz);
const nightInterval = nightIntervalSetting(db);
bench.param('recentDays', recentDays);
bench.param('recentStart', new Date(recentStartMs).toISOString());
bench.param('timeZone', tz);
bench.param('nightIntervalMinutes', nightInterval);

const watches = loadWatches(db);
const scans = loadScans(db).filter((scan) => scan.startMs <= nowMs);
const watchScans = scans.filter((scan) => scan.kind === 'watch');
const windows = [
  { key: 'recent', from: recentStartMs },
  { key: 'all', from: -Infinity },
] as const;
const inWindow = (ms: number, from: number) => ms >= from && ms <= nowMs;
const minutes = (ms: number) => ms / 60_000;

// ----------------------------------------------------------------- outcomes

for (const window of windows) {
  for (const marketplace of MARKETPLACES) {
    const rows = watchScans.filter((scan) => scan.marketplace === marketplace && inWindow(scan.startMs, window.from));
    const count = (status: string) => rows.filter((scan) => scan.status === status).length;
    const attempts = rows.length;
    const id = `scan.${window.key}.${mpKey(marketplace)}`;
    bench.metric(`${id}.attempts`, `${marketplace} watch scan attempts (${window.key})`, attempts, 'count', 'info');
    bench.metric(`${id}.success_rate`, `${marketplace} scans completed (${window.key})`, attempts ? count('completed') / attempts : null, 'ratio', 'higher');
    bench.metric(`${id}.failed_rate`, `${marketplace} scans failed (${window.key})`, attempts ? count('failed') / attempts : null, 'ratio', 'lower');
    bench.metric(`${id}.skipped_rate`, `${marketplace} scans skipped by connector backoff (${window.key})`, attempts ? count('skipped') / attempts : null, 'ratio', 'lower');
  }
  const interrupted = scans.filter((scan) => scan.status === 'interrupted' && inWindow(scan.startMs, window.from));
  bench.metric(`scan.${window.key}.interrupted`, `Scans cut off by a process restart (${window.key})`, interrupted.length, 'count', 'lower');
  // Restarts that cut scans off: interrupted scans cluster by the minute they started.
  const restartMinutes = new Set(interrupted.map((scan) => scan.startedAt.slice(0, 16)));
  bench.metric(`scan.${window.key}.restarts_mid_scan`, `Restarts that interrupted at least one scan (distinct start minutes, ${window.key})`, restartMinutes.size, 'count', 'lower');
}

// Weekly outcome table.
{
  const weekly = new Map<string, { week: string; marketplace: string; attempts: number; completed: number; failed: number; skipped: number; interrupted: number }>();
  for (const scan of watchScans) {
    const key = `${isoWeek(scan.startedAt)}|${scan.marketplace}`;
    let row = weekly.get(key);
    if (!row) weekly.set(key, row = { week: isoWeek(scan.startedAt), marketplace: scan.marketplace, attempts: 0, completed: 0, failed: 0, skipped: 0, interrupted: 0 });
    row.attempts += 1;
    if (scan.status === 'completed' || scan.status === 'failed' || scan.status === 'skipped' || scan.status === 'interrupted') row[scan.status] += 1;
  }
  bench.table('weekly_outcomes', [...weekly.values()].sort((a, b) => a.week.localeCompare(b.week) || a.marketplace.localeCompare(b.marketplace)).map((row) => ({
    week: row.week, marketplace: row.marketplace, attempts: row.attempts,
    ok_pct: pct(row.completed, row.attempts), fail_pct: pct(row.failed, row.attempts), skip_pct: pct(row.skipped, row.attempts), interrupted: row.interrupted,
  })));
}

// Error clusters (failed scans), all-time and recent.
{
  const clusters = new Map<string, { marketplace: string; cluster: string; all: number; recent: number; first: string; last: string }>();
  for (const scan of scans) {
    if (scan.status !== 'failed') continue;
    const cluster = errorCluster(scan.error);
    const key = `${scan.marketplace}|${cluster}`;
    let row = clusters.get(key);
    if (!row) clusters.set(key, row = { marketplace: scan.marketplace, cluster, all: 0, recent: 0, first: scan.startedAt, last: scan.startedAt });
    row.all += 1;
    if (scan.startMs >= recentStartMs) row.recent += 1;
    if (scan.startedAt < row.first) row.first = scan.startedAt;
    if (scan.startedAt > row.last) row.last = scan.startedAt;
  }
  bench.table('failure_clusters', [...clusters.values()].sort((a, b) => b.recent - a.recent || b.all - a.all).map((row) => ({ ...row, first: row.first.slice(0, 16), last: row.last.slice(0, 16) })));
  const authFailures = scans.filter((scan) => scan.status === 'failed' && scan.startMs >= recentStartMs && /authenticated session failed/.test(scan.error ?? ''));
  bench.metric('scan.recent.auth_session_failures', 'Recent scans failed inside the stored-session Chromium path', authFailures.length, 'count', 'lower');
}

// ---------------------------------------------------------------- connectors

interface RunRow { source: string; status: string; message: string | null; startMs: number; finishMs: number; backoffMs: number }
const runs: RunRow[] = all<Record<string, unknown>>(db, 'SELECT source, status, message, started_at, finished_at, backoff_until FROM connector_runs ORDER BY started_at, id')
  .map((row) => ({
    source: String(row.source),
    status: String(row.status),
    message: row.message === null ? null : String(row.message),
    startMs: Date.parse(String(row.started_at)),
    finishMs: row.finished_at ? Date.parse(String(row.finished_at)) : Number.NaN,
    backoffMs: row.backoff_until ? Date.parse(String(row.backoff_until)) : Number.NaN,
  }))
  .filter((run) => run.startMs <= nowMs);

for (const window of windows) {
  for (const marketplace of MARKETPLACES) {
    const outcomes = runs.filter((run) => run.source === marketplace && (run.status === 'ok' || run.status === 'error') && inWindow(run.startMs, window.from));
    const streaks: number[] = [];
    let current = 0;
    for (const run of outcomes) {
      if (run.status === 'error') current += 1;
      else if (current) { streaks.push(current); current = 0; }
    }
    if (current) streaks.push(current);
    const id = `connector.${window.key}.${mpKey(marketplace)}`;
    bench.metric(`${id}.error_streaks`, `${marketplace} runs of consecutive connector errors (${window.key})`, streaks.length, 'count', 'lower');
    bench.metric(`${id}.max_error_streak`, `${marketplace} longest run of consecutive connector errors (${window.key})`, streaks.length ? Math.max(...streaks) : 0, 'count', 'lower');
    // Backoff windows, merged so overlapping ones are not double-counted.
    const intervals = runs
      .filter((run) => run.source === marketplace && Number.isFinite(run.backoffMs) && Number.isFinite(run.finishMs) && inWindow(run.startMs, window.from))
      .map((run) => [run.finishMs, Math.min(run.backoffMs, nowMs)] as const)
      .filter(([a, b]) => b > a)
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curStart = Number.NaN;
    let curEnd = Number.NaN;
    for (const [a, b] of intervals) {
      if (!Number.isFinite(curStart) || a > curEnd) {
        if (Number.isFinite(curStart)) total += curEnd - curStart;
        curStart = a; curEnd = b;
      } else if (b > curEnd) curEnd = b;
    }
    if (Number.isFinite(curStart)) total += curEnd - curStart;
    bench.metric(`${id}.backoff_hours`, `${marketplace} hours under connector backoff (${window.key})`, total / 3_600_000, 'h', 'lower');
  }
}
{
  const orphaned = runs.filter((run) => run.status === 'running' && run.startMs < nowMs - 3_600_000);
  bench.metric('connector.all.orphaned_running_runs', 'Connector runs left "running" forever (restart mid-scan; db.ts marks only scans interrupted)', orphaned.length, 'count', 'lower');
  // Error rows that set a backoff on the very first failure of a tick: all
  // due watches fail together, so a single blip counts as a streak.
  const recentErrors = runs.filter((run) => run.status === 'error' && MARKETPLACES.includes(run.source as never) && run.startMs >= recentStartMs);
  const withBackoff = recentErrors.filter((run) => Number.isFinite(run.backoffMs)).length;
  bench.metric('connector.recent.errors_with_backoff_share', 'Recent connector errors that set a backoff', recentErrors.length ? withBackoff / recentErrors.length : null, 'ratio', 'info');
  // How many of those errors share a start second with another error on the same source (one tick, several watches).
  const bySecond = new Map<string, number>();
  for (const run of recentErrors) {
    const key = `${run.source}|${Math.floor(run.startMs / 2000)}`;
    bySecond.set(key, (bySecond.get(key) ?? 0) + 1);
  }
  const sameTick = recentErrors.filter((run) => (bySecond.get(`${run.source}|${Math.floor(run.startMs / 2000)}`) ?? 0) > 1).length;
  bench.metric('connector.recent.errors_in_same_tick_share', 'Recent connector errors that happened in the same tick as another error on that marketplace', recentErrors.length ? sameTick / recentErrors.length : null, 'ratio', 'info');
}

// ------------------------------------------------------------------ cadence

interface WatchRun { watchId: string; startMs: number; endMs: number; scans: Map<string, ScanRow> }
const runsByWatch = new Map<string, WatchRun[]>();
{
  const byWatch = new Map<string, ScanRow[]>();
  for (const scan of watchScans) {
    const list = byWatch.get(scan.watchId);
    if (list) list.push(scan);
    else byWatch.set(scan.watchId, [scan]);
  }
  for (const [watchId, list] of byWatch) {
    list.sort((a, b) => a.startMs - b.startMs);
    const watchRuns: WatchRun[] = [];
    let current: WatchRun | null = null;
    for (const scan of list) {
      // runWatch creates every due source's scan before its first await (service.ts:6566-6577).
      if (!current || scan.startMs - current.startMs > 2000 || current.scans.has(scan.marketplace)) {
        current = { watchId, startMs: scan.startMs, endMs: scan.startMs, scans: new Map() };
        watchRuns.push(current);
      }
      current.scans.set(scan.marketplace, scan);
      const end = Number.isFinite(scan.endMs) ? scan.endMs : scan.startMs;
      if (end > current.endMs) current.endMs = end;
    }
    runsByWatch.set(watchId, watchRuns);
  }
}

{
  const cadenceRows: Array<Record<string, unknown>> = [];
  const slipAll: number[] = [];
  const runDurations: number[] = [];
  const overshootBy = new Map<string, { day: number[]; night: number[] }>();
  let late = 0;
  let early = 0;
  let pairs = 0;
  for (const [watchId, watchRuns] of runsByWatch) {
    const watch = watches.get(watchId);
    if (!watch || !watch.enabled) continue;
    for (const run of watchRuns) if (run.startMs >= recentStartMs) runDurations.push((run.endMs - run.startMs) / 1000);
    for (const marketplace of watch.sources) {
      const interval = sourceInterval(watch, marketplace);
      const gapsDay: number[] = [];
      const gapsNight: number[] = [];
      const slips: number[] = [];
      let lateHere = 0;
      let prev: WatchRun | null = null;
      for (const run of watchRuns) {
        const scan = run.scans.get(marketplace);
        if (!scan) continue;
        if (prev && run.startMs >= recentStartMs && prev.startMs >= recentStartMs) {
          const prevScan = prev.scans.get(marketplace) as ScanRow;
          const gap = run.startMs - prev.startMs;
          if (gap < 6 * 3_600_000) {
            let expected = clock.expectedNext(prev.endMs, interval, nightInterval);
            // A skipped source waits for the backoff deadline (nextWatchScanSchedule, service.ts:622-627).
            const backoff = prevScan.status === 'skipped' ? Date.parse(/until (\S+)/.exec(prevScan.error ?? '')?.[1] ?? '') : Number.NaN;
            if (Number.isFinite(backoff) && backoff > expected) expected = backoff;
            const slip = run.startMs - expected;
            pairs += 1;
            if (slip < -120_000) early += 1;
            else {
              slips.push(slip / 1000);
              slipAll.push(slip / 1000);
              if (slip > 120_000) { late += 1; lateHere += 1; }
              const night = clock.isNight(prev.endMs);
              (night ? gapsNight : gapsDay).push(minutes(gap));
              const key = mpKey(marketplace);
              let bucket = overshootBy.get(key);
              if (!bucket) overshootBy.set(key, bucket = { day: [], night: [] });
              if (prevScan.status !== 'skipped') (night ? bucket.night : bucket.day).push(minutes(gap) - (night ? Math.max(interval, nightInterval) : interval));
            }
          }
        }
        prev = run;
      }
      const dayDist = distribution(gapsDay);
      const nightDist = distribution(gapsNight);
      const slipDist = distribution(slips);
      cadenceRows.push({
        watch: watch.name, marketplace, configured_day_min: interval, configured_night_min: Math.max(interval, nightInterval),
        actual_day_p50: round(dayDist.p50), actual_day_p90: round(dayDist.p90), actual_night_p50: round(nightDist.p50),
        slip_s_p50: round(slipDist.p50), slip_s_p90: round(slipDist.p90), late_over_2min: lateHere, pairs: slips.length,
      });
    }
  }
  bench.table('cadence_recent', cadenceRows);
  for (const [key, bucket] of overshootBy) {
    bench.distributionMetrics(`cadence.recent.${key}.day_overshoot_min`, `${key} actual day gap minus configured interval`, distribution(bucket.day), 'min', 'lower', ['p50', 'p90']);
    bench.distributionMetrics(`cadence.recent.${key}.night_overshoot_min`, `${key} actual night gap minus configured night interval`, distribution(bucket.night), 'min', 'lower', ['p50', 'p90']);
  }
  bench.distributionMetrics('cadence.recent.slip_s', 'Scan start after its scheduled time (run end + interval)', distribution(slipAll), 's', 'lower', ['p50', 'p90', 'p99', 'max']);
  bench.metric('cadence.recent.late_share', 'Scans that started more than 2 min after schedule', pairs ? late / pairs : null, 'ratio', 'lower');
  bench.metric('cadence.recent.early_or_reconfigured', 'Scans more than 2 min before the schedule implied by today\'s config (config changed or Scan now)', early, 'count', 'info');
  bench.distributionMetrics('cadence.recent.run_duration_s', 'Watch run (all due marketplaces) start → last scan completed', distribution(runDurations), 's', 'lower', ['p50', 'p90', 'max']);
}

// Coverage gaps: stretches with no scan of any kind.
{
  const starts = scans.map((scan) => scan.startMs).sort((a, b) => a - b);
  const gaps: Array<Record<string, unknown>> = [];
  const gapHours = { recent: 0, all: 0 };
  for (let i = 1; i < starts.length; i += 1) {
    const gap = starts[i] - starts[i - 1];
    if (gap > 3_600_000) {
      // Beyond the longest regular wait (30-min night interval) the time is lost coverage.
      const lost = (gap - 30 * 60_000) / 3_600_000;
      gapHours.all += lost;
      if (starts[i - 1] >= recentStartMs) gapHours.recent += lost;
      gaps.push({ from: new Date(starts[i - 1]).toISOString().slice(0, 16), to: new Date(starts[i]).toISOString().slice(0, 16), hours: round(gap / 3_600_000, 2) });
    }
  }
  const tail = (nowMs - starts[starts.length - 1]) / 3_600_000;
  bench.metric('coverage.recent.gap_hours', 'Hours without any scan beyond the 30-min night wait (recent)', gapHours.recent, 'h', 'lower');
  bench.metric('coverage.all.gap_hours', 'Hours without any scan beyond the 30-min night wait (all)', gapHours.all, 'h', 'lower');
  bench.metric('coverage.export_tail_min', 'Minutes from the last scan to the export', tail * 60, 'min', 'info');
  bench.table('coverage_gaps', gaps.sort((a, b) => Number(b.hours) - Number(a.hours)));
}

// ----------------------------------------------------------------- duration

for (const window of windows) {
  for (const marketplace of MARKETPLACES) {
    const done = watchScans.filter((scan) => scan.marketplace === marketplace && scan.status === 'completed' && Number.isFinite(scan.endMs) && inWindow(scan.startMs, window.from));
    bench.distributionMetrics(`duration.${window.key}.${mpKey(marketplace)}.completed_s`, `${marketplace} completed scan duration (${window.key})`, distribution(done.map((scan) => (scan.endMs - scan.startMs) / 1000)), 's', 'lower', ['p50', 'p90', 'max']);
    const failed = watchScans.filter((scan) => scan.marketplace === marketplace && scan.status === 'failed' && Number.isFinite(scan.endMs) && inWindow(scan.startMs, window.from));
    bench.metric(`duration.${window.key}.${mpKey(marketplace)}.failed_s.p50`, `${marketplace} failed scan duration p50 (${window.key})`, distribution(failed.map((scan) => (scan.endMs - scan.startMs) / 1000)).p50, 's', 'info');
  }
}
{
  const weekly = new Map<string, number[]>();
  for (const scan of watchScans) {
    if (scan.status !== 'completed' || !Number.isFinite(scan.endMs)) continue;
    const key = `${isoWeek(scan.startedAt)}|${scan.marketplace}`;
    const list = weekly.get(key);
    if (list) list.push((scan.endMs - scan.startMs) / 1000);
    else weekly.set(key, [(scan.endMs - scan.startMs) / 1000]);
  }
  bench.table('weekly_duration_s', [...weekly.entries()].sort().map(([key, values]) => {
    const [week, marketplace] = key.split('|');
    const dist = distribution(values);
    return { week, marketplace, n: dist.n, p50: round(dist.p50, 2), p90: round(dist.p90, 2), max: round(dist.max, 1) };
  }));
}

// --------------------------------------------------- listings, deals, alerts

interface WatchListing {
  watchId: string; listingId: number; marketplace: string; externalId: string;
  firstMs: number; lastMs: number; postedMs: number; refreshedMs: number;
  firstStrength: number | null; maxStrength: number | null; alerted: boolean;
}
const strengthRows = all<{ watch_id: string; listing_id: number; first_id: number; max_strength: number | null }>(db,
  'SELECT watch_id, listing_id, MIN(id) AS first_id, MAX(deal_strength) AS max_strength FROM observations GROUP BY watch_id, listing_id');
const firstStrengthById = new Map<number, number | null>();
{
  // Strength recorded on each watch listing's first observation (the call made when it was first seen).
  const ids = strengthRows.map((row) => row.first_id);
  const statement = db.prepare('SELECT id, deal_strength FROM observations WHERE id = ?');
  for (const id of ids) {
    const row = statement.get(id) as { id: number; deal_strength: number | null } | undefined;
    if (row) firstStrengthById.set(Number(row.id), row.deal_strength === null ? null : Number(row.deal_strength));
  }
}
const strengthByPair = new Map<string, { first: number | null; max: number | null }>();
for (const row of strengthRows) strengthByPair.set(`${row.watch_id}|${row.listing_id}`, { first: firstStrengthById.get(Number(row.first_id)) ?? null, max: row.max_strength === null ? null : Number(row.max_strength) });
const alertedKeys = new Set(all<{ listing_key: string }>(db, "SELECT listing_key FROM notifications WHERE listing_key LIKE '%|alert:%'")
  .map((row) => row.listing_key.replace(/\|alert:\d+.*$/, '')));
const watchListings: WatchListing[] = all<Record<string, unknown>>(db, `SELECT wl.watch_id, wl.listing_id, l.marketplace, l.listing_id AS external_id,
    wl.first_seen_at, wl.last_seen_at, l.posted_at, l.refreshed_at
  FROM watch_listings wl JOIN listings l ON l.id = wl.listing_id`).map((row) => {
  const strength = strengthByPair.get(`${row.watch_id}|${row.listing_id}`);
  return {
    watchId: String(row.watch_id), listingId: Number(row.listing_id), marketplace: String(row.marketplace), externalId: String(row.external_id),
    firstMs: Date.parse(String(row.first_seen_at)), lastMs: Date.parse(String(row.last_seen_at)),
    postedMs: row.posted_at ? Date.parse(String(row.posted_at)) : Number.NaN,
    refreshedMs: row.refreshed_at ? Date.parse(String(row.refreshed_at)) : Number.NaN,
    firstStrength: strength?.first ?? null, maxStrength: strength?.max ?? null,
    alerted: alertedKeys.has(`${row.watch_id}|${row.marketplace}|${row.external_id}`),
  };
}).filter((wl) => wl.firstMs <= nowMs);
const isDealAtFirstSight = (wl: WatchListing) => (wl.firstStrength ?? 0) >= 4;

// Completed scan start/end times per watch+marketplace.
const completedByPair = new Map<string, { starts: number[]; ends: number[]; scans: ScanRow[] }>();
const attemptsByPair = new Map<string, ScanRow[]>();
for (const scan of watchScans) {
  const key = `${scan.watchId}|${scan.marketplace}`;
  const attempts = attemptsByPair.get(key);
  if (attempts) attempts.push(scan);
  else attemptsByPair.set(key, [scan]);
  if (scan.status !== 'completed' || !Number.isFinite(scan.endMs)) continue;
  let entry = completedByPair.get(key);
  if (!entry) completedByPair.set(key, entry = { starts: [], ends: [], scans: [] });
  entry.starts.push(scan.startMs);
  entry.ends.push(scan.endMs);
  entry.scans.push(scan);
}

// ---------------------------------------------------------------- detection

{
  for (const marketplace of MARKETPLACES) {
    const rows = watchListings.filter((wl) => wl.marketplace === marketplace);
    bench.metric(`detect.${mpKey(marketplace)}.posted_at_coverage`, `${marketplace} watch listings with a posting time`, rows.length ? rows.filter((wl) => Number.isFinite(wl.postedMs)).length / rows.length : null, 'ratio', 'higher');
  }
  const olx = watchListings.filter((wl) => wl.marketplace === 'OLX' && Number.isFinite(wl.postedMs));
  const firstScanStart = (key: string) => completedByPair.get(key)?.starts[0] ?? Number.NaN;
  const detail: Array<{ wl: WatchListing; latencyMin: number; missed: number; night: boolean }> = [];
  let resurfaced = 0;
  let eligible = 0;
  for (const wl of olx) {
    const key = `${wl.watchId}|OLX`;
    const watch = watches.get(wl.watchId);
    const firstScan = firstScanStart(key);
    if (!watch || !Number.isFinite(firstScan)) continue;
    eligible += 1;
    if (wl.firstMs - wl.postedMs > 86_400_000) resurfaced += 1;
    // Fresh: posted while this watch was already scanning OLX.
    if (wl.postedMs < firstScan || wl.postedMs < Date.parse(watch.createdAt)) continue;
    if (wl.firstMs - wl.postedMs > 86_400_000) continue;
    const entry = completedByPair.get(key) as { starts: number[]; ends: number[] };
    // Completed scans that started after posting and finished before the sighting: they ran but did not store it.
    let missed = 0;
    const from = upperBound(entry.starts, wl.postedMs);
    for (let i = from; i < entry.starts.length && entry.starts[i] < wl.firstMs; i += 1) if (entry.ends[i] < wl.firstMs - 1000) missed += 1;
    detail.push({ wl, latencyMin: minutes(wl.firstMs - wl.postedMs), missed, night: clock.isNight(wl.postedMs) });
  }
  bench.metric('detect.all.olx.resurfaced_share', 'OLX watch listings first seen >24 h after posting (bumps, price edits into range, new watches)', eligible ? resurfaced / eligible : null, 'ratio', 'info');
  for (const window of windows) {
    const rows = detail.filter((item) => inWindow(item.wl.firstMs, window.from));
    const id = `detect.${window.key}.olx`;
    bench.distributionMetrics(`${id}.latency_min`, `OLX posting → first stored by the watch (${window.key})`, distribution(rows.map((item) => item.latencyMin)), 'min', 'lower', ['p50', 'p90']);
    bench.metric(`${id}.latency_day_min.p50`, `OLX posting → sighting p50, posted 08–22 (${window.key})`, distribution(rows.filter((item) => !item.night).map((item) => item.latencyMin)).p50, 'min', 'lower');
    bench.metric(`${id}.latency_night_min.p50`, `OLX posting → sighting p50, posted 22–08 (${window.key})`, distribution(rows.filter((item) => item.night).map((item) => item.latencyMin)).p50, 'min', 'lower');
    bench.metric(`${id}.missed_scan_share`, `Fresh OLX listings that ≥1 completed scan ran past without storing (${window.key})`, rows.length ? rows.filter((item) => item.missed > 0).length / rows.length : null, 'ratio', 'lower');
    const deals = rows.filter((item) => isDealAtFirstSight(item.wl) || item.wl.alerted);
    bench.distributionMetrics(`${id}.deal_latency_min`, `OLX posting → sighting for deals (strength ≥4 at first sight, or alerted) (${window.key})`, distribution(deals.map((item) => item.latencyMin)), 'min', 'lower', ['p50', 'p90']);
  }
  // Missed-scan histogram (all time).
  const histogram = new Map<number, number>();
  for (const item of detail) histogram.set(Math.min(item.missed, 5), (histogram.get(Math.min(item.missed, 5)) ?? 0) + 1);
  bench.table('olx_missed_scans_before_sighting', [...histogram.entries()].sort((a, b) => a[0] - b[0]).map(([missed, n]) => ({ missed_scans: missed === 5 ? '5+' : missed, listings: n, pct: pct(n, detail.length) })));

  // Activation lag. OLX's last_refresh_time (refreshed_at, server/marketplaces.ts:1263) sits a few minutes after
  // created_time on never-bumped offers: it marks when the ad went live after moderation. Measuring from it
  // instead of posted_at removes the moderation delay Scout cannot see. Only offers with refreshed − posted in
  // [0, 15] min count (never bumped).
  const activation = detail.filter((item) => Number.isFinite(item.wl.refreshedMs)
    && item.wl.refreshedMs >= item.wl.postedMs && item.wl.refreshedMs - item.wl.postedMs <= 15 * 60_000);
  const activationRows = activation.map((item) => {
    const entry = completedByPair.get(`${item.wl.watchId}|OLX`) as { starts: number[]; ends: number[] };
    let missed = 0;
    const from = upperBound(entry.starts, item.wl.refreshedMs);
    for (let i = from; i < entry.starts.length && entry.starts[i] < item.wl.firstMs - 1000; i += 1) missed += 1;
    return { item, lagMin: minutes(item.wl.firstMs - item.wl.refreshedMs), missed, moderationMin: minutes(item.wl.refreshedMs - item.wl.postedMs) };
  });
  bench.distributionMetrics('detect.all.olx.moderation_min', 'OLX created_time → last_refresh_time on never-bumped offers (moderation, outside Scout)', distribution(activationRows.map((row) => row.moderationMin)), 'min', 'info', ['p50', 'p90']);
  for (const window of windows) {
    const rows = activationRows.filter((row) => inWindow(row.item.wl.firstMs, window.from));
    const id = `detect.${window.key}.olx`;
    bench.distributionMetrics(`${id}.activation_lag_min`, `OLX activation (last_refresh_time) → first stored (${window.key})`, distribution(rows.map((row) => row.lagMin)), 'min', 'lower', ['p50', 'p90']);
    bench.metric(`${id}.caught_by_first_scan_after_activation`, `Never-bumped OLX offers stored by the first completed scan after activation (${window.key})`, rows.length ? rows.filter((row) => row.missed === 0).length / rows.length : null, 'ratio', 'higher');
  }
  const activationHistogram = new Map<number, number>();
  for (const row of activationRows) activationHistogram.set(Math.min(row.missed, 5), (activationHistogram.get(Math.min(row.missed, 5)) ?? 0) + 1);
  bench.table('olx_scans_after_activation_before_sighting', [...activationHistogram.entries()].sort((a, b) => a[0] - b[0]).map(([missed, n]) => ({ scans_started_after_activation: missed === 5 ? '5+' : missed, listings: n, pct: pct(n, activationRows.length) })));
}

// -------------------------------------------------------------------- yield

{
  const watchRows: Array<Record<string, unknown>> = [];
  for (const window of windows) {
    for (const marketplace of MARKETPLACES) {
      const attempts = watchScans.filter((scan) => scan.marketplace === marketplace && (scan.status === 'completed' || scan.status === 'failed') && inWindow(scan.startMs, window.from));
      const completed = attempts.filter((scan) => scan.status === 'completed');
      const fresh = watchListings.filter((wl) => wl.marketplace === marketplace && inWindow(wl.firstMs, window.from));
      const deals = fresh.filter(isDealAtFirstSight);
      const alerted = fresh.filter((wl) => wl.alerted);
      // Productive scans: completed scans in whose [start, end] window a new watch listing was stored.
      const productive = new Set<number>();
      const newPerScan = new Map<number, number>();
      for (const wl of fresh) {
        const entry = completedByPair.get(`${wl.watchId}|${marketplace}`);
        if (!entry) continue;
        const index = upperBound(entry.starts, wl.firstMs) - 1;
        if (index < 0 || wl.firstMs > entry.ends[index] + 1000) continue;
        if (index === 0) continue; // a watch's first scan finds everything at once
        const scanId = entry.scans[index].id;
        productive.add(scanId);
        newPerScan.set(scanId, (newPerScan.get(scanId) ?? 0) + 1);
      }
      const id = `yield.${window.key}.${mpKey(marketplace)}`;
      bench.metric(`${id}.requests`, `${marketplace} search requests (completed + failed scans, ${window.key})`, attempts.length, 'count', 'info');
      bench.metric(`${id}.new_listings`, `${marketplace} new watch listings (${window.key})`, fresh.length, 'count', 'info');
      bench.metric(`${id}.new_deals`, `${marketplace} new listings that were Very strong+ at first sight (${window.key})`, deals.length, 'count', 'info');
      bench.metric(`${id}.requests_per_new_listing`, `${marketplace} requests per new watch listing (${window.key})`, fresh.length ? attempts.length / fresh.length : null, 'req', 'lower');
      bench.metric(`${id}.requests_per_new_deal`, `${marketplace} requests per new Very strong+ listing (${window.key})`, deals.length ? attempts.length / deals.length : null, 'req', 'lower');
      bench.metric(`${id}.requests_per_alerted_listing`, `${marketplace} requests per alerted listing (${window.key})`, alerted.length ? attempts.length / alerted.length : null, 'req', 'lower');
      bench.metric(`${id}.productive_scan_share`, `${marketplace} completed scans that stored ≥1 new listing (${window.key})`, completed.length ? productive.size / completed.length : null, 'ratio', 'higher');
      bench.metric(`${id}.max_new_per_scan`, `${marketplace} most new listings stored by one scan, first scans excluded (${window.key})`, newPerScan.size ? Math.max(...newPerScan.values()) : 0, 'count', 'info');
      // Page saturation: completed scans that stored as many matches as one result page holds.
      // OLX API pages hold 50 (server/marketplaces.ts:1036); the Vinted SSR catalog page holds 96 cards
      // (server/marketplaces.ts:1652-1654); Allegro's HTML page size is not fixed in code.
      const pageSize = marketplace === 'OLX' ? 50 : marketplace === 'Vinted' ? 96 : null;
      const stored = completed.map((scan) => storedCountFromMessage(scan.error)).filter((value): value is number => value !== null);
      bench.metric(`${id}.stored_per_scan.p90`, `${marketplace} listings stored per completed scan p90 (${window.key})`, distribution(stored).p90, 'count', 'info');
      if (pageSize) bench.metric(`${id}.page_saturated_share`, `${marketplace} completed scans storing ≥ a full page (${pageSize}) of matches (${window.key})`, stored.length ? stored.filter((value) => value >= pageSize).length / stored.length : null, 'ratio', 'lower');
    }
  }
  // Per-watch cost and return, all time.
  for (const [watchId, watch] of watches) {
    for (const marketplace of watch.sources) {
      const attempts = (attemptsByPair.get(`${watchId}|${marketplace}`) ?? []).filter((scan) => scan.status === 'completed' || scan.status === 'failed');
      const fresh = watchListings.filter((wl) => wl.watchId === watchId && wl.marketplace === marketplace);
      const deals = fresh.filter(isDealAtFirstSight).length;
      const alerted = fresh.filter((wl) => wl.alerted).length;
      watchRows.push({
        watch: watch.name, enabled: watch.enabled ? 'yes' : 'no', marketplace, requests: attempts.length,
        first_scan: attempts[0]?.startedAt.slice(0, 10) ?? null, last_scan: attempts[attempts.length - 1]?.startedAt.slice(0, 10) ?? null,
        new_listings: fresh.length, new_deals: deals, alerted,
        req_per_listing: fresh.length ? round(attempts.length / fresh.length, 0) : null,
        req_per_alert: alerted ? round(attempts.length / alerted, 0) : null,
      });
    }
  }
  // Deleted watches still own scans.
  const knownIds = new Set(watches.keys());
  const orphanScans = watchScans.filter((scan) => !knownIds.has(scan.watchId));
  bench.metric('yield.all.scans_of_deleted_watches', 'Scans whose watch no longer exists', orphanScans.length, 'count', 'info');
  bench.table('watch_yield_all', watchRows);
  const disabledRequests = watchRows.filter((row) => row.enabled === 'no').reduce((sum, row) => sum + Number(row.requests), 0);
  const disabledAlerts = watchRows.filter((row) => row.enabled === 'no').reduce((sum, row) => sum + Number(row.alerted), 0);
  bench.metric('yield.all.disabled_watch_requests', 'Requests spent by watches that are now disabled', disabledRequests, 'count', 'info');
  bench.metric('yield.all.disabled_watch_alerted_listings', 'Listings alerted by watches that are now disabled', disabledAlerts, 'count', 'info');
}

// ------------------------------------------------------------------ arrival

{
  // OLX posting hour is the market's own clock; first-sighting hours are biased by cadence.
  const olxFresh = watchListings.filter((wl) => wl.marketplace === 'OLX' && Number.isFinite(wl.postedMs) && wl.firstMs - wl.postedMs < 86_400_000 && wl.firstMs >= wl.postedMs);
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, olx_posted: 0, olx_deals_posted: 0, first_seen_olx: 0, first_seen_allegro: 0, first_seen_vinted: 0, scans_recent: 0 }));
  for (const wl of olxFresh) {
    const hour = clock.hour(wl.postedMs);
    hours[hour].olx_posted += 1;
    if (isDealAtFirstSight(wl) || wl.alerted) hours[hour].olx_deals_posted += 1;
  }
  for (const wl of watchListings) {
    const hour = clock.hour(wl.firstMs);
    const key = `first_seen_${mpKey(wl.marketplace)}` as 'first_seen_olx';
    if (key in hours[hour]) hours[hour][key] += 1;
  }
  for (const scan of watchScans) if (scan.startMs >= recentStartMs) hours[clock.hour(scan.startMs)].scans_recent += 1;
  bench.table('arrival_by_local_hour', hours);
  const nightHours = (hour: number) => hour >= 22 || hour < 8;
  const postedNight = hours.filter((row) => nightHours(row.hour)).reduce((sum, row) => sum + row.olx_posted, 0);
  const postedTotal = hours.reduce((sum, row) => sum + row.olx_posted, 0);
  const dealsNight = hours.filter((row) => nightHours(row.hour)).reduce((sum, row) => sum + row.olx_deals_posted, 0);
  const dealsTotal = hours.reduce((sum, row) => sum + row.olx_deals_posted, 0);
  const scansNight = hours.filter((row) => nightHours(row.hour)).reduce((sum, row) => sum + row.scans_recent, 0);
  const scansTotal = hours.reduce((sum, row) => sum + row.scans_recent, 0);
  bench.metric('arrival.olx.posted_night_share', 'OLX listings posted 22–08 local', postedTotal ? postedNight / postedTotal : null, 'ratio', 'info');
  bench.metric('arrival.olx.deals_posted_night_share', 'OLX deals posted 22–08 local', dealsTotal ? dealsNight / dealsTotal : null, 'ratio', 'info');
  const shoulder = hours.filter((row) => row.hour === 22 || row.hour === 23 || row.hour === 6 || row.hour === 7).reduce((sum, row) => sum + row.olx_posted, 0);
  bench.metric('arrival.olx.posted_shoulder_share', 'OLX listings posted 22–24 and 06–08 (night interval, still active hours)', postedTotal ? shoulder / postedTotal : null, 'ratio', 'info');
  bench.metric('arrival.recent.night_scan_share', 'Scans started 22–08 local (recent)', scansTotal ? scansNight / scansTotal : null, 'ratio', 'info');
}

// Square-root allocation: for the same number of requests, intervals ∝ 1/√(arrival rate) minimise the mean detection delay.
{
  const rows: Array<{ watch: string; marketplace: string; interval: number; perDay: number }> = [];
  for (const [watchId, watch] of watches) {
    if (!watch.enabled) continue;
    for (const marketplace of watch.sources) {
      const entry = completedByPair.get(`${watchId}|${marketplace}`);
      if (!entry?.starts.length) continue;
      const from = Math.max(recentStartMs, entry.starts[0]);
      const days = (nowMs - from) / 86_400_000;
      if (days <= 0) continue;
      const fresh = watchListings.filter((wl) => wl.watchId === watchId && wl.marketplace === marketplace && wl.firstMs >= from && wl.firstMs <= nowMs).length;
      rows.push({ watch: watch.name, marketplace, interval: sourceInterval(watch, marketplace), perDay: fresh / days });
    }
  }
  const totalRate = rows.reduce((sum, row) => sum + row.perDay, 0);
  const budget = rows.reduce((sum, row) => sum + 1 / row.interval, 0); // scans per minute (day cadence)
  const sqrtSum = rows.reduce((sum, row) => sum + Math.sqrt(row.perDay), 0);
  const currentDelay = totalRate ? rows.reduce((sum, row) => sum + row.perDay * row.interval / 2, 0) / totalRate : null;
  const suggested = rows.map((row) => ({ ...row, suggested: row.perDay > 0 ? Math.max(5, sqrtSum / (budget * Math.sqrt(row.perDay))) : 60 }));
  // Re-normalise after the 5-min floor and the 60-min cap for idle sources, so the budget stays equal.
  const usedBudget = suggested.reduce((sum, row) => sum + 1 / Math.min(row.suggested, 60), 0);
  const scale = usedBudget / budget;
  const final = suggested.map((row) => ({ ...row, suggested: Math.min(60, Math.max(5, row.suggested * scale)) }));
  const optimalDelay = totalRate ? final.reduce((sum, row) => sum + row.perDay * row.suggested / 2, 0) / totalRate : null;
  bench.metric('cadence.recent.mean_wait_current_min', 'Mean wait from listing arrival to next scan with today\'s day intervals (interval/2, arrival-weighted)', currentDelay, 'min', 'lower');
  bench.metric('cadence.recent.mean_wait_sqrt_rule_min', 'Same, with the same request budget reallocated by the square-root rule', optimalDelay, 'min', 'info');
  bench.table('interval_reallocation_recent', final.map((row) => ({ watch: row.watch, marketplace: row.marketplace, new_per_day: round(row.perDay, 2), interval_min: row.interval, sqrt_rule_min: round(row.suggested, 1) })));
}

// ----------------------------------------------------------------- lifetime

{
  for (const marketplace of MARKETPLACES) {
    const gone: number[] = [];
    const goneDeals: number[] = [];
    let dealsGone2h = 0;
    for (const wl of watchListings) {
      if (wl.marketplace !== marketplace) continue;
      const entry = completedByPair.get(`${wl.watchId}|${marketplace}`);
      if (!entry) continue;
      // Gone: a later completed scan of the same watch did not store it again.
      const later = upperBound(entry.starts, wl.lastMs + 60_000);
      if (later >= entry.starts.length) continue;
      const hours = (wl.lastMs - wl.firstMs) / 3_600_000;
      gone.push(hours);
      if (isDealAtFirstSight(wl) || wl.alerted) {
        goneDeals.push(hours);
        if (hours <= 2) dealsGone2h += 1;
      }
    }
    const key = mpKey(marketplace);
    bench.metric(`life.all.${key}.visible_hours.p50`, `${marketplace} hours a listing stays in a watch's results p50 (gone ones)`, distribution(gone).p50, 'h', 'info');
    bench.metric(`life.all.${key}.deal_visible_hours.p50`, `${marketplace} same for deals (Very strong+ at first sight or alerted)`, distribution(goneDeals).p50, 'h', 'info');
    bench.metric(`life.all.${key}.deals_gone_within_2h_share`, `${marketplace} deals that left the results within 2 h`, goneDeals.length ? dealsGone2h / goneDeals.length : null, 'ratio', 'info');
    bench.metric(`life.all.${key}.deals_gone_n`, `${marketplace} deals that left the results (n)`, goneDeals.length, 'count', 'info');
  }
}

// ----------------------------------------------------------------- sessions

{
  const sessions = all<Record<string, unknown>>(db, 'SELECT marketplace, created_at, last_used_at, signed_in, checked_at, use_for_checks FROM marketplace_sessions');
  const rows: Array<Record<string, unknown>> = [];
  for (const session of sessions) {
    const marketplace = String(session.marketplace);
    const from = Date.parse(String(session.created_at));
    const to = session.last_used_at ? Date.parse(String(session.last_used_at)) : Number.NaN;
    const within = (scan: ScanRow) => Number.isFinite(to) && scan.startMs >= from && scan.startMs <= to;
    const compareFrom = from - 14 * 86_400_000;
    const pick = (inUse: boolean) => watchScans.filter((scan) => scan.marketplace === marketplace && scan.startMs >= compareFrom && within(scan) === inUse && (scan.status === 'completed' || scan.status === 'failed'));
    for (const inUse of [true, false]) {
      const list = pick(inUse);
      const done = list.filter((scan) => scan.status === 'completed' && Number.isFinite(scan.endMs));
      const dist: Distribution = distribution(done.map((scan) => (scan.endMs - scan.startMs) / 1000));
      rows.push({ marketplace, session_in_use: inUse ? 'yes' : 'no', scans: list.length, fail_pct: pct(list.length - done.length, list.length), duration_p50_s: round(dist.p50, 2), duration_p90_s: round(dist.p90, 2) });
      if (Number.isFinite(to)) {
        bench.metric(`session.${mpKey(marketplace)}.${inUse ? 'in_use' : 'not_in_use'}.duration_s.p50`, `${marketplace} completed scan p50 while the stored session was ${inUse ? '' : 'not '}in use`, dist.p50, 's', 'info');
        bench.metric(`session.${mpKey(marketplace)}.${inUse ? 'in_use' : 'not_in_use'}.failed_rate`, `${marketplace} scan failure rate while the stored session was ${inUse ? '' : 'not '}in use`, list.length ? (list.length - done.length) / list.length : null, 'ratio', 'info');
      }
    }
  }
  bench.table('session_effect', rows);
  bench.table('marketplace_sessions', sessions.map((session) => ({ ...session })));
}

// ----------------------------------------------------------------- research

{
  const research = scans.filter((scan) => scan.kind === 'research');
  const byStatus = new Map<string, number>();
  for (const scan of research) byStatus.set(scan.status, (byStatus.get(scan.status) ?? 0) + 1);
  bench.metric('scan.all.research_scans', 'Research watch scans', research.length, 'count', 'info');
  bench.metric('scan.all.research_failed_rate', 'Research scans failed or skipped', research.length ? ((byStatus.get('failed') ?? 0) + (byStatus.get('skipped') ?? 0)) / research.length : null, 'ratio', 'lower');
}

bench.note('Deals = deal_strength ≥ 4 (Very strong+) on the first observation of a watch listing, or any listing that was alerted. Ground truth is thin (5 flips, 41 listing actions) and marketplace prices are asking prices.');
bench.note('Only OLX listings carry a posting time (created_time); Vinted and Allegro Lokalnie search rows have none (marketplaces.ts:1498-1500), so detection latency is OLX-only.');
bench.note('"Gone" means a later completed scan of the same watch did not store the listing again: sold, removed, edited out of the filters, judged irrelevant, or pushed off the single result page (fetchSearchPages fetches one page, service.ts:4971).');
bench.note('Cadence uses each watch\'s current interval settings; runs after a config change show up as early_or_reconfigured or as overshoot.');
bench.finish();
