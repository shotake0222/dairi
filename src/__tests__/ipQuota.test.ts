import { describe, it, expect } from "vitest";
import { env, SELF } from "cloudflare:test";
import { clientIpOf, consumeIpQuota, dayKey, purgeOldIpQuota } from "../lib/ipQuota";

/**
 * 送信元ごとの回数制限の検証。
 *
 * 守りたいのは2つ。
 *  - 大量送信が止まること（止まらないと、本物の相談が埋もれる）
 *  - **生のIPアドレスがどこにも残らないこと**（数えるためだけの仕組みで、身元を持つ必要はない）
 */

const BASE = "https://example.com";

function reqFrom(ip: string): Request {
  return new Request(`${BASE}/api/contact`, { method: "POST", headers: { "cf-connecting-ip": ip } });
}

describe("clientIpOf", () => {
  it("CF-Connecting-IP を最優先で見る", () => {
    const r = new Request(BASE, { headers: { "cf-connecting-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.1" } });
    expect(clientIpOf(r)).toBe("203.0.113.9");
  });

  it("X-Forwarded-For は先頭だけを使う", () => {
    const r = new Request(BASE, { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } });
    expect(clientIpOf(r)).toBe("198.51.100.1");
  });

  it("どちらも無ければ null（数えずに通す判断のため）", () => {
    expect(clientIpOf(new Request(BASE))).toBeNull();
  });
});

describe("consumeIpQuota", () => {
  it("上限までは通し、超えたら止める", async () => {
    const ip = `203.0.113.${Math.floor(Math.random() * 200) + 10}`;
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await consumeIpQuota(env, "test-scope", reqFrom(ip), 3));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3].count).toBe(4);
  });

  it("送信元が違えば互いに影響しない", async () => {
    const a = await consumeIpQuota(env, "test-isolated", reqFrom("203.0.113.201"), 1);
    const b = await consumeIpQuota(env, "test-isolated", reqFrom("203.0.113.202"), 1);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
  });

  it("送信元が分からないときは数えずに通す（ローカル開発で自分を締め出さない）", async () => {
    const res = await consumeIpQuota(env, "test-anon", new Request(BASE), 0);
    expect(res.allowed).toBe(true);
    expect(res.count).toBe(0);
  });

  it("生のIPアドレスは保存されない", async () => {
    const ip = "203.0.113.77";
    await consumeIpQuota(env, "test-privacy", reqFrom(ip), 5);
    const rows = await env.DB.prepare("SELECT client FROM rate_counters WHERE scope = ?")
      .bind("test-privacy")
      .all<{ client: string }>();
    expect(rows.results?.length).toBeGreaterThan(0);
    for (const row of rows.results ?? []) {
      expect(row.client).not.toContain(ip);
      expect(row.client).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("日ごとに塩が変わるので、同じIPでも別の値になる", async () => {
    const today = dayKey();
    const yesterday = dayKey(Date.now() - 24 * 60 * 60 * 1000);
    await env.DB.prepare("INSERT OR IGNORE INTO rate_salts (day, salt, created_at) VALUES (?,?,?)")
      .bind(yesterday, "salt-of-yesterday", Date.now())
      .run();
    const rows = await env.DB.prepare("SELECT day, salt FROM rate_salts WHERE day IN (?,?)")
      .bind(today, yesterday)
      .all<{ day: string; salt: string }>();
    const salts = new Set((rows.results ?? []).map((r) => r.salt));
    expect(salts.size).toBe((rows.results ?? []).length);
  });
});

describe("purgeOldIpQuota", () => {
  it("古い記録と塩を消す（新しいものは残す）", async () => {
    const old = dayKey(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await env.DB.prepare("INSERT OR REPLACE INTO rate_salts (day, salt, created_at) VALUES (?,?,?)")
      .bind(old, "old-salt", Date.now())
      .run();
    await env.DB.prepare(
      "INSERT OR REPLACE INTO rate_counters (scope, day, client, count, updated_at) VALUES (?,?,?,?,?)"
    )
      .bind("test-purge", old, "deadbeef", 5, Date.now())
      .run();

    await purgeOldIpQuota(env);

    const salt = await env.DB.prepare("SELECT day FROM rate_salts WHERE day = ?").bind(old).first();
    const counter = await env.DB.prepare("SELECT day FROM rate_counters WHERE day = ?").bind(old).first();
    expect(salt).toBeNull();
    expect(counter).toBeNull();
    const today = await env.DB.prepare("SELECT day FROM rate_salts WHERE day = ?").bind(dayKey()).first();
    expect(today).not.toBeNull();
  });
});

describe("/api/contact", () => {
  it("同じ送信元から送りすぎると429で止まる", async () => {
    const ip = "198.51.100.55";
    let last: Response | null = null;
    for (let i = 0; i < 10; i++) {
      last = await SELF.fetch(`${BASE}/api/contact`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: JSON.stringify({ contact: `flood${i}@example.com`, message: "こんにちは" }),
      });
    }
    expect(last?.status).toBe(429);
  });
});
