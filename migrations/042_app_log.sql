-- Warnings and errors from Scout's log, kept across restarts (server/appLog.ts).
-- Info lines stay in the in-memory buffer only. An identical line is stored
-- once a minute with a repeat count; the table is bounded by row count as it
-- grows and by age in the daily retention prune.
CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  level TEXT NOT NULL,
  scope TEXT NOT NULL,
  message TEXT NOT NULL,
  repeats INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS app_log_at ON app_log (at);

-- Startup recovery closes connector runs left 'running' by a restart; this
-- keeps that from scanning every connector_runs row (114k on a real copy).
CREATE INDEX IF NOT EXISTS connector_runs_running ON connector_runs (status) WHERE status = 'running';
