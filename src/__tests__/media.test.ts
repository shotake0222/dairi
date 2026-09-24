import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { env, SELF } from "cloudflare:test";
import { sniffImage, isUploadedImagePath, purgeUnusedImages, MEDIA_MAX_BYTES, UNUSED_IMAGE_DAYS } from "../media";
import { cleanImageUrl, sanitizeObjects } from "../metaverse";
import { sanitizeContent } from "../land";

/**
 * 広告・ランドマーク・看板の画像のアップロード（src/media.ts）。
 *
 * 守りたい約束:
 *   1. 画像（WebP・JPEG・PNG）だけを受け取る。中身は先頭の数バイトで確かめる（申告の content-type は信じない）
 *   2. 管理画面の口は合言葉の内側。申込ページの口は受付中のときだけ
 *   3. 返した /img/… は、そのまま広告・看板の画像として保存できる（https:// と同じ扱い）
 *   4. 申込ページから入れて使われなかった画像は、日がたてば消える。使われている画像は消さない
 */

const BASE = "https://example.com";
const PASS = "test-admin-pass";
const COOKIE = `waketama_admin=${encodeURIComponent(PASS)}`;
type MutableEnv = { ADMIN_PASSCODE?: string };
let saved: string | undefined;

beforeAll(() => {
  saved = (env as unknown as MutableEnv).ADMIN_PASSCODE;
  (env as unknown as MutableEnv).ADMIN_PASSCODE = PASS;
});
afterAll(() => {
  (env as unknown as MutableEnv).ADMIN_PASSCODE = saved;
});

/** 1×1 の PNG */
const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0)
);
/** WebP の先頭（中身は検査しないので、見出しだけで足りる） */
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]);

async function upload(path: string, body: Uint8Array, headers: Record<string, string> = {}) {
  const res = await SELF.fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "image/png", ...headers }, body });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as { url?: string; error?: string } };
}

describe("画像の見分け", () => {
  it("WebP・JPEG・PNG を見分け、それ以外は断る", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe("image/jpeg");
    expect(sniffImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("GIF89a......"))).toBeNull();
  });

  it("/img/… は画像のURLとして通り、ほかの相対パスや http は通らない", () => {
    const path = "/img/0123456789abcdef01234567.webp";
    expect(isUploadedImagePath(path)).toBe(true);
    expect(cleanImageUrl(path)).toBe(path);
    expect(cleanImageUrl("https://example.org/a.png")).toBe("https://example.org/a.png");
    expect(cleanImageUrl("/img/../admin")).toBe("");
    expect(cleanImageUrl("/admin")).toBe("");
    expect(cleanImageUrl("http://example.org/a.png")).toBe("");
    expect(cleanImageUrl("javascript:alert(1)")).toBe("");
  });

  it("広告の中身・看板に /img/… を入れて保存できる", () => {
    const path = "/img/0123456789abcdef01234567.jpg";
    const c = sanitizeContent("ad", { sponsor: "テスト", imageUrl: path });
    expect(c.ok && c.value.imageUrl).toBe(path);
    const objs = sanitizeObjects([{ type: "board", slot: "back", title: "お知らせ", imageUrl: path }]);
    expect(objs.ok && objs.value[0].imageUrl).toBe(path);
  });
});

describe("管理画面からのアップロード", () => {
  it("合言葉が無いと入れられない", async () => {
    const r = await upload("/api/admin/media", PNG);
    expect(r.status).not.toBe(200);
  });

  it("入れた画像を /img/… で配る（同じ中身・長く覚えてよい・種類は中身から）", async () => {
    // 申告は image/png だが中身は WebP → 中身の方で決まる
    const r = await upload("/api/admin/media", WEBP, { cookie: COOKIE });
    expect(r.status).toBe(200);
    expect(r.data.url).toMatch(/^\/img\/[a-f0-9]{24}\.webp$/);
    const res = await SELF.fetch(`${BASE}${r.data.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(WEBP);
  });

  it("画像でないもの・空・大きすぎるものは断る", async () => {
    expect((await upload("/api/admin/media", new TextEncoder().encode("<svg onload=alert(1)>........"), { cookie: COOKIE })).status).toBe(415);
    expect((await upload("/api/admin/media", new Uint8Array(0), { cookie: COOKIE })).status).toBe(400);
    const big = new Uint8Array(MEDIA_MAX_BYTES + 1);
    big.set(PNG);
    expect((await upload("/api/admin/media", big, { cookie: COOKIE })).status).toBe(413);
  });

  it("無い画像は 404、形の違うパスは画像として扱わない", async () => {
    expect((await SELF.fetch(`${BASE}/img/ffffffffffffffffffffffff.png`)).status).toBe(404);
    const odd = await SELF.fetch(`${BASE}/img/abc.png`);
    expect(odd.headers.get("content-type") || "").not.toContain("image/");
  });
});

describe("申込ページからのアップロード", () => {
  it("受付を止めているときは入れられず、受付中なら入れられる", async () => {
    const setSales = (open: boolean) =>
      SELF.fetch(`${BASE}/api/admin/land/settings`, {
        method: "POST",
        headers: { cookie: COOKIE, "content-type": "application/json" },
        body: JSON.stringify({ salesOpen: open }),
      });
    await setSales(false);
    expect((await upload("/api/land/image", PNG)).status).toBe(403);
    await setSales(true);
    const r = await upload("/api/land/image", PNG);
    expect(r.status).toBe(200);
    expect(r.data.url).toMatch(/^\/img\/[a-f0-9]{24}\.png$/);
    await setSales(false);
  });

  it("使われなかった画像は日がたつと消え、申込に使われている画像は残る", async () => {
    const old = Date.now() - (UNUSED_IMAGE_DAYS + 1) * 24 * 60 * 60 * 1000;
    const put = (id: string, source: string) =>
      env.DB.prepare("INSERT INTO meta_images (id, mime, data, bytes, source, created_at) VALUES (?,?,?,?,?,?)")
        .bind(id, "image/png", PNG, PNG.length, source, old)
        .run();
    await put("aaaaaaaaaaaaaaaaaaaaaaa1", "land");
    await put("aaaaaaaaaaaaaaaaaaaaaaa2", "land");
    await put("aaaaaaaaaaaaaaaaaaaaaaa3", "admin");
    await env.DB.prepare(
      `INSERT INTO meta_orders (id, key_hash, area_id, spot, kind, quantity, content, contact_name, contact_email, status, created_at, updated_at)
       VALUES ('ordimg1', 'x', 'hiroba', 'n1', 'ad', 1, ?, 'a', 'a@example.com', 'pending', ?, ?)`
    )
      .bind(JSON.stringify({ imageUrl: "/img/aaaaaaaaaaaaaaaaaaaaaaa2.png" }), old, old)
      .run();
    await purgeUnusedImages(env);
    const left = await env.DB.prepare("SELECT id FROM meta_images WHERE id LIKE 'aaaaaaaa%' ORDER BY id").all<{ id: string }>();
    expect(left.results.map((r) => r.id)).toEqual(["aaaaaaaaaaaaaaaaaaaaaaa2", "aaaaaaaaaaaaaaaaaaaaaaa3"]);
  });
});
