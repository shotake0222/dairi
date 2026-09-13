/**
 * 属性情報（デモグラフィック）の定義。
 *
 * 「細かく取りたい」という要望に対して、項目数は多く用意しつつ、
 * **取り方**は次の3つの制約で設計している。理由も書いておく。
 *
 * 1. **すべて任意で、いつでも消せる**。
 *    このサービスはアカウント登録なしで始められることが入口の価値なので、
 *    NFCをタップした直後に長いフォームを出すと、そこで人が消える。
 *    答えれば分身がそのぶん自分に近づく、という順序にしてある。
 *
 * 2. **自由記述をほぼ置かない**。
 *    自由記述は氏名・勤務先・病名のような、こちらが取るつもりのない情報が入ってくる。
 *    選択肢式にしておけば「入っている値の種類」がこちらで分かっているので、
 *    集計もできるし、うっかり個人が特定される事故も起きにくい。
 *
 * 3. **要配慮個人情報は取らない**。
 *    病歴・障害・信条・出自などは、日本の個人情報保護法で本人同意なしの取得が禁じられており、
 *    同意があっても取扱いの負担が跳ね上がる。集計や販売の対象にする以上、ここには持ち込まない。
 *    体の状態に関わる設定（入力方法など）は accessibility 側に置き、販売・集約から構造的に外す。
 *
 * 段階的に聞くための `askAfter` は「この回数だけ会話したら聞いてよい」の目安。
 * 全部まとめて出したいときは、属性ページから手動で開ける。
 */

export type ProfileFieldType = "single" | "multi";

export interface ProfileField {
  key: string;
  label: string;
  /** なぜ聞くのかを、利用者にそのまま見せる文言で持つ（説明を画面側に散らかさないため） */
  why: string;
  type: ProfileFieldType;
  options: string[];
  /** 何回か会話したあとで聞く。0なら最初から聞いてよい */
  askAfter: number;
  /** 複数選択のときの上限 */
  maxSelections?: number;
}

export interface ProfileGroup {
  key: string;
  title: string;
  lead: string;
  fields: ProfileField[];
}

const AGE_BANDS = ["10代以下", "10代", "20代", "30代", "40代", "50代", "60代", "70代以上"];
const REGIONS = [
  "北海道", "東北", "北関東", "首都圏", "甲信越", "北陸", "東海", "関西", "中国", "四国", "九州", "沖縄", "日本国外",
];

