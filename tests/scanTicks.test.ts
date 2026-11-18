import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db';
import { ScoutService, connectorFailedTicks, nextWatchScanAt, nextWatchScanSchedule } from '../server/service';

const templateDirectory = mkdtempSync(join(tmpdir(), 'scout-scan-ticks-template-'));
after(() => rmSync(templateDirectory, { recursive: true, force: true }));
let template: string | undefined;

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'scout-scan-ticks-'));
  if (!template) {
    template = join(templateDirectory, 'scout.sqlite');
    openDatabase(template).close();
  }
  copyFileSync(template, join(directory, 'scout.sqlite'));
  const db = openDatabase(join(directory, 'scout.sqlite'));
  const service = new ScoutService(db, () => {}, { suggestVariantGroups: async () => [] });
  return { db, service, close: () => { db.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function seedWatch(db: any, id: string) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO watches (id, name, query, sources_json, enabled, next_scan_at, created_at, updated_at)
    VALUES (?, ?, 'cpu', '["OLX"]', 1, ?, ?, ?)`).run(id, `${id} name`, now, now, now);
}

// Connector backoff counts failed scheduler ticks, not failed runs.
test('counts connector failures per scheduler tick, not per watch', () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 18, 18, 0, 0) + seconds * 1000).toISOString();
  const run = (status: string, startedS: number, finishedS: number | null) => ({ status, startedAt: at(startedS), finishedAt: finishedS === null ? null : at(finishedS) });
  // Newest first. Three watches failing in one tick after an ok tick: one failure.
  assert.equal(connectorFailedTicks([run('error', 60.002, 95), run('error', 60.001, 90), run('error', 60, 88), run('ok', 30, 31)]), 1);
  // Failures in two ticks 30 s apart: two.
  assert.equal(connectorFailedTicks([run('error', 60, 90), run('error', 30.001, 59), run('error', 30, 58), run('ok', 0, 1)]), 2);
  // A tick where another watch's scan succeeded is not a failed tick.
  assert.equal(connectorFailedTicks([run('error', 60.001, 90), run('ok', 60, 61), run('error', 30, 58)]), 0);
  assert.equal(connectorFailedTicks([run('ok', 60.001, 61), run('error', 60, 90), run('error', 30, 58)]), 0);
  // A newer tick that worked ends the streak.
  assert.equal(connectorFailedTicks([run('ok', 90, 91), run('error', 60, 120), run('error', 30, 58)]), 0);
  // Back-to-back scans (the second started after the first ended) are separate attempts.
  assert.equal(connectorFailedTicks([run('error', 0.5, 0.9), run('error', 0, 0.4)]), 2);
  // A run that started 20 s after another, while it still ran, is the next tick.
  assert.equal(connectorFailedTicks([run('error', 50, 80), run('error', 30, 75)]), 2);
  assert.equal(connectorFailedTicks([]), 0);
});

test('two watches failing in the same tick do not pause the marketplace; the next failed tick does', async () => {
  const context = fixture();
  try {
    seedWatch(context.db, 'tick-a');
    seedWatch(context.db, 'tick-b');
    let fetches = 0;
    (context.service as any).fetchOlxApi = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { status: 403, json: null };
    };
    const row = (id: string) => context.db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
    const errors = () => context.db.prepare("SELECT backoff_until FROM connector_runs WHERE source = 'OLX' AND status = 'error' ORDER BY id").all() as Array<{ backoff_until: string | null }>;
    // One tick: both scans start before either fails.
    await Promise.all([(context.service as any).runWatch(row('tick-a'), { forceAll: true }), (context.service as any).runWatch(row('tick-b'), { forceAll: true })]);
    assert.equal(fetches, 2);
    assert.deepEqual(errors().map((run) => run.backoff_until), [null, null]);
    assert.notEqual(context.service.getConnectors().find((connector) => connector.name === 'OLX')?.status, 'OK');
    // The next tick fails too: now the connector backs off for 5 minutes.
    await (context.service as any).runWatch(row('tick-a'), { forceAll: true });
    const latest = errors().at(-1)!;
    assert.ok(latest.backoff_until);
    const delay = Date.parse(latest.backoff_until) - Date.now();
    assert.ok(delay > 4 * 60_000 && delay <= 5 * 60_000, `expected a 5 min pause, got ${delay} ms`);
    await (context.service as any).runWatch(row('tick-b'), { forceAll: true });
    assert.equal(fetches, 3, 'the paused marketplace is skipped');
  } finally { context.close(); }
});

// A scanned source's next time counts from when it was due.

test('advances a scanned marketplace from when it was due, not from when the scan finished', () => {
  const local = (hours: number, minutes: number, seconds = 0) => new Date(2026, 7, 23, hours, minutes, seconds, 0).toISOString();
  const schedule = (due: string | undefined, finished: string, interval = 7) => nextWatchScanSchedule({
    sources: ['OLX'], intervals: { OLX: interval }, prior: due ? { OLX: due } : {}, scanned: ['OLX'], finishedAt: finished, nightIntervalMinutes: 30,
  }).nextBySource.OLX;
  // Picked up by the 30 s tick and scanned for 12 s: still 7 minutes after the due time.
  assert.equal(schedule(local(12, 0), local(12, 0, 42)), local(12, 7));
  // Late by more than an interval (Scout was down): counts from the finish.
  assert.equal(schedule(local(11, 50), local(12, 0, 40)), local(12, 7, 40));
  // Not due yet (Scan now): counts from the finish, never later than that.
  assert.equal(schedule(local(12, 5), local(12, 0, 40)), local(12, 7, 40));
  // No recorded time (a new source): from the finish.
  assert.equal(schedule(undefined, local(12, 0, 40)), local(12, 7, 40));
  // Due just before the night window, finished inside it: the night interval from the finish.
  assert.equal(schedule(local(21, 59, 50), local(22, 0, 20)), nextWatchScanAt(local(22, 0, 20), 7, 30));
  // Backoff still wins when it is later.
  const backoff = local(12, 30);
  assert.equal(nextWatchScanSchedule({ sources: ['OLX'], intervals: { OLX: 7 }, prior: { OLX: local(12, 0) }, scanned: ['OLX'], finishedAt: local(12, 0, 30), nightIntervalMinutes: 30, backoff: { OLX: backoff } }).nextBySource.OLX, backoff);
});
