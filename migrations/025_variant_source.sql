-- How each listing's model variant was chosen: 'rule' (the variant's terms),
-- 'jev' (AI fallback for titles no rule matched), or 'manual' (set from the
-- listing drawer). Manual picks survive scans and variant edits while their
-- variant exists; NULL predates this column and is treated as a rule match.
ALTER TABLE watch_listings ADD COLUMN variant_source TEXT;
