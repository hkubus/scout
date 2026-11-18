// Warnings and errors from Scout's log, kept in SQLite (app_log, migration
// 042) so they survive a restart. The in-memory buffer behind the Logs tab
// holds every line since the process started; this table holds only the lines
// that are not 'info', so a failed scan still has its error after a restart.
//
// A burst cannot flood the database: an identical line (same level, scope and
// message) is stored once per minute with a repeat count, at most
// APP_LOG_MAX_PER_MINUTE rows are written a minute (the rest are counted and
// summarised in one line), and the table is bounded by count as it grows and
// by age in the daily retention prune. Writing a log line never throws.
import type { LogEntry } from '../src/types';

export const APP_LOG_MAX_ROWS = 10_000;
export const APP_LOG_MAX_DAYS = 30;
export const APP_LOG_REPEAT_WINDOW_MS = 60_000;
export const APP_LOG_MAX_PER_MINUTE = 60;
const MAX_MESSAGE_CHARS = 2_000;
// The count bound is enforced every this many stored rows.
const COUNT_PRUNE_EVERY = 100;
const MAX_TRACKED_LINES = 1_000;

/** A log line as the debug API and the improvement export show it. */
export type LogHistoryEntry = LogEntry & {
  /** memory: this process's log buffer. stored: app_log, which outlives restarts. */
  source: 'memory' | 'stored';
  /** Identical lines folded into a stored row (stored rows only). */
  repeats?: number;
};

type Tracked = { id: number; at: number; pending: number };

export class AppLog {
  private readonly statements = new Map<string, any>();
  // Recently stored lines by level, scope and message, for folding repeats.
  private readonly recent = new Map<string, Tracked>();
  private minuteStart = 0;
  private writtenThisMinute = 0;
  private dropped = 0;
  private storedSincePrune = 0;
  private lastSweep = 0;

  constructor(private readonly db: any, private readonly now: () => number = Date.now) {}

  private stmt(sql: string) {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  /** Store a warning or error line; info lines stay in memory only. */
  record(entry: LogEntry) {
    if (entry.level === 'info') return;
    try {
      this.store(entry);
    } catch {
      // A closed or busy database, or one without the table yet, must not
      // turn a log line into a failure of whatever was being logged.
    }
  }

  private store(entry: LogEntry) {
    const now = this.now();
    if (now - this.lastSweep >= APP_LOG_REPEAT_WINDOW_MS || this.recent.size > MAX_TRACKED_LINES) this.sweep(now);
    const key = `${entry.level}\u0000${entry.scope}\u0000${entry.message}`;
    const seen = this.recent.get(key);
    if (seen && now - seen.at < APP_LOG_REPEAT_WINDOW_MS) {
      seen.pending += 1;
      return;
    }
    if (seen) this.flushOne(key, seen);
    if (now - this.minuteStart >= 60_000) {
      this.minuteStart = now;
      this.writtenThisMinute = 0;
      this.flushDropped(new Date(now).toISOString());
    }
    if (this.writtenThisMinute >= APP_LOG_MAX_PER_MINUTE) {
      this.dropped += 1;
      return;
    }
    const id = this.insert(entry.at, entry.level, entry.scope, entry.message);
    this.recent.set(key, { id, at: now, pending: 0 });
  }

  private insert(at: string, level: string, scope: string, message: string) {
    const result = this.stmt('INSERT INTO app_log (at, level, scope, message) VALUES (?, ?, ?, ?)').run(at, level, scope, message.slice(0, MAX_MESSAGE_CHARS));
    const id = Number(result.lastInsertRowid);
    this.writtenThisMinute += 1;
    this.storedSincePrune += 1;
    if (this.storedSincePrune >= COUNT_PRUNE_EVERY) {
      this.storedSincePrune = 0;
      // Ids only grow and the oldest rows go first, so this keeps the newest rows.
      this.stmt('DELETE FROM app_log WHERE id <= ?').run(id - APP_LOG_MAX_ROWS);
    }
    return id;
  }

  private flushOne(key: string, tracked: Tracked) {
    if (tracked.pending) this.stmt('UPDATE app_log SET repeats = repeats + ? WHERE id = ?').run(tracked.pending, tracked.id);
    tracked.pending = 0;
    this.recent.delete(key);
  }

  private flushDropped(at: string) {
    if (!this.dropped) return;
    const count = this.dropped;
    this.dropped = 0;
    this.insert(at, 'error', 'diagnostics', `${count} more warning and error line${count === 1 ? ' was' : 's were'} not stored: more than ${APP_LOG_MAX_PER_MINUTE} a minute`);
  }

  /** Write the repeat counts of lines whose window has closed and forget them. */
  private sweep(now: number) {
    this.lastSweep = now;
    for (const [key, tracked] of this.recent) if (now - tracked.at >= APP_LOG_REPEAT_WINDOW_MS || this.recent.size > MAX_TRACKED_LINES) this.flushOne(key, tracked);
  }

  /** Store every pending repeat count and dropped-line summary. */
  flush() {
    try {
      for (const tracked of this.recent.values()) {
        if (!tracked.pending) continue;
        this.stmt('UPDATE app_log SET repeats = repeats + ? WHERE id = ?').run(tracked.pending, tracked.id);
        tracked.pending = 0;
      }
      this.flushDropped(new Date(this.now()).toISOString());
    } catch { /* best-effort, like record() */ }
  }

  /** Age bound, run with the daily retention prune. */
  prune() {
    this.flush();
    this.stmt('DELETE FROM app_log WHERE at < ?').run(new Date(this.now() - APP_LOG_MAX_DAYS * 24 * 60 * 60_000).toISOString());
  }

  /**
   * This process's log buffer (`buffer`, oldest first) merged with up to
   * `storedLimit` of the newest stored lines it does not already hold, newest
   * first. After a restart the buffer is nearly empty and the stored lines
   * carry the warnings and errors from before it.
   */
  history(buffer: readonly LogEntry[], storedLimit = 500): LogHistoryEntry[] {
    this.flush();
    let stored: Array<{ id: number; at: string; level: LogEntry['level']; scope: LogEntry['scope']; message: string; repeats: number }> = [];
    try {
      stored = this.stmt('SELECT id, at, level, scope, message, repeats FROM app_log ORDER BY id DESC LIMIT ?').all(Math.max(0, storedLimit) + buffer.length);
    } catch { /* no table yet: the buffer alone */ }
    const key = (entry: { at: string; level: string; scope: string; message: string }) => `${entry.at}\u0000${entry.level}\u0000${entry.scope}\u0000${entry.message.slice(0, MAX_MESSAGE_CHARS)}`;
    const inBuffer = new Set(buffer.map(key));
    const merged: LogHistoryEntry[] = buffer.map((entry) => ({ ...entry, source: 'memory' as const })).reverse();
    let added = 0;
    for (const row of stored) {
      if (added >= storedLimit) break;
      if (inBuffer.has(key(row))) continue;
      merged.push({ id: Number(row.id), at: String(row.at), level: row.level, scope: row.scope, message: String(row.message), source: 'stored', repeats: Number(row.repeats) });
      added += 1;
    }
    // ISO-8601 UTC timestamps sort as text; the sort is stable, so lines
    // logged in the same millisecond keep their newest-first order.
    return merged.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
}
