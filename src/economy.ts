/**
 * メタバースの通貨と、お店・提携店の引換券（経済圏）。
 *
 * ## 通貨の約束（ここを崩すと、法律上の扱いが変わる）
 *   - **お金で買えない。** 遊ぶ（毎日の入室・ミニゲームのクリア・分身どうしの会話）と貯まるだけ。
 *     お金で売ると「前払式支払手段」（資金決済法）になり、提携店で使えるなら第三者型として登録が要る
 *   - **お金に戻せない。** 払い戻し・換金の口は作らない（資金移動業・暗号資産の扱いにしない）
 *   - **人に渡せない。** 利用者どうしの送り合いは作らない（見知らぬ人・子どもどうしの「ちょうだい」の口にしない、RMT を防ぐ）
 *   - リアルで使うときは、**提携店の引換券**（特典・割引）に換える。お店の人が暗証番号で「使った」にする
 *     （提携店の特典は景品表示法の景品の上限に収まるよう、運営と提携店で決める。docs/METAVERSE.md）
 *
 * ## 貯まり方（どれも運営が管理画面で変えられる。1日の上限つき）
 *   - login: その日はじめてメタバースに入った（分身ごと1日1回）
 *   - clear: ミニゲームをクリアした（同じエリアの同じ屋台は1日1回）。クリアの判定は端末なので、
 *            額を小さく・1日の上限を必ず付ける（点数は受け取らない。「クリアした」ことだけ）
 *   - talk: メタバースで分身どうしが話した（部屋＝サーバーで確かめられる。1日の回数の上限つき）
 *   - grant: 運営が付与（キャンペーンなど。管理画面から。理由を必ず残す）
 *
 * 分身の識別子で持つ。会話・記憶は入れない。
 */

import { cleanLong, cleanText, cleanUrl, intIn, type MetaverseEnv } from "./metaverse";

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_MS = 9 * 60 * 60 * 1000;

/** 日本時間の日付（1日の上限の区切り） */
export function jstDay(now = Date.now()): string {
  return new Date(now + JST_MS).toISOString().slice(0, 10);
}
function jstMonth(now = Date.now()): string {
  return jstDay(now).slice(0, 7);
}

// ---------------------------------------------------------------- 設定

export interface EconomySettings {
  enabled: boolean;
  name: string;
  unit: string;
  symbol: string;
  loginBonus: number;
  clearReward: number;
  talkReward: number;
  /** 会話で貯まる回数（1日） */
  talkDailyMax: number;
  /** 遊んで貯まる額の上限（1日。運営の付与は含まない） */
  dailyEarnCap: number;
  maxBalance: number;
  /** リアルの引換券を受け付けるか（提携店が決まるまでは閉じておく） */
  realOpen: boolean;
  /** 引換券を発行できる枚数（1体・1か月） */
  voucherMonthlyLimit: number;
}

export const DEFAULT_ECONOMY: EconomySettings = {
  enabled: true,
  name: "たまコイン",
  unit: "コイン",
  symbol: "🪙",
  loginBonus: 10,
  clearReward: 5,
  talkReward: 2,
  talkDailyMax: 10,
  dailyEarnCap: 150,
  maxBalance: 99999,
  realOpen: false,
  voucherMonthlyLimit: 3,
};

export async function getEconomySettings(env: MetaverseEnv): Promise<EconomySettings> {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta_settings WHERE key = 'economy'").first<{ value: string }>();
    if (!row) return { ...DEFAULT_ECONOMY };
    return normalizeSettings(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_ECONOMY };
  }
}

function normalizeSettings(raw: Record<string, unknown>): EconomySettings {
  const d = DEFAULT_ECONOMY;
  return {
    enabled: raw.enabled !== false,
    name: cleanText(raw.name, 16) || d.name,
    unit: cleanText(raw.unit, 8) || d.unit,
    symbol: cleanText(raw.symbol, 4) || d.symbol,
    loginBonus: intIn(raw.loginBonus, 0, 1000, d.loginBonus),
    clearReward: intIn(raw.clearReward, 0, 1000, d.clearReward),
    talkReward: intIn(raw.talkReward, 0, 1000, d.talkReward),
    talkDailyMax: intIn(raw.talkDailyMax, 0, 100, d.talkDailyMax),
    dailyEarnCap: intIn(raw.dailyEarnCap, 0, 100000, d.dailyEarnCap),
    maxBalance: intIn(raw.maxBalance, 100, 10000000, d.maxBalance),
    realOpen: raw.realOpen === true,
    voucherMonthlyLimit: intIn(raw.voucherMonthlyLimit, 0, 100, d.voucherMonthlyLimit),
  };
}

