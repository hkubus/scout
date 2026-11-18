// The improvement export (Settings → Data): one SQLite file with everything
// Scout has stored that could help improve it, such as listings, scores, AI
// verdicts, triage, scans, connector runs and alerts, plus the recent log and
// runtime state. A short-lived child process copies the live database with
// VACUUM INTO, empties or blanks what must not leave the server, adds three
// export_* tables that describe the file, and compacts it, so neither the
// copy nor the cleanup blocks the event loop. The route streams the file and
// then deletes it.
//
// Every table is classified in IMPROVEMENT_TABLES. A table missing from that
// list (say, from a newer migration) is emptied, so new data only leaves the
// server once someone has decided it may.
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { APP_LOG_MAX_ROWS } from './appLog';
import { EMBEDDED_SECRET, ENCRYPTED_SECRET, REDACTED, runNodeChild, runtimeEnvironment } from './debug';
import { ServiceError } from './service';
import type { ScoutService } from './service';

/** How a column is blanked: an empty blob (image bytes), an empty string, or the redaction marker. */
type Blank = { to: 'empty-blob' | 'empty-text' | 'redacted'; note: string };

export type TablePolicy = {
  /** What the table holds, in the export's own guide (export_tables.contents). */
  contents: string;
  /** yes: copied. private: copied unless the operator leaves private records out. no: emptied. */
  keep: 'yes' | 'private' | 'no';
  /** Columns replaced in every row. */
  blank?: Record<string, Blank>;
  /** Encrypted values and secret keys of the settings table are redacted. */
  settings?: boolean;
  /** Text columns in which the encrypted-secret shape is redacted wherever it appears. */
  redactSecrets?: string[];
};

const IMAGE_BYTES: Blank = { to: 'empty-blob', note: 'image bytes removed' };

export const IMPROVEMENT_TABLES: Record<string, TablePolicy> = {
  watches: { keep: 'yes', contents: 'Deal watches: query, include and exclude terms, marketplaces, price, condition and seller filters, variant groups, description checks, target price and minimum saving.' },
  watch_listings: { keep: 'yes', contents: 'Each listing a watch matched, with the typical price, discount, deviation, confidence, deal strength and alert-gate result (qualifies) from its latest scan.' },
  listings: { keep: 'yes', contents: 'Every listing Scout has seen: title, asking price, condition, location, seller, posted and refreshed times, availability, quick flags (flags_json) and the AI description check.' },
  observations: { keep: 'yes', contents: 'Asking-price history per listing and watch, with the baseline, discount and deal strength scored at each scan.' },
  listing_actions: { keep: 'yes', contents: 'Your triage of listings (decision, note, hidden): the closest thing to ground truth for deal scoring and relevance.' },
  listing_relevance: { keep: 'yes', contents: 'AI relevance verdicts on watch listings: relevant or not, reason, model, status and error.' },
  manual_relevance_cache: { keep: 'yes', contents: 'AI relevance verdicts from manual searches, by input hash and model.' },
  jev_shadow_log: { keep: 'yes', contents: 'Jev judgments logged beside the DeepSeek decision and the vision verdict, for agreement and calibration.' },
  jev_fuzzy_cache: { keep: 'yes', contents: 'Jev rescue decisions on near-miss term and condition matches.' },
  app_log: { keep: 'yes', redactSecrets: ['message'], contents: 'Warnings and errors from Scout\'s log kept across restarts (the last 30 days, at most 10,000 lines); an identical line within a minute is one row with a repeat count. export_logs merges them with the in-memory log.' },
  listing_detail_snapshots: { keep: 'yes', contents: 'Listing pages captured for the description check: description, condition, location, price and check status.' },
  listing_duplicate_pairs: { keep: 'yes', contents: 'Pairs of listings judged to be the same item posted more than once, with their similarity.' },
  scans: { keep: 'yes', contents: 'Every watch and research scan per marketplace: status, start, finish and error.' },
  connector_runs: { keep: 'yes', contents: 'Marketplace and notification connector runs: status, message, timing and backoff.' },
  notifications: { keep: 'yes', contents: 'Alerts Scout raised, with their payloads.' },
  notification_deliveries: { keep: 'yes', contents: 'Alert deliveries per channel: status, attempts and error.' },
  watch_listing_alert_state: { keep: 'yes', contents: 'The price and priority each listing last alerted at, per watch and channel.' },
  daily_digest_candidates: { keep: 'yes', contents: 'Deals queued for or sent in daily digests.' },
  market_watches: { keep: 'yes', contents: 'Research watches: query, filters, marketplaces and scan interval.' },
  market_watch_versions: { keep: 'yes', contents: 'The immutable criteria versions of each research watch.' },
  market_listings: { keep: 'yes', contents: 'Listings tracked by research watches: first, last and lowest asking price, status and availability.' },
  market_price_observations: { keep: 'yes', contents: 'Asking-price history of research listings, per scan.' },
  market_listing_snapshots: { keep: 'yes', contents: 'Research listing pages as captured: description, condition, location and price.' },
  market_listing_snapshot_images: { keep: 'yes', blank: { data: IMAGE_BYTES }, contents: 'Photos of captured research listings: source URL, type and size.' },
  marketplace_sessions: {
    keep: 'yes',
    blank: { storage_state_encrypted: { to: 'redacted', note: 'stored session redacted' }, label: { to: 'empty-text', note: 'label removed' } },
    contents: 'Whether each stored marketplace session was signed in at its last check, and its last error.',
  },
  settings: { keep: 'yes', settings: true, contents: 'Scout settings: scan intervals, alert priorities, daily digest, AI model, fee presets.' },
  migrations: { keep: 'yes', contents: 'Applied schema migrations.' },
  scheduler_leases: { keep: 'yes', contents: 'Which Scout process owns the scheduler.' },
  flips: { keep: 'private', contents: 'Your flip ledger: what you bought, where and for how much, and what it sold for after fees and costs. The real outcome of the deals Scout found.' },
  flip_photos: { keep: 'private', blank: { data: IMAGE_BYTES }, contents: 'Photo records of your flips: position, type and size.' },
  negotiation_outcomes: { keep: 'private', contents: 'How your negotiations ended: asking and agreed price, rounds and outcome.' },
  auth_sessions: { keep: 'no', contents: 'Sign-in sessions: token hashes, IP addresses and browsers.' },
  oauth_clients: { keep: 'no', contents: 'Apps connected over OAuth.' },
  oauth_codes: { keep: 'no', contents: 'OAuth authorization codes.' },
  connected_app_tokens: { keep: 'no', contents: 'Access tokens of connected apps.' },
};

