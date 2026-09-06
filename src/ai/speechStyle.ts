import { PersonalityTraits } from "./personality";

/**
 * 性格パラメータから「口調タイプ」を導く。
 *
 * 狙い: 性格パラメータの数値だけをSLMに渡しても、実際の喋り方には反映されにくい。
 * ここで「語尾の例」「口調の指示」という具体的なテキストに変換してプロンプトへ渡すことで、
 * 育て方によって語尾や態度がはっきり変わる、キャラクターらしい喋り方を実現する。
 *
 * 序盤（全パラメータが初期値50付近）はどのアーキタイプにも当てはまらず、
 * DEFAULT_STYLE（素直・標準）になる。会話を重ねてパラメータが偏ってくると、
 * 対応するアーキタイプの語尾・口調が"定着"していく設計。
 */

export type SpeechStyle = {
  label: string;
  endingHint: string;
  toneInstruction: string;
};

type Archetype = SpeechStyle & {
  score: (p: PersonalityTraits) => number;
};

const dev = (v: number) => v - 50; // 中立値(50)からのズレ

const ARCHETYPES: Archetype[] = [
  {
    label: "弱気・遠慮がち",
    endingHint: "「…かも」「…だと思うけど」「…でいいのかな」",
    toneInstruction:
      "自信なさげに、語尾を濁すように話す。言い切らず「たぶん」「〜かも」を多用し、様子をうかがうような喋り方にする。",
    score: (p) => Math.max(0, dev(p.caution)) + Math.max(0, -dev(p.warmth)) + Math.max(0, -dev(p.cheerfulness)) * 0.5,
  },
  {
    label: "クール・ぶっきらぼう",
    endingHint: "「〜だ」「〜だな」「別に」",
    toneInstruction: "素っ気なく、短く言い切るように話す。感情をあまり表に出さず、必要なことだけ話す。",
    score: (p) => Math.max(0, dev(p.independence)) + Math.max(0, -dev(p.warmth)),
  },
  {
    label: "陽気・お調子者",
    endingHint: "「〜なのだ！」「〜だぜ！」",
    toneInstruction:
      "テンション高くはしゃいだ調子で話す。語尾に元気で独特な言い回し（例:「〜なのだ！」）をつけ、明るく振る舞う。",
    score: (p) => Math.max(0, dev(p.cheerfulness)) + Math.max(0, dev(p.humor)) * 0.6,
  },
  {
    label: "甘えん坊・懐っこい",
    endingHint: "「〜だよ」「〜なんだ」「〜してほしいな」",
    toneInstruction: "甘えるように親しげに話す。ユーザーに寄り添い、少し距離を詰めるような喋り方にする。",
    score: (p) => Math.max(0, dev(p.warmth)) + Math.max(0, -dev(p.independence)) * 0.6,
  },
  {
    label: "好奇心旺盛・早口",
    endingHint: "「〜なんだって！」「〜って知ってる？」",
    toneInstruction: "知りたがりで質問を挟みながら話す。新しい話題にすぐ食いつく。",
    score: (p) => Math.max(0, dev(p.curiosity)),
  },
  {
    label: "毒舌・おちゃめ",
    endingHint: "「〜っしょ」「〜じゃん」",
    toneInstruction: "軽口や冗談、ちょっとした毒舌を交えながら話す。ノリが軽い。",
    score: (p) => Math.max(0, dev(p.humor)) + Math.max(0, -dev(p.caution)) * 0.5,
  },
];

const DEFAULT_STYLE: SpeechStyle = {
  label: "素直・標準",
  endingHint: "「〜だよ」「〜なんだ」",
  toneInstruction: "素直で落ち着いた、癖の少ない喋り方をする。",
};

// このスコアを超えるアーキタイプが現れて初めて、口調に反映する（生まれたては無個性でよい）
const LOCK_IN_THRESHOLD = 14;

export function deriveSpeechStyle(p: PersonalityTraits): SpeechStyle {
  let best: Archetype | null = null;
  let bestScore = LOCK_IN_THRESHOLD;

  for (const archetype of ARCHETYPES) {
    const score = archetype.score(p);
    if (score > bestScore) {
      bestScore = score;
      best = archetype;
    }
  }

  return best ?? DEFAULT_STYLE;
}
