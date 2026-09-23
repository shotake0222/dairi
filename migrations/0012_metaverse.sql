-- メタバースの部屋（2026-09-23）。
--
-- 部屋は**管理画面でだけ**作る・直す（利用者が作れる部屋は持たない。見知らぬ人に任意の画像・文字を
-- 見せる口を開けないため）。ここに置くのは部屋の「設定」だけで、誰が入っているか・どこにいるかは
-- Durable Object（MetaverseRoom）のメモリとWebSocketにだけあり、ここには書かない（入退室の記録を残さない）。
--
-- objects: 部屋に置く物の一覧（JSON配列）。看板（広告）・動画・いまいる子の紹介・ミニゲーム
--          （宝さがし・○×クイズ・スタンプラリー）。中身の形と上限は src/metaverse.ts の sanitizeObjects
-- listed : 1 ならロビーの一覧に出す。0 ならリンク（/meta?room=<id>）を知っている人だけが入れる
CREATE TABLE IF NOT EXISTS meta_rooms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  place TEXT NOT NULL,
  time_of_day TEXT NOT NULL,
  camera TEXT NOT NULL,
  objects TEXT NOT NULL DEFAULT '[]',
  listed INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_meta_rooms_listed ON meta_rooms (listed, updated_at);
