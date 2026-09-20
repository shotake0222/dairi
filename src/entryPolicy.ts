/**
 * 「誰が新しい分身を作れるか」の線引き。
 *
 * **なぜ要るか。**
 * 依代（キーホルダー）は売り物で、1つ5,500円。その横の画面に
 * 「この端末で分身を始める」ボタンが誰にでも押せる形で置いてあると、
 * 買う理由が消えるうえ、押されただけ Durable Object が増える。
 * かといって完全に塞ぐと、**タグのUIDミラーが効いていなかった人**
 * （＝ちゃんと買った人）まで締め出してしまう。そこを分ける。
 *
 * 決め方:
 *
 *   依代から来た（/t・/q）  … **いつでも作れる。** 現物を持っている人を止めない
 *   管理者                  … いつでも作れる。手元で試すため
 *   それ以外（/add の3番・/w）… **既定では作れない。** 開けたいときだけ開ける
 *
 * 開けるには、デプロイ時に次を付ける:
 *
 *   npx wrangler deploy --env="" --var ENTRY_OPEN:1
 *
 * タグが刷り上がる前にリンクだけで始めたい時期（/w）は、これを立てておく。
 * 売り始めたら外す。
 *
 * **これは鍵ではなく、扉。**
 * 下の「依代から来た」の判定はCookieで、curlなら偽れる。防ぎたいのは
 * 「画面にボタンがあるから押される」であって、本気の相手ではない。
 * 機械的な量産のほうは、回線ごとの1日上限（DIRECT_CREATE_DAILY_LIMIT）で止めている。
 * ここを本物の認証にするなら、依代の読み取りごとに署名を発行する作りに変えること。
 */

import { AdminEnv, isAdminRequest } from "./admin";

/** 判定に要るのは合言葉まわりだけだが、AdminEnv をそのまま受けて型を1つにしておく。 */
export type EntryPolicyEnv = AdminEnv & {
  /** "1" のときだけ、依代を持たない人にも入口を開ける。既定は閉じる */
  ENTRY_OPEN?: string;
};

/** 依代を読み取った直後であることの印。/t・/q が付けて、受け皿が使う。 */
export const CLAIM_COOKIE = "wt_claim";

/**
 * 依代を読んだ端末に付ける印。
 *
 * **長め（90日）にしてある。** 名前を付け終わるまでの数分だけにすると、
 * 2枚目を買った人や、翌日に思い立って /add を開いた人が
 * 「依代を持っていない人」に見えてしまう。現物を持っているのは変わらないので、
 * 買った人の側で期限切れが起きないほうを取る。
 * 依代を読むたびに付け直すので、使っている人のぶんは切れない。
 */
export function claimCookie(kind: "tag" | "qr"): string {
  const days90 = 90 * 24 * 60 * 60;
  return `${CLAIM_COOKIE}=${kind}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${days90}`;
}

function hasClaimCookie(request: Request): boolean {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === CLAIM_COOKIE) {
      const v = rest.join("=");
      return v === "tag" || v === "qr";
    }
  }
  return false;
}

export type EntryReason = "admin" | "yorishiro" | "open" | "closed";

export interface EntryDecision {
  allowed: boolean;
  reason: EntryReason;
}

/** 依代を持たない人にも開いているか（運営の設定）。 */
export function isEntryOpen(env: EntryPolicyEnv): boolean {
  return env.ENTRY_OPEN === "1";
}

/**
 * この要求で、新しい分身を作ってよいか。
 * 依代の読み取り（/t・/q）そのものはここを通らない——あれは常に作れる。
 * ここで判定するのは「依代を使わずに作ろうとしている」場合だけ。
 */
export function canCreateCharacter(request: Request, env: EntryPolicyEnv): EntryDecision {
  if (isAdminRequest(request, env)) return { allowed: true, reason: "admin" };
  if (hasClaimCookie(request)) return { allowed: true, reason: "yorishiro" };
  if (isEntryOpen(env)) return { allowed: true, reason: "open" };
  return { allowed: false, reason: "closed" };
}

/** 断るときの文面。画面にそのまま出すので、次にどうすればよいかまで書く。 */
export const ENTRY_CLOSED_MESSAGE =
  "いまは、依代（キーホルダーや配られたQR）をお持ちの方だけがはじめられます。" +
  "依代をかざすか読み取ると、その場で分身が生まれます。";
