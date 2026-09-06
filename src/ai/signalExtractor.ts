import { InteractionSignal } from "./personality";

/**
 * MVP版のヒューリスティック抽出（キーワードマッチベース）。
 * モデル呼び出しを増やさずコストを抑えつつ、以下の点で精度を上げている:
 *  - 語彙の拡充（口語・ネットスラング・顔文字寄りの表現を追加）
 *  - ごく簡易な否定表現の考慮（「楽しくない」を肯定と誤判定しないようにする）
 *  - 強調表現による強度（sentimentIntensity）の算出
 *  - 疑問符が無くても「なんで」「教えて」等で好奇心シグナルを拾う
 *
 * 完全な構文解析ではなく、あくまで「多くの日常会話でそれなりに当たる」近似ロジック。
 * 将来的には、①SLM自体に一言で分類させる、②Vectorizeで話題の類似度から新規性を測る、
 * などへの置き換えを想定した差し替えポイント。
 */
const POSITIVE_WORDS = [
  "嬉しい", "うれしい", "楽しい", "たのしい", "好き", "すき", "大好き", "だいすき",
  "ありがとう", "感謝", "かわいい", "可愛い", "元気", "最高", "幸せ", "しあわせ",
  "癒される", "いいね", "良い", "よい", "面白い", "おもしろい", "助かる", "助かった",
];
const NEGATIVE_WORDS = [
  "嫌い", "きらい", "疲れた", "つかれた", "うざい", "最悪", "つまらない", "むかつく",
  "嫌だ", "いやだ", "悲しい", "かなしい", "辛い", "つらい", "むり", "無理", "怖い",
  "こわい", "さみしい", "寂しい", "イライラ", "腹立つ",
];
const NEGATION_MARKERS = ["ない", "なかった", "じゃない", "ではない", "わけじゃない", "とは限らない"];
const INTENSIFIERS = ["すごく", "とても", "めちゃ", "めっちゃ", "本当に", "ほんとに", "ほんとうに", "超", "かなり", "一番"];
const PLAYFUL_MARKERS = ["笑", "www", "ｗｗｗ", "！！", "笑笑", "www", "ワロタ", "www", "(^^)", "😂", "🤣", "😆"];
// 疑問符が無くても「気になっている」と読める表現（好奇心シグナル用）
const CURIOSITY_WORDS = ["なんで", "どうして", "なぜ", "教えて", "気になる", "知りたい", "って何", "とは？", "何それ", "なにそれ"];

function countHits(message: string, words: string[], negationCheck: boolean): number {
  let hits = 0;
  for (const w of words) {
    let idx = message.indexOf(w);
    while (idx !== -1) {
      if (negationCheck && isNegatedNearby(message, idx, w.length)) {
        // 否定されている場合はこの語をノーカウント（逆側の弱いシグナルとして別途扱う）
      } else {
        hits += 1;
      }
      idx = message.indexOf(w, idx + w.length);
    }
  }
  return hits;
}

function countNegatedHits(message: string, words: string[]): number {
  let hits = 0;
  for (const w of words) {
    let idx = message.indexOf(w);
    while (idx !== -1) {
      if (isNegatedNearby(message, idx, w.length)) hits += 1;
      idx = message.indexOf(w, idx + w.length);
    }
  }
  return hits;
}

/** 語の直後（数文字以内）に否定表現が来ていないかをざっくり見る簡易チェック */
function isNegatedNearby(message: string, matchIndex: number, wordLength: number): boolean {
  const windowEnd = Math.min(message.length, matchIndex + wordLength + 6);
  const after = message.slice(matchIndex + wordLength, windowEnd);
  return NEGATION_MARKERS.some((n) => after.startsWith(n) || after.includes(n));
}

export function analyzeMessage(message: string, daysSinceLastVisit: number): InteractionSignal {
  const positiveHits = countHits(message, POSITIVE_WORDS, true);
  const negativeHits = countHits(message, NEGATIVE_WORDS, true);
  // 「楽しくない」のように肯定語が否定されているケースは、弱いネガティブとして加算
  const negatedPositive = countNegatedHits(message, POSITIVE_WORDS);
  // 「嫌いじゃない」のように否定語が否定されているケースは、弱いポジティブとして加算
  const negatedNegative = countNegatedHits(message, NEGATIVE_WORDS);

  const positiveScore = positiveHits + negatedNegative * 0.6;
  const negativeScore = negativeHits + negatedPositive * 0.6;

  const sentiment: InteractionSignal["sentiment"] =
    positiveScore > negativeScore ? "positive" : negativeScore > positiveScore ? "negative" : "neutral";

  const intensifierBoost = INTENSIFIERS.some((w) => message.includes(w)) ? 1.4 : 1.0;
  const dominant = Math.max(positiveScore, negativeScore);
  // 0〜1に正規化。3語分くらいで頭打ちにして、極端な値になりすぎないようにする
  const sentimentIntensity = Math.min(1, (dominant / 3) * intensifierBoost);

  const playful = PLAYFUL_MARKERS.some((w) => message.includes(w));
  const askedQuestion =
    message.includes("？") || message.includes("?") || CURIOSITY_WORDS.some((w) => message.includes(w));

  return {
    messageLength: message.length,
    sentiment,
    sentimentIntensity,
    // 簡易版: 質問文・好奇心ワードは「新しい話題を掘り下げようとしている」とみなして新規性を高めに見積もる
    topicNovelty: askedQuestion ? 0.7 : 0.3,
    daysSinceLastVisit,
    askedQuestion,
    playful,
  };
}
