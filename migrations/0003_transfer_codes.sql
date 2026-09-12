-- wrangler d1 migrations apply nfc-companion-db --local/--remote で適用
--
-- 「引き継ぎコード」用のテーブル。
--
-- 背景: わけたまはアカウント登録が無く、持ち主であることの証明（ownerToken）は
-- そのブラウザのlocalStorageにしか存在しない。つまり機種変更やブラウザのデータ削除で、
-- 自分が育てた分身の所有権を永久に失う。育てるサービスとしてこれは致命的なので、
-- アカウントを導入せずに端末間で所有権を移すための仕組みとしてコードを発行する。
--
-- 設計上の注意:
-- - コードは短命（発行から30分）かつ1回限り。使われたら used_at を立てて再利用させない。
-- - コード自体が所有権そのものなので、他人に渡ると乗っ取られる。UI側でその旨を明示する。
-- - 期限切れの行はいつでも削除してよい（cronでの掃除は後回しでも実害はない）。
CREATE TABLE IF NOT EXISTS transfer_codes (
  code TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  -- 引き継ぎ先で有効になる新しい持ち主トークン。発行時に決めておき、使用時に引き渡す。
  new_owner_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_transfer_codes_character_id ON transfer_codes (character_id);
CREATE INDEX IF NOT EXISTS idx_transfer_codes_expires_at ON transfer_codes (expires_at);
