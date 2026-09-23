/**
 * メタバース — エリア（部屋）の設定と、ミニゲームの管理。
 *
 * わけたまで育った分身が、人格の数値どおりに動く共有の3D空間。
 * ここは「エリアの設定」と「ミニゲームの全体設定」を扱う層で、入室・移動・挨拶の中継は
 * Durable Object（metaverseRoom.ts）がやる。
 *
 * **エリアは管理画面でだけ作る・直す。** 利用者が自由に作れると、見知らぬ人に任意の画像や
 * 文字を見せる口になる。子どもも使うサービスなので、置く物はすべて運営が決める。
 *
 * エリアの設定:
 *   - 場所（草原・おへや・境内・海辺・夜空の丘）と時間帯（朝・昼・夕・夜）、最初のカメラ視点
 *   - 状態: 公開（open）／準備中（draft）／閉鎖（closed）、開放日時（それまでは「近日開放」）、終了日時、並び順
 *   - まとめる: 2つのエリアを1つにする。まとめた元（merged_into）へのリンクは、まとめた先へ案内する
 *   - 置く物（objects。最大7つ、決まった置き場所に1つずつ）:
 *       board / video / members         看板（広告・お知らせ）・動画・いまいる子の紹介
 *       treasure / quiz / rally         歩いて遊ぶミニゲーム
 *       tilt / shake / balance / voice / arhunt / skycatch / rhythm / hotcold / daruma / xr
 *                                        端末のセンサー（ジャイロ・加速度・マイク・カメラ・振動）や WebXR を使うミニゲーム
 *
 * 最初からあるエリア（BUILTIN_ROOMS）はコードにあるが、**同じIDのDB行があれば、その行が優先**される。
 * これで最初からあるエリアも、直す・閉じる・まとめるができる。
 *
 * ミニゲームは**その端末の中だけ**で遊ぶ（点数や結果をサーバーへ送らない）。
 * マイク・カメラ・センサーの値も端末の外へ出さない（画面の中で使って捨てる）。
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

export const STATUSES = [
  { id: "open", label: "公開" },
  { id: "draft", label: "準備中（管理者だけ）" },
  { id: "closed", label: "閉鎖" },
] as const;

/**
 * センサー・XRを使うミニゲームの定義。管理画面の入力欄も、ここから作る。
 * goal / seconds が null のものは、その設定を持たない（例: バランスは「秒」だけ）。
 */
