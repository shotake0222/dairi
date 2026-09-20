/**
 * ホスト（ドメイン）ごとの役割分担。
 *
 * わけたまは1つのWorkerで2つの顔を持つ:
 *   - waketama.com      … 紹介ページ（/lp・/biz）。検索・SNS・名刺から来る人の入口。
 *   - app.waketama.com  … サービス本体（/home 以下）。分身を育てる場所。
 *
 * **なぜ本体を1つのホストに寄せるのか。**
 * 持ち主トークンはブラウザのlocalStorageに置いてあり、localStorageはオリジンごとに完全に別物になる。
 * 同じアプリを2つのホストで開けるようにしてしまうと、apexで育てた分身がappからは
 * 「持ち主ではない」ものに見える。ユーザーから見ればこれは分身を失ったのと同じで、
 * しかも本人には原因が分からない（URLの先頭が違うだけなので）。
 * だから「本体のパスはappだけ」「紹介ページはapexだけ」を入口で強制する。
 *
 * SITE_HOST / APP_HOST のどちらかが未設定なら、この仕組みは丸ごと何もしない。
 * ローカル（localhost）やステージング（staging.waketama.com）で意図しない
 * 外部ドメインへの転送が起きると、開発中に何を見ているのか分からなくなるため。
 */

/**
 * サービス本体のパス。ここに apex で来た人は app へ送り返す。
 *
 * **入口（依代・リンク）を落とすと、分身の持ち主が消える。**
 * localStorage はオリジンごとに別物なので、apex で分身が生まれると
 * 持ち主の印が apex 側に保存される。本体ドメインからは二度と見えず、
 * **育てた本人が持ち主でなくなる**（本人には「消えた」としか見えない）。
 * URLを刷ってから気づいても、配った現物は直せない。
 * 入口を足したら、必ずここにも足すこと。
 */
const APP_ONLY_PATHS = new Set([
  "/home",
  "/chat",
  "/summon",
  "/call",
  "/talk",
  "/eyes",
  "/profile",
  "/history",
  "/friends",
  "/recover",
  // --- 分身が生まれる入口 ---
  "/add", // 依代を持たない人の入口
  "/t", // 共通URLのNFCタグ（/t?u=<UID>）
  "/q", // QR
  "/w", // リンクだけで始める
]);

/** apex（紹介用ドメイン）で見せるパス。app に来たら apex へ送る。 */
const SITE_ONLY_PATHS = new Set(["/lp", "/biz"]);

/** どちらのホストでも見せてよいパス（規約・プライバシーは両方から参照される）。 */
const SHARED_PATHS = new Set(["/privacy", "/terms"]);

export interface HostConfig {
  site: string;
  app: string;
}

/**
 * ホストで振り分けてよい状況かどうか。
 *
 * **なぜ判定が要るのか。**
 * `wrangler dev` は wrangler.toml の custom_domain を見て、リクエストのURLもHostヘッダも
 * その独自ドメイン（app.waketama.com）に**書き換えてから**Workerに渡す。
 * そのため素直にホストを見ると、ローカルで http://127.0.0.1:8787/lp を開いただけで
 * 「app で紹介ページが開かれた」と判定され、本番の waketama.com へ飛ばされる。
 * つまりローカルでLPの確認ができなくなる（実際にそうなった）。
 *
 * 見分けには Miniflare が付ける mf-original-hostname を使う。
 * 「この印が無ければ本番」と判断する向きにしてあるのは、逆向き（印が無ければ開発とみなす）だと、
 * 万一その印が本番で消えたときに **apex でアプリ本体が開ける** 状態になり、
 * localStorage が分かれて利用者が分身を失うように見えるため。
 * こちら向きなら、壊れたときに困るのは開発中の自分だけで済む。
 */
export function isEdgeRuntime(request: Request): boolean {
  return !request.headers.has("mf-original-hostname");
}

/**
 * ホストの振り分けに使う設定。開発サーバー上では空にして、振り分けを丸ごと無効にする。
 * ENVIRONMENT は残す（robots.txt の判定に必要なため）。
 */
export function routingEnv<T extends { SITE_HOST?: string; APP_HOST?: string }>(request: Request, env: T): T {
  if (isEdgeRuntime(request)) return env;
  return { ...env, SITE_HOST: undefined, APP_HOST: undefined };
}

/** 2つのホストが揃っていて、かつ別物のときだけ振り分けを有効にする。 */
export function hostConfig(env: { SITE_HOST?: string; APP_HOST?: string }): HostConfig | null {
  const site = (env.SITE_HOST || "").trim().toLowerCase();
  const app = (env.APP_HOST || "").trim().toLowerCase();
  if (!site || !app || site === app) return null;
  return { site, app };
}

function isAppOnly(pathname: string): boolean {
  // 依代から飛んでくるURL（/t/<コード>・/q/<コード>）も本体側。
  // **ここを間違えると、apex を刷ったタグから生まれた分身の持ち主が消える。**
  return (
    APP_ONLY_PATHS.has(pathname) ||
    pathname === "/admin" ||
    pathname.startsWith("/t/") ||
    pathname.startsWith("/q/") ||
    pathname === "/w/"
  );
}

