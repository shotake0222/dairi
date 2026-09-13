/**
 * 人格データのマーケット。2種類あり、性質がまったく違うので同じファイル内でも扱いを分けている。
 *
 * A. **本人による出品**（/api/market/listing, /api/market/listings）
 *    育てた本人が、自分の分身を他の人に使ってもらう形で出す。
 *    公開されるのは「どんな子か」までで、記憶の中身も属性も一覧には出さない。
 *    出品には marketplace への同意が要る。同意していない分身は、操作しても載らない。
 *
 * B. **匿名化・集約したセグメント統計**（/api/market/insights）
 *    企業向けに「どういう人たちがどんな話をしているか」の傾向を出す。
 *    個人を特定できないことが前提なので、**人数が一定に満たないグループは出さない**。
 *    aggregate に同意した分身しか母集団に入らない（レジストリにそもそも載っていない）。
 *
 * 決済は繋いでいない。買いたい人の申し込みを受け取るところまでで、
 * 金銭のやり取りは運営が個別に対応する前提にしてある
 * （人格データの売買は、値付けより先に「誰に渡ってよいか」の運用を決める必要があるため）。
 */

import { CharacterState } from "./durable-objects/characterState";
import { SEGMENTS, segmentById } from "./analysis/segments";
import { LogContext, logInfo, logWarn } from "./lib/log";

export interface MarketEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

/**
 * 集約統計を出すときの最小人数。
 *
 * これを下回るグループは、条件を重ねていくと個人が特定できてしまう
 * （「30代・北陸・獣医」が1人しかいなければ、それは統計ではなく個人情報）。
 * 数字を下げたくなったら、下げるのではなく条件を粗くすること。
 */
export const MIN_COHORT_SIZE = 20;

const MAX_TITLE = 40;
const MAX_DESCRIPTION = 400;
const MAX_PRICE = 1_000_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

interface ListingRow {
  listing_id: string;
  character_id: string;
  title: string;
  description: string;
  price_jpy: number;
  segment_id: string | null;
  growth_stage: string | null;
  interaction_count: number;
  status: string;
  created_at: number;
  updated_at: number;
  views: number;
}

/** 出品に載せる文字列を、そのまま信用せずに切り詰める。 */
function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * 出品の作成・更新・公開・取り下げ。
 * action で状態を変える: save（下書き保存）/ list（公開）/ withdraw（取り下げ）
 */
export async function handleSaveListing(
  env: MarketEnv,
  body: {
    characterId?: string;
    token?: string;
    title?: unknown;
    description?: unknown;
    priceJpy?: unknown;
    action?: string;
  },
  log: LogContext
): Promise<Response> {
  const characterId = body.characterId;
  if (!characterId) return json({ error: "characterId is required" }, 400);

  const stub = env.CHARACTER.getByName(characterId);

  // 持ち主であることの確認は、所有権の判定を持っているDO側に任せる（判定を2箇所に書かない）
  const isOwner = await stub.verifyOwner(body.token);
  if (!isOwner) return json({ error: "この操作は分身の持ち主だけが行えます" }, 403);

  const summary = await stub.getListingSummary();
  if (!summary) return json({ error: "not found" }, 404);
  if (!summary.consented) {
    return json({ error: "先に「育てた分身を出品する」への同意が必要です" }, 403);
  }

  const action = body.action === "list" || body.action === "withdraw" ? body.action : "save";
  const title = clean(body.title, MAX_TITLE) || summary.name;
  const description = clean(body.description, MAX_DESCRIPTION);
  const priceRaw = typeof body.priceJpy === "number" ? body.priceJpy : Number(body.priceJpy);
  const priceJpy = Number.isFinite(priceRaw) ? Math.max(0, Math.min(MAX_PRICE, Math.round(priceRaw))) : 0;

  if (action === "list" && description.length < 10) {
    return json({ error: "どんな子かの説明を、もう少し書いてください（10文字以上）" }, 400);
  }

  const now = Date.now();
  const status = action === "list" ? "listed" : action === "withdraw" ? "withdrawn" : "draft";

  const existing = await env.DB.prepare("SELECT listing_id FROM market_listings WHERE character_id = ?")
    .bind(characterId)
    .first<{ listing_id: string }>();
  const listingId = existing?.listing_id ?? crypto.randomUUID();

  await env.DB.prepare(
    `INSERT INTO market_listings
       (listing_id, character_id, title, description, price_jpy, segment_id, growth_stage, interaction_count, status, created_at, updated_at, views)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,0)
     ON CONFLICT(character_id) DO UPDATE SET
       title=excluded.title, description=excluded.description, price_jpy=excluded.price_jpy,
       segment_id=excluded.segment_id, growth_stage=excluded.growth_stage,
       interaction_count=excluded.interaction_count, status=excluded.status, updated_at=excluded.updated_at`
  )
    .bind(
      listingId,
      characterId,
      title,
      description,
      priceJpy,
      summary.segment.id,
      summary.growthStage,
      summary.interactionCount,
      status,
      now
    )
    .run();

  logInfo(log, "market.listing_saved", { characterId, status, priceJpy });
  return json({ listingId, status, title, description, priceJpy });
}

/** 自分の出品を見る（持ち主のみ）。 */
export async function handleMyListing(env: MarketEnv, url: URL): Promise<Response> {
  const cid = url.searchParams.get("cid");
  const token = url.searchParams.get("token") || undefined;
  if (!cid) return json({ error: "cid is required" }, 400);

  const stub = env.CHARACTER.getByName(cid);
  if (!(await stub.verifyOwner(token))) return json({ error: "この操作は分身の持ち主だけが行えます" }, 403);

  const row = await env.DB.prepare("SELECT * FROM market_listings WHERE character_id = ?")
    .bind(cid)
    .first<ListingRow>();
  const summary = await stub.getListingSummary();

  return json({ listing: row ?? null, summary });
}

