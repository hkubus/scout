-- Retention prune deletes expired listings only when no observation still
-- references them (plus the ON DELETE CASCADE child lookup); without an index
-- leading with listing_id each candidate scanned the whole observation index.
-- listing_id never changes, so trailing-row updates do not maintain it.
CREATE INDEX IF NOT EXISTS observations_listing ON observations (listing_id);
-- No query filters or orders by scan_id (it is only read as IS NULL on the
-- row), yet both indexes were maintained on every observation write.
DROP INDEX IF EXISTS observations_scan;
DROP INDEX IF EXISTS market_price_observations_scan;
