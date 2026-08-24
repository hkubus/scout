-- Opt-in automatic OLX/Allegro Lokalnie negotiation with one durable attempt per listing.

ALTER TABLE seller_messages ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS automatic_negotiations (
  marketplace TEXT NOT NULL,
  listing_id TEXT NOT NULL,
  watch_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'sent', 'failed')),
  asking_price_pln REAL NOT NULL,
  offer_price_pln REAL NOT NULL,
  max_total_cost_pln REAL NOT NULL,
  known_costs_pln REAL NOT NULL,
  discount_percent REAL NOT NULL,
  message_id INTEGER,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (marketplace, listing_id)
);

CREATE INDEX IF NOT EXISTS automatic_negotiations_updated ON automatic_negotiations (updated_at);
CREATE INDEX IF NOT EXISTS seller_messages_source_created ON seller_messages (source, created_at);
