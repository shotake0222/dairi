-- 問い合わせの受付。
--
-- 法人向けページ（/biz）の相談フォームと、将来の一般的な問い合わせ窓口で共用する。
-- purchase_requests と分けているのは、あちらが「特定の出品に対する購入希望」であり、
-- 出品IDに紐づく必要があるのに対し、こちらは出品と無関係なため。
-- 無関係なものを同じ表に押し込むと、出品を消したときの扱いが曖昧になる。
--
-- ここに入るのは、相手が自分で書いて送った連絡先と本文だけ。
-- 分身の会話や人格データとは一切結び付けない。

CREATE TABLE IF NOT EXISTS contact_requests (
  request_id TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'biz',   -- biz | other
  company    TEXT,
  contact    TEXT NOT NULL,
  topic      TEXT,
  message    TEXT,
  created_at INTEGER NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new'    -- new | handled
);

CREATE INDEX IF NOT EXISTS idx_contact_created ON contact_requests (created_at);