export const PROFILE_GROUPS: ProfileGroup[] = [
  {
    key: "basic",
    title: "かんたんなこと",
    lead: "分身が、あなたに合った話し方をするための手がかりです。",
    fields: [
      {
        key: "ageBand",
        label: "年代",
        why: "話し方や話題の選び方が変わります",
        type: "single",
        options: AGE_BANDS,
        askAfter: 0,
      },
      {
        key: "gender",
        label: "性別",
        why: "呼びかけ方の参考にします",
        type: "single",
        options: ["女性", "男性", "その他", "答えたくない"],
        askAfter: 0,
      },
      {
        key: "region",
        label: "住んでいる地域",
        why: "季節や地域の話題が自然になります",
        type: "single",
        options: REGIONS,
        askAfter: 0,
      },
    ],
  },
  {
    key: "life",
    title: "暮らし",
    lead: "生活のリズムが分かると、会話の間の取り方が変わります。",
    fields: [
      {
        key: "household",
        label: "同居している人",
        why: "話しかけられる時間帯や話題に関わります",
        type: "multi",
        maxSelections: 4,
        options: ["ひとり暮らし", "パートナー", "子ども", "親", "きょうだい", "祖父母", "ルームメイト"],
        askAfter: 3,
      },
      {
        key: "pets",
        label: "一緒に暮らしている動物",
        why: "分身がその子のことを覚えていられます",
        type: "multi",
        maxSelections: 4,
        options: ["犬", "猫", "鳥", "魚", "うさぎ・小動物", "は虫類", "いない"],
        askAfter: 3,
      },
      {
        key: "chronotype",
        label: "活動しやすい時間帯",
        why: "夜に話しかける人と朝に話しかける人では、ちょうどいい距離感が違います",
        type: "single",
        options: ["朝型", "夜型", "決まっていない", "不規則（交代勤務など）"],
        askAfter: 6,
      },
      {
        key: "livingArea",
        label: "住んでいる場所の雰囲気",
        why: "身近な景色の話ができるようになります",
        type: "single",
        options: ["都心", "郊外・住宅地", "地方都市", "田舎", "離島・山間部"],
        askAfter: 10,
      },
    ],
  },
  {
    key: "work",
    title: "仕事・学び",
    lead: "働き方や学び方は、話したいことの中身に一番効きます。",
    fields: [
      {
        key: "occupation",
        label: "いまの立場",
        why: "生活のリズムと関心の方向が変わります",
        type: "single",
        options: [
          "会社員", "経営者・役員", "自営業・フリーランス", "公務員", "医療・福祉",
          "教育", "学生", "主婦・主夫", "アルバイト・パート", "求職中", "退職", "その他",
        ],
        askAfter: 6,
      },
      {
        key: "workStyle",
        label: "働き方",
        why: "話しかけられる時間帯の見当がつきます",
        type: "single",
        options: ["出社中心", "在宅中心", "半々", "外回り・現場", "決まっていない", "働いていない"],
        askAfter: 10,
      },
      {
        key: "education",
        label: "最終学歴",
        why: "説明の細かさを合わせます",
        type: "single",
        options: ["中学", "高校", "専門・短大・高専", "大学", "大学院", "答えたくない"],
        askAfter: 15,
      },
      {
        key: "income",
        label: "世帯年収",
        why: "統計としてのみ使います。会話には出しません",
        type: "single",
        options: ["300万円未満", "300〜500万円", "500〜700万円", "700〜1000万円", "1000万円以上", "答えたくない"],
        askAfter: 20,
      },
    ],
  },
  {
    key: "interest",
    title: "好きなもの",
    lead: "分身が、あなたの好きな話に乗れるようになります。",
    fields: [
      {
        key: "hobbies",
        label: "よくやること",
        why: "会話の話題に直接使います",
        type: "multi",
        maxSelections: 8,
        options: [
          "ゲーム", "アニメ・マンガ", "音楽", "映画・ドラマ", "読書", "スポーツ観戦", "運動・トレーニング",
          "料理", "カフェ巡り", "旅行", "カメラ", "アウトドア", "手芸・ものづくり", "絵を描く",
          "ファッション", "美容", "車・バイク", "投資", "プログラミング", "資格の勉強", "推し活",
        ],
        askAfter: 3,
      },
      {
        key: "mediaHabit",
        label: "よく見ているもの",
        why: "話題の温度感を合わせます",
        type: "multi",
        maxSelections: 5,
        options: ["YouTube", "TikTok", "X", "Instagram", "テレビ", "ニュースサイト", "配信サービス", "ほとんど見ない"],
        askAfter: 10,
      },
      {
        key: "petPeeve",
        label: "苦手なこと",
        why: "分身が地雷を踏まないようにします",
        type: "multi",
        maxSelections: 5,
        options: ["大きな音", "人混み", "電話", "早口", "説教くさい話", "下ネタ", "強い言葉", "特にない"],
        askAfter: 15,
      },
    ],
  },
  {
    key: "relation",
    title: "分身との距離",
    lead: "どう接してほしいかは、育て方そのものです。",
    fields: [
      {
        key: "wantedRelation",
        label: "分身にどう接してほしいか",
        why: "口調と距離感の土台になります",
        type: "single",
        options: ["友達みたいに", "きょうだいみたいに", "相棒として", "後輩として", "先輩として", "ペットのように"],
        askAfter: 3,
      },
      {
        key: "callMe",
        label: "呼ばれ方",
        why: "呼びかけに使います",
        type: "single",
        options: ["名前で呼んでほしい", "あだ名で呼んでほしい", "きみ・あなた", "呼びかけなくていい"],
        askAfter: 6,
      },
      {
        key: "talkTime",
        label: "話したくなる時",
        why: "留守番中の振る舞いを合わせます",
        type: "multi",
        maxSelections: 4,
        options: ["朝の支度中", "通勤・通学中", "仕事の合間", "帰り道", "寝る前", "落ち込んだとき", "うれしいとき"],
        askAfter: 10,
      },
    ],
  },
  {
    key: "future",
    title: "この先のこと",
    lead: "分身をどこへ連れて行きたいか。将来の機能を決める材料にします。",
    fields: [
      {
        key: "futureBody",
        label: "分身に宿ってほしい姿",
        why: "どの身体を先に作るかの判断に使います",
        type: "multi",
        maxSelections: 4,
        options: ["スマホの中のまま", "スマートスピーカー", "小さなロボット", "等身大のロボット", "VR・メタバース", "車の中", "決めていない"],
        askAfter: 15,
      },
      {
        key: "futureRole",
        label: "分身にしてほしいこと",
        why: "機能の優先順位を決めます",
        type: "multi",
        maxSelections: 4,
        options: ["話し相手", "予定の管理", "留守番・見守り", "代わりに考えてもらう", "作業の手伝い", "思い出を残す"],
        askAfter: 20,
      },
    ],
  },
];

