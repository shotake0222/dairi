import { describe, it, expect } from "vitest";
import { analyzeMessage } from "../signalExtractor";

describe("analyzeMessage", () => {
  it("detects positive sentiment", () => {
    const s = analyzeMessage("今日はとても楽しかった！ありがとう", 0);
    expect(s.sentiment).toBe("positive");
    expect(s.sentimentIntensity).toBeGreaterThan(0);
  });

  it("detects negative sentiment", () => {
    const s = analyzeMessage("最悪、もう疲れた", 0);
    expect(s.sentiment).toBe("negative");
  });

  it("does not misread a negated positive word as positive", () => {
    // 「楽しくない」は肯定語「楽しい」を含むが、直後に否定が続くため肯定と誤判定しないことを確認
    const s = analyzeMessage("今日は楽しくないな", 0);
    expect(s.sentiment).not.toBe("positive");
  });

  it("treats a negated negative word as leaning positive", () => {
    // 「嫌いじゃない」は否定語「嫌い」を含むが、直後の否定により肯定寄りになることを確認
    const s = analyzeMessage("べつに嫌いじゃないよ", 0);
    expect(s.sentiment).not.toBe("negative");
  });

  it("gives higher intensity to intensifier-boosted messages", () => {
    const weak = analyzeMessage("嬉しい", 0);
    const strong = analyzeMessage("本当にすごく嬉しい！大好き！", 0);
    expect(strong.sentimentIntensity).toBeGreaterThanOrEqual(weak.sentimentIntensity);
  });

  it("flags a question mark as askedQuestion", () => {
    const s = analyzeMessage("今日は何して遊んだの？", 0);
    expect(s.askedQuestion).toBe(true);
  });

  it("flags curiosity phrasing even without a question mark", () => {
    const s = analyzeMessage("それ、なんでそうなったのか教えて", 0);
    expect(s.askedQuestion).toBe(true);
  });

  it("flags playful markers", () => {
    const s = analyzeMessage("それ面白すぎるwww", 0);
    expect(s.playful).toBe(true);
  });

  it("passes daysSinceLastVisit through unchanged", () => {
    const s = analyzeMessage("こんにちは", 4.5);
    expect(s.daysSinceLastVisit).toBe(4.5);
  });

  it("stays neutral with no matched keywords", () => {
    const s = analyzeMessage("そうなんだ", 0);
    expect(s.sentiment).toBe("neutral");
  });
});
