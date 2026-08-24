CREATE INDEX IF NOT EXISTS listing_relevance_reuse
ON listing_relevance (marketplace, listing_id, input_hash, model, relevance_status);
