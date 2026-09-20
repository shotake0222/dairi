import { describe, it, expect } from "vitest";
import { adminGate, isAdminRequest } from "../admin";

/**
 * 管理者の判定。
 *
 * **合言葉そのものをCookieに入れている**ので、ここの扱いを間違えると
 * 管理画面（＝所有権を動かせる場所）がそのまま開く。
 * 見ているのは1箇所（waketama_admin Cookie）だけ、というのを崩さないための検査。
 */
const ENV = { ADMIN_PASSCODE: "ひみつ", DB: {} as D1Database };
const u = (href: string) => new URL(href);
const req = (href: string, cookie?: string) =>
  new Request(href, cookie ? { headers: { cookie } } : undefined);

function setCookieOf(res: Response): string {
  return res.headers.get("set-cookie") || "";
}

describe("管理者として入る", () => {
  it("合言葉付きで開くとCookieへ移し、URLからは消す", () => {
    const res = adminGate(req("https://app.example.com/admin?key=ひみつ"), u("https://app.example.com/admin?key=ひみつ"), ENV);
    expect(res?.status).toBe(302);
    // 合言葉がURLに残ると、履歴や共有から漏れる
    expect(res?.headers.get("location")).toBe("/admin");
    const cookie = setCookieOf(res!);
    expect(cookie).toContain("waketama_admin=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("**30日は覚えている**（運用する端末で毎日入れ直さずに済むように）", () => {
    const res = adminGate(req("https://app.example.com/admin?key=ひみつ"), u("https://app.example.com/admin?key=ひみつ"), ENV);
    const maxAge = Number(/Max-Age=(\d+)/.exec(setCookieOf(res!))?.[1]);
    expect(maxAge).toBe(30 * 24 * 60 * 60);
  });

  it("違う合言葉では入れない", () => {
    const res = adminGate(req("https://app.example.com/admin?key=ちがう"), u("https://app.example.com/admin?key=ちがう"), ENV);
    expect(res?.status).toBe(401);
  });

  it("Cookieを持っていれば、そのまま通る", () => {
    const res = adminGate(
      req("https://app.example.com/admin", "waketama_admin=" + encodeURIComponent("ひみつ")),
      u("https://app.example.com/admin"),
      ENV
    );
    expect(res).toBeNull();
  });

  it("合言葉が未設定なら、管理画面は開かない（設定漏れが情報公開にならないように）", () => {
    const res = adminGate(req("https://app.example.com/admin"), u("https://app.example.com/admin"), { DB: {} as D1Database });
    expect(res?.status).toBe(404);
  });
});

describe("その端末から管理者を降りる", () => {
  it("/admin?logout=1 でCookieを落とす", () => {
    const res = adminGate(req("https://app.example.com/admin?logout=1"), u("https://app.example.com/admin?logout=1"), ENV);
    expect(res?.status).toBe(302);
    expect(setCookieOf(res!)).toContain("Max-Age=0");
  });

  it("**合言葉を知らなくても降りられる。** 人に貸した端末を戻すため", () => {
    const res = adminGate(
      req("https://app.example.com/admin?logout=1", "waketama_admin=" + encodeURIComponent("ひみつ")),
      u("https://app.example.com/admin?logout=1"),
      ENV
    );
    expect(setCookieOf(res!)).toContain("Max-Age=0");
  });
});

describe("判定そのもの（isAdminRequest）", () => {
  it("正しいCookieを持っているときだけ true", () => {
    expect(isAdminRequest(req("https://x/", "waketama_admin=" + encodeURIComponent("ひみつ")), ENV)).toBe(true);
    expect(isAdminRequest(req("https://x/", "waketama_admin=" + encodeURIComponent("ちがう")), ENV)).toBe(false);
    expect(isAdminRequest(req("https://x/"), ENV)).toBe(false);
  });

  it("合言葉が未設定なら、誰も管理者にならない", () => {
    expect(
      isAdminRequest(req("https://x/", "waketama_admin=" + encodeURIComponent("ひみつ")), { DB: {} as D1Database })
    ).toBe(false);
  });
});