export async function saveEconomySettings(env: MetaverseEnv, raw: Record<string, unknown>): Promise<EconomySettings> {
  const next = normalizeSettings({ ...(await getEconomySettings(env)), ...raw });
  await env.DB.prepare(
    "INSERT INTO meta_settings (key, value, updated_at) VALUES ('economy', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(JSON.stringify(next), Date.now())
    .run();
  return next;
}

// ---------------------------------------------------------------- 商品・お店

export const ITEM_KINDS = [
  { id: "wear", label: "身につける物（頭のかざり）" },
  { id: "effect", label: "演出（使うと消える。部屋のみんなに見える）" },
  { id: "real", label: "リアル引換券（提携店で使う）" },
] as const;
export const WEAR_SHAPES = [
  { id: "ribbon", label: "リボン" },
  { id: "flower", label: "お花" },
  { id: "leaf", label: "はっぱ" },
  { id: "star", label: "星のかざり" },
  { id: "strawhat", label: "麦わら帽子" },
  { id: "tophat", label: "シルクハット" },
  { id: "crown", label: "王冠" },
  { id: "halo", label: "天使の輪" },
] as const;
export const EFFECT_KINDS = [
  { id: "hanabi", label: "花火" },
  { id: "hearts", label: "ハート" },
  { id: "confetti", label: "紙ふぶき" },
  { id: "bubbles", label: "シャボン玉" },
] as const;

type ItemKind = (typeof ITEM_KINDS)[number]["id"];

export interface ShopItem {
  id: string;
  name: string;
  kind: ItemKind;
  price: number;
  description: string;
  icon: string;
  /** wear: 形と色（#rrggbb） */
  shape?: string;
  color?: string;
  /** effect: 種類 */
  effect?: string;
  /** real: 提携店・有効日数・1人1か月の上限・店頭での使い方 */
  partnerId?: string;
  validDays?: number;
  perPersonMonthly?: number;
  usage?: string;
  /** 在庫（null なら無制限） */
  stock: number | null;
  active: boolean;
  sortOrder: number;
  builtin?: boolean;
}

export interface Shop {
  id: string;
  name: string;
  description: string;
  /** お店の人のひとこと */
  keeper: string;
  itemIds: string[];
  active: boolean;
  sortOrder: number;
  builtin?: boolean;
}

const wear = (id: string, name: string, shape: string, color: string, price: number, icon: string, description: string, sortOrder: number): ShopItem => ({
  id, name, kind: "wear", price, description, icon, shape, color, stock: null, active: true, sortOrder, builtin: true,
});
const effect = (id: string, name: string, kind: string, price: number, icon: string, description: string, sortOrder: number): ShopItem => ({
  id, name, kind: "effect", price, description, icon, effect: kind, stock: null, active: true, sortOrder, builtin: true,
});

export const BUILTIN_ITEMS: ShopItem[] = [
  wear("w-ribbon", "ピンクのリボン", "ribbon", "#ff7aa8", 40, "🎀", "頭にちょこんと、かわいいリボン", 10),
  wear("w-flower", "ひまわりのお花", "flower", "#ffd23f", 40, "🌻", "元気が出る黄色いお花", 20),
  wear("w-leaf", "ふたばのはっぱ", "leaf", "#6fcf5a", 30, "🌱", "すくすく育つ、ふたばのしるし", 30),
  wear("w-star", "星のかざり", "star", "#ffe14d", 60, "⭐", "きらりと光る星", 40),
  wear("w-strawhat", "麦わら帽子", "strawhat", "#e8c86a", 80, "👒", "夏のおでかけに", 50),
  wear("w-tophat", "シルクハット", "tophat", "#2a2440", 120, "🎩", "ちょっとおしゃれに", 60),
  wear("w-halo", "天使の輪", "halo", "#fff3a0", 150, "😇", "ふわっと浮かぶ光の輪", 70),
  wear("w-crown", "王冠", "crown", "#f2c23a", 200, "👑", "がんばった子のあかし", 80),
  effect("e-hanabi", "打ち上げ花火", "hanabi", 15, "🎆", "使うと、部屋のみんなに花火が見える", 110),
  effect("e-hearts", "ハートふわふわ", "hearts", 10, "💕", "ハートがふわふわ浮かぶ", 120),
  effect("e-confetti", "紙ふぶき", "confetti", 10, "🎊", "お祝いの紙ふぶき", 130),
  effect("e-bubbles", "シャボン玉", "bubbles", 10, "🫧", "シャボン玉がふわり", 140),
];

export const BUILTIN_SHOPS: Shop[] = [
  { id: "zakka", name: "ひろばの雑貨屋", description: "頭のかざりと、ちょっとした演出", keeper: "いらっしゃい！ 遊んで貯めたコインで、おしゃれしていってね", itemIds: ["w-ribbon", "w-flower", "w-leaf", "w-star", "e-bubbles"], active: true, sortOrder: 10, builtin: true },
  { id: "boushi", name: "おかしの国の帽子屋", description: "特別な帽子と王冠", keeper: "とっておきの帽子がそろっていますよ", itemIds: ["w-strawhat", "w-tophat", "w-halo", "w-crown"], active: true, sortOrder: 20, builtin: true },
  { id: "hanabi", name: "お祭りの花火屋", description: "みんなに見える演出", keeper: "ぱーっと打ち上げて、みんなを楽しませよう！", itemIds: ["e-hanabi", "e-hearts", "e-confetti", "e-bubbles"], active: true, sortOrder: 30, builtin: true },
  { id: "koukan", name: "わけたま引き換え所", description: "コインを、提携店で使える引換券にかえる", keeper: "貯めたコインを、町のお店で使える引換券にかえられます", itemIds: [], active: true, sortOrder: 40, builtin: true },
];

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[a-z0-9-]{2,24}$/;

function randomId(prefix: string, n = 6): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return `${prefix}${[...bytes].map((b) => alphabet[b % alphabet.length]).join("")}`;
}

