/**
 * ステージング環境の入口ガード。
 *
 * なぜ必要か:
 * ステージングを独自ドメインのサブドメイン（staging.waketama.com）に載せると、
 * 当然ながら誰でも開ける状態になる。ここは検証用に本物のWorkers AIを呼ぶので、
 * 放置すると「知らない誰かの利用でAI課金が発生する」「検証中の未完成な画面が
 * 検索結果に出る」という2つの実害がある。
 *
 * 方針:
 * - 検索避け（noindex）は常に有効。これは無条件でやってよい。
 * - 合言葉は **設定されているときだけ** 有効。未設定なら素通しする。
 *   こうしておけば「合言葉を設定し忘れてデプロイが壊れる」ことがなく、
 *   必要になった時点で secret を入れるだけで締められる。
 *
 * これは本格的な認証ではない（合言葉ひとつの共有秘密）。
 * 検索エンジンや通りすがりを弾くための、検証環境相応の軽い蓋という位置づけ。
 */

const COOKIE_NAME = "waketama_staging";

export interface StagingEnv {
  ENVIRONMENT?: string;
  STAGING_PASSCODE?: string;
}

export function isStaging(env: StagingEnv): boolean {
  return env.ENVIRONMENT === "staging";
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function lockedPage(): Response {
  return new Response(
    `<!doctype html><html lang="ja"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>わけたま（検証環境）</title>
<style>
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#f5f3ff; color:#4c3a99; font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Yu Gothic",sans-serif;
    text-align:center; padding:24px; }
  .box { max-width:340px; }
  h1 { font-size:16px; margin:0 0 10px; }
  p { font-size:13px; line-height:1.9; color:#6b5cae; margin:0; }
  code { background:#ece7ff; padding:2px 6px; border-radius:5px; font-size:12px; }
</style></head>
<body><div class="box">
<h1>ここは「わけたま」の検証環境です</h1>
<p>開発中の動作確認用のため、合言葉が必要です。<br />
URLの末尾に <code>?key=合言葉</code> を付けて開いてください。</p>
</div></body></html>`,
    {
      status: 401,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    }
  );
}

/**
 * ステージングで合言葉が設定されている場合に、未認証のアクセスを止める。
 * 通してよいときは null を返す（呼び出し側はそのまま通常処理へ進む）。
 */
export function stagingGate(request: Request, url: URL, env: StagingEnv): Response | null {
  if (!isStaging(env)) return null;

  const passcode = env.STAGING_PASSCODE;
  if (!passcode) return null; // 未設定なら素通し（＝合言葉なしの検証環境として使う）

  // 死活確認だけは合言葉なしで通す。デプロイ後の疎通確認や監視から叩けるようにするため。
  if (url.pathname === "/api/health") return null;

  if (readCookie(request, COOKIE_NAME) === passcode) return null;

  // ?key=合言葉 で入ってきたら、Cookieに移してURLからは消す
  // （URLに合言葉が残ると、共有やリファラ経由で漏れやすくなるため）
  if (url.searchParams.get("key") === passcode) {
    const cleaned = new URL(url.toString());
    cleaned.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        location: cleaned.pathname + (cleaned.search || "") ,
        "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(passcode)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`,
        "cache-control": "no-store",
      },
    });
  }

  return lockedPage();
}

/** 検証環境の画面が検索結果に出ないようにする。 */
export function applyStagingHeaders(response: Response, env: StagingEnv): Response {
  if (!isStaging(env)) return response;
  const withHeader = new Response(response.body, response);
  withHeader.headers.set("x-robots-tag", "noindex, nofollow");
  return withHeader;
}
