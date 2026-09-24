import { CharacterState, SPECIES_LABELS, MEETING_COOLDOWN_MS, MeetingLogEntry, MeetingRecord, SpeciesKey, ColorKey, PersonalityPackageV1 } from "./durable-objects/characterState";
import { deriveSpeechStyle } from "./ai/speechStyle";
import { PersonalityTraits, TRAIT_KEYS } from "./ai/personality";
import { handleCallStream } from "./call";
import { handleTalk } from "./talk";
import { deriveVoiceProfile } from "./ai/voiceProfile";
import { handleHealth } from "./health";
import { handleTranscribe, handleSpeak } from "./voice";
import { issueTransferCode, claimTransferCode } from "./transfer";
import { purgeUnusedImages, serveImage, storeImage, storeLandImage } from "./media";
import { stagingGate, applyStagingHeaders } from "./stagingGuard";
import { handleEconomyAdmin, handleEconomyApi, handleRedeemApi } from "./economyRoutes";
import { listShops } from "./economy";
import { adminGate, applyAdminHeaders, handleAdminOverview, handleAdminPersonas, isAdminRequest } from "./admin";
import {
  handleGetOwnerView,
  handlePersonaCard,
  handleProfileSchema,
  handleSetAccessibility,
  handleSetConsent,
  handleSetNotes,
  handleSetProfile,
} from "./personaRoutes";
import { handleInsights } from "./insights";
import { handleIme } from "./ime";
import {
  handleSurveyAnswer,
  handleSurveyCatalog,
  handleSurveyDecline,
  handleSurveyNext,
  handleSurveySkip,
} from "./surveyRoutes";
import { handleAdminQuestions } from "./admin";
import { handleContact, handleAdminContacts } from "./contact";
import { handleRecoveryLookup, handleRecoveryIssue } from "./recovery";
import { countMetric } from "./persona/registry";
import { canonicalFor, hostRedirect, isMarketingHost, renderRobots, renderSitemap, routingEnv, SW_UNREGISTER_SCRIPT } from "./hosts";
import { growthProgress } from "./ai/growth";
import { purgeOldIpQuota } from "./lib/ipQuota";
import {
  canClaimNewTag,
  createDirectCharacter,
  dailyLimitFor,
  deleteSpot,
  getSpot,
  issueTags,
  listSpots,
  listTags,
  publicSpot,
  recordOrigin,
  identifyTag,
  isLimitedSpot,
  saveSpot,
  spotOfTag,
} from "./yorishiro";
import {
  buildDelivery,
  DELIVERY_SCOPES,
  DeliveryScope,
  issueGrant,
  listGrants,
  revokeGrant,
  SKUS,
  verifyGrant,
} from "./delivery";
import {
  canCreateCharacter,
  claimCookie,
  ENTRY_CLOSED_MESSAGE,
  isEntryOpen,
} from "./entryPolicy";
import { handleMcp } from "./mcp";
import { MetaverseRoom } from "./durable-objects/metaverseRoom";
import { roomView } from "./metaRoomView";
import { partnerKeyOf } from "./metaText";
import {
  createAdminCharacters,
  deleteAdminCharacter,
  deleteNpc,
  listAdminCharacters,
  listNpcs,
  NPC_SPOTS,
  refreshNpcAvatars,
  saveNpc,
} from "./adminCharacters";
import {
  createOrder,
  deletePlacement,
  endPlacement,
  getLandSettings,
  LAND_SPOTS,
  LANDMARK_COLORS,
  LANDMARK_MODELS,
  landCatalog,
  listAdsAndCoupons,
  listOrders,
  listPlacements,
  listPlots,
  orderAction,
  orderStatus,
  pendingOrderCount,
  recordAdEvent,
  SALE_KINDS,
  saveLandSettings,
  savePlacement,
  savePlots,
} from "./land";
import {
  applicationStatus,
  createApplication,
  createInvites,
  decideApplication,
  getApplicationSettings,
  INVITE_FAIL_TEXT,
  isInviteCode,
  listApplications,
  listInvites,
  pendingApplicationCount,
  redeemInvite,
  saveApplicationSettings,
  setInviteActive,
} from "./invites";
import {
  areaState,
  deleteRoom,
  getGameSettings,
  getRoom,
  listAdminRooms,
  listRooms,
  mergeRooms,
  metaverseCatalog,
  publicRoom,
  resolveRoom,
  saveGameSettings,
  saveRoom,
  upsertTestArea,
  type RoomConfig,
} from "./metaverse";
import { LogContext, newRequestId } from "./lib/log";

export { CharacterState, MetaverseRoom };

export interface Env {
  AI: Ai;
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  CHARACTER: DurableObjectNamespace<CharacterState>;
  /** メタバースの部屋（1部屋＝1インスタンス。src/durable-objects/metaverseRoom.ts） */
  META_ROOM: DurableObjectNamespace<MetaverseRoom>;
  ASSETS: Fetcher;
  /** デプロイ時に注入される版数（npm run deploy が git のコミットハッシュを渡す）。 */
  APP_VERSION?: string;
  BUILT_AT?: string;
  /** "production" | "staging"。wrangler.toml の [vars] で環境ごとに設定している。 */
  ENVIRONMENT?: string;
  /** ステージングの合言葉。設定されているときだけ入口で要求する（secretで設定）。 */
  STAGING_PASSCODE?: string;
  /**
   * 会話モデルの上書き。コードを変えずに品質評価やロールバックができるようにするための逃げ道。
   * 未設定なら src/ai/modelPolicy.ts の既定の連鎖を使う。
   */
  CHAT_MODEL?: string;
  /** 管理画面の合言葉。未設定なら管理画面は開かない（secretで設定）。 */
  ADMIN_PASSCODE?: string;
  /**
   * 依代を持たない人にも入口を開けるか（"1" で開ける。**既定は閉じる**）。
   *   npx wrangler deploy --env="" --var ENTRY_OPEN:1
   * 閉じているあいだ、/add の「この端末で分身を始める」と /w は管理者だけが使える。
   * 依代（/t・/q）から来た人は、この設定に関係なくいつでも作れる（src/entryPolicy.ts）。
   */
  ENTRY_OPEN?: string;
  /**
   * Service Workerの緊急停止。"1" を指定してデプロイすると、/sw.js が解除用スクリプトに変わる。
   *   npx wrangler deploy --env="" --var SW_KILL:1
   * 壊れたSWが配られたときの唯一の逃げ道なので、消さないこと（src/hosts.ts）。
   */
  SW_KILL?: string;
  /**
   * 紹介ページを見せるドメイン（apex）とサービス本体のドメイン。
   * 両方揃っているときだけホストの振り分けが働く（src/hosts.ts）。
   * ローカル・ステージングでは未設定なので、何も起きない。
   */
  SITE_HOST?: string;
  APP_HOST?: string;
}

/**
 * 実機デバッグ用に、全レスポンスへ版数を載せる。
 * PWA化した以上「いま端末が掴んでいるのはどの版か」が分からないと、
 * Service Workerやキャッシュが絡んだ不具合の切り分けができなくなる。
 */
function versionHeaders(env: Env): Record<string, string> {
  return { "x-waketama-version": env.APP_VERSION || "dev" };
}

function json(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers || {}) },
  });
}

/**
 * CSPのscript-srcに使う、リクエストごとの使い捨てトークン。
 * HTMLの各 <script> タグに同じ値を nonce 属性として振り、ヘッダの許可リストと突き合わせる。
 * 推測されると意味が無くなるので、暗号乱数から作る（crypto.randomUUID ではなく getRandomValues
 * を使うのは、UUIDのハイフンや版数ビットのような固定パターンを含めたくないため）。
 */
function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * HTMLページに付ける保護のヘッダ。
 *
 * - frame-ancestors: 他所のサイトに埋め込ませない。管理画面や引き継ぎ画面を透明なiframeで重ねて
 *   踏ませる手口（クリックジャッキング）を塞ぐ。X-Frame-Options は古いブラウザ向けの保険。
 * - script-src 'nonce-...': そのレスポンスと一緒に配った nonce を持つ <script> だけを実行させる。
 *   攻撃者がどこかから文字列を注入できても（XSS）、nonce を知らなければスクリプトとしては動かない。
 *   全ページのインラインスクリプトに serveAsset() 側で同じ nonce を振っているので、
 *   'unsafe-inline' を許可する必要がない（詳しくは serveAsset の HTMLRewriter 部分）。
 * - 'strict-dynamic': nonce を持つスクリプトが**自分で読み込んだ**スクリプトも実行を許す。
 *   視線入力（eyes.html）は MediaPipe を import() で後から読むので、これが無いと
 *   nonce だけのCSPでは読み込みが拒否されて、視線入力が黙って動かなくなる。
 *   'strict-dynamic' を付けても、攻撃者が注入した（nonce を持たない）タグは動かないのは同じ。
 * - 'wasm-unsafe-eval': MediaPipe は WebAssembly を使う。WASMのコンパイルだけを許す指定で、
 *   JavaScript の eval は許さない（'unsafe-eval' とは別物）。
 * - worker-src 'self': Service Worker（/sw.js）の登録。worker-src を書かないと script-src が
 *   代わりに使われ、nonce を付けられない sw.js が拒否される（オフライン対応が消える）。
 *   2026-09-23、実ブラウザで確かめて見つけた。nonce 化（10-8）のときはブラウザで確認できていなかった。
 * - object-src / base-uri: <object>/<embed>や<base>タグの差し替えでCSPを迂回されないための保険。
 *   このサービスはどちらも使っていないので、閉じてしまって実害が無い。
 * - nosniff: content-typeを無視した解釈をさせない。
 * - Referrer-Policy: 他所へ遷移するときに、URLのクエリ（cid等）を送らない。
 * - Permissions-Policy: カメラ・マイクは自分のページでだけ使う（かざして話す・通話・視線入力で必要）。
 *   位置情報などは使っていないので明示的に閉じる。
 */
