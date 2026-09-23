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
    body: JSON.stringify({ characterId: cid, token, consent: { terms: true, profile: true, aggregate: true, individual: true } }),
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
      // 取り出し口も。**券を切る前に答えられること**（商談中に必ず聞かれる）
      expect(sku.endpoint.length).toBeGreaterThan(0);
      expect(sku.endpoint).toMatch(/<TOKEN>/);
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
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    expect((await verifyGrant(env, issued.token, "behavior")).ok).toBe(true);
    const denied = await verifyGrant(env, issued.token, "card");
    expect(denied.ok).toBe(false);
  });

  it("失効させると取り出せなくなる", async () => {
    const { cid } = await makeCharacter("revoke");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card"] });
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const res = await SELF.fetch(`${BASE}/api/delivery?scope=card&token=${issued.token}`);
    expect(res.status).toBe(200);
    const card = await res.json<{ runtime: { avatar: unknown }; identity: { name: string } }>();
    expect(card.runtime.avatar).toBeTruthy();
  });

  it("機器向けの形には、会話・覚え書き・属性が混ざらない", async () => {
    const { cid } = await makeCharacter("behavior");
    const issued = await issueGrant(env, { characterId: cid, scopes: ["behavior"] });
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
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
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    const text = await (await SELF.fetch(`${BASE}/api/delivery?scope=decision&token=${issued.token}`)).text();
    expect(text).not.toContain("コタロウ");
    expect(text).not.toContain("夜勤");
  });
});

/**
 * 法人へ渡す写しの中身と、持ち主の同意。
 *
 * 以前は、買い手向けの取り出しが本人向けのカードをそのまま使っていて、
 * 会話の抜粋・覚え書き・記憶・年収・入力方法の設定まで渡っていた（規約違反）。
 * どの取り出し口から見ても、それらが1文字も出てこないことをここで縛る。
 */
