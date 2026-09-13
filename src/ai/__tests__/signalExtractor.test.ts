import { describe, it, expect } from "vitest";
import { analyzeMessage, estimateNovelty } from "../signalExtractor";

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

/**
 * 2026-09-13 の見直しぶん。
 * 「話題が新しいか」を、質問かどうかではなく実際の語で測るようにした部分を確かめる。
 */
describe("estimateNovelty（話題の新しさ）", () => {
  it("treats a topic the character has heard many times as not new", () => {
    const known = ["仕事", "残業", "上司"];
    const familiar = estimateNovelty("今日も残業だった。上司が…", known, false);
    const fresh = estimateNovelty("陶芸教室に通いはじめた", known, false);
    expect(fresh).toBeGreaterThan(familiar);
  });

  it("no longer calls a repeated topic novel just because it ends with a question mark", () => {
    const known = ["仕事", "残業"];
    // 以前は疑問符があるだけで 0.7 になっていた
    expect(estimateNovelty("今日も残業？", known, true)).toBeLessThan(0.7);
  });

  it("does not treat a short filler reply as a new topic", () => {
    expect(estimateNovelty("うん", ["仕事"], false)).toBeLessThan(0.3);
  });

  it("stays moderate for a character that knows nothing yet", () => {
    // 相手のことを何も知らない段階。話題は全部初めてだが、そこで確信するのも違うので中庸に置く
    const value = estimateNovelty("陶芸をはじめました", undefined, false);
    expect(value).toBeGreaterThan(0.3);
    expect(value).toBeLessThanOrEqual(1);
  });

  it("treats an utterance with no topic words as not a new topic at all", () => {
    // ひらがなだけの相槌からは語が取れない。「新しい話題」ではないので低く出るのが正しい
    expect(estimateNovelty("そうなんだ", undefined, false)).toBeLessThan(0.3);
  });

  it("always returns a value between 0 and 1", () => {
    for (const text of ["", "あ", "全部あたらしい話題です陶芸登山写真", "？？？"]) {
      const v = estimateNovelty(text, ["仕事"], true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe("analyzeMessage（見直しぶん）", () => {
  it("reads emoji as sentiment", () => {
    expect(analyzeMessage("今日はこんな感じ 😭", 0).sentiment).toBe("negative");
    expect(analyzeMessage("今日はこんな感じ 🎉", 0).sentiment).toBe("positive");
  });

  it("scales the intensity by how strongly it was said", () => {
    const plain = analyzeMessage("楽しい", 0).sentimentIntensity;
    const strong = analyzeMessage("めっちゃ楽しい", 0).sentimentIntensity;
    const weak = analyzeMessage("ちょっと楽しい", 0).sentimentIntensity;
    expect(strong).toBeGreaterThan(plain);
    expect(weak).toBeLessThan(plain);
  });

  it("does not treat an angry double exclamation as playfulness", () => {
    // 「！！」は強い感情であって冗談ではない。怒っている人のユーモア値を上げてはいけない
    expect(analyzeMessage("もう無理！！", 0).playful).toBe(false);
    expect(analyzeMessage("それは草", 0).playful).toBe(true);
  });

  it("uses the words the character already knows when they are provided", () => {
    const known = ["仕事", "残業"];
    const repeated = analyzeMessage("残業がつらい", 0, known).topicNovelty;
    const brandNew = analyzeMessage("陶芸をはじめた", 0, known).topicNovelty;
    expect(brandNew).toBeGreaterThan(repeated);
  });
});
