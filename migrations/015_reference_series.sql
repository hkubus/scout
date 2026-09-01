-- Opt-in reference series: a deal watch may use a research watch's
-- probable-sale band as a fallback baseline while its own history is still
-- learning. Display/ranking only; the alert readiness gate is unchanged.

ALTER TABLE watches ADD COLUMN reference_market_watch_id TEXT REFERENCES market_watches(id);
ALTER TABLE watch_listings ADD COLUMN typical_source TEXT;
