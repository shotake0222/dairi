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
 *       shop                            お店（メタバースの通貨で買い物・提携店の引換券へ。src/economy.ts）
 *       treasure / quiz / rally         歩いて遊ぶミニゲーム
 *       tilt / shake / balance / voice / arhunt / skycatch / rhythm / hotcold / daruma / xr
 *       fishing / pour / maze / balloon / tower / colorhunt / hanetsuki / taiko / sled / nenne
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
  // 2026-09-23 追加（和風を中心に10か所）
  { id: "sakura", label: "桜の神社" },
  { id: "garden", label: "和の庭園" },
  { id: "onsen", label: "温泉街" },
  { id: "bamboo", label: "竹林の小径" },
  { id: "momiji", label: "紅葉の山寺" },
  { id: "matsuri", label: "夏祭りの参道" },
  { id: "snow", label: "雪の里" },
  { id: "lake", label: "星降る湖" },
  { id: "forest", label: "森のひろば" },
  { id: "flower", label: "花畑" },
  // 2026-09-23 さらに追加の10か所
  { id: "castle", label: "お城の城下町" },
  { id: "tanabata", label: "七夕の笹かざり" },
  { id: "paddy", label: "田んぼのあぜ道" },
  { id: "inari", label: "千本鳥居" },
  { id: "harbor", label: "港町の灯台" },
  { id: "desert", label: "砂丘のオアシス" },
  { id: "candy", label: "おかしの国" },
  { id: "moon", label: "月面ステーション" },
  { id: "undersea", label: "海の底" },
  { id: "park", label: "ゆうえんち" },
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
    seconds: { min: 10, max: 120, default: 30, label: "落ちずに" },
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
  // ---- 2026-09-23 に足した10種類 ----
  fishing: {
    label: "ふりふり釣りぼり",
    sensors: ["加速度", "振動"],
    how: "端末をふって糸を投げ、ウキがしずんで震えたら、すばやく端末をふり上げて釣り上げる",
    fallback: "ボタンで投げる・引く",
    goal: { label: "釣る数", min: 1, max: 15, default: 3 },
    seconds: { min: 30, max: 300, default: 90 },
  },
  pour: {
    label: "ぴったりジュース",
    sensors: ["ジャイロ"],
    how: "端末をかたむけて、コップの線までジュースをそそぐ。こぼさず、線にぴったり",
    fallback: "ボタンを押している間だけそそぐ",
    goal: { label: "そそぐ杯数", min: 1, max: 10, default: 3 },
    seconds: { min: 20, max: 180, default: 60 },
  },
  maze: {
    label: "かたむけ迷路",
    sensors: ["ジャイロ"],
    how: "端末をかたむけて、迷路の中の分身をゴールの旗まで転がす",
    fallback: "画面をなぞって転がす",
    goal: { label: "迷路の数", min: 1, max: 5, default: 2 },
    seconds: { min: 30, max: 300, default: 90 },
  },
  balloon: {
    label: "ふーふー風船",
    sensors: ["マイク"],
    how: "マイクに息をふきかけて、風船をふくらませる。大きくしすぎると割れる（声は大きさだけを端末の中で使い、録音も送信もしない）",
    fallback: "ボタンを押している間ふくらむ",
    goal: { label: "ふくらませる数", min: 1, max: 10, default: 3 },
    seconds: { min: 20, max: 180, default: 60 },
  },
  tower: {
    label: "つみつみタワー",
    sensors: ["ジャイロ"],
    how: "ゆれるブロックを、端末のかたむきで位置を合わせてタップで落とす。高く積み上げよう",
    fallback: "画面をなぞって位置を合わせる",
    goal: { label: "積む段数", min: 3, max: 30, default: 8 },
    seconds: null,
  },
  colorhunt: {
    label: "カメラで色さがし",
    sensors: ["カメラ"],
    how: "お題の色（赤・青・黄…）の物を、身のまわりから探してカメラの真ん中に映す（映像は色を読むだけで、保存も送信もしない）",
    fallback: "画面の色パレットから選ぶ",
    goal: { label: "見つける色の数", min: 1, max: 8, default: 4 },
    seconds: { min: 30, max: 300, default: 90 },
  },
  hanetsuki: {
    label: "はねつき",
    sensors: ["加速度"],
    how: "落ちてくる羽根に合わせて端末をふり、羽子板で打ち返す。落とさずに続けよう",
    fallback: "タップで打ち返す",
    goal: { label: "続ける回数", min: 3, max: 50, default: 10 },
    seconds: null,
  },
  taiko: {
    label: "わだいこ",
    sensors: ["加速度", "タッチ"],
    how: "流れてくる太鼓の合図に合わせて、赤い「ドン」は画面をタップ、青い「カッ」は端末をふる",
    fallback: "「カッ」は右のボタン",
    goal: { label: "合図の数", min: 8, max: 64, default: 20 },
    seconds: null,
  },
  sled: {
    label: "そりすべり",
    sensors: ["ジャイロ"],
    how: "雪山をそりですべり下りる。端末を左右にかたむけて、旗の門をくぐる",
    fallback: "画面の左右を押してまがる",
    goal: { label: "くぐる門の数", min: 3, max: 30, default: 10 },
    seconds: { min: 20, max: 180, default: 60 },
  },
  nenne: {
    label: "ねんねタイム",
    sensors: ["マイク", "加速度"],
    how: "分身が眠るまで、しずかにして端末を動かさない。物音や揺れで起きてしまう（声は大きさだけを端末の中で使い、録音も送信もしない）",
    fallback: "画面にさわらずに待つ",
    goal: null,
    // 制限時間ではなく「しずかにしていれば眠るまでの時間」（その2.5倍＋10秒で時間切れ）
    seconds: { min: 10, max: 120, default: 30, label: "眠るまで" },
  },
} as const;

