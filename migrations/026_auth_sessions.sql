-- Browser login sessions. Only a SHA-256 hash of each random session token is
-- stored, so a database copy cannot be replayed as a cookie. credential_id
-- fingerprints the configured password, so rotating it revokes every session.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx ON auth_sessions (expires_at);
