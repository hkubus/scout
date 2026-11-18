/**
 * Shared helpers for the improvement benchmarks in scripts/bench/.
 *
 * Every benchmark reads an improvement export (`scout-improvement-*.sqlite`,
 * Settings → Data or GET /api/export/improvement), measures one area, prints
 * a table and can write a JSON report that `compare.ts` diffs against a later
 * run. The export is opened read-only; a benchmark that needs to write (the
 * real service code, migrations) works on a copy from `writableCopy()`.
 *
 * Usage pattern:
 *   node --import tsx scripts/bench/<name>.ts <export.sqlite> [--json=out.json] [--now=ISO]
 *
 * Time windows default to the export's own `exported_at`, so two runs over the
 * same file give the same numbers.
 */

import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';

export type Better = 'lower' | 'higher' | 'info';

export interface Metric {
  /** Stable id, e.g. `scan.detect_latency.olx.p50_min`; compare.ts matches on it. */
  id: string;
  label: string;
  value: number | null;
  unit: string;
  /** Which direction is an improvement; `info` is context, never a regression. */
  better: Better;
  detail?: string;
}

export interface BenchReport {
  format: 'scout-bench/1';
  bench: string;
  generatedAt: string;
  export: {
    path: string;
    exportedAt: string | null;
    format: string | null;
    scoutVersion: string | null;
    sourceDatabaseBytes: number | null;
  };
  params: Record<string, unknown>;
  metrics: Metric[];
  tables: Record<string, Array<Record<string, unknown>>>;
  notes: string[];
}

export interface BenchArgs {
  exportPath: string;
  jsonPath: string | null;
  /** Reference "now" (ISO); defaults to the export's exported_at. */
  now: string | null;
  flags: Map<string, string | true>;
  positional: string[];
}

export function parseArgs(argv = process.argv.slice(2)): BenchArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) flags.set(arg.slice(2), true);
      else flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      positional.push(arg);
    }
  }
  const exportPath = positional[0];
  if (!exportPath) {
    console.error('usage: node --import tsx scripts/bench/<name>.ts <scout-improvement-*.sqlite> [--json=out.json] [--now=ISO]');
    process.exit(2);
  }
  const json = flags.get('json');
  const now = flags.get('now');
  return {
    exportPath: resolve(exportPath),
    jsonPath: typeof json === 'string' ? resolve(json) : null,
    now: typeof now === 'string' ? new Date(now).toISOString() : null,
    flags,
    positional,
  };
}

export type Db = InstanceType<typeof DatabaseSync>;

/** Opens an export read-only. Throws if it isn't a Scout database. */
export function openExport(path: string): Db {
  const db = new DatabaseSync(path, { readOnly: true });
  const hasMigrations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get();
  if (!hasMigrations) throw new Error(`${path} is not a Scout database (no migrations table)`);
  return db;
}

