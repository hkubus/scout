CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  included_terms TEXT NOT NULL DEFAULT '',
  excluded_terms TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'Polska',
  condition TEXT NOT NULL DEFAULT 'Any',
  sources_json TEXT NOT NULL,
  exact_urls_json TEXT NOT NULL DEFAULT '[]',
  interval_minutes INTEGER NOT NULL DEFAULT 5,
  sensitivity REAL NOT NULL DEFAULT 1,
  shipping_only INTEGER NOT NULL DEFAULT 0,
  ai_relevance INTEGER NOT NULL DEFAULT 1,
  min_price_pln REAL,
  max_price_pln REAL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_scan_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  price_pln REAL NOT NULL,
  typical_pln REAL,
  url TEXT NOT NULL,
  image_url TEXT,
  condition TEXT,
  location TEXT,
  shipping_available INTEGER,
  price_negotiable INTEGER,
  ai_normalization_json TEXT,
  ai_normalization_input_hash TEXT,
  ai_normalization_model TEXT,
  ai_normalization_at TEXT,
  ai_normalization_error TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (marketplace, listing_id)
);

CREATE TABLE IF NOT EXISTS listing_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  decision TEXT CHECK (decision IN ('buy', 'watch', 'pass') OR decision IS NULL),
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  UNIQUE (marketplace, listing_id)
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  price_pln REAL NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS listing_relevance (
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  relevant INTEGER NOT NULL CHECK (relevant IN (0, 1)),
  reason TEXT NOT NULL,
  error TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (watch_id, marketplace, listing_id)
);

CREATE TABLE IF NOT EXISTS connector_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  backoff_until TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL,
  sent_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (listing_key, channel)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marketplace_sessions (
  marketplace TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  storage_state_encrypted TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_used_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS seller_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  listing_title TEXT NOT NULL,
  listing_url TEXT NOT NULL,
  message TEXT NOT NULL,
  offer_price_pln REAL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS market_watches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  query TEXT NOT NULL,
  included_terms TEXT NOT NULL DEFAULT '',
  excluded_terms TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT 'Polska',
  condition TEXT NOT NULL DEFAULT 'Any',
  sources_json TEXT NOT NULL,
  interval_hours INTEGER NOT NULL DEFAULT 24,
  min_price_pln REAL,
  max_price_pln REAL,
  shipping_only INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_scan_at TEXT NOT NULL,
  last_scan_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_watch_id TEXT NOT NULL REFERENCES market_watches(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  first_price_pln REAL NOT NULL,
  last_price_pln REAL NOT NULL,
  lowest_price_pln REAL NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  missing_scans INTEGER NOT NULL DEFAULT 0,
  ended_at TEXT,
  UNIQUE (market_watch_id, marketplace, listing_id)
);

CREATE TABLE IF NOT EXISTS market_price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_listing_id INTEGER NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  price_pln REAL NOT NULL,
  observed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS observations_watch_time ON observations (watch_id, observed_at);
CREATE INDEX IF NOT EXISTS listing_relevance_watch ON listing_relevance (watch_id, relevant, checked_at);
CREATE INDEX IF NOT EXISTS listings_last_seen ON listings (last_seen_at);
CREATE INDEX IF NOT EXISTS listing_actions_key ON listing_actions (marketplace, listing_id);
CREATE INDEX IF NOT EXISTS seller_messages_created ON seller_messages (created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_listing ON notification_deliveries (listing_key);
CREATE INDEX IF NOT EXISTS market_watches_due ON market_watches (enabled, next_scan_at);
CREATE INDEX IF NOT EXISTS market_listings_watch_status ON market_listings (market_watch_id, status);
CREATE INDEX IF NOT EXISTS market_price_listing_time ON market_price_observations (market_listing_id, observed_at);
