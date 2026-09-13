import { describe, it, expect } from "vitest";
import { deriveVoiceProfile } from "../voiceProfile";
import { DEFAULT_PERSONALITY } from "../personality";

/**
 * 「分身ごとの固有の声」の検証。
 *
 * 大事なのは **同じ分身がいつでも同じ声で喋ること**。
 * ここが揺れると、同じ子に会っているという感覚が崩れる（別人が出てくるのと同じ）。
 */

describe("deriveVoiceProfile", () => {
  it("gives the same character the same voice every time", () => {
    const a = deriveVoiceProfile("cid-abc", DEFAULT_PERSONALITY);
    const b = deriveVoiceProfile("cid-abc", DEFAULT_PERSONALITY);
    expect(a).toEqual(b);
  });

  it("gives different characters different voices", () => {
    const voices = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => {
        const v = deriveVoiceProfile(`cid-${s}`, DEFAULT_PERSONALITY);
        return `${v.pitch}:${v.voiceIndex}`;
      })
    );
    // 8体で全部同じ声になるようだと、個体差として機能していない
    expect(voices.size).toBeGreaterThan(3);
  });

  it("keeps the timbre fixed while the personality changes the delivery", () => {
    const calm = deriveVoiceProfile("cid-grow", { ...DEFAULT_PERSONALITY, cheerfulness: 20, caution: 80 });
    const lively = deriveVoiceProfile("cid-grow", { ...DEFAULT_PERSONALITY, cheerfulness: 90, caution: 20 });

    // 声質（何番目の声を使うか）は育っても変わらない
    expect(calm.voiceIndex).toBe(lively.voiceIndex);
    // 話す速さは性格で変わる（陽気な方が速い）
    expect(lively.rate).toBeGreaterThan(calm.rate);
  });

  it("stays inside the range the Web Speech API accepts", () => {
    for (let i = 0; i < 50; i++) {
      const v = deriveVoiceProfile(`cid-${i}`, {
        warmth: i * 2,
        curiosity: 50,
        cheerfulness: (i * 7) % 100,
        caution: (i * 3) % 100,
        independence: 50,
        humor: 50,
      });
      expect(v.pitch).toBeGreaterThanOrEqual(0.7);
      expect(v.pitch).toBeLessThanOrEqual(1.5);
      expect(v.rate).toBeGreaterThanOrEqual(0.8);
      expect(v.rate).toBeLessThanOrEqual(1.3);
      expect(v.voiceIndex).toBeGreaterThanOrEqual(0);
      expect(v.voiceIndex).toBeLessThan(4);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });

  it("works without a personality (used before the character is loaded)", () => {
    const v = deriveVoiceProfile("cid-nopersonality");
    expect(v.pitch).toBeGreaterThan(0);
    expect(v.rate).toBeGreaterThan(0);
  });
});
