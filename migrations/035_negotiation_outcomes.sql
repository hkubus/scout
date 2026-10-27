-- How the operator's negotiations ended, recorded by Hatbot through
-- scout_record_outcome: the asking price, the final price and the outcome.
-- These are real agreed prices, unlike every other price in Scout, so like
-- the flip ledger they never feed baselines, bands or alerts, are never
-- pruned by retention, and are hidden from the debug API. negotiation_id is
-- Hatbot's own id: recording it again updates the same row. watch_id is the
-- watch the listing was placed in when the outcome was recorded.
CREATE TABLE IF NOT EXISTS negotiation_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  negotiation_id TEXT NOT NULL UNIQUE,
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  watch_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('buy', 'sell')),
  outcome TEXT NOT NULL CHECK (outcome IN ('agreed', 'lost', 'abandoned', 'expired')),
  asking_price_pln REAL NOT NULL,
  final_price_pln REAL,
  rounds INTEGER,
  decided_on TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS negotiation_outcomes_watch ON negotiation_outcomes (watch_id, marketplace);
