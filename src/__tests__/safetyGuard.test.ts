import { describe, it, expect } from "vitest";
import { detectsSelfHarmSignal, SELF_HARM_RESPONSE } from "../ai/safetyGuard";

describe("detectsSelfHarmSignal", () => {
  it("代表的な言い回しを検知する", () => {
    expect(detectsSelfHarmSignal("もう死にたい")).toBe(true);
    expect(detectsSelfHarmSignal("消えたいって思うことがある")).toBe(true);
    expect(detectsSelfHarmSignal("自殺のことを考えてしまう")).toBe(true);
    expect(detectsSelfHarmSignal("リストカットしちゃった")).toBe(true);
  });

  it("何気ない会話には反応しない", () => {
    expect(detectsSelfHarmSignal("こんにちは、今日は天気がいいね")).toBe(false);
    expect(detectsSelfHarmSignal("ゲームで負けて悔しい")).toBe(false);
  });

  it("固定応答には、相談窓口の案内が含まれる（電話とチャットの両方）", () => {
    expect(SELF_HARM_RESPONSE).toContain("0120-279-338");
    expect(SELF_HARM_RESPONSE).toContain("talkme.jp");
  });
});
