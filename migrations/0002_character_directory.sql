-- wrangler d1 migrations apply nfc-companion-db --local/--remote で適用
--
-- 「分身同士の交流」機能用のディレクトリテーブル。
-- ユーザーが明示的にオプトインしたキャラクターのみ、ここに性格スナップショットが1行入る。
-- オプトアウト時はDELETEされる（＝同意していないキャラクターの情報は一切残らない設計）。
CREATE TABLE IF NOT EXISTS character_directory (
  character_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  species TEXT NOT NULL,
  color TEXT NOT NULL,
  growth_stage TEXT NOT NULL,
  warmth REAL NOT NULL,
  curiosity REAL NOT NULL,
  cheerfulness REAL NOT NULL,
  caution REAL NOT NULL,
  independence REAL NOT NULL,
  humor REAL NOT NULL,
  updated_at INTEGER NOT NULL
);
