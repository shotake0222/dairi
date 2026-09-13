/**
 * 「かざして話す」モードの実処理。
 *
 * どんな体験か:
 * スマホのカメラをかざすと、その映像の中に分身が立っている。マイクは開いたままで、
 * 画面を切り替えずにそのまま声で話しかけると、**カメラ映像を表示したまま**分身が動いて答える。
 *
 * 「その場限りの通話」（src/call.ts）との違いは、はっきり分けてある:
 *
 * |            | 通話（/call）        | かざして話す（/talk）      |
 * | ---------- | ------------------- | ------------------------ |
 * | カメラ      | 使わない             | 使う（表示したまま応答する） |
 * | 保存        | 一切しない            | 通常の会話と同じく保存する   |
 * | 性格への影響 | なし                 | あり（育つ）               |
 *
 * つまりこちらは「その場限り」ではない。分身と実際に会って話す、いちばん普通のモードとして扱う。
 * 保存する以上、処理は通常のチャットと同じ CharacterState.chat() を通す。
 * 話し方だけをモードで切り替える（プロンプトが変わる）。
 *
 * サーバーが返すのは文章だけでなく **演出スクリプト**（src/ai/actionScript.ts）。
 * 画面側はそれを順に実行して、撮像画像を表示したまま応答を出力する。
 */

import { CharacterState } from "./durable-objects/characterState";
import { buildActionScript } from "./ai/actionScript";
import { deriveVoiceProfile } from "./ai/voiceProfile";
import { describeScene, decodeBase64Image, MAX_IMAGE_BYTES } from "./vision";
import { LogContext, logInfo, logWarn } from "./lib/log";

export interface TalkEnv {
  AI: Ai;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

export interface TalkRequestBody {
  characterId?: string;
  message?: string;
  /** 「これ見て」を押したときだけ入ってくる、カメラ映像の静止画（base64）。保存はしない。 */
  image?: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleTalk(env: TalkEnv, body: TalkRequestBody, log: LogContext): Promise<Response> {
  const characterId = body.characterId;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!characterId || !message) {
    return json({ error: "characterId and message are required" }, 400);
  }

  // 「これ見て」で送られてきた1枚を、この場で説明文に変えて捨てる。
  // 画像そのものも説明文も保存せず、このターンのプロンプトにだけ混ぜる。
  let sceneDescription: string | undefined;
  if (typeof body.image === "string" && body.image.length > 0) {
    const bytes = decodeBase64Image(body.image);
    if (!bytes) {
      logWarn(log, "talk.image_decode_failed");
    } else if (bytes.byteLength > MAX_IMAGE_BYTES) {
      logWarn(log, "talk.image_too_large", { bytes: bytes.byteLength });
    } else {
      sceneDescription = (await describeScene(env, bytes, log)) ?? undefined;
    }
  }

  const stub = env.CHARACTER.getByName(characterId);
  const result = await stub.chat(message, { mode: "talk", sceneDescription });

  if (result.error || !result.reply) {
    // レート制限や空メッセージなど。画面側は同じ形で受け取れるようにしておく。
    return json({ error: result.error || "うまく返事ができませんでした" }, 429);
  }

  const script = buildActionScript(result.reply, result.personality);
  logInfo(log, "talk.turn", {
    characterId,
    saw: Boolean(sceneDescription),
    emotion: script.emotion,
    interactionCount: result.interactionCount,
  });

  return json({
    reply: result.reply,
    emotion: script.emotion,
    // 画面側はこの配列を上から実行するだけでよい（解釈できない要素は読み飛ばす前提）。
    script: script.steps,
    voice: result.voice ?? deriveVoiceProfile(characterId, result.personality),
    personality: result.personality,
    growthStage: result.growthStage,
    interactionCount: result.interactionCount,
    speechStyleLabel: result.speechStyleLabel,
    // 「見えたもの」は画面に短く出して、何を送ったのかユーザーが分かるようにする。
    saw: sceneDescription ?? null,
  });
}
