-- Cross-source duplicate detection: the same physical item cross-posted on
-- OLX / Allegro Lokalnie / Vinted. Canonical order is listing_id_a < listing_id_b.

CREATE TABLE listing_duplicate_pairs (
  listing_id_a INTEGER NOT NULL REFERENCES listings(id),
  listing_id_b INTEGER NOT NULL REFERENCES listings(id),
  similarity REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (listing_id_a, listing_id_b)
);

CREATE INDEX listing_duplicate_pairs_created ON listing_duplicate_pairs(created_at);