// Setting keys whose values are credentials even if they were ever stored unencrypted.
const SECRET_SETTING_KEY = /(?:webhook|ntfy_config|api_key|token|secret|password)/i;
const BUILD_TIMEOUT_MS = 10 * 60_000;
// A download still open after this is stopped, so a stalled client cannot
// keep the copy on disk and block the next export.
const DOWNLOAD_MAX_OPEN_MS = 30 * 60_000;
export const IMPROVEMENT_EXPORT_FORMAT = 'scout-improvement-export/1';
const NOTE = 'Everything Scout stored that could help improve it, one table per kind of record; export_tables describes each table and how it was handled. '
  + 'Marketplace prices are asking prices, never completed sales. Credentials, marketplace sessions, sign-in sessions, connected apps and photo bytes are removed.';

// Runs in a child process (see runNodeChild). Copies the source read-only
// with VACUUM INTO, applies the policy inside one transaction, adds the
// export_* tables, then VACUUMs so emptied rows and blanked values leave no
// trace in free pages.
const BUILD_CHILD = `
const { DatabaseSync } = require('node:sqlite');
const { statSync } = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const job = JSON.parse(input);
  const out = (value) => process.stdout.write(JSON.stringify(value));
  const quote = (name) => '"' + String(name).replace(/"/g, '""') + '"';
  const blankValue = (blank) => blank.to === 'empty-blob' ? new Uint8Array(0) : blank.to === 'redacted' ? job.redacted : '';
  try {
    const source = new DatabaseSync(job.source, { readOnly: true });
    try {
      source.exec('PRAGMA busy_timeout = 5000');
      source.prepare('VACUUM INTO ?').run(job.target);
    } finally { source.close(); }
    const db = new DatabaseSync(job.target);
    try {
      db.exec('PRAGMA foreign_keys = OFF; PRAGMA busy_timeout = 5000;');
      const encrypted = new RegExp(job.encryptedSecret);
      const embedded = new RegExp(job.embeddedSecret, 'g');
      const secretKey = new RegExp(job.secretSettingKey, 'i');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row) => row.name);
      const guide = [];
      db.exec('BEGIN');
      for (const name of tables) {
        const policy = job.tables[name];
        let handling;
        if (!policy) {
          db.exec('DELETE FROM ' + quote(name));
          handling = 'emptied: not yet classified for this export';
        } else if (policy.keep === 'no') {
          db.exec('DELETE FROM ' + quote(name));
          handling = 'emptied: credentials or sign-in records';
        } else if (policy.keep === 'private' && !job.includePrivate) {
          db.exec('DELETE FROM ' + quote(name));
          handling = 'emptied: private records left out';
        } else {
          const notes = [];
          const columns = new Set(db.prepare('PRAGMA table_info(' + quote(name) + ')').all().map((column) => column.name));
          for (const [column, blank] of Object.entries(policy.blank || {})) {
            if (!columns.has(column)) continue;
            db.prepare('UPDATE ' + quote(name) + ' SET ' + quote(column) + ' = ?').run(blankValue(blank));
            notes.push(blank.note);
          }
          for (const column of policy.redactSecrets || []) {
            if (!columns.has(column)) continue;
            const update = db.prepare('UPDATE ' + quote(name) + ' SET ' + quote(column) + ' = ? WHERE rowid = ?');
            for (const row of db.prepare('SELECT rowid AS id, ' + quote(column) + ' AS value FROM ' + quote(name)).all()) {
              if (typeof row.value !== 'string') continue;
              const value = row.value.replace(embedded, job.redacted);
              if (value !== row.value) update.run(value, row.id);
            }
            notes.push('encrypted values redacted');
          }
          if (policy.settings) {
            const update = db.prepare('UPDATE ' + quote(name) + ' SET value = ? WHERE key = ?');
            for (const row of db.prepare('SELECT key, value FROM ' + quote(name)).all()) {
              if (typeof row.value !== 'string') continue;
              const value = secretKey.test(String(row.key)) || encrypted.test(row.value) ? job.redacted : row.value.replace(embedded, job.redacted);
              if (value !== row.value) update.run(value, row.key);
            }
            notes.push('credentials and encrypted values redacted');
          }
          handling = notes.length ? 'copied; ' + notes.join('; ') : 'copied';
        }
        guide.push({ name, contents: policy ? policy.contents : null, handling });
      }
      db.exec('CREATE TABLE export_info (key TEXT PRIMARY KEY, value TEXT)');
      const info = db.prepare('INSERT INTO export_info (key, value) VALUES (?, ?)');
      for (const [key, value] of Object.entries(job.info)) info.run(key, typeof value === 'string' ? value : JSON.stringify(value));
      // Oldest first. Buffer and stored ids are separate sequences, so rows are renumbered.
      db.exec('CREATE TABLE export_logs (id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, scope TEXT NOT NULL, message TEXT NOT NULL, source TEXT, repeats INTEGER)');
      const log = db.prepare('INSERT INTO export_logs (id, at, level, scope, message, source, repeats) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const logs = [...job.logs].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      logs.forEach((entry, index) => log.run(index + 1, entry.at, entry.level, entry.scope, String(entry.message).replace(embedded, job.redacted), entry.source ?? null, entry.repeats ?? null));
      db.exec('CREATE TABLE export_tables (name TEXT PRIMARY KEY, rows INTEGER NOT NULL, contents TEXT, handling TEXT NOT NULL)');
      const describe = db.prepare('INSERT INTO export_tables (name, rows, contents, handling) VALUES (?, ?, ?, ?)');
      for (const entry of guide) describe.run(entry.name, db.prepare('SELECT COUNT(*) AS count FROM ' + quote(entry.name)).get().count, entry.contents, entry.handling);
      db.exec('COMMIT');
      db.exec('VACUUM');
    } finally { db.close(); }
    out({ bytes: statSync(job.target).size });
  } catch (error) { out({ error: String(error && error.message || error) }); }
});
`;

