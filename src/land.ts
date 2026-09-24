/**
 * メタバースの「区画」— 広告の出稿と、デジタルランドマークの設置・購入。
 *
 * 流れ（決済そのものは外に置く。カード番号などをこのサービスで預からない）:
 *   1. 管理画面で、エリアの外周にある区画（LAND_SPOTS・8か所）ごとに「売る物（広告／ランドマーク）」と価格を決める
 *   2. 申し込む人は /land で区画・中身（看板の文字・画像・リンク・クーポン、またはランドマークの形・色・銘板）と連絡先を送る
 *   3. 運営が中身を確かめ、承認するときに金額と決済リンク（Stripe の Payment Link・請求書のURLなど）を入れる
 *      → 申込者の状況ページ（/land?order=…&key=…）に金額と決済リンクが出る
 *   4. 入金を確かめたら「支払い済み」にする → その時点から期間ぶん、エリアに表示される
 *
 * **中身は必ず運営が見てから出す。** 見知らぬ人（子どもを含む）の画面に出るので、自動では掲載しない。
 * 広告には必ず「広告」、ランドマークは「提供: ○○」を表示する（ステルスマーケティング規制）。
 *
 * 広告の見られ方は、日ごとの回数（詳細を開いた・リンクを開いた・クーポンを出した）だけを数える。誰が見たかは持たない。
 */

import type { LogContext } from "./lib/log";
import { consumeIpQuota } from "./lib/ipQuota";
import {
  LAND_SPOTS,
  LANDMARK_COLORS,
  LANDMARK_MODELS,
  cleanLong,
  cleanImageUrl,
  cleanText,
  cleanUrl,
  getRoom,
  intIn,
  isValidRoomId,
  listAdminRooms,
  timeOrNull,
  type MetaverseEnv,
} from "./metaverse";

export { LAND_SPOTS, LANDMARK_MODELS, LANDMARK_COLORS };

export const SALE_KINDS = [
  { id: "none", label: "売らない" },
  { id: "ad", label: "広告だけ" },
  { id: "landmark", label: "ランドマークだけ" },
  { id: "both", label: "広告・ランドマーク" },
] as const;

type SpotId = (typeof LAND_SPOTS)[number]["id"];
type Kind = "ad" | "landmark";
const DAY = 24 * 60 * 60 * 1000;

export interface LandSettings {
  /** 申し込みを受け付けるか */
  salesOpen: boolean;
  /** メタバースの中に「販売中」の目印を出すか */
  showForSale: boolean;
  /** 申込者に見せる、支払いの案内 */
  paymentNote: string;
  /** 承認するときの決済リンクの既定値 */
  defaultPaymentUrl: string;
  /** 広告の1単位の日数（既定7日）・ランドマークの1単位の日数（既定30日） */
  adUnitDays: number;
  landmarkUnitDays: number;
  /** 1回に申し込める単位の数 */
  maxUnits: number;
}

const DEFAULT_SETTINGS: LandSettings = {
  salesOpen: false,
  showForSale: false,
  paymentNote: "承認後、この画面に金額とお支払いの案内が表示されます。お支払いを確認したら掲載を始めます。",
  defaultPaymentUrl: "",
  adUnitDays: 7,
  landmarkUnitDays: 30,
  maxUnits: 12,
};

export interface PlacementContent {
  title: string;
  text: string;
  detail: string;
  imageUrl: string;
  linkUrl: string;
  sponsor: string;
  couponCode: string;
  couponNote: string;
  couponUntil: number | null;
  qrUrl: string;
  /** ランドマーク */
  model?: string;
  color?: string;
  plaque?: string;
}

export interface Placement {
  id: string;
  areaId: string;
  spot: SpotId;
  kind: Kind;
  status: "active" | "ended";
  startsAt: number;
  endsAt: number | null;
  content: PlacementContent;
  source: "operator" | "order";
  orderId: string | null;
  createdAt: number;
  /** 一覧用: いま表示中か・これからか・終わったか */
  state?: "live" | "upcoming" | "ended";
}

