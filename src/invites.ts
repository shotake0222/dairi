/**
 * 依代（NFC）を使わない入口。
 *
 * これまでの入口:
 *   /t・/q   依代をかざす・QRを読む（いつでも作れる）
 *   /w・/add 依代なしでその端末だけ（既定は閉じている。ENTRY_OPEN のときだけ）
 *
 * ここで足すもの（どれも「画面のURL」を渡すと、開いた端末に分身と持ち主の印が渡る）:
 *
 *   A. 招待リンク（/i/<コード>）… 管理画面で発行。1回だけ使える／N回まで使える（キャンペーン・イベント・法人の配布）、
 *                                  期限つき。開いた人に新しい分身が生まれる
 *   B. Web申し込み（/apply）   … 名前と連絡先を送る → 運営が承認 → 申込者の状況ページに招待リンクが出る
 *                                  （メールを送る仕組みは持たない。運営が連絡先へ知らせるか、申込者が状況ページで受け取る）
 *   C. 引き渡しリンク          … 管理画面で作った運営の分身（育てた人格データ）を、開いた人に渡す。
 *                                  開いた端末が新しい持ち主になり、運営の一覧からは外れる（1回だけ）
 *
 * どの入口も「開いた瞬間の端末」が持ち主になり、持ち主の印（トークン）はURLで一度だけ渡して、
 * 画面（/summon）がすぐ端末に保存する（/t と同じ）。
 */

import type { CharacterState } from "./durable-objects/characterState";
import { consumeIpQuota } from "./lib/ipQuota";
import { releaseAdminCharacter } from "./adminCharacters";
import { cleanLong, cleanText, intIn, timeOrNull, type MetaverseEnv } from "./metaverse";

