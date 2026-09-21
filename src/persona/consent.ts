/**
 * 同意の管理。
 *
 * ここが「サービスを始めてよいか」「属性を取ってよいか」「集約に混ぜてよいか」の入口になる。
 * 設計の前提を先に書いておく。
 *
 * 1. **入口で聞くのは terms の1つだけ。**
 *    terms は「利用規約とプライバシーポリシーを読んで、始めてよい」という同意で、
 *    これが無いと会話を始めない。**terms に同意すると、そこに書いてある使い道
 *    （profile / aggregate）も一緒に有効になる**（`BUNDLED_WITH_TERMS`）。
 *
 *    以前は残り2つを既定オフのチェックにしていたが、生まれた直後の人に
 *    3つの判断を求める形になっていて、ほとんど誰も読まずに素通りしていた。
 *    「使い道を細かく選ばせる」より、**使い道を最初に全部見せて、
 *    始めるかどうかだけを決めてもらう**方が、実際に伝わる。
 *
 *    代わりに次の2つを必ず守ること。どちらか欠けると、ただの黙認になる:
 *      a. 入口の画面で、束ねた使い道を**隠さずに全部見せる**（CONSENT_TEXTS をそのまま出す）
 *      b. あとから**1つずつ取り消せる**道を残す（/profile の設定。既存の実装がある）
 *
 * 2. **記録は用途ごとに分けたまま**。まとめて聞いても、保存とチェックは別々にする。
 *    後から「統計には使わないで」と言われたときに、terms を残したまま
 *    aggregate だけ落とせるのは、分けて持っているから。
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
export const CONSENT_VERSION = 4;

/**
 * 4 で何が変わったか:
 * - **入口の同意画面（gate.js が出す terms.note）に、未成年の方への注記を足した。**
 *   「未成年の方は、保護者の方の同意を得たうえでご利用ください」は以前から `public/terms.html` の
 *   12条にあったが、そこは同意画面から見ればリンクの先——実際にはほとんどの人（特に子ども）が
 *   開かない。NFCキーホルダーという入口の性質上、子どもが直接この画面に来る可能性があるため、
 *   同意画面の本文自体に同じ文言を足した（フェーズ5「年齢への配慮」）。
 * - 使い道（terms / profile / aggregate のどれか）は増えていない。文面へ一文足しただけだが、
 *   このファイル冒頭の方針どおり「文面を変えたら必ず版を上げる」に従い、既存の同意は取り直しにした。
 *
 * 3 で何が変わったか:
 * - **profile / aggregate を terms に束ねた。** 入口で聞くのは「はじめてよいか」だけになり、
 *   同意すると2つの使い道も有効になる。使い道の説明は入口で全部見せる（隠して束ねない）。
 * - 版を上げたので、**2 で同意した人は次に開いたときに取り直しになる**。
 *   束ねた範囲は 2 の同意より広いので、流用してはいけない。
 *
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
      "**運営がサービスの改善や、個人が特定されない形での企業向け提供に使うことがあります。**" +
      "はじめると、下の2つの使い道が有効になります。",
    note:
      "会話の本文がそのまま外へ出ることはありません。**この2つは、あとから設定でいつでも個別に止められます。**" +
      "分身ごと削除すれば、すべて消えます。詳しくは利用規約とプライバシーポリシーをご覧ください。" +
      "**未成年の方は、保護者の方の同意を得たうえでご利用ください。**",
  },
  profile: {
    title: "あなたのことを分身に覚えさせる",
    body:
      "年代や住んでいる地域などを、分身の記憶として保存します。" +
      "答えた内容は会話に反映され、分身があなたに合った話し方をするようになります。",
    note: "答えるかどうかは自由です。ひとつも答えない選択もできますし、設定でこの保存自体を止められます。",
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

/**
 * terms に同意したときに、一緒に有効になる使い道。
 *
 * **入口の画面は、ここに入っているものを1つ残らず本文で見せること。**
 * 束ねてよいのは「説明を尽くしたうえで、始めるかどうかだけを聞く」からで、
 * 見せずに束ねたら、それは同意ではない。
 *
 * 一度でも記録された同意があるときは、こちらが優先されない（normalizeConsent 参照）。
 * 設定で止めた人が、次に開いたときに黙って戻る——が一番やってはいけない挙動。
 */
export const BUNDLED_WITH_TERMS: ConsentPurpose[] = ["profile", "aggregate"];

/** 保存されている同意が「いま有効か」を判定する。版が古ければ同意していない扱いにする。 */
export function hasConsent(consent: ConsentState | undefined, purpose: ConsentPurpose): boolean {
  if (!consent) return false;
  if (consent.version !== CONSENT_VERSION) return false;
  return consent[purpose] === true;
}

/** 受け取った値を、信用せずに ConsentState に整える。 */
export function normalizeConsent(raw: unknown, previous?: ConsentState): ConsentState {
  const input = (raw ?? {}) as Partial<Record<ConsentPurpose, unknown>>;
  const current = previous && previous.version === CONSENT_VERSION ? previous : undefined;

  const pick = (key: ConsentPurpose): boolean => {
    if (typeof input[key] === "boolean") return input[key] as boolean;
    // 指定が無い項目は、いまの版で同意済みのものだけ引き継ぐ（版が上がったら落ちる）
    return current ? current[key] : false;
  };

  const terms = pick("terms");
  const bundled = (key: ConsentPurpose): boolean => {
    // 1. 画面がはっきり指定した値がいちばん強い（設定で止めた／戻した）
    if (typeof input[key] === "boolean") return input[key] as boolean;
    // 2. いまの版で記録がある人は、その値のまま。止めた人を黙って戻さない
    if (current) return current[key];
    // 3. はじめての人は、terms に同意したなら一緒に有効（BUNDLED_WITH_TERMS）
    return terms;
  };

  return {
    version: CONSENT_VERSION,
    updatedAt: Date.now(),
    terms,
    profile: BUNDLED_WITH_TERMS.includes("profile") ? bundled("profile") : pick("profile"),
    aggregate: BUNDLED_WITH_TERMS.includes("aggregate") ? bundled("aggregate") : pick("aggregate"),
  };
}