export const PROFILE_FIELDS: ProfileField[] = PROFILE_GROUPS.flatMap((g) => g.fields);

const FIELD_BY_KEY = new Map(PROFILE_FIELDS.map((f) => [f.key, f]));

/** key → 選択された値（単一選択は長さ1の配列に正規化して持つ） */
export type ProfileAnswers = Record<string, string[]>;

export interface DemographicProfile {
  answers: ProfileAnswers;
  updatedAt: number;
  /** 「もう聞かないで」を選んだら、以降こちらから促さない */
  declinedAll?: boolean;
}

export const EMPTY_PROFILE: DemographicProfile = { answers: {}, updatedAt: 0 };

/**
 * 受け取った回答を、定義済みの項目・選択肢だけに絞り込む。
 *
 * ここを緩くすると、選択肢式にした意味が無くなる（任意の文字列が保存できてしまい、
 * 氏名や病名のような取るつもりのない情報が入り込む）。知らないキーも知らない値も黙って捨てる。
 */
export function sanitizeAnswers(raw: unknown): ProfileAnswers {
  if (!raw || typeof raw !== "object") return {};
  const out: ProfileAnswers = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) continue;
    const values = (Array.isArray(value) ? value : [value]).filter(
      (v): v is string => typeof v === "string" && field.options.includes(v)
    );
    if (values.length === 0) continue;
    const limit = field.type === "single" ? 1 : field.maxSelections ?? field.options.length;
    out[key] = Array.from(new Set(values)).slice(0, limit);
  }
  return out;
}

/** 何割答えたか（画面の進捗表示と、統計データの品質判定に使う）。 */
export function completionRate(answers: ProfileAnswers): number {
  if (PROFILE_FIELDS.length === 0) return 0;
  const answered = PROFILE_FIELDS.filter((f) => (answers[f.key]?.length ?? 0) > 0).length;
  return Math.round((answered / PROFILE_FIELDS.length) * 100);
}

/**
 * 次に聞いてよい項目を1つだけ返す。会話の合間に少しずつ聞くための関数。
 * 一度に複数返さないのは、「ついでにこれも」を重ねると結局フォームになるため。
 */
export function nextFieldToAsk(
  profile: DemographicProfile | undefined,
  interactionCount: number
): ProfileField | null {
  if (profile?.declinedAll) return null;
  const answers = profile?.answers ?? {};
  for (const field of PROFILE_FIELDS) {
    if ((answers[field.key]?.length ?? 0) > 0) continue;
    if (interactionCount < field.askAfter) continue;
    return field;
  }
  return null;
}

/**
 * 分身が会話で使えるように、回答を短い日本語にする。
 * 統計用の生データとは別に、ここで「プロンプトに載せる形」を1箇所で決めておく。
 */
export function describeProfile(answers: ProfileAnswers): string {
  const lines: string[] = [];
  for (const field of PROFILE_FIELDS) {
    const values = answers[field.key];
    if (!values || values.length === 0) continue;
    // 年収は会話に出さない（統計としてのみ使うと説明しているため）
    if (field.key === "income") continue;
    lines.push(`・${field.label}: ${values.join("、")}`);
  }
  return lines.join("\n");
}
