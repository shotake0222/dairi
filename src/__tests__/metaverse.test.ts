import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { listRooms, sanitizeObjects, saveRoom } from "../metaverse";

/**
 * メタバースの検証。
 *
 * ここで守りたいのは、見知らぬ人と同じ空間にいる以上、壊れたら取り返しがつかない約束:
 *   1. 他人に配られるのは「名前・姿・声・動きの数値」だけ。分身の識別子・持ち主トークン・覚え書きは配らない
 *   2. 持ち主でない人は、他人の分身を連れて入れない
 *   3. 利用者が書いた文字は他人に配らない（挨拶は決まった台詞の番号、スタンプは決まった種類）
 *   4. 部屋（置く物＝広告・動画・ミニゲーム）は管理画面でだけ作れる。利用者が作る口は無い
 */

const BASE = "https://example.com";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

async function makeCharacter(label: string, consent = true) {
  const res = await SELF.fetch(`${BASE}/t/meta-${label}-${crypto.randomUUID().slice(0, 8)}`, { redirect: "manual" });
  const location = new URL(res.headers.get("location")!, BASE);
  const cid = location.searchParams.get("cid")!;
  const token = location.searchParams.get("token")!;
  if (consent) {
    await SELF.fetch(`${BASE}/api/consent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, token, consent: { terms: true } }),
    });
  }
  await SELF.fetch(`${BASE}/api/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, token, part: "seed", notes: "柴犬のコタロウを飼っている" }),
  });
  return { cid, token };
}

