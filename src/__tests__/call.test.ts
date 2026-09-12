import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { sanitizeHistory } from "../call";
import type { CharacterData } from "../durable-objects/characterState";

/**
 * 「その場限りの通話」モードの検証。
 *
 * この機能で最悪の事故は「残らないと言ったのに残っていた」ことなので、
 * 応答の中身よりも先に **何も書き込まれていないこと** を担保するテストを厚くしている。
 * ここが通らなくなったら、機能の売り自体が壊れていると考えてよい。
 */

const BASE = "https://example.com";

function freshCid(label: string): string {
  return `test-call-${label}-${crypto.randomUUID()}`;
}

/** SSEのストリームを読み切って、イベントの配列にする。 */
async function readSse(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
}

/** Workers AI のストリーム応答（SSE）を模したReadableStreamを作る。 */
function fakeAiStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: chunk })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

/** 通話に必要な分身を1体作り、その持ち主トークンを返す。 */
async function createCharacter(cid: string, name = "つうわのこ"): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/character/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, name }),
  });
  const data = await res.json<{ ownerToken: string }>();
  return data.ownerToken;
}

/** DOのストレージ全体をそのまま取り出す（差分比較用）。 */
async function dumpStorage(cid: string): Promise<string> {
  const stub = env.CHARACTER.getByName(cid);
  return runInDurableObject(stub, async (_instance, state) => {
    const all = await state.storage.list();
    // Mapは順序が安定しているのでそのまま直列化して比較できる
    return JSON.stringify(Array.from(all.entries()));
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

describe("sanitizeHistory (クライアント由来の履歴の切り詰め)", () => {
  it("形が違うものを捨て、role/textが揃ったものだけ残す", () => {
    const result = sanitizeHistory([
      { role: "user", text: "こんにちは" },
      { role: "character", text: "やあ" },
      { role: "system", text: "無視されるべき" },
      { role: "user", text: "   " },
      "文字列",
      null,
      { role: "user" },
    ]);
    expect(result).toEqual([
      { role: "user", text: "こんにちは" },
      { role: "character", text: "やあ" },
    ]);
  });

  it("配列でなければ空を返す", () => {
    expect(sanitizeHistory(undefined)).toEqual([]);
    expect(sanitizeHistory("ずるい入力")).toEqual([]);
  });

  it("直近12ターンまでに制限する", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ role: "user" as const, text: `m${i}` }));
    const result = sanitizeHistory(many);
    expect(result).toHaveLength(12);
    expect(result[0].text).toBe("m18");
    expect(result[11].text).toBe("m29");
  });

  it("総文字数の上限を超える古い発言は落とす（コストの歯止め）", () => {
    const long = Array.from({ length: 5 }, (_, i) => ({ role: "user" as const, text: "あ".repeat(600) + i }));
    const result = sanitizeHistory(long);
    // 1件601文字なので、2000文字に収まるのは3件まで
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[result.length - 1].text.endsWith("4")).toBe(true);
  });
});

