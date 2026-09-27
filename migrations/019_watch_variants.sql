-- Per-watch model variant groups: split a broad watch (e.g. "1660") into
-- separately scored products (1660, 1660 Super, 1660 Ti). Each listing
-- association carries its assigned variant_key so the scan can learn a
-- separate price baseline per model instead of blending them.
ALTER TABLE watches ADD COLUMN variant_groups_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE watch_listings ADD COLUMN variant_key TEXT;
CREATE INDEX IF NOT EXISTS watch_listings_watch_variant ON watch_listings (watch_id, variant_key, last_seen_at);
