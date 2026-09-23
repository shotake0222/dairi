-- 管理者の分身（NPC）・広告とランドマーク（区画・設置物・申込・クーポンの集計）・招待と利用の申し込み（2026-09-23）。
--
-- どれも「分身の中身（会話・記憶）」は入れない。入るのは、運営が決めた設定と、申込者が自分で書いて送った内容だけ。

-- 管理者が作った分身（人格データ）。上限なしで作れる。持ち主トークンは運営の端末へ渡すために持つ
-- （このトークンで動かせるのは、ここにある運営の分身だけ。利用者の分身のトークンは、どこにも保存しない）
CREATE TABLE IF NOT EXISTS admin_characters (
  character_id TEXT PRIMARY KEY,
  owner_token TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

-- メタバースに置くNPC（運営の分身だけを置ける）。avatar は姿と動きの数値の写し（配る形そのもの）
CREATE TABLE IF NOT EXISTS meta_npcs (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  area_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  link_url TEXT,
  ad INTEGER NOT NULL DEFAULT 0,
  home_x REAL NOT NULL DEFAULT 0,
  home_z REAL NOT NULL DEFAULT 0,
  radius REAL NOT NULL DEFAULT 1.5,
  talk INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 100,
  avatar TEXT,
  avatar_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_npcs_area ON meta_npcs (area_id, active);

-- 区画（エリアの外周の決まった場所）ごとの販売設定
CREATE TABLE IF NOT EXISTS meta_plots (
  area_id TEXT NOT NULL,
  spot TEXT NOT NULL,
  -- 'none' | 'ad' | 'landmark' | 'both'
  sale TEXT NOT NULL DEFAULT 'none',
  ad_price INTEGER,
  landmark_price INTEGER,
  note TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (area_id, spot)
);

-- 区画に置いた物（広告・ランドマーク）。starts_at〜ends_at の間だけ表示する
CREATE TABLE IF NOT EXISTS meta_placements (
  id TEXT PRIMARY KEY,
  area_id TEXT NOT NULL,
  spot TEXT NOT NULL,
  -- 'ad' | 'landmark'
  kind TEXT NOT NULL,
  -- 'active' | 'ended'
  status TEXT NOT NULL DEFAULT 'active',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  content TEXT NOT NULL,
  -- 'operator'（運営が置いた） | 'order'（申込から）
  source TEXT NOT NULL DEFAULT 'operator',
  order_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_placements_area ON meta_placements (area_id, status);

-- 広告・ランドマークの申込。連絡先は、申込の連絡のためだけに使う
CREATE TABLE IF NOT EXISTS meta_orders (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  area_id TEXT NOT NULL,
  spot TEXT NOT NULL,
  kind TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  content TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  -- 'pending' | 'approved' | 'paid' | 'rejected' | 'cancelled'
  status TEXT NOT NULL DEFAULT 'pending',
  price INTEGER,
  payment_url TEXT,
  admin_note TEXT NOT NULL DEFAULT '',
  reject_reason TEXT NOT NULL DEFAULT '',
  placement_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_orders_status ON meta_orders (status, created_at);

-- 広告の見られ方（日ごとの回数だけ。誰が見たかは持たない）
CREATE TABLE IF NOT EXISTS meta_ad_stats (
  ad_key TEXT NOT NULL,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  coupons INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_key, day)
);

-- 依代を使わない入口: 招待リンク（/i/<code>）
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  -- 'new'（開いた人に新しい分身） | 'handover'（運営の分身を、開いた人に渡す）
  kind TEXT NOT NULL,
  character_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL DEFAULT 1,
  used INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  -- 'admin' | 'application'
  source TEXT NOT NULL DEFAULT 'admin',
  application_id TEXT,
  created_at INTEGER NOT NULL
);

-- Webからの利用の申し込み。承認すると招待リンクが発行され、申込者の状況ページに出る
CREATE TABLE IF NOT EXISTS entry_applications (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  -- 'pending' | 'approved' | 'rejected'
  status TEXT NOT NULL DEFAULT 'pending',
  invite_code TEXT,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entry_applications_status ON entry_applications (status, created_at);
