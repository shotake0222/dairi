/**
 * 「これ見て」— カメラに写っているものを分身に見せる機能。
 *
 * 位置づけ:
 * 「かざして話す」モードでは、ユーザーはカメラを構えたまま分身に話しかけている。
 * そこで何かを見せたときに「見えているのに反応がない」と、その場に居る感じが一気に崩れる。
 * 一方で、映像を常時サーバーへ送るのはプライバシー的にもコスト的にも筋が悪い。
 *
 * そこで **ユーザーが明示的にボタンを押したときの1枚だけ** を送る設計にした。
 *
 * プライバシー上の約束（変更するときは privacy.html も必ず直すこと）:
 * - 画像は保存しない。AIに渡して説明文を得たら、その場で捨てる。
 * - 得られた説明文も保存しない。その1ターンのプロンプトに混ぜるだけで、記憶（Vectorize）には
 *   ユーザーの発言と分身の返答しか入らない。
 * - 人物が写っていても、容姿や個人を特定できる記述をさせない（プロンプトで明示的に禁じている）。
 * - ログには説明文を出さない（本文を残さないという全体方針と同じ）。
 */

import { VISION_MODEL } from "./ai/modelPolicy";
import { LogContext, logInfo, logWarn } from "./lib/log";

/** 受け付ける画像の上限。クライアントは短辺512px程度のJPEGに縮小してから送る想定。 */
export const MAX_IMAGE_BYTES = 600 * 1024;

export interface VisionEnv {
  AI: Ai;
}

const VISION_PROMPT = `この画像に写っているものを、日本語の短い1文で説明してください。
説明は「〜が写っている」の形にしてください。
人物が写っている場合は「人がいる」とだけ書き、顔立ち・服装・年齢・性別など個人を特定できることは書かないでください。
文字が読み取れる場合は、その文字を含めて構いません。
推測は書かず、はっきり見えるものだけを書いてください。`;

/**
 * 画像1枚の内容を短い日本語で説明させる。
 * 失敗しても null を返すだけで、呼び出し元は「見えなかった」として会話を続ける。
 */
export async function describeScene(
  env: VisionEnv,
  bytes: Uint8Array,
  log: LogContext
): Promise<string | null> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) {
    logWarn(log, "vision.rejected", { bytes: bytes.byteLength });
    return null;
  }

  const startedAt = Date.now();
  try {
    const result = (await env.AI.run(VISION_MODEL, {
      // このモデルの image はバイト値の配列を受け取る（base64文字列も受けるが、配列の方が確実）。
      image: Array.from(bytes),
      prompt: VISION_PROMPT,
      max_tokens: 120,
      temperature: 0.2,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { response?: string; description?: string };

    const text = (result?.response || result?.description || "").trim();
    // 本文はログに出さない（長さだけ記録して、動いているかの確認に使う）。
    logInfo(log, "vision.describe", {
      ok: Boolean(text),
      ms: Date.now() - startedAt,
      bytes: bytes.byteLength,
      chars: text.length,
    });
    if (!text) return null;
    // 説明が長いとプロンプトを圧迫するので、ここで頭打ちにする。
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch (err) {
    logWarn(log, "vision.failed", {
      ms: Date.now() - startedAt,
      bytes: bytes.byteLength,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** base64（data: プレフィックスの有無どちらでも可）をバイト列に戻す。壊れていれば null。 */
export function decodeBase64Image(input: string): Uint8Array | null {
  const raw = input.includes(",") ? input.slice(input.indexOf(",") + 1) : input;
  if (!raw) return null;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch (err) {
    return null;
  }
}
