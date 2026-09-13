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
import { chatModelChain, runChat } from "./ai/modelPolicy";
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
  CHAT_MODEL?: string;
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

  // 会話モデル: 「意図した設定」はAIを呼ばずに見せ、「実際に応答するのはどれか」は ?deep=1 のときだけ確かめる。
  //
  // これが無いと、フォールバックで下位モデルに落ちたまま運用していても気づけない。
  // 上位モデルが落ちても会話は続く設計なので、症状が「なんとなく返事が浅い」だけになり、
  // ログを漁るまで分からない状態になってしまう。ここを見れば1回で分かるようにしておく。
  const chain = chatModelChain(env);
  const chat: CheckResult = deep
    ? await timed(async () => {
        const result = await runChat(env, [{ role: "user", content: "ping" }], { maxTokens: 8, temperature: 0 });
        if (!result) throw new Error(`全モデルが応答しませんでした（試した順: ${chain.join(", ")}）`);
        return result.fallbacks === 0
          ? `answered by ${result.model}`
          : `answered by ${result.model}（第一候補から${result.fallbacks}段フォールバック）`;
      })
    : { ok: true, detail: `configured: ${chain.join(" → ")}（実際の応答確認は ?deep=1）` };

  const body = {
    ok: d1.ok && vectorize.ok && ai.ok && chat.ok,
    version: env.APP_VERSION || "dev",
    builtAt: env.BUILT_AT || null,
    checkedAt: new Date().toISOString(),
    checks: { d1, vectorize, ai, chat },
  };

  logInfo(log, "health", { ok: body.ok, d1: d1.ok, vectorize: vectorize.ok, chat: chat.ok, deep });

  return new Response(JSON.stringify(body, null, 2), {
    status: body.ok ? 200 : 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-waketama-version": body.version,
    },
  });
}
