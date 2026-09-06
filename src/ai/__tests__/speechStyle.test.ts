import { describe, it, expect } from "vitest";
import { DEFAULT_PERSONALITY, PersonalityTraits } from "../personality";
import { deriveSpeechStyle } from "../speechStyle";

describe("deriveSpeechStyle", () => {
  it("stays neutral (素直・標準) when personality is still near default", () => {
    const style = deriveSpeechStyle(DEFAULT_PERSONALITY);
    expect(style.label).toBe("素直・標準");
  });

  it("locks in 甘えん坊・懐っこい when warmth is high and independence is low", () => {
    const p: PersonalityTraits = { ...DEFAULT_PERSONALITY, warmth: 95, independence: 10 };
    expect(deriveSpeechStyle(p).label).toBe("甘えん坊・懐っこい");
  });

  it("locks in 弱気・遠慮がち when caution is high and warmth/cheerfulness are low", () => {
    const p: PersonalityTraits = { ...DEFAULT_PERSONALITY, caution: 95, warmth: 10, cheerfulness: 10 };
    expect(deriveSpeechStyle(p).label).toBe("弱気・遠慮がち");
  });

  it("locks in 陽気・お調子者 when cheerfulness and humor are high", () => {
    const p: PersonalityTraits = { ...DEFAULT_PERSONALITY, cheerfulness: 95, humor: 90 };
    expect(deriveSpeechStyle(p).label).toBe("陽気・お調子者");
  });

  it("does not flip styles from a single-point deviation (avoids noise near the threshold)", () => {
    const p: PersonalityTraits = { ...DEFAULT_PERSONALITY, warmth: 51 };
    expect(deriveSpeechStyle(p).label).toBe("素直・標準");
  });

  it("always returns a non-empty endingHint and toneInstruction", () => {
    const style = deriveSpeechStyle({ ...DEFAULT_PERSONALITY, humor: 100, caution: 5 });
    expect(style.endingHint.length).toBeGreaterThan(0);
    expect(style.toneInstruction.length).toBeGreaterThan(0);
  });
});
