-- 広告・ランドマーク・看板の画像（2026-09-24）。
--
-- それまでは「画像のURL（https://）」を貼るしかなく、相手のサーバーが外部からの読み込み（CORS）を
-- 許していないと出なかった。アップロードした画像はここに入れ、同じサイトの /img/<id>.<拡張子> で配る。
--
-- - 画像は端末の側で縮めてから送る（長い辺1600px・WebP/JPEG）。1枚1.5MBまで（D1の1行の上限より小さく）
-- - 中身は画像の先頭の数バイトで確かめる（WebP・JPEG・PNG だけ）
-- - source: 'admin'（管理画面から） | 'land'（公開の申込ページ /land から）
-- - 申込ページから入れた画像は、どの申込・掲載にも使われないまま30日たつと消す（src/media.ts の purgeUnusedImages）
-- - 誰が送ったかは持たない（回数の制限は src/lib/ipQuota.ts の、日ごとに塩を変えたハッシュで数える）
CREATE TABLE IF NOT EXISTS meta_images (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  bytes INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'admin',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_images_source ON meta_images (source, created_at);
