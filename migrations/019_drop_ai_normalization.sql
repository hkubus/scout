-- AI listing normalization was removed as an unnecessary feature.
-- Drop its cached columns and cross-listing reuse index.
DROP INDEX IF EXISTS listing_normalization_input_reuse;
ALTER TABLE listings DROP COLUMN ai_normalization_json;
ALTER TABLE listings DROP COLUMN ai_normalization_input_hash;
ALTER TABLE listings DROP COLUMN ai_normalization_model;
ALTER TABLE listings DROP COLUMN ai_normalization_at;
ALTER TABLE listings DROP COLUMN ai_normalization_error;