export type SensorGameId = keyof typeof SENSOR_GAMES;
const SENSOR_GAME_IDS = Object.keys(SENSOR_GAMES) as SensorGameId[];

export const OBJECT_TYPES = [
  { id: "board", label: "看板（広告・お知らせ）", game: false },
  { id: "video", label: "動画スクリーン", game: false },
  { id: "members", label: "いまいる子の紹介", game: false },
  { id: "shop", label: "お店（通貨で買い物・引き換え）", game: false },
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

/** 区画の場所（エリアの外周。置く物の7か所とは重ならない） */
export const LAND_SPOTS = [
  { id: "nw", label: "左奥の角", x: -8.0, z: -7.6 },
  { id: "ne", label: "右奥の角", x: 8.0, z: -7.6 },
  { id: "bl", label: "奥の左", x: -2.9, z: -8.3 },
  { id: "br", label: "奥の右", x: 2.9, z: -8.3 },
  { id: "lb", label: "左の奥", x: -8.4, z: -3.1 },
  { id: "rb", label: "右の奥", x: 8.4, z: -3.1 },
  { id: "sw", label: "左手前の角", x: -8.0, z: 8.0 },
  { id: "se", label: "右手前の角", x: 8.0, z: 8.0 },
] as const;

/** デジタルランドマークの形（画面側 public/meta/land.mjs で組み立てる） */
export const LANDMARK_MODELS = [
  { id: "tower", label: "時計塔" },
  { id: "torii", label: "鳥居" },
  { id: "tree", label: "大きな木" },
  { id: "fountain", label: "噴水" },
  { id: "balloon", label: "気球" },
  { id: "monument", label: "記念碑" },
  { id: "lantern", label: "大灯籠" },
  { id: "statue", label: "たまごの像" },
] as const;

export const LANDMARK_COLORS = [
  { id: "gold", label: "金", hex: "#e8b93a" },
  { id: "red", label: "朱", hex: "#d8443a" },
  { id: "blue", label: "青", hex: "#4f8fe0" },
  { id: "green", label: "緑", hex: "#4fb36a" },
  { id: "pink", label: "桃", hex: "#f28fb8" },
  { id: "white", label: "白", hex: "#f4f1ea" },
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
  /** 看板の詳しい説明（タップで開く詳細画面に出す。200文字まで） */
  detail?: string;
  /** 特別クーポン（詳細画面に出す）。コード・説明・期限 */
  couponCode?: string;
  couponNote?: string;
  couponUntil?: number | null;
  /** 詳細画面のQRコードが指す先（https）。空ならリンク先 */
  qrUrl?: string;
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
  /** お店: どのお店か（通貨・お店の管理で作ったお店の ID。src/economy.ts） */
  shopId?: string;
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
  /**
   * 部屋に入った人へ渡すときだけ付く（src/metaRoomView.ts が組み立てる）。
   * npcs の cid（分身の識別子）は部屋の中だけで使い、画面へは渡さない（metaverseRoom.ts の publicConfig）。
   */
  npcs?: Array<{ aid: string; cid: string } & Record<string, unknown>>;
  placements?: Array<Record<string, unknown>>;
  plotsForSale?: Array<Record<string, unknown>>;
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
      { id: "stars", type: "treasure", slot: "left", title: "宝さがし", text: "60秒で、星を10こ集めよう", count: 10, seconds: 60, clearMessage: "ぜんぶ見つけたね！" },
      {
        id: "quiz",
        type: "quiz",
        slot: "right",
        title: "わけたま○×クイズ",
        text: "○か×の場所へ、分身を歩かせてね",
        questions: [
          { q: "分身は、依代ひとつにつき1体。", a: "o", note: "1つの依代には、1体の分身が宿ります" },
          { q: "分身と話すには、アプリのインストールが必要。", a: "x", note: "かざすだけ。アプリは要りません" },
          { q: "分身は、話しかけるほど性格が育つ。", a: "o", note: "会話を重ねるほど、その子らしくなります" },
        ],
        clearMessage: "全問正解！",
      },
      { id: "zakka", type: "shop", slot: "back-left", title: "ひろばの雑貨屋", text: "遊んで貯めたコインで、おしゃれしよう", shopId: "zakka" },
      { id: "koukan", type: "shop", slot: "back-right", title: "引き換え所", text: "コインを、町のお店の引換券にかえる", shopId: "koukan" },
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
  // ---- 2026-09-23 追加の10エリア（和風・神社を中心に） ----
  {
    id: "sakura-jinja",
    name: "桜の神社",
    place: "sakura",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 30,
    objects: [
      { id: "omairi", type: "board", slot: "back", title: "ようこそ桜の神社へ", text: "鳥居をくぐって、分身といっしょにお参りしよう。", ad: false },
      { id: "omikuji", type: "quiz", slot: "back-left", title: "おみくじ○×", text: "神社の豆知識クイズ", questions: [
        { q: "鳥居は、神様の場所への入口のしるし。", a: "o", note: "鳥居の内側は神様の場所とされます" },
        { q: "参道の真ん中は、神様の通り道といわれる。", a: "o", note: "端を歩くのが丁寧とされます" },
        { q: "お賽銭は、投げ入れるほど願いが叶う。", a: "x", note: "静かに入れるのが丁寧です" },
      ], clearMessage: "大吉！" },
      { id: "hanabira", type: "skycatch", slot: "back-right", title: "花びらキャッチ", text: "舞う花びらを見回してつかまえよう", goal: 10, seconds: 45, level: 1, clearMessage: "春をつかまえた！" },
      { id: "sando", type: "rally", slot: "left", title: "参道めぐり", text: "境内の灯籠をめぐろう", points: 5, clearMessage: "お参り完了！" },
      { id: "members", type: "members", slot: "right", title: "お参り中の子", text: "" },
      { id: "hanetsuki", type: "hanetsuki", slot: "front-left", title: "境内のはねつき", text: "羽根を落とさずに打ち返そう", goal: 10, level: 1, clearMessage: "おみごと！" },
    ],
  },
  {
    id: "wa-teien",
    name: "和の庭園",
    place: "garden",
    time: "morning",
    camera: "front",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 40,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "和の庭園", text: "池のまわりを、ゆっくり歩いてみよう。", ad: false },
      { id: "balance", type: "balance", slot: "left", title: "飛び石わたり", text: "丸太の橋をわたろう", seconds: 25, level: 1, clearMessage: "おみごと！" },
      { id: "hotcold", type: "hotcold", slot: "right", title: "かくれ石さがし", text: "庭のどこかの宝の方角をさがそう", goal: 2, seconds: 90, level: 1, clearMessage: "見つけた！" },
      { id: "members", type: "members", slot: "front-left", title: "庭にいる子", text: "" },
    ],
  },
  {
    id: "onsen-gai",
    name: "ゆけむり温泉街",
    place: "onsen",
    time: "evening",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 50,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "ゆけむり温泉街", text: "湯けむりの町を、分身とおさんぽ。", ad: false },
      { id: "tilt", type: "tilt", slot: "back-left", title: "温泉たまごコロコロ", text: "かたむけてたまごを集めよう", goal: 8, seconds: 45, level: 2, clearMessage: "ほかほか！" },
      { id: "treasure", type: "treasure", slot: "back-right", title: "湯のはな集め", text: "町に落ちている湯のはなを集めよう", count: 8, seconds: 60, clearMessage: "いい湯だな！" },
      { id: "members", type: "members", slot: "front-right", title: "湯上がりの子", text: "" },
    ],
  },
  {
    id: "chikurin",
    name: "竹林の小径",
    place: "bamboo",
    time: "day",
    camera: "follow",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 60,
    objects: [
      { id: "daruma", type: "daruma", slot: "back", title: "竹林のだるまさん", text: "鬼がふり向いたら止まって！", seconds: 90, level: 2, clearMessage: "タッチ！" },
      { id: "voice", type: "voice", slot: "left", title: "こだまジャンプ", text: "声でジャンプして進もう", goal: 8, seconds: 60, level: 1, clearMessage: "こだまが返ってきた！" },
      { id: "members", type: "members", slot: "right", title: "小径の子", text: "" },
    ],
  },
  {
    id: "momiji-dera",
    name: "紅葉の山寺",
    place: "momiji",
    time: "evening",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 70,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "紅葉の山寺", text: "赤と黄色の葉っぱが、ひらひら。", ad: false },
      { id: "rally", type: "rally", slot: "back-left", title: "もみじ狩り", text: "山寺の紅葉スポットをめぐろう", points: 5, clearMessage: "秋を満喫！" },
      { id: "rhythm", type: "rhythm", slot: "back-right", title: "鐘つきリズム", text: "鐘の音に合わせてふろう", goal: 12, level: 1, clearMessage: "ごーん！" },
      { id: "members", type: "members", slot: "front-left", title: "山寺の子", text: "" },
    ],
  },
  {
    id: "natsu-matsuri",
    name: "夏祭りの参道",
    place: "matsuri",
    time: "night",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 80,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "夏祭り", text: "提灯のあかりの下で、屋台めぐり！", ad: false },
      { id: "shake", type: "shake", slot: "back-left", title: "おみこしダッシュ", text: "ふって、おみこしを運ぼう", goal: 30, seconds: 25, level: 2, clearMessage: "わっしょい！" },
      { id: "treasure", type: "treasure", slot: "back-right", title: "金魚すくい", text: "逃げる金魚（星）を集めよう", count: 10, seconds: 60, clearMessage: "大漁！" },
      { id: "skycatch", type: "skycatch", slot: "left", title: "花火キャッチ", text: "夜空の花火を見回してキャッチ", goal: 8, seconds: 45, level: 2, clearMessage: "たまや〜！" },
      { id: "members", type: "members", slot: "right", title: "お祭りの子", text: "" },
      { id: "taiko", type: "taiko", slot: "front-left", title: "お祭り太鼓", text: "ドンとカッで、お祭りを盛り上げよう", goal: 20, level: 1, clearMessage: "よっ、名人！" },
      { id: "hanabi", type: "shop", slot: "front-right", title: "花火屋", text: "みんなに見える花火や紙ふぶき", shopId: "hanabi" },
    ],
  },
  {
    id: "yuki-no-sato",
    name: "雪の里",
    place: "snow",
    time: "morning",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 90,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "雪の里", text: "まっしろな雪の上を歩いてみよう。", ad: false },
      { id: "tilt", type: "tilt", slot: "left", title: "雪玉コロコロ", text: "かたむけて雪玉を大きく", goal: 10, seconds: 50, level: 2, clearMessage: "大きな雪だるま！" },
      { id: "arhunt", type: "arhunt", slot: "right", title: "雪の結晶さがし", text: "カメラで結晶をさがそう", goal: 8, seconds: 45, level: 1, clearMessage: "きらきら！" },
      { id: "members", type: "members", slot: "front-left", title: "雪あそびの子", text: "" },
      { id: "sled", type: "sled", slot: "back-left", title: "そりすべり", text: "旗の門をくぐって、雪山をすべろう", goal: 10, seconds: 60, level: 1, clearMessage: "ひゃっほう！" },
    ],
  },
  {
    id: "hoshi-mizuumi",
    name: "星降る湖",
    place: "lake",
    time: "night",
    camera: "front",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 100,
    objects: [
      { id: "skycatch", type: "skycatch", slot: "back", title: "流れ星キャッチ", text: "湖に映る流れ星をつかまえよう", goal: 10, seconds: 45, level: 2, clearMessage: "願いごと、とどいたかな" },
      { id: "xr", type: "xr", slot: "left", title: "ARシャボン玉", text: "現実の床でシャボン玉割り", goal: 10, seconds: 60, level: 1, clearMessage: "パチパチ！" },
      { id: "members", type: "members", slot: "right", title: "湖のほとりの子", text: "" },
    ],
  },
  {
    id: "mori-hiroba",
    name: "森のひろば",
    place: "forest",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 110,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "森のひろば", text: "木もれびの中で、みんなとあそぼう。", ad: false },
      { id: "treasure", type: "treasure", slot: "back-left", title: "どんぐり拾い", text: "森のどんぐりを集めよう", count: 12, seconds: 60, clearMessage: "どんぐりいっぱい！" },
      { id: "balance", type: "balance", slot: "back-right", title: "丸太わたり", text: "丸太の上でバランス", seconds: 30, level: 2, clearMessage: "わたりきった！" },
      { id: "members", type: "members", slot: "front-right", title: "森の子", text: "" },
    ],
  },
  {
    id: "hanabatake",
    name: "花畑",
    place: "flower",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 120,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "花畑", text: "色とりどりの花のあいだを、おさんぽ。", ad: false },
      { id: "rally", type: "rally", slot: "left", title: "花めぐり", text: "花畑の旗をまわろう", points: 6, clearMessage: "いい香り！" },
      { id: "rhythm", type: "rhythm", slot: "right", title: "ちょうちょリズム", text: "ちょうちょに合わせてふろう", goal: 16, level: 2, clearMessage: "ひらひら！" },
      { id: "members", type: "members", slot: "front-left", title: "花畑の子", text: "" },
    ],
  },
  // ---- 2026-09-23 さらに追加の10エリア（和風4か所＋いろいろ） ----
  {
    id: "oshiro",
    name: "お城の城下町",
    place: "castle",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 130,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "お城の城下町", text: "天守を見上げながら、城下町をおさんぽ。", ad: false },
      { id: "tower", type: "tower", slot: "back-left", title: "石垣つみつみ", text: "石を高く積み上げよう", goal: 8, level: 1, clearMessage: "りっぱな石垣！" },
      { id: "taiko", type: "taiko", slot: "back-right", title: "出陣の太鼓", text: "ドンとカッを打ち分けよう", goal: 20, level: 2, clearMessage: "えいえい、おー！" },
      { id: "quiz", type: "quiz", slot: "left", title: "お城○×クイズ", text: "お城の豆知識", questions: [
        { q: "天守のてっぺんには、しゃちほこが飾られることがある。", a: "o", note: "火よけのお守りとされます" },
        { q: "お城の石垣は、ぜんぶ同じ大きさの石で積まれている。", a: "x", note: "大小の石を組み合わせて積みます" },
        { q: "お堀は、お城を守るために作られた。", a: "o", note: "敵が近づきにくくするためです" },
      ], clearMessage: "お殿様もびっくり！" },
      { id: "members", type: "members", slot: "right", title: "城下町の子", text: "" },
    ],
  },
  {
    id: "tanabata",
    name: "七夕の笹かざり",
    place: "tanabata",
    time: "night",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 140,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "七夕の夜", text: "天の川の下で、短冊に願いごとを。", ad: false },
      { id: "colorhunt", type: "colorhunt", slot: "back-left", title: "短冊の色さがし", text: "短冊と同じ色を、身のまわりから探そう", goal: 4, seconds: 90, level: 1, clearMessage: "願いがかないますように" },
      { id: "skycatch", type: "skycatch", slot: "back-right", title: "天の川キャッチ", text: "見回して、星をつかまえよう", goal: 10, seconds: 45, level: 2, clearMessage: "織姫と彦星も会えたかな" },
      { id: "nenne", type: "nenne", slot: "left", title: "星の下でねんね", text: "しずかに、分身が眠るまで", seconds: 30, level: 1, clearMessage: "おやすみなさい" },
      { id: "members", type: "members", slot: "right", title: "七夕の子", text: "" },
    ],
  },
  {
    id: "tanbo",
    name: "田んぼのあぜ道",
    place: "paddy",
    time: "evening",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 150,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "田んぼのあぜ道", text: "夕やけの田んぼを、かかしといっしょに。", ad: false },
      { id: "fishing", type: "fishing", slot: "back-left", title: "ため池の釣り", text: "ウキがしずんだら、ふり上げよう", goal: 3, seconds: 90, level: 1, clearMessage: "大漁だ！" },
      { id: "daruma", type: "daruma", slot: "back-right", title: "かかしがころんだ", text: "かかしがふり向いたら止まって！", seconds: 90, level: 1, clearMessage: "タッチ！" },
      { id: "rally", type: "rally", slot: "left", title: "あぜ道さんぽ", text: "田んぼの旗をめぐろう", points: 5, clearMessage: "いい夕やけ！" },
      { id: "members", type: "members", slot: "right", title: "あぜ道の子", text: "" },
    ],
  },
  {
    id: "senbon-torii",
    name: "千本鳥居",
    place: "inari",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 160,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "千本鳥居", text: "朱色の鳥居がずらり。きつねさんにごあいさつ。", ad: false },
      { id: "maze", type: "maze", slot: "back-left", title: "鳥居の迷い道", text: "かたむけて、迷路をぬけよう", goal: 2, seconds: 90, level: 1, clearMessage: "ぬけられた！" },
      { id: "quiz", type: "quiz", slot: "back-right", title: "お稲荷さん○×", text: "稲荷神社の豆知識", questions: [
        { q: "お稲荷さんでは、きつねが神様のお使いとされる。", a: "o", note: "きつねは神様のお使いです" },
        { q: "鳥居は、ぜんぶ青色でぬられている。", a: "x", note: "朱色の鳥居が多いです" },
        { q: "鳥居は、願いがかなったお礼に奉納されることがある。", a: "o", note: "感謝の気持ちで納められます" },
      ], clearMessage: "こんこん、正解！" },
      { id: "hanetsuki", type: "hanetsuki", slot: "left", title: "はねつき", text: "羽根を落とさずに打ち返そう", goal: 12, level: 2, clearMessage: "おみごと！" },
      { id: "members", type: "members", slot: "right", title: "お参り中の子", text: "" },
    ],
  },
  {
    id: "minato",
    name: "港町の灯台",
    place: "harbor",
    time: "evening",
    camera: "front",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 170,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "港町", text: "灯台と船と、かもめの声。", ad: false },
      { id: "fishing", type: "fishing", slot: "back-left", title: "桟橋の釣り", text: "ふって投げて、ふり上げて釣ろう", goal: 4, seconds: 90, level: 2, clearMessage: "今夜はごちそう！" },
      { id: "balance", type: "balance", slot: "back-right", title: "ゆれる船", text: "船の上でバランス", seconds: 30, level: 2, clearMessage: "船乗りになれるね！" },
      { id: "members", type: "members", slot: "right", title: "港の子", text: "" },
    ],
  },
  {
    id: "oasis",
    name: "砂丘のオアシス",
    place: "desert",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 180,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "砂丘のオアシス", text: "ヤシの木の下で、ひと休み。", ad: false },
      { id: "pour", type: "pour", slot: "back-left", title: "オアシスのジュース", text: "線にぴったり、そそいでね", goal: 3, seconds: 60, level: 1, clearMessage: "ごくごく！" },
      { id: "maze", type: "maze", slot: "back-right", title: "砂丘の迷路", text: "かたむけて、旗までたどりつこう", goal: 2, seconds: 100, level: 2, clearMessage: "オアシスに着いた！" },
      { id: "treasure", type: "treasure", slot: "left", title: "砂の中の宝", text: "砂丘にうもれた宝を集めよう", count: 8, seconds: 60, clearMessage: "お宝ざくざく！" },
      { id: "members", type: "members", slot: "right", title: "オアシスの子", text: "" },
    ],
  },
  {
    id: "okashi",
    name: "おかしの国",
    place: "candy",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 190,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "おかしの国", text: "キャンディの木と、ケーキのおうち。", ad: false },
      { id: "tower", type: "tower", slot: "back-left", title: "ケーキタワー", text: "スポンジを高く積もう", goal: 10, level: 2, clearMessage: "とびきりのケーキ！" },
      { id: "pour", type: "pour", slot: "back-right", title: "ミルクをそそごう", text: "線にぴったり", goal: 3, seconds: 60, level: 2, clearMessage: "おいしそう！" },
      { id: "balloon", type: "balloon", slot: "left", title: "わたあめ風船", text: "ふーふー、ふくらませよう", goal: 3, seconds: 60, level: 1, clearMessage: "ふわふわ！" },
      { id: "members", type: "members", slot: "right", title: "おかしの国の子", text: "" },
      { id: "boushi", type: "shop", slot: "front-left", title: "帽子屋", text: "とっておきの帽子と王冠", shopId: "boushi" },
    ],
  },
  {
    id: "tsuki",
    name: "月面ステーション",
    place: "moon",
    time: "night",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 200,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "月面ステーション", text: "地球が見える、月の基地へようこそ。", ad: false },
      { id: "tilt", type: "tilt", slot: "back-left", title: "月面コロコロ", text: "かたむけて、月の石を集めよう", goal: 8, seconds: 45, level: 2, clearMessage: "月の石コレクター！" },
      { id: "skycatch", type: "skycatch", slot: "back-right", title: "流星キャッチ", text: "宇宙の流れ星をつかまえよう", goal: 12, seconds: 45, level: 3, clearMessage: "宇宙飛行士みたい！" },
      { id: "nenne", type: "nenne", slot: "left", title: "宇宙でねんね", text: "しずかに、ふわふわ眠ろう", seconds: 25, level: 2, clearMessage: "すやすや…" },
      { id: "members", type: "members", slot: "right", title: "基地にいる子", text: "" },
    ],
  },
  {
    id: "umi-no-soko",
    name: "海の底",
    place: "undersea",
    time: "day",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 210,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "海の底", text: "サンゴとさかなの、青い世界。", ad: false },
      { id: "colorhunt", type: "colorhunt", slot: "back-left", title: "さかなの色さがし", text: "さかなと同じ色を、身のまわりから探そう", goal: 4, seconds: 90, level: 1, clearMessage: "カラフル！" },
      { id: "maze", type: "maze", slot: "back-right", title: "サンゴの迷路", text: "かたむけて、宝箱までたどりつこう", goal: 2, seconds: 90, level: 1, clearMessage: "宝箱を見つけた！" },
      { id: "voice", type: "voice", slot: "left", title: "あわあわジャンプ", text: "声でジャンプして進もう", goal: 8, seconds: 60, level: 1, clearMessage: "ぷくぷく！" },
      { id: "members", type: "members", slot: "right", title: "海の底の子", text: "" },
    ],
  },
  {
    id: "yuenchi",
    name: "ゆうえんち",
    place: "park",
    time: "evening",
    camera: "overview",
    listed: true,
    builtin: true,
    ...AREA_DEFAULTS,
    sortOrder: 220,
    objects: [
      { id: "welcome", type: "board", slot: "back", title: "ゆうえんち", text: "観覧車とメリーゴーランドが、くるくる。", ad: false },
      { id: "balloon", type: "balloon", slot: "back-left", title: "風船やさん", text: "ふーふー、ふくらませよう", goal: 4, seconds: 60, level: 2, clearMessage: "風船、いっぱい！" },
      { id: "rhythm", type: "rhythm", slot: "back-right", title: "パレードリズム", text: "音楽に合わせてふろう", goal: 16, level: 2, clearMessage: "パレード大成功！" },
      { id: "shake", type: "shake", slot: "left", title: "ゴーカート", text: "ふって、ゴールまで走ろう", goal: 40, seconds: 25, level: 2, clearMessage: "一等賞！" },
      { id: "members", type: "members", slot: "right", title: "あそびに来た子", text: "" },
      { id: "hanabi", type: "shop", slot: "front-left", title: "パレードの花火屋", text: "花火を打ち上げて、みんなでお祝い", shopId: "hanabi" },
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
export function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** 複数行を許す文字（詳細の説明など）。改行は2つまでに詰める */
export function cleanLong(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function pick<T extends { id: string }>(list: readonly T[], value: unknown, fallback: T["id"]): T["id"] {
  return list.some((x) => x.id === value) ? (value as T["id"]) : fallback;
}

export function cleanUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" ? u.toString().slice(0, 500) : "";
  } catch {
    return "";
  }
}

export function intIn(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function timeOrNull(value: unknown): number | null {
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
      base.detail = cleanLong(o.detail, 200);
      base.couponCode = cleanText(o.couponCode, 24);
      base.couponNote = cleanText(o.couponNote, 60);
      base.couponUntil = timeOrNull(o.couponUntil);
      base.qrUrl = cleanUrl(o.qrUrl);
      if (!base.text && !base.imageUrl) return { ok: false, error: `${n}つ目（看板）: 文字か画像のURLを入れてください` };
      if (typeof o.linkUrl === "string" && o.linkUrl.trim() && !base.linkUrl) {
        return { ok: false, error: `${n}つ目（看板）: リンクは https:// で始まるURLにしてください` };
      }
    } else if (type === "shop") {
      base.shopId = typeof o.shopId === "string" && /^[a-z0-9-]{2,24}$/.test(o.shopId) ? o.shopId : "";
      if (!base.shopId) return { ok: false, error: `${n}つ目（お店）: どのお店を置くか選んでください` };
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
    landSpots: LAND_SPOTS,
    landmarkModels: LANDMARK_MODELS,
    landmarkColors: LANDMARK_COLORS,
  };
}
