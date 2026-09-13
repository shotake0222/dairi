/**
 * セグメンテーション。
 *
 * 性格パラメータ・価値観・関心から、分身を人物像のグループへ分類する。
 *
 * 方式について:
 * k-meansのような教師なしクラスタリングは、データが貯まるまで意味のある塊にならず、
 * 出てきた塊に名前を付ける作業も結局人手になる。いまの規模では、
 * **意味の分かる軸で書いたルール**の方が、説明できる分だけ実用的だと判断した。
 * 各セグメントは「どういう人か」を言葉で説明できる状態にしてある
 * （BtoBで統計を出すなら、何を数えたのか説明できないと使ってもらえない）。
 *
 * 分類は必ずどれか1つに落ちる。該当が弱いときは confidence が低くなるだけで、
 * 「未分類」を作らない（未分類の山ができると統計として使えなくなるため）。
 */

import { PersonalityTraits } from "../ai/personality";
import { Psychographics } from "./psychographics";

export interface SegmentDefinition {
  id: string;
  label: string;
  /** どういう人たちか。管理画面とBtoB向けの説明にそのまま使う */
  description: string;
  /** 0〜1に正規化されない生スコア。最大のものが採用される */
  score: (input: SegmentInput) => number;
}

export interface SegmentInput {
  personality: PersonalityTraits;
  psychographics: Psychographics;
  /** 会話の総回数（浅い分身を「特徴あり」と誤判定しないために使う） */
  interactionCount: number;
}

export interface SegmentResult {
  id: string;
  label: string;
  /** 0〜100。低いときは「まだよく分かっていない」を意味する */
  confidence: number;
  /** 上位3つ（管理画面で分布の重なりを見るため） */
  runnersUp: Array<{ id: string; label: string; score: number }>;
}

const dev = (v: number) => v - 50;
const pos = (v: number) => Math.max(0, v);
const val = (p: Psychographics, axis: string) => (p.values[axis] ?? 50) - 50;
const interest = (p: Psychographics, topic: string) => p.interests[topic] ?? 0;

export const SEGMENTS: SegmentDefinition[] = [
  {
    id: "explorer",
    label: "探究者",
    description: "新しいことに触れるのが好きで、自分で調べて決めたい人。技術・学び・創作の話題が多い。",
    score: ({ personality, psychographics }) =>
      pos(dev(personality.curiosity)) * 1.2 +
      pos(val(psychographics, "stimulation")) +
      pos(val(psychographics, "selfDirection")) * 0.8 +
      (interest(psychographics, "技術") + interest(psychographics, "勉強")) * 0.3,
  },
  {
    id: "nurturer",
    label: "つなぐ人",
    description: "身近な人や生き物を気にかける人。家族・友人・ペット・食の話題が多く、会話も柔らかい。",
    score: ({ personality, psychographics }) =>
      pos(dev(personality.warmth)) * 1.2 +
      pos(val(psychographics, "benevolence")) * 1.2 +
      pos(-dev(personality.independence)) * 0.6 +
      (interest(psychographics, "人間関係") + interest(psychographics, "動物") + interest(psychographics, "食")) * 0.3,
  },
  {
    id: "achiever",
    label: "積み上げる人",
    description: "目標に向かって進めることを重視する人。仕事・勉強・お金の話題が多く、成果への言及が目立つ。",
    score: ({ personality, psychographics }) =>
      pos(val(psychographics, "achievement")) * 1.3 +
      pos(val(psychographics, "power")) * 0.6 +
      pos(dev(personality.independence)) * 0.5 +
      (interest(psychographics, "仕事") + interest(psychographics, "勉強") + interest(psychographics, "お金")) * 0.35,
  },
  {
    id: "enjoyer",
    label: "楽しむ人",
    description: "その時々の楽しさを大事にする人。エンタメ・推し活・食・旅行の話題が多く、テンションが高い。",
    score: ({ personality, psychographics }) =>
      pos(dev(personality.cheerfulness)) * 1.1 +
      pos(dev(personality.humor)) * 0.9 +
      pos(val(psychographics, "hedonism")) * 1.1 +
      (interest(psychographics, "エンタメ") + interest(psychographics, "旅行")) * 0.3,
  },
  {
    id: "settler",
    label: "整える人",
    description: "安定と落ち着きを大事にする人。生活・健康・慣れたやり方の話題が多く、変化には慎重。",
    score: ({ personality, psychographics }) =>
      pos(dev(personality.caution)) * 1.1 +
      pos(val(psychographics, "security")) * 1.2 +
      pos(val(psychographics, "tradition")) * 0.8 +
      interest(psychographics, "健康") * 0.35,
  },
  {
    id: "seeker",
    label: "寄りかかる人",
    description: "気持ちの揺れを言葉にすることが多い人。不安や疲れの話題が出やすく、聞いてもらう相手を求めている。",
    score: ({ personality, psychographics }) =>
      pos(-dev(personality.cheerfulness)) * 0.9 +
      pos(-dev(personality.independence)) * 1.1 +
      pos(dev(personality.caution)) * 0.5 +
      interest(psychographics, "気分") * 0.6,
  },
  {
    id: "quiet",
    label: "静かな人",
    description: "言葉数が少なく、淡々と付き合う人。特定の話題に偏らず、距離を保ったまま長く続く傾向。",
    score: ({ personality }) =>
      pos(dev(personality.independence)) * 0.9 + pos(-dev(personality.warmth)) * 0.7 + pos(-dev(personality.humor)) * 0.5,
  },
];

/**
 * 分類する。
 *
 * confidence は「最大スコアが2位からどれだけ離れているか」と「会話量」の両方から出す。
 * 5回しか話していない分身を confidence 90 で「探究者」と言い切っても、それは観測ではなく偶然なので、
 * 会話量が少ないうちは自動的に低く出るようにしてある。
 */
export function classifySegment(input: SegmentInput): SegmentResult {
  const scored = SEGMENTS.map((s) => ({ id: s.id, label: s.label, score: Math.max(0, s.score(input)) })).sort(
    (a, b) => b.score - a.score
  );

  const top = scored[0];
  const second = scored[1];
  const gap = top.score - (second?.score ?? 0);

  // 会話量による信頼の上限。20往復でようやく満額になる
  const volumeCap = Math.min(1, input.interactionCount / 20);
  // スコア差による確からしさ。差が20点開いたら十分に分かれているとみなす
  const separation = Math.min(1, gap / 20);
  const strength = Math.min(1, top.score / 40);

  const confidence = Math.round(volumeCap * (0.5 * separation + 0.5 * strength) * 100);

  return {
    id: top.id,
    label: top.label,
    confidence,
    runnersUp: scored.slice(0, 3).map((s) => ({ id: s.id, label: s.label, score: Math.round(s.score) })),
  };
}

export function segmentById(id: string): SegmentDefinition | undefined {
  return SEGMENTS.find((s) => s.id === id);
}
