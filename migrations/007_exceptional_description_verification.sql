-- Cache the conservative detail-page check used for very strong and exceptional deals.

ALTER TABLE listings ADD COLUMN ai_description_verification_json TEXT;
ALTER TABLE listings ADD COLUMN ai_description_verification_input_hash TEXT;
ALTER TABLE listings ADD COLUMN ai_description_verification_model TEXT;
ALTER TABLE listings ADD COLUMN ai_description_verification_at TEXT;
ALTER TABLE listings ADD COLUMN ai_description_verification_status TEXT;
ALTER TABLE listings ADD COLUMN ai_description_verification_error TEXT;

CREATE INDEX IF NOT EXISTS listing_description_verification_reuse
  ON listings (ai_description_verification_input_hash, ai_description_verification_model, ai_description_verification_at);
