-- Model groups: a deal watch may split its results into groups (e.g. iPhone
-- 13 / 13 Pro / 13 Pro Max) so each listing is scored against its own
-- group's typical price instead of the whole watch's mixed distribution.
-- groups_json holds [{ key, name, terms, excluded }]; the key is stable across
-- renames so assignments survive edits.

ALTER TABLE watches ADD COLUMN groups_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE watch_listings ADD COLUMN group_key TEXT;
ALTER TABLE watch_listings ADD COLUMN group_source TEXT;
