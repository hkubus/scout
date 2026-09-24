-- Manual (non-watch) search relevance cache (spend control).
-- A manual search has no watch row to key `listing_relevance` on, so in
-- Jev-live mode every repeat of the same query re-spent one judgment per
-- listing and never reused a verdict. Decisions are keyed by the same input
-- hash + model the watch path already uses, so repeating a search — or
-- searching the same title/condition under the same phrase — reuses the result.

CREATE TABLE IF NOT EXISTS manual_relevance_cache (
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  relevant INTEGER NOT NULL CHECK (relevant IN (0, 1)),
  relevance_status TEXT NOT NULL,
  reason TEXT NOT NULL,
  error TEXT,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (input_hash, model)
);

CREATE INDEX IF NOT EXISTS manual_relevance_cache_checked
  ON manual_relevance_cache (checked_at DESC);