function securityHeaders(nonce: string): Record<string, string> {
  return {
    "content-security-policy":
      `frame-ancestors 'none'; script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'; ` +
      `worker-src 'self'; object-src 'none'; base-uri 'none'`,
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    // メタバースのミニゲーム（sensorgames.mjs）: 傾き・動き・AR も自分のページでだけ
    "permissions-policy":
      "camera=(self), microphone=(self), accelerometer=(self), gyroscope=(self), magnetometer=(self), xr-spatial-tracking=(self), geolocation=(), payment=(), usb=()",
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // ホストで判断する処理は、開発サーバーでは無効にする。
    // wrangler dev はURLもHostヘッダも独自ドメインに書き換えてしまうため
    // （詳細は src/hosts.ts の isEdgeRuntime）。
    const hostEnv = routingEnv(request, env);
    const log: LogContext = { requestId: newRequestId(), route: url.pathname };

    // 検証環境に合言葉が設定されている場合、ここで止める（本番では何もしない）
    const gated = stagingGate(request, url, env);
    if (gated) return gated;

    // 紹介ドメイン（waketama.com）とアプリ本体（app.waketama.com）の振り分け。
    // 合言葉の判定より前に置くと、管理画面のパスが素通りしてしまうので必ず後。
    // 詳しい理由（localStorageはオリジンごとに別物）は src/hosts.ts の冒頭コメント。
    const hostMoved = hostRedirect(url, hostEnv);
    if (hostMoved) return hostMoved;

    // 管理画面は合言葉で閉じる。未設定なら開かない（設定漏れが情報公開になるのを防ぐ）
    const adminBlocked = adminGate(request, url, env);
    if (adminBlocked) return adminBlocked;

    // --- Service Workerの配信（緊急停止の口）---
    // 壊れたSWを配ると、こちらが直しても端末側の古いSWが動き続ける。
    // SW_KILL=1 を付けてデプロイすれば、解除用のスクリプトに差し替えて端末から抜ける。
    if (url.pathname === "/sw.js") {
      if (env.SW_KILL === "1" || isMarketingHost(url, hostEnv)) {
        return new Response(SW_UNREGISTER_SCRIPT, {
          headers: {
            "content-type": "text/javascript; charset=utf-8",
            // 端末が古いSWを掴み続けないよう、ここだけは絶対にキャッシュさせない
            "cache-control": "no-store",
          },
        });
      }
      return env.ASSETS.fetch(request);
    }

    // --- 検索エンジン向け ---
    if (url.pathname === "/robots.txt") {
      return new Response(renderRobots(url, hostEnv), {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }
    if (url.pathname === "/sitemap.xml") {
      return new Response(renderSitemap(url, hostEnv), {
        headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
      });
    }

    // --- トップページ ---
    // public/ に index.html を置いていないため、素のドメインを開くと404になってしまう。
    // ドメイン直打ちや共有リンクからの流入は「分身一覧」に着地させる。
    // （apex に来た人は hostRedirect が先に /lp へ送っているので、ここに来るのは本体側だけ）
    if (url.pathname === "/") {
      return Response.redirect(new URL("/home", url.origin).toString(), 302);
    }

    // --- 死活・自己診断 ---
    // 「記憶が保存されていない気がする」類の切り分けを1秒で終わらせるためのエンドポイント。
    // 既定ではAIを呼ばない（呼ぶと課金が発生するため）。深い確認は ?deep=1 で明示的に行う。
    if (url.pathname === "/api/health") {
      return handleHealth(env, url, log);
    }

    // --- その場限りの通話（何も保存しないモード） ---
    // 応答はSSEで流す。詳しい設計方針は src/call.ts の冒頭コメントを参照。
    if (url.pathname === "/api/call/stream" && request.method === "POST") {
      const body = await request.json<Record<string, unknown>>();
      ctx.waitUntil(countMetric(env, "call"));
      return handleCallStream(env, body, { ...log, characterId: typeof body.characterId === "string" ? body.characterId : undefined });
    }

    // --- 納品（買い手が引換券で取り出す口。持ち主トークンは使わせない） ---
    //
    // 持ち主トークンで取り出す /api/persona/card とは経路を分けてある。
    // 同じ関数から本人向けと買い手向けを出すと、片方だけ範囲を変えたときに事故る。
    // --- メタバース（部屋の設定と、入室のWebSocket。src/metaverse.ts / metaverseRoom.ts） ---
    // --- メタバースの通貨・お店（src/economy.ts）と、提携店の店頭での引き換え ---
    if (url.pathname.startsWith("/api/meta/economy/")) {
      const economyResponse = await handleEconomyApi(request, url, env);
      if (economyResponse) return economyResponse;
    }
    if (url.pathname.startsWith("/api/redeem/")) {
      const redeemResponse = await handleRedeemApi(request, url, env);
      if (redeemResponse) return redeemResponse;
    }
    if (url.pathname.startsWith("/api/meta/")) {
      const metaResponse = await handleMetaverseApi(request, url, env);
      if (metaResponse) return metaResponse;
    }
    // --- 区画（広告・ランドマーク）の申込と、依代を使わない入口（Web申し込み・招待リンク） ---
    if (url.pathname.startsWith("/api/land/") || url.pathname.startsWith("/api/apply") || url.pathname === "/api/meta-ad-event") {
      const publicResponse = await handlePublicLandAndEntry(request, url, env, log);
      if (publicResponse) return publicResponse;
    }
    // アップロードした画像: /img/<id>.<拡張子>（広告・ランドマーク・看板。src/media.ts）
    if (url.pathname.startsWith("/img/")) {
      const image = await serveImage(env, request, url.pathname);
      if (image) return image;
    }
    // 招待リンク: /i/<コード>（開いた端末に分身と持ち主の印を渡す）
    if (url.pathname.startsWith("/i/")) {
      const code = url.pathname.slice(3).replace(/\/$/, "");
      if (!isInviteCode(code)) return Response.redirect(new URL("/apply?invite=not_found", url.origin).toString(), 302);
      const result = await redeemInvite(env, code, request);
      if (!result.ok) return Response.redirect(new URL(`/apply?invite=${result.reason}`, url.origin).toString(), 302);
      ctx.waitUntil(countMetric(env, "new_character"));
      const next = new URL("/summon", url.origin);
      next.searchParams.set("cid", result.characterId);
      // 引き渡し（もう名前も性格もある運営の分身）は、名付けの場面を出さない
      if (result.kind === "new") next.searchParams.set("first", "1");
      // 持ち主の印は、この一度だけURLで渡す（summon.html がすぐ端末に保存して、URLから消す。/t と同じ）
      next.searchParams.set("token", result.ownerToken);
      return Response.redirect(next.toString(), 302);
    }

    if (url.pathname === "/api/delivery" && request.method === "GET") {
      const scopeParam = url.searchParams.get("scope") || "card";
      const scope = (DELIVERY_SCOPES as string[]).includes(scopeParam) ? (scopeParam as DeliveryScope) : null;
      if (!scope) return json({ error: "scope は card / behavior / mcp / bundle のいずれかです" }, { status: 400 });

      const grant = await verifyGrant(env, url.searchParams.get("token"), scope);
      if (!grant.ok) return json({ error: grant.error }, { status: grant.status });

      const payload = await buildDelivery(env, grant.characterId, scope, url.searchParams.get("format") || "json");
      // 下見も買い手向けの写しで出す。持ち主が個別提供を許可していない分身は、商談の場にも出さない
      if (!payload) {
        return json(
          { error: "取り出せませんでした（分身が無いか、持ち主が法人への個別提供を許可していません）" },
          { status: 404 }
        );
      }

      return new Response(payload.body, {
        headers: {
          "content-type": payload.contentType,
          "cache-control": "no-store",
          "content-disposition": `attachment; filename="${encodeURIComponent(payload.filename)}"`,
        },
      });
    }

    // 相手がAIのときの口。読み取りだけで、分身には何も保存しない（src/mcp.ts）
    if (url.pathname === "/mcp") {
      return handleMcp(env, request, url);
    }

    // --- 管理画面のAPI（adminGate を通過したリクエストだけがここに来る） ---
    // メタバースの部屋（作る・直すのはここだけ。置く物＝看板・動画・ミニゲームもここで決める）
    if (
      url.pathname.startsWith("/api/admin/characters") ||
      url.pathname.startsWith("/api/admin/npcs") ||
      url.pathname.startsWith("/api/admin/land/") ||
      url.pathname.startsWith("/api/admin/invites") ||
      url.pathname.startsWith("/api/admin/applications") ||
      url.pathname === "/api/admin/badges"
    ) {
      const extra = await handleAdminExtra(request, url, env);
      if (extra) return extra;
    }
    // 管理画面からの画像のアップロード（広告・ランドマーク・看板）
    if (url.pathname === "/api/admin/media" && request.method === "POST") {
      const stored = await storeImage(env, request, "admin");
      if (!stored.ok) return json({ error: stored.error }, { status: stored.status });
      return json({ url: stored.url, bytes: stored.bytes });
    }
    if (url.pathname.startsWith("/api/admin/economy/")) {
      const economyAdmin = await handleEconomyAdmin(request, url, env);
      if (economyAdmin) return economyAdmin;
    }
    if (url.pathname.startsWith("/api/admin/meta/")) {
      const metaAdmin = await handleMetaverseAdmin(request, url, env);
      if (metaAdmin) return metaAdmin;
    }
    if (url.pathname === "/api/admin/overview" && request.method === "GET") {
      return handleAdminOverview(env, log);
    }
    if (url.pathname === "/api/admin/personas" && request.method === "GET") {
      return handleAdminPersonas(env, url);
    }
    if (url.pathname === "/api/admin/contacts") {
      return handleAdminContacts(env, request, url);
    }
    // 設問の編集。人格データの質は設問の質でほぼ決まるので、デプロイせずに直せるようにしてある。
    if (url.pathname === "/api/admin/questions") {
      return handleAdminQuestions(env, request);
    }
    // 復旧（持ち主トークンを失った人の救済）。所有権を移せる操作なので管理画面の中にだけ置く。
    if (url.pathname === "/api/admin/recovery/lookup" && request.method === "GET") {
      return handleRecoveryLookup(env, url, log);
    }
    if (url.pathname === "/api/admin/recovery/issue" && request.method === "POST") {
      return handleRecoveryIssue(env, await request.json(), log);
    }
    // 依代（NFCタグの台帳／場所に置くQR）の管理。
    // 何枚配ったか・どのQRが使われているかが分からないと、設置した側に報告もできない。
    if (url.pathname === "/api/admin/tags" && request.method === "GET") {
      return json({ tags: await listTags(env, Number(url.searchParams.get("limit") ?? 200)) });
    }
    if (url.pathname === "/api/admin/tags" && request.method === "POST") {
      const result = await issueTags(env, await request.json<Record<string, unknown>>());
      return result.ok ? json({ tagIds: result.tagIds }) : json({ error: result.error }, { status: result.status });
    }
    if (url.pathname === "/api/admin/spots" && request.method === "GET") {
      return json({ spots: await listSpots(env) });
    }
    if (url.pathname === "/api/admin/spots" && request.method === "POST") {
      const result = await saveSpot(env, await request.json<Record<string, unknown>>());
      return result.ok ? json({ spot: result.spot }) : json({ error: result.error }, { status: result.status });
    }
    // 納品（何を売るのかの定義と、買い手に渡す引換券）
    if (url.pathname === "/api/admin/skus" && request.method === "GET") {
      return json({ skus: SKUS, scopes: DELIVERY_SCOPES });
    }
    if (url.pathname === "/api/admin/grants" && request.method === "GET") {
      return json({ grants: await listGrants(env) });
    }
    if (url.pathname === "/api/admin/grants" && request.method === "POST") {
      const result = await issueGrant(env, await request.json<Record<string, unknown>>());
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      // 引換券の平文を出せるのはこの1回だけ（保存しているのはハッシュ）
      return json({ token: result.token, expiresAt: result.expiresAt });
    }
    // 商談の場で中身を見せるための下見。引換券を発行せずに、同じものを出す。
    // 管理画面の中だけなので、外からは見えない。
    if (url.pathname === "/api/admin/preview" && request.method === "GET") {
      const scopeParam = url.searchParams.get("scope") || "decision";
      const scope = (DELIVERY_SCOPES as string[]).includes(scopeParam) ? (scopeParam as DeliveryScope) : null;
      const cid = url.searchParams.get("cid") || "";
      if (!scope || !cid) return json({ error: "cid と scope が要ります" }, { status: 400 });
      const payload = await buildDelivery(env, cid, scope, url.searchParams.get("format") || "json");
      // 下見も買い手向けの写しで出す。持ち主が個別提供を許可していない分身は、商談の場にも出さない
      if (!payload) {
        return json(
          { error: "取り出せませんでした（分身が無いか、持ち主が法人への個別提供を許可していません）" },
          { status: 404 }
        );
      }
      return new Response(payload.body, {
        headers: { "content-type": payload.contentType, "cache-control": "no-store" },
      });
    }
    if (url.pathname === "/api/admin/grants" && request.method === "DELETE") {
      const body = await request.json<{ tokenHash?: string }>();
      return json(await revokeGrant(env, body.tokenHash));
    }
    if (url.pathname === "/api/admin/spots" && request.method === "DELETE") {
      const body = await request.json<{ code?: string }>();
      return json(await deleteSpot(env, body.code));
    }

    // --- 属性・同意・アクセシビリティ（すべて持ち主トークンで保護） ---
    if (url.pathname === "/api/profile/schema" && request.method === "GET") {
      return handleProfileSchema();
    }

    // 「いま、依代を持たない人も分身を作れるか」。
    // 画面が押せないボタンを出さないためだけの口なので、理由までは返す。
    // **判定そのものは作成時にサーバーでやり直す**（画面の判定は飾り）。
    if (url.pathname === "/api/entry" && request.method === "GET") {
      const decision = canCreateCharacter(request, env);
      return json({
        canCreate: decision.allowed,
        reason: decision.reason,
        message: decision.allowed ? null : ENTRY_CLOSED_MESSAGE,
      });
    }
    if (url.pathname === "/api/profile" && request.method === "GET") {
      return handleGetOwnerView(env, url);
    }
    if (url.pathname === "/api/profile" && request.method === "POST") {
      return handleSetProfile(env, await request.json());
    }
    if (url.pathname === "/api/consent" && request.method === "POST") {
      return handleSetConsent(env, await request.json(), log);
    }
    if (url.pathname === "/api/accessibility" && request.method === "POST") {
      return handleSetAccessibility(env, await request.json());
    }
    // 分身が自分について覚えている内容は、間違っていたら本人が直せる必要がある
    if (url.pathname === "/api/notes" && request.method === "POST") {
      return handleSetNotes(env, await request.json());
    }

    // --- 会話の履歴（画面に前回までのやり取りを戻すため） ---
    //
    // 会話の本文そのものなので、cidだけでは読めない。必ず持ち主トークンを要求する。
    //
    // **/api/character/history ではなく /api/character/dialogue。**
    // 前者は先に「性格の変遷（成長グラフ）」が使っていた名前で、
    // ここで同じ名前を先に登録してしまい、成長ページが静かに空になっていた。
    // 同じ「履歴」でも、性格の履歴と会話の履歴は別物なので、名前を分ける。
    if (url.pathname === "/api/character/dialogue" && request.method === "GET") {
      const cid = url.searchParams.get("cid");
      if (!cid) return json({ error: "cid is required" }, { status: 400 });
      const limit = Math.min(60, Math.max(1, Number(url.searchParams.get("limit") ?? 40) || 40));
      const result = await env.CHARACTER.getByName(cid).getDialogue(
        url.searchParams.get("token") || undefined,
        limit
      );
      if (!result.ok) {
        return json({ error: result.error }, { status: result.error === "not found" ? 404 : 403 });
      }
      return json(result, { headers: { "cache-control": "no-store" } });
    }

    // --- パルスサーベイ（会話の合間に1問ずつ聞く） ---
    // 設問の出し方はサーバー側で決める。画面ごとに判断を持たせると、同じ人に同じ設問が何度も出る。
    if (url.pathname === "/api/survey/next" && request.method === "GET") {
      return handleSurveyNext(env, url);
    }
    if (url.pathname === "/api/survey/answer" && request.method === "POST") {
      return handleSurveyAnswer(env, await request.json(), log);
    }
    if (url.pathname === "/api/survey/skip" && request.method === "POST") {
      return handleSurveySkip(env, await request.json());
    }
    if (url.pathname === "/api/survey/decline" && request.method === "POST") {
      return handleSurveyDecline(env, await request.json(), log);
    }
    if (url.pathname === "/api/survey/catalog" && request.method === "GET") {
      return handleSurveyCatalog(env);
    }

    // --- 人格カード（エッジAI・別ランタイムへの持ち出し） ---
    if (url.pathname === "/api/persona/card" && request.method === "GET") {
      return handlePersonaCard(env, url, log);
    }

    // --- マーケット ---
    // 匿名集約のセグメント統計。
    // **本人による出品の機能は畳んだ**ので、/api/market/* のうち残っているのはここだけ。
    // 出品を消した理由は、人格を他人が使う仕組みを開けたままにすると、
    // 「誰に渡ってよいか」の運用を先に固めない限り、取り返しがつかない事故になりうるため。
    // 企業への提供は、運営が引換券で個別に行う形（src/delivery.ts）に一本化した。
    if (url.pathname === "/api/market/insights" && request.method === "GET") {
      return handleInsights(env, log);
    }

    // --- 法人向けページからの問い合わせ ---
    if (url.pathname === "/api/contact" && request.method === "POST") {
      return handleContact(env, await request.json(), log, request);
    }

    // --- かな漢字変換（視線入力・スイッチ入力の補助） ---
    if (url.pathname === "/api/ime" && request.method === "POST") {
      return handleIme(env, await request.json(), log);
    }

    // --- かざして話す（カメラ映像を出したまま声で会話する） ---
    // 通話と違い、こちらは通常の会話と同じく保存され、性格も育つ。詳しい設計は src/talk.ts を参照。
    if (url.pathname === "/api/talk" && request.method === "POST") {
      const body = await request.json<Record<string, unknown>>();
      // 利用状況のカウントは応答を待たせない。1件欠けることより、返事が遅れる方が損失が大きい。
      ctx.waitUntil(countMetric(env, "talk"));
      return handleTalk(env, body, {
        ...log,
        characterId: typeof body.characterId === "string" ? body.characterId : undefined,
      });
    }

    // --- 音声入力の文字起こし ---
    if (url.pathname === "/api/voice/transcribe" && request.method === "POST") {
      return handleTranscribe(env, request, log);
    }

    // --- 音声合成（読み上げ）。ブラウザ標準の音声より自然な声を使いたいとき用 ---
    if (url.pathname === "/api/voice/speak" && request.method === "POST") {
      return handleSpeak(env, request, log);
    }

    // 依代を持っていない人が、その端末だけで育てる分身を始める入口。
    if (url.pathname === "/api/character/new" && request.method === "POST") {
      // 依代をかざしたのにタグを特定できなかったとき（UIDミラー未設定など）も、ここを通る。
      // その場合だけ入口の記録を分ける。配った枚数と合わなくなるのを避けるため。
      // **依代を持たない人の入口は、既定で閉じている。**
      // 依代から来た人（/t・/q が付けた印を持っている）と管理者だけが通る。
      // 理由と開け方は src/entryPolicy.ts。
      const gate = canCreateCharacter(request, env);
      if (!gate.allowed) {
        return json({ error: ENTRY_CLOSED_MESSAGE, reason: "closed" }, { status: 403 });
      }

      const from = url.searchParams.get("from");
      const kind =
        from === "tag" ? "nfc" : from === "qr" ? "qr" : from === "web" ? "web" : "direct";
      // 1日あたりの上限は、通り方で変える。**管理者は数えない**
      // （運営が自分の道具で詰まるのがいちばん無駄。src/yorishiro.ts の dailyLimitFor）。
      const result = await createDirectCharacter(env, request, kind, dailyLimitFor(gate.reason));
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      ctx.waitUntil(countMetric(env, "new_character"));
      return json({ characterId: result.characterId, ownerToken: result.ownerToken });
    }

    // その依代がどこで配られたものかを、出会いの画面で見せるための情報。
    if (url.pathname === "/api/spot" && request.method === "GET") {
      const spot = await getSpot(env, url.searchParams.get("code") || "");
      if (!spot) return json({ error: "見つかりませんでした" }, { status: 404 });
      return json({ spot: publicSpot(spot) });
    }

    // --- 依代の読み取り: /t/:code（かざす） と /q/:code（QRを読み取る） ---
    //
    // **2つのパスは同じ処理にしてある。** 読み取り方が違うだけで、意味は同じ。
    //   - 1つの依代からは1体しか生まれない（2回目以降は同じ子に会いに行く）
    //   - 生まれる子の姿はランダム。どちらの入口でも確率は等しい
    // ここを揃えておかないと「集める」が成り立たない。運営が姿を決められるようにすると
    // 「引き当てた」が「配られた」になり、1つの依代から何体も生まれるなら集める理由が消える。
    //
    // --- 依代を使わない入口: /w（Webだけで始める） ---
    //
    // **タグが刷り上がる前でも、サービスを始められるようにするための口。**
    // リンクを配る・QRに刷る・SNSに貼る、のどれでも使える。かざす依代と同じで、
    // 開いた瞬間に1体生まれ、2回目からは同じ子に戻る（同じ端末なら）。
    //
    // 依代に紐づかないので、**端末を変えると引き継ぎコードだけが頼り**になる。
    // その注意は /summon の先（チャット画面）で伝えている。
    // 1日に作れる数は同じ回線から3体まで（src/yorishiro.ts の DIRECT_CREATE_DAILY_LIMIT）。
    if (url.pathname === "/w" || url.pathname === "/w/") {
      // 公開URLなので、依代を持たない人の入口が開いているときだけ通す。
      // 閉じているときは「依代をお持ちの方だけ」と伝える画面へ（/add）。
      if (!isEntryOpen(env) && !canCreateCharacter(request, env).allowed) {
        return Response.redirect(new URL("/add?closed=1", url.origin).toString(), 302);
      }
      ctx.waitUntil(countMetric(env, "scan"));
      const claim = new URL("/summon", url.origin);
      claim.searchParams.set("claim", "web");
      return Response.redirect(claim.toString(), 302);
    }

    // **依代に書き込むURLは、全部同じで構わない。**
    //   https://<ドメイン>/t?u=00000000000000   ← NFCタグ（UIDミラーの埋め草つき）
    //   https://<ドメイン>/q/<コード>            ← QRは1枚ずつ違うコードを刷る
    // タグは読まれた瞬間に、チップが自分のUIDを埋め草へ差し替える。書き込む内容は同じ、
    // 読まれるURLはタグごとに違う——これで外注できて、かつ1枚1体が成立する
    // （詳しくは src/yorishiro.ts の identifyTag）。
    if (url.pathname.startsWith("/t/") || url.pathname.startsWith("/q/") ||
        url.pathname === "/t" || url.pathname === "/q") {
      const viaQr = url.pathname === "/q" || url.pathname.startsWith("/q/");
      ctx.waitUntil(countMetric(env, viaQr ? "scan" : "tap"));

      const identity = identifyTag(url);
      if (!identity.tagId) {
        // 見分けが付かなかった。**ここで400を返して終わりにしない。**
        // 目の前の人にとっては「かざしたのに何も起きない」で、こちらの設定漏れが
        // そのまま体験の失敗になる。端末ごとに1体を割り当てる受け皿へ送る。
        if (identity.suspectedFiller) {
          // ミラーの設定漏れが疑われる。**全員が同じ分身を共有する事故の一歩手前**なので、
          // 切り分けられるようログに残す（本文は載せない）。
          console.warn(
            JSON.stringify({
              ...log,
              event: "yorishiro.uid_filler",
              note: "UIDミラーが効いていない可能性。タグの書き込み設定を確認すること",
            })
          );
        }
        const claim = new URL("/summon", url.origin);
        claim.searchParams.set("claim", viaQr ? "qr" : "tag");
        return new Response(null, {
          status: 302,
          headers: { location: claim.toString(), "set-cookie": claimCookie(viaQr ? "qr" : "tag") },
        });
      }
      const tagId = identity.tagId;

      const row = await env.DB.prepare(
        "SELECT character_id FROM nfc_tags WHERE tag_id = ?"
      )
        .bind(tagId)
        .first<{ character_id: string }>();

      let characterId: string;
      let isFirstTime = false;
      let ownerToken: string | undefined;
      let spotCode: string | null = null;

      if (row) {
        characterId = row.character_id;
      } else {
        // 初回の読み取り: この依代に宿る分身を新規発行する。
        // **ここで一度だけ、機械的な連番打ち（/t/1, /t/2, ...）を疑う。**
        // 台帳に無いコードでも新しい依代として受け付ける都合上（後述）、
        // ここを素通りさせると依代を持たない人の上限が意味を成さなくなる。
        // 詳しい理由は src/yorishiro.ts の TAG_CLAIM_DAILY_LIMIT を参照。
        if (!(await canClaimNewTag(env, request))) {
          return Response.redirect(new URL("/add?closed=1&reason=busy", url.origin).toString(), 302);
        }
        // 姿を引くのはDO側（init）。ここで渡せるのは**引く範囲**だけで、
        // どの子が出るかは指定できない（migration 0011 と BirthPool のコメントを参照）。
        characterId = crypto.randomUUID();
        isFirstTime = true;
        await env.DB.prepare(
          "INSERT INTO nfc_tags (tag_id, character_id, created_at) VALUES (?, ?, ?)"
        )
          .bind(tagId, characterId, Date.now())
          .run();

        spotCode = await spotOfTag(env, tagId);
        // 場所限定の姿。配布元が範囲を絞っているときだけ効く（ほとんどの依代は素通り）。
        // 止まっている配布元（active=false）の範囲は使わない——止めたつもりの企画が
        // 配り残しのコードから生き続けるのは、運営として困る。
        const spotForBirth = spotCode ? await getSpot(env, spotCode) : null;
        const pool =
          spotForBirth && spotForBirth.active && isLimitedSpot(spotForBirth)
            ? { species: spotForBirth.speciesPool, color: spotForBirth.colorPool }
            : undefined;

        const stub = env.CHARACTER.getByName(characterId);
        const initData = await stub.init("名もなきキャラクター", pool);
        ownerToken = initData.ownerToken;
        ctx.waitUntil(countMetric(env, "new_character"));
        ctx.waitUntil(recordOrigin(env, characterId, viaQr ? "qr" : "nfc", tagId, spotCode));
      }

      const redirectUrl = new URL("/summon", url.origin);
      redirectUrl.searchParams.set("cid", characterId);
      if (isFirstTime) {
        redirectUrl.searchParams.set("first", "1");
        // 「持ち主トークン」は誕生の瞬間だけURLに乗せてクライアントへ渡す。
        // summon.html側ですぐlocalStorageへ保存し、URLからは消す想定（人格エクスポート仕様書5章参照）。
        if (ownerToken) redirectUrl.searchParams.set("token", ownerToken);
        // どこで手に入れた子なのかを、出会いの場面で一度だけ見せる。
        if (spotCode) redirectUrl.searchParams.set("spot", spotCode);
      }

      // **依代を読んだ端末には、毎回この印を付ける。**
      // 「この人は現物を持っている」の判定に使う（src/entryPolicy.ts）。
      // 初回だけにすると、2枚目を買った人や、翌日に思い立って
      // /add を開いた人が「依代を持っていない人」に見えてしまう。
      return new Response(null, {
        status: 302,
        headers: {
          location: redirectUrl.toString(),
          "set-cookie": claimCookie(viaQr ? "qr" : "tag"),
        },
      });
    }

    // --- チャットAPI ---
    if (url.pathname === "/api/chat" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; message?: string }>();
      if (!body.characterId || !body.message) {
        return json({ error: "characterId and message are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      ctx.waitUntil(countMetric(env, "chat"));
      const result = await stub.chat(body.message);
      return json(result);
    }

    // --- キャラクター状態取得API ---
    if (url.pathname === "/api/character" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const state = await stub.getState();
      if (!state) return json({ error: "not found" }, { status: 404 });
      // このAPIは cid さえ知っていれば誰でも叩ける。cid はチャットページのURLに乗って
      // 共有されうるので、ここから出てよいのは「見た目と育ち具合」までに限る。
      //
      // **返す項目を並べる方式（許可制）にしてあることが重要。**
      // 以前は「危ないものを除く」除外方式だったが、CharacterData に項目を足すたびに
      // 除外を書き足す必要があり、実際に属性・同意状態・入力設定が漏れる状態になっていた
      // （E2Eの「属性は公開APIから読めない」で気づいた）。許可制なら、新しい項目は既定で外に出ない。
      //
      // ここに項目を足すときは「cidを知っているだけの他人に見えてよいか」だけで判断すること。
      // 会話の本文・記憶・覚え書き・属性・価値観・同意状態・入力設定・持ち主トークンは、いずれも該当しない。
      return json({
        name: state.name,
        species: state.species,
        color: state.color,
        personality: state.personality,
        growthStage: state.growthStage,
        // 「次の段階まであと何回か」。段階名だけだと、この先まだ育つのか打ち止めなのかが
        // 分からず、育てる手が止まる（src/ai/growth.ts）。
        growth: growthProgress(state.interactionCount),
        interactionCount: state.interactionCount,
        lastVisit: state.lastVisit,
        createdAt: state.createdAt,
        personalityHistory: state.personalityHistory,
        socialOptIn: state.socialOptIn ?? false,
        // 分身同士の立ち話の記録。オプトインした人だけが持ち、ユーザー本人との会話は含まれない
        // （src/ai/promptBuilder.ts の buildMeetingPrompt を参照）。
        lastMeeting: state.lastMeeting,
        lastMeetingAt: state.lastMeetingAt,
        // 相手の仮の印（partnerKey）は、この子ごとに別の値へ変えて渡す（同じ相手の記録をまとめるためだけ。
        // 別の子の記録と突き合わせて、同じ相手を追えないように）
        meetingHistory: await viewMeetingHistory(state.meetingHistory, characterId),
        speechStyleLabel: deriveSpeechStyle(state.personality).label,
        // 読み上げに使う「この子の声」。保存はせず、characterIdと性格から毎回導出する。
        voice: deriveVoiceProfile(characterId, state.personality, state.species, state.color),
      });
    }

    // --- 性格変遷（成長グラフ）取得API ---
    if (url.pathname === "/api/character/history" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const history = await stub.getHistory();
      if (!history) return json({ error: "not found" }, { status: 404 });
      return json(history);
    }

    // --- 「他の分身と出会う」機能へのオプトイン/オプトアウトAPI ---
    // 公開ディレクトリへの掲載可否に関わるため、持ち主トークンによる保護対象。
    if (url.pathname === "/api/character/social" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; optIn?: boolean; token?: string }>();
      if (!body.characterId || typeof body.optIn !== "boolean") {
        return json({ error: "characterId and optIn are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.setSocialOptIn(body.optIn, body.token);
      if ("error" in result) return json(result, { status: 403 });
      return json(result);
    }

    // --- 「お散歩」機能: 性格の近い、他ユーザーの分身とのAI同士の短い交流を生成する ---
    // 安全上の配慮: 人間同士のメッセージ交換は一切行わない。オプトイン制。
    // 相手に渡るのは名前・種族・成長段階のみで、ユーザー本人との会話内容・記憶は渡さない。
    // 実処理は runMeeting() に切り出してあり、手動実行（このAPI）と自動実行（scheduled）の両方から呼ばれる。
    if (url.pathname === "/api/character/meet" && request.method === "POST") {
      const body = await request.json<{ characterId?: string }>();
      if (!body.characterId) {
        return json({ error: "characterId is required" }, { status: 400 });
      }
      const result = await runMeeting(env, body.characterId);
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      return json({ partner: result.partner, log: result.log });
    }

    // --- 人格パッケージのエクスポート（ダウンロード） ---
    // 育った性格・記憶を、モデル/実行環境に依存しない形の1ファイルとして書き出す。
    // フィジカルAI移植・バックアップ・他プラットフォームへの持ち出しの共通の出発点になるAPI。
    // 記憶の持ち出しという性質上、持ち主トークンによる保護対象。
    if (url.pathname === "/api/character/export" && request.method === "GET") {
      const characterId = url.searchParams.get("cid");
      const token = url.searchParams.get("token") || undefined;
      if (!characterId) {
        return json({ error: "cid is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(characterId);
      const result = await stub.exportPackage(token);
      if (!result.ok) return json({ error: result.error }, { status: result.error === "not found" ? 404 : 403 });
      const pkg = result.package;
      const fileName = `waketama_${pkg.character.name || characterId}.json`.replace(/[^\w.\-ぁ-んァ-ヶー一-龠]/g, "_");
      return new Response(JSON.stringify(pkg, null, 2), {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
        },
      });
    }

    // --- 人格パッケージのインポート（復元） ---
    // 指定したcharacterId（＝復元先のDOインスタンス）の現在のデータを上書きする破壊的操作。
    // 「他の分身と出会う」機能へのオプトイン状態は引き継がない（復元後は必ずオフから）。
    // 上書き操作のため、既にデータがある場合は持ち主トークンによる保護対象。
    if (url.pathname === "/api/character/import" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; package?: PersonalityPackageV1; token?: string }>();
      if (!body.characterId || !body.package) {
        return json({ error: "characterId and package are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.importPackage(body.package, body.token);
      if (!result.ok) {
        const status = result.error === "この操作は分身の持ち主だけが行えます" ? 403 : 400;
        return json({ error: result.error }, { status });
      }
      return json(result);
    }

    // --- キャラクター名前設定API（初回サモン時に使う想定） ---
    if (url.pathname === "/api/character/rename" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; name?: string; token?: string }>();
      if (!body.characterId || !body.name) {
        return json({ error: "characterId and name are required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const state = await stub.rename(body.name, body.token);
      if ("error" in state) return json(state, { status: 403 });
      return json(state);
    }

    // --- 引き継ぎコードの発行（持ち主のみ） ---
    // 機種変更やブラウザのデータ削除で所有権を失うのを救うための仕組み。詳細は src/transfer.ts。
    if (url.pathname === "/api/character/transfer/issue" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; token?: string }>();
      if (!body.characterId) {
        return json({ error: "characterId is required" }, { status: 400 });
      }
      const result = await issueTransferCode(env, body.characterId, body.token, {
        ...log,
        characterId: body.characterId,
      });
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      return json({ code: result.code, expiresAt: result.expiresAt });
    }

    // --- 引き継ぎコードの使用（新しい端末側） ---
    if (url.pathname === "/api/character/transfer/claim" && request.method === "POST") {
      const body = await request.json<{ code?: string }>();
      const result = await claimTransferCode(env, body.code || "", log);
      if (!result.ok) return json({ error: result.error }, { status: result.status });
      return json({ characterId: result.characterId, ownerToken: result.ownerToken, name: result.name });
    }

    // --- 分身の削除API（「アカウント不要」設計における、持ち主自身によるデータ削除手段） ---
    // 破壊的操作のため持ち主トークンによる保護対象。成功時、このタグから新しい分身を始め直せるように
    // nfc_tagsの対応も併せて削除する（同じ物理カードを再利用・譲渡できるようにするため）。
    if (url.pathname === "/api/character/delete" && request.method === "POST") {
      const body = await request.json<{ characterId?: string; token?: string }>();
      if (!body.characterId) {
        return json({ error: "characterId is required" }, { status: 400 });
      }
      const stub = env.CHARACTER.getByName(body.characterId);
      const result = await stub.deleteData(body.token);
      if (!result.ok) return json(result, { status: 403 });
      try {
        await env.DB.prepare("DELETE FROM nfc_tags WHERE character_id = ?").bind(body.characterId).run();
        // どの入口から来たかの記録も消す。分身が消えたのに来歴だけ残るのは筋が通らない。
        await env.DB.prepare("DELETE FROM character_origin WHERE character_id = ?").bind(body.characterId).run();
      } catch (err) {
        // 紐付けの削除に失敗しても致命的ではない（分身本体のデータは既に削除済み）
      }
      return json({ ok: true });
    }

    // --- それ以外は静的ファイル（public/ 配下）を配信 ---
    return serveAsset(request, url, env, hostEnv);
  },

  /**
   * 留守番エージェント（自動お散歩）: Cronトリガーから定期的に呼ばれる。
   * オプトイン済み・クールダウン明けのキャラクターを一定件数だけ選び、
   * ユーザーの操作なしに「お散歩」を自動実行しておく。
   * ユーザーが次にチャットを開いたときに「今日の出会い」として結果を見られるようにするのが狙い
   * （サービスコンセプトの「自分の代わりに動いてくれる分身」を体現する機能）。
   *
   * AIコスト・D1負荷を抑えるため、1回の実行で処理する件数には上限を設けている。
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // 回数制限の記録は数日で用済みになる。放っておくと増え続けるので、ここで掃除する
    // （塩も一緒に消えるため、過去の送信元をあとから割り出すことはできなくなる）。
    ctx.waitUntil(purgeOldIpQuota(env).catch(() => {}));
    // 申込ページから入れて、どこにも使われなかった画像（30日）
    ctx.waitUntil(purgeUnusedImages(env).catch(() => 0));

    const BATCH_LIMIT = 50;
    const rows = await env.DB.prepare(
      `SELECT character_id FROM character_directory ORDER BY updated_at ASC LIMIT ?1`
    )
      .bind(BATCH_LIMIT)
      .all<{ character_id: string }>();

    const candidateIds = (rows.results ?? []).map((r) => r.character_id);

    for (const characterId of candidateIds) {
      // 1件ずつ順に処理する（Durable Object/AI呼び出しの同時実行数を抑えるため）。
      // 個々の失敗（オプトイン済みだがクールダウン中、相手なし等）は他の処理を止めない。
      ctx.waitUntil(
        runMeeting(env, characterId).catch(() => {
          /* 自動実行なのでエラーは静かに無視する（次回のCronでまた試される） */
        })
      );
    }
  },
} satisfies ExportedHandler<Env>;

/**
 * 静的ファイルの配信。HTMLだけは、OGP用のURLをその場で絶対URLに書き換えてから返す。
 *
 * なぜサーバー側で書き換えるのか:
 * OGPのog:image / og:urlは、SNSのクローラーがJavaScriptを実行せずに読むため相対パスでは正しく解決されず、
 * かといってHTMLに絶対URLを直書きすると、配信ドメイン（*.workers.dev / 独自ドメイン / プレビュー環境）が
 * 変わるたびにカード画像が壊れる。リクエストのオリジンを見てここで補完すれば、どのドメインで配信しても
 * 常に正しい絶対URLになり、HTML側はドメインを知らなくて済む。
 */
async function serveAsset(request: Request, url: URL, env: Env, hostEnv: Env = env): Promise<Response> {
  // **条件付きリクエスト（If-None-Match など）をアセット層へ渡さない。**
  // HTMLには毎回ちがう nonce を振っているので、304 で返すとブラウザは
  // 「手元のキャッシュの本文（古い nonce）」に「新しいヘッダ（新しい nonce）」を重ねてしまい、
  // **2回目以降の訪問で、そのページのスクリプトが全部拒否される**（2026-09-23、実ブラウザで確認）。
  // ここを通るのは run_worker_first のページと sw.js・robots.txt・sitemap.xml だけなので、
  // 304 を諦めても転送量はほとんど増えない。
  const unconditional = new Headers(request.headers);
  unconditional.delete("if-none-match");
  unconditional.delete("if-modified-since");
  let assetResponse = await env.ASSETS.fetch(new Request(request, { headers: unconditional }));

  // 存在しないパスには案内のあるページを返す。
  //
  // アセット層の not_found_handling = "404-page" には**しない**こと。
  // あれを有効にすると、アセットに無いパスをアセット層がその場で404にしてしまい、
  // リクエストがWorkerまで届かなくなる（/api/* が丸ごと動かなくなる）。
  // 案内は、こうしてWorker側から読みに行くほうが安全。
  if (assetResponse.status === 404 && request.method === "GET") {
    const fallback = await env.ASSETS.fetch(new Request(new URL("/404.html", url.origin), { method: "GET" }));
    if (fallback.ok) {
      assetResponse = new Response(fallback.body, {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      });
    }
  }

  const contentType = assetResponse.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return assetResponse;

  // 版数ヘッダを載せる。実機で「いま掴んでいるのはどの版か」を確認するための手がかり。
  // 検証環境なら、あわせて検索避け（noindex）も付ける。
  const withVersion = applyAdminHeaders(applyStagingHeaders(new Response(assetResponse.body, assetResponse), env), url);
  for (const [key, value] of Object.entries(versionHeaders(env))) {
    withVersion.headers.set(key, value);
  }
  const nonce = randomNonce();
  for (const [key, value] of Object.entries(securityHeaders(nonce))) {
    withVersion.headers.set(key, value);
  }
  // 検証子（ETag / Last-Modified）を付けたままにすると、次の訪問でブラウザが条件付きで聞きに来る。
  // 本文は nonce を振った時点でアセットとは別物なので、検証子ごと外し、毎回取り直してもらう。
  withVersion.headers.delete("etag");
  withVersion.headers.delete("last-modified");
  // 管理画面や404で付けた no-store は、より強い指定なのでそのまま残す
  if (!/no-store/i.test(withVersion.headers.get("cache-control") || "")) {
    withVersion.headers.set("cache-control", "no-cache");
  }

  const origin = url.origin;
  const toAbsolute = (value: string | null): string | null => {
    if (!value) return null;
    if (/^https?:\/\//i.test(value)) return null; // すでに絶対URLなら触らない
    return origin + (value.startsWith("/") ? value : `/${value}`);
  };

  // 正規URL。app と apex の両方から同じページが引けるため、
  // これが無いと検索エンジンに重複ページとして扱われる。
  // HTMLに直書きしないのは、OGPと同じ理由（配信ドメインが変わると壊れるため）。
  const canonical = canonicalFor(url, hostEnv);
  let canonicalSeen = false;

  // 紹介ドメイン（apex）ではPWAとして入れさせない。
  // 入れられると、起動のたびに本体ドメインへ転送される「入れても意味のないアプリ」ができ、
  // しかもホーム画面には本物と同じアイコンが並ぶ。どちらが本物か本人にも分からなくなる。
  const stripManifest = isMarketingHost(url, hostEnv);

  return new HTMLRewriter()
    // CSPのnonce方式。すべての<script>タグ（インラインも、外部読み込みも）に
    // レスポンスヘッダと同じ使い捨てトークンを振る。付け忘れが1つでもあると
    // そのスクリプトだけ動かなくなる（フェイルセーフ側に倒れる。動いてしまうより安全）。
    .on("script", {
      element(element) {
        element.setAttribute("nonce", nonce);
      },
    })
    .on('link[rel="manifest"]', {
      element(element) {
        if (stripManifest) element.remove();
      },
    })
    .on("head", {
      element(element) {
        element.onEndTag((end) => {
          if (!canonicalSeen) end.before(`<link rel="canonical" href="${canonical}">`, { html: true });
        });
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        // 既に書かれている場合は上書きする（古い絶対URLが残っているより確実）
        canonicalSeen = true;
        element.setAttribute("href", canonical);
      },
    })
    .on('meta[property="og:image"], meta[name="twitter:image"]', {
      element(element) {
        const absolute = toAbsolute(element.getAttribute("content"));
        if (absolute) element.setAttribute("content", absolute);
      },
    })
    .on('meta[property="og:url"]', {
      element(element) {
        // 共有されるのは「今開いているページ」。クエリ文字列（cid等）は共有カードに載せない。
        // 転送先が決まっているページは転送後のURLを載せる（踏んだ人が無駄に1回転送されないように）。
        element.setAttribute("content", canonical);
      },
    })
    .transform(withVersion);
}

export type MeetingResult =
  | { ok: true; partner: { name: string; species: SpeciesKey; color: ColorKey }; log: MeetingLogEntry[] }
  | { ok: false; error: string; status: number };

/**
 * 「お散歩」の実処理本体。手動API（/api/character/meet）と自動実行（scheduled）の両方から呼ばれる共通関数。
 * オプトイン確認・クールダウン確認・相手探し・AI同士の立ち話生成・双方への記録保存までをここで行う。
 */
export async function runMeeting(env: Env, characterId: string): Promise<MeetingResult> {
  const selfStub = env.CHARACTER.getByName(characterId);
  const selfState = await selfStub.getState();
  if (!selfState) return { ok: false, error: "not found", status: 404 };
  if (!selfState.socialOptIn) {
    return { ok: false, error: "「他の分身と出会う」がオフになっています。まずオンにしてください", status: 400 };
  }
  const now = Date.now();
  if (selfState.lastMeetingAt && now - selfState.lastMeetingAt < MEETING_COOLDOWN_MS) {
    const remainingHours = Math.ceil((MEETING_COOLDOWN_MS - (now - selfState.lastMeetingAt)) / (60 * 60 * 1000));
    return { ok: false, error: `また今度お散歩に行こうね（あと${remainingHours}時間くらい待ってね）`, status: 429 };
  }

  const candidates = await env.DB.prepare(
    `SELECT character_id, name, species, color, warmth, curiosity, cheerfulness, caution, independence, humor
     FROM character_directory WHERE character_id != ?1 ORDER BY RANDOM() LIMIT 30`
  )
    .bind(characterId)
    .all<{
      character_id: string;
      name: string;
      species: SpeciesKey;
      color: ColorKey;
      warmth: number;
      curiosity: number;
      cheerfulness: number;
      caution: number;
      independence: number;
      humor: number;
    }>();

  const rows = candidates.results ?? [];
  if (rows.length === 0) {
    return { ok: false, error: "まだお散歩できる相手がいないみたい。また今度試してね", status: 404 };
  }

  const partnerRow = pickMostSimilar(selfState.personality, rows);
  const partnerId = partnerRow.character_id;
  const partnerStub = env.CHARACTER.getByName(partnerId);

  const selfSpeciesLabel = SPECIES_LABELS[selfState.species];
  const partnerSpeciesLabel = SPECIES_LABELS[partnerRow.species];

  // 3ターンのその場限りの立ち話を生成する（AI呼び出しはこの3回のみ。クールダウンで頻度も抑えている）
  const lineA1 = await selfStub.speakInMeeting(partnerRow.name, partnerSpeciesLabel);
  const lineB1 = await partnerStub.speakInMeeting(selfState.name, selfSpeciesLabel, lineA1);
  const lineA2 = await selfStub.speakInMeeting(partnerRow.name, partnerSpeciesLabel, lineB1);

  const selfLog: MeetingLogEntry[] = [
    { role: "self", text: lineA1 },
    { role: "other", text: lineB1 },
    { role: "self", text: lineA2 },
  ];
  const partnerLog: MeetingLogEntry[] = [
    { role: "other", text: lineA1 },
    { role: "self", text: lineB1 },
    { role: "other", text: lineA2 },
  ];

  // メタバースで会ったときと同じ「相手の仮の印」を付けて、どちらで会っても「また会えた」と数える
  await selfStub.recordMeeting(selfLog, { name: partnerRow.name, species: partnerRow.species, color: partnerRow.color }, await partnerKeyOf(partnerId));
  await partnerStub.recordMeeting(partnerLog, { name: selfState.name, species: selfState.species, color: selfState.color }, await partnerKeyOf(characterId));

  return {
    ok: true,
    partner: { name: partnerRow.name, species: partnerRow.species, color: partnerRow.color },
    log: selfLog,
  };
}

/** 性格パラメータ（6軸）のユークリッド距離が最も近い候補を選ぶ（＝いちばん性格が近い分身とマッチングする）。 */
export function pickMostSimilar<T extends Pick<PersonalityTraits, (typeof TRAIT_KEYS)[number]>>(
  self: PersonalityTraits,
  candidates: T[]
): T {
  let best = candidates[0];
  let bestDist = Infinity;
  for (const candidate of candidates) {
    let distSq = 0;
    for (const key of TRAIT_KEYS) {
      const diff = self[key] - candidate[key];
      distSq += diff * diff;
    }
    if (distSq < bestDist) {
      bestDist = distSq;
      best = candidate;
    }
  }
  return best;
}


/**
 * いま部屋にいる人へ、新しい設定（または「移った」「閉じた」）を配る。
 * まとめた元のエリアにいる人には、まとめた先を知らせる。
 */
async function pushAreaToRoom(env: Env, room: RoomConfig): Promise<void> {
  const state = areaState(room);
  const view = await roomView(env, room);
  await env.META_ROOM.getByName(room.id)
    .pushConfig(view, state, room.mergedInto)
    .catch(() => undefined);
}

/**
 * 管理画面のメタバース（adminGate を通過したリクエストだけがここに来る）。
 *
 *   GET    /api/admin/meta/rooms         すべてのエリア（状態つき）と選択肢の定義、ミニゲームの設定
 *   POST   /api/admin/meta/rooms         作る・直す（最初からあるエリアも上書きできる）
 *   DELETE /api/admin/meta/rooms         消す（最初からあるエリアは元に戻る）
 *   POST   /api/admin/meta/merge         エリアをまとめる
 *   GET    /api/admin/meta/games         ミニゲームの設定（止める・既定値）と、どのエリアで使っているか
 *   POST   /api/admin/meta/games         ミニゲームの設定を保存
 *   POST   /api/admin/meta/games/test    試し場にそのミニゲームだけを置く（管理者だけが入れる）
 */
async function handleMetaverseAdmin(request: Request, url: URL, env: Env): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/admin/meta/rooms" && request.method === "GET") {
    const [rooms, settings, shops] = await Promise.all([listAdminRooms(env), getGameSettings(env), listShops(env)]);
    return json({ rooms, settings, catalog: metaverseCatalog(), shops: shops.map((s) => ({ id: s.id, label: s.name, active: s.active })), now: Date.now() });
  }
  if (p === "/api/admin/meta/rooms" && request.method === "POST") {
    const result = await saveRoom(env, await request.json<Record<string, unknown>>());
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    await pushAreaToRoom(env, result.room);
    return json({ room: result.room, state: areaState(result.room) });
  }
  if (p === "/api/admin/meta/rooms" && request.method === "DELETE") {
    const body = await request.json<{ id?: string }>();
    const result = await deleteRoom(env, body.id);
    if (result.ok && typeof body.id === "string") {
      const now = await getRoom(env, body.id);
      if (now) await pushAreaToRoom(env, now);
      else await env.META_ROOM.getByName(body.id).pushConfig(null, "closed", null).catch(() => undefined);
    }
    return json(result);
  }
  if (p === "/api/admin/meta/merge" && request.method === "POST") {
    const result = await mergeRooms(env, await request.json<Record<string, unknown>>());
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    await pushAreaToRoom(env, result.room);
    for (const id of result.merged) {
      const r = await getRoom(env, id);
      if (r) await pushAreaToRoom(env, r);
    }
    return json(result);
  }
  if (p === "/api/admin/meta/games" && request.method === "GET") {
    const [rooms, settings] = await Promise.all([listAdminRooms(env), getGameSettings(env)]);
    const usedIn: Record<string, Array<{ id: string; name: string; state: string }>> = {};
    for (const r of rooms) {
      for (const o of r.objects) {
        (usedIn[o.type] ??= []).push({ id: r.id, name: r.name, state: r.state });
      }
    }
    return json({ settings, usedIn, catalog: metaverseCatalog() });
  }
  if (p === "/api/admin/meta/games" && request.method === "POST") {
    const settings = await saveGameSettings(env, await request.json<Record<string, unknown>>());
    // 止めた・戻したミニゲームを、いま開いているエリアにも反映する
    for (const r of await listAdminRooms(env)) {
      if (r.state === "open") await pushAreaToRoom(env, r);
    }
    return json({ settings });
  }
  if (p === "/api/admin/meta/games/test" && request.method === "POST") {
    const body = await request.json<{ type?: string }>();
    const result = await upsertTestArea(env, body.type);
    if (!result.ok) return json({ error: result.error }, { status: 400 });
    const room = await getRoom(env, result.id);
    if (room) await pushAreaToRoom(env, room);
    return json({ id: result.id, url: `/meta?room=${result.id}` });
  }
  return null;
}

/** 状態ごとの、入れないときの説明 */
const AREA_CLOSED_TEXT: Record<string, string> = {
  soon: "このエリアはまだ開いていません。開放までお待ちください",
  draft: "このエリアは準備中です",
  closed: "このエリアは閉じました",
};

/**
 * メタバースのAPI。
 *
 *   GET  /api/meta/rooms              ロビーの一覧（公開中＋近日開放）と、選択肢の定義
 *   GET  /api/meta/rooms/:id          1エリアの設定（まとめたエリアなら、まとめた先を返す）
 *   GET  /api/meta/rooms/:id/ws       入室（WebSocket）。公開中のエリアだけ（準備中は管理者だけ）
 * エリアを作る・直すのは管理画面だけ（/api/admin/meta/*）。
 */
async function handleMetaverseApi(request: Request, url: URL, env: Env): Promise<Response | null> {
  if (url.pathname === "/api/meta/rooms" && request.method === "GET") {
    return json({ rooms: await listRooms(env), catalog: metaverseCatalog(), now: Date.now() }, { headers: { "cache-control": "no-store" } });
  }

  const m = /^\/api\/meta\/rooms\/([a-z0-9-]{3,32})(\/ws)?$/.exec(url.pathname);
  if (!m) return null;
  const id = m[1];

  if (m[2]) {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "WebSocketで接続してください" }, { status: 426 });
    }
    // 他所のサイトから、閲覧者のブラウザを使って勝手に入室させない（Cross-Site WebSocket Hijacking）。
    // Origin はブラウザが必ず付ける。付いていて、しかも自分のドメインでないものだけを断る。
    const origin = request.headers.get("origin");
    if (origin) {
      let sameSite = false;
      try {
        const o = new URL(origin);
        sameSite = o.host === url.host;
      } catch {
        sameSite = false;
      }
      if (!sameSite) return json({ error: "この接続は受け付けられません" }, { status: 403 });
    }
    const room = await getRoom(env, id);
    if (!room) return json({ error: "そのエリアはありません" }, { status: 404 });
    const state = areaState(room);
    if (state === "moved") {
      const resolved = await resolveRoom(env, id);
      return json({ error: "このエリアは別のエリアにまとまりました", code: "moved", movedTo: resolved?.room.id ?? null }, { status: 409 });
    }
    if (state !== "open" && !(state === "draft" && isAdminRequest(request, env))) {
      return json({ error: AREA_CLOSED_TEXT[state] ?? "このエリアには入れません", code: state }, { status: 409 });
    }
    // 部屋の設定は、ヘッダに載せず RPC で先に渡す（クイズの問題などで大きくなるとヘッダに収まらない）
    const stub = env.META_ROOM.getByName(id);
    await stub.setConfig(await roomView(env, room));
    return stub.fetch(request);
  }

  if (request.method === "GET") {
    const resolved = await resolveRoom(env, id);
    if (!resolved) return json({ error: "そのエリアはありません" }, { status: 404 });
    const state = areaState(resolved.room);
    const canEnter = state === "open" || (state === "draft" && isAdminRequest(request, env));
    const view = await roomView(env, resolved.room);
    // NPC の分身の識別子は、画面へは渡さない（部屋の中だけで使う）
    view.npcs = (view.npcs ?? []).map(({ cid: _cid, ...rest }) => rest) as unknown as RoomConfig["npcs"];
    return json(
      {
        room: view,
        state,
        canEnter,
        movedFrom: resolved.movedFrom,
        message: canEnter ? null : AREA_CLOSED_TEXT[state] ?? null,
        catalog: metaverseCatalog(),
        now: Date.now(),
      },
      { headers: { "cache-control": "no-store" } }
    );
  }
  return null;
}


/** エリアIDから部屋へ配り直す（NPC・設置物を変えたとき） */
async function pushAreaById(env: Env, areaId: string | null | undefined): Promise<void> {
  if (!areaId) return;
  const room = await getRoom(env, areaId);
  if (room) await pushAreaToRoom(env, room);
}

/**
 * 管理画面の、運営の分身・NPC・区画（広告・ランドマーク）・招待と申し込み（adminGate を通過したリクエストだけ）。
 *
 *   /api/admin/characters        GET 一覧 / POST 作る（上限なし）/ DELETE 消す
 *   /api/admin/npcs              GET 一覧と選択肢 / POST 置く・直す / DELETE 外す
 *   /api/admin/npcs/refresh      POST 姿と動きの数値を取り直す（育てた結果を反映）
 *   /api/admin/land/settings     GET / POST 受付・販売中の表示・支払いの案内
 *   /api/admin/land/plots        GET ?area= / POST 区画ごとの販売設定
 *   /api/admin/land/placements   GET / POST 運営が置く・直す / DELETE
 *   /api/admin/land/placements/end POST いますぐ終える
 *   /api/admin/land/orders       GET 申込一覧 / POST 操作（承認・支払い済み・見送り・取り消し・メモ）
 *   /api/admin/land/ads          GET 広告・クーポンの一覧（直近30日の回数つき）
 *   /api/admin/invites           GET / POST 招待リンク（新しい分身・運営の分身の引き渡し）
 *   /api/admin/invites/active    POST 止める・戻す
 *   /api/admin/applications      GET / POST 承認・見送り
 *   /api/admin/applications/settings GET / POST
 *   /api/admin/badges            GET 確認待ちの数（タブの印）
 */
async function handleAdminExtra(request: Request, url: URL, env: Env): Promise<Response | null> {
  const p = url.pathname;
  const m = request.method;
  const body = async () => (await request.json().catch(() => ({}))) as Record<string, unknown>;

  if (p === "/api/admin/badges" && m === "GET") {
    return json({ pendingOrders: await pendingOrderCount(env), pendingApplications: await pendingApplicationCount(env) });
  }

  // ---- 運営の分身 ----
  if (p === "/api/admin/characters" && m === "GET") return json({ characters: await listAdminCharacters(env) });
  if (p === "/api/admin/characters" && m === "POST") {
    const result = await createAdminCharacters(env, await body());
    if (!result.ok) return json({ error: result.error }, { status: 400 });
    return json({ created: result.created });
  }
  if (p === "/api/admin/characters" && m === "DELETE") {
    const b = await body();
    const result = await deleteAdminCharacter(env, String(b.characterId || ""));
    for (const a of result.areas) await pushAreaById(env, a);
    return json(result, { status: result.ok ? 200 : 404 });
  }

  // ---- NPC ----
  if (p === "/api/admin/npcs" && m === "GET") {
    const [npcs, characters, rooms] = await Promise.all([listNpcs(env), listAdminCharacters(env), listAdminRooms(env)]);
    return json({
      npcs,
      characters: characters.map(({ ownerToken: _t, ...rest }) => rest),
      areas: rooms.map((r) => ({ id: r.id, name: r.name, state: r.state })),
      spots: NPC_SPOTS,
      greetings: metaverseCatalog().greetings,
    });
  }
  if (p === "/api/admin/npcs" && m === "POST") {
    const b = await body();
    const before = typeof b.id === "string" ? (await listNpcs(env)).find((n) => n.id === b.id)?.areaId : null;
    const result = await saveNpc(env, b);
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    await pushAreaById(env, result.npc.areaId);
    if (before && before !== result.npc.areaId) await pushAreaById(env, before);
    return json({ npc: result.npc });
  }
  if (p === "/api/admin/npcs" && m === "DELETE") {
    const area = await deleteNpc(env, (await body()).id);
    await pushAreaById(env, area);
    return json({ ok: !!area });
  }
  if (p === "/api/admin/npcs/refresh" && m === "POST") {
    const b = await body();
    const areaId = typeof b.areaId === "string" ? b.areaId : undefined;
    const n = await refreshNpcAvatars(env, areaId);
    for (const r of await listAdminRooms(env)) if (!areaId || r.id === areaId) await pushAreaToRoom(env, r);
    return json({ refreshed: n });
  }

  // ---- 区画・広告・ランドマーク ----
  if (p === "/api/admin/land/settings" && m === "GET") {
    return json({ settings: await getLandSettings(env), spots: LAND_SPOTS, models: LANDMARK_MODELS, colors: LANDMARK_COLORS, saleKinds: SALE_KINDS });
  }
  if (p === "/api/admin/land/settings" && m === "POST") {
    const settings = await saveLandSettings(env, await body());
    for (const r of await listAdminRooms(env)) if (r.state === "open") await pushAreaToRoom(env, r);
    return json({ settings });
  }
  if (p === "/api/admin/land/plots" && m === "GET") {
    const areaId = url.searchParams.get("area") || "";
    return json({ plots: await listPlots(env, areaId) });
  }
  if (p === "/api/admin/land/plots" && m === "POST") {
    const b = await body();
    const areaId = String(b.areaId || "");
    const result = await savePlots(env, areaId, b.plots);
    if (!result.ok) return json({ error: result.error }, { status: 400 });
    await pushAreaById(env, areaId);
    return json({ plots: await listPlots(env, areaId) });
  }
  if (p === "/api/admin/land/placements" && m === "GET") {
    return json({ placements: await listPlacements(env, { areaId: url.searchParams.get("area") || undefined }) });
  }
  if (p === "/api/admin/land/placements" && m === "POST") {
    const result = await savePlacement(env, await body());
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    await pushAreaById(env, result.placement.areaId);
    return json({ placement: result.placement });
  }
  if (p === "/api/admin/land/placements" && m === "DELETE") {
    const area = await deletePlacement(env, (await body()).id);
    await pushAreaById(env, area);
    return json({ ok: !!area });
  }
  if (p === "/api/admin/land/placements/end" && m === "POST") {
    const area = await endPlacement(env, (await body()).id);
    await pushAreaById(env, area);
    return json({ ok: !!area });
  }
  if (p === "/api/admin/land/orders" && m === "GET") {
    return json({ orders: await listOrders(env, url.searchParams.get("status") || undefined) });
  }
  if (p === "/api/admin/land/orders" && m === "POST") {
    const result = await orderAction(env, await body());
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    await pushAreaById(env, result.areaId);
    return json(result);
  }
  if (p === "/api/admin/land/ads" && m === "GET") return json({ ads: await listAdsAndCoupons(env) });

  // ---- 招待リンク・Web申し込み ----
  if (p === "/api/admin/invites" && m === "GET") {
    const [invites, characters] = await Promise.all([listInvites(env), listAdminCharacters(env)]);
    return json({ invites, origin: url.origin, characters: characters.map(({ ownerToken: _t, ...rest }) => rest) });
  }
  if (p === "/api/admin/invites" && m === "POST") {
    const result = await createInvites(env, await body());
    if (!result.ok) return json({ error: result.error }, { status: 400 });
    return json({ invites: result.invites, origin: url.origin });
  }
  if (p === "/api/admin/invites/active" && m === "POST") {
    const b = await body();
    return json({ ok: await setInviteActive(env, b.code, b.active === true) });
  }
  if (p === "/api/admin/applications" && m === "GET") {
    return json({ applications: await listApplications(env), settings: await getApplicationSettings(env), origin: url.origin });
  }
  if (p === "/api/admin/applications" && m === "POST") {
    const result = await decideApplication(env, await body());
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    return json(result);
  }
  if (p === "/api/admin/applications/settings" && m === "POST") {
    return json({ settings: await saveApplicationSettings(env, await body()) });
  }
  return null;
}

/**
 * 誰でも使える口（区画の申込・広告の回数・Web申し込み）。
 *
 *   GET  /api/land/catalog         申込ページの一覧（売っている区画・価格・形と色）
 *   POST /api/land/orders          申し込む（連絡先つき。1回線1日5件まで）
 *   GET  /api/land/orders/:id      申込の状況（?key= が合うときだけ）
 *   POST /api/meta-ad-event        広告の詳細を開いた・リンクを開いた・クーポンを出した（回数だけ）
 *   GET  /api/apply/settings       Web申し込みを受け付けているか
 *   POST /api/apply                申し込む
 *   GET  /api/apply/:id            状況（?key=。承認されたら招待リンク）
 */
async function handlePublicLandAndEntry(request: Request, url: URL, env: Env, log: LogContext): Promise<Response | null> {
  const p = url.pathname;
  const noStore = { headers: { "cache-control": "no-store" } };
  if (p === "/api/land/catalog" && request.method === "GET") return json(await landCatalog(env), noStore);
  if (p === "/api/land/orders" && request.method === "POST") {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await createOrder(env, raw, request, log);
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    return json({ id: result.id, key: result.key, statusUrl: `/land?order=${result.id}&key=${result.key}` });
  }
  const om = /^\/api\/land\/orders\/([a-z0-9]{8,20})$/.exec(p);
  if (om && request.method === "GET") {
    const status = await orderStatus(env, om[1], url.searchParams.get("key"));
    if (!status) return json({ error: "申込が見つかりませんでした" }, { status: 404 });
    return json(status, noStore);
  }
  // 申込ページからの画像のアップロード（受付中のときだけ）
  if (p === "/api/land/image" && request.method === "POST") {
    if (!(await getLandSettings(env)).salesOpen) return json({ error: "いまは申し込みを受け付けていません" }, { status: 403 });
    const stored = await storeLandImage(env, request);
    if (!stored.ok) return json({ error: stored.error }, { status: stored.status });
    return json({ url: stored.url, bytes: stored.bytes });
  }
  if (p === "/api/meta-ad-event" && request.method === "POST") {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return json({ ok: await recordAdEvent(env, raw.key, raw.type) });
  }
  if (p === "/api/apply/settings" && request.method === "GET") {
    const s = await getApplicationSettings(env);
    return json({ open: s.open, autoApprove: s.autoApprove, note: s.note, inviteText: INVITE_FAIL_TEXT }, noStore);
  }
  if (p === "/api/apply" && request.method === "POST") {
    const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await createApplication(env, raw, request);
    if (!result.ok) return json({ error: result.error }, { status: result.status });
    return json({ id: result.id, key: result.key, approved: result.approved, statusUrl: `/apply?id=${result.id}&key=${result.key}` });
  }
  const am = /^\/api\/apply\/([a-z0-9]{8,20})$/.exec(p);
  if (am && request.method === "GET") {
    const status = await applicationStatus(env, am[1], url.searchParams.get("key"), url.origin);
    if (!status) return json({ error: "申し込みが見つかりませんでした" }, { status: 404 });
    return json(status, noStore);
  }
  return null;
}


/** 交流の記録を画面へ渡す形にする（相手の仮の印を、この子ごとの値に変える） */
async function viewMeetingHistory(history: MeetingRecord[] | undefined, characterId: string): Promise<MeetingRecord[]> {
  const list = Array.isArray(history) ? history : [];
  const out: MeetingRecord[] = [];
  for (const h of list) {
    if (!h.partnerKey) {
      out.push(h);
      continue;
    }
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${characterId}:${h.partnerKey}`));
    const key = [...new Uint8Array(d)].slice(0, 6).map((b) => b.toString(16).padStart(2, "0")).join("");
    out.push({ ...h, partnerKey: key });
  }
  return out;
}
