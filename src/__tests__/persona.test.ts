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

/**
 * 管理画面の入口。
 *
 * 合言葉の有無を、テストの中で明示的に切り替えている。
 * 開発時に .dev.vars へ ADMIN_PASSCODE を書いていると、環境によって結果が変わってしまうため
 * （実際それで落ちた）。「未設定なら開かない」は最も守りたい性質なので、環境に依存させない。
 */
describe("管理画面の入口", () => {
  type MutableEnv = { ADMIN_PASSCODE?: string };

  async function withPasscode<T>(passcode: string | undefined, fn: () => Promise<T>): Promise<T> {
    const mutable = env as unknown as MutableEnv;
    const saved = mutable.ADMIN_PASSCODE;
    if (passcode === undefined) delete mutable.ADMIN_PASSCODE;
    else mutable.ADMIN_PASSCODE = passcode;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete mutable.ADMIN_PASSCODE;
      else mutable.ADMIN_PASSCODE = saved;
    }
  }

  it("is closed when no passcode is configured", async () => {
    await withPasscode(undefined, async () => {
      // 「未設定なら素通し」にすると、設定を忘れた瞬間に全データが公開される
      expect((await SELF.fetch(`${BASE}/api/admin/overview`)).status).toBe(404);
      expect((await SELF.fetch(`${BASE}/admin`)).status).toBe(404);
      expect((await SELF.fetch(`${BASE}/api/admin/contacts`)).status).toBe(404);
      expect((await SELF.fetch(`${BASE}/api/admin/recovery/lookup?q=x`)).status).toBe(404);
    });
  });

  it("refuses without the passcode once one is configured", async () => {
    await withPasscode("test-passcode", async () => {
      expect((await SELF.fetch(`${BASE}/api/admin/overview`)).status).toBe(401);
    });
  });

  it("moves the passcode out of the URL and into an HttpOnly cookie", async () => {
    await withPasscode("test-passcode", async () => {
      const res = await SELF.fetch(`${BASE}/admin?key=test-passcode`, { redirect: "manual" });
      expect(res.status).toBe(302);
      const cookie = res.headers.get("set-cookie") || "";
      // 合言葉がURLに残ると、共有履歴や参照元ヘッダから漏れる
      expect(res.headers.get("location")).not.toContain("key=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
    });
  });

  it("rejects a wrong passcode", async () => {
    await withPasscode("test-passcode", async () => {
      const res = await SELF.fetch(`${BASE}/admin?key=wrong`, { redirect: "manual" });
      expect(res.status).toBe(401);
    });
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

describe("覚え書きの書き換え（/api/notes）", () => {
  it("is owner-only", async () => {
    const cid = freshCid("notes-auth");
    await createCharacter(cid);
    const res = await post("/api/notes", { characterId: cid, notes: "・勝手に書き換える" });
    expect(res.status).toBe(403);
  });

  it("lets the owner correct what the character believes about them", async () => {
    const cid = freshCid("notes-edit");
    const token = await createCharacter(cid);

    const stub = env.CHARACTER.getByName(cid);
    await runInDurableObject(stub, async (_i, state) => {
      const data = await state.storage.get<CharacterData>("data");
      data!.profileNotes = "・弟がいる\n・犬を飼っている";
      await state.storage.put("data", data);
    });

    const res = await post("/api/notes", {
      characterId: cid,
      token,
      notes: "妹がいる\n・犬を飼っている",
    });
    const data = await res.json<{ notes: string }>();

    // 「・」が無い行にも揃えて付ける（次の蒸留でAIに渡したときに書式が崩れないように）
    expect(data.notes).toBe("・妹がいる\n・犬を飼っている");
    expect(data.notes).not.toContain("弟");
  });

  it("does not let the next reflection immediately overwrite the correction", async () => {
    const cid = freshCid("notes-hold");
    const token = await createCharacter(cid);
    const stub = env.CHARACTER.getByName(cid);
    await runInDurableObject(stub, async (_i, state) => {
      const data = await state.storage.get<CharacterData>("data");
      data!.interactionCount = 12;
      data!.lastReflectedAt = 0; // 本来ならすぐ蒸留が走る状態
      await state.storage.put("data", data);
    });

    await post("/api/notes", { characterId: cid, token, notes: "・直した内容" });

    await runInDurableObject(stub, async (_i, state) => {
      const data = await state.storage.get<CharacterData>("data");
      // 直した直後に上書きされないよう、反映済みとして扱う
      expect(data!.lastReflectedAt).toBe(12);
    });
  });

  it("accepts an empty value as 'forget everything you wrote about me'", async () => {
    const cid = freshCid("notes-clear");
    const token = await createCharacter(cid);
    const res = await post("/api/notes", { characterId: cid, token, notes: "" });
    const data = await res.json<{ notes: string }>();
    expect(data.notes).toBe("");
  });
});

describe("法人からの問い合わせ（/api/contact）", () => {
  it("requires a plausible email address", async () => {
    expect((await post("/api/contact", { contact: "" })).status).toBe(400);
    expect((await post("/api/contact", { contact: "not-an-email" })).status).toBe(400);
  });

  it("stores the inquiry", async () => {
    const contact = `biz-${crypto.randomUUID()}@example.com`;
    const res = await post("/api/contact", {
      kind: "biz",
      company: "テスト株式会社",
      contact,
      topic: "poc",
      message: "ロボットに載せたいです",
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT * FROM contact_requests WHERE contact = ?")
      .bind(contact)
      .first<Record<string, unknown>>();
    expect(row!.company).toBe("テスト株式会社");
    expect(row!.topic).toBe("poc");
    expect(row!.status).toBe("new");
  });

  it("falls back to a known topic instead of storing arbitrary values", async () => {
    const contact = `biz2-${crypto.randomUUID()}@example.com`;
    await post("/api/contact", { contact, topic: "'; DROP TABLE contact_requests; --" });
    const row = await env.DB.prepare("SELECT topic FROM contact_requests WHERE contact = ?")
      .bind(contact)
      .first<{ topic: string }>();
    expect(row!.topic).toBe("other");
  });

  it("is not readable from outside the admin console", async () => {
    // 連絡先が入る表なので、管理画面と同じ扉の内側にあること
    const res = await SELF.fetch(`${BASE}/api/admin/contacts`);
    expect([401, 404]).toContain(res.status);
  });
});

describe("分身の復旧（運営による救済）", () => {
  it("is only reachable from inside the admin console", async () => {
    // 所有権を移せる操作なので、管理画面の扉の内側にしか無いこと
    const res = await SELF.fetch(`${BASE}/api/admin/recovery/lookup?q=whatever`);
    expect([401, 404]).toContain(res.status);
    const issue = await post("/api/admin/recovery/issue", { characterId: "x", reason: "test" });
    expect([401, 404]).toContain(issue.status);
  });
});

describe("復旧の依頼（/api/contact kind=recovery）", () => {
  it("goes into the same inbox as the business inquiries", async () => {
    const contact = `recover-${crypto.randomUUID()}@example.com`;
    const res = await post("/api/contact", {
      kind: "recovery",
      contact,
      message: "機種変更で引き継ぎを忘れました",
    });
    expect(res.status).toBe(200);

    const row = await env.DB.prepare("SELECT kind FROM contact_requests WHERE contact = ?")
      .bind(contact)
      .first<{ kind: string }>();
    // 受け皿を分けると運営が2箇所を見ることになるので、同じ表に種別だけ分けて入れる
    expect(row!.kind).toBe("recovery");
  });
});
