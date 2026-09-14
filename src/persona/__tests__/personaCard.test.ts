import { describe, it, expect } from "vitest";
import { buildPersonaCard, extractExamples } from "../personaCard";
import { deriveAvatarProfile, derivePolicy } from "../avatarProfile";
import { emptyPsychographics } from "../../analysis/psychographics";
import { DEFAULT_PERSONALITY } from "../../ai/personality";

/**
 * 「集めたデータで、載せ先の分身が本当に動くのか」を守るためのテスト。
 *
 * ここが緩むと、カードのJSONには情報が入っているのに
 * **systemPrompt には出てこない**という状態に戻る。
 * 大半の載せ先はプロンプトしか読まないので、それは情報が無いのと同じ。
 */

function makeInput(overrides: Partial<Parameters<typeof buildPersonaCard>[0]> = {}) {
  const psychographics = emptyPsychographics();
  psychographics.values = {
    achievement: 80,
    benevolence: 30,
    hedonism: 75,
    security: 20,
    stimulation: 88,
    selfDirection: 84,
    tradition: 22,
    power: 70,
  };
  psychographics.selfReported = { stimulation: 88, security: 20 };
  psychographics.interests = { 旅行: 40, 仕事: 20 };

  return {
    characterId: "test-card",
    name: "さきがけ",
    species: "punikoro",
    color: "sun",
    createdAt: Date.now() - 1000,
    growthStage: "おしゃべり期",
    interactionCount: 62,
    personality: { ...DEFAULT_PERSONALITY, curiosity: 88, caution: 26, warmth: 55 },
    psychographics,
    segment: { id: "explorer", label: "探究者", confidence: 60, runnersUp: [] },
    profileAnswers: { ageBand: ["20代"], region: ["首都圏"], income: ["1000万円以上"] },
    profileNotes: "・フリーランスで働いている\n・夜型",
    memories: [],
    recentTurns: [
      { role: "user" as const, text: "福岡に行くことにした" },
      { role: "character" as const, text: "いいね、宿は現地で探すのも面白いよ" },
    ],
    includeOwnerProfile: true,
    ...overrides,
  };
}

describe("人格カードのプロンプト", () => {
  it("価値観が、数値ではなく行動の指示として載る", () => {
    const card = buildPersonaCard(makeInput());
    const prompt = card.runtime.systemPrompt;
    // 数値をそのまま渡してもモデルは使えない。行動に翻訳されていること
    expect(prompt).toContain("刺激");
    expect(prompt).toContain("やったことがない選択肢");
    expect(prompt).toContain("安定");
  });

  it("本人が申告した軸には、そう書いてある（推定と区別できる）", () => {
    const card = buildPersonaCard(makeInput());
    expect(card.runtime.systemPrompt).toContain("本人の申告");
    expect(card.runtime.systemPrompt).toContain("会話からの推定");
    expect(card.owner.declaredValues.stimulation).toBe(88);
  });

  it("属性がプロンプトに載る", () => {
    const prompt = buildPersonaCard(makeInput()).runtime.systemPrompt;
    expect(prompt).toContain("20代");
    expect(prompt).toContain("首都圏");
  });

  it("年収だけは載らない（統計にしか使わないと説明しているため）", () => {
    const prompt = buildPersonaCard(makeInput()).runtime.systemPrompt;
    expect(prompt).not.toContain("1000万円");
    expect(prompt).not.toContain("年収");
  });

  it("同意が無ければ、人物像は一切載らない", () => {
    const card = buildPersonaCard(makeInput({ includeOwnerProfile: false }));
    const prompt = card.runtime.systemPrompt;
    expect(prompt).not.toContain("20代");
    expect(prompt).not.toContain("首都圏");
    expect(card.owner.values).toEqual({});
    expect(card.owner.declaredValues).toEqual({});
    // 価値観に由来する振る舞いの指示も出ない（分身の性格だけで動く身体になる）
    expect(card.runtime.avatar.policy).toEqual([]);
  });
});

describe("応答例", () => {
  it("AIが失敗したときの定型文は、例として持ち出さない", () => {
    // これを渡すと、載せ先のモデルがこの言い回しを口調として真似る
    const examples = extractExamples([
      { role: "user", text: "こんにちは" },
      { role: "character", text: "（今はうまく考えがまとまらないみたい。少し時間をおいてもう一度話しかけてね）" },
      { role: "user", text: "元気？" },
      { role: "character", text: "元気だよ、そっちは？" },
    ]);
    expect(examples).toHaveLength(1);
    expect(examples[0].assistant).toBe("元気だよ、そっちは？");
  });
});

describe("身体のパラメータ", () => {
  it("性格と価値観から、動き・距離・表情が決まる", () => {
    const profile = deriveAvatarProfile(
      { warmth: 90, curiosity: 80, cheerfulness: 80, caution: 10, independence: 50, humor: 70 },
      { stimulation: 90, benevolence: 90, power: 70 }
    );
    expect(profile.motion.energy).toBeGreaterThan(50);
    expect(profile.proxemics.comfortableDistanceM).toBeLessThan(1.2); // 温かい人は近い
    expect(profile.motion.responseDelayMs).toBeLessThan(500); // 慎重でなければ間を取らない
  });

  it("慎重な子は、間を取り、距離も遠い", () => {
    const bold = deriveAvatarProfile({ ...DEFAULT_PERSONALITY, caution: 10, warmth: 90 }, {});
    const careful = deriveAvatarProfile({ ...DEFAULT_PERSONALITY, caution: 90, warmth: 30 }, {});
    expect(careful.motion.responseDelayMs).toBeGreaterThan(bold.motion.responseDelayMs);
    expect(careful.proxemics.comfortableDistanceM).toBeGreaterThan(bold.proxemics.comfortableDistanceM);
  });

  it("価値観が真ん中なら、方針は出ない（無理に特徴を作らない）", () => {
    const flat = derivePolicy({ stimulation: 50, security: 52, power: 48 });
    expect(flat).toEqual([]);
  });

  it("方針には、機械が分岐するための識別子が付いている", () => {
    const policy = derivePolicy({ stimulation: 90, security: 15 });
    const codes = policy.map((p) => p.code);
    expect(codes).toContain("prefer_novel_options");
    expect(codes).toContain("tolerate_open_plans");
    // 日本語を読めない機器でも使えることが要件なので、識別子は英数字だけ
    for (const code of codes) expect(code).toMatch(/^[a-z_]+$/);
  });

  it("強く出ている軸から順に並ぶ（載せ先が数を絞れるように）", () => {
    const policy = derivePolicy({ stimulation: 95, security: 35, power: 70 });
    expect(policy[0].axis).toBe("stimulation");
  });
});
