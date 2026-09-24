/**
 * 通貨・お店・引換券の API（中身は src/economy.ts）。
 *
 *   利用者（持ち主トークンで確かめた分身だけ）:
 *     GET  /api/meta/economy/info      通貨の名前と貯まり方（誰でも）
 *     POST /api/meta/economy/wallet    { cid, token }                    財布（残高・持ち物・引換券・出入り）
 *     POST /api/meta/economy/shop      { cid, token, shopId }            お店の中身
 *     POST /api/meta/economy/buy       { cid, token, shopId, itemId }    買う
 *     POST /api/meta/economy/equip     { cid, token, itemId, on }        身につける・外す
 *   提携店（お店の暗証番号で確かめる）:
 *     POST /api/redeem/check           { code, pin }                     引換券を確かめる
 *     POST /api/redeem/use             { code, pin }                     使ったにする
 *   管理画面（adminGate を通過したものだけ）:
 *     /api/admin/economy/settings      GET / POST
 *     /api/admin/economy/items         GET / POST / DELETE
 *     /api/admin/economy/shops         GET / POST / DELETE
 *     /api/admin/economy/partners      GET / POST（新規・暗証番号の作り直しのときだけ暗証番号を1回返す）
 *     /api/admin/economy/vouchers      GET ?partner=&status= / POST { code, refund }（取り消し）
 *     /api/admin/economy/grant         POST { characterId, amount, note }
 *     /api/admin/economy/wallet        GET ?cid=
 *     /api/admin/economy/stats         GET
 */

import type { CharacterState } from "./durable-objects/characterState";
import {
  EFFECT_KINDS,
  ITEM_KINDS,
  WEAR_SHAPES,
  buy,
  cancelVoucher,
  deleteItem,
  deleteShop,
  economyStats,
  equip,
  getEconomySettings,
  grant,
  listItems,
  listPartners,
  listShops,
  listVouchers,
  publicSettings,
  redeem,
  saveEconomySettings,
  saveItem,
  savePartner,
  saveShop,
  shopView,
  walletView,
} from "./economy";
import { consumeIpQuota } from "./lib/ipQuota";

export interface EconomyEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

const noStore = { "cache-control": "no-store" };

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", ...noStore, ...(init.headers ?? {}) },
  });
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const b = await request.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 持ち主トークンで、その分身の財布を使ってよいか確かめる */
async function owner(env: EconomyEnv, b: Record<string, unknown>): Promise<string | null> {
  const cid = typeof b.cid === "string" ? b.cid.slice(0, 200) : "";
  const token = typeof b.token === "string" ? b.token.slice(0, 200) : "";
  if (!cid || !token) return null;
  try {
    return (await env.CHARACTER.getByName(cid).canUseWallet(token)) ? cid : null;
  } catch {
    return null;
  }
}

const NOT_OWNER = { error: "この端末の分身だと確かめられませんでした。分身の画面から開き直してください", code: "not_owner" };

export async function handleEconomyApi(request: Request, url: URL, env: EconomyEnv): Promise<Response | null> {
  try {
    return await economyApi(request, url, env);
  } catch (e) {
    // 表がまだ無い（migration 0015 を当てる前にデプロイした）ときなど。画面には理由を短く返す
    console.error("[economy]", e);
    return json({ error: "いまはお店・財布を開けませんでした。少し待ってからもう一度お試しください", code: "economy_unavailable" }, { status: 503 });
  }
}

async function economyApi(request: Request, url: URL, env: EconomyEnv): Promise<Response | null> {
  const p = url.pathname;
  if (p === "/api/meta/economy/info" && request.method === "GET") {
    return json({
      settings: publicSettings(await getEconomySettings(env)),
      rules: [
        "遊ぶと貯まります（毎日の入室・ミニゲームのクリア・分身どうしのおしゃべり）",
        "お金で買うことはできません。お金に戻すこともできません",
        "ほかの人に渡すことはできません",
        "リアルでは、提携店の引換券にかえて使えます（数と期限があります）",
      ],
    });
  }
  if (request.method !== "POST") return null;
  if (!["/api/meta/economy/wallet", "/api/meta/economy/shop", "/api/meta/economy/buy", "/api/meta/economy/equip"].includes(p)) return null;
  const b = await body(request);
  const cid = await owner(env, b);
  if (!cid) return json(NOT_OWNER, { status: 403 });

  if (p === "/api/meta/economy/wallet") return json(await walletView(env, cid));
  if (p === "/api/meta/economy/shop") {
    const view = await shopView(env, cid, String(b.shopId ?? ""));
    return view ? json(view) : json({ error: "そのお店はいま開いていません" }, { status: 404 });
  }
  if (p === "/api/meta/economy/buy") {
    const r = await buy(env, cid, String(b.shopId ?? ""), String(b.itemId ?? ""));
    return r.ok ? json(r) : json({ error: r.error }, { status: 409 });
  }
  if (p === "/api/meta/economy/equip") {
    const r = await equip(env, cid, String(b.itemId ?? ""), b.on !== false);
    return r.ok ? json(r) : json({ error: r.error }, { status: 409 });
  }
  return null;
}

