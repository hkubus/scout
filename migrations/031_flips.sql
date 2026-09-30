-- The operator's own flips: what they bought, where it is listed, and what
-- it sold for. This is private bookkeeping. It never feeds baselines, bands
-- or alerts, is never pruned by retention, and is hidden from the debug API.
-- Dates are the operator's calendar dates (YYYY-MM-DD). sale_fee_pln is
-- stored at sale time, so later fee-preset edits do not rewrite history.
CREATE TABLE IF NOT EXISTS flips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  listing_key TEXT,
  watch_id TEXT,
  buy_channel TEXT NOT NULL,
  bought_on TEXT NOT NULL,
  buy_price_pln REAL NOT NULL,
  buy_costs_pln REAL NOT NULL DEFAULT 0,
  listed_on_json TEXT NOT NULL DEFAULT '[]',
  sold_on TEXT,
  sale_channel TEXT,
  sale_price_pln REAL,
  sale_fee_pln REAL,
  sale_costs_pln REAL,
  delisted_json TEXT NOT NULL DEFAULT '[]',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flips_sold_on ON flips (sold_on);
CREATE INDEX IF NOT EXISTS flips_bought_on ON flips (bought_on);
