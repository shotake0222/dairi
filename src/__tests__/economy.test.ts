import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { earn, grant, jstDay, saveEconomySettings } from "../economy";
import { sanitizeObjects } from "../metaverse";

/**
 * メタバースの通貨・お店・提携店の引換券。
 *
 * 守りたい約束:
 *   1. 遊ぶと貯まる。同じ理由で何度も貯められない（入室は1日1回・同じ屋台は1日1回・会話は回数の上限・1日の上限）
 *   2. お金で買う口・お金に戻す口・人に渡す口は無い
 *   3. 財布を使えるのは持ち主だけ。残高より多くは使えない
 *   4. 引換券は、その提携店の暗証番号でしか確かめられず、1回しか使えない
 */

const BASE = "https://example.com";
const PASS = "test-admin-pass";
const ADMIN = { cookie: `waketama_admin=${encodeURIComponent(PASS)}`, "content-type": "application/json" };
type MutableEnv = { ADMIN_PASSCODE?: string };
let saved: string | undefined;

beforeAll(() => {
  saved = (env as unknown as MutableEnv).ADMIN_PASSCODE;
  (env as unknown as MutableEnv).ADMIN_PASSCODE = PASS;
});
afterAll(() => {
  (env as unknown as MutableEnv).ADMIN_PASSCODE = saved;
});
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockResolvedValue({ response: "こんにちは！いい天気だね。" } as never);
  await saveEconomySettings(env, { enabled: true, realOpen: false, dailyEarnCap: 150, talkDailyMax: 10, voucherMonthlyLimit: 3 });
});

