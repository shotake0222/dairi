/**
 * 「演出スクリプト」の生成。
 *
 * 「かざして話す」モードでは、サーバーが返すのは文章だけではなく、
 * **カメラ映像を表示したままブラウザ側で実行する、一連の動作の指示**にしている。
 *
 * なぜ文章とは別に持たせたか:
 * - 画面側に「この語尾なら喜んでいる」といった判定を書くと、キャラクターの解釈が
 *   サーバー（性格・口調を握っている側）とクライアントの2箇所に分裂する。
 *   分身の振る舞いの決定権はサーバー側に一本化しておきたい。
 * - 表示のしかた（吹き出し・エフェクト・動き）は端末の都合で変わるが、
 *   「喜んだ」「首をかしげた」という**意味**は変わらない。意味だけを送れば、
 *   将来ロボットやメタバースのアバターに出力先が変わっても、同じスクリプトが使える。
 *   人格ポータビリティの方針（モデル・実行環境に依存しない形で持ち出す）と同じ考え方。
 *
 * スクリプトは「上から順に実行する」だけの単純な配列にしてある。
 * 解釈に失敗した要素は、クライアント側で無視して構わない（前方互換のため）。
 */

import { PersonalityTraits } from "./personality";

export type Emotion = "happy" | "curious" | "shy" | "calm" | "surprised" | "sad";

export type ActionStep =
  | { type: "emote"; emotion: Emotion; ms: number }
  | { type: "move"; motion: "hop" | "lean" | "spin" | "shake" | "nod"; ms: number }
  | { type: "effect"; effect: "sparkle" | "heart" | "note" | "question" | "drop"; ms: number }
  | { type: "say"; text: string };

/** 応答テキストから感情を推定する。日本語の語尾・記号・語彙による簡易判定。 */
export function detectEmotion(reply: string, personality?: Partial<PersonalityTraits>): Emotion {
  const text = reply || "";

  // 判定の順番が結果を決める。強い手がかり（驚き・落ち込み）から先に見る。
  if (/(えっ|ええっ|うそ|まさか|びっくり|驚い|なんと)/.test(text) || /[!！?？]{2,}/.test(text)) {
    return "surprised";
  }
  if (/(ごめん|さみし|寂し|かなし|悲し|つら|辛い|残念|しょんぼり|大丈夫\?)/.test(text)) {
    return "sad";
  }
  if (/(うれし|嬉し|たのし|楽し|やった|よかった|ありがと|すき|好き|大好き|わーい)/.test(text)) {
    return "happy";
  }
  if (/[?？]/.test(text) || /(なに|何|どう|どんな|なんで|どこ|いつ|教えて|知りたい)/.test(text)) {
    return "curious";
  }
  if (/(えっと|うーん|そのー|ちょっと|かも|かな…|照れ|恥ずかし)/.test(text)) {
    return "shy";
  }

  // 手がかりが無いときは性格に寄せる。無表情で固まるより、その子らしく揺れている方が生きて見える。
  const p = personality || {};
  if ((p.cheerfulness ?? 50) >= 65) return "happy";
  if ((p.curiosity ?? 50) >= 65) return "curious";
  if ((p.caution ?? 50) >= 65) return "shy";
  return "calm";
}

const EMOTION_PRESET: Record<Emotion, { motion: "hop" | "lean" | "spin" | "shake" | "nod"; effect: ActionStep & { type: "effect" } }> = {
  happy: { motion: "hop", effect: { type: "effect", effect: "sparkle", ms: 1200 } },
  curious: { motion: "lean", effect: { type: "effect", effect: "question", ms: 1200 } },
  shy: { motion: "shake", effect: { type: "effect", effect: "note", ms: 1000 } },
  calm: { motion: "nod", effect: { type: "effect", effect: "note", ms: 900 } },
  surprised: { motion: "spin", effect: { type: "effect", effect: "sparkle", ms: 1000 } },
  sad: { motion: "shake", effect: { type: "effect", effect: "drop", ms: 1200 } },
};

export interface ActionScript {
  emotion: Emotion;
  steps: ActionStep[];
}

/**
 * 応答文から、カメラ映像の上で再生する演出スクリプトを組み立てる。
 * 「感情を出す → 体を動かす → 喋る → 余韻のエフェクト」という並びを基本形にしている。
 */
export function buildActionScript(reply: string, personality?: Partial<PersonalityTraits>): ActionScript {
  const emotion = detectEmotion(reply, personality);
  const preset = EMOTION_PRESET[emotion];

  const steps: ActionStep[] = [
    { type: "emote", emotion, ms: 400 },
    { type: "move", motion: preset.motion, ms: 700 },
    { type: "say", text: reply },
  ];

  // ユーモアや陽気さが高い子ほど、余韻のエフェクトを出す（性格が見た目にも滲むようにする）。
  const liveliness = ((personality?.cheerfulness ?? 50) + (personality?.humor ?? 50)) / 2;
  if (liveliness >= 55 || emotion === "happy" || emotion === "surprised" || emotion === "sad") {
    steps.push(preset.effect);
  }

  return { emotion, steps };
}