export const SENSOR_GAMES = {
  tilt: {
    label: "かたむけコロコロ",
    sensors: ["ジャイロ"],
    how: "端末をかたむけると、分身が転がるように進む。制限時間内にコインを集める",
    fallback: "画面をなぞって進む",
    goal: { label: "コインの数", min: 3, max: 30, default: 8 },
    seconds: { min: 15, max: 180, default: 45 },
  },
  shake: {
    label: "ふりふりダッシュ",
    sensors: ["加速度"],
    how: "端末をふるほど分身が速く走る。制限時間内にゴールまで",
    fallback: "ボタンを連打",
    goal: { label: "走る距離（m）", min: 10, max: 100, default: 30 },
    seconds: { min: 10, max: 120, default: 20 },
  },
  balance: {
    label: "ゆらゆらバランス",
    sensors: ["ジャイロ"],
    how: "丸太の上の分身を、端末のかたむきで支える。落ちずに時間いっぱい",
    fallback: "画面の左右を押して支える",
    goal: null,
    seconds: { min: 10, max: 120, default: 30 },
  },
  voice: {
    label: "こえでジャンプ",
    sensors: ["マイク"],
    how: "声を出すと分身がジャンプ。転がってくる箱をとびこえる（声は大きさだけを端末の中で使い、録音も送信もしない）",
    fallback: "画面を押してジャンプ",
    goal: { label: "とびこえる数", min: 3, max: 50, default: 10 },
    seconds: { min: 20, max: 180, default: 60 },
  },
  arhunt: {
    label: "カメラでARさがし",
    sensors: ["カメラ", "ジャイロ"],
    how: "カメラの映像に星が浮かぶ。まわりを見回して、タップで集める（映像は画面に映すだけで、保存も送信もしない）",
    fallback: "画面をなぞって見回す",
    goal: { label: "星の数", min: 3, max: 30, default: 8 },
    seconds: { min: 15, max: 180, default: 45 },
  },
  skycatch: {
    label: "ぐるっと星キャッチ",
    sensors: ["ジャイロ"],
    how: "分身の目線でぐるっと見回し、飛んでいる星を画面の真ん中に合わせてキャッチ",
    fallback: "画面をなぞって見回す",
    goal: { label: "星の数", min: 3, max: 30, default: 10 },
    seconds: { min: 15, max: 180, default: 45 },
  },
  rhythm: {
    label: "ふりふりリズム",
    sensors: ["加速度"],
    how: "輪がちぢむのに合わせて、端末をふる（またはタップ）。7割ぴったりでクリア",
    fallback: "タップ",
    goal: { label: "ノーツの数", min: 8, max: 64, default: 16 },
    seconds: null,
  },
  hotcold: {
    label: "ホット＆コールド",
    sensors: ["コンパス", "振動"],
    how: "ぐるっと向きを変えて、かくれた宝の方角をさがす。近いほど震える",
    fallback: "画面をなぞって向きを変える",
    goal: { label: "見つける回数", min: 1, max: 10, default: 3 },
    seconds: { min: 20, max: 300, default: 90 },
  },
  daruma: {
    label: "だるまさんがころんだ",
    sensors: ["加速度"],
    how: "その場で足ぶみすると分身が進む。鬼がふり向いたら、端末をぴたっと止める",
    fallback: "ボタンを押している間だけ進む",
    goal: null,
    seconds: { min: 30, max: 300, default: 90 },
  },
  xr: {
    label: "ARでおでかけ",
    sensors: ["WebXR"],
    how: "現実の床に分身を出して、まわりに浮かぶシャボン玉をタップで割る（対応していない端末ではカメラの映像で遊ぶ）",
    fallback: "カメラの映像で遊ぶ",
    goal: { label: "シャボン玉の数", min: 3, max: 30, default: 10 },
    seconds: { min: 20, max: 180, default: 60 },
  },
} as const;

export type SensorGameId = keyof typeof SENSOR_GAMES;
const SENSOR_GAME_IDS = Object.keys(SENSOR_GAMES) as SensorGameId[];

export const OBJECT_TYPES = [
  { id: "board", label: "看板（広告・お知らせ）", game: false },
  { id: "video", label: "動画スクリーン", game: false },
  { id: "members", label: "いまいる子の紹介", game: false },
  { id: "treasure", label: "ミニゲーム：宝さがし", game: true },
  { id: "quiz", label: "ミニゲーム：○×クイズ", game: true },
  { id: "rally", label: "ミニゲーム：スタンプラリー", game: true },
  ...SENSOR_GAME_IDS.map((id) => ({ id, label: `ミニゲーム：${SENSOR_GAMES[id].label}`, game: true })),
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
/** ミニゲームを試すための、一覧に出さないエリア */
export const TEST_AREA_ID = "r-game-test";

type PlaceId = (typeof PLACES)[number]["id"];
type TimeId = (typeof TIMES)[number]["id"];
type CameraId = (typeof CAMERAS)[number]["id"];
type StatusId = (typeof STATUSES)[number]["id"];
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
  /** センサーのミニゲーム: 目標（コインの数・距離など。SENSOR_GAMES の goal）と難しさ（1〜3） */
  goal?: number;
  level?: number;
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
  status: StatusId;
  opensAt: number | null;
  closesAt: number | null;
  mergedInto: string | null;
  sortOrder: number;
}

/** 入れるかどうか（状態と日時から、いま決まるもの） */
export type AreaState = "open" | "soon" | "draft" | "closed" | "moved";

export function areaState(room: RoomConfig, now = Date.now()): AreaState {
  if (room.mergedInto) return "moved";
  if (room.status === "closed") return "closed";
  if (room.closesAt && now >= room.closesAt) return "closed";
  if (room.status === "draft") return "draft";
  if (room.opensAt && now < room.opensAt) return "soon";
  return "open";
}