/** 公開されている出品の一覧。誰でも見られるので、個人に紐づくものは何も返さない。 */
export async function handleBrowseListings(env: MarketEnv, url: URL): Promise<Response> {
  const segment = url.searchParams.get("segment");
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 24) || 24));

  const query = segment
    ? env.DB.prepare(
        `SELECT listing_id, title, description, price_jpy, segment_id, growth_stage, interaction_count, updated_at
         FROM market_listings WHERE status='listed' AND segment_id = ?1 ORDER BY updated_at DESC LIMIT ?2`
      ).bind(segment, limit)
    : env.DB.prepare(
        `SELECT listing_id, title, description, price_jpy, segment_id, growth_stage, interaction_count, updated_at
         FROM market_listings WHERE status='listed' ORDER BY updated_at DESC LIMIT ?1`
      ).bind(limit);

  const rows = await query.all<Omit<ListingRow, "character_id" | "status" | "created_at" | "views">>();

  return json({
    listings: (rows.results ?? []).map((r) => ({
      listingId: r.listing_id,
      title: r.title,
      description: r.description,
      priceJpy: r.price_jpy,
      segment: r.segment_id ? segmentById(r.segment_id)?.label ?? r.segment_id : null,
      growthStage: r.growth_stage,
      interactionCount: r.interaction_count,
      updatedAt: r.updated_at,
    })),
    segments: SEGMENTS.map((s) => ({ id: s.id, label: s.label })),
  });
}

/** 購入の申し込み。決済が無いので、連絡先を受け取って運営が対応する。 */
export async function handlePurchaseRequest(
  env: MarketEnv,
  body: { listingId?: string; contact?: unknown; message?: unknown },
  log: LogContext
): Promise<Response> {
  const listingId = typeof body.listingId === "string" ? body.listingId : "";
  const contact = clean(body.contact, 120);
  const message = clean(body.message, 400);
  if (!listingId || !contact) return json({ error: "listingId と連絡先が必要です" }, 400);
  // 連絡先はこちらから返信するためだけに使う。形式の緩いチェックだけ行う
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) {
    return json({ error: "連絡先はメールアドレスの形式で入力してください" }, 400);
  }

  const listing = await env.DB.prepare("SELECT listing_id, status FROM market_listings WHERE listing_id = ?")
    .bind(listingId)
    .first<{ listing_id: string; status: string }>();
  if (!listing || listing.status !== "listed") {
    return json({ error: "この出品は見つかりませんでした" }, 404);
  }

  await env.DB.prepare(
    "INSERT INTO purchase_requests (request_id, listing_id, contact, message, created_at, status) VALUES (?,?,?,?,?,'new')"
  )
    .bind(crypto.randomUUID(), listingId, contact, message, Date.now())
    .run();

  logInfo(log, "market.purchase_requested", { listingId });
  // 連絡先はログにも応答にも出さない
  return json({ ok: true });
}

export interface SegmentInsight {
  id: string;
  label: string;
  description: string;
  count: number;
  share: number;
  avgInteractions: number;
  topInterests: string[];
}

/**
 * 集約セグメント統計。
 *
 * k-匿名性の考え方で、人数が MIN_COHORT_SIZE に満たないセグメントは行ごと返さない。
 * 「0人」ではなく「存在しない」として扱うのは、人数の少なさ自体がヒントになるため。
 */
export async function handleInsights(env: MarketEnv, log: LogContext): Promise<Response> {
  try {
    const rows = await env.DB.prepare(
      `SELECT segment_id, COUNT(*) AS n, AVG(interaction_count) AS avg_interactions,
              GROUP_CONCAT(top_interests) AS interests
       FROM persona_registry
       WHERE consent_aggregate = 1
       GROUP BY segment_id`
    ).all<{ segment_id: string | null; n: number; avg_interactions: number; interests: string | null }>();

    const all = rows.results ?? [];
    const totalConsented = all.reduce((sum, r) => sum + r.n, 0);

    const insights: SegmentInsight[] = [];
    for (const row of all) {
      if (row.n < MIN_COHORT_SIZE) continue;
      const def = row.segment_id ? segmentById(row.segment_id) : undefined;

      // 関心はカテゴリ名の集合なので、そのまま数えても個人には結びつかない
      const counts = new Map<string, number>();
      for (const topic of (row.interests ?? "").split(",")) {
        const key = topic.trim();
        if (!key) continue;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      insights.push({
        id: row.segment_id ?? "unknown",
        label: def?.label ?? row.segment_id ?? "不明",
        description: def?.description ?? "",
        count: row.n,
        share: totalConsented > 0 ? Math.round((row.n / totalConsented) * 100) : 0,
        avgInteractions: Math.round(row.avg_interactions ?? 0),
        topInterests: [...counts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([topic]) => topic),
      });
    }

    insights.sort((a, b) => b.count - a.count);
    logInfo(log, "market.insights", { segments: insights.length, suppressed: all.length - insights.length });

    return json({
      minCohortSize: MIN_COHORT_SIZE,
      totalConsented,
      // 出せなかったグループがあること自体は伝える（データが無いのか、伏せたのかを区別できるように）
      suppressedSegments: all.length - insights.length,
      insights,
    });
  } catch (err) {
    logWarn(log, "market.insights_failed", { error: err instanceof Error ? err.message : String(err) });
    return json({ error: "統計を取得できませんでした" }, 500);
  }
}