type BuildResult = { bytes?: number; error?: string };

export type ImprovementContext = {
  /** Runtime facts stored as JSON in export_info. */
  info: Record<string, unknown>;
  logs: Array<{ id: number; at: string; level: string; scope: string; message: string; source?: 'memory' | 'stored'; repeats?: number }>;
};

/** The live state an export records beside the tables: readiness, settings, connectors, environment and the log (buffer plus stored warnings and errors). */
export function improvementContext(service: ScoutService): ImprovementContext {
  const settings = service.settings();
  return {
    info: {
      readiness: service.readiness(),
      // Session labels are the operator's own names for accounts, blanked in the table too.
      settings: { ...settings, marketplaceSessions: settings.marketplaceSessions.map(({ label: _label, ...session }) => session) },
      connectors: service.getConnectors(),
      runtime: runtimeEnvironment(),
    },
    logs: service.logHistory(APP_LOG_MAX_ROWS),
  };
}

let building = false;

/**
 * Build the improvement export of `db`'s file beside it. One export exists at
 * a time, from the start of its build until cleanup(), so two downloads never
 * hold two copies of the database. The caller streams `path` and must call
 * cleanup() afterwards.
 */
export async function buildImprovementExport(db: any, options: { includePrivate: boolean; context: ImprovementContext; signal?: AbortSignal; timeoutMs?: number }) {
  const main = (db.prepare('PRAGMA database_list').all() as Array<{ name: string; file: string }>).find((row) => row.name === 'main');
  if (!main?.file) throw new ServiceError('The improvement export needs a database file; this Scout runs on an in-memory database', 409);
  if (building) throw new ServiceError('An improvement export is already being prepared or downloaded; try again when it has finished', 409);
  building = true;
  const source = resolve(main.file);
  const now = new Date();
  const path = resolve(dirname(source), `.${basename(source)}.improvement-${now.getTime()}-${randomBytes(3).toString('hex')}.sqlite`);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const suffix of ['', '-journal', '-wal', '-shm']) { try { unlinkSync(`${path}${suffix}`); } catch { /* already gone */ } }
    building = false;
  };
  try {
    // VACUUM INTO fills an existing empty file, so the copy is private from its first byte.
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    const timeoutMs = options.timeoutMs ?? BUILD_TIMEOUT_MS;
    const result = await runNodeChild<BuildResult>(BUILD_CHILD, {
      source,
      target: path,
      includePrivate: options.includePrivate,
      tables: IMPROVEMENT_TABLES,
      redacted: REDACTED,
      encryptedSecret: ENCRYPTED_SECRET.source,
      embeddedSecret: EMBEDDED_SECRET.source,
      secretSettingKey: SECRET_SETTING_KEY.source,
      info: {
        format: IMPROVEMENT_EXPORT_FORMAT,
        exported_at: now.toISOString(),
        scout_version: process.env.SCOUT_VERSION ?? '1.0.0',
        includes_private: options.includePrivate,
        note: NOTE,
        source_database_bytes: statSync(source).size,
        ...options.context.info,
      },
      logs: options.context.logs,
    }, {
      timeoutMs,
      maxOutputBytes: 64 * 1024,
      signal: options.signal,
      errors: {
        timeout: () => new ServiceError(`The improvement export took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped`, 500),
        tooLarge: () => new ServiceError('The improvement export process answered with too much output', 500),
        noResult: () => new ServiceError('The improvement export process ended without a result (out of memory or disk?)', 500),
        aborted: () => new ServiceError('The improvement export was cancelled', 400),
      },
    });
    if (result.error) throw new ServiceError(`Could not build the improvement export: ${result.error}`, 500);
    return { path, filename: `scout-improvement-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`, bytes: Number(result.bytes), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/**
 * The built file as a stream that deletes it (and frees the next export) once
 * it closes: read to the end, destroyed by a client that left, or stopped
 * after maxOpenMs.
 */
export function improvementExportStream(file: { path: string; cleanup: () => void }, maxOpenMs = DOWNLOAD_MAX_OPEN_MS) {
  const stream = createReadStream(file.path);
  const timer = setTimeout(() => stream.destroy(new Error(`Improvement export download exceeded ${maxOpenMs} ms and was stopped`)), maxOpenMs);
  timer.unref?.();
  stream.once('close', () => { clearTimeout(timer); file.cleanup(); });
  return stream;
}
