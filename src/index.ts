import { CharacterState, SPECIES_LABELS, MEETING_COOLDOWN_MS, MeetingLogEntry, SpeciesKey, ColorKey, PersonalityPackageV1 } from "./durable-objects/characterState";
import { deriveSpeechStyle } from "./ai/speechStyle";
import { PersonalityTraits, TRAIT_KEYS } from "./ai/personality";
import { handleCallStream } from "./call";
import { handleTalk } from "./talk";
import { deriveVoiceProfile } from "./ai/voiceProfile";
import { handleHealth } from "./health";
import { handleTranscribe, handleSpeak } from "./voice";
import { issueTransferCode, claimTransferCode } from "./transfer";
import { stagingGate, applyStagingHeaders } from "./stagingGuard";
import { adminGate, applyAdminHeaders, handleAdminOverview, handleAdminPersonas } from "./admin";
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
  createDirectCharacter,
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
import { handleMcp } from "./mcp";
import { LogContext, newRequestId } from "./lib/log";

export { CharacterState };

export interface Env {
  AI: Ai;
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  CHARACTER: DurableObjectNamespace<CharacterState>;
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
 * HTMLページに付ける保護のヘッダ。
 *
 * - frame-ancestors: 他所のサイトに埋め込ませない。管理画面や引き継ぎ画面を透明なiframeで重ねて
 *   踏ませる手口（クリックジャッキング）を塞ぐ。X-Frame-Options は古いブラウザ向けの保険。
 * - nosniff: content-typeを無視した解釈をさせない。
 * - Referrer-Policy: 他所へ遷移するときに、URLのクエリ（cid等）を送らない。
 * - Permissions-Policy: カメラ・マイクは自分のページでだけ使う（かざして話す・通話・視線入力で必要）。
 *   位置情報などは使っていないので明示的に閉じる。
 *
 * CSPはここでは付けていない。全ページがインラインスクリプトで書かれているため、
 * 中途半端に入れると 'unsafe-inline' を許すことになり、意味のある防御にならない。
 * 入れるなら nonce を配る作りに変えてからにする（ROADMAPの積み残し）。
 */
function securityHeaders(): Record<string, string> {
  return {
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=()",
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
    if (url.pathname === "/api/delivery" && request.method === "GET") {
      const scopeParam = url.searchParams.get("scope") || "card";
      const scope = (DELIVERY_SCOPES as string[]).includes(scopeParam) ? (scopeParam as DeliveryScope) : null;
      if (!scope) return json({ error: "scope は card / behavior / mcp / bundle のいずれかです" }, { status: 400 });

      const grant = await verifyGrant(env, url.searchParams.get("token"), scope);
      if (!grant.ok) return json({ error: grant.error }, { status: grant.status });

      const payload = await buildDelivery(env, grant.characterId, scope, url.searchParams.get("format") || "json");
      if (!payload) return json({ error: "取り出せませんでした" }, { status: 404 });

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
      if (!payload) return json({ error: "取り出せませんでした" }, { status: 404 });
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
      const from = url.searchParams.get("from");
      const kind = from === "tag" ? "nfc" : from === "qr" ? "qr" : "direct";
      const result = await createDirectCharacter(env, request, kind);
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
        return Response.redirect(claim.toString(), 302);
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

      return Response.redirect(redirectUrl.toString(), 302);
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
        meetingHistory: state.meetingHistory,
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
  let assetResponse = await env.ASSETS.fetch(request);

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
  for (const [key, value] of Object.entries(securityHeaders())) {
    withVersion.headers.set(key, value);
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

  await selfStub.recordMeeting(selfLog, { name: partnerRow.name, species: partnerRow.species, color: partnerRow.color });
  await partnerStub.recordMeeting(partnerLog, { name: selfState.name, species: selfState.species, color: selfState.color });

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
