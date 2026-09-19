-- 依代（よりしろ）＝ 分身が宿るもの。
--
-- これまで入口はNFCタグだけだった。ここからQRコードも入口になる。
--
-- **重要な決めごと: 入口の種類が違っても、振る舞いは完全に同じにする。**
--   - 1つの依代からは、1体しか生まれない（2回目以降は同じ子に会いに行く）
--   - 生まれる子の姿はランダム。どの依代から来ても確率は等しい
-- こうしないと「集める」が成り立たない。運営が姿を決められるようにすると、
-- 手に入れた喜びが「引き当てた」ではなく「配られた」になってしまうし、
-- 1つの依代から何体も生まれるようにすると、依代を集める理由が消える。
-- そのため species/color を運営が指定する仕組みは**置かない**。
--
-- 入口:
--   1. NFCタグ  /t/<code>                 … かざす
--   2. QR       /q/<code>                 … 読み取る
--   3. 依代なし  POST /api/character/new   … その端末だけで育てる
-- 1と2は同じ台帳（nfc_tags）を引く。違うのは読み取り方と、配った経路の記録だけ。

-- 発行済みの依代の台帳。
-- /t/ と /q/ は台帳に無いコードでも受け付ける（台帳を作る前に配ったタグを死なせないため）。
-- 台帳は「こちらが発行したものはどれか」「まだ使われていないのはどれか」を見るために持つ。
CREATE TABLE IF NOT EXISTS tag_registry (
  tag_id TEXT PRIMARY KEY,
  -- 'nfc'（かざす） | 'qr'（読み取る）。どちらで配ったかの記録で、振る舞いは変わらない
  kind TEXT NOT NULL DEFAULT 'nfc',
  -- 発行の単位（"2026-09-初回100枚" のような自由記述）
  batch TEXT,
  -- 配布元（spots.code）。特別な場所で配ったQRなら、その場所
  spot TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tag_registry_batch ON tag_registry (batch);
CREATE INDEX IF NOT EXISTS idx_tag_registry_spot ON tag_registry (spot);

-- 配布元（特別な場所）。
--
-- 「その場所でしか手に入らない」を、姿を固定することでは作らない（上の決めごと）。
-- **その場所にしか置いていないコードを配ることで**作る。
-- 手に入れた子がどこで手に入ったかは記録されるので、「出雲で拾った子」は言葉として残る。
CREATE TABLE IF NOT EXISTS spots (
  code TEXT PRIMARY KEY,
  -- 画面に出す名前（例: 「八重垣神社」）
  label TEXT NOT NULL,
  -- 設置場所の細かいメモ（運営用。利用者には出さない）
  place TEXT,
  -- 利用者に見せる一言（例: 「境内でだけ手に入る子です」）
  note TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_spots_active ON spots (active);

-- どの入口から生まれた分身か。復旧のときに「どこで手に入れたか」を本人に確認できる。
-- 分身の中身（会話・記憶）はここには一切入れない。
CREATE TABLE IF NOT EXISTS character_origin (
  character_id TEXT PRIMARY KEY,
  -- 'nfc' | 'qr' | 'direct' | 'import'
  kind TEXT NOT NULL,
  -- 依代から来たなら、その tag_id。'direct' なら NULL
  ref TEXT,
  -- 配布元（spots.code）。分かるときだけ
  spot TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_character_origin_ref ON character_origin (kind, ref);
CREATE INDEX IF NOT EXISTS idx_character_origin_spot ON character_origin (spot);
