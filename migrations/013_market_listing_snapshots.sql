-- Preserved copies of research listings (description + downloaded images) so a
-- listing remains reviewable after the marketplace page disappears.

ALTER TABLE market_listings ADD COLUMN snapshot_status TEXT;
ALTER TABLE market_listings ADD COLUMN snapshot_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_listings ADD COLUMN snapshot_at TEXT;

CREATE TABLE IF NOT EXISTS market_listing_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_listing_id INTEGER NOT NULL REFERENCES market_listings(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  external_listing_id TEXT NOT NULL,
  title TEXT NOT NULL,
  price_pln REAL NOT NULL,
  url TEXT NOT NULL,
  condition TEXT,
  location TEXT,
  description TEXT,
  state_hash TEXT NOT NULL,
  image_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'auto',
  captured_at TEXT NOT NULL,
  UNIQUE (market_listing_id, state_hash)
);

CREATE INDEX IF NOT EXISTS market_listing_snapshots_latest
  ON market_listing_snapshots (market_listing_id, captured_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS market_listing_snapshot_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES market_listing_snapshots(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  data BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS market_listing_snapshot_images_by_snapshot
  ON market_listing_snapshot_images (snapshot_id, position, id);
