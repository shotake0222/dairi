/**
 * 使用するAIモデルと、その呼び出し方をここ1箇所に集約する。
 *
 * なぜ分離したか:
 * これまでモデルIDは characterState.ts の中に定数として1つだけ置かれていた。
 * その結果、(1) モデルを見直すときにDOの実装を触ることになり、(2) 用途（通常会話/要約/視覚）ごとに
 * 別のモデルを使い分けられず、(3) 一時的にモデルが落ちているときのフォールバックも書けなかった。
 * 会話品質は「モデル選び」と「渡す文脈の作り方」の掛け算で決まるので、前者はここに、
 * 後者は promptBuilder.ts と characterState.ts に、はっきり分けて置く。
 *
 * 重要な設計判断:
 * - **フォールバック連鎖**を持つ。上位モデルが落ちていても、下位モデルで会話は続く。
 *   「今はうまく考えがまとまらないみたい」と黙り込むのは最後の手段にする。
 * - **環境変数で上書きできる**。品質評価のたびにコードを書き換えてデプロイし直すのは重いので、
 *   `--var CHAT_MODEL:...` で本番/検証を切り替えられるようにしてある。
 * - **成長段階に応じて文脈量を変える**。生まれたては短く素朴に、育つほど文脈を厚くする。
 *   モデルを弱くして「バカな時期」を作るのではなく、渡す記憶と許す長さで差をつける
 *   （弱いモデルにすると口調まで崩れて、単に品質が悪いだけになるため）。
 */

export interface ModelEnv {
  AI: Ai;
  /** 本番で会話モデルを差し替えるための上書き（wrangler の --var / [vars] で注入）。 */
  CHAT_MODEL?: string;
}

type ChatModelId = keyof AiModels;

/**
 * 会話用モデルの優先順位。
 *
 * 先頭が第一候補で、失敗したら順に降りていく。最後の3Bは「必ず動くこと」を優先した保険で、
 * 品質のために置いているわけではない（ここまで落ちたら、それは障害として気づけるようログに残す）。
 */
export const CHAT_MODEL_CHAIN: readonly ChatModelId[] = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/google/gemma-3-12b-it",
  "@cf/meta/llama-3.2-3b-instruct",
];

/** 「覚え書き」の蒸留など、裏方の要約処理に使うモデル（会話ほどの表現力は不要なので軽いものを使う）。 */
export const SUMMARY_MODEL: ChatModelId = "@cf/google/gemma-3-12b-it";

/** 「これ見て」で使う視覚モデル。 */
export const VISION_MODEL: ChatModelId = "@cf/meta/llama-3.2-11b-vision-instruct";

/**
 * 後方互換のためのエイリアス。
 * 以前は characterState.ts が CHAT_MODEL という名前の定数を公開しており、
 * call.ts など複数箇所がそれを参照していた。参照先をここへ移したうえで、
 * 「単一のモデルID」を要求する箇所（ストリーミング等）には第一候補を返す。
 */
export function primaryChatModel(env: ModelEnv): ChatModelId {
  const override = (env.CHAT_MODEL || "").trim();
  if (override) return override as ChatModelId;
  return CHAT_MODEL_CHAIN[0];
}

/** 環境変数の上書きを先頭に差し込んだ、実際に試すモデルの並び。 */
export function chatModelChain(env: ModelEnv): ChatModelId[] {
  const override = (env.CHAT_MODEL || "").trim();
  if (!override) return [...CHAT_MODEL_CHAIN];
  const rest = CHAT_MODEL_CHAIN.filter((m) => m !== override);
  return [override as ChatModelId, ...rest];
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  /** 実際に応答を返したモデル。ログや `/api/health` の確認に使う。 */
  model: string;
  /** 第一候補で失敗した回数（0なら一発で通っている）。 */
  fallbacks: number;
}

export interface ChatOptions {
  maxTokens?: number;
  temperature?: number;
  /** 各モデルの失敗を記録するためのフック（ログの実装をこのモジュールに持ち込まないための注入口）。 */
  onFailure?: (model: string, error: unknown) => void;
}

/**
 * 会話モデルを呼ぶ。連鎖の先頭から順に試し、最初に応答が取れたものを返す。
 * すべて失敗した場合だけ null を返す（呼び出し元がキャラクターらしい言い訳を返す）。
 */
export async function runChat(
  env: ModelEnv,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<ChatResult | null> {
  const chain = chatModelChain(env);
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    try {
      const response = (await env.AI.run(model, {
        messages,
        max_tokens: options.maxTokens ?? 320,
        temperature: options.temperature ?? 0.8,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)) as { response?: string };
      const text = (response?.response || "").trim();
      if (text) return { text, model, fallbacks: i };
      // 応答が空文字なのは、モデルが生きていても中身が返っていない状態。次の候補を試す価値がある。
      options.onFailure?.(model, new Error("empty response"));
    } catch (err) {
      options.onFailure?.(model, err);
    }
  }
  return null;
}

/**
 * 成長段階に応じた「文脈の厚み」。
 *
 * これが「だんだん賢くなっていく」の実体。生まれたては短く素朴に、
 * 育つほど覚えている量と話せる長さが増えていく。数値は体験の手触りで調整する前提で、
 * 判定ロジックを散らかさないようここに集約している。
 */
export interface ContextBudget {
  /** プロンプトに載せる直近のやり取りの往復数 */
  historyTurns: number;
  /** 長期記憶（Vectorize）から引く件数 */
  recallTopK: number;
  /** 返答の目安の長さ（プロンプトにそのまま書く） */
  replyLengthHint: string;
  /** 生成トークンの上限 */
  maxTokens: number;
}

export function contextBudgetFor(interactionCount: number): ContextBudget {
  if (interactionCount < 5) {
    // 誕生したばかり: まだ相手のことを知らない。短く、たどたどしく。
    return { historyTurns: 3, recallTopK: 2, replyLengthHint: "1〜2文", maxTokens: 160 };
  }
  if (interactionCount < 20) {
    return { historyTurns: 5, recallTopK: 3, replyLengthHint: "1〜3文", maxTokens: 220 };
  }
  if (interactionCount < 50) {
    return { historyTurns: 7, recallTopK: 4, replyLengthHint: "2〜3文", maxTokens: 280 };
  }
  // 成熟期: 過去の話も踏まえて、踏み込んだ返しができるようになる。
  return { historyTurns: 10, recallTopK: 5, replyLengthHint: "2〜4文", maxTokens: 360 };
}
