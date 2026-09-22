-- Manual listing visibility: a per-marketplace-listing hide flag that removes
-- an offer from the overview, listings feed, and alerting even when the AI
-- relevance filter considers it a match. Hidden rows stay in the database so
-- their price history is retained and they can be unhidden later.
ALTER TABLE listing_actions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