/** 部屋に接続して、届いた電文を順に受け取れるようにする */
async function connect(room: string, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${BASE}/api/meta/rooms/${room}/ws`, { headers: { upgrade: "websocket", ...headers } });
  const ws = res.webSocket;
  if (!ws) return { res, ws: null, next: async () => null as unknown, all: [] as unknown[] };
  ws.accept();
  const inbox: Array<Record<string, unknown>> = [];
  const waiters: Array<(m: Record<string, unknown>) => void> = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    const w = waiters.shift();
    if (w) w(m);
    else inbox.push(m);
  });
  const next = (timeout = 2000) =>
    new Promise<Record<string, unknown> | null>((resolve) => {
      const m = inbox.shift();
      if (m) return resolve(m);
      const waiter = (msg: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(msg);
      };
      // 待ちきれなかった受け手は外す（残すと、次の電文をこの受け手が飲み込んでしまう）
      const timer = setTimeout(() => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeout);
      waiters.push(waiter);
    });
  return { res, ws, next, all: inbox };
}

describe("部屋の設定（何を映すか・何で遊ぶか）", () => {
  it("ロビーには最初からある部屋が並び、選択肢の定義も一緒に返る", async () => {
    const data = await (await SELF.fetch(`${BASE}/api/meta/rooms`)).json<{
      rooms: Array<{ id: string; objects: Array<{ type: string }> }>;
      catalog: { places: unknown[]; cameras: unknown[]; objectTypes: unknown[]; slots: unknown[] };
    }>();
    const hiroba = data.rooms.find((r) => r.id === "hiroba")!;
    expect(hiroba).toBeTruthy();
    // 見本として、看板・紹介・3つのミニゲームが全部置いてある
    expect(new Set(hiroba.objects.map((o) => o.type))).toEqual(new Set(["board", "treasure", "quiz", "members", "rally"]));
    expect(data.catalog.cameras.length).toBe(4);
    expect(data.catalog.slots.length).toBe(7);
  });

  it("部屋は管理画面でだけ作れる（利用者向けの作る口は無い）", async () => {
    const res = await SELF.fetch(`${BASE}/api/meta/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "勝手な部屋" }),
    });
    expect(res.status).not.toBe(200);
    const admin = await SELF.fetch(`${BASE}/api/admin/meta/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "勝手な部屋" }),
    });
    expect([401, 403, 404]).toContain(admin.status);
  });

  it("広告の看板・動画・3つのミニゲームを置いた部屋を作れて、ロビーと入室で同じ設定が返る", async () => {
    const saved = await saveRoom(env, {
      name: "春のキャンペーン会場",
      place: "beach",
      time: "evening",
      camera: "front",
      objects: [
        { type: "board", slot: "back", title: "新発売", text: "春の限定キーホルダー", imageUrl: "https://example.com/a.png", linkUrl: "https://example.com/shop", ad: true },
        { type: "video", slot: "left", title: "紹介動画", videoUrl: "https://example.com/v.mp4" },
        { type: "treasure", slot: "back-left", count: 12, seconds: 45, clearMessage: "クーポン: SPRING" },
        { type: "quiz", slot: "back-right", questions: [{ q: "海は青い", a: "o", note: "そうです" }] },
        { type: "rally", slot: "front-left", points: 3 },
      ],
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    const got = await (await SELF.fetch(`${BASE}/api/meta/rooms/${saved.room.id}`)).json<{ room: { objects: Array<Record<string, unknown>> } }>();
    const board = got.room.objects.find((o) => o.type === "board")!;
    expect(board.ad).toBe(true);
    expect(board.linkUrl).toBe("https://example.com/shop");
    const treasure = got.room.objects.find((o) => o.type === "treasure")!;
    expect(treasure.count).toBe(12);
    expect(treasure.clearMessage).toBe("クーポン: SPRING");

    const lobby = await listRooms(env);
    expect(lobby.map((r) => r.id)).toContain(saved.room.id);
  });

  it("置く物の中身を信用しない（http のURL・重なった置き場所・問題の無いクイズ・多すぎる数）", () => {
    expect(sanitizeObjects([{ type: "board", slot: "back", text: "x", linkUrl: "http://example.com" }]).ok).toBe(false);
    expect(sanitizeObjects([{ type: "video", slot: "back", videoUrl: "javascript:alert(1)" }]).ok).toBe(false);
    expect(
      sanitizeObjects([
        { type: "members", slot: "left" },
        { type: "members", slot: "left" },
      ]).ok
    ).toBe(false);
    expect(sanitizeObjects([{ type: "quiz", slot: "back", questions: [] }]).ok).toBe(false);
    expect(sanitizeObjects(Array.from({ length: 8 }, (_, i) => ({ type: "members", slot: `s${i}` }))).ok).toBe(false);

    // 数値は範囲に収める（星1000個・制限時間0秒にはならない）
    const t = sanitizeObjects([{ type: "treasure", slot: "back", count: 1000, seconds: 0 }]);
    expect(t.ok && t.value[0].count).toBe(30);
    expect(t.ok && t.value[0].seconds).toBe(15);
    // 改行や制御文字は1行に
    const b = sanitizeObjects([{ type: "board", slot: "back", title: "a\n\nb", text: "本文" }]);
    expect(b.ok && b.value[0].title).toBe("a b");
  });

  it("最初からある部屋は直せない・消せない", async () => {
    const res = await saveRoom(env, { id: "hiroba", name: "のっとり" });
    expect(res.ok).toBe(false);
  });
});

describe("入室と中継", () => {
  it("持ち主トークンで分身を連れて入れる。配られるのは名前・姿・声・動きの数値だけ", async () => {
    const a = await makeCharacter("join");
    const c = await connect("hiroba");
    expect(c.ws).toBeTruthy();
    c.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    const welcome = (await c.next()) as Record<string, unknown>;
    expect(welcome.t).toBe("welcome");
    const actors = welcome.actors as Array<Record<string, unknown>>;
    expect(actors.length).toBeGreaterThanOrEqual(1);
    const mine = actors.find((x) => (welcome.mine as string[]).includes(x.aid as string))!;
    expect(mine.species).toBeTruthy();
    expect((mine.voice as { pitch: number }).pitch).toBeGreaterThan(0);
    expect((mine.compact as { m: number[] }).m.length).toBe(6);

    const text = JSON.stringify(welcome);
    expect(text).not.toContain(a.cid);
    expect(text).not.toContain(a.token);
    expect(text).not.toContain("コタロウ");
    c.ws!.close();
  });

  it("持ち主でなければ、他人の分身は連れて入れない", async () => {
    const a = await makeCharacter("steal");
    const c = await connect("hiroba");
    c.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: "not-the-owner" }] }));
    const msg = (await c.next()) as Record<string, unknown>;
    expect(msg.t).toBe("error");
    c.ws!.close();
  });

  it("移動・スタンプ・挨拶は、同じ部屋の他の人に届く（挨拶は台詞の番号だけ）", async () => {
    // 部屋を1つ作って（管理画面と同じ関数）、その中で2人を会わせる
    const created = await saveRoom(env, { name: `test-${crypto.randomUUID().slice(0, 8)}`, listed: false });
    if (!created.ok) throw new Error(created.error);
    const id = created.room.id;

    const a = await makeCharacter("relay-a");
    const b = await makeCharacter("relay-b");
    const ca = await connect(id);
    ca.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    const wa = (await ca.next()) as { mine: string[] };
    const cb = await connect(id);
    cb.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: b.cid, token: b.token }] }));
    const wb = (await cb.next()) as { actors: unknown[]; mine: string[] };
    // あとから入った人には、先にいた子も見える
    expect(wb.actors.length).toBe(2);
    // 先にいた人には、入ってきた子が届く
    const joined = (await ca.next()) as { t: string };
    expect(joined.t).toBe("joined");

    ca.ws!.send(JSON.stringify({ t: "move", aid: wa.mine[0], x: 3.2, z: -1.5 }));
    const moved = (await cb.next()) as { t: string; x: number; z: number };
    expect(moved.t).toBe("move");
    expect(moved.x).toBe(3.2);

    // 世界の外へは出られない
    ca.ws!.send(JSON.stringify({ t: "stamp", aid: wa.mine[0], kind: "heart" }));
    expect(((await cb.next()) as { kind: string }).kind).toBe("heart");

    // 自由な文字は配らない（text を付けても line の番号しか届かない）
    ca.ws!.send(JSON.stringify({ t: "greet", aid: wa.mine[0], line: 1, text: "連絡先おしえて" }));
    const greet = (await cb.next()) as Record<string, unknown>;
    expect(greet.t).toBe("greet");
    expect(greet.line).toBe(1);
    expect(JSON.stringify(greet)).not.toContain("連絡先");

    // 他人の分身は動かせない
    cb.ws!.send(JSON.stringify({ t: "move", aid: wa.mine[0], x: 0, z: 0 }));
    expect(await ca.next(300)).toBeNull();

    // 出ていったら、残った人に知らせる（画面は閉じる前に leave を送る）
    cb.ws!.send(JSON.stringify({ t: "leave" }));
    cb.ws!.close();
    const left = (await ca.next()) as { t: string; aids: string[] };
    expect(left.t).toBe("left");
    expect(left.aids).toEqual(wb.mine);
    ca.ws!.close();
  });

  it("同じ子を2つの端末から重ねて連れて入れない", async () => {
    const a = await makeCharacter("dup");
    const c1 = await connect("yozora");
    c1.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    expect(((await c1.next()) as { t: string }).t).toBe("welcome");
    const c2 = await connect("yozora");
    c2.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    expect(((await c2.next()) as { t: string }).t).toBe("error");
    c1.ws!.close();
    c2.ws!.close();
  });

  it("よそのサイトからの接続は断る", async () => {
    const res = await SELF.fetch(`${BASE}/api/meta/rooms/hiroba/ws`, {
      headers: { upgrade: "websocket", origin: "https://evil.example.net" },
    });
    expect(res.status).toBe(403);
  });

  it("無い部屋には入れない", async () => {
    const res = await SELF.fetch(`${BASE}/api/meta/rooms/no-such-room/ws`, { headers: { upgrade: "websocket" } });
    expect(res.status).toBe(404);
  });
});
