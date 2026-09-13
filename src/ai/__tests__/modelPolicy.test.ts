import { describe, it, expect, vi } from "vitest";
import {
  CHAT_MODEL_CHAIN,
  chatModelChain,
  contextBudgetFor,
  primaryChatModel,
  runChat,
} from "../modelPolicy";

/**
 * モデル選択とフォールバックの検証。
 *
 * ここで守りたいのは2点だけ:
 *   1. 上位モデルが落ちていても会話が続くこと（黙り込むのは全滅したときだけ）
 *   2. 育つほど渡す文脈が厚くなること（「だんだん賢くなる」の実体）
 */

/** env.AI.run の代わり。呼ばれたモデルIDを記録しつつ、指定した順に成功/失敗を返す。 */
function fakeAi(behaviors: Array<{ ok: boolean; text?: string }>) {
  const calls: string[] = [];
  let i = 0;
  const run = vi.fn(async (model: string) => {
    calls.push(model);
    const behavior = behaviors[Math.min(i, behaviors.length - 1)];
    i++;
    if (!behavior.ok) throw new Error("model down");
    return { response: behavior.text ?? "こんにちは" };
  });
  return { env: { AI: { run } } as unknown as { AI: Ai }, calls };
}

describe("chatModelChain", () => {
  it("uses the built-in chain when no override is set", () => {
    expect(chatModelChain({ AI: {} as Ai })).toEqual([...CHAT_MODEL_CHAIN]);
  });

  it("puts an env override first and keeps the rest as fallbacks", () => {
    const chain = chatModelChain({ AI: {} as Ai, CHAT_MODEL: "@cf/google/gemma-3-12b-it" });
    expect(chain[0]).toBe("@cf/google/gemma-3-12b-it");
    // 上書きしたモデルが連鎖の中に二重で現れないこと（同じモデルを2回試しても無意味なので）
    expect(chain.filter((m) => m === "@cf/google/gemma-3-12b-it")).toHaveLength(1);
    expect(chain.length).toBe(CHAT_MODEL_CHAIN.length);
  });

  it("exposes the override as the primary model for streaming callers", () => {
    expect(primaryChatModel({ AI: {} as Ai })).toBe(CHAT_MODEL_CHAIN[0]);
    expect(primaryChatModel({ AI: {} as Ai, CHAT_MODEL: "@cf/meta/llama-3.2-3b-instruct" })).toBe(
      "@cf/meta/llama-3.2-3b-instruct"
    );
  });
});

describe("runChat", () => {
  it("returns the first successful model's text without trying the rest", async () => {
    const { env, calls } = fakeAi([{ ok: true, text: "やっほー" }]);
    const result = await runChat(env, [{ role: "user", content: "こんにちは" }]);
    expect(result?.text).toBe("やっほー");
    expect(result?.fallbacks).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("falls through to the next model when the first one throws", async () => {
    const { env, calls } = fakeAi([{ ok: false }, { ok: true, text: "二番手だよ" }]);
    const onFailure = vi.fn();
    const result = await runChat(env, [{ role: "user", content: "やあ" }], { onFailure });

    expect(result?.text).toBe("二番手だよ");
    expect(result?.fallbacks).toBe(1);
    expect(result?.model).toBe(CHAT_MODEL_CHAIN[1]);
    expect(calls).toEqual([CHAT_MODEL_CHAIN[0], CHAT_MODEL_CHAIN[1]]);
    // 落ちたことに気づけないと、静かに品質が下がったまま運用してしまう
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it("treats an empty response as a failure and tries the next model", async () => {
    const { env, calls } = fakeAi([{ ok: true, text: "   " }, { ok: true, text: "こっちは喋れる" }]);
    const result = await runChat(env, [{ role: "user", content: "やあ" }]);
    expect(result?.text).toBe("こっちは喋れる");
    expect(calls).toHaveLength(2);
  });

  it("returns null only when every model in the chain fails", async () => {
    const { env, calls } = fakeAi([{ ok: false }]);
    const result = await runChat(env, [{ role: "user", content: "やあ" }]);
    expect(result).toBeNull();
    expect(calls).toHaveLength(CHAT_MODEL_CHAIN.length);
  });
});

describe("contextBudgetFor", () => {
  it("gives a newborn less context and a mature character more", () => {
    const newborn = contextBudgetFor(0);
    const mature = contextBudgetFor(120);

    expect(mature.historyTurns).toBeGreaterThan(newborn.historyTurns);
    expect(mature.recallTopK).toBeGreaterThan(newborn.recallTopK);
    expect(mature.maxTokens).toBeGreaterThan(newborn.maxTokens);
  });

  it("never shrinks as the character grows", () => {
    const counts = [0, 4, 5, 19, 20, 49, 50, 200];
    let prevTurns = 0;
    let prevRecall = 0;
    for (const c of counts) {
      const budget = contextBudgetFor(c);
      expect(budget.historyTurns).toBeGreaterThanOrEqual(prevTurns);
      expect(budget.recallTopK).toBeGreaterThanOrEqual(prevRecall);
      prevTurns = budget.historyTurns;
      prevRecall = budget.recallTopK;
    }
  });
});