async function admin(path: string, method = "GET", body?: unknown) {
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function user(path: string, body: unknown) {
  const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function makeUserCharacter(label: string) {
  const res = await SELF.fetch(`${BASE}/t/eco-${label}-${crypto.randomUUID().slice(0, 8)}`, { redirect: "manual" });
  const location = new URL(res.headers.get("location")!, BASE);
  const cid = location.searchParams.get("cid")!;
  const token = location.searchParams.get("token")!;
  await SELF.fetch(`${BASE}/api/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, token, consent: { terms: true } }),
  });
  return { cid, token };
}

describe("貯まり方", () => {
  it("入室は1日1回、同じ屋台のクリアは1日1回、会話は回数の上限まで", async () => {
    const cid = `eco-earn-${crypto.randomUUID()}`;
    const first = await earn(env, cid, "login");
    expect(first.ok && first.amount).toBe(10);
    expect((await earn(env, cid, "login")).ok).toBe(false);
    expect((await earn(env, cid, "clear", "hiroba:stars")).ok).toBe(true);
    expect((await earn(env, cid, "clear", "hiroba:stars")).ok).toBe(false);
    expect((await earn(env, cid, "clear", "hiroba:quiz")).ok).toBe(true);
    await saveEconomySettings(env, { talkDailyMax: 3 });
    const talks = [];
    for (let i = 0; i < 5; i++) talks.push(await earn(env, cid, "talk"));
    expect(talks.filter((t) => t.ok).length).toBe(3);
    const r = await earn(env, cid, "talk");
    expect(r.ok === false && r.reason).toBe("talk_limit");
  });

  it("遊んで貯まる額は1日の上限で止まる（運営の付与は上限の外）。日が変われば、また貯まる", async () => {
    const cid = `eco-cap-${crypto.randomUUID()}`;
    await saveEconomySettings(env, { dailyEarnCap: 12, clearReward: 5 });
    const now = Date.now();
    const got = [];
    for (let i = 0; i < 5; i++) got.push(await earn(env, cid, "clear", `room:${i}`, now));
    expect(got.map((g) => (g.ok ? g.amount : 0))).toEqual([5, 5, 2, 0, 0]);
    const g = await grant(env, cid, 100, "テスト");
    expect(g.ok && g.balance).toBe(112);
    const tomorrow = now + 24 * 60 * 60 * 1000;
    expect(jstDay(tomorrow)).not.toBe(jstDay(now));
    expect((await earn(env, cid, "clear", "room:0", tomorrow)).ok).toBe(true);
  });

  it("通貨を止めると貯まらない", async () => {
    await saveEconomySettings(env, { enabled: false });
    const r = await earn(env, `eco-off-${crypto.randomUUID()}`, "login");
    expect(r.ok).toBe(false);
  });

  it("部屋に入るとその日の分が貯まり、クリアの知らせは部屋にある屋台のときだけ数える", async () => {
    const me = await makeUserCharacter("room");
    const res = await SELF.fetch(`${BASE}/api/meta/rooms/hiroba/ws`, { headers: { upgrade: "websocket" } });
    const ws = res.webSocket!;
    ws.accept();
    const inbox: Array<Record<string, any>> = [];
    ws.addEventListener("message", (e) => inbox.push(JSON.parse(String(e.data))));
    const wait = async (pred: (m: Record<string, any>) => boolean, timeout = 3000) => {
      const start = Date.now();
      while (Date.now() - start < timeout) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    };
    ws.send(JSON.stringify({ t: "join", characters: [{ cid: me.cid, token: me.token }] }));
    const welcome = await wait((m) => m.t === "welcome");
    const aid = welcome!.mine[0];
    const login = await wait((m) => m.t === "coins");
    expect(login).toMatchObject({ aid, amount: 10, reason: "login" });
    // 部屋に無い屋台は数えない
    ws.send(JSON.stringify({ t: "clear", aid, objectId: "no-such" }));
    expect(await wait((m) => m.t === "coins", 400)).toBeNull();
    await new Promise((r) => setTimeout(r, 8100));
    ws.send(JSON.stringify({ t: "clear", aid, objectId: "stars" }));
    const clear = await wait((m) => m.t === "coins");
    expect(clear).toMatchObject({ amount: 5, reason: "clear", balance: 15 });
    ws.close();
  }, 20000);
});

describe("お店と財布", () => {
  it("持ち主トークンが無いと財布は開けない。お金で買う口・換金の口・渡す口は無い", async () => {
    const me = await makeUserCharacter("owner");
    expect((await user("/api/meta/economy/wallet", { cid: me.cid, token: "wrong" })).status).toBe(403);
    expect((await user("/api/meta/economy/wallet", { cid: me.cid, token: me.token })).status).toBe(200);
    for (const p of ["/api/meta/economy/transfer", "/api/meta/economy/purchase", "/api/meta/economy/cashout", "/api/meta/economy/send"]) {
      expect((await user(p, { cid: me.cid, token: me.token, to: "x", amount: 1 })).status).toBe(404);
    }
  });

  it("残高より多くは買えない。買うと減り、身につけると部屋に配る形になる", async () => {
    const me = await makeUserCharacter("buy");
    const short = await user("/api/meta/economy/buy", { ...me, shopId: "zakka", itemId: "w-ribbon" });
    expect(short.status).toBe(409);
    await grant(env, me.cid, 100, "テスト");
    const shop = await user("/api/meta/economy/shop", { ...me, shopId: "zakka" });
    expect(shop.data.items.map((i: { id: string }) => i.id)).toContain("w-ribbon");
    // 別のお店の商品は、このお店では買えない
    expect((await user("/api/meta/economy/buy", { ...me, shopId: "zakka", itemId: "w-crown" })).status).toBe(409);
    const ok = await user("/api/meta/economy/buy", { ...me, shopId: "zakka", itemId: "w-ribbon" });
    expect(ok.status).toBe(200);
    expect(ok.data.balance).toBe(60);
    // 身につける物は2つ目を買えない
    const again = await user("/api/meta/economy/buy", { ...me, shopId: "zakka", itemId: "w-ribbon" });
    expect(again.data.error).toBe("持っています");
    const eq = await user("/api/meta/economy/equip", { ...me, itemId: "w-ribbon", on: true });
    expect(eq.data.wear).toEqual({ shape: "ribbon", color: "#ff7aa8" });
    const w = await user("/api/meta/economy/wallet", me);
    expect(w.data.balance).toBe(60);
    expect(w.data.inventory[0]).toMatchObject({ itemId: "w-ribbon", equipped: true });
    expect(w.data.ledger[0]).toMatchObject({ delta: -40, kind: "buy" });
  });

  it("同時に2回押しても、残高は負にならない", async () => {
    const me = await makeUserCharacter("race");
    await grant(env, me.cid, 15, "テスト");
    const results = await Promise.all([1, 2, 3].map(() => user("/api/meta/economy/buy", { ...me, shopId: "hanabi", itemId: "e-hearts" })));
    expect(results.filter((r) => r.status === 200).length).toBe(1);
    const w = await user("/api/meta/economy/wallet", me);
    expect(w.data.balance).toBe(5);
  });

  it("在庫がある商品は、売り切れたら買えない", async () => {
    const a = await makeUserCharacter("stock-a");
    const b = await makeUserCharacter("stock-b");
    const item = await admin("/api/admin/economy/items", "POST", { kind: "effect", name: "限定花火", price: 5, effect: "hanabi", stock: 1 });
    expect(item.status).toBe(200);
    await admin("/api/admin/economy/shops", "POST", { id: "limited", name: "限定のお店", itemIds: [item.data.item.id] });
    await grant(env, a.cid, 10, "テスト");
    await grant(env, b.cid, 10, "テスト");
    expect((await user("/api/meta/economy/buy", { ...a, shopId: "limited", itemId: item.data.item.id })).status).toBe(200);
    const sold = await user("/api/meta/economy/buy", { ...b, shopId: "limited", itemId: item.data.item.id });
    expect(sold.data.error).toBe("売り切れ");
  });

  it("お店の置く物は、どのお店かを選ばないと保存できない", () => {
    expect(sanitizeObjects([{ type: "shop", slot: "back" }]).ok).toBe(false);
    expect(sanitizeObjects([{ type: "shop", slot: "back", shopId: "zakka" }]).ok).toBe(true);
  });
});

describe("提携店の引換券（リアルで使う）", () => {
  it("暗証番号は作ったときだけ返り、引換券はその店の暗証番号でしか確かめられず、1回しか使えない", async () => {
    const shopA = await admin("/api/admin/economy/partners", "POST", { name: "カフェA", area: "渋谷" });
    const shopB = await admin("/api/admin/economy/partners", "POST", { name: "本屋B" });
    expect(shopA.data.pin).toMatch(/^\d{8}$/);
    const list = await admin("/api/admin/economy/partners");
    expect(JSON.stringify(list.data)).not.toContain(shopA.data.pin);
    const item = await admin("/api/admin/economy/items", "POST", { kind: "real", name: "ドリンク1杯", price: 50, partnerId: shopA.data.partner.id, validDays: 14, perPersonMonthly: 1, usage: "レジで画面を見せてください" });
    expect(item.status).toBe(200);
    await admin("/api/admin/economy/shops", "POST", { id: "koukan", name: "わけたま引き換え所", itemIds: [item.data.item.id] });
    const me = await makeUserCharacter("real");
    await grant(env, me.cid, 200, "テスト");

    // 受け付けを開くまでは引き換えられない
    const closed = await user("/api/meta/economy/buy", { ...me, shopId: "koukan", itemId: item.data.item.id });
    expect(closed.data.error).toBe("引き換えは準備中です");
    await saveEconomySettings(env, { realOpen: true });
    const bought = await user("/api/meta/economy/buy", { ...me, shopId: "koukan", itemId: item.data.item.id });
    expect(bought.status).toBe(200);
    const code = bought.data.voucher.code as string;
    expect(code).toMatch(/^[A-Z2-9]{10}$/);
    expect(bought.data.balance).toBe(150);
    // 1人1か月1枚まで
    const twice = await user("/api/meta/economy/buy", { ...me, shopId: "koukan", itemId: item.data.item.id });
    expect(twice.data.error).toBe("今月はもう引き換えました");

    // ほかの店の暗証番号では「見つからない」
    const wrong = await user("/api/redeem/check", { code, pin: shopB.data.pin });
    expect(wrong.status).toBe(404);
    const check = await user("/api/redeem/check", { code: code.replace(/(.{4})/, "$1-").toLowerCase(), pin: shopA.data.pin });
    expect(check.data.voucher).toMatchObject({ title: "ドリンク1杯", status: "issued", partnerName: "カフェA" });
    // お客さまの情報は返さない
    expect(JSON.stringify(check.data)).not.toContain(me.cid);
    const used = await user("/api/redeem/use", { code, pin: shopA.data.pin });
    expect(used.data).toMatchObject({ justUsed: true, voucher: { status: "used" } });
    const again = await user("/api/redeem/use", { code, pin: shopA.data.pin });
    expect(again.status).toBe(404);
    expect(again.data.error).toBe("この引換券は使用済みです");
    // 使用済みは取り消せない
    expect((await admin("/api/admin/economy/vouchers", "POST", { code, refund: true })).status).toBe(400);
    await saveEconomySettings(env, { realOpen: false });
  });

  it("運営が未使用の引換券を取り消すと、通貨が戻る", async () => {
    const shop = await admin("/api/admin/economy/partners", "POST", { name: "パン屋C" });
    const item = await admin("/api/admin/economy/items", "POST", { kind: "real", name: "パン1個", price: 30, partnerId: shop.data.partner.id });
    await admin("/api/admin/economy/shops", "POST", { id: "bakery", name: "パンの引き換え所", itemIds: [item.data.item.id] });
    await saveEconomySettings(env, { realOpen: true });
    const me = await makeUserCharacter("cancel");
    await grant(env, me.cid, 30, "テスト");
    const bought = await user("/api/meta/economy/buy", { ...me, shopId: "bakery", itemId: item.data.item.id });
    expect(bought.data.balance).toBe(0);
    expect((await admin("/api/admin/economy/vouchers", "POST", { code: bought.data.voucher.code, refund: true })).status).toBe(200);
    const w = await user("/api/meta/economy/wallet", me);
    expect(w.data.balance).toBe(30);
    expect(w.data.vouchers[0].status).toBe("cancelled");
    await saveEconomySettings(env, { realOpen: false });
  });

  it("管理画面の API は管理者だけ", async () => {
    const res = await SELF.fetch(`${BASE}/api/admin/economy/stats`);
    expect(res.status).not.toBe(200);
    const ok = await admin("/api/admin/economy/stats");
    expect(ok.status).toBe(200);
    expect(ok.data.stats).toHaveProperty("circulating");
  });
});
