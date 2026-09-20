import { describe, it, expect } from "vitest";
import { canonicalFor, hostRedirect, renderRobots, renderSitemap } from "../hosts";

/**
 * ホストの振り分けの検証。
 *
 * いちばん怖いのは「アプリ本体が2つのホストで開けてしまう」こと。
 * 持ち主トークンはlocalStorage（オリジンごとに別物）にあるため、
 * それが起きるとユーザーには分身が消えたように見える。
 * そのうえで、ローカルと検証環境が巻き添えを食わないことも同じくらい重要。
 */

const PROD = { SITE_HOST: "waketama.com", APP_HOST: "app.waketama.com", ENVIRONMENT: "production" };
const LOCAL = { ENVIRONMENT: "development", SITE_HOST: undefined, APP_HOST: undefined };

const u = (href: string) => new URL(href);

describe("hostRedirect", () => {
  it("apexのトップはLPへ送る", () => {
    const res = hostRedirect(u("https://waketama.com/"), PROD);
    expect(res?.status).toBe(302);
    expect(res?.headers.get("location")).toBe("https://waketama.com/lp");
  });

  it("apexにアプリ本体のパスで来たら app へ送り返す（クエリは保つ）", () => {
    const res = hostRedirect(u("https://waketama.com/chat?cid=abc"), PROD);
    expect(res?.headers.get("location")).toBe("https://app.waketama.com/chat?cid=abc");
  });

  it("NFCタグのURL(/t/:id)も本体側へ送る", () => {
    const res = hostRedirect(u("https://waketama.com/t/tag123"), PROD);
    expect(res?.headers.get("location")).toBe("https://app.waketama.com/t/tag123");
  });

  it("管理画面はapexからでも本体側へ寄せる", () => {
    const res = hostRedirect(u("https://waketama.com/admin"), PROD);
    expect(res?.headers.get("location")).toBe("https://app.waketama.com/admin");
  });

  it("appで紹介ページを開いたら apex へ送る", () => {
    expect(hostRedirect(u("https://app.waketama.com/lp"), PROD)?.headers.get("location")).toBe(
      "https://waketama.com/lp"
    );
    expect(hostRedirect(u("https://app.waketama.com/biz"), PROD)?.headers.get("location")).toBe(
      "https://waketama.com/biz"
    );
  });

  it("本体側の通常のページは何もしない", () => {
    expect(hostRedirect(u("https://app.waketama.com/chat"), PROD)).toBeNull();
    expect(hostRedirect(u("https://app.waketama.com/api/character?cid=x"), PROD)).toBeNull();
  });

  it("APIはapexからでも転送しない（フォームの控えが同一オリジンで送れなくなるため）", () => {
    expect(hostRedirect(u("https://waketama.com/api/contact"), PROD)).toBeNull();
  });

  it("規約・プライバシーはどちらのホストでも開ける", () => {
    expect(hostRedirect(u("https://waketama.com/terms"), PROD)).toBeNull();
    expect(hostRedirect(u("https://app.waketama.com/privacy"), PROD)).toBeNull();
  });

  it("ホストが未設定なら一切転送しない（ローカル・検証環境の巻き添えを防ぐ）", () => {
    expect(hostRedirect(u("http://localhost:8787/"), LOCAL)).toBeNull();
    expect(hostRedirect(u("http://localhost:8787/lp"), LOCAL)).toBeNull();
    expect(hostRedirect(u("https://staging.waketama.com/chat"), { SITE_HOST: "waketama.com" })).toBeNull();
  });

  it("2つのホストが同じ値なら無効（設定ミスで無限ループにしない）", () => {
    const same = { SITE_HOST: "waketama.com", APP_HOST: "waketama.com" };
    expect(hostRedirect(u("https://waketama.com/chat"), same)).toBeNull();
  });
});

