-- Signals the marketplaces already send with every search result, so no
-- extra requests are needed:
-- posted_at     when the seller first posted it (OLX created_time), written once
-- refreshed_at  the seller's latest refresh or paid bump (OLX)
-- promoted      1 for a paid placement or highlight, NULL when unknown
-- seller_type   'private' | 'business' from the marketplace's own flag, NULL when unknown
ALTER TABLE listings ADD COLUMN posted_at TEXT;
ALTER TABLE listings ADD COLUMN refreshed_at TEXT;
ALTER TABLE listings ADD COLUMN promoted INTEGER;
ALTER TABLE listings ADD COLUMN seller_type TEXT;
-- Per-watch preferences. seller_type NULL means any seller. OLX filters it
-- natively; for other sources a listing is only dropped when its flag is
-- known to be the other type.
ALTER TABLE watches ADD COLUMN seller_type TEXT;
ALTER TABLE watches ADD COLUMN ignore_promoted INTEGER NOT NULL DEFAULT 0;
