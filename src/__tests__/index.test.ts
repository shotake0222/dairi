import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker, { runMeeting, pickMostSimilar } from "../index";
import type { PersonalityTraits } from "../ai/personality";
import { MEETING_COOLDOWN_MS } from "../durable-objects/characterState";

// AI呼び出しはデフォルトでは常に失敗させ、リモート課金や不確定な応答に依存しないようにする。
// chat()/speakInMeeting() 側にフォールバック文言が用意されているため、これでもテストは意味を持つ。
// character_directory（D1）はテストファイル内で共有されるため、他テストが残したオプトイン行が
// ランダムマッチング（ORDER BY RANDOM()）に紛れ込まないよう、テストごとに空にしておく。
beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
  await env.DB.prepare("DELETE FROM character_directory").run();
});

function freshCid(label: string): string {
  return `test-index-${label}-${crypto.randomUUID()}`;
}

const BASE = "https://example.com";

/**
 * 新規キャラクターを作成し、持ち主トークンを取得する。
 * rename APIは「未作成のキャラクターへの最初の呼び出しはトークン不要で作成でき、
 * その際に発行されたownerTokenをレスポンスに含める」という、召喚(summon)フローと
 * 同じ経路をテストでも使う（GET /api/characterはownerTokenを含まないよう修正済みのため、
 * そちらから読み取ることはできない）。
 */
async function createCharacter(cid: string, name = "テストキャラ"): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/character/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, name }),
  });
  const data = await res.json<{ ownerToken: string }>();
  return data.ownerToken;
}

