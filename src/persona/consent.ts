/**
 * 同意の管理。
 *
 * ここが、これから足す「属性の取得」「集約データの提供」「人格の出品」すべての入口になる。
 * 設計の前提を先に書いておく。
 *
 * 1. **既定はすべてオフ**。同意していない分身のデータは、集計にもマーケットにも一切載らない。
 *    「オプトアウトできます」ではなく「オプトインしない限り出ない」を守る。
 *
 * 2. **用途ごとに分ける**。「データを使ってよいか」をひとまとめの1個のチェックにしない。
 *    属性を保存することと、それを統計に混ぜることと、人格を売りに出すことは、
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
export const CONSENT_VERSION = 1;

export type ConsentPurpose = "profile" | "aggregate" | "marketplace";

export interface ConsentState {
  version: number;
  updatedAt: number;
  /** 属性情報（年代・地域など、本人が任意で入れたもの）を保存してよい */
  profile: boolean;
  /** 匿名化・集約したうえで、統計や第三者提供に含めてよい */
  aggregate: boolean;
  /** 育てた人格パッケージをマーケットに出品してよい */
  marketplace: boolean;
}

export const EMPTY_CONSENT: ConsentState = {
  version: CONSENT_VERSION,
  updatedAt: 0,
  profile: false,
  aggregate: false,
  marketplace: false,
};

/** 画面と同意記録で同じ文面を使うための定義（説明を2箇所に書くと必ずズレるため）。 */
export const CONSENT_TEXTS: Record<ConsentPurpose, { title: string; body: string; note: string }> = {
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
  marketplace: {
    title: "育てた分身を出品する",
    body:
      "あなたが育てた人格パッケージを、他の人が使えるようにマーケットへ出せるようになります。" +
      "出品するかどうか、いくらにするかは、そのつど自分で決めます。",
    note: "ここをオンにしただけでは公開されません。出品操作をするまで、誰にも見えません。",
  },
};

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
    profile: pick("profile"),
    aggregate: pick("aggregate"),
    marketplace: pick("marketplace"),
  };
}
