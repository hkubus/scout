-- Correctness release: keep 001_init compatible and put all new schema work
-- behind the numbered migration runner.

ALTER TABLE watches ADD COLUMN archived_at TEXT;

ALTER TABLE listings ADD COLUMN availability_status TEXT;
ALTER TABLE listings ADD COLUMN ended_reason TEXT;
ALTER TABLE listings ADD COLUMN last_verified_at TEXT;

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL,
  watch_kind TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT
);

ALTER TABLE observations ADD COLUMN watch_listing_id INTEGER;
ALTER TABLE observations ADD COLUMN scan_id INTEGER;
ALTER TABLE observations ADD COLUMN baseline_pln REAL;
ALTER TABLE observations ADD COLUMN discount_percent REAL;
ALTER TABLE observations ADD COLUMN deal_strength INTEGER;
ALTER TABLE observations ADD COLUMN deal_label TEXT;

ALTER TABLE listing_relevance ADD COLUMN relevance_status TEXT NOT NULL DEFAULT 'relevant';

ALTER TABLE notification_deliveries ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD COLUMN next_attempt_at TEXT;
ALTER TABLE notification_deliveries ADD COLUMN updated_at TEXT;

CREATE TABLE IF NOT EXISTS watch_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  typical_pln REAL,
  deal_strength INTEGER,
  deal_label TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (watch_id, listing_id)
);

INSERT OR IGNORE INTO watch_listings (watch_id, listing_id, typical_pln, first_seen_at, last_seen_at)
SELECT o.watch_id, o.listing_id, NULL, MIN(o.observed_at), MAX(o.observed_at)
FROM observations o
JOIN listings l ON l.id = o.listing_id
GROUP BY o.watch_id, o.listing_id;

UPDATE observations
SET watch_listing_id = (
  SELECT wl.id FROM watch_listings wl
  WHERE wl.watch_id = observations.watch_id AND wl.listing_id = observations.listing_id
)
WHERE watch_listing_id IS NULL;

CREATE TRIGGER IF NOT EXISTS observations_create_watch_listing
AFTER INSERT ON observations
WHEN NOT EXISTS (SELECT 1 FROM watch_listings WHERE watch_id = NEW.watch_id AND listing_id = NEW.listing_id)
BEGIN
  INSERT INTO watch_listings (watch_id, listing_id, first_seen_at, last_seen_at)
  VALUES (NEW.watch_id, NEW.listing_id, NEW.observed_at, NEW.observed_at);
END;

CREATE TRIGGER IF NOT EXISTS observations_link_watch_listing
AFTER INSERT ON observations
BEGIN
  UPDATE observations SET watch_listing_id = (
    SELECT id FROM watch_listings WHERE watch_id = NEW.watch_id AND listing_id = NEW.listing_id
  ) WHERE id = NEW.id AND watch_listing_id IS NULL;
  UPDATE watch_listings SET first_seen_at = MIN(first_seen_at, NEW.observed_at), last_seen_at = MAX(last_seen_at, NEW.observed_at)
  WHERE watch_id = NEW.watch_id AND listing_id = NEW.listing_id;
END;

UPDATE listing_relevance
SET relevance_status = CASE
  WHEN error IS NOT NULL THEN 'unknown'
  WHEN relevant = 0 THEN 'irrelevant'
  ELSE 'relevant'
END
WHERE relevance_status = 'relevant';

ALTER TABLE market_watches ADD COLUMN active_version_id TEXT;

