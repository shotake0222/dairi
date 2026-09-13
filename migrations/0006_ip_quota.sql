-- 連絡フォームの回数制限。
--
-- 誰でも叩けるエンドポイント（/api/contact）に上限がないと、
-- いたずらで数千件入れられた時点で運営が本物の相談を見つけられなくなる。
--
-- **IPアドレスをそのまま保存しない。**
-- 目的は「同じ相手が短時間に何度も送っていないか」を数えることだけで、
-- 相手が誰かを知る必要はない。そこで、その日限りのランダムな塩を足して
-- ハッシュ化した値だけを持つ。塩は日ごとに変わるので、
-- 昨日の記録と今日の記録を突き合わせて同一人物を追うことはできない。
-- 古い行は Cron（1日2回）で消す。

CREATE TABLE IF NOT EXISTS rate_salts (
  day        TEXT PRIMARY KEY,   -- UTCの YYYY-MM-DD
  salt       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_counters (
  scope      TEXT NOT NULL,      -- 何の回数か（例: contact）
  day        TEXT NOT NULL,
  client     TEXT NOT NULL,      -- その日限りの塩でハッシュ化した送信元
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, day, client)
);

CREATE INDEX IF NOT EXISTS idx_rate_counters_day ON rate_counters (day);
