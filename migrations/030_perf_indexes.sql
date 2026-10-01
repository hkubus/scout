-- Retention prune deletes expired listings only when no observation still
-- references them (plus the ON DELETE CASCADE child lookup); without an index
-- leading with listing_id each candidate scanned the whole observation index.
-- listing_id never changes, so trailing-row updates do not maintain it.
CREATE INDEX IF NOT EXISTS observations_listing ON observations (listing_id);
-- No query filters or orders by scan_id (it is only read as IS NULL on the
-- row), yet both indexes were maintained on every observation write.
DROP INDEX IF EXISTS observations_scan;
DROP INDEX IF EXISTS market_price_observations_scan;
-- Connector history pages order every run by recency, and the retention
-- prune ranges on started_at; both scanned the whole table.
CREATE INDEX IF NOT EXISTS connector_runs_recent ON connector_runs (started_at DESC, id DESC);
-- No query reads finished_at through an index (health reads go through
-- connector_runs_source_latest), yet it was maintained on every run write.
DROP INDEX IF EXISTS connector_runs_finished_at;
-- Readiness and startup recovery only look for unfinished scans.
CREATE INDEX IF NOT EXISTS scans_unfinished ON scans (status) WHERE status IN ('running', 'interrupted');
