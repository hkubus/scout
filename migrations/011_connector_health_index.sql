-- Keep per-source connector health aggregation in source/latest order so the
-- dashboard can compute latest state, run count, and last success in one scan.
CREATE INDEX IF NOT EXISTS connector_runs_source_latest
  ON connector_runs (source, started_at DESC, id DESC);
