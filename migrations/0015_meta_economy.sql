-- メタバースの通貨・お店・提携店の引換券（2026-09-23）。
--
-- 通貨は「遊んで貯まる」だけのポイント。**お金で買えない・お金に戻せない・人に渡せない**（src/economy.ts の約束）。
-- 分身の識別子で持つ（会話・記憶は入れない）。財布を持てるのは、持ち主トークンで確かめた分身だけ。

-- 財布（分身ごと）
CREATE TABLE IF NOT EXISTS meta_wallets (
  character_id TEXT PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0,
  earned INTEGER NOT NULL DEFAULT 0,
  spent INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 出入りの記録（増えた・使った・運営の付与）。day は日本時間の日付（1日の上限の計算に使う）
CREATE TABLE IF NOT EXISTS meta_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  balance INTEGER NOT NULL,
  -- 'login' | 'clear' | 'talk' | 'grant' | 'buy' | 'refund'
  kind TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_meta_ledger_char ON meta_ledger (character_id, id);
CREATE INDEX IF NOT EXISTS idx_meta_ledger_day ON meta_ledger (character_id, day, kind);
CREATE INDEX IF NOT EXISTS idx_meta_ledger_created ON meta_ledger (created_at);

-- 商品（最初からある商品はコードにあり、同じIDの行があれば上書き）
CREATE TABLE IF NOT EXISTS meta_items (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 売れた数（在庫のある商品だけ数える）
CREATE TABLE IF NOT EXISTS meta_item_sold (
  item_id TEXT PRIMARY KEY,
  sold INTEGER NOT NULL DEFAULT 0
);

-- お店（最初からあるお店はコードにあり、同じIDの行があれば上書き）
CREATE TABLE IF NOT EXISTS meta_shops (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 持ち物
CREATE TABLE IF NOT EXISTS meta_inventory (
  character_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  qty INTEGER NOT NULL DEFAULT 0,
  equipped INTEGER NOT NULL DEFAULT 0,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, item_id)
);

-- 提携店（リアルの店）。pin_hash はお店の人が引換券を使うときの暗証番号（そのものは持たない）
CREATE TABLE IF NOT EXISTS meta_partners (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 引換券（通貨と引き換えに発行し、提携店の店頭で使う）
CREATE TABLE IF NOT EXISTS meta_vouchers (
  code TEXT PRIMARY KEY,
  character_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  partner_id TEXT NOT NULL,
  title TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  -- 'issued' | 'used' | 'cancelled'
  status TEXT NOT NULL DEFAULT 'issued',
  month TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_meta_vouchers_char ON meta_vouchers (character_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_meta_vouchers_partner ON meta_vouchers (partner_id, status);
