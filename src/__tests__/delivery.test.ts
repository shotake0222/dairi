import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { issueGrant, listGrants, revokeGrant, SKUS, verifyGrant } from "../delivery";

/**
 * 納品の検証。
 *
 * ここで守りたいのは、売買の前提そのもの:
 *   1. **買い手に渡すのは読み取りだけ。** 持ち主トークンは一切渡らない
 *   2. **買い手との会話で持ち主の分身が育たない**（MCPの応答は保存しない経路）
 *   3. **機器へ渡す形に、会話・覚え書き・属性が混ざらない**
 *   4. 期限切れ・失効した引換券では取り出せない
 * どれも、壊れても画面上は何事もなく動いてしまう種類のもの。
 */

const BASE = "https://example.com";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

/** 売れる程度に中身のある分身を1体作る。 */
async function makeCharacter(label: string) {
  const res = await SELF.fetch(`${BASE}/t/deliv-${label}-${crypto.randomUUID().slice(0, 8)}`, { redirect: "manual" });
  const location = new URL(res.headers.get("location")!, BASE);
  const cid = location.searchParams.get("cid")!;
  const token = location.searchParams.get("token")!;

  await SELF.fetch(`${BASE}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, token, consent: { profile: true, aggregate: true, marketplace: true } }),
  });
  await SELF.fetch(`${BASE}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, token, part: "seed", notes: "柴犬のコタロウを飼っている\n夜勤で働いている" }),
  });
  return { cid, token };
}

describe("何を売るのかの定義", () => {
  it("商品ごとに、買い手・渡すもの・渡らないものが決まっている", () => {
    expect(SKUS.length).toBeGreaterThan(0);
    for (const sku of SKUS) {
      expect(sku.buyer.length).toBeGreaterThan(0);
      expect(sku.delivers.length).toBeGreaterThan(0);
      // 「渡らないもの」を空にしないこと。ここが曖昧だと商談で答えられない
      expect(sku.excludes.length).toBeGreaterThan(0);
    }
  });

  it("AIを積んでいない機器向けの商品がある（LLM不要と明示されている）", () => {
    const behavior = SKUS.find((s) => s.id === "behavior");
    expect(behavior).toBeTruthy();
    expect(behavior!.requires).toContain("不要");
  });
});

describe("引換券", () => {
  it("平文は発行時にしか出ない（保存しているのはハッシュ）", async () => {
    const { cid } = await makeCharacter("token");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card"], label: "テスト社" });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const grants = await listGrants(env);
    const mine = grants.find((g) => g.characterId === cid)!;
    expect(mine).toBeTruthy();
    // 一覧のどこにも平文が出ていないこと
    expect(JSON.stringify(mine)).not.toContain(issued.token);
  });

  it("範囲の外は断る", async () => {
    const { cid } = await makeCharacter("scope");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["behavior"] });
    if (!issued.ok) return;

    expect((await verifyGrant(env, issued.token, "behavior")).ok).toBe(true);
    const denied = await verifyGrant(env, issued.token, "card");
    expect(denied.ok).toBe(false);
  });

  it("失効させると取り出せなくなる", async () => {
    const { cid } = await makeCharacter("revoke");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card"] });
    if (!issued.ok) return;

    const grants = await listGrants(env);
    const mine = grants.find((g) => g.characterId === cid)!;
    await revokeGrant(env, mine.tokenHash);

    const after = await verifyGrant(env, issued.token, "card");
    expect(after.ok).toBe(false);
  });

  it("期限切れは断る", async () => {
    const { cid } = await makeCharacter("expire");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card"] });
    if (!issued.ok) return;

    await env.DB.prepare("UPDATE delivery_grants SET expires_at = ? WHERE character_id = ?")
      .bind(Date.now() - 1000, cid)
      .run();

    expect((await verifyGrant(env, issued.token, "card")).ok).toBe(false);
  });

  it("券が無い・でたらめな券は断る", async () => {
    expect((await verifyGrant(env, "", "card")).ok).toBe(false);
    expect((await verifyGrant(env, "ABCDEF-GHJKLM", "card")).ok).toBe(false);
  });
});

