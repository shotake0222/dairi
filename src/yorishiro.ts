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
import { COLOR_KEYS, SPECIES_KEYS } from "./durable-objects/characterState";

/**
 * 管理画面から来た「限定の姿」の指定を、保存できる形に整える。
 * 配列でも "a,b" でも受ける。**知っているキーだけを残す。**
 */
function normalizePool(raw: unknown, allowed: readonly string[]): string {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  const seen = new Set<string>();
  for (const v of list) {
    const key = String(v).trim();
    if (allowed.includes(key)) seen.add(key);
  }
  // 全部選ばれているのは「制限なし」と同じ。空にして、限定扱いにしない
  if (seen.size === allowed.length) return "";
  return [...seen].join(",");
}

export interface YorishiroEnv {
  DB: D1Database;
  CHARACTER: DurableObjectNamespace<import("./durable-objects/characterState").CharacterState>;
}

/**
 * 入口の種類。character_origin.kind に入る値。振る舞いではなく「どう配ったか」だけを表す。
 *
 *   nfc    … 依代をかざした
 *   qr     … 配られたQRを読み取った
 *   web    … **依代を使わず、配ったリンクから始めた**（/w）。タグが刷り上がる前でも始められる口
 *   direct … /add の「この端末で分身を始める」を自分で押した
 *   import … 人格パッケージを取り込んだ
 *
 * web と direct は中身が同じ（どちらも依代に紐づかない）が、**分けて数えられるようにしている**。
 * 配ったリンクがどれだけ効いたのかは、混ぜると分からなくなる。
 */
export type OriginKind = "nfc" | "qr" | "web" | "direct" | "import" | "admin" | "invite";

/**
 * 依代を持たずに作れる分身の、1日あたりの上限（同じ回線から）。
 *
 * **相手によって変える。** もともとは誰でも押せるボタンを守るための数字だったが、
 * 入口を閉じた（src/entryPolicy.ts）いま、同じ厳しさを全員に当てる理由が無くなった。
 *
 *   admin     … 上限なし。**運営が自分の道具で詰まるのがいちばん無駄**。
 *               試作の読み取り確認では、1日に何体も作る
 *   yorishiro … 10体。現物を持っている人。家族で分け合う・買い直すぶんには足りる
 *   open      … 3体。ENTRY_OPEN で誰でも入れる状態。ここだけは機械的な量産を警戒する
 *
 * **日付の区切りはUTC。** 日本時間の朝9時に戻る（夜中ではない）。
 * 「夜中を回ったのに戻らない」と言われる元なので、断るときの文面にもそう書く。
 */
export const DIRECT_CREATE_DAILY_LIMIT = 3;

/** 入口の通り方ごとの1日あたりの上限。null は上限なし。 */
export function dailyLimitFor(reason: "admin" | "yorishiro" | "open" | "closed"): number | null {
  if (reason === "admin") return null;
  if (reason === "yorishiro") return 10;
  return DIRECT_CREATE_DAILY_LIMIT;
}

/**
 * /t・/q で「台帳に無い、初めて見るコード」を新しい依代として受け付けるときの、
 * 1日あたりの上限（同じ回線から）。
 *
 * **なぜ要るか。** /t/<code> と /q/<code> は、台帳（tag_registry）に無いコードでも
 * 新しい依代として受け付ける（台帳を作る前に配ったタグを死なせないため。
 * migration 0009_yorishiro.sql 参照）。これは裏を返すと、**何でもいいから文字列を1つ
 * 付けて `/t/好きな文字列` を開くだけで、上のDIRECT_CREATE_DAILY_LIMIT（依代を持たない
 * 人の上限）をまるごと素通りして分身が1体生まれる**、ということでもある。
 * `canCreateCharacter`（src/entryPolicy.ts）はこのルートを一切見ていない。
 *
 * 本物の依代は現物が要る（1つ5,500円、または配布場所に行く必要がある）ので、
 * 1日に何十個も「初めて読む」ことは通常起きない。ここで警戒したいのは
 * `/t/1`, `/t/2`, ... のような機械的な連番打ちで、依代を持たない人の上限より
 * かなり緩くしてある（実在の依代を何個も同時に開ける買い方を邪魔しないため）。
 */
