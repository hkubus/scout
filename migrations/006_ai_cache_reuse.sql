CREATE INDEX IF NOT EXISTS listing_relevance_input_reuse
ON listing_relevance (input_hash, model, relevance_status, checked_at);

CREATE INDEX IF NOT EXISTS listing_normalization_input_reuse
ON listings (ai_normalization_input_hash, ai_normalization_model, ai_normalization_at);
