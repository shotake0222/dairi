import { describe, it, expect, beforeEach, vi } from "vitest";
import { env, SELF } from "cloudflare:test";

/**
 * /api/health の検証。
 *
 * このエンドポイントの価値は「設定漏れを即座に見つけられること」なので、
 * 失敗したときにちゃんと失敗として返るか（＝異常を見逃さないか）を重点的に確認する。
 * また、監視から定期的に叩かれてもAI課金が発生しないことは必ず守りたいので、そこもテストする。
 */

const BASE = "https://example.com";

interface HealthBody {
  ok: boolean;
  version: string;
  builtAt: string | null;
  checks: {
    d1: { ok: boolean; detail?: string };
    vectorize: { ok: boolean; detail?: string };
    ai: { ok: boolean; detail?: string };
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(env.AI, "run").mockRejectedValue(new Error("AI is disabled by default in tests"));
  // Vectorizeにもローカルシミュレータが無く、素で呼ぶと「remoteで動かせ」と例外になる。
  // health側で握りつぶしてはいるが、挙動を決定的にしてログも汚さないよう既定でモックしておく。
  vi.spyOn(env.MEMORY_INDEX, "describe").mockResolvedValue({
    dimensions: 1024,
    vectorCount: 0,
  } as never);
});

describe("GET /api/health", () => {
  it("D1のテーブルまで確認し、結果を個別に返す", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    const body = await res.json<HealthBody>();

    expect(body.checks.d1.ok).toBe(true);
    // マイグレーション済みなら件数が読めている（未適用ならここが false になる）
    expect(body.checks.d1.detail).toContain("nfc_tags=");
    expect(body.checks.d1.detail).toContain("character_directory=");
  });

  it("既定ではWorkers AIを呼ばない（監視から叩かれても課金させない）", async () => {
    const aiSpy = vi.spyOn(env.AI, "run");
    const res = await SELF.fetch(`${BASE}/api/health`);
    const body = await res.json<HealthBody>();

    expect(aiSpy).not.toHaveBeenCalled();
    expect(body.checks.ai.ok).toBe(true);
    expect(body.checks.ai.detail).toContain("skipped");
  });

  it("?deep=1 のときだけAIを1回呼んで確認する", async () => {
    const aiSpy = vi.spyOn(env.AI, "run").mockResolvedValue({ data: [[0.1, 0.2, 0.3]] } as never);
    const res = await SELF.fetch(`${BASE}/api/health?deep=1`);
    const body = await res.json<HealthBody>();

    expect(aiSpy).toHaveBeenCalledTimes(1);
    expect(body.checks.ai.ok).toBe(true);
    expect(body.checks.ai.detail).toContain("dimensions=3");
  });

  it("依存先が落ちているときは 503 を返し、どれが駄目かが分かる", async () => {
    // Vectorizeが使えない状況を再現する（インデックス未作成などで実際に起こる）
    vi.spyOn(env.MEMORY_INDEX, "describe").mockRejectedValue(new Error("index not found"));

    const res = await SELF.fetch(`${BASE}/api/health`);
    const body = await res.json<HealthBody>();

    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.vectorize.ok).toBe(false);
    expect(body.checks.vectorize.detail).toContain("index not found");
    // 他の項目は巻き込まれず、個別に成否が分かること
    expect(body.checks.d1.ok).toBe(true);
  });

  it("版数を返し、レスポンスヘッダにも載せる（実機の版ずれ切り分け用）", async () => {
    const res = await SELF.fetch(`${BASE}/api/health`);
    const body = await res.json<HealthBody>();

    expect(body.version).toBeTruthy();
    expect(res.headers.get("x-waketama-version")).toBe(body.version);
    // 監視やブラウザにキャッシュされると意味が無くなる
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
