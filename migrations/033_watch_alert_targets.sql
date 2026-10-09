-- Per-watch alert rules set by the operator.
-- target_price_pln  a listing at or below this price alerts at once, even
--                   while the watch is still learning; NULL means no target
-- min_saving_pln    deal alerts also need typical − price of at least this
--                   many złoty; target hits ignore it; NULL means no floor
-- Neither changes scoring, baselines or the feed, only which listings alert.
ALTER TABLE watches ADD COLUMN target_price_pln REAL;
ALTER TABLE watches ADD COLUMN min_saving_pln REAL;
