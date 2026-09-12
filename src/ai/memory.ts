/**
 * Vectorize を使った長期記憶（RAG）モジュール。
 *
 * 設計方針:
 * - 短期記憶（直近の会話ログ）は characterState.ts 側で文字列としてそのまま保持する（軽量・確認しやすい）。
 * - 長期記憶はここで「発言の埋め込みベクトル」としてVectorizeに蓄積し、
 *   新しいメッセージが来るたびに類似度検索で「今の話題に関係が深い過去のやり取り」だけを引っ張り出す。
 * - これにより、会話量が増えても毎回のプロンプトが肥大化せず、かつ「昔話したこと」を思い出せるようになる。
 *
 * 埋め込みモデルは @cf/baai/bge-m3（多言語対応・日本語OK・1024次元）を使用。
 * Cloudflare Workers AI上での正確な入出力スキーマは、モデルのドキュメント例に基づき
 * { text: string[] } 形式で呼び出し、{ data: number[][] } 形式で返る想定で実装している。
 * もし実際のレスポンス形状が異なりランタイムエラーになった場合は、下記 embedText() 内の
 * パース処理だけを直せば良いように、呼び出し口を1箇所に集約してある。
 */

import { logDetachedError, logDetachedWarn } from "../lib/log";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";

export interface MemoryEnv {
  AI: Ai;
  MEMORY_INDEX: VectorizeIndex;
}

/** テキストを埋め込みベクトルに変換する。呼び出し口をここに集約し、レスポンス形状の差異に強くする。 */
export async function embedText(env: MemoryEnv, text: string): Promise<number[] | null> {
  try {
    const res = (await env.AI.run(EMBEDDING_MODEL, { text: [text] })) as unknown;

    // 想定される主なレスポンス形状に防御的に対応する。
    // 1) { data: number[][] }  … bge-base-en-v1.5などと同系統のシンプルな形（最有力候補）
    // 2) { response: { data: number[][] } } のようにネストされている可能性
    // 3) 万一 { embedding: number[] } のような単一ベクトル形の場合
    const asAny = res as {
      data?: number[][];
      response?: { data?: number[][] };
      embedding?: number[];
    };

    const vector = asAny?.data?.[0] ?? asAny?.response?.data?.[0] ?? asAny?.embedding;
    if (Array.isArray(vector) && vector.length > 0 && typeof vector[0] === "number") {
      return vector;
    }
    // 例外ではないが、想定した形でベクトルが取れていない状態。
    // モデル側のレスポンス形状が変わったときにここに落ちるので、必ず気づけるようにする。
    logDetachedWarn("memory.embed_unexpected_shape", { keys: Object.keys(asAny || {}).join(",") });
    return null;
  } catch (err) {
    // 埋め込み失敗時は長期記憶機能をスキップする（チャット自体は継続させる）。
    // ただし黙って消すと「なんとなく記憶が弱い」の原因が追えなくなるので、必ず記録する。
    logDetachedError("memory.embed_failed", err);
    return null;
  }
}

/** 1往復のやり取りをVectorizeに保存する（失敗しても呼び出し元のチャット処理は止めない）。 */
export async function storeMemory(
  env: MemoryEnv,
  characterId: string,
  userMessage: string,
  reply: string
): Promise<void> {
  const text = `ユーザー: ${userMessage}\nキャラクター: ${reply}`;
  const vector = await embedText(env, text);
  if (!vector) {
    logDetachedWarn("memory.store_skipped_no_vector", { characterId });
    return;
  }

  try {
    const result = await env.MEMORY_INDEX.upsert([
      {
        id: crypto.randomUUID(),
        values: vector,
        metadata: {
          characterId,
          text,
          createdAt: Date.now(),
        },
      },
    ]);
    // Vectorizeの書き込みは非同期に処理されるため、ここでの成功＝即座に検索可能ではない。
    // mutationIdを残しておくと、後から「送ったのに入っていない」の切り分けができる。
    logDetachedWarn("memory.stored", {
      characterId,
      mutationId: (result as { mutationId?: string } | undefined)?.mutationId,
    });
  } catch (err) {
    // 書き込み失敗は致命的ではない（次回以降のRAG精度が少し下がるだけ）が、
    // 黙って消すと記憶が貯まらない原因が分からなくなるため必ず記録する。
    logDetachedError("memory.store_failed", err, { characterId });
  }
}

