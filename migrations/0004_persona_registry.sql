-- 人格データのレジストリ・マーケット・利用状況。
--
-- Durable Object は1体ずつ独立していて横断で数えられないため、
-- 「全体で何体いるか」「どのセグメントが多いか」を知るには、別途こちらへ写しておく必要がある。
--
-- 重要な前提:
--   * persona_registry に行が作られるのは、集約利用（consent_aggregate）か
--     出品（consent_marketplace）のどちらかに同意した分身だけ。
--     同意していない分身は、そもそもここに存在しない。
--   * 会話の本文・記憶・覚え書きは一切入れない。入れるのは数値と選択肢の値まで。
--   * 属性は同意がある場合のみ入れる（無ければ NULL のまま）。
--   * アクセシビリティ設定は、同意の有無に関わらずここへ持ち込まない。

CREATE TABLE IF NOT EXISTS persona_registry (
  character_id       TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,

  growth_stage       TEXT,
  interaction_count  INTEGER NOT NULL DEFAULT 0,

  segment_id         TEXT,
  segment_confidence INTEGER NOT NULL DEFAULT 0,

  -- 性格6軸
  warmth        INTEGER, curiosity INTEGER, cheerfulness INTEGER,
  caution       INTEGER, independence INTEGER, humor INTEGER,

  -- 価値観8軸
  v_achievement   INTEGER, v_benevolence INTEGER, v_hedonism  INTEGER, v_security INTEGER,
  v_stimulation   INTEGER, v_selfdirection INTEGER, v_tradition INTEGER, v_power   INTEGER,

  -- 属性（consent_profile かつ consent_aggregate のときだけ入る）
  age_band     TEXT,
  gender       TEXT,
  region       TEXT,
  occupation   TEXT,
  income       TEXT,
  profile_completion INTEGER NOT NULL DEFAULT 0,

  -- 上位の関心（カンマ区切り。話題カテゴリ名のみで、発言そのものではない）
  top_interests TEXT,

  consent_aggregate   INTEGER NOT NULL DEFAULT 0,
  consent_marketplace INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_persona_segment ON persona_registry (segment_id);
CREATE INDEX IF NOT EXISTS idx_persona_updated ON persona_registry (updated_at);

-- 本人による出品。ここに行があっても status='listed' でなければ公開されない。
CREATE TABLE IF NOT EXISTS market_listings (
  listing_id        TEXT PRIMARY KEY,
  character_id      TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  price_jpy         INTEGER NOT NULL DEFAULT 0,
  segment_id        TEXT,
  growth_stage      TEXT,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'draft',  -- draft | listed | withdrawn
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  views             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_listing_status ON market_listings (status, updated_at);

-- 購入の申し込み。決済は未接続なので、いまは「話を進めたい」を受け取るところまで。
CREATE TABLE IF NOT EXISTS purchase_requests (
  request_id  TEXT PRIMARY KEY,
  listing_id  TEXT NOT NULL,
  contact     TEXT NOT NULL,
  message     TEXT,
  created_at  INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'new'          -- new | handled
);

CREATE INDEX IF NOT EXISTS idx_purchase_listing ON purchase_requests (listing_id);

-- 日ごとの利用状況。1行1指標で持ち、加算だけする。
CREATE TABLE IF NOT EXISTS analytics_daily (
  day    TEXT NOT NULL,
  metric TEXT NOT NULL,
  value  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, metric)
);
