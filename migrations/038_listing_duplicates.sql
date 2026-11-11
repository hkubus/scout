-- Cross-marketplace copies of the same item (docs/market-intelligence-plan.md,
-- Milestone 6). Derived data: refreshDuplicatePairs() rebuilds it from the
-- listings seen in the last 14 days, so it is not exported.
-- Canonical order listing_id_a < listing_id_b; created_at is when the pair
-- was first found. Pairs go with their listings when retention deletes them.
CREATE TABLE IF NOT EXISTS listing_duplicate_pairs (
  listing_id_a INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  listing_id_b INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  similarity REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (listing_id_a, listing_id_b),
  CHECK (listing_id_a < listing_id_b)
);

CREATE INDEX IF NOT EXISTS listing_duplicate_pairs_b ON listing_duplicate_pairs (listing_id_b);
