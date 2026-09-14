-- 人格データの「厚み」をレジストリにも持つ。
--
-- なぜ列を足すのか:
-- 出品や法人提供の判断は「どれだけ育っているか」で決まるのに、
-- これまでは会話回数と属性の回答率しか無く、価値観の申告が入っていなかった。
-- 厚みの計算は src/persona/survey.ts の personaDepth 一箇所に置き、
-- ここにはその結果だけを写す（同じ計算を管理画面のSQLに書き直すと、必ず食い違う）。
--
-- 既存の行は 0 のまま入る。次に会話するか設問に答えた時点で更新される。

ALTER TABLE persona_registry ADD COLUMN depth_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE persona_registry ADD COLUMN psycho_answered INTEGER NOT NULL DEFAULT 0;
