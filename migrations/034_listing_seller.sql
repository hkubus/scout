-- The seller's marketplace account id, where the search payload carries it
-- (OLX user.id, Vinted user.id; Allegro Lokalnie search cards have none).
-- It lets scout_listing_detail list a seller's other listings and relists
-- from stored rows without a request. Written once a scan sees it; a later
-- scan without it keeps the stored value.
ALTER TABLE listings ADD COLUMN seller_id TEXT;
CREATE INDEX IF NOT EXISTS listings_seller ON listings (marketplace, seller_id) WHERE seller_id IS NOT NULL;
