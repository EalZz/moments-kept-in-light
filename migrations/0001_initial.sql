CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  date TEXT DEFAULT '',
  cover_photo_id INTEGER,
  meta_json TEXT DEFAULT '{}',
  sort_order INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  meta_json TEXT DEFAULT '{}',
  sort_order INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collection_id INTEGER NOT NULL,
  group_id INTEGER,
  key_large TEXT NOT NULL,
  key_thumb TEXT NOT NULL,
  width INTEGER DEFAULT 0,
  height INTEGER DEFAULT 0,
  taken_at TEXT DEFAULT '',
  exif_json TEXT DEFAULT '{}',
  sort_order INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS model_aliases (
  old_handle TEXT PRIMARY KEY,
  new_handle TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_names (
  handle TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS site_daily_views (
  view_date TEXT PRIMARY KEY,
  views INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_groups_collection_order
  ON groups(collection_id, sort_order, id);