/** character_directoryに直接1行upsertする（社交機能へのオプトインをAPIを介さず素早く用意するテスト用ヘルパー）。 */
async function seedDirectoryRow(cid: string, overrides: Partial<PersonalityTraits> & { name?: string } = {}) {
  const p: PersonalityTraits = {
    warmth: 50,
    curiosity: 50,
    cheerfulness: 50,
    caution: 50,
    independence: 50,
    humor: 50,
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO character_directory (character_id, name, species, color, growth_stage, warmth, curiosity, cheerfulness, caution, independence, humor, updated_at)
     VALUES (?1, ?2, 'punikoro', 'coral', '誕生したばかり', ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
  )
    .bind(cid, overrides.name ?? cid, p.warmth, p.curiosity, p.cheerfulness, p.caution, p.independence, p.humor, Date.now())
    .run();
}

describe("pickMostSimilar (性格ベクトルのユークリッド距離マッチング)", () => {
  const self: PersonalityTraits = { warmth: 50, curiosity: 50, cheerfulness: 50, caution: 50, independence: 50, humor: 50 };

  it("最も性格の近い候補を選ぶ", () => {
    const near = { id: "near", warmth: 51, curiosity: 49, cheerfulness: 50, caution: 50, independence: 50, humor: 50 };
    const far = { id: "far", warmth: 100, curiosity: 0, cheerfulness: 100, caution: 0, independence: 100, humor: 0 };
    const result = pickMostSimilar(self, [far, near]);
    expect(result.id).toBe("near");
  });

  it("候補が1件のときはそれを返す", () => {
    const only = { id: "only", warmth: 0, curiosity: 0, cheerfulness: 0, caution: 0, independence: 0, humor: 0 };
    expect(pickMostSimilar(self, [only]).id).toBe("only");
  });
});

describe("GET /t/:tagId (NFCタグ読み取り)", () => {
  it("未登録タグは新規キャラクターを発行し、初回トークン付きで召喚ページへリダイレクトする", async () => {
    const tagId = freshCid("tag");
    const res = await SELF.fetch(`${BASE}/t/${tagId}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/summon");
    expect(loc.searchParams.get("first")).toBe("1");
    expect(loc.searchParams.get("cid")).toBeTruthy();
    expect(loc.searchParams.get("token")).toBeTruthy();
  });

  it("2回目以降のタップでは同じcidに戻り、first/tokenは付かない", async () => {
    const tagId = freshCid("tag2");
    const first = await SELF.fetch(`${BASE}/t/${tagId}`, { redirect: "manual" });
    const firstCid = new URL(first.headers.get("location")!).searchParams.get("cid");

    const second = await SELF.fetch(`${BASE}/t/${tagId}`, { redirect: "manual" });
    const loc = new URL(second.headers.get("location")!);
    expect(loc.searchParams.get("cid")).toBe(firstCid);
    expect(loc.searchParams.get("first")).toBeNull();
    expect(loc.searchParams.get("token")).toBeNull();
  });
});

describe("POST /api/chat", () => {
  it("characterId/messageが無ければ400", async () => {
    const res = await SELF.fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("新規characterIdでも自動初期化されて返答が返る（AI失敗時はフォールバック文言）", async () => {
    const cid = freshCid("chat");
    const res = await SELF.fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "こんにちは" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json<{ reply?: string; interactionCount: number }>();
    expect(data.interactionCount).toBe(1);
    expect(data.reply).toBeTruthy();
  });

  it("安全ガード: 自傷・自殺のサインには、AIを呼ばず固定の案内文を返す", async () => {
    const cid = freshCid("safety");
    const res = await SELF.fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "もう死にたい" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json<{ reply?: string }>();
    expect(data.reply).toContain("よりそいホットライン");
    expect(data.reply).toContain("0120-279-338");
  });
});

describe("GET /api/character", () => {
  it("cid未指定は400", async () => {
    const res = await SELF.fetch(`${BASE}/api/character`);
    expect(res.status).toBe(400);
  });

  it("未作成のキャラクターは404", async () => {
    const res = await SELF.fetch(`${BASE}/api/character?cid=${freshCid("none")}`);
    expect(res.status).toBe(404);
  });

  it("作成済みのキャラクターはspeechStyleLabel付きで返る", async () => {
    const cid = freshCid("get");
    await SELF.fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "はじめまして" }),
    });
    const res = await SELF.fetch(`${BASE}/api/character?cid=${cid}`);
    expect(res.status).toBe(200);
    const data = await res.json<{ speechStyleLabel: string }>();
    expect(typeof data.speechStyleLabel).toBe("string");
  });
});

describe("POST /api/character/rename (持ち主トークン保護)", () => {
  it("未作成のキャラクターはトークン無しで作成できる", async () => {
    const cid = freshCid("rename-new");
    const res = await SELF.fetch(`${BASE}/api/character/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, name: "たろう" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json<{ name: string; ownerToken: string }>();
    expect(data.name).toBe("たろう");
    expect(data.ownerToken).toBeTruthy();
  });

  it("誤ったトークンでの改名は403で拒否される", async () => {
    const cid = freshCid("rename-wrong");
    const created = await (
      await SELF.fetch(`${BASE}/api/character/rename`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: cid, name: "はじめ" }),
      })
    ).json<{ ownerToken: string }>();

    const res = await SELF.fetch(`${BASE}/api/character/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, name: "のっとり", token: "wrong-token" }),
    });
    expect(res.status).toBe(403);

    const check = await (await SELF.fetch(`${BASE}/api/character?cid=${cid}`)).json<{ name: string }>();
    expect(check.name).toBe("はじめ");
    expect(created.ownerToken).toBeTruthy();
  });
});

describe("POST /api/character/delete (持ち主トークン保護・完全削除)", () => {
  it("characterId未指定は400", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("誤ったトークンでは403で拒否され、キャラクターは残る", async () => {
    const cid = freshCid("delete-wrong");
    await createCharacter(cid);

    const res = await SELF.fetch(`${BASE}/api/character/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, token: "wrong-token" }),
    });
    expect(res.status).toBe(403);

    const check = await SELF.fetch(`${BASE}/api/character?cid=${cid}`);
    expect(check.status).toBe(200);
  });

  it("正しいトークンで削除でき、以後は404になる", async () => {
    const cid = freshCid("delete-ok");
    const token = await createCharacter(cid);

    const res = await SELF.fetch(`${BASE}/api/character/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, token }),
    });
    expect(res.status).toBe(200);
    const data = await res.json<{ ok: boolean }>();
    expect(data.ok).toBe(true);

    const after = await SELF.fetch(`${BASE}/api/character?cid=${cid}`);
    expect(after.status).toBe(404);
  });

  it("削除後は同じNFCタグを再タップすると、まったく新しい分身が発行される", async () => {
    const tagId = freshCid("delete-tag");
    const first = await SELF.fetch(`${BASE}/t/${tagId}`, { redirect: "manual" });
    const firstLoc = new URL(first.headers.get("location")!);
    const firstCid = firstLoc.searchParams.get("cid")!;
    const token = firstLoc.searchParams.get("token")!;

    const del = await SELF.fetch(`${BASE}/api/character/delete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: firstCid, token }),
    });
    expect(del.status).toBe(200);

    const second = await SELF.fetch(`${BASE}/t/${tagId}`, { redirect: "manual" });
    const secondLoc = new URL(second.headers.get("location")!);
    expect(secondLoc.searchParams.get("first")).toBe("1");
    expect(secondLoc.searchParams.get("cid")).not.toBe(firstCid);
  });
});

