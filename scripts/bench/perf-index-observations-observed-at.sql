-- Prototype for perf.ts --apply: an index for pruneRetention()'s
-- DELETE FROM observations WHERE observed_at < ?, which otherwise scans the
-- whole table once a day. Compare with perf-compact-observations.sql, which
-- shrinks the table the scan walks instead.
--
--   node --import tsx scripts/bench/perf.ts <export> --only=prune --prune --apply=scripts/bench/perf-index-observations-observed-at.sql --json=after.json
CREATE INDEX IF NOT EXISTS perf_observations_observed_at ON observations (observed_at);
