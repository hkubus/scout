-- Scout no longer filters watches or research series by location: a reseller
-- buys shipped items, so listings from anywhere count. The columns stay (the
-- API still reports `location` for older iOS builds) but hold the neutral
-- value, so nothing stored implies a filter that no longer applies.
UPDATE watches SET location = 'Polska' WHERE location IS NOT 'Polska';
UPDATE market_watches SET location = 'Polska' WHERE location IS NOT 'Polska';
UPDATE market_watch_versions SET location = 'Polska' WHERE location IS NOT 'Polska';
