-- Recovery and bounded-history support for long-running home-server installs.

ALTER TABLE automatic_negotiations ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS scheduler_leases (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_id TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS scans_started_at ON scans (started_at);
CREATE INDEX IF NOT EXISTS connector_runs_finished_at ON connector_runs (finished_at);
CREATE INDEX IF NOT EXISTS notifications_created_at ON notifications (created_at);
CREATE INDEX IF NOT EXISTS seller_messages_created_at ON seller_messages (created_at);
CREATE INDEX IF NOT EXISTS market_price_observations_observed_at ON market_price_observations (observed_at);
