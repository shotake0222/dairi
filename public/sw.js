/*
 * わけたまのService Worker。
 *
 * 目的は2つだけ:
 *   1. ホーム画面への追加（PWAインストール）を可能にすること
 *   2. 3Dモデル(.glb)やアイコンなど、重くて滅多に変わらないファイルの再ダウンロードを省くこと
 *
 * 設計方針（ここを崩さないこと）:
 *   - HTMLとAPIは絶対にキャッシュ優先にしない。分身の状態は常に最新でなければ意味が無いし、
 *     HTMLを握ってしまうと更新を配信できなくなる（Service Workerでいちばんよくある事故）。
 *   - キャッシュするのは /icons/ と /characters/ 配下（画像・3Dモデル）だけ。
 *   - CACHE_VERSION を上げれば古いキャッシュは activate 時に全部破棄される。
 *   - skipWaiting + clients.claim で、更新したSWが次の訪問を待たずすぐ有効になるようにする。
 */

const CACHE_VERSION = "waketama-v1";
const OFFLINE_URL = "/offline";

// 起動に最低限必要で、かつ滅多に変わらないものだけを先読みしておく。
const PRECACHE_URLS = [OFFLINE_URL, "/icons/icon-192.png", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      // 1つでも失敗すると addAll 全体が失敗してSWが入らなくなるため、個別に握りつぶす。
      await Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => undefined))
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })()
  );
});

/** 画像・3Dモデルなど、キャッシュ優先にしてよいパスかどうか。 */
function isCacheableAsset(url) {
  return url.origin === self.location.origin && (url.pathname.startsWith("/icons/") || url.pathname.startsWith("/characters/"));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // APIは常にネットワークへ。ここをキャッシュすると古い性格・古い出会いが表示されてしまう。
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/t/")) return;

  // ページ遷移はネットワーク優先。オフラインのときだけ、案内ページを返す。
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch (err) {
          const cached = await caches.match(OFFLINE_URL);
          return cached || new Response("オフラインです", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
        }
      })()
    );
    return;
  }

  if (isCacheableAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        // 部分応答(206)や失敗レスポンスはキャッシュに入れない
        if (response && response.ok && response.status === 200) {
          const cache = await caches.open(CACHE_VERSION);
          cache.put(request, response.clone()).catch(() => undefined);
        }
        return response;
      })()
    );
  }
});
