/**
 * 管理者の分身（人格データ）と、それをメタバースに置く NPC。
 *
 * - **管理者は、上限なしで分身を作れる**（依代・1日の上限を通らない）。作った子は admin_characters に載り、
 *   持ち主トークンを運営の端末へ渡して、ふつうの会話で育てられる
 * - **NPC にできるのは、運営の分身だけ。** 利用者の分身を、本人の知らないところで人前に出す口は作らない
 * - NPC が他人に配るのは、利用者の分身と同じ「名前・姿・声・動きの数値」と、運営が書いた一言（役目・メッセージ）だけ
 * - 姿と動きの数値は D1 に写しを持つ（部屋に入るたびに分身へ聞きに行かない）。古くなったら取り直す
 */

import type { CharacterState } from "./durable-objects/characterState";
import { cleanText, cleanUrl, isValidRoomId, WORLD_HALF, type MetaverseEnv } from "./metaverse";

export interface AdminCharacterEnv extends MetaverseEnv {
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

/** 1回に作れる数（上限は「1回に」だけ。何回でも作れる） */
export const ADMIN_CREATE_BATCH_MAX = 50;
/** 1エリアに置ける NPC の数 */
export const MAX_NPCS_PER_AREA = 12;
/** NPC の姿と動きの写しを、取り直すまでの時間 */
export const NPC_AVATAR_TTL_MS = 6 * 60 * 60 * 1000;

function randomId(n: number): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

// ---------------------------------------------------------------- 管理者の分身

export interface AdminCharacter {
  characterId: string;
  ownerToken: string;
  label: string;
  createdAt: number;
  name?: string;
  species?: string;
  color?: string;
  growthStage?: string;
  interactionCount?: number;
  npcCount?: number;
}

export async function isAdminCharacter(env: MetaverseEnv, characterId: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 AS ok FROM admin_characters WHERE character_id = ?").bind(characterId).first();
  return !!row;
}

/**
 * 管理者の分身を作る。**1日の上限を数えない**（src/yorishiro.ts の dailyLimitFor と同じ考え方）。
 * 名前は「名前」「名前2」…と付ける（空なら「運営の分身」）。
 */
export async function createAdminCharacters(
  env: AdminCharacterEnv,
  raw: { count?: unknown; name?: unknown; label?: unknown }
): Promise<{ ok: true; created: AdminCharacter[] } | { ok: false; error: string }> {
  const count = Math.max(1, Math.min(ADMIN_CREATE_BATCH_MAX, Math.round(Number(raw.count) || 1)));
  const baseName = cleanText(raw.name, 16) || "運営の分身";
  const label = cleanText(raw.label, 40);
  const created: AdminCharacter[] = [];
  for (let i = 0; i < count; i++) {
    const characterId = crypto.randomUUID();
    const name = count === 1 ? baseName : `${baseName}${i + 1}`;
    const stub = env.CHARACTER.getByName(characterId);
    const data = await stub.init(name);
    const now = Date.now();
    await env.DB.prepare("INSERT INTO admin_characters (character_id, owner_token, label, created_at) VALUES (?,?,?,?)")
      .bind(characterId, data.ownerToken, label, now)
      .run();
    await env.DB.prepare(
      "INSERT INTO character_origin (character_id, kind, ref, spot, created_at) VALUES (?, 'admin', NULL, NULL, ?) ON CONFLICT(character_id) DO NOTHING"
    )
      .bind(characterId, now)
      .run()
      .catch(() => undefined);
    created.push({
      characterId,
      ownerToken: data.ownerToken!,
      label,
      createdAt: now,
      name: data.name,
      species: data.species,
      color: data.color,
      growthStage: data.growthStage,
      interactionCount: data.interactionCount,
    });
  }
  return { ok: true, created };
}

/** 一覧（姿・成長は分身に聞く。数が多いときは新しい方から200体） */
export async function listAdminCharacters(env: AdminCharacterEnv): Promise<AdminCharacter[]> {
  const rows = await env.DB.prepare(
    `SELECT a.character_id, a.owner_token, a.label, a.created_at,
            (SELECT COUNT(*) FROM meta_npcs n WHERE n.character_id = a.character_id) AS npc_count
       FROM admin_characters a ORDER BY a.created_at DESC LIMIT 200`
  ).all<{ character_id: string; owner_token: string; label: string; created_at: number; npc_count: number }>();
  const out: AdminCharacter[] = [];
  for (const r of rows.results ?? []) {
    let state: Awaited<ReturnType<CharacterState["getState"]>> = null;
    try {
      state = await env.CHARACTER.getByName(r.character_id).getState();
    } catch {
      state = null;
    }
    out.push({
      characterId: r.character_id,
      ownerToken: r.owner_token,
      label: r.label,
      createdAt: r.created_at,
      name: state?.name ?? "（見つかりません）",
      species: state?.species,
      color: state?.color,
      growthStage: state?.growthStage,
      interactionCount: state?.interactionCount ?? 0,
      npcCount: r.npc_count,
    });
  }
  return out;
}

/** 運営の分身を消す（中身も消す。置いていた NPC も外す） */
export async function deleteAdminCharacter(env: AdminCharacterEnv, characterId: string): Promise<{ ok: boolean; areas: string[] }> {
  const row = await env.DB.prepare("SELECT owner_token FROM admin_characters WHERE character_id = ?")
    .bind(characterId)
    .first<{ owner_token: string }>();
  if (!row) return { ok: false, areas: [] };
  const areas = await env.DB.prepare("SELECT DISTINCT area_id FROM meta_npcs WHERE character_id = ?").bind(characterId).all<{ area_id: string }>();
  await env.CHARACTER.getByName(characterId).deleteData(row.owner_token).catch(() => undefined);
  await env.DB.prepare("DELETE FROM meta_npcs WHERE character_id = ?").bind(characterId).run();
  await env.DB.prepare("DELETE FROM admin_characters WHERE character_id = ?").bind(characterId).run();
  await env.DB.prepare("DELETE FROM character_origin WHERE character_id = ?").bind(characterId).run().catch(() => undefined);
  return { ok: true, areas: (areas.results ?? []).map((a) => a.area_id) };
}

/** 引き渡したので、運営の分身の一覧から外す（中身は消さない。以後は受け取った人の子） */
export async function releaseAdminCharacter(env: MetaverseEnv, characterId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM meta_npcs WHERE character_id = ?").bind(characterId).run();
  await env.DB.prepare("DELETE FROM admin_characters WHERE character_id = ?").bind(characterId).run();
}

// ---------------------------------------------------------------- NPC

export interface NpcRow {
  id: string;
  characterId: string;
  areaId: string;
  role: string;
  message: string;
  linkUrl: string;
  ad: boolean;
  homeX: number;
  homeZ: number;
  radius: number;
  talk: boolean;
  active: boolean;
  sortOrder: number;
  name?: string;
  species?: string;
  color?: string;
}

/** 部屋に配る NPC（characterId は画面には出さない。部屋の中だけで使う） */
export interface RoomNpc {
  aid: string;
  cid: string;
  name: string;
  species: string;
  color: string;
  voice: { pitch: number; rate: number; voiceIndex: number };
  compact: unknown;
  x: number;
  z: number;
  radius: number;
  role: string;
  message: string;
  linkUrl: string;
  ad: boolean;
  talk: boolean;
}

/** NPC を置く位置の目安（管理画面の選択肢）。x, z は中心からの距離[m] */
export const NPC_SPOTS = [
  { id: "center", label: "真ん中", x: 0, z: 0 },
  { id: "center-left", label: "真ん中の左", x: -2.6, z: 0.4 },
  { id: "center-right", label: "真ん中の右", x: 2.6, z: 0.4 },
  { id: "front", label: "手前", x: 0, z: 3.2 },
  { id: "back", label: "奥", x: 0, z: -3.4 },
  { id: "front-left", label: "手前の左", x: -3.2, z: 3 },
  { id: "front-right", label: "手前の右", x: 3.2, z: 3 },
] as const;

interface NpcDbRow {
  id: string;
  character_id: string;
  area_id: string;
  role: string;
  message: string;
  link_url: string | null;
  ad: number;
  home_x: number;
  home_z: number;
  radius: number;
  talk: number;
  active: number;
  sort_order: number;
  avatar: string | null;
  avatar_at: number | null;
}

function fromNpcRow(r: NpcDbRow): NpcRow {
  return {
    id: r.id,
    characterId: r.character_id,
    areaId: r.area_id,
    role: r.role,
    message: r.message,
    linkUrl: r.link_url ?? "",
    ad: r.ad === 1,
    homeX: r.home_x,
    homeZ: r.home_z,
    radius: r.radius,
    talk: r.talk === 1,
    active: r.active === 1,
    sortOrder: r.sort_order,
  };
}

const clampWorld = (v: unknown, fallback = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-(WORLD_HALF - 1), Math.min(WORLD_HALF - 1, Math.round(n * 10) / 10));
};

