import { describe, it, expect } from "vitest";
import { PROFILE_FIELDS } from "../profile";
import {
  PSYCHO_QUESTIONS,
  nextSurveyItem,
  personaDepth,
  psychoQuestionById,
  PERSONA_SELLABLE_THRESHOLD,
} from "../survey";
import { VALUE_AXES } from "../../analysis/psychographics";

/**
 * パルスサーベイの検証。
 *
 * ここで守りたいこと:
 *  - 同じ設問を二度出さない（答えた／あとで、のどちらも）
 *  - 属性ばかり・価値観ばかりに偏らない
 *  - 「もう聞かないで」が確実に効く
 *  - 価値観の設問が、推定と同じ8軸に載っている（載っていないと、申告と推定を重ねられない）
 */

const base = {
  answers: {},
  psychoAnswered: [] as string[],
  skipped: [] as string[],
  interactionCount: 100,
};

describe("PSYCHO_QUESTIONS", () => {
  it("すべて推定と同じ8軸のどれかに載っている", () => {
    for (const q of PSYCHO_QUESTIONS) {
      expect(VALUE_AXES).toContain(q.axis);
    }
  });

  it("1軸につき最低1問はある（申告だけで人物像の骨格が埋まるように）", () => {
    const covered = new Set(PSYCHO_QUESTIONS.map((q) => q.axis));
    for (const axis of VALUE_AXES) expect(covered.has(axis)).toBe(true);
  });

  it("選択肢の点数が0〜100に収まっていて、幅がある", () => {
    for (const q of PSYCHO_QUESTIONS) {
      expect(q.options.length).toBeGreaterThanOrEqual(2);
      const scores = q.options.map((o) => o.score);
      for (const s of scores) expect(s).toBeGreaterThanOrEqual(0), expect(s).toBeLessThanOrEqual(100);
      // 全部同じ点数だと、答えても何も動かない設問になる
      expect(Math.max(...scores) - Math.min(...scores)).toBeGreaterThanOrEqual(30);
    }
  });

  it("「なぜ聞くのか」が全問に書いてある（説明なしに人に質問しない）", () => {
    for (const q of PSYCHO_QUESTIONS) expect(q.why.length).toBeGreaterThan(4);
  });

  it("IDで引ける", () => {
    expect(psychoQuestionById("psy_stimulation")?.axis).toBe("stimulation");
    expect(psychoQuestionById("nope")).toBeNull();
  });
});

describe("nextSurveyItem", () => {
  it("会話が足りないうちは何も聞かない", () => {
    const item = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, { ...base, interactionCount: 0 });
    // askAfter=0 の属性はあるので、属性から出る
    expect(item?.kind).toBe("demographic");

    const late = PROFILE_FIELDS.filter((f) => f.askAfter > 50);
    const psychoLate = PSYCHO_QUESTIONS.filter((q) => q.askAfter > 50);
    expect(nextSurveyItem(late, psychoLate, { ...base, interactionCount: 0 })).toBeNull();
  });

  it("答えた設問は二度と出ない", () => {
    const first = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, base);
    expect(first).not.toBeNull();
    const next = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, {
      ...base,
      answers: { [first!.id]: ["なにか"] },
    });
    expect(next?.id).not.toBe(first!.id);
  });

  it("「あとで」と言われた設問も、その場では出し直さない", () => {
    const first = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, base);
    const next = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, { ...base, skipped: [first!.id] });
    expect(next?.id).not.toBe(first!.id);
  });

  it("属性と価値観が交互に出る", () => {
    // 答えた数が偶数なら属性、奇数なら価値観
    const even = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, { ...base, answers: { ageBand: ["30代"], gender: ["女性"] } });
    const odd = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, { ...base, answers: { ageBand: ["30代"] } });
    expect(even?.kind).toBe("demographic");
    expect(odd?.kind).toBe("psychographic");
  });

  it("片方を答え切ったら、もう片方だけを出す", () => {
    const allAnswered: Record<string, string[]> = {};
    for (const f of PROFILE_FIELDS) allAnswered[f.key] = ["x"];
    const item = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, { ...base, answers: allAnswered });
    expect(item?.kind).toBe("psychographic");

    const item2 = nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, {
      ...base,
      psychoAnswered: PSYCHO_QUESTIONS.map((q) => q.id),
    });
    expect(item2?.kind).toBe("demographic");
  });

  it("「もう聞かないで」が効く", () => {
    expect(nextSurveyItem(PROFILE_FIELDS, PSYCHO_QUESTIONS, { ...base, declinedAll: true })).toBeNull();
  });
});

describe("personaDepth", () => {
  it("何もしていない分身は0", () => {
    const d = personaDepth({
      interactionCount: 0,
      profileAnswered: 0,
      profileTotal: 20,
      psychoAnswered: 0,
      psychoTotal: 8,
      memoryCount: 0,
    });
    expect(d.score).toBe(0);
    expect(d.sellable).toBe(false);
  });

  it("会話だけでは出品の水準に届かない（喋っていても誰なのか分からない分身を出させない）", () => {
    const d = personaDepth({
      interactionCount: 1000,
      profileAnswered: 0,
      profileTotal: 20,
      psychoAnswered: 0,
      psychoTotal: 8,
      memoryCount: 0,
    });
    expect(d.score).toBeLessThan(PERSONA_SELLABLE_THRESHOLD);
  });

  it("会話・属性・価値観・記憶がそろえば水準に届く", () => {
    const d = personaDepth({
      interactionCount: 60,
      profileAnswered: 20,
      profileTotal: 20,
      psychoAnswered: 8,
      psychoTotal: 8,
      memoryCount: 40,
    });
    expect(d.score).toBe(100);
    expect(d.sellable).toBe(true);
  });

  it("内訳の合計が全体と一致する（画面で足し算が合わないのは、数字が信用されなくなる）", () => {
    const d = personaDepth({
      interactionCount: 23,
      profileAnswered: 7,
      profileTotal: 20,
      psychoAnswered: 3,
      psychoTotal: 8,
      memoryCount: 11,
    });
    const sum = d.parts.reduce((a, p) => a + p.score, 0);
    expect(sum).toBe(d.score);
  });
});
