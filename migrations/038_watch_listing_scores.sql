-- The deal score from a listing's latest scan, per watch, so feeds can ask
-- "would Scout alert?" without re-scoring every row.
-- discount_percent  (typical − price) / typical × 100 against typical_pln;
--                   NULL while the watch has no typical for the listing
-- deviation         (typical − price) / robust scale, the z-score the alert
--                   gate compares with 3.1 / sensitivity; NULL as above
-- confidence        0-100 baseline readiness from samples and hours observed
-- qualifies         1 when the score passes the deal gate (ready baseline,
--                   18 %+ below typical, and the z-score or 20 %+); the
--                   watch's minimum saving and target price are applied
--                   when reading, so changing them needs no rescore
-- All four stay NULL until the listing's watch scans it again.
ALTER TABLE watch_listings ADD COLUMN discount_percent REAL;
ALTER TABLE watch_listings ADD COLUMN deviation REAL;
ALTER TABLE watch_listings ADD COLUMN confidence INTEGER;
ALTER TABLE watch_listings ADD COLUMN qualifies INTEGER;