/** Reads one export_info value; null on a plain Scout database without export tables. */
export function exportInfo(db: Db, key: string): string | null {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'export_info'").get();
  if (!table) return null;
  const row = db.prepare('SELECT value FROM export_info WHERE key = ?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

export function tableExists(db: Db, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

export function all<T = Record<string, unknown>>(db: Db, sql: string, ...params: SQLInputValue[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function one<T = Record<string, unknown>>(db: Db, sql: string, ...params: SQLInputValue[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

/** Single numeric value of the first column, or null. */
export function scalar(db: Db, sql: string, ...params: SQLInputValue[]): number | null {
  const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
  if (!row) return null;
  const value = Object.values(row)[0];
  return value === null || value === undefined ? null : Number(value);
}

/**
 * Copies a database to a scratch file the caller may write to (service code,
 * migrations, VACUUM experiments). Never pass the user's live database here
 * without their say-so; exports are fine. Set TMPDIR to a disk path for big files.
 */
export function writableCopy(path: string, dir = process.env.SCOUT_BENCH_TMP ?? tmpdir()): { path: string; dispose(): void } {
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `bench-${process.pid}-${Date.now()}-${basename(path)}`);
  copyFileSync(path, target);
  return {
    path: target,
    dispose() {
      for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(target + suffix, { force: true });
    },
  };
}

// ---------------------------------------------------------------- statistics

export function quantile(sorted: readonly number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export interface Distribution {
  n: number;
  mean: number | null;
  p50: number | null;
  p90: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

export function distribution(values: Iterable<number>): Distribution {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    mean: n ? sorted.reduce((sum, v) => sum + v, 0) / n : null,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: n ? sorted[n - 1] : null,
  };
}

export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

/** Wall time of `fn` over `iterations` runs after `warmup` runs, in ms. */
export function timeSync(fn: () => unknown, iterations = 20, warmup = 3): Distribution {
  for (let i = 0; i < warmup; i += 1) fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return distribution(samples);
}

export async function timeAsync(fn: () => Promise<unknown>, iterations = 20, warmup = 3): Promise<Distribution> {
  for (let i = 0; i < warmup; i += 1) await fn();
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = process.hrtime.bigint();
    await fn();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return distribution(samples);
}

export function hoursBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const ms = Date.parse(b) - Date.parse(a);
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

// ------------------------------------------------------------------ reporting

export class Bench {
  readonly report: BenchReport;
  readonly db: Db;
  readonly args: BenchArgs;
  /** Reference time: --now, else the export's exported_at, else the wall clock. */
  readonly now: string;

  constructor(name: string, args = parseArgs()) {
    this.args = args;
    this.db = openExport(args.exportPath);
    const exportedAt = exportInfo(this.db, 'exported_at');
    const bytes = exportInfo(this.db, 'source_database_bytes');
    this.now = args.now ?? exportedAt ?? new Date().toISOString();
    this.report = {
      format: 'scout-bench/1',
      bench: name,
      generatedAt: new Date().toISOString(),
      export: {
        path: args.exportPath,
        exportedAt,
        format: exportInfo(this.db, 'format'),
        scoutVersion: exportInfo(this.db, 'scout_version'),
        sourceDatabaseBytes: bytes === null ? null : Number(bytes),
      },
      params: { now: this.now },
      metrics: [],
      tables: {},
      notes: [],
    };
  }

  /** ISO time `days` before the reference time. */
  daysAgo(days: number): string {
    return new Date(Date.parse(this.now) - days * 86_400_000).toISOString();
  }

  param(key: string, value: unknown): void {
    this.report.params[key] = value;
  }

  metric(id: string, label: string, value: number | null | undefined, unit: string, better: Better, detail?: string): void {
    const clean = value === undefined || value === null || !Number.isFinite(value) ? null : value;
    this.report.metrics.push({ id, label, value: clean, unit, better, ...(detail ? { detail } : {}) });
  }

  /** Adds p50/p90/p95/max (and n as info) of a distribution under `<id>.<stat>`. */
  distributionMetrics(id: string, label: string, dist: Distribution, unit: string, better: Better, stats: Array<keyof Distribution> = ['p50', 'p90', 'max']): void {
    this.metric(`${id}.n`, `${label} (n)`, dist.n, 'count', 'info');
    for (const stat of stats) {
      if (stat === 'n') continue;
      this.metric(`${id}.${stat}`, `${label} ${stat}`, dist[stat], unit, better);
    }
  }

  table(name: string, rows: Array<Record<string, unknown>>): void {
    this.report.tables[name] = rows;
  }

  note(text: string): void {
    this.report.notes.push(text);
  }

  /** Prints every metric and table, writes --json if given, closes the database. */
  finish(): BenchReport {
    const { report } = this;
    console.log(`\n# ${report.bench} — export ${report.export.exportedAt ?? '?'} (now=${this.now})\n`);
    const idWidth = Math.min(64, Math.max(...report.metrics.map((m) => m.id.length), 10));
    for (const m of report.metrics) {
      const arrow = m.better === 'lower' ? '↓' : m.better === 'higher' ? '↑' : ' ';
      console.log(`${m.id.padEnd(idWidth)}  ${formatValue(m.value).padStart(12)} ${m.unit.padEnd(8)} ${arrow} ${m.label}${m.detail ? ` — ${m.detail}` : ''}`);
    }
    for (const [name, rows] of Object.entries(report.tables)) {
      console.log(`\n## ${name}`);
      if (rows.length) console.table(rows.slice(0, 40));
      else console.log('(no rows)');
      if (rows.length > 40) console.log(`… ${rows.length - 40} more rows in the JSON report`);
    }
    if (report.notes.length) {
      console.log('\n## notes');
      for (const note of report.notes) console.log(`- ${note}`);
    }
    if (this.args.jsonPath) {
      writeFileSync(this.args.jsonPath, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\nwrote ${this.args.jsonPath}`);
    }
    this.db.close();
    return report;
  }
}

export function formatValue(value: number | null): string {
  if (value === null) return '—';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  const abs = Math.abs(value);
  return value.toFixed(abs >= 100 ? 1 : abs >= 1 ? 2 : 4);
}
