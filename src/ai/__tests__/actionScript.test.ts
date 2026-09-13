import { describe, it, expect } from "vitest";
import { buildActionScript, detectEmotion } from "../actionScript";
import { DEFAULT_PERSONALITY } from "../personality";

/**
 * 「かざして話す」の演出スクリプトの検証。
 *
 * 画面側はこの配列を上から実行するだけなので、
 * **必ず say ステップが含まれること**（＝返事が必ず出力されること）が最低条件になる。
 * ここが欠けると、分身が動くだけで何も答えない画面になってしまう。
 */

describe("detectEmotion", () => {
  it("reads plain emotional cues out of Japanese replies", () => {
    expect(detectEmotion("うれしい！ありがとう")).toBe("happy");
    expect(detectEmotion("えっ、まさかそんなことが")).toBe("surprised");
    expect(detectEmotion("ちょっとさみしかったんだ")).toBe("sad");
    expect(detectEmotion("それってどういうこと？")).toBe("curious");
  });

  it("falls back to the personality when the text gives no hint", () => {
    expect(detectEmotion("そう", { ...DEFAULT_PERSONALITY, cheerfulness: 80 })).toBe("happy");
    expect(detectEmotion("そう", { ...DEFAULT_PERSONALITY, curiosity: 80 })).toBe("curious");
    expect(detectEmotion("そう", { ...DEFAULT_PERSONALITY, caution: 80 })).toBe("shy");
    expect(detectEmotion("そう", DEFAULT_PERSONALITY)).toBe("calm");
  });
});

describe("buildActionScript", () => {
  it("always includes the reply as a say step", () => {
    const script = buildActionScript("おかえり", DEFAULT_PERSONALITY);
    const say = script.steps.find((s) => s.type === "say");
    expect(say).toBeDefined();
    expect(say && "text" in say ? say.text : "").toBe("おかえり");
  });

  it("emotes and moves before it speaks (so the reaction is not delayed behind the sentence)", () => {
    const script = buildActionScript("わーい、うれしい！", DEFAULT_PERSONALITY);
    const types = script.steps.map((s) => s.type);
    expect(types.indexOf("emote")).toBeLessThan(types.indexOf("say"));
    expect(types.indexOf("move")).toBeLessThan(types.indexOf("say"));
  });

  it("adds an afterglow effect for strong emotions", () => {
    const happy = buildActionScript("やった！うれしい", { ...DEFAULT_PERSONALITY, cheerfulness: 20, humor: 20 });
    expect(happy.steps.some((s) => s.type === "effect")).toBe(true);
  });

  it("keeps a quiet character quiet (no extra effects when nothing calls for them)", () => {
    const calm = buildActionScript("そうだね", {
      ...DEFAULT_PERSONALITY,
      cheerfulness: 20,
      humor: 20,
      curiosity: 30,
      caution: 30,
    });
    expect(calm.emotion).toBe("calm");
    expect(calm.steps.some((s) => s.type === "effect")).toBe(false);
  });
});