export async function listNpcs(env: AdminCharacterEnv, areaId?: string): Promise<NpcRow[]> {
  const rows = areaId
    ? await env.DB.prepare("SELECT * FROM meta_npcs WHERE area_id = ? ORDER BY sort_order, created_at").bind(areaId).all<NpcDbRow>()
    : await env.DB.prepare("SELECT * FROM meta_npcs ORDER BY area_id, sort_order, created_at LIMIT 500").all<NpcDbRow>();
  return (rows.results ?? []).map((r) => {
    const n = fromNpcRow(r);
    try {
      const a = r.avatar ? (JSON.parse(r.avatar) as { name?: string; species?: string; color?: string }) : null;
      if (a) Object.assign(n, { name: a.name, species: a.species, color: a.color });
    } catch {
      /* 写しが壊れていても一覧は出す */
    }
    return n;
  });
}

async function fetchAvatar(env: AdminCharacterEnv, characterId: string) {
  const result = await env.CHARACTER.getByName(characterId).getNpcAvatar();
  if (!result.ok) return null;
  return { name: result.name, species: result.species, color: result.color, voice: result.voice, compact: result.compact };
}

/** NPC を置く・直す */
export async function saveNpc(
  env: AdminCharacterEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; npc: NpcRow } | { ok: false; status: number; error: string }> {
  const characterId = typeof raw.characterId === "string" ? raw.characterId : "";
  const areaId = typeof raw.areaId === "string" ? raw.areaId : "";
  if (!isValidRoomId(areaId)) return { ok: false, status: 400, error: "置くエリアを選んでください" };
  // **運営の分身だけ。** 利用者の分身の識別子を渡されても置かない
  if (!characterId || !(await isAdminCharacter(env, characterId))) {
    return { ok: false, status: 400, error: "NPC にできるのは、管理画面で作った運営の分身だけです" };
  }
  const id = typeof raw.id === "string" && /^[a-z0-9]{6,16}$/.test(raw.id) ? raw.id : "";
  if (!id) {
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM meta_npcs WHERE area_id = ?").bind(areaId).first<{ n: number }>();
    if ((count?.n ?? 0) >= MAX_NPCS_PER_AREA) return { ok: false, status: 400, error: `1つのエリアに置ける NPC は${MAX_NPCS_PER_AREA}体までです` };
  }
  const linkRaw = typeof raw.linkUrl === "string" ? raw.linkUrl.trim() : "";
  const linkUrl = cleanUrl(linkRaw);
  if (linkRaw && !linkUrl) return { ok: false, status: 400, error: "リンクは https:// で始まるURLにしてください" };
  const avatar = await fetchAvatar(env, characterId);
  if (!avatar) return { ok: false, status: 400, error: "その分身が見つかりませんでした" };
  const now = Date.now();
  const npcId = id || randomId(10);
  const v = {
    role: cleanText(raw.role, 12),
    message: cleanText(raw.message, 80),
    ad: raw.ad === true ? 1 : 0,
    homeX: clampWorld(raw.homeX),
    homeZ: clampWorld(raw.homeZ),
    radius: Math.max(0, Math.min(4, Number(raw.radius) || 0)),
    talk: raw.talk === false ? 0 : 1,
    active: raw.active === false ? 0 : 1,
    sortOrder: Math.max(0, Math.min(9999, Math.round(Number(raw.sortOrder) || 100))),
  };
  await env.DB.prepare(
    `INSERT INTO meta_npcs (id, character_id, area_id, role, message, link_url, ad, home_x, home_z, radius, talk, active, sort_order, avatar, avatar_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET character_id=excluded.character_id, area_id=excluded.area_id, role=excluded.role, message=excluded.message,
       link_url=excluded.link_url, ad=excluded.ad, home_x=excluded.home_x, home_z=excluded.home_z, radius=excluded.radius, talk=excluded.talk,
       active=excluded.active, sort_order=excluded.sort_order, avatar=excluded.avatar, avatar_at=excluded.avatar_at, updated_at=excluded.updated_at`
  )
    .bind(npcId, characterId, areaId, v.role, v.message, linkUrl || null, v.ad, v.homeX, v.homeZ, v.radius, v.talk, v.active, v.sortOrder, JSON.stringify(avatar), now, now, now)
    .run();
  return {
    ok: true,
    npc: {
      id: npcId,
      characterId,
      areaId,
      role: v.role,
      message: v.message,
      linkUrl,
      ad: v.ad === 1,
      homeX: v.homeX,
      homeZ: v.homeZ,
      radius: v.radius,
      talk: v.talk === 1,
      active: v.active === 1,
      sortOrder: v.sortOrder,
      name: avatar.name,
      species: avatar.species,
      color: avatar.color,
    },
  };
}

