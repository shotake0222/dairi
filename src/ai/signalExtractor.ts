import { InteractionSignal } from "./personality";
import { extractTerms } from "../analysis/textMining";

/**
 * 1発言から「育て方の傾向」を読み取るヒューリスティック。
 *
 * AIを呼ばずに毎ターン回すことが前提なので、構文解析はしない。
 * 「多くの日常会話でそれなりに当たる」近似で十分な用途（性格パラメータを少しずつ動かす）に絞っている。
 *
 * 2026-09-13の見直しで変えたこと:
 *
 * 1. **話題の新規性を、実際に「初めて出てきた語か」で測るようにした。**
 *    それまでは「疑問符が付いていれば新規性0.7」という、質問かどうかだけの判定だった。
 *    これだと「今日も疲れた？」のような繰り返しの話題でも好奇心が上がってしまう。
 *    分身は既に「よく口にする語」を持っている（src/analysis/psychographics.ts）ので、
 *    それと突き合わせて、初めて出た語の割合を新規性とする。AI呼び出しは増えない。
 *
 * 2. **感情語を絵文字・顔文字まで広げ、強調の効き方を段階的にした。**
 *    「すごく楽しい」と「楽しい」が同じ強度なのは、育ち方の差として粗すぎた。
 *
 * 3. **playful の判定を、笑い表現に限定した。**
 *    以前は「！！」も playful に入れていたが、あれは強い感情であって冗談ではない。
 *    怒って「！！」と打った人のユーモア値が上がるのはおかしい。
 */

const POSITIVE_WORDS = [
  "嬉しい", "うれしい", "楽しい", "たのしい", "好き", "すき", "大好き", "だいすき",
  "ありがとう", "感謝", "かわいい", "可愛い", "元気", "最高", "幸せ", "しあわせ",
  "癒される", "いいね", "良い", "よい", "面白い", "おもしろい", "助かる", "助かった",
  "落ち着く", "安心", "うまくいった", "できた", "やった", "たのしみ", "楽しみ", "わくわく",
  "すっきり", "満足",
];
const NEGATIVE_WORDS = [
  "嫌い", "きらい", "疲れた", "つかれた", "うざい", "最悪", "つまらない", "むかつく",
  "嫌だ", "いやだ", "悲しい", "かなしい", "辛い", "つらい", "むり", "無理", "怖い",
  "こわい", "さみしい", "寂しい", "イライラ", "腹立つ",
  "しんどい", "だるい", "落ち込", "凹", "へこむ", "不安", "心配", "面倒", "めんどい", "めんどくさ",
  "痛い", "眠れない", "泣", "失敗", "後悔",
];

/** 絵文字は語より強い手がかりになることが多いので、別枠で重みを付ける。 */
const POSITIVE_EMOJI = ["😊", "😄", "😆", "🥰", "😍", "✨", "🎉", "💕", "❤️", "👍", "🙌"];
const NEGATIVE_EMOJI = ["😢", "😭", "😞", "😔", "😩", "😡", "💢", "🥺", "😰", "🙇"];

const NEGATION_MARKERS = ["ない", "なかった", "じゃない", "ではない", "わけじゃない", "とは限らない", "ません", "ませんでした"];

/** 強調の度合いを2段に分ける（「ちょっと」で弱まる場合も見る）。 */
const STRONG_INTENSIFIERS = ["めちゃくちゃ", "めっちゃ", "超", "死ぬほど", "本当に", "ほんとうに", "すごく", "とても", "一番", "最高に"];
const WEAK_INTENSIFIERS = ["ちょっと", "少し", "やや", "そこそこ", "まあまあ"];

/** 笑い・冗談の表現。強い感嘆（！！）はここに入れない（怒りでも出るため）。 */
const PLAYFUL_MARKERS = ["笑", "ｗ", "w", "ワロタ", "草", "(^^)", "(笑)", "😂", "🤣", "😆", "😜", "冗談", "なんてね"];

const CURIOSITY_WORDS = [
  "なんで", "どうして", "なぜ", "教えて", "気になる", "知りたい", "って何", "とは？", "何それ", "なにそれ",
  "どう思う", "どっち", "どれがいい", "おすすめ",
];

function countHits(message: string, words: string[], negationCheck: boolean): number {
  let hits = 0;
  for (const w of words) {
    let idx = message.indexOf(w);
    while (idx !== -1) {
      if (!(negationCheck && isNegatedNearby(message, idx, w.length))) hits += 1;
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

function countEmoji(message: string, emoji: string[]): number {
  let hits = 0;
  for (const e of emoji) {
    let idx = message.indexOf(e);
    while (idx !== -1) {
      hits += 1;
      idx = message.indexOf(e, idx + e.length);
    }
  }
  return hits;
}

/**
 * 話題の新しさを測る。
 *
 * knownTerms は、その分身がこれまでによく耳にしてきた語
 * （src/analysis/psychographics.ts が数えている）。
 * 渡されなければ、以前と同じ「質問なら高め」の粗い推定に戻る（既存の分身との互換のため）。
 */
export function estimateNovelty(message: string, knownTerms: string[] | undefined, askedQuestion: boolean): number {
  const terms = extractTerms(message);
  if (terms.length === 0) {
    // 語が取れない短い相槌。新しい話題ではない
    return askedQuestion ? 0.5 : 0.15;
  }
  if (!knownTerms || knownTerms.length === 0) {
    // まだ何も知らない相手。何を言われても新しいが、断定はしない
    return askedQuestion ? 0.75 : 0.6;
  }

  const known = new Set(knownTerms);
  const unseen = terms.filter((t) => !known.has(t)).length;
  const ratio = unseen / terms.length;

  // 質問は「掘り下げたい」の合図なので、少し上乗せする（ただし主役は語の新しさ）
  return Math.max(0, Math.min(1, ratio * 0.85 + (askedQuestion ? 0.15 : 0)));
}

export function analyzeMessage(
  message: string,
  daysSinceLastVisit: number,
  knownTerms?: string[]
): InteractionSignal {
  const positiveHits = countHits(message, POSITIVE_WORDS, true);
  const negativeHits = countHits(message, NEGATIVE_WORDS, true);
  // 「楽しくない」のように肯定語が否定されているケースは、弱いネガティブとして加算
  const negatedPositive = countNegatedHits(message, POSITIVE_WORDS);
  // 「嫌いじゃない」のように否定語が否定されているケースは、弱いポジティブとして加算
  const negatedNegative = countNegatedHits(message, NEGATIVE_WORDS);

  // 絵文字は語より確度が高いので、1つで語1.5個ぶんとして数える
  const positiveScore = positiveHits + negatedNegative * 0.6 + countEmoji(message, POSITIVE_EMOJI) * 1.5;
  const negativeScore = negativeHits + negatedPositive * 0.6 + countEmoji(message, NEGATIVE_EMOJI) * 1.5;

  const sentiment: InteractionSignal["sentiment"] =
    positiveScore > negativeScore ? "positive" : negativeScore > positiveScore ? "negative" : "neutral";

  let intensifierBoost = 1.0;
  if (STRONG_INTENSIFIERS.some((w) => message.includes(w))) intensifierBoost = 1.5;
  else if (WEAK_INTENSIFIERS.some((w) => message.includes(w))) intensifierBoost = 0.7;

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
    topicNovelty: estimateNovelty(message, knownTerms, askedQuestion),
    daysSinceLastVisit,
    askedQuestion,
    playful,
  };
}
