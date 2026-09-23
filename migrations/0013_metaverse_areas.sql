-- メタバースのエリア管理（2026-09-23）。
--
-- status     : open（公開）/ draft（準備中。管理者だけが入れる）/ closed（閉鎖）
-- opens_at   : これより前は「近日開放」として一覧に出すが、入れない（新しいエリアの開放予約）
-- closes_at  : これを過ぎたら閉鎖扱い（キャンペーンの終了）
-- merged_into: 別のエリアにまとめた。古いリンクで来た人は、まとめた先へ案内する
-- sort_order : 一覧の並び（小さいほど上）
--
-- 最初からあるエリア（ひろば・夜空の丘）は、同じIDの行を作ると、その行の設定で上書きされる。
-- これで、最初からあるエリアも直す・閉じる・まとめるができる。
ALTER TABLE meta_rooms ADD COLUMN status TEXT NOT NULL DEFAULT 'open';
ALTER TABLE meta_rooms ADD COLUMN opens_at INTEGER;
ALTER TABLE meta_rooms ADD COLUMN closes_at INTEGER;
ALTER TABLE meta_rooms ADD COLUMN merged_into TEXT;
ALTER TABLE meta_rooms ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 100;

-- メタバース全体の設定（ミニゲームの有効・停止と既定値など）。key ごとに JSON で持つ
CREATE TABLE IF NOT EXISTS meta_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
