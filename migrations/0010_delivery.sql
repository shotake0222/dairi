-- 納品（何を、誰に、どの範囲で渡したか）。
--
-- これまで人格カードは「持ち主トークン」でしか取り出せなかった。
-- それは正しいが、**売るときに渡せるものが無い**ことを意味する。
-- 持ち主トークンを買い手に渡すと、名前の変更も削除もできてしまう。
--
-- そこで「引換券」を別に発行する。引換券は
--   - 1つの分身に紐づく
--   - 範囲（card / behavior / mcp）が決まっている
--   - 期限がある
--   - いつでも失効させられる
-- 売買の実体はこの引換券であって、分身そのものの所有権は動かない。

CREATE TABLE IF NOT EXISTS delivery_grants (
  -- 引換券そのものは保存しない。ハッシュだけを持つ（漏れたときに使い回せないように）
  token_hash TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  -- 渡す範囲。カンマ区切り: card, behavior, mcp, bundle
  scopes TEXT NOT NULL,
  -- 誰に渡したか（運営のメモ。会社名など）
  label TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  -- 何回使われたか。納品したのに使われていない＝先方が困っている可能性がある
  used_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_delivery_grants_character ON delivery_grants (character_id);
CREATE INDEX IF NOT EXISTS idx_delivery_grants_created ON delivery_grants (created_at);
