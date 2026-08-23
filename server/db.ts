// Node 22+ exposes the small synchronous SQLite API used here. Keeping the
// database boundary synchronous makes each scheduler tick atomic and easy to
// resume after a home-server restart.
// @ts-ignore node:sqlite is present in the supported Node 22+ runtime.
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openDatabase(databasePath = process.env.SCOUT_DB_PATH ?? './data/scout.sqlite') {
  const absolutePath = resolve(databasePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const db = new DatabaseSync(absolutePath);
  const migration = resolve(process.cwd(), 'migrations/001_init.sql');
  if (existsSync(migration)) db.exec(readFileSync(migration, 'utf8'));
  db.prepare('INSERT OR IGNORE INTO migrations (id, applied_at) VALUES (?, ?)').run('001_init', new Date().toISOString());
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`CREATE TABLE IF NOT EXISTS marketplace_sessions (
    marketplace TEXT PRIMARY KEY,
    label TEXT NOT NULL DEFAULT '',
    storage_state_encrypted TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_used_at TEXT,
    last_error TEXT
  )`);
  const watchColumns = new Set((db.prepare('PRAGMA table_info(watches)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!watchColumns.has('shipping_only')) db.exec('ALTER TABLE watches ADD COLUMN shipping_only INTEGER NOT NULL DEFAULT 0');
  if (!watchColumns.has('min_price_pln')) db.exec('ALTER TABLE watches ADD COLUMN min_price_pln REAL');
  if (!watchColumns.has('max_price_pln')) db.exec('ALTER TABLE watches ADD COLUMN max_price_pln REAL');
  const listingColumns = new Set((db.prepare('PRAGMA table_info(listings)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!listingColumns.has('shipping_available')) db.exec('ALTER TABLE listings ADD COLUMN shipping_available INTEGER');
  const marketWatchColumns = new Set((db.prepare('PRAGMA table_info(market_watches)').all() as Array<{ name: string }>).map((column) => column.name));
  if (!marketWatchColumns.has('included_terms')) db.exec("ALTER TABLE market_watches ADD COLUMN included_terms TEXT NOT NULL DEFAULT ''");
  if (!marketWatchColumns.has('excluded_terms')) db.exec("ALTER TABLE market_watches ADD COLUMN excluded_terms TEXT NOT NULL DEFAULT ''");
  if (!marketWatchColumns.has('location')) db.exec("ALTER TABLE market_watches ADD COLUMN location TEXT NOT NULL DEFAULT 'Polska'");
  if (!marketWatchColumns.has('condition')) db.exec("ALTER TABLE market_watches ADD COLUMN condition TEXT NOT NULL DEFAULT 'Any'");
  if (!marketWatchColumns.has('min_price_pln')) db.exec('ALTER TABLE market_watches ADD COLUMN min_price_pln REAL');
  if (!marketWatchColumns.has('max_price_pln')) db.exec('ALTER TABLE market_watches ADD COLUMN max_price_pln REAL');
  if (!marketWatchColumns.has('shipping_only')) db.exec('ALTER TABLE market_watches ADD COLUMN shipping_only INTEGER NOT NULL DEFAULT 0');
  db.prepare('INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('default_interval', '5', new Date().toISOString());
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
