import { CharacterState } from "./durable-objects/characterState";

export { CharacterState };

export interface Env {
  AI: Ai;
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
  ASSETS: Fetcher;
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers || {}) },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- NFCタグ読み取り: /t/:tagId ---
    // NFCタグにはこのURL（例: https://<your-domain>/t/xxxxxx）を書き込む想定。
    if (url.pathname.startsWith("/t/")) {
      const tagId = decodeURIComponent(url.pathname.split("/")[2] || "");
      if (!tagId) {
        return new Response("invalid tag", { status: 400 });
      }

      const row = await env.DB.prepare(
        "SELECT character_id FROM nfc_tags WHERE tag_id = ?"
      )
        .bind(tagId)
        .first<{ character_id: string }>();

      let characterId: string;
      let isFirstTime = false;

      if (row) {
        characterId = row.character_id;
      } else {
        // 初回タップ: このタグに紐づくキャラクターを新規発行
        characterId = crypto.randomUUID();
        isFirstTime = true;
        await env.DB.prepare(
          "INSERT INTO nfc_tags (tag_id, character_id, created_at) VALUES (?, ?, ?)"
        )
          .bind(tagId, characterId, Date.now())
          .run();

        const stub = env.CHARACTER.getByName(characterId);
        await stub.init("名もなきキャラクター");
      }

      const redirectUrl = new URL("/summon.html", url.origin);
      redirectUrl.searchParams.set("cid", characterId);
      if (isFirstTime) redirectUrl.searchParams.set("first", "1");

      return Response.redirect(redirectUrl.toString(), 302);
    }

    // --- チャットAPI ---
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; message?: string }>();
      if (!body.characterId || !body.message) {
        return json({ error: "characterId and message are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.chat(body.message);
      return json(result);
    }

    // --- キャラクター状態取得API ---
    if (url.pathname === "/api/character" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const state = await stub.getState();
      if (!state) return json({ error: "not found" }, { status: 404 });
      return json(state);
    }

    // --- キャラクター名前設定API（初回サモン時に使う想定） ---
    if (url.pathname === "/api/character/rename" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; name?: string }>();
      if (!body.characterId || !body.name) {
        return json({ error: "characterId and name are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const state = await stub.rename(body.name);
      return json(state);
    }

    // --- それ以外は静的ファイル（public/ 配下）を配信 ---
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