function randomId(n: number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isSpot(v: unknown): v is SpotId {
  return LAND_SPOTS.some((s) => s.id === v);
}

// ---------------------------------------------------------------- 設定

export async function getLandSettings(env: MetaverseEnv): Promise<LandSettings> {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta_settings WHERE key = 'land'").first<{ value: string }>();
    if (!row) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value) as Partial<LandSettings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveLandSettings(env: MetaverseEnv, raw: Record<string, unknown>): Promise<LandSettings> {
  const value: LandSettings = {
    salesOpen: raw.salesOpen === true,
    showForSale: raw.showForSale === true,
    paymentNote: cleanLong(raw.paymentNote, 300) || DEFAULT_SETTINGS.paymentNote,
    defaultPaymentUrl: cleanUrl(raw.defaultPaymentUrl),
    adUnitDays: intIn(raw.adUnitDays, 1, 90, 7),
    landmarkUnitDays: intIn(raw.landmarkUnitDays, 1, 365, 30),
    maxUnits: intIn(raw.maxUnits, 1, 52, 12),
  };
  await env.DB.prepare(
    "INSERT INTO meta_settings (key, value, updated_at) VALUES ('land', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(JSON.stringify(value), Date.now())
    .run();
  return value;
}

// ---------------------------------------------------------------- 中身の検査

/**
 * 広告・ランドマークの中身を整える。直せないもの（http のURL・中身が空）はエラーにする。
 * 申込（利用者）と運営の設置で同じ検査を通す。
 */
export function sanitizeContent(kind: Kind, raw: unknown): { ok: true; value: PlacementContent } | { ok: false; error: string } {
  const o = (raw ?? {}) as Record<string, unknown>;
  const urlField = (key: string, label: string, clean = cleanUrl): string | { error: string } => {
    const v = typeof o[key] === "string" ? (o[key] as string).trim() : "";
    if (!v) return "";
    const u = clean(v);
    return u || { error: `${label}は https:// で始まるURLにしてください` };
  };
  // 画像はアップロードした画像（/img/…）も通す
  const imageUrl = urlField("imageUrl", "画像のURL", cleanImageUrl);
  const linkUrl = urlField("linkUrl", "リンク先");
  const qrUrl = urlField("qrUrl", "QRコードの行き先");
  for (const v of [imageUrl, linkUrl, qrUrl]) if (typeof v !== "string") return { ok: false, error: v.error };
  const value: PlacementContent = {
    title: cleanText(o.title, 24),
    text: cleanText(o.text, 80),
    detail: cleanLong(o.detail, 300),
    imageUrl: imageUrl as string,
    linkUrl: linkUrl as string,
    sponsor: cleanText(o.sponsor, 30),
    couponCode: cleanText(o.couponCode, 24),
    couponNote: cleanText(o.couponNote, 60),
    couponUntil: timeOrNull(o.couponUntil),
    qrUrl: qrUrl as string,
  };
  if (kind === "landmark") {
    value.model = LANDMARK_MODELS.some((m) => m.id === o.model) ? String(o.model) : "monument";
    value.color = LANDMARK_COLORS.some((c) => c.id === o.color) ? String(o.color) : "gold";
    value.plaque = cleanText(o.plaque, 20);
    if (!value.plaque && !value.title) return { ok: false, error: "ランドマークの銘板（名前）を入れてください" };
  } else if (!value.title && !value.text && !value.imageUrl) {
    return { ok: false, error: "広告の見出し・文字・画像のどれかを入れてください" };
  }
  if (!value.sponsor) return { ok: false, error: "提供者の名前（表示名）を入れてください" };
  return { ok: true, value };
}

// ---------------------------------------------------------------- 区画

interface PlotRow {
  area_id: string;
  spot: string;
  sale: string;
  ad_price: number | null;
  landmark_price: number | null;
  note: string;
}

export interface PlotView {
  spot: SpotId;
  label: string;
  sale: string;
  adPrice: number | null;
  landmarkPrice: number | null;
  note: string;
  /** いま表示中の物（あれば）と、その終わり */
  current: { id: string; kind: Kind; title: string; endsAt: number | null } | null;
  /** これから始まる物（予約済み） */
  upcoming: number;
}

interface PlacementRow {
  id: string;
  area_id: string;
  spot: string;
  kind: string;
  status: string;
  starts_at: number;
  ends_at: number | null;
  content: string;
  source: string;
  order_id: string | null;
  created_at: number;
}

function placementState(p: { status: string; startsAt: number; endsAt: number | null }, now = Date.now()): "live" | "upcoming" | "ended" {
  if (p.status !== "active") return "ended";
  if (p.endsAt !== null && now >= p.endsAt) return "ended";
  if (now < p.startsAt) return "upcoming";
  return "live";
}

function fromPlacementRow(r: PlacementRow): Placement {
  let content: PlacementContent;
  try {
    content = JSON.parse(r.content);
  } catch {
    content = { title: "", text: "", detail: "", imageUrl: "", linkUrl: "", sponsor: "", couponCode: "", couponNote: "", couponUntil: null, qrUrl: "" };
  }
  const p: Placement = {
    id: r.id,
    areaId: r.area_id,
    spot: r.spot as SpotId,
    kind: r.kind === "landmark" ? "landmark" : "ad",
    status: r.status === "ended" ? "ended" : "active",
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    content,
    source: r.source === "order" ? "order" : "operator",
    orderId: r.order_id,
    createdAt: r.created_at,
  };
  p.state = placementState(p);
  return p;
}

async function placementsOf(env: MetaverseEnv, areaId: string): Promise<Placement[]> {
  const rows = await env.DB.prepare("SELECT * FROM meta_placements WHERE area_id = ? AND status = 'active' ORDER BY starts_at").bind(areaId).all<PlacementRow>();
  return (rows.results ?? []).map(fromPlacementRow);
}

export async function listPlots(env: MetaverseEnv, areaId: string): Promise<PlotView[]> {
  const rows = await env.DB.prepare("SELECT * FROM meta_plots WHERE area_id = ?").bind(areaId).all<PlotRow>();
  const byId = new Map((rows.results ?? []).map((r) => [r.spot, r]));
  const placements = (await placementsOf(env, areaId)).filter((p) => p.state !== "ended");
  return LAND_SPOTS.map((s) => {
    const r = byId.get(s.id);
    const live = placements.find((p) => p.spot === s.id && p.state === "live");
    return {
      spot: s.id,
      label: s.label,
      sale: r?.sale ?? "none",
      adPrice: r?.ad_price ?? null,
      landmarkPrice: r?.landmark_price ?? null,
      note: r?.note ?? "",
      current: live ? { id: live.id, kind: live.kind, title: live.content.title || live.content.plaque || "", endsAt: live.endsAt } : null,
      upcoming: placements.filter((p) => p.spot === s.id && p.state === "upcoming").length,
    };
  });
}

export async function savePlots(env: MetaverseEnv, areaId: string, raw: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!isValidRoomId(areaId) || !(await getRoom(env, areaId))) return { ok: false, error: "そのエリアはありません" };
  const list = Array.isArray(raw) ? raw : [];
  const now = Date.now();
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    if (!isSpot(o.spot)) continue;
    const sale = SALE_KINDS.some((k) => k.id === o.sale) ? String(o.sale) : "none";
    const price = (v: unknown) => (v === null || v === "" || v === undefined ? null : intIn(v, 0, 100_000_000, 0));
    await env.DB.prepare(
      `INSERT INTO meta_plots (area_id, spot, sale, ad_price, landmark_price, note, updated_at) VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(area_id, spot) DO UPDATE SET sale=excluded.sale, ad_price=excluded.ad_price, landmark_price=excluded.landmark_price, note=excluded.note, updated_at=excluded.updated_at`
    )
      .bind(areaId, o.spot, sale, price(o.adPrice), price(o.landmarkPrice), cleanText(o.note, 60), now)
      .run();
  }
  return { ok: true };
}