/**
 * ホストが違えば転送する。転送不要ならnull。
 *
 * 恒久リダイレクト（301）はブラウザに強く記憶され、後から方針を変えても
 * 古い転送を掴み続ける端末が出る。運用初期は取り消しの効く302にしておき、
 * 検索エンジン向けの正規化は canonical リンクで行う。
 */
export function hostRedirect(url: URL, env: { SITE_HOST?: string; APP_HOST?: string }): Response | null {
  const hosts = hostConfig(env);
  if (!hosts) return null;
  const hostname = url.hostname.toLowerCase();

  if (hostname === hosts.site) {
    // 紹介ドメインの入口はLP。/home ではない（まだサービスを知らない人が来る場所なので）。
    if (url.pathname === "/") {
      return Response.redirect(`https://${hosts.site}/lp`, 302);
    }
    if (isAppOnly(url.pathname)) {
      return Response.redirect(`https://${hosts.app}${url.pathname}${url.search}`, 302);
    }
    return null;
  }

  if (hostname === hosts.app && SITE_ONLY_PATHS.has(url.pathname)) {
    return Response.redirect(`https://${hosts.site}${url.pathname}`, 302);
  }

  return null;
}

/**
 * そのページの正規URL。検索結果に app と apex の両方が並ぶのを防ぐ。
 * 振り分けが無効（ローカル・ステージング）なら、今開いているオリジンをそのまま正とする。
 */
export function canonicalFor(url: URL, env: { SITE_HOST?: string; APP_HOST?: string }): string {
  const hosts = hostConfig(env);
  const hostname = url.hostname.toLowerCase();
  // 本番の2つのホスト以外（ローカル・検証環境・プレビュー）から配信されているときは、
  // 今見ているURLをそのまま正とする。ここで本番のURLを名乗ると、
  // 検証環境で共有したリンクが本番のカードを出すことになり、確認作業が成立しない。
  if (!hosts || (hostname !== hosts.site && hostname !== hosts.app)) return url.origin + url.pathname;
  if (SITE_ONLY_PATHS.has(url.pathname)) return `https://${hosts.site}${url.pathname}`;
  if (SHARED_PATHS.has(url.pathname)) return `https://${hosts.site}${url.pathname}`;
  return `https://${hosts.app}${url.pathname}`;
}

/**
 * robots.txt。ホストごとに内容を変える。
 * - 検証環境（ENVIRONMENT !== "production"）は全面拒否。テスト用の分身が検索に出ると実害がある。
 * - 管理画面とAPIはどのホストでも拒否。
 * - サービス本体（app）は個人のページばかりなので、紹介ページ以外はクロールさせない。
 */
export function renderRobots(url: URL, env: { SITE_HOST?: string; APP_HOST?: string; ENVIRONMENT?: string }): string {
  if ((env.ENVIRONMENT || "") !== "production") {
    return "User-agent: *\nDisallow: /\n";
  }
  const hosts = hostConfig(env);
  const hostname = url.hostname.toLowerCase();
  const lines = ["User-agent: *", "Disallow: /admin", "Disallow: /api/", "Disallow: /t/"];

  if (hosts && hostname === hosts.app) {
    // 本体側は個人の分身のページ。インデックスされて得をする人がいない。
    lines.push("Disallow: /");
  } else {
    lines.push("Allow: /");
  }
  if (hosts) {
    lines.push("", `Sitemap: https://${hosts.site}/sitemap.xml`);
  }
  return lines.join("\n") + "\n";
}

/** 紹介ドメイン（apex）で開かれているか。ここではPWAとしてインストールさせない。 */
export function isMarketingHost(url: URL, env: { SITE_HOST?: string; APP_HOST?: string }): boolean {
  const hosts = hostConfig(env);
  return Boolean(hosts && url.hostname.toLowerCase() === hosts.site);
}

/**
 * Service Workerの緊急停止。
 *
 * Service Workerは一度入ると、こちらが配信を直しても端末側の古いSWが動き続ける。
 * 壊れたSWを配ってしまった場合、利用者に「サイトデータを削除してください」と
 * 案内するしかなくなる——これは実質的にサービスが死ぬのと同じなので、
 * **サーバー側から解除できる手段**を最初から持っておく。
 *
 * 使い方: SW_KILL=1 を付けてデプロイすると、/sw.js の中身がこの解除スクリプトに置き換わる。
 * 端末は数時間以内（もしくは次回のページ遷移時）にこれを取得し、自分自身を登録解除して
 * キャッシュを捨てる。復旧したら SW_KILL を外して戻す。
 *
 * 紹介ドメイン（apex）でも同じものを返す。紹介ページからPWAを入れられると、
 * 起動のたびに本体ドメインへ転送される「入れても意味のないアプリ」ができてしまうため。
 */
export const SW_UNREGISTER_SCRIPT = `/* わけたま: このService Workerは無効化されています */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    for (const client of clients) client.navigate(client.url);
  })());
});
`;

/** 公開して意味のあるページだけを載せる（個人の分身のページは載せない）。 */
export function renderSitemap(url: URL, env: { SITE_HOST?: string; APP_HOST?: string }): string {
  const hosts = hostConfig(env);
  const base = hosts ? `https://${hosts.site}` : url.origin;
  const paths = ["/lp", "/biz", "/privacy", "/terms"];
  const entries = paths
    .map((p) => `  <url><loc>${base}${p}</loc><changefreq>weekly</changefreq></url>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</urlset>\n`;
}
