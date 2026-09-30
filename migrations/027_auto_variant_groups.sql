-- Automatic model-variant groups. variant_groups_auto = 1 means Scout still
-- owes this watch a proposal: once enough listings are saved it derives groups
-- from their titles, stores them like hand-made ones, and clears the flag.
-- Editing the groups also clears it, so a user's choice is never overwritten.
-- variant_groups_auto_checked records how many listings the last attempt saw
-- so a watch that looked like a single product is only re-examined after it
-- has grown. Existing watches without groups start pending.
ALTER TABLE watches ADD COLUMN variant_groups_auto INTEGER NOT NULL DEFAULT 1;
ALTER TABLE watches ADD COLUMN variant_groups_auto_checked INTEGER NOT NULL DEFAULT 0;
UPDATE watches SET variant_groups_auto = 0 WHERE variant_groups_json NOT IN ('', '[]');