function saleAllows(sale: string, kind: Kind): boolean {
  return sale === "both" || sale === kind;
}

// ---------------------------------------------------------------- 設置物

export async function listPlacements(env: MetaverseEnv, filter: { areaId?: string; state?: string } = {}): Promise<Placement[]> {
  const rows = filter.areaId
    ? await env.DB.prepare("SELECT * FROM meta_placements WHERE area_id = ? ORDER BY starts_at DESC LIMIT 300").bind(filter.areaId).all<PlacementRow>()
    : await env.DB.prepare("SELECT * FROM meta_placements ORDER BY starts_at DESC LIMIT 300").all<PlacementRow>();
  const list = (rows.results ?? []).map(fromPlacementRow);
  return filter.state ? list.filter((p) => p.state === filter.state) : list;
}

/** 同じ区画で、期間が重なる物があるか（自分自身は除く） */
async function overlaps(env: MetaverseEnv, areaId: string, spot: string, startsAt: number, endsAt: number | null, exceptId?: string): Promise<boolean> {
  const list = await placementsOf(env, areaId);
  return list.some((p) => {
    if (p.id === exceptId || p.spot !== spot || p.state === "ended") return false;
    const aEnd = endsAt ?? Infinity;
    const bEnd = p.endsAt ?? Infinity;
    return startsAt < bEnd && p.startsAt < aEnd;
  });
}