export async function deleteNpc(env: MetaverseEnv, id: unknown): Promise<string | null> {
  if (typeof id !== "string") return null;
  const row = await env.DB.prepare("SELECT area_id FROM meta_npcs WHERE id = ?").bind(id).first<{ area_id: string }>();
  await env.DB.prepare("DELETE FROM meta_npcs WHERE id = ?").bind(id).run();
  return row?.area_id ?? null;
}

/** 姿と動きの数値を、いまの分身から取り直す（育てた結果を NPC に反映する） */
export async function refreshNpcAvatars(env: AdminCharacterEnv, areaId?: string): Promise<number> {
  const rows = areaId
    ? await env.DB.prepare("SELECT id, character_id FROM meta_npcs WHERE area_id = ?").bind(areaId).all<{ id: string; character_id: string }>()
    : await env.DB.prepare("SELECT id, character_id FROM meta_npcs").all<{ id: string; character_id: string }>();
  let n = 0;
  for (const r of rows.results ?? []) {
    const avatar = await fetchAvatar(env, r.character_id).catch(() => null);
    if (!avatar) continue;
    await env.DB.prepare("UPDATE meta_npcs SET avatar = ?, avatar_at = ? WHERE id = ?").bind(JSON.stringify(avatar), Date.now(), r.id).run();
    n++;
  }
  return n;
}

