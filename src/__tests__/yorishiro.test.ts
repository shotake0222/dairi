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

/**
 * 場所限定の姿（migration 0011）。
 *
 * ここで守りたいのは、**運営が決められるのは「どの範囲から引くか」までで、
 * 「どの子が出るか」ではない**という線。緩めすぎると「引き当てた」が「配られた」になる。
 */
describe("場所限定の姿", () => {
  async function birth(spotCode: string): Promise<{ species: string; color: string }> {
    const issued = await issueTags(env, { count: 1, kind: "qr", spot: spotCode });
    if (!issued.ok) throw new Error("依代を発行できませんでした");
    const res = await SELF.fetch(`${BASE}/q/${issued.tagIds[0]}`, { redirect: "manual" });
    const cid = cidOf(res);
    const state = await (await SELF.fetch(`${BASE}/api/character?cid=${cid}`)).json<{
      species: string;
      color: string;
    }>();
    return state;
  }

  it("範囲を絞った配布元からは、その範囲の姿しか出ない", async () => {
    const code = freshCode("limited").slice(0, 32);
    await saveSpot(env, {
      code,
      label: "八重垣神社",
      speciesPool: ["kiratsubu"],
      colorPool: ["sun", "lavender"],
    });

    // 乱数なので、何度か引いて全部が範囲内であることを見る
    for (let i = 0; i < 12; i++) {
      const { species, color } = await birth(code);
      expect(species).toBe("kiratsubu");
      expect(["sun", "lavender"]).toContain(color);
    }
  });

  it("色だけ絞ることもできる（種族は制限なしのまま）", async () => {
    const code = freshCode("coloronly").slice(0, 32);
    await saveSpot(env, { code, label: "港の灯台", colorPool: ["peach"] });
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const { species, color } = await birth(code);
      expect(color).toBe("peach");
      seen.add(species);
    }
    // 種族は絞っていないので、10回も引けばふつうは複数出る
    expect(seen.size).toBeGreaterThan(1);
  });

  it("範囲を指定していない配布元は、これまでどおり全体から引く", async () => {
    const code = freshCode("open").slice(0, 32);
    await saveSpot(env, { code, label: "ふつうの配布元" });
    const spot = (await listSpots(env)).find((s) => s.code === code);
    expect(spot?.speciesPool).toEqual([]);
    expect(spot?.colorPool).toEqual([]);
  });

  it("知らないキーは保存しない（綴り違いで「絞ったつもり」になるのを防ぐ）", async () => {
    const code = freshCode("typo").slice(0, 32);
    await saveSpot(env, { code, label: "綴り違い", speciesPool: ["kiratubu", "kiratsubu"] });
    const spot = (await listSpots(env)).find((s) => s.code === code);
    expect(spot?.speciesPool).toEqual(["kiratsubu"]);
  });

  it("全部選んだら「制限なし」と同じ扱いにする", async () => {
    const code = freshCode("all").slice(0, 32);
    await saveSpot(env, {
      code,
      label: "全部選んだ場合",
      colorPool: ["coral", "sky", "leaf", "sun", "lavender", "peach"],
    });
    const spot = (await listSpots(env)).find((s) => s.code === code);
    expect(spot?.colorPool).toEqual([]);
  });

  it("止めた配布元の限定は効かせない（止めたはずの企画が配り残しから生き続けない）", async () => {
    const code = freshCode("stopped").slice(0, 32);
    await saveSpot(env, { code, label: "終わった催し", speciesPool: ["kiratsubu"], active: false });
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add((await birth(code)).species);
    expect(seen.size).toBeGreaterThan(1);
  });

  it("何が出るかは、引く前の画面には出さない", async () => {
    const code = freshCode("secret").slice(0, 32);
    await saveSpot(env, { code, label: "秘密の場所", speciesPool: ["kiratsubu"] });
    const info = await SELF.fetch(`${BASE}/api/spot?code=${code}`);
    const text = await info.text();
    // 「限定がある」ことだけ伝え、中身は伝えない
    expect(text).toContain('"limited":true');
    expect(text).not.toContain("kiratsubu");
  });
});

/**
 * 依代を複数持てば、分身も複数育てられる。
 * 「1つの依代からは1体だけ」と混同されやすいが、**端末あたりの上限は無い**。
 */
describe("複数の依代で、複数体を育てる", () => {
  it("依代が2つあれば、別々の分身が2体生まれる", async () => {
    const a = freshCode("multi-a");
    const b = freshCode("multi-b");
    const cidA = cidOf(await SELF.fetch(`${BASE}/t/${a}`, { redirect: "manual" }));
    const cidB = cidOf(await SELF.fetch(`${BASE}/t/${b}`, { redirect: "manual" }));

    expect(cidA).not.toBe("");
    expect(cidB).not.toBe("");
    expect(cidA).not.toBe(cidB);

    // 2体とも生きていて、それぞれ別に育つ
    for (const cid of [cidA, cidB]) {
      const res = await SELF.fetch(`${BASE}/api/character?cid=${cid}`);
      expect(res.status).toBe(200);
    }
  });

  it("かざす依代とQRの依代を1つずつ持っても、同じように2体になる", async () => {
    const a = freshCode("mix-nfc");
    const b = freshCode("mix-qr");
    const cidA = cidOf(await SELF.fetch(`${BASE}/t/${a}`, { redirect: "manual" }));
    const cidB = cidOf(await SELF.fetch(`${BASE}/q/${b}`, { redirect: "manual" }));
    expect(cidA).not.toBe(cidB);
  });
});
