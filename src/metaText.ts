/**
 * メタバースで、分身の言葉を**他人の画面に出す前に**整える。
 *
 * 分身どうしの会話は AI が生成した言葉だが、見知らぬ人（子どもを含む）の画面に出る。
 * プロンプトで禁じていても、念のため機械的に落とす:
 *   - URL・メールアドレス・電話番号らしき数字の並び（連絡先の交換の口にしない）
 *   - 改行・制御文字（吹き出しを崩さない）
 *   - 長すぎる言葉（60文字で切る）
 *   - 明らかに不適切な語（下の一覧。見つけたら、その言葉ごと出さない）
 */

const BLOCKED_WORDS = ["死ね", "殺す", "ころす", "しね", "バカ", "ばか", "アホ", "うざい", "きもい", "キモい", "セックス", "エロ"];

export const META_LINE_MAX = 60;

export function sanitizeMetaLine(raw: string): string {
  let text = String(raw || "");
  // eslint-disable-next-line no-control-regex
  text = text.replace(/[\u0000-\u001f\u007f]/g, " ");
  text = text.replace(/https?:\/\/\S+/gi, "");
  text = text.replace(/www\.\S+/gi, "");
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "");
  // 数字が7桁以上続く（区切り込み）＝電話番号・ID らしきもの
  text = text.replace(/(?:\d[\d\s\-ー－]{5,}\d)/g, "");
  text = text.replace(/[「」『』]/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (BLOCKED_WORDS.some((w) => text.includes(w))) return "";
  if (text.length > META_LINE_MAX) text = text.slice(0, META_LINE_MAX - 1) + "…";
  return text;
}

/** 持ち主が入力した「伝えたいこと」を、AI に渡す前に整える（これ自体は他人に出さない） */
export function sanitizeHint(raw: unknown): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}
