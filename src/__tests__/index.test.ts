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
  it("未登録タグは新規キャラクターを発行し、初回トークン付きでsummon.htmlへリダイレクトする", async () => {
    const tagId = freshCid("tag");
    const res = await SELF.fetch(`${BASE}/t/${tagId}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.pathname).toBe("/summon.html");
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
