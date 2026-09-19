/**
 * 「覚え書き」の蒸留。
 *
 * 会話が賢くならない最大の原因は、覚えている内容が薄いことだった。
 * 直近の生ログ（recentTurns）は文脈をつなぐには効くが、
 * 「この人は犬を飼っている」「夜勤の仕事をしている」といった**長く効く事実**は、
 * 数十ターン前に一度だけ言われて、そのまま流れていってしまう。
 *
 * そこで数ターンごとに、直近のやり取りと今の覚え書きをAIに渡し直し、
 * 「長く覚えておくべきことだけ」に絞った短い箇条書きへ書き換えさせる。
 * これは毎ターンではなく間隔を空けて行うので、コストは会話全体から見れば小さい。
 *
 * 設計上の要点:
 * - **上書きではなく書き換え**。前回の覚え書きも一緒に渡し、AIに統合させる。
 *   こうしないと、直近の話題だけが残って古い事実が消える。
 * - **推測を書かせない**。「たぶん学生」のような当て推量が積み上がると、
 *   分身が事実と違うことを自信満々に喋るようになる（これは体験として最悪）。
 * - **失敗しても会話は止めない**。null を返すだけで、呼び出し元は前回の覚え書きを使い続ける。
 */

import { ChatMessage, ModelEnv, SUMMARY_MODEL } from "./modelPolicy";
import { logDetachedError, logDetachedInfo, logDetachedWarn } from "../lib/log";

/** 何ターンごとに覚え書きを更新するか。短くすると賢くなるがAI呼び出しが増える。 */
export const REFLECTION_INTERVAL = 6;

/** 覚え書きの上限（文字数・行数）。プロンプトに毎回載るので、無制限に伸ばすと逆に応答が鈍る。 */
export const MAX_NOTES_CHARS = 600;
export const MAX_NOTES_LINES = 10;

/**
 * 本人が自分で書いた「土台」の上限。自動で覚えた分とは別枠で持つ。
 *
 * **なぜ別枠なのか。**
 * 覚え書きはAIが会話から蒸留して**書き換える**。上書きである以上、
 * 本人が書いた内容も、次の蒸留で消える可能性がある。
 * 実際「だいぶ会話しても空っぽ」という状態が起きていて、
 * 自動学習だけに頼ると、何も溜まらない期間がとても長い。
 *
 * 土台を別に持てば、最初に本人が5行書いた時点で分身はその人を知っている状態から始められ、
 * そのうえに会話からの学習が積み上がる。土台はAIからは触れない。
 */
export const MAX_SEED_LINES = 12;
export const MAX_SEED_CHARS = 700;

/** 「・」始まりの箇条書きに揃える（本人が手で書いたものも、AIの出力も同じ形にする）。 */
export function normalizeNoteLines(text: string, maxLines: number, maxChars: number): string {
  const lines = (text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => (line.startsWith("・") ? line : `・${line.replace(/^[-*•]\s*/, "")}`));
  const deduped: string[] = [];
  for (const line of lines) if (!deduped.includes(line)) deduped.push(line);
  return deduped.slice(0, maxLines).join("\n").slice(0, maxChars);
}

/**
 * 土台と、会話から覚えた分を1つにまとめる。
 * 土台が先（分身にとっての前提）。重複する行は落とす。
 */
export function mergeNotes(seed: string | undefined, learned: string | undefined): string {
  const seedLines = (seed || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const learnedLines = (learned || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const out = [...seedLines];
  for (const line of learnedLines) {
    if (!out.includes(line)) out.push(line);
  }
  return out.slice(0, MAX_SEED_LINES + MAX_NOTES_LINES).join("\n");
}

export interface ReflectionTurn {
  role: "user" | "character";
  text: string;
}

/** 覚え書きを更新すべきタイミングか判定する。 */
export function shouldReflect(interactionCount: number, lastReflectedAt: number | undefined): boolean {
  const last = lastReflectedAt ?? 0;
  return interactionCount - last >= REFLECTION_INTERVAL;
}

/** モデルの出力を、箇条書きだけの短いテキストに整形する。 */
export function normalizeNotes(raw: string): string {
  const lines = raw
    .replace(/```[a-zA-Z]*\n?/g, "")
    .split("\n")
    .map((line) => line.trim())
    // 「以下が覚え書きです」のような前置きを落とす（箇条書きの行だけを採る）
    .filter((line) => /^[-・*•・]/.test(line) || /^\d+[.)]/.test(line))
    .map((line) => line.replace(/^[-*•・]\s*/, "・").replace(/^\d+[.)]\s*/, "・"))
    .filter((line) => line.length > 1);

  const deduped: string[] = [];
  for (const line of lines) {
    if (!deduped.includes(line)) deduped.push(line);
  }

  let out = deduped.slice(0, MAX_NOTES_LINES).join("\n");
  if (out.length > MAX_NOTES_CHARS) out = out.slice(0, MAX_NOTES_CHARS);
  return out;
}

export async function distillProfileNotes(
  env: ModelEnv,
  params: { name: string; previousNotes: string; turns: ReflectionTurn[]; seedNotes?: string }
): Promise<string | null> {
  const conversation = params.turns
    .map((t) => `${t.role === "user" ? "ユーザー" : params.name}: ${t.text}`)
    .join("\n");
  if (!conversation.trim()) return null;

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `あなたは、あるキャラクターの「覚え書き」を管理する係です。
キャラクターが相手（ユーザー）のことを長く覚えていられるように、要点だけを箇条書きで整理します。

# ルール
- 書いてよいのは、**会話の中で実際に語られた事実**だけです。推測・想像・一般論は書かないでください
- 長く効くこと（名前、家族やペット、仕事や学校、好きなもの・苦手なもの、続けている習慣、大事な予定、体調）を優先してください
- あいさつ、その日の天気、一度きりの雑談は書かないでください
- 既存の覚え書きの内容は、否定された場合を除いて必ず残してください。新しい情報は統合し、矛盾があれば新しい方を採用してください
- 出力は「・」で始まる箇条書きのみ。前置きも説明も見出しも書かないでください
- 各行は40文字以内、全体で最大${MAX_NOTES_LINES}行
- **本人が書いた前提**として渡される内容は、あなたの出力に含めないでください（別に保持されており、重複します）。
  ただし、それと矛盾する内容も書かないでください`,
    },
    {
      role: "user",
      content: `${params.seedNotes ? `# 本人が書いた前提（変更も再掲もしないでください）\n${params.seedNotes}\n\n` : ""}# 現在の覚え書き
${params.previousNotes || "（まだ何もありません）"}

# 直近の会話
${conversation}

上のルールに従って、更新後の覚え書きだけを出力してください。`,
    },
  ];

  try {
    // 覚え書きは表現力より安定性が大事なので、温度を低くし、会話用の連鎖ではなく専用の軽いモデルを使う。
    const response = (await env.AI.run(SUMMARY_MODEL, {
      messages,
      max_tokens: 400,
      temperature: 0.2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { response?: string };

    const normalized = normalizeNotes(response?.response || "");
    if (!normalized) {
      // 箇条書きが1行も取れないのは、モデルが指示を無視した状態。前回の覚え書きを守るため何もしない。
      logDetachedWarn("reflection.empty_notes", {});
      return null;
    }
    logDetachedInfo("reflection.updated", { lines: normalized.split("\n").length, chars: normalized.length });
    return normalized;
  } catch (err) {
    logDetachedError("reflection.failed", err);
    return null;
  }
}
