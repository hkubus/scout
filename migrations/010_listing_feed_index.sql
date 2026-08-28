-- Serve recent saved-listing pages directly in display order instead of
-- scanning every watch association and building a temporary sort table.
CREATE INDEX IF NOT EXISTS watch_listings_recent
  ON watch_listings (last_seen_at DESC, id DESC);