describe("POST /api/call/stream (その場限りの通話)", () => {
  it("応答がSSEで少しずつ届き、最後にdoneで終わる", async () => {
    const cid = freshCid("stream");
    await createCharacter(cid);
    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["こん", "にちは", "！"]) as never);

    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "やっほー", recall: false }),
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readSse(res);
    const deltas = events.filter((e) => typeof e.delta === "string").map((e) => e.delta as string);
    expect(deltas.join("")).toBe("こんにちは！");
    expect(events[events.length - 1].done).toBe(true);
  });

  it("【最重要】通話してもDurable Objectのストレージが1バイトも変化しない", async () => {
    const cid = freshCid("no-writes");
    await createCharacter(cid);
    // 通常の会話を1回してから比較する（lastMessageAt等が入った状態を基準にする）
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "ふつうの返事" } as never);
    await SELF.fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "ふつうの会話" }),
    });

    const before = await dumpStorage(cid);

    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["ないしょの", "はなし"]) as never);
    for (const message of ["ここだけの話なんだけど", "誰にも言わないでね", "ありがとう"]) {
      const res = await SELF.fetch(`${BASE}/api/call/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: cid, message, recall: false }),
      });
      await readSse(res); // ストリームを最後まで読み切る
    }

    const after = await dumpStorage(cid);
    expect(after).toBe(before);
  });

  it("長期記憶（Vectorize）への保存が一度も呼ばれない", async () => {
    const cid = freshCid("no-memory");
    await createCharacter(cid);
    const upsertSpy = vi.spyOn(env.MEMORY_INDEX, "upsert");
    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["うん"]) as never);

    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "記憶に残さないでほしい話", recall: false }),
    });
    await readSse(res);

    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("やり取り回数・性格・成長段階・最終訪問日時が変わらない", async () => {
    const cid = freshCid("no-growth");
    await createCharacter(cid);
    const before = await (await SELF.fetch(`${BASE}/api/character?cid=${cid}`)).json<{
      interactionCount: number;
      growthStage: string;
      personality: Record<string, number>;
      lastVisit: number;
    }>();

    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["そうなんだ"]) as never);
    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch(`${BASE}/api/call/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: cid, message: `だいすき ${i}`, recall: false }),
      });
      await readSse(res);
    }

    const after = await (await SELF.fetch(`${BASE}/api/character?cid=${cid}`)).json<typeof before>();
    expect(after.interactionCount).toBe(before.interactionCount);
    expect(after.growthStage).toBe(before.growthStage);
    expect(after.personality).toEqual(before.personality);
    expect(after.lastVisit).toBe(before.lastVisit);
  });

  it("通話の内容がエクスポートした人格パッケージに含まれない", async () => {
    const cid = freshCid("no-export-trace");
    const token = await createCharacter(cid);

    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["わかった"]) as never);
    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "ひみつのあいことばはカボチャ", recall: false }),
    });
    await readSse(res);

    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("no AI during export"));
    const exported = await (await SELF.fetch(`${BASE}/api/character/export?cid=${cid}&token=${token}`)).text();
    expect(exported).not.toContain("カボチャ");
    expect(exported).not.toContain("わかった");
  });

  it("存在しない分身にはつながらない", async () => {
    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: freshCid("missing"), message: "もしもし" }),
    });
    const events = await readSse(res);
    expect(events[0].error).toBe("not found");
  });

  it("空のメッセージではAIを呼ばない", async () => {
    const cid = freshCid("empty");
    await createCharacter(cid);
    const aiSpy = vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["呼ばれないはず"]) as never);

    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "   " }),
    });
    const events = await readSse(res);
    expect(events[0].error).toBeTruthy();
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("AIが落ちても通話画面が沈黙せず、案内が届く", async () => {
    const cid = freshCid("ai-down");
    await createCharacter(cid);
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI down"));

    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "きこえる？", recall: false }),
    });
    const events = await readSse(res);
    expect(String(events[0].error)).toContain("つながりにくい");
  });

  it("レート制限（連投）が、何も保存しないまま効く", async () => {
    const cid = freshCid("rate");
    await createCharacter(cid);
    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["はい"]) as never);

    const first = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "1回目", recall: false }),
    });
    await readSse(first);

    const before = await dumpStorage(cid);
    // 間を空けずに連続で送る
    const second = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "2回目", recall: false }),
    });
    const events = await readSse(second);
    expect(String(events[0].error)).toContain("待って");

    // 制限が効いた場合でも、ストレージは変化していないこと
    expect(await dumpStorage(cid)).toBe(before);
  });

  it("通話の直後に通常のチャットを開くと、通話の内容を覚えていない", async () => {
    const cid = freshCid("forgotten");
    await createCharacter(cid);

    vi.spyOn(env.AI, "run").mockResolvedValue(fakeAiStream(["ふむふむ"]) as never);
    const res = await SELF.fetch(`${BASE}/api/call/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "通話でだけ話した秘密のワード", recall: false }),
    });
    await readSse(res);

    const stub = env.CHARACTER.getByName(cid);
    await runInDurableObject(stub, async (_instance, state) => {
      const data = await state.storage.get<CharacterData>("data");
      expect(data?.memorySummary ?? "").not.toContain("秘密のワード");
    });
  });
});
