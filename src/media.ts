/**
 * 広告・ランドマーク・看板の画像のアップロードと配信（migrations/0016_meta_images.sql）。
 *
 *   POST /api/admin/media        管理画面から（adminGate の内側）
 *   POST /api/land/image         公開の申込ページ /land から（受付中のときだけ・1日の回数に上限）
 *   GET  /img/<id>.<拡張子>       配信（同じサイトなので、メタバースの3D看板にも CORS なしで貼れる）
 *
 * 送る側（public/image-upload.js）が長い辺1600pxに縮めて WebP（使えなければ JPEG）にしてから、
 * 画像の中身そのものを本文にして送る。ここでは大きさと先頭の数バイトを確かめて、そのまま入れる。
 * 返す URL は `/img/…` の相対パス。本体のホスト（app）とLPのホストのどちらで開いても同じ画像が出る。
 */

import { consumeIpQuota } from "./lib/ipQuota";

export interface MediaEnv {
  DB: D1Database;
}

/** 1枚の上限。D1 の1行の上限（2MB）より小さくしておく */
export const MEDIA_MAX_BYTES = 1_500_000;
/** 公開の申込ページから入れられる枚数（同じ送信元・1日） */
export const LAND_IMAGE_DAILY_LIMIT = 12;
/** 申込ページから入れて、どこにも使われなかった画像を消すまでの日数 */
export const UNUSED_IMAGE_DAYS = 30;

const EXT: Record<string, string> = { "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" };
const IMAGE_PATH = /^\/img\/([a-f0-9]{24})\.(webp|jpg|png)$/;

/** 画像の先頭の数バイトから種類を決める。WebP・JPEG・PNG 以外は null */
export function sniffImage(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return null;
}

/** アップロードした画像の URL（/img/…）かどうか */
export function isUploadedImagePath(value: string): boolean {
  return IMAGE_PATH.test(value);
}

function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

type StoreResult = { ok: true; url: string; bytes: number } | { ok: false; status: number; error: string };

/** 本文（画像そのもの）を確かめて入れる */
export async function storeImage(env: MediaEnv, request: Request, source: "admin" | "land"): Promise<StoreResult> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MEDIA_MAX_BYTES) return { ok: false, status: 413, error: tooLarge() };
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.length === 0) return { ok: false, status: 400, error: "画像が空でした" };
  if (buf.length > MEDIA_MAX_BYTES) return { ok: false, status: 413, error: tooLarge() };
  const mime = sniffImage(buf);
  if (!mime) return { ok: false, status: 415, error: "画像は JPEG・PNG・WebP にしてください" };
  const id = newId();
  try {
    await env.DB.prepare("INSERT INTO meta_images (id, mime, data, bytes, source, created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, mime, buf, buf.length, source, Date.now())
      .run();
  } catch {
    // いちばんありそうなのは、本番に migration 0016 が当たっていないこと（docs/OPERATIONS.md §7）
    return { ok: false, status: 503, error: "いまは画像を受け付けられません（準備中）。URLを貼る方法をお使いください" };
  }
  return { ok: true, url: `/img/${id}.${EXT[mime]}`, bytes: buf.length };
}

function tooLarge(): string {
  return `画像が大きすぎます（${Math.round(MEDIA_MAX_BYTES / 1000)}KBまで）`;
}

/** 公開の申込ページからのアップロード。受付中かどうかは呼ぶ側で確かめる */
export async function storeLandImage(env: MediaEnv, request: Request): Promise<StoreResult> {
  const quota = await consumeIpQuota(env, "land_image", request, LAND_IMAGE_DAILY_LIMIT);
  if (!quota.allowed) return { ok: false, status: 429, error: "本日のアップロードの上限に達しました。時間をおいてお試しください" };
  return storeImage(env, request, "land");
}

/** GET /img/<id>.<拡張子> */
export async function serveImage(env: MediaEnv, request: Request, pathname: string): Promise<Response | null> {
  const m = IMAGE_PATH.exec(pathname);
  if (!m) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const row = await env.DB.prepare("SELECT mime, data FROM meta_images WHERE id = ?")
    .bind(m[1])
    .first<{ mime: string; data: ArrayBuffer | number[] }>();
  if (!row) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
  const body = row.data instanceof ArrayBuffer ? new Uint8Array(row.data) : Uint8Array.from(row.data as number[]);
  return new Response(request.method === "HEAD" ? null : body, {
    headers: {
      "content-type": row.mime,
      "content-length": String(body.length),
      // 中身は変わらない（同じ id に別の画像を入れることはない）
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      // メタバースの3D看板（WebGL のテクスチャ）に貼れるように
      "access-control-allow-origin": "*",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}

/**
 * 申込ページから入れて、どの申込にも掲載にも使われないまま日がたった画像を消す（Cron から）。
 * 管理画面から入れた画像は消さない（運営のエリアの看板は D1 の外＝部屋の設定に入るため、ここでは追えない）。
 */
export async function purgeUnusedImages(env: MediaEnv, now = Date.now()): Promise<number> {
  const before = now - UNUSED_IMAGE_DAYS * 24 * 60 * 60 * 1000;
  const r = await env.DB.prepare(
    `DELETE FROM meta_images WHERE source = 'land' AND created_at < ?
       AND NOT EXISTS (SELECT 1 FROM meta_orders o WHERE instr(o.content, meta_images.id) > 0)
       AND NOT EXISTS (SELECT 1 FROM meta_placements p WHERE instr(p.content, meta_images.id) > 0)`
  )
    .bind(before)
    .run();
  return r.meta?.changes ?? 0;
}