/** 今回のメッセージに関連が深い過去のやり取りを、そのキャラクター専用に絞り込んで取得する。 */
export async function retrieveRelevantMemories(
  env: MemoryEnv,
  characterId: string,
  queryText: string,
  topK = 3
): Promise<string[]> {
  const vector = await embedText(env, queryText);
  if (!vector) return [];

  try {
    const result = await env.MEMORY_INDEX.query(vector, {
      topK,
      filter: { characterId },
      returnMetadata: "all",
    });
    return result.matches
      .map((m) => (m.metadata?.text as string) || "")
      .filter((t) => t.length > 0);
  } catch (err) {
    // メタデータインデックス未作成など、初期セットアップ未完了時にもチャットは継続できるようにする。
    // ここが落ち続けていると「昔の話を思い出さない」状態になるので記録する。
    logDetachedError("memory.retrieve_failed", err, { characterId });
    return [];
  }
}

export interface ExportedMemory {
  text: string;
  createdAt: number;
}

/**
 * そのキャラクターの長期記憶を、埋め込みベクトルではなく平文テキストのまま全件取り出す（エクスポート用）。
 *
 * 設計上重要な点: エクスポートするのは「テキスト」であって「ベクトル」ではない。
 * ベクトルをそのまま書き出すと、わけたまが使っているembeddingモデル（bge-m3）に
 * フォーマットが縛られてしまい、将来別のハードウェア/プラットフォームに持ち出す際の
 * 障害になる。テキストであれば、移行先がどんな埋め込みモデルを使っていても再埋め込みするだけで済み、
 * 「モデルが変わっても人格・記憶は持ち越せる」というこのプロジェクトの一貫した設計方針に合致する。
 *
 * Vectorizeには「全件列挙」専用のAPIが無いため、characterIdによるメタデータフィルタと
 * 十分に大きなtopKを組み合わせて代用している（MVP規模の記憶件数であれば実用上問題ない）。
 */
export async function exportAllMemories(env: MemoryEnv, characterId: string, limit = 100): Promise<ExportedMemory[]> {
  // クエリベクトル自体の中身はフィルタ後の結果に影響しない（類似度ランキングは問わないため）。
  // characterIdをシードにすることで、呼ぶたびに同じベクトルになり挙動が安定する。
  const vector = await embedText(env, `sodatsukake-memory-export:${characterId}`);
  if (!vector) return [];

  try {
    const result = await env.MEMORY_INDEX.query(vector, {
      topK: limit,
      filter: { characterId },
      returnMetadata: "all",
    });
    return result.matches
      .map((m) => ({
        text: (m.metadata?.text as string) || "",
        createdAt: (m.metadata?.createdAt as number) || 0,
      }))
      .filter((m) => m.text.length > 0)
      .sort((a, b) => a.createdAt - b.createdAt);
  } catch (err) {
    return [];
  }
}

/** インポート時、書き出された長期記憶を（新しいcharacterIdかもしれない）宛先に再埋め込みし直して復元する。 */
export async function importMemories(env: MemoryEnv, characterId: string, memories: ExportedMemory[]): Promise<void> {
  for (const m of memories) {
    if (!m.text) continue;
    const vector = await embedText(env, m.text);
    if (!vector) continue;
    try {
      await env.MEMORY_INDEX.upsert([
        {
          id: crypto.randomUUID(),
          values: vector,
          metadata: { characterId, text: m.text, createdAt: m.createdAt || Date.now() },
        },
      ]);
    } catch (err) {
      // 1件の復元失敗で全体を止めない（他の記憶の復元は続ける）
    }
  }
}

/**
 * そのキャラクターの長期記憶をVectorizeから全件削除する（「分身を削除する」機能の一部）。
 *
 * exportAllMemories同様、Vectorizeには「characterIdで全件削除」の直接APIが無いため、
 * まずcharacterIdでフィルタしたクエリでヒットしたベクトルのidを集め、deleteByIdsへ渡す
 * 二段構成にしている。1回のqueryで拾いきれない件数（topKの上限）が残っている可能性はあるが、
 * 「消し忘れが少し残る」ことよりも「削除操作自体が失敗して全体が止まる」ことを避ける設計とし、
 * 個々の失敗は握りつぶして呼び出し元（deleteData）の完了を優先する。
 */
export async function deleteAllMemories(env: MemoryEnv, characterId: string, limit = 200): Promise<void> {
  const vector = await embedText(env, `sodatsukake-memory-export:${characterId}`);
  if (!vector) return;

  try {
    const result = await env.MEMORY_INDEX.query(vector, {
      topK: limit,
      filter: { characterId },
    });
    const ids = result.matches.map((m) => m.id).filter((id): id is string => Boolean(id));
    if (ids.length > 0) {
      await env.MEMORY_INDEX.deleteByIds(ids);
    }
  } catch (err) {
    // Vectorize側の削除失敗は致命的ではない（DO本体のデータ削除は別途進む）
  }
}
