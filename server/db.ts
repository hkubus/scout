// Node 22+ exposes the small synchronous SQLite API used here. Keeping the
// database boundary synchronous makes each scheduler tick atomic and easy to
// resume after a home-server restart.
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

function prunePreMigrationBackups(absolutePath: string, keep = 5) {
  try {
    const dir = dirname(absolutePath);
    const base = absolutePath.split('/').at(-1) ?? '';
    if (!existsSync(dir) || !base) return;
    const stale = readdirSync(dir)
      .filter((file) => file.startsWith(`${base}.pre-`) && file.endsWith('.sqlite'))
      .map((file) => {
        const match = file.match(/\.pre-[^-]+-(\d+)-/);
        return { file, time: match ? Number(match[1]) : 0 };
      })
      .sort((a, b) => b.time - a.time);
    for (const entry of stale.slice(keep)) {
      try { unlinkSync(resolve(dir, entry.file)); } catch { /* best-effort */ }
    }
  } catch { /* pruning is best-effort */ }
}

export function openDatabase(databasePath = process.env.SCOUT_DB_PATH ?? './data/scout.sqlite') {
  try { process.umask(0o077); } catch { /* permissions are best-effort on non-POSIX runtimes */ }
  const absolutePath = resolve(databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  try { chmodSync(dirname(absolutePath), 0o700); } catch { /* permissions are best-effort on non-POSIX filesystems */ }
  const db = new DatabaseSync(absolutePath);
  try { db.exec('PRAGMA busy_timeout = 5000;'); } catch { /* best-effort for concurrent writers */ }
  try { chmodSync(absolutePath, 0o600); } catch { /* permissions are best-effort on non-POSIX filesystems */ }
  const candidateMigrationDirs = [resolve(process.cwd(), 'migrations'), resolve(new URL('.', import.meta.url).pathname, '../migrations')];
  const migrationDirectory = candidateMigrationDirs.find((dir) => existsSync(dir)) ?? resolve(process.cwd(), 'migrations');
  const migrationFiles = existsSync(migrationDirectory)
    ? readdirSync(migrationDirectory)
      .filter((file) => file.endsWith('.sql'))
      .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    : [];

  // Older Scout databases already contain the migrations table and a row for
  // 001_init. New databases get the same row as part of the first migration.
  // Keep each file atomic so a failed upgrade can be retried safely.
  db.exec('PRAGMA foreign_keys = OFF;');
  const ensureLegacyColumns = () => {
    const hasTable = (name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
    if (hasTable('watches')) {
      const columns = new Set((db.prepare('PRAGMA table_info(watches)').all() as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has('shipping_only')) db.exec('ALTER TABLE watches ADD COLUMN shipping_only INTEGER NOT NULL DEFAULT 0');
      if (!columns.has('ai_relevance')) db.exec('ALTER TABLE watches ADD COLUMN ai_relevance INTEGER NOT NULL DEFAULT 1');
      if (!columns.has('min_price_pln')) db.exec('ALTER TABLE watches ADD COLUMN min_price_pln REAL');
      if (!columns.has('max_price_pln')) db.exec('ALTER TABLE watches ADD COLUMN max_price_pln REAL');
    }
    if (hasTable('listings')) {
      const columns = new Set((db.prepare('PRAGMA table_info(listings)').all() as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has('shipping_available')) db.exec('ALTER TABLE listings ADD COLUMN shipping_available INTEGER');
      if (!columns.has('price_negotiable')) db.exec('ALTER TABLE listings ADD COLUMN price_negotiable INTEGER');
    }
    if (hasTable('market_watches')) {
      const columns = new Set((db.prepare('PRAGMA table_info(market_watches)').all() as Array<{ name: string }>).map((column) => column.name));
      if (!columns.has('included_terms')) db.exec("ALTER TABLE market_watches ADD COLUMN included_terms TEXT NOT NULL DEFAULT ''");
      if (!columns.has('excluded_terms')) db.exec("ALTER TABLE market_watches ADD COLUMN excluded_terms TEXT NOT NULL DEFAULT ''");
      if (!columns.has('location')) db.exec("ALTER TABLE market_watches ADD COLUMN location TEXT NOT NULL DEFAULT 'Polska'");
      if (!columns.has('condition')) db.exec("ALTER TABLE market_watches ADD COLUMN condition TEXT NOT NULL DEFAULT 'Any'");
      if (!columns.has('min_price_pln')) db.exec('ALTER TABLE market_watches ADD COLUMN min_price_pln REAL');
      if (!columns.has('max_price_pln')) db.exec('ALTER TABLE market_watches ADD COLUMN max_price_pln REAL');
      if (!columns.has('shipping_only')) db.exec('ALTER TABLE market_watches ADD COLUMN shipping_only INTEGER NOT NULL DEFAULT 0');
    }
  };
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migrations'").get()) {
    ensureLegacyColumns();
    const migrationColumns = new Set((db.prepare('PRAGMA table_info(migrations)').all() as Array<{ name: string }>).map((column) => column.name));
    if (!migrationColumns.has('checksum')) db.exec('ALTER TABLE migrations ADD COLUMN checksum TEXT');
  }
  for (const file of migrationFiles) {
    const id = file.replace(/\.sql$/i, '');
    const migrationPath = resolve(migrationDirectory, file);
    const checksum = createHash('sha256').update(readFileSync(migrationPath)).digest('hex');
    const applied = db.prepare('SELECT 1 AS applied FROM sqlite_master WHERE type = \'table\' AND name = \'migrations\'').get() as { applied?: number } | undefined;
    if (applied?.applied !== 1) {
      if (id !== '001_init') continue;
    } else {
      const existing = db.prepare('SELECT checksum FROM migrations WHERE id = ?').get(id) as { checksum?: string | null } | undefined;
      if (existing) {
        if (existing.checksum && existing.checksum !== checksum) throw new Error(`Migration checksum mismatch for ${id}`);
        if (!existing.checksum) db.prepare('UPDATE migrations SET checksum = ? WHERE id = ?').run(checksum, id);
        continue;
      }
    }

    prunePreMigrationBackups(absolutePath);
    if (existsSync(absolutePath) && process.env.SCOUT_SKIP_MIGRATION_BACKUP !== 'true') {
      const backupPath = `${absolutePath}.pre-${id}-${Date.now()}-${randomBytes(3).toString('hex')}.sqlite`;
      const escapedBackupPath = backupPath.replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escapedBackupPath}'`);
      try { chmodSync(backupPath, 0o600); } catch { /* permissions are best-effort on non-POSIX filesystems */ }
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(readFileSync(migrationPath, 'utf8'));
      db.prepare('CREATE TABLE IF NOT EXISTS migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)').run();
      const migrationColumns = new Set((db.prepare('PRAGMA table_info(migrations)').all() as Array<{ name: string }>).map((column) => column.name));
      if (!migrationColumns.has('checksum')) db.exec('ALTER TABLE migrations ADD COLUMN checksum TEXT');
      db.prepare('INSERT OR IGNORE INTO migrations (id, applied_at, checksum) VALUES (?, ?, ?)').run(id, new Date().toISOString(), checksum);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve the original migration error */ }
      db.exec('PRAGMA foreign_keys = ON;');
      throw error;
    }
  }
  // WAL pairs with synchronous=NORMAL: commits skip the fsync (only an OS or
  // power failure can lose the last commits, which is acceptable for this
  // data) while crash-safe durability for the process is retained. The write
  // path performs many small per-row commits, so this removes most fsync
  // traffic. The extra page cache and mmap window are modest wins for a
  // dedicated Scout process.
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA cache_size = -16000; PRAGMA mmap_size = 268435456;');
  try { chmodSync(`${absolutePath}-wal`, 0o600); chmodSync(`${absolutePath}-shm`, 0o600); } catch { /* files may not exist until the first write */ }
  db.exec(`CREATE TABLE IF NOT EXISTS marketplace_sessions (
    marketplace TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    storage_state_encrypted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    last_error TEXT
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT,
    sent_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (listing_key, channel)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS scheduler_leases (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    owner_id TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  // Post-migration safety net: the ensure block above runs only when the
  // migrations table already existed, and the migrations themselves no longer
  // carry these columns for every path — re-check once for every database.
  ensureLegacyColumns();
  db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('default_interval', '5', new Date().toISOString());
  db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('night_interval', '30', new Date().toISOString());
  if (db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'scans'").get()) {
    db.prepare("UPDATE scans SET status = 'interrupted', completed_at = ?, error = COALESCE(error, 'Process restarted before scan completed') WHERE status = 'running'").run(new Date().toISOString());
  }
  return db;
}

export function seedDatabase(db: any, seed: { watches: Array<any>; listings: Array<any> }) {
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT COUNT(*) AS count FROM watches').get() as { count: number };
  if (Number(existing.count) > 0) return;
  const watchStmt = db.prepare(`INSERT INTO watches (id, name, query, included_terms, excluded_terms, location, condition, sources_json, exact_urls_json, interval_minutes, sensitivity, shipping_only, min_price_pln, max_price_pln, enabled, next_scan_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const watch of seed.watches) watchStmt.run(watch.id, watch.name, watch.query, watch.terms ?? '', watch.excluded ?? '', watch.location ?? 'Polska', watch.condition ?? 'Any', JSON.stringify(watch.sources ?? []), JSON.stringify(watch.exactUrls ?? []), watch.interval ?? 5, watch.sensitivity ?? 1, watch.shippingOnly ? 1 : 0, watch.minPrice ?? null, watch.maxPrice ?? null, watch.enabled ? 1 : 0, now, now, now);
  const listingStmt = db.prepare(`INSERT INTO listings (marketplace, listing_id, title, subtitle, price_pln, typical_pln, url, image_url, condition, location, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const listing of seed.listings) listingStmt.run(listing.marketplace, listing.id, listing.title, listing.subtitle ?? '', listing.price, listing.typical, listing.url, listing.image, listing.condition ?? '', listing.location ?? '', now, now);
}

export function backupDatabase(db: any, databasePath = process.env.SCOUT_DB_PATH ?? './data/scout.sqlite', keep = 10) {
  const absolutePath = resolve(databasePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${absolutePath}.${stamp}-${randomBytes(3).toString('hex')}.backup.sqlite`;
  const escapedPath = backupPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escapedPath}'`);
  try { chmodSync(backupPath, 0o600); } catch { /* permissions are best-effort on non-POSIX filesystems */ }
  pruneBackups(absolutePath, keep);
  return backupPath;
}

/** Keep the newest timestamped `<db>.<stamp>.backup.sqlite` copies so repeated backups cannot fill the disk. */
function pruneBackups(absolutePath: string, keep: number) {
  try {
    const dir = dirname(absolutePath);
    const base = absolutePath.split('/').at(-1) ?? '';
    const backups = readdirSync(dir)
      .filter((file) => file.startsWith(`${base}.`) && file.endsWith('.backup.sqlite'))
      .sort()
      .reverse();
    for (const stale of backups.slice(keep)) {
      try { unlinkSync(resolve(dir, stale)); } catch { /* best-effort */ }
    }
  } catch { /* pruning is best-effort */ }
}
