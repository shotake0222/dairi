/**
 * メタバース — 部屋の設定（何を映すか・何で遊ぶか）。
 *
 * わけたまで育った分身が、人格の数値どおりに動く共有の3D空間。
 * ここは「部屋の設定」を扱う層で、入室・移動・挨拶の中継は Durable Object（metaverseRoom.ts）がやる。
 *
 * **部屋は管理画面でだけ作る・直す。** 利用者が自由に部屋を作れると、見知らぬ人に任意の画像や
 * 文字を見せる口になる。子どもも使うサービスなので、置く物はすべて運営が決める。
 *
 * 部屋の設定:
 *   - 場所（草原・おへや・境内・海辺・夜空の丘）と時間帯（朝・昼・夕・夜）
 *   - 最初のカメラ視点（見下ろし・正面・後ろから・この子の目線）。入った人が画面で切り替えられる
 *   - 置く物（objects。最大7つ、決まった置き場所に1つずつ）:
 *       board    看板。文字・画像・リンク。広告のときは「広告」の表示を必ず付ける（ステルスマーケティング規制）
 *       video    動画のスクリーン（音なし・くり返し）
 *       members  いまいる子の紹介
 *       treasure ミニゲーム「宝さがし」: 制限時間内に散らばった星を集める
 *       quiz     ミニゲーム「○×クイズ」: 問題に合わせて、分身を○か×の場所へ歩かせる
 *       rally    ミニゲーム「スタンプラリー」: 空間のあちこちにある旗を全部まわる
 *   - 登場させる分身は、入る人がその場で選ぶ（キャラクター画面から来たら、その子）
 *
 * ミニゲームは**その端末の中だけ**で遊ぶ（点数や結果をサーバーへ送らない）。
 * 同じ部屋の他の子は、いっしょに歩いているのが見えるだけ。記録を持たない方針を崩さないため。
 */

export interface MetaverseEnv {
  DB: D1Database;
}

export const PLACES = [
  { id: "meadow", label: "草原" },
  { id: "room", label: "おへや" },
  { id: "shrine", label: "境内" },
  { id: "beach", label: "海辺" },
  { id: "hill", label: "夜空の丘" },
] as const;

export const TIMES = [
  { id: "morning", label: "朝" },
  { id: "day", label: "昼" },
  { id: "evening", label: "夕方" },
  { id: "night", label: "夜" },
] as const;

export const CAMERAS = [
  { id: "overview", label: "見下ろし" },
  { id: "front", label: "正面" },
  { id: "follow", label: "後ろから" },
  { id: "eye", label: "この子の目線" },
] as const;

export const OBJECT_TYPES = [
  { id: "board", label: "看板（広告・お知らせ）", game: false },
  { id: "video", label: "動画スクリーン", game: false },
  { id: "members", label: "いまいる子の紹介", game: false },
  { id: "treasure", label: "ミニゲーム：宝さがし", game: true },
  { id: "quiz", label: "ミニゲーム：○×クイズ", game: true },
  { id: "rally", label: "ミニゲーム：スタンプラリー", game: true },
] as const;

/**
 * 置き場所。座標を直接入れさせないのは、真ん中（分身が集まる場所）や物どうしが重ならないようにするため。
 * x, z は空間の中心からの距離[m]。
 */
export const SLOTS = [
  { id: "back", label: "奥（正面）", x: 0, z: -6.8 },
  { id: "back-left", label: "左奥", x: -5.6, z: -5.2 },
  { id: "back-right", label: "右奥", x: 5.6, z: -5.2 },
  { id: "left", label: "左", x: -7, z: 0.5 },
  { id: "right", label: "右", x: 7, z: 0.5 },
  { id: "front-left", label: "左手前", x: -5.4, z: 5.6 },
  { id: "front-right", label: "右手前", x: 5.4, z: 5.6 },
] as const;

/** 挨拶で分身が口にする台詞。**利用者が自由に書いた文字は、他人の画面で喋らせない。** */
export const GREETING_LINES = ["こんにちは！", "やっほー", "はじめまして", "いい天気だね", "また会えたね", "よろしくね"] as const;

/** スタンプ（押すと、その子の頭の上に出る） */
export const STAMPS = ["heart", "clap", "wow", "question", "music", "sleepy"] as const;

/** 1部屋に同時に入れる端末の数と、1端末が連れて入れる分身の数 */
export const MAX_PEOPLE = 12;
export const MAX_ACTORS_PER_PERSON = 3;
/** 空間の広さ（中心から ±この値[m] の正方形） */
export const WORLD_HALF = 9;
export const MAX_OBJECTS = SLOTS.length;
export const MAX_QUIZ_QUESTIONS = 10;

