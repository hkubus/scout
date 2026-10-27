-- "Ready to list": the operator picks marketplaces and Hatbot posts the
-- flip's listing draft there, reporting each outcome back over MCP.
-- listing_ready_at       when it was marked ready; NULL when it isn't
-- listing_channels_json  [{"channel","status","url","error","updatedAt"}],
--                        status ready | listed | failed | declined
-- listing_revised_at     the draft's revision: moves only when what gets
--                        posted changes (text, prices, delivery, photos,
--                        channels), never when a channel's status is recorded
-- listing_fingerprint    hash of what gets posted, to tell when it changed
-- Private like the rest of flips: hidden from the Debug API.
ALTER TABLE flips ADD COLUMN listing_ready_at TEXT;
ALTER TABLE flips ADD COLUMN listing_channels_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE flips ADD COLUMN listing_revised_at TEXT;
ALTER TABLE flips ADD COLUMN listing_fingerprint TEXT;