describe("法人へ渡す写し（中身と同意）", () => {
  async function post(path: string, body: unknown) {
    return SELF.fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** 会話・覚え書き・年収・アクセシビリティ設定まで入った分身を作る */
  async function makeRichCharacter(label: string, consent: Record<string, boolean>) {
    const res = await SELF.fetch(`${BASE}/t/rich-${label}-${crypto.randomUUID().slice(0, 8)}`, { redirect: "manual" });
    const location = new URL(res.headers.get("location")!, BASE);
    const cid = location.searchParams.get("cid")!;
    const token = location.searchParams.get("token")!;
    await post("/api/character/import", {
      characterId: cid,
      token,
      package: {
        formatVersion: "1.1",
        exportedAt: Date.now(),
        character: { id: cid, name: "しずく", species: "punikoro", color: "leaf", createdAt: Date.now() - 86400000, growthStage: "sprout", interactionCount: 40 },
        personality: { warmth: 70, curiosity: 60, cheerfulness: 55, caution: 40, independence: 50, humor: 45 },
        personalityHistory: [],
        memory: {
          shortTerm: "",
          longTerm: [],
          profileNotes: "",
          recentTurns: [
            { role: "user", text: "今日は病院で検査結果を聞いてきたよ", t: Date.now() - 60000 },
            { role: "character", text: "そっか、結果はどうだったの？ゆっくり教えてね", t: Date.now() - 59000 },
            { role: "user", text: "港北区の新しいカフェに行ったんだ", t: Date.now() - 50000 },
            { role: "character", text: "いいね、どんなお店だったのか聞かせてほしいな", t: Date.now() - 49000 },
          ],
        },
        meta: { generator: "waketama", note: "test" },
      },
    });
    await post("/api/consent", { characterId: cid, token, consent });
    await post("/api/profile", { characterId: cid, token, answers: { income: ["1000万円以上"], ageBand: ["30代"] } });
    await post("/api/notes", { characterId: cid, token, part: "seed", notes: "柴犬のコタロウを飼っている\n夜勤で働いている" });
    return { cid, token };
  }

  const FULL = { terms: true, profile: true, aggregate: true, individual: true };
  const LEAKS = ["コタロウ", "夜勤", "検査結果", "港北区", "1000万円"];

  it("持ち主が許可していない分身には、引換券を発行できない", async () => {
    const { cid } = await makeRichCharacter("noconsent", { terms: true, profile: true, aggregate: true });
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card"] });
    expect(issued.ok).toBe(false);
    if (!issued.ok) expect(issued.status).toBe(409);
  });

  it("どの取り出し口からも、会話・覚え書き・年収は出てこない", async () => {
    const { cid } = await makeRichCharacter("leak", FULL);
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card", "bundle", "slm", "decision", "behavior", "mcp"] });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const urls = [
      `scope=card`,
      `scope=card&format=prompt`,
      `scope=card&format=modelfile`,
      `scope=card&format=readme`,
      `scope=bundle`,
      `scope=slm`,
      `scope=decision`,
      `scope=behavior`,
    ];
    for (const q of urls) {
      const res = await SELF.fetch(`${BASE}/api/delivery?${q}&token=${issued.token}`);
      expect(res.status, q).toBe(200);
      const text = await res.text();
      for (const word of LEAKS) expect(text, `${q} に「${word}」`).not.toContain(word);
    }

    const card = await (await SELF.fetch(`${BASE}/api/delivery?scope=card&token=${issued.token}`)).json<{
      audience: string;
      notes: string[];
      memories: unknown[];
      examples: unknown[];
      accessibility?: unknown;
      owner: { profile: Record<string, string[]> };
    }>();
    expect(card.audience).toBe("buyer");
    // 分身の識別子（本人のURLに出るもの）は渡さない
    expect(JSON.stringify(card)).not.toContain(cid);
    expect(card.notes).toEqual([]);
    expect(card.memories).toEqual([]);
    expect(card.examples).toEqual([]);
    expect(card.accessibility).toBeUndefined();
    // 選択肢の属性は、年収を除いて渡る（同意文面に書いてあるとおり）
    expect(card.owner.profile.ageBand).toEqual(["30代"]);
    expect(card.owner.profile.income).toBeUndefined();

    // MCP の「その子として答える材料」も同じ
    const rpc = await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "persona_reply", arguments: { message: "こんにちは" } } }),
    });
    const rpcText = JSON.stringify(await rpc.json());
    for (const word of LEAKS) expect(rpcText, `persona_reply に「${word}」`).not.toContain(word);
  });

  it("本人の書き出しは、これまでどおり全部入る（学習データつきのSLM一式も）", async () => {
    const { cid, token } = await makeRichCharacter("owner", FULL);
    const card = await (await SELF.fetch(`${BASE}/api/persona/card?cid=${cid}&token=${token}`)).text();
    expect(card).toContain("コタロウ");
    expect(card).toContain("港北区");

    const slm = await (await SELF.fetch(`${BASE}/api/persona/card?cid=${cid}&token=${token}&format=slm`)).json<{
      files: Record<string, string>;
    }>();
    expect(slm.files["train.jsonl"] + slm.files["eval.jsonl"]).toContain("港北区");
  });

  it("許可を取り消すと、発行済みの券はその場で失効し、取り出せなくなる", async () => {
    const { cid, token } = await makeRichCharacter("withdraw", FULL);
    const issued = await issueGrant(env, { characterId: cid, scopes: ["card", "mcp"] });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    expect((await SELF.fetch(`${BASE}/api/delivery?scope=card&token=${issued.token}`)).status).toBe(200);

    await post("/api/consent", { characterId: cid, token, consent: { individual: false } });

    expect((await SELF.fetch(`${BASE}/api/delivery?scope=card&token=${issued.token}`)).status).not.toBe(200);
    const mine = (await listGrants(env)).find((g) => g.characterId === cid)!;
    expect(mine.revokedAt).not.toBeNull();
  });

  it("持ち主は、いま何件の券が有効かを自分の画面で見られる", async () => {
    const { cid, token } = await makeRichCharacter("count", FULL);
    await issueGrant(env, { characterId: cid, scopes: ["card"] });
    const view = await (await SELF.fetch(`${BASE}/api/profile?cid=${cid}&token=${token}`)).json<{ activeGrants: number }>();
    expect(view.activeGrants).toBe(1);
  });

  it("買い手のMCP呼び出しが、持ち主の会話の回数制限を食わない", async () => {
    const { cid } = await makeRichCharacter("ratelimit", FULL);
    const issued = await issueGrant(env, { characterId: cid, scopes: ["mcp"] });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    await SELF.fetch(`${BASE}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${issued.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "persona_reply", arguments: { message: "やあ" } } }),
    });
    // 同じ入れ物で数えていた頃は、直後の持ち主の発話が「少し間を空けて」で止まっていた
    const turn = await env.CHARACTER.getByName(cid).beginEphemeralTurn("ただいま");
    expect(turn.ok).toBe(true);
  });
});
