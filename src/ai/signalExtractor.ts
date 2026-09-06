import { InteractionSignal } from "./personality";

/**
 * MVP版の簡易ヒューリスティック抽出。
 * 将来的には、①SLM自体に一言で分類させる、②Vectorizeで話題の類似度から新規性を測る、
 * などに置き換えることを想定した差し替えポイント。
 */
const POSITIVE_WORDS = ["嬉しい", "うれしい", "楽しい", "たのしい", "好き", "すき", "ありがとう", "かわいい", "元気", "最高"];
const NEGATIVE_WORDS = ["嫌い", "きらい", "疲れた", "つかれた", "うざい", "最悪", "つまらない", "むかつく", "嫌だ"];
const PLAYFUL_MARKERS = ["笑", "www", "ｗｗｗ", "！！", "笑笑", "www"];

export function analyzeMessage(message: string, daysSinceLastVisit: number): InteractionSignal {
  const positive = POSITIVE_WORDS.some((w) => message.includes(w));
  const negative = NEGATIVE_WORDS.some((w) => message.includes(w));
  const playful = PLAYFUL_MARKERS.some((w) => message.includes(w));
  const askedQuestion = message.includes("？") || message.includes("?");

  return {
    messageLength: message.length,
    sentiment: positive ? "positive" : negative ? "negative" : "neutral",
    // 簡易版: 質問文は「新しい話題を掘り下げようとしている」とみなして新規性を高めに見積もる
    topicNovelty: askedQuestion ? 0.7 : 0.3,
    daysSinceLastVisit,
    askedQuestion,
    playful,
  };
}
