/**
 * かな漢字変換（視線入力・スイッチ入力のための補助）。
 *
 * なぜ必要か:
 * 視線で文字を選ぶ入力は、1文字あたり1〜2秒かかる。ひらがなだけで書くと読みづらく、
 * かといってブラウザのIMEは視線入力の画面からは呼び出せない（変換候補の選択自体が
 * 細かいタップを要求するので、視線では現実的でない）。
 *
 * そこで「ひらがなの文を丸ごと送って、自然な日本語に直してもらう」形にした。
 * 候補を選ばせるのではなく、1つの結果を返して、違ったら書き直してもらう。
 * 選択肢を減らすことが、この入力方法では正しい方向になる。
 *
 * 変換にAIを使うのはコストがかかるので、短い文だけに限り、
 * 変換なしでもそのまま送れるようにしてある（変換は補助であって、必須にしない）。
 */

import { ChatMessage, ModelEnv, SUMMARY_MODEL } from "./ai/modelPolicy";
import { LogContext, logInfo, logWarn } from "./lib/log";

/** 変換にかける文の長さの上限。長文を視線で打つことは想定していない。 */
export const MAX_IME_CHARS = 120;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** ひらがな・カタカナ・記号だけで構成されているか（既に漢字が入っていれば変換は不要）。 */
export function needsConversion(text: string): boolean {
  return !/[一-鿿]/.test(text) && /[ぁ-ゖ]/.test(text);
}

export async function handleIme(env: ModelEnv, body: { text?: unknown }, log: LogContext): Promise<Response> {
  const raw = typeof body.text === "string" ? body.text.trim() : "";
  if (!raw) return json({ error: "textが必要です" }, 400);
  if (raw.length > MAX_IME_CHARS) {
    return json({ error: `変換できるのは${MAX_IME_CHARS}文字までです`, text: raw }, 413);
  }
  if (!needsConversion(raw)) {
    // 既に漢字が入っている＝変換済みとみなし、AIを呼ばずに返す（無駄な課金を避ける）
    return json({ text: raw, converted: false });
  }

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `あなたは日本語のかな漢字変換器です。ひらがなで書かれた文を、自然な日本語の表記に直してください。

# ルール
- 意味を変えないでください。言い換え・要約・敬語化・丁寧語への変換はしないでください
- 足りない言葉を補わないでください。書かれていることだけを変換してください
- 句読点は、無いと読みにくい場合にだけ足してください
- 変換後の文だけを出力してください。説明・引用符・候補の列挙はしないでください`,
    },
    { role: "user", content: raw },
  ];

  const startedAt = Date.now();
  try {
    const response = (await env.AI.run(SUMMARY_MODEL, {
      messages,
      max_tokens: 200,
      temperature: 0.1,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { response?: string };

    // 前後の引用符や改行を落とす。モデルが「〜です。」と囲んでくることがある。
    const converted = (response?.response || "")
      .trim()
      .replace(/^["'「『]/, "")
      .replace(/["'」』]$/, "")
      .split("\n")[0]
      .trim();

    // 変換結果が元より極端に長い/短いときは、指示を無視して喋っている可能性が高い。
    // そういうときは変換せずに元の文を返す（勝手に別の文が送られる方が困る）。
    const plausible = converted.length > 0 && converted.length <= raw.length * 1.6 + 10;
    if (!plausible) {
      logWarn(log, "ime.implausible", { inLen: raw.length, outLen: converted.length });
      return json({ text: raw, converted: false });
    }

    logInfo(log, "ime.converted", { ms: Date.now() - startedAt, inLen: raw.length, outLen: converted.length });
    return json({ text: converted, converted: true });
  } catch (err) {
    logWarn(log, "ime.failed", { error: err instanceof Error ? err.message : String(err) });
    // 変換できなくても、ひらがなのまま送れる方が大事
    return json({ text: raw, converted: false });
  }
}