export const TAG_CLAIM_DAILY_LIMIT = 20;

/**
 * 台帳に無い新しいコードを、いま受け付けてよいか。
 * 断るときはDBに何も書き込まない（コードを無駄に消費させないため）。
 */
export async function canClaimNewTag(env: { DB: D1Database }, request: Request): Promise<boolean> {
  const limited = await consumeIpQuota(env, "tag_claim", request, TAG_CLAIM_DAILY_LIMIT);
  return limited.allowed;
}

export interface Spot {
  code: string;
  label: string;
  place: string | null;
  note: string | null;
  active: boolean;
  createdAt: number;
  /**
   * そこでしか出ない姿の範囲。空なら制限なし（＝90種類から等確率。ほとんどの配布元はこちら）。
   * **どの子が出るかは指定できない。範囲を狭めるだけ**（migration 0011 の説明を参照）。
   */
  speciesPool: string[];
  colorPool: string[];
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
  species_pool?: string | null;
  color_pool?: string | null;
}

/** "a,b" ⇔ ["a","b"]。空文字とNULLはどちらも「制限なし」を意味する。 */
function parsePool(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function toSpot(row: SpotRow): Spot {
  return {
    code: row.code,
    label: row.label,
    place: row.place,
    note: row.note,
    active: row.active === 1,
    createdAt: row.created_at,
    speciesPool: parsePool(row.species_pool),
    colorPool: parsePool(row.color_pool),
  };
}

/** その配布元は、姿の範囲を絞っているか。 */
export function isLimitedSpot(spot: Pick<Spot, "speciesPool" | "colorPool">): boolean {
  return spot.speciesPool.length > 0 || spot.colorPool.length > 0;
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

/**
 * 共通URLで配るための、依代の見分け方。
 *
 * **なぜ要るか。** タグ1枚ずつに違うURLを書き込むのは、数十枚なら回るが、
 * 売り物として数百・数千枚を外注するとそこが詰まる。全部に同じ内容を書き込めないと、
 * 「キーホルダーを作って売る」が成立しない。
 *
 * **どう解決するか。** NTAG213/215/216 の **UIDミラー**を使う。
 * タグには全部同じ内容を書き込む。読み取られた瞬間に、**チップが自分のUID（14文字）を
 * URLの中の埋め草に差し替えて**返す。だから、
 *
 *   書き込む内容  … 全部同じ（外注できる）
 *   読まれるURL   … タグごとに違う（1枚1体が成立する）
 *
 * が両立する。UIDは工場で焼かれていて書き換えられないので、こちらで採番する必要もない。
 * iOSでもAndroidでも、NDEFの中身として読まれるので同じように効く
 * （Web NFC と違って、ブラウザの対応に依存しない）。
 *
 * 受け付ける形:
 *   /t?u=04a1b2c3d4e5f6         … UIDミラーのみ
 *   /t?u=04a1b2c3d4e5f6x000123  … UID＋カウンタミラー（区切りは 'x'。カウンタは捨てる）
 *   /t/<コード>                  … 1枚ずつ個別に書き込む従来の方式（併用できる）
 *
 * **いちばん危ないのは、ミラーの設定を忘れて出荷すること。**
 * そのとき全部のタグが埋め草のまま同じURLを返すので、**買った人全員が同じ分身を共有する**。
 * 気づくのは苦情が来てから。なので埋め草らしい値（全部0・全部F・16進以外・長さ違い）は
 * ここで弾いて、見分けが付かなかったものとして扱う。
 */
const UID_FILLER = /^(0+|f+|x+|-+)$/;

export interface TagIdentity {
  /** 見分けが付いたときの依代ID。付かなければ null */
  tagId: string | null;
  /** 何から見分けたか。運営が切り分けるときのため */
  source: "code" | "uid" | "none";
  /** UIDらしきものは来たが、埋め草だったか（＝ミラーの設定漏れが疑われる） */
  suspectedFiller: boolean;
}

/**
 * 読み取りのURLから、依代を1枚に特定する。
 * `/t/<コード>` が最優先。無ければ `?u=` のUIDを見る。
 */
export function identifyTag(url: URL): TagIdentity {
  // 1. パスに個別コードが入っている（従来方式）
  const fromPath = decodeURIComponent(url.pathname.split("/")[2] || "").trim();
  if (fromPath) return { tagId: fromPath, source: "code", suspectedFiller: false };

  // 2. UIDミラー。タグ屋によって名前が揺れるので、よく使われるものは拾う
  const raw = url.searchParams.get("u") ?? url.searchParams.get("uid") ?? url.searchParams.get("id");
  if (!raw) return { tagId: null, source: "none", suspectedFiller: false };

  // カウンタミラーを併用すると "UIDxカウンタ" の形で来る。区切りより前だけ使う
  const head = raw.split(/[xX]/)[0].trim().toLowerCase().replace(/[^0-9a-f]/g, "");

  // 4バイト(8文字)か7バイト(14文字)のUIDだけを本物として扱う。
  // NTAG21x は7バイトなので通常は14文字
  const looksLikeUid = head.length === 8 || head.length === 14;
  const filler = UID_FILLER.test(head) || !looksLikeUid;
  if (filler) return { tagId: null, source: "none", suspectedFiller: true };

  // コード方式と混ざらないよう、前置きを付けて別の名前空間にする
  return { tagId: `uid-${head}`, source: "uid", suspectedFiller: false };
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
  /** そこでしか出ない姿があるか。何が出るかは出さない */
  limited: boolean;
}

export async function getSpot(env: { DB: D1Database }, code: string): Promise<Spot | null> {
  if (!code) return null;
  const row = await env.DB.prepare("SELECT * FROM spots WHERE code = ?").bind(code).first<SpotRow>();
  return row ? toSpot(row) : null;
}

export function publicSpot(spot: Spot): PublicSpot {
  // place（設置場所の細かいメモ）は出さない。運営が管理のために書いた文で、見せる前提がない。
  // limited は「ここでしか出ない姿がある」の一言を出すためだけの真偽値。
  // **どの姿が出るかは出さない。** 先に分かると、引く前に結果が見えてしまう。
  return { code: spot.code, label: spot.label, note: spot.note, limited: isLimitedSpot(spot) };
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
export async function createDirectCharacter(
  env: YorishiroEnv,
  request: Request,
  /**
   * どの入口から来たか。既定は "direct"（/add から自分で始めた人）。
   * 依代をかざしたのに**タグを1枚に特定できなかった**ときも、ここを通って1体つくる。
   * そのときは "nfc" / "qr" として記録する——実際に依代から来ているので、
   * 集計で「自分で始めた人」に混ぜると、配った枚数と数が合わなくなる。
   */
  kind: OriginKind = "direct",
  /** 1日あたりの上限。null なら数えない（管理者）。既定は依代なしの人と同じ */
  dailyLimit: number | null = DIRECT_CREATE_DAILY_LIMIT
): Promise<DirectCreateResult> {
  if (dailyLimit !== null) {
    const limited = await consumeIpQuota(env, "new_character", request, dailyLimit);
    if (!limited.allowed) {
      return {
        ok: false,
        status: 429,
        error:
          `今日はもう ${limited.limit} 体つくりました。` +
          // 区切りはUTCなので、日本時間だと朝9時に戻る。夜中を待っても戻らない
          `日本時間の翌朝9時に、また作れるようになります`,
      };
    }
  }

  const characterId = crypto.randomUUID();
  const initData = await env.CHARACTER.getByName(characterId).init("名もなきキャラクター");
  await recordOrigin(env, characterId, kind, null);
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

  // 限定の姿。**知らないキーは黙って捨てる。** 綴り間違いをそのまま保存すると、
  // 「絞ったつもりが1件も該当せず、全体から引かれている」という、
  // 現物を配ってからでないと気づけない事故になる。
  const speciesPool = normalizePool(body.speciesPool, SPECIES_KEYS);
  const colorPool = normalizePool(body.colorPool, COLOR_KEYS);

  await env.DB.prepare(
    `INSERT INTO spots (code, label, place, note, active, created_at, species_pool, color_pool)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET
       label=excluded.label, place=excluded.place, note=excluded.note, active=excluded.active,
       species_pool=excluded.species_pool, color_pool=excluded.color_pool`
  )
    .bind(code, label, place, note, active, Date.now(), speciesPool || null, colorPool || null)
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
