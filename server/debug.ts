// Read-only debug access to the live database for development and agent
// troubleshooting. Queries run on a separate read-only SQLite connection
// (query_only as well), so nothing reachable from here can modify Scout's
// data. Encrypted credentials are redacted by shape wherever they appear.
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { ServiceError } from './service';
import type { ScoutService } from './service';

export const REDACTED = '[redacted: encrypted secret]';
// encryptSecret() output: base64url(12-byte iv).base64url(16-byte tag).base64url(ciphertext)
const ENCRYPTED_SECRET = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;
const READ_STATEMENT = /^(?:select|with|values|explain|pragma)\b/i;
const QUERY_MAX_ROWS = 5000;
const TABLE_MAX_ROWS = 1000;
const SAFE_ENV_KEYS = [
  'NODE_ENV', 'PORT', 'SCOUT_HOST', 'TZ', 'SCOUT_DB_PATH', 'SCOUT_VERSION', 'SCOUT_CORS_ORIGIN',
  'SCOUT_OPENROUTER_MODEL', 'SCOUT_JEV_MODE', 'SCOUT_JEV_MODEL', 'SCOUT_VISION_MODEL', 'SCOUT_JEV_CONCURRENCY',
  'SCOUT_BROWSER_WS', 'SCOUT_CHROMIUM_PATH', 'SCOUT_DIST_PATH', 'SCOUT_SEED_DEMO', 'SCOUT_SKIP_MIGRATION_BACKUP',
];
const SECRET_ENV_KEYS = ['SCOUT_SECRET', 'SCOUT_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'];

export function debugApiEnabled() {
  return process.env.SCOUT_DEBUG_API?.trim().toLowerCase() !== 'false';
}

/** JSON-safe, secret-free copy of a SQLite value. */
export function debugValue(value: unknown): unknown {
  if (typeof value === 'string') return ENCRYPTED_SECRET.test(value) ? REDACTED : value;
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

function sqliteMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

export class ScoutDebug {
  private readonlyDb: any = null;
  readonly databasePath: string;

  constructor(private readonly db: any, private readonly service: ScoutService, databasePath = process.env.SCOUT_DB_PATH ?? './data/scout.sqlite') {
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
    return (this.reader().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
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

  /** Run one read-only statement (SELECT/WITH/VALUES/EXPLAIN/PRAGMA) with positional or named params. */
  query(sql: string, params: unknown[] | Record<string, unknown> = [], maxRows = 500) {
    const statementText = stripLeadingComments(sql);
    if (!READ_STATEMENT.test(statementText)) throw new ServiceError('Only SELECT, WITH, VALUES, EXPLAIN, and PRAGMA statements are allowed', 400);
    const limit = Math.min(Math.max(1, Math.trunc(maxRows)), QUERY_MAX_ROWS);
    const started = performance.now();
    let statement: any;
    try {
      statement = this.reader().prepare(statementText);
    } catch (error) {
      throw new ServiceError(`SQL error: ${sqliteMessage(error)}`, 400);
    }
    const bound = Array.isArray(params) ? params : [params];
    const rows: Array<Record<string, unknown>> = [];
    let truncated = false;
    try {
      for (const row of statement.iterate(...bound)) {
        if (rows.length >= limit) { truncated = true; break; }
        rows.push(debugRow(row));
      }
    } catch (error) {
      throw new ServiceError(`SQL error: ${sqliteMessage(error)}`, 400);
    }
    let columns: string[];
    try {
      columns = (statement.columns() as Array<{ name: string }>).map((column) => column.name);
    } catch {
      columns = rows[0] ? Object.keys(rows[0]) : [];
    }
    return { columns, rows, rowCount: rows.length, truncated, maxRows: limit, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
  }

  /** Process, configuration, readiness, and the in-memory log buffer. */
  runtime() {
    const env: Record<string, string | null> = {};
    for (const key of SAFE_ENV_KEYS) env[key] = process.env[key] ?? null;
    const secrets: Record<string, boolean> = {};
    for (const key of SECRET_ENV_KEYS) secrets[key] = Boolean(process.env[key]?.trim());
    return {
      now: new Date().toISOString(),
      pid: process.pid,
      uptimeSeconds: Math.round(process.uptime()),
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      memory: process.memoryUsage(),
      env,
      secretsConfigured: secrets,
      readiness: this.service.readiness(),
      settings: this.service.settings(),
      logs: this.service.logs(),
    };
  }

  /**
   * Write a consistent copy of the whole database with stored credentials
   * blanked. The caller streams it and must call cleanup() afterwards.
   */
  snapshot() {
    const path = resolve(dirname(this.databasePath), `.${basename(this.databasePath)}.debug-${Date.now()}-${randomBytes(3).toString('hex')}.sqlite`);
    const cleanup = () => { for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(`${path}${suffix}`); } catch { /* already gone */ } } };
    try {
      this.db.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
      try { chmodSync(path, 0o600); } catch { /* best-effort on non-POSIX filesystems */ }
      const copy = new DatabaseSync(path);
      try {
        const hasTable = (name: string) => Boolean(copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
        if (hasTable('settings')) {
          const rows = copy.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: unknown }>;
          const update = copy.prepare('UPDATE settings SET value = ? WHERE key = ?');
          for (const row of rows) if (typeof row.value === 'string' && ENCRYPTED_SECRET.test(row.value)) update.run(REDACTED, row.key);
        }
        if (hasTable('marketplace_sessions')) copy.prepare('UPDATE marketplace_sessions SET storage_state_encrypted = ?').run(REDACTED);
        copy.exec('VACUUM');
      } finally {
        copy.close();
      }
      return { path, filename: `scout-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`, bytes: statSync(path).size, cleanup };
    } catch (error) {
      cleanup();
      throw error;
    }
  }
}
