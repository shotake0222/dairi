import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import {
  dailyLimitFor,
  DIRECT_CREATE_DAILY_LIMIT,
  generateTagId,
  identifyTag,
  issueTags,
  listSpots,
  listTags,
  saveSpot,
} from "../yorishiro";

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

/**
 * 依代から来た人の印（Cookie）。
 * 入口は既定で閉じているので、依代なしで作る検査はこれを付けて回す
 * （＝「ちゃんと買った人」を模す）。詳しくは src/entryPolicy.ts。
 */
async function yorishiroCookie(): Promise<string> {
  const tap = await SELF.fetch(`${BASE}/t?u=00000000000000`, { redirect: "manual" });
  return (tap.headers.get("set-cookie") || "").split(";")[0];
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

  it("コードが空でも、かざした人の前で行き止まりにしない", async () => {
    // 以前は 400 を返していた。共通URLを配るようになって、ここは
    // 「こちらの書き込み設定が足りていない」ときに通る道になった。
    // 目の前の人にとっては「かざしたのに何も起きない」なので、受け皿へ送る。
    const res = await SELF.fetch(`${BASE}/t/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!, BASE).searchParams.get("claim")).toBe("tag");
  });
});

describe("依代を持たない人の入口（/api/character/new）", () => {
  it("分身を1体作り、持ち主の印を返す", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/new`, {
      method: "POST",
      headers: { cookie: await yorishiroCookie() },
    });
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

/**
 * 共通URLで配る（UIDミラー）。
 *
 * **全部のタグに同じ内容を書き込めないと、キーホルダーを作って売ることが成立しない。**
 * NTAG21x のUIDミラーを使うと、書き込む内容は同じまま、読まれるURLだけがタグごとに変わる。
 *
 * ここでいちばん怖いのは、ミラーの設定を忘れて出荷すること。
 * そのとき全タグが同じURLを返すので、**買った人全員が同じ分身を共有する**。
 * 気づくのは苦情が来てから。だから埋め草は必ず弾く。
 */
describe("共通URL（UIDミラー）", () => {
  const u = (path: string) => new URL(`${BASE}${path}`);

  it("UIDが乗っていれば、それで1枚を見分ける", () => {
    expect(identifyTag(u("/t?u=04a1b2c3d4e5f6"))).toEqual({
      tagId: "uid-04a1b2c3d4e5f6",
      source: "uid",
      suspectedFiller: false,
    });
  });

  it("大文字でも、区切りが入っていても同じ1枚として扱う", () => {
    const a = identifyTag(u("/t?u=04A1B2C3D4E5F6")).tagId;
    const b = identifyTag(u("/t?u=04:a1:b2:c3:d4:e5:f6")).tagId;
    expect(a).toBe("uid-04a1b2c3d4e5f6");
    expect(b).toBe(a);
  });

  it("カウンタミラーが一緒でも、UIDの部分だけ見る（読むたびに別の子にならない）", () => {
    const first = identifyTag(u("/t?u=04a1b2c3d4e5f6x000001")).tagId;
    const later = identifyTag(u("/t?u=04a1b2c3d4e5f6x0004c2")).tagId;
    expect(first).toBe("uid-04a1b2c3d4e5f6");
    expect(later).toBe(first);
  });

  it("**埋め草は弾く。** ミラーが効いていないタグを全部同じ子にしない", () => {
    for (const bad of ["00000000000000", "0000000000000000", "ffffffffffffff", "xxxxxxxxxxxxxx", "--------------"]) {
      const got = identifyTag(u(`/t?u=${bad}`));
      expect(got.tagId).toBeNull();
      expect(got.suspectedFiller).toBe(true);
    }
  });

  it("UIDの長さが合わないものも信用しない", () => {
    expect(identifyTag(u("/t?u=04a1b2")).tagId).toBeNull();
    expect(identifyTag(u("/t?u=04a1b2c3d4e5f6a1b2c3")).tagId).toBeNull();
  });

  it("個別コードが入っていれば、そちらを優先する（従来方式と併用できる）", () => {
    expect(identifyTag(u("/t/abc123?u=04a1b2c3d4e5f6")).tagId).toBe("abc123");
  });

  it("何も無ければ、見分けが付かなかったこととして返す", () => {
    const got = identifyTag(u("/t"));
    expect(got.tagId).toBeNull();
    expect(got.suspectedFiller).toBe(false);
  });

  it("同じUIDを2回読んでも1体のまま、違うUIDなら別の子になる", async () => {
    const uidA = "04" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const uidB = "04" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const first = cidOf(await SELF.fetch(`${BASE}/t?u=${uidA}`, { redirect: "manual" }));
    const again = cidOf(await SELF.fetch(`${BASE}/t?u=${uidA}`, { redirect: "manual" }));
    const other = cidOf(await SELF.fetch(`${BASE}/t?u=${uidB}`, { redirect: "manual" }));

    expect(first).not.toBe("");
    expect(again).toBe(first);
    expect(other).not.toBe(first);
  });

  it("見分けが付かないときは、受け皿の画面へ送る（かざしても無反応、にしない）", async () => {
    const res = await SELF.fetch(`${BASE}/t?u=00000000000000`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, BASE);
    expect(to.pathname).toBe("/summon");
    expect(to.searchParams.get("claim")).toBe("tag");
  });

  it("QRの共通URLでも同じように受け皿へ送る", async () => {
    const res = await SELF.fetch(`${BASE}/q`, { redirect: "manual" });
    const to = new URL(res.headers.get("location")!, BASE);
    expect(to.searchParams.get("claim")).toBe("qr");
  });
});

/**
 * 依代を使わない入口（/w）。
 *
 * **タグが刷り上がる前でもサービスを出せるようにするための口。**
 * リンク1本配れば始まる。かざす依代と違って台帳には載らないが、
 * 「開くたびに増える」ことだけは避ける（それをやると数がすぐ壊れる）。
 */
describe("Webだけで始める（/w）", () => {
  it("受け皿の画面へ送り、Web由来として扱う", async () => {
    const res = await SELF.fetch(`${BASE}/w`, {
      redirect: "manual",
      headers: { cookie: await yorishiroCookie() },
    });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, BASE);
    expect(to.pathname).toBe("/summon");
    expect(to.searchParams.get("claim")).toBe("web");
  });

  it("末尾のスラッシュが付いていても同じ", async () => {
    const res = await SELF.fetch(`${BASE}/w/`, {
      redirect: "manual",
      headers: { cookie: await yorishiroCookie() },
    });
    expect(new URL(res.headers.get("location")!, BASE).searchParams.get("claim")).toBe("web");
  });

  it("入口の種類を web として記録する（配ったリンクの効きを別に数えられる）", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/new?from=web`, {
      method: "POST",
      headers: { cookie: await yorishiroCookie() },
    });
    expect(res.ok).toBe(true);
    const { characterId } = await res.json<{ characterId: string }>();
    const row = await env.DB.prepare("SELECT kind FROM character_origin WHERE character_id = ?")
      .bind(characterId)
      .first<{ kind: string }>();
    expect(row?.kind).toBe("web");
  });

  it("from を付けなければ direct のまま（/add のボタンと混ざらない）", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/new`, {
      method: "POST",
      headers: { cookie: await yorishiroCookie() },
    });
    const { characterId } = await res.json<{ characterId: string }>();
    const row = await env.DB.prepare("SELECT kind FROM character_origin WHERE character_id = ?")
      .bind(characterId)
      .first<{ kind: string }>();
    expect(row?.kind).toBe("direct");
  });
});

