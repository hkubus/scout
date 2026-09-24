-- Per-marketplace watch cadence: each source can poll on its own interval
-- instead of a single watch-wide cadence. source_intervals_json holds an
-- optional { "<marketplace>": <minutes> } override map; sources without an
-- entry fall back to the watch's interval_minutes. source_next_scan_json keeps
-- the independently scheduled next check per marketplace so due sources can be
-- scanned without waking the ones that are not due yet. Both are JSON text for
-- forward-compatible parsing; an empty/NULL value preserves the previous
-- single-interval behavior.
ALTER TABLE watches ADD COLUMN source_intervals_json TEXT;
ALTER TABLE watches ADD COLUMN source_next_scan_json TEXT;