describe("canonicalFor", () => {
  it("紹介ページと規約はapexが正", () => {
    expect(canonicalFor(u("https://app.waketama.com/lp"), PROD)).toBe("https://waketama.com/lp");
    expect(canonicalFor(u("https://app.waketama.com/terms"), PROD)).toBe("https://waketama.com/terms");
  });

  it("本体のページはappが正", () => {
    expect(canonicalFor(u("https://waketama.com/chat?cid=x"), PROD)).toBe("https://app.waketama.com/chat");
  });

  it("クエリ文字列は載せない（cidが共有カードに漏れないように）", () => {
    expect(canonicalFor(u("https://app.waketama.com/chat?cid=secret"), PROD)).not.toContain("secret");
  });

  it("ホスト未設定なら今のオリジンをそのまま正とする", () => {
    expect(canonicalFor(u("http://localhost:8787/lp"), LOCAL)).toBe("http://localhost:8787/lp");
  });

  it("本番以外のホストから配信されているときは、本番のURLを名乗らない", () => {
    // 検証環境で共有したリンクが本番のカードを出すと、確認作業が成立しない
    expect(canonicalFor(u("https://staging.waketama.com/lp"), PROD)).toBe("https://staging.waketama.com/lp");
  });
});

describe("renderRobots", () => {
  it("本番以外は全面拒否", () => {
    const txt = renderRobots(u("https://staging.waketama.com/robots.txt"), { ENVIRONMENT: "staging" });
    expect(txt).toContain("Disallow: /");
    expect(txt).not.toContain("Allow:");
  });

  it("apexは紹介ページを許可しつつ、管理画面とAPIは拒否する", () => {
    const txt = renderRobots(u("https://waketama.com/robots.txt"), PROD);
    expect(txt).toContain("Allow: /");
    expect(txt).toContain("Disallow: /admin");
    expect(txt).toContain("Disallow: /api/");
    expect(txt).toContain("Sitemap: https://waketama.com/sitemap.xml");
  });

  it("本体側は丸ごと拒否（個人の分身のページなので）", () => {
    const txt = renderRobots(u("https://app.waketama.com/robots.txt"), PROD);
    expect(txt).toContain("Disallow: /");
    expect(txt).not.toContain("Allow: /");
  });
});

describe("renderSitemap", () => {
  it("公開して意味のあるページだけを、apexのURLで載せる", () => {
    const xml = renderSitemap(u("https://waketama.com/sitemap.xml"), PROD);
    expect(xml).toContain("<loc>https://waketama.com/lp</loc>");
    expect(xml).toContain("<loc>https://waketama.com/biz</loc>");
    expect(xml).not.toContain("/home");
    expect(xml).not.toContain("/admin");
  });
});

/**
 * **分身が生まれる入口は、必ず本体ドメインで開かせる。**
 *
 * localStorage はオリジンごとに別物なので、apex で分身が生まれると
 * 持ち主の印が apex 側に保存される。本体ドメインからは二度と見えず、
 * 育てた本人が持ち主でなくなる（本人には「消えた」としか見えない）。
 * URLを刷ってから気づいても、配った現物は直せない。
 */
describe("分身が生まれる入口は、必ず本体ドメインへ送る", () => {
  const entries = [
    ["/t?u=04a1b2c3d4e5f6", "共通URLのNFCタグ"],
    ["/t/abc123", "1枚ずつコードを振ったタグ"],
    ["/t", "UIDが取れなかったタグ"],
    ["/q/abc123", "配られたQR"],
    ["/q", "コードの無いQR"],
    ["/w", "リンクだけで始める入口"],
    ["/w/", "同上（末尾スラッシュ）"],
    ["/add", "依代を持たない人の入口"],
    ["/summon?cid=x", "誕生の画面"],
  ];

  for (const [path, label] of entries) {
    it(`${label}（${path}）は app へ送る`, () => {
      const res = hostRedirect(u(`https://waketama.com${path}`), PROD);
      expect(res, `${path} が apex のまま通っている`).not.toBeNull();
      const to = new URL(res!.headers.get("location")!);
      expect(to.hostname).toBe("app.waketama.com");
      // クエリを落とすと、UIDも引換券も消えて別の子が生まれる
      expect(to.pathname + to.search).toBe(path);
    });
  }

  it("本体ドメインで開いているぶんには、そのまま通す", () => {
    for (const [path] of entries) {
      expect(hostRedirect(u(`https://app.waketama.com${path}`), PROD)).toBeNull();
    }
  });

  it("ローカルでは何も転送しない（開発中に外部へ飛ばさない）", () => {
    for (const [path] of entries) {
      expect(hostRedirect(u(`http://localhost:8787${path}`), LOCAL)).toBeNull();
    }
  });
});
