-- Description verdicts by input hash. listings keeps one verdict slot per
-- listing, which a detail-page fetch error or a missing description
-- overwrites, so the next good fetch used to re-ask Jev (and often vision)
-- about an input it had already judged. This keeps every fresh verdict by
-- input hash and model. scope is '' for a verdict Jev reached from the text
-- alone, which any listing with the same input may reuse, and
-- 'Marketplace:listingId' for one vision decided from that listing's photos.
CREATE TABLE IF NOT EXISTS description_verification_cache (
  input_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  verification_json TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (input_hash, model, scope)
);
CREATE INDEX IF NOT EXISTS description_verification_cache_checked ON description_verification_cache (checked_at);

-- Wall time of each logged AI call in milliseconds, queue wait included.
-- Rows logged before this migration have NULL.
ALTER TABLE jev_shadow_log ADD COLUMN duration_ms INTEGER;
