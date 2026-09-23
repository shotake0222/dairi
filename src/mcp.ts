/**
 * MCP（Model Context Protocol）の口。
 *
 * **相手がAIのときの納品形はこれ。**
 * ファイルを渡す形（人格カード）だと、相手のエージェントに読み込ませる作業が要るうえ、
 * こちらが人格を更新しても相手の手元は古いままになる。
 * MCPで口を開けておけば、相手のエージェントが必要なときに取りに来る。
 *
 * 実装の方針:
 * - **読み取りだけ。** 書き込みの道具は作らない。買い手が分身を書き換えられると、
 *   持ち主の分身が他人の手で変わることになる
 * - persona_reply（その子として答えさせる）は、**何も保存しない経路**を使う。
 *   買い手との会話で持ち主の分身が育ってしまうのは、売り物としても体験としても間違い
 * - 引換券（src/delivery.ts）で認証する。持ち主トークンは絶対に使わせない
 *
 * 対応しているのは JSON-RPC 2.0 over HTTP（streamable HTTP のうち、POSTでの1往復）。
 * SSEでの通知は使っていない。読み取り専用の道具しか無いので、サーバから押す用事が無い。
 */

import { toCompact } from "../tools/edge/compact.mjs";
import { verifyGrant } from "./delivery";
import type { CharacterState } from "./durable-objects/characterState";

export interface McpEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null | undefined, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function rpcError(id: string | number | null | undefined, code: number, message: string, status = 200): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function textContent(value: unknown) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

const TOOLS = [
  {
    name: "persona_profile",
    description:
      "この人格の人物像を返す。性格6軸、価値観、口調、身体を持たせるときの振る舞いの方針。" +
      "会話の全文や持ち主の連絡先は含まれない。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "persona_behavior",
    description:
      "言語モデルを使わずに身体を動かすための数値だけを返す（動きの大きさ、間の取り方、対人距離など）。" +
      "ロボットやアバターの制御に直接使える。数百バイト。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "persona_reply",
    description:
      "この人格として1回だけ答える。**分身側には何も保存されない**ので、呼んでも人格は変わらない。",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string", description: "話しかける内容" } },
      required: ["message"],
      additionalProperties: false,
    },
  },
] as const;

/**
 * 引換券の受け取り方。
 * Authorization: Bearer <券> を基本にしつつ、?token= も見る
 * （MCPクライアントによってはヘッダを足せないものがあるため）。
 */
function grantTokenOf(request: Request, url: URL): string {
  const auth = request.headers.get("authorization") || "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  return url.searchParams.get("token") || "";
}

/** 買い手向けの写しが作れなかったときの返し方。同意が無いのか、分身が無いのかを分けて伝える。 */
function buyerCardError(id: string | number | null | undefined, error: string): Response {
  if (error === "no_consent") {
    return rpcError(id, -32004, "この分身の持ち主は、法人への個別提供を許可していません（または取り消しました）");
  }
  return rpcError(id, -32002, "この分身は見つかりませんでした");
}

export async function handleMcp(env: McpEnv, request: Request, url: URL): Promise<Response> {
  if (request.method !== "POST") {
    // GETで開いた人に、何が要るかだけは伝える（黙って405だと繋ぎ方が分からない）
    return new Response(
      JSON.stringify({
        name: "waketama",
        protocolVersion: MCP_PROTOCOL_VERSION,
        transport: "streamable-http (POST only)",
        auth: "Authorization: Bearer <引換券> もしくは ?token=<引換券>",
        tools: TOOLS.map((t) => t.name),
      }),
      { status: 405, headers: { "content-type": "application/json; charset=utf-8", allow: "POST" } }
    );
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json<JsonRpcRequest>();
  } catch {
    return rpcError(null, -32700, "JSONとして読めませんでした");
  }

  const id = body.id;
  const method = body.method || "";

  // initialize と tools/list は、繋がるかどうかの確認に使われるので券なしでも答える。
  // 中身（人物像や応答）を出す段階で必ず券を見る。
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "waketama-persona", version: "1.0.0" },
      instructions:
        "わけたまで育った人格を参照するためのサーバです。読み取りだけで、書き込みの道具はありません。" +
        "引換券（Authorization: Bearer）が要ります。",
    });
  }
  if (method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (method === "tools/list") {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method !== "tools/call") {
    return rpcError(id, -32601, `未対応のメソッドです: ${method}`);
  }

  const params = body.params ?? {};
  const toolName = typeof params.name === "string" ? params.name : "";
  const args = (params.arguments ?? {}) as Record<string, unknown>;

  const grant = await verifyGrant(env, grantTokenOf(request, url), "mcp");
  if (!grant.ok) return rpcError(id, -32001, grant.error);

  const stub = env.CHARACTER.getByName(grant.characterId);

  if (toolName === "persona_behavior") {
    const card = await stub.buildBuyerCard();
    if (!card.ok) return buyerCardError(id, card.error);
    return rpcResult(id, textContent(toCompact(card.card)));
  }

  if (toolName === "persona_profile") {
    const card = await stub.buildBuyerCard();
    if (!card.ok) return buyerCardError(id, card.error);
    // 買い手に渡すのは人物像まで。覚え書きと会話の抜粋はここでは出さない
    // （必要なら card スコープの引換券で、ファイルとして納品する）。
    return rpcResult(
      id,
      textContent({
        identity: {
          name: card.card.identity.name,
          growthStage: card.card.identity.growthStage,
          interactionCount: card.card.identity.interactionCount,
        },
        personality: card.card.personality,
        speech: card.card.speech,
        values: card.card.owner?.values ?? {},
        segment: card.card.owner?.segment ?? null,
        avatar: card.card.runtime.avatar,
      })
    );
  }

  if (toolName === "persona_reply") {
    const message = typeof args.message === "string" ? args.message : "";
    if (!message.trim()) return rpcError(id, -32602, "message が空です");

    // 何も保存しない経路を使う。買い手との会話で持ち主の分身が育ってはいけない。
    // 回数制限もこの中で効くので、MCP経由で無制限に叩かれることはない。
    // 回数は持ち主の会話とは別の入れ物で数える（買い手が使い切っても、本人は話せる）
    const turn = await stub.beginEphemeralTurn(message, "buyer");
    if (!turn.ok) return rpcError(id, -32003, turn.error);

    // 返す systemPrompt は買い手向けの写しから作る。本人向けのカードから作ると、
    // プロンプトの中に覚え書き・記憶・会話の抜粋がそのまま入ってしまう。
    const card = await stub.buildBuyerCard();
    if (!card.ok) return buyerCardError(id, card.error);

    // 返すのは「この子として答えるための材料一式」。
    // 発話そのものをこちらで生成しないのは、買い手が自分のモデル・自分の温度で
    // 動かしたい場面がほとんどで、こちらで生成すると二重にコストが掛かるため。
    return rpcResult(
      id,
      textContent({
        note: "この応答は分身側に保存されていません（持ち主の人格は変わりません）",
        systemPrompt: card.card.runtime.systemPrompt,
        userMessage: message,
        temperature: card.card.runtime.temperature,
        maxContextTokens: card.card.runtime.recommendedContextTokens,
        hint: "systemPrompt と userMessage を、そのままお使いのモデルへ渡してください。",
      })
    );
  }

  return rpcError(id, -32602, `そのような道具はありません: ${toolName}`);
}
