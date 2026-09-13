import { describe, it, expect } from "vitest";
import {
  PROFILE_FIELDS,
  PROFILE_GROUPS,
  completionRate,
  describeProfile,
  nextFieldToAsk,
  sanitizeAnswers,
} from "../profile";

/**
 * 属性の定義と受け入れの検証。
 *
 * いちばん大事なのは sanitizeAnswers。ここが緩いと、選択肢式にした意味が無くなり、
 * 氏名や病名のような「取るつもりのない情報」が保存できてしまう。
 */

describe("PROFILE_GROUPS", () => {
  it("has no duplicate field keys (a duplicate would silently overwrite answers)", () => {
    const keys = PROFILE_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("asks the easy questions first and defers the sensitive-feeling ones", () => {
    const byKey = Object.fromEntries(PROFILE_FIELDS.map((f) => [f.key, f]));
    expect(byKey.ageBand.askAfter).toBe(0);
    // 年収を初回に聞くのは、体験としても信頼としても最悪なので必ず後回しにする
    expect(byKey.income.askAfter).toBeGreaterThan(10);
  });

  it("explains why every question is asked (the text is shown to the user as-is)", () => {
    for (const field of PROFILE_FIELDS) {
      expect(field.why.length).toBeGreaterThan(3);
      expect(field.options.length).toBeGreaterThan(1);
    }
  });
});

describe("sanitizeAnswers", () => {
  it("keeps known keys with known option values", () => {
    expect(sanitizeAnswers({ ageBand: "30代", region: "首都圏" })).toEqual({
      ageBand: ["30代"],
      region: ["首都圏"],
    });
  });

  it("drops unknown keys entirely", () => {
    // 定義していない項目を保存できてしまうと、何が入っているか把握できなくなる
    expect(sanitizeAnswers({ realName: "山田太郎", diagnosis: "ALS" })).toEqual({});
  });

  it("drops free text even for a known key", () => {
    expect(sanitizeAnswers({ ageBand: "1990年3月2日生まれ" })).toEqual({});
  });

  it("collapses a single-choice field to one value", () => {
    expect(sanitizeAnswers({ ageBand: ["30代", "40代"] })).toEqual({ ageBand: ["30代"] });
  });

  it("respects the maximum number of selections", () => {
    const many = ["ゲーム", "音楽", "読書", "料理", "旅行", "カメラ", "美容", "投資", "ゲーム"];
    const result = sanitizeAnswers({ hobbies: many });
    expect(result.hobbies.length).toBeLessThanOrEqual(8);
    // 重複は畳む
    expect(new Set(result.hobbies).size).toBe(result.hobbies.length);
  });

  it("returns an empty object for junk input", () => {
    expect(sanitizeAnswers(null)).toEqual({});
    expect(sanitizeAnswers("こんにちは")).toEqual({});
    expect(sanitizeAnswers([1, 2, 3])).toEqual({});
  });
});

describe("nextFieldToAsk", () => {
  it("asks nothing before the character has talked enough", () => {
    const field = nextFieldToAsk({ answers: { ageBand: ["30代"], gender: ["女性"], region: ["関西"] }, updatedAt: 0 }, 0);
    // 会話回数0では、askAfter が 0 の項目しか出ない。全部答えていれば何も出ない
    expect(field).toBeNull();
  });

  it("moves on to later questions as the conversation grows", () => {
    const profile = { answers: { ageBand: ["30代"], gender: ["女性"], region: ["関西"] }, updatedAt: 0 };
    const field = nextFieldToAsk(profile, 5);
    expect(field).not.toBeNull();
    expect(field!.askAfter).toBeLessThanOrEqual(5);
  });

  it("stops asking when the user said not to", () => {
    expect(nextFieldToAsk({ answers: {}, updatedAt: 0, declinedAll: true }, 100)).toBeNull();
  });
});

describe("completionRate", () => {
  it("is 0 with no answers and rises as fields are filled", () => {
    expect(completionRate({})).toBe(0);
    expect(completionRate({ ageBand: ["30代"] })).toBeGreaterThan(0);
  });
});

describe("describeProfile", () => {
  it("renders the answers as short Japanese lines for the prompt", () => {
    const text = describeProfile({ ageBand: ["30代"], hobbies: ["ゲーム", "料理"] });
    expect(text).toContain("年代: 30代");
    expect(text).toContain("ゲーム、料理");
  });

  it("keeps income out of the conversation (it was collected for statistics only)", () => {
    const text = describeProfile({ ageBand: ["30代"], income: ["1000万円以上"] });
    expect(text).toContain("30代");
    expect(text).not.toContain("1000万円");
  });
});
