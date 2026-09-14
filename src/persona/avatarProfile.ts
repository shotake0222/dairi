/**
 * 身体のためのパラメータ — メタバースのアバターと、フィジカルAIに載せるための層。
 *
 * **なぜ必要か。**
 * 人格カードには性格の数値も価値観の数値も入っているが、これまで持ち出せる形は
 * 「システムプロンプト1枚」しかなかった。文章で渡す前提の作りなので、
 *   - LLMを常時呼べない機器（ロボット・スマートスピーカー）では何も使えない
 *   - メタバースのアバターに「どう動くか」を渡せない
 * という穴があった。人格の大部分は、実は言葉ではなく**間・距離・目線・身振り**に出る。
 * そこを数値で渡せなければ、身体を持たせた瞬間に「別人」になる。
 *
 * **なぜ性格と価値観の両方から作るのか。**
 * 性格（6軸）は分身の振る舞い、価値観（8軸）は育てた本人の人物像。
 * 動きの速さや目線は前者に、「何を先に提案するか」は後者に効く。
 * どちらか片方だと、動きは似ているのに判断が違う（またはその逆）ちぐはぐな身体になる。
 *
 * 対応づけの数字に厳密な根拠は無い。実機で見ながら調整する前提の初期値で、
 * ここを1箇所に集めてあるのは、**調整の跡が1ファイルに残るようにする**ため。
 */

import { PersonalityTraits } from "../ai/personality";
import { VALUE_AXES, ValueAxis, VALUE_LABELS } from "../analysis/psychographics";

export interface AvatarMotion {
  /** 動きの大きさと速さ（0〜100） */
  energy: number;
  /** 身振りの頻度（0〜100） */
  gestureRate: number;
  /** 待機中の揺らぎ。0だと置物に見える（0〜100） */
  idleVariance: number;
  /** 話しかけられてから動き出すまでの間（ミリ秒）。慎重な子ほど長い */
  responseDelayMs: number;
  /** 目線を合わせ続ける長さ（ミリ秒）。長すぎると圧、短すぎると上の空に見える */
  gazeHoldMs: number;
  /** 姿勢の開き（0〜100）。低いと縮こまって見える */
  postureOpenness: number;
}

export interface AvatarProxemics {
  /** 相手との心地よい距離（メートル）。ロボットが近づいてよい距離 */
  comfortableDistanceM: number;
  /** 近づく速さ（メートル毎秒） */
  approachSpeedMps: number;
}

export interface AvatarExpression {
  /** 何もしていないときの口角（0〜100） */
  baselineSmile: number;
  /** まばたきの回数（毎分） */
  blinkRatePerMin: number;
}

/**
 * 振る舞いの方針。
 *
 * `code` は機械が分岐するための固定の識別子で、**訳しても変えないこと**。
 * `behavior` は人とLLMが読む日本語。2つ持っているのは、
 * LLMに渡すときは文章が要り、ルールで動く機器には識別子が要るため。
 */
export interface AvatarPolicy {
  axis: ValueAxis;
  direction: "high" | "low";
  code: string;
  behavior: string;
}

export interface AvatarProfile {
  motion: AvatarMotion;
  proxemics: AvatarProxemics;
  expression: AvatarExpression;
  policy: AvatarPolicy[];
}

