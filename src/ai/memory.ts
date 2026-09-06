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
    return null;
  } catch (err) {
    // 埋め込み失敗時は長期記憶機能を静かにスキップする（チャット自体は継続させる）
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
  if (!vector) return;

  try {
    await env.MEMORY_INDEX.upsert([
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
  } catch (err) {
    // Vectorizeへの書き込み失敗は致命的ではないため握りつぶす（次回以降のRAG精度が少し下がるだけ）
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
    // メタデータインデックス未作成など、初期セットアップ未完了時にもチャットは継続できるようにする
    return [];
  }
}
