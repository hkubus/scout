-- Jev fuzzy-rescue cache (spend control): term-match and condition-match
-- rescue decisions are cached by input hash + model so repeat scans reuse
-- the verdict instead of re-spending a Jev call on the same near-miss title
-- every cycle. Best-effort reads/writes only; misses fall through to live Jev.

CREATE TABLE IF NOT EXISTS jev_fuzzy_cache (
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  task TEXT NOT NULL,
  decision TEXT NOT NULL,
  confidence REAL,
  rescued INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (input_hash, model, task)
);

CREATE INDEX IF NOT EXISTS jev_fuzzy_cache_checked
  ON jev_fuzzy_cache (checked_at DESC);
