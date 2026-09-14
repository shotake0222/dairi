-- 設問カタログ。
--
-- 組み込みの設問（src/persona/profile.ts と src/persona/survey.ts）はコードのまま残し、
-- この表は**上書きと追加**だけを持つ。理由:
--   - 表が空でもサービスは完全に動く（初期化を忘れて設問が全部消える、という事故が起きない）
--   - 組み込みの設問には「なぜ聞くのか」の文言まで書いてあり、それがそのまま画面に出る。
--     全部をDBへ移すと、その説明がレビューの目に触れない場所へ移ってしまう
--   - id が組み込みと同じなら上書き、違えば追加。運営が設問を足すたびにデプロイしなくてよい
--
-- options は JSON。属性の設問なら ["会社員","学生",...]、
-- 価値観の設問なら [{"label":"…","score":90}, …]（score は 0〜100。その軸の値がここへ寄る）。

CREATE TABLE IF NOT EXISTS survey_questions (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,            -- demographic | psychographic
  group_key      TEXT NOT NULL DEFAULT 'custom',
  label          TEXT NOT NULL,
  why            TEXT NOT NULL DEFAULT '',
  type           TEXT NOT NULL DEFAULT 'single',   -- single | multi（価値観は常に single）
  options        TEXT NOT NULL,            -- JSON
  axis           TEXT,                     -- 価値観の設問のときだけ。8軸のいずれか
  ask_after      INTEGER NOT NULL DEFAULT 0,
  max_selections INTEGER,
  sort_order     INTEGER NOT NULL DEFAULT 100,
  enabled        INTEGER NOT NULL DEFAULT 1,
  updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_survey_questions_kind ON survey_questions (kind, sort_order);
