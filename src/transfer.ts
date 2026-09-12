/**
 * 引き継ぎコード：端末をまたいで「持ち主」を移す仕組み。
 *
 * 解こうとしている問題:
 * 持ち主トークンはlocalStorageにしか無いため、機種変更・ブラウザのデータ削除・
 * プライベートモードでの利用などで、育てた分身の所有権を永久に失ってしまう。
 * アカウント登録を導入せずにこれを救うのが、この短命なコード。
 *
 * 安全側に倒した設計:
 * - 発行できるのは現在の持ち主だけ（ownerTokenの照合が必要）
 * - 30分で失効し、1回使ったら無効
 * - 発行のたびに、そのキャラクターの未使用コードは無効化する（複数同時に生きた状態を作らない）
 * - コードは推測されにくい文字種・桁数にする
 * - コードそのものが所有権なので、画面側で「他人に渡さないこと」を明示する
 */

import { CharacterState } from "./durable-objects/characterState";
import { LogContext, logInfo, logWarn } from "./lib/log";

/** 有効期限。長すぎると漏れたコードの危険が増すので短く。 */
const TRANSFER_CODE_TTL_MS = 30 * 60 * 1000;

/**
 * 読み間違えにくい文字だけを使う（0/O、1/I/l のような紛らわしい組み合わせを除外）。
 * 口頭やメモで受け渡すことを想定している。
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

export interface TransferEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<CharacterState>;
}

function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  // 読みやすさのため4文字ずつ区切る（保存時は区切りを除いた形に正規化する）
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** 入力ゆれ（小文字・全角ハイフン・空白）を吸収して比較できる形にする。 */
export function normalizeCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[\s　ー−―–—]/g, "")
    .replace(/-/g, "");
}

export interface IssueResult {
  ok: true;
  code: string;
  expiresAt: number;
}

/**
 * 引き継ぎコードを発行する。現在の持ち主だけが実行できる。
 * 新しい持ち主トークンはこの時点で決めておき、引き継ぎ先が使った瞬間に有効化する。
 */
export async function issueTransferCode(
  env: TransferEnv,
  characterId: string,
  ownerToken: string | undefined,
  log: LogContext
): Promise<IssueResult | { ok: false; error: string; status: number }> {
  const stub = env.CHARACTER.getByName(characterId);
  const state = await stub.getState();
  if (!state) return { ok: false, error: "not found", status: 404 };

  // 所有権の確認はDO側の判定ロジックに委ねる（判定を二重に持たない）
  const allowed = await stub.verifyOwner(ownerToken);
  if (!allowed) {
    logInfo(log, "transfer.issue_denied");
    return { ok: false, error: "この操作は分身の持ち主だけが行えます", status: 403 };
  }

  const now = Date.now();
  const code = generateCode();
  const newOwnerToken = crypto.randomUUID();

  // 同じキャラクターの未使用コードは、新しいものを出す時点で無効化しておく
  await env.DB.prepare("DELETE FROM transfer_codes WHERE character_id = ? AND used_at IS NULL")
    .bind(characterId)
    .run();

  await env.DB.prepare(
    `INSERT INTO transfer_codes (code, character_id, new_owner_token, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`
  )
    .bind(normalizeCode(code), characterId, newOwnerToken, now, now + TRANSFER_CODE_TTL_MS)
    .run();

  logInfo(log, "transfer.issued", { expiresInMs: TRANSFER_CODE_TTL_MS });
  return { ok: true, code, expiresAt: now + TRANSFER_CODE_TTL_MS };
}

export interface ClaimResult {
  ok: true;
  characterId: string;
  ownerToken: string;
  name: string;
}

/**
 * コードを使って持ち主になる。
 * 成功すると、そのキャラクターのownerTokenが新しい値へ差し替わり、
 * 元の端末に残っている古いトークンは無効になる（＝所有権が移る）。
 */
export async function claimTransferCode(
  env: TransferEnv,
  rawCode: string,
  log: LogContext
): Promise<ClaimResult | { ok: false; error: string; status: number }> {
  const code = normalizeCode(rawCode);
  if (!code) return { ok: false, error: "引き継ぎコードを入力してください", status: 400 };

  const row = await env.DB.prepare(
    "SELECT code, character_id, new_owner_token, expires_at, used_at FROM transfer_codes WHERE code = ?"
  )
    .bind(code)
    .first<{ code: string; character_id: string; new_owner_token: string; expires_at: number; used_at: number | null }>();

  if (!row) {
    logInfo(log, "transfer.claim_not_found");
    return { ok: false, error: "そのコードは見つかりませんでした", status: 404 };
  }
  if (row.used_at) {
    return { ok: false, error: "そのコードはすでに使われています", status: 410 };
  }
  if (Date.now() > row.expires_at) {
    return { ok: false, error: "そのコードは期限切れです。もう一度発行してください", status: 410 };
  }

  const stub = env.CHARACTER.getByName(row.character_id);
  const applied = await stub.replaceOwnerToken(row.new_owner_token);
  if (!applied.ok) {
    logWarn(log, "transfer.claim_apply_failed", { reason: applied.error });
    return { ok: false, error: applied.error, status: 404 };
  }

  // 使用済みにする。ここが失敗するとコードが再利用できてしまうため、失敗は握りつぶさない。
  await env.DB.prepare("UPDATE transfer_codes SET used_at = ? WHERE code = ?").bind(Date.now(), code).run();

  logInfo(log, "transfer.claimed", { characterId: row.character_id });
  return { ok: true, characterId: row.character_id, ownerToken: row.new_owner_token, name: applied.name };
}