const AREA_DEFAULTS = { status: "open" as StatusId, opensAt: null, closesAt: null, mergedInto: null };

/** 最初からあるエリア。DBに同じIDの行が無いときは、これがそのまま使われる。 */
export const BUILTIN_ROOMS: RoomConfig[] = [
  {
    id: "hiroba",
    name: "わけたまのひろば",
    place: "meadow",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 10,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "ようこそ", text: "地面をタップすると歩きます。分身をタップすると挨拶します。", ad: false },
      { id: "stars", type: "treasure", slot: "back-left", title: "宝さがし", text: "60秒で、星を10こ集めよう", count: 10, seconds: 60, clearMessage: "ぜんぶ見つけたね！" },
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
      { id: "tilt", type: "tilt", slot: "left", title: "かたむけコロコロ", text: "端末をかたむけてコインを集めよう", goal: 8, seconds: 45, level: 2, clearMessage: "コロコロ名人！" },
      { id: "shake", type: "shake", slot: "right", title: "ふりふりダッシュ", text: "端末をふって走ろう", goal: 30, seconds: 20, level: 2, clearMessage: "はやい！" },
      { id: "members", type: "members", slot: "front-left", title: "いまいる子", text: "" },
      { id: "rally", type: "rally", slot: "front-right", title: "スタンプラリー", text: "ひろばの旗を、ぜんぶまわろう", points: 4, clearMessage: "ひろばをひとまわりしたね！" },
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
    ...AREA_DEFAULTS,
    sortOrder: 20,
    objects: [
      { id: "members", type: "members", slot: "back", title: "今夜ここにいる子", text: "" },
      { id: "stars", type: "rally", slot: "left", title: "星めぐり", text: "丘の上の光を、ぜんぶたずねよう", points: 5, clearMessage: "星をぜんぶめぐったね。おやすみ" },
      { id: "sky", type: "skycatch", slot: "right", title: "ぐるっと星キャッチ", text: "見回して、流れ星をつかまえよう", goal: 10, seconds: 45, level: 2, clearMessage: "流れ星をつかまえた！" },
      { id: "hotcold", type: "hotcold", slot: "back-left", title: "ホット＆コールド", text: "月の宝の方角をさがそう", goal: 3, seconds: 90, level: 2, clearMessage: "宝を見つけた！" },
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

function timeOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
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
    } else if (type in SENSOR_GAMES) {
      const spec = SENSOR_GAMES[type as SensorGameId];
      if (spec.goal) base.goal = intIn(o.goal, spec.goal.min, spec.goal.max, spec.goal.default);
      if (spec.seconds) base.seconds = intIn(o.seconds, spec.seconds.min, spec.seconds.max, spec.seconds.default);
      base.level = intIn(o.level, 1, 3, 2);
      base.clearMessage = cleanText(o.clearMessage, 60);
    }
    out.push(base);
  }
  return { ok: true, value: out };
}

