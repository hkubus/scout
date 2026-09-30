-- Optional OLX category scope for watches and research series, stored as
-- {"id":2184,"label":"Karty graficzne","path":"elektronika/.../karty-graficzne"}.
-- Only the id is sent on scans; label and path are for display. NULL keeps
-- the previous behaviour of searching every OLX category. Research versions
-- carry it too because it is part of the immutable criteria.
ALTER TABLE watches ADD COLUMN olx_category_json TEXT;
ALTER TABLE market_watches ADD COLUMN olx_category_json TEXT;
ALTER TABLE market_watch_versions ADD COLUMN olx_category_json TEXT;