/** 運営が置く・直す（無料。運営の告知・協賛・記念など） */
export async function savePlacement(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; placement: Placement } | { ok: false; status: number; error: string }> {
  const areaId = typeof raw.areaId === "string" ? raw.areaId : "";
  if (!isValidRoomId(areaId) || !(await getRoom(env, areaId))) return { ok: false, status: 400, error: "エリアを選んでください" };
  if (!isSpot(raw.spot)) return { ok: false, status: 400, error: "区画を選んでください" };
  const kind: Kind = raw.kind === "landmark" ? "landmark" : "ad";
  const content = sanitizeContent(kind, raw.content);
  if (!content.ok) return { ok: false, status: 400, error: content.error };
  const startsAt = timeOrNull(raw.startsAt) ?? Date.now();
  const endsAt = timeOrNull(raw.endsAt);
  if (endsAt !== null && endsAt <= startsAt) return { ok: false, status: 400, error: "終わりは、始まりより後にしてください" };
  const id = typeof raw.id === "string" && /^[a-z0-9]{6,16}$/.test(raw.id) ? raw.id : "";
  if (await overlaps(env, areaId, raw.spot, startsAt, endsAt, id || undefined)) {
    return { ok: false, status: 409, error: "その区画には、同じ期間に別の物が置かれています" };
  }
  const now = Date.now();
  const placementId = id || randomId(10);
  const existing = id ? await env.DB.prepare("SELECT source, order_id, created_at FROM meta_placements WHERE id = ?").bind(id).first<{ source: string; order_id: string | null; created_at: number }>() : null;
  await env.DB.prepare(
    `INSERT INTO meta_placements (id, area_id, spot, kind, status, starts_at, ends_at, content, source, order_id, created_at, updated_at)
     VALUES (?,?,?,?, 'active', ?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET area_id=excluded.area_id, spot=excluded.spot, kind=excluded.kind, status='active', starts_at=excluded.starts_at,
       ends_at=excluded.ends_at, content=excluded.content, updated_at=excluded.updated_at`
  )
    .bind(placementId, areaId, raw.spot, kind, startsAt, endsAt, JSON.stringify(content.value), existing?.source ?? "operator", existing?.order_id ?? null, existing?.created_at ?? now, now)
    .run();
  const row = await env.DB.prepare("SELECT * FROM meta_placements WHERE id = ?").bind(placementId).first<PlacementRow>();
  return { ok: true, placement: fromPlacementRow(row!) };
}

/** いますぐ終える（記録は残す） */
export async function endPlacement(env: MetaverseEnv, id: unknown): Promise<string | null> {
  if (typeof id !== "string") return null;
  const row = await env.DB.prepare("SELECT area_id FROM meta_placements WHERE id = ?").bind(id).first<{ area_id: string }>();
  if (!row) return null;
  const now = Date.now();
  await env.DB.prepare("UPDATE meta_placements SET status = 'ended', ends_at = MIN(COALESCE(ends_at, ?), ?), updated_at = ? WHERE id = ?").bind(now, now, now, id).run();
  return row.area_id;
}

export async function deletePlacement(env: MetaverseEnv, id: unknown): Promise<string | null> {
  if (typeof id !== "string") return null;
  const row = await env.DB.prepare("SELECT area_id FROM meta_placements WHERE id = ?").bind(id).first<{ area_id: string }>();
  await env.DB.prepare("DELETE FROM meta_placements WHERE id = ?").bind(id).run();
  return row?.area_id ?? null;
}

/** 部屋に配る設置物（いま表示中の物だけ） */
export interface RoomPlacement {
  id: string;
  kind: Kind;
  spot: SpotId;
  content: PlacementContent;
}

export async function roomPlacements(env: MetaverseEnv, areaId: string): Promise<RoomPlacement[]> {
  const list = await placementsOf(env, areaId);
  return list.filter((p) => p.state === "live").map((p) => ({ id: p.id, kind: p.kind, spot: p.spot, content: p.content }));
}

