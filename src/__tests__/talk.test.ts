import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import type { CharacterData } from "../durable-objects/characterState";

/**
 * 「かざして話す」（/api/talk）の検証。
 *
 * ここで守りたいこと:
 *   1. 画面側が実行できる形（演出スクリプト）が必ず返ること
 *   2. 通話モードと違い、**保存される**こと（こちらは育つモードなので）
 *   3. 「これ見て」を押していないターンでは、視覚モデルを一切呼ばないこと
 *      （押していないのに画像が送られる／AIが呼ばれるのは、約束違反かつ無駄な課金になる）
 */

const BASE = "https://example.com";

function freshCid(label: string): string {
  return `test-talk-${label}-${crypto.randomUUID()}`;
}

async function createCharacter(cid: string, name = "かざしこ"): Promise<void> {
  await SELF.fetch(`${BASE}/api/character/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, name }),
  });
}

async function talk(body: Record<string, unknown>): Promise<Response> {
  return SELF.fetch(`${BASE}/api/talk`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

describe("POST /api/talk", () => {
  it("requires characterId and message", async () => {
    const res = await talk({ message: "やあ" });
    expect(res.status).toBe(400);
  });

  it("returns the reply together with a script the page can play back", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "うれしい！会えたね" } as never);

    const cid = freshCid("script");
    await createCharacter(cid);

    const res = await talk({ characterId: cid, message: "ただいま" });
    expect(res.status).toBe(200);
    const data = await res.json<Record<string, unknown>>();

    expect(data.reply).toBe("うれしい！会えたね");
    expect(data.emotion).toBe("happy");
    const script = data.script as Array<{ type: string; text?: string }>;
    expect(Array.isArray(script)).toBe(true);
    // 返事が必ず出力されること（動くだけで喋らない画面になってはいけない）
    expect(script.some((s) => s.type === "say" && s.text === "うれしい！会えたね")).toBe(true);
    // 読み上げに使う「この子の声」も一緒に返る
    expect(data.voice).toMatchObject({ pitch: expect.any(Number), rate: expect.any(Number) });
    // 画像を送っていないので「見えたもの」は無い
    expect(data.saw).toBeNull();
  });

  it("saves the exchange (unlike the ephemeral call mode) so the character grows", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "そうなんだ" } as never);

    const cid = freshCid("saves");
    await createCharacter(cid);

    await talk({ characterId: cid, message: "今日は海に行ったよ" });

    const stub = env.CHARACTER.getByName(cid);
    await runInDurableObject(stub, async (_instance, state) => {
      const data = await state.storage.get<CharacterData>("data");
      expect(data!.interactionCount).toBe(1);
      expect(data!.recentTurns?.[0]).toMatchObject({ role: "user", text: "今日は海に行ったよ" });
    });
  });

  it("never calls the vision model when the user did not press 見せる", async () => {
    const aiSpy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "うん" } as never);

    const cid = freshCid("no-vision");
    await createCharacter(cid);
    await talk({ characterId: cid, message: "やあ" });

    const usedVision = aiSpy.mock.calls.some(
      (call) => typeof call[0] === "string" && String(call[0]).includes("vision")
    );
    expect(usedVision).toBe(false);
  });

  it("keeps talking when the vision model fails (the reply must not depend on it)", async () => {
    vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
      if (String(model).includes("vision")) throw new Error("vision down");
      return { response: "うーん、よく見えないや" };
    }) as never);

    const cid = freshCid("vision-failure");
    await createCharacter(cid);

    // 1x1のJPEGに満たない短いデータでも、デコードできれば視覚モデルまで進む
    const res = await talk({ characterId: cid, message: "これ見て", image: btoa("not-a-real-jpeg") });
    expect(res.status).toBe(200);
    const data = await res.json<Record<string, unknown>>();
    expect(data.reply).toBe("うーん、よく見えないや");
    expect(data.saw).toBeNull();
  });

  it("feeds what it saw into the reply when 見せる was used", async () => {
    const aiSpy = vi.spyOn(env.AI, "run").mockImplementation((async (model: string) => {
      if (String(model).includes("vision")) return { response: "机の上にみかんが写っている" };
      return { response: "みかんだ、おいしそう" };
    }) as never);

    const cid = freshCid("vision-ok");
    await createCharacter(cid);

    const res = await talk({ characterId: cid, message: "これ見て", image: btoa("fake-image-bytes") });
    const data = await res.json<Record<string, unknown>>();

    expect(data.saw).toBe("机の上にみかんが写っている");
    // 見えたものが、そのターンのシステムプロンプトに渡っていること
    const chatCall = aiSpy.mock.calls
      .map((c) => c[1] as { messages?: Array<{ role: string; content: string }> })
      .find((input) => Array.isArray(input?.messages));
    expect(chatCall!.messages![0].content).toContain("机の上にみかんが写っている");
  });
});

describe("GET /api/character (privacy of the conversation itself)", () => {
  it("never exposes the conversation, the notes, or the owner token", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "ひみつの返事" } as never);

    const cid = freshCid("privacy");
    await createCharacter(cid, "ひみつこ");
    await talk({ characterId: cid, message: "ひみつの話をするね" });

    const stub = env.CHARACTER.getByName(cid);
    await runInDurableObject(stub, async (_instance, state) => {
      const data = await state.storage.get<CharacterData>("data");
      data!.profileNotes = "・ひみつの覚え書き";
      await state.storage.put("data", data);
    });

    const res = await SELF.fetch(`${BASE}/api/character?cid=${encodeURIComponent(cid)}`);
    const body = await res.text();

    // cid はURLに乗って共有されうる。ここから会話の中身が読めてはいけない。
    expect(body).not.toContain("ひみつの話をするね");
    expect(body).not.toContain("ひみつの返事");
    expect(body).not.toContain("ひみつの覚え書き");
    expect(body).not.toContain("ownerToken");
    // 見た目と育ち具合、そして声は公開してよい
    const json = JSON.parse(body) as Record<string, unknown>;
    expect(json.name).toBe("ひみつこ");
    expect(json.voice).toBeDefined();
  });
});
