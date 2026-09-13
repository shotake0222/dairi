/**
 * 問い合わせの受付（法人向けページの相談フォーム）。
 *
 * 連絡先を預かる、このサービスで数少ない経路なので、方針を書いておく。
 *
 * - 受け取るのは、相手が自分で書いて送った内容だけ。分身のデータとは一切結び付けない。
 * - ログにも連絡先や本文を出さない（本文をログに出さないという全体方針と同じ扱いにする）。
 * - 返信のためだけに使う。マーケティング目的の再利用はしない前提で保存している。
 * - 誰でも叩けるエンドポイントなので、長さの上限と、ごく簡単な形式チェックを入れておく。
 */

import { LogContext, logInfo, logWarn } from "./lib/log";
import { consumeIpQuota } from "./lib/ipQuota";

export interface ContactEnv {
  DB: D1Database;
}

const MAX_COMPANY = 80;
const MAX_CONTACT = 120;
const MAX_MESSAGE = 1000;
const TOPICS = ["format", "data", "insights", "poc", "other"];
/**
 * 同じ送信元からの1日あたりの上限。
 * 相談・復旧依頼を続けて送る人（書き直し・追記）はいるので、1〜2件では狭すぎる。
 * 一方でこれを超える回数を人が手で送ることはまずない。
 */
const CONTACT_DAILY_LIMIT = 8;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function clean(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

export async function handleContact(
  env: ContactEnv,
  body: { kind?: unknown; company?: unknown; contact?: unknown; topic?: unknown; message?: unknown },
  log: LogContext,
  request?: Request
): Promise<Response> {
  // 大量送信で本物の相談が埋もれるのを防ぐ。送信元のIPは保存せず、
  // その日限りの塩でハッシュ化した値だけを数える（src/lib/ipQuota.ts）。
  if (request) {
    const limited = await consumeIpQuota(env, "contact", request, CONTACT_DAILY_LIMIT);
    if (!limited.allowed) {
      logWarn(log, "contact.rate_limited", { count: limited.count });
      return json({ error: "本日の送信回数の上限に達しました。お急ぎの場合は時間をおいてお試しください" }, 429);
    }
  }

  const contact = clean(body.contact, MAX_CONTACT);
  if (!contact) return json({ error: "連絡先を入力してください" }, 400);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contact)) {
    return json({ error: "メールアドレスの形式で入力してください" }, 400);
  }

  const company = clean(body.company, MAX_COMPANY);
  // 改行は残したいので、message だけは空白の畳み込みをしない
  const rawMessage = typeof body.message === "string" ? body.message.trim() : "";
  const message = rawMessage.slice(0, MAX_MESSAGE);
  const topic = typeof body.topic === "string" && TOPICS.includes(body.topic) ? body.topic : "other";
  // recovery は /recover（分身の復旧の依頼）から届く。
  // 受け皿を分けると運営が2箇所を見ることになり、取りこぼすので同じ表に入れる。
  const kind = body.kind === "other" ? "other" : body.kind === "recovery" ? "recovery" : "biz";

  try {
    await env.DB.prepare(
      `INSERT INTO contact_requests (request_id, kind, company, contact, topic, message, created_at, status)
       VALUES (?,?,?,?,?,?,?,'new')`
    )
      .bind(crypto.randomUUID(), kind, company || null, contact, topic, message || null, Date.now())
      .run();

    // 連絡先も本文も記録しない。届いたことと、どの関心かだけ分かればよい。
    logInfo(log, "contact.received", { kind, topic, hasCompany: Boolean(company) });
    return json({ ok: true });
  } catch (err) {
    logWarn(log, "contact.failed", { error: err instanceof Error ? err.message : String(err) });
    return json({ error: "送信できませんでした。お手数ですが時間をおいてお試しください" }, 500);
  }
}

/** 管理画面用。届いた問い合わせの一覧と、対応済みへの変更。 */
export async function handleAdminContacts(env: ContactEnv, request: Request, url: URL): Promise<Response> {
  if (request.method === "POST") {
    const body = await request
      .json<{ requestId?: string; status?: string }>()
      .catch(() => ({}) as { requestId?: string; status?: string });
    if (!body.requestId) return json({ error: "requestId is required" }, 400);
    const status = body.status === "new" ? "new" : "handled";
    await env.DB.prepare("UPDATE contact_requests SET status = ? WHERE request_id = ?")
      .bind(status, body.requestId)
      .run();
    return json({ ok: true, status });
  }

  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
  const rows = await env.DB.prepare(
    `SELECT request_id, kind, company, contact, topic, message, created_at, status
     FROM contact_requests ORDER BY created_at DESC LIMIT ?1`
  )
    .bind(limit)
    .all();
  return json({ contacts: rows.results ?? [] });
}
