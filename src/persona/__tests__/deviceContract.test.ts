import { describe, expect, it } from "vitest";
import contract from "../../../tools/device/contract.json";
import pinmap from "../../../tools/device/pinmap.json";
import { TRAIT_ORDER, COMPACT_VERSION, toCompact } from "../../../tools/edge/compact.mjs";
import { buildPersonaCard } from "../personaCard";
import { emptyPsychographics } from "../../analysis/psychographics";
import { DEFAULT_PERSONALITY } from "../../ai/personality";

/**
 * サーバーと検証機のあいだの取り決めが、片方だけ変わっていないことの確認。
 *
 * **なぜCIで見るのか。**
 * 配列の並び（`m` が何番目に何を持つか）は、サーバー（compact.mjs）と
 * 機器のファーム（wt_core.py / wt_core.h）の両方に書かれている。
 * サーバー側だけ増やすと、**機器は何も文句を言わずに別の意味の数値で動く**。
 * 「ESP32だけ性格が違う」という形でしか現れないので、現場では原因に辿り着けない。
 *
 * 機器側どうしの突き合わせは tools/device/selftest.py（g++ でC++版も動かす）。
 * こちらは「サーバーが取り決めから外れていないか」だけを見る。
 */

function sampleCard() {
  const psychographics = emptyPsychographics();
  psychographics.values = {
    achievement: 80, benevolence: 30, hedonism: 78, security: 15,
    stimulation: 90, selfDirection: 86, tradition: 18, power: 72,
  };
  return buildPersonaCard({
    characterId: "5b0a7533-cafe-4d00-9e11-000000000000",
    name: "さきがけ",
    species: "punikoro",
    color: "sun",
    createdAt: Date.now() - 1000,
    growthStage: "おしゃべり期",
    interactionCount: 80,
    personality: { ...DEFAULT_PERSONALITY, curiosity: 88, caution: 26, cheerfulness: 74 },
    psychographics,
    segment: null,
    profileAnswers: {},
    profileNotes: "",
    memories: [],
    recentTurns: [],
    includeOwnerProfile: false,
  });
}

describe("検証機との取り決め（tools/device/contract.json）", () => {
  it("版がサーバー側と一致している", () => {
    expect(contract.version).toBe(COMPACT_VERSION);
  });

  it("性格6軸の並びが一致している", () => {
    expect(contract.arrays.t.fields.map((f) => f.key)).toEqual([...TRAIT_ORDER]);
  });

  it("実際に作った最小形が、取り決めどおりの長さになっている", () => {
    const compact = toCompact(sampleCard());
    for (const key of ["m", "p", "e", "t"] as const) {
      expect(compact[key]).toHaveLength(contract.arrays[key].fields.length);
    }
    expect(compact.v).toBe(contract.version);
    expect(compact.id.length).toBeLessThanOrEqual(8);
    expect(compact.n.length).toBeLessThanOrEqual(16);
  });

  it("方針コードは、取り決めに載っているものしか出さない", () => {
    // 機器は文字列で分岐する。表に無いコードを出しても、機器は黙って無視する
    const compact = toCompact(sampleCard());
    for (const code of compact.c) {
      expect(contract.policyCodes).toContain(code);
    }
  });

  it("最小形が機器の上限に収まっている", () => {
    const bytes = new TextEncoder().encode(JSON.stringify(toCompact(sampleCard()))).length;
    expect(bytes).toBeLessThanOrEqual(contract.limits.maxBytes);
    expect(toCompact(sampleCard()).c.length).toBeLessThanOrEqual(contract.limits.maxPolicies);
  });
});

describe("ピン割り当て（tools/device/pinmap.json）", () => {
  const roles = pinmap.roles.map((r) => r.role);

  it("3機種とも、すべての役割にピンがある", () => {
    for (const [name, board] of Object.entries(pinmap.boards)) {
      for (const role of roles) {
        expect(Object.keys(board.pins), `${name} に ${role} が無い`).toContain(role);
      }
    }
  });

  it("同じピンを2つの役割に割り当てていない", () => {
    for (const [name, board] of Object.entries(pinmap.boards)) {
      const used = Object.values(board.pins).filter((v): v is number => typeof v === "number");
      expect(new Set(used).size, `${name} でピンが重複している`).toBe(used.length);
    }
  });

  it("ESP32 の、触ると起動しなくなるピンを使っていない", () => {
    // 0/2/5/12/15 は起動時の状態を見ているピン、6〜11 は内蔵フラッシュ、34〜39 は入力専用
    const pins = pinmap.boards.esp32.pins as Record<string, number | string | null>;
    for (const [role, pin] of Object.entries(pins)) {
      if (typeof pin !== "number") continue;
      if (role === "LED_ALIVE") continue; // オンボードLEDは GPIO2 で固定
      expect([0, 2, 5, 12, 15], `${role}`).not.toContain(pin);
      expect(pin < 6 || pin > 11, `${role} が内蔵フラッシュのピン`).toBe(true);
      if (pin >= 34) expect(role).toBe("SONAR_ECHO"); // 入力専用は測距の受信だけ
    }
  });
});
