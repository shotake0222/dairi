/**
 * 「その場限りの通話」モードの実処理。
 *
 * 設計の要点（ここが崩れると機能の意味が無くなるので、変更時は必ず読むこと）:
 *
 * 1. **何も保存しない**。Durable Objectは `beginEphemeralTurn()` による読み取りだけに使い、
 *    性格更新・記憶保存・やり取り回数・履歴・最終訪問日時のいずれも書き換えない。
 *    通常の `chat()` に「保存しないフラグ」を足す方式を採らなかったのは、あちらが
 *    保存処理の塊であり、条件分岐を1つ足し忘れるだけで約束が破れるため。入口ごと分けている。
 *
 * 2. **会話の文脈はクライアントが持つ**。サーバーに履歴を置かないので、その通話中のやり取りは
 *    ブラウザのメモリ上にだけ存在し、送信のたびに一緒に送られてくる。画面を閉じれば消える。
 *    無制限に送られるとコストが膨らむため、ここで件数と文字数を切り詰める。
 *
 * 3. **記憶は読むだけ**。長期記憶（Vectorize）は参照する。読まないと「自分の分身」ではなく
 *    ただの汎用AIになってしまうため。読み取りは何も残さないので約束とは矛盾しない。
 *
 * 4. **応答はストリーミング**。待ち時間が沈黙になるのを避けるため、生成された端から流す。
 */

import { CharacterState } from "./durable-objects/characterState";
import { buildCallPrompt } from "./ai/promptBuilder";
import { retrieveRelevantMemories } from "./ai/memory";
import { chatModelChain, contextBudgetFor } from "./ai/modelPolicy";
import { LogContext, logInfo, logWarn, tolerate } from "./lib/log";

export interface CallTurn {
  role: "user" | "character";
  text: string;
}

/** 1回の通話でサーバーに送り返せる履歴の上限（コストと遅延の歯止め）。 */
const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_CHARS = 2000;

export interface CallEnv {
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
  CHARACTER: DurableObjectNamespace<CharacterState>;
  /** 会話モデルの上書き（src/ai/modelPolicy.ts 参照）。 */
  CHAT_MODEL?: string;
}

/** クライアントから届いた履歴を、信用せずに切り詰める。 */
export function sanitizeHistory(raw: unknown): CallTurn[] {
  if (!Array.isArray(raw)) return [];
  const turns: CallTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const role = (item as { role?: unknown }).role;
    const text = (item as { text?: unknown }).text;
    if ((role !== "user" && role !== "character") || typeof text !== "string") continue;
    const trimmed = text.trim();
    if (!trimmed) continue;
    turns.push({ role, text: trimmed });
  }

  // 直近から遡って、件数と総文字数の両方が上限に収まる範囲だけを残す
  const recent = turns.slice(-MAX_HISTORY_TURNS);
  let total = 0;
  const kept: CallTurn[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    total += recent[i].text.length;
    if (total > MAX_HISTORY_CHARS) break;
    kept.unshift(recent[i]);
  }
  return kept;
}

function sseEvent(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Workers AI のストリーム応答（SSE）を、こちらの形式に変換して流す。
 *
 * 変換している理由は、クライアントをWorkers AIのレスポンス形式に依存させないため。
 * 将来モデルや提供元を差し替えても、画面側は `{delta}` と `{done}` だけ見ていればよくなる。
 */
function transformAiStream(aiStream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let full = "";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = aiStream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSEは空行区切り。行単位で "data: ..." を拾う。
          const chunks = buffer.split("\n");
          buffer = chunks.pop() ?? "";
          for (const line of chunks) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const body = trimmed.slice(5).trim();
            if (!body || body === "[DONE]") continue;
            try {
              const parsed = JSON.parse(body) as { response?: string };
              if (parsed.response) {
                full += parsed.response;
                controller.enqueue(encoder.encode(sseEvent({ delta: parsed.response })));
              }
            } catch (err) {
              // 途中で切れた行は次のチャンクと連結されるので、ここでは無視してよい
            }
          }
        }

        if (!full) {
          // モデルが何も返さなかった場合でも、画面が沈黙したままにならないようにする
          controller.enqueue(encoder.encode(sseEvent({ delta: "……（うまく言葉が出てこなかったみたい）" })));
        }
        controller.enqueue(encoder.encode(sseEvent({ done: true })));
      } catch (err) {
        controller.enqueue(
          encoder.encode(sseEvent({ delta: "（ごめん、うまく聞き取れなかったみたい）", done: true }))
        );
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      // プロキシによるバッファリングを抑止する（これが無いと最後にまとめて届くことがある）
      "x-accel-buffering": "no",
    },
  });
}