export function sanitizeItem(raw: Record<string, unknown>): { ok: true; value: ShopItem } | { ok: false; error: string } {
  const kind = (ITEM_KINDS.find((k) => k.id === raw.kind)?.id ?? "wear") as ItemKind;
  const name = cleanText(raw.name, 24);
  if (!name) return { ok: false, error: "商品の名前を入れてください" };
  const id = typeof raw.id === "string" && ID.test(raw.id) ? raw.id : randomId(kind === "real" ? "r-" : kind === "effect" ? "e-" : "w-");
  const item: ShopItem = {
    id,
    name,
    kind,
    price: intIn(raw.price, 1, 1000000, 50),
    description: cleanText(raw.description, 80),
    icon: cleanText(raw.icon, 4) || (kind === "real" ? "🎟" : kind === "effect" ? "✨" : "🎀"),
    stock: raw.stock === null || raw.stock === "" || raw.stock === undefined ? null : intIn(raw.stock, 0, 1000000, 0),
    active: raw.active !== false,
    sortOrder: intIn(raw.sortOrder, 0, 9999, 100),
  };
  if (kind === "wear") {
    item.shape = (WEAR_SHAPES.find((s) => s.id === raw.shape)?.id ?? "ribbon") as string;
    item.color = typeof raw.color === "string" && HEX.test(raw.color) ? raw.color.toLowerCase() : "#ff7aa8";
  } else if (kind === "effect") {
    item.effect = (EFFECT_KINDS.find((s) => s.id === raw.effect)?.id ?? "hanabi") as string;
  } else {
    const partnerId = typeof raw.partnerId === "string" && ID.test(raw.partnerId) ? raw.partnerId : "";
    if (!partnerId) return { ok: false, error: "リアル引換券は、提携店を選んでください" };
    item.partnerId = partnerId;
    item.validDays = intIn(raw.validDays, 1, 365, 30);
    item.perPersonMonthly = intIn(raw.perPersonMonthly, 1, 31, 1);
    item.usage = cleanLong(raw.usage, 200);
  }
  return { ok: true, value: item };
}

export function sanitizeShop(raw: Record<string, unknown>): { ok: true; value: Shop } | { ok: false; error: string } {
  const name = cleanText(raw.name, 24);
  if (!name) return { ok: false, error: "お店の名前を入れてください" };
  const ids = Array.isArray(raw.itemIds) ? raw.itemIds.filter((x): x is string => typeof x === "string" && ID.test(x)) : [];
  return {
    ok: true,
    value: {
      id: typeof raw.id === "string" && ID.test(raw.id) ? raw.id : randomId("s-"),
      name,
      description: cleanText(raw.description, 60),
      keeper: cleanText(raw.keeper, 60),
      itemIds: [...new Set(ids)].slice(0, 24),
      active: raw.active !== false,
      sortOrder: intIn(raw.sortOrder, 0, 9999, 100),
    },
  };
}

async function overrides<T>(env: MetaverseEnv, table: "meta_items" | "meta_shops"): Promise<Map<string, T | null>> {
  const out = new Map<string, T | null>();
  try {
    const rows = await env.DB.prepare(`SELECT id, data FROM ${table}`).all<{ id: string; data: string }>();
    for (const r of rows.results ?? []) {
      try {
        const parsed = JSON.parse(r.data);
        out.set(r.id, parsed && parsed.deleted ? null : (parsed as T));
      } catch {
        /* 壊れた行は無視 */
      }
    }
  } catch {
    /* 表がまだ無い（移行前） */
  }
  return out;
}

