-- Durable, deduplicated detail-page state for high-priority watched deals.

CREATE TABLE IF NOT EXISTS listing_detail_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_pln REAL NOT NULL,
  url TEXT NOT NULL,
  condition TEXT,
  location TEXT,
  description TEXT,
  state_hash TEXT NOT NULL,
  verification_input_hash TEXT,
  verification_status TEXT,
  captured_at TEXT NOT NULL,
  UNIQUE (listing_id, state_hash)
);

CREATE INDEX IF NOT EXISTS listing_detail_snapshots_latest
  ON listing_detail_snapshots (listing_id, captured_at DESC, id DESC);
