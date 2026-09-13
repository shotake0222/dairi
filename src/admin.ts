/**
 * 管理画面（/admin）と、その裏側のAPI。
 *
 * 認証について:
 * このサービスにはアカウントの仕組みが無いので、管理画面だけのために作るのは筋が悪い。
 * ここでは合言葉（ADMIN_PASSCODE。wrangler secret で設定）で入口を閉じ、
 * 一度通ったらHttpOnlyのCookieで維持する方式にしている。ステージングの入口と同じ考え方。
 *
 * **合言葉が未設定なら、管理画面は開かない**。「設定していないから素通し」にすると、
 * 設定を忘れた瞬間に全データが公開されることになる。閉じている方を既定にする。
 *
 * 見せる情報について:
 * 管理者であっても、**会話の本文・記憶・覚え書きは見えない**。
 * ここに出るのは集計用レジストリ（同意した分身のみ）と、日次のカウンタだけ。
 * 運営が全員の会話を読める状態にしておくと、プライバシーポリシーで説明した内容と食い違う。
 */

import { SEGMENTS, segmentById } from "./analysis/segments";
import { VALUE_AXES, VALUE_LABELS } from "./analysis/psychographics";
import { todayKey } from "./persona/registry";
import { LogContext, logInfo, logWarn } from "./lib/log";

export interface AdminEnv {
  DB: D1Database;
  ADMIN_PASSCODE?: string;
  APP_VERSION?: string;
  ENVIRONMENT?: string;
}

const COOKIE_NAME = "waketama_admin";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 長さの違いでも早期に抜けないよう、固定回数で比較する。 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/") || pathname.startsWith("/api/admin/");
}

/**
 * 管理画面の入口。通してよければ null、止めるなら Response を返す。
 * `?key=合言葉` で入ると、以後はCookieで維持される。
 */