/** エラーを1回のSSEイベントとして返す（画面側の分岐を1本化するため、HTTPは200のまま流す）。 */
function sseError(message: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(sseEvent({ error: message, done: true })));
      controller.close();
    },
  });
  return sseResponse(stream);
}

export interface CallRequestBody {
  characterId?: string;
  message?: string;
  history?: unknown;
  /** 長期記憶を参照するか（既定は参照する）。参照しても何も書き込まない。 */
  recall?: boolean;
}

/**
 * その場限りの通話の1ターン分を処理し、応答をSSEで流す。
 * 呼び出し側（index.ts）はこの戻り値をそのまま返せばよい。
 */
export async function handleCallStream(
  env: CallEnv,
  body: CallRequestBody,
  log: LogContext
): Promise<Response> {
  const characterId = body.characterId;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!characterId || !message) {
    return sseError("characterId and message are required");
  }

  const stub = env.CHARACTER.getByName(characterId);
  // ここが唯一のDOアクセス。読み取りと、メモリ上のレート制限判定だけを行う。
  const turn = await stub.beginEphemeralTurn(message);
  if (!turn.ok) {
    logInfo(log, "call.rejected", { reason: turn.error });
    return sseError(turn.error);
  }

  // 育っているほど、通話でも思い出せる量が増える（文字チャットと同じ方針）。
  const budget = contextBudgetFor(turn.interactionCount);

  // 長期記憶の参照。失敗しても通話は続ける（記憶が薄いだけで会話は成立するため）。
  const relevantMemories =
    body.recall === false
      ? []
      : await tolerate(log, "call.recall", [] as string[], () =>
          retrieveRelevantMemories(env, characterId, message, budget.recallTopK)
        );

  const history = sanitizeHistory(body.history);
  const messages = [
    {
      role: "system",
      content: buildCallPrompt({
        name: turn.name,
        personality: turn.personality,
        growthStage: turn.growthStage,
        profileNotes: turn.profileNotes,
        legacySummary: turn.profileNotes ? undefined : turn.memorySummary,
        relevantMemories,
      }),
    },
    ...history.map((h) => ({ role: h.role === "user" ? "user" : "assistant", content: h.text })),
    { role: "user", content: message },
  ];

  // ストリーミングは1モデルずつしか試せないので、連鎖を順に当たる。
  // 上位モデルが一時的に落ちているだけで通話が成立しなくなるのは避けたい。
  for (const model of chatModelChain(env)) {
    try {
      // 型定義上 run() の戻りはオブジェクトだが、stream:true のときは実際にはSSEのReadableStreamが返る。
      const aiStream = (await env.AI.run(model, {
        messages,
        stream: true,
        max_tokens: budget.maxTokens,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as unknown as ReadableStream<Uint8Array>;
      if (!aiStream || typeof (aiStream as ReadableStream).getReader !== "function") {
        logWarn(log, "call.stream_unavailable", { model });
        continue;
      }
      logInfo(log, "call.stream_started", {
        model,
        historyTurns: history.length,
        recalled: relevantMemories.length,
      });
      return sseResponse(transformAiStream(aiStream));
    } catch (err) {
      logWarn(log, "call.ai_failed", { model, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return sseError("いまは通話がつながりにくいみたい。少し待ってからかけ直してね");
}
