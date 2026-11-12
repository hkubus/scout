-- Quick flags (server/flags.ts): deterministic junk signals such as for
-- parts, wanted ad, swap, replica, damaged and locked, as a JSON array of
-- {flag, match, in}. Every store rewrites them from the listing's title,
-- condition and, for OLX, the description the offers API returned.
-- flags_version is the rule version that wrote them; rows stored before this
-- migration, or under older rules, are recomputed in the background from
-- title and condition. The query-dependent accessory flag is never stored.
ALTER TABLE listings ADD COLUMN flags_json TEXT;
ALTER TABLE listings ADD COLUMN flags_version INTEGER;
