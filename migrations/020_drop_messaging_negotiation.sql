-- Seller messaging and AI negotiation were removed as unused features.
-- Drop their tables and the settings that only configured automatic negotiation.
DROP TABLE IF EXISTS seller_messages;
DROP TABLE IF EXISTS automatic_negotiations;
DELETE FROM settings WHERE key IN ('auto_negotiation_config', 'negotiation_use_band');
