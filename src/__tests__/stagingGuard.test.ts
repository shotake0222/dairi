import { describe, it, expect } from "vitest";
import { stagingGate, applyStagingHeaders, isStaging } from "../stagingGuard";

/**
 * 検証環境の入口ガードの検証。
 *
 * ここで守りたいのは2点。
 *  - 本番には一切影響しないこと（誤って本番を締め出すのが最悪の事故）
 *  - 合言葉を設定したときに、ちゃんと閉まること
 *
 * 実際のWorkerに通す形ではなく関数単体で検証している。環境変数の組み合わせ
 * （本番/検証 × 合言葉あり/なし）を網羅するには、こちらのほうが確実なため。
 */

const PROD = { ENVIRONMENT: "production" };
const STAGING_OPEN = { ENVIRONMENT: "staging" };
const STAGING_LOCKED = { ENVIRONMENT: "staging", STAGING_PASSCODE: "himitsu" };

function req(path = "/home", cookie?: string): { request: Request; url: URL } {
  const url = new URL(`https://staging.waketama.com${path}`);
  const request = new Request(url.toString(), cookie ? { headers: { cookie } } : undefined);
  return { request, url };
}

describe("isStaging", () => {
  it("ENVIRONMENTがstagingのときだけ真", () => {
    expect(isStaging(STAGING_OPEN)).toBe(true);
    expect(isStaging(PROD)).toBe(false);
    expect(isStaging({})).toBe(false);
  });
});

describe("stagingGate", () => {
  it("本番では合言葉が設定されていても何もしない", () => {
    const { request, url } = req();
    expect(stagingGate(request, url, { ENVIRONMENT: "production", STAGING_PASSCODE: "himitsu" })).toBeNull();
  });

  it("検証環境でも合言葉が未設定なら素通し", () => {
    const { request, url } = req();
    expect(stagingGate(request, url, STAGING_OPEN)).toBeNull();
  });

  it("合言葉が設定されていて、持っていなければ401で止める", () => {
    const { request, url } = req();
    const res = stagingGate(request, url, STAGING_LOCKED);
    expect(res?.status).toBe(401);
    expect(res?.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("?key=合言葉 で入ると、Cookieに移してURLから合言葉を消す", () => {
    const url = new URL("https://staging.waketama.com/chat?cid=abc&key=himitsu");
    const request = new Request(url.toString());
    const res = stagingGate(request, url, STAGING_LOCKED);

    expect(res?.status).toBe(302);
    // 合言葉がURLに残らないこと（共有やリファラ経由での漏れを防ぐ）
    const location = res!.headers.get("location")!;
    expect(location).not.toContain("himitsu");
    expect(location).not.toContain("key=");
    expect(location).toContain("cid=abc");

    const cookie = res!.headers.get("set-cookie")!;
    expect(cookie).toContain("waketama_staging=himitsu");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
  });

  it("間違った合言葉では通さない", () => {
    const url = new URL("https://staging.waketama.com/home?key=chigau");
    const request = new Request(url.toString());
    expect(stagingGate(request, url, STAGING_LOCKED)?.status).toBe(401);
  });

  it("Cookieを持っていれば通る", () => {
    const { request, url } = req("/home", "waketama_staging=himitsu");
    expect(stagingGate(request, url, STAGING_LOCKED)).toBeNull();
  });

  it("他のCookieが混ざっていても正しく読み取る", () => {
    const { request, url } = req("/home", "foo=bar; waketama_staging=himitsu; baz=qux");
    expect(stagingGate(request, url, STAGING_LOCKED)).toBeNull();
  });

  it("死活確認だけは合言葉なしで通す（デプロイ後の疎通確認・監視のため）", () => {
    const { request, url } = req("/api/health");
    expect(stagingGate(request, url, STAGING_LOCKED)).toBeNull();
  });
});

describe("applyStagingHeaders", () => {
  it("検証環境のレスポンスには検索避けを付ける", () => {
    const res = applyStagingHeaders(new Response("ok"), STAGING_OPEN);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("本番のレスポンスには付けない", () => {
    const res = applyStagingHeaders(new Response("ok"), PROD);
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("元のヘッダとステータスを壊さない", () => {
    const original = new Response("ok", { status: 201, headers: { "content-type": "text/plain", "x-keep": "1" } });
    const res = applyStagingHeaders(original, STAGING_OPEN);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-keep")).toBe("1");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });
});
