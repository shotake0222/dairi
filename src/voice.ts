/**
 * 音声まわり（文字起こしと読み上げ）。
 *
 * 方針:
 * - 文字起こしはブラウザ標準（Web Speech API）を第一候補にし、**ここはフォールバック**。
 *   iOS Safariのように標準APIが不安定・非対応な環境では、録音した音声をここへ送る。
 * - 読み上げもブラウザ標準を既定にし、ここは「もっと自然な声で聞きたい」ときの選択肢。
 *   どちらもサーバー側はWorkers AIを呼ぶため課金が発生する。既定で常用しない理由はそれ。
 *
 * プライバシー上の重要事項:
 * 音声はCloudflareのAIに送られる。**利用規約・プライバシーポリシーでの明示が必要**であり、
 * 公開前に必ず整備すること（ROADMAP.md フェーズ5）。
 * ここでは音声そのものも文字起こし結果も一切保存しない（ログにも本文は出さない）。
 */

import { LogContext, logInfo, logWarn } from "./lib/log";

/** 文字起こしモデル。turboは速度と精度のバランスが良く、日本語も扱える。 */
const TRANSCRIBE_MODEL = "@cf/openai/whisper-large-v3-turbo";

/** 読み上げモデル。多言語対応で日本語の音声も生成できる。 */
const SPEECH_MODEL = "@cf/myshell-ai/melotts";

/** 受け付ける音声の上限（およそ1分程度の想定）。長すぎる音声はコストと遅延に直結する。 */
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;

/** 読み上げに渡す文字数の上限。 */
const MAX_SPEAK_CHARS = 300;

interface VoiceEnv {
  AI: Ai;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function base64FromBytes(bytes: Uint8Array): string {
  // btoa は引数の文字列長に上限があるため、分割して積む
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * 音声を文字起こしする。
 * リクエストボディは音声のバイト列そのもの（Content-Typeは audio/webm など）。
 */
export async function handleTranscribe(env: VoiceEnv, request: Request, log: LogContext): Promise<Response> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) {
    return json({ error: "音声データが空です" }, 400);
  }
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    return json({ error: "音声が長すぎます。短く区切って話しかけてね" }, 413);
  }

  const startedAt = Date.now();
  try {
    const result = (await env.AI.run(TRANSCRIBE_MODEL, {
      audio: base64FromBytes(new Uint8Array(buffer)),
      task: "transcribe",
      language: "ja",
      // 無音や環境音だけの区間を先に落とす。AIの無駄打ちと、幻聴のような誤認識を減らせる。
      vad_filter: true,
      // 無音判定を少し強めにして、「うーん」だけで反応してしまうのを抑える
      no_speech_threshold: 0.7,
      // 繰り返しの幻覚を抑制する
      condition_on_previous_text: false,
    })) as { text?: string };

    const text = (result?.text || "").trim();
    logInfo(log, "voice.transcribe", { ok: true, ms: Date.now() - startedAt, bytes: buffer.byteLength, chars: text.length });

    if (!text) {
      // 無音・雑音のみ。ここでクライアントにAI呼び出しをさせないことがコスト面でも重要。
      return json({ text: "", empty: true });
    }
    return json({ text });
  } catch (err) {
    logWarn(log, "voice.transcribe_failed", {
      ms: Date.now() - startedAt,
      bytes: buffer.byteLength,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "うまく聞き取れませんでした。もう一度話しかけてね" }, 502);
  }
}

/**
 * テキストを読み上げ音声に変換する。
 * 返すのは音声バイト列（audio/mpeg）。クライアントはそのまま再生できる。
 */
export async function handleSpeak(env: VoiceEnv, request: Request, log: LogContext): Promise<Response> {
  const body = await request.json<{ text?: string; lang?: string }>().catch(() => ({}) as { text?: string; lang?: string });
  const text = (body.text || "").trim();
  if (!text) return json({ error: "textが必要です" }, 400);
  if (text.length > MAX_SPEAK_CHARS) {
    return json({ error: `読み上げは${MAX_SPEAK_CHARS}文字までです` }, 413);
  }

  const startedAt = Date.now();
  try {
    const result = (await env.AI.run(SPEECH_MODEL, {
      prompt: text,
      lang: body.lang || "jp",
    })) as Uint8Array | { audio?: string } | ReadableStream;

    // モデルの戻り値はバイト列・base64・ストリームのいずれもありうるので、すべて受けられるようにする
    if (result instanceof Uint8Array) {
      logInfo(log, "voice.speak", { ok: true, ms: Date.now() - startedAt, chars: text.length, shape: "bytes" });
      return new Response(result, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }
    if (result && typeof (result as ReadableStream).getReader === "function") {
      logInfo(log, "voice.speak", { ok: true, ms: Date.now() - startedAt, chars: text.length, shape: "stream" });
      return new Response(result as ReadableStream, {
        headers: { "content-type": "audio/mpeg", "cache-control": "no-store" },
      });
    }
    const audioBase64 = (result as { audio?: string })?.audio;
    if (audioBase64) {
      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      logInfo(log, "voice.speak", { ok: true, ms: Date.now() - startedAt, chars: text.length, shape: "base64" });
      return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "no-store" } });
    }

    logWarn(log, "voice.speak_unexpected_shape", { ms: Date.now() - startedAt });
    return json({ error: "音声を生成できませんでした" }, 502);
  } catch (err) {
    logWarn(log, "voice.speak_failed", {
      ms: Date.now() - startedAt,
      chars: text.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "音声を生成できませんでした" }, 502);
  }
}