/** 部屋に出す「販売中」の目印（設定で出すときだけ・空いている区画だけ） */
export async function roomPlotsForSale(env: MetaverseEnv, areaId: string, settings?: LandSettings): Promise<Array<{ spot: SpotId; sale: string; adPrice: number | null; landmarkPrice: number | null }>> {
  const s = settings ?? (await getLandSettings(env));
  if (!s.salesOpen || !s.showForSale) return [];
  const plots = await listPlots(env, areaId);
  return plots
    .filter((p) => p.sale !== "none" && !p.current)
    .map((p) => ({ spot: p.spot, sale: p.sale, adPrice: p.adPrice, landmarkPrice: p.landmarkPrice }));
}

// ---------------------------------------------------------------- 申込（/land）

/** 申込ページに見せる一覧（公開中・近日開放のエリアで、売っている区画） */
export async function landCatalog(env: MetaverseEnv) {
  const settings = await getLandSettings(env);
  const rooms = (await listAdminRooms(env)).filter((r) => (r.state === "open" || r.state === "soon") && r.listed);
  const areas = [];
  for (const r of rooms) {
    const plots = (await listPlots(env, r.id)).filter((p) => p.sale !== "none");
    if (plots.length === 0) continue;
    areas.push({
      id: r.id,
      name: r.name,
      place: r.place,
      time: r.time,
      plots: plots.map((p) => ({
        spot: p.spot,
        label: p.label,
        sale: p.sale,
        adPrice: p.adPrice,
        landmarkPrice: p.landmarkPrice,
        note: p.note,
        busyUntil: p.current ? p.current.endsAt : null,
        busy: !!p.current,
      })),
    });
  }
  return {
    salesOpen: settings.salesOpen,
    paymentNote: settings.paymentNote,
    adUnitDays: settings.adUnitDays,
    landmarkUnitDays: settings.landmarkUnitDays,
    maxUnits: settings.maxUnits,
    spots: LAND_SPOTS,
    models: LANDMARK_MODELS,
    colors: LANDMARK_COLORS,
    areas,
  };
}

const ORDER_DAILY_LIMIT = 5;

