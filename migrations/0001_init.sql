-- wrangler d1 migrations apply nfc-companion-db --local/--remote で適用
CREATE TABLE IF NOT EXISTS nfc_tags (
  tag_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nfc_tags_character_id ON nfc_tags (character_id);

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_characters (
  user_id TEXT NOT NULL,
  character_id TEXT NOT NULL,
  PRIMARY KEY (user_id, character_id)
);
