ALTER TABLE collections ADD COLUMN published INTEGER NOT NULL DEFAULT 1;
ALTER TABLE collections ADD COLUMN deleted_at TEXT;
ALTER TABLE photos ADD COLUMN deleted_at TEXT;

CREATE TABLE IF NOT EXISTS login_attempts (
  client_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_collections_visibility
  ON collections(deleted_at, published, sort_order, date);
CREATE INDEX IF NOT EXISTS idx_photos_collection_order
  ON photos(collection_id, deleted_at, sort_order, taken_at, id);
CREATE INDEX IF NOT EXISTS idx_photos_group
  ON photos(group_id, deleted_at, sort_order, id);
