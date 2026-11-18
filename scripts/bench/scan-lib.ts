/**
 * Helpers shared by scanning.ts and alerts.ts: local-time arithmetic for the
 * night polling window, scan/watch loaders and error-message clustering.
 */

import { all, exportInfo, one, type Db } from './lib';

export const MARKETPLACES = ['OLX', 'Allegro Lokalnie', 'Vinted'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

/** Short metric-id segment for a marketplace. */
export function mpKey(marketplace: string): string {
  if (marketplace === 'Allegro Lokalnie') return 'allegro';
  return marketplace.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

/** Night polling window and default, mirroring server/service.ts:185 and :201-202. */
export const NIGHT_START_HOUR = 22;
export const NIGHT_END_HOUR = 8;
export const DEFAULT_NIGHT_INTERVAL_MINUTES = 30;
const HOUR_MS = 3_600_000;

/** The time zone the server ran in (export_info runtime env TZ), else Europe/Warsaw. */
export function exportTimeZone(db: Db): string {
  const runtime = exportInfo(db, 'runtime');
  if (runtime) {
    try {
      const tz = (JSON.parse(runtime) as { env?: { TZ?: string | null } }).env?.TZ;
      if (tz) return tz;
    } catch { /* fall through */ }
  }
  return 'Europe/Warsaw';
}

/**
 * Local wall-clock hour in the server's zone, memoized per UTC hour (every
 * zone Scout runs in has whole-hour offsets, so local hours change on UTC
 * hour boundaries).
 */
export class LocalClock {
  private readonly format: Intl.DateTimeFormat;
  private readonly memo = new Map<number, number>();

  constructor(readonly timeZone: string) {
    this.format = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' });
  }

  hour(ms: number): number {
    const key = Math.floor(ms / HOUR_MS);
    let hour = this.memo.get(key);
    if (hour === undefined) {
      hour = Number(this.format.format(new Date(key * HOUR_MS))) % 24;
      this.memo.set(key, hour);
    }
    return hour;
  }

  isNight(ms: number): boolean {
    const hour = this.hour(ms);
    return hour >= NIGHT_START_HOUR || hour < NIGHT_END_HOUR;
  }

  /** The next instant after `ms` at which the local hour becomes `target`. */
  nextHourStart(ms: number, target: number): number {
    const first = Math.floor(ms / HOUR_MS) + 1;
    for (let k = 0; k < 50; k += 1) {
      const t = (first + k) * HOUR_MS;
      if (this.hour(t) === target) return t;
    }
    return ms + 24 * HOUR_MS;
  }

  /**
   * Mirrors nextWatchScanAt (server/service.ts:535): the day or night
   * interval from the finish time, capped at the next 08:00/22:00 boundary.
   */
  expectedNext(finishedMs: number, dayIntervalMinutes: number, nightIntervalMinutes = DEFAULT_NIGHT_INTERVAL_MINUTES): number {
    const day = Math.max(5, Math.floor(Number(dayIntervalMinutes) || 5));
    const night = Math.max(day, Math.floor(Number.isFinite(nightIntervalMinutes) ? nightIntervalMinutes : DEFAULT_NIGHT_INTERVAL_MINUTES));
    const isNight = this.isNight(finishedMs);
    const next = finishedMs + (isNight ? night : day) * 60_000;
    const boundary = this.nextHourStart(finishedMs, isNight ? NIGHT_END_HOUR : NIGHT_START_HOUR);
    return Math.min(next, boundary);
  }
}

export interface WatchConfig {
  id: string;
  name: string;
  enabled: boolean;
  intervalMinutes: number;
  sources: string[];
  sourceIntervals: Record<string, number>;
  createdAt: string;
  archivedAt: string | null;
}

export function loadWatches(db: Db): Map<string, WatchConfig> {
  const rows = all<Record<string, unknown>>(db, 'SELECT id, name, enabled, interval_minutes, sources_json, source_intervals_json, created_at, archived_at FROM watches');
  const map = new Map<string, WatchConfig>();
  for (const row of rows) {
    let sources: string[] = [];
    let sourceIntervals: Record<string, number> = {};
    try { sources = JSON.parse(String(row.sources_json ?? '[]')); } catch { /* keep empty */ }
    try {
      const raw = JSON.parse(String(row.source_intervals_json ?? '{}')) as Record<string, unknown> | null;
      for (const [key, value] of Object.entries(raw ?? {})) if (Number.isFinite(Number(value))) sourceIntervals[key] = Math.min(1440, Math.max(5, Math.floor(Number(value))));
    } catch { sourceIntervals = {}; }
    map.set(String(row.id), {
      id: String(row.id),
      name: String(row.name),
      enabled: Number(row.enabled) === 1,
      intervalMinutes: Number(row.interval_minutes),
      sources,
      sourceIntervals,
      createdAt: String(row.created_at),
      archivedAt: row.archived_at ? String(row.archived_at) : null,
    });
  }
  return map;
}

/** Effective day interval of one source (watchSourceIntervals, server/service.ts:575). */
export function sourceInterval(watch: WatchConfig, marketplace: string): number {
  return watch.sourceIntervals[marketplace] ?? Math.max(5, Math.floor(watch.intervalMinutes || 5));
}

export function nightIntervalSetting(db: Db): number {
  const row = one<{ value?: string }>(db, "SELECT value FROM settings WHERE key = 'night_interval'");
  const value = Number(row?.value);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_NIGHT_INTERVAL_MINUTES;
}

export interface ScanRow {
  id: number;
  watchId: string;
  kind: 'watch' | 'research';
  marketplace: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  startMs: number;
  endMs: number;
}

export function loadScans(db: Db): ScanRow[] {
  const rows = all<Record<string, unknown>>(db, 'SELECT id, watch_id, watch_kind, marketplace, status, started_at, completed_at, error FROM scans ORDER BY started_at, id');
  return rows.map((row) => ({
    id: Number(row.id),
    watchId: String(row.watch_id),
    kind: row.watch_kind === 'research' ? 'research' : 'watch',
    marketplace: String(row.marketplace),
    status: String(row.status),
    startedAt: String(row.started_at),
    completedAt: row.completed_at ? String(row.completed_at) : null,
    error: row.error === null || row.error === undefined ? null : String(row.error),
    startMs: Date.parse(String(row.started_at)),
    endMs: row.completed_at ? Date.parse(String(row.completed_at)) : Number.NaN,
  }));
}

/**
 * Collapses a scan/connector message into a cluster key: first line only,
 * URLs, timestamps, quoted strings and numbers replaced.
 */
export function errorCluster(message: string | null | undefined): string {
  if (!message) return '(none)';
  let text = message.split('\n')[0];
  text = text.replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>')
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\d+(\.\d+)?/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 110 ? `${text.slice(0, 107)}…` : text;
}

/** Stored-listing count from a completed scan's summary ("12 shipping matches · …", "8 listings normalized"). */
export function storedCountFromMessage(message: string | null): number | null {
  if (!message) return null;
  const match = /^(\d+) (shipping matches|listings normalized)/.exec(message);
  return match ? Number(match[1]) : null;
}

/** First index in a sorted array with value > x. */
export function upperBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index in a sorted array with value >= x. */
export function lowerBound(sorted: readonly number[], x: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Count of values in (from, to) exclusive, from a sorted array. */
export function countBetween(sorted: readonly number[], from: number, to: number): number {
  if (!(to > from)) return 0;
  return Math.max(0, lowerBound(sorted, to) - upperBound(sorted, from));
}

export function isoWeek(iso: string): string {
  const date = new Date(iso);
  const day = (date.getUTCDay() + 6) % 7;
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 3));
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((thursday.getTime() - yearStart) / (7 * 86_400_000));
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function round(value: number | null | undefined, digits = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function pct(part: number, whole: number, digits = 1): number | null {
  return whole > 0 ? round((part / whole) * 100, digits) : null;
}
