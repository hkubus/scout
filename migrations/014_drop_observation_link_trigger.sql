-- observations_link_watch_listing ran on every observation insert: it updated
-- the observation's watch_listing_id and pushed first_seen_at/last_seen_at
-- into watch_listings. storeListing — the only observation-insert path in the
-- application — already upserts watch_listings with those timestamps and
-- passes the association id explicitly, so the trigger's two writes were
-- redundant work per row on the hottest write path. The create trigger stays:
-- it is a no-op guard for direct inserts and backfills that predate the
-- association (its WHEN clause is an indexed probe).
DROP TRIGGER IF EXISTS observations_link_watch_listing;