describe("POST /api/character/social (公開ディレクトリへのオプトイン)", () => {
  it("optInが真偽値でなければ400", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: freshCid("social-bad") }),
    });
    expect(res.status).toBe(400);
  });

  it("オプトインするとcharacter_directoryに1行作られ、オプトアウトで消える", async () => {
    const cid = freshCid("social-ok");
    const token = await createCharacter(cid);
    await SELF.fetch(`${BASE}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, message: "hi" }),
    });

    const optInRes = await SELF.fetch(`${BASE}/api/character/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, optIn: true, token }),
    });
    expect(optInRes.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?").bind(cid).first();
    expect(row).toBeTruthy();

    const optOutRes = await SELF.fetch(`${BASE}/api/character/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, optIn: false, token }),
    });
    expect(optOutRes.status).toBe(200);
    const rowAfter = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?").bind(cid).first();
    expect(rowAfter).toBeNull();
  });

  it("トークンが無い（または誤っている）場合は403で拒否され、ディレクトリにも作られない", async () => {
    const cid = freshCid("social-forbidden");
    await createCharacter(cid);

    const res = await SELF.fetch(`${BASE}/api/character/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, optIn: true, token: "wrong" }),
    });
    expect(res.status).toBe(403);
    const row = await env.DB.prepare("SELECT * FROM character_directory WHERE character_id = ?").bind(cid).first();
    expect(row).toBeNull();
  });
});

