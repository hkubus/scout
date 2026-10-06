-- Operator-written things Jev looks for while verifying a watch's
-- high-priority deals: [{"text": "...", "mode": "require" | "exclude"}].
ALTER TABLE watches ADD COLUMN verification_checks_json TEXT NOT NULL DEFAULT '[]';
