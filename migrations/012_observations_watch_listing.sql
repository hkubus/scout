-- The scan baseline (latest price per listing for a watch) walks observations
-- with ROW_NUMBER() OVER (PARTITION BY listing_id ORDER BY observed_at DESC,
-- id DESC). This covering index makes that a single ordered pass instead of a
-- per-row probe over the watch's history, which degraded to seconds of
-- synchronous CPU on watches with recurring listings.
CREATE INDEX IF NOT EXISTS observations_watch_listing
ON observations (watch_id, listing_id, observed_at, id);
