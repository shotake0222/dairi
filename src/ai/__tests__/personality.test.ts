import { describe, it, expect } from "vitest";
import { DEFAULT_PERSONALITY, InteractionSignal, updatePersonality, describePersonality, dominantTrait } from "../personality";

function baseSignal(overrides: Partial<InteractionSignal> = {}): InteractionSignal {
  return {
    messageLength: 20,
    sentiment: "neutral",
    sentimentIntensity: 0.5,
    topicNovelty: 0.3,
    daysSinceLastVisit: 0,
    askedQuestion: false,
    playful: false,
    ...overrides,
  };
}

describe("updatePersonality", () => {
  it("does not mutate the input object (immutability)", () => {
    const before = { ...DEFAULT_PERSONALITY };
    updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "positive" }));
    expect(DEFAULT_PERSONALITY).toEqual(before);
  });

  it("raises warmth and cheerfulness, lowers caution on positive sentiment", () => {
    const next = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "positive" }));
    expect(next.warmth).toBeGreaterThan(DEFAULT_PERSONALITY.warmth);
    expect(next.cheerfulness).toBeGreaterThan(DEFAULT_PERSONALITY.cheerfulness);
    expect(next.caution).toBeLessThan(DEFAULT_PERSONALITY.caution);
  });

  it("raises caution and lowers cheerfulness on negative sentiment", () => {
    const next = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "negative" }));
    expect(next.caution).toBeGreaterThan(DEFAULT_PERSONALITY.caution);
    expect(next.cheerfulness).toBeLessThan(DEFAULT_PERSONALITY.cheerfulness);
  });

  it("scales the change amount by sentimentIntensity", () => {
    const weak = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "positive", sentimentIntensity: 0 }));
    const strong = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "positive", sentimentIntensity: 1 }));
    const weakDelta = weak.warmth - DEFAULT_PERSONALITY.warmth;
    const strongDelta = strong.warmth - DEFAULT_PERSONALITY.warmth;
    expect(strongDelta).toBeGreaterThan(weakDelta);
  });

  it("raises curiosity when a question is asked or topic novelty is high", () => {
    const next = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ askedQuestion: true, topicNovelty: 0.8 }));
    expect(next.curiosity).toBeGreaterThan(DEFAULT_PERSONALITY.curiosity);
  });

  it("raises humor when the message is playful", () => {
    const next = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ playful: true }));
    expect(next.humor).toBeGreaterThan(DEFAULT_PERSONALITY.humor);
  });

  it("applies the neglect mechanic after 3+ days of absence", () => {
    const shortGap = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ daysSinceLastVisit: 1 }));
    const longGap = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ daysSinceLastVisit: 10 }));
    expect(longGap.cheerfulness).toBeLessThan(shortGap.cheerfulness);
    expect(longGap.caution).toBeGreaterThan(shortGap.caution);
    expect(longGap.independence).toBeGreaterThan(shortGap.independence);
  });

  // --- ここから下が、育成として一番大事な性質 ---------------------------------

  it("可愛がり続けても、軸が100に張り付かない（育てるほど没個性になるのを防ぐ）", () => {
    let p = { ...DEFAULT_PERSONALITY };
    for (let i = 0; i < 500; i++) {
      p = updatePersonality(p, baseSignal({ sentiment: "positive", sentimentIntensity: 1 }));
    }
    // 上がってはいるが、振り切れてはいない
    expect(p.warmth).toBeGreaterThan(80);
    expect(p.warmth).toBeLessThan(100);
    expect(p.cheerfulness).toBeLessThan(100);
  });

  it("端に近いほど動きにくく、端から戻るときは動きやすい", () => {
    const sig = baseSignal({ sentiment: "positive", sentimentIntensity: 0.5 });
    const fromLow = updatePersonality({ ...DEFAULT_PERSONALITY, warmth: 10 }, sig).warmth - 10;
    const fromMid = updatePersonality({ ...DEFAULT_PERSONALITY, warmth: 50 }, sig).warmth - 50;
    const fromHigh = updatePersonality({ ...DEFAULT_PERSONALITY, warmth: 90 }, sig).warmth - 90;
    expect(fromLow).toBeGreaterThan(fromMid);
    expect(fromMid).toBeGreaterThan(fromHigh);
    expect(fromHigh).toBeGreaterThan(0); // 動かなくなるわけではない
  });

  it("50のときの変化量は、これまでと同じ（序盤の育ち方を変えていない）", () => {
    const next = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "positive", sentimentIntensity: 0.5 }));
    expect(next.warmth).toBeCloseTo(51.5, 5); // 1.5 × intensity1.0 × 係数1.0
  });

  it("長く空けて戻ってきても、1回で受ける打撃が大きすぎない", () => {
    // 戻ってきた初回で、可愛がり6往復ぶんより大きく削られないこと
    const oneHappyTurn =
      updatePersonality(DEFAULT_PERSONALITY, baseSignal({ sentiment: "positive", sentimentIntensity: 0.5 })).cheerfulness -
      50;
    const afterMonth = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ daysSinceLastVisit: 30 }));
    const damage = 50 - afterMonth.cheerfulness;
    expect(damage).toBeGreaterThan(0); // 寂しがりはする
    expect(damage).toBeLessThan(oneHappyTurn * 6);
  });

  it("放置で落ちた分は、話しかければ取り返せる", () => {
    const hurt = updatePersonality(DEFAULT_PERSONALITY, baseSignal({ daysSinceLastVisit: 30 }));
    let p = hurt;
    for (let i = 0; i < 5; i++) {
      p = updatePersonality(p, baseSignal({ sentiment: "positive", sentimentIntensity: 0.6 }));
    }
    expect(p.cheerfulness).toBeGreaterThan(50); // 元より上まで戻る
  });

  it("性格が逆の2体は、長く育てても別人のままでいる", () => {
    // 100に張り付くと、どちらも同じ「全部100」になって見分けが付かなくなる。
    // それが起きていないことを、軸の開きで見る。
    let warm = { ...DEFAULT_PERSONALITY };
    let wary = { ...DEFAULT_PERSONALITY };
    for (let i = 0; i < 300; i++) {
      warm = updatePersonality(warm, baseSignal({ sentiment: "positive", sentimentIntensity: 0.9, playful: true }));
      wary = updatePersonality(wary, baseSignal({ sentiment: "negative", sentimentIntensity: 0.9 }));
    }
    expect(warm.cheerfulness - wary.cheerfulness).toBeGreaterThan(40);
    expect(wary.caution - warm.caution).toBeGreaterThan(40);
  });

  it("never lets any trait go out of the 0-100 range even under repeated extreme input", () => {
    let p = { ...DEFAULT_PERSONALITY };
    for (let i = 0; i < 200; i++) {
      p = updatePersonality(p, baseSignal({ sentiment: "negative", sentimentIntensity: 1, daysSinceLastVisit: 30 }));
    }
    for (const key of Object.keys(p) as (keyof typeof p)[]) {
      expect(p[key]).toBeGreaterThanOrEqual(0);
      expect(p[key]).toBeLessThanOrEqual(100);
    }
  });
});

describe("describePersonality", () => {
  it("includes all six trait labels", () => {
    const text = describePersonality(DEFAULT_PERSONALITY);
    for (const label of ["温かさ", "好奇心", "陽気さ", "慎重さ", "自立心", "ユーモア"]) {
      expect(text).toContain(label);
    }
  });
});

describe("dominantTrait", () => {
  it("returns the trait with the highest value", () => {
    const p = { ...DEFAULT_PERSONALITY, humor: 90 };
    expect(dominantTrait(p)).toBe("humor");
  });
});