type PlaceId = (typeof PLACES)[number]["id"];
type TimeId = (typeof TIMES)[number]["id"];
type CameraId = (typeof CAMERAS)[number]["id"];
type ObjectTypeId = (typeof OBJECT_TYPES)[number]["id"];
type SlotId = (typeof SLOTS)[number]["id"];

export interface QuizQuestion {
  q: string;
  /** "o"＝○が正解、"x"＝×が正解 */
  a: "o" | "x";
  /** 答えのあとに出す一言（解説） */
  note: string;
}

export interface RoomObject {
  id: string;
  type: ObjectTypeId;
  slot: SlotId;
  title: string;
  /** 看板の本文、ミニゲームの説明 */
  text: string;
  /** 看板 */
  imageUrl?: string;
  linkUrl?: string;
  /** 広告なら true。看板に「広告」の表示が付く */
  ad?: boolean;
  /** 動画 */
  videoUrl?: string;
  /** 宝さがし: 星の数と制限時間[秒] */
  count?: number;
  seconds?: number;
  /** スタンプラリー: 旗の数 */
  points?: number;
  /** ○×クイズ */
  questions?: QuizQuestion[];
  /** クリアしたときに出す言葉（クーポンの案内など） */
  clearMessage?: string;
}

export interface RoomConfig {
  id: string;
  name: string;
  place: PlaceId;
  time: TimeId;
  camera: CameraId;
  objects: RoomObject[];
  listed: boolean;
  builtin: boolean;
}

/** 最初からある部屋。DBが空でも入れて、置ける物の見本にもなる。 */
export const BUILTIN_ROOMS: RoomConfig[] = [
  {
    id: "hiroba",
    name: "わけたまのひろば",
    place: "meadow",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    objects: [
      {
        id: "welcome",
        type: "board",
        slot: "back",
        title: "ようこそ",
        text: "地面をタップすると歩きます。分身をタップすると挨拶します。",
        ad: false,
      },
      {
        id: "stars",
        type: "treasure",
        slot: "back-left",
        title: "宝さがし",
        text: "60秒で、星を10こ集めよう",
        count: 10,
        seconds: 60,
        clearMessage: "ぜんぶ見つけたね！",
      },
      {
        id: "quiz",
        type: "quiz",
        slot: "back-right",
        title: "わけたま○×クイズ",
        text: "○か×の場所へ、分身を歩かせてね",
        questions: [
          { q: "分身は、依代ひとつにつき1体。", a: "o", note: "1つの依代には、1体の分身が宿ります" },
          { q: "分身と話すには、アプリのインストールが必要。", a: "x", note: "かざすだけ。アプリは要りません" },
          { q: "分身は、話しかけるほど性格が育つ。", a: "o", note: "会話を重ねるほど、その子らしくなります" },
        ],
        clearMessage: "全問正解！",
      },
      { id: "members", type: "members", slot: "left", title: "いまいる子", text: "" },
      {
        id: "rally",
        type: "rally",
        slot: "front-right",
        title: "スタンプラリー",
        text: "ひろばの旗を、ぜんぶまわろう",
        points: 4,
        clearMessage: "ひろばをひとまわりしたね！",
      },
    ],
  },
  {
    id: "yozora",
    name: "夜空の丘",
    place: "hill",
    time: "night",
    camera: "front",
    listed: true,
    builtin: true,
    objects: [
      { id: "members", type: "members", slot: "back", title: "今夜ここにいる子", text: "" },
      {
        id: "stars",
        type: "rally",
        slot: "left",
        title: "星めぐり",
        text: "丘の上の光を、ぜんぶたずねよう",
        points: 5,
        clearMessage: "星をぜんぶめぐったね。おやすみ",
      },
    ],
  },
];

const ROOM_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomId(length: number, alphabet = ROOM_ID_ALPHABET): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

export function isValidRoomId(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9-]{3,32}$/.test(id);
}

/** 1行の文字にする（改行・制御文字を落とし、長さを切る）。 */
function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function pick<T extends { id: string }>(list: readonly T[], value: unknown, fallback: T["id"]): T["id"] {
  return list.some((x) => x.id === value) ? (value as T["id"]) : fallback;
}

function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" ? u.toString().slice(0, 500) : "";
  } catch {
    return "";
  }
}

