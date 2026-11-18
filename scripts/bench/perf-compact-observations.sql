-- Prototype for perf.ts --apply: removes the observation rows that today's
-- per-scan dedup (storeListing, commit 039f835) would never have written.
-- Within a (watch, listing) history, a run of rows with one price on one UTC
-- day keeps its first row and its last row; the rows in between go. Daily
-- analytics read each day's latest row and readiness reads MIN(observed_at),
-- so both keep their inputs. Only watchAnalytics' raw totalObservations count
-- changes. Nothing references observations by id (no foreign keys).
--
--   node --import tsx scripts/bench/perf.ts <export> --apply=scripts/bench/perf-compact-observations.sql --json=after.json
--   node --import tsx scripts/bench/compare.ts baseline.json after.json
--
-- The closing VACUUM makes the copy's size (copyBytes) and index layout what
-- a compacted live file would have.
DELETE FROM observations WHERE id IN (
  SELECT id FROM (
    SELECT id,
      price_pln,
      substr(observed_at, 1, 10) AS day,
      LAG(price_pln) OVER w AS prev_price,
      LEAD(price_pln) OVER w AS next_price,
      LAG(substr(observed_at, 1, 10)) OVER w AS prev_day,
      LEAD(substr(observed_at, 1, 10)) OVER w AS next_day
    FROM observations
    WINDOW w AS (PARTITION BY watch_id, listing_id ORDER BY observed_at, id)
  )
  WHERE prev_price = price_pln AND next_price = price_pln AND prev_day = day AND next_day = day
);
VACUUM;
