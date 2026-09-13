/**
 * 送信元（IP）ごとの1日あたりの回数制限。フォーム送信のような、
 * 持ち主トークンを持たない相手からの投稿を数えるためのもの。
 *
 * 会話の回数制限（src/lib/rateLimit.ts）とは別物なので混ぜないこと。
 * あちらは Durable Object のメモリ上で1体ごとのAI呼び出しを数える仕組みで、
 * 何も保存しない「その場限りモード」の約束を守るために作られている。
 * こちらは相手が誰か分からない経路が対象なので、D1に控えを持つ必要がある。
 *
 * 目的は「同じ相手が短時間に何度も送っていないか」を数えることだけ。
 * 相手が誰かを知る必要はないので、IPアドレスはその日限りのランダムな塩を足して
 * ハッシュ化した値だけを保存する（生のIPはどこにも残さない／ログにも出さない）。
 * 塩は日ごとに変わるため、昨日と今日の記録を突き合わせて同一人物を追うこともできない。
 *
 * Durable Object を使わないのは、回数制限のために毎回DOを起こすと
 * 待ち時間とコストが増えるため。多少の取りこぼし（同時実行での競合）は許容する。
 * ここで守りたいのは「機械的な大量送信で運営が本物の相談を見失うこと」であって、
 * 厳密な回数の一致ではない。
 */

export interface IpQuotaEnv {
  DB: D1Database;
}

export interface IpQuotaResult {
  allowed: boolean;
  count: number;
  limit: number;
}

/** UTCの YYYY-MM-DD。日付が変われば塩も記録も切り替わる。 */
export function dayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 送信元のIP。Cloudflare が付ける CF-Connecting-IP を最優先で見る。 */
export function clientIpOf(request: Request): string | null {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct;
  // ローカル開発やプロキシ経由のときの保険。先頭が元の送信元。
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

async function saltForDay(env: IpQuotaEnv, day: string): Promise<string> {
  const fresh = crypto.randomUUID().replace(/-/g, "");
  // 競合しても最初に入った1つが残ればよい（同じ日の塩は1つで十分）
  await env.DB.prepare("INSERT OR IGNORE INTO rate_salts (day, salt, created_at) VALUES (?,?,?)")
    .bind(day, fresh, Date.now())
    .run();
  const row = await env.DB.prepare("SELECT salt FROM rate_salts WHERE day = ?").bind(day).first<{ salt: string }>();
  return row?.salt || fresh;
}

async function hashClient(salt: string, ip: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/**
 * 自分自身からのアクセスか（ローカル開発・E2E）。
 *
 * cf-connecting-ip はCloudflareが必ず上書きするので、外部から詐称できない。
 * ここを「Miniflare特有のヘッダの有無」で見分ける作りにすると、
 * そのヘッダを自分で付けるだけで本番の回数制限を回避できてしまう。
 */
function isLoopback(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "0:0:0:0:0:0:0:1";
}

/**
 * 1回分を数えて、上限を超えていないか返す。
 * 送信元が分からないとき、および自分自身からのアクセスは数えずに通す。
 * ここで全員を1つの枠に押し込めると、開発中に自分で自分を締め出すことになる。
 */
export async function consumeIpQuota(
  env: IpQuotaEnv,
  scope: string,
  request: Request,
  limit: number,
  now = Date.now()
): Promise<IpQuotaResult> {
  const ip = clientIpOf(request);
  if (!ip || isLoopback(ip)) return { allowed: true, count: 0, limit };

  const day = dayKey(now);
  try {
    const salt = await saltForDay(env, day);
    const client = await hashClient(salt, ip);
    await env.DB.prepare(
      `INSERT INTO rate_counters (scope, day, client, count, updated_at) VALUES (?,?,?,1,?)
       ON CONFLICT(scope, day, client) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`
    )
      .bind(scope, day, client, now)
      .run();
    const row = await env.DB.prepare(
      "SELECT count FROM rate_counters WHERE scope = ? AND day = ? AND client = ?"
    )
      .bind(scope, day, client)
      .first<{ count: number }>();
    const count = row?.count ?? 1;
    return { allowed: count <= limit, count, limit };
  } catch {
    // 数えられなかった（表が無い等）ときに送信を止めると、正規の相談まで届かなくなる。
    // 制限は保険であって本体ではないので、失敗時は通す。
    return { allowed: true, count: 0, limit };
  }
}

/** 古い記録の掃除。Cronから呼ぶ。塩も一緒に消えるので、過去の記録は復元できなくなる。 */
export async function purgeOldIpQuota(env: IpQuotaEnv, keepDays = 3, now = Date.now()): Promise<void> {
  const cutoff = dayKey(now - keepDays * 24 * 60 * 60 * 1000);
  await env.DB.prepare("DELETE FROM rate_counters WHERE day < ?").bind(cutoff).run();
  await env.DB.prepare("DELETE FROM rate_salts WHERE day < ?").bind(cutoff).run();
}