export interface InviteEnv extends MetaverseEnv {
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomCode(n: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isInviteCode(v: unknown): v is string {
  return typeof v === "string" && /^[a-z0-9]{8,24}$/.test(v);
}

export interface Invite {
  code: string;
  kind: "new" | "handover";
  characterId: string | null;
  label: string;
  maxUses: number;
  used: number;
  expiresAt: number | null;
  active: boolean;
  source: "admin" | "application";
  applicationId: string | null;
  createdAt: number;
  /** 一覧用 */
  state?: "usable" | "used_up" | "expired" | "stopped";
}

interface InviteRow {
  code: string;
  kind: string;
  character_id: string | null;
  label: string;
  max_uses: number;
  used: number;
  expires_at: number | null;
  active: number;
  source: string;
  application_id: string | null;
  created_at: number;
}

function fromRow(r: InviteRow): Invite {
  const i: Invite = {
    code: r.code,
    kind: r.kind === "handover" ? "handover" : "new",
    characterId: r.character_id,
    label: r.label,
    maxUses: r.max_uses,
    used: r.used,
    expiresAt: r.expires_at,
    active: r.active === 1,
    source: r.source === "application" ? "application" : "admin",
    applicationId: r.application_id,
    createdAt: r.created_at,
  };
  i.state = !i.active ? "stopped" : i.expiresAt && Date.now() >= i.expiresAt ? "expired" : i.used >= i.maxUses ? "used_up" : "usable";
  return i;
}

/** 招待リンクを作る（管理画面）。count 本まとめて作れる（1本ずつ別のコード） */
export async function createInvites(
  env: InviteEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; invites: Invite[] } | { ok: false; error: string }> {
  const kind = raw.kind === "handover" ? "handover" : "new";
  const label = cleanText(raw.label, 40);
  const expiresAt = timeOrNull(raw.expiresAt);
  if (kind === "handover") {
    const characterId = typeof raw.characterId === "string" ? raw.characterId : "";
    const own = characterId
      ? await env.DB.prepare("SELECT 1 AS ok FROM admin_characters WHERE character_id = ?").bind(characterId).first()
      : null;
    if (!own) return { ok: false, error: "引き渡せるのは、管理画面で作った運営の分身だけです" };
    const code = randomCode(14);
    await env.DB.prepare(
      "INSERT INTO invites (code, kind, character_id, label, max_uses, used, expires_at, active, source, created_at) VALUES (?, 'handover', ?, ?, 1, 0, ?, 1, 'admin', ?)"
    )
      .bind(code, characterId, label, expiresAt, Date.now())
      .run();
    return { ok: true, invites: [fromRow((await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<InviteRow>())!)] };
  }
  const count = intIn(raw.count, 1, 200, 1);
  const maxUses = intIn(raw.maxUses, 1, 100000, 1);
  const out: Invite[] = [];
  for (let i = 0; i < count; i++) {
    const code = randomCode(12);
    await env.DB.prepare(
      "INSERT INTO invites (code, kind, character_id, label, max_uses, used, expires_at, active, source, created_at) VALUES (?, 'new', NULL, ?, ?, 0, ?, 1, 'admin', ?)"
    )
      .bind(code, label, maxUses, expiresAt, Date.now())
      .run();
    out.push(fromRow((await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<InviteRow>())!));
  }
  return { ok: true, invites: out };
}

export async function listInvites(env: MetaverseEnv): Promise<Invite[]> {
  const rows = await env.DB.prepare("SELECT * FROM invites ORDER BY created_at DESC LIMIT 500").all<InviteRow>();
  return (rows.results ?? []).map(fromRow);
}

export async function setInviteActive(env: MetaverseEnv, code: unknown, active: boolean): Promise<boolean> {
  if (!isInviteCode(code)) return false;
  await env.DB.prepare("UPDATE invites SET active = ? WHERE code = ?").bind(active ? 1 : 0, code).run();
  return true;
}

/**
 * 招待リンクを使う（/i/<コード>）。開いた端末に渡す分身と持ち主の印を返す。
 * 使える回数は、先に1つ減らしてから分身を作る（同時に開かれても、回数を超えて生まれない）。
 */
export async function redeemInvite(
  env: InviteEnv,
  code: string,
  request: Request
): Promise<{ ok: true; characterId: string; ownerToken: string; kind: "new" | "handover" } | { ok: false; reason: "not_found" | "used_up" | "expired" | "stopped" | "busy" }> {
  const row = await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(code).first<InviteRow>();
  if (!row) return { ok: false, reason: "not_found" };
  const invite = fromRow(row);
  if (invite.state !== "usable") return { ok: false, reason: invite.state as "used_up" | "expired" | "stopped" };
  // 機械的な連打で何百体も作られないように（1回線あたり1日30回まで。イベント会場の共有回線でも足りる数）
  const limited = await consumeIpQuota(env, "invite", request, 30);
  if (!limited.allowed) return { ok: false, reason: "busy" };
  const claimed = await env.DB.prepare("UPDATE invites SET used = used + 1 WHERE code = ? AND used < max_uses AND active = 1").bind(code).run();
  if (!claimed.meta.changes) return { ok: false, reason: "used_up" };

  if (invite.kind === "handover" && invite.characterId) {
    // 運営の分身を渡す: 持ち主の印を新しくして、運営の一覧から外す（運営の端末からは動かせなくなる）
    const token = crypto.randomUUID();
    const moved = await env.CHARACTER.getByName(invite.characterId).replaceOwnerToken(token);
    if (!moved.ok) return { ok: false, reason: "not_found" };
    await releaseAdminCharacter(env, invite.characterId);
    await env.DB.prepare("UPDATE character_origin SET kind = 'invite', ref = ? WHERE character_id = ?").bind(code, invite.characterId).run().catch(() => undefined);
    return { ok: true, characterId: invite.characterId, ownerToken: token, kind: "handover" };
  }
  const characterId = crypto.randomUUID();
  const data = await env.CHARACTER.getByName(characterId).init("名もなきキャラクター");
  await env.DB.prepare(
    "INSERT INTO character_origin (character_id, kind, ref, spot, created_at) VALUES (?, 'invite', ?, NULL, ?) ON CONFLICT(character_id) DO NOTHING"
  )
    .bind(characterId, code, Date.now())
    .run()
    .catch(() => undefined);
  return { ok: true, characterId, ownerToken: data.ownerToken!, kind: "new" };
}

export const INVITE_FAIL_TEXT: Record<string, string> = {
  not_found: "この招待リンクは見つかりませんでした。URLをもう一度お確かめください。",
  used_up: "この招待リンクは、もう使われています。",
  expired: "この招待リンクは、有効期限が過ぎています。",
  stopped: "この招待リンクは、いまは使えません。",
  busy: "いまは混み合っています。少し時間をおいてから開いてください。",
};

// ---------------------------------------------------------------- Web申し込み（/apply）

export interface ApplicationSettings {
  /** 申し込みを受け付けるか */
  open: boolean;
  /** 承認せずに、すぐ招待リンクを出すか（イベント期間などに。1回線1日3件まで） */
  autoApprove: boolean;
  /** 申込ページに出す一言 */
  note: string;
}

const DEFAULT_APP_SETTINGS: ApplicationSettings = {
  open: false,
  autoApprove: false,
  note: "申し込みを確認したら、この画面に「はじめるためのリンク」が表示されます。",
};

export async function getApplicationSettings(env: MetaverseEnv): Promise<ApplicationSettings> {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta_settings WHERE key = 'apply'").first<{ value: string }>();
    return row ? { ...DEFAULT_APP_SETTINGS, ...(JSON.parse(row.value) as Partial<ApplicationSettings>) } : { ...DEFAULT_APP_SETTINGS };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export async function saveApplicationSettings(env: MetaverseEnv, raw: Record<string, unknown>): Promise<ApplicationSettings> {
  const value: ApplicationSettings = {
    open: raw.open === true,
    autoApprove: raw.autoApprove === true,
    note: cleanLong(raw.note, 300) || DEFAULT_APP_SETTINGS.note,
  };
  await env.DB.prepare(
    "INSERT INTO meta_settings (key, value, updated_at) VALUES ('apply', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(JSON.stringify(value), Date.now())
    .run();
  return value;
}

async function issueForApplication(env: MetaverseEnv, applicationId: string, nickname: string): Promise<string> {
  const code = randomCode(12);
  const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO invites (code, kind, character_id, label, max_uses, used, expires_at, active, source, application_id, created_at) VALUES (?, 'new', NULL, ?, 1, 0, ?, 1, 'application', ?, ?)"
  )
    .bind(code, `申し込み: ${nickname}`.slice(0, 40), expiresAt, applicationId, Date.now())
    .run();
  return code;
}

export async function createApplication(
  env: MetaverseEnv,
  raw: Record<string, unknown>,
  request: Request
): Promise<{ ok: true; id: string; key: string; approved: boolean } | { ok: false; status: number; error: string }> {
  const settings = await getApplicationSettings(env);
  if (!settings.open) return { ok: false, status: 403, error: "いまはWebからの申し込みを受け付けていません" };
  if (raw.agree !== true) return { ok: false, status: 400, error: "利用規約とプライバシーポリシーへの同意が必要です" };
  const nickname = cleanText(raw.nickname, 30);
  if (!nickname) return { ok: false, status: 400, error: "お名前（ニックネームで構いません）を入れてください" };
  const contact = cleanText(raw.contact, 120);
  const limited = await consumeIpQuota(env, "entry_apply", request, settings.autoApprove ? 3 : 5);
  if (!limited.allowed) return { ok: false, status: 429, error: "本日の申し込みの上限に達しました。時間をおいてお試しください" };
  const id = randomCode(12);
  const key = randomCode(24);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT INTO entry_applications (id, key_hash, nickname, contact, purpose, status, created_at) VALUES (?,?,?,?,?, 'pending', ?)"
  )
    .bind(id, await sha256(key), nickname, contact, cleanLong(raw.purpose, 300), now)
    .run();
  if (settings.autoApprove) {
    const code = await issueForApplication(env, id, nickname);
    await env.DB.prepare("UPDATE entry_applications SET status = 'approved', invite_code = ?, decided_at = ? WHERE id = ?").bind(code, now, id).run();
    return { ok: true, id, key, approved: true };
  }
  return { ok: true, id, key, approved: false };
}

interface ApplicationRow {
  id: string;
  key_hash: string;
  nickname: string;
  contact: string;
  purpose: string;
  status: string;
  invite_code: string | null;
  reason: string;
  created_at: number;
  decided_at: number | null;
}

export async function applicationStatus(env: MetaverseEnv, id: unknown, key: unknown, origin: string) {
  if (typeof id !== "string" || typeof key !== "string" || !id || !key) return null;
  const row = await env.DB.prepare("SELECT * FROM entry_applications WHERE id = ?").bind(id).first<ApplicationRow>();
  if (!row || row.key_hash !== (await sha256(key))) return null;
  let invite: Invite | null = null;
  if (row.invite_code) {
    const r = await env.DB.prepare("SELECT * FROM invites WHERE code = ?").bind(row.invite_code).first<InviteRow>();
    invite = r ? fromRow(r) : null;
  }
  return {
    status: row.status,
    nickname: row.nickname,
    reason: row.status === "rejected" ? row.reason : "",
    inviteUrl: row.status === "approved" && invite && invite.state === "usable" ? `${origin}/i/${invite.code}` : null,
    inviteState: invite?.state ?? null,
    createdAt: row.created_at,
  };
}

export async function listApplications(env: MetaverseEnv) {
  // 決まってから90日たった申込の連絡先は消す（招待リンクを渡すためだけに預かっている）
  await env.DB.prepare("UPDATE entry_applications SET contact = '' WHERE contact != '' AND decided_at IS NOT NULL AND decided_at < ?")
    .bind(Date.now() - 90 * 24 * 60 * 60 * 1000)
    .run()
    .catch(() => undefined);
  const rows = await env.DB.prepare("SELECT * FROM entry_applications ORDER BY created_at DESC LIMIT 300").all<ApplicationRow>();
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    nickname: r.nickname,
    contact: r.contact,
    purpose: r.purpose,
    status: r.status,
    inviteCode: r.invite_code,
    reason: r.reason,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  }));
}