export async function createOrder(
  env: MetaverseEnv,
  raw: Record<string, unknown>,
  request: Request,
  log?: LogContext
): Promise<{ ok: true; id: string; key: string } | { ok: false; status: number; error: string }> {
  void log;
  const settings = await getLandSettings(env);
  if (!settings.salesOpen) return { ok: false, status: 403, error: "いまは申し込みを受け付けていません" };
  if (raw.agree !== true) return { ok: false, status: 400, error: "掲載のきまりと、プライバシーポリシーへの同意が必要です" };
  const areaId = typeof raw.areaId === "string" ? raw.areaId : "";
  const room = isValidRoomId(areaId) ? await getRoom(env, areaId) : null;
  if (!room) return { ok: false, status: 400, error: "エリアを選んでください" };
  if (!isSpot(raw.spot)) return { ok: false, status: 400, error: "区画を選んでください" };
  const kind: Kind = raw.kind === "landmark" ? "landmark" : "ad";
  const plot = (await listPlots(env, areaId)).find((p) => p.spot === raw.spot)!;
  if (!saleAllows(plot.sale, kind)) return { ok: false, status: 400, error: "その区画では、選んだ種類を扱っていません" };
  const content = sanitizeContent(kind, raw.content);
  if (!content.ok) return { ok: false, status: 400, error: content.error };
  const name = cleanText(raw.contactName, 40);
  const email = cleanText(raw.contactEmail, 120);
  if (!name) return { ok: false, status: 400, error: "お名前を入れてください" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, status: 400, error: "連絡先のメールアドレスを正しく入れてください" };
  const quantity = intIn(raw.quantity, 1, settings.maxUnits, 1);

  const limited = await consumeIpQuota(env, "land_order", request, ORDER_DAILY_LIMIT);
  if (!limited.allowed) return { ok: false, status: 429, error: "本日の申し込みの上限に達しました。時間をおいてお試しください" };

  const id = randomId(12);
  const key = randomId(24);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO meta_orders (id, key_hash, area_id, spot, kind, quantity, content, contact_name, contact_email, company, note, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`
  )
    .bind(id, await sha256(key), areaId, raw.spot, kind, quantity, JSON.stringify(content.value), name, email, cleanText(raw.company, 80), cleanLong(raw.note, 500), now, now)
    .run();
  return { ok: true, id, key };
}

interface OrderRow {
  id: string;
  key_hash: string;
  area_id: string;
  spot: string;
  kind: string;
  quantity: number;
  content: string;
  contact_name: string;
  contact_email: string;
  company: string;
  note: string;
  status: string;
  price: number | null;
  payment_url: string | null;
  admin_note: string;
  reject_reason: string;
  placement_id: string | null;
  created_at: number;
  updated_at: number;
}

const ORDER_STATUS_LABEL: Record<string, string> = {
  pending: "確認中",
  approved: "承認済み・お支払い待ち",
  paid: "お支払い確認済み・掲載",
  rejected: "お見送り",
  cancelled: "取り消し",
};

/** 申込者が見る状況（鍵が合うときだけ） */
export async function orderStatus(env: MetaverseEnv, id: unknown, key: unknown) {
  if (typeof id !== "string" || typeof key !== "string" || !id || !key) return null;
  const row = await env.DB.prepare("SELECT * FROM meta_orders WHERE id = ?").bind(id).first<OrderRow>();
  if (!row || row.key_hash !== (await sha256(key))) return null;
  const settings = await getLandSettings(env);
  const room = await getRoom(env, row.area_id);
  let period: { startsAt: number; endsAt: number | null } | null = null;
  if (row.placement_id) {
    const p = await env.DB.prepare("SELECT starts_at, ends_at FROM meta_placements WHERE id = ?").bind(row.placement_id).first<{ starts_at: number; ends_at: number | null }>();
    if (p) period = { startsAt: p.starts_at, endsAt: p.ends_at };
  }
  return {
    id: row.id,
    status: row.status,
    statusLabel: ORDER_STATUS_LABEL[row.status] ?? row.status,
    kind: row.kind,
    areaName: room?.name ?? row.area_id,
    spotLabel: LAND_SPOTS.find((s) => s.id === row.spot)?.label ?? row.spot,
    quantity: row.quantity,
    unitDays: row.kind === "landmark" ? settings.landmarkUnitDays : settings.adUnitDays,
    price: row.status === "approved" || row.status === "paid" ? row.price : null,
    paymentUrl: row.status === "approved" ? row.payment_url : null,
    paymentNote: settings.paymentNote,
    rejectReason: row.status === "rejected" ? row.reject_reason : "",
    period,
    createdAt: row.created_at,
  };
}

/** 連絡先を持ち続けない: 終わってから1年たった申込の連絡先を消す */
async function purgeOldContacts(env: MetaverseEnv): Promise<void> {
  const cutoff = Date.now() - 365 * DAY;
  await env.DB.prepare(
    `UPDATE meta_orders SET contact_name = '（消去済み）', contact_email = '', company = '', note = ''
      WHERE contact_email != '' AND updated_at < ? AND status IN ('rejected','cancelled','paid')
        AND (placement_id IS NULL OR placement_id IN (SELECT id FROM meta_placements WHERE ends_at IS NOT NULL AND ends_at < ?))`
  )
    .bind(cutoff, cutoff)
    .run()
    .catch(() => undefined);
}

export async function listOrders(env: MetaverseEnv, status?: string) {
  await purgeOldContacts(env);
  const rows = status
    ? await env.DB.prepare("SELECT * FROM meta_orders WHERE status = ? ORDER BY created_at DESC LIMIT 300").bind(status).all<OrderRow>()
    : await env.DB.prepare("SELECT * FROM meta_orders ORDER BY created_at DESC LIMIT 300").all<OrderRow>();
  const settings = await getLandSettings(env);
  const rooms = new Map((await listAdminRooms(env)).map((r) => [r.id, r.name]));
  const plotsCache = new Map<string, PlotView[]>();
  const out = [];
  for (const r of rows.results ?? []) {
    if (!plotsCache.has(r.area_id)) plotsCache.set(r.area_id, await listPlots(env, r.area_id));
    const plot = plotsCache.get(r.area_id)!.find((p) => p.spot === r.spot);
    const unitPrice = r.kind === "landmark" ? plot?.landmarkPrice : plot?.adPrice;
    let content: PlacementContent | null = null;
    try {
      content = JSON.parse(r.content);
    } catch {
      content = null;
    }
    out.push({
      id: r.id,
      areaId: r.area_id,
      areaName: rooms.get(r.area_id) ?? r.area_id,
      spot: r.spot,
      spotLabel: LAND_SPOTS.find((s) => s.id === r.spot)?.label ?? r.spot,
      kind: r.kind,
      quantity: r.quantity,
      unitDays: r.kind === "landmark" ? settings.landmarkUnitDays : settings.adUnitDays,
      suggestedPrice: unitPrice != null ? unitPrice * r.quantity : null,
      content,
      contactName: r.contact_name,
      contactEmail: r.contact_email,
      company: r.company,
      note: r.note,
      status: r.status,
      statusLabel: ORDER_STATUS_LABEL[r.status] ?? r.status,
      price: r.price,
      paymentUrl: r.payment_url,
      adminNote: r.admin_note,
      rejectReason: r.reject_reason,
      placementId: r.placement_id,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    });
  }
  return out;
}

/**
 * 申込の操作（管理画面）。
 *   approve  金額・決済リンクを入れて承認（申込者の状況ページに出る）
 *   paid     入金を確認した → 設置物を作って掲載開始（startsAt を渡せば、その日から）
 *   reject   理由を入れて見送る
 *   cancel   取り消す（掲載中なら、その場で終える）
 *   note     運営のメモだけ直す
 */
export async function orderAction(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; status: string; areaId: string } | { ok: false; status: number; error: string }> {
  const id = typeof raw.id === "string" ? raw.id : "";
  const row = id ? await env.DB.prepare("SELECT * FROM meta_orders WHERE id = ?").bind(id).first<OrderRow>() : null;
  if (!row) return { ok: false, status: 404, error: "その申込はありません" };
  const now = Date.now();
  const action = String(raw.action || "");
  const note = raw.adminNote !== undefined ? cleanLong(raw.adminNote, 500) : row.admin_note;

  if (action === "approve") {
    if (row.status !== "pending" && row.status !== "approved") return { ok: false, status: 400, error: "確認中の申込だけ承認できます" };
    const price = intIn(raw.price, 0, 100_000_000, -1);
    if (price < 0) return { ok: false, status: 400, error: "金額を入れてください" };
    const settings = await getLandSettings(env);
    const payRaw = typeof raw.paymentUrl === "string" ? raw.paymentUrl.trim() : "";
    const paymentUrl = cleanUrl(payRaw) || settings.defaultPaymentUrl;
    if (payRaw && !cleanUrl(payRaw)) return { ok: false, status: 400, error: "決済リンクは https:// で始まるURLにしてください" };
    await env.DB.prepare("UPDATE meta_orders SET status='approved', price=?, payment_url=?, admin_note=?, updated_at=? WHERE id=?")
      .bind(price, paymentUrl || null, note, now, id)
      .run();
    return { ok: true, status: "approved", areaId: row.area_id };
  }
  if (action === "paid") {
    if (row.status !== "approved" && row.status !== "pending") return { ok: false, status: 400, error: "承認済みの申込だけ、支払い済みにできます" };
    const settings = await getLandSettings(env);
    const unit = row.kind === "landmark" ? settings.landmarkUnitDays : settings.adUnitDays;
    const startsAt = Math.max(timeOrNull(raw.startsAt) ?? now, now - 60_000);
    const endsAt = startsAt + row.quantity * unit * DAY;
    if (await overlaps(env, row.area_id, row.spot, startsAt, endsAt)) {
      return { ok: false, status: 409, error: "その区画の同じ期間に、別の物が置かれています。始める日をずらしてください" };
    }
    const placementId = randomId(10);
    await env.DB.prepare(
      `INSERT INTO meta_placements (id, area_id, spot, kind, status, starts_at, ends_at, content, source, order_id, created_at, updated_at)
       VALUES (?,?,?,?, 'active', ?,?,?, 'order', ?, ?, ?)`
    )
      .bind(placementId, row.area_id, row.spot, row.kind, startsAt, endsAt, row.content, id, now, now)
      .run();
    await env.DB.prepare("UPDATE meta_orders SET status='paid', placement_id=?, admin_note=?, updated_at=? WHERE id=?").bind(placementId, note, now, id).run();
    return { ok: true, status: "paid", areaId: row.area_id };
  }
  if (action === "reject") {
    if (row.status === "paid") return { ok: false, status: 400, error: "掲載を始めた申込は、取り消しで終えてください" };
    await env.DB.prepare("UPDATE meta_orders SET status='rejected', reject_reason=?, admin_note=?, updated_at=? WHERE id=?")
      .bind(cleanText(raw.reason, 200), note, now, id)
      .run();
    return { ok: true, status: "rejected", areaId: row.area_id };
  }
  if (action === "cancel") {
    if (row.placement_id) await endPlacement(env, row.placement_id);
    await env.DB.prepare("UPDATE meta_orders SET status='cancelled', admin_note=?, updated_at=? WHERE id=?").bind(note, now, id).run();
    return { ok: true, status: "cancelled", areaId: row.area_id };
  }
  if (action === "note") {
    await env.DB.prepare("UPDATE meta_orders SET admin_note=?, updated_at=? WHERE id=?").bind(note, now, id).run();
    return { ok: true, status: row.status, areaId: row.area_id };
  }
  return { ok: false, status: 400, error: "操作が分かりません" };
}

export async function pendingOrderCount(env: MetaverseEnv): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM meta_orders WHERE status = 'pending'").first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------------------------------------------------------------- 広告の見られ方（回数だけ）

const AD_EVENTS = ["view", "click", "coupon"] as const;

/** 広告の鍵: p-<設置物のid> または o-<エリア>-<置く物のid>（エリアに置いた広告の看板） */
export function isAdKey(v: unknown): v is string {
  return typeof v === "string" && /^(p-[a-z0-9]{6,16}|o-[a-z0-9-]{3,32}-[a-z0-9-]{1,24})$/.test(v);
}

export async function recordAdEvent(env: MetaverseEnv, key: unknown, type: unknown): Promise<boolean> {
  if (!isAdKey(key) || !AD_EVENTS.includes(type as (typeof AD_EVENTS)[number])) return false;
  const day = new Date().toISOString().slice(0, 10);
  const col = type === "view" ? "views" : type === "click" ? "clicks" : "coupons";
  await env.DB.prepare(
    `INSERT INTO meta_ad_stats (ad_key, day, ${col}) VALUES (?, ?, 1) ON CONFLICT(ad_key, day) DO UPDATE SET ${col} = ${col} + 1`
  )
    .bind(key, day)
    .run();
  return true;
}

/** 管理画面「広告・クーポン」: エリアの広告看板と、区画の広告・ランドマークを、直近30日の回数つきで */
export async function listAdsAndCoupons(env: MetaverseEnv) {
  const since = new Date(Date.now() - 30 * DAY).toISOString().slice(0, 10);
  const stats = await env.DB.prepare("SELECT ad_key, SUM(views) AS v, SUM(clicks) AS c, SUM(coupons) AS k FROM meta_ad_stats WHERE day >= ? GROUP BY ad_key")
    .bind(since)
    .all<{ ad_key: string; v: number; c: number; k: number }>();
  const byKey = new Map((stats.results ?? []).map((s) => [s.ad_key, { views: s.v, clicks: s.c, coupons: s.k }]));
  const zero = { views: 0, clicks: 0, coupons: 0 };
  const items = [];
  for (const r of await listAdminRooms(env)) {
    for (const o of r.objects) {
      if (o.type !== "board" || (!o.ad && !o.couponCode && !o.linkUrl)) continue;
      const key = `o-${r.id}-${o.id}`;
      items.push({
        key,
        where: "area",
        areaId: r.id,
        areaName: r.name,
        areaState: r.state,
        spot: o.slot,
        title: o.title,
        ad: !!o.ad,
        sponsor: "",
        linkUrl: o.linkUrl ?? "",
        couponCode: o.couponCode ?? "",
        couponNote: o.couponNote ?? "",
        couponUntil: o.couponUntil ?? null,
        state: r.state === "open" ? "live" : "ended",
        startsAt: null,
        endsAt: r.closesAt,
        stats: byKey.get(key) ?? zero,
      });
    }
  }
  const rooms = new Map((await listAdminRooms(env)).map((r) => [r.id, r.name]));
  for (const p of await listPlacements(env)) {
    const key = `p-${p.id}`;
    items.push({
      key,
      where: "plot",
      placementId: p.id,
      areaId: p.areaId,
      areaName: rooms.get(p.areaId) ?? p.areaId,
      areaState: "",
      spot: p.spot,
      kind: p.kind,
      title: p.content.title || p.content.plaque || "",
      ad: p.kind === "ad",
      sponsor: p.content.sponsor,
      linkUrl: p.content.linkUrl,
      couponCode: p.content.couponCode,
      couponNote: p.content.couponNote,
      couponUntil: p.content.couponUntil,
      state: p.state,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      stats: byKey.get(key) ?? zero,
    });
  }
  return items;
}