/**
 * 部屋に配る NPC。写しが古いものは、そのとき取り直す（1回に3体まで。入室を待たせすぎない）。
 * aid は NPC ごとに決まった値（npc-<id>）。分身の識別子とは結びつかない。
 */
export async function roomNpcs(env: AdminCharacterEnv, areaId: string): Promise<RoomNpc[]> {
  const rows = await env.DB.prepare("SELECT * FROM meta_npcs WHERE area_id = ? AND active = 1 ORDER BY sort_order, created_at LIMIT ?")
    .bind(areaId, MAX_NPCS_PER_AREA)
    .all<NpcDbRow>();
  const out: RoomNpc[] = [];
  let refreshed = 0;
  for (const r of rows.results ?? []) {
    let avatarJson = r.avatar;
    if ((!avatarJson || !r.avatar_at || Date.now() - r.avatar_at > NPC_AVATAR_TTL_MS) && refreshed < 3) {
      refreshed++;
      const fresh = await fetchAvatar(env, r.character_id).catch(() => null);
      if (fresh) {
        avatarJson = JSON.stringify(fresh);
        await env.DB.prepare("UPDATE meta_npcs SET avatar = ?, avatar_at = ? WHERE id = ?").bind(avatarJson, Date.now(), r.id).run();
      }
    }
    if (!avatarJson) continue;
    let a: { name: string; species: string; color: string; voice: RoomNpc["voice"]; compact: Record<string, unknown> };
    try {
      a = JSON.parse(avatarJson);
    } catch {
      continue;
    }
    const aid = `npc-${r.id}`;
    out.push({
      aid,
      cid: r.character_id,
      name: String(a.name).slice(0, 16),
      species: a.species,
      color: a.color,
      voice: a.voice,
      compact: { ...a.compact, id: aid },
      x: r.home_x,
      z: r.home_z,
      radius: r.radius,
      role: r.role,
      message: r.message,
      linkUrl: r.link_url ?? "",
      ad: r.ad === 1,
      talk: r.talk === 1,
    });
  }
  return out;
}
