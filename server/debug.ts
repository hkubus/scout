// Read-only debug access to the live database for development and agent
// troubleshooting. Browsing runs on a separate read-only SQLite connection;
// free-form SQL runs in a short-lived child process on its own read-only
// connection that is killed at a deadline, so a runaway query cannot block
// Scout's event loop. Encrypted credentials are redacted by shape wherever
// they appear.
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { ServiceError } from './service';
import type { ScoutService } from './service';

export const REDACTED = '[redacted: encrypted secret]';
// encryptSecret() output: base64url(12-byte iv).base64url(16-byte tag).base64url(ciphertext)
const ENCRYPTED_SECRET = /^[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+$/;
// The same shape anywhere inside a value, e.g. `' ' || value` in free-form SQL.
const EMBEDDED_SECRET = /[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]+/g;
const QUERY_TIMEOUT_MS = 5_000;
const QUERY_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const READ_STATEMENT = /^(?:select|with|values|explain|pragma)\b/i;
const QUERY_MAX_ROWS = 5000;
const TABLE_MAX_ROWS = 1000;
const SAFE_ENV_KEYS = [
  'NODE_ENV', 'PORT', 'SCOUT_HOST', 'TZ', 'SCOUT_DB_PATH', 'SCOUT_VERSION', 'SCOUT_CORS_ORIGIN',
  'SCOUT_OPENROUTER_MODEL', 'SCOUT_JEV_MODE', 'SCOUT_JEV_MODEL', 'SCOUT_VISION_MODEL', 'SCOUT_JEV_CONCURRENCY',
  'SCOUT_CHROMIUM_PATH', 'SCOUT_DIST_PATH', 'SCOUT_SEED_DEMO', 'SCOUT_SKIP_MIGRATION_BACKUP',
];
const SECRET_ENV_KEYS = ['SCOUT_SECRET', 'SCOUT_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY'];

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

/**
 * The operator's private bookkeeping (the flip ledger) is not debugging data:
 * it is left out of the table list, refused in read-only SQL, and emptied in
 * snapshots. Export it through the authenticated /api/export instead.
 */
const PRIVATE_TABLES = ['flips', 'flip_photos'];
const PRIVATE_TABLE_PATTERN = new RegExp(`\\b(?:${PRIVATE_TABLES.join('|')})\\b`, 'i');

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

// Runs in a child process: opens its own read-only connection, blanks the
// encrypted marketplace session column via the authorizer (where supported),
// runs one statement, and prints rows as JSON with blobs and bigints made safe.
const QUERY_CHILD = `
const { DatabaseSync, constants } = require('node:sqlite');
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
      db.setAuthorizer((action, table, column) => (action === constants.SQLITE_READ && (table === 'flips' || table === 'flip_photos') ? constants.SQLITE_DENY
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
  return new Promise((resolvePromise, reject) => {
    // Keep flags such as --experimental-sqlite that node:sqlite needs on older Node 22.
    const flags = process.execArgv.filter((flag) => flag.startsWith('--experimental'));
    const child = spawn(process.execPath, [...flags, '--no-warnings', '--max-old-space-size=256', '-e', QUERY_CHILD], { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH ?? '' } });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    const kill = (error: Error) => { if (!failure) { failure = error; child.kill('SIGKILL'); } };
    const timer = setTimeout(() => kill(new ServiceError(`Query exceeded the ${timeoutMs} ms debug time limit and was stopped`, 400)), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > QUERY_MAX_OUTPUT_BYTES) kill(new ServiceError('Query result is too large; select fewer columns or rows', 400));
      else chunks.push(chunk);
    });
    child.stderr.resume();
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', () => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      try { resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')) as QueryChildResult); } catch { reject(new ServiceError('Query process ended without a result (out of memory?)', 400)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

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
    if (PRIVATE_TABLE_PATTERN.test(statementText)) throw new ServiceError('The flip ledger is private and not available through the debug API', 403);
    const limit = Math.min(Math.max(1, Math.trunc(maxRows)), QUERY_MAX_ROWS);
    const started = performance.now();
    const result = await runQueryChild({ path: this.databasePath, sql: statementText, params, maxRows: limit }, this.queryTimeoutMs);
    if (result.error) throw new ServiceError(result.error === 'sql' ? `SQL error: ${result.message}` : `Could not open the database: ${result.message}`, 400);
    const rows = (result.rows ?? []).map(debugRow);
    return { columns: result.columns ?? [], rows, rowCount: rows.length, truncated: Boolean(result.truncated), maxRows: limit, elapsedMs: Math.round((performance.now() - started) * 10) / 10 };
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
        for (const table of PRIVATE_TABLES) if (hasTable(table)) copy.exec(`DELETE FROM ${quoteIdent(table)}`);
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
