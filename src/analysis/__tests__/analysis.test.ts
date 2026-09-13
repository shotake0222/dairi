import { describe, it, expect, vi } from "vitest";
import { countTerms, extractTerms, topicWeights } from "../textMining";
import {
  emptyPsychographics,
  mergeTermSignals,
  mergeValueEstimate,
  parseValueJson,
  describeValues,
  topInterests,
} from "../psychographics";
import { classifySegment, SEGMENTS } from "../segments";
import { DEFAULT_PERSONALITY } from "../../ai/personality";

/**
 * テキストマイニング・サイコグラフィック・セグメンテーションの検証。
 *
 * 気をつけている点は「1回の会話で人物像が入れ替わらないこと」と、
 * 「会話量が少ないうちは自信を持って分類しないこと」。
 * どちらも、統計として出したときに嘘になるのを防ぐためのもの。
 */

describe("extractTerms", () => {
  it("picks up kanji runs, katakana runs and latin words", () => {
    const terms = extractTerms("今日はプログラミングの勉強をした。Pythonが楽しい");
    expect(terms).toContain("プログラミング");
    expect(terms).toContain("勉強");
    expect(terms).toContain("Python");
  });

  it("ignores hiragana-only words (they are mostly grammar, not topics)", () => {
    expect(extractTerms("そうだね、たぶんそうかもしれない")).toEqual([]);
  });

  it("drops filler words that appear everywhere", () => {
    expect(extractTerms("今日は自分の気持ちを思う")).not.toContain("今日");
  });
});

describe("countTerms / topicWeights", () => {
  it("counts across several utterances and ranks by frequency", () => {
    const counts = countTerms(["仕事が忙しい", "仕事の話をしよう", "映画を見た"]);
    expect(counts[0].term).toBe("仕事");
    expect(counts[0].count).toBe(2);
  });

  it("maps terms onto topic categories", () => {
    const weights = topicWeights(countTerms(["残業が続いてる", "上司と会議"]));
    expect(weights["仕事"]).toBeGreaterThan(0);
  });
});

describe("mergeTermSignals", () => {
  it("moves interests gradually rather than replacing them", () => {
    let psy = emptyPsychographics();
    psy = mergeTermSignals(psy, ["ゲームの話", "ゲームが楽しい"]);
    const afterGames = psy.interests["エンタメ"] ?? 0;
    expect(afterGames).toBeGreaterThan(0);

    // 一度だけ仕事の話をしても、エンタメの関心が消えてはいけない
    psy = mergeTermSignals(psy, ["仕事が忙しい"]);
    expect(psy.interests["エンタメ"]).toBeGreaterThan(0);
    expect(psy.interests["エンタメ"]).toBeLessThan(afterGames);
  });

  it("records the words the person actually uses, and counts the observation", () => {
    const psy = mergeTermSignals(emptyPsychographics(), ["猫と散歩", "猫がかわいい"]);
    expect(psy.terms).toContain("猫");
    expect(psy.sampleCount).toBe(1);
  });

  it("leaves the record untouched when nothing usable was said", () => {
    const before = emptyPsychographics();
    expect(mergeTermSignals(before, ["うん", "そうだね"])).toBe(before);
  });
});

describe("parseValueJson", () => {
  it("finds the JSON even when the model wraps it in chatter", () => {
    const parsed = parseValueJson('はい、結果です {"values":{"achievement":70}} 以上です');
    expect(parsed?.values?.achievement).toBe(70);
  });

  it("returns null when there is no JSON at all", () => {
    expect(parseValueJson("すみません、分かりません")).toBeNull();
  });
});

describe("mergeValueEstimate", () => {
  function fakeAi(response: string | Error) {
    const run = vi.fn(async (_model: string, _input: unknown) => {
      if (response instanceof Error) throw response;
      return { response };
    });
    return { AI: { run } } as unknown as { AI: Ai };
  }

  it("blends the estimate in slowly instead of overwriting", async () => {
    const env = fakeAi('{"values":{"achievement":100}}');
    const psy = await mergeValueEstimate(env, emptyPsychographics(), ["がんばって結果を出したい"]);
    // 50 から 100 へ一足飛びに動かない
    expect(psy.values.achievement).toBeGreaterThan(50);
    expect(psy.values.achievement).toBeLessThan(80);
  });

  it("keeps the previous estimate when the model fails", async () => {
    const before = emptyPsychographics();
    const env = fakeAi(new Error("AI down"));
    expect(await mergeValueEstimate(env, before, ["やあ"])).toBe(before);
  });

  it("does not call the AI when there is nothing to read", async () => {
    const env = fakeAi('{"values":{}}');
    const before = emptyPsychographics();
    expect(await mergeValueEstimate(env, before, [])).toBe(before);
    expect((env.AI.run as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });
});

describe("describeValues / topInterests", () => {
  it("only mentions the axes that actually stand out", () => {
    const psy = emptyPsychographics();
    expect(describeValues(psy)).toBe("");
    psy.values.security = 80;
    expect(describeValues(psy)).toContain("安定");
  });

  it("lists interests strongest first", () => {
    const psy = emptyPsychographics();
    psy.interests = { 仕事: 10, エンタメ: 40, 食: 25 };
    expect(topInterests(psy, 2)).toEqual(["エンタメ", "食"]);
  });
});

describe("classifySegment", () => {
  it("always lands on one of the defined segments", () => {
    const result = classifySegment({
      personality: DEFAULT_PERSONALITY,
      psychographics: emptyPsychographics(),
      interactionCount: 30,
    });
    expect(SEGMENTS.some((s) => s.id === result.id)).toBe(true);
  });

  it("is not confident about a character that has barely talked", () => {
    const psy = emptyPsychographics();
    psy.values.stimulation = 90;
    const early = classifySegment({
      personality: { ...DEFAULT_PERSONALITY, curiosity: 90 },
      psychographics: psy,
      interactionCount: 2,
    });
    const later = classifySegment({
      personality: { ...DEFAULT_PERSONALITY, curiosity: 90 },
      psychographics: psy,
      interactionCount: 60,
    });
    // 2回話しただけで「探究者と断定」してはいけない
    expect(early.confidence).toBeLessThan(later.confidence);
    expect(early.confidence).toBeLessThan(30);
  });

  it("separates clearly different people", () => {
    const curious = emptyPsychographics();
    curious.values.stimulation = 85;
    curious.values.selfDirection = 80;
    const explorer = classifySegment({
      personality: { ...DEFAULT_PERSONALITY, curiosity: 85 },
      psychographics: curious,
      interactionCount: 60,
    });

    const kind = emptyPsychographics();
    kind.values.benevolence = 85;
    const nurturer = classifySegment({
      personality: { ...DEFAULT_PERSONALITY, warmth: 85, independence: 25 },
      psychographics: kind,
      interactionCount: 60,
    });

    expect(explorer.id).toBe("explorer");
    expect(nurturer.id).toBe("nurturer");
  });

  it("reports the runners-up so overlapping groups are visible", () => {
    const result = classifySegment({
      personality: DEFAULT_PERSONALITY,
      psychographics: emptyPsychographics(),
      interactionCount: 30,
    });
    expect(result.runnersUp.length).toBeGreaterThan(1);
  });
});
