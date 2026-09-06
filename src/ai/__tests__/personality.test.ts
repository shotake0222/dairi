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
