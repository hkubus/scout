-- Connected apps: MCP clients such as Hatbot that the operator lets in with
-- OAuth 2.1 (authorization code + PKCE, public clients). Their tokens work on
-- /mcp only. Codes and tokens are stored only as SHA-256 hex digests.
-- Private: hidden from the Debug API like the flip ledger.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  first_token_at TEXT
);
CREATE INDEX IF NOT EXISTS oauth_clients_created_idx ON oauth_clients (created_at);

-- One-time codes from the "Let … in?" page, valid for 5 minutes. token_id is
-- set once the code is exchanged, so a replayed code revokes that token.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  token_id INTEGER
);
CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx ON oauth_codes (expires_at);

-- Tokens last until the operator disconnects the app (deleting the row).
CREATE TABLE IF NOT EXISTS connected_app_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
