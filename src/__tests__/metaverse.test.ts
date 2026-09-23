import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { SENSOR_GAMES, areaState, deleteRoom, getGameSettings, listRooms, mergeRooms, sanitizeObjects, saveGameSettings, saveRoom } from "../metaverse";

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
    // 通貨が貯まった知らせ（本人にだけ届く。src/economy.ts）は、中継の確かめには関係ないので読み飛ばす
    if (m.t === "coins") return;
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
    // 見本として、看板・紹介・3つのミニゲームと、お店（雑貨屋・引き換え所）が置いてある
    expect(new Set(hiroba.objects.map((o) => o.type))).toEqual(new Set(["board", "treasure", "quiz", "members", "rally", "shop"]));
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

  it("最初からあるエリアも管理画面から直せて、消すと元に戻る", async () => {
    const res = await saveRoom(env, { id: "hiroba", name: "秋のひろば", objects: [{ type: "members", slot: "back" }] });
    expect(res.ok).toBe(true);
    let got = await (await SELF.fetch(`${BASE}/api/meta/rooms/hiroba`)).json<{ room: { name: string; builtin: boolean } }>();
    expect(got.room.name).toBe("秋のひろば");
    expect(got.room.builtin).toBe(true);
    const del = await deleteRoom(env, "hiroba");
    expect(del.restored).toBe(true);
    got = await (await SELF.fetch(`${BASE}/api/meta/rooms/hiroba`)).json<{ room: { name: string; builtin: boolean } }>();
    expect(got.room.name).toBe("わけたまのひろば");
  });
});

describe("エリアの管理（開放予約・閉鎖・まとめる）", () => {
  it("開放日時より前は「近日開放」で一覧に出るが、入れない", async () => {
    const saved = await saveRoom(env, { name: "冬のエリア", opensAt: Date.now() + 86_400_000 });
    if (!saved.ok) throw new Error(saved.error);
    expect(areaState(saved.room)).toBe("soon");
    const lobby = await listRooms(env);
    expect(lobby.find((r) => r.id === saved.room.id)?.state).toBe("soon");
    const info = await (await SELF.fetch(`${BASE}/api/meta/rooms/${saved.room.id}`)).json<{ canEnter: boolean; state: string }>();
    expect(info.canEnter).toBe(false);
    const ws = await SELF.fetch(`${BASE}/api/meta/rooms/${saved.room.id}/ws`, { headers: { upgrade: "websocket" } });
    expect(ws.status).toBe(409);
    expect((await ws.json<{ code: string }>()).code).toBe("soon");
  });

  it("終了日時を過ぎた・閉鎖した・準備中のエリアは一覧に出ず、入れない", async () => {
    const ended = await saveRoom(env, { name: "夏祭り", opensAt: Date.now() - 2000, closesAt: Date.now() - 1000 });
    const closed = await saveRoom(env, { name: "閉じた", status: "closed" });
    const draft = await saveRoom(env, { name: "準備中", status: "draft" });
    if (!ended.ok || !closed.ok || !draft.ok) throw new Error("save failed");
    const ids = (await listRooms(env)).map((r) => r.id);
    for (const r of [ended.room, closed.room, draft.room]) {
      expect(ids).not.toContain(r.id);
      const ws = await SELF.fetch(`${BASE}/api/meta/rooms/${r.id}/ws`, { headers: { upgrade: "websocket" } });
      expect(ws.status).toBe(409);
    }
    // 終了日時は開放日時より後でなければならない
    expect((await saveRoom(env, { name: "x", opensAt: 2000, closesAt: 1000 })).ok).toBe(false);
  });

  it("2つのエリアを1つにまとめると、古いエリアのリンクはまとめた先へ案内される", async () => {
    const merged = await mergeRooms(env, {
      targetId: "hiroba",
      sourceIds: ["yozora"],
      room: { name: "ひろばと夜空", place: "meadow", time: "evening", objects: [{ type: "members", slot: "back" }, { type: "skycatch", slot: "left" }] },
    });
    expect(merged.ok).toBe(true);
    const lobby = (await listRooms(env)).map((r) => r.id);
    expect(lobby).toContain("hiroba");
    expect(lobby).not.toContain("yozora");
    // 古いリンク（yozora）で来ても、まとめた先の設定が返る
    const info = await (await SELF.fetch(`${BASE}/api/meta/rooms/yozora`)).json<{ room: { id: string; name: string }; movedFrom: string }>();
    expect(info.room.id).toBe("hiroba");
    expect(info.movedFrom).toBe("yozora");
    // 入室の口は、まとめた先を教えて断る
    const ws = await SELF.fetch(`${BASE}/api/meta/rooms/yozora/ws`, { headers: { upgrade: "websocket" } });
    expect(ws.status).toBe(409);
    expect(await ws.json()).toMatchObject({ code: "moved", movedTo: "hiroba" });
    // まとめ先を消すと、まとめた元は元に戻る（行き先の無いリンクを作らない）
    await deleteRoom(env, "hiroba");
    const back = await (await SELF.fetch(`${BASE}/api/meta/rooms/yozora`)).json<{ room: { id: string }; movedFrom: string | null }>();
    expect(back.room.id).toBe("yozora");
    expect(back.movedFrom).toBeNull();
    // 自分自身へはまとめられない
    expect((await mergeRooms(env, { targetId: "hiroba", sourceIds: ["hiroba"], room: { name: "x" } })).ok).toBe(false);
  });
});