describe("買い手が取り出す口（/api/delivery）", () => {
  it("人格カードを取り出せる", async () => {
    const { cid } = await makeCharacter("card");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card"] });
    if (!issued.ok) return;

    const res = await SELF.fetch(`${BASE}/api/delivery?scope=card&token=${issued.token}`);
    expect(res.status).toBe(200);
    const card = await res.json<{ runtime: { avatar: unknown }; identity: { name: string } }>();
    expect(card.runtime.avatar).toBeTruthy();
  });

  it("機器向けの形には、会話・覚え書き・属性が混ざらない", async () => {
    const { cid } = await makeCharacter("behavior");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["behavior"] });
    if (!issued.ok) return;

    const res = await SELF.fetch(`${BASE}/api/delivery?scope=behavior&token=${issued.token}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("コタロウ");
    expect(text).not.toContain("夜勤");
    // 機器に載る大きさであること
    expect(new TextEncoder().encode(text).length).toBeLessThan(512);
  });

  it("持ち主トークンでは取り出せない（券とは別物）", async () => {
    const { cid, token } = await makeCharacter("ownertoken");
    await issueGrant(env, { characterId: cid, scopes: ["card"] });
    const res = await SELF.fetch(`${BASE}/api/delivery?scope=card&token=${token}`);
    expect(res.status).toBe(401);
  });
});

describe("MCP（相手がAIのとき）", () => {
  async function rpc(body: Record<string, unknown>, token?: string) {
    return SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
    });
  }

  it("繋がるかの確認（initialize / tools/list）は券なしでも答える", async () => {
    const init = await rpc({ method: "initialize" });
    const initBody = await init.json<{ result: { protocolVersion: string } }>();
    expect(initBody.result.protocolVersion).toBeTruthy();

    const tools = await rpc({ method: "tools/list" });
    const toolsBody = await tools.json<{ result: { tools: { name: string }[] } }>();
    const names = toolsBody.result.tools.map((t) => t.name);
    expect(names).toContain("persona_profile");
    expect(names).toContain("persona_behavior");
    expect(names).toContain("persona_reply");
  });

  it("書き込みの道具は用意していない", async () => {
    const tools = await rpc({ method: "tools/list" });
    const body = await tools.json<{ result: { tools: { name: string }[] } }>();
    for (const tool of body.result.tools) {
      expect(tool.name).not.toMatch(/set|update|delete|write|rename/i);
    }
  });

  it("中身を出す段階では券を見る", async () => {
    const res = await rpc({ method: "tools/call", params: { name: "persona_profile", arguments: {} } });
    const body = await res.json<{ error?: { message: string } }>();
    expect(body.error).toBeTruthy();
  });

  it("券があれば人物像を返す（覚え書きは出さない）", async () => {
    const { cid } = await makeCharacter("mcp");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["mcp"] });
    if (!issued.ok) return;

    const res = await rpc({ method: "tools/call", params: { name: "persona_profile", arguments: {} } }, issued.token);
    const body = await res.json<{ result: { content: { text: string }[] } }>();
    const text = body.result.content[0].text;
    expect(text).toContain("personality");
    // 人物像には覚え書きを含めない（必要なら card スコープでファイル納品する）
    expect(text).not.toContain("コタロウ");
  });

  it("その子として答えるための材料（systemPrompt）を返す", async () => {
    const { cid } = await makeCharacter("mcp-prompt");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["mcp"] });
    if (!issued.ok) return;

    const res = await rpc(
      { method: "tools/call", params: { name: "persona_reply", arguments: { message: "はじめまして" } } },
      issued.token
    );
    const body = await res.json<{ result: { content: { text: string }[] } }>();
    const payload = JSON.parse(body.result.content[0].text) as { systemPrompt: string; userMessage: string };
    expect(payload.systemPrompt.length).toBeGreaterThan(100);
    expect(payload.userMessage).toBe("はじめまして");
  });

  /**
   * ここが一番大事。買い手が何度話しかけても、持ち主の分身が育たないこと。
   * 育つ実装にすると、売った相手の会話で人格が変わる＝持ち主のものではなくなる。
   */
  it("買い手が話しかけても、持ち主の分身は育たない", async () => {
    const { cid } = await makeCharacter("mcp-reply");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["mcp"] });
    if (!issued.ok) return;

    const before = await env.CHARACTER.getByName(cid).getState();
    for (let i = 0; i < 3; i++) {
      await rpc(
        { method: "tools/call", params: { name: "persona_reply", arguments: { message: `こんにちは${i}` } } },
        issued.token
      );
    }
    const after = await env.CHARACTER.getByName(cid).getState();

    expect(after!.interactionCount).toBe(before!.interactionCount);
    expect(after!.personality).toEqual(before!.personality);
    expect((after!.recentTurns ?? []).length).toBe((before!.recentTurns ?? []).length);
  });
});

/**
 * 「自分専用のSLM」と「判断プロファイル」。
 *
 * 用語の扱いも、ここで固定しておく。
 * SLM は Small Language Model で、SML（Standard ML という別の言語）ではない。
 * Jev は TypeSafe AI の製品で、**こちらでは作れない**。作れるのは、
 * 判断特化モデルへ渡す「この人の判断の癖」まで。
 * 資料と実装がずれると商談で嘘をつくことになるので、文言もテストで縛る。
 */
describe("自分専用のSLM / 判断プロファイル", () => {
  it("SLMの説明で、SMLと取り違えていない", () => {
    const slm = SKUS.find((s) => s.id === "slm")!;
    expect(slm.name).toContain("SLM");
    // 「SML」という並びが本文のどこにも無いこと（打ち間違いを機械で止める）
    expect(`${slm.name}${slm.buyer}${slm.delivers.join("")}${slm.requires}`).not.toMatch(/SML/);
  });

  it("Jevを『作れる』とは書いていない", () => {
    const d = SKUS.find((s) => s.id === "decision")!;
    expect(d.excludes).toContain("作れません");
  });

  it("SLM一式は、そのまま ollama create できる形で出る", async () => {
    const { cid } = await makeCharacter("slm");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["slm"] });
    if (!issued.ok) return;

    const res = await SELF.fetch(`${BASE}/api/delivery?scope=slm&token=${issued.token}`);
    expect(res.status).toBe(200);
    const pkg = await res.json<{ files: Record<string, string>; stats: { base: string; enough: boolean } }>();
    expect(pkg.files.Modelfile).toContain("FROM ");
    expect(pkg.files["README.md"]).toContain("ollama create");
    // 会話が浅い分身は学習データが足りない。そこを黙って十分と言わないこと
    expect(pkg.stats.enough).toBe(false);
  });

  it("判断プロファイルは Choice / Score / Noul の形で出て、確からしさを隠さない", async () => {
    const { cid } = await makeCharacter("decision");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["decision"] });
    if (!issued.ok) return;

    const res = await SELF.fetch(`${BASE}/api/delivery?scope=decision&token=${issued.token}`);
    const profile = await res.json<{
      confidence: number;
      questions: Array<{ type: string; prior: number; because: string }>;
      note: string;
    }>();

    expect(profile.questions.length).toBeGreaterThan(4);
    for (const q of profile.questions) {
      expect(["choice", "score", "noul"]).toContain(q.type);
      expect(typeof q.prior).toBe("number");
      // 既定値の根拠が無いと、受け取った側が信じてよいのか判断できない
      expect(q.because.length).toBeGreaterThan(0);
    }
    // 生まれたての分身なので、確からしさは低く出るはず
    expect(profile.confidence).toBeLessThan(30);
    expect(profile.note).toContain("Jev");
  });

  it("判断プロファイルにも、会話や覚え書きは混ざらない", async () => {
    const { cid } = await makeCharacter("decision-leak");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["decision"] });
    if (!issued.ok) return;
    const text = await (await SELF.fetch(`${BASE}/api/delivery?scope=decision&token=${issued.token}`)).text();
    expect(text).not.toContain("コタロウ");
    expect(text).not.toContain("夜勤");
  });
});