function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/**
 * 置く物を、信用せずに整える。直せないもの（URLが無い動画・問題の無いクイズ）はエラーにして、
 * 管理画面で気づけるようにする（黙って消すと「置いたはずなのに出ない」になる）。
 */
export function sanitizeObjects(raw: unknown): { ok: true; value: RoomObject[] } | { ok: false; error: string } {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_OBJECTS) return { ok: false, error: `置ける物は${MAX_OBJECTS}つまでです` };
  const used = new Set<string>();
  const out: RoomObject[] = [];
  for (const [i, item] of list.entries()) {
    const o = (item ?? {}) as Record<string, unknown>;
    const n = i + 1;
    const type = pick(OBJECT_TYPES, o.type, "board") as ObjectTypeId;
    const slot = pick(SLOTS, o.slot, "back") as SlotId;
    if (used.has(slot)) return { ok: false, error: `${n}つ目: 置き場所「${SLOTS.find((s) => s.id === slot)!.label}」が重なっています` };
    used.add(slot);
    const typeLabel = OBJECT_TYPES.find((t) => t.id === type)!.label;
    const base: RoomObject = {
      id: typeof o.id === "string" && /^[a-z0-9-]{1,24}$/.test(o.id) ? o.id : `${type}-${randomId(5)}`,
      type,
      slot,
      title: cleanText(o.title, 24) || typeLabel.replace(/^ミニゲーム：/, ""),
      text: cleanText(o.text, 80),
    };

    if (type === "board") {
      base.imageUrl = cleanUrl(o.imageUrl);
      base.linkUrl = cleanUrl(o.linkUrl);
      base.ad = o.ad === true;
      if (!base.text && !base.imageUrl) return { ok: false, error: `${n}つ目（看板）: 文字か画像のURLを入れてください` };
      if (typeof o.linkUrl === "string" && o.linkUrl.trim() && !base.linkUrl) {
        return { ok: false, error: `${n}つ目（看板）: リンクは https:// で始まるURLにしてください` };
      }
    } else if (type === "video") {
      base.videoUrl = cleanUrl(o.videoUrl);
      if (!base.videoUrl) return { ok: false, error: `${n}つ目（動画）: 動画のURL（https://〜）を入れてください` };
    } else if (type === "treasure") {
      base.count = intIn(o.count, 3, 30, 10);
      base.seconds = intIn(o.seconds, 15, 300, 60);
      base.clearMessage = cleanText(o.clearMessage, 60);
    } else if (type === "rally") {
      base.points = intIn(o.points, 2, 8, 4);
      base.clearMessage = cleanText(o.clearMessage, 60);
    } else if (type === "quiz") {
      const qs = Array.isArray(o.questions) ? o.questions : [];
      const questions: QuizQuestion[] = [];
      for (const q of qs.slice(0, MAX_QUIZ_QUESTIONS)) {
        const r = (q ?? {}) as Record<string, unknown>;
        const text = cleanText(r.q, 60);
        if (!text) continue;
        questions.push({ q: text, a: r.a === "x" ? "x" : "o", note: cleanText(r.note, 60) });
      }
      if (questions.length === 0) return { ok: false, error: `${n}つ目（○×クイズ）: 問題を1つ以上入れてください` };
      base.questions = questions;
      base.clearMessage = cleanText(o.clearMessage, 60);
    }
    out.push(base);
  }
  return { ok: true, value: out };
}

/** 部屋の設定を整える（管理画面から来たもの）。 */
export function sanitizeRoomInput(
  raw: Record<string, unknown>
): { ok: true; value: Omit<RoomConfig, "id" | "builtin"> } | { ok: false; error: string } {
  const name = cleanText(raw.name, 30);
  if (!name) return { ok: false, error: "部屋の名前を入れてください" };
  const objects = sanitizeObjects(raw.objects);
  if (!objects.ok) return objects;
  return {
    ok: true,
    value: {
      name,
      place: pick(PLACES, raw.place, "meadow") as PlaceId,
      time: pick(TIMES, raw.time, "day") as TimeId,
      camera: pick(CAMERAS, raw.camera, "overview") as CameraId,
      objects: objects.value,
      listed: raw.listed !== false,
    },
  };
}

interface RoomRow {
  id: string;
  name: string;
  place: string;
  time_of_day: string;
  camera: string;
  objects: string;
  listed: number;
}

