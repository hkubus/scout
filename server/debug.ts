// Read-only debug access to the live database for development and agent
// troubleshooting. Browsing runs on a separate read-only SQLite connection;
// free-form SQL and the snapshot run in short-lived child processes on their
// own read-only connections (queries are killed at a deadline), so neither a
// runaway query nor copying the database can block Scout's event loop. Encrypted credentials are redacted by shape wherever
// they appear.
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { runNodeChild } from './nodeChild';
import { ServiceError } from './service';
import type { ScoutService } from './service';

export { runNodeChild };

export const REDACTED = '[redacted: encrypted secret]';
// encryptSecret() output: base64url(12-byte iv).base64url(16-byte tag).base64url(ciphertext)
export const ENCRYPTED_SECRET = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;
// The same shape anywhere inside a value, e.g. `' ' || value` in free-form SQL.
export const EMBEDDED_SECRET = /[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+/g;
const QUERY_TIMEOUT_MS = 5_000;
const QUERY_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const READ_STATEMENT = /^(?:select|with|values|explain|pragma)\b/i;
const QUERY_MAX_ROWS = 5000;
const TABLE_MAX_ROWS = 1000;
const SAFE_ENV_KEYS = [
  'NODE_ENV', 'PORT', 'SCOUT_HOST', 'TZ', 'SCOUT_DB_PATH', 'SCOUT_VERSION', 'SCOUT_CORS_ORIGIN',
  'SCOUT_OPENROUTER_MODEL', 'SCOUT_JEV_MODE', 'SCOUT_JEV_MODEL', 'SCOUT_VISION_MODEL', 'SCOUT_JEV_CONCURRENCY', 'SCOUT_JEV_GLOBAL_CONCURRENCY',
  'SCOUT_SEARCH_DEADLINE_MS', 'SCOUT_SEARCH_MAX_MS', 'SCOUT_SEARCH_CACHE_MS', 'SCOUT_SEARCH_TYPO_VARIANTS', 'SCOUT_SEARCH_TYPO_WAIT_MS',
  'SCOUT_CHROMIUM_PATH', 'SCOUT_DIST_PATH', 'SCOUT_SEED_DEMO', 'SCOUT_SKIP_MIGRATION_BACKUP',
];
const SECRET_ENV_KEYS = ['SCOUT_SECRET', 'SCOUT_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'];

/** The process and the non-secret configuration it runs with; secrets only as configured or not. */
export function runtimeEnvironment() {
  const env: Record<string, string | null> = {};
  for (const key of SAFE_ENV_KEYS) env[key] = process.env[key] ?? null;
  const secretsConfigured: Record<string, boolean> = {};
  for (const key of SECRET_ENV_KEYS) secretsConfigured[key] = Boolean(process.env[key]?.trim());
  return {
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    memory: process.memoryUsage(),
    env,
    secretsConfigured,
  };
}

/**
 * SCOUT_DEBUG_API=true/false decides explicitly; unset, the debug API is on
 * only while authentication is off (local development), so an internet-facing
 * instance does not hand arbitrary SQL to every credential by default.
 */
export function debugApiEnabled(authEnabled = false) {
  const value = process.env.SCOUT_DEBUG_API?.trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  return !authEnabled;
}

/** JSON-safe, secret-free copy of a SQLite value. */
export function debugValue(value: unknown): unknown {
  if (typeof value === 'string') return ENCRYPTED_SECRET.test(value) ? REDACTED : value.replace(EMBEDDED_SECRET, REDACTED);
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return { blob: true, bytes: value.byteLength };
  return value;
}

function debugRow(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = debugValue(value);
  return out;
}

function stripLeadingComments(sql: string) {
  let rest = sql.trimStart();
  for (;;) {
    if (rest.startsWith('--')) {
      const newline = rest.indexOf('\n');
      rest = newline === -1 ? '' : rest.slice(newline + 1).trimStart();
    } else if (rest.startsWith('/*')) {
      const end = rest.indexOf('*/');
      rest = end === -1 ? '' : rest.slice(end + 2).trimStart();
    } else return rest;
  }
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * The operator's private bookkeeping (the flip ledger and the outcomes of
 * their negotiations) and the apps let in over OAuth are not debugging data:
 * they are left out of the table list, refused in read-only SQL, and emptied
 * in snapshots. Export the ledger through the authenticated /api/export
 * instead.
 */
const PRIVATE_TABLES = ['flips', 'flip_photos', 'negotiation_outcomes', 'oauth_clients', 'oauth_codes', 'connected_app_tokens'];
const PRIVATE_TABLE_PATTERN = new RegExp(`\\b(?:${PRIVATE_TABLES.join('|')})\\b`, 'i');

// Runs in a child process: opens its own read-only connection, blanks the
// encrypted marketplace session column via the authorizer (where supported),
// runs one statement, and prints rows as JSON with blobs and bigints made safe.
const QUERY_CHILD = `
const { DatabaseSync, constants } = require('node:sqlite');
const privateTables = new Set(${JSON.stringify(PRIVATE_TABLES)});
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const { path, sql, params, maxRows } = JSON.parse(input);
  const out = (value) => process.stdout.write(JSON.stringify(value));
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;');
    if (typeof db.setAuthorizer === 'function' && constants) {
      db.setAuthorizer((action, table, column) => (action === constants.SQLITE_READ && privateTables.has(table) ? constants.SQLITE_DENY
        : action === constants.SQLITE_READ && table === 'marketplace_sessions' && column === 'storage_state_encrypted' ? constants.SQLITE_IGNORE : constants.SQLITE_OK));
    }
  } catch (error) { out({ error: 'open', message: String(error && error.message || error) }); return; }
  let statement;
  try { statement = db.prepare(sql); } catch (error) { out({ error: 'sql', message: String(error && error.message || error) }); return; }
  const rows = [];
  let truncated = false;
  try {
    for (const row of statement.iterate(...(Array.isArray(params) ? params : [params]))) {
      if (rows.length >= maxRows) { truncated = true; break; }
      const safe = {};
      for (const [key, value] of Object.entries(row)) {
        safe[key] = typeof value === 'bigint' ? (Number.isSafeInteger(Number(value)) ? Number(value) : value.toString())
          : value instanceof Uint8Array ? { blob: true, bytes: value.byteLength } : value;
      }
      rows.push(safe);
    }
  } catch (error) { out({ error: 'sql', message: String(error && error.message || error) }); return; }
  let columns;
  try { columns = statement.columns().map((column) => column.name); } catch { columns = rows[0] ? Object.keys(rows[0]) : []; }
  out({ columns, rows, truncated });
});
`;

type QueryChildResult = { error?: 'open' | 'sql'; message?: string; columns?: string[]; rows?: Array<Record<string, unknown>>; truncated?: boolean };

function runQueryChild(payload: object, timeoutMs: number): Promise<QueryChildResult> {
  return runNodeChild<QueryChildResult>(QUERY_CHILD, payload, {
    timeoutMs,
    maxOutputBytes: QUERY_MAX_OUTPUT_BYTES,
    errors: {
      timeout: () => new ServiceError(`Query exceeded the ${timeoutMs} ms debug time limit and was stopped`, 400),
      tooLarge: () => new ServiceError('Query result is too large; select fewer columns or rows', 400),
      noResult: () => new ServiceError('Query process ended without a result (out of memory?)', 400),
    },
  });
}

const SNAPSHOT_TIMEOUT_MS = 10 * 60_000;

// Runs in a child process (see runNodeChild): copies the database read-only
// with VACUUM INTO, then blanks credentials and empties the private tables in
// the copy. secure_delete zeroes the removed values where they lay, so the
// copy needs no second VACUUM: at 235 MB that VACUUM took 15 s of the 26 s.
const SNAPSHOT_CHILD = `
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const job = JSON.parse(input);
  const out = (value) => process.stdout.write(JSON.stringify(value));
  const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"';
  try {
    const source = new DatabaseSync(job.source, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout = 5000');
      source.prepare('VACUUM INTO ?').run(job.target);
    } finally { source.close(); }
    const copy = new DatabaseSync(job.target);
    try {
      copy.exec('PRAGMA secure_delete = ON; PRAGMA foreign_keys = OFF;');
      const encrypted = new RegExp(job.encryptedSecret);
      const hasTable = (name) => Boolean(copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
      copy.exec('BEGIN');
      if (hasTable('settings')) {
        const update = copy.prepare('UPDATE settings SET value = ? WHERE key = ?');
        for (const row of copy.prepare('SELECT key, value FROM settings').all()) if (typeof row.value === 'string' && encrypted.test(row.value)) update.run(job.redacted, row.key);
      }
      if (hasTable('marketplace_sessions')) copy.prepare('UPDATE marketplace_sessions SET storage_state_encrypted = ?').run(job.redacted);
      for (const table of job.privateTables) if (hasTable(table)) copy.exec('DELETE FROM ' + quote(table));
      copy.exec('COMMIT');
    } finally { copy.close(); }
    out({ bytes: statSync(job.target).size });
  } catch (error) { out({ error: String(error && error.message || error) }); }
});
`;

export class ScoutDebug {
  private readonlyDb: any = null;
  readonly databasePath: string;

  constructor(private readonly db: any, private readonly service: ScoutService, databasePath = process.env.SCOUT_DB_PATH ?? './data/scout.sqlite', private readonly queryTimeoutMs = QUERY_TIMEOUT_MS) {
    this.databasePath = resolve(databasePath);
  }

  private reader() {
    if (!this.readonlyDb) {
      const reader = new DatabaseSync(this.databasePath, { readOnly: true });
      reader.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;');
      this.readonlyDb = reader;
    }
    return this.readonlyDb;
  }

  close() {
    try { this.readonlyDb?.close(); } catch { /* best-effort */ }
    this.readonlyDb = null;
  }

  private tableNames(): string[] {
    return (this.reader().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name).filter((name) => !PRIVATE_TABLES.includes(name));
  }

  /** Every table and view with columns, indexes, and row counts, plus file and migration state. */
  schema() {
    const reader = this.reader();
    const fileSize = (path: string) => (existsSync(path) ? statSync(path).size : null);
    const pragma = (name: string) => Object.values(reader.prepare(`PRAGMA ${name}`).get() ?? {})[0] ?? null;
    const withoutRowid = new Set<string>();
    try {
      for (const row of reader.prepare('PRAGMA table_list').all() as Array<{ name: string; wr: number }>) if (row.wr) withoutRowid.add(row.name);
    } catch { /* table_list needs SQLite 3.37+ */ }
    const tables = this.tableNames().map((name) => {
      const columns = (reader.prepare(`PRAGMA table_xinfo(${quoteIdent(name)})`).all() as Array<Record<string, unknown>>)
        .map((column) => ({ name: column.name, type: column.type, notNull: Boolean(column.notnull), default: column.dflt_value, primaryKey: Number(column.pk) || 0, hidden: Number(column.hidden) || 0 }));
      const indexes = (reader.prepare(`PRAGMA index_list(${quoteIdent(name)})`).all() as Array<Record<string, unknown>>)
        .map((index) => ({
          name: index.name,
          unique: Boolean(index.unique),
          columns: (reader.prepare(`PRAGMA index_info(${quoteIdent(String(index.name))})`).all() as Array<{ name: string | null }>).map((column) => column.name),
        }));
      const rowCount = Number((reader.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(name)}`).get() as { count: number }).count);
      return { name, rowCount, withoutRowid: withoutRowid.has(name), columns, indexes };
    });
    const views = (reader.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'view' ORDER BY name").all() as Array<{ name: string; sql: string }>);
    const migrations = (reader.prepare('SELECT id, applied_at FROM migrations ORDER BY id').all() as Array<{ id: string; applied_at: string }>);
    return {
      database: {
        path: this.databasePath,
        bytes: fileSize(this.databasePath),
        walBytes: fileSize(`${this.databasePath}-wal`),
        sqliteVersion: (reader.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
        pageSize: pragma('page_size'),
        pageCount: pragma('page_count'),
        freelistCount: pragma('freelist_count'),
        journalMode: pragma('journal_mode'),
      },
      migrations,
      tables,
      views,
    };
  }

  /** Page through one table's raw rows; defaults to newest-first by rowid. */
  tableRows(table: string, options: { limit?: number; offset?: number; orderBy?: string; direction?: 'asc' | 'desc' } = {}) {
    const reader = this.reader();
    if (!this.tableNames().includes(table)) throw new ServiceError(`Unknown table: ${table}`, 404);
    const columns = (reader.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as Array<{ name: string }>).map((column) => column.name);
    if (options.orderBy && !columns.includes(options.orderBy)) throw new ServiceError(`Unknown column for ${table}: ${options.orderBy}`, 400);
    const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 100)), TABLE_MAX_ROWS);
    const offset = Math.max(0, Math.trunc(options.offset ?? 0));
    const direction = options.direction === 'asc' ? 'ASC' : 'DESC';
    let order = options.orderBy ? `ORDER BY ${quoteIdent(options.orderBy)} ${direction}` : `ORDER BY rowid ${direction}`;
    const total = Number((reader.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdent(table)}`).get() as { count: number }).count);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = reader.prepare(`SELECT * FROM ${quoteIdent(table)} ${order} LIMIT ? OFFSET ?`).all(limit, offset);
    } catch {
      // WITHOUT ROWID tables have no rowid to order by.
      order = '';
      rows = reader.prepare(`SELECT * FROM ${quoteIdent(table)} LIMIT ? OFFSET ?`).all(limit, offset);
    }
    return { table, columns, total, limit, offset, orderBy: options.orderBy ?? (order ? 'rowid' : null), direction: direction.toLowerCase(), rows: rows.map(debugRow) };
  }

  /**
   * Run one read-only statement (SELECT/WITH/VALUES/EXPLAIN/PRAGMA) with
   * positional or named params in a child process that is killed after the
   * debug time limit, so the event loop and scheduler keep running.
   */
  async query(sql: string, params: unknown[] | Record<string, unknown> = [], maxRows = 500) {
    const statementText = stripLeadingComments(sql);
    if (!READ_STATEMENT.test(statementText)) throw new ServiceError('Only SELECT, WITH, VALUES, EXPLAIN, and PRAGMA statements are allowed', 400);
    // Belt and braces with the child's authorizer, which older Node builds lack.
    if (PRIVATE_TABLE_PATTERN.test(statementText)) throw new ServiceError('The flip ledger, negotiation outcomes and connected apps are private and not available through the debug API', 403);
    const limit = Math.min(Math.max(1, Math.trunc(maxRows)), QUERY_MAX_ROWS);
    const started = performance.now();
    const result = await runQueryChild({ path: this.databasePath, sql: statementText, params, maxRows: limit }, this.queryTimeoutMs);
    if (result.error) throw new ServiceError(result.error === 'sql' ? `SQL error: ${result.message}` : `Could not open the database: ${result.message}`, 400);
    const rows = (result.rows ?? []).map(debugRow);
    return { columns: result.columns ?? [], rows, rowCount: rows.length, truncated: Boolean(result.truncated), maxRows: limit, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  /**
   * Process, configuration, readiness, and the log: this process's buffer
   * plus the warnings and errors stored from before it (app_log).
   */
  runtime() {
    return {
      now: new Date().toISOString(),
      pid: process.pid,
      ...runtimeEnvironment(),
      readiness: this.service.readiness(),
      settings: this.service.settings(),
      logs: this.service.logHistory(),
    };
  }

  /**
   * Write a consistent copy of the whole database with stored credentials
   * blanked. Built in a child process (SNAPSHOT_CHILD) so the copy never
   * blocks the event loop. The caller streams it and must call cleanup()
   * afterwards.
   */
  async snapshot(options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    const path = resolve(dirname(this.databasePath), `.${basename(this.databasePath)}.debug-${Date.now()}-${randomBytes(3).toString('hex')}.sqlite`);
    const cleanup = () => { for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(`${path}${suffix}`); } catch { /* already gone */ } } };
    try {
      // VACUUM INTO fills an existing empty file, so the copy is private from its first byte.
      writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
      const timeoutMs = options.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
      const result = await runNodeChild<{ bytes?: number; error?: string }>(SNAPSHOT_CHILD, {
        source: this.databasePath,
        target: path,
        privateTables: PRIVATE_TABLES,
        redacted: REDACTED,
        encryptedSecret: ENCRYPTED_SECRET.source,
      }, {
        timeoutMs,
        maxOutputBytes: 64 * 1024,
        signal: options.signal,
        errors: {
          timeout: () => new ServiceError(`The debug snapshot took longer than ${Math.round(timeoutMs / 1000)} s and was stopped`, 500),
          tooLarge: () => new ServiceError('The debug snapshot process answered with too much output', 500),
          noResult: () => new ServiceError('The debug snapshot process ended without a result (out of memory or disk?)', 500),
          aborted: () => new ServiceError('The debug snapshot was cancelled', 400),
        },
      });
      if (result.error) throw new ServiceError(`Could not write the debug snapshot: ${result.error}`, 500);
      try { chmodSync(path, 0o600); } catch { /* best-effort on non-POSIX filesystems */ }
      return { path, filename: `scout-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`, bytes: statSync(path).size, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
