import { describe, it, expect } from "vitest";
import { buildPersonaCard } from "../personaCard";
import { emptyPsychographics } from "../../analysis/psychographics";
import { DEFAULT_PERSONALITY } from "../../ai/personality";
// @ts-expect-error -- 機器側と同じ実装をそのまま検証するため、JSのまま読み込む
import { auditCompact, toCompact } from "../../../tools/edge/compact.mjs";

/**
 * 機器に焼く「振る舞いだけ」の最小形の検証。
 *
 * 守りたいのは2つ。
 *   1. **会話・覚え書き・属性が1文字も混ざらないこと。**
 *      部屋に置く機器や人に配るデバイスに、その人の生活が焼かれるのは事故そのもの。
 *      目視の確認に任せるといつか漏れるので、機械で見る。
 *   2. **人格の違いが、数値の違いとして残ること。**
 *      小さくした結果みんな同じ数字になるなら、機器の上で人格は消えている。
 *      「エッジでも動く」という主張の裏付けが無くなる。
 */

function makeCard(kind: "bold" | "careful") {
  const psychographics = emptyPsychographics();
  psychographics.values =
    kind === "bold"
      ? { achievement: 80, benevolence: 30, hedonism: 78, security: 15, stimulation: 90, selfDirection: 86, tradition: 18, power: 72 }
      : { achievement: 35, benevolence: 82, hedonism: 25, security: 88, stimulation: 12, selfDirection: 28, tradition: 80, power: 20 };

  return buildPersonaCard({
    characterId: `edge-${kind}-0123456789`,
    name: kind === "bold" ? "さきがけ" : "しずか",
    species: "punikoro",
    color: "sun",
    createdAt: Date.now() - 1000,
    growthStage: "おしゃべり期",
    interactionCount: 80,
    personality:
      kind === "bold"
        ? { ...DEFAULT_PERSONALITY, curiosity: 90, caution: 20, cheerfulness: 82 }
        : { ...DEFAULT_PERSONALITY, curiosity: 25, caution: 85, cheerfulness: 35 },
    psychographics,
    segment: null,
    profileAnswers: { ageBand: ["30代"], region: ["首都圏"], income: ["1000万円以上"] },
    profileNotes: "・柴犬のコタロウを飼っている\n・夜勤の仕事をしている",
    memories: [{ text: "来月、福岡へ引っ越すと話していた", at: Date.now() }],
    recentTurns: [
      { role: "user" as const, text: "来月、福岡へ引っ越すことにした" },
      { role: "character" as const, text: "いいね、宿は現地で探すのも面白いよ" },
    ],
    includeOwnerProfile: true,
  });
}

describe("機器用の最小形", () => {
  it("会話・覚え書き・属性を1文字も含まない", () => {
    const card = makeCard("bold");
    const compact = toCompact(card);
    const audit = auditCompact(compact, card);

    expect(audit.leaks).toEqual([]);
    expect(audit.ok).toBe(true);

    // 具体的な危ない語でも直接見ておく（auditの実装ごと壊れた場合の保険）
    const json = JSON.stringify(compact);
    expect(json).not.toContain("コタロウ");
    expect(json).not.toContain("福岡");
    expect(json).not.toContain("夜勤");
    expect(json).not.toContain("1000万円以上");
  });

  it("ESP32やPicoに載る大きさに収まる", () => {
    const audit = auditCompact(toCompact(makeCard("bold")), makeCard("bold"));
    // 512バイトは、ArduinoJsonの静的バッファでも素直に扱える大きさ
    expect(audit.bytes).toBeLessThan(512);
  });

  it("性格が違えば、機器に渡る数値も違う（小さくしても人格が消えない）", () => {
    const bold = toCompact(makeCard("bold"));
    const careful = toCompact(makeCard("careful"));

    // 動きの大きさ・返すまでの間・心地よい距離は、体感で分かる差になる箇所
    expect(bold.m[0]).not.toBe(careful.m[0]); // energy
    expect(bold.m[3]).toBeLessThan(careful.m[3]); // 慎重な子ほど、返すまでの間が長い
    expect(bold.p[0]).toBeLessThan(careful.p[0]); // 慎重な子ほど、離れていたい

    // 方針（機械が分岐する識別子）も別物になっていること
    expect(bold.c).not.toEqual(careful.c);
    expect(bold.c.length).toBeGreaterThan(0);
  });

  it("形式の版を持つ（機器側と食い違ったら弾けるように）", () => {
    expect(toCompact(makeCard("bold")).v).toBe(1);
  });
});