describe("runMeeting (お散歩の実処理)", () => {
  it("存在しないキャラクターは404", async () => {
    const result = await runMeeting(env, freshCid("meet-missing"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("オプトインしていないキャラクターは400", async () => {
    const cid = freshCid("meet-optout");
    await createCharacter(cid);
    const result = await runMeeting(env, cid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("相手候補がいない場合は404", async () => {
    const cid = freshCid("meet-alone");
    const token = await createCharacter(cid);
    await SELF.fetch(`${BASE}/api/character/social`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, optIn: true, token }),
    });
    const result = await runMeeting(env, cid);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it("相手がいれば成功し、双方にrecordMeetingされる（クールダウン中は再実行できない）", async () => {
    const cid = freshCid("meet-self");
    const partnerCid = freshCid("meet-partner");

    for (const id of [cid, partnerCid]) {
      const token = await createCharacter(id);
      await SELF.fetch(`${BASE}/api/character/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: id, optIn: true, token }),
      });
    }

    const result = await runMeeting(env, cid);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.partner.name).toBeTruthy();
      expect(result.log.length).toBe(3);
    }

    const selfState = await (await SELF.fetch(`${BASE}/api/character?cid=${cid}`)).json<{ lastMeetingAt?: number }>();
    expect(selfState.lastMeetingAt).toBeTruthy();
    const partnerState = await (await SELF.fetch(`${BASE}/api/character?cid=${partnerCid}`)).json<{ lastMeetingAt?: number }>();
    expect(partnerState.lastMeetingAt).toBeTruthy();

    // クールダウン中の再実行は429
    const again = await runMeeting(env, cid);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.status).toBe(429);
  });

  it("クールダウン明けであれば再度お散歩できる", async () => {
    const cid = freshCid("meet-cooldown-self");
    const partnerCid = freshCid("meet-cooldown-partner");
    for (const id of [cid, partnerCid]) {
      const token = await createCharacter(id);
      await SELF.fetch(`${BASE}/api/character/social`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ characterId: id, optIn: true, token }),
      });
    }
    const first = await runMeeting(env, cid);
    expect(first.ok).toBe(true);

    // lastMeetingAtをクールダウン以前まで巻き戻して再実行できることを確認する
    const stub = env.CHARACTER.getByName(cid);
    const { runInDurableObject } = await import("cloudflare:test");
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      const data = await state.storage.get<{ lastMeetingAt?: number }>("data");
      if (data) {
        data.lastMeetingAt = Date.now() - MEETING_COOLDOWN_MS - 1000;
        await state.storage.put("data", data);
      }
    });

    const second = await runMeeting(env, cid);
    expect(second.ok).toBe(true);
  });
});

describe("POST /api/character/meet (HTTPルート)", () => {
  it("characterId未指定は400", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/meet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("runMeetingのエラーがHTTPステータスにマッピングされる", async () => {
    const res = await SELF.fetch(`${BASE}/api/character/meet`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: freshCid("meet-http-missing") }),
    });
    expect(res.status).toBe(404);
  });
});

describe("scheduled (留守番エージェントの自動お散歩)", () => {
  it("対象キャラクターが0件でもエラーにならない", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled!({} as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    // 例外を投げずに完了すればOK（個々の失敗は握りつぶす設計）
    expect(true).toBe(true);
  });

  it("ディレクトリ登録済みキャラクターに対してrunMeetingを実行し、失敗しても他に伝播しない", async () => {
    const cid = freshCid("scheduled-1");
    await seedDirectoryRow(cid);
    const ctx = createExecutionContext();
    await worker.scheduled!({} as ScheduledController, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(true).toBe(true);
  });
});

describe("静的ファイル配信とPWA/OGP", () => {
  it("manifestとService Workerが配信される", async () => {
    const manifestRes = await SELF.fetch(`${BASE}/manifest.webmanifest`);
    expect(manifestRes.status).toBe(200);
    const manifest = await manifestRes.json<{ name: string; start_url: string; icons: unknown[] }>();
    expect(manifest.name).toBe("わけたま");
    expect(manifest.start_url).toBe("/home");
    expect(manifest.icons.length).toBeGreaterThan(0);

    const swRes = await SELF.fetch(`${BASE}/sw.js`);
    expect(swRes.status).toBe(200);
  });

  it("Service WorkerはAPIレスポンスをキャッシュ対象にしていない（古い分身の状態を表示しないため）", async () => {
    const sw = await (await SELF.fetch(`${BASE}/sw.js`)).text();
    // /api/ と /t/ は早期returnでネットワークに素通しされていること
    expect(sw).toContain('url.pathname.startsWith("/api/")');
    expect(sw).toContain('url.pathname.startsWith("/t/")');
    // キャッシュ対象は画像・3Dモデルのみ
    expect(sw).toContain('url.pathname.startsWith("/characters/")');
  });

  it("Service Workerは緊急停止できる（SW_KILLを立てると解除用スクリプトに差し替わる）", async () => {
    // 壊れたSWを配ると、こちらが直しても端末側の古いSWが動き続ける。
    // この逃げ道が無いと「サイトデータを消してください」と案内するしかなくなる。
    const before = (env as { SW_KILL?: string }).SW_KILL;
    try {
      (env as { SW_KILL?: string }).SW_KILL = "1";
      const res = await SELF.fetch(`${BASE}/sw.js`);
      const body = await res.text();
      expect(body).toContain("self.registration.unregister()");
      expect(body).not.toContain("isCacheableAsset");
      // 解除用スクリプト自体がキャッシュされると、そこから抜けられなくなる
      expect(res.headers.get("cache-control")).toBe("no-store");
    } finally {
      (env as { SW_KILL?: string }).SW_KILL = before;
    }
    // 元に戻ること（停止が居座らない）
    expect(await (await SELF.fetch(`${BASE}/sw.js`)).text()).toContain("isCacheableAsset");
  });

  it("HTMLに埋め込み防止と参照元制限のヘッダが付く", async () => {
    const res = await SELF.fetch(`${BASE}/home`);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    // かざして話す・通話・視線入力で必要なので、カメラとマイクは自分のページにだけ許す
    expect(res.headers.get("permissions-policy")).toContain("camera=(self)");
    expect(res.headers.get("permissions-policy")).toContain("geolocation=()");
  });

  it("CSPはnonce方式で、'unsafe-inline'を許していない", async () => {
    const res = await SELF.fetch(`${BASE}/home`);
    const csp = res.headers.get("content-security-policy") || "";
    expect(csp).toMatch(/script-src 'nonce-[^']+'/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
  });

  it("HTML中のすべての<script>タグに、ヘッダと同じnonceが振られている", async () => {
    const res = await SELF.fetch(`${BASE}/home`);
    const csp = res.headers.get("content-security-policy") || "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    const body = await res.text();
    const scriptTags = body.match(/<script\b[^>]*>/g) || [];
    // かざして話す等と違い/homeに<script>が無い、という事故を検知できるよう、最低1つはあることも確認する
    expect(scriptTags.length).toBeGreaterThan(0);
    for (const tag of scriptTags) {
      expect(tag).toContain(`nonce="${nonce}"`);
    }
  });

  it("リクエストごとにnonceが変わる（使い回すと防御にならない）", async () => {
    const [a, b] = await Promise.all([SELF.fetch(`${BASE}/home`), SELF.fetch(`${BASE}/home`)]);
    const nonceOf = (res: Response) => /script-src 'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") || "")?.[1];
    const nonceA = nonceOf(a);
    const nonceB = nonceOf(b);
    expect(nonceA).toBeTruthy();
    expect(nonceB).toBeTruthy();
    expect(nonceA).not.toBe(nonceB);
  });

  it("外部スクリプト（model-viewer）を読み込むページでも、そのタグにnonceが振られる", async () => {
    const res = await SELF.fetch(`${BASE}/chat`);
    const csp = res.headers.get("content-security-policy") || "";
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
    const body = await res.text();
    expect(body).toContain("cdn.jsdelivr.net");
    const externalTag = body.match(/<script[^>]*src="https:\/\/cdn\.jsdelivr\.net[^>]*>/)?.[0];
    expect(externalTag).toBeTruthy();
    expect(externalTag).toContain(`nonce="${nonce}"`);
  });

  it("存在しないパスには案内付きの404ページを返す（APIは巻き添えにしない）", async () => {
    // アセット層の not_found_handling を使うと、無いパスがWorkerまで届かなくなり
    // /api/* が丸ごと死ぬ。Worker側で404ページを返しているのはそのため。
    const missing = await SELF.fetch(`${BASE}/no-such-page`);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("このページは見つかりませんでした");

    // 同じ経路でAPIが壊れていないこと（この2つは必ず一緒に検証する）
    const health = await SELF.fetch(`${BASE}/api/health`);
    expect(health.headers.get("content-type")).toContain("application/json");
  });

  it("robots.txtとsitemap.xmlが配信され、管理画面はクロール対象外", async () => {
    const robots = await (await SELF.fetch(`${BASE}/robots.txt`)).text();
    expect(robots).toContain("Disallow: /admin");
    const sitemap = await (await SELF.fetch(`${BASE}/sitemap.xml`)).text();
    expect(sitemap).toContain("<urlset");
    expect(sitemap).not.toContain("/admin");
  });

  it("HTMLのog:image / og:url が、配信元のオリジンを使った絶対URLに書き換えられる", async () => {
    const html = await (await SELF.fetch(`${BASE}/home`)).text();
    expect(html).toContain(`<meta property="og:image" content="${BASE}/icons/ogp.png" />`);
    expect(html).toContain(`<meta name="twitter:image" content="${BASE}/icons/ogp.png" />`);
    expect(html).toContain(`<meta property="og:url" content="${BASE}/home" />`);
  });

  it("HTMLにcanonicalリンクが1つだけ挿し込まれる", async () => {
    // 同じページが2つのホスト（apex / app）から引けるため、
    // これが無いと検索エンジンに重複ページとして扱われる。
    const html = await (await SELF.fetch(`${BASE}/lp`)).text();
    const matches = html.match(/<link rel="canonical"/g) ?? [];
    expect(matches.length).toBe(1);
    expect(html).toContain(`<link rel="canonical" href="${BASE}/lp">`);
  });

  it("og:urlにはクエリ文字列（cid）を含めない", async () => {
    const html = await (await SELF.fetch(`${BASE}/chat?cid=secret-character-id`)).text();
    expect(html).toContain(`<meta property="og:url" content="${BASE}/chat" />`);
    expect(html).not.toContain("secret-character-id");
  });

  // Cloudflare Assetsの既定動作では /x.html は /x へ307リダイレクトされる（＝正規URLは拡張子なし）。
  // アプリ内リンクは正規URLを直接指すようにしてあり、この前提が崩れると全画面遷移に余計な往復が増える。
  it("拡張子なしの正規URLが200で配信され、.html付きはそこへリダイレクトされる", async () => {
    const canonical = await SELF.fetch(`${BASE}/chat`, { redirect: "manual" });
    expect(canonical.status).toBe(200);

    const legacy = await SELF.fetch(`${BASE}/chat.html?cid=abc`, { redirect: "manual" });
    expect(legacy.status).toBe(307);
    // 既存のブックマークやNFCタグが壊れないよう、クエリ文字列は維持されること
    expect(legacy.headers.get("location")).toBe("/chat?cid=abc");
  });

  it("アプリ内リンクは拡張子なしの正規URLを指している（余計なリダイレクトを挟まない）", async () => {
    const chatHtml = await (await SELF.fetch(`${BASE}/chat`)).text();
    expect(chatHtml).toContain('href="/home"');
    expect(chatHtml).toContain("`/history?cid=");
    expect(chatHtml).toContain("`/friends?cid=");
    expect(chatHtml).not.toContain('href="/home.html"');

    const manifest = await (await SELF.fetch(`${BASE}/manifest.webmanifest`)).json<{ start_url: string }>();
    expect(manifest.start_url).toBe("/home");
  });

  it("素のドメイン（/）は分身一覧へリダイレクトされる", async () => {
    const res = await SELF.fetch(`${BASE}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${BASE}/home`);
  });

  it("NFCタップのリダイレクト先も正規URL（/summon）である", async () => {
    const res = await SELF.fetch(`${BASE}/t/${freshCid("canonical-tag")}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/summon");
  });

  it("HTML以外（アイコン等）は書き換えずそのまま配信される", async () => {
    const res = await SELF.fetch(`${BASE}/icons/icon-192.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    // PNGのマジックナンバー
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});

/**
 * ルートの取り合い。
 *
 * 「会話の履歴」と「性格の履歴」を、どちらも /api/character/history という名前で
 * 登録してしまい、**先に書いたほうが勝って成長ページが静かに空になった**ことがある。
 * 例外も出ず、画面に「記録が見つかりませんでした」と出るだけなので、気づきにくい。
 * 同じ名前を二度登録していないことを、ここで押さえる。
 */
describe("履歴の2つのAPIが取り合っていないこと", () => {
  it("性格の変遷は cid だけで読める（成長ページが使う）", async () => {
    const res = await SELF.fetch(`${BASE}/t/route-history-${crypto.randomUUID().slice(0, 8)}`, {
      redirect: "manual",
    });
    const cid = new URL(res.headers.get("location")!, BASE).searchParams.get("cid")!;

    const history = await SELF.fetch(`${BASE}/api/character/history?cid=${cid}`);
    expect(history.status).toBe(200);
    const body = await history.json<{ history?: unknown[]; turns?: unknown[] }>();
    // 性格の履歴が返ること。会話の履歴（turns）が返ってきたら、名前を取られている
    expect(Array.isArray(body.history)).toBe(true);
    expect(body.turns).toBeUndefined();
  });

  it("会話の履歴は別の名前で、持ち主トークンが要る", async () => {
    const res = await SELF.fetch(`${BASE}/t/route-dialogue-${crypto.randomUUID().slice(0, 8)}`, {
      redirect: "manual",
    });
    const loc = new URL(res.headers.get("location")!, BASE);
    const cid = loc.searchParams.get("cid")!;
    const token = loc.searchParams.get("token")!;

    expect((await SELF.fetch(`${BASE}/api/character/dialogue?cid=${cid}`)).status).toBe(403);

    const mine = await SELF.fetch(`${BASE}/api/character/dialogue?cid=${cid}&token=${token}`);
    expect(mine.status).toBe(200);
    expect(Array.isArray((await mine.json<{ turns: unknown[] }>()).turns)).toBe(true);
  });
});