export function adminGate(request: Request, url: URL, env: AdminEnv): Response | null {
  if (!isAdminPath(url.pathname)) return null;

  const passcode = env.ADMIN_PASSCODE;
  if (!passcode) {
    // 未設定のときに素通しにしない。設定漏れが即座に情報公開になるため。
    return new Response(
      [
        "管理画面は無効です（ADMIN_PASSCODE が未設定）。",
        "",
        "有効にするには、次を実行してください:",
        "  npx wrangler secret put ADMIN_PASSCODE",
        "",
        "※ この引数は「シークレットの名前」です。合言葉そのものではありません。",
        "   実行するとプロンプトが出るので、そこに合言葉を入力してください。",
        "   合言葉を引数に書くと、その文字列の名前でシークレットが作られ、ここは無効のままになります。",
        "",
        "設定できたか確認: /api/health の admin フィールドを見てください。",
        "開くとき: /admin?key=合言葉",
        "",
      ].join("\n"),
      { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } }
    );
  }

  const provided = url.searchParams.get("key");
  if (provided && safeEqual(provided, passcode)) {
    // 合言葉をURLに残したままにしない。Cookieへ移して、キー無しのURLへ送り直す。
    const clean = new URL(url.toString());
    clean.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        location: clean.pathname + (clean.search || ""),
        "set-cookie": `${COOKIE_NAME}=${encodeURIComponent(passcode)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
      },
    });
  }

  const cookie = readCookie(request, COOKIE_NAME);
  if (cookie && safeEqual(decodeURIComponent(cookie), passcode)) return null;

  return new Response("管理画面です。URLの末尾に ?key=合言葉 を付けて開いてください。\n", {
    status: 401,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 管理画面のページには検索避けを付ける（万一URLが漏れても拾われないように）。 */
export function applyAdminHeaders(response: Response, url: URL): Response {
  if (!isAdminPath(url.pathname)) return response;
  const next = new Response(response.body, response);
  next.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  next.headers.set("cache-control", "no-store");
  return next;
}

interface OverviewRow {
  segment_id: string | null;
  n: number;
  avg_interactions: number;
}

/** 管理画面の1画面ぶんの数字をまとめて返す（画面側で何度も叩かなくて済むように）。 */
export async function handleAdminOverview(env: AdminEnv, log: LogContext): Promise<Response> {
  try {
    const [registryCount, segmentRows, personalityRow, valueRow, consentRow, profileRow, listingRow, requestRow, metricRows, tagRow] =
      await env.DB.batch([
        env.DB.prepare("SELECT COUNT(*) AS n FROM persona_registry"),
        env.DB.prepare(
          "SELECT segment_id, COUNT(*) AS n, AVG(interaction_count) AS avg_interactions FROM persona_registry GROUP BY segment_id"
        ),
        env.DB.prepare(
          "SELECT AVG(warmth) AS warmth, AVG(curiosity) AS curiosity, AVG(cheerfulness) AS cheerfulness, AVG(caution) AS caution, AVG(independence) AS independence, AVG(humor) AS humor FROM persona_registry"
        ),
        env.DB.prepare(
          "SELECT AVG(v_achievement) AS achievement, AVG(v_benevolence) AS benevolence, AVG(v_hedonism) AS hedonism, AVG(v_security) AS security, AVG(v_stimulation) AS stimulation, AVG(v_selfdirection) AS selfDirection, AVG(v_tradition) AS tradition, AVG(v_power) AS power FROM persona_registry"
        ),
        env.DB.prepare(
          "SELECT SUM(consent_aggregate) AS aggregate, SUM(consent_marketplace) AS marketplace FROM persona_registry"
        ),
        env.DB.prepare(
          "SELECT AVG(profile_completion) AS avg_completion, COUNT(CASE WHEN profile_completion > 0 THEN 1 END) AS answered FROM persona_registry"
        ),
        env.DB.prepare("SELECT status, COUNT(*) AS n FROM market_listings GROUP BY status"),
        env.DB.prepare("SELECT status, COUNT(*) AS n FROM purchase_requests GROUP BY status"),
        env.DB.prepare("SELECT day, metric, value FROM analytics_daily ORDER BY day DESC LIMIT 200"),
        env.DB.prepare("SELECT COUNT(*) AS n FROM nfc_tags"),
      ]);

    const segments = (segmentRows.results as unknown as OverviewRow[]).map((r) => ({
      id: r.segment_id ?? "unknown",
      label: r.segment_id ? segmentById(r.segment_id)?.label ?? r.segment_id : "不明",
      count: r.n,
      avgInteractions: Math.round(r.avg_interactions ?? 0),
    }));
    for (const def of SEGMENTS) {
      if (!segments.some((s) => s.id === def.id)) {
        segments.push({ id: def.id, label: def.label, count: 0, avgInteractions: 0 });
      }
    }
    segments.sort((a, b) => b.count - a.count);

    // 日次カウンタは日→指標の表に組み替える（画面側で組み替えると、指標が増えるたびに直すことになる）
    const daily = new Map<string, Record<string, number>>();
    for (const row of metricRows.results as unknown as Array<{ day: string; metric: string; value: number }>) {
      const entry = daily.get(row.day) ?? {};
      entry[row.metric] = row.value;
      daily.set(row.day, entry);
    }

    const body = {
      environment: env.ENVIRONMENT || "production",
      version: env.APP_VERSION || "dev",
      today: todayKey(),
      totals: {
        // nfc_tags は同意に関係なく作られるので、これがサービス全体の分身の数になる
        characters: (tagRow.results?.[0] as { n?: number } | undefined)?.n ?? 0,
        // レジストリに載っているのは、集約か出品に同意した分身だけ
        registered: (registryCount.results?.[0] as { n?: number } | undefined)?.n ?? 0,
      },
      consent: consentRow.results?.[0] ?? { aggregate: 0, marketplace: 0 },
      profile: profileRow.results?.[0] ?? { avg_completion: 0, answered: 0 },
      segments,
      personalityAverage: personalityRow.results?.[0] ?? {},
      valueAverage: valueRow.results?.[0] ?? {},
      valueLabels: Object.fromEntries(VALUE_AXES.map((a) => [a, VALUE_LABELS[a]])),
      listings: listingRow.results ?? [],
      purchaseRequests: requestRow.results ?? [],
      daily: [...daily.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1))
        .slice(0, 21)
        .map(([day, metrics]) => ({ day, ...metrics })),
    };

    logInfo(log, "admin.overview", { segments: segments.length });
    return json(body);
  } catch (err) {
    logWarn(log, "admin.overview_failed", { error: err instanceof Error ? err.message : String(err) });
    return json({ error: "集計に失敗しました。マイグレーションが適用されているか確認してください" }, 500);
  }
}

/**
 * 個々の分身の一覧（同意済みのみ）。
 * 会話の本文は含まれない。運営が読めるのは、あくまで数値と選択肢の値まで。
 */
export async function handleAdminPersonas(env: AdminEnv, url: URL): Promise<Response> {
  const segment = url.searchParams.get("segment");
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));

  const query = segment
    ? env.DB.prepare(
        `SELECT character_id, updated_at, growth_stage, interaction_count, segment_id, segment_confidence,
                age_band, gender, region, occupation, profile_completion, top_interests,
                consent_aggregate, consent_marketplace
         FROM persona_registry WHERE segment_id = ?1 ORDER BY updated_at DESC LIMIT ?2`
      ).bind(segment, limit)
    : env.DB.prepare(
        `SELECT character_id, updated_at, growth_stage, interaction_count, segment_id, segment_confidence,
                age_band, gender, region, occupation, profile_completion, top_interests,
                consent_aggregate, consent_marketplace
         FROM persona_registry ORDER BY updated_at DESC LIMIT ?1`
      ).bind(limit);

  const rows = await query.all();
  return json({ personas: rows.results ?? [] });
}

/** 購入の申し込み一覧と、対応済みへの変更。 */
export async function handleAdminRequests(env: AdminEnv, request: Request, url: URL): Promise<Response> {
  if (request.method === "POST") {
    const body = await request
      .json<{ requestId?: string; status?: string }>()
      .catch(() => ({}) as { requestId?: string; status?: string });
    if (!body.requestId) return json({ error: "requestId is required" }, 400);
    const status = body.status === "new" ? "new" : "handled";
    await env.DB.prepare("UPDATE purchase_requests SET status = ? WHERE request_id = ?")
      .bind(status, body.requestId)
      .run();
    return json({ ok: true, status });
  }

  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const rows = await env.DB.prepare(
    `SELECT r.request_id, r.listing_id, r.contact, r.message, r.created_at, r.status, l.title
     FROM purchase_requests r LEFT JOIN market_listings l ON l.listing_id = r.listing_id
     ORDER BY r.created_at DESC LIMIT ?1`
  )
    .bind(limit)
    .all();
  return json({ requests: rows.results ?? [] });
}
