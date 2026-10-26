-- Stored marketplace sessions: whether Scout's scans, detail checks and AI
-- verification render with the account, and the last signed-in check.
-- use_for_checks  1 renders with the stored session (the old behaviour),
--                 0 keeps them anonymous while the session stays stored
-- signed_in       1 signed in, 0 signed out, NULL not checked or undecided
-- checked_at      when the account page was last rendered to find out
-- check_detail    what that check saw, in one sentence
ALTER TABLE marketplace_sessions ADD COLUMN use_for_checks INTEGER NOT NULL DEFAULT 1;
ALTER TABLE marketplace_sessions ADD COLUMN signed_in INTEGER;
ALTER TABLE marketplace_sessions ADD COLUMN checked_at TEXT;
ALTER TABLE marketplace_sessions ADD COLUMN check_detail TEXT;
