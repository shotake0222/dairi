/**
 * パルスサーベイ — 会話の合間に、1問ずつ聞く。
 *
 * **なぜフォームではなく1問ずつなのか。**
 * 属性も価値観も、まとめて聞けば10分のアンケートになる。それは
 * 「アカウント登録不要ですぐ始められる」という入口の価値と真正面からぶつかるし、
 * 途中で閉じられた回答は1問分も残らない。1問ずつなら、
 * 途中でやめても答えた分だけが残る。
 *
 * **なぜ属性（デモグラフィック）と価値観（サイコグラフィック）を混ぜて聞くのか。**
 * 人格データとして売り物になるのは「30代・首都圏」ではなく、
 * 「30代・首都圏で、安定より刺激を選ぶ人」のほうだから。
 * 属性だけを集めても、それはただの名簿に近い。
 * ここでは両方を交互に聞き、同じ1つの人格データに束ねる。
 *
 * 価値観の設問は、会話からのAI推定（analysis/psychographics.ts）と同じ8軸に
 * そのまま載る形にしてある。推定と申告が同じ軸を指しているから、
 * 「答えてくれた軸は申告を優先し、それ以外は推定で埋める」という重ね方ができる。
 */

import { ProfileField, ProfileAnswers } from "./profile";
import { ValueAxis } from "../analysis/psychographics";

/** 価値観の設問の選択肢。答えると、その軸の値がこの点数に寄る。 */
export interface PsychoOption {
  label: string;
  score: number;
}

export interface PsychoQuestion {
  id: string;
  /** どの価値観の軸に効くか */
  axis: ValueAxis;
  label: string;
  /** なぜ聞くのかを、利用者にそのまま見せる文言 */
  why: string;
  options: PsychoOption[];
  /** 何回か会話したあとで聞く */
  askAfter: number;
}

/**
 * 組み込みの価値観の設問。
 *
 * 作り方の方針:
 * - 1問1軸。1つの問いで複数の軸を動かすと、あとから「なぜこの値なのか」を説明できなくなる。
 * - どちらを選んでも否定されないニ択〜四択にする。「正解がある」と感じた瞬間に、人は本音を書かない。
 * - 抽象的な価値語（「達成」「自律」）を直接聞かない。日常の場面で聞く。
 */
export const PSYCHO_QUESTIONS: PsychoQuestion[] = [
  {
    id: "psy_stimulation",
    axis: "stimulation",
    label: "はじめての店と、いつもの店。今日えらぶなら？",
    why: "新しいものへの構え方が分かると、分身の話の振り方が変わります",
    options: [
      { label: "絶対はじめての店", score: 92 },
      { label: "どちらかといえば新しい方", score: 68 },
      { label: "どちらかといえばいつもの方", score: 34 },
      { label: "ぜったいいつもの店", score: 10 },
    ],
    askAfter: 4,
  },
  {
    id: "psy_achievement",
    axis: "achievement",
    label: "うまくいった日。いちばん近いのは？",
    why: "何を「うまくいった」と感じるかは、その人らしさそのものです",
    options: [
      { label: "結果を出せた日", score: 90 },
      { label: "人に喜んでもらえた日", score: 45 },
      { label: "自分のペースで過ごせた日", score: 30 },
      { label: "何も起きなかった日", score: 15 },
    ],
    askAfter: 7,
  },
  {
    id: "psy_benevolence",
    axis: "benevolence",
    label: "友だちが落ち込んでいると聞いたら？",
    why: "人との距離の取り方に合わせて、分身の寄り添い方を決めます",
    options: [
      { label: "すぐ連絡して会いに行く", score: 95 },
      { label: "連絡はするが、そっとしておく", score: 70 },
      { label: "向こうから言ってくるまで待つ", score: 40 },
      { label: "気にはなるが、特に何もしない", score: 18 },
    ],
    askAfter: 10,
  },
  {
    id: "psy_security",
    axis: "security",
    label: "来月の予定。どちらが落ち着きますか？",
    why: "予定の埋め方は、安心の作り方の違いです",
    options: [
      { label: "だいたい埋まっている", score: 88 },
      { label: "半分くらい決まっている", score: 60 },
      { label: "ほとんど白紙", score: 28 },
      { label: "決めない方が気が楽", score: 10 },
    ],
    askAfter: 13,
  },
  {
    id: "psy_selfDirection",
    axis: "selfDirection",
    label: "やり方が決まっている仕事と、自分で決められる仕事。",
    why: "任されたいのか、任せたいのか。分身の提案の仕方が変わります",
    options: [
      { label: "自分で決めたい", score: 92 },
      { label: "どちらかといえば自分で", score: 68 },
      { label: "どちらかといえば決まっている方", score: 34 },
      { label: "決まっている方が助かる", score: 12 },
    ],
    askAfter: 16,
  },
  {
    id: "psy_hedonism",
    axis: "hedonism",
    label: "急に3時間空いたら、まず何を考えますか？",
    why: "余白の使い方に、その人の楽しみ方が出ます",
    options: [
      { label: "とにかく楽しいことをする", score: 90 },
      { label: "前からやりたかったことをする", score: 62 },
      { label: "たまっている用事を片づける", score: 30 },
      { label: "何もしないで休む", score: 45 },
    ],
    askAfter: 19,
  },
  {
    id: "psy_tradition",
    axis: "tradition",
    label: "昔からのやり方について、近いのは？",
    why: "変えたい人と、守りたい人。分身の言葉づかいの土台になります",
    options: [
      { label: "理由があるから続いている", score: 88 },
      { label: "良いところは残したい", score: 65 },
      { label: "だいたいは変えていい", score: 32 },
      { label: "古いやり方にこだわりはない", score: 12 },
    ],
    askAfter: 22,
  },
  {
    id: "psy_power",
    axis: "power",
    label: "何人かで何かを決めるとき、あなたは？",
    why: "場の中での立ち位置に合わせて、分身の出方を決めます",
    options: [
      { label: "自分が引っぱることが多い", score: 90 },
      { label: "意見は言うが、決めるのは任せる", score: 58 },
      { label: "だいたい流れに合わせる", score: 28 },
      { label: "決まったことに従うのが楽", score: 12 },
    ],
    askAfter: 25,
  },
];

