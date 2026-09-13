/**
 * サイコグラフィック（価値観・関心・生活傾向）の抽出と、人格データへのマージ。
 *
 * 性格パラメータ（src/ai/personality.ts）との違い:
 *   - 性格パラメータは「分身がどう振る舞うか」。育て方の結果であり、演技の指示に使う。
 *   - サイコグラフィックは「その人が何を大事にしているか」。人物像の記述であり、
 *     分身の理解を深めるためと、セグメンテーション・統計のために使う。
 * 混ぜると、統計を取るために分身の性格をいじる、という本末転倒が起きるので、別々に持つ。
 *
 * 二段構えで取る:
 *   1. 毎ターン: 語の出現からの重み付け（無料・即時・粗い）
 *   2. 数ターンごと: AIによる価値観の推定（有料・遅い・意味が分かる）
 * どちらも指数移動平均で少しずつ動かす。1回の発言で人物像が塗り替わらないようにするため。
 */

import { ChatMessage, ModelEnv, SUMMARY_MODEL } from "../ai/modelPolicy";
import { logDetachedError, logDetachedWarn } from "../lib/log";
import { countTerms, topicWeights } from "./textMining";

/**
 * 価値観の軸。Schwartzの基本価値理論から、日本語の日常会話で判別できそうなものを8つ選んだ。
 * 心理尺度としての厳密さは主張しない（会話からの推定なので当然揺れる）。
 * セグメントを分けるための特徴量として使う、という位置づけ。
 */
export const VALUE_AXES = [
  "achievement", // 達成: 成果を出したい
  "benevolence", // 他者への思いやり: 身近な人を大切にしたい
  "hedonism", // 快楽: 楽しさ・心地よさを求める
  "security", // 安全: 安定と安心を求める
  "stimulation", // 刺激: 新しさ・変化を求める
  "selfDirection", // 自律: 自分で決めたい
  "tradition", // 伝統: 慣れ親しんだやり方を尊ぶ
  "power", // 影響力: 認められたい・主導したい
] as const;

export type ValueAxis = (typeof VALUE_AXES)[number];

export const VALUE_LABELS: Record<ValueAxis, string> = {
  achievement: "達成",
  benevolence: "思いやり",
  hedonism: "楽しさ",
  security: "安定",
  stimulation: "刺激",
  selfDirection: "自律",
  tradition: "伝統",
  power: "影響力",
};

export interface Psychographics {
  /** 0〜100。50が「特に強くも弱くもない」 */
  values: Record<string, number>;
  /** 話題カテゴリごとの関心の強さ（0〜100） */
  interests: Record<string, number>;
  /** よく口にする語（上位のみ。会話の本文そのものではない） */
  terms: string[];
  /** 何回分の観測を反映したか */
  sampleCount: number;
  updatedAt: number;
}

export function emptyPsychographics(): Psychographics {
  const values: Record<string, number> = {};
  for (const axis of VALUE_AXES) values[axis] = 50;
  return { values, interests: {}, terms: [], sampleCount: 0, updatedAt: 0 };
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/**
 * 指数移動平均で少しずつ寄せる。
 *
 * alpha を小さくしてあるのは、1回の会話で人物像が入れ替わらないようにするため。
 * 「今日はたまたま仕事の愚痴を言った」だけで仕事人間に分類されては困る。
 */
function blend(current: number, observed: number, alpha: number): number {
  return clamp(current + (observed - current) * alpha);
}

/**
 * 語の出現だけを使った、無料の更新。毎ターン呼べる。
 * ここで動かすのは関心（interests）とよく使う語だけで、価値観には触れない
 * （語の出現から価値観を決めつけるのは、いくらなんでも乱暴なため）。
 */
export function mergeTermSignals(prev: Psychographics, texts: string[]): Psychographics {
  const terms = countTerms(texts, 30);
  if (terms.length === 0) return prev;

  const weights = topicWeights(terms);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);

  const interests = { ...prev.interests };
  if (total > 0) {
    for (const topic of Object.keys({ ...interests, ...weights })) {
      // その回の会話に占める割合を0〜100に直してから寄せる
      const observed = ((weights[topic] ?? 0) / total) * 100;
      interests[topic] = Math.round(blend(interests[topic] ?? 0, observed, 0.25));
    }
  }

  // 重みの小さい話題を残し続けると、関心が薄く広がって特徴が消える
  const trimmed: Record<string, number> = {};
  for (const [topic, weight] of Object.entries(interests)) {
    if (weight >= 3) trimmed[topic] = weight;
  }

  return {
    ...prev,
    interests: trimmed,
    terms: terms.slice(0, 12).map((t) => t.term),
    sampleCount: prev.sampleCount + 1,
    updatedAt: Date.now(),
  };
}

