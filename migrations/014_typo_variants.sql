-- Typo-variant scanning: optional per-watch extra searches that catch
-- mispriced listings whose titles misspell the product.

ALTER TABLE watches ADD COLUMN typo_variants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_watches ADD COLUMN typo_variants INTEGER NOT NULL DEFAULT 0;
ALTER TABLE market_watch_versions ADD COLUMN typo_variants INTEGER NOT NULL DEFAULT 0;