CREATE TABLE IF NOT EXISTS market_watch_versions (
  id TEXT PRIMARY KEY,
  market_watch_id TEXT NOT NULL REFERENCES market_watches(id) ON DELETE CASCADE,
  query TEXT NOT NULL,
  included_terms TEXT NOT NULL,
  excluded_terms TEXT NOT NULL,
  location TEXT NOT NULL,
  condition TEXT NOT NULL,
  sources_json TEXT NOT NULL,
  min_price_pln REAL,
  max_price_pln REAL,
  shipping_only INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

INSERT OR IGNORE INTO market_watch_versions (
  id, market_watch_id, query, included_terms, excluded_terms, location, condition,
  sources_json, min_price_pln, max_price_pln, shipping_only, created_at, closed_at
)
SELECT id || ':v1', id, query, included_terms, excluded_terms, location, condition,
  sources_json, min_price_pln, max_price_pln, shipping_only, created_at, NULL
FROM market_watches;

UPDATE market_watches
SET active_version_id = id || ':v1'
WHERE active_version_id IS NULL;

-- The original table made the watch/listing key unique without the research
-- definition. Rebuild it so a listing can legitimately belong to two
-- immutable research series for the same watch.
PRAGMA foreign_keys = OFF;
CREATE TABLE market_listings_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  market_watch_id TEXT NOT NULL REFERENCES market_watches(id) ON DELETE CASCADE,
  version_id TEXT REFERENCES market_watch_versions(id) ON DELETE CASCADE,
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
  availability_status TEXT,
  ended_reason TEXT,
  last_verified_at TEXT,
  UNIQUE (market_watch_id, version_id, marketplace, listing_id)
);

INSERT INTO market_listings_v2 (
  id, market_watch_id, version_id, marketplace, listing_id, title, url, image_url,
  first_price_pln, last_price_pln, lowest_price_pln, first_seen_at, last_seen_at,
  status, missing_scans, ended_at, availability_status, ended_reason, last_verified_at
)
SELECT ml.id, ml.market_watch_id, COALESCE(mw.active_version_id, mw.id || ':v1'),
  ml.marketplace, ml.listing_id, ml.title, ml.url, ml.image_url,
  ml.first_price_pln, ml.last_price_pln, ml.lowest_price_pln, ml.first_seen_at,
  ml.last_seen_at, ml.status, ml.missing_scans, ml.ended_at, NULL, NULL, NULL
FROM market_listings ml
JOIN market_watches mw ON mw.id = ml.market_watch_id;

DROP TABLE market_listings;
ALTER TABLE market_listings_v2 RENAME TO market_listings;
PRAGMA foreign_keys = ON;

ALTER TABLE market_price_observations ADD COLUMN version_id TEXT;
ALTER TABLE market_price_observations ADD COLUMN scan_id INTEGER;
UPDATE market_price_observations
SET version_id = (
  SELECT ml.version_id FROM market_listings ml
  WHERE ml.id = market_price_observations.market_listing_id
)
WHERE version_id IS NULL;

-- Older releases treated three search absences as an ended listing. Those
-- rows have no detail-page evidence, so keep their price history but return
-- them to a verifiable state instead of presenting an unproven disappearance
-- as a terminal result.
UPDATE market_listings
SET status = 'active', missing_scans = 0, ended_at = NULL,
  availability_status = 'unknown', ended_reason = 'Historical search-only status requires detail verification', last_verified_at = NULL
WHERE status = 'ended' AND availability_status IS NULL;

CREATE TABLE IF NOT EXISTS watch_listing_alert_state (
  watch_id TEXT NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  last_alerted_price_pln REAL NOT NULL,
  last_priority TEXT NOT NULL,
  alert_sequence INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (watch_id, marketplace, listing_id, channel)
);

CREATE INDEX IF NOT EXISTS watch_listings_watch ON watch_listings (watch_id, last_seen_at);
CREATE INDEX IF NOT EXISTS scans_watch_status ON scans (watch_id, status, started_at);
CREATE INDEX IF NOT EXISTS observations_scan ON observations (scan_id);
CREATE INDEX IF NOT EXISTS market_price_observations_scan ON market_price_observations (scan_id);
CREATE INDEX IF NOT EXISTS market_listings_version_status ON market_listings (market_watch_id, version_id, status);
CREATE INDEX IF NOT EXISTS market_watch_versions_watch ON market_watch_versions (market_watch_id, created_at);
CREATE INDEX IF NOT EXISTS notification_deliveries_retry ON notification_deliveries (status, next_attempt_at, updated_at);