export async function listItems(env: MetaverseEnv): Promise<ShopItem[]> {
  const db = await overrides<Record<string, unknown>>(env, "meta_items");
  const out: ShopItem[] = [];
  for (const b of BUILTIN_ITEMS) {
    if (!db.has(b.id)) out.push(b);
    else {
      const o = db.get(b.id);
      if (o) {
        const r = sanitizeItem({ ...b, ...o, id: b.id, kind: b.kind });
        if (r.ok) out.push({ ...r.value, builtin: true });
      }
    }
  }
  for (const [id, o] of db) {
    if (!o || BUILTIN_ITEMS.some((b) => b.id === id)) continue;
    const r = sanitizeItem({ ...o, id });
    if (r.ok) out.push(r.value);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function listShops(env: MetaverseEnv): Promise<Shop[]> {
  const db = await overrides<Record<string, unknown>>(env, "meta_shops");
  const out: Shop[] = [];
  for (const b of BUILTIN_SHOPS) {
    if (!db.has(b.id)) out.push(b);
    else {
      const o = db.get(b.id);
      if (o) {
        const r = sanitizeShop({ ...b, ...o, id: b.id });
        if (r.ok) out.push({ ...r.value, builtin: true });
      }
    }
  }
  for (const [id, o] of db) {
    if (!o || BUILTIN_SHOPS.some((b) => b.id === id)) continue;
    const r = sanitizeShop({ ...o, id });
    if (r.ok) out.push(r.value);
  }
  return out.sort((a, b) => a.sortOrder - b.sortOrder);
}

export async function saveItem(env: MetaverseEnv, raw: Record<string, unknown>): Promise<{ ok: true; item: ShopItem } | { ok: false; error: string }> {
  const builtin = BUILTIN_ITEMS.find((b) => b.id === raw.id);
  const r = sanitizeItem(builtin ? { ...raw, kind: builtin.kind } : raw);
  if (!r.ok) return r;
  if (r.value.kind === "real") {
    const partner = await getPartner(env, r.value.partnerId!);
    if (!partner) return { ok: false, error: "その提携店はありません" };
  }
  const { builtin: _b, ...data } = r.value;
  await env.DB.prepare("INSERT INTO meta_items (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(r.value.id, JSON.stringify(data), Date.now())
    .run();
  return { ok: true, item: r.value };
}

/** 消す（最初からある商品は「出さない」にする。持っている人の持ち物は消さない） */
export async function deleteItem(env: MetaverseEnv, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !ID.test(id)) return false;
  await env.DB.prepare("INSERT INTO meta_items (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(id, JSON.stringify({ deleted: true }), Date.now())
    .run();
  return true;
}

export async function saveShop(env: MetaverseEnv, raw: Record<string, unknown>): Promise<{ ok: true; shop: Shop } | { ok: false; error: string }> {
  const r = sanitizeShop(raw);
  if (!r.ok) return r;
  const { builtin: _b, ...data } = r.value;
  await env.DB.prepare("INSERT INTO meta_shops (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(r.value.id, JSON.stringify(data), Date.now())
    .run();
  return { ok: true, shop: r.value };
}

export async function deleteShop(env: MetaverseEnv, id: unknown): Promise<boolean> {
  if (typeof id !== "string" || !ID.test(id)) return false;
  await env.DB.prepare("INSERT INTO meta_shops (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
    .bind(id, JSON.stringify({ deleted: true }), Date.now())
    .run();
  return true;
}

// ---------------------------------------------------------------- 提携店

export interface Partner {
  id: string;
  name: string;
  area: string;
  address: string;
  url: string;
  note: string;
  active: boolean;
}

async function hashPin(partnerId: string, pin: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`partner:${partnerId}:${pin}`));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newPin(): string {
  const bytes = crypto.getRandomValues(new Uint32Array(1));
  return String(bytes[0] % 100000000).padStart(8, "0");
}

function partnerFromRow(r: { id: string; data: string; active: number }): Partner {
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(r.data);
  } catch {
    d = {};
  }
  return {
    id: r.id,
    name: cleanText(d.name, 30),
    area: cleanText(d.area, 30),
    address: cleanText(d.address, 80),
    url: cleanUrl(d.url),
    note: cleanText(d.note, 120),
    active: r.active === 1,
  };
}

export async function listPartners(env: MetaverseEnv): Promise<Partner[]> {
  try {
    const rows = await env.DB.prepare("SELECT id, data, active FROM meta_partners ORDER BY created_at").all<{ id: string; data: string; active: number }>();
    return (rows.results ?? []).map(partnerFromRow);
  } catch {
    return [];
  }
}

export async function getPartner(env: MetaverseEnv, id: string): Promise<Partner | null> {
  const r = await env.DB.prepare("SELECT id, data, active FROM meta_partners WHERE id = ?").bind(id).first<{ id: string; data: string; active: number }>();
  return r ? partnerFromRow(r) : null;
}

/**
 * 提携店を作る・直す。新しく作ったとき（と resetPin のとき）だけ、お店の暗証番号を1回だけ返す。
 * 暗証番号そのものは保存しない（なくしたら作り直す）。
 */
export async function savePartner(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; partner: Partner; pin: string | null } | { ok: false; error: string }> {
  const name = cleanText(raw.name, 30);
  if (!name) return { ok: false, error: "提携店の名前を入れてください" };
  const now = Date.now();
  const existing = typeof raw.id === "string" && ID.test(raw.id) ? await getPartner(env, raw.id) : null;
  const id = existing ? existing.id : randomId("p-");
  const data = {
    name,
    area: cleanText(raw.area, 30),
    address: cleanText(raw.address, 80),
    url: cleanUrl(raw.url),
    note: cleanText(raw.note, 120),
  };
  const active = raw.active === false ? 0 : 1;
  let pin: string | null = null;
  if (!existing || raw.resetPin === true) pin = newPin();
  if (existing) {
    if (pin) {
      await env.DB.prepare("UPDATE meta_partners SET data = ?, active = ?, pin_hash = ?, updated_at = ? WHERE id = ?")
        .bind(JSON.stringify(data), active, await hashPin(id, pin), now, id)
        .run();
    } else {
      await env.DB.prepare("UPDATE meta_partners SET data = ?, active = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(data), active, now, id).run();
    }
  } else {
    await env.DB.prepare("INSERT INTO meta_partners (id, data, pin_hash, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, JSON.stringify(data), await hashPin(id, pin!), active, now, now)
      .run();
  }
  return { ok: true, partner: { id, ...data, active: active === 1 }, pin };
}

// ---------------------------------------------------------------- 財布

export interface LedgerEntry {
  delta: number;
  balance: number;
  kind: string;
  note: string;
  at: number;
}

export interface Voucher {
  code: string;
  itemId: string;
  partnerId: string;
  partnerName: string;
  title: string;
  note: string;
  price: number;
  status: "issued" | "used" | "cancelled" | "expired";
  issuedAt: number;
  expiresAt: number | null;
  usedAt: number | null;
}

async function balanceOf(env: MetaverseEnv, cid: string): Promise<number> {
  const r = await env.DB.prepare("SELECT balance FROM meta_wallets WHERE character_id = ?").bind(cid).first<{ balance: number }>();
  return r?.balance ?? 0;
}

const EARN_KINDS = ["login", "clear", "talk"];

async function earnedToday(env: MetaverseEnv, cid: string, day: string): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(delta), 0) AS s FROM meta_ledger WHERE character_id = ? AND day = ? AND kind IN ('login','clear','talk')`
  )
    .bind(cid, day)
    .first<{ s: number }>();
  return r?.s ?? 0;
}

async function addLedger(env: MetaverseEnv, cid: string, delta: number, balance: number, kind: string, ref: string, note: string, now: number) {
  await env.DB.prepare("INSERT INTO meta_ledger (character_id, delta, balance, kind, ref, note, day, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(cid, delta, balance, kind, ref.slice(0, 80), note.slice(0, 80), jstDay(now), now)
    .run();
}

/** 残高を増やす（上限で止める）。増えた後の残高と、実際に増えた額を返す */
async function credit(env: MetaverseEnv, cid: string, amount: number, max: number, now: number, countAsEarned: boolean): Promise<{ balance: number; added: number }> {
  const before = await balanceOf(env, cid);
  const added = Math.max(0, Math.min(amount, max - before));
  const row = await env.DB.prepare(
    `INSERT INTO meta_wallets (character_id, balance, earned, spent, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)
     ON CONFLICT(character_id) DO UPDATE SET balance = MIN(balance + excluded.balance, ?), earned = earned + excluded.earned, updated_at = excluded.updated_at
     RETURNING balance`
  )
    .bind(cid, added, countAsEarned ? added : 0, now, now, max)
    .first<{ balance: number }>();
  return { balance: row?.balance ?? before + added, added };
}

export type EarnKind = "login" | "clear" | "talk";

/**
 * 遊んで貯まる（部屋＝サーバーから呼ぶ）。貯まらなかったときは理由を返す（画面は何も出さない）。
 * @param ref login: 空 / clear: 「エリア:屋台」 / talk: 空
 */
export async function earn(
  env: MetaverseEnv,
  cid: string,
  kind: EarnKind,
  ref = "",
  now = Date.now()
): Promise<{ ok: true; amount: number; balance: number; kind: EarnKind } | { ok: false; reason: string }> {
  const s = await getEconomySettings(env);
  if (!s.enabled) return { ok: false, reason: "disabled" };
  const base = kind === "login" ? s.loginBonus : kind === "clear" ? s.clearReward : s.talkReward;
  if (base <= 0) return { ok: false, reason: "zero" };
  const day = jstDay(now);
  if (kind === "login" || kind === "clear") {
    const dup = await env.DB.prepare("SELECT 1 FROM meta_ledger WHERE character_id = ? AND day = ? AND kind = ? AND ref = ? LIMIT 1")
      .bind(cid, day, kind, ref.slice(0, 80))
      .first();
    if (dup) return { ok: false, reason: "already" };
  } else {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM meta_ledger WHERE character_id = ? AND day = ? AND kind = 'talk'").bind(cid, day).first<{ n: number }>();
    if ((r?.n ?? 0) >= s.talkDailyMax) return { ok: false, reason: "talk_limit" };
  }
  const today = await earnedToday(env, cid, day);
  const amount = Math.min(base, Math.max(0, s.dailyEarnCap - today));
  if (amount <= 0) return { ok: false, reason: "daily_cap" };
  const { balance, added } = await credit(env, cid, amount, s.maxBalance, now, true);
  if (added <= 0) return { ok: false, reason: "max_balance" };
  const note = kind === "login" ? "今日はじめての入室" : kind === "clear" ? "ミニゲームをクリア" : "分身どうしの会話";
  await addLedger(env, cid, added, balance, kind, ref, note, now);
  return { ok: true, amount: added, balance, kind };
}

/** 運営の付与・回収（管理画面。理由を必ず残す）。回収は残高より多くは引かない */
export async function grant(env: MetaverseEnv, cid: string, amount: number, note: string, now = Date.now()): Promise<{ ok: true; balance: number; delta: number } | { ok: false; error: string }> {
  if (!cid || cid.length > 200) return { ok: false, error: "分身のIDを入れてください" };
  const reason = cleanText(note, 60);
  if (!reason) return { ok: false, error: "理由を入れてください（出入りの記録に残ります）" };
  if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000000) return { ok: false, error: "額は0以外の整数にしてください" };
  const s = await getEconomySettings(env);
  if (amount > 0) {
    const { balance, added } = await credit(env, cid, amount, s.maxBalance, now, false);
    if (added <= 0) return { ok: false, error: "残高の上限に達しています" };
    await addLedger(env, cid, added, balance, "grant", "", `運営: ${reason}`, now);
    return { ok: true, balance, delta: added };
  }
  const before = await balanceOf(env, cid);
  const take = Math.min(before, -amount);
  if (take <= 0) return { ok: false, error: "残高がありません" };
  const row = await env.DB.prepare("UPDATE meta_wallets SET balance = balance - ?, updated_at = ? WHERE character_id = ? AND balance >= ? RETURNING balance")
    .bind(take, now, cid, take)
    .first<{ balance: number }>();
  if (!row) return { ok: false, error: "残高が足りません" };
  await addLedger(env, cid, -take, row.balance, "grant", "", `運営: ${reason}`, now);
  return { ok: true, balance: row.balance, delta: -take };
}

function voucherView(r: Record<string, unknown>, partners: Map<string, Partner>, now: number): Voucher {
  const status = String(r.status) as Voucher["status"];
  const expiresAt = (r.expires_at as number | null) ?? null;
  return {
    code: String(r.code),
    itemId: String(r.item_id),
    partnerId: String(r.partner_id),
    partnerName: partners.get(String(r.partner_id))?.name ?? "",
    title: String(r.title),
    note: String(r.note ?? ""),
    price: Number(r.price),
    status: status === "issued" && expiresAt && now > expiresAt ? "expired" : status,
    issuedAt: Number(r.issued_at),
    expiresAt,
    usedAt: (r.used_at as number | null) ?? null,
  };
}

export async function walletView(env: MetaverseEnv, cid: string, now = Date.now()) {
  const settings = await getEconomySettings(env);
  const [w, inv, led, vr, items, partners] = await Promise.all([
    env.DB.prepare("SELECT balance, earned, spent FROM meta_wallets WHERE character_id = ?").bind(cid).first<{ balance: number; earned: number; spent: number }>(),
    env.DB.prepare("SELECT item_id, qty, equipped FROM meta_inventory WHERE character_id = ? AND qty > 0 ORDER BY acquired_at").bind(cid).all<{ item_id: string; qty: number; equipped: number }>(),
    env.DB.prepare("SELECT delta, balance, kind, note, created_at FROM meta_ledger WHERE character_id = ? ORDER BY id DESC LIMIT 40").bind(cid).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM meta_vouchers WHERE character_id = ? ORDER BY issued_at DESC LIMIT 30").bind(cid).all<Record<string, unknown>>(),
    listItems(env),
    listPartners(env),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const pmap = new Map(partners.map((p) => [p.id, p]));
  return {
    settings: publicSettings(settings),
    balance: w?.balance ?? 0,
    earned: w?.earned ?? 0,
    spent: w?.spent ?? 0,
    todayEarned: await earnedToday(env, cid, jstDay(now)),
    inventory: (inv.results ?? []).map((r) => {
      const item = byId.get(r.item_id) ?? BUILTIN_ITEMS.find((b) => b.id === r.item_id);
      return { itemId: r.item_id, qty: r.qty, equipped: r.equipped === 1, item: item ? publicItem(item) : null };
    }),
    ledger: (led.results ?? []).map((r) => ({ delta: Number(r.delta), balance: Number(r.balance), kind: String(r.kind), note: String(r.note), at: Number(r.created_at) })),
    vouchers: (vr.results ?? []).map((r) => voucherView(r, pmap, now)),
  };
}

export function publicSettings(s: EconomySettings) {
  return {
    enabled: s.enabled,
    name: s.name,
    unit: s.unit,
    symbol: s.symbol,
    loginBonus: s.loginBonus,
    clearReward: s.clearReward,
    talkReward: s.talkReward,
    talkDailyMax: s.talkDailyMax,
    dailyEarnCap: s.dailyEarnCap,
    realOpen: s.realOpen,
    voucherMonthlyLimit: s.voucherMonthlyLimit,
  };
}

function publicItem(i: ShopItem) {
  return {
    id: i.id,
    name: i.name,
    kind: i.kind,
    price: i.price,
    description: i.description,
    icon: i.icon,
    shape: i.shape,
    color: i.color,
    effect: i.effect,
    partnerId: i.partnerId,
    validDays: i.validDays,
    usage: i.usage,
  };
}

/** お店の中身（その分身から見た、持っている・売り切れ・今月の残り） */
export async function shopView(env: MetaverseEnv, cid: string, shopId: string, now = Date.now()) {
  const settings = await getEconomySettings(env);
  const shop = (await listShops(env)).find((s) => s.id === shopId && s.active);
  if (!shop) return null;
  const items = await listItems(env);
  const partners = new Map((await listPartners(env)).map((p) => [p.id, p]));
  const owned = new Map<string, number>();
  const inv = await env.DB.prepare("SELECT item_id, qty FROM meta_inventory WHERE character_id = ?").bind(cid).all<{ item_id: string; qty: number }>();
  for (const r of inv.results ?? []) owned.set(r.item_id, r.qty);
  const month = jstMonth(now);
  const monthV = await env.DB.prepare("SELECT item_id, COUNT(*) AS n FROM meta_vouchers WHERE character_id = ? AND month = ? AND status != 'cancelled' GROUP BY item_id")
    .bind(cid, month)
    .all<{ item_id: string; n: number }>();
  const monthly = new Map((monthV.results ?? []).map((r) => [r.item_id, r.n]));
  const monthTotal = [...monthly.values()].reduce((a, b) => a + b, 0);
  const sold = new Map<string, number>();
  const soldRows = await env.DB.prepare("SELECT item_id, sold FROM meta_item_sold").all<{ item_id: string; sold: number }>();
  for (const r of soldRows.results ?? []) sold.set(r.item_id, r.sold);
  const list = shop.itemIds
    .map((id) => items.find((i) => i.id === id && i.active))
    .filter((i): i is ShopItem => !!i)
    .filter((i) => i.kind !== "real" || (i.partnerId && partners.get(i.partnerId)?.active))
    .map((i) => {
      const left = i.stock === null ? null : Math.max(0, i.stock - (sold.get(i.id) ?? 0));
      const partner = i.partnerId ? partners.get(i.partnerId) : undefined;
      let blocked = "";
      if (left === 0) blocked = "売り切れ";
      else if (i.kind === "wear" && (owned.get(i.id) ?? 0) > 0) blocked = "持っています";
      else if (i.kind === "real" && !settings.realOpen) blocked = "引き換えは準備中です";
      else if (i.kind === "real" && (monthly.get(i.id) ?? 0) >= (i.perPersonMonthly ?? 1)) blocked = "今月はもう引き換えました";
      else if (i.kind === "real" && monthTotal >= settings.voucherMonthlyLimit) blocked = `引換券は1か月${settings.voucherMonthlyLimit}枚までです`;
      return {
        ...publicItem(i),
        left,
        owned: owned.get(i.id) ?? 0,
        blocked,
        partner: partner ? { name: partner.name, area: partner.area, address: partner.address, url: partner.url, note: partner.note } : null,
      };
    });
  return {
    settings: publicSettings(settings),
    shop: { id: shop.id, name: shop.name, description: shop.description, keeper: shop.keeper },
    items: list,
    balance: await balanceOf(env, cid),
  };
}

const VOUCHER_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function voucherCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return [...bytes].map((b) => VOUCHER_ALPHABET[b % VOUCHER_ALPHABET.length]).join("");
}

/**
 * 買う。順番: 在庫を押さえる → 残高を引く（足りなければ在庫を戻す）→ 持ち物・引換券を作る。
 * 残高は「足りるときだけ引く」1文の更新なので、同時に2回押しても負にならない。
 */
export async function buy(
  env: MetaverseEnv,
  cid: string,
  shopId: string,
  itemId: string,
  now = Date.now()
): Promise<{ ok: true; balance: number; item: ReturnType<typeof publicItem>; voucher: Voucher | null } | { ok: false; error: string }> {
  const settings = await getEconomySettings(env);
  if (!settings.enabled) return { ok: false, error: "いまはお店がお休みです" };
  const view = await shopView(env, cid, shopId, now);
  if (!view) return { ok: false, error: "そのお店はいま開いていません" };
  const entry = view.items.find((i) => i.id === itemId);
  if (!entry) return { ok: false, error: "その商品はこのお店にありません" };
  if (entry.blocked) return { ok: false, error: entry.blocked };
  const item = (await listItems(env)).find((i) => i.id === itemId)!;
  if (view.balance < item.price) return { ok: false, error: `${settings.name}が足りません` };

  // 在庫
  if (item.stock !== null) {
    const r = await env.DB.prepare(
      "INSERT INTO meta_item_sold (item_id, sold) VALUES (?, 1) ON CONFLICT(item_id) DO UPDATE SET sold = sold + 1 WHERE sold < ? RETURNING sold"
    )
      .bind(itemId, item.stock)
      .first<{ sold: number }>();
    if (!r || r.sold > item.stock) return { ok: false, error: "売り切れました" };
  }
  const unreserve = async () => {
    if (item.stock !== null) await env.DB.prepare("UPDATE meta_item_sold SET sold = MAX(0, sold - 1) WHERE item_id = ?").bind(itemId).run();
  };
  const paid = await env.DB.prepare(
    "UPDATE meta_wallets SET balance = balance - ?, spent = spent + ?, updated_at = ? WHERE character_id = ? AND balance >= ? RETURNING balance"
  )
    .bind(item.price, item.price, now, cid, item.price)
    .first<{ balance: number }>();
  if (!paid) {
    await unreserve();
    return { ok: false, error: `${settings.name}が足りません` };
  }
  let voucher: Voucher | null = null;
  try {
    if (item.kind === "real") {
      const partner = await getPartner(env, item.partnerId!);
      let code = voucherCode();
      for (let i = 0; i < 3; i++) {
        const clash = await env.DB.prepare("SELECT 1 FROM meta_vouchers WHERE code = ?").bind(code).first();
        if (!clash) break;
        code = voucherCode();
      }
      const expiresAt = now + (item.validDays ?? 30) * DAY_MS;
      await env.DB.prepare(
        "INSERT INTO meta_vouchers (code, character_id, item_id, partner_id, title, note, price, status, month, issued_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'issued', ?, ?, ?)"
      )
        .bind(code, cid, item.id, item.partnerId, item.name, item.usage ?? "", item.price, jstMonth(now), now, expiresAt)
        .run();
      voucher = {
        code,
        itemId: item.id,
        partnerId: item.partnerId!,
        partnerName: partner?.name ?? "",
        title: item.name,
        note: item.usage ?? "",
        price: item.price,
        status: "issued",
        issuedAt: now,
        expiresAt,
        usedAt: null,
      };
    } else {
      await env.DB.prepare(
        "INSERT INTO meta_inventory (character_id, item_id, qty, equipped, acquired_at) VALUES (?, ?, 1, 0, ?) ON CONFLICT(character_id, item_id) DO UPDATE SET qty = qty + 1"
      )
        .bind(cid, item.id, now)
        .run();
    }
    await addLedger(env, cid, -item.price, paid.balance, "buy", `${shopId}:${item.id}`, `${view.shop.name}で「${item.name}」`, now);
  } catch (e) {
    // 渡せなかったら返金する
    await env.DB.prepare("UPDATE meta_wallets SET balance = balance + ?, spent = spent - ? WHERE character_id = ?").bind(item.price, item.price, cid).run();
    await unreserve();
    throw e;
  }
  return { ok: true, balance: paid.balance, item: publicItem(item), voucher };
}

/** 身につける（頭のかざりは1つだけ）。外すときは on=false */
export async function equip(env: MetaverseEnv, cid: string, itemId: string, on: boolean): Promise<{ ok: true; wear: { shape: string; color: string } | null } | { ok: false; error: string }> {
  const items = await listItems(env);
  const item = items.find((i) => i.id === itemId) ?? BUILTIN_ITEMS.find((i) => i.id === itemId);
  if (!item || item.kind !== "wear") return { ok: false, error: "身につけられる物ではありません" };
  const have = await env.DB.prepare("SELECT qty FROM meta_inventory WHERE character_id = ? AND item_id = ?").bind(cid, itemId).first<{ qty: number }>();
  if (!have || have.qty <= 0) return { ok: false, error: "持っていません" };
  await env.DB.batch([
    env.DB.prepare("UPDATE meta_inventory SET equipped = 0 WHERE character_id = ?").bind(cid),
    ...(on ? [env.DB.prepare("UPDATE meta_inventory SET equipped = 1 WHERE character_id = ? AND item_id = ?").bind(cid, itemId)] : []),
  ]);
  return { ok: true, wear: on ? { shape: item.shape!, color: item.color! } : null };
}

/** いま身につけている物（部屋が入室のときに読む） */
export async function equippedWear(env: MetaverseEnv, cid: string): Promise<{ shape: string; color: string } | null> {
  try {
    const r = await env.DB.prepare("SELECT item_id FROM meta_inventory WHERE character_id = ? AND equipped = 1 AND qty > 0 LIMIT 1").bind(cid).first<{ item_id: string }>();
    if (!r) return null;
    const item = (await listItems(env)).find((i) => i.id === r.item_id) ?? BUILTIN_ITEMS.find((i) => i.id === r.item_id);
    return item && item.kind === "wear" ? { shape: item.shape!, color: item.color! } : null;
  } catch {
    return null;
  }
}

/** 演出を使う（1つ減る）。部屋が、みんなに配る */
export async function consumeEffect(env: MetaverseEnv, cid: string, itemId: string): Promise<{ ok: true; effect: string; left: number } | { ok: false; error: string }> {
  const item = (await listItems(env)).find((i) => i.id === itemId) ?? BUILTIN_ITEMS.find((i) => i.id === itemId);
  if (!item || item.kind !== "effect") return { ok: false, error: "使える物ではありません" };
  const r = await env.DB.prepare("UPDATE meta_inventory SET qty = qty - 1 WHERE character_id = ? AND item_id = ? AND qty > 0 RETURNING qty")
    .bind(cid, itemId)
    .first<{ qty: number }>();
  if (!r) return { ok: false, error: "持っていません" };
  return { ok: true, effect: item.effect!, left: r.qty };
}

// ---------------------------------------------------------------- 店頭（提携店）での引き換え

export function normalizeCode(v: unknown): string {
  return typeof v === "string" ? v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12) : "";
}

/**
 * お店の人が、引換券を確かめる／使ったにする。暗証番号が、その引換券の提携店のものと合うときだけ中身を返す
 * （合わないときは「見つからない」と同じ返事にして、ほかの店の券かどうかも分からないようにする）。
 */
export async function redeem(
  env: MetaverseEnv,
  codeRaw: unknown,
  pinRaw: unknown,
  use: boolean,
  now = Date.now()
): Promise<{ ok: true; voucher: Voucher; justUsed: boolean } | { ok: false; error: string }> {
  const code = normalizeCode(codeRaw);
  const pin = typeof pinRaw === "string" ? pinRaw.replace(/\D/g, "").slice(0, 12) : "";
  if (code.length !== 10 || pin.length < 6) return { ok: false, error: "引換券の番号と、お店の暗証番号を入れてください" };
  const row = await env.DB.prepare("SELECT * FROM meta_vouchers WHERE code = ?").bind(code).first<Record<string, unknown>>();
  const notFound = { ok: false as const, error: "この番号の引換券は見つかりません（番号と暗証番号をお確かめください）" };
  if (!row) return notFound;
  const p = await env.DB.prepare("SELECT id, data, active, pin_hash FROM meta_partners WHERE id = ?").bind(row.partner_id).first<{ id: string; data: string; active: number; pin_hash: string }>();
  if (!p || p.pin_hash !== (await hashPin(p.id, pin))) return notFound;
  const partners = new Map([[p.id, partnerFromRow(p)]]);
  const v = voucherView(row, partners, now);
  if (!use) return { ok: true, voucher: v, justUsed: false };
  if (v.status !== "issued") return { ok: false, error: v.status === "used" ? "この引換券は使用済みです" : v.status === "expired" ? "この引換券は期限切れです" : "この引換券は取り消されています" };
  const upd = await env.DB.prepare("UPDATE meta_vouchers SET status = 'used', used_at = ? WHERE code = ? AND status = 'issued'").bind(now, code).run();
  if (!upd.meta.changes) return { ok: false, error: "この引換券は使用済みです" };
  return { ok: true, voucher: { ...v, status: "used", usedAt: now }, justUsed: true };
}

/** 運営が引換券を取り消す（refund なら通貨を戻す） */
export async function cancelVoucher(env: MetaverseEnv, codeRaw: unknown, refund: boolean, now = Date.now()): Promise<{ ok: true } | { ok: false; error: string }> {
  const code = normalizeCode(codeRaw);
  const row = await env.DB.prepare("SELECT character_id, price, status, title FROM meta_vouchers WHERE code = ?").bind(code).first<{ character_id: string; price: number; status: string; title: string }>();
  if (!row) return { ok: false, error: "その引換券はありません" };
  if (row.status !== "issued") return { ok: false, error: "使用済み・取り消し済みの引換券は取り消せません" };
  await env.DB.prepare("UPDATE meta_vouchers SET status = 'cancelled' WHERE code = ? AND status = 'issued'").bind(code).run();
  if (refund) {
    const s = await getEconomySettings(env);
    const { balance, added } = await credit(env, row.character_id, row.price, s.maxBalance, now, false);
    if (added > 0) await addLedger(env, row.character_id, added, balance, "refund", code, `引換券の取り消し「${row.title}」`, now);
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 管理画面の集計

export async function economyStats(env: MetaverseEnv, now = Date.now()) {
  const since = now - 30 * DAY_MS;
  const [w, kinds, vouchers, topItems] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS wallets, COALESCE(SUM(balance),0) AS circulating, COALESCE(SUM(earned),0) AS earned, COALESCE(SUM(spent),0) AS spent FROM meta_wallets").first<{
      wallets: number;
      circulating: number;
      earned: number;
      spent: number;
    }>(),
    env.DB.prepare("SELECT kind, COUNT(*) AS n, COALESCE(SUM(delta),0) AS total FROM meta_ledger WHERE created_at >= ? GROUP BY kind").bind(since).all<{ kind: string; n: number; total: number }>(),
    env.DB.prepare("SELECT partner_id, status, COUNT(*) AS n, COALESCE(SUM(price),0) AS coins FROM meta_vouchers GROUP BY partner_id, status").all<{ partner_id: string; status: string; n: number; coins: number }>(),
    env.DB.prepare("SELECT ref, COUNT(*) AS n FROM meta_ledger WHERE kind = 'buy' AND created_at >= ? GROUP BY ref ORDER BY n DESC LIMIT 10").bind(since).all<{ ref: string; n: number }>(),
  ]);
  return {
    wallets: w?.wallets ?? 0,
    circulating: w?.circulating ?? 0,
    earned: w?.earned ?? 0,
    spent: w?.spent ?? 0,
    last30: kinds.results ?? [],
    vouchers: vouchers.results ?? [],
    topItems: (topItems.results ?? []).map((r) => ({ itemId: r.ref.split(":")[1] ?? r.ref, shopId: r.ref.split(":")[0] ?? "", n: r.n })),
  };
}

export async function listVouchers(env: MetaverseEnv, filter: { partnerId?: string; status?: string } = {}, now = Date.now()): Promise<Voucher[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (filter.partnerId) {
    where.push("partner_id = ?");
    binds.push(filter.partnerId);
  }
  if (filter.status && ["issued", "used", "cancelled"].includes(filter.status)) {
    where.push("status = ?");
    binds.push(filter.status);
  }
  const rows = await env.DB.prepare(`SELECT * FROM meta_vouchers ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY issued_at DESC LIMIT 200`)
    .bind(...binds)
    .all<Record<string, unknown>>();
  const partners = new Map((await listPartners(env)).map((p) => [p.id, p]));
  return (rows.results ?? []).map((r) => voucherView(r, partners, now));
}

/** 1体の出入りの記録（管理画面で問い合わせに答えるとき） */
export async function walletForAdmin(env: MetaverseEnv, cid: string) {
  return walletView(env, cid);
}

export const ECONOMY_EARN_KINDS = EARN_KINDS;
