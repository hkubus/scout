-- Shadow-mode log for the Jev integration (Phase 1): every shadowed Jev
-- judgment is recorded next to the DeepSeek decision that drove behavior, so
-- agreement rates and unsure-band calibration can be measured locally before
-- cutover. Never read on any hot path; best-effort writes only.
-- `note` is left NULL by code and reserved for manual annotation during
-- calibration. No automatic retention: prune manually, e.g.
-- DELETE FROM jev_shadow_log WHERE created_at < '2026-01-01T00:00:00.000Z'.

CREATE TABLE IF NOT EXISTS jev_shadow_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  task TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  jev_model TEXT NOT NULL,
  jev_answer_json TEXT,
  jev_confidence REAL,
  jev_unsure INTEGER NOT NULL DEFAULT 0,
  jev_error TEXT,
  deepseek_decision TEXT,
  agreement INTEGER,
  vision_verdict TEXT,
  vision_confidence REAL,
  vision_images_seen INTEGER,
  vision_error TEXT,
  note TEXT
);

CREATE INDEX IF NOT EXISTS jev_shadow_log_task_created
  ON jev_shadow_log (task, created_at DESC, id DESC);
