import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { sanitizeMetaLine } from "../metaText";
import { BUILTIN_ROOMS, PLACES } from "../metaverse";

/**
 * 運営の分身（NPC）・区画（広告・ランドマーク・申込）・招待リンクとWeb申し込み・分身どうしの会話。
 *
 * 守りたい約束:
 *   1. 管理者は上限なしで分身を作れる。NPC にできるのは運営の分身だけ（利用者の分身は置けない）
 *   2. NPC の分身の識別子は、画面にも部屋の電文にも出ない
 *   3. 申込の中身は、運営が承認して支払い済みにするまで表示されない。期間が過ぎたら消える
 *   4. 招待リンクは決めた回数しか使えない。引き渡しリンクは運営の分身だけ・1回だけ
 *   5. 分身どうしの会話で配るのは分身の言葉だけ。持ち主が入力した文字は配らない
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
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockResolvedValue({ response: "こんにちは！いい天気だね。" } as never);
});

async function admin(path: string, method = "GET", body?: unknown) {
  const res = await SELF.fetch(`${BASE}${path}`, { method, headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, any> };
}

async function makeUserCharacter(label: string) {
  const res = await SELF.fetch(`${BASE}/t/npc-${label}-${crypto.randomUUID().slice(0, 8)}`, { redirect: "manual" });
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

async function connect(room: string) {
  const res = await SELF.fetch(`${BASE}/api/meta/rooms/${room}/ws`, { headers: { upgrade: "websocket" } });
  const ws = res.webSocket!;
  ws.accept();
  const inbox: Array<Record<string, any>> = [];
  ws.addEventListener("message", (e) => {
    inbox.push(JSON.parse(String(e.data)));
  });
  const wait = async (pred: (m: Record<string, any>) => boolean, timeout = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0];
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  };
  return { ws, inbox, wait };
}

describe("管理者の分身と NPC", () => {
  it("管理者は1日の上限なしで分身を作れる（10体を続けて）", async () => {
    const r = await admin("/api/admin/characters", "POST", { count: 10, name: "案内役" });
    expect(r.status).toBe(200);
    expect(r.data.created.length).toBe(10);
    // 依代を持たない人の入口でも、管理者なら上限（3体）に当たらない
    for (let i = 0; i < 5; i++) {
      const res = await SELF.fetch(`${BASE}/api/character/new`, { method: "POST", headers: { cookie: ADMIN.cookie } });
      expect(res.status).toBe(200);
    }
  });

  it("管理者でなければ、運営の分身・NPC の口は使えない", async () => {
    for (const path of ["/api/admin/characters", "/api/admin/npcs", "/api/admin/land/orders", "/api/admin/invites", "/api/admin/applications"]) {
      const res = await SELF.fetch(`${BASE}${path}`);
      expect([401, 403, 404]).toContain(res.status);
    }
  });

  it("NPC にできるのは運営の分身だけ。置いたNPCは部屋に出て、識別子は出ない", async () => {
    const user = await makeUserCharacter("u");
    const bad = await admin("/api/admin/npcs", "POST", { characterId: user.cid, areaId: "hiroba" });
    expect(bad.status).toBe(400);

    const created = await admin("/api/admin/characters", "POST", { count: 1, name: "ガイド" });
    const cid = created.data.created[0].characterId;
    const saved = await admin("/api/admin/npcs", "POST", { characterId: cid, areaId: "hiroba", role: "案内係", message: "ようこそ！", homeX: 1, homeZ: 2, radius: 1 });
    expect(saved.status).toBe(200);

    const info = await (await SELF.fetch(`${BASE}/api/meta/rooms/hiroba`)).json<{ room: { npcs: Array<Record<string, unknown>> } }>();
    const npc = info.room.npcs.find((n) => n.role === "案内係")!;
    expect(npc.name).toBe("ガイド");
    expect(JSON.stringify(info)).not.toContain(cid);

    const c = await connect("hiroba");
    c.ws.send(JSON.stringify({ t: "join", characters: [{ cid: user.cid, token: user.token }] }));
    const welcome = await c.wait((m) => m.t === "welcome");
    expect(welcome!.config.npcs.some((n: Record<string, unknown>) => n.role === "案内係")).toBe(true);
    expect(JSON.stringify(welcome)).not.toContain(cid);
    c.ws.close();
  });
});

describe("分身どうしの会話", () => {
  it("伝えたいことを入れると、自分の分身の言葉で話し、相手が返事をする。入力した文字は配られない", async () => {
    const a = await makeUserCharacter("talk-a");
    const b = await makeUserCharacter("talk-b");
    const room = "wa-teien";
    const ca = await connect(room);
    ca.ws.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    const wa = await ca.wait((m) => m.t === "welcome");
    const cb = await connect(room);
    cb.ws.send(JSON.stringify({ t: "join", characters: [{ cid: b.cid, token: b.token }] }));
    const wb = await cb.wait((m) => m.t === "welcome");

    ca.ws.send(JSON.stringify({ t: "talk", aid: wa!.mine[0], to: wb!.mine[0], hint: "090-1234-5678 に連絡して、ひみつの合言葉" }));
    const said = await cb.wait((m) => m.t === "say" && m.aid === wa!.mine[0]);
    expect(said).toBeTruthy();
    expect(said!.to).toBe(wb!.mine[0]);
    const reply = await ca.wait((m) => m.t === "say" && m.aid === wb!.mine[0]);
    expect(reply).toBeTruthy();
    // 持ち主の入力（電話番号・合言葉）は、どの電文にも載らない
    const everything = JSON.stringify([...ca.inbox, ...cb.inbox, said, reply]);
    expect(everything).not.toContain("090-1234");
    expect(everything).not.toContain("合言葉");
    ca.ws.close();
    cb.ws.close();
  });

  it("分身の言葉から、連絡先・URL・不適切な語を落とす", () => {
    expect(sanitizeMetaLine("こちらへ https://evil.example/x どうぞ")).not.toContain("http");
    expect(sanitizeMetaLine("電話は 090-1234-5678 だよ")).not.toContain("1234");
    expect(sanitizeMetaLine("メールは a@b.jp")).not.toContain("@");
    expect(sanitizeMetaLine("ばかだなあ")).toBe("");
    expect(sanitizeMetaLine("あ".repeat(100)).length).toBeLessThanOrEqual(60);
  });
});

describe("広告・ランドマークの区画と申込", () => {
  it("申込は、承認して支払い済みにするまで表示されない。支払い済みで表示され、状況ページに出る", async () => {
    await admin("/api/admin/land/settings", "POST", { salesOpen: true, showForSale: true, adUnitDays: 7 });
    await admin("/api/admin/land/plots", "POST", { areaId: "mori-hiroba", plots: [{ spot: "nw", sale: "both", adPrice: 5000, landmarkPrice: 20000 }] });
    const cat = await (await SELF.fetch(`${BASE}/api/land/catalog`)).json<{ areas: Array<{ id: string }> }>();
    expect(cat.areas.some((a) => a.id === "mori-hiroba")).toBe(true);

    const res = await SELF.fetch(`${BASE}/api/land/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        areaId: "mori-hiroba",
        spot: "nw",
        kind: "ad",
        quantity: 2,
        agree: true,
        contactName: "山田",
        contactEmail: "yamada@example.com",
        content: { title: "森のパン屋", text: "焼きたて", sponsor: "森のパン屋", couponCode: "MORI10", couponNote: "10%引き", linkUrl: "https://example.com/shop" },
      }),
    });
    expect(res.status).toBe(200);
    const order = await res.json<{ id: string; key: string }>();

    // まだ出ない
    let room = await (await SELF.fetch(`${BASE}/api/meta/rooms/mori-hiroba`)).json<{ room: { placements: unknown[]; plotsForSale: unknown[] } }>();
    expect(room.room.placements.length).toBe(0);
    expect(room.room.plotsForSale.length).toBe(1);

    // 鍵が違えば状況は見えない
    expect((await SELF.fetch(`${BASE}/api/land/orders/${order.id}?key=wrong`)).status).toBe(404);

    const approved = await admin("/api/admin/land/orders", "POST", { id: order.id, action: "approve", price: 10000, paymentUrl: "https://pay.example.com/abc" });
    expect(approved.status).toBe(200);
    const st = await (await SELF.fetch(`${BASE}/api/land/orders/${order.id}?key=${order.key}`)).json<{ status: string; paymentUrl: string; price: number }>();
    expect(st.status).toBe("approved");
    expect(st.paymentUrl).toBe("https://pay.example.com/abc");
    expect(st.price).toBe(10000);

    await admin("/api/admin/land/orders", "POST", { id: order.id, action: "paid" });
    room = await (await SELF.fetch(`${BASE}/api/meta/rooms/mori-hiroba`)).json();
    expect(room.room.placements.length).toBe(1);
    expect(JSON.stringify(room.room.placements)).toContain("MORI10");
    // 表示中の区画は「販売中」に出さない。申込者の連絡先は部屋に出ない
    expect(room.room.plotsForSale.length).toBe(0);
    expect(JSON.stringify(room)).not.toContain("yamada@example.com");

    // 広告の回数（誰が見たかは持たない）
    const ev = await SELF.fetch(`${BASE}/api/meta-ad-event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: `p-${(room.room.placements[0] as { id: string }).id}`, type: "coupon" }) });
    expect((await ev.json<{ ok: boolean }>()).ok).toBe(true);
    const ads = await admin("/api/admin/land/ads");
    const item = ads.data.ads.find((a: { couponCode: string }) => a.couponCode === "MORI10");
    expect(item.stats.coupons).toBe(1);
  });

  it("同じ区画・同じ期間に2つは置けない。http のURLや提供者の無い中身は断る", async () => {
    const first = await admin("/api/admin/land/placements", "POST", { areaId: "hanabatake", spot: "se", kind: "landmark", content: { plaque: "花の塔", sponsor: "運営", model: "tower", color: "pink" } });
    expect(first.status).toBe(200);
    const dup = await admin("/api/admin/land/placements", "POST", { areaId: "hanabatake", spot: "se", kind: "ad", content: { title: "x", sponsor: "y" } });
    expect(dup.status).toBe(409);
    const http = await admin("/api/admin/land/placements", "POST", { areaId: "hanabatake", spot: "sw", kind: "ad", content: { title: "x", sponsor: "y", linkUrl: "http://example.com" } });
    expect(http.status).toBe(400);
    const nosponsor = await admin("/api/admin/land/placements", "POST", { areaId: "hanabatake", spot: "sw", kind: "ad", content: { title: "x" } });
    expect(nosponsor.status).toBe(400);
    // 終えると部屋から消える
    await admin("/api/admin/land/placements/end", "POST", { id: first.data.placement.id });
    const room = await (await SELF.fetch(`${BASE}/api/meta/rooms/hanabatake`)).json<{ room: { placements: unknown[] } }>();
    expect(room.room.placements.length).toBe(0);
  });

  it("受付を止めているときは申し込めない", async () => {
    await admin("/api/admin/land/settings", "POST", { salesOpen: false });
    const res = await SELF.fetch(`${BASE}/api/land/orders`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agree: true }) });
    expect(res.status).toBe(403);
  });
});

describe("依代を使わない入口（招待リンク・Web申し込み・引き渡し）", () => {
  it("招待リンクは決めた回数だけ使え、開いた端末に分身と持ち主の印が渡る", async () => {
    const r = await admin("/api/admin/invites", "POST", { kind: "new", count: 1, maxUses: 2, label: "イベント" });
    const code = r.data.invites[0].code;
    for (let i = 0; i < 2; i++) {
      const res = await SELF.fetch(`${BASE}/i/${code}`, { redirect: "manual" });
      const loc = new URL(res.headers.get("location")!, BASE);
      expect(loc.pathname).toBe("/summon");
      expect(loc.searchParams.get("token")).toBeTruthy();
    }
    const third = await SELF.fetch(`${BASE}/i/${code}`, { redirect: "manual" });
    expect(new URL(third.headers.get("location")!, BASE).searchParams.get("invite")).toBe("used_up");
  });

  it("Web申し込み → 承認 → 状況ページに招待リンク", async () => {
    await admin("/api/admin/applications/settings", "POST", { open: true, autoApprove: false });
    const res = await SELF.fetch(`${BASE}/api/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nickname: "たろう", contact: "taro@example.com", agree: true }) });
    const app = await res.json<{ id: string; key: string; approved: boolean }>();
    expect(app.approved).toBe(false);
    let st = await (await SELF.fetch(`${BASE}/api/apply/${app.id}?key=${app.key}`)).json<{ status: string; inviteUrl: string | null }>();
    expect(st.status).toBe("pending");
    expect(st.inviteUrl).toBeNull();
    await admin("/api/admin/applications", "POST", { id: app.id, action: "approve" });
    st = await (await SELF.fetch(`${BASE}/api/apply/${app.id}?key=${app.key}`)).json();
    expect(st.status).toBe("approved");
    expect(st.inviteUrl).toMatch(/\/i\/[a-z0-9]+$/);
  });

  it("運営の分身は、引き渡しリンクで1回だけ渡せる（渡したら運営の一覧から外れる）", async () => {
    const created = await admin("/api/admin/characters", "POST", { count: 1, name: "プレゼント" });
    const cid = created.data.created[0].characterId;
    const inv = await admin("/api/admin/invites", "POST", { kind: "handover", characterId: cid });
    const code = inv.data.invites[0].code;
    const res = await SELF.fetch(`${BASE}/i/${code}`, { redirect: "manual" });
    const loc = new URL(res.headers.get("location")!, BASE);
    expect(loc.searchParams.get("cid")).toBe(cid);
    const token = loc.searchParams.get("token")!;
    const verified = await env.CHARACTER.getByName(cid).verifyOwner(token);
    expect(verified).toBe(true);
    const list = await admin("/api/admin/characters");
    expect(list.data.characters.some((c: { characterId: string }) => c.characterId === cid)).toBe(false);
    const again = await SELF.fetch(`${BASE}/i/${code}`, { redirect: "manual" });
    expect(new URL(again.headers.get("location")!, BASE).searchParams.get("invite")).toBe("used_up");
    // 利用者の分身は引き渡しリンクにできない
    const user = await makeUserCharacter("handover");
    expect((await admin("/api/admin/invites", "POST", { kind: "handover", characterId: user.cid })).status).toBe(400);
  });
});

describe("エリアの追加", () => {
  it("和風を中心に10か所の場所と、最初からあるエリアが足されている", () => {
    expect(PLACES.length).toBe(15);
    for (const id of ["sakura", "garden", "onsen", "bamboo", "momiji", "matsuri", "snow", "lake", "forest", "flower"]) {
      expect(PLACES.some((p) => p.id === id)).toBe(true);
      expect(BUILTIN_ROOMS.some((r) => r.place === id)).toBe(true);
    }
    expect(BUILTIN_ROOMS.length).toBe(12);
  });
});