export async function handleRedeemApi(request: Request, url: URL, env: EconomyEnv): Promise<Response | null> {
  const p = url.pathname;
  if ((p !== "/api/redeem/check" && p !== "/api/redeem/use") || request.method !== "POST") return null;
  const b = await body(request);
  const r = await redeem(env, b.code, b.pin, p === "/api/redeem/use");
  if (!r.ok) {
    // 番号・暗証番号の当てずっぽうを止める（まちがえたときだけ数える。1回線1日30回まで）
    const q = await consumeIpQuota(env, "redeem_fail", request, 30);
    if (!q.allowed) return json({ error: "まちがいが多いため、今日はこれ以上確かめられません。明日もう一度お試しください" }, { status: 429 });
    return json({ error: r.error }, { status: 404 });
  }
  const v = r.voucher;
  return json({
    voucher: { code: v.code, title: v.title, note: v.note, partnerName: v.partnerName, status: v.status, issuedAt: v.issuedAt, expiresAt: v.expiresAt, usedAt: v.usedAt },
    justUsed: r.justUsed,
  });
}

export async function handleEconomyAdmin(request: Request, url: URL, env: EconomyEnv): Promise<Response | null> {
  const p = url.pathname;
  const m = request.method;
  if (!p.startsWith("/api/admin/economy/")) return null;

  if (p === "/api/admin/economy/settings") {
    if (m === "GET") return json({ settings: await getEconomySettings(env) });
    if (m === "POST") return json({ settings: await saveEconomySettings(env, await body(request)) });
  }
  if (p === "/api/admin/economy/items") {
    if (m === "GET") {
      const [items, partners, shops] = await Promise.all([listItems(env), listPartners(env), listShops(env)]);
      return json({ items, partners, shops, kinds: ITEM_KINDS, shapes: WEAR_SHAPES, effects: EFFECT_KINDS });
    }
    if (m === "POST") {
      const r = await saveItem(env, await body(request));
      return r.ok ? json(r) : json({ error: r.error }, { status: 400 });
    }
    if (m === "DELETE") {
      const ok = await deleteItem(env, url.searchParams.get("id"));
      return ok ? json({ ok }) : json({ error: "その商品はありません" }, { status: 404 });
    }
  }
  if (p === "/api/admin/economy/shops") {
    if (m === "GET") return json({ shops: await listShops(env), items: await listItems(env) });
    if (m === "POST") {
      const r = await saveShop(env, await body(request));
      return r.ok ? json(r) : json({ error: r.error }, { status: 400 });
    }
    if (m === "DELETE") {
      const ok = await deleteShop(env, url.searchParams.get("id"));
      return ok ? json({ ok }) : json({ error: "そのお店はありません" }, { status: 404 });
    }
  }
  if (p === "/api/admin/economy/partners") {
    if (m === "GET") return json({ partners: await listPartners(env) });
    if (m === "POST") {
      const r = await savePartner(env, await body(request));
      return r.ok ? json(r) : json({ error: r.error }, { status: 400 });
    }
  }
  if (p === "/api/admin/economy/vouchers") {
    if (m === "GET") {
      return json({
        vouchers: await listVouchers(env, { partnerId: url.searchParams.get("partner") || undefined, status: url.searchParams.get("status") || undefined }),
        partners: await listPartners(env),
      });
    }
    if (m === "POST") {
      const b = await body(request);
      const r = await cancelVoucher(env, b.code, b.refund === true);
      return r.ok ? json(r) : json({ error: r.error }, { status: 400 });
    }
  }
  if (p === "/api/admin/economy/grant" && m === "POST") {
    const b = await body(request);
    const r = await grant(env, String(b.characterId ?? "").trim(), Number(b.amount), String(b.note ?? ""));
    return r.ok ? json(r) : json({ error: r.error }, { status: 400 });
  }
  if (p === "/api/admin/economy/wallet" && m === "GET") {
    const cid = (url.searchParams.get("cid") || "").trim();
    if (!cid) return json({ error: "分身のIDを入れてください" }, { status: 400 });
    return json(await walletView(env, cid));
  }
  if (p === "/api/admin/economy/stats" && m === "GET") {
    return json({ stats: await economyStats(env), settings: await getEconomySettings(env), partners: await listPartners(env), items: await listItems(env) });
  }
  return null;
}