/** AIに価値観を推定させるときの、返してほしいJSONの形。 */
interface ValueEstimate {
  values?: Partial<Record<ValueAxis, number>>;
}

/** モデルの出力からJSONを取り出す。前後に説明文が付いてくることがあるので、最初の { から最後の } までを見る。 */
export function parseValueJson(raw: string): ValueEstimate | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as ValueEstimate;
  } catch (err) {
    return null;
  }
}

/**
 * 直近の会話から価値観を推定し、既存の値へ少しずつ混ぜる。
 * 失敗したら prev をそのまま返す（推定できないことは、人物像を壊す理由にはならない）。
 */
export async function mergeValueEstimate(
  env: ModelEnv,
  prev: Psychographics,
  userTexts: string[]
): Promise<Psychographics> {
  const conversation = userTexts.filter((t) => t.trim()).slice(-12).join("\n");
  if (!conversation) return prev;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `あなたは、発言から話し手が大事にしていることを読み取る分析器です。
次の8つの軸について、0から100の整数で評価してください。50は「特に強くも弱くもない」です。

- achievement: 成果を出すこと、うまくやることを大事にしている
- benevolence: 身近な人を気にかけ、helpすることを大事にしている
- hedonism: 楽しさ、心地よさを大事にしている
- security: 安定していること、安心できることを大事にしている
- stimulation: 新しいこと、変化、刺激を求めている
- selfDirection: 自分で決めること、自分のやり方を大事にしている
- tradition: これまでのやり方、慣れ親しんだものを大事にしている
- power: 認められること、影響力を持つことを大事にしている

# ルール
- 判断できない軸は 50 にしてください。無理に差を付けないでください
- 発言に書かれていることだけから判断してください。想像で補わないでください
- 出力はJSONのみ。説明文は書かないでください
- 形式: {"values":{"achievement":50,"benevolence":50,"hedonism":50,"security":50,"stimulation":50,"selfDirection":50,"tradition":50,"power":50}}`,
    },
    { role: "user", content: `# 発言\n${conversation}\n\nJSONだけを出力してください。` },
  ];

  try {
    const response = (await env.AI.run(SUMMARY_MODEL, {
      messages,
      max_tokens: 300,
      temperature: 0.1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { response?: string };

    const parsed = parseValueJson(response?.response || "");
    if (!parsed?.values) {
      logDetachedWarn("psychographics.unparsable", {});
      return prev;
    }

    const values = { ...prev.values };
    let applied = 0;
    for (const axis of VALUE_AXES) {
      const observed = parsed.values[axis];
      if (typeof observed !== "number" || !Number.isFinite(observed)) continue;
      values[axis] = Math.round(blend(values[axis] ?? 50, clamp(observed), 0.3));
      applied++;
    }
    if (applied === 0) return prev;

    return { ...prev, values, updatedAt: Date.now() };
  } catch (err) {
    logDetachedError("psychographics.failed", err);
    return prev;
  }
}

/** 上位の関心を、読める形にして返す（プロンプトや管理画面で使う）。 */
export function topInterests(psy: Psychographics, limit = 4): string[] {
  return Object.entries(psy.interests)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([topic]) => topic);
}

/** 際立っている価値観だけを日本語で返す（50付近は「特徴なし」として出さない）。 */
export function describeValues(psy: Psychographics, threshold = 12): string {
  const notable = VALUE_AXES.map((axis) => ({ axis, v: psy.values[axis] ?? 50 }))
    .filter((x) => Math.abs(x.v - 50) >= threshold)
    .sort((a, b) => Math.abs(b.v - 50) - Math.abs(a.v - 50))
    .slice(0, 4)
    .map((x) => `${VALUE_LABELS[x.axis]}${x.v >= 50 ? "を重んじる" : "にはこだわらない"}`);
  return notable.join("、");
}