/**
 * 誰が新しい分身を作れるか（src/entryPolicy.ts）。
 *
 * 依代は売り物なので、その横に「誰でも押せば1体」のボタンがあると買う理由が消える。
 * かといって完全に塞ぐと、**タグのミラーが効いていなかった人**（＝ちゃんと買った人）
 * まで締め出す。そこを分けているのがここ。
 */
describe("依代を持たない人の入口（既定は閉じる）", () => {
  it("何も持たずに作ろうとすると断る", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/new`, { method: "POST" });
    expect(res.status).toBe(403);
    const body = await res.json<{ error: string }>();
    // 断るだけでなく、次にどうすればよいかまで言う
    expect(body.error).toContain("依代");
  });

  it("依代から来た人は作れる（ミラーが効いていない現物を持っている人を締め出さない）", async () => {
    const tap = await SELF.fetch(`${BASE}/t?u=00000000000000`, { redirect: "manual" });
    const cookie = (tap.headers.get("set-cookie") || "").split(";")[0];
    expect(cookie).toContain("wt_claim");

    const res = await SELF.fetch(`${BASE}/api/character/new?from=tag`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
  });

  it("画面に出す判定も、同じ答えを返す（押せないボタンを出さないため）", async () => {
    const closed = await (await SELF.fetch(`${BASE}/api/entry`)).json<{ canCreate: boolean }>();
    expect(closed.canCreate).toBe(false);

    const tap = await SELF.fetch(`${BASE}/t?u=00000000000000`, { redirect: "manual" });
    const cookie = (tap.headers.get("set-cookie") || "").split(";")[0];
    const open = await (
      await SELF.fetch(`${BASE}/api/entry`, { headers: { cookie } })
    ).json<{ canCreate: boolean; reason: string }>();
    expect(open.canCreate).toBe(true);
    expect(open.reason).toBe("yorishiro");
  });

  it("閉じているあいだ、/w は案内へ送る（黙って何も起きない、にしない）", async () => {
    const res = await SELF.fetch(`${BASE}/w`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!, BASE);
    expect(to.pathname).toBe("/add");
    expect(to.searchParams.get("closed")).toBe("1");
  });

  it("依代の読み取りそのものは、設定に関係なくいつでも通る", async () => {
    // ここを止めると、買った人が使えなくなる。**この検査は消さないこと**
    const code = freshCode("entry-always");
    const res = await SELF.fetch(`${BASE}/t/${code}`, { redirect: "manual" });
    expect(cidOf(res)).not.toBe("");
  });
});

/**
 * 1日あたりの上限。
 *
 * もともとは「誰でも押せるボタン」を守るための数字だった。入口を閉じたいま、
 * 同じ厳しさを全員に当てる理由が無い。**運営が自分の道具で詰まるのがいちばん無駄**で、
 * 試作の読み取り確認では1日に何体も作る。
 */
describe("作れる数の上限", () => {
  it("管理者には上限を付けない", () => {
    expect(dailyLimitFor("admin")).toBeNull();
  });

  it("依代を持つ人はゆるめ（家族で分ける・買い直すぶんは通る）", () => {
    expect(dailyLimitFor("yorishiro")).toBe(10);
    expect(dailyLimitFor("yorishiro")).toBeGreaterThan(DIRECT_CREATE_DAILY_LIMIT);
  });

  it("誰でも入れる状態のときだけ、きつく数える", () => {
    expect(dailyLimitFor("open")).toBe(DIRECT_CREATE_DAILY_LIMIT);
  });

  it("管理者は、何体つくっても断られない", async () => {
    // 上限（3）を超える回数を、管理者として続けて作る
    const cookie = "waketama_admin=" + encodeURIComponent("e2e-admin-secret");
    for (let i = 0; i < DIRECT_CREATE_DAILY_LIMIT + 3; i++) {
      const res = await SELF.fetch(`${BASE}/api/character/new`, {
        method: "POST",
        headers: { cookie, "cf-connecting-ip": "203.0.113.9" },
      });
      expect(res.status, `${i + 1}体目で断られた`).toBe(200);
    }
  });

  it("断るときは、いつ戻るかまで言う（区切りはUTCなので日本時間の朝9時）", async () => {
    const tap = await SELF.fetch(`${BASE}/t?u=00000000000000`, { redirect: "manual" });
    const claim = (tap.headers.get("set-cookie") || "").split(";")[0];
    const headers = { cookie: claim, "cf-connecting-ip": "203.0.113.77" };

    let last: Response | null = null;
    for (let i = 0; i < 12; i++) {
      last = await SELF.fetch(`${BASE}/api/character/new`, { method: "POST", headers });
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    const body = await last!.json<{ error: string }>();
    expect(body.error).toContain("翌朝9時");
  });
});