const clamp = (v: number, min = 0, max = 100) => Math.max(min, Math.min(max, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * 価値観の軸ごとの、振る舞いの方針。
 * 「その軸が高い人／低い人は、身体を持ったときに何が違って見えるか」で書いている。
 * 数値をそのまま渡してもモデルも機器も使えないので、**行動に翻訳して**渡すのが要点。
 */
const POLICY_TABLE: Record<ValueAxis, { high: [string, string]; low: [string, string] }> = {
  stimulation: {
    high: ["prefer_novel_options", "提案するときは、定番より先に、やったことがない選択肢を出す"],
    low: ["prefer_familiar_options", "提案するときは、いつものやり方・慣れた選択肢から出す"],
  },
  security: {
    high: ["confirm_before_change", "予定や手順が変わるときは、先に確認してから動く"],
    low: ["tolerate_open_plans", "決まっていないことを、無理に決めようとしない"],
  },
  benevolence: {
    high: ["notice_others_first", "相手の様子の変化に、用件より先に触れる"],
    low: ["respect_distance", "踏み込みすぎず、聞かれてから答える"],
  },
  achievement: {
    high: ["track_progress", "話に出たことの結果や進み具合を、あとから聞き返す"],
    low: ["avoid_pushing_goals", "成果や達成を促す言い方をしない"],
  },
  selfDirection: {
    high: ["offer_choices_not_answers", "答えを1つに絞らず、選べる形で出す"],
    low: ["give_one_clear_suggestion", "迷わせないよう、はっきり1つを勧める"],
  },
  power: {
    high: ["take_initiative", "会話が止まったら、自分から次の話題や提案を出す"],
    low: ["follow_the_lead", "相手が決めるのを待ち、決まったことに沿って動く"],
  },
  tradition: {
    high: ["honor_routine", "続けてきた習慣や記念日に、こちらから触れる"],
    low: ["suggest_updates", "やり方を変える提案を、遠慮せずに出す"],
  },
  hedonism: {
    high: ["prioritize_enjoyment", "重い話が続いたら、軽い話や楽しみの話に寄せる"],
    low: ["stay_on_task", "用件が済むまで、話を広げすぎない"],
  },
};

/** 際立っている軸だけを方針に落とす。50付近は「特徴なし」として何も出さない。 */
export function derivePolicy(values: Record<string, number>, threshold = 15): AvatarPolicy[] {
  const policies: AvatarPolicy[] = [];
  for (const axis of VALUE_AXES) {
    const v = values[axis];
    if (typeof v !== "number") continue;
    if (Math.abs(v - 50) < threshold) continue;
    const direction = v >= 50 ? "high" : "low";
    const [code, behavior] = POLICY_TABLE[axis][direction];
    policies.push({ axis, direction, code, behavior });
  }
  // 強く出ている軸から並べる。載せ先が数を絞るときは、上から採ればよい
  return policies.sort((a, b) => Math.abs((values[b.axis] ?? 50) - 50) - Math.abs((values[a.axis] ?? 50) - 50));
}

export function deriveAvatarProfile(
  personality: PersonalityTraits,
  values: Record<string, number> = {}
): AvatarProfile {
  const v = (axis: ValueAxis) => values[axis] ?? 50;

  const energy = clamp(personality.cheerfulness * 0.5 + v("hedonism") * 0.3 + v("stimulation") * 0.2);
  const gestureRate = clamp(personality.humor * 0.4 + personality.cheerfulness * 0.3 + v("power") * 0.3);
  const idleVariance = clamp(personality.curiosity * 0.5 + v("stimulation") * 0.5);

  return {
    motion: {
      energy: Math.round(energy),
      gestureRate: Math.round(gestureRate),
      idleVariance: Math.round(idleVariance),
      // 慎重な子ほど、返す前に一拍おく。0.25〜1.05秒
      responseDelayMs: Math.round(250 + personality.caution * 8),
      // 思いやりが強いほど目を合わせ続け、慎重さが強いほど早く外す
      gazeHoldMs: Math.round(clamp(800 + v("benevolence") * 12 - personality.caution * 4, 400, 2600)),
      postureOpenness: Math.round(clamp(personality.warmth * 0.6 + v("power") * 0.4)),
    },
    proxemics: {
      // 温かいほど近く、慎重なほど遠い。0.8〜1.8mの範囲に収める
      comfortableDistanceM: round1(clamp(1.5 - personality.warmth / 200 + personality.caution / 250, 0.8, 1.8)),
      approachSpeedMps: round1(clamp(0.35 + energy / 250, 0.2, 0.9)),
    },
    expression: {
      baselineSmile: Math.round(clamp(personality.warmth * 0.5 + personality.cheerfulness * 0.5)),
      blinkRatePerMin: Math.round(clamp(14 + personality.caution / 10, 8, 30)),
    },
    policy: derivePolicy(values),
  };
}

/** 価値観を、そのまま人に読める1行にする（プロンプトと管理画面で使う）。 */
export function describeValueAxis(axis: ValueAxis, value: number): string {
  return `${VALUE_LABELS[axis]}: ${Math.round(value)}`;
}
