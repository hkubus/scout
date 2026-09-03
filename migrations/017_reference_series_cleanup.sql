-- Clear orphaned reference-series pointers and keep them null on research-watch delete.
UPDATE watches SET reference_market_watch_id = NULL WHERE reference_market_watch_id IS NOT NULL AND reference_market_watch_id NOT IN (SELECT id FROM market_watches);

DROP TRIGGER IF EXISTS market_watches_reference_nullify;
CREATE TRIGGER market_watches_reference_nullify
BEFORE DELETE ON market_watches
FOR EACH ROW BEGIN
  UPDATE watches SET reference_market_watch_id = NULL WHERE reference_market_watch_id = OLD.id;
END;
