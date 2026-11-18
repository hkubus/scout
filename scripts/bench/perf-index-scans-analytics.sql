-- Prototype for perf.ts --apply: a covering index for the Analytics page's
-- scan-health query (service.ts analytics(): runs, completed, average duration
-- per marketplace since the cutoff). Today it seeks scans_started_at and then
-- reads every scan row in the window from the table.
--
--   node --import tsx scripts/bench/perf.ts <export> --only=analytics --apply=scripts/bench/perf-index-scans-analytics.sql --json=after.json
CREATE INDEX IF NOT EXISTS perf_scans_analytics ON scans (watch_kind, started_at, marketplace, status, completed_at, watch_id);