describe("ミニゲームの管理", () => {
  it("センサーのミニゲームは20種類あり、目標と時間は決めた範囲に収める", () => {
    expect(Object.keys(SENSOR_GAMES).length).toBe(20);
    for (const [type, spec] of Object.entries(SENSOR_GAMES)) {
      const r = sanitizeObjects([{ type, slot: "back", goal: 99999, seconds: 99999, level: 9 }]);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      const o = r.value[0];
      expect(o.type).toBe(type);
      if (spec.goal) expect(o.goal).toBe(spec.goal.max);
      else expect(o.goal).toBeUndefined();
      if (spec.seconds) expect(o.seconds).toBe(spec.seconds.max);
      else expect(o.seconds).toBeUndefined();
      expect(o.level).toBe(3);
    }
  });

  it("止めたミニゲームは、置いたままでもどのエリアにも出ない", async () => {
    await saveGameSettings(env, { disabled: ["tilt", "treasure", "no-such-game"], defaults: { shake: { goal: 50, seconds: 5 } } });
    const settings = await getGameSettings(env);
    expect(settings.disabled).toEqual(["tilt", "treasure"]);
    // 既定値も範囲に収める
    expect(settings.defaults.shake.goal).toBe(50);
    expect(settings.defaults.shake.seconds).toBe(10);
    const got = await (await SELF.fetch(`${BASE}/api/meta/rooms/hiroba`)).json<{ room: { objects: Array<{ type: string }> } }>();
    const types = got.room.objects.map((o) => o.type);
    expect(types).not.toContain("tilt");
    expect(types).not.toContain("treasure");
    expect(types).toContain("quiz");
  });

  it("管理のAPIは管理者だけ", async () => {
    for (const [path, method] of [
      ["/api/admin/meta/games", "GET"],
      ["/api/admin/meta/games", "POST"],
      ["/api/admin/meta/merge", "POST"],
      ["/api/admin/meta/games/test", "POST"],
    ]) {
      const res = await SELF.fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      expect([401, 403, 404]).toContain(res.status);
    }
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
    const msg = (await c.next()) as { t: string; code: string; rejected: Array<{ index: number; code: string }> };
    expect(msg.t).toBe("error");
    // 画面が「どうすれば入れるか」を案内できるように、断った理由を種類で返す
    expect(msg.code).toBe("join_failed");
    expect(msg.rejected).toEqual([{ index: 0, code: "not_owner" }]);
    c.ws!.close();
  });

  it("利用規約に同意していない子は連れて入れず、理由は no_consent と分かる", async () => {
    const a = await makeCharacter("noconsent", false);
    const c = await connect("hiroba");
    c.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    const msg = (await c.next()) as { t: string; rejected: Array<{ code: string }> };
    expect(msg.t).toBe("error");
    expect(msg.rejected[0].code).toBe("no_consent");
    c.ws!.close();
  });

  it("入れた子と入れなかった子が混ざるときは、入れた子だけで入り、入れなかった理由を知らせる", async () => {
    const ok = await makeCharacter("mix-ok");
    const ng = await makeCharacter("mix-ng", false);
    const c = await connect("hiroba");
    c.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: ok.cid, token: ok.token }, { cid: ng.cid, token: ng.token }] }));
    const msg = (await c.next()) as { t: string; mine: string[]; notices: Array<{ index: number; code: string }> };
    expect(msg.t).toBe("welcome");
    expect(msg.mine.length).toBe(1);
    expect(msg.notices).toEqual([{ index: 1, code: "no_consent" }]);
    c.ws!.close();
  });

  it("いる間にエリアがまとめられたら、まとめた先を知らせる", async () => {
    const created = await saveRoom(env, { name: `move-${crypto.randomUUID().slice(0, 8)}`, listed: false });
    if (!created.ok) throw new Error(created.error);
    const a = await makeCharacter("moved");
    const c = await connect(created.room.id);
    c.ws!.send(JSON.stringify({ t: "join", characters: [{ cid: a.cid, token: a.token }] }));
    expect(((await c.next()) as { t: string }).t).toBe("welcome");
    await env.META_ROOM.getByName(created.room.id).pushConfig(created.room, "moved", "hiroba");
    expect(await c.next()).toMatchObject({ t: "moved", to: "hiroba" });
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