export async function decideApplication(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; inviteCode: string | null } | { ok: false; status: number; error: string }> {
  const id = typeof raw.id === "string" ? raw.id : "";
  const row = id ? await env.DB.prepare("SELECT * FROM entry_applications WHERE id = ?").bind(id).first<ApplicationRow>() : null;
  if (!row) return { ok: false, status: 404, error: "その申し込みはありません" };
  if (row.status !== "pending") return { ok: false, status: 400, error: "もう決まっている申し込みです" };
  const now = Date.now();
  if (raw.action === "approve") {
    const code = await issueForApplication(env, id, row.nickname);
    await env.DB.prepare("UPDATE entry_applications SET status = 'approved', invite_code = ?, decided_at = ? WHERE id = ?").bind(code, now, id).run();
    return { ok: true, inviteCode: code };
  }
  if (raw.action === "reject") {
    await env.DB.prepare("UPDATE entry_applications SET status = 'rejected', reason = ?, decided_at = ? WHERE id = ?")
      .bind(cleanText(raw.reason, 200), now, id)
      .run();
    return { ok: true, inviteCode: null };
  }
  return { ok: false, status: 400, error: "操作が分かりません" };
}

export async function pendingApplicationCount(env: MetaverseEnv): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM entry_applications WHERE status = 'pending'").first<{ n: number }>();
  return r?.n ?? 0;
}
