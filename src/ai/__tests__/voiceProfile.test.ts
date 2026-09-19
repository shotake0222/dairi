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
      // Web Speech API が受け付けるのは pitch 0〜2 / rate 0.1〜10。
      // 可愛らしい方へ寄せたので上限を 2.0 まで使うが、仕様の外へは出さない。
      expect(v.pitch).toBeGreaterThanOrEqual(0.7);
      expect(v.pitch).toBeLessThanOrEqual(2.0);
      expect(v.rate).toBeGreaterThanOrEqual(0.8);
      expect(v.rate).toBeLessThanOrEqual(1.4);
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

/**
 * 種族と色で声が変わること。
 *
 * 「どの子も同じ声で喋る」に戻っていないかを見るためのテスト。
 * 声は聞かないと分からないが、**少なくとも数値が全部違うこと**は機械で確かめられる。
 * ここが同じ値に潰れていたら、実機で聞いても区別がつかない。
 */
describe("種族・色ごとの声", () => {
  const SPECIES = ["punikoro", "mofukuru", "tsunomaru", "howahowa", "kiratsubu"];
  const COLORS = ["coral", "sky", "leaf", "sun", "lavender", "peach"];

  it("30通りの組み合わせが、すべて違う声になる", () => {
    const seen = new Set<string>();
    for (const s of SPECIES) {
      for (const c of COLORS) {
        // 個体差（characterIdのゆらぎ）を消して、種族と色の差だけを見る
        const v = deriveVoiceProfile("same-seed", DEFAULT_PERSONALITY, s, c);
        seen.add(`${v.pitch}/${v.rate}`);
      }
    }
    expect(seen.size).toBe(SPECIES.length * COLORS.length);
  });

  it("同じ種族・同じ色でも、個体ごとに少しだけ違う", () => {
    const a = deriveVoiceProfile("cid-one", DEFAULT_PERSONALITY, "punikoro", "sun");
    const b = deriveVoiceProfile("cid-two", DEFAULT_PERSONALITY, "punikoro", "sun");
    expect(a.pitch).not.toBe(b.pitch);
    // ただし、色や種族の差が埋もれるほどは動かさない
    expect(Math.abs(a.pitch - b.pitch)).toBeLessThan(0.12);
  });

  it("どの子も、見た目に合う高めの声になる（低い大人の声にならない）", () => {
    for (const s of SPECIES) {
      for (const c of COLORS) {
        const v = deriveVoiceProfile(`cid-${s}-${c}`, DEFAULT_PERSONALITY, s, c);
        expect(v.pitch).toBeGreaterThanOrEqual(1.0);
        expect(v.pitch).toBeLessThanOrEqual(2.0);
        expect(v.rate).toBeGreaterThanOrEqual(0.8);
        expect(v.rate).toBeLessThanOrEqual(1.4);
      }
    }
  });

  it("説明の文言に、色と種族の両方が出る", () => {
    const v = deriveVoiceProfile("cid-label", DEFAULT_PERSONALITY, "kiratsubu", "peach");
    expect(v.label).toContain("あまえた");
    expect(v.label).toContain("きらきら");
  });

  it("種族・色が分からない古い呼び出しでも壊れない", () => {
    const v = deriveVoiceProfile("legacy-cid", DEFAULT_PERSONALITY);
    expect(v.pitch).toBeGreaterThan(0);
    expect(v.label.length).toBeGreaterThan(0);
  });
});
