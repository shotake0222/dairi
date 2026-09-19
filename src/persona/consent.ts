/**
 * 同意の管理。
 *
 * ここが「サービスを始めてよいか」「属性を取ってよいか」「集約に混ぜてよいか」の入口になる。
 * 設計の前提を先に書いておく。
 *
 * 1. **terms だけは必須で、それ以外は既定オフ。**
 *    terms は「利用規約とプライバシーポリシーを読んで、始めてよい」という同意で、
 *    これが無いと会話を始めない。残り（profile / aggregate）は、
 *    「オプトアウトできます」ではなく「オプトインしない限り出ない」を守る。
 *
 * 2. **用途ごとに分ける**。「データを使ってよいか」をひとまとめの1個のチェックにしない。
 *    始めてよいことと、属性を保存することと、それを統計に混ぜることは、
 *    利用者から見て全く違う話なので、別々に取る。
 *
 * 3. **版を持つ**。同意した時点の文面の版を記録する。文面を変えたら、
 *    古い版で同意した人は「未同意」に戻る（黙って範囲を広げない）。
 *    これが無いと、後から用途を足したときに過去の同意を流用してしまう。
 *
 * 4. **アクセシビリティ設定はここに含めない**。入力方法や文字の大きさは、
 *    人によっては障害の存在を示してしまう情報なので、販売・集約の対象から構造的に外す
 *    （CharacterData 上も別のフィールドに置き、集約処理はそこを見に行かない）。
 */

/**
 * 同意文面の版。**用途を増やしたり文面の意味を変えたら、必ず上げること。**
 * 上げると、既存の同意は自動的に無効になり、次に開いたときに取り直しになる。
 */
export const CONSENT_VERSION = 2;

/**
 * 2 で何が変わったか（版を上げた理由をここに残す。上げた事実だけだと後から追えない）:
 * - **出品（marketplace）を廃止した。** 本人が自分の分身を他人へ出す仕組みは畳んだ。
 *   人格が他人の手に渡る経路を開けたままにすると、「誰に渡ってよいか」の運用を
 *   固める前に取り返しのつかない事故が起きうるため。企業への提供は、
 *   運営が引換券で個別に行う形（src/delivery.ts）へ一本化した。
 * - **terms を足した。** 始める前に、規約とプライバシーポリシーへの同意を取る。
 */
export type ConsentPurpose = "terms" | "profile" | "aggregate";

export interface ConsentState {
  version: number;
  updatedAt: number;
  /** 利用規約とプライバシーポリシーに同意して、サービスを始めてよい（**必須**） */
  terms: boolean;
  /** 属性情報（年代・地域など、本人が任意で入れたもの）を保存してよい */
  profile: boolean;
  /** 匿名化・集約したうえで、統計や第三者提供に含めてよい */
  aggregate: boolean;
}

export const EMPTY_CONSENT: ConsentState = {
  version: CONSENT_VERSION,
  updatedAt: 0,
  terms: false,
  profile: false,
  aggregate: false,
};

/** 画面と同意記録で同じ文面を使うための定義（説明を2箇所に書くと必ずズレるため）。 */
export const CONSENT_TEXTS: Record<ConsentPurpose, { title: string; body: string; note: string }> = {
  terms: {
    title: "はじめる前に",
    body:
      "わけたまは、**氏名・メールアドレス・電話番号などの個人情報をお預かりしません。**" +
      "アカウント登録もありません。分身の持ち主かどうかは、この端末のブラウザに保存される印だけで判断しています。" +
      "一方で、分身との会話から生まれた性格・価値観・覚え書きは、" +
      "**運営がサービスの改善や、個人が特定されない形での企業向け提供に使うことがあります。**",
    note:
      "会話の本文がそのまま外へ出ることはありません。いつでも設定から使い道を変えられますし、" +
      "分身ごと削除すれば、すべて消えます。詳しくは利用規約とプライバシーポリシーをご覧ください。",
  },
  profile: {
    title: "あなたのことを分身に覚えさせる",
    body:
      "年代や住んでいる地域などを、分身の記憶として保存します。" +
      "答えた内容は会話に反映され、分身があなたに合った話し方をするようになります。",
    note: "答えなくても、これまでどおり使えます。ひとつも答えない選択もできます。",
  },
  aggregate: {
    title: "統計として使うことを許可する",
    body:
      "あなた個人が特定されない形にまとめたうえで、傾向の分析や、企業向けの統計データとして提供することがあります。" +
      "会話の本文そのものが渡ることはありません。",
    note: "一定人数に満たないグループは、そもそも統計として出しません。いつでも取り消せます。",
  },
};

/**
 * サービスを始めるのに、最低限これだけは要る同意。
 * 画面側はこれを見て入口を閉じる（項目を増やしたときに、画面の判定を書き忘れないように）。
 */
export const REQUIRED_CONSENT: ConsentPurpose[] = ["terms"];

/** 保存されている同意が「いま有効か」を判定する。版が古ければ同意していない扱いにする。 */
export function hasConsent(consent: ConsentState | undefined, purpose: ConsentPurpose): boolean {
  if (!consent) return false;
  if (consent.version !== CONSENT_VERSION) return false;
  return consent[purpose] === true;
}

/** 受け取った値を、信用せずに ConsentState に整える。 */
export function normalizeConsent(raw: unknown, previous?: ConsentState): ConsentState {
  const input = (raw ?? {}) as Partial<Record<ConsentPurpose, unknown>>;
  const pick = (key: ConsentPurpose): boolean => {
    if (typeof input[key] === "boolean") return input[key] as boolean;
    // 指定が無い項目は、いまの版で同意済みのものだけ引き継ぐ（版が上がったら落ちる）
    return previous && previous.version === CONSENT_VERSION ? previous[key] : false;
  };
  return {
    version: CONSENT_VERSION,
    updatedAt: Date.now(),
    terms: pick("terms"),
    profile: pick("profile"),
    aggregate: pick("aggregate"),
  };
}
