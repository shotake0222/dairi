/**
 * 死活・自己診断エンドポイント。
 *
 * 実機で「なんとなく記憶が弱い」「お散歩の相手が見つからない」といった症状が出たとき、
 * 原因がコードなのか設定漏れ（マイグレーション未適用・Vectorizeインデックス未作成）なのかを
 * 切り分けるのに、毎回ログを漁るのは重い。ここを見れば1秒で分かる状態にしておく。
 *
 * 設計上の注意:
 * - **既定ではWorkers AIを呼ばない**。AIは呼ぶたびに課金されるため、
 *   監視から定期的に叩かれる可能性のあるエンドポイントで無条件に呼ぶべきではない。
 *   AIまで含めて確認したいときだけ `?deep=1` を付ける。
 * - 個々のチェックが失敗しても全体を落とさず、どれが駄目なのかを個別に返す。
 */

import { EMBEDDING_MODEL } from "./ai/memory";
import { LogContext, logInfo } from "./lib/log";

interface CheckResult {
  ok: boolean;
  detail?: string;
  ms?: number;
}

interface HealthEnv {
  DB: D1Database;
  MEMORY_INDEX: VectorizeIndex;
  AI: Ai;
  APP_VERSION?: string;
  BUILT_AT?: string;
}

async function timed(fn: () => Promise<string | undefined>): Promise<CheckResult> {
  const startedAt = Date.now();
  try {
    const detail = await fn();
    return { ok: true, detail, ms: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt };
  }
}

export async function handleHealth(env: HealthEnv, url: URL, log: LogContext): Promise<Response> {
  const deep = url.searchParams.get("deep") === "1";

  // D1: テーブルが実在するかまで見る（マイグレーション未適用の取りこぼしがいちばん多い）
  const d1 = await timed(async () => {
    const tags = await env.DB.prepare("SELECT count(*) AS n FROM nfc_tags").first<{ n: number }>();
    const directory = await env.DB.prepare("SELECT count(*) AS n FROM character_directory").first<{ n: number }>();
    return `nfc_tags=${tags?.n ?? 0}, character_directory=${directory?.n ?? 0}`;
  });

  // Vectorize: インデックスの情報を引く（作成忘れならここで落ちる）
  const vectorize = await timed(async () => {
    const info = (await env.MEMORY_INDEX.describe()) as { dimensions?: number; vectorCount?: number } | undefined;
    return info ? `dimensions=${info.dimensions ?? "?"}, vectors=${info.vectorCount ?? "?"}` : "described";
  });

  // AI: 明示的に要求されたときだけ、最小の埋め込みを1回だけ実行する
  const ai: CheckResult = deep
    ? await timed(async () => {
        const res = (await env.AI.run(EMBEDDING_MODEL, { text: ["ping"] })) as { data?: number[][] };
        const dim = res?.data?.[0]?.length;
        return dim ? `embedding dimensions=${dim}` : "responded";
      })
    : { ok: true, detail: "skipped (?deep=1 で実行。呼ぶと課金が発生します)" };

  const body = {
    ok: d1.ok && vectorize.ok && ai.ok,
    version: env.APP_VERSION || "dev",
    builtAt: env.BUILT_AT || null,
    checkedAt: new Date().toISOString(),
    checks: { d1, vectorize, ai },
  };

  logInfo(log, "health", { ok: body.ok, d1: d1.ok, vectorize: vectorize.ok, deep });

  return new Response(JSON.stringify(body, null, 2), {
    status: body.ok ? 200 : 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-waketama-version": body.version,
    },
  });
}
