/**
 * 依代（よりしろ）＝ 分身が宿るもの。
 *
 * **なぜこの言い方にしたか。**
 * これまで画面には「NFCタグ」と書いてあった。入口がNFCタグしか無かったので、
 * それで正しかった。ここから入口がQRコードにも広がると、
 * 「NFCタグをタップしてください」と書いてある画面をQRで来た人が見ることになる。
 * かといって「NFCタグまたはQRコード」と毎回書くと読みにくく、
 * 次に入口が増えたときにまた全部書き換えることになる。
 * サービス名が「分け御霊」から来ているので、宿る先を指す言葉をそのまま使う。
 *
 * **入口の種類が違っても、振る舞いは完全に同じ。**
 *   - 1つの依代からは1体しか生まれない（2回目以降は同じ子に会いに行く）
 *   - 生まれる子の姿はランダム。どの依代でも確率は等しい
 * これは集める体験の土台なので、ここだけは崩さない。運営が姿を決められるようにすると
 * 「引き当てた」が「配られた」に変わるし、1つの依代から何体も生まれるなら集める理由が消える。
 *
 * 入口:
 *   1. NFCタグ  /t/<code>               … かざす
 *   2. QR       /q/<code>               … 読み取る（1と同じ台帳・同じ振る舞い）
 *   3. 依代なし  POST /api/character/new … その端末だけで育てる
 */

import { consumeIpQuota } from "./lib/ipQuota";

export interface YorishiroEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<import("./durable-objects/characterState").CharacterState>;
}

/** 入口の種類。character_origin.kind に入る値。振る舞いではなく「どう配ったか」だけを表す。 */
export type OriginKind = "nfc" | "qr" | "direct" | "import";

/**
 * 依代を持たずに作れる分身の、1日あたりの上限（同じ回線から）。
 *
 * ここを開けておかないと「依代が手元にない人」が誰も始められないが、
 * 無制限だと機械的に大量の分身が作られて、Durable Objectの数だけが増えていく。
 * 1日3体は「家族で試す」までは通り、「自動で回す」は通らない線として置いている。
 */
export const DIRECT_CREATE_DAILY_LIMIT = 3;

export interface Spot {
  code: string;
  label: string;
  place: string | null;
  note: string | null;
  active: boolean;
  createdAt: number;
  /** この配布元で発行した依代の数（一覧でのみ埋まる） */
  issued?: number;
  /** そのうち既に使われた数 */
  claimed?: number;
}

interface SpotRow {
  code: string;
  label: string;
  place: string | null;
  note: string | null;
  active: number;
  created_at: number;
}

function toSpot(row: SpotRow): Spot {
  return {
    code: row.code,
    label: row.label,
    place: row.place,
    note: row.note,
    active: row.active === 1,
    createdAt: row.created_at,
  };
}

/**
 * 「どこから生まれたか」を控える。
 *
 * 失敗しても分身の誕生は止めない。これは運営が後から見るための記録で、
 * 無くても利用者の体験は成立する（逆に、ここの失敗で誕生が止まる方が損害が大きい）。
 */
