import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { generateTagId, issueTags, listSpots, listTags, saveSpot } from "../yorishiro";

/**
 * 依代（NFCタグ・QR）の検証。
 *
 * ここで守りたいのは、集める体験の土台になっている2つの約束:
 *   1. **1つの依代からは1体しか生まれない**（2回目以降は同じ子へ）
 *   2. **入口の種類で姿の出方が変わらない**（/t/ でも /q/ でもランダム）
 * どちらかが崩れると、依代を集める理由そのものが消える。
 * 見落としやすいのは2で、QRだけ別処理にした瞬間に静かに壊れる類のもの。
 */

const BASE = "https://example.com";

function freshCode(label: string): string {
  return `test-${label}-${crypto.randomUUID().slice(0, 8)}`;
}

/** リダイレクト先の /summon から cid を取り出す。 */
function cidOf(res: Response): string {
  const location = res.headers.get("location") || "";
  return new URL(location, BASE).searchParams.get("cid") || "";
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

describe("依代の読み取り（/t/ と /q/）", () => {
  it("1つの依代からは1体しか生まれず、2回目は同じ子に戻る", async () => {
    const code = freshCode("once");
    const first = await SELF.fetch(`${BASE}/t/${code}`, { redirect: "manual" });
    const second = await SELF.fetch(`${BASE}/t/${code}`, { redirect: "manual" });

    expect(first.status).toBe(302);
    const cid = cidOf(first);
    expect(cid).not.toBe("");
    // 誕生は初回だけ。2回目に first=1 が付くと、演出も名付けもやり直しになる
    expect(new URL(first.headers.get("location")!, BASE).searchParams.get("first")).toBe("1");
    expect(cidOf(second)).toBe(cid);
    expect(new URL(second.headers.get("location")!, BASE).searchParams.get("first")).toBeNull();
  });

  it("/q/ と /t/ は同じ台帳を引く（同じコードなら同じ子）", async () => {
    const code = freshCode("same");
    const viaQr = await SELF.fetch(`${BASE}/q/${code}`, { redirect: "manual" });
    const viaNfc = await SELF.fetch(`${BASE}/t/${code}`, { redirect: "manual" });
    expect(cidOf(viaNfc)).toBe(cidOf(viaQr));
  });

  it("持ち主の印は誕生の瞬間だけURLに乗り、2回目以降は乗らない", async () => {
    const code = freshCode("token");
    const first = await SELF.fetch(`${BASE}/t/${code}`, { redirect: "manual" });
    const second = await SELF.fetch(`${BASE}/t/${code}`, { redirect: "manual" });
    expect(new URL(first.headers.get("location")!, BASE).searchParams.get("token")).toBeTruthy();
    expect(new URL(second.headers.get("location")!, BASE).searchParams.get("token")).toBeNull();
  });

  /**
   * 姿の出方が入口で変わらないこと。
   *
   * 種族5種・色6種の30通りから引くので、20体も取れば普通は複数種類になる。
   * 「どちらかの入口だけ1種類に偏っている」状態を捕まえたいだけなので、
   * 分布の厳密さは見ない（見るとAIやランダムの揺れでたまに落ちるテストになる）。
   */
  it("入口の種類で姿が固定されない", async () => {
    const seen: Record<string, Set<string>> = { t: new Set(), q: new Set() };
    for (const path of ["t", "q"] as const) {
      for (let i = 0; i < 12; i++) {
        const res = await SELF.fetch(`${BASE}/${path}/${freshCode(`rand-${path}-${i}`)}`, { redirect: "manual" });
        const state = await env.CHARACTER.getByName(cidOf(res)).getState();
        seen[path].add(`${state!.species}/${state!.color}`);
      }
    }
    expect(seen.t.size).toBeGreaterThan(1);
    expect(seen.q.size).toBeGreaterThan(1);
  });

  it("コードが空なら何も作らない", async () => {
    const res = await SELF.fetch(`${BASE}/t/`, { redirect: "manual" });
    expect(res.status).toBe(400);
  });
});

describe("依代を持たない人の入口（/api/character/new）", () => {
  it("分身を1体作り、持ち主の印を返す", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/new`, { method: "POST" });
    expect(res.status).toBe(200);
    const data = await res.json<{ characterId: string; ownerToken: string }>();
    expect(data.characterId).toBeTruthy();
    expect(data.ownerToken).toBeTruthy();

    const state = await env.CHARACTER.getByName(data.characterId).getState();
    expect(state?.interactionCount).toBe(0);
  });
});

describe("運営側の台帳", () => {
  it("読みにくい文字をコードに使わない（手で書き写す場面があるため）", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateTagId()).toMatch(/^[23456789abcdefghjkmnpqrstuvwxyz]{10}$/);
    }
  });

  it("発行した依代は、使われるまで未使用として見える", async () => {
    const batch = freshCode("batch");
    const issued = await issueTags(env, { count: 3, kind: "qr", batch });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;

    const before = (await listTags(env, 1000)).filter((t) => t.batch === batch);
    expect(before).toHaveLength(3);
    expect(before.every((t) => t.claimedAt === null)).toBe(true);

    await SELF.fetch(`${BASE}/q/${issued.tagIds[0]}`, { redirect: "manual" });

    const after = (await listTags(env, 1000)).filter((t) => t.batch === batch);
    expect(after.filter((t) => t.characterId !== null)).toHaveLength(1);
  });

  it("存在しない配布元を指した発行は断る（あとで追えなくなるため）", async () => {
    const result = await issueTags(env, { count: 1, spot: "no-such-place" });
    expect(result.ok).toBe(false);
  });

  it("配布元ごとに、発行数と使用済み数が数えられる", async () => {
    const code = freshCode("spot").slice(0, 32);
    const saved = await saveSpot(env, { code, label: "テスト神社", note: "ここでだけ" });
    expect(saved.ok).toBe(true);

    const issued = await issueTags(env, { count: 2, kind: "qr", spot: code });
    expect(issued.ok).toBe(true);
    if (!issued.ok) return;
    await SELF.fetch(`${BASE}/q/${issued.tagIds[0]}`, { redirect: "manual" });

    const spot = (await listSpots(env)).find((s) => s.code === code);
    expect(spot?.issued).toBe(2);
    expect(spot?.claimed).toBe(1);
  });

  it("配布元のある依代から生まれた子には、どこで会ったかが渡る", async () => {
    const code = freshCode("origin").slice(0, 32);
    await saveSpot(env, { code, label: "出雲の社", note: "境内でだけ" });
    const issued = await issueTags(env, { count: 1, kind: "qr", spot: code });
    if (!issued.ok) return;

    const res = await SELF.fetch(`${BASE}/q/${issued.tagIds[0]}`, { redirect: "manual" });
    const location = new URL(res.headers.get("location")!, BASE);
    expect(location.searchParams.get("spot")).toBe(code);

    // 画面に出すのは、公開してよい範囲だけ（運営用の設置メモは出さない）
    const info = await SELF.fetch(`${BASE}/api/spot?code=${code}`);
    const body = await info.json<{ spot: { label: string; note: string; place?: string } }>();
    expect(body.spot.label).toBe("出雲の社");
    expect(body.spot.place).toBeUndefined();
  });
});