function fromRow(r: RoomRow): RoomConfig {
  let objects: RoomObject[] = [];
  try {
    const parsed = sanitizeObjects(JSON.parse(r.objects || "[]"));
    objects = parsed.ok ? parsed.value : [];
  } catch {
    objects = [];
  }
  return {
    id: r.id,
    name: r.name,
    place: pick(PLACES, r.place, "meadow") as PlaceId,
    time: pick(TIMES, r.time_of_day, "day") as TimeId,
    camera: pick(CAMERAS, r.camera, "overview") as CameraId,
    objects,
    listed: r.listed === 1,
    builtin: false,
  };
}

export async function getRoom(env: MetaverseEnv, id: unknown): Promise<RoomConfig | null> {
  if (!isValidRoomId(id)) return null;
  const builtin = BUILTIN_ROOMS.find((r) => r.id === id);
  if (builtin) return builtin;
  const row = await env.DB.prepare("SELECT * FROM meta_rooms WHERE id = ?").bind(id).first<RoomRow>();
  return row ? fromRow(row) : null;
}

/** ロビーに並べる部屋（最初からある部屋＋「一覧に出す」にした部屋） */
export async function listRooms(env: MetaverseEnv): Promise<RoomConfig[]> {
  const rows = await env.DB.prepare("SELECT * FROM meta_rooms WHERE listed = 1 ORDER BY updated_at DESC LIMIT 50").all<RoomRow>();
  return [...BUILTIN_ROOMS, ...(rows.results ?? []).map(fromRow)];
}

/** 管理画面向け: 作った部屋を全部（一覧に出していないものも） */
export async function listAdminRooms(env: MetaverseEnv): Promise<RoomConfig[]> {
  const rows = await env.DB.prepare("SELECT * FROM meta_rooms ORDER BY updated_at DESC LIMIT 200").all<RoomRow>();
  return (rows.results ?? []).map(fromRow);
}

/** 部屋を作る・直す（管理画面から。id を渡せば更新）。 */
export async function saveRoom(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; room: RoomConfig } | { ok: false; status: number; error: string }> {
  const input = sanitizeRoomInput(raw);
  if (!input.ok) return { ok: false, status: 400, error: input.error };
  const v = input.value;
  const now = Date.now();
  let id = typeof raw.id === "string" && raw.id ? raw.id : "";
  const objectsJson = JSON.stringify(v.objects);
  if (id) {
    if (!isValidRoomId(id)) return { ok: false, status: 400, error: "部屋のIDが正しくありません" };
    if (BUILTIN_ROOMS.some((r) => r.id === id)) {
      return { ok: false, status: 400, error: "最初からある部屋は直せません。新しい部屋として作ってください" };
    }
    const row = await env.DB.prepare("SELECT id FROM meta_rooms WHERE id = ?").bind(id).first();
    if (!row) return { ok: false, status: 404, error: "その部屋はありません" };
    await env.DB.prepare(
      `UPDATE meta_rooms SET name=?, place=?, time_of_day=?, camera=?, objects=?, listed=?, updated_at=? WHERE id=?`
    )
      .bind(v.name, v.place, v.time, v.camera, objectsJson, v.listed ? 1 : 0, now, id)
      .run();
  } else {
    id = `r-${randomId(8)}`;
    await env.DB.prepare(
      `INSERT INTO meta_rooms (id, name, place, time_of_day, camera, objects, listed, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
      .bind(id, v.name, v.place, v.time, v.camera, objectsJson, v.listed ? 1 : 0, now, now)
      .run();
  }
  return { ok: true, room: { id, ...v, builtin: false } };
}

export async function deleteRoom(env: MetaverseEnv, id: unknown): Promise<{ ok: boolean }> {
  if (!isValidRoomId(id) || BUILTIN_ROOMS.some((r) => r.id === id)) return { ok: false };
  await env.DB.prepare("DELETE FROM meta_rooms WHERE id = ?").bind(id).run();
  return { ok: true };
}

/** 画面が選択肢を書き写さずに済むように、定義をまとめて返す。 */
export function metaverseCatalog() {
  return {
    places: PLACES,
    times: TIMES,
    cameras: CAMERAS,
    objectTypes: OBJECT_TYPES,
    slots: SLOTS,
    stamps: STAMPS,
    greetings: GREETING_LINES,
    maxPeople: MAX_PEOPLE,
    maxActorsPerPerson: MAX_ACTORS_PER_PERSON,
    maxObjects: MAX_OBJECTS,
    maxQuizQuestions: MAX_QUIZ_QUESTIONS,
    worldHalf: WORLD_HALF,
  };
}