const PSYCHO_BY_ID = new Map(PSYCHO_QUESTIONS.map((q) => [q.id, q]));

export function psychoQuestionById(id: string, extra: PsychoQuestion[] = []): PsychoQuestion | null {
  for (const q of extra) if (q.id === id) return q;
  return PSYCHO_BY_ID.get(id) ?? null;
}

/** 画面に渡す形。属性と価値観のどちらでも同じ形で扱えるようにしてある。 */
export interface SurveyItem {
  id: string;
  kind: "demographic" | "psychographic";
  label: string;
  why: string;
  type: "single" | "multi";
  options: string[];
  maxSelections?: number;
}

export interface SurveyState {
  answers: ProfileAnswers;
  /** 価値観の設問で、すでに答えたもののID */
  psychoAnswered: string[];
  /** 「あとで」と言われたもの。同じセッションでは二度出さない */
  skipped: string[];
  declinedAll?: boolean;
  interactionCount: number;
}

export function toItem(field: ProfileField): SurveyItem {
  return {
    id: field.key,
    kind: "demographic",
    label: field.label,
    why: field.why,
    type: field.type,
    options: field.options,
    maxSelections: field.maxSelections,
  };
}

export function psychoToItem(q: PsychoQuestion): SurveyItem {
  return {
    id: q.id,
    kind: "psychographic",
    label: q.label,
    why: q.why,
    type: "single",
    options: q.options.map((o) => o.label),
  };
}

/**
 * 次に聞く1問を選ぶ。
 *
 * 属性と価値観を**交互に**出す。片方に寄せると、
 * 「年代」「性別」「地域」…と続いて登録フォームの尋問のようになるか、
 * 逆に価値観ばかりで心理テストのようになる。交互だと、
 * 「知ってもらっている」感じのまま続けられる。
 */
export function nextSurveyItem(
  fields: ProfileField[],
  psycho: PsychoQuestion[],
  state: SurveyState
): SurveyItem | null {
  if (state.declinedAll) return null;
  const skipped = new Set(state.skipped);

  const nextDemographic = fields.find(
    (f) =>
      (state.answers[f.key]?.length ?? 0) === 0 &&
      !skipped.has(f.key) &&
      state.interactionCount >= f.askAfter
  );
  const answeredPsycho = new Set(state.psychoAnswered);
  const nextPsycho = psycho.find(
    (q) => !answeredPsycho.has(q.id) && !skipped.has(q.id) && state.interactionCount >= q.askAfter
  );

  if (!nextDemographic) return nextPsycho ? psychoToItem(nextPsycho) : null;
  if (!nextPsycho) return toItem(nextDemographic);

  // 交互に出す。答えた総数が偶数なら属性、奇数なら価値観から。
  const answeredCount = Object.keys(state.answers).length + state.psychoAnswered.length;
  return answeredCount % 2 === 0 ? toItem(nextDemographic) : psychoToItem(nextPsycho);
}

/**
 * 人格データの「厚み」。0〜100。
 *
 * 何のための数字か: この分身のデータが、他所で人格として動かせる水準に達しているかどうかを、
 * 本人にも運営にも同じ基準で見せるため。出品の可否や、法人提供時の品質の目安にも使う。
 *
 * 会話量だけで測らないのは、たくさん喋っていても「誰なのか」が分からない分身があるため。
 * 逆に属性だけ埋めても人格にはならないので、4つの材料を別々に数え、合計で見る。
 */
export interface DepthInput {
  interactionCount: number;
  profileAnswered: number;
  profileTotal: number;
  psychoAnswered: number;
  psychoTotal: number;
  memoryCount: number;
}

export interface DepthResult {
  score: number;
  parts: { label: string; score: number; max: number; hint: string }[];
  /** 出品・提供に足る水準か */
  sellable: boolean;
}

const SELLABLE_THRESHOLD = 60;

export function personaDepth(input: DepthInput): DepthResult {
  const ratio = (v: number, max: number) => Math.max(0, Math.min(1, max > 0 ? v / max : 0));

  const conversation = Math.round(ratio(input.interactionCount, 60) * 40);
  const profile = Math.round(ratio(input.profileAnswered, Math.max(1, input.profileTotal)) * 25);
  const values = Math.round(ratio(input.psychoAnswered, Math.max(1, input.psychoTotal)) * 20);
  const memory = Math.round(ratio(input.memoryCount, 40) * 15);
  const score = conversation + profile + values + memory;

  return {
    score,
    sellable: score >= SELLABLE_THRESHOLD,
    parts: [
      { label: "会話の量", score: conversation, max: 40, hint: "話しかけるほど、口調と記憶が厚くなります" },
      { label: "あなたのこと", score: profile, max: 25, hint: "属性の設問に答えると上がります" },
      { label: "価値観", score: values, max: 20, hint: "価値観の設問に答えると上がります" },
      { label: "覚えていること", score: memory, max: 15, hint: "会話の中で覚えた事柄の数です" },
    ],
  };
}

export const PERSONA_SELLABLE_THRESHOLD = SELLABLE_THRESHOLD;