/** エリアの設定を整える（管理画面から来たもの）。 */
export function sanitizeRoomInput(
  raw: Record<string, unknown>
): { ok: true; value: Omit<RoomConfig, "id" | "builtin" | "mergedInto"> } | { ok: false; error: string } {
  const name = cleanText(raw.name, 30);
  if (!name) return { ok: false, error: "エリアの名前を入れてください" };
  const objects = sanitizeObjects(raw.objects);
  if (!objects.ok) return objects;
  const opensAt = timeOrNull(raw.opensAt);
  const closesAt = timeOrNull(raw.closesAt);
  if (opensAt && closesAt && closesAt <= opensAt) return { ok: false, error: "終了日時は、開放日時より後にしてください" };
  return {
    ok: true,
    value: {
      name,
      place: pick(PLACES, raw.place, "meadow") as PlaceId,
      time: pick(TIMES, raw.time, "day") as TimeId,
      camera: pick(CAMERAS, raw.camera, "overview") as CameraId,
      objects: objects.value,
      listed: raw.listed !== false,
      status: pick(STATUSES, raw.status, "open") as StatusId,
      opensAt,
      closesAt,
      sortOrder: intIn(raw.sortOrder, 0, 9999, 100),
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
  status: string | null;
  opens_at: number | null;
  closes_at: number | null;
  merged_into: string | null;
  sort_order: number | null;
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
    builtin: BUILTIN_ROOMS.some((b) => b.id === r.id),
    status: pick(STATUSES, r.status, "open") as StatusId,
    opensAt: r.opens_at ?? null,
    closesAt: r.closes_at ?? null,
    mergedInto: r.merged_into ?? null,
    sortOrder: r.sort_order ?? 100,
  };
}

// ---- ミニゲームの全体設定（有効・停止と既定値） ----

export interface GameSettings {
  /** 止めたミニゲームの種類。止めると、どのエリアからも消える（置いた設定は残る） */
  disabled: string[];
  /** エリアに置くときの既定値（管理画面で「置く」を押したときの初期値） */
  defaults: Record<string, { seconds?: number; goal?: number; level?: number; clearMessage?: string }>;
}

const EMPTY_SETTINGS: GameSettings = { disabled: [], defaults: {} };
const GAME_TYPE_IDS = OBJECT_TYPES.filter((t) => t.game).map((t) => t.id as string);

export async function getGameSettings(env: MetaverseEnv): Promise<GameSettings> {
  try {
    const row = await env.DB.prepare("SELECT value FROM meta_settings WHERE key = 'games'").first<{ value: string }>();
    if (!row) return EMPTY_SETTINGS;
    const v = JSON.parse(row.value) as Partial<GameSettings>;
    return {
      disabled: Array.isArray(v.disabled) ? v.disabled.filter((x) => GAME_TYPE_IDS.includes(x)) : [],
      defaults: typeof v.defaults === "object" && v.defaults ? v.defaults : {},
    };
  } catch {
    return EMPTY_SETTINGS;
  }
}

export async function saveGameSettings(env: MetaverseEnv, raw: Record<string, unknown>): Promise<GameSettings> {
  const disabled = Array.isArray(raw.disabled) ? raw.disabled.filter((x): x is string => typeof x === "string" && GAME_TYPE_IDS.includes(x)) : [];
  const defaults: GameSettings["defaults"] = {};
  const src = (raw.defaults ?? {}) as Record<string, Record<string, unknown>>;
  for (const type of GAME_TYPE_IDS) {
    const d = src[type];
    if (!d || typeof d !== "object") continue;
    // 置く物と同じ検査を通して、範囲外の既定値を作らない
    const goal = d.goal ?? d.count ?? d.points;
    const checked = sanitizeObjects([{ type, slot: "back", ...d, count: goal, points: goal, goal, questions: [{ q: "仮", a: "o" }] }]);
    if (!checked.ok) continue;
    const o = checked.value[0];
    defaults[type] = { seconds: o.seconds, goal: o.goal ?? o.count ?? o.points, level: o.level, clearMessage: o.clearMessage };
  }
  const value: GameSettings = { disabled: [...new Set(disabled)], defaults };
  await env.DB.prepare(
    "INSERT INTO meta_settings (key, value, updated_at) VALUES ('games', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  )
    .bind(JSON.stringify(value), Date.now())
    .run();
  return value;
}

/** 利用者の画面に渡す形（止めたミニゲームを抜く） */
export function publicRoom(room: RoomConfig, settings: GameSettings): RoomConfig {
  if (settings.disabled.length === 0) return room;
  return { ...room, objects: room.objects.filter((o) => !settings.disabled.includes(o.type)) };
}

// ---- エリアの読み書き ----

async function rowOf(env: MetaverseEnv, id: string): Promise<RoomRow | null> {
  return env.DB.prepare("SELECT * FROM meta_rooms WHERE id = ?").bind(id).first<RoomRow>();
}

/** 1エリアの設定（DBの行があれば優先、無ければ最初からあるエリア） */
export async function getRoom(env: MetaverseEnv, id: unknown): Promise<RoomConfig | null> {
  if (!isValidRoomId(id)) return null;
  const row = await rowOf(env, id);
  if (row) return fromRow(row);
  return BUILTIN_ROOMS.find((r) => r.id === id) ?? null;
}

/**
 * まとめた先をたどる（まとめた先がさらにまとめられていても、最後まで）。
 * 行き先が無い・輪になっている場合は null。
 */
export async function resolveRoom(env: MetaverseEnv, id: unknown): Promise<{ room: RoomConfig; movedFrom: string | null } | null> {
  let room = await getRoom(env, id);
  if (!room) return null;
  const start = room.id;
  const seen = new Set<string>();
  while (room.mergedInto) {
    if (seen.has(room.id)) return null;
    seen.add(room.id);
    const next: RoomConfig | null = await getRoom(env, room.mergedInto);
    if (!next) return null;
    room = next;
  }
  return { room, movedFrom: room.id === start ? null : start };
}

/** 管理画面向け: すべてのエリア（最初からあるエリアも、まとめた元も） */
export async function listAdminRooms(env: MetaverseEnv): Promise<Array<RoomConfig & { state: AreaState; overridden: boolean }>> {
  const rows = await env.DB.prepare("SELECT * FROM meta_rooms ORDER BY sort_order ASC, updated_at DESC LIMIT 300").all<RoomRow>();
  const fromDb = (rows.results ?? []).map(fromRow);
  const ids = new Set(fromDb.map((r) => r.id));
  const builtins = BUILTIN_ROOMS.filter((b) => !ids.has(b.id));
  const all = [...builtins, ...fromDb].map((r) => ({ ...r, state: areaState(r), overridden: r.builtin && ids.has(r.id) }));
  return all.sort((a, b) => a.sortOrder - b.sortOrder);
}

/** ロビーに並べるエリア（公開中と近日開放。一覧に出す設定のものだけ） */
export async function listRooms(env: MetaverseEnv): Promise<Array<RoomConfig & { state: AreaState }>> {
  const settings = await getGameSettings(env);
  const all = await listAdminRooms(env);
  return all
    .filter((r) => r.listed && (r.state === "open" || r.state === "soon") && r.id !== TEST_AREA_ID)
    .map((r) => ({ ...publicRoom(r, settings), state: r.state }));
}

async function upsertRow(env: MetaverseEnv, id: string, v: Omit<RoomConfig, "id" | "builtin">) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO meta_rooms (id, name, place, time_of_day, camera, objects, listed, status, opens_at, closes_at, merged_into, sort_order, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, place=excluded.place, time_of_day=excluded.time_of_day, camera=excluded.camera,
       objects=excluded.objects, listed=excluded.listed, status=excluded.status, opens_at=excluded.opens_at, closes_at=excluded.closes_at,
       merged_into=excluded.merged_into, sort_order=excluded.sort_order, updated_at=excluded.updated_at`
  )
    .bind(
      id,
      v.name,
      v.place,
      v.time,
      v.camera,
      JSON.stringify(v.objects),
      v.listed ? 1 : 0,
      v.status,
      v.opensAt,
      v.closesAt,
      v.mergedInto,
      v.sortOrder,
      now,
      now
    )
    .run();
}

/**
 * エリアを作る・直す（管理画面から。id を渡せば更新）。
 * 最初からあるエリアのIDを渡すと、同じIDの行を作って上書きする。
 */
export async function saveRoom(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; room: RoomConfig } | { ok: false; status: number; error: string }> {
  const input = sanitizeRoomInput(raw);
  if (!input.ok) return { ok: false, status: 400, error: input.error };
  let id = typeof raw.id === "string" && raw.id ? raw.id : "";
  let mergedInto: string | null = null;
  if (id) {
    if (!isValidRoomId(id)) return { ok: false, status: 400, error: "エリアのIDが正しくありません" };
    const current = await getRoom(env, id);
    if (!current) return { ok: false, status: 404, error: "そのエリアはありません" };
    // 直すだけでは、まとめた状態は解かない（解くときは「まとめを解く」を明示的に）
    mergedInto = raw.unmerge === true ? null : current.mergedInto;
  } else {
    id = `r-${randomId(8)}`;
  }
  const v = { ...input.value, mergedInto };
  await upsertRow(env, id, v);
  return { ok: true, room: { id, ...v, builtin: BUILTIN_ROOMS.some((b) => b.id === id) } };
}

/**
 * 2つ以上のエリアを1つにまとめる。
 * target の設定（置く物は、管理画面で重なりを直した最終形）で保存し、source は merged_into = target にする。
 * source のリンクで来た人・source にいま居る人は、target へ案内される。
 */
export async function mergeRooms(
  env: MetaverseEnv,
  raw: Record<string, unknown>
): Promise<{ ok: true; room: RoomConfig; merged: string[] } | { ok: false; status: number; error: string }> {
  const targetId = typeof raw.targetId === "string" ? raw.targetId : "";
  const sources = Array.isArray(raw.sourceIds) ? raw.sourceIds.filter((x): x is string => typeof x === "string") : [];
  if (!isValidRoomId(targetId) || sources.length === 0) return { ok: false, status: 400, error: "まとめる先と、まとめるエリアを選んでください" };
  if (sources.includes(targetId)) return { ok: false, status: 400, error: "まとめる先と同じエリアは選べません" };
  const target = await getRoom(env, targetId);
  if (!target) return { ok: false, status: 404, error: "まとめる先のエリアがありません" };
  const sourceRooms: RoomConfig[] = [];
  for (const s of sources) {
    const r = await getRoom(env, s);
    if (!r) return { ok: false, status: 404, error: `エリア ${s} がありません` };
    sourceRooms.push(r);
  }
  const saved = await saveRoom(env, { ...(raw.room as Record<string, unknown>), id: targetId, unmerge: true });
  if (!saved.ok) return saved;
  for (const r of sourceRooms) {
    await upsertRow(env, r.id, { ...r, mergedInto: targetId });
  }
  return { ok: true, room: saved.room, merged: sourceRooms.map((r) => r.id) };
}

/** 消す（作ったエリアだけ。最初からあるエリアは「閉鎖」にする。上書きの行を消すと元に戻る） */
export async function deleteRoom(env: MetaverseEnv, id: unknown): Promise<{ ok: boolean; restored?: boolean }> {
  if (!isValidRoomId(id)) return { ok: false };
  await env.DB.prepare("DELETE FROM meta_rooms WHERE id = ?").bind(id).run();
  // まとめ先として指されていたら、指している側のまとめを解く（行き先の無いリンクを作らない）
  await env.DB.prepare("UPDATE meta_rooms SET merged_into = NULL WHERE merged_into = ?").bind(id).run();
  return { ok: true, restored: BUILTIN_ROOMS.some((b) => b.id === id) };
}

/** ミニゲームを試すためのエリアに、その1つだけを置く（一覧には出さない） */
export async function upsertTestArea(env: MetaverseEnv, type: unknown): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!GAME_TYPE_IDS.includes(String(type))) return { ok: false, error: "そのミニゲームはありません" };
  const settings = await getGameSettings(env);
  const d = settings.defaults[String(type)] ?? {};
  const obj: Record<string, unknown> = {
    type,
    slot: "back",
    ...d,
    count: d.goal,
    points: d.goal,
    questions: BUILTIN_ROOMS[0].objects.find((o) => o.type === "quiz")?.questions ?? [{ q: "これは試しの問題です", a: "o", note: "○が正解でした" }],
  };
  const checked = sanitizeObjects([obj]);
  if (!checked.ok) return { ok: false, error: checked.error };
  await upsertRow(env, TEST_AREA_ID, {
    name: "ミニゲームの試し場",
    place: "meadow",
    time: "day",
    camera: "overview",
    objects: checked.value,
    listed: false,
    // 準備中＝管理者だけが入れる（管理画面のCookieで判定）
    status: "draft",
    opensAt: null,
    closesAt: null,
    mergedInto: null,
    sortOrder: 9999,
  });
  return { ok: true, id: TEST_AREA_ID };
}

/** 画面が選択肢を書き写さずに済むように、定義をまとめて返す。 */
export function metaverseCatalog() {
  return {
    places: PLACES,
    times: TIMES,
    cameras: CAMERAS,
    statuses: STATUSES,
    objectTypes: OBJECT_TYPES,
    sensorGames: SENSOR_GAMES,
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
