import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import type { CharacterData } from "../durable-objects/characterState";
import { CONSENT_VERSION } from "../persona/consent";
import { MIN_COHORT_SIZE } from "../market";

/**
 * 同意・属性・人格カード・マーケット・管理画面の通しの検証。
 *
 * ここで守りたい線は1本だけ:
 * **同意していないデータは、どこからも出てこない。**
 * 属性APIも、集計用レジストリも、統計も、マーケットも、すべてこの線で検証する。
 */

const BASE = "https://example.com";

function freshCid(label: string): string {
  return `test-persona-${label}-${crypto.randomUUID()}`;
}

async function createCharacter(cid: string, name = "きろくこ"): Promise<string> {
  await SELF.fetch(`${BASE}/api/character/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, name }),
  });
  const stub = env.CHARACTER.getByName(cid);
  return runInDurableObject(stub, async (_i, state) => {
    const data = await state.storage.get<CharacterData>("data");
    return data!.ownerToken!;
  });
}

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

describe("同意（/api/consent）", () => {
  it("starts with nothing consented", async () => {
    const cid = freshCid("default");
    const token = await createCharacter(cid);

    const res = await SELF.fetch(`${BASE}/api/profile?cid=${cid}&token=${token}`);
    const data = await res.json<Record<string, unknown>>();
    expect(data.consent).toBeNull();
  });

  it("refuses to answer to anyone but the owner", async () => {
    const cid = freshCid("owner");
    await createCharacter(cid);

    expect((await SELF.fetch(`${BASE}/api/profile?cid=${cid}`)).status).toBe(403);
    expect((await post("/api/consent", { characterId: cid, consent: { aggregate: true } })).status).toBe(403);
    expect((await post("/api/profile", { characterId: cid, answers: { ageBand: ["30代"] } })).status).toBe(403);
  });

  it("records each purpose separately", async () => {
    const cid = freshCid("purposes");
    const token = await createCharacter(cid);

    const res = await post("/api/consent", { characterId: cid, token, consent: { profile: true } });
    const data = await res.json<{ consent: Record<string, unknown> }>();
    expect(data.consent.profile).toBe(true);
    expect(data.consent.aggregate).toBe(false);
    expect(data.consent.marketplace).toBe(false);
    expect(data.consent.version).toBe(CONSENT_VERSION);
  });
});

describe("属性（/api/profile）", () => {
  it("refuses to store answers before the user consented", async () => {
    const cid = freshCid("no-consent");
    const token = await createCharacter(cid);

    const res = await post("/api/profile", { characterId: cid, token, answers: { ageBand: ["30代"] } });
    expect(res.status).toBe(403);
  });

  it("stores only the defined options, ignoring anything else", async () => {
    const cid = freshCid("sanitize");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { profile: true } });

    await post("/api/profile", {
      characterId: cid,
      token,
      answers: { ageBand: ["30代"], realName: "山田太郎", ageBandFree: "35歳" },
    });

    const res = await SELF.fetch(`${BASE}/api/profile?cid=${cid}&token=${token}`);
    const body = await res.text();
    expect(body).toContain("30代");
    expect(body).not.toContain("山田太郎");
  });

  it("deletes the stored answers when the user withdraws consent", async () => {
    const cid = freshCid("withdraw");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { profile: true } });
    await post("/api/profile", { characterId: cid, token, answers: { ageBand: ["30代"] } });

    await post("/api/consent", { characterId: cid, token, consent: { profile: false } });

    const res = await SELF.fetch(`${BASE}/api/profile?cid=${cid}&token=${token}`);
    const data = await res.json<{ profile: { answers: Record<string, unknown> } }>();
    // 「同意を外したのに手元には残っている」は、利用者の理解と食い違う
    expect(data.profile.answers).toEqual({});
  });
});

describe("集計用レジストリ（同意が無ければ行ごと存在しない）", () => {
  async function registryRow(cid: string) {
    return env.DB.prepare("SELECT * FROM persona_registry WHERE character_id = ?")
      .bind(cid)
      .first<Record<string, unknown>>();
  }

  it("does not register a character that has not consented", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "やあ" } as never);
    const cid = freshCid("unregistered");
    await createCharacter(cid);

    await post("/api/chat", { characterId: cid, message: "こんにちは" });
    expect(await registryRow(cid)).toBeNull();
  });

  it("registers once the user consents to aggregate use", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "やあ" } as never);
    const cid = freshCid("registered");
    const token = await createCharacter(cid);

    await post("/api/consent", { characterId: cid, token, consent: { aggregate: true } });
    const row = await registryRow(cid);
    expect(row).not.toBeNull();
    expect(row!.consent_aggregate).toBe(1);
  });

  it("removes the row the moment consent is withdrawn", async () => {
    const cid = freshCid("removed");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { aggregate: true } });
    expect(await registryRow(cid)).not.toBeNull();

    await post("/api/consent", { characterId: cid, token, consent: { aggregate: false } });
    expect(await registryRow(cid)).toBeNull();
  });

  it("keeps the demographics out unless both profile and aggregate were agreed", async () => {
    const cid = freshCid("profile-gate");
    const token = await createCharacter(cid);

    await post("/api/consent", { characterId: cid, token, consent: { profile: true } });
    await post("/api/profile", { characterId: cid, token, answers: { ageBand: ["30代"] } });
    // まだ集約には同意していないので、そもそもレジストリに載らない
    expect(await registryRow(cid)).toBeNull();

    await post("/api/consent", { characterId: cid, token, consent: { aggregate: true } });
    const row = await registryRow(cid);
    expect(row!.age_band).toBe("30代");
  });

  it("registers for the marketplace without leaking the demographics", async () => {
    const cid = freshCid("market-only");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { profile: true, marketplace: true } });
    await post("/api/profile", { characterId: cid, token, answers: { ageBand: ["30代"] } });

    const row = await registryRow(cid);
    expect(row!.consent_marketplace).toBe(1);
    // 出品への同意は、統計に属性を載せてよいという意味ではない
    expect(row!.age_band).toBeNull();
  });

  it("never stores accessibility settings in the registry", async () => {
    const cid = freshCid("a11y");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { profile: true, aggregate: true } });
    await post("/api/accessibility", { characterId: cid, token, prefs: { inputMode: "gaze", dwellMs: 1500 } });

    const row = await registryRow(cid);
    // 入力方法は身体の状態を示しうるので、同意の有無に関わらず外へ出す経路を作らない
    expect(JSON.stringify(row)).not.toContain("gaze");
  });
});

describe("人格カード（/api/persona/card）", () => {
  it("is owner-only", async () => {
    const cid = freshCid("card-auth");
    await createCharacter(cid);
    expect((await SELF.fetch(`${BASE}/api/persona/card?cid=${cid}`)).status).toBe(403);
  });

  it("returns something an SLM can be given directly", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "うん、そうだね" } as never);
    const cid = freshCid("card");
    const token = await createCharacter(cid, "カードこ");
    await post("/api/chat", { characterId: cid, message: "はじめまして" });

    const res = await SELF.fetch(`${BASE}/api/persona/card?cid=${cid}&token=${token}`);
    const card = await res.json<Record<string, any>>();

    expect(card.format).toBe("waketama.persona-card");
    expect(card.identity.name).toBe("カードこ");
    // そのままシステムメッセージに入れれば動く、という形になっていること
    expect(card.runtime.systemPrompt).toContain("カードこ");
    expect(card.runtime.systemPrompt.length).toBeGreaterThan(100);
    // 実際の会話から取った応答例が入っていること（口調の移植に一番効く）
    expect(card.examples[0]).toEqual({ user: "はじめまして", assistant: "うん、そうだね" });
    expect(card.voice.pitch).toBeGreaterThan(0);
  });

  it("can be exported as an Ollama Modelfile", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "やあ" } as never);
    const cid = freshCid("modelfile");
    const token = await createCharacter(cid, "モデルこ");

    const res = await SELF.fetch(`${BASE}/api/persona/card?cid=${cid}&token=${token}&format=modelfile`);
    const text = await res.text();

    expect(text).toContain("FROM ");
    expect(text).toContain("SYSTEM ");
    expect(text).toContain("モデルこ");
    expect(res.headers.get("content-disposition")).toContain("Modelfile");
  });
});

describe("マーケット", () => {
  it("refuses to create a listing before the user consented", async () => {
    const cid = freshCid("listing-consent");
    const token = await createCharacter(cid);

    const res = await post("/api/market/listing", {
      characterId: cid,
      token,
      title: "うちの子",
      description: "とても良い子に育ちました",
      action: "list",
    });
    expect(res.status).toBe(403);
  });

  it("publishes only after an explicit 公開 action", async () => {
    const cid = freshCid("listing-flow");
    const token = await createCharacter(cid, "でるこ");
    await post("/api/consent", { characterId: cid, token, consent: { marketplace: true } });

    type Browse = { listings: Array<{ title: string }> };
    // 同意しただけでは載らない
    let browse = await (await SELF.fetch(`${BASE}/api/market/listings`)).json<Browse>();
    const before = browse.listings.length;

    await post("/api/market/listing", {
      characterId: cid,
      token,
      title: "おっとりした子",
      description: "毎日のできごとを聞いてくれます",
      action: "save",
    });
    browse = await (await SELF.fetch(`${BASE}/api/market/listings`)).json<Browse>();
    expect(browse.listings.length).toBe(before); // 下書きは公開されない

    await post("/api/market/listing", {
      characterId: cid,
      token,
      title: "おっとりした子",
      description: "毎日のできごとを聞いてくれます",
      action: "list",
    });
    browse = await (await SELF.fetch(`${BASE}/api/market/listings`)).json<Browse>();
    expect(browse.listings.some((l) => l.title === "おっとりした子")).toBe(true);
  });

  it("does not expose the character id or the owner in the public listing", async () => {
    const cid = freshCid("listing-privacy");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { marketplace: true } });
    await post("/api/market/listing", {
      characterId: cid,
      token,
      title: "ひみつの子",
      description: "説明はここに書きます",
      action: "list",
    });

    const body = await (await SELF.fetch(`${BASE}/api/market/listings`)).text();
    expect(body).not.toContain(cid);
    expect(body).not.toContain(token);
  });

  it("suppresses segments below the minimum cohort size", async () => {
    // 同意した分身が少数しかいない状態で統計を出すと、条件次第で個人が分かってしまう
    const cid = freshCid("k-anon");
    const token = await createCharacter(cid);
    await post("/api/consent", { characterId: cid, token, consent: { aggregate: true } });

    const data = await (await SELF.fetch(`${BASE}/api/market/insights`)).json<{
      insights: unknown[];
      minCohortSize: number;
      suppressedSegments: number;
    }>();
    expect(data.minCohortSize).toBe(MIN_COHORT_SIZE);
    expect(data.insights).toHaveLength(0);
    expect(data.suppressedSegments).toBeGreaterThan(0);
  });
});

describe("管理画面", () => {
  it("is closed when no passcode is configured", async () => {
    // ADMIN_PASSCODE を設定していない状態が既定。素通しにしてはいけない
    const res = await SELF.fetch(`${BASE}/api/admin/overview`);
    expect(res.status).toBe(404);
    const page = await SELF.fetch(`${BASE}/admin`);
    expect(page.status).toBe(404);
  });
});

describe("かな漢字変換（/api/ime）", () => {
  it("does not call the AI when the text already has kanji", async () => {
    const aiSpy = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "呼ばれないはず" } as never);
    const res = await post("/api/ime", { text: "今日は雨です" });
    const data = await res.json<{ text: string; converted: boolean }>();

    expect(data.converted).toBe(false);
    expect(data.text).toBe("今日は雨です");
    expect(aiSpy).not.toHaveBeenCalled();
  });

  it("converts kana into a normal sentence", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "今日は雨です" } as never);
    const res = await post("/api/ime", { text: "きょうはあめです" });
    const data = await res.json<{ text: string; converted: boolean }>();
    expect(data.converted).toBe(true);
    expect(data.text).toBe("今日は雨です");
  });

  it("falls back to the kana when the model starts talking instead of converting", async () => {
    vi.spyOn(env.AI, "run").mockResolvedValue({
      response: "承知しました。以下が変換結果です。今日は雨です。何かお手伝いできることはありますか？",
    } as never);
    const res = await post("/api/ime", { text: "きょうはあめ" });
    const data = await res.json<{ text: string; converted: boolean }>();
    // 勝手に別の文が送られるくらいなら、ひらがなのまま送る方がよい
    expect(data.converted).toBe(false);
    expect(data.text).toBe("きょうはあめ");
  });

  it("still returns the original text when the AI fails", async () => {
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("down"));
    const res = await post("/api/ime", { text: "ありがとう" });
    const data = await res.json<{ text: string }>();
    expect(res.status).toBe(200);
    expect(data.text).toBe("ありがとう");
  });
});
