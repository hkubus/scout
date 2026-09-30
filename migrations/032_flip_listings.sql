-- What the operator wants to post for a flip, filled into the OLX, Allegro
-- Lokalnie and Vinted forms by the browser extension. listing_json holds
-- {"title","description","condition","prices":{"OLX":…}}. Photos are the
-- operator's own and are stored once, then attached on every platform.
-- Like flips, both are private: never pruned and hidden from the Debug API.
ALTER TABLE flips ADD COLUMN listing_json TEXT;
CREATE TABLE IF NOT EXISTS flip_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  flip_id INTEGER NOT NULL REFERENCES flips(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  byte_size INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flip_photos_flip ON flip_photos (flip_id, position);
