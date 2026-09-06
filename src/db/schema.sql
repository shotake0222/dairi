-- NFCタグとキャラクター（Durable Object）の紐付け
CREATE TABLE IF NOT EXISTS nfc_tags (
  tag_id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nfc_tags_character_id ON nfc_tags (character_id);

-- 将来のユーザーアカウント機能・マッチング機能拡張用（MVP時点では最小限）
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