export async function recordOrigin(
  env: { DB: D1Database },
  characterId: string,
  kind: OriginKind,
  ref: string | null,
  spot: string | null = null
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO character_origin (character_id, kind, ref, spot, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(character_id) DO NOTHING`
    )
      .bind(characterId, kind, ref, spot, Date.now())
      .run();
  } catch {
    /* 記録できなくても誕生は成立させる */
  }
}

/** その依代が、どの配布元のものとして発行されたか。台帳に無ければ null。 */
export async function spotOfTag(env: { DB: D1Database }, tagId: string): Promise<string | null> {
  try {
    const row = await env.DB.prepare("SELECT spot FROM tag_registry WHERE tag_id = ?")
      .bind(tagId)
      .first<{ spot: string | null }>();
    return row?.spot ?? null;
  } catch {
    return null;
  }
}

/** 公開してよい範囲の配布元情報（手に入れた人の画面に出す）。 */
export interface PublicSpot {
  code: string;
  label: string;
  note: string | null;
}

export async function getSpot(env: { DB: D1Database }, code: string): Promise<Spot | null> {
  if (!code) return null;
  const row = await env.DB.prepare("SELECT * FROM spots WHERE code = ?").bind(code).first<SpotRow>();
  return row ? toSpot(row) : null;
}

export function publicSpot(spot: Spot): PublicSpot {
  // place（設置場所の細かいメモ）は出さない。運営が管理のために書いた文で、見せる前提がない。
  return { code: spot.code, label: spot.label, note: spot.note };
}

export type DirectCreateResult =
  | { ok: true; characterId: string; ownerToken: string }
  | { ok: false; status: number; error: string };

/**
 * 依代を持たずに分身を1体生む。
 *
 * キーホルダーを買う前に試したい人、無くした人、もう1体育てたい人のための入口。
 * この分身は依代に紐づかないので、端末を変えるときは引き継ぎコードだけが頼りになる。
 * その注意は画面側（/add）で必ず出すこと。
 */
export async function createDirectCharacter(env: YorishiroEnv, request: Request): Promise<DirectCreateResult> {
  const limited = await consumeIpQuota(env, "new_character", request, DIRECT_CREATE_DAILY_LIMIT);
  if (!limited.allowed) {
    return {
      ok: false,
      status: 429,
      error: `今日はもう ${limited.limit} 体つくりました。続きは明日にしてください`,
    };
  }

  const characterId = crypto.randomUUID();
  const initData = await env.CHARACTER.getByName(characterId).init("名もなきキャラクター");
  await recordOrigin(env, characterId, "direct", null);
  return { ok: true, characterId, ownerToken: initData.ownerToken! };
}

// ---- 運営側（管理画面）----

export interface TagRegistryRow {
  tagId: string;
  kind: string;
  batch: string | null;
  spot: string | null;
  note: string | null;
  createdAt: number;
  /** 既に誰かが読み取って分身が生まれているか */
  claimedAt: number | null;
  characterId: string | null;
}

/** 発行済みの依代の一覧。まだ使われていないものが分かるよう、nfc_tags と突き合わせて返す。 */
export async function listTags(env: { DB: D1Database }, limit = 200): Promise<TagRegistryRow[]> {
  const result = await env.DB.prepare(
    `SELECT r.tag_id, r.kind, r.batch, r.spot, r.note, r.created_at,
            t.character_id, t.created_at AS claimed_at
       FROM tag_registry r
       LEFT JOIN nfc_tags t ON t.tag_id = r.tag_id
      ORDER BY r.created_at DESC
      LIMIT ?`
  )
    .bind(Math.max(1, Math.min(1000, limit)))
    .all<{
      tag_id: string;
      kind: string;
      batch: string | null;
      spot: string | null;
      note: string | null;
      created_at: number;
      character_id: string | null;
      claimed_at: number | null;
    }>();

  return (result.results ?? []).map((r) => ({
    tagId: r.tag_id,
    kind: r.kind,
    batch: r.batch,
    spot: r.spot,
    note: r.note,
    createdAt: r.created_at,
    claimedAt: r.claimed_at,
    characterId: r.character_id,
  }));
}

/**
 * 依代のコードを、読みにくい文字を避けて作る。
 *
 * 印刷したコードを人が手で書き写す場面（復旧の問い合わせ）が実際にあるので、
 * 0/O、1/l/I のような取り違えが起きる文字は最初から使わない。
 */
const TAG_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";

export function generateTagId(length = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const b of bytes) out += TAG_ALPHABET[b % TAG_ALPHABET.length];
  return out;
}

/**
 * 依代をまとめて発行する（実際にタグへ書き込む・QRを刷るのは運営。ここで作るのはコードと台帳の行だけ）。
 *
 * QRも1コード1体なので、壁に1枚貼るのではなく、カードやシールとして1人に1枚配る想定。
 * 「その場所でしか手に入らない」は、姿を固定するのではなく
 * **そのコードをその場所にしか置かないこと**で作る。
 */
export async function issueTags(
  env: { DB: D1Database },
  params: { count?: unknown; kind?: unknown; batch?: unknown; spot?: unknown; note?: unknown }
): Promise<{ ok: true; tagIds: string[] } | { ok: false; status: number; error: string }> {
  const n = Math.floor(Number(params.count));
  if (!Number.isFinite(n) || n < 1 || n > 200) {
    return { ok: false, status: 400, error: "発行数は1〜200で指定してください" };
  }

  const kind = params.kind === "qr" ? "qr" : "nfc";
  const now = Date.now();
  const batchLabel = typeof params.batch === "string" && params.batch.trim() ? params.batch.trim().slice(0, 60) : null;
  const noteText = typeof params.note === "string" && params.note.trim() ? params.note.trim().slice(0, 200) : null;
  let spotCode: string | null =
    typeof params.spot === "string" && params.spot.trim() ? params.spot.trim().toLowerCase() : null;

  // 存在しない配布元を指したまま発行すると、あとから「どこで配ったか」が引けなくなる。
  if (spotCode && !(await getSpot(env, spotCode))) {
    return { ok: false, status: 400, error: `配布元「${spotCode}」が見つかりません` };
  }

  const tagIds = Array.from({ length: n }, () => generateTagId());
  await env.DB.batch(
    tagIds.map((id) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO tag_registry (tag_id, kind, batch, spot, note, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(id, kind, batchLabel, spotCode, noteText, now)
    )
  );
  return { ok: true, tagIds };
}

/** 配布元の一覧。発行数と、そのうち使われた数も一緒に返す（設置先へ報告するために必要）。 */
export async function listSpots(env: { DB: D1Database }): Promise<Spot[]> {
  const result = await env.DB.prepare("SELECT * FROM spots ORDER BY created_at DESC LIMIT 500").all<SpotRow>();
  const spots = (result.results ?? []).map(toSpot);
  if (spots.length === 0) return spots;

  const counts = await env.DB.prepare(
    `SELECT r.spot AS spot, COUNT(*) AS issued, COUNT(t.tag_id) AS claimed
       FROM tag_registry r
       LEFT JOIN nfc_tags t ON t.tag_id = r.tag_id
      WHERE r.spot IS NOT NULL
      GROUP BY r.spot`
  ).all<{ spot: string; issued: number; claimed: number }>();

  const byCode = new Map((counts.results ?? []).map((r) => [r.spot, r]));
  for (const spot of spots) {
    const row = byCode.get(spot.code);
    spot.issued = row?.issued ?? 0;
    spot.claimed = row?.claimed ?? 0;
  }
  return spots;
}

/** 配布元を作る・直す。code が既にあれば上書き（設置後に文言だけ直したい場面が必ず来る）。 */
export async function saveSpot(
  env: { DB: D1Database },
  body: Record<string, unknown>
): Promise<{ ok: true; spot: Spot } | { ok: false; status: number; error: string }> {
  const rawCode = typeof body.code === "string" ? body.code.trim().toLowerCase() : "";
  const code = rawCode || generateTagId(8);
  if (!/^[a-z0-9-]{3,32}$/.test(code)) {
    return { ok: false, status: 400, error: "コードは英小文字・数字・ハイフンで3〜32文字にしてください" };
  }

  const label = typeof body.label === "string" ? body.label.trim().slice(0, 60) : "";
  if (!label) return { ok: false, status: 400, error: "名前（利用者に見せる呼び名）を入れてください" };

  const place = typeof body.place === "string" ? body.place.trim().slice(0, 120) || null : null;
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 200) || null : null;
  const active = body.active === false || body.active === 0 || body.active === "0" ? 0 : 1;

  await env.DB.prepare(
    `INSERT INTO spots (code, label, place, note, active, created_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       label=excluded.label, place=excluded.place, note=excluded.note, active=excluded.active`
  )
    .bind(code, label, place, note, active, Date.now())
    .run();

  const saved = await getSpot(env, code);
  return saved ? { ok: true, spot: saved } : { ok: false, status: 500, error: "保存できませんでした" };
}

/**
 * 配布元を消す。
 *
 * 既に配ったQRのコード自体は tag_registry と nfc_tags に残るので、読み取っても壊れない
 * （「どこで配ったか」が引けなくなるだけ）。それでも、止めたいだけなら
 * active=false にするよう管理画面側で先に促すこと。
 * ここで生まれた分身は消さない（利用者のものなので、運営の都合で消してはいけない）。
 */
export async function deleteSpot(env: { DB: D1Database }, code: unknown): Promise<{ ok: boolean }> {
  if (typeof code !== "string" || !code.trim()) return { ok: false };
  await env.DB.prepare("DELETE FROM spots WHERE code = ?").bind(code.trim()).run();
  return { ok: true };
}
