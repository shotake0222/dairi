import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";
import { normalizeCode } from "../transfer";

/**
 * 引き継ぎコードの検証。
 *
 * この機能は「所有権そのものを移す」ので、緩いと乗っ取りに直結する。
 * 正常系よりも、期限切れ・使い回し・他人による発行といった外し方を重点的に確認する。
 */

const BASE = "https://example.com";

function freshCid(label: string): string {
  return `test-transfer-${label}-${crypto.randomUUID()}`;
}

async function createCharacter(cid: string, name = "ひきつぎのこ"): Promise<string> {
  const res = await SELF.fetch(`${BASE}/api/character/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, name }),
  });
  return (await res.json<{ ownerToken: string }>()).ownerToken;
}

async function issue(cid: string, token?: string) {
  const res = await SELF.fetch(`${BASE}/api/character/transfer/issue`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ characterId: cid, token }),
  });
  return { status: res.status, body: await res.json<{ code?: string; expiresAt?: number; error?: string }>() };
}

async function claim(code: string) {
  const res = await SELF.fetch(`${BASE}/api/character/transfer/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return { status: res.status, body: await res.json<{ characterId?: string; ownerToken?: string; name?: string; error?: string }>() };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
});

describe("normalizeCode (入力ゆれの吸収)", () => {
  it("小文字・区切り・空白の違いを同じコードとして扱う", () => {
    expect(normalizeCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeCode(" ABCD 2345 ")).toBe("ABCD2345");
    expect(normalizeCode("ABCD−2345")).toBe("ABCD2345"); // 全角ハイフン
    expect(normalizeCode("ABCD2345")).toBe("ABCD2345");
  });
});

describe("引き継ぎコードの発行", () => {
  it("持ち主なら発行でき、読みやすい形式で返る", async () => {
    const cid = freshCid("issue");
    const token = await createCharacter(cid);
    const { status, body } = await issue(cid, token);
    expect(status).toBe(200);
    expect(body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("持ち主でなければ403で拒否され、コードは作られない", async () => {
    const cid = freshCid("issue-denied");
    await createCharacter(cid);
    const { status, body } = await issue(cid, "wrong-token");
    expect(status).toBe(403);
    expect(body.code).toBeUndefined();

    const row = await env.DB.prepare("SELECT count(*) AS n FROM transfer_codes WHERE character_id = ?")
      .bind(cid)
      .first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("存在しない分身には発行できない", async () => {
    const { status } = await issue(freshCid("missing"), "any");
    expect(status).toBe(404);
  });

  it("発行し直すと、前のコードは無効になる（同時に複数生かさない）", async () => {
    const cid = freshCid("reissue");
    const token = await createCharacter(cid);
    const first = await issue(cid, token);
    const second = await issue(cid, token);
    expect(first.body.code).not.toBe(second.body.code);

    const old = await claim(first.body.code!);
    expect(old.status).toBe(404);

    const fresh = await claim(second.body.code!);
    expect(fresh.status).toBe(200);
  });
});

describe("引き継ぎコードの使用", () => {
  it("コードで所有権が移り、古いトークンは通らなくなる", async () => {
    const cid = freshCid("claim");
    const oldToken = await createCharacter(cid, "うつるこ");
    const { body } = await issue(cid, oldToken);

    const claimed = await claim(body.code!);
    expect(claimed.status).toBe(200);
    expect(claimed.body.characterId).toBe(cid);
    expect(claimed.body.name).toBe("うつるこ");
    const newToken = claimed.body.ownerToken!;
    expect(newToken).toBeTruthy();
    expect(newToken).not.toBe(oldToken);

    // 新しいトークンでは持ち主専用の操作ができる
    const renameNew = await SELF.fetch(`${BASE}/api/character/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, name: "あたらしい端末から", token: newToken }),
    });
    expect(renameNew.status).toBe(200);

    // 古いトークンはもう通らない（＝所有権が移っている）
    const renameOld = await SELF.fetch(`${BASE}/api/character/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ characterId: cid, name: "元の端末から", token: oldToken }),
    });
    expect(renameOld.status).toBe(403);
  });

  it("同じコードは二度使えない", async () => {
    const cid = freshCid("reuse");
    const token = await createCharacter(cid);
    const { body } = await issue(cid, token);

    expect((await claim(body.code!)).status).toBe(200);
    const second = await claim(body.code!);
    expect(second.status).toBe(410);
    expect(second.body.error).toContain("すでに使われています");
  });

  it("小文字や区切り無しで入力しても引き継げる", async () => {
    const cid = freshCid("loose-input");
    const token = await createCharacter(cid);
    const { body } = await issue(cid, token);
    const messy = body.code!.toLowerCase().replace("-", " ");
    expect((await claim(messy)).status).toBe(200);
  });

  it("期限切れのコードは使えない", async () => {
    const cid = freshCid("expired");
    const token = await createCharacter(cid);
    const { body } = await issue(cid, token);

    // 期限を過去にずらして、時間経過を再現する
    await env.DB.prepare("UPDATE transfer_codes SET expires_at = ? WHERE character_id = ?")
      .bind(Date.now() - 1000, cid)
      .run();

    const result = await claim(body.code!);
    expect(result.status).toBe(410);
    expect(result.body.error).toContain("期限切れ");
  });

  it("でたらめなコードでは引き継げない", async () => {
    const result = await claim("ZZZZ-9999");
    expect(result.status).toBe(404);
  });

  it("空のコードは400", async () => {
    const result = await claim("   ");
    expect(result.status).toBe(400);
  });
});
