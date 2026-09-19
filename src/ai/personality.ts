/**
 * 性格パラメータの定義と、ユーザーとのやり取り（育て方）に応じた更新ロジック。
 *
 * 設計方針:
 * - 「育成」の実体はSLM（小規模言語モデル）の記憶力に頼らず、ここで構造化データとして管理する。
 * - SLMには毎ターン「現在の性格パラメータ」をテキストで渡し、その通りに演技してもらう。
 * - これにより、モデル自体は入れ替え可能なまま、蓄積されたパーソナライズはこちら側の資産として残る。
 */

export type PersonalityTraits = {
  warmth: number; // 温かさ：優しさ・親密さ
  curiosity: number; // 好奇心：新しい話題への食いつき
  cheerfulness: number; // 陽気さ：テンション・明るさ
  caution: number; // 慎重さ：距離感・警戒心
  independence: number; // 自立心：ユーザーへの依存度合い（逆相関）
  humor: number; // ユーモア：冗談・軽口の量
};

export const TRAIT_KEYS = [
  "warmth",
  "curiosity",
  "cheerfulness",
  "caution",
  "independence",
  "humor",
] as const;

export const DEFAULT_PERSONALITY: PersonalityTraits = {
  warmth: 50,
  curiosity: 50,
  cheerfulness: 50,
  caution: 50,
  independence: 50,
  humor: 50,
};

export type InteractionSignal = {
  messageLength: number;
  sentiment: "positive" | "neutral" | "negative";
  sentimentIntensity: number; // 0-1: 感情表現の強さ（強調語・語数から推定。旧データ互換のためoptional扱いでも読める）
  topicNovelty: number; // 0-1: 話題の目新しさ（簡易推定）
  daysSinceLastVisit: number;
  askedQuestion: boolean;
  playful: boolean;
};

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/**
 * 軸を動かす。**端に近いほど動きにくく、端から戻るときは動きやすい。**
 *
 * なぜこれが要るか（ここが育成の一番大事なところ）:
 * 前は「positive なら温かさ +1.5」と一律に足していた。すると、
 * **ふつうに可愛がっているだけで35回ほどで100に張り付き、そこから先は何を話しても動かない。**
 * 長く育てた分身ほど全部の軸が振り切れて、**育てるほど他の子と見分けが付かなくなっていた**
 * （育成サービスとして、これは逆立ちしている）。
 *
 * そこで、残りの幅で割り引く。50のときは今までどおり、100に近いほど効かず、
 * 0に近いところからは倍の速さで戻る。
 *
 *   v=50 → 係数1.0（従来と同じ）   v=90 → 0.2   v=10 → 1.8（上げる場合）
 *
 * 結果として 0 や 100 には**漸近するだけで到達しない**。振り切れないので、
 * 軸の大小がいつまでも意味を持つ。放置で落ちた分も、戻りが速いので取り返せる。
 */
function nudge(value: number, delta: number): number {
  if (delta === 0) return value;
  const room = delta > 0 ? 100 - value : value;
  return clamp(value + delta * (room / 50));
}

/**
 * 1回のやり取り（インタラクション）を性格パラメータに反映する。
 * 変化量は意図的に小さくし、「じわじわ育つ」感触を出している。
 * バランス調整はこの関数の係数を変えるだけで完結するようにしてある。
 * 実際に効く量は、上の nudge が端との距離で割り引く。
 */
export function updatePersonality(
  current: PersonalityTraits,
  signal: InteractionSignal
): PersonalityTraits {
  const next: PersonalityTraits = { ...current };

  // 強調語や語数から推定した「感情の強さ」で変化量をスケールする（0.6倍〜1.4倍程度の範囲）。
  // 弱い相槌と「大好き！」のような強い表現とで、育ち方に差が出るようにするための重み。
  const intensity = 0.6 + 0.8 * (signal.sentimentIntensity ?? 0.5);

  if (signal.sentiment === "positive") {
    next.warmth = nudge(next.warmth, 1.5 * intensity);
    next.cheerfulness = nudge(next.cheerfulness, 1.2 * intensity);
    next.caution = nudge(next.caution, -0.5 * intensity);
  } else if (signal.sentiment === "negative") {
    next.caution = nudge(next.caution, 1.5 * intensity);
    next.cheerfulness = nudge(next.cheerfulness, -1 * intensity);
  }

  if (signal.topicNovelty > 0.6 || signal.askedQuestion) {
    next.curiosity = nudge(next.curiosity, 1.5);
  }

  if (signal.playful) {
    next.humor = nudge(next.humor, 1.5);
  }

  if (signal.messageLength > 80) {
    // じっくり長く話しかけてくれる相手には懐きやすくなる（＝自立心はやや下がる）
    next.warmth = nudge(next.warmth, 0.5);
    next.independence = nudge(next.independence, -0.3);
  } else if (signal.messageLength < 8) {
    // そっけないやり取りが続くと、マイペースになっていく
    next.independence = nudge(next.independence, 0.2);
  }

  if (signal.daysSinceLastVisit >= 3) {
    // 放置期間が長いほど、寂しさから慎重・マイペースになる（ネグレクト挙動）。
    //
    // **1回の再会で与える打撃を小さくした。** 前は最大で陽気さ −8。
    // 可愛がっている人の1往復が +1.2 なので、2週間の旅行から帰ってきただけで
    // 7往復ぶんが吹き飛んでいた。出張や入院で離れた人が、戻ってきた初回に
    // いちばん冷たい反応を受けることになる。**寂しがるのと、罰するのは別。**
    //
    // 上限も 10日ぶん から 7日ぶん に下げた。ひと月放置しても半月放置しても
    // 同じところで頭打ちになる（それ以上の差は、体験として意味が無い）。
    const neglect = Math.min(signal.daysSinceLastVisit - 2, 7);
    next.cheerfulness = nudge(next.cheerfulness, -neglect * 0.35);
    next.caution = nudge(next.caution, neglect * 0.28);
    next.independence = nudge(next.independence, neglect * 0.2);
  }

  return next;
}

export function describePersonality(p: PersonalityTraits): string {
  const level = (v: number) => (v >= 70 ? "高い" : v <= 30 ? "低い" : "中程度");
  return [
    `温かさ:${Math.round(p.warmth)}(${level(p.warmth)})`,
    `好奇心:${Math.round(p.curiosity)}(${level(p.curiosity)})`,
    `陽気さ:${Math.round(p.cheerfulness)}(${level(p.cheerfulness)})`,
    `慎重さ:${Math.round(p.caution)}(${level(p.caution)})`,
    `自立心:${Math.round(p.independence)}(${level(p.independence)})`,
    `ユーモア:${Math.round(p.humor)}(${level(p.humor)})`,
  ].join(" / ");
}

/** 支配的な特性から、将来の「進化分岐」の見た目・口調バリエーションに使う想定のタグを返す（拡張ポイント） */
export function dominantTrait(p: PersonalityTraits): keyof PersonalityTraits {
  return TRAIT_KEYS.reduce((max, key) => (p[key] > p[max] ? key : max), TRAIT_KEYS[0]);
}
