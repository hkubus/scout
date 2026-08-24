-- Durable daily deal digests. Candidates stay independent from delivery rows so
-- one digest can be retried without re-running or re-scoring marketplace scans.

CREATE TABLE IF NOT EXISTS daily_digest_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  image_url TEXT,
  price_pln REAL NOT NULL,
  typical_pln REAL NOT NULL,
  discount_percent REAL NOT NULL,
  confidence INTEGER NOT NULL,
  priority TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  digest_date TEXT,
  UNIQUE (watch_id, marketplace, listing_id, sequence)
);

CREATE INDEX IF NOT EXISTS daily_digest_candidates_pending
  ON daily_digest_candidates (digest_date, observed_at, priority);

CREATE INDEX IF NOT EXISTS daily_digest_candidates_listing
  ON daily_digest_candidates (watch_id, marketplace, listing_id, sequence);
