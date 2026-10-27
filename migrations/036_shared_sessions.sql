-- shared_with_apps: the operator lets connected apps (Hatbot) fetch this
-- marketplace session over MCP, so Hatbot's own browser can use the login.
-- Off by default; re-importing a session keeps the choice.
ALTER TABLE marketplace_sessions ADD COLUMN shared_with_apps INTEGER NOT NULL DEFAULT 0;
